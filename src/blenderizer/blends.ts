/**
 * Recipe discovery for the `blenderizerx` contract (the "Blenderizer").
 *
 * A third platform next to NeftyBlocks and WaxDAO. Despite the name it
 * is NOT a Nefty contract: its own `config` row credits `3dkrenderwax`
 * (3DkRender), and the account predates `blend.nefty` by seven months
 * (2020-12-03 vs 2021-07-13). The website that drove it is gone; the
 * contract is still live and still used.
 *
 * It is by far the simplest of the three blend contracts:
 *
 *   - one flat table, `blenders`, scope = blenderizerx
 *         { owner, collection, target: int32, mixture: int32[] }
 *   - the primary key IS the target template_id, so a recipe is
 *     addressed by what it produces
 *   - `mixture` lists the templates to burn WITH repetition
 *     (e.g. [83, 83, 83, 89, 89, 89] = 3x template 83 + 3x template 89)
 *   - no odds, no pool, no whitelist, no token cost, no time window
 *   - blending is a single `atomicassets::transfer` to blenderizerx
 *     with memo = the target template_id (see blendExecute.ts)
 *
 * Two things the table does NOT carry, which we resolve separately
 * because they decide whether a recipe can actually pay out:
 *
 *   1. the target template's supply. `blenders` has no "sold out"
 *      flag; a capped target that is fully minted simply fails at
 *      blend time. We read issued/max from the AtomicAssets indexer.
 *   2. the collection's RAM balance on the contract (`rambalance`).
 *      blenderizerx mints from RAM the collection author pre-paid; a
 *      collection with no balance cannot mint at all. That is a
 *      collection-wide blocker, not a per-recipe one.
 *
 * Discovery has to scan: `blenders` has no secondary index on
 * `collection` (index_position 2 returns nothing), so we walk the whole
 * table in parallel chunks and filter client-side, exactly like
 * nefty/discover.ts does for `blend.nefty`. ~17.7K rows today, which a
 * 16-way parallel walk clears in a couple of seconds.
 */

import { atomicFetch, getTableRows } from '../chain/rpc';
import { pickImageRef } from '../atomic/image';

export const BLENDERIZER_CONTRACT = 'blenderizerx';

// Chunking for the parallel table walk. The key space is template_ids,
// so it is wide and sparsely populated; we walk each chunk with a
// cursor rather than assuming rows are dense.
const CHAIN_CHUNK_ROWS = 1000;
const CHAIN_MAX_CHUNKS = 16;
/** Fallback head when the probe fails; today's max target is ~650K. */
const FALLBACK_HEAD = 800_000n;

/**
 * A transfer carrying this many NFTs starts to strain WAX CPU limits
 * and wallet UIs. Recipes above it still render and can be signed, but
 * we warn first. 112 of the 17.7K recipes on-chain exceed 100.
 */
export const LARGE_MIXTURE_WARN = 40;

// ── shaped types ────────────────────────────────────────────────────── //

export type BlenderizerStatus =
  /** Target template can still be minted. */
  | 'active'
  /** Target template is capped and fully minted; the blend would fail. */
  | 'sold_out'
  /** Target template could not be read (deleted, or indexer down). */
  | 'unknown';

/**
 * One ingredient slot: `amount` NFTs of a single template. Produced by
 * collapsing the repeated entries of `mixture`, preserving the order
 * templates first appear so the picker matches the recipe's own layout.
 */
export interface BlenderizerSlot {
  index: number;
  template_id: number;
  amount: number;
}

export interface DiscoveredBlenderizerBlend {
  /** String form of `target`. The table's primary key IS the target. */
  blend_id: string;
  /** Account that registered the recipe (usually the collection itself). */
  owner: string;
  collection: string;
  /** Template minted when the recipe is blended. */
  target: number;
  /** Target template's name, once the indexer resolved it. */
  name?: string;
  image?: string;
  schema_name?: string;
  target_issued?: number;
  /** 0 = uncapped. */
  target_max?: number;
  status: BlenderizerStatus;
  slots: BlenderizerSlot[];
  /** Total NFTs burned, i.e. `mixture.length`. */
  total_nfts: number;
}

/** Collection-wide RAM state on the contract. */
export interface BlenderizerRam {
  collection: string;
  bytes: number;
}

// ── raw on-chain shape ──────────────────────────────────────────────── //

interface RawBlender {
  owner: string;
  collection: string;
  target: number | string;
  mixture: (number | string)[];
}

interface RawIndexerTemplate {
  template_id: string;
  schema?: { schema_name?: string };
  immutable_data?: Record<string, unknown>;
  issued_supply?: string | number;
  max_supply?: string | number;
}

// ── public entrypoints ─────────────────────────────────────────────── //

export interface ListBlenderizerOpts {
  collection: string;
  /** When false (default), sold-out recipes are filtered out. */
  includeInactive?: boolean;
  onProgress?: (message: string, pct: number) => void;
}

const cache = new Map<string, { at: number; data: DiscoveredBlenderizerBlend[] }>();
const TTL_MS = 5 * 60_000;

/**
 * Every Blenderizer recipe registered for `collection`, target-template
 * names and supplies resolved. Sorted active-first, then by name.
 */
export async function listBlenderizerBlends(
  opts: ListBlenderizerOpts,
): Promise<{ blends: DiscoveredBlenderizerBlend[] }> {
  const key = `${opts.collection}::${opts.includeInactive ? 'all' : 'active'}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return { blends: hit.data };

  opts.onProgress?.('Probing blenderizerx…', 0.02);
  const head = await probeHead();

  const chunkSize = head / BigInt(CHAIN_MAX_CHUNKS) + 1n;
  const ranges: { from: bigint; to: bigint }[] = [];
  for (let from = 0n; from < head; from += chunkSize) {
    ranges.push({ from, to: from + chunkSize });
  }

  let done = 0;
  const matched: RawBlender[] = [];
  await Promise.all(
    ranges.map(async (r) => {
      try {
        for (const row of await scanRange(r.from, r.to)) {
          if (row.collection === opts.collection) matched.push(row);
        }
      } finally {
        done += 1;
        opts.onProgress?.(
          `Scanning blenderizerx… ${done}/${ranges.length} ranges (${matched.length} match so far)`,
          0.05 + 0.85 * (done / ranges.length),
        );
      }
    }),
  );

  opts.onProgress?.('Resolving target templates…', 0.92);
  let shaped = matched.map(toDiscovered);
  await enrichTargets(opts.collection, shaped);

  if (!opts.includeInactive) {
    shaped = shaped.filter((b) => b.status !== 'sold_out');
  }
  shaped.sort((a, b) => {
    const p = statusPriority(a.status) - statusPriority(b.status);
    if (p !== 0) return p;
    const byName = (a.name ?? '').localeCompare(b.name ?? '', undefined, { sensitivity: 'base' });
    if (byName !== 0) return byName;
    return a.target - b.target;
  });

  opts.onProgress?.(`Scan complete: ${shaped.length} recipe(s).`, 1);
  cache.set(key, { at: Date.now(), data: shaped });
  return { blends: shaped };
}

/**
 * Loads a single recipe by target template_id (which is also its id).
 * Used by the manual-entry field and by deep links.
 */
export async function loadBlenderizerBlendById(
  target: string | number,
): Promise<DiscoveredBlenderizerBlend | undefined> {
  const id = String(target);
  const rows = await getTableRows<RawBlender>({
    code: BLENDERIZER_CONTRACT,
    scope: BLENDERIZER_CONTRACT,
    table: 'blenders',
    lower_bound: id,
    upper_bound: id,
    limit: 1,
  });
  if (rows.length === 0) return undefined;
  const shaped = toDiscovered(rows[0]);
  await enrichTargets(shaped.collection, [shaped]);
  return shaped;
}

/**
 * The collection's RAM balance on blenderizerx. `undefined` means the
 * collection has no row at all, i.e. it never funded the contract -
 * treated the same as a zero balance by the caller.
 *
 * Best-effort: a failed read returns undefined rather than throwing, so
 * a flaky RPC never blocks a blend the user could otherwise sign.
 */
export async function readBlenderizerRam(
  collection: string,
): Promise<BlenderizerRam | undefined> {
  try {
    const rows = await getTableRows<{ collection: string; bytes: number | string }>({
      code: BLENDERIZER_CONTRACT,
      scope: BLENDERIZER_CONTRACT,
      table: 'rambalance',
      lower_bound: collection,
      upper_bound: collection,
      limit: 1,
    });
    const row = rows[0];
    if (!row) return undefined;
    return { collection: String(row.collection), bytes: Number(row.bytes ?? 0) || 0 };
  } catch {
    return undefined;
  }
}

export function clearBlenderizerCache() {
  cache.clear();
}

// ── scanning ───────────────────────────────────────────────────────── //

/** Highest target currently registered, +1. Falls back on probe failure. */
async function probeHead(): Promise<bigint> {
  try {
    const tail = await getTableRows<RawBlender>({
      code: BLENDERIZER_CONTRACT,
      scope: BLENDERIZER_CONTRACT,
      table: 'blenders',
      limit: 1,
      reverse: true,
    });
    if (tail.length === 0) return FALLBACK_HEAD;
    const head = BigInt(String(tail[0].target ?? 0)) + 1n;
    return head > 1000n ? head : FALLBACK_HEAD;
  } catch {
    return FALLBACK_HEAD;
  }
}

/**
 * Walks one key range with a cursor. The key space is sparse (targets
 * are template_ids), so a page can span a wide id gap - we always
 * advance past the last row we actually got rather than by a fixed
 * step.
 */
async function scanRange(from: bigint, to: bigint): Promise<RawBlender[]> {
  const rows: RawBlender[] = [];
  let cursor = from;
  while (cursor < to) {
    const batch = await getTableRows<RawBlender>({
      code: BLENDERIZER_CONTRACT,
      scope: BLENDERIZER_CONTRACT,
      table: 'blenders',
      lower_bound: String(cursor),
      upper_bound: String(to),
      limit: CHAIN_CHUNK_ROWS,
    });
    if (batch.length === 0) break;
    rows.push(...batch);
    const last = BigInt(String(batch[batch.length - 1].target ?? cursor));
    if (last + 1n <= cursor) break;
    cursor = last + 1n;
    if (batch.length < CHAIN_CHUNK_ROWS) break;
  }
  return rows;
}

// ── shaping ────────────────────────────────────────────────────────── //

function statusPriority(s: BlenderizerStatus): number {
  switch (s) {
    case 'active':   return 0;
    case 'unknown':  return 1;
    case 'sold_out': return 2;
  }
}

/**
 * Collapses `mixture` into slots. Repeated template ids become one slot
 * with an amount; first-appearance order is preserved so the picker
 * lists ingredients the way the author wrote the recipe.
 */
export function slotsFromMixture(mixture: (number | string)[]): BlenderizerSlot[] {
  const order: number[] = [];
  const counts = new Map<number, number>();
  for (const raw of mixture ?? []) {
    const t = Number(raw);
    if (!Number.isFinite(t)) continue;
    if (!counts.has(t)) order.push(t);
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return order.map((template_id, index) => ({
    index,
    template_id,
    amount: counts.get(template_id) ?? 1,
  }));
}

function toDiscovered(r: RawBlender): DiscoveredBlenderizerBlend {
  const target = Number(r.target);
  const slots = slotsFromMixture(r.mixture ?? []);
  return {
    blend_id: String(target),
    owner: String(r.owner ?? ''),
    collection: String(r.collection ?? ''),
    target,
    status: 'unknown', // refined by enrichTargets()
    slots,
    total_nfts: (r.mixture ?? []).length,
  };
}

/**
 * Fills in each recipe's target template (name, schema, supply) and
 * derives its status. One batched indexer call per 100 recipes, since
 * `blenders` carries no display data at all.
 *
 * Failure is non-fatal: recipes keep status 'unknown' and render with
 * the bare template id, same as the rest of the app does when the
 * indexer is down.
 */
async function enrichTargets(
  collection: string,
  blends: DiscoveredBlenderizerBlend[],
): Promise<void> {
  if (blends.length === 0 || !collection) return;
  const ids = [...new Set(blends.map((b) => b.target))];
  const byId = new Map<number, RawIndexerTemplate>();

  for (let i = 0; i < ids.length; i += 100) {
    const page = ids.slice(i, i + 100);
    try {
      const qs = new URLSearchParams({
        collection_name: collection,
        ids: page.join(','),
        limit: String(page.length),
      });
      const data = await atomicFetch<RawIndexerTemplate[]>(
        `/atomicassets/v1/templates?${qs.toString()}`,
      );
      for (const t of data ?? []) byId.set(Number(t.template_id), t);
    } catch {
      // leave this page unresolved; status stays 'unknown'
    }
  }

  for (const b of blends) {
    const t = byId.get(b.target);
    if (!t) continue;
    const imm = t.immutable_data ?? {};
    // Author-entered names occasionally carry stray leading whitespace
    // (e.g. "\t1000 coins" on underpunks55/182201), which breaks
    // alphabetical sorting and looks like a rendering bug in the picker.
    const rawName = typeof imm.name === 'string' ? imm.name.trim() : '';
    b.name = rawName || undefined;
    b.image = pickImageRef(imm);
    b.schema_name = t.schema?.schema_name;
    b.target_issued = Number(t.issued_supply ?? 0) || 0;
    b.target_max = Number(t.max_supply ?? 0) || 0;
    // max_supply 0 means uncapped, so only a positive cap can sell out.
    b.status =
      b.target_max > 0 && b.target_issued >= b.target_max ? 'sold_out' : 'active';
  }
}

/** Human label for a recipe, falling back to the bare target id. */
export function blenderizerTitle(b: DiscoveredBlenderizerBlend): string {
  return b.name ?? `Template #${b.target}`;
}
