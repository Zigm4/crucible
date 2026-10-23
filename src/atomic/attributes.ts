/**
 * Attribute rules, read the way the contracts read them.
 *
 * up.nefty and waxdaomarket both let a recipe ask for NFTs by what their
 * attributes say rather than by template: "a spaceship named 8L-U8 at
 * level 1", "a TV whose power is on". About a fifth of open upgrades ask
 * that way, for the NFT to upgrade or for the one to burn, and so do 62
 * WaxDAO blends. What follows was settled against the chain, by running
 * real assets through compute_transaction (executed, never signed, never
 * written) and comparing with what this file predicts:
 *
 *   - The value is the asset's MUTABLE data first, then its own immutable
 *     data, then its template's. On up.nefty upgrade 170, asset
 *     1099947641493 says level "1" in its template and "2" in its mutable
 *     data, and the rule "2" accepts it. The AtomicAssets API's merged
 *     `data` lets the template win and calls that a refusal, so it is not
 *     what is read here. A value only in the template counts (upgrade 376,
 *     WaxDAO 1652), and so does one only in the asset's immutable data
 *     (WaxDAO 1589).
 *   - An attribute the NFT does not have fails the rule, on both contracts
 *     ("doesn't match a typed_attribute_requirement", "One of the required
 *     attributes was not found on this NFT").
 *   - Values compare exactly: text as text, numbers as numbers.
 *
 * Only the forms in use are judged. Every live up.nefty rule uses
 * comparator 0 (is one of), and every live WaxDAO rule is "exact". Any
 * other form answers `undefined`: this page cannot tell, and says so,
 * rather than guess and build a transaction the contract refuses.
 */
import type { AtomicAsset } from './assets';

/** The value a contract reads for one attribute, or undefined when the NFT has none. */
export function attributeOf(a: AtomicAsset, name: string): unknown {
  return a.mutable_data?.[name] ?? a.immutable_data?.[name] ?? a.template?.immutable_data?.[name];
}

/** up.nefty's TYPED_ATTRIBUTE_DEFINITION, decoded from the row. */
export interface TypedAttributeRule {
  attribute_name: string;
  attribute_type: string;
  /** The vector's tag: STRING_VEC, UINT64_VEC, DOUBLE_VEC, UINT8_VEC... */
  vector: string;
  allowed: (string | number)[];
  /** 0 is "is one of", the only one in use. */
  comparator: number;
}

/** blend.nefty's and up.nefty's untyped ATTRIBUTE_DEFINITION. */
export interface AttributeList {
  attribute_name: string;
  allowed_values: string[];
}

/** waxdaomarket's REQUIRED_ATTRIBUTE. */
export interface WaxdaoAttributeRule {
  type: string;
  name: string;
  value: string;
  criteria: string;
}

/** The forms this page can judge; see the header. */
export const canJudgeTypedRule = (r: TypedAttributeRule) => r.comparator === 0;
export const canJudgeWaxdaoRule = (r: WaxdaoAttributeRule) => r.criteria === 'exact' && ['string', 'image'].includes(r.type);

const INTEGER_VECTORS = new Set(['INT16_VEC', 'INT32_VEC', 'INT64_VEC', 'UINT16_VEC', 'UINT32_VEC', 'UINT64_VEC']);

/**
 * Decodes a TYPED_ATTRIBUTE_DEFINITION. The 8-bit vectors come as hex
 * bytes ("0001" is [0, 1]); a bool attribute is one of those.
 */
export function decodeTypedRule(def: Record<string, unknown>): TypedAttributeRule {
  const [vector, values] = (def.allowed_values ?? ['STRING_VEC', []]) as [string, unknown];
  let allowed: (string | number)[];
  if (vector === 'UINT8_VEC' || vector === 'INT8_VEC') {
    allowed = (String(values ?? '').match(/../g) ?? []).map((h) => {
      const n = parseInt(h, 16);
      return vector === 'INT8_VEC' && n > 127 ? n - 256 : n;
    });
  } else {
    allowed = Array.isArray(values) ? values.map((v) => (typeof v === 'number' ? v : String(v))) : [];
  }
  return {
    attribute_name: String(def.attribute_name ?? ''),
    attribute_type: String(def.attribute_type ?? ''),
    vector,
    allowed,
    comparator: Number(def.comparator ?? 0),
  };
}

function sameValue(v: unknown, x: string | number, vector: string): boolean {
  if (vector === 'STRING_VEC') return String(v) === String(x);
  const n = v === true ? 1 : v === false ? 0 : v;
  // uint64 can pass 2^53, and the API sends it as text for that reason.
  if (INTEGER_VECTORS.has(vector)) {
    try { return BigInt(String(n)) === BigInt(String(x)); } catch { return false; }
  }
  // float32 values are stored rounded to 32 bits on both sides.
  if (vector === 'FLOAT_VEC') return Math.fround(Number(n)) === Math.fround(Number(x));
  return Number(n) === Number(x);
}

/** Whether an NFT passes one up.nefty typed rule; undefined for a comparator this page does not know. */
export function passesTypedRule(a: AtomicAsset, rule: TypedAttributeRule): boolean | undefined {
  if (!canJudgeTypedRule(rule)) return undefined;
  const v = attributeOf(a, rule.attribute_name);
  if (v === undefined || v === null) return false;
  return rule.allowed.some((x) => sameValue(v, x, rule.vector));
}

/** Whether an NFT passes an untyped list: every attribute, as text, is one of its allowed values. */
export function passesAttributeList(a: AtomicAsset, list: AttributeList[]): boolean {
  return list.every(({ attribute_name, allowed_values }) => {
    const v = attributeOf(a, attribute_name);
    return v !== undefined && v !== null && allowed_values.includes(String(v));
  });
}

/** Whether an NFT passes one WaxDAO rule; undefined for a criteria other than "exact" on text. */
export function passesWaxdaoRule(a: AtomicAsset, rule: WaxdaoAttributeRule): boolean | undefined {
  if (!canJudgeWaxdaoRule(rule)) return undefined;
  const v = attributeOf(a, rule.name);
  return v !== undefined && v !== null && String(v) === rule.value;
}

/** All of several rules: false as soon as one fails, undefined when none fails but one cannot be told. */
export function passesAll(results: (boolean | undefined)[]): boolean | undefined {
  if (results.includes(false)) return false;
  return results.includes(undefined) ? undefined : true;
}

// ─── in words ──────────────────────────────────────────────────────────

/** An IPFS hash is fifty characters nobody reads. The start is enough to tell two apart. */
const shortValue = (v: string | number) => {
  const s = String(v);
  return /^(Qm|bafy)/.test(s) && s.length > 20 ? `${s.slice(0, 10)}…` : s;
};

function oneOf(values: (string | number)[]): string {
  const shown = values.slice(0, 4).map((v) => `"${shortValue(v)}"`);
  if (values.length > 4) return `one of ${shown.join(', ')} and ${values.length - 4} more`;
  return shown.length > 1 ? `one of ${shown.join(', ')}` : shown[0] ?? 'nothing';
}

export function describeTypedRule(r: TypedAttributeRule): string {
  if (!canJudgeTypedRule(r)) return `${r.attribute_name} passes a test this page cannot read`;
  return `${r.attribute_name} is ${oneOf(r.allowed)}`;
}

export function describeAttributeList(list: AttributeList[]): string {
  return list.map((x) => `${x.attribute_name} is ${oneOf(x.allowed_values)}`).join(' and ');
}

export function describeWaxdaoRule(r: WaxdaoAttributeRule): string {
  if (!canJudgeWaxdaoRule(r)) return `${r.name} passes a "${r.criteria}" test this page cannot read`;
  return `${r.name} is "${shortValue(r.value)}"`;
}
