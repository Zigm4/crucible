/**
 * WaxDAO blend discovery against the `waxdaomarket` contract.
 *
 * WaxDAO is a parallel ecosystem to NeftyBlocks on WAX. Its blends are
 * registered on a different contract (`waxdaomarket`), use a different
 * action set (`assertblend` instead of `nosecfuse`/`fuse`), and
 * deposit each NFT ingredient through its OWN `atomicassets::transfer`
 * with a slot-indexed memo:
 *
 *     |blend_deposit|<blend_ID>|<slot>|
 *
 * where `<slot>` is the 1-based index of the NFT in the recipe's
 * `blend_ingredients` array (slot 0 is reserved for the FT cost when
 * present).
 *
 * The WaxDAO website itself is shut down at the time of writing, but
 * the contract is still live and Crucible can drive it directly, the
 * same way it drives blend.nefty / atomicpacksx / up.nefty.
 */

import { getTableRows } from '../chain/rpc';

const CHAIN_CHUNK_SIZE = 250n;
const CHAIN_ROWS_PER_CALL = 250;
const CHAIN_MAX_CHUNKS = 16;

// ── shaped types ────────────────────────────────────────────────────── //

export type WaxdaoBlendStatus = 'active' | 'upcoming' | 'ended' | 'sold_out';

/**
 * One ingredient slot in a WaxDAO recipe. WaxDAO uses ONE flat struct
 * for both FT and NFT ingredients, distinguished by `ingredient_type`.
 * We surface only the kinds Crucible's UI needs.
 */
export type WaxdaoIngredient =
  | {
      kind: 'fungible';
      /** Asset-formatted quantity, e.g. "10.00000000 UPMAX". */
      quantity: string;
      /** Issuing contract for the token, e.g. "underpunks55". */
      contract: string;
    }
  | {
      kind: 'nft_template';
      collection_name: string;
      schema_name: string;
      template_id: number;
      amount: number;
      burn: boolean;
    }
  | {
      kind: 'nft_schema';
      collection_name: string;
      schema_name: string;
      amount: number;
      burn: boolean;
    }
  | {
      kind: 'nft_collection';
      collection_name: string;
      amount: number;
      burn: boolean;
    }
  | {
      kind: 'nft_attribute';
      collection_name: string;
      schema_name: string;
      amount: number;
      burn: boolean;
      required_attributes: unknown[];
    }
  | { kind: 'unknown'; raw: unknown };

/** What the recipe mints when blended. Usually a single template. */
export interface WaxdaoResult {
  result_type: string;
  collection_name?: string;
  schema_name?: string;
  template_id?: number;
  nft_name?: string;
  nft_image?: string;
  amount: number;
}

export interface DiscoveredWaxdaoBlend {
  blend_id: string;
  creator: string;
  title: string;
  description?: string;
  cover_image?: string;
  status: WaxdaoBlendStatus;
  start_time: number;
  end_time: number;
  max_blends: number;
  blends_remaining: number;
  limit_per_user: number;
  cooldown_reset: number;
  ingredients: WaxdaoIngredient[];
  results: WaxdaoResult[];
  payment_receivers: { account: string; percentage: number }[];
  /**
   * Set of all NFT ingredient slots that need a separate
   * atomicassets::transfer. Each slot is the 1-based index of the
   * ingredient in `blend_ingredients` (slot 0 is the FT cost, when
   * present). Pre-computed here so the action builder is a thin
   * mapping.
   */
  nftSlots: { slot: number; ingredient: WaxdaoIngredient }[];
  /** True when the recipe has a fungible-token cost. */
  hasFtCost: boolean;
}

// ── raw on-chain shape ──────────────────────────────────────────────── //

interface RawIngredient {
  ingredient_type: string;
  filter_by: string;
  burn_non_fungible: number | boolean;
  fungible_token_symbol: string;
  fungible_token_contract: string;
  fungible_token_amount: string | number;
  collection_name: string;
  schema_name: string;
  template_id: number;
  non_fungible_quantity: number;
  required_attributes: unknown[];
}

interface RawResult {
  result_type: string;
  preminted_pool_id: number[];
  collection_name: string;
  schema_name: string;
  template_id: number;
  nft_name: string;
  nft_image: string;
  fungible_token_symbol: string;
  fungible_token_contract: string;
  fungible_token_amount: string | number;
  non_fungible_quantity: number;
}

interface RawBlend {
  ID: number | string;
  creator: string;
  start_time: number | string;
  end_time: number | string;
  max_blends: number | string;
  blends_remaining: number | string;
  whitelist_type: string;
  blend_title: string;
  blend_description: string;
  cover_image: string;
  blend_ingredients: RawIngredient[];
  blend_results: RawResult[];
  payment_receivers: { payment_receiver: string; payment_percentage: string | number }[];
  limit_per_user: number | string;
  cooldown_reset: number | string;
}

// ── public entrypoint ──────────────────────────────────────────────── //

export interface ListWaxdaoBlendsOpts {
  collection: string;
  includeInactive?: boolean;
  onProgress?: (message: string, pct: number) => void;
}

const cache = new Map<string, { at: number; data: DiscoveredWaxdaoBlend[] }>();
const TTL_MS = 5 * 60_000;

/**
 * Lists every active waxdaomarket blend whose creator is `collection`.
 * Sorted: active first, then alphabetical by title within each bucket.
 */
export async function listWaxdaoBlends(
  opts: ListWaxdaoBlendsOpts,
): Promise<{ blends: DiscoveredWaxdaoBlend[] }> {
  const cacheKey = `${opts.collection}::${opts.includeInactive ? 'all' : 'active'}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) return { blends: hit.data };

  opts.onProgress?.('Probing waxdaomarket...', 0);

  const tail = await getTableRows<{ ID: number | string }>({
    code: 'waxdaomarket',
    scope: 'waxdaomarket',
    table: 'blends',
    limit: 1,
    reverse: true,
  });
  const head = tail.length ? BigInt(String(tail[0].ID ?? 0)) + 1n : 0n;
  const headId = head > 100n ? head : 3_000n;

  const ranges: { from: bigint; to: bigint }[] = [];
  for (let from = 0n; from < headId && ranges.length < CHAIN_MAX_CHUNKS; from += CHAIN_CHUNK_SIZE) {
    ranges.push({ from, to: from + CHAIN_CHUNK_SIZE });
  }

  let done = 0;
  const matched: RawBlend[] = [];
  await Promise.all(
    ranges.map(async (r) => {
      const rows = await scanRange(r.from, r.to);
      done += 1;
      opts.onProgress?.(
        `Scanning waxdaomarket... chunk ${done}/${ranges.length}`,
        done / ranges.length,
      );
      for (const row of rows) {
        if (row.creator === opts.collection) matched.push(row);
      }
    }),
  );

  let shaped = matched.map(toDiscovered);
  if (!opts.includeInactive) {
    shaped = shaped.filter((b) => b.status === 'active');
  }
  shaped.sort((a, b) => {
    const p = statusPriority(a.status) - statusPriority(b.status);
    if (p !== 0) return p;
    const byTitle = a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
    if (byTitle !== 0) return byTitle;
    return Number(b.blend_id) - Number(a.blend_id);
  });

  cache.set(cacheKey, { at: Date.now(), data: shaped });
  return { blends: shaped };
}

async function scanRange(from: bigint, to: bigint): Promise<RawBlend[]> {
  const rows: RawBlend[] = [];
  let cursor = from;
  while (cursor < to) {
    const batch = await getTableRows<RawBlend>({
      code: 'waxdaomarket',
      scope: 'waxdaomarket',
      table: 'blends',
      lower_bound: String(cursor),
      upper_bound: String(to),
      limit: CHAIN_ROWS_PER_CALL,
    });
    if (batch.length === 0) break;
    rows.push(...batch);
    const last = BigInt(String(batch[batch.length - 1].ID ?? cursor));
    if (last + 1n <= cursor) break;
    cursor = last + 1n;
    if (batch.length < CHAIN_ROWS_PER_CALL) break;
  }
  return rows;
}

function statusPriority(s: WaxdaoBlendStatus): number {
  switch (s) {
    case 'active':   return 0;
    case 'upcoming': return 1;
    case 'sold_out': return 2;
    case 'ended':    return 3;
  }
}

function computeStatus(r: RawBlend): WaxdaoBlendStatus {
  const max = Number(r.max_blends ?? 0);
  const remaining = Number(r.blends_remaining ?? 0);
  // WaxDAO's `max_blends = 0` means unlimited; otherwise blends_remaining
  // reaching zero means sold-out.
  if (max > 0 && remaining === 0) return 'sold_out';
  const now = Date.now() / 1000;
  const start = Number(r.start_time ?? 0);
  const end = Number(r.end_time ?? 0);
  if (start > 0 && start > now) return 'upcoming';
  // WaxDAO often stores "no end" as a huge timestamp (year 2124, etc.)
  // so we only treat it as "ended" when end is positive AND in the past
  // AND below 10^11 (defensive ceiling for sane year).
  if (end > 0 && end < now && end < 1e11) return 'ended';
  return 'active';
}

function decodeBurn(v: number | boolean): boolean {
  if (typeof v === 'boolean') return v;
  return v !== 0;
}

function decodeIngredient(ing: RawIngredient): WaxdaoIngredient {
  if (ing.ingredient_type === 'fungible') {
    const amount = Number(ing.fungible_token_amount);
    const sym = ing.fungible_token_symbol; // "8,UPMAX"
    const [precStr, ticker] = sym.split(',');
    const precision = Number(precStr) || 0;
    const quantity = `${amount.toFixed(precision)} ${ticker}`;
    return {
      kind: 'fungible',
      quantity,
      contract: ing.fungible_token_contract,
    };
  }
  if (ing.ingredient_type !== 'nonfungible') {
    return { kind: 'unknown', raw: ing };
  }
  const filter = ing.filter_by;
  const amount = ing.non_fungible_quantity || 1;
  const burn = decodeBurn(ing.burn_non_fungible);
  if (filter === 'template') {
    return {
      kind: 'nft_template',
      collection_name: ing.collection_name,
      schema_name: ing.schema_name,
      template_id: ing.template_id,
      amount,
      burn,
    };
  }
  if (filter === 'schema') {
    return {
      kind: 'nft_schema',
      collection_name: ing.collection_name,
      schema_name: ing.schema_name,
      amount,
      burn,
    };
  }
  if (filter === 'collection') {
    return {
      kind: 'nft_collection',
      collection_name: ing.collection_name,
      amount,
      burn,
    };
  }
  if (filter === 'attributes' || filter === 'attribute') {
    return {
      kind: 'nft_attribute',
      collection_name: ing.collection_name,
      schema_name: ing.schema_name,
      amount,
      burn,
      required_attributes: ing.required_attributes ?? [],
    };
  }
  return { kind: 'unknown', raw: ing };
}

function decodeResult(r: RawResult): WaxdaoResult {
  return {
    result_type: r.result_type,
    collection_name: r.collection_name || undefined,
    schema_name: r.schema_name || undefined,
    template_id: r.template_id || undefined,
    nft_name: r.nft_name || undefined,
    nft_image: r.nft_image || undefined,
    amount: r.non_fungible_quantity || 1,
  };
}

function toDiscovered(r: RawBlend): DiscoveredWaxdaoBlend {
  const ingredients = (r.blend_ingredients ?? []).map(decodeIngredient);

  // Slot indices: WaxDAO numbers slots from 0, where slot 0 is the FT
  // ingredient when present, then 1..N for each NFT ingredient in
  // order. We mirror that here so the action builder can produce
  // memos byte-identical to the chain trace.
  const hasFtCost = ingredients.some((i) => i.kind === 'fungible');
  const nftSlots: { slot: number; ingredient: WaxdaoIngredient }[] = [];
  let nftSlotCursor = hasFtCost ? 1 : 0;
  for (const ing of ingredients) {
    if (ing.kind === 'fungible') continue;
    nftSlots.push({ slot: nftSlotCursor, ingredient: ing });
    nftSlotCursor += 1;
  }

  return {
    blend_id: String(r.ID),
    creator: r.creator,
    title: r.blend_title || `Blend #${r.ID}`,
    description: r.blend_description || undefined,
    cover_image: r.cover_image || undefined,
    status: computeStatus(r),
    start_time: Number(r.start_time ?? 0),
    end_time: Number(r.end_time ?? 0),
    max_blends: Number(r.max_blends ?? 0),
    blends_remaining: Number(r.blends_remaining ?? 0),
    limit_per_user: Number(r.limit_per_user ?? 0),
    cooldown_reset: Number(r.cooldown_reset ?? 0),
    ingredients,
    results: (r.blend_results ?? []).map(decodeResult),
    payment_receivers: (r.payment_receivers ?? []).map((p) => ({
      account: p.payment_receiver,
      percentage: Number(p.payment_percentage),
    })),
    nftSlots,
    hasFtCost,
  };
}

export async function loadWaxdaoBlendById(
  blend_id: string | number,
): Promise<DiscoveredWaxdaoBlend | undefined> {
  const id = String(blend_id);
  const rows = await getTableRows<RawBlend>({
    code: 'waxdaomarket',
    scope: 'waxdaomarket',
    table: 'blends',
    lower_bound: id,
    upper_bound: id,
    limit: 1,
  });
  if (rows.length === 0) return undefined;
  return toDiscovered(rows[0]);
}

export function clearWaxdaoBlendsCache() {
  cache.clear();
}
