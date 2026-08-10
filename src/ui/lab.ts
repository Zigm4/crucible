/**
 * Guided creator (route `#/lab`, unlisted).
 * ─────────────────────────────────────────────────────────────
 * A REAL creator, not a mock-up. It reads the chain, it builds the same
 * actions the classic panels build, and it signs. Three contracts:
 *
 *   blend.nefty   createblend    burn NFTs, mint a result
 *   up.nefty      createupgrde   rewrite an attribute of an NFT in place
 *   neftyblocksd  createdrop     sell or give away fresh mints
 *
 * Why a second creator at all. The classic panels are text boxes with a
 * syntax to learn: you type template ids from memory, weights are
 * abstract numbers, and for upgrades you have to DECLARE each attribute's
 * type, which is the one mistake the chain will not catch. This page
 * removes all three by reading the collection first:
 *
 *   1. Pick, do not type. Templates arrive with artwork, name, schema and
 *      supply, so an id is recognised rather than recalled.
 *   2. Weights become a picture. A stacked bar turns "50 / 30 / 20" into
 *      a shape before it is arithmetic.
 *   3. Attribute types are READ FROM THE SCHEMA, never typed. The schema
 *      format is the authority on what an attribute is called and what
 *      type it holds, so the payload cannot disagree with the chain.
 *   4. One plain sentence, on every step. If the sentence is wrong, the
 *      recipe is wrong, with no payload to decode.
 *
 * Self-contained on purpose: its own state, its own render, its own
 * confirmation gate. It can be deleted in one file, or promoted over the
 * classic panels once the interaction has been through real testers.
 */

import { getCurrentSession } from '../chain/session';
import { atomicFetch } from '../chain/rpc';
import { listAuthorizedCollections } from '../atomic/collections';
import { readCollectionSecurities, executeAdminAction } from '../nefty/admin';
import { clearDiscoverCache } from '../nefty/discover';
import { clearUpgradesCache } from '../nefty/upgrades';
import { clearDropsCache } from '../nefty/drops';
import { dryRunActions } from './dryrun';
import { pickImageRef, renderMediaThumb } from './media';
import {
  buildCreateBlendAction,
  executeCreateBlend,
  validateNewBlend,
  type CreateBlendArgs,
  type NewIngredient,
  type NewOutcome,
  type NewResult,
} from '../nefty/createBlend';
import {
  buildCreateUpgradeAction,
  executeCreateUpgrade,
  validateNewUpgrade,
  UPGRADE_OP,
  type CreateUpgradeArgs,
  type NewRequirement,
  type NewUpgradeResult,
} from '../nefty/createUpgrade';
import {
  buildCreateDrop,
  buildDropDisplayData,
  formatListing,
  entriesToAssets,
  totalMints,
  FREE_LISTING_PRICE,
  FREE_SETTLEMENT_SYMBOL,
  type CreateDropArgs,
} from '../nefty/createDrop';

// ─── chain shapes ───────────────────────────────────────────────────────

/** One attribute as the schema declares it. The type is the authority. */
export interface LabAttribute {
  name: string;
  /** AtomicAssets type: string, image, ipfs, uint64, double, bool, ... */
  type: string;
}

interface LabSchema {
  schema_name: string;
  format: LabAttribute[];
  /**
   * How many templates of this schema pin each attribute in immutable_data.
   * Those cannot be rewritten in any way a player would see, so the UI has
   * to block them rather than let an author build a recipe that burns
   * ingredients and changes nothing.
   */
  pinned: Map<string, number>;
  /** The same fact per template, for upgrades limited to specific ones. */
  pinnedBy: Map<number, Set<string>>;
  templateCount: number;
}

interface LabTemplate {
  template_id: number;
  name: string;
  schema_name: string;
  /** IPFS reference for the artwork, if the template has one. */
  image?: string;
  issued: number;
  /** 0 means no cap. */
  max: number;
}

// ─── form shapes ────────────────────────────────────────────────────────

type LabKind = 'blend' | 'upgrade' | 'drop';

/** What a player hands over. Mirrors the NewIngredient variants worth a UI. */
type LabIngredient =
  | { kind: 'template'; template_id: number; amount: number; sendTo: string }
  | { kind: 'schema'; schema_name: string; amount: number; sendTo: string }
  | {
      kind: 'attribute';
      schema_name: string;
      attribute_name: string;
      values: string;
      amount: number;
      sendTo: string;
    }
  | { kind: 'collection'; amount: number; sendTo: string }
  | { kind: 'token'; quantity: string; to: string };

/** One branch of a blend's draw. `kind: 'nothing'` is the blank branch. */
type LabOutcome =
  | { kind: 'nft'; template_id: number; weight: number }
  | { kind: 'token'; quantity: string; contract: string; weight: number }
  | { kind: 'pool'; pool_name: string; weight: number }
  | { kind: 'nothing'; weight: number };

/** Which NFTs an upgrade accepts. */
type LabRequirement =
  | { kind: 'template'; template_id: number }
  | { kind: 'templates'; template_ids: number[] }
  | { kind: 'attribute'; attribute_name: string; values: string };

/** One attribute rewrite. The type is never typed by hand: see schemaType. */
interface LabMutation {
  attribute_name: string;
  /** UPGRADE_OP.SET or UPGRADE_OP.ADD. */
  op: number;
  value: string;
}

/** One line of a drop's mint list. */
interface LabMint {
  template_id: number;
  quantity: number;
}

type LoadState = 'idle' | 'loading' | 'done' | 'error';

/**
 * Everything the argument builders read. Split out from the UI state so the
 * builders are pure functions of a plain object, which is what lets
 * scripts/verify-lab.mjs exercise the REAL code instead of a copy of it.
 * That distinction has bitten this repo before.
 */
export interface LabForm {
  kind: LabKind;
  actor: string;
  collection: string;
  schemas: LabSchema[];
  templates: LabTemplate[];

  // ── shared presentation ──
  name: string;
  description: string;
  image: string;
  category: string;

  // ── blend ──
  ingredients: LabIngredient[];
  outcomes: LabOutcome[];

  // ── upgrade ──
  schemaName: string;
  requirements: LabRequirement[];
  mutations: LabMutation[];

  // ── drop ──
  mints: LabMint[];
  free: boolean;
  priceAmount: string;
  priceToken: string;
  priceDecimals: string;
  priceRecipient: string;
  authRequired: boolean;
  allowCreditCard: boolean;
  maxClaimable: string;
  unlimited: boolean;

  // ── rules ──
  startTime: string;
  endTime: string;
  maxUses: string;
  accountLimit: string;
  cooldown: string;
  securityId: string;
  hidden: boolean;

}

/** LabForm plus everything that only exists to drive the screen. */
interface LabState extends LabForm {
  step: number;
  collections: { collection_name: string; name: string }[];
  collectionsState: LoadState;
  /** Which collection the loaded schemas/templates belong to. */
  loadedFor: string;
  dataState: LoadState;
  dataError: string;
  truncated: boolean;
  securities: { id: string; name: string }[];
  picking?: { target: 'ingredient' | 'outcome' | 'mint' | 'requirement' };
  search: string;
  busy: boolean;
  dryRun: string;
  lastTx: string;
  lastError: string;
}

const state: LabState = {
  kind: 'blend',
  step: 0,
  actor: '',
  collections: [],
  collectionsState: 'idle',
  collection: '',
  loadedFor: '',
  schemas: [],
  templates: [],
  dataState: 'idle',
  dataError: '',
  truncated: false,
  securities: [],
  name: '',
  description: '',
  image: '',
  category: '',
  ingredients: [],
  outcomes: [],
  schemaName: '',
  requirements: [],
  mutations: [],
  mints: [],
  free: true,
  priceAmount: '1',
  priceToken: 'WAX',
  priceDecimals: '8',
  priceRecipient: '',
  authRequired: false,
  allowCreditCard: false,
  maxClaimable: '100',
  unlimited: false,
  startTime: '',
  endTime: '',
  maxUses: '',
  accountLimit: '',
  cooldown: '',
  securityId: '',
  hidden: true,
  search: '',
  busy: false,
  dryRun: '',
  lastTx: '',
  lastError: '',
};

const STEP_COUNT = 5;

/** Step 3 asks a different question for each contract. */
function steps(): string[] {
  switch (state.kind) {
    case 'upgrade': return ['Collection', 'What players give', 'What changes', 'Rules', 'Review'];
    case 'drop':    return ['Collection', 'What it mints', 'Price', 'Rules', 'Review'];
    default:        return ['Collection', 'What players give', 'What they get', 'Rules', 'Review'];
  }
}

// ─── small helpers ──────────────────────────────────────────────────────

const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * One decimal, trailing `.0` dropped. Every place that shows a chance uses
 * this: a row reading 1.9% beside a sentence reading 2% reads as a bug.
 */
const pct = (weight: number, total: number) =>
  `${((weight / total) * 100).toFixed(1).replace(/\.0$/, '')}%`;

const tpl = (id: number) => state.templates.find((t) => t.template_id === id);
const tplName = (id: number) => tpl(id)?.name || `template ${id}`;

const schema = (name: string) => state.schemas.find((s) => s.schema_name === name);

/**
 * The declared type of an attribute on the active schema. This is the
 * value that goes on the wire, and reading it here is the whole point of
 * loading the schema: an author who guesses wrong builds a recipe the
 * chain accepts and no player can ever satisfy.
 */
function schemaType(schema_name: string, attribute_name: string): string {
  return schema(schema_name)?.format.find((f) => f.name === attribute_name)?.type ?? 'string';
}

/** Numeric types are the only ones `+=` is defined for. */
const isNumericType = (t: string) => t === 'uint64' || t === 'double' || t === 'uint8';

/**
 * AtomicAssets schemas accept 19 base types plus their vector forms, but
 * `wireTypeFor` only branches on five and lets everything else fall through
 * to `string`. A `uint16` attribute would therefore be encoded as a string
 * into a uint16 slot: the payload serialises, the chain stores nonsense.
 *
 * So the picker offers only the types the encoder actually models. The rest
 * are shown, disabled, with the reason, rather than hidden: an author whose
 * attribute is missing needs to know why, not wonder.
 */
const ENCODABLE_TYPES = new Set(['string', 'image', 'ipfs', 'uint64', 'double', 'bool', 'uint8']);

/**
 * Why an attribute cannot be written here, or empty if it can.
 *
 * Only two things make it impossible: a type the encoder does not model,
 * and EVERY targeted template freezing the attribute. Partial pinning is
 * not a block, it is a warning, and the difference is not academic.
 * `kingsburynft/tv` pins `img` on 70 of its 71 templates and its live
 * upgrades rewrite `img` anyway: all 124 upgraded assets belong to the one
 * template that leaves it free. Blocking on "any template pins it" would
 * have refused a recipe that demonstrably works.
 */
function attributeBlock(schema_name: string, attribute_name: string, forWriting: boolean): string {
  const s = schema(schema_name);
  const f = s?.format.find((x) => x.name === attribute_name);
  if (!f) return '';
  if (!ENCODABLE_TYPES.has(f.type)) return `type ${f.type} is not supported by this builder`;
  if (forWriting) {
    const { pinned, total } = pinning(schema_name, attribute_name);
    if (total > 0 && pinned === total) {
      return `frozen in the immutable data of all ${total} template(s) this would apply to, so nothing anyone sees would change`;
    }
  }
  return '';
}

/** The softer half: possible, but only for part of the NFTs. */
function attributeWarn(schema_name: string, attribute_name: string): string {
  const { pinned, total } = pinning(schema_name, attribute_name);
  if (pinned === 0 || pinned === total) return '';
  return `"${attribute_name}" is frozen in the immutable data of ${pinned} of the ${total} template(s) this applies to. ` +
    `It will only visibly change on the other ${total - pinned}. Restrict who qualifies if that is not what you meant.`;
}

/**
 * How many of the targeted templates freeze this attribute, out of how
 * many are targeted at all. Scoped to the templates the requirements name
 * when there are any, because an upgrade limited to one template is only
 * shadowed by that template.
 */
function pinning(schema_name: string, attribute_name: string): { pinned: number; total: number } {
  const s = schema(schema_name);
  if (!s) return { pinned: 0, total: 0 };
  const targeted = state.requirements.flatMap((r) =>
    r.kind === 'template' ? [r.template_id] : r.kind === 'templates' ? r.template_ids : [],
  );
  if (targeted.length === 0) return { pinned: s.pinned.get(attribute_name) ?? 0, total: s.templateCount };
  return {
    pinned: targeted.filter((id) => s.pinnedBy.get(id)?.has(attribute_name)).length,
    total: targeted.length,
  };
}

/** "2026-08-10T14:30" from a datetime-local input to unix seconds. */
function toUnix(v: string): number {
  if (!v.trim()) return 0;
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

const intOr = (v: string, fallback = 0) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** Splits "Rare | Epic" into ["Rare", "Epic"]. */
const splitValues = (v: string) => v.split('|').map((s) => s.trim()).filter(Boolean);

const totalWeight = () => state.outcomes.reduce((n, o) => n + o.weight, 0) || 1;

const OUTCOME_COLOURS = ['#7c9cff', '#86c97f', '#f0a860', '#e8798f', '#c58cf5', '#5ec8d8', '#d8c85e', '#8fd8b0'];

// ─── loading from the chain ─────────────────────────────────────────────

let rerender: () => void = () => {};

/** Collections this wallet is allowed to manage. Nothing else is offered. */
async function loadCollections() {
  const session = getCurrentSession();
  const actor = session ? String(session.actor) : '';
  state.actor = actor;
  if (!actor) { state.collectionsState = 'idle'; state.collections = []; return; }
  state.collectionsState = 'loading';
  rerender();
  try {
    state.collections = await listAuthorizedCollections(actor);
    state.collectionsState = 'done';
    // One collection is not a choice, it is an answer.
    if (!state.collection && state.collections.length === 1) {
      state.collection = state.collections[0].collection_name;
      void loadCollectionData();
    }
  } catch {
    state.collectionsState = 'error';
  }
  rerender();
}

interface RawSchema { schema_name: string; format: { name: string; type: string }[] }
interface RawTemplate {
  template_id: string | number;
  name?: string;
  issued_supply?: string | number;
  max_supply?: string | number;
  schema?: { schema_name?: string };
  immutable_data?: Record<string, unknown>;
}

/**
 * Everything the wizard needs about one collection, in parallel: its
 * schemas (attribute names and types), its templates (artwork, names,
 * supply) and its whitelists.
 *
 * The template list is capped at the API maximum. A collection past that
 * cap still works, the picker just cannot offer what it has not seen, so
 * the UI says so instead of pretending the list is complete.
 */
const TEMPLATE_PAGE = 1000;

async function loadCollectionData() {
  const collection = state.collection.trim();
  if (!collection) return;
  state.dataState = 'loading';
  state.dataError = '';
  rerender();
  try {
    const [rawSchemas, rawTemplates, securities] = await Promise.all([
      atomicFetch<RawSchema[]>(
        `/atomicassets/v1/schemas?collection_name=${encodeURIComponent(collection)}&limit=100&order=asc&sort=schema_name`,
      ),
      atomicFetch<RawTemplate[]>(
        `/atomicassets/v1/templates?collection_name=${encodeURIComponent(collection)}&limit=${TEMPLATE_PAGE}&order=desc&sort=created`,
      ),
      readCollectionSecurities(collection).catch(() => []),
    ]);

    state.templates = (rawTemplates ?? []).map((t) => ({
      template_id: Number(t.template_id),
      name: String(t.name || t.immutable_data?.name || `template ${t.template_id}`),
      schema_name: String(t.schema?.schema_name ?? ''),
      image: pickImageRef(t.immutable_data as Record<string, unknown> | undefined),
      issued: Number(t.issued_supply ?? 0),
      max: Number(t.max_supply ?? 0),
    }));
    state.truncated = (rawTemplates ?? []).length >= TEMPLATE_PAGE;

    // An attribute a template pins in immutable_data is frozen for every
    // asset of that template. Counting them here is what lets the upgrade
    // step warn instead of silently building a no-op.
    state.schemas = (rawSchemas ?? []).map((s) => {
      const pinned = new Map<string, number>();
      const pinnedBy = new Map<number, Set<string>>();
      let templateCount = 0;
      for (const raw of rawTemplates ?? []) {
        if (String(raw.schema?.schema_name ?? '') !== s.schema_name) continue;
        templateCount++;
        const keys = Object.keys(raw.immutable_data ?? {});
        pinnedBy.set(Number(raw.template_id), new Set(keys));
        for (const key of keys) pinned.set(key, (pinned.get(key) ?? 0) + 1);
      }
      return {
        schema_name: s.schema_name,
        format: (s.format ?? []).map((f) => ({ name: f.name, type: f.type })),
        pinned,
        pinnedBy,
        templateCount,
      };
    });

    state.securities = (securities ?? []).map((r) => ({ id: String(r.id), name: r.name }));
    if (!state.schemaName && state.schemas.length) state.schemaName = state.schemas[0].schema_name;
    state.loadedFor = collection;
    state.dataState = 'done';
  } catch (err) {
    state.dataState = 'error';
    state.dataError = err instanceof Error ? err.message : String(err);
  }
  rerender();
}

// ─── the sentence ───────────────────────────────────────────────────────

function describeIngredient(i: LabIngredient): string {
  const fate = 'sendTo' in i && i.sendTo ? ` (sent to ${i.sendTo})` : ' (destroyed)';
  switch (i.kind) {
    case 'template':   return `${i.amount} x ${tplName(i.template_id)}${fate}`;
    case 'schema':     return `${i.amount} x any ${i.schema_name} NFT${fate}`;
    case 'attribute':  return `${i.amount} x ${i.schema_name} where ${i.attribute_name} is ${splitValues(i.values).join(' or ') || 'anything'}${fate}`;
    case 'collection': return `${i.amount} x any NFT from the collection${fate}`;
    case 'token':      return i.quantity.trim()
      ? `${i.quantity.trim()}${i.to.trim() ? ` paid to ${i.to.trim()}` : ''}`
      : 'a token cost you have not set yet';
  }
}

function describeOutcome(o: LabOutcome): string {
  switch (o.kind) {
    case 'nft':     return tplName(o.template_id);
    case 'token':   return o.quantity || 'tokens';
    case 'pool':    return o.pool_name.trim() ? `an NFT from the "${o.pool_name.trim()}" pool` : 'an NFT from a pool you have not named yet';
    case 'nothing': return 'nothing';
  }
}

function describeMutation(m: LabMutation): string {
  const v = String(m.value).trim() || 'a value you have not set yet';
  return m.op === UPGRADE_OP.ADD
    ? `${m.attribute_name} goes up by ${v}`
    : `${m.attribute_name} becomes ${v}`;
}

/**
 * The recipe as a player would describe it. If this sentence is wrong,
 * the recipe is wrong, and you can tell without reading a payload.
 */
function plainSentence(): string {
  if (state.kind === 'drop') {
    const mints = state.mints.length
      ? state.mints.map((m) => `${m.quantity} x ${tplName(m.template_id)}`).join(' and ')
      : 'nothing yet';
    const price = state.free
      ? 'for free'
      : `for ${state.priceAmount.trim() || 'an amount you have not set'} ${state.priceToken.trim()}`;
    const supply = state.unlimited
      ? 'as many times as players want'
      : `${intOr(state.maxClaimable) || 'a number of'} times in total`;
    return `Each claim mints ${mints}, ${price}, claimable ${supply}.`;
  }

  const give = state.ingredients.length
    ? state.ingredients.map(describeIngredient).join(' and ')
    : 'nothing yet';

  if (state.kind === 'upgrade') {
    const effect = state.mutations.length === 0
      ? 'nothing changes yet'
      : state.mutations.map(describeMutation).join(', then ');
    const gate = state.requirements.length
      ? state.requirements.map((r) =>
          r.kind === 'template' ? `is ${tplName(r.template_id)}`
          : r.kind === 'templates' ? `is one of ${r.template_ids.length} templates`
          : `has ${r.attribute_name} equal to ${splitValues(r.values).join(' or ') || 'a value you have not set yet'}`).join(' and ')
      : '';
    const who = `their ${state.schemaName || 'chosen'} NFT${gate ? ` (${gate})` : ''}`;
    return `A player spends ${give} and ${who} is rewritten: ${effect}.`;
  }

  const total = totalWeight();
  const get = state.outcomes.length === 0
    ? 'nothing yet'
    : state.outcomes.length === 1
      ? describeOutcome(state.outcomes[0])
      : state.outcomes.map((o) => `${pct(o.weight, total)} ${describeOutcome(o)}`).join(', ');
  return `A player gives ${give} and gets ${get}.`;
}

// ─── building the on-chain arguments ────────────────────────────────────

function displayData(): string {
  const dd: Record<string, string> = {};
  if (state.name.trim()) dd.name = state.name.trim();
  if (state.description.trim()) dd.description = state.description.trim();
  if (state.image.trim()) dd.image = state.image.trim();
  return JSON.stringify(dd);
}

function toIngredient(i: LabIngredient): NewIngredient {
  const collection_name = state.collection.trim();
  const disposal = 'sendTo' in i && i.sendTo.trim() ? { transfer_to: i.sendTo.trim() } : {};
  switch (i.kind) {
    case 'template':
      return { kind: 'template', template_id: i.template_id, collection_name, amount: i.amount, ...disposal };
    case 'schema':
      return { kind: 'schema', collection_name, schema_name: i.schema_name, amount: i.amount, ...disposal };
    case 'attribute':
      return {
        kind: 'attribute',
        collection_name,
        schema_name: i.schema_name,
        amount: i.amount,
        attributes: [{ attribute_name: i.attribute_name, allowed_values: splitValues(i.values) }],
        ...disposal,
      };
    case 'collection':
      return { kind: 'collection', collection_name, amount: i.amount, ...disposal };
    case 'token':
      return { kind: 'ft', quantity: i.quantity.trim(), to: i.to.trim() || undefined };
  }
}

function toResults(o: LabOutcome): NewResult[] {
  switch (o.kind) {
    case 'nft':     return [{ kind: 'nft', template_id: o.template_id }];
    case 'token':   return [{ kind: 'ft', quantity: o.quantity.trim(), contract: o.contract.trim() }];
    case 'pool':    return [{ kind: 'pool', pool_name: o.pool_name.trim() }];
    case 'nothing': return [];
  }
}

function blendArgs(): CreateBlendArgs {
  const outcomes: NewOutcome[] = state.outcomes.map((o) => ({ odds: o.weight, results: toResults(o) }));
  return {
    authorized_account: state.actor,
    collection_name: state.collection.trim(),
    ingredients: state.ingredients.map(toIngredient),
    rolls: [{ outcomes }],
    start_time: toUnix(state.startTime),
    end_time: toUnix(state.endTime),
    max_uses: intOr(state.maxUses),
    display_data: displayData(),
    security_id: state.securityId || 0,
    is_hidden: state.hidden,
    category: state.category.trim(),
    account_limit: intOr(state.accountLimit),
    account_limit_cooldown: intOr(state.cooldown),
  };
}

function upgradeArgs(): CreateUpgradeArgs {
  const sn = state.schemaName;
  const requirements: NewRequirement[] = state.requirements.map((r) =>
    r.kind === 'template'
      ? { kind: 'template', template_id: r.template_id }
      : r.kind === 'templates'
        ? { kind: 'templates', template_ids: r.template_ids }
        : {
            kind: 'attribute',
            attribute_name: r.attribute_name,
            // Read from the schema, never typed by the author.
            attribute_type: schemaType(sn, r.attribute_name),
            allowed_values: splitValues(r.values),
          },
  );
  const results: NewUpgradeResult[] = state.mutations.map((m) => {
    const type = schemaType(sn, m.attribute_name);
    // A bool travels as a uint8, so its value must be the NUMBER 1 or 0.
    // A JS `true` would encode as JSON true into a uint8 slot.
    const value = type === 'bool'
      ? (String(m.value) === '1' || String(m.value).toLowerCase() === 'true' ? 1 : 0)
      : isNumericType(type) ? Number(m.value) : m.value;
    return { attribute_name: m.attribute_name, attribute_type: type, op: m.op, value };
  });
  return {
    authorized_account: state.actor,
    collection_name: state.collection.trim(),
    ingredients: state.ingredients.map(toIngredient),
    specs: [{ schema_name: sn, requirements, results }],
    start_time: toUnix(state.startTime),
    end_time: toUnix(state.endTime),
    max_uses: intOr(state.maxUses),
    display_data: displayData(),
    security_id: state.securityId || 0,
    is_hidden: state.hidden,
    category: state.category.trim(),
  };
}

function dropArgs(): CreateDropArgs {
  const entries = state.mints.map((m) => ({ template_id: m.template_id, quantity: m.quantity }));
  const pricing = state.free
    ? { listing_price: FREE_LISTING_PRICE, settlement_symbol: FREE_SETTLEMENT_SYMBOL }
    : formatListing(Number(state.priceAmount) || 0, state.priceToken, intOr(state.priceDecimals, 8));
  return {
    authorized_account: state.actor,
    collection_name: state.collection.trim(),
    assets_to_mint: entriesToAssets(entries),
    listing_price: pricing.listing_price,
    alternative_prices: [],
    settlement_symbol: pricing.settlement_symbol,
    price_recipient: (state.priceRecipient.trim() || state.actor).toLowerCase(),
    auth_required: state.authRequired,
    is_hidden: state.hidden,
    max_claimable: state.unlimited ? 0 : intOr(state.maxClaimable),
    account_limit: intOr(state.accountLimit),
    account_limit_cooldown: intOr(state.cooldown),
    start_time: toUnix(state.startTime),
    end_time: toUnix(state.endTime),
    display_data: buildDropDisplayData(state.name, state.description, state.image),
    distribution_id: 0,
    allow_credit_card_payments: state.allowCreditCard,
    referral_fee: 0,
    referral_whitelist_id: 0,
  };
}

function builtAction() {
  return state.kind === 'blend'
    ? buildCreateBlendAction(blendArgs())
    : state.kind === 'upgrade'
      ? buildCreateUpgradeAction(upgradeArgs())
      : buildCreateDrop(dropArgs());
}

/**
 * Everything that would make the chain, or a player, reject this recipe.
 * The shared validators do the contract-level work; the extra checks here
 * are the ones only the wizard can make, because only it knows the schema.
 */
function problems(): string[] {
  const out: string[] = [];
  if (!state.actor) out.push('Connect a wallet to sign.');
  if (!state.collection.trim()) out.push('Pick the collection this belongs to.');

  if (state.kind === 'drop') {
    if (state.mints.length === 0) out.push('Add at least one template for the drop to mint.');
    if (!state.unlimited && intOr(state.maxClaimable) === 0) out.push('Set a max supply, or tick "unlimited".');
    if (!state.free) {
      if (!(Number(state.priceAmount) > 0)) out.push('Set a price above zero, or make the drop free.');
      if (!/^[A-Z]{1,7}$/.test(state.priceToken.trim().toUpperCase())) out.push('Token symbol must be 1 to 7 letters, e.g. WAX.');
      const d = Number(state.priceDecimals);
      if (!Number.isInteger(d) || d < 0 || d > 18) {
        out.push('Token decimals must be a whole number from 0 to 18. WAX is 8, TLM is 4.');
      }
    }
  } else {
    if (state.ingredients.length === 0) out.push('Add at least one thing the player gives up.');
    // The shared upgrade validator does not look at ingredients at all, so
    // these checks have to run for both contracts rather than only blends.
    for (const i of state.ingredients) {
      if (i.kind === 'token') {
        if (!/^\d+(\.\d+)? [A-Z]{1,7}$/.test(i.quantity.trim())) {
          out.push(`"${i.quantity.trim() || 'empty'}" is not a token amount. Write it with the token's exact decimals, e.g. 10.00000000 WAX.`);
        }
        if (!i.to.trim()) out.push('A token cost with no receiving account would burn the tokens. Name an account.');
      } else if ('amount' in i && i.amount < 1) {
        out.push('An ingredient asks for fewer than one NFT.');
      }
      if (i.kind === 'attribute' && splitValues(i.values).length === 0) {
        out.push(`Ingredient on ${i.attribute_name} lists no allowed value.`);
      }
    }
  }

  if (state.kind === 'blend') {
    if (state.outcomes.length === 0) out.push('Add at least one outcome.');
    if (state.outcomes.length && state.outcomes.every((o) => o.kind === 'nothing')) {
      out.push('Every outcome is blank, so a player could never win anything.');
    }
    out.push(...validateNewBlend(blendArgs()));
  }

  if (state.kind === 'upgrade') {
    if (!state.schemaName) out.push('Pick the schema the upgrade applies to.');
    if (state.mutations.length === 0) out.push('Add at least one attribute change.');
    for (const m of state.mutations) {
      if (!m.attribute_name) { out.push('An attribute change has no attribute selected.'); continue; }
      const type = schemaType(state.schemaName, m.attribute_name);
      const why = attributeBlock(state.schemaName, m.attribute_name, true);
      if (why) out.push(`"${m.attribute_name}" cannot be rewritten: ${why}.`);
      if (!String(m.value).trim()) out.push(`"${m.attribute_name}" has no value.`);
      else if (isNumericType(type) && !Number.isFinite(Number(m.value))) {
        out.push(`"${m.attribute_name}" is declared ${type} on the schema, so its value must be a number.`);
      }
      if (m.op === UPGRADE_OP.ADD && !isNumericType(type)) {
        out.push(`"${m.attribute_name}" is ${type}, which cannot be added to. Use "is set to".`);
      }
    }
    for (const r of state.requirements) {
      if (r.kind === 'attribute' && splitValues(r.values).length === 0) {
        out.push(`The condition on "${r.attribute_name}" lists no value to match.`);
      }
    }
    out.push(...validateNewUpgrade(upgradeArgs()));
  }

  const start = toUnix(state.startTime);
  const end = toUnix(state.endTime);
  if (end !== 0 && start !== 0 && end <= start) out.push('The end time is not after the start time.');
  // An empty start means "now", so an end in the past would be created
  // already finished. Comparing only start against end misses that.
  if (end !== 0 && end <= Math.floor(Date.now() / 1000)) {
    out.push('The end time is in the past, so this would be over before it began.');
  }

  return [...new Set(out)];
}

/**
 * Warnings are not errors: each one describes a recipe the chain will
 * happily accept and that will not do what the author expects.
 */
function warnings(): string[] {
  const out: string[] = [];

  if (state.kind === 'upgrade') {
    for (const m of state.mutations) {
      const w = attributeWarn(state.schemaName, m.attribute_name);
      if (w) out.push(w);
    }
  }

  if (state.kind === 'upgrade' && state.mutations.length > 1) {
    out.push('The contract applies every change in order to the same NFT, so all of them happen together. This is not a draw.');
  }

  if (state.kind === 'drop' && state.authRequired) {
    out.push('A whitelisted drop starts with an EMPTY whitelist, so nobody can claim it until you add accounts in the classic Manage panel.');
  }

  if (state.kind !== 'drop') {
    const burned = state.ingredients.filter((i) => 'sendTo' in i && !i.sendTo.trim()).length;
    if (burned > 0) out.push(`${burned} ingredient(s) are burned, which destroys them permanently on every use.`);
  }

  if (state.kind === 'blend' && state.outcomes.length > 1) {
    out.push('More than one outcome makes this a lottery: one branch is drawn per blend and the player pays the full cost either way.');
  }

  if (!state.hidden) out.push('This will be visible to players the moment it is created.');
  if (state.truncated) out.push(`Only the ${TEMPLATE_PAGE} most recent templates were loaded, so the picker may not list everything.`);

  return out;
}

// ─── test seam ──────────────────────────────────────────────────────────
//
// scripts/verify-lab.mjs drives the REAL builders through these, rather
// than re-implementing them. That distinction has already cost this repo
// once: a harness that reimplemented the parsers passed while the shipped
// parser was broken, so the test validated the wrong code.
//
// The form goes through the same module-level state the UI writes to,
// which is the faithful path rather than a parallel one.

/** Overwrites the form fields. Test-only; the UI never calls this. */
export function __setForm(f: Partial<LabState>): void {
  Object.assign(state, f);
}

export {
  blendArgs as __blendArgs,
  upgradeArgs as __upgradeArgs,
  dropArgs as __dropArgs,
  builtAction as __builtAction,
  problems as __problems,
  warnings as __warnings,
  plainSentence as __plainSentence,
  attributeBlock as __attributeBlock,
};

// ─── shared UI pieces ───────────────────────────────────────────────────

function stepRail(): string {
  return `
    <ol class="lab-rail">
      ${steps().map((label, i) => `
        <li class="lab-rail-step${i === state.step ? ' current' : ''}${i < state.step ? ' done' : ''}"
            data-lab="step" data-step="${i}">
          <span class="lab-rail-dot">${i < state.step ? '&check;' : i + 1}</span>
          <span class="lab-rail-label">${esc(label)}</span>
        </li>`).join('')}
    </ol>`;
}

/** A quantity control. The signs are drawn in CSS, not typed as glyphs. */
function stepper(amount: number, minusAction: string, plusAction: string, idx: number): string {
  return `
    <span class="lab-stepper">
      <button class="lab-minus" data-lab="${minusAction}" data-idx="${idx}" aria-label="one fewer"></button>
      <b>${amount}</b>
      <button class="lab-plus" data-lab="${plusAction}" data-idx="${idx}" aria-label="one more"></button>
    </span>`;
}

function thumb(templateId: number): string {
  const t = tpl(templateId);
  const art = t?.image ? renderMediaThumb({ ref: t.image, alt: t.name, className: 'media-thumb-sm' }) : '';
  return art || '<span class="lab-noart" aria-hidden="true"></span>';
}

function templateCard(t: LabTemplate): string {
  const art = t.image ? renderMediaThumb({ ref: t.image, alt: t.name, className: 'media-thumb-sm' }) : '<span class="lab-noart"></span>';
  const supply = t.max ? `${t.issued} of ${t.max} minted` : `${t.issued} minted`;
  return `
    <button class="lab-tpl" data-lab="pick-template" data-id="${t.template_id}">
      ${art}
      <span class="lab-tpl-body">
        <span class="lab-tpl-name">${esc(t.name)}</span>
        <span class="lab-tpl-meta">${esc(t.schema_name)} &middot; #${t.template_id} &middot; ${supply}</span>
      </span>
    </button>`;
}

/** The template overlay. Same component for every step that needs one. */
function picker(): string {
  const q = state.search.trim().toLowerCase();
  const list = state.templates.filter(
    (t) => !q || t.name.toLowerCase().includes(q) || String(t.template_id).includes(q) || t.schema_name.toLowerCase().includes(q),
  );
  const shown = list.slice(0, 200);
  return `
    <div class="lab-picker">
      <input id="lab-search" type="text" placeholder="Search by name, schema or template id" value="${esc(state.search)}" autocomplete="off" />
      ${state.templates.length === 0
        ? '<p class="lab-hint">No templates loaded for this collection yet.</p>'
        : `<div class="lab-tpl-grid">${shown.map(templateCard).join('')}</div>
           ${list.length > shown.length ? `<p class="lab-note">Showing 200 of ${list.length} matches. Narrow the search to see the rest.</p>` : ''}`}
      <button class="lab-ghost" data-lab="close-picker">Cancel</button>
    </div>`;
}

function disposalToggle(i: LabIngredient, idx: number): string {
  if (i.kind === 'token') return '';
  const keeps = Boolean(i.sendTo.trim());
  return `
    <span class="lab-seg small">
      <button class="${keeps ? '' : 'on danger'}" data-lab="ing-burn" data-idx="${idx}">Burn</button>
      <button class="${keeps ? 'on' : ''}" data-lab="ing-keep" data-idx="${idx}">Send to</button>
    </span>
    ${keeps ? `<input class="lab-inline" id="lab-ing-to-${idx}" type="text" data-lab="ing-to" data-idx="${idx}"
                     value="${esc(i.sendTo)}" placeholder="vault.wam" autocomplete="off" />` : ''}`;
}

// ─── step 1: collection ─────────────────────────────────────────────────

function stepCollection(): string {
  const kinds: { k: LabKind; title: string; sub: string }[] = [
    { k: 'blend',   title: 'Blend',   sub: 'burn NFTs, mint a result' },
    { k: 'upgrade', title: 'Upgrade', sub: 'rewrite an NFT in place' },
    { k: 'drop',    title: 'Drop',    sub: 'sell or give away mints' },
  ];
  const label = state.kind === 'drop' ? 'Drop name' : state.kind === 'upgrade' ? 'Upgrade name' : 'Blend name';

  // A wallet that manages collections gets a list. Everyone else gets a
  // text box: authorship is checked by the contract, not by this page, and
  // an author who was just added is not in the indexer yet.
  const manualBox = `
    <input id="lab-collection-manual" type="text" value="${esc(state.collection)}"
           placeholder="collection name, e.g. underpunks55" autocomplete="off" />`;

  const collectionField = state.collectionsState === 'loading'
    ? '<p class="lab-hint">Looking up the collections you manage.</p>'
    : state.collections.length > 0
      ? `<select id="lab-collection">
           <option value=""${state.collection ? '' : ' selected'}>Choose a collection</option>
           ${state.collections.map((c) => `<option value="${esc(c.collection_name)}"${c.collection_name === state.collection ? ' selected' : ''}>${esc(c.name)} (${esc(c.collection_name)})</option>`).join('')}
         </select>`
      : `${manualBox}
         <p class="lab-note">${
           !state.actor
             ? 'Connect your wallet at the top of the app and the collections you manage will be listed here. You can still type one to look around.'
             : state.collectionsState === 'error'
               ? `Could not reach the AtomicAssets indexer. <button class="lab-link" data-lab="reload-collections">Try again</button>`
               : `${esc(state.actor)} is not listed as an authorized account on any collection. <button class="lab-link" data-lab="reload-collections">Check again</button>`
         }</p>`;

  const loadLine = state.collection && state.dataState === 'loading'
    ? '<p class="lab-hint">Reading the schemas and templates of this collection.</p>'
    : state.collection && state.dataState === 'error'
      ? `<p class="lab-warn">Could not load this collection: ${esc(state.dataError)} <button class="lab-link" data-lab="reload-data">Try again</button></p>`
      : state.collection && state.dataState === 'done'
        ? `<p class="lab-ok">${state.templates.length} template(s) and ${state.schemas.length} schema(s) loaded${state.securities.length ? `, ${state.securities.length} whitelist(s)` : ''}.</p>`
        : '';

  return `
    <h3 class="lab-q">What are you creating, and where?</h3>

    <div class="lab-field">
      <label>This is a</label>
      <div class="lab-seg">
        ${kinds.map((k) => `
          <button class="${state.kind === k.k ? 'on' : ''}" data-lab="kind" data-kind="${k.k}">
            ${k.title}<small>${k.sub}</small>
          </button>`).join('')}
      </div>
    </div>

    <div class="lab-field">
      <label>Collection</label>
      ${collectionField}
      ${loadLine}
    </div>

    <div class="lab-field">
      <label>${esc(label)} <span class="lab-note">what players see in the list, not the name of the NFT</span></label>
      <input id="lab-name" type="text" value="${esc(state.name)}" placeholder="e.g. Forge a Mycelium Helmet" autocomplete="off" />
    </div>

    <div class="lab-field">
      <label>Description <span class="lab-note">optional</span></label>
      <input id="lab-description" type="text" value="${esc(state.description)}" placeholder="Shown under the recipe" autocomplete="off" />
    </div>

    <div class="lab-field">
      <label>Thumbnail <span class="lab-note">optional, an IPFS hash and not a URL</span></label>
      <input id="lab-image" type="text" value="${esc(state.image)}" placeholder="Qm... or baf..." autocomplete="off" />
      <p class="lab-note">Leave it empty to fall back to the artwork of what this produces.</p>
    </div>

    ${state.kind === 'drop' ? '' : `
      <div class="lab-field">
        <label>Category <span class="lab-note">optional, a free tag to group your own recipes</span></label>
        <input id="lab-category" type="text" value="${esc(state.category)}" placeholder="e.g. armour" autocomplete="off" />
        <p class="lab-note">Purely cosmetic. It changes nothing on chain and most authors leave it empty.</p>
      </div>`}`;
}

// ─── step 2: what players give (blend and upgrade) ──────────────────────

function ingredientRow(i: LabIngredient, idx: number): string {
  const del = `<button class="lab-x" data-lab="ing-del" data-idx="${idx}" aria-label="remove"></button>`;

  if (i.kind === 'token') {
    return `
      <div class="lab-row">
        <span class="lab-tag">Tokens</span>
        <input class="lab-inline" id="lab-ing-qty-${idx}" type="text" data-lab="ing-qty" data-idx="${idx}"
               value="${esc(i.quantity)}" placeholder="10.00000000 WAX" autocomplete="off" />
        <span class="lab-mini-label">paid to</span>
        <input class="lab-inline" id="lab-ing-payto-${idx}" type="text" data-lab="ing-payto" data-idx="${idx}"
               value="${esc(i.to)}" placeholder="${esc(state.actor || 'your.wam')}" autocomplete="off" />
        ${del}
      </div>`;
  }

  if (i.kind === 'template') {
    const t = tpl(i.template_id);
    return `
      <div class="lab-row">
        ${thumb(i.template_id)}
        <span class="lab-row-main">
          <strong>${esc(t?.name ?? `template ${i.template_id}`)}</strong>
          <span class="lab-tpl-meta">${esc(t?.schema_name ?? '')} &middot; #${i.template_id}</span>
        </span>
        ${stepper(i.amount, 'ing-minus', 'ing-plus', idx)}
        ${disposalToggle(i, idx)}
        ${del}
      </div>`;
  }

  if (i.kind === 'collection') {
    return `
      <div class="lab-row">
        <span class="lab-tag">Any NFT</span>
        <span class="lab-row-main">
          <strong>Any NFT from ${esc(state.collection || 'the collection')}</strong>
          <span class="lab-tpl-meta">no template or schema restriction</span>
        </span>
        ${stepper(i.amount, 'ing-minus', 'ing-plus', idx)}
        ${disposalToggle(i, idx)}
        ${del}
      </div>`;
  }

  const schemaSelect = `
    <select class="lab-inline" data-lab="ing-schema" data-idx="${idx}">
      ${state.schemas.map((s) => `<option${s.schema_name === i.schema_name ? ' selected' : ''}>${esc(s.schema_name)}</option>`).join('')}
    </select>`;

  if (i.kind === 'schema') {
    return `
      <div class="lab-row">
        <span class="lab-tag">Any of</span>
        ${schemaSelect}
        ${stepper(i.amount, 'ing-minus', 'ing-plus', idx)}
        ${disposalToggle(i, idx)}
        ${del}
      </div>`;
  }

  const fields = schema(i.schema_name)?.format ?? [];
  return `
    <div class="lab-row lab-row-wide">
      <span class="lab-tag">Matching</span>
      ${schemaSelect}
      <span class="lab-mini-label">where</span>
      <select class="lab-inline" data-lab="ing-attr" data-idx="${idx}">
        ${fields.map((f) => `<option${f.name === i.attribute_name ? ' selected' : ''}>${esc(f.name)}</option>`).join('')}
      </select>
      <span class="lab-mini-label">is</span>
      <input class="lab-inline" id="lab-ing-values-${idx}" type="text" data-lab="ing-values" data-idx="${idx}"
             value="${esc(i.values)}" placeholder="Rare | Epic" autocomplete="off" />
      ${stepper(i.amount, 'ing-minus', 'ing-plus', idx)}
      ${disposalToggle(i, idx)}
      ${del}
    </div>`;
}

function stepGive(): string {
  if (state.picking?.target === 'ingredient') return picker();
  const burned = state.ingredients.filter((i) => 'sendTo' in i && !i.sendTo.trim()).length;
  const nft = state.ingredients.filter((i) => i.kind !== 'token').length;
  return `
    <h3 class="lab-q">What does a player give up?</h3>
    <p class="lab-hint">Pick from your own collection. Nothing here has to be typed from memory.</p>

    ${state.ingredients.length === 0
      ? '<p class="lab-empty">Nothing yet. Add at least one cost below.</p>'
      : `<div class="lab-rows">${state.ingredients.map(ingredientRow).join('')}</div>`}

    <div class="lab-row-actions">
      <button class="lab-add" data-lab="open-ingredient">Add a specific NFT</button>
      <button class="lab-add" data-lab="add-ing-schema" ${state.schemas.length ? '' : 'disabled'}>Add any NFT of a schema</button>
      <button class="lab-add" data-lab="add-ing-attribute" ${state.schemas.length ? '' : 'disabled'}>Add NFTs matching an attribute</button>
      <button class="lab-add" data-lab="add-ing-collection">Add any NFT of the collection</button>
      <button class="lab-add" data-lab="add-ing-token">Add a token cost</button>
    </div>

    ${nft > 0 ? `
      <div class="lab-callout ${burned ? 'danger' : ''}">
        <strong>${burned} of ${nft} NFT cost(s) are burned.</strong>
        Burning destroys them permanently, on every single use, with no way to get them back.
        "Send to" routes them to an account you own instead.
      </div>` : ''}`;
}

// ─── step 3a: outcomes (blend) ──────────────────────────────────────────

function outcomeRow(o: LabOutcome, idx: number): string {
  const total = totalWeight();
  const colour = OUTCOME_COLOURS[idx % OUTCOME_COLOURS.length];
  const many = state.outcomes.length > 1;
  const head = o.kind === 'nft'
    ? `${thumb(o.template_id)}
       <span class="lab-row-main">
         <strong>${esc(tplName(o.template_id))}</strong>
         <span class="lab-tpl-meta">${esc(tpl(o.template_id)?.schema_name ?? '')} &middot; #${o.template_id}</span>
       </span>`
    : o.kind === 'token'
      ? `<span class="lab-tag">Tokens</span>
         <input class="lab-inline" id="lab-out-qty-${idx}" type="text" data-lab="out-qty" data-idx="${idx}"
                value="${esc(o.quantity)}" placeholder="1.00000000 WAX" autocomplete="off" />
         <span class="lab-mini-label">on</span>
         <input class="lab-inline" id="lab-out-contract-${idx}" type="text" data-lab="out-contract" data-idx="${idx}"
                value="${esc(o.contract)}" placeholder="eosio.token" autocomplete="off" />`
      : o.kind === 'pool'
        ? `<span class="lab-tag">Pool</span>
           <input class="lab-inline" id="lab-out-pool-${idx}" type="text" data-lab="out-pool" data-idx="${idx}"
                  value="${esc(o.pool_name)}" placeholder="pool name" autocomplete="off" />`
        : `<span class="lab-tag muted">Nothing</span>
           <span class="lab-row-main"><strong>The player gets nothing</strong>
             <span class="lab-tpl-meta">a losing branch</span></span>`;
  return `
    <div class="lab-row">
      <span class="lab-swatch" style="background:${colour}"></span>
      ${head}
      ${many ? `
        <input class="lab-weight" type="range" min="1" max="100" value="${o.weight}" data-lab="odds" data-idx="${idx}"
               aria-label="weight" />
        <b class="lab-pct">${pct(o.weight, total)}</b>` : ''}
      <button class="lab-x" data-lab="out-del" data-idx="${idx}" aria-label="remove"></button>
    </div>`;
}

function stepGet(): string {
  if (state.picking?.target === 'outcome') return picker();
  const total = totalWeight();
  return `
    <h3 class="lab-q">What do they get?</h3>
    <p class="lab-hint">One line is a certainty. Add more and it becomes a draw, and the bar shows the real chances.</p>

    ${state.outcomes.length > 1 ? `
      <div class="lab-bar">
        ${state.outcomes.map((o, i) => `
          <span class="lab-bar-seg" style="width:${(o.weight / total) * 100}%; background:${OUTCOME_COLOURS[i % OUTCOME_COLOURS.length]}"
                title="${esc(describeOutcome(o))} ${pct(o.weight, total)}"></span>`).join('')}
      </div>` : ''}

    ${state.outcomes.length === 0
      ? '<p class="lab-empty">Nothing yet. Add at least one outcome below.</p>'
      : `<div class="lab-rows">${state.outcomes.map(outcomeRow).join('')}</div>`}

    <div class="lab-row-actions">
      <button class="lab-add" data-lab="open-outcome">Add an NFT reward</button>
      <button class="lab-add" data-lab="add-out-token">Add a token payout</button>
      <button class="lab-add" data-lab="add-out-pool">Add a pool draw</button>
      <button class="lab-add" data-lab="add-out-nothing">Add a losing branch</button>
    </div>

    ${state.outcomes.length > 1
      ? '<div class="lab-callout">This is a <strong>lottery</strong>: the contract draws one line per blend and the others do not happen. The player pays the full cost either way.</div>'
      : state.outcomes.length === 1
        ? '<div class="lab-callout ok">Single outcome, so every player gets this, guaranteed.</div>'
        : ''}`;
}

// ─── step 3b: what changes (upgrade) ────────────────────────────────────

function requirementRow(r: LabRequirement, idx: number): string {
  const del = `<button class="lab-x" data-lab="req-del" data-idx="${idx}" aria-label="remove"></button>`;
  if (r.kind === 'template' || r.kind === 'templates') {
    const ids = r.kind === 'template' ? [r.template_id] : r.template_ids;
    return `
      <div class="lab-row">
        <span class="lab-tag">Is</span>
        <span class="lab-row-main">
          <strong>${ids.map(tplName).map(esc).join(', ')}</strong>
          <span class="lab-tpl-meta">${ids.map((i) => `#${i}`).join(', ')}</span>
        </span>
        ${del}
      </div>`;
  }
  const type = schemaType(state.schemaName, r.attribute_name);
  return `
    <div class="lab-row">
      <span class="lab-tag">Has</span>
      ${attributeSelect(r.attribute_name, 'req-attr', idx, false)}
      <span class="lab-mini-label">equal to</span>
      <input class="lab-inline" id="lab-req-values-${idx}" type="text" data-lab="req-values" data-idx="${idx}"
             value="${esc(r.values)}" placeholder="Rare | Epic" autocomplete="off" />
      <span class="lab-type">${esc(type)}</span>
      ${del}
    </div>`;
}

/**
 * The attribute dropdown, with anything unusable disabled and labelled.
 * `forWriting` distinguishes the two questions: a requirement only READS an
 * attribute, so a template-pinned one is perfectly valid to filter on, while
 * writing to it is the trap.
 */
function attributeSelect(selected: string, action: string, idx: number, forWriting: boolean): string {
  const fields = schema(state.schemaName)?.format ?? [];
  return `
    <select class="lab-inline" data-lab="${action}" data-idx="${idx}">
      ${fields.map((f) => {
        const why = attributeBlock(state.schemaName, f.name, forWriting);
        return `<option${f.name === selected ? ' selected' : ''}${why ? ' disabled' : ''}>${esc(f.name)}</option>`;
      }).join('')}
    </select>`;
}

function mutationRow(m: LabMutation, idx: number): string {
  const type = schemaType(state.schemaName, m.attribute_name);
  const numeric = isNumericType(type);
  const why = attributeBlock(state.schemaName, m.attribute_name, true);
  const caution = why ? '' : attributeWarn(state.schemaName, m.attribute_name);
  const isBool = type === 'bool';
  return `
    <div class="lab-row${why ? ' lab-row-bad' : caution ? ' lab-row-warn' : ''}">
      ${attributeSelect(m.attribute_name, 'mut-attr', idx, true)}
      <span class="lab-type" title="declared on the schema">${esc(type)}</span>
      <span class="lab-seg small">
        <button class="${m.op === UPGRADE_OP.SET ? 'on' : ''}" data-lab="mut-set" data-idx="${idx}">is set to</button>
        <button class="${m.op === UPGRADE_OP.ADD ? 'on' : ''}" data-lab="mut-add" data-idx="${idx}"
                ${numeric ? '' : 'disabled title="only numeric attributes can be added to"'}>goes up by</button>
      </span>
      ${isBool
        ? `<select class="lab-inline" data-lab="mut-bool" data-idx="${idx}">
             <option value="1"${String(m.value) === '1' ? ' selected' : ''}>true</option>
             <option value="0"${String(m.value) === '0' ? ' selected' : ''}>false</option>
           </select>`
        : `<input class="lab-inline" id="lab-mut-value-${idx}" type="text" data-lab="mut-value" data-idx="${idx}"
                  value="${esc(m.value)}" placeholder="${numeric ? '1' : 'new value'}" autocomplete="off" />`}
      <button class="lab-x" data-lab="mut-del" data-idx="${idx}" aria-label="remove"></button>
      ${why
        ? `<span class="lab-blocked">${esc(why)}</span>`
        : caution ? `<span class="lab-caution">${esc(caution)}</span>` : ''}
    </div>`;
}

function stepChanges(): string {
  if (state.picking?.target === 'requirement') return picker();

  const s = schema(state.schemaName);
  const fields = s?.format ?? [];

  return `
    <h3 class="lab-q">What changes on the NFT?</h3>
    <p class="lab-hint">
      An upgrade mints nothing. The player keeps the same NFT and its attributes are rewritten in place,
      which is why it cannot be undone.
    </p>

    <div class="lab-field">
      <label>Which schema</label>
      ${state.schemas.length === 0
        ? '<p class="lab-warn">No schema loaded. Go back to step 1 and pick a collection.</p>'
        : `<select id="lab-schema">
             ${state.schemas.map((x) => `<option${x.schema_name === state.schemaName ? ' selected' : ''}>${esc(x.schema_name)}</option>`).join('')}
           </select>`}
      ${fields.length ? `
        <p class="lab-note">
          ${fields.length} attribute(s) declared on this schema:
          ${fields.map((f) => {
            const why = attributeBlock(state.schemaName, f.name, true);
            return `<code${why ? ' class="lab-code-off"' : ''} title="${esc(why)}">${esc(f.name)}</code> <span class="lab-type">${esc(f.type)}</span>`;
          }).join(', ')}.
          Types come from the schema, so they are never guessed.
          ${fields.some((f) => attributeBlock(state.schemaName, f.name, true))
            ? 'Greyed names cannot be rewritten, hover to see why.'
            : ''}
        </p>` : ''}
    </div>

    <div class="lab-field">
      <label>Who qualifies <span class="lab-note">optional, leave empty and every ${esc(state.schemaName || 'matching')} NFT qualifies</span></label>
      ${state.requirements.length
        ? `<div class="lab-rows">${state.requirements.map(requirementRow).join('')}</div>`
        : '<p class="lab-empty">No condition: any NFT of this schema can be upgraded.</p>'}
      <div class="lab-row-actions">
        <button class="lab-add" data-lab="open-requirement">Only a specific template</button>
        <button class="lab-add" data-lab="add-req-attribute" ${fields.length ? '' : 'disabled'}>Only NFTs with an attribute value</button>
      </div>
    </div>

    <div class="lab-field">
      <label>What gets rewritten</label>
      ${state.mutations.length
        ? `<div class="lab-rows">${state.mutations.map(mutationRow).join('')}</div>`
        : '<p class="lab-empty">Nothing yet. Add at least one change below.</p>'}
      <div class="lab-row-actions">
        <button class="lab-add" data-lab="add-mutation" ${fields.length ? '' : 'disabled'}>Add an attribute change</button>
      </div>
    </div>

    ${renderWarnings(warnings().filter((w) => w.includes('every change in order')))}`;
}

// ─── step 2/3 for drops ─────────────────────────────────────────────────

function stepMints(): string {
  if (state.picking?.target === 'mint') return picker();
  const total = totalMints(state.mints.map((m) => ({ template_id: m.template_id, quantity: m.quantity })));
  return `
    <h3 class="lab-q">What does one claim mint?</h3>
    <p class="lab-hint">A drop mints from templates that already exist. Every claim mints this whole list.</p>

    ${state.mints.length === 0
      ? '<p class="lab-empty">Nothing yet. Add at least one template below.</p>'
      : `<div class="lab-rows">${state.mints.map((m, idx) => {
          const t = tpl(m.template_id);
          return `
            <div class="lab-row">
              ${thumb(m.template_id)}
              <span class="lab-row-main">
                <strong>${esc(t?.name ?? `template ${m.template_id}`)}</strong>
                <span class="lab-tpl-meta">${esc(t?.schema_name ?? '')} &middot; #${m.template_id}${t && t.max ? ` &middot; ${t.issued} of ${t.max} minted` : ''}</span>
              </span>
              ${stepper(m.quantity, 'mint-minus', 'mint-plus', idx)}
              <button class="lab-x" data-lab="mint-del" data-idx="${idx}" aria-label="remove"></button>
            </div>`;
        }).join('')}</div>`}

    <div class="lab-row-actions">
      <button class="lab-add" data-lab="open-mint">Add a template to mint</button>
    </div>

    ${total > 0 ? `<div class="lab-callout ok">Each claim mints <strong>${total} NFT(s)</strong>.</div>` : ''}`;
}

function stepPrice(): string {
  return `
    <h3 class="lab-q">What does a claim cost?</h3>
    <p class="lab-hint">Free drops are the common case. A priced drop needs an exact token symbol and its decimals.</p>

    <div class="lab-field">
      <label>Price</label>
      <div class="lab-seg">
        <button class="${state.free ? 'on' : ''}" data-lab="drop-free">Free<small>players pay nothing</small></button>
        <button class="${state.free ? '' : 'on'}" data-lab="drop-paid">Paid<small>players pay tokens</small></button>
      </div>
    </div>

    ${state.free ? '' : `
      <div class="lab-field">
        <label>Amount and token</label>
        <div class="lab-gate">
          <input id="lab-price-amount" type="text" value="${esc(state.priceAmount)}" placeholder="1" autocomplete="off" />
          <select id="lab-price-token">
            ${['WAX', 'TLM', 'USDC'].map((t) => `<option${t === state.priceToken ? ' selected' : ''}>${t}</option>`).join('')}
            ${['WAX', 'TLM', 'USDC'].includes(state.priceToken) ? '' : `<option selected>${esc(state.priceToken)}</option>`}
          </select>
          <span>with</span>
          <input id="lab-price-decimals" type="number" min="0" max="18" value="${esc(state.priceDecimals)}" />
          <span>decimals</span>
        </div>
        <p class="lab-note">WAX has 8 decimals, TLM has 4. Getting this wrong makes the listing unreadable to the marketplace.</p>
      </div>

      <div class="lab-field">
        <label>Payments go to</label>
        <input id="lab-price-recipient" type="text" value="${esc(state.priceRecipient)}" placeholder="${esc(state.actor || 'your.wam')}" autocomplete="off" />
        <p class="lab-note">Empty means your own account, ${esc(state.actor || 'the signing wallet')}.</p>
      </div>

      <label class="lab-check">
        <input type="checkbox" ${state.allowCreditCard ? 'checked' : ''} data-lab="drop-cc" />
        <span><strong>Allow credit card payments</strong> through the NeftyBlocks payment processor.</span>
      </label>`}

    <div class="lab-field" style="margin-top:18px">
      <label>Total supply</label>
      <label class="lab-check">
        <input type="checkbox" ${state.unlimited ? 'checked' : ''} data-lab="drop-unlimited" />
        <span><strong>Unlimited</strong>, claimable until the drop ends.</span>
      </label>
      ${state.unlimited ? '' : `
        <input id="lab-max-claimable" type="number" min="1" value="${esc(state.maxClaimable)}" placeholder="100" />
        <p class="lab-note">The number of times the drop can be claimed in total, across everyone.</p>`}
    </div>`;
}

// ─── step 4: rules ──────────────────────────────────────────────────────

function stepRules(): string {
  const isDrop = state.kind === 'drop';
  return `
    <h3 class="lab-q">Any limits?</h3>
    <p class="lab-hint">All optional. Leave them alone and it is open, unlimited and live as soon as it is created.</p>

    <div class="lab-field">
      <label>Runs from</label>
      <div class="lab-pair">
        <label class="lab-mini">Starts
          <input id="lab-start" type="datetime-local" value="${esc(state.startTime)}" />
        </label>
        <label class="lab-mini">Ends
          <input id="lab-end" type="datetime-local" value="${esc(state.endTime)}" />
        </label>
      </div>
      <p class="lab-note">Empty start means immediately, empty end means never.</p>
    </div>

    ${isDrop ? '' : `
      <div class="lab-field">
        <label>Total uses <span class="lab-note">empty means unlimited</span></label>
        <input id="lab-max-uses" type="number" min="0" value="${esc(state.maxUses)}" placeholder="unlimited" />
      </div>`}

    <div class="lab-field">
      <label>Per wallet</label>
      <div class="lab-pair">
        <label class="lab-mini">Max per wallet
          <input id="lab-account-limit" type="number" min="0" value="${esc(state.accountLimit)}" placeholder="0" />
        </label>
        <label class="lab-mini">Cooldown in seconds
          <input id="lab-cooldown" type="number" min="0" value="${esc(state.cooldown)}" placeholder="0" />
        </label>
      </div>
      <p class="lab-note">0 and 0 means no per-wallet limit. With a limit, the cooldown is how long a wallet waits before its counter resets. 86400 is one day, and 0 means the limit never resets.</p>
    </div>

    ${isDrop ? `
      <label class="lab-check">
        <input type="checkbox" ${state.authRequired ? 'checked' : ''} data-lab="drop-auth" />
        <span><strong>Whitelist required</strong>. The whitelist starts EMPTY, so nobody can claim until you add accounts in the classic Manage panel.</span>
      </label>`
    : `
      <div class="lab-field">
        <label>Who can use it</label>
        ${state.securities.length
          ? `<select id="lab-security">
               <option value=""${state.securityId ? '' : ' selected'}>Everyone, no whitelist</option>
               ${state.securities.map((s) => `<option value="${esc(s.id)}"${s.id === state.securityId ? ' selected' : ''}>Only "${esc(s.name)}" (#${esc(s.id)})</option>`).join('')}
             </select>`
          : '<p class="lab-note">This collection has no whitelist, so everyone can use it. Whitelists are created in the classic Manage panel.</p>'}
      </div>`}

    <label class="lab-check">
      <input type="checkbox" ${state.hidden ? 'checked' : ''} data-lab="hidden" />
      <span><strong>Create it hidden</strong>. It exists on chain but appears in no list, so you can test it before players find it. Strongly recommended for a first one.</span>
    </label>`;
}

// ─── step 5: review and sign ────────────────────────────────────────────

function renderWarnings(list: string[]): string {
  if (list.length === 0) return '';
  return `<div class="lab-callout danger"><strong>Before you sign</strong><ul class="lab-list">${list.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`;
}

function reviewRows(): string {
  const rows: [string, string][] = [
    ['Contract', state.kind === 'blend' ? 'blend.nefty createblend' : state.kind === 'upgrade' ? 'up.nefty createupgrde' : 'neftyblocksd createdrop'],
    ['Collection', state.collection || 'not set'],
    ['Name', state.name.trim() || 'unnamed'],
  ];
  if (state.kind === 'drop') {
    const entries = state.mints.map((m) => ({ template_id: m.template_id, quantity: m.quantity }));
    rows.push(['Mints', state.mints.map((m) => `${m.quantity} x ${tplName(m.template_id)}`).join(', ') || 'nothing']);
    rows.push(['Per claim', `${totalMints(entries)} NFT(s)`]);
    rows.push(['Price', state.free ? 'free' : `${state.priceAmount} ${state.priceToken}`]);
    rows.push(['Supply', state.unlimited ? 'unlimited' : String(intOr(state.maxClaimable))]);
    rows.push(['Paid to', state.priceRecipient.trim() || state.actor || 'the signing wallet']);
  } else {
    rows.push(['Cost', state.ingredients.map(describeIngredient).join(', ') || 'nothing']);
    if (state.kind === 'blend') {
      const total = totalWeight();
      rows.push(['Draw', state.outcomes.map((o) => `${pct(o.weight, total)} ${describeOutcome(o)}`).join(' / ') || 'nothing']);
    } else {
      rows.push(['Schema', state.schemaName || 'not set']);
      rows.push(['Qualifies', state.requirements.length
        ? state.requirements.map((r) => r.kind === 'attribute'
            ? `${r.attribute_name} is ${splitValues(r.values).join(' or ')}`
            : r.kind === 'template' ? tplName(r.template_id) : `${r.template_ids.length} templates`).join(' and ')
        : `every ${state.schemaName || 'matching'} NFT`]);
      rows.push(['Rewrites', state.mutations.map((m) =>
        `${m.attribute_name} (${schemaType(state.schemaName, m.attribute_name)}) ${m.op === UPGRADE_OP.ADD ? '+=' : '='} ${String(m.value).trim() || 'unset'}`).join(', ') || 'nothing']);
    }
  }
  rows.push(['Window', `${state.startTime ? new Date(state.startTime).toLocaleString() : 'now'} to ${state.endTime ? new Date(state.endTime).toLocaleString() : 'never'}`]);
  rows.push(['Visibility', state.hidden ? 'hidden, safe to test' : 'visible immediately']);

  return `<div class="lab-review">${rows.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>`;
}

function stepReview(): string {
  const errs = problems();
  const warns = warnings();
  return `
    <h3 class="lab-q">Does this read the way you meant it?</h3>
    <div class="lab-sentence big">${esc(plainSentence())}</div>
    ${reviewRows()}

    ${errs.length
      ? `<div class="lab-callout danger"><strong>This cannot be created yet</strong><ul class="lab-list">${errs.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>`
      : '<div class="lab-callout ok">Every check passes. Simulate first, then sign.</div>'}

    ${renderWarnings(warns)}

    <div class="lab-callout">
      <strong>Beta.</strong> Creation through Crucible is new and has been verified against every
      matching creation on chain, but no substitute for your own test. Create it hidden, try it on
      one NFT, then reveal it. On-chain creation costs RAM and cannot be undone.
    </div>

    <div class="lab-nav-actions">
      <button class="lab-ghost" data-lab="simulate" ${errs.length || state.busy ? 'disabled' : ''}>Simulate, no signature</button>
      <button class="lab-primary" data-lab="submit" ${errs.length || state.busy ? 'disabled' : ''}>
        ${state.busy ? 'Waiting for your wallet' : 'Sign and create'}
      </button>
    </div>

    ${state.dryRun ? `<h4 class="lab-sub">What your wallet would be asked to sign</h4><pre class="lab-pre">${esc(state.dryRun)}</pre>` : ''}
    ${state.lastError ? `<p class="lab-warn">${esc(state.lastError)}</p>` : ''}
    ${state.lastTx ? `<p class="lab-ok">Created. Transaction <a target="_blank" rel="noreferrer" href="https://waxblock.io/transaction/${esc(state.lastTx)}">${esc(state.lastTx)}</a></p>` : ''}`;
}

// ─── page ───────────────────────────────────────────────────────────────

export function renderLabPage(): string {
  const body = state.step === 0
    ? stepCollection()
    : state.step === 1
      ? (state.kind === 'drop' ? stepMints() : stepGive())
      : state.step === 2
        ? (state.kind === 'drop' ? stepPrice() : state.kind === 'upgrade' ? stepChanges() : stepGet())
        : state.step === 3
          ? stepRules()
          : stepReview();

  const title = state.kind === 'blend' ? 'a blend' : state.kind === 'upgrade' ? 'an upgrade' : 'a drop';

  return `
    <a class="app-link" href="#/nefty" style="margin-bottom:14px">Back to the app</a>
    <section class="lab">
      <div class="lab-head">
        <span class="lab-badge">GUIDED</span>
        <h2>Create ${title}</h2>
      </div>
      <p class="lab-intro">
        The same contracts as the classic panels, asked one question at a time. Templates are picked
        from your collection instead of typed, odds are drawn instead of counted, and for upgrades the
        attribute types are read from the schema so they cannot disagree with the chain.
        <strong>This signs real transactions.</strong>
      </p>

      ${stepRail()}
      ${state.step === STEP_COUNT - 1 ? '' : `<div class="lab-sentence">${esc(plainSentence())}</div>`}
      <div class="lab-panel">${body}</div>

      <div class="lab-nav">
        <button class="lab-ghost" data-lab="prev" ${state.step === 0 ? 'disabled' : ''}>Back</button>
        <span class="lab-step-of">Step ${state.step + 1} of ${STEP_COUNT}</span>
        <button class="lab-primary" data-lab="next" ${state.step === STEP_COUNT - 1 ? 'disabled' : ''}>Continue</button>
      </div>
    </section>`;
}

// ─── confirmation gate ──────────────────────────────────────────────────

/**
 * Renders on document.body rather than inside the page: the app replaces
 * `#root.innerHTML` on every render, which would tear a modal out mid-read.
 */
function confirmCreate(summary: string): Promise<boolean> {
  return new Promise((resolve) => {
    document.getElementById('lab-gate')?.remove();
    const wrap = document.createElement('div');
    wrap.id = 'lab-gate';
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="lab-gate-title">
        <h3 id="lab-gate-title" class="modal-title">Sign this on chain?</h3>
        <pre class="lab-pre">${esc(summary)}</pre>
        <label class="lab-check" style="margin:14px 0">
          <input id="lab-gate-ack" type="checkbox" />
          <span>I understand this is permanent, costs RAM, and that creation through Crucible is in beta.</span>
        </label>
        <div class="modal-actions">
          <button id="lab-gate-cancel" class="lab-ghost">Cancel</button>
          <button id="lab-gate-go" class="lab-primary" disabled>Sign it</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    const ack = wrap.querySelector<HTMLInputElement>('#lab-gate-ack')!;
    const go = wrap.querySelector<HTMLButtonElement>('#lab-gate-go')!;
    const done = (v: boolean) => { wrap.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') done(false); };

    ack.addEventListener('change', () => { go.disabled = !ack.checked; });
    go.addEventListener('click', () => done(true));
    wrap.querySelector('#lab-gate-cancel')!.addEventListener('click', () => done(false));
    wrap.addEventListener('click', (e) => { if (e.target === wrap) done(false); });
    document.addEventListener('keydown', onKey);
  });
}

// ─── signing ────────────────────────────────────────────────────────────

async function onSimulate() {
  state.busy = true;
  state.dryRun = '';
  state.lastError = '';
  rerender();
  try {
    const results = await dryRunActions([builtAction()]);
    state.dryRun = results
      .map((r) => (r.error ? `${r.action}\n  REJECTED: ${r.error}` : `${r.action}\n  ${r.bin}`))
      .join('\n\n');
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
  }
  state.busy = false;
  rerender();
}

async function onSubmit() {
  const session = getCurrentSession();
  if (!session) { state.lastError = 'Connect a wallet first.'; rerender(); return; }

  const summary = [
    `${state.kind.toUpperCase()} on ${state.collection}`,
    '',
    plainSentence(),
    '',
    ...warnings().map((w) => `! ${w}`),
  ].join('\n');
  if (!(await confirmCreate(summary))) return;

  state.busy = true;
  state.lastError = '';
  state.lastTx = '';
  rerender();
  try {
    let result;
    if (state.kind === 'blend') {
      const { authorized_account: _drop, ...rest } = blendArgs();
      result = await executeCreateBlend(session, rest);
    } else if (state.kind === 'upgrade') {
      const { authorized_account: _drop, ...rest } = upgradeArgs();
      result = await executeCreateUpgrade(session, rest);
    } else {
      result = await executeAdminAction(session, buildCreateDrop(dropArgs()));
    }
    state.lastTx =
      (result.response as { transaction_id?: string } | undefined)?.transaction_id ??
      String(result.resolved?.transaction.id ?? '');
    // The app caches each contract's list. Something was just added to one
    // of them, so drop the cache rather than send the author back to a
    // page that does not show what they just made.
    if (state.kind === 'blend') clearDiscoverCache();
    else if (state.kind === 'upgrade') clearUpgradesCache();
    else clearDropsCache();
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
  }
  state.busy = false;
  rerender();
}

// ─── handlers ───────────────────────────────────────────────────────────

/** The first attribute of the active schema that can actually be used. */
function firstUsableAttribute(forWriting: boolean): string {
  const fields = schema(state.schemaName)?.format ?? [];
  return (fields.find((f) => !attributeBlock(state.schemaName, f.name, forWriting)) ?? fields[0])?.name ?? '';
}

/** A blank ingredient of each kind, so "add" never lands on an invalid row. */
function newIngredient(kind: LabIngredient['kind']): LabIngredient {
  const s = state.schemas[0]?.schema_name ?? '';
  switch (kind) {
    case 'schema':     return { kind: 'schema', schema_name: s, amount: 1, sendTo: '' };
    case 'attribute':  return { kind: 'attribute', schema_name: s, attribute_name: schema(s)?.format[0]?.name ?? '', values: '', amount: 1, sendTo: '' };
    case 'collection': return { kind: 'collection', amount: 1, sendTo: '' };
    case 'token':      return { kind: 'token', quantity: '', to: state.actor };
    default:           return { kind: 'template', template_id: 0, amount: 1, sendTo: '' };
  }
}

/** Wires the page. Every input carries an id so focus survives a re-render. */
export function attachLabHandlers(root: HTMLElement, render: () => void): void {
  rerender = render;

  // First paint with a connected wallet: go and find its collections.
  const session = getCurrentSession();
  const actor = session ? String(session.actor) : '';
  if (actor !== state.actor || (actor && state.collectionsState === 'idle')) {
    void loadCollections();
  }

  const idx = (el: HTMLElement) => Number(el.dataset.idx);

  root.querySelectorAll<HTMLElement>('[data-lab]').forEach((el) => {
    const kind = el.dataset.lab!;

    // Range sliders update live.
    if (kind === 'odds') {
      el.addEventListener('input', () => {
        state.outcomes[idx(el)].weight = Number((el as HTMLInputElement).value);
        render();
      });
      return;
    }

    // Free-text rows: store on every keystroke, repaint on blur. Their ids
    // are stable so focus would survive either way, but not repainting
    // keeps the caret exactly where the user left it.
    const textField: Record<string, (v: string, i: number) => void> = {
      'ing-to':        (v, i) => { const g = state.ingredients[i]; if ('sendTo' in g) g.sendTo = v; },
      'ing-qty':       (v, i) => { const g = state.ingredients[i]; if (g.kind === 'token') g.quantity = v; },
      'ing-payto':     (v, i) => { const g = state.ingredients[i]; if (g.kind === 'token') g.to = v; },
      'ing-values':    (v, i) => { const g = state.ingredients[i]; if (g.kind === 'attribute') g.values = v; },
      'out-qty':       (v, i) => { const o = state.outcomes[i]; if (o.kind === 'token') o.quantity = v; },
      'out-contract':  (v, i) => { const o = state.outcomes[i]; if (o.kind === 'token') o.contract = v; },
      'out-pool':      (v, i) => { const o = state.outcomes[i]; if (o.kind === 'pool') o.pool_name = v; },
      'req-values':    (v, i) => { const r = state.requirements[i]; if (r.kind === 'attribute') r.values = v; },
      'mut-value':     (v, i) => { state.mutations[i].value = v; },
    };
    if (textField[kind]) {
      el.addEventListener('input', () => textField[kind]((el as HTMLInputElement).value, idx(el)));
      el.addEventListener('change', () => render());
      return;
    }

    // Selects that need the schema or attribute re-read.
    if (kind === 'mut-bool') {
      el.addEventListener('change', () => {
        state.mutations[idx(el)].value = (el as HTMLSelectElement).value;
        render();
      });
      return;
    }

    if (kind === 'ing-schema' || kind === 'ing-attr' || kind === 'req-attr' || kind === 'mut-attr') {
      el.addEventListener('change', () => {
        const v = (el as HTMLSelectElement).value;
        const i = idx(el);
        if (kind === 'ing-schema') {
          const g = state.ingredients[i];
          if (g.kind === 'schema' || g.kind === 'attribute') g.schema_name = v;
          if (g.kind === 'attribute') g.attribute_name = schema(v)?.format[0]?.name ?? '';
        } else if (kind === 'ing-attr') {
          const g = state.ingredients[i];
          if (g.kind === 'attribute') g.attribute_name = v;
        } else if (kind === 'req-attr') {
          const r = state.requirements[i];
          if (r.kind === 'attribute') r.attribute_name = v;
        } else {
          const m = state.mutations[i];
          m.attribute_name = v;
          // `+=` exists only for numbers, so a switch to text has to fall
          // back rather than leave an impossible pair on screen.
          const t = schemaType(state.schemaName, v);
          if (!isNumericType(t)) m.op = UPGRADE_OP.SET;
          // A bool has only two values, so start it on one rather than
          // leaving a blank the validator would immediately reject.
          m.value = t === 'bool' ? '1' : '';
        }
        render();
      });
      return;
    }

    // Checkboxes.
    const checkbox: Record<string, (v: boolean) => void> = {
      hidden:            (v) => { state.hidden = v; },
      'drop-auth':       (v) => { state.authRequired = v; },
      'drop-cc':         (v) => { state.allowCreditCard = v; },
      'drop-unlimited':  (v) => { state.unlimited = v; },
    };
    if (checkbox[kind]) {
      el.addEventListener('change', () => { checkbox[kind]((el as HTMLInputElement).checked); render(); });
      return;
    }

    el.addEventListener('click', () => {
      const i = idx(el);
      switch (kind) {
        case 'step': state.step = Number(el.dataset.step); break;
        case 'next': state.step = Math.min(STEP_COUNT - 1, state.step + 1); break;
        case 'prev': state.step = Math.max(0, state.step - 1); break;
        case 'kind': state.kind = el.dataset.kind as LabKind; state.step = 0; break;

        case 'reload-collections': void loadCollections(); return;
        case 'reload-data':        void loadCollectionData(); return;

        case 'open-ingredient':  state.picking = { target: 'ingredient' }; state.search = ''; break;
        case 'open-outcome':     state.picking = { target: 'outcome' }; state.search = ''; break;
        case 'open-mint':        state.picking = { target: 'mint' }; state.search = ''; break;
        case 'open-requirement': state.picking = { target: 'requirement' }; state.search = ''; break;
        case 'close-picker':     state.picking = undefined; break;

        case 'pick-template': {
          const id = Number(el.dataset.id);
          const target = state.picking?.target;
          if (target === 'ingredient') state.ingredients.push({ kind: 'template', template_id: id, amount: 1, sendTo: '' });
          if (target === 'outcome')    state.outcomes.push({ kind: 'nft', template_id: id, weight: 1 });
          if (target === 'mint')       state.mints.push({ template_id: id, quantity: 1 });
          if (target === 'requirement') state.requirements.push({ kind: 'template', template_id: id });
          state.picking = undefined;
          break;
        }

        case 'add-ing-schema':     state.ingredients.push(newIngredient('schema')); break;
        case 'add-ing-attribute':  state.ingredients.push(newIngredient('attribute')); break;
        case 'add-ing-collection': state.ingredients.push(newIngredient('collection')); break;
        case 'add-ing-token':      state.ingredients.push(newIngredient('token')); break;
        case 'ing-plus':  { const g = state.ingredients[i]; if ('amount' in g) g.amount += 1; break; }
        case 'ing-minus': { const g = state.ingredients[i]; if ('amount' in g) g.amount = Math.max(1, g.amount - 1); break; }
        case 'ing-burn':  { const g = state.ingredients[i]; if ('sendTo' in g) g.sendTo = ''; break; }
        case 'ing-keep':  { const g = state.ingredients[i]; if ('sendTo' in g && !g.sendTo) g.sendTo = state.actor; break; }
        case 'ing-del':   state.ingredients.splice(i, 1); break;

        case 'add-out-token':   state.outcomes.push({ kind: 'token', quantity: '', contract: 'eosio.token', weight: 1 }); break;
        case 'add-out-pool':    state.outcomes.push({ kind: 'pool', pool_name: '', weight: 1 }); break;
        case 'add-out-nothing': state.outcomes.push({ kind: 'nothing', weight: 1 }); break;
        case 'out-del':         state.outcomes.splice(i, 1); break;

        case 'add-req-attribute':
          state.requirements.push({ kind: 'attribute', attribute_name: firstUsableAttribute(false), values: '' });
          break;
        case 'req-del': state.requirements.splice(i, 1); break;

        case 'add-mutation':
          state.mutations.push({ attribute_name: firstUsableAttribute(true), op: UPGRADE_OP.SET, value: '' });
          break;
        case 'mut-set': state.mutations[i].op = UPGRADE_OP.SET; break;
        case 'mut-add': state.mutations[i].op = UPGRADE_OP.ADD; break;
        case 'mut-del': state.mutations.splice(i, 1); break;

        case 'mint-plus':  state.mints[i].quantity += 1; break;
        case 'mint-minus': state.mints[i].quantity = Math.max(1, state.mints[i].quantity - 1); break;
        case 'mint-del':   state.mints.splice(i, 1); break;

        case 'drop-free': state.free = true; break;
        case 'drop-paid': state.free = false; break;

        case 'simulate': void onSimulate(); return;
        case 'submit':   void onSubmit(); return;
      }
      render();
    });
  });

  // Plain text and select fields, keyed by id.
  const bind = (id: string, apply: (v: string) => void, repaint: 'live' | 'blur' = 'blur') => {
    const el = root.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`);
    if (!el) return;
    const isSelect = el.tagName === 'SELECT';
    el.addEventListener(isSelect ? 'change' : 'input', () => {
      apply(el.value);
      if (isSelect || repaint === 'live') render();
    });
    if (!isSelect) el.addEventListener('change', () => render());
  };

  bind('lab-search', (v) => { state.search = v; }, 'live');
  bind('lab-name', (v) => { state.name = v; });
  bind('lab-description', (v) => { state.description = v; });
  bind('lab-image', (v) => { state.image = v; });
  bind('lab-category', (v) => { state.category = v; });
  const pickCollection = (v: string) => {
    state.collection = v.trim();
    state.schemas = []; state.templates = []; state.securities = [];
    state.schemaName = ''; state.dataState = 'idle';
    if (state.collection) void loadCollectionData();
  };
  bind('lab-collection', pickCollection);
  // The manual box loads on blur or Enter, never per keystroke: every
  // half-typed name would otherwise fire its own round trip.
  bind('lab-collection-manual', (v) => { state.collection = v.trim(); });
  const manual = root.querySelector<HTMLInputElement>('#lab-collection-manual');
  if (manual) {
    const go = () => { if (manual.value.trim() !== state.loadedFor) pickCollection(manual.value); };
    manual.addEventListener('blur', go);
    manual.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') go(); });
  }
  bind('lab-schema', (v) => {
    state.schemaName = v;
    // Requirements and mutations name attributes of the OLD schema, and
    // silently keeping them would build a spec no NFT can satisfy.
    state.requirements = state.requirements.filter((r) => r.kind !== 'attribute');
    state.mutations = [];
  });
  bind('lab-start', (v) => { state.startTime = v; });
  bind('lab-end', (v) => { state.endTime = v; });
  bind('lab-max-uses', (v) => { state.maxUses = v; });
  bind('lab-account-limit', (v) => { state.accountLimit = v; });
  bind('lab-cooldown', (v) => { state.cooldown = v; });
  bind('lab-security', (v) => { state.securityId = v; });
  bind('lab-price-amount', (v) => { state.priceAmount = v; });
  bind('lab-price-token', (v) => { state.priceToken = v; });
  bind('lab-price-decimals', (v) => { state.priceDecimals = v; });
  bind('lab-price-recipient', (v) => { state.priceRecipient = v; });
  bind('lab-max-claimable', (v) => { state.maxClaimable = v; });
}
