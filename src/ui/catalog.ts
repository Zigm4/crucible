/**
 * Collection catalogue (route `#/catalog/<collection>`).
 * ─────────────────────────────────────────────────────────────
 * One page answering the only question a player actually has:
 * **"what can I make, open or claim in this collection?"**
 *
 * The rest of Crucible is organised the way the CHAIN is: one tab per
 * contract, because that is what you need when you are about to sign
 * something. That is the wrong shape for browsing. A player does not
 * think "I want a blend.nefty recipe", they think "I want boots" - and
 * the boots might come from a blend, a Blenderizer recipe, a drop or a
 * pack, on four different contracts, with no single place listing them.
 *
 * So this page inverts the axis. It scans all six contracts in
 * parallel for ONE collection, normalises every result into a single
 * `CatalogEntry` shape, and groups them by **category** (the schema of
 * the NFT produced) instead of by contract. Grouping by contract is
 * still one click away, because authors do think that way.
 *
 *   blend.nefty    blends          -> nefty/discover.ts
 *   neftyblocksd   drops           -> nefty/drops.ts
 *   atomicpacksx   packs           -> nefty/packs.ts
 *   neftyblocksp   packs           -> nefty/neftyPacks.ts
 *   up.nefty       upgrades        -> nefty/upgrades.ts
 *   waxdaomarket   blends          -> waxdao/blends.ts
 *   blenderizerx   recipes         -> blenderizer/blends.ts
 *
 * Nothing here is signed. Every row deep-links into the normal app
 * (`#/nefty/blend/123`, `#/blenderizer/blend/336429`, ...) where the
 * existing per-contract flow does the actual signing. The catalogue is
 * a map, not a second implementation.
 *
 * With a wallet connected, entries the wallet can actually satisfy
 * right now are marked, and a single toggle hides everything else -
 * which is the feature that turns a long list into a to-do list.
 */

import { atomicFetch } from '../chain/rpc';
import { renderMediaThumb, pickImageRef } from './media';
import { listAssetsForOwner, type AtomicAsset } from '../atomic/assets';
import { buildSlots, nftSlots, ftSlots } from '../atomic/matcher';
import { listBlends, type DiscoveredBlend } from '../nefty/discover';
import { listDrops, type DiscoveredDrop } from '../nefty/drops';
import { listUpgrades, type DiscoveredUpgrade } from '../nefty/upgrades';
import { listPackDesigns, pickOwnedPacks, type PackDesign } from '../nefty/packs';
import { listNeftyPackDesigns } from '../nefty/neftyPacks';
import { listWaxdaoBlends, type DiscoveredWaxdaoBlend } from '../waxdao/blends';
import {
  listBlenderizerBlends,
  blenderizerTitle,
  type DiscoveredBlenderizerBlend,
} from '../blenderizer/blends';

// ─── shaped model ───────────────────────────────────────────────────────

/** Which contract an entry came from. Drives the badge and the deep link. */
export type CatalogKind =
  | 'blend'
  | 'drop'
  | 'pack'
  | 'upgrade'
  | 'waxdao'
  | 'blenderizer';

export type CatalogStatus =
  | 'active'
  | 'sold_out'
  | 'ended'
  | 'upcoming'
  | 'hidden'
  | 'locked';

export interface CatalogEntry {
  kind: CatalogKind;
  /** Contract account, shown in the badge tooltip. */
  contract: string;
  id: string;
  name: string;
  /** Hash route into the normal app, where signing happens. */
  href: string;
  status: CatalogStatus;
  /**
   * Schema of the NFT this entry produces (upgrades: the schema they
   * mutate). This is the grouping axis: it is what a player recognises,
   * e.g. "up.armour", "up.resources".
   */
  category: string;
  /** Template produced, when there is exactly one obvious one. */
  templateId?: number;
  image?: string;
  /** One-line cost summary, e.g. "10 NFTs", "1.00 WAX", "free". */
  cost: string;
  /** Extra qualifier chips. */
  gated: boolean;
  random: boolean;
  /**
   * True when the connected wallet can satisfy this entry right now.
   * `undefined` when no wallet is connected, or when the check does not
   * apply (drops, where the gate is tokens rather than NFTs).
   */
  doable?: boolean;
  /** Why it is not doable, when we can say something useful. */
  blocked?: string;
}

const UNCATEGORISED = 'uncategorised';

// ─── state ──────────────────────────────────────────────────────────────

export type CatalogGrouping = 'category' | 'contract';

interface CatalogState {
  collection: string;
  /** Collection currently loaded (may lag behind the input while typing). */
  loaded?: string;
  entries: CatalogEntry[];
  scanning: boolean;
  scanned: boolean;
  progress: { pct: number; message: string };
  errors: string[];
  /** Per-source counts, including sources that returned nothing. */
  sourceCounts: { label: string; contract: string; n: number; failed: boolean }[];
  grouping: CatalogGrouping;
  search: string;
  onlyDoable: boolean;
  showInactive: boolean;
  /** Collapsed group titles, so long pages stay navigable. */
  collapsed: Set<string>;
  actor?: string;
  ownedCount: number;
}

const state: CatalogState = {
  collection: '',
  entries: [],
  scanning: false,
  scanned: false,
  progress: { pct: 0, message: '' },
  errors: [],
  sourceCounts: [],
  grouping: 'category',
  search: '',
  onlyDoable: false,
  showInactive: false,
  collapsed: new Set(),
  ownedCount: 0,
};

export function getCatalogState(): CatalogState {
  return state;
}

export function setCatalogCollection(v: string) {
  state.collection = v.trim().toLowerCase();
}
export function setCatalogGrouping(g: CatalogGrouping) {
  state.grouping = g;
}
export function setCatalogSearch(v: string) {
  state.search = v;
}
export function setCatalogOnlyDoable(v: boolean) {
  state.onlyDoable = v;
}
export function setCatalogShowInactive(v: boolean) {
  state.showInactive = v;
}
export function toggleCatalogGroup(title: string) {
  if (state.collapsed.has(title)) state.collapsed.delete(title);
  else state.collapsed.add(title);
}

// ─── scanning ───────────────────────────────────────────────────────────

/**
 * Scans all six contracts for `collection` in parallel and rebuilds the
 * catalogue. Every source is independent: one failing contract adds a
 * line to `errors` and the rest of the page still renders.
 *
 * `actor` (optional) enables the wallet-aware "I can do this" marking.
 */
export async function runCatalogScan(
  collection: string,
  actor: string | undefined,
  onProgress: () => void,
): Promise<void> {
  if (state.scanning) return;
  const target = collection.trim().toLowerCase();
  if (!target) return;

  state.scanning = true;
  state.scanned = false;
  state.entries = [];
  state.errors = [];
  state.sourceCounts = [];
  state.actor = actor;
  state.ownedCount = 0;
  state.loaded = target;
  state.progress = { pct: 0.02, message: `Scanning ${target}…` };
  onProgress();

  // The wallet inventory is shared by every "can I do this" check, so
  // fetch it once up front rather than per source.
  let owned: AtomicAsset[] = [];
  if (actor) {
    try {
      owned = await listAssetsForOwner({
        owner: actor,
        collection_name: target,
        force: true,
      });
      state.ownedCount = owned.length;
    } catch {
      // non-fatal: entries just stay unmarked
    }
  }

  let done = 0;
  const SOURCES = 6;
  const step = (label: string) => {
    done += 1;
    state.progress = {
      pct: 0.05 + 0.9 * (done / SOURCES),
      message: `${label} · ${done}/${SOURCES} sources`,
    };
    onProgress();
  };

  const collected: CatalogEntry[] = [];
  const note = (label: string, contract: string, n: number, failed: boolean) => {
    state.sourceCounts.push({ label, contract, n, failed });
  };
  const fail = (label: string, err: unknown) => {
    state.errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
  };

  await Promise.all([
    (async () => {
      try {
        const { blends } = await listBlends({
          collection: target,
          includeInactive: true,
          actor,
        });
        const rows = blends.map((b) => fromNeftyBlend(b, owned, !!actor));
        collected.push(...rows);
        note('Blends', 'blend.nefty', rows.length, false);
      } catch (e) {
        fail('blend.nefty', e);
        note('Blends', 'blend.nefty', 0, true);
      } finally {
        step('blend.nefty');
      }
    })(),

    (async () => {
      try {
        const { drops } = await listDrops({
          collection: target,
          includeInactive: true,
          actor,
          ownedAssets: owned,
        });
        const rows = drops.map(fromDrop);
        collected.push(...rows);
        note('Drops', 'neftyblocksd', rows.length, false);
      } catch (e) {
        fail('neftyblocksd', e);
        note('Drops', 'neftyblocksd', 0, true);
      } finally {
        step('neftyblocksd');
      }
    })(),

    (async () => {
      try {
        const { upgrades } = await listUpgrades({
          collection: target,
          includeInactive: true,
        });
        const rows = upgrades.map((u) => fromUpgrade(u, owned, !!actor));
        collected.push(...rows);
        note('Upgrades', 'up.nefty', rows.length, false);
      } catch (e) {
        fail('up.nefty', e);
        note('Upgrades', 'up.nefty', 0, true);
      } finally {
        step('up.nefty');
      }
    })(),

    (async () => {
      try {
        // Both pack contracts feed the same UNPACK tab, so they are one
        // "source" from the player's point of view.
        const [a, b] = await Promise.all([
          listPackDesigns(target).catch(() => [] as PackDesign[]),
          listNeftyPackDesigns(target).catch(() => [] as PackDesign[]),
        ]);
        const designs = [...a, ...b];
        const ownedPacks = actor ? pickOwnedPacks(owned, designs) : [];
        const heldByDesign = new Map<string, number>();
        for (const p of ownedPacks) {
          const k = `${p.pack.source}:${p.pack.pack_id}`;
          heldByDesign.set(k, (heldByDesign.get(k) ?? 0) + 1);
        }
        const rows = designs.map((d) => fromPack(d, heldByDesign, !!actor));
        collected.push(...rows);
        note('Packs', 'atomicpacksx + neftyblocksp', rows.length, false);
      } catch (e) {
        fail('packs', e);
        note('Packs', 'atomicpacksx + neftyblocksp', 0, true);
      } finally {
        step('packs');
      }
    })(),

    (async () => {
      try {
        const { blends } = await listWaxdaoBlends({
          collection: target,
          includeInactive: true,
        });
        const rows = blends.map((b) => fromWaxdao(b, owned, !!actor));
        collected.push(...rows);
        note('WaxDAO blends', 'waxdaomarket', rows.length, false);
      } catch (e) {
        fail('waxdaomarket', e);
        note('WaxDAO blends', 'waxdaomarket', 0, true);
      } finally {
        step('waxdaomarket');
      }
    })(),

    (async () => {
      try {
        const { blends } = await listBlenderizerBlends({
          collection: target,
          includeInactive: true,
        });
        const rows = blends.map((b) => fromBlenderizer(b, owned, !!actor));
        collected.push(...rows);
        note('Blenderizer recipes', 'blenderizerx', rows.length, false);
      } catch (e) {
        fail('blenderizerx', e);
        note('Blenderizer recipes', 'blenderizerx', 0, true);
      } finally {
        step('blenderizerx');
      }
    })(),
  ]);

  state.progress = { pct: 0.97, message: 'Resolving categories…' };
  onProgress();
  await resolveCategories(target, collected);

  state.sourceCounts.sort((a, b) => a.label.localeCompare(b.label));
  state.entries = collected;
  state.scanning = false;
  state.scanned = true;
  state.progress = { pct: 1, message: '' };
  onProgress();
}

// ─── per-source normalisation ───────────────────────────────────────────

function statusFrom(s: string): CatalogStatus {
  switch (s) {
    case 'active':   return 'active';
    case 'sold_out': return 'sold_out';
    case 'ended':    return 'ended';
    case 'upcoming': return 'upcoming';
    case 'hidden':   return 'hidden';
    default:         return 'active';
  }
}

/**
 * "Can the wallet fill every NFT slot?" Shared by the three contracts
 * whose cost is NFTs the user must hold (nefty blends, blenderizer,
 * waxdao). Token costs are reported separately as a caveat rather than
 * a hard no, since a balance check per entry would mean one RPC call
 * per row.
 */
function canFillSlots(
  need: { template_id?: number; schema_name?: string; collection_name?: string; amount: number }[],
  owned: AtomicAsset[],
): { ok: boolean; missing: string[] } {
  const pool = new Map<string, number>();
  for (const a of owned) {
    const t = a.template?.template_id;
    if (t != null) {
      const k = `t:${Number(t)}`;
      pool.set(k, (pool.get(k) ?? 0) + 1);
    }
    const s = a.schema?.schema_name;
    if (s) {
      const k = `s:${s}`;
      pool.set(k, (pool.get(k) ?? 0) + 1);
    }
  }
  const missing: string[] = [];
  // Sort template requirements first: they are the strictest, so
  // consuming them before schema-wide slots avoids a false negative.
  for (const req of [...need].sort((a, b) => (a.template_id ? 0 : 1) - (b.template_id ? 0 : 1))) {
    const key = req.template_id != null ? `t:${req.template_id}` : req.schema_name ? `s:${req.schema_name}` : null;
    if (!key) continue;
    const have = pool.get(key) ?? 0;
    if (have < req.amount) {
      missing.push(
        req.template_id != null
          ? `${req.amount - have}× template ${req.template_id}`
          : `${req.amount - have}× ${req.schema_name}`,
      );
    }
    pool.set(key, Math.max(0, have - req.amount));
  }
  return { ok: missing.length === 0, missing };
}

function fromNeftyBlend(b: DiscoveredBlend, owned: AtomicAsset[], hasWallet: boolean): CatalogEntry {
  const slots = b.ingredients ? buildSlots(b.ingredients, []) : [];
  const nft = nftSlots(slots);
  const ft = ftSlots(slots);
  const nftCount = nft.reduce((n, s) => n + s.amount, 0);
  const bits: string[] = [];
  if (nftCount > 0) bits.push(`${nftCount} NFT${nftCount === 1 ? '' : 's'}`);
  for (const f of ft) bits.push(f.quantity);

  let doable: boolean | undefined;
  let blocked: string | undefined;
  if (hasWallet && b.ingredients) {
    const need = nft.map((s) => ({
      template_id: s.template_id,
      collection_name: s.collection_name,
      amount: s.amount,
    }));
    const r = canFillSlots(need, owned);
    doable = r.ok;
    if (!r.ok) blocked = `missing ${r.missing.join(', ')}`;
    if (r.ok && b.whitelist_required && b.whitelist_allowed === false) {
      doable = false;
      blocked = 'not on the whitelist';
    }
  }

  return {
    kind: 'blend',
    contract: 'blend.nefty',
    id: b.blend_id,
    name: b.name,
    href: `#/nefty/blend/${b.blend_id}`,
    status: statusFrom(b.status),
    category: UNCATEGORISED,
    templateId: b.result_template_id,
    cost: bits.join(' + ') || 'free',
    gated: b.whitelist_required,
    random: b.is_random,
    doable,
    blocked,
  };
}

function fromDrop(d: DiscoveredDrop): CatalogEntry {
  const price = d.is_free ? 'free' : d.listing_price;
  const gated = d.auth?.kind !== undefined && d.auth.kind !== 'public';
  return {
    kind: 'drop',
    contract: 'neftyblocksd',
    id: d.drop_id,
    name: d.name,
    href: `#/nefty/claim/${d.drop_id}`,
    status: statusFrom(d.status),
    category: UNCATEGORISED,
    templateId: d.primary_template_id,
    cost: price,
    gated,
    random: false,
    // A drop's gate is tokens + whitelist, not NFTs in the wallet, so
    // a per-row "doable" would need one balance call each. Left unset.
    doable: undefined,
  };
}

function fromUpgrade(u: DiscoveredUpgrade, owned: AtomicAsset[], hasWallet: boolean): CatalogEntry {
  const bits: string[] = [];
  for (const ing of u.ingredients ?? []) {
    if (ing.kind === 'ft') bits.push(ing.quantity);
    else if ('amount' in ing && ing.amount) {
      bits.push(`${ing.amount} NFT${ing.amount === 1 ? '' : 's'}`);
    }
  }
  let doable: boolean | undefined;
  let blocked: string | undefined;
  if (hasWallet) {
    // An upgrade needs an NFT it accepts; the token cost is separate.
    const accepted = new Set((u.acceptedTemplateIds ?? []).map(Number));
    const has = accepted.size === 0
      ? undefined
      : owned.some((a) => a.template?.template_id != null && accepted.has(Number(a.template.template_id)));
    doable = has;
    if (has === false) blocked = 'you hold no NFT this upgrade accepts';
  }
  return {
    kind: 'upgrade',
    contract: 'up.nefty',
    id: u.upgrade_id,
    name: u.name,
    href: `#/nefty/upgrade/${u.upgrade_id}`,
    status: statusFrom(u.status),
    category: (u.specs ?? [])[0]?.schema_name || UNCATEGORISED,
    cost: bits.join(' + ') || 'free',
    gated: u.whitelist_required,
    random: u.is_random,
    doable,
    blocked,
  };
}

function fromPack(d: PackDesign, held: Map<string, number>, hasWallet: boolean): CatalogEntry {
  const n = held.get(`${d.source}:${d.pack_id}`) ?? 0;
  const locked = d.unlock_time > 0 && d.unlock_time * 1000 > Date.now();
  return {
    kind: 'pack',
    contract: d.source,
    id: d.pack_id,
    name: d.name,
    href: '#/nefty/unpack',
    status: locked ? 'locked' : 'active',
    category: UNCATEGORISED,
    templateId: d.pack_template_id,
    image: d.image,
    cost: `${d.roll_counter} roll${d.roll_counter === 1 ? '' : 's'}`,
    gated: false,
    random: true,
    // You can only open a pack you already hold, so ownership IS the gate.
    doable: hasWallet ? n > 0 : undefined,
    blocked: hasWallet && n === 0 ? 'you hold none of this pack' : undefined,
  };
}

function fromWaxdao(b: DiscoveredWaxdaoBlend, owned: AtomicAsset[], hasWallet: boolean): CatalogEntry {
  const bits: string[] = [];
  const need: { template_id?: number; schema_name?: string; amount: number }[] = [];
  for (const ing of b.ingredients) {
    if (ing.kind === 'fungible') bits.push(ing.quantity);
    else if (ing.kind === 'nft_template') {
      bits.push(`${ing.amount} NFT${ing.amount === 1 ? '' : 's'}`);
      need.push({ template_id: ing.template_id, amount: ing.amount });
    } else if (ing.kind === 'nft_schema') {
      bits.push(`${ing.amount} × ${ing.schema_name}`);
      need.push({ schema_name: ing.schema_name, amount: ing.amount });
    } else if (ing.kind === 'nft_collection' || ing.kind === 'nft_attribute') {
      bits.push(`${ing.amount} NFT${ing.amount === 1 ? '' : 's'}`);
    }
  }
  let doable: boolean | undefined;
  let blocked: string | undefined;
  if (hasWallet && need.length > 0) {
    const r = canFillSlots(need, owned);
    doable = r.ok;
    if (!r.ok) blocked = `missing ${r.missing.join(', ')}`;
  }
  return {
    kind: 'waxdao',
    contract: 'waxdaomarket',
    id: b.blend_id,
    name: b.title,
    href: `#/waxdao/blend/${b.blend_id}`,
    status: statusFrom(b.status),
    category: UNCATEGORISED,
    templateId: b.results?.[0]?.template_id,
    cost: bits.join(' + ') || 'free',
    gated: false,
    random: false,
    doable,
    blocked,
  };
}

function fromBlenderizer(
  b: DiscoveredBlenderizerBlend,
  owned: AtomicAsset[],
  hasWallet: boolean,
): CatalogEntry {
  let doable: boolean | undefined;
  let blocked: string | undefined;
  if (hasWallet) {
    const r = canFillSlots(
      b.slots.map((s) => ({ template_id: s.template_id, amount: s.amount })),
      owned,
    );
    doable = r.ok;
    if (!r.ok) blocked = `missing ${r.missing.join(', ')}`;
  }
  return {
    kind: 'blenderizer',
    contract: 'blenderizerx',
    id: b.blend_id,
    name: blenderizerTitle(b),
    href: `#/blenderizer/blend/${b.blend_id}`,
    status: b.status === 'sold_out' ? 'sold_out' : 'active',
    // blenderizer/blends.ts already resolved the target template.
    category: b.schema_name || UNCATEGORISED,
    templateId: b.target,
    image: b.image,
    cost: `${b.total_nfts} NFT${b.total_nfts === 1 ? '' : 's'}`,
    gated: false,
    random: false,
    doable,
    blocked,
  };
}

// ─── category resolution ────────────────────────────────────────────────

interface RawTemplate {
  template_id: string;
  schema?: { schema_name?: string };
  immutable_data?: Record<string, unknown>;
}

/**
 * Fills in `category` (and a fallback image) from the produced template's
 * schema, in batched indexer calls. Entries whose source already knew
 * their schema (upgrades, blenderizer) are skipped.
 *
 * Best-effort: unresolved entries fall into "uncategorised" rather than
 * disappearing, because a missing schema is a display problem, not a
 * reason to hide a recipe from a player.
 */
async function resolveCategories(collection: string, entries: CatalogEntry[]): Promise<void> {
  const pending = entries.filter((e) => e.category === UNCATEGORISED && e.templateId);
  const ids = [...new Set(pending.map((e) => e.templateId as number))];
  if (ids.length === 0) return;

  const byId = new Map<number, RawTemplate>();
  for (let i = 0; i < ids.length; i += 100) {
    const page = ids.slice(i, i + 100);
    try {
      const qs = new URLSearchParams({
        collection_name: collection,
        ids: page.join(','),
        limit: String(page.length),
      });
      const data = await atomicFetch<RawTemplate[]>(`/atomicassets/v1/templates?${qs.toString()}`);
      for (const t of data ?? []) byId.set(Number(t.template_id), t);
    } catch {
      // leave this page uncategorised
    }
  }

  for (const e of pending) {
    const t = byId.get(e.templateId as number);
    if (!t) continue;
    e.category = t.schema?.schema_name || UNCATEGORISED;
    if (!e.image) e.image = pickImageRef(t.immutable_data);
    // Packs and drops often have no display name of their own; the
    // produced template's name is the one players recognise.
    if (!e.name || /^(Blend|Drop|Pack|Template) #/i.test(e.name)) {
      const nm = typeof (t.immutable_data ?? {}).name === 'string'
        ? String((t.immutable_data ?? {}).name).trim()
        : '';
      if (nm) e.name = nm;
    }
  }
}

// ─── filtering + grouping ───────────────────────────────────────────────

const ACTIVE_STATUSES = new Set<CatalogStatus>(['active', 'locked']);

export function visibleEntries(): CatalogEntry[] {
  const q = state.search.trim().toLowerCase();
  return state.entries.filter((e) => {
    if (!state.showInactive && !ACTIVE_STATUSES.has(e.status)) return false;
    if (state.onlyDoable && e.doable !== true) return false;
    if (q) {
      const hay = `${e.name} ${e.category} ${e.contract} ${e.id}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

const KIND_LABEL: Record<CatalogKind, string> = {
  blend: 'Blend',
  drop: 'Drop',
  pack: 'Pack',
  upgrade: 'Upgrade',
  waxdao: 'WaxDAO blend',
  blenderizer: 'Blenderizer',
};

const STATUS_ORDER: Record<CatalogStatus, number> = {
  active: 0, locked: 1, upcoming: 2, sold_out: 3, ended: 4, hidden: 5,
};

function groupTitle(e: CatalogEntry): string {
  return state.grouping === 'category' ? e.category : `${KIND_LABEL[e.kind]} · ${e.contract}`;
}

export function groupedEntries(): { title: string; rows: CatalogEntry[] }[] {
  const map = new Map<string, CatalogEntry[]>();
  for (const e of visibleEntries()) {
    const t = groupTitle(e);
    if (!map.has(t)) map.set(t, []);
    map.get(t)!.push(e);
  }
  const groups = [...map.entries()].map(([title, rows]) => ({
    title,
    rows: rows.sort((a, b) => {
      // Doable first when a wallet is connected, then by status, then name.
      const d = (b.doable === true ? 1 : 0) - (a.doable === true ? 1 : 0);
      if (d !== 0) return d;
      const s = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      if (s !== 0) return s;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    }),
  }));
  groups.sort((a, b) => {
    // "uncategorised" always last; everything else alphabetical.
    const au = a.title === UNCATEGORISED ? 1 : 0;
    const bu = b.title === UNCATEGORISED ? 1 : 0;
    if (au !== bu) return au - bu;
    return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
  });
  return groups;
}

// ─── rendering ──────────────────────────────────────────────────────────

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function statusLabel(s: CatalogStatus): string {
  switch (s) {
    case 'active':   return 'active';
    case 'sold_out': return 'sold out';
    case 'ended':    return 'ended';
    case 'upcoming': return 'upcoming';
    case 'hidden':   return 'hidden';
    case 'locked':   return 'locked';
  }
}
/** Maps our statuses onto the shared status-chip classes. */
function statusClass(s: CatalogStatus): string {
  return s === 'locked' ? 'upcoming' : s;
}

function renderEntry(e: CatalogEntry): string {
  const chips: string[] = [];
  chips.push(`<span class="cat-kind cat-kind-${e.kind}" title="${esc(e.contract)}">${esc(KIND_LABEL[e.kind])}</span>`);
  if (e.status !== 'active') {
    chips.push(`<span class="status-chip status-${statusClass(e.status)}">${esc(statusLabel(e.status))}</span>`);
  }
  if (e.gated) chips.push('<span class="cat-flag">whitelist</span>');
  if (e.random) chips.push('<span class="cat-flag">random</span>');

  const mark = e.doable === true
    ? '<span class="cat-doable" title="your wallet can do this right now">✓ ready</span>'
    : e.blocked
      ? `<span class="cat-blocked" title="${esc(e.blocked)}">${esc(e.blocked)}</span>`
      : '';

  // A row thumbnail is the whole point of a browsing page, but 130 rows
  // must not mean 130 immediate requests: `loading="lazy"` on the img
  // (set in renderMediaThumb) keeps fetches to what is actually scrolled
  // into view.
  const art = renderMediaThumb({
    ref: e.image,
    alt: `${e.name} artwork`,
    className: 'media-thumb-row',
  });

  // The art cell is ALWAYS emitted, even when empty. A missing image, or
  // one whose <figure> gets pulled after every gateway fails, must not
  // shift the other columns of a 130-row grid.
  return `
    <a class="cat-row${e.doable === true ? ' is-doable' : ''}" href="${esc(e.href)}">
      <span class="cat-art">${art}</span>
      <span class="cat-name">${esc(e.name)}</span>
      <span class="cat-chips">${chips.join('')}</span>
      <span class="cat-cost" title="${esc(e.cost)}">${esc(e.cost)}</span>
      <span class="cat-mark">${mark}</span>
    </a>`;
}

function renderGroup(g: { title: string; rows: CatalogEntry[] }): string {
  const collapsed = state.collapsed.has(g.title);
  const ready = g.rows.filter((r) => r.doable === true).length;
  return `
    <section class="cat-group">
      <button class="cat-group-head" data-action="catalogToggleGroup" data-group="${esc(g.title)}">
        <span class="cat-group-caret">${collapsed ? '▸' : '▾'}</span>
        <span class="cat-group-title">${esc(g.title)}</span>
        <span class="cat-group-count">${g.rows.length}${ready > 0 ? ` · ${ready} ready` : ''}</span>
      </button>
      ${collapsed ? '' : `<div class="cat-rows">${g.rows.map(renderEntry).join('')}</div>`}
    </section>`;
}

function renderSummary(): string {
  if (!state.scanned) return '';
  const total = state.entries.length;
  const active = state.entries.filter((e) => ACTIVE_STATUSES.has(e.status)).length;
  const ready = state.entries.filter((e) => e.doable === true).length;
  const cards = state.sourceCounts.map((s) => `
    <div class="cat-stat${s.failed ? ' cat-stat-failed' : ''}">
      <span class="cat-stat-n">${s.failed ? '—' : s.n}</span>
      <span class="cat-stat-label">${esc(s.label)}</span>
      <span class="cat-stat-sub">${esc(s.contract)}</span>
    </div>`).join('');
  return `
    <div class="cat-stats">${cards}</div>
    <p class="status-line ${ready > 0 ? 'ok' : ''}" style="margin-top:10px">
      ${total} entr${total === 1 ? 'y' : 'ies'} · ${active} available now${
        state.actor
          ? ` · <strong>${ready} your wallet can do right now</strong> (${state.ownedCount} NFT${state.ownedCount === 1 ? '' : 's'} held in this collection)`
          : ' · connect a wallet to see what you can do'
      }
    </p>`;
}

export function renderCatalogPage(): string {
  const s = state;
  const groups = s.scanned ? groupedEntries() : [];
  const shown = groups.reduce((n, g) => n + g.rows.length, 0);

  const progress = s.scanning
    ? `<div class="progress"><div class="progress-fill" style="width:${Math.round(s.progress.pct * 100)}%"></div></div>
       <p class="status-line">${esc(s.progress.message)}</p>`
    : '';

  const errors = s.errors.length
    ? `<p class="status-line warn">${s.errors.length} source(s) failed: ${esc(s.errors.join(' · '))}</p>`
    : '';

  const empty = s.scanned && groups.length === 0
    ? `<p class="status-line warn">Nothing matches. ${
        s.onlyDoable ? 'Try unticking “only what I can do”.' : s.showInactive ? '' : 'Try ticking “show ended / sold-out”.'
      }</p>`
    : '';

  return `
    <a class="app-link" href="#/nefty" style="margin-bottom:14px">← Open the app</a>
    <section>
      <div class="card-header">
        <h2>Collection catalogue</h2>
        <button id="catalog-refresh" ${s.scanning ? 'disabled' : ''}>${s.scanning ? 'Scanning…' : 'Scan collection'}</button>
      </div>
      <p class="term" style="margin:2px 0 12px; line-height:1.6; color:var(--fg-dim)">
        Everything one collection offers, from every contract Crucible speaks to,
        on a single page: blends, drops, packs, upgrades, WaxDAO blends and
        Blenderizer recipes. Grouped by <strong>what the item is</strong> rather
        than which contract happens to host it. Click any row to open it in the
        normal app and sign there.
      </p>
      <div class="row" style="gap:14px; align-items:flex-end; flex-wrap:wrap">
        <div style="flex:1 1 220px; min-width:180px">
          <label>Collection</label>
          <input id="catalog-collection" type="text" value="${esc(s.collection)}"
                 placeholder="e.g. underpunks55" autocomplete="off" spellcheck="false" />
        </div>
      </div>
      <div class="collection-chips">
        <span class="collection-chips-label">suggestions:</span>
        ${['underpunks55', 'cigalepixeld', 'northshireup', 'pearlhorizon']
          .map((c) => `<button type="button" class="collection-chip${s.collection === c ? ' active' : ''}" data-action="catalogPickCollection" data-collection="${c}">${c}</button>`)
          .join('')}
      </div>
      ${progress}
      ${errors}
      ${renderSummary()}
    </section>

    ${s.scanned ? `
    <section class="cat-controls">
      <div class="row" style="gap:12px; align-items:flex-end; flex-wrap:wrap">
        <div style="flex:1 1 240px; min-width:180px">
          <label>Search</label>
          <input id="catalog-search" type="text" value="${esc(s.search)}" placeholder="name, category, id…" autocomplete="off" />
        </div>
        <div>
          <label>Group by</label>
          <div class="cat-toggle">
            <button class="${s.grouping === 'category' ? 'active' : ''}" data-action="catalogGroupBy" data-grouping="category">Category</button>
            <button class="${s.grouping === 'contract' ? 'active' : ''}" data-action="catalogGroupBy" data-grouping="contract">Contract</button>
          </div>
        </div>
      </div>
      <div class="row" style="gap:16px; margin-top:10px; flex-wrap:wrap; align-items:center">
        <label class="inline-toggle">
          <input id="catalog-only-doable" type="checkbox" ${s.onlyDoable ? 'checked' : ''} ${s.actor ? '' : 'disabled'} />
          <span>only what I can do${s.actor ? '' : ' (connect a wallet)'}</span>
        </label>
        <label class="inline-toggle">
          <input id="catalog-show-inactive" type="checkbox" ${s.showInactive ? 'checked' : ''} />
          <span>show ended / sold-out / hidden</span>
        </label>
        <div class="spacer"></div>
        <span class="term">${shown} shown</span>
      </div>
    </section>` : ''}

    ${empty}
    ${groups.map(renderGroup).join('')}`;
}
