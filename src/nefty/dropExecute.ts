import type { Session } from '@wharfkit/session';

import { resolveTokenContract, symbolFromQuantity } from './tokens';
import type { DiscoveredDrop } from './drops';

/**
 * Common parameters every claim variant carries. NeftyBlocks bakes a few
 * "vanity" fields into the action (referrer, country) that the contract
 * mostly ignores but the schema still requires. We expose them with safe
 * defaults so the UI doesn't have to ask for them every time.
 */
export interface ClaimDefaults {
  referrer: string;        // shown in NeftyBlocks UI; can be anything
  country: string;         // ISO-2 used historically for marketing; "" is fine
  referrer_account: string; // "" by default
  intended_delphi_median: string; // "0" for non-delphi drops (all our cases)
}

const DEFAULTS: ClaimDefaults = {
  referrer: 'Crucible',
  country: '',
  referrer_account: '',
  intended_delphi_median: '0',
};

export interface ClaimArgs {
  claimer: string;
  drop: DiscoveredDrop;
  /** How many copies of the drop to claim in one tx (most drops cap at 1 per account). */
  amount: number;
  /** Required when the drop's auth is `proof`: the picked asset_ids in filter order. */
  proof_asset_ids?: string[];
  defaults?: Partial<ClaimDefaults>;
}

export interface BuiltAction {
  account: string;
  name: string;
  authorization: { actor: string; permission: string }[];
  data: Record<string, unknown>;
}

/**
 * Builds the on-chain action sequence for a Nefty drop claim.
 *
 * Sequence (matches the live trace of any historical Nefty claim):
 *   1. neftyblocksd::assertprice    — price lock; skipped for free drops
 *   2. <token>::transfer            — pays the cost; skipped for free drops
 *   3. neftyblocksd::<claim action> — actual claim:
 *        - public:        claimdrop
 *        - whitelist:     claimdropwl
 *        - proof:         claimwproof (adds asset_ids)
 *        - authkey:       NOT SUPPORTED (requires a signed key from the
 *                         drop creator; impossible without the secret).
 *
 * The historical `neftybrespay::paycpu` leading the trace is intentionally
 * omitted — that payer no longer signs.
 */
export async function buildClaimActions(args: ClaimArgs): Promise<BuiltAction[]> {
  const d = args.drop;
  const defaults = { ...DEFAULTS, ...(args.defaults ?? {}) };
  const auth = [{ actor: args.claimer, permission: 'active' }];
  const actions: BuiltAction[] = [];

  // Pre-flight: catch the per-account limit BEFORE we ask the wallet to
  // sign anything. The contract throws "You can only claim the drop X more
  // times" — we want to surface that earlier with a friendlier message.
  if (typeof d.account_remaining === 'number' && d.account_remaining < args.amount) {
    if (d.account_remaining === 0 && d.cooldown_resets_at && d.cooldown_resets_at > Math.floor(Date.now() / 1000)) {
      const waitS = d.cooldown_resets_at - Math.floor(Date.now() / 1000);
      throw new Error(
        `You've already claimed this drop the maximum allowed times. Cooldown resets in ${formatDuration(waitS)}.`,
      );
    }
    throw new Error(
      d.account_remaining === 0
        ? `You've reached this drop's per-account limit (${d.account_limit}). The contract won't let you claim again.`
        : `You can only claim ${d.account_remaining} more time(s); you asked for ${args.amount}.`,
    );
  }

  // 1. + 2. only when the drop is not free.
  if (!d.is_free) {
    actions.push({
      account: 'neftyblocksd',
      name: 'assertprice',
      authorization: auth,
      data: {
        drop_id: d.drop_id,
        listing_price: d.listing_price,
        settlement_symbol: d.settlement_symbol,
      },
    });

    // The settlement_symbol carries the precision and ticker we need to find
    // the token contract via the same `supported_tokens` registry used for
    // blends (loaded from `blend.nefty/config`). For drops priced in tokens
    // NeftyBlocks doesn't register, this will throw — at that point the user
    // would need a manual fallback (out of scope here).
    const contract = await resolveTokenContractForDrop(d.listing_price, d.settlement_symbol);
    actions.push({
      account: contract,
      name: 'transfer',
      authorization: auth,
      data: {
        from: args.claimer,
        to: 'neftyblocksd',
        quantity: d.listing_price,
        memo: 'deposit',
      },
    });
  }

  // 3. claim — variant depends on auth flavour.
  const currency = d.is_free ? d.settlement_symbol || '8,WAX' : d.settlement_symbol;
  const commonClaim = {
    claimer: args.claimer,
    drop_id: d.drop_id,
    amount: args.amount,
    intended_delphi_median: defaults.intended_delphi_median,
    referrer: defaults.referrer,
    country: defaults.country,
    currency,
    referrer_account: defaults.referrer_account,
  };

  switch (d.auth.kind) {
    case 'public':
      actions.push({
        account: 'neftyblocksd',
        name: 'claimdrop',
        authorization: auth,
        data: commonClaim,
      });
      break;
    case 'whitelist':
      actions.push({
        account: 'neftyblocksd',
        name: 'claimdropwl',
        authorization: auth,
        data: commonClaim,
      });
      break;
    case 'proof': {
      const ids = args.proof_asset_ids ?? d.auth.resolved?.asset_ids ?? [];
      if (ids.length === 0) {
        throw new Error('This drop requires NFT-ownership proof, but no eligible asset_ids were provided.');
      }
      // claimwproof has the same fields as claimdrop *plus* `asset_ids` —
      // the contract's ABI puts it between `referrer` and `country`.
      actions.push({
        account: 'neftyblocksd',
        name: 'claimwproof',
        authorization: auth,
        data: {
          claimer: args.claimer,
          drop_id: d.drop_id,
          amount: args.amount,
          intended_delphi_median: defaults.intended_delphi_median,
          referrer: defaults.referrer,
          asset_ids: ids,
          country: defaults.country,
          currency,
          referrer_account: defaults.referrer_account,
        },
      });
      break;
    }
    case 'authkey':
      throw new Error(
        'This drop is gated by a cryptographic authkey (claimdropkey). The drop creator must sign a per-user message to allow claims — not supported by this tool.',
      );
    case 'unverified':
      throw new Error(
        'This drop is gated — connect your wallet so the page can verify your access (whitelist / NFT proof) before signing.',
      );
    case 'unclaimable':
      throw new Error(
        "This drop has auth_required = true but no auth list is populated on-chain. The contract will refuse every claim until the creator fixes the config.",
      );
    default:
      throw new Error('Unknown drop auth flavour — cannot build claim.');
  }

  return actions;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export async function executeClaim(
  session: Session,
  args: Omit<ClaimArgs, 'claimer'>,
) {
  const actions = await buildClaimActions({
    ...args,
    claimer: String(session.actor),
  });
  return session.transact({ actions });
}

/**
 * Find the token contract for a drop's listing price. NeftyBlocks drops use
 * their *own* supported_tokens list (separate from blend.nefty's), but the
 * data lives in `neftyblocksd/config`. WAX is a special case — eosio.token.
 */
async function resolveTokenContractForDrop(quantity: string, _symbol: string): Promise<string> {
  const sym = symbolFromQuantity(quantity);
  if (sym === '8,WAX') return 'eosio.token';
  // Try the blend.nefty registry first — it's the larger of the two and
  // mostly a superset.
  try {
    return await resolveTokenContract(quantity);
  } catch { /* fall through to neftyblocksd-specific lookup */ }
  return resolveFromDropsConfig(sym);
}

import { getTableRows } from '../chain/rpc';
interface DropsConfig {
  supported_tokens: { token_contract: string; token_symbol: string }[];
}
let dropsConfigCache: DropsConfig | undefined;
async function resolveFromDropsConfig(sym: string): Promise<string> {
  if (!dropsConfigCache) {
    const rows = await getTableRows<DropsConfig>({
      code: 'neftyblocksd',
      scope: 'neftyblocksd',
      table: 'config',
      limit: 1,
    });
    if (rows.length === 0) throw new Error('Cannot read neftyblocksd config');
    dropsConfigCache = rows[0];
  }
  const found = dropsConfigCache.supported_tokens.find((t) => t.token_symbol === sym);
  if (!found) {
    throw new Error(`Token ${sym} is not registered in either blend.nefty or neftyblocksd. Cannot derive its contract.`);
  }
  return found.token_contract;
}
