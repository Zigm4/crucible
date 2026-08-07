/**
 * Builds and broadcasts a `blenderizerx` blend.
 *
 * This is the simplest transaction in the whole app: ONE action.
 *
 *   atomicassets::transfer  from   = <claimer>
 *                           to     = blenderizerx
 *                           memo   = "<target_template_id>"
 *                           asset_ids = [every NFT the recipe burns]
 *
 * The contract has no blend/mix action of its own - it reacts to the
 * AtomicAssets transfer notification, mints the target to the sender,
 * then burns the deposited NFTs. Verified against a real trace
 * (cryptoviking, memo "106051", 11 NFTs in a single transfer: one
 * `mintasset` of template 106051 followed by 11 `burnasset`).
 *
 * Compared to the other two platforms:
 *   - blend.nefty  : announcedepo + transfer + nosecfuse/fuse (+ claim)
 *   - waxdaomarket : assertblend + one transfer PER ingredient slot
 *   - blenderizerx : a single transfer carrying every NFT at once
 *
 * There is no announce step, no oracle, no second signature, and no
 * token cost - `blenders` rows carry nothing but templates.
 *
 * Two failure modes worth knowing about, neither visible in the ABI:
 *   - the collection must have a `rambalance` on the contract (the
 *     author pre-pays the RAM the mint consumes)
 *   - a capped target that is fully minted cannot be produced
 * Both are surfaced by the UI before signing; the contract itself just
 * rejects the transfer, which reverts the whole transaction.
 */

import type { Session } from '@wharfkit/session';

import type { BuiltAction } from '../nefty/execute';
import { BLENDERIZER_CONTRACT, type DiscoveredBlenderizerBlend } from './blends';

export interface BlenderizerPlanArgs {
  claimer: string;
  blend: DiscoveredBlenderizerBlend;
  /**
   * Picked asset_ids per slot index (matching `blend.slots[*].index`).
   * Every slot must be filled with exactly `amount` ids.
   */
  selection: Map<number, string[]>;
}

/**
 * Flattens the per-slot selection into the single asset_ids array the
 * transfer carries, in slot order. Throws when a slot is short so the
 * caller never builds a transaction the contract would reject.
 */
export function flattenBlenderizerSelection(
  blend: DiscoveredBlenderizerBlend,
  selection: Map<number, string[]>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const slot of blend.slots) {
    const picked = selection.get(slot.index) ?? [];
    if (picked.length !== slot.amount) {
      throw new Error(
        `Slot #${slot.index} (template ${slot.template_id}): ${picked.length}/${slot.amount} NFTs picked.`,
      );
    }
    for (const id of picked) {
      if (seen.has(id)) {
        throw new Error(`Asset ${id} is used twice in this recipe.`);
      }
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * The whole transaction: one transfer whose memo is the target
 * template_id (which is also the recipe's primary key).
 */
export function buildBlenderizerBlendActions(args: BlenderizerPlanArgs): BuiltAction[] {
  const asset_ids = flattenBlenderizerSelection(args.blend, args.selection);
  return [
    {
      account: 'atomicassets',
      name: 'transfer',
      authorization: [{ actor: args.claimer, permission: 'active' }],
      data: {
        from: args.claimer,
        to: BLENDERIZER_CONTRACT,
        asset_ids,
        memo: String(args.blend.target),
      },
    },
  ];
}

/** Sign-and-broadcast convenience wrapper. */
export async function executeBlenderizerBlend(
  session: Session,
  args: Omit<BlenderizerPlanArgs, 'claimer'>,
) {
  const actions = buildBlenderizerBlendActions({
    ...args,
    claimer: String(session.actor),
  });
  return session.transact({ actions });
}
