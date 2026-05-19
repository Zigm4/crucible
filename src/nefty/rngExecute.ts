/**
 * Builds and broadcasts the two transactions of a random-result blend
 * (`fuse` + `claim`).
 *
 * Unlike `nosecfuse` (deterministic blends), `fuse` triggers a commit-
 * reveal dance: the contract either resolves the result inline (when no
 * actual randomness is needed) or queues an ORNG job that fires back a
 * few seconds later. Either way, the resolved outcome is staged in the
 * `claimassets` table keyed by `claim_id`, and the user has to sign a
 * second transaction (`claim`) to actually mint the cards.
 *
 * On-chain trace skeleton (5 to 7 actions in TX1, 1 action in TX2):
 *
 *   TX1 (announce + deposit + fuse, signed by the user):
 *     [0a. blend.nefty::openbal         once per (owner, symbol) ever]
 *     [0b. <token>::transfer            for token-paying blends]
 *      1.  blend.nefty::announcedepo    { owner, count }
 *     [2.  atomicassets::transfer       { ..., memo: "deposit" }    ]
 *      3.  blend.nefty::fuse            { claimer, blend_id,
 *                                         transferred_assets,
 *                                         own_assets,
 *                                         security_check }
 *
 *   ... wait for claimassets[claimer] to gain a new row ...
 *
 *   TX2 (claim, signed by the user):
 *      blend.nefty::claim               { claim_id, roll_indexes }
 *
 * `security_check` is mandatory on every `fuse`. For blends without a
 * `security_id` we fall back to a no-op `WHITELIST_CHECK` carrying the
 * claimer's own name, which the contract simply accepts.
 *
 * The historical `neftybrespay::paycpu` action that used to lead the
 * trace is intentionally omitted, that payer is no longer running.
 */

import type { Session } from '@wharfkit/session';

import {
  hasOpenBalance,
  resolveTokenContract,
  symbolFromQuantity,
} from './tokens';
import type { BuiltAction } from './execute';

/**
 * The variant tag for the `SECURITY_CHECK` field. The contract supports
 * either a simple whitelist proof (just an account name) or a proof of
 * ownership over a specific set of assets.
 */
export type SecurityCheck =
  | { kind: 'whitelist'; account_name: string }
  | { kind: 'ownership'; account_name: string; asset_ids: string[] };

/**
 * Encodes our SecurityCheck union into the WharfKit-friendly variant
 * literal the ABI expects (a `[tag, payload]` tuple).
 */
function encodeSecurityCheck(s: SecurityCheck): [string, Record<string, unknown>] {
  if (s.kind === 'whitelist') {
    return ['WHITELIST_CHECK', { account_name: s.account_name }];
  }
  return [
    'OWNERSHIP_CHECK',
    { account_name: s.account_name, asset_ids: s.asset_ids },
  ];
}

export interface RngPlanArgs {
  claimer: string;
  blend_id: string | number;
  /** NFTs we're depositing (transferred_assets). Can be empty for FT-only blends. */
  asset_ids: string[];
  /** Token costs as asset strings: "105.00000000 UPMAX". */
  ft_payments: string[];
  /** NFTs we hold (not transferred) that the contract should consider. Usually []. */
  own_assets?: string[];
  /** Mandatory: shape of the contract's security guard for this blend. */
  security_check: SecurityCheck;
}

/**
 * Builds the announce + fuse leg. The TX2 (claim) is built separately
 * once we've waited for the contract to stage the result.
 */
export async function buildFuseActions(args: RngPlanArgs): Promise<BuiltAction[]> {
  const auth = [{ actor: args.claimer, permission: 'active' }];
  const actions: BuiltAction[] = [];

  // 1. openbal: only the first time a given (owner, symbol) pair is
  //    used, otherwise the inline RAM allocation would fail.
  for (const qty of args.ft_payments) {
    const symbol = symbolFromQuantity(qty);
    let already = false;
    try {
      already = await hasOpenBalance({ owner: args.claimer, symbol });
    } catch {
      already = false;
    }
    if (!already) {
      actions.push({
        account: 'blend.nefty',
        name: 'openbal',
        authorization: auth,
        data: { owner: args.claimer, token_symbol: symbol },
      });
    }
  }

  // 2. token transfers, one per FT requirement
  for (const qty of args.ft_payments) {
    const contract = await resolveTokenContract(qty);
    actions.push({
      account: contract,
      name: 'transfer',
      authorization: auth,
      data: {
        from: args.claimer,
        to: 'blend.nefty',
        quantity: qty,
        memo: 'deposit',
      },
    });
  }

  // 3. announcedepo (count = NFTs being deposited, even when 0)
  actions.push({
    account: 'blend.nefty',
    name: 'announcedepo',
    authorization: auth,
    data: { owner: args.claimer, count: args.asset_ids.length },
  });

  // 4. NFT transfer (skip when FT-only)
  if (args.asset_ids.length > 0) {
    actions.push({
      account: 'atomicassets',
      name: 'transfer',
      authorization: auth,
      data: {
        from: args.claimer,
        to: 'blend.nefty',
        asset_ids: args.asset_ids,
        memo: 'deposit',
      },
    });
  }

  // 5. fuse (instead of nosecfuse), with the mandatory security_check
  actions.push({
    account: 'blend.nefty',
    name: 'fuse',
    authorization: auth,
    data: {
      claimer: args.claimer,
      blend_id: String(args.blend_id),
      transferred_assets: args.asset_ids,
      own_assets: args.own_assets ?? [],
      security_check: encodeSecurityCheck(args.security_check),
    },
  });

  return actions;
}

/**
 * TX2 builder: claim the staged result. `roll_indexes` is one entry per
 * roll in the blend; the convention used by every recent on-chain claim
 * is `[0, 0, ..., 0]` (pick the first / only result of each rolled
 * outcome).
 */
export function buildClaimAction(args: {
  claimer: string;
  claim_id: string | number;
  roll_count: number;
}): BuiltAction {
  return {
    account: 'blend.nefty',
    name: 'claim',
    authorization: [{ actor: args.claimer, permission: 'active' }],
    data: {
      claim_id: String(args.claim_id),
      roll_indexes: Array.from({ length: Math.max(1, args.roll_count) }, () => 0),
    },
  };
}

/**
 * Convenience wrapper: signs and broadcasts the fuse leg.
 */
export async function executeFuse(
  session: Session,
  args: Omit<RngPlanArgs, 'claimer'>,
) {
  const actions = await buildFuseActions({
    ...args,
    claimer: String(session.actor),
  });
  return session.transact({ actions });
}

/**
 * Convenience wrapper: signs and broadcasts the claim leg.
 */
export async function executeClaim(
  session: Session,
  args: { claim_id: string | number; roll_count: number },
) {
  const action = buildClaimAction({
    claimer: String(session.actor),
    claim_id: args.claim_id,
    roll_count: args.roll_count,
  });
  return session.transact({ actions: [action] });
}
