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
  | ['POOL_NFT_RESULT', { pool_id: number }]
  | ['ON_DEMAND_NFT_RESULT', OnDemandNftResult]
  | ['FT_RESULT', { quantity: string }];
export interface OnDemandNftResult {
  template_id: number;
  payload?: unknown;
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
 * A blend's `nosecfuse` action is only safe to call when the result is fully
 * deterministic: every roll has a single outcome whose odds equal total_odds.
 * Anything else means the contract would draw a random result from a pool,
 * which requires the secfuse / RNG flow we do NOT support.
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
        reason: `Roll #${i} has ${r.outcomes.length} possible outcomes (random blend, uses secfuse, not supported here).`,
      };
    }
    if (r.outcomes[0].odds !== r.total_odds) {
      return {
        ok: false,
        reason: `Roll #${i}: odds=${r.outcomes[0].odds} != total_odds=${r.total_odds} (outcome not guaranteed).`,
      };
    }
    // Reject pool draws, by definition non-deterministic for the claimer
    for (const res of r.outcomes[0].results) {
      if (res[0] === 'POOL_NFT_RESULT') {
        return {
          ok: false,
          reason: `Roll #${i} draws from a POOL_NFT, random outcome, not supported.`,
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
