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
 * The view lives in the URL, so a filtered inventory is a link somebody
 * can send. Separately, and only for choices rather than data, a few
 * preferences survive a reload through ./prefs: which view mode you like,
 * how you sort, and any filter sets you named. Nothing about your wallet
 * or your NFTs is ever written, and a button clears the lot.
 */
import { listAssetsForOwner, clearAssetsCache, type AtomicAsset } from '../atomic/assets';
import { atomicFetch } from '../chain/rpc';

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
  /**
   * What is typed in the Wallet field right now, which is not the same
   * thing as the wallet being shown.
   *
   * These were briefly the same field, so that a typed name would survive
   * a re-render. It did, and it also broke the read it was meant to help:
   * `loadInventory` uses `owner` as its in-flight identity guard, so
   * correcting a character mid-read made the finished read discard itself
   * and leave `loading` true for good. A draft is a draft.
   */
  ownerDraft: string;
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
  /**
   * The narrowest a grid card may be, in pixels. The grid packs in as
   * many columns as fit, so this is really "how big do you want the
   * artwork", and the column count follows from it and the screen. One
   * control that means the right thing on a phone and on a monitor.
   */
  cardSize: number;
  /** How many rows are on screen. Raised by the "show more" control. */
  limit: number;
  /** Facet panels the reader has opened. */
  openFacets: string[];
  /**
   * Whether the filter panel is showing.
   *
   * Only meaningful on a narrow screen, where the panel is a dialog. On a
   * wide one the same markup is a column beside the results and is always
   * there, so this is ignored. Not stored and not in the URL: whether a
   * drawer happened to be open is not part of the view somebody shares.
   */
  filtersOpen: boolean;
  /**
   * The asset being looked at, if any. Carried in the URL like the rest
   * of the view, so a link opens on the same NFT the sender was reading.
   */
  openAsset: string;
  /**
   * A template being looked at, and everyone who owns one. Kept apart
   * from openAsset because you reach it FROM an asset and go back to it.
   */
  openTemplate: string;
  templateOwners: { owner: string; count: number }[];
  templateState: 'idle' | 'loading' | 'done' | 'error';
  /** What the open NFT can be fed to, and whether we have looked. */
  uses: import('./bridge').Uses | undefined;
  usesState: 'idle' | 'loading' | 'done';
  /**
   * The other half of a wallet: its fungible tokens.
   *
   * A dialog rather than a column, and loaded only when it is opened.
   * Finding tokens costs an indexer round trip plus one read per issuer,
   * which is not a price the NFT list should pay on every visit. Not in
   * the URL for the same reason the filter drawer is not: whether a panel
   * happened to be open is not part of the view somebody shares.
   */
  tokensOpen: boolean;
  tokens: import('../nefty/wallet').WalletTokens | undefined;
  tokensState: 'idle' | 'loading' | 'done' | 'error';
  /** Which wallet the token list belongs to, so it cannot outlive it. */
  tokensFor: string;
  /** Free text over ticker and issuer, for wallets holding dozens. */
  tokensQ: string;
  /** Empty balances are hidden by default; this shows them. */
  tokensShowEmpty: boolean;
}

export function emptyInventoryState(): InventoryState {
  return {
    owner: '', ownerDraft: '', loadedFor: '', loading: false, error: '', assets: [],
    q: '', include: {}, exclude: {}, view: 'grid',
    sortKey: 'received', sortDesc: true, cardSize: 96, limit: 120, openFacets: [], filtersOpen: false,
    openAsset: '', openTemplate: '', templateOwners: [], templateState: 'idle',
    uses: undefined, usesState: 'idle',
    tokensOpen: false, tokens: undefined, tokensState: 'idle', tokensFor: '',
    tokensQ: '', tokensShowEmpty: false,
  };
}

/** Keys the contract-level fields live under, kept apart from `data`. */
export const CORE_FACETS = ['collection', 'schema', 'template'] as const;

export const ATTR_PREFIX = 'attr:';

/**
 * The offered card widths.
 *
 * Deliberately a short list rather than a slider: a slider invites
 * fiddling and stores an arbitrary number, and four steps already cover
 * "cram in as many as possible" through "let me actually see the art".
 */
export const CARD_SIZES: { px: number; label: string }[] = [
  { px: 64, label: 'XS' },
  { px: 96, label: 'S' },
  { px: 140, label: 'M' },
  { px: 200, label: 'L' },
];

/** A stored or shared size, held to the offered range. */
export function clampCardSize(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 96;
  // Snapped to an offered step rather than merely clamped, so a hand
  // edited URL cannot produce a layout nobody designed.
  return CARD_SIZES.reduce((best, s) =>
    Math.abs(s.px - n) < Math.abs(best - n) ? s.px : best, 96);
}

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

/**
 * The artwork reference an asset carries, wherever the author put it.
 *
 * Looking only at `img` and `image` left most of a real wallet blank:
 * 33 of 120 cards had a picture. Authors use `img2`, and one collection
 * numbers its fields `1`, `2`, `3`. So instead of a fixed list of names,
 * this takes the first value that LOOKS like artwork, which is a CID or
 * an https URL, from the fields most likely to hold one first.
 */
export function artworkOf(a: AtomicAsset): string {
  const data = a.data ?? {};
  const looksLikeArt = (v: unknown) => {
    const t = stringify(v).trim();
    if (!t) return false;
    return /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[A-Za-z2-7]{20,})$/.test(t)
      || /^ipfs:\/\//i.test(t)
      || /^https?:\/\/\S+\.(png|jpe?g|gif|webp|avif|svg)(\?|$)/i.test(t);
  };
  // Named fields first, so an author who filled `img` still wins over a
  // stray CID in some other attribute.
  for (const k of ['img', 'image', 'video', 'img2', 'backimg', 'back_img']) {
    if (looksLikeArt(data[k])) return stringify(data[k]);
  }
  for (const v of Object.values(data)) {
    if (looksLikeArt(v)) return stringify(v);
  }
  return '';
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
  // First, and the default: the order things landed in the wallet. An
  // inventory should open on what you just got.
  { key: 'received', label: 'Recently received' },
  { key: 'minted', label: 'Mint date' },
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
/** The numeric fields, and where each one's value comes from. */
const NUMERIC_SORT: Record<string, (a: AtomicAsset) => string> = {
  asset_id: (a) => a.asset_id,
  template_mint: (a) => a.template_mint ?? '',
  template: (a) => a.template?.template_id ?? '',
  received: (a) => a.transferred_at_time ?? '0',
  minted: (a) => a.minted_at_time ?? '0',
};

export function sortAssets(assets: AtomicAsset[], key: string, desc: boolean): AtomicAsset[] {
  const pick = NUMERIC_SORT[key];
  const out = [...assets].sort((a, b) => {
    if (pick) {
      // Compared as BigInt because asset ids are 64 bit and WAX issues
      // them high enough to pass 2^53, where a double stops being exact.
      // Millisecond timestamps sit around 1.8e12 and would be safe as
      // numbers, but they go through the same path rather than growing a
      // second one that could disagree with it.
      const an = big(pick(a)); const bn = big(pick(b));
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
/**
 * Percent-encoding, plus the two characters this format uses as
 * separators.
 *
 * encodeURIComponent leaves `~` alone, because it is an unreserved mark
 * in the URI spec. That is fine for a URL and fatal here: a schema named
 * `x~y` would split its own chunk in half and the filter would come back
 * as two broken ones. Found by the harness, not by reading the code.
 */
function enc(v: string): string {
  return encodeURIComponent(v).replace(/~/g, '%7E');
}

export function encodeInventoryView(st: InventoryState): string {
  const parts: string[] = [];
  if (st.q.trim()) parts.push(`q=${enc(st.q.trim())}`);
  const pack = (r: Record<string, string[]>, bang: string) => {
    for (const [k, vals] of Object.entries(r)) {
      if (!vals.length) continue;
      parts.push(`${enc(k)}=${vals.map((v) => bang + enc(v)).join(',')}`);
    }
  };
  pack(st.include, '');
  pack(st.exclude, '!');
  if (st.view !== 'grid') parts.push(`view=${st.view}`);
  // Direction rides in its own key rather than after a colon in the sort
  // key. Attribute keys are `attr:rarity`, so `sort=attr:rarity:asc` was
  // being split at the FIRST colon and came back as a sort by `attr`.
  if (st.sortKey !== 'received') parts.push(`sort=${enc(st.sortKey)}`);
  if (!st.sortDesc) parts.push('asc=1');
  if (st.cardSize !== 96) parts.push(`size=${st.cardSize}`);
  // What is being looked at travels too: "look at this one" is the most
  // obvious reason to send somebody an inventory link.
  if (st.openAsset) parts.push(`asset=${enc(st.openAsset)}`);
  if (st.openTemplate) parts.push(`tpl=${enc(st.openTemplate)}`);
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
    if (key === 'sort') { st.sortKey = decodeURIComponent(raw) || 'received'; continue; }
    if (key === 'asc') { st.sortDesc = raw !== '1'; continue; }
    if (key === 'size') { st.cardSize = clampCardSize(raw); continue; }
    if (key === 'asset') { st.openAsset = decodeURIComponent(raw); continue; }
    if (key === 'tpl') { st.openTemplate = decodeURIComponent(raw); continue; }
    for (const v of raw.split(',')) {
      if (!v) continue;
      const excluded = v.startsWith('!');
      const value = decodeURIComponent(excluded ? v.slice(1) : v);
      const bag = excluded ? st.exclude : st.include;
      bag[key] = [...(bag[key] ?? []), value];
    }
  }
}

/**
 * Everyone who owns a copy of one template.
 *
 * Answers "who else has this", the question that follows "what is this"
 * and the one the standard explorer buries. Read from the AtomicAssets
 * accounts endpoint rather than by paging every asset, so a template
 * with thousands of copies costs one request rather than thousands.
 */
export async function loadTemplateOwners(
  templateId: string,
): Promise<{ owner: string; count: number }[]> {
  if (!templateId) return [];
  const rows = await atomicFetch<{ account: string; assets: string }[]>(
    `/atomicassets/v1/accounts?template_id=${encodeURIComponent(templateId)}&limit=200`,
  );
  return (Array.isArray(rows) ? rows : [])
    .map((r) => ({ owner: String(r.account), count: Number(r.assets) || 0 }))
    .sort((a, b) => b.count - a.count || a.owner.localeCompare(b.owner));
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
