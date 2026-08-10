/**
 * Pack unbox transactions for atomicpacksx.
 *
 * Unboxing a pack is a two-step commit-reveal flow:
 *
 *   TX1 (commit):
 *     atomicassets::transfer(pack_asset_id -> atomicpacksx, memo "unbox")
 *
 *   ...wait for ORNG to call back the contract (typically 5-30s)...
 *
 *   TX2 (reveal):
 *     atomicpacksx::claimunboxed({ pack_asset_id, origin_roll_ids })
 *
 * Between the two, the user does NOTHING; the app polls the
 * atomicpacksx::unboxassets table (scoped by pack_asset_id) until the
 * oracle has written the resolved outcomes. Then the second action just
 * passes every roll_id we found back to the contract, which mints them.
 */

import type { Session } from '@wharfkit/session';

// One definition for the whole project, in chain/. Re-exported here so
// existing importers of this module keep working.
import type { BuiltAction } from '../chain/action';
export type { BuiltAction };

/**
 * Builds TX1: the transfer of the pack NFT to atomicpacksx with memo
 * "unbox". The contract picks this up via its receiver and queues an
 * ORNG randomness request internally.
 */
export function buildUnboxAnnounce(args: {
  claimer: string;
  pack_asset_id: string | number;
}): BuiltAction[] {
  const auth = [{ actor: args.claimer, permission: 'active' }];
  return [
    {
      account: 'atomicassets',
      name: 'transfer',
      authorization: auth,
      data: {
        from: args.claimer,
        to: 'atomicpacksx',
        asset_ids: [String(args.pack_asset_id)],
        memo: 'unbox',
      },
    },
  ];
}

/**
 * Builds TX2: the claim of the resolved outcomes. `origin_roll_ids` is
 * the array of roll indexes returned by the ORNG callback (read from
 * `unboxassets scope=pack_asset_id`). Must include every roll the pack
 * produced, not a subset -- the contract validates the count.
 */
export function buildUnboxClaim(args: {
  claimer: string;
  pack_asset_id: string | number;
  origin_roll_ids: (string | number)[];
}): BuiltAction[] {
  const auth = [{ actor: args.claimer, permission: 'active' }];
  return [
    {
      account: 'atomicpacksx',
      name: 'claimunboxed',
      authorization: auth,
      data: {
        pack_asset_id: String(args.pack_asset_id),
        origin_roll_ids: args.origin_roll_ids.map((r) => String(r)),
      },
    },
  ];
}

export async function executeUnboxAnnounce(
  session: Session,
  pack_asset_id: string | number,
) {
  const actions = buildUnboxAnnounce({
    claimer: String(session.actor),
    pack_asset_id,
  });
  return session.transact({ actions });
}

export async function executeUnboxClaim(
  session: Session,
  args: { pack_asset_id: string | number; origin_roll_ids: (string | number)[] },
) {
  const actions = buildUnboxClaim({ claimer: String(session.actor), ...args });
  return session.transact({ actions });
}
