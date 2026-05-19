/**
 * Builds and broadcasts the blend transaction.
 *
 * Three-or-five actions, in the exact order the on-chain trace of a real
 * Nefty blend uses:
 *   1. blend.nefty::announcedepo            - announce N NFTs are coming
 *   2. atomicassets::transfer  memo deposit - actually transfer the N NFTs
 *   3. blend.nefty::nosecfuse               - burn them, mint the result
 *
 * For blends that also cost a fungible token (UPMAX, GUILD, ...), two more
 * actions lead the sequence:
 *   0a. blend.nefty::openbal      - reserve a balance slot for that symbol
 *   0b. <token>::transfer         - pay the cost
 * The openbal is auto-skipped when the user already has a balance row.
 *
 * The historical neftybrespay::paycpu action is intentionally omitted,
 * that payer no longer signs.
 */
import type { Session } from '@wharfkit/session';

import {
  hasOpenBalance,
  resolveTokenContract,
  symbolFromQuantity,
} from './tokens';

export interface PlanArgs {
  claimer: string;
  blend_id: string | number;
  asset_ids: string[]; // NFTs to transfer (can be empty if FT-only blend)
  ft_payments: string[]; // asset strings like "105.00000000 UPMAX"
  own_assets?: string[];
}

export interface BuiltAction {
  account: string;
  name: string;
  authorization: { actor: string; permission: string }[];
  data: Record<string, unknown>;
}

/**
 * Builds the full action list for a `nosecfuse` blend, including the optional
 * token payment leg.
 *
 * Order (matches the on-chain trace of a real blend):
 *   1. openbal          : once per token symbol the user hasn't opened yet
 *   2. <token>::transfer, one per FT ingredient, memo "deposit"
 *   3. announcedepo     : count = number of NFTs being transferred (0 ok)
 *   4. atomicassets::transfer, only if asset_ids.length > 0
 *   5. nosecfuse        : claimer, blend_id, transferred_assets, own_assets
 *
 * The Nefty-paid `neftybrespay::paycpu` action that used to lead the trace is
 * intentionally omitted: that payer no longer signs, so we'd just bake a
 * permanent error into every tx.
 */
export async function buildBlendActions(args: PlanArgs): Promise<BuiltAction[]> {
  const auth = [{ actor: args.claimer, permission: 'active' }];
  const actions: BuiltAction[] = [];

  // 1. openbal, only the first time a given (owner, symbol) pair is used,
  //    otherwise the inline RAM allocation would fail.
  for (const qty of args.ft_payments) {
    const symbol = symbolFromQuantity(qty);
    let already = false;
    try {
      already = await hasOpenBalance({ owner: args.claimer, symbol });
    } catch {
      // If we can't tell, err on the side of including it. Most contracts
      // tolerate redundant openbal calls (the user already paid the RAM).
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

  // 3. announcedepo for the NFT leg (count = NFT count, even 0)
  actions.push({
    account: 'blend.nefty',
    name: 'announcedepo',
    authorization: auth,
    data: { owner: args.claimer, count: args.asset_ids.length },
  });

  // 4. NFT transfer (skip when no NFTs, FT-only blends are valid)
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

  // 5. nosecfuse
  actions.push({
    account: 'blend.nefty',
    name: 'nosecfuse',
    authorization: auth,
    data: {
      claimer: args.claimer,
      blend_id: String(args.blend_id),
      transferred_assets: args.asset_ids,
      own_assets: args.own_assets ?? [],
    },
  });

  return actions;
}

export async function executeBlend(
  session: Session,
  args: Omit<PlanArgs, 'claimer'>,
) {
  const actions = await buildBlendActions({
    ...args,
    claimer: String(session.actor),
  });
  return session.transact({ actions });
}
