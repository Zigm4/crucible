import { atomicFetch, getTableRows } from '../chain/rpc';

const PAGE_LIMIT = 100;
const MAX_PAGES = 5;
const CACHE_TTL_MS = 5 * 60_000;

// On-chain scan parameters. Tuned to complete in ≤5–10s on a fast WAX node.
const CHAIN_CHUNK_SIZE = 5_000n; // blend_id range per parallel worker
const CHAIN_ROWS_PER_CALL = 1000;
const CHAIN_MAX_CHUNKS = 16; // ≤ 80K blend_ids end-to-end safety cap

export const SUPPORTED_COLLECTIONS = [
  'underpunks55',
  'shadowsquads',
  'cigalepixeld',
  'punksmticorp',
  'northshireup',
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
  /** When provided, run whitelist checks in parallel for blends with security_id > 0. */
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

export function clearDiscoverCache() {
  cache.clear();
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

async function fetchFromChain(
  collection: string,
  opts: { includeInactive: boolean; onProgress?: ProgressCb },
): Promise<DiscoveredBlend[]> {
  opts.onProgress?.({ source: 'on_chain', progress: 0.02, message: 'Probing chain head…' });
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
  const filtered: RawBlend[] = [];

  await Promise.all(
    ranges.map(async (range) => {
      try {
        const rows = await scanRange(range.from, range.to);
        for (const r of rows) {
          if (r.collection_name === collection) filtered.push(r);
        }
      } finally {
        done++;
        opts.onProgress?.({
          source: 'on_chain',
          progress: 0.05 + 0.9 * (done / total),
          message: `Scanning chain: ${done}/${total} ranges (${filtered.length} match so far)`,
        });
      }
    }),
  );

  const out = shapeAndFilter(filtered, opts.includeInactive);
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
    // Hide random / non-deterministic blends entirely — this tool can't
    // execute them, and "non-selectable" should be reserved for whitelist
    // denial to make the legend unambiguous.
    if (!isDeterministicRolls(b.rolls)) continue;
    const shaped = toDiscovered(b);
    if (shaped) out.push(shaped);
  }
  const filtered = includeInactive ? out : out.filter((b) => b.status === 'active');
  filtered.sort((a, b) => {
    const p = statusPriority(a.status) - statusPriority(b.status);
    if (p !== 0) return p;
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

function toDiscovered(b: RawBlend): DiscoveredBlend | undefined {
  if (b.blend_id === undefined || b.blend_id === null) return undefined;
  const dd = parseDisplayData(b.display_data);
  const id = String(b.blend_id);
  const security_id = b.security_id !== undefined ? String(b.security_id) : '0';
  return {
    blend_id: id,
    collection_name: String(b.collection_name ?? ''),
    name: (dd.name && String(dd.name)) || `Blend #${id}`,
    status: computeStatus(b),
    whitelist_required: security_id !== '0',
    // whitelist_allowed left undefined until enrichWhitelist runs
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
  // — N is typically small (a few whitelisted blends per collection).
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
