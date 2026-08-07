/**
 * Discovers and shapes NeftyBlocks `up.nefty` upgrades for the UPGRADE
 * tab. Mirrors drops.ts in structure (per-collection list, on-chain
 * fallback scan, status / security enrichment) but the on-chain shape
 * is different enough to warrant its own module.
 *
 * What is an "upgrade"?
 *   A recipe registered in `up.nefty/upgrades` that MUTATES the
 *   mutable_data of one or more existing NFTs the user already holds.
 *   Unlike a blend (burn-and-mint), the NFTs survive the operation:
 *   only their on-chain attributes change (image, colour, level, ...).
 *
 * On-chain action set
 *
 *   TX1 (single signature for the common case):
 *     [0a. up.nefty::openbal           per (owner, FT symbol), once ever]
 *     [0b. <token>::transfer           one per FT ingredient, memo "deposit"]
 *      1.  up.nefty::announcedepo       { owner, count }
 *     [2.  atomicassets::transfer       memo "deposit", when NFT ingredients are
 *           required (cost NFTs to burn)]
 *      3.  up.nefty::upgrade            { claimer, upgrade_id,
 *                                          transferred_assets, own_assets,
 *                                          assets_to_upgrade }
 *
 *   With a security gate (whitelist / ownership proof), step 3 becomes
 *   `up.nefty::upgradesec` with an extra `security_check` field. Same
 *   variant shape used by `blend.nefty::fuse` and `secure.nefty`.
 *
 * Random upgrades
 *   When upgrade_results contain non-IMMEDIATE values, the contract
 *   queues an ORNG job (visible in the `up.nefty/orngjobs` table). For
 *   the first cut this module flags them via `is_random` but the UI
 *   only executes deterministic ones (mirrors how RNG was added to
 *   blends later).
 */

import { getTableRows } from '../chain/rpc';

const CHAIN_CHUNK_SIZE = 200n;
const CHAIN_ROWS_PER_CALL = 200;
const CHAIN_MAX_CHUNKS = 12;

export type UpgradeStatus = 'active' | 'upcoming' | 'ended' | 'sold_out' | 'hidden';

// ── ingredient / requirement / result variants ──────────────────────── //

/**
 * What the user has to pay or burn to run the upgrade. Mirrors the
 * ingredient variants used by blend.nefty but with extra TYPED_ATTR
 * support. We only render the FT case in the picker today; other
 * cases are shown as plain-English notices.
 */
export type UpgradeIngredient =
  | { kind: 'ft'; quantity: string; effect: UpgradeEffect }
  | { kind: 'template'; template_id: number; collection_name: string; amount: number; effect: UpgradeEffect }
  | { kind: 'schema'; collection_name: string; schema_name: string; amount: number; effect: UpgradeEffect }
  | { kind: 'collection'; collection_name: string; amount: number; effect: UpgradeEffect }
  | { kind: 'balance'; schema_name: string; template_id: number; attribute_name: string; cost: number }
  | { kind: 'attribute'; collection_name: string; schema_name: string; amount: number; effect: UpgradeEffect }
  | { kind: 'typed_attribute'; collection_name: string; schema_name: string; amount: number; effect: UpgradeEffect }
  | { kind: 'unknown'; raw: unknown };

/**
 * Where an FT/NFT ingredient ends up: typically transferred to a fee
 * collector account (TRANSFER_EFFECT) or just burned (TYPED_EFFECT).
 */
export type UpgradeEffect =
  | { kind: 'transfer'; to: string }
  | { kind: 'typed'; type: number };

/**
 * Constraint on which NFTs the user can apply this upgrade to. The
 * most common case in production is `templates` (one of a specific
 * set of template_ids) or `template` (a single template_id).
 */
export type UpgradeRequirement =
  | { kind: 'template'; template_id: number }
  | { kind: 'templates'; template_ids: number[] }
  | { kind: 'attribute'; raw: unknown };

/** What attribute the upgrade rewrites and to which value. */
export interface UpgradeResult {
  attribute_name: string;
  attribute_type: string;
  /** 0 = SET (default for IMMEDIATE_VALUE). Other ops can add / subtract. */
  op_type: number;
  /** Decoded value when the variant is IMMEDIATE_VALUE; undefined for random results. */
  immediate_value?: string | number;
  /** True when the value came from a non-IMMEDIATE source (=> random / oracle-driven). */
  is_random: boolean;
}

export interface UpgradeSpec {
  schema_name: string;
  requirements: UpgradeRequirement[];
  results: UpgradeResult[];
  display_data: string;
}

export interface DiscoveredUpgrade {
  upgrade_id: string;
  collection_name: string;
  name: string;
  description?: string;
  /** Artwork of the upgraded result, from the row's display_data. */
  image?: string;
  status: UpgradeStatus;
  is_random: boolean;
  /** True when security_id != 0 (whitelist or ownership gate). */
  whitelist_required: boolean;
  whitelist_allowed?: boolean;
  ingredients: UpgradeIngredient[];
  specs: UpgradeSpec[];
  max: number;
  use_count: number;
  start_time: number;
  end_time: number;
  /** Convenience: every template_id any of the specs accept. Used by the matcher. */
  acceptedTemplateIds: number[];
}

// ── raw on-chain row shape ──────────────────────────────────────────── //

interface RawUpgradeRow {
  upgrade_id: number | string;
  collection_name: string;
  start_time: number;
  end_time: number;
  ingredients: Array<[string, Record<string, unknown>]>;
  upgrade_specs: Array<{
    schema_name: string;
    upgrade_requirements: Array<[string, Record<string, unknown>]>;
    upgrade_results: Array<{
      attribute_name: string;
      attribute_type: string;
      op: { type: number };
      value: [string, [string, unknown]];
    }>;
    display_data?: string;
  }>;
  max?: number | string;
  use_count?: number | string;
  display_data?: string;
  security_id?: number | string;
  is_hidden?: boolean;
  category?: string;
}

// ── public entrypoint ──────────────────────────────────────────────── //

export interface ListUpgradesOpts {
  collection: string;
  includeInactive?: boolean;
  onProgress?: (msg: string, pct: number) => void;
}

const cache = new Map<string, { at: number; data: DiscoveredUpgrade[] }>();
const TTL_MS = 5 * 60_000;

/**
 * Lists every upgrade for a collection. Result is sorted by status
 * (active first) then alphabetically by name within each status.
 *
 * Cached for 5 minutes keyed by `${collection}::${includeInactive}`.
 */
export async function listUpgrades(
  opts: ListUpgradesOpts,
): Promise<{ upgrades: DiscoveredUpgrade[] }> {
  const cacheKey = `${opts.collection}::${opts.includeInactive ? 'all' : 'active'}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) return { upgrades: hit.data };

  opts.onProgress?.('Probing the upgrades table...', 0);

  // Probe the latest upgrade_id so we don't walk into empty space.
  const tail = await getTableRows<{ upgrade_id: number | string }>({
    code: 'up.nefty',
    scope: 'up.nefty',
    table: 'upgrades',
    limit: 1,
    reverse: true,
  });
  const headFromProbe = tail.length ? BigInt(String(tail[0].upgrade_id ?? 0)) + 1n : 0n;
  const headId = headFromProbe > 100n ? headFromProbe : 2_000n;

  // Build chunk ranges.
  const ranges: { from: bigint; to: bigint }[] = [];
  for (let from = 0n; from < headId && ranges.length < CHAIN_MAX_CHUNKS; from += CHAIN_CHUNK_SIZE) {
    ranges.push({ from, to: from + CHAIN_CHUNK_SIZE });
  }

  // Walk every chunk in parallel, filter client-side by collection.
  let done = 0;
  const matched: RawUpgradeRow[] = [];
  await Promise.all(
    ranges.map(async (r) => {
      const rows = await scanRange(r.from, r.to);
      done += 1;
      opts.onProgress?.(
        `Scanning upgrades... chunk ${done}/${ranges.length}`,
        done / ranges.length,
      );
      for (const row of rows) {
        if (row.collection_name === opts.collection) matched.push(row);
      }
    }),
  );

  const filtered = matched
    .map(toDiscovered)
    .filter((u): u is DiscoveredUpgrade => !!u)
    .filter((u) => (opts.includeInactive ? true : u.status === 'active'));

  // Active first, then alphabetical by name within each bucket.
  filtered.sort((a, b) => {
    const p = statusPriority(a.status) - statusPriority(b.status);
    if (p !== 0) return p;
    return a.name.localeCompare(b.name);
  });

  cache.set(cacheKey, { at: Date.now(), data: filtered });
  return { upgrades: filtered };
}

async function scanRange(from: bigint, to: bigint): Promise<RawUpgradeRow[]> {
  const rows: RawUpgradeRow[] = [];
  let cursor = from;
  while (cursor < to) {
    const batch = await getTableRows<RawUpgradeRow>({
      code: 'up.nefty',
      scope: 'up.nefty',
      table: 'upgrades',
      lower_bound: String(cursor),
      upper_bound: String(to),
      limit: CHAIN_ROWS_PER_CALL,
    });
    if (batch.length === 0) break;
    rows.push(...batch);
    const last = BigInt(String(batch[batch.length - 1].upgrade_id ?? cursor));
    if (last + 1n <= cursor) break;
    cursor = last + 1n;
    if (batch.length < CHAIN_ROWS_PER_CALL) break;
  }
  return rows;
}

function statusPriority(s: UpgradeStatus): number {
  switch (s) {
    case 'active':   return 0;
    case 'upcoming': return 1;
    case 'sold_out': return 2;
    case 'ended':    return 3;
    case 'hidden':   return 4;
  }
}

function computeStatus(r: RawUpgradeRow): UpgradeStatus {
  if (r.is_hidden) return 'hidden';
  const max = Number(r.max ?? 0);
  const used = Number(r.use_count ?? 0);
  if (max > 0 && used >= max) return 'sold_out';
  const now = Date.now() / 1000;
  if (r.start_time > 0 && r.start_time > now) return 'upcoming';
  if (r.end_time > 0 && r.end_time < now) return 'ended';
  return 'active';
}

function parseDisplayData(
  d: string | undefined,
): { name?: string; description?: string; image?: string } {
  if (!d) return {};
  try {
    const o = JSON.parse(d);
    if (typeof o !== 'object' || !o) return {};
    return o as { name?: string; description?: string; image?: string };
  } catch {
    return {};
  }
}

function decodeEffect(raw: [string, Record<string, unknown>] | undefined): UpgradeEffect {
  if (!raw) return { kind: 'typed', type: 0 };
  const [tag, payload] = raw;
  if (tag === 'TRANSFER_EFFECT') return { kind: 'transfer', to: String(payload.to ?? '') };
  return { kind: 'typed', type: Number(payload.type ?? 0) };
}

function decodeIngredient(raw: [string, Record<string, unknown>]): UpgradeIngredient {
  const [tag, p] = raw;
  switch (tag) {
    case 'FT_INGREDIENT':
      return {
        kind: 'ft',
        quantity: String(p.quantity ?? ''),
        effect: decodeEffect(p.effect as [string, Record<string, unknown>] | undefined),
      };
    case 'TEMPLATE_INGREDIENT':
      return {
        kind: 'template',
        template_id: Number(p.template_id ?? 0),
        collection_name: String(p.collection_name ?? ''),
        amount: Number(p.amount ?? 1),
        effect: decodeEffect(p.effect as [string, Record<string, unknown>] | undefined),
      };
    case 'SCHEMA_INGREDIENT':
      return {
        kind: 'schema',
        collection_name: String(p.collection_name ?? ''),
        schema_name: String(p.schema_name ?? ''),
        amount: Number(p.amount ?? 1),
        effect: decodeEffect(p.effect as [string, Record<string, unknown>] | undefined),
      };
    case 'COLLECTION_INGREDIENT':
      return {
        kind: 'collection',
        collection_name: String(p.collection_name ?? ''),
        amount: Number(p.amount ?? 1),
        effect: decodeEffect(p.effect as [string, Record<string, unknown>] | undefined),
      };
    case 'BALANCE_INGREDIENT':
      return {
        kind: 'balance',
        schema_name: String(p.schema_name ?? ''),
        template_id: Number(p.template_id ?? 0),
        attribute_name: String(p.attribute_name ?? ''),
        cost: Number(p.cost ?? 0),
      };
    case 'ATTRIBUTE_INGREDIENT':
      return {
        kind: 'attribute',
        collection_name: String(p.collection_name ?? ''),
        schema_name: String(p.schema_name ?? ''),
        amount: Number(p.amount ?? 1),
        effect: decodeEffect(p.effect as [string, Record<string, unknown>] | undefined),
      };
    case 'TYPED_ATTRIBUTE_INGREDIENT':
      return {
        kind: 'typed_attribute',
        collection_name: String(p.collection_name ?? ''),
        schema_name: String(p.schema_name ?? ''),
        amount: Number(p.amount ?? 1),
        effect: decodeEffect(p.effect as [string, Record<string, unknown>] | undefined),
      };
    default:
      return { kind: 'unknown', raw };
  }
}

function decodeRequirement(raw: [string, Record<string, unknown>]): UpgradeRequirement {
  const [tag, p] = raw;
  if (tag === 'TEMPLATE_REQUIREMENT') {
    return { kind: 'template', template_id: Number(p.template_id ?? 0) };
  }
  if (tag === 'TEMPLATES_REQUIREMENT') {
    return {
      kind: 'templates',
      template_ids: ((p.template_ids ?? []) as unknown[]).map((n) => Number(n)),
    };
  }
  return { kind: 'attribute', raw: p };
}

function decodeResult(r: RawUpgradeRow['upgrade_specs'][number]['upgrade_results'][number]): UpgradeResult {
  const wrap = r.value;
  let immediate: string | number | undefined;
  let isRandom = false;
  if (Array.isArray(wrap) && wrap[0] === 'IMMEDIATE_VALUE' && Array.isArray(wrap[1])) {
    const inner = wrap[1] as [string, unknown];
    const v = inner[1];
    if (typeof v === 'string' || typeof v === 'number') immediate = v;
  } else {
    // Any non-IMMEDIATE wrapper means the result is decided at execution
    // time by an oracle / RNG.
    isRandom = true;
  }
  return {
    attribute_name: r.attribute_name,
    attribute_type: r.attribute_type,
    op_type: Number(r.op?.type ?? 0),
    immediate_value: immediate,
    is_random: isRandom,
  };
}

function toDiscovered(r: RawUpgradeRow): DiscoveredUpgrade | undefined {
  if (r.upgrade_id === undefined || r.upgrade_id === null) return undefined;
  const dd = parseDisplayData(r.display_data);
  const id = String(r.upgrade_id);
  const ingredients = (r.ingredients ?? []).map(decodeIngredient);
  const specs = (r.upgrade_specs ?? []).map((s) => ({
    schema_name: s.schema_name,
    requirements: (s.upgrade_requirements ?? []).map(decodeRequirement),
    results: (s.upgrade_results ?? []).map(decodeResult),
    display_data: s.display_data ?? '',
  }));
  const acceptedTemplateIds: number[] = [];
  for (const s of specs) {
    for (const req of s.requirements) {
      if (req.kind === 'template') acceptedTemplateIds.push(req.template_id);
      else if (req.kind === 'templates') acceptedTemplateIds.push(...req.template_ids);
    }
  }
  const is_random = specs.some((s) => s.results.some((res) => res.is_random));
  const security_id = r.security_id !== undefined ? String(r.security_id) : '0';
  return {
    upgrade_id: id,
    collection_name: r.collection_name,
    name: dd.name || `Upgrade #${id}`,
    description: dd.description,
    image: typeof dd.image === 'string' && dd.image.trim() ? dd.image.trim() : undefined,
    status: computeStatus(r),
    is_random,
    whitelist_required: security_id !== '0',
    ingredients,
    specs,
    max: Number(r.max ?? 0),
    use_count: Number(r.use_count ?? 0),
    start_time: Number(r.start_time ?? 0),
    end_time: Number(r.end_time ?? 0),
    acceptedTemplateIds,
  };
}

/**
 * Loads a single upgrade by id, for the manual entry path. Single
 * table lookup, no scan.
 */
export async function loadUpgradeById(upgrade_id: string | number): Promise<DiscoveredUpgrade | undefined> {
  const id = String(upgrade_id);
  const rows = await getTableRows<RawUpgradeRow>({
    code: 'up.nefty',
    scope: 'up.nefty',
    table: 'upgrades',
    lower_bound: id,
    upper_bound: id,
    limit: 1,
  });
  if (rows.length === 0) return undefined;
  return toDiscovered(rows[0]);
}

export function clearUpgradesCache() {
  cache.clear();
}
