/**
 * Pack unbox transactions for neftyblocksp (NeftyBlocks-native packs).
 *
 * Same commit-reveal shape as atomicpacksx, different contract + reveal:
 *
 *   TX1 (commit):
 *     atomicassets::transfer(pack_asset_id -> neftyblocksp, memo "unbox")
 *
 *   ...wait for ORNG -> a `claimassets` row keyed by claim_id == the pack's
 *      own asset_id, holding N staged `claims`...
 *
 *   TX2 (reveal):
 *     neftyblocksp::claim({ claim_id, roll_indexes: [0,1,...,N-1] })
 *
 * Verified against the live ABI and real on-chain unboxings: the open memo
 * is "unbox" (same as atomicpacksx), the staged claim_id equals the pack's
 * asset_id, and the reveal passes one sequential roll index per staged claim.
 */
import type { Session } from '@wharfkit/session';

import type { BuiltAction } from '../chain/action';

/** TX1: transfer the pack NFT to neftyblocksp with memo "unbox". */
export function buildNeftyUnboxAnnounce(args: {
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
        to: 'neftyblocksp',
        asset_ids: [String(args.pack_asset_id)],
        memo: 'unbox',
      },
    },
  ];
}

/** TX2: claim the staged results. roll_indexes is [0..roll_count-1]. */
export function buildNeftyUnboxClaim(args: {
  claimer: string;
  claim_id: string | number;
  roll_count: number;
}): BuiltAction[] {
  const auth = [{ actor: args.claimer, permission: 'active' }];
  return [
    {
      account: 'neftyblocksp',
      name: 'claim',
      authorization: auth,
      data: {
        claim_id: String(args.claim_id),
        roll_indexes: Array.from({ length: Math.max(1, args.roll_count) }, (_, i) => i),
      },
    },
  ];
}

export async function executeNeftyUnboxAnnounce(session: Session, pack_asset_id: string | number) {
  const actions = buildNeftyUnboxAnnounce({ claimer: String(session.actor), pack_asset_id });
  return session.transact({ actions });
}

export async function executeNeftyUnboxClaim(
  session: Session,
  args: { claim_id: string | number; roll_count: number },
) {
  const actions = buildNeftyUnboxClaim({ claimer: String(session.actor), ...args });
  return session.transact({ actions });
}
