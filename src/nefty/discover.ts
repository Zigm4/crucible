/**
 * Blend discovery for a collection.
 *
 * Lists every active (and optionally inactive) deterministic blend a
 * collection has on `blend.nefty`. Two data paths:
 *   - Indexer (fast):  AtomicHub /neftyblocks/v1/blends, if reachable
 *   - On-chain (slow but always-up): parallel walk of the global `blends`
 *     table, filtered client-side by collection_name
 *
 * The on-chain path uses 16 parallel chunks of 25K blend_ids each. Total
 * walk time is typically 5-10 seconds on a fast WAX node.
 *
 * Random (`fuse`) blends are kept in the list and tagged via the
 * `is_random` field on `DiscoveredBlend`. The UI uses a separate state
 * machine (announce + fuse, wait for claimassets, then claim) when the
 * user picks one.
 *
 * When `actor` is supplied, the result also resolves whitelist eligibility
 * for blends with security_id != 0 by reading `secure.nefty/whitelists`.
 */
import { atomicFetch, getTableRows } from '../chain/rpc';

const PAGE_LIMIT = 100;
const MAX_PAGES = 5;
const CACHE_TTL_MS = 5 * 60_000;

// On-chain scan parameters. Tuned to complete in ≤5-10s on a fast WAX node.
const CHAIN_CHUNK_SIZE = 5_000n; // blend_id range per parallel worker
const CHAIN_ROWS_PER_CALL = 1000;
const CHAIN_MAX_CHUNKS = 16; // ≤ 80K blend_ids end-to-end safety cap

/**
 * The collections we surface as quick-pick suggestions in the UI.
 * Free-form collection names are also supported -- this list is purely
 * a convenience for the most-used communities.
 */
export const SUPPORTED_COLLECTIONS = [
  'underpunks55',
  'cigalepixeld',
  'northshireup',
  'pearlhorizon',
] as const;
export type SupportedCollection = (typeof SUPPORTED_COLLECTIONS)[number];

export type DiscoveryFlavour = 'indexer' | 'on_chain';

export interface DiscoveryProgress {
  source: DiscoveryFlavour;
  /** 0..1 progress; only meaningful for on-chain scans. */
  progress: number;
  message: string;
}
export type ProgressCb = (p: DiscoveryProgress) => void;

export type DiscoveredStatus =
  | 'active'
  | 'upcoming'
  | 'ended'
  | 'sold_out'
  | 'hidden';

export interface DiscoveredBlend {
  blend_id: string;
  collection_name: string;
  name: string;
  status: DiscoveredStatus;
  /** True when the blend requires a `secure.nefty` whitelist. */
  whitelist_required: boolean;
  /** True/false once we've checked; undefined when no wallet or check failed. */
  whitelist_allowed?: boolean;
  /**
   * True for blends where at least one roll has 2+ outcomes (the result
   * is decided at unbox time, not at recipe time). The UI executes
   * these through the announce+fuse / wait / claim state machine
   * instead of the single-shot nosecfuse path. Pool-NFT blends are also
   * tagged here because their pool is drawn from at execution time.
   */
  is_random: boolean;
  /**
   * Raw ingredient list, kept around so the picker can offer an
   * "only show blends I can do" filter without re-fetching each row.
   * Same shape on-chain returns: `[VARIANT_TYPE, payload]` tuples.
   */
  ingredients?: import('./blend').IngredientVariant[];
  /** First mint template this blend produces, if any - lets the picker show
   *  a meaningful name when the blend has no display_data name. */
  result_template_id?: number;
  /** Result template's name, when the source already carried it (indexer). */
  result_template_name?: string;
}

// ─── raw indexer / on-chain shape ──────────────────────────────────────── //

interface RawTemplate {
  template_id?: string;
  immutable_data?: { name?: string };
}
interface RawResult {
  template_id?: string;
  template?: RawTemplate;
  type?: string;
  name?: string;
}
interface RawOutcome {
  odds?: number;
  results?: RawResult[];
}
interface RawRoll {
  outcomes?: RawOutcome[];
  total_odds?: number;
}
interface RawBlend {
  blend_id?: string | number;
  contract?: string;
  collection_name?: string;
  start_time?: number;
  end_time?: number;
  use_count?: number;
  max?: number;
  is_hidden?: boolean;
  security_id?: number | string;
  display_data?: string | { name?: string; image?: string } | null;
  ingredients?: unknown[];
  ingredients_count?: number;
  result_count?: number;
  rolls?: RawRoll[];
}

// ─── public API ────────────────────────────────────────────────────────── //

interface CacheEntry {
  at: number;
  data: DiscoveredBlend[];
  source: DiscoveryFlavour;
}

const cache = new Map<string, CacheEntry>();

export interface ListBlendsOpts {
  collection: string;
  includeInactive: boolean;
  /** When provided: run whitelist checks in parallel for blends with security_id > 0. */
  actor?: string;
  onProgress?: ProgressCb;
}

export async function listBlends(
  opts: ListBlendsOpts,
): Promise<{ blends: DiscoveredBlend[]; source: DiscoveryFlavour }> {
  const key = `${opts.collection}::${opts.includeInactive}::${opts.actor ?? ''}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { blends: hit.data, source: hit.source };
  }

  let blends: DiscoveredBlend[];
  let source: DiscoveryFlavour;
  try {
    blends = await fetchFromIndexer(opts.collection, opts.includeInactive);
    source = 'indexer';
  } catch (err) {
    opts.onProgress?.({
      source: 'on_chain',
      progress: 0,
      message: `Indexer failed (${(err as Error).message.slice(0, 80)}). Falling back to on-chain scan…`,
    });
    blends = await fetchFromChain(opts.collection, opts);
    source = 'on_chain';
  }

  // Whitelist enrichment (parallel, best-effort)
  if (opts.actor) {
    await enrichWhitelist(blends, opts.actor);
  }

  cache.set(key, { at: Date.now(), data: blends, source });
  return { blends, source };
}

export function clearDiscoverCache(collection?: string) {
  // The shared walk goes too: "search again" has to mean the chain is
  // asked again, not that the same five minute old walk is re-filtered.
  chainWalk = undefined;
  // One collection when asked. "Search again" on a single NFT used to
  // empty this for every collection, so retrying one failed read threw
  // away every good read the page had made and the next tab re-walked
  // the chain for nothing.
  if (!collection) { cache.clear(); return; }
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${collection}::`)) cache.delete(key);
  }
}

// ─── indexer path ──────────────────────────────────────────────────────── //

async function fetchFromIndexer(
  collection: string,
  includeInactive: boolean,
): Promise<DiscoveredBlend[]> {
  const all: RawBlend[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const qs = new URLSearchParams({
      collection_name: collection,
      visibility: 'visible',
      render_markdown: 'true',
      limit: String(PAGE_LIMIT),
      page: String(page),
    });
    if (!includeInactive) qs.set('must_be_available', 'true');
    let batch: RawBlend[];
    try {
      batch = await atomicFetch<RawBlend[]>(`/neftyblocks/v1/blends?${qs.toString()}`);
    } catch (err) {
      if (page === 1) throw err;
      break;
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < PAGE_LIMIT) break;
  }
  return shapeAndFilter(all, includeInactive);
}

// ─── on-chain fallback path ────────────────────────────────────────────── //

/**
 * The whole blends table, grouped by collection, walked once.
 *
 * This scan reads EVERY blend on the contract and then keeps the ones
 * whose collection matches. It always did; the collection filter is
 * client side because the table is keyed by blend_id and nothing else.
 * What it did not do was remember the rest of the walk, so listing a
 * second collection walked all 45,000 blends again for the sake of a
 * different filter. A page that pre-reads eight collections did it eight
 * times: measured at roughly 45 MiB and 30 requests each, so 350 MiB and
 * 240 requests to say something the first walk already knew.
 *
 * One walk, shared. The second collection is free, and the eighth is too.
 */
/**
 * Held only as long as it is useful, because it is big.
 *
 * The grouped rows are every blend on WAX: measured at 97 MiB of heap.
 * That is a fine thing to have for the half minute in which a page reads
 * eight collections and a fine thing to be holding on a phone ten minutes
 * later. So it is released as soon as the reader that asked for it says it
 * is done, and expires on its own shortly after in case nobody says.
 */
const WALK_TTL_MS = 90_000;

/**
 * Everyone currently waiting on the walk, so they all see it move.
 *
 * The callback used to be captured when the walk started. Anyone who
 * joined a walk already in flight got no events at all until it finished,
 * which on the Recipes tab meant a progress bar pinned at 0% and a button
 * reading "Falling back to on-chain scan" for the whole scan. The warm
 * pass starts most walks and passes no callback, so that was the normal
 * case rather than the rare one.
 */
const walkWatchers = new Set<ProgressCb>();

let chainWalk: { at: number; rows: Promise<Map<string, RawBlend[]>> } | undefined;
let chainWalkTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Drops the shared walk. The per-collection results stay cached, so this
 * costs nothing already read; it only means the next unread collection
 * pays for its own walk.
 */
export function releaseChainWalk(): void {
  // Not while somebody is still watching it. The lab's warm pass calls
  // this when its own workers finish, and the Recipes tab can be part way
  // through the same walk: dropping the memo there would make its next
  // read start a second walk of the whole table.
  if (walkWatchers.size > 0) return;
  chainWalk = undefined;
  if (chainWalkTimer) { clearTimeout(chainWalkTimer); chainWalkTimer = undefined; }
}

function walkAllBlends(onProgress?: ProgressCb): Promise<Map<string, RawBlend[]>> {
  if (chainWalk && Date.now() - chainWalk.at < WALK_TTL_MS) {
    if (onProgress) {
      walkWatchers.add(onProgress);
      void chainWalk.rows.finally(() => walkWatchers.delete(onProgress));
    }
    return chainWalk.rows;
  }
  if (onProgress) walkWatchers.add(onProgress);
  const tell = (p: DiscoveryProgress) => {
    for (const w of walkWatchers) w(p);
  };
  // Declared before the body so the body can check it is still the walk
  // the module is holding, rather than one a retry has replaced.
  let current: { at: number; rows: Promise<Map<string, RawBlend[]>> } | undefined;
  const rows = (async (): Promise<Map<string, RawBlend[]>> => {
    tell({ source: 'on_chain', progress: 0.02, message: 'Probing chain head…' });
    const tail = await getTableRows<RawBlend>({
      code: 'blend.nefty',
      scope: 'blend.nefty',
      table: 'blends',
      limit: 1,
      reverse: true,
    });
    const headFromProbe = tail.length ? BigInt(String(tail[0].blend_id ?? 0)) + 1n : 0n;
    const headId = headFromProbe > 1000n ? headFromProbe : 80_000n;

    const ranges: { from: bigint; to: bigint }[] = [];
    for (let from = 0n; from < headId && ranges.length < CHAIN_MAX_CHUNKS; from += CHAIN_CHUNK_SIZE) {
      ranges.push({ from, to: from + CHAIN_CHUNK_SIZE });
    }

    let done = 0;
    const total = ranges.length;
    const byCollection = new Map<string, RawBlend[]>();

    await Promise.all(
      ranges.map(async (range) => {
        try {
          for (const r of await scanRange(range.from, range.to)) {
            const c = String(r.collection_name ?? '');
            if (!c) continue;
            const bucket = byCollection.get(c);
            if (bucket) bucket.push(r);
            else byCollection.set(c, [r]);
          }
        } finally {
          done++;
          tell({
            source: 'on_chain',
            progress: 0.05 + 0.9 * (done / total),
            message: `Scanning chain: ${done}/${total} ranges`,
          });
        }
      }),
    );
    // Stamped on completion rather than on start. A walk that takes half a
    // minute was otherwise a third of the way to expiry before its first
    // reader could touch it.
    //
    // And evicted by a timer, not by the next caller. Checking the age on
    // the way in means the map is only dropped when somebody asks for
    // another one, so a person who lists one collection and then reads
    // the page holds every blend on WAX, 63 MiB of it, for as long as the
    // tab is open. The lab's warm pass releases it sooner; this is for
    // everybody who never goes there.
    if (current && chainWalk === current) {
      chainWalk.at = Date.now();
      if (chainWalkTimer) clearTimeout(chainWalkTimer);
      chainWalkTimer = setTimeout(() => {
        if (current && chainWalk === current) releaseChainWalk();
      }, WALK_TTL_MS);
      // Node keeps the process alive for a pending timer; a five minute
      // script should not wait on this one.
      (chainWalkTimer as unknown as { unref?: () => void }).unref?.();
    }
    return byCollection;
  })();
  current = { at: Date.now(), rows };
  chainWalk = current;
  // A walk that failed must not be the answer for the next five minutes,
  // and must not clear a healthy walk that replaced it in the meantime.
  void rows.catch(() => { if (current && chainWalk === current) releaseChainWalk(); })
    .finally(() => { if (onProgress) walkWatchers.delete(onProgress); });
  return rows;
}

async function fetchFromChain(
  collection: string,
  opts: { includeInactive: boolean; onProgress?: ProgressCb },
): Promise<DiscoveredBlend[]> {
  const byCollection = await walkAllBlends(opts.onProgress);
  const out = shapeAndFilter(byCollection.get(collection) ?? [], opts.includeInactive);
  opts.onProgress?.({
    source: 'on_chain',
    progress: 1,
    message: `Scan complete: ${out.length} blend(s) found.`,
  });
  return out;
}

async function scanRange(from: bigint, to: bigint): Promise<RawBlend[]> {
  const rows: RawBlend[] = [];
  let cursor = from;
  while (cursor < to) {
    const batch = await getTableRows<RawBlend>({
      code: 'blend.nefty',
      scope: 'blend.nefty',
      table: 'blends',
      lower_bound: String(cursor),
      upper_bound: String(to),
      limit: CHAIN_ROWS_PER_CALL,
    });
    if (batch.length === 0) break;
    rows.push(...batch.map(normalizeChainBlend));
    const lastId = BigInt(String(batch[batch.length - 1].blend_id ?? cursor));
    if (lastId + 1n <= cursor) break;
    cursor = lastId + 1n;
    if (batch.length < CHAIN_ROWS_PER_CALL) break;
  }
  return rows;
}

/**
 * On-chain rolls come as variant tuples `[type, payload]`; the indexer flattens
 * them into `{type, ...payload}`. Normalise to the indexer shape so the rest
 * of the pipeline handles both.
 */
function normalizeChainBlend(b: RawBlend): RawBlend {
  if (!b.rolls) return b;
  const rolls = b.rolls.map((r) => ({
    total_odds: r.total_odds,
    outcomes: (r.outcomes ?? []).map((o) => ({
      odds: o.odds,
      results: (o.results ?? []).map((res) => {
        if (Array.isArray(res)) {
          const [type, payload] = res as [string, Record<string, unknown>];
          return { type, ...(payload ?? {}) } as RawResult;
        }
        return res;
      }),
    })),
  }));
  return { ...b, rolls };
}

// ─── shaping + filtering ───────────────────────────────────────────────── //

function shapeAndFilter(raw: RawBlend[], includeInactive: boolean): DiscoveredBlend[] {
  const out: DiscoveredBlend[] = [];
  for (const b of raw) {
    const shaped = toDiscovered(b);
    if (shaped) out.push(shaped);
  }
  const filtered = includeInactive ? out : out.filter((b) => b.status === 'active');
  // Active first, then alphabetical by name within each status bucket
  // (case-insensitive, locale-aware). Falls back to blend_id desc when
  // two blends share the exact same name, so duplicates stay stable.
  filtered.sort((a, b) => {
    const p = statusPriority(a.status) - statusPriority(b.status);
    if (p !== 0) return p;
    const byName = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    if (byName !== 0) return byName;
    return Number(b.blend_id) - Number(a.blend_id);
  });
  return filtered;
}

function statusPriority(s: DiscoveredStatus): number {
  switch (s) {
    case 'active': return 0;
    case 'upcoming': return 1;
    case 'ended': return 2;
    case 'sold_out': return 3;
    case 'hidden': return 4;
  }
}

function parseDisplayData(d: RawBlend['display_data']): { name?: string } {
  if (!d) return {};
  if (typeof d === 'object') return d;
  if (typeof d === 'string') {
    const t = d.trim();
    if (!t) return {};
    try {
      const parsed = JSON.parse(t);
      return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function computeStatus(b: RawBlend): DiscoveredStatus {
  if (b.is_hidden) return 'hidden';
  const max = Number(b.max ?? 0);
  const used = Number(b.use_count ?? 0);
  if (max > 0 && used >= max) return 'sold_out';
  const now = Date.now();
  const norm = (t?: number) => {
    if (!t) return 0;
    return t > 1e11 ? t : t * 1000;
  };
  const start = norm(b.start_time);
  const end = norm(b.end_time);
  if (start > now) return 'upcoming';
  if (end > 0 && end < now) return 'ended';
  return 'active';
}

function isDeterministicRolls(rolls: RawRoll[] | undefined): boolean {
  if (!rolls || rolls.length === 0) return true;
  for (const r of rolls) {
    const outs = r.outcomes ?? [];
    if (outs.length !== 1) return false;
    if (r.total_odds !== undefined && r.total_odds !== outs[0].odds) return false;
    for (const res of outs[0].results ?? []) {
      if (res.type === 'POOL_NFT_RESULT' || res.type === 'pool') return false;
    }
  }
  return true;
}

/** Digs out the first result template (id + name when present) from rolls. */
function firstResultTemplate(rolls: RawRoll[] | undefined): { template_id?: number; name?: string } {
  for (const roll of rolls ?? []) {
    for (const o of roll.outcomes ?? []) {
      for (const r of o.results ?? []) {
        const tid = r.template_id ?? r.template?.template_id;
        if (tid != null && tid !== '') {
          const name = r.template?.immutable_data?.name ?? r.name;
          return { template_id: Number(tid), name: name ? String(name) : undefined };
        }
      }
    }
  }
  return {};
}

function toDiscovered(b: RawBlend): DiscoveredBlend | undefined {
  if (b.blend_id === undefined || b.blend_id === null) return undefined;
  const dd = parseDisplayData(b.display_data);
  const id = String(b.blend_id);
  const security_id = b.security_id !== undefined ? String(b.security_id) : '0';
  const res = firstResultTemplate(b.rolls);
  return {
    blend_id: id,
    collection_name: String(b.collection_name ?? ''),
    name: (dd.name && String(dd.name)) || `Blend #${id}`,
    status: computeStatus(b),
    whitelist_required: security_id !== '0',
    is_random: !isDeterministicRolls(b.rolls),
    // whitelist_allowed left undefined until enrichWhitelist runs
    ingredients: b.ingredients as import('./blend').IngredientVariant[] | undefined,
    result_template_id: res.template_id,
    result_template_name: res.name,
  };
}

// ─── whitelist enrichment ──────────────────────────────────────────────── //

/**
 * For each blend with whitelist_required, ask secure.nefty/whitelists/<sid>
 * whether `actor` is listed. Multiple blends often share the same security_id,
 * so we cache lookups inside this call.
 */
async function enrichWhitelist(blends: DiscoveredBlend[], actor: string): Promise<void> {
  const targets = blends.filter((b) => b.whitelist_required);
  if (targets.length === 0) return;

  // Distinct security_ids referenced by these blends. We carry it implicitly
  // through the raw shape by re-fetching the row, but since we've already
  // discarded RawBlend objects, we'd have to re-query. Simpler: store
  // security_id on the discovered blend too. We do this by re-reading the
  // chain rows for these specific blend_ids in a single batched query.
  //, N is typically small (a few whitelisted blends per collection).
  await Promise.all(
    targets.map(async (b) => {
      try {
        const sid = await fetchSecurityId(b.blend_id);
        if (!sid || sid === '0') {
          b.whitelist_required = false;
          return;
        }
        const allowed = await isInWhitelist(sid, actor);
        b.whitelist_allowed = allowed;
      } catch {
        // leave whitelist_allowed undefined; UI handles it gracefully
      }
    }),
  );
}

const sidCache = new Map<string, string>();
async function fetchSecurityId(blend_id: string): Promise<string> {
  if (sidCache.has(blend_id)) return sidCache.get(blend_id)!;
  const rows = await getTableRows<{ security_id?: number | string }>({
    code: 'blend.nefty',
    scope: 'blend.nefty',
    table: 'blends',
    lower_bound: blend_id,
    upper_bound: blend_id,
    limit: 1,
  });
  const sid = rows[0]?.security_id !== undefined ? String(rows[0].security_id) : '0';
  sidCache.set(blend_id, sid);
  return sid;
}

const wlCache = new Map<string, Set<string>>(); // security_id -> set of allowed actors
async function isInWhitelist(security_id: string, actor: string): Promise<boolean> {
  let allowed = wlCache.get(security_id);
  if (!allowed) {
    const rows = await getTableRows<{ account?: string; name?: string }>({
      code: 'secure.nefty',
      scope: security_id,
      table: 'whitelists',
      limit: 1000,
    });
    allowed = new Set();
    for (const r of rows) {
      const candidate = (r.account ?? r.name ?? '') as string;
      if (candidate) allowed.add(candidate);
    }
    wlCache.set(security_id, allowed);
  }
  return allowed.has(actor);
}
