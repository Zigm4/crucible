/**
 * Polls the chain waiting for ORNG to call atomicpacksx back after a
 * pack-unbox announcement transaction.
 *
 * On-chain, after the user transfers a pack with memo "unbox", the
 * atomicpacksx contract:
 *   1. creates a row in `unboxpacks` (scope=atomicpacksx, key=pack_asset_id)
 *   2. requests randomness from the ORNG oracle
 *   3. waits for an ORNG callback (typically 5-30s on WAX)
 *   4. on callback, writes N rows to `unboxassets` (scope=pack_asset_id,
 *      key=origin_roll_id) recording the resolved outcomes
 *
 * `waitForUnboxAssets` watches the `unboxassets` table for that
 * pack_asset_id and resolves once at least one row appears (we then
 * read them ALL for the claim).
 *
 * Why a manual poll rather than a websocket subscription? Public WAX
 * RPC nodes don't expose a stable push subscription. Polling every 2s
 * with failover across multiple nodes is reliable, cheap, and dead
 * simple.
 */

import { getTableRows } from '../chain/rpc';

export interface WaitOpts {
  pack_asset_id: string | number;
  /** Total time to wait before giving up (ms). Default: 90 seconds. */
  timeoutMs?: number;
  /** Time between table polls (ms). Default: 2 seconds. */
  intervalMs?: number;
  /** Called on every poll with the elapsed time (for UI countdown). */
  onTick?: (elapsedMs: number) => void;
  /** Set an AbortSignal to let the caller cancel mid-wait. */
  signal?: AbortSignal;
}

export interface UnboxAssetRow {
  origin_roll_id: number | string;
  template_id: number;
}

/**
 * Resolves with the rows from `unboxassets scope=pack_asset_id` as soon
 * as at least one exists. Rejects on timeout or abort.
 *
 * The returned array is sorted by origin_roll_id ascending so the order
 * we hand to `claimunboxed` is deterministic.
 */
export async function waitForUnboxAssets(opts: WaitOpts): Promise<UnboxAssetRow[]> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const start = Date.now();

  while (true) {
    if (opts.signal?.aborted) throw new Error('Wait aborted by user');
    const elapsed = Date.now() - start;
    opts.onTick?.(elapsed);
    if (elapsed > timeoutMs) {
      throw new Error(
        `ORNG callback didn't arrive within ${Math.round(timeoutMs / 1000)}s. ` +
          `The chain may be congested or the oracle is delayed. Your pack is still safe in the atomicpacksx contract -- you can retry the claim later.`,
      );
    }
    let rows: UnboxAssetRow[] = [];
    try {
      rows = await getTableRows<UnboxAssetRow>({
        code: 'atomicpacksx',
        scope: String(opts.pack_asset_id),
        table: 'unboxassets',
        limit: 200,
      });
    } catch {
      // transient RPC error; retry next tick
    }
    if (rows.length > 0) {
      rows.sort((a, b) => Number(a.origin_roll_id) - Number(b.origin_roll_id));
      return rows;
    }
    await sleep(intervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
