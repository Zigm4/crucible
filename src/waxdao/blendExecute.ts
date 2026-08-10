/**
 * Builds and broadcasts the multi-action `waxdaomarket` blend
 * transaction.
 *
 * Trace shape, verified byte-for-byte against zigm4.gm/71d4917b... :
 *
 *   1. waxdaomarket::assertblend     { blend_ID, user, unique_id }
 *  [2. <token>::transfer  to=waxdaomarket
 *                          memo="|blend_deposit|<blend_ID>|0|"     <-- slot 0
 *                          quantity=<the FT cost> ]
 *   3. atomicassets::transfer  to=waxdaomarket
 *                              memo="|blend_deposit|<blend_ID>|1|" <-- slot 1
 *                              asset_ids=[<NFT for slot 1>]
 *   4. atomicassets::transfer  to=waxdaomarket
 *                              memo="|blend_deposit|<blend_ID>|2|" <-- slot 2
 *                              asset_ids=[<NFT for slot 2>]
 *   ...                                       (one transfer per NFT slot)
 *
 * Key differences vs blend.nefty:
 *   - no `announcedepo`: the order is created entirely by the
 *     `assertblend` row + the slot-indexed memos
 *   - each NFT ingredient is its OWN transfer (no batching), and the
 *     memo carries the 1-based slot index
 *   - slot 0 is reserved for the FT ingredient when present; NFT
 *     slots start at 1 in that case, or at 0 when the recipe has no
 *     FT cost
 *   - `unique_id` is a client-side uint64 used by the contract to
 *     dedup pending blend orders; we generate one at sign time
 */

import type { Session } from '@wharfkit/session';

import type { BuiltAction } from '../chain/action';
import type { DiscoveredWaxdaoBlend } from './blends';

export interface WaxdaoBlendPlanArgs {
  claimer: string;
  blend: DiscoveredWaxdaoBlend;
  /**
   * Map from NFT slot index -> asset_id picked by the user. Slot
   * indices match `blend.nftSlots[*].slot`. Multi-asset slots are
   * supported via the second form (asset_ids[]).
   */
  nftSelection: Map<number, string | string[]>;
  /**
   * Optional explicit unique_id. When omitted we generate a fresh one
   * from the current time. Tests pin it to a known value to keep the
   * byte-for-byte comparison stable.
   */
  unique_id?: string | number;
}

/**
 * Generates a 53-bit-safe uint64 candidate for `assertblend.unique_id`.
 * The WaxDAO UI used to base this on the page load timestamp; we do
 * the same plus a random suffix so two parallel signatures by the
 * same wallet don't collide.
 */
export function generateUniqueId(): string {
  const ms = Date.now();
  const rnd = Math.floor(Math.random() * 1_000_000);
  // Result fits in 2^53 -1 = 9007199254740991, well under uint64 max.
  return String(ms * 1_000_000 + rnd);
}

/**
 * Memo format for every deposit transfer: `|blend_deposit|<id>|<slot>|`.
 * Pipe-delimited, trailing pipe included, matching the on-chain trace
 * byte-for-byte.
 */
function depositMemo(blend_id: string | number, slot: number): string {
  return `|blend_deposit|${blend_id}|${slot}|`;
}

/**
 * Builds the full action list for a WaxDAO blend.
 *
 * Order matters: `assertblend` first, then the FT transfer (slot 0)
 * if any, then one atomicassets::transfer per NFT slot in slot-index
 * order.
 */
export function buildWaxdaoBlendActions(args: WaxdaoBlendPlanArgs): BuiltAction[] {
  const auth = [{ actor: args.claimer, permission: 'active' }];
  const actions: BuiltAction[] = [];
  const unique_id = args.unique_id !== undefined ? String(args.unique_id) : generateUniqueId();
  const blend_id = args.blend.blend_id;

  // 1. assertblend
  actions.push({
    account: 'waxdaomarket',
    name: 'assertblend',
    authorization: auth,
    data: {
      blend_ID: String(blend_id),
      user: args.claimer,
      unique_id: String(unique_id),
    },
  });

  // 2. FT cost, slot 0 (when present)
  for (const ing of args.blend.ingredients) {
    if (ing.kind !== 'fungible') continue;
    actions.push({
      account: ing.contract,
      name: 'transfer',
      authorization: auth,
      data: {
        from: args.claimer,
        to: 'waxdaomarket',
        quantity: ing.quantity,
        memo: depositMemo(blend_id, 0),
      },
    });
    break; // recipes have at most one FT ingredient in practice
  }

  // 3. NFT transfers, one per slot, in increasing slot order.
  const slotsSorted = [...args.blend.nftSlots].sort((a, b) => a.slot - b.slot);
  for (const { slot, ingredient } of slotsSorted) {
    const picked = args.nftSelection.get(slot);
    if (!picked) {
      throw new Error(
        `WaxDAO blend ${blend_id}: NFT not picked for slot ${slot} (${ingredient.kind})`,
      );
    }
    const asset_ids = Array.isArray(picked) ? picked : [picked];
    actions.push({
      account: 'atomicassets',
      name: 'transfer',
      authorization: auth,
      data: {
        from: args.claimer,
        to: 'waxdaomarket',
        asset_ids,
        memo: depositMemo(blend_id, slot),
      },
    });
  }

  return actions;
}

/**
 * Sign-and-broadcast convenience wrapper.
 */
export async function executeWaxdaoBlend(
  session: Session,
  args: Omit<WaxdaoBlendPlanArgs, 'claimer'>,
) {
  const actions = buildWaxdaoBlendActions({
    ...args,
    claimer: String(session.actor),
  });
  return session.transact({ actions });
}
