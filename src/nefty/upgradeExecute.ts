/**
 * Builds and broadcasts the `up.nefty::upgrade` transaction.
 *
 * Trace shape, verified against zigm4.gm/b92981ab... :
 *
 *   [0a. up.nefty::openbal               once per (owner, FT symbol) ever]
 *   [0b. <token>::transfer  memo=deposit one per FT ingredient]
 *    1.  up.nefty::announcedepo          { owner, count }
 *   [2.  atomicassets::transfer          memo=deposit, when ingredients
 *         include NFT requirements that get burned]
 *    3.  up.nefty::upgrade               { claimer, upgrade_id,
 *                                          transferred_assets,
 *                                          own_assets,
 *                                          assets_to_upgrade }
 *
 * `assets_to_upgrade` is the key differentiator vs `blend.nefty`: those
 * are NFTs the user OWNS that get mutated in place (their on-chain
 * mutable_data is rewritten). They do not leave the wallet.
 *
 * `transferred_assets` is the list of NFTs being deposited as cost
 * (for blends with NFT ingredients). Empty for FT-only upgrades like
 * the underpunks55 colour upgrades.
 *
 * `own_assets` mirrors the same field on blend.nefty: NFTs the user
 * holds (not deposited) that the contract should "see" when evaluating
 * the recipe. Almost always empty in practice.
 *
 * `upgradesec` is the security-gated variant, used when the upgrade
 * has security_id != 0. It adds a SECURITY_CHECK field identical to
 * the one on `blend.nefty::fuse`. We pass a no-op WHITELIST_CHECK
 * carrying the claimer's own name for non-secured / whitelist-secured
 * upgrades, which is what every recent on-chain trace does.
 */

import type { Session } from '@wharfkit/session';

import {
  hasOpenBalance,
  resolveTokenContract,
  symbolFromQuantity,
} from './tokens';
import type { BuiltAction } from '../chain/action';
import type { SecurityCheck } from './rngExecute';

export interface UpgradePlanArgs {
  claimer: string;
  upgrade_id: string | number;
  /** NFTs to upgrade (mutated in place, stay in the wallet). */
  assets_to_upgrade: string[];
  /** NFTs deposited as cost (burned / transferred to the upgrade's effect target). */
  transferred_assets: string[];
  /** NFTs held but not deposited. Usually []. */
  own_assets?: string[];
  /** Token-denominated costs, e.g. ["10.00000000 WAX"]. */
  ft_payments: string[];
  /** Optional security gate. Defaults to a no-op WHITELIST_CHECK with the claimer's name. */
  security_check?: SecurityCheck;
}

/**
 * Builds the action list for a `up.nefty::upgrade` transaction.
 *
 * When `security_check` is provided we emit `upgradesec` instead of the
 * plain `upgrade`. Both variants share every other field.
 */
export async function buildUpgradeActions(args: UpgradePlanArgs): Promise<BuiltAction[]> {
  const auth = [{ actor: args.claimer, permission: 'active' }];
  const actions: BuiltAction[] = [];

  // 1. openbal for each token symbol the user hasn't deposited yet.
  for (const qty of args.ft_payments) {
    const symbol = symbolFromQuantity(qty);
    let already = false;
    try {
      already = await hasOpenBalance({ owner: args.claimer, symbol, contract: 'up.nefty' });
    } catch {
      already = false;
    }
    if (!already) {
      actions.push({
        account: 'up.nefty',
        name: 'openbal',
        authorization: auth,
        data: { owner: args.claimer, token_symbol: symbol },
      });
    }
  }

  // 2. token transfers (one per FT ingredient)
  for (const qty of args.ft_payments) {
    const contract = await resolveTokenContract(qty);
    actions.push({
      account: contract,
      name: 'transfer',
      authorization: auth,
      data: {
        from: args.claimer,
        to: 'up.nefty',
        quantity: qty,
        memo: 'deposit',
      },
    });
  }

  // 3. announcedepo + atomicassets::transfer: ONLY when the recipe has
  //    NFT ingredients to deposit. FT-only upgrades skip both legs.
  //    This matches the on-chain trace: zigm4.gm/b92981ab (FT-only, 10
  //    WAX) has no announcedepo, while zigm4.gm/24f65725 (FT + NFT)
  //    does.
  if (args.transferred_assets.length > 0) {
    actions.push({
      account: 'up.nefty',
      name: 'announcedepo',
      authorization: auth,
      data: { owner: args.claimer, count: args.transferred_assets.length },
    });
    actions.push({
      account: 'atomicassets',
      name: 'transfer',
      authorization: auth,
      data: {
        from: args.claimer,
        to: 'up.nefty',
        asset_ids: args.transferred_assets,
        memo: 'deposit',
      },
    });
  }

  // 5. upgrade or upgradesec depending on whether a security check is
  //    required.
  if (args.security_check) {
    const sc = encodeSecurityCheck(args.security_check);
    actions.push({
      account: 'up.nefty',
      name: 'upgradesec',
      authorization: auth,
      data: {
        claimer: args.claimer,
        upgrade_id: String(args.upgrade_id),
        transferred_assets: args.transferred_assets,
        own_assets: args.own_assets ?? [],
        assets_to_upgrade: args.assets_to_upgrade,
        security_check: sc,
      },
    });
  } else {
    actions.push({
      account: 'up.nefty',
      name: 'upgrade',
      authorization: auth,
      data: {
        claimer: args.claimer,
        upgrade_id: String(args.upgrade_id),
        transferred_assets: args.transferred_assets,
        own_assets: args.own_assets ?? [],
        assets_to_upgrade: args.assets_to_upgrade,
      },
    });
  }

  return actions;
}

function encodeSecurityCheck(s: SecurityCheck): [string, Record<string, unknown>] {
  if (s.kind === 'whitelist') {
    return ['WHITELIST_CHECK', { account_name: s.account_name }];
  }
  return [
    'OWNERSHIP_CHECK',
    { account_name: s.account_name, asset_ids: s.asset_ids },
  ];
}

/**
 * Sign-and-broadcast convenience wrapper. Mirrors `executeBlend` /
 * `executeClaim` so the UI shell stays uniform.
 */
export async function executeUpgrade(
  session: Session,
  args: Omit<UpgradePlanArgs, 'claimer'>,
) {
  const actions = await buildUpgradeActions({
    ...args,
    claimer: String(session.actor),
  });
  return session.transact({ actions });
}
