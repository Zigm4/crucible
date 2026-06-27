/**
 * Polls for the ORNG callback after a neftyblocksp pack-unbox announcement.
 *
 * After the user transfers a pack to neftyblocksp with memo "unbox", the
 * contract requests randomness and, on the ORNG callback, writes a row to
 * `claimassets` (scope = neftyblocksp, primary key = claim_id) where
 * claim_id == the pack's own asset_id. The row's `claims` array is the list
 * of resolved outcomes (ON_DEMAND_NFT_CLAIM / POOL_NFT_CLAIM).
 *
 * We watch that table for our claim_id and resolve once the row exists with
 * at least one claim. The reveal (`claim`) then passes roll_indexes
 * [0..claims.length-1]. Shape mirrors packWait.ts so the UI can treat both
 * pack sources uniformly (UnboxAssetRow = { origin_roll_id, template_id }).
 */
import { getTableRows } from '../chain/rpc';

import type { UnboxAssetRow } from './packWait';

interface RawClaimRow {
  claim_id: number | string;
  recipient: string;
  claims?: [string, { template_id?: number; asset_id?: string }][];
}

export interface NeftyWaitOpts {
  /** The pack NFT's asset_id (== the staged claim_id). */
  pack_asset_id: string | number;
  timeoutMs?: number;
  intervalMs?: number;
  onTick?: (elapsedMs: number) => void;
  signal?: AbortSignal;
}

/**
 * Resolves with one UnboxAssetRow per staged claim as soon as the
 * `claimassets` row for this pack appears. POOL_NFT_CLAIM outcomes (which
 * carry an asset_id, not a template_id) surface with template_id 0 - the
 * count is what matters for the reveal; names are best-effort.
 */
export async function waitForNeftyClaim(opts: NeftyWaitOpts): Promise<UnboxAssetRow[]> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const target = String(opts.pack_asset_id);
  const start = Date.now();

  while (true) {
    if (opts.signal?.aborted) throw new Error('Wait aborted by user');
    const elapsed = Date.now() - start;
    opts.onTick?.(elapsed);
    if (elapsed > timeoutMs) {
      throw new Error(
        `ORNG callback didn't arrive within ${Math.round(timeoutMs / 1000)}s. ` +
          `The chain may be congested or the oracle is delayed. Your pack is still safe in the neftyblocksp contract - you can retry the claim later.`,
      );
    }
    let rows: RawClaimRow[] = [];
    try {
      rows = await getTableRows<RawClaimRow>({
        code: 'neftyblocksp',
        scope: 'neftyblocksp',
        table: 'claimassets',
        lower_bound: target,
        limit: 1,
      });
    } catch {
      // transient RPC error; retry next tick
    }
    const row = rows[0];
    if (row && String(row.claim_id) === target && (row.claims?.length ?? 0) > 0) {
      return (row.claims ?? []).map((c, i) => ({
        origin_roll_id: i,
        template_id: Number(c?.[1]?.template_id ?? 0),
      }));
    }
    await sleep(intervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
