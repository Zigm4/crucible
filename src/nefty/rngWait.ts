/**
 * Polls the chain for the claim row staged by `blend.nefty::fuse`.
 *
 * After TX1 (`fuse`), the contract either:
 *   - resolves the result synchronously (deterministic-but-secured
 *     blends, or blends with a single outcome per roll, get their
 *     result staged in the same block), OR
 *   - queues an ORNG job that fires back a few seconds later, then
 *     writes the resolved row.
 *
 * Either way the resolved data lands in `claimassets` scope=<claimer>,
 * keyed by `claim_id`. We snapshot the existing claim_ids BEFORE
 * broadcasting TX1, then poll for new rows in the same scope matching
 * our `blend_id` (via `recipe_id` field). The first new row is the one
 * we just created.
 *
 * Why a manual poll and not a websocket? Public WAX RPCs don't expose a
 * stable push subscription. A 1.5s poll with multi-host failover is
 * reliable, cheap, and fits the existing rpc.ts plumbing.
 */

import { getTableRows } from '../chain/rpc';

/** A single resolved outcome within a CLAIMABLE row. */
export interface ClaimResult {
  /** Variant of the resolved claim, e.g. ['ON_DEMAND_NFT_CLAIM', {template_id: 20562}]. */
  claim: [string, Record<string, unknown>];
  is_claimed: boolean;
}

/** A claimassets row as it appears under scope=<claimer>. */
export interface ClaimAssetsRow {
  claim_id: string | number;
  recipient: string;
  recipe_id: string | number;
  collection_name: string;
  claims: ClaimResult[];
}

export interface RngWaitOpts {
  claimer: string;
  blend_id: string | number;
  /** Total wait before throwing (ms). Default: 90 seconds. */
  timeoutMs?: number;
  /** Time between polls (ms). Default: 1.5 seconds. */
  intervalMs?: number;
  /** Snapshot of pre-existing claim_ids in the user's scope; new IDs are skipped past these. */
  knownClaimIds?: Set<string>;
  /** Called on every tick with elapsed ms, for the UI countdown. */
  onTick?: (elapsedMs: number) => void;
  /** AbortSignal to let the caller cancel mid-wait. */
  signal?: AbortSignal;
}

/**
 * Reads every claim_id currently sitting in `claimassets` scope=claimer.
 * Used to snapshot the table before signing TX1 so we can distinguish
 * "the row we just created" from any older pending claims the user may
 * still have lying around.
 */
export async function readKnownClaimIds(claimer: string): Promise<Set<string>> {
  try {
    const rows = await getTableRows<ClaimAssetsRow>({
      code: 'blend.nefty',
      scope: claimer,
      table: 'claimassets',
      limit: 500,
    });
    return new Set(rows.map((r) => String(r.claim_id)));
  } catch {
    return new Set();
  }
}

/**
 * Resolves once a fresh row matching our `blend_id` appears in
 * `claimassets` scope=claimer. Rejects on timeout or abort.
 *
 * "Fresh" means: claim_id NOT in `knownClaimIds`. Pre-existing pending
 * claims are skipped so we never accidentally claim someone else's
 * earlier deposit.
 */
export async function waitForClaim(opts: RngWaitOpts): Promise<ClaimAssetsRow> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const intervalMs = opts.intervalMs ?? 1_500;
  const known = opts.knownClaimIds ?? new Set<string>();
  const start = Date.now();
  const targetRecipe = String(opts.blend_id);

  while (true) {
    if (opts.signal?.aborted) throw new Error('Wait aborted by user');
    const elapsed = Date.now() - start;
    opts.onTick?.(elapsed);
    if (elapsed > timeoutMs) {
      throw new Error(
        `The contract didn't stage a result within ${Math.round(timeoutMs / 1000)}s. ` +
          `Your deposit is still locked in blend.nefty; refresh and you'll be able to resume the claim from this same wallet.`,
      );
    }
    let rows: ClaimAssetsRow[] = [];
    try {
      rows = await getTableRows<ClaimAssetsRow>({
        code: 'blend.nefty',
        scope: opts.claimer,
        table: 'claimassets',
        limit: 500,
      });
    } catch {
      // transient RPC error: just retry next tick
    }
    // Find the youngest unknown row matching our blend_id.
    let candidate: ClaimAssetsRow | undefined;
    for (const r of rows) {
      if (String(r.recipe_id) !== targetRecipe) continue;
      if (known.has(String(r.claim_id))) continue;
      if (!candidate || Number(r.claim_id) > Number(candidate.claim_id)) {
        candidate = r;
      }
    }
    if (candidate) return candidate;
    await sleep(intervalMs);
  }
}

/**
 * Watches whether a staged claim row gets CONSUMED. Most `blend.nefty`
 * results are minted automatically by Nefty's on-chain claim service
 * (`setup.nefty`), which removes the row from `claimassets`. Resolves
 * `true` once the row is gone (auto-claimed → already in the wallet),
 * `false` on timeout (still pending → the caller can offer a manual claim).
 */
export async function waitForClaimConsumed(
  claimer: string,
  claim_id: string | number,
  opts: { timeoutMs?: number; intervalMs?: number; onTick?: (ms: number) => void; signal?: AbortSignal } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const intervalMs = opts.intervalMs ?? 1_500;
  const target = String(claim_id);
  const start = Date.now();
  while (true) {
    if (opts.signal?.aborted) return false;
    if (Date.now() - start > timeoutMs) return false;
    opts.onTick?.(Date.now() - start);
    let rows: ClaimAssetsRow[] = [];
    try {
      rows = await getTableRows<ClaimAssetsRow>({
        code: 'blend.nefty',
        scope: claimer,
        table: 'claimassets',
        limit: 500,
      });
    } catch {
      // transient RPC error: retry
    }
    if (!rows.some((r) => String(r.claim_id) === target)) return true; // consumed
    await sleep(intervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
