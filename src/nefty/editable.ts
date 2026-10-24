/**
 * What Change shows of a recipe, read from the recipe's own row.
 * ─────────────────────────────────────────────────────────────
 * The editor used to start from the lists the pickers read, which carry a
 * name and a status and little else. Every field it did not know started
 * empty, and an empty field is what got signed:
 *   - "Hidden" started unticked, so a hidden recipe could not be revealed
 *   - a blend's description and image were not known, so renaming it
 *     signed a display_data holding only the name, and erased the rest
 *   - a blend's end date and cooldown were not known, so changing its
 *     start date or its per-wallet limit set them to 0
 * Here every field comes from the contract's own table, and display_data
 * is kept whole: only what the author touches is replaced in it, so keys
 * no editor shows (video, animation, ...) survive a rename.
 *
 * Ingredients are offered for editing only when they can be written back
 * exactly as they are (decodeIngredients): the mix actions replace the
 * whole list, so an ingredient the editor cannot represent would be
 * changed by saving anything at all.
 */
import { getTableRows } from '../chain/rpc';
import { encodeIngredient, type NewIngredient } from './createBlend';
import { readBlendLimits } from './blendLimits';

export type EditableKind = 'blend' | 'upgrade' | 'drop';

export interface EditableRecipe {
  kind: EditableKind;
  id: string;
  collection: string;
  hidden: boolean;
  /** Unix seconds, 0 for no bound. */
  startTime: number;
  endTime: number;
  /** Total uses, or a drop's supply, 0 for unlimited. */
  max: number;
  accountLimit: number;
  cooldown: number;
  /** display_data as the contract holds it, parsed; {} when it is not JSON. */
  display: Record<string, unknown>;
  category: string;
  /** '' for no gate. */
  securityId: string;
  /** Drops. */
  authRequired: boolean;
  listingPrice: string;
  /** Blends and upgrades: the ingredient variants as the contract holds them. */
  ingredients: unknown[];
  /** Drops: how many NFTs one claim mints (pool draws excluded), for its RAM. */
  mintsPerClaim: number;
}

function parseDisplay(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  try {
    const v = JSON.parse(String(raw ?? '') || '{}');
    return v && typeof v === 'object' ? v as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

const gate = (v: unknown) => (v && String(v) !== '0' ? String(v) : '');

/** The whole recipe, or undefined when no row has this id. */
export async function readEditable(kind: EditableKind, id: string): Promise<EditableRecipe | undefined> {
  const code = kind === 'blend' ? 'blend.nefty' : kind === 'upgrade' ? 'up.nefty' : 'neftyblocksd';
  const table = kind === 'blend' ? 'blends' : kind === 'upgrade' ? 'upgrades' : 'drops';
  const rows = await getTableRows<Record<string, unknown>>({
    code, scope: code, table, lower_bound: id, upper_bound: id, limit: 1,
  });
  const r = rows[0];
  if (!r) return undefined;
  const base = {
    kind, id, collection: String(r.collection_name ?? ''),
    hidden: Boolean(Number(r.is_hidden ?? 0)),
    startTime: Number(r.start_time ?? 0),
    endTime: Number(r.end_time ?? 0),
    display: parseDisplay(r.display_data),
    category: String(r.category ?? ''),
    securityId: gate(r.security_id),
    authRequired: false, listingPrice: '',
    ingredients: Array.isArray(r.ingredients) ? r.ingredients : [],
    mintsPerClaim: Array.isArray(r.assets_to_mint)
      ? (r.assets_to_mint as { use_pool?: boolean | number }[]).filter((a) => !Number(a.use_pool ?? 0)).length : 0,
  };
  if (kind === 'blend') {
    // A blend's per-wallet limit lives in its own table, one row per limited blend.
    const limit = (await readBlendLimits([id])).get(id);
    return { ...base, max: Number(r.max ?? 0), accountLimit: limit?.account_limit ?? 0, cooldown: limit?.account_limit_cooldown ?? 0 };
  }
  if (kind === 'upgrade') return { ...base, max: Number(r.max ?? 0), accountLimit: 0, cooldown: 0 };
  return {
    ...base,
    max: Number(r.max_claimable ?? 0),
    accountLimit: Number(r.account_limit ?? 0),
    cooldown: Number(r.account_limit_cooldown ?? 0),
    authRequired: Boolean(Number(r.auth_required ?? 0)),
    listingPrice: String(r.listing_price ?? ''),
    ingredients: [],
  };
}

/** The display text of a recipe. Only the three keys the editor shows change; every other key stays. */
export function displayText(display: Record<string, unknown>, key: 'name' | 'description' | 'image'): string {
  const v = display[key];
  return typeof v === 'string' ? v : '';
}

export function mergeDisplayData(
  display: Record<string, unknown>,
  edits: { name: string; description: string; image: string },
): string {
  const out: Record<string, unknown> = { ...display };
  for (const key of ['name', 'description', 'image'] as const) {
    const v = edits[key].trim();
    if (v) out[key] = v;
    else delete out[key];
  }
  return JSON.stringify(out);
}

// ─── ingredients ────────────────────────────────────────────────────────

type Variant = [string, Record<string, unknown>];

/** NFT effect: burn (TYPED_EFFECT type 0) or a transfer. Anything else has no place in the editor. */
function disposal(effect: unknown): { transfer_to?: string } | undefined {
  const [name, data] = (Array.isArray(effect) ? effect : []) as [string?, Record<string, unknown>?];
  if (name === 'TYPED_EFFECT' && Number(data?.type) === 0) return {};
  if (name === 'TRANSFER_EFFECT' && data?.to) return { transfer_to: String(data.to) };
  return undefined;
}

/** Deep equality on JSON shapes, without caring about key order. */
function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object), kb = Object.keys(b as object);
    return ka.length === kb.length && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return String(a) === String(b);
}

function decodeOne(v: unknown): NewIngredient | string {
  const [name, d] = (Array.isArray(v) ? v : []) as [string?, Record<string, unknown>?];
  if (!name || !d) return 'an ingredient this page cannot read';
  const amount = Number(d.amount ?? 0);
  const collection_name = String(d.collection_name ?? '');
  switch (name) {
    case 'TEMPLATE_INGREDIENT': {
      const how = disposal(d.effect);
      if (!how) return 'an NFT with an effect other than burning or sending it';
      return { kind: 'template', template_id: Number(d.template_id), collection_name, amount, ...how };
    }
    case 'SCHEMA_INGREDIENT': {
      const how = disposal(d.effect);
      if (!how) return 'an NFT with an effect other than burning or sending it';
      return { kind: 'schema', collection_name, schema_name: String(d.schema_name), amount, display_data: String(d.display_data ?? ''), ...how };
    }
    case 'ATTRIBUTE_INGREDIENT': {
      const how = disposal(d.effect);
      if (!how) return 'an NFT with an effect other than burning or sending it';
      const attributes = (Array.isArray(d.attributes) ? d.attributes : []).map((a) => ({
        attribute_name: String((a as Record<string, unknown>).attribute_name),
        allowed_values: ((a as Record<string, unknown>).allowed_values as unknown[] ?? []).map(String),
      }));
      return { kind: 'attribute', collection_name, schema_name: String(d.schema_name), amount, display_data: String(d.display_data ?? ''), attributes, ...how };
    }
    case 'COLLECTION_INGREDIENT': {
      const how = disposal(d.effect);
      if (!how) return 'an NFT with an effect other than burning or sending it';
      return { kind: 'collection', collection_name, amount, ...how };
    }
    case 'FT_INGREDIENT': {
      const [ename, edata] = (Array.isArray(d.effect) ? d.effect : []) as [string?, Record<string, unknown>?];
      if (ename !== 'TRANSFER_EFFECT' || !edata?.to) return 'a token cost that is not sent to an account';
      return { kind: 'ft', quantity: String(d.quantity), to: String(edata.to) };
    }
    case 'COOLDOWN_INGREDIENT': return 'a time gate (COOLDOWN_INGREDIENT)';
    case 'BALANCE_INGREDIENT': return 'an NFT that must hold a token balance (BALANCE_INGREDIENT)';
    default: return `a ${name}`;
  }
}

/**
 * The ingredients as the editor's own shape, or why they cannot be edited
 * here. Accepted only when encoding them again gives back exactly what the
 * contract holds, so saving without touching them would change nothing.
 */
export function decodeIngredients(raw: unknown[]): { ok: true; list: NewIngredient[] } | { ok: false; reason: string } {
  const list: NewIngredient[] = [];
  for (const v of raw) {
    const one = decodeOne(v);
    if (typeof one === 'string') return { ok: false, reason: `it uses ${one}` };
    if (!same(encodeIngredient(one) as Variant, v)) return { ok: false, reason: 'one of its ingredients would not be written back exactly as it is' };
    list.push(one);
  }
  return { ok: true, list };
}

/** Whether a new ingredient list differs from what the contract holds. */
export function ingredientsChanged(raw: unknown[], next: NewIngredient[]): boolean {
  return !same(raw, next.map(encodeIngredient));
}
