/**
 * Single-blend reader for blend.nefty.
 *
 * Exposes:
 *   - loadBlend({blend_id})        - read one row from the global `blends` table
 *   - isDeterministic(row)         - predicate: can this be claimed with `nosecfuse`?
 *   - deterministicResults(row)    - list the ON_DEMAND_NFT mints the row produces
 *   - all the typed shapes (BlendRow, IngredientVariant, ResultVariant, ...)
 *
 * The `blends` table is scoped by `blend.nefty` (the contract itself), NOT
 * by collection. Each row carries its own `collection_name` field.
 */
import { getTableRows } from '../chain/rpc';

/**
 * A blend row stored at scope = collection_name, table 'blends', in the
 * blend.nefty contract. Ingredients and rolls are inlined as variants.
 *
 * Source of truth: the live ABI fetched in src/nefty/abi.ts.
 */
export interface BlendRow {
  blend_id: string | number;
  collection_name: string;
  start_time: number;
  end_time: number;
  ingredients: IngredientVariant[];
  rolls: Roll[];
  max: number;
  use_count: number;
  display_data: string;
  security_id?: string | number;
  is_hidden?: boolean;
  category?: string;
}

/**
 * The contract returns each ingredient as a [variant_name, payload] tuple
 * (EOSIO native variant encoding in JSON).
 */
export type IngredientVariant =
  | ['TEMPLATE_INGREDIENT', TemplateIngredient]
  | ['ATTRIBUTE_INGREDIENT', AttributeIngredient]
  | ['SCHEMA_INGREDIENT', SchemaIngredient]
  | ['COLLECTION_INGREDIENT', CollectionIngredient]
  | ['CHEST_INGREDIENT', ChestIngredient]
  | ['BALANCE_INGREDIENT', ChestIngredient]
  | ['FT_INGREDIENT', FtIngredient]
  | ['COOLDOWN_INGREDIENT', unknown];

export interface TemplateIngredient {
  template_id: number;
  collection_name: string;
  amount: number;
  effect: unknown;
}
export interface AttributeIngredient {
  collection_name: string;
  schema_name: string;
  display_data: string;
  attributes: { attribute_name: string; allowed_values: string[] }[];
  amount: number;
  effect: unknown;
}
export interface SchemaIngredient {
  collection_name: string;
  schema_name: string;
  display_data: string;
  amount: number;
  effect: unknown;
}
export interface CollectionIngredient {
  collection_name: string;
  amount: number;
  effect: unknown;
}
export interface ChestIngredient {
  schema_name: string;
  template_id: number;
  attribute_name: string;
  cost: string | number;
  display_data: string;
}
export interface FtIngredient {
  quantity: string;
  effect: unknown;
}

export interface Roll {
  outcomes: Outcome[];
  total_odds: number;
}
export interface Outcome {
  odds: number;
  results: ResultVariant[];
}
export type ResultVariant =
  | ['POOL_NFT_RESULT', PoolNftResult]
  | ['ON_DEMAND_NFT_RESULT', OnDemandNftResult]
  | ['FT_RESULT', { quantity: string }];
export interface OnDemandNftResult {
  template_id: number;
  payload?: unknown;
}
/**
 * A reward drawn from a pre-filled pool rather than minted on demand. The
 * live ABI declares `{ pool_name: name, display_data: string }` -- there is
 * no `pool_id` on the result, the pool is addressed by name within the
 * blend's own collection scope (see src/nefty/pools.ts).
 *
 * `display_data` is the author-supplied JSON blob describing what the pool
 * hands out ({"name": ..., "image": ...}), which is what the UI shows since
 * no template_id is available here.
 */
export interface PoolNftResult {
  pool_name: string;
  display_data?: string;
}

export async function loadBlend(args: {
  blend_id: string | number;
}): Promise<BlendRow> {
  // The `blends` table lives in scope=blend.nefty (global), NOT per-collection.
  // The collection name is a field inside each row.
  const rows = await getTableRows<BlendRow>({
    code: 'blend.nefty',
    scope: 'blend.nefty',
    table: 'blends',
    lower_bound: String(args.blend_id),
    upper_bound: String(args.blend_id),
    limit: 1,
  });
  if (rows.length === 0) {
    throw new Error(
      `Blend ${args.blend_id} not found in the blend.nefty contract. ` +
        `Double-check the ID (visible on AtomicHub or waxblock.io).`,
    );
  }
  return rows[0];
}

/**
 * "Can this blend be settled in ONE transaction, with the exact output
 * known before signing?"
 *
 * That holds only when every roll has a single outcome whose odds equal
 * total_odds AND that outcome mints on demand from a template. Anything
 * else - several outcomes per roll, or a draw from a pool - means the
 * contract decides something at execution time and stages the answer in
 * `claimassets`, so it needs the two-step fuse -> wait -> claim flow
 * (src/nefty/rngExecute.ts).
 *
 * `ok: false` is NOT "unsupported": it only selects which flow the UI runs.
 */
export function isDeterministic(blend: BlendRow): {
  ok: boolean;
  reason?: string;
} {
  if (!blend.rolls || blend.rolls.length === 0) {
    return { ok: true };
  }
  for (let i = 0; i < blend.rolls.length; i++) {
    const r = blend.rolls[i];
    if (r.outcomes.length !== 1) {
      return {
        ok: false,
        reason: `Roll #${i} has ${r.outcomes.length} possible outcomes (the oracle picks one at fuse time).`,
      };
    }
    if (r.outcomes[0].odds !== r.total_odds) {
      return {
        ok: false,
        reason: `Roll #${i}: odds=${r.outcomes[0].odds} != total_odds=${r.total_odds} (outcome not guaranteed).`,
      };
    }
    // A pool draw keeps the odds at 100% but the contract still picks WHICH
    // escrowed asset you get, so the exact asset_id only exists after the
    // claim row is staged -> two-step flow.
    for (const res of r.outcomes[0].results) {
      if (res[0] === 'POOL_NFT_RESULT') {
        return {
          ok: false,
          reason: `Roll #${i} draws a pre-minted NFT from pool "${res[1].pool_name}" (the contract picks which asset at fuse time).`,
        };
      }
    }
  }
  return { ok: true };
}

/**
 * Extracts the on-demand mint templates that will be produced. Only meaningful
 * once isDeterministic() returned ok.
 */
export function deterministicResults(blend: BlendRow): OnDemandNftResult[] {
  const out: OnDemandNftResult[] = [];
  for (const roll of blend.rolls ?? []) {
    for (const result of roll.outcomes[0]?.results ?? []) {
      if (result[0] === 'ON_DEMAND_NFT_RESULT') out.push(result[1]);
    }
  }
  return out;
}

/** One pool draw declared by a blend, tagged with the roll it belongs to. */
export interface PoolDraw extends PoolNftResult {
  roll_index: number;
}

/**
 * Every POOL_NFT_RESULT the blend declares, across all rolls and outcomes.
 * Used to fetch pool stock and to preview the reward, since pool results
 * carry no template_id.
 */
export function poolDraws(blend: BlendRow): PoolDraw[] {
  const out: PoolDraw[] = [];
  const rolls = blend.rolls ?? [];
  for (let i = 0; i < rolls.length; i++) {
    for (const outcome of rolls[i].outcomes ?? []) {
      for (const result of outcome.results ?? []) {
        if (result[0] === 'POOL_NFT_RESULT') {
          out.push({ roll_index: i, ...result[1] });
        }
      }
    }
  }
  return out;
}

/**
 * True when the odds themselves leave nothing to chance: every roll has a
 * single outcome carrying the full odds. A pool blend can satisfy this and
 * still be non-deterministic per `isDeterministic()` -- the reward IS
 * guaranteed, only the specific escrowed asset_id is drawn. The UI uses
 * this to avoid labelling a 100%-certain craft as a lottery.
 */
export function oddsAreCertain(blend: BlendRow): boolean {
  for (const roll of blend.rolls ?? []) {
    if ((roll.outcomes ?? []).length !== 1) return false;
    if (roll.outcomes[0].odds !== roll.total_odds) return false;
  }
  return true;
}

/**
 * Parses a pool result's author-supplied `display_data` JSON blob. Returns
 * an empty object for malformed or absent data rather than throwing -- it is
 * cosmetic metadata, never something to fail a blend over.
 */
export function parsePoolDisplayData(
  raw: string | undefined,
): { name?: string; image?: string } {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const o = parsed as Record<string, unknown>;
    return {
      name: typeof o.name === 'string' ? o.name : undefined,
      image: typeof o.image === 'string' ? o.image : undefined,
    };
  } catch {
    return {};
  }
}
