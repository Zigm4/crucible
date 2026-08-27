/**
 * An inventory you can actually work in.
 *
 * The complaint this answers: the standard explorer shows a handful of
 * cards at a time, its search only matches a name, and there is no way to
 * say "not those". People with a few thousand NFTs cannot see what they
 * own.
 *
 * Three ideas carry the whole thing.
 *
 * 1. Read once, work locally. Every asset is pulled up front, then every
 *    search, facet, sort and exclusion runs in memory. No round trip per
 *    keystroke, so refining is instant and the API is hit once.
 *
 * 2. Facets are computed from what is ALREADY filtered, not from a fixed
 *    list. Type "underpunks" and the template facet offers only that
 *    collection's templates; pick VESSEL and the attribute facets become
 *    VESSEL's own fields, engines and shield type and the rest. That is
 *    the "smart search that refines based on what is already found",
 *    and it falls out of recomputing facets over the current result set
 *    rather than over everything.
 *
 * 3. Every facet value can be included OR excluded. "Don't show shrooms"
 *    is one click on the same chip that would have filtered to them.
 *
 * State lives in the URL, not in storage. This page promises a clean boot
 * on every load, and a filtered inventory is worth sharing anyway: the
 * hash carries the whole view, so a link reproduces exactly what the
 * sender was looking at.
 */
import { listAssetsForOwner, clearAssetsCache, type AtomicAsset } from '../atomic/assets';

export type InventoryView = 'grid' | 'list';

/** A facet is one column of the data people can slice on. */
export interface Facet {
  key: string;
  label: string;
  values: { value: string; count: number }[];
  /** How many distinct values exist before the display cap. */
  total: number;
}

export interface InventoryState {
  owner: string;
  loadedFor: string;
  loading: boolean;
  error: string;
  assets: AtomicAsset[];
  /** Free text, matched against every field a person might remember. */
  q: string;
  /** facet key -> values that must match. Within a key, any value matches. */
  include: Record<string, string[]>;
  /** facet key -> values that must NOT match. Beats include. */
  exclude: Record<string, string[]>;
  view: InventoryView;
  sortKey: string;
  sortDesc: boolean;
  /** How many rows are on screen. Raised by the "show more" control. */
  limit: number;
  /** Facet panels the reader has opened. */
  openFacets: string[];
}

export function emptyInventoryState(): InventoryState {
  return {
    owner: '', loadedFor: '', loading: false, error: '', assets: [],
    q: '', include: {}, exclude: {}, view: 'grid',
    sortKey: 'asset_id', sortDesc: true, limit: 120, openFacets: [],
  };
}

/** Keys the contract-level fields live under, kept apart from `data`. */
export const CORE_FACETS = ['collection', 'schema', 'template'] as const;

export const ATTR_PREFIX = 'attr:';

/**
 * Attributes that are never worth faceting on.
 *
 * Artwork references and prose are unique per asset, so they produce a
 * facet with as many values as there are rows and no way to narrow
 * anything. They stay searchable through the free-text box, where a
 * remembered phrase from a description is genuinely useful; they just do
 * not get a panel in the rail.
 */
const UNFACETABLE = new Set([
  'img', 'image', 'video', 'audio', 'backimg', 'back_img', 'model', 'glb',
  'description', 'desc', 'lore', 'url', 'link',
]);

/** Everything about one asset that a person might search for, lowercased. */
function haystack(a: AtomicAsset): string {
  const parts = [
    a.asset_id,
    a.name ?? '',
    a.collection?.collection_name ?? '',
    a.schema?.schema_name ?? '',
    a.template?.template_id ?? '',
    a.template_mint ?? '',
  ];
  for (const [k, v] of Object.entries(a.data ?? {})) {
    parts.push(k, stringify(v));
  }
  return parts.join(' ').toLowerCase();
}

/**
 * One attribute value as text.
 *
 * AtomicAssets attributes are typed, so a value can arrive as a number, a
 * bool, or a vector. Everything is compared and displayed as a string so
 * one code path covers them all; an array joins on a comma rather than
 * rendering as "[object Object]".
 */
export function stringify(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(stringify).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** The value of one facet key for one asset, or '' when it has none. */
export function facetValue(a: AtomicAsset, key: string): string {
  if (key === 'collection') return a.collection?.collection_name ?? '';
  if (key === 'schema') return a.schema?.schema_name ?? '';
  if (key === 'template') return a.template?.template_id ?? '';
  if (key === 'name') return a.name ?? '';
  if (key.startsWith(ATTR_PREFIX)) return stringify((a.data ?? {})[key.slice(ATTR_PREFIX.length)]);
  return '';
}

/**
 * The assets a filter leaves standing.
 *
 * `skipKey` exists for facet counting: when counting the values of one
 * facet, that facet's own include list is left out, so picking one value
 * does not collapse its own list to a single row. Standard faceted search
 * behaviour, and without it the second click in a facet is impossible.
 */
export function applyFilter(
  assets: AtomicAsset[], st: InventoryState, skipKey?: string,
): AtomicAsset[] {
  const terms = st.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return assets.filter((a) => {
    if (terms.length) {
      const hay = haystack(a);
      // Every word must appear somewhere. Typing more always narrows.
      if (!terms.every((t) => hay.includes(t))) return false;
    }
    for (const [key, vals] of Object.entries(st.exclude)) {
      if (!vals.length) continue;
      if (vals.includes(facetValue(a, key))) return false;
    }
    for (const [key, vals] of Object.entries(st.include)) {
      if (!vals.length || key === skipKey) continue;
      if (!vals.includes(facetValue(a, key))) return false;
    }
    return true;
  });
}

/**
 * The facets worth offering for a set of assets.
 *
 * Recomputed on every render from the filtered set, which is what makes
 * the refinement progressive. A field that holds a different value on
 * every asset is a poor filter and a long list, so anything above
 * `maxValues` distinct values is offered with its top values only and
 * says how many it hid.
 */
export function facetsOf(
  assets: AtomicAsset[], st: InventoryState, maxValues = 25,
): Facet[] {
  const out: Facet[] = [];
  const keys: { key: string; label: string }[] = [
    { key: 'collection', label: 'Collection' },
    { key: 'schema', label: 'Schema' },
    { key: 'template', label: 'Template' },
  ];
  // Attribute keys present anywhere in the current set, in first-seen
  // order so a schema's own field order roughly survives.
  const attrKeys: string[] = [];
  for (const a of assets) {
    for (const k of Object.keys(a.data ?? {})) {
      if (UNFACETABLE.has(k.toLowerCase())) continue;
      const key = ATTR_PREFIX + k;
      if (!attrKeys.includes(key)) attrKeys.push(key);
    }
  }
  for (const k of attrKeys) keys.push({ key: k, label: k.slice(ATTR_PREFIX.length) });

  for (const { key, label } of keys) {
    // Counted against everything the OTHER filters allow, so the numbers
    // beside each value are what you would get by clicking it.
    const pool = applyFilter(assets, st, key);
    const counts = new Map<string, number>();
    for (const a of pool) {
      const v = facetValue(a, key);
      if (!v) continue;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    if (counts.size === 0) continue;
    // A facet whose every asset shares one value tells you nothing, unless
    // it is already being filtered on and needs to stay visible to undo.
    const chosen = (st.include[key]?.length ?? 0) + (st.exclude[key]?.length ?? 0);
    if (counts.size === 1 && !chosen) continue;
    const values = [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((x, y) => y.count - x.count || x.value.localeCompare(y.value));
    out.push({ key, label, values: values.slice(0, maxValues), total: values.length });
  }
  return out;
}

/** Sort keys that are not facets: the ones every asset always has. */
export const SORT_KEYS: { key: string; label: string }[] = [
  { key: 'asset_id', label: 'Asset id' },
  { key: 'name', label: 'Name' },
  { key: 'template_mint', label: 'Mint number' },
  { key: 'collection', label: 'Collection' },
  { key: 'schema', label: 'Schema' },
  { key: 'template', label: 'Template' },
];

/**
 * Ordered for display.
 *
 * Numbers sort as numbers. Mint 2 belongs before mint 10, and asset ids
 * are 64 bit so they are compared as BigInt rather than as doubles, which
 * lose precision above 2^53 and would shuffle a whale's inventory.
 */
export function sortAssets(assets: AtomicAsset[], key: string, desc: boolean): AtomicAsset[] {
  const numeric = key === 'asset_id' || key === 'template_mint' || key === 'template';
  const out = [...assets].sort((a, b) => {
    if (numeric) {
      const av = key === 'asset_id' ? a.asset_id
        : key === 'template_mint' ? (a.template_mint ?? '')
          : (a.template?.template_id ?? '');
      const bv = key === 'asset_id' ? b.asset_id
        : key === 'template_mint' ? (b.template_mint ?? '')
          : (b.template?.template_id ?? '');
      const an = big(av); const bn = big(bv);
      return an === bn ? 0 : an < bn ? -1 : 1;
    }
    const av = key === 'name' ? (a.name ?? '') : facetValue(a, key);
    const bv = key === 'name' ? (b.name ?? '') : facetValue(b, key);
    // A numeric-looking attribute still sorts numerically: "Level 10"
    // after "Level 9" is what a player expects.
    const an = Number(av); const bn = Number(bv);
    if (av !== '' && bv !== '' && Number.isFinite(an) && Number.isFinite(bn)) {
      return an - bn;
    }
    return av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' });
  });
  return desc ? out.reverse() : out;
}

function big(v: string): bigint {
  try { return BigInt(v || '0'); } catch { return 0n; }
}

/** Adds, flips or removes one facet value. Include and exclude are exclusive. */
export function toggleFacet(
  st: InventoryState, key: string, value: string, mode: 'include' | 'exclude',
): void {
  const other = mode === 'include' ? 'exclude' : 'include';
  const cur = st[mode][key] ?? [];
  const had = cur.includes(value);
  // Leaving the other side set as well would ask for a row that is both
  // required and forbidden, which can only ever return nothing.
  st[other][key] = (st[other][key] ?? []).filter((v) => v !== value);
  if (!st[other][key].length) delete st[other][key];
  st[mode][key] = had ? cur.filter((v) => v !== value) : [...cur, value];
  if (!st[mode][key].length) delete st[mode][key];
}

export function clearFilters(st: InventoryState): void {
  st.q = '';
  st.include = {};
  st.exclude = {};
  st.limit = 120;
}

/** How many filters are on, for the "clear" control and the summary line. */
export function activeFilterCount(st: InventoryState): number {
  const n = (r: Record<string, string[]>) =>
    Object.values(r).reduce((s, v) => s + v.length, 0);
  return (st.q.trim() ? 1 : 0) + n(st.include) + n(st.exclude);
}

/**
 * The whole view as URL text, so a filtered inventory is a link.
 *
 * Deliberately compact: this ends up in a hash somebody pastes into chat.
 * Keys are separated by `~`, values inside a key by `,`, and an excluded
 * value is prefixed with `!`.
 */
export function encodeInventoryView(st: InventoryState): string {
  const parts: string[] = [];
  if (st.q.trim()) parts.push(`q=${encodeURIComponent(st.q.trim())}`);
  const pack = (r: Record<string, string[]>, bang: string) => {
    for (const [k, vals] of Object.entries(r)) {
      if (!vals.length) continue;
      parts.push(`${encodeURIComponent(k)}=${vals.map((v) => bang + encodeURIComponent(v)).join(',')}`);
    }
  };
  pack(st.include, '');
  pack(st.exclude, '!');
  if (st.view !== 'grid') parts.push(`view=${st.view}`);
  if (st.sortKey !== 'asset_id' || !st.sortDesc) {
    parts.push(`sort=${encodeURIComponent(st.sortKey)}${st.sortDesc ? '' : ':asc'}`);
  }
  return parts.join('~');
}

export function decodeInventoryView(text: string, st: InventoryState): void {
  if (!text) return;
  for (const chunk of text.split('~')) {
    const eq = chunk.indexOf('=');
    if (eq < 0) continue;
    const key = decodeURIComponent(chunk.slice(0, eq));
    const raw = chunk.slice(eq + 1);
    if (key === 'q') { st.q = decodeURIComponent(raw); continue; }
    if (key === 'view') { st.view = raw === 'list' ? 'list' : 'grid'; continue; }
    if (key === 'sort') {
      const [k, order] = decodeURIComponent(raw).split(':');
      st.sortKey = k || 'asset_id';
      st.sortDesc = order !== 'asc';
      continue;
    }
    for (const v of raw.split(',')) {
      if (!v) continue;
      const excluded = v.startsWith('!');
      const value = decodeURIComponent(excluded ? v.slice(1) : v);
      const bag = excluded ? st.exclude : st.include;
      bag[key] = [...(bag[key] ?? []), value];
    }
  }
}

/** Pulls the wallet's NFTs. One call, then everything else is local. */
export async function loadInventory(st: InventoryState, owner: string, force = false): Promise<void> {
  st.loading = true;
  st.error = '';
  st.owner = owner;
  // Cleared rather than left standing: showing one wallet's NFTs under
  // another wallet's name for the length of a round trip is the kind of
  // mistake that gets somebody to burn the wrong thing.
  st.assets = [];
  st.loadedFor = '';
  try {
    if (force) clearAssetsCache();
    const assets = await listAssetsForOwner({ owner, force });
    if (st.owner !== owner) return;   // a switch landed while we waited
    st.assets = assets;
    st.loadedFor = owner;
  } catch (e) {
    st.error = e instanceof Error ? e.message : String(e);
  } finally {
    if (st.owner === owner) st.loading = false;
  }
}
