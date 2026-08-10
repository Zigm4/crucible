/**
 * Builds the `up.nefty::createupgrde` action (collection authors).
 *
 * The author-side counterpart to running an upgrade. An upgrade does
 * NOT mint anything: it rewrites attributes on an NFT the player
 * already owns, in place. So where a blend describes "burn these, mint
 * that", an upgrade describes "for NFTs matching this, set these
 * attributes to these values".
 *
 *   createupgrde(authorized_account, collection_name,
 *                ingredients[],     <- what the upgrade COSTS
 *                upgrade_specs[],   <- what it MUTATES
 *                start_time, end_time, max_uses, display_data,
 *                security_id, is_hidden, category)
 *
 * `ingredients` is the same 8-way variant family blends use, so the
 * cost side is shared with createBlend.ts rather than reimplemented -
 * one encoder, one text syntax, one set of tests. Note the contracts do
 * NOT accept the same subset: up.nefty has no CHEST/COOLDOWN variant
 * and blend.nefty has no TYPED_ATTRIBUTE one. Encoding is by variant
 * NAME, so the ABI rejects a mismatch rather than silently mis-writing.
 *
 * `upgrade_specs` is upgrade-specific and is what this module adds:
 *
 *   { schema_name,
 *     upgrade_requirements[] : which NFTs qualify
 *     upgrade_results[]      : which attributes get rewritten
 *     display_data }
 *
 * Every one of the 1,558 real creations carries exactly ONE spec, so
 * the form builds one, the same way the blend form builds one roll.
 *
 * Verified byte-for-byte against every createupgrde on chain:
 * scripts/verify-createupgrade.mjs
 */

import type { Session } from '@wharfkit/session';

import type { BuiltAction } from '../chain/action';
import {
  encodeIngredient,
  parseIngredientLines,
  type NewIngredient,
  type ParseResult,
} from './createBlend';

/**
 * Strips a `# comment`, but ONLY from the part before the `=`.
 *
 * Attribute values routinely contain "#" - "Positive #1 level 2",
 * "Mint #3" - and cutting there silently truncated the value while
 * still producing a perfectly valid-looking transaction. A comment can
 * only sensibly precede the assignment anyway.
 */
function stripCommentBeforeAssign(line: string): string {
  const eq = line.indexOf('=');
  const hash = line.indexOf('#');
  if (hash < 0) return line;
  if (eq >= 0 && hash > eq) return line; // "#" lives in the value
  return line.slice(0, hash);
}

export const UPGRADE_CONTRACT = 'up.nefty';

type Variant = [string, unknown];

// ─── which NFTs qualify ─────────────────────────────────────────────────

/**
 * A constraint on the NFT being upgraded. All requirements in a spec
 * must hold. Distribution across real creations: typed-attribute 1604,
 * templates 966, single template 260.
 */
export type NewRequirement =
  | { kind: 'template'; template_id: number }
  | { kind: 'templates'; template_ids: number[] }
  /**
   * "attribute <name> is one of <values>". `comparator` is the
   * contract's own enum; 0 (equals / is-one-of) is what every observed
   * creation uses, and it is what the form writes.
   */
  | {
      kind: 'attribute';
      attribute_name: string;
      /** string | image | uint64 | double | bool | uint8 */
      attribute_type: string;
      /** Strings from the form; coerced to numbers for numeric types. */
      allowed_values: (string | number)[];
      /** The contract's own enum. 0 (is-one-of) on every real trace. */
      comparator?: number;
    };

/**
 * Allowed-values vectors are a variant keyed by ELEMENT type, and the
 * tag follows the attribute's declared type rather than being always
 * STRING_VEC. Observed across every real requirement:
 *
 *   string / image -> STRING_VEC     uint64      -> UINT64_VEC
 *   double         -> DOUBLE_VEC     bool / uint8 -> UINT8_VEC
 *
 * Note DOUBLE_VEC, not FLOAT64_VEC: the vector tag and the scalar tag
 * for the same type are spelled differently in this ABI.
 */
export function vecTypeFor(attribute_type: string): string {
  switch (attribute_type) {
    case 'uint64': return 'UINT64_VEC';
    case 'double': return 'DOUBLE_VEC';
    case 'bool':
    case 'uint8':  return 'UINT8_VEC';
    default:       return 'STRING_VEC';
  }
}

/**
 * Each vector type has its own wire shape, and they are NOT
 * interchangeable:
 *
 *   STRING_VEC  array of strings
 *   UINT64_VEC  array of STRINGS (64-bit values do not survive as JS
 *               numbers, so the ABI carries them as decimal strings)
 *   DOUBLE_VEC  array of numbers
 *   UINT8_VEC   a HEX STRING, not an array - a uint8[] is a byte
 *               vector, so [25] is "19" and [0] is "00"
 *
 * Handing an array to UINT8_VEC, or numbers to UINT64_VEC, produces a
 * payload the ABI rejects or mis-encodes.
 */
export function encodeAllowedValues(
  attribute_type: string,
  values: (string | number)[],
): Variant {
  const tag = vecTypeFor(attribute_type);
  switch (tag) {
    case 'UINT8_VEC':
      return [tag, values
        .map((v) => (Number(v) & 0xff).toString(16).padStart(2, '0'))
        .join('')];
    case 'UINT64_VEC':
      return [tag, values.map((v) => String(v))];
    case 'DOUBLE_VEC':
      return [tag, values.map((v) => Number(v))];
    default:
      return [tag, values.map((v) => String(v))];
  }
}

/** Inverse of encodeAllowedValues, for reading a recipe back. */
export function decodeAllowedValues(attribute_type: string, encoded: unknown): (string | number)[] {
  const tag = vecTypeFor(attribute_type);
  if (tag === 'UINT8_VEC') {
    const hex = String(encoded ?? '');
    const out: number[] = [];
    for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
    return out;
  }
  return Array.isArray(encoded) ? (encoded as (string | number)[]) : [];
}

export function encodeRequirement(r: NewRequirement): Variant {
  switch (r.kind) {
    case 'template':
      return ['TEMPLATE_REQUIREMENT', { template_id: r.template_id }];
    case 'templates':
      return ['TEMPLATES_REQUIREMENT', { template_ids: r.template_ids }];
    case 'attribute':
      return ['TYPED_ATTRIBUTE_REQUIREMENT', {
        typed_attribute_definition: {
          attribute_name: r.attribute_name,
          attribute_type: r.attribute_type,
          allowed_values: encodeAllowedValues(r.attribute_type, r.allowed_values),
          comparator: r.comparator ?? 0,
        },
      }];
  }
}

// ─── what gets rewritten ────────────────────────────────────────────────

/**
 * How the new value combines with the old one. The contract stores it
 * as a bare uint8; 0 and 1 are the only values in use.
 */
export const UPGRADE_OP = {
  /** Replace the attribute with the value. 2,124 of 2,407 real results. */
  SET: 0,
  /** Add the value to the current one (numeric attributes). 283. */
  ADD: 1,
} as const;

/**
 * One attribute rewrite.
 *
 * `attribute_type` is the AtomicAssets type as declared on the schema
 * (`string`, `image`, `uint64`, `double`, `bool`), and it does NOT
 * always match the wire type of the value: an `image` attribute carries
 * a `string`, a `bool` carries a `uint8`. Deriving one from the other
 * is the obvious mistake here, so both are explicit.
 */
export interface NewUpgradeResult {
  attribute_name: string;
  /** As declared on the schema: string | image | uint64 | double | bool. */
  attribute_type: string;
  op: number;
  /** The value, already in its final JS form (string | number). */
  value: string | number;
}

/** Wire type for a value, given the schema's declared attribute type. */
export function wireTypeFor(attribute_type: string): string {
  switch (attribute_type) {
    case 'uint64': return 'uint64';
    case 'double': return 'float64';
    case 'bool':
    case 'uint8':  return 'uint8';
    // string, image, ipfs, and anything unknown travel as a string.
    default:       return 'string';
  }
}

export function encodeUpgradeResult(r: NewUpgradeResult): Record<string, unknown> {
  return {
    attribute_name: r.attribute_name,
    attribute_type: r.attribute_type,
    op: { type: r.op },
    value: ['IMMEDIATE_VALUE', [wireTypeFor(r.attribute_type), r.value]],
  };
}

export interface NewUpgradeSpec {
  schema_name: string;
  requirements: NewRequirement[];
  results: NewUpgradeResult[];
  display_data?: string;
}

export function encodeSpec(s: NewUpgradeSpec): Record<string, unknown> {
  return {
    schema_name: s.schema_name,
    upgrade_requirements: s.requirements.map(encodeRequirement),
    upgrade_results: s.results.map(encodeUpgradeResult),
    display_data: s.display_data ?? '',
  };
}

// ─── the action ─────────────────────────────────────────────────────────

export interface CreateUpgradeArgs {
  authorized_account: string;
  collection_name: string;
  ingredients: NewIngredient[];
  specs: NewUpgradeSpec[];
  start_time?: number;
  end_time?: number;
  max_uses?: number;
  display_data?: string;
  security_id?: string | number;
  is_hidden?: boolean;
  category?: string;
}

export function buildCreateUpgradeAction(args: CreateUpgradeArgs): BuiltAction {
  return {
    account: UPGRADE_CONTRACT,
    name: 'createupgrde',
    authorization: [{ actor: args.authorized_account, permission: 'active' }],
    data: {
      authorized_account: args.authorized_account,
      collection_name: args.collection_name,
      ingredients: args.ingredients.map(encodeIngredient),
      upgrade_specs: args.specs.map(encodeSpec),
      start_time: args.start_time ?? 0,
      end_time: args.end_time ?? 0,
      max_uses: args.max_uses ?? 0,
      display_data: args.display_data ?? '',
      security_id: String(args.security_id ?? 0),
      is_hidden: args.is_hidden ?? false,
      category: args.category ?? '',
    },
  };
}

export async function executeCreateUpgrade(
  session: Session,
  args: Omit<CreateUpgradeArgs, 'authorized_account'>,
) {
  return session.transact({
    actions: [buildCreateUpgradeAction({ ...args, authorized_account: String(session.actor) })],
  });
}

// ─── text form ──────────────────────────────────────────────────────────
//
// Same one-per-line approach as the blend creator, and the ingredients
// box is literally the same parser.

export { parseIngredientLines };

/**
 * Parses the "which NFTs qualify" box. One per line:
 *
 *   template 906678                 exactly that template
 *   templates 906678 + 906679       any one of these
 *   attribute name = Farmer | Level 69
 *                                   attribute is one of the values
 *   attribute uint64 level = 3      ...with an explicit type
 *
 * The type defaults to `string`, which is what every observed
 * requirement uses.
 */
export function parseRequirementLines(text: string): ParseResult<NewRequirement> {
  const items: NewRequirement[] = [];
  const errors: string[] = [];

  text.split('\n').forEach((raw, idx) => {
    const line = stripCommentBeforeAssign(raw).trim();
    if (!line) return;
    const where = `Line ${idx + 1}`;
    const [kw, ...rest] = line.split(/\s+/);
    const kind = (kw || '').toLowerCase();

    if (kind === 'template') {
      const tid = Number(rest[0]);
      if (!Number.isFinite(tid) || tid <= 0) { errors.push(`${where}: "${rest[0] ?? ''}" is not a template id.`); return; }
      items.push({ kind: 'template', template_id: tid });
    } else if (kind === 'templates') {
      const ids = rest.join(' ').split('+').map((v) => Number(v.trim())).filter((n) => !Number.isNaN(n));
      if (ids.length === 0 || ids.some((n) => !Number.isFinite(n) || n <= 0)) {
        errors.push(`${where}: expected template ids, e.g. "templates 906678 + 906679".`);
        return;
      }
      items.push({ kind: 'templates', template_ids: ids });
    } else if (kind === 'attribute') {
      // attribute [<type>] <name> = <v1> | <v2>
      const body = rest.join(' ');
      const eq = body.indexOf('=');
      if (eq < 0) { errors.push(`${where}: missing "=" between the attribute and its values.`); return; }
      let namePart = body.slice(0, eq).trim();
      const allowed_values = body.slice(eq + 1).split('|').map((v) => v.trim()).filter(Boolean);
      if (allowed_values.length === 0) { errors.push(`${where}: list at least one allowed value.`); return; }
      // An explicit leading type is optional: "attribute uint64 level = 3".
      let attribute_type = 'string';
      const m = namePart.match(/^(string|image|uint64|double|bool|uint8|ipfs)\s+(.+)$/i);
      if (m) { attribute_type = m[1].toLowerCase(); namePart = m[2].trim(); }
      if (!namePart) { errors.push(`${where}: attribute name missing.`); return; }
      items.push({ kind: 'attribute', attribute_name: namePart, attribute_type, allowed_values });
    } else {
      errors.push(`${where}: unknown requirement "${kw}". Use template / templates / attribute.`);
    }
  });

  return { items, errors };
}

/**
 * Parses the "what changes" box. One rewrite per line:
 *
 *   name = Upgraded Sword          set a string
 *   image img = Qm…                set an image (an IPFS hash)
 *   uint64 level = 5               set a number
 *   uint64 level += 1              ADD to the current value
 *   bool engine = true             booleans travel as 0/1
 *
 * The optional leading word is the attribute's declared TYPE on the
 * schema. Getting it wrong is the one mistake the chain will not catch
 * for you, so the form states it rather than guessing from the value.
 */
export function parseUpgradeResultLines(text: string): ParseResult<NewUpgradeResult> {
  const items: NewUpgradeResult[] = [];
  const errors: string[] = [];

  text.split('\n').forEach((raw, idx) => {
    const line = stripCommentBeforeAssign(raw).trim();
    if (!line) return;
    const where = `Line ${idx + 1}`;

    // "+=" means add; "=" means set. Look for "+=" first.
    const addAt = line.indexOf('+=');
    const eqAt = line.indexOf('=');
    const isAdd = addAt >= 0 && (eqAt < 0 || addAt <= eqAt);
    const cut = isAdd ? addAt : eqAt;
    if (cut < 0) { errors.push(`${where}: missing "=" (or "+=") between the attribute and its value.`); return; }

    let head = line.slice(0, cut).trim();
    const rawValue = line.slice(cut + (isAdd ? 2 : 1)).trim();
    if (!head) { errors.push(`${where}: attribute name missing.`); return; }

    let attribute_type = 'string';
    const m = head.match(/^(string|image|uint64|double|bool|uint8|ipfs)\s+(.+)$/i);
    if (m) { attribute_type = m[1].toLowerCase(); head = m[2].trim(); }

    let value: string | number = rawValue;
    if (attribute_type === 'uint64') {
      const n = Number(rawValue);
      if (!Number.isInteger(n) || n < 0) { errors.push(`${where}: "${rawValue}" is not a whole number.`); return; }
      value = n;
    } else if (attribute_type === 'double') {
      const n = Number(rawValue);
      if (!Number.isFinite(n)) { errors.push(`${where}: "${rawValue}" is not a number.`); return; }
      value = n;
    } else if (attribute_type === 'uint8') {
      const n = Number(rawValue);
      if (!Number.isInteger(n) || n < 0) { errors.push(`${where}: "${rawValue}" is not a whole number.`); return; }
      value = n;
    } else if (attribute_type === 'bool') {
      const v = rawValue.toLowerCase();
      if (!['true', 'false', '1', '0'].includes(v)) { errors.push(`${where}: "${rawValue}" is not true/false.`); return; }
      value = v === 'true' || v === '1' ? 1 : 0;
    } else if (!rawValue) {
      errors.push(`${where}: value missing.`);
      return;
    }

    items.push({
      attribute_name: head,
      attribute_type,
      op: isAdd ? UPGRADE_OP.ADD : UPGRADE_OP.SET,
      value,
    });
  });

  return { items, errors };
}

/** Plain-language summary of what the upgrade does, for the preview. */
export function describeSpec(spec: NewUpgradeSpec): string[] {
  const who = spec.requirements.map((r) =>
    r.kind === 'template' ? `template ${r.template_id}`
      : r.kind === 'templates' ? `one of templates ${r.template_ids.join(', ')}`
        : `${r.attribute_name} is ${r.allowed_values.join(' or ')}`);
  const what = spec.results.map((r) =>
    `${r.attribute_name} ${r.op === UPGRADE_OP.ADD ? '+=' : '='} ${r.value}`);
  return [
    `Applies to NFTs in schema "${spec.schema_name}"${who.length ? ` where ${who.join(' and ')}` : ''}`,
    ...what.map((w) => `Rewrites ${w}`),
  ];
}

// ─── validation ─────────────────────────────────────────────────────────

export function validateNewUpgrade(args: CreateUpgradeArgs): string[] {
  const errs: string[] = [];
  if (!args.authorized_account) errs.push('No authorized account: connect the wallet that manages this collection.');
  if (!args.collection_name) errs.push('Collection name is required.');
  if (args.specs.length === 0) errs.push('An upgrade needs a spec (which NFTs, and what changes).');

  args.specs.forEach((s, i) => {
    const at = `Spec #${i + 1}`;
    if (!s.schema_name) errs.push(`${at}: schema name is required.`);
    if (s.results.length === 0) errs.push(`${at}: nothing would change - add at least one attribute rewrite.`);
    s.results.forEach((r, ri) => {
      if (!r.attribute_name) errs.push(`${at}, change #${ri + 1}: attribute name is required.`);
      // "+=" is NOT restricted to numbers: 14 real upgrades use it on a
      // string attribute (the contract appends). Refusing it would block
      // recipes the chain accepts.
    });
    s.requirements.forEach((r, ri) => {
      if (r.kind === 'template' && !(r.template_id > 0)) errs.push(`${at}, requirement #${ri + 1}: template id required.`);
      if (r.kind === 'templates' && r.template_ids.length === 0) errs.push(`${at}, requirement #${ri + 1}: list at least one template.`);
      if (r.kind === 'attribute' && r.allowed_values.length === 0) errs.push(`${at}, requirement #${ri + 1}: list at least one allowed value.`);
    });
  });

  const start = args.start_time ?? 0;
  const end = args.end_time ?? 0;
  if (end > 0 && start > 0 && end <= start) errs.push('End time must be after start time.');
  return errs;
}
