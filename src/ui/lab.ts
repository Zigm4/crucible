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

import { renderCrucibleTool, attachCrucibleHandlers } from './crucibleLab';
import { getCurrentSession, login, logout } from '../chain/session';
import { atomicFetch } from '../chain/rpc';
import { listAuthorizedCollections, isContractAuthorized } from '../atomic/collections';
import { readCollectionSecurities, executeAdminAction } from '../nefty/admin';
import { clearDiscoverCache } from '../nefty/discover';
import { clearUpgradesCache } from '../nefty/upgrades';
import { clearDropsCache } from '../nefty/drops';
import { listDropTokens, type DropToken } from '../nefty/dropTokens';
import {
  readNameStatus, readMyBids, readTopBids, minimumNextBid, formatWax, QUIET_PERIOD_MS,
  buildBidName, buildBidRefund, readRefundsFor, canOutbid,
  buildClaimName, readAccountKeys,
  type NameAvailability, type BidHistoryEntry, type NameBid, type PendingRefund,
} from '../wax/names';
import { listBlends, type DiscoveredBlend } from '../nefty/discover';
import { listUpgrades, type DiscoveredUpgrade } from '../nefty/upgrades';
import { listDrops, type DiscoveredDrop } from '../nefty/drops';
import {
  buildSetBlendHide, buildSetBlendTime, buildSetBlendMax, buildSetBlendLim,
  buildSetBlendData, buildSetBlendCat, buildSetBlendSec, buildDelBlend,
} from '../nefty/admin';
import {
  buildSetUpgradeHide, buildSetUpgradeTime, buildSetUpgradeMax,
  buildSetUpgradeData, buildSetUpgradeCat, buildSetUpgradeSec, buildDelUpgrade,
} from '../nefty/upgradeAdmin';
import {
  buildSetDropHidden, buildSetDropTimes, buildSetDropMax, buildSetDropLimit,
  buildSetDropData, buildSetDropPrice, buildEraseDrop,
} from '../nefty/dropAdmin';
import { dryRunActions } from './dryrun';
import { renderMediaThumb } from './media';
import { pickImageRef } from '../atomic/image';
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

/** Create something new, or change something that already exists. */
type LabMode = 'create' | 'edit';

/**
 * Which tool the page is showing. The lab is a workbench, not one screen:
 * `recipes` is the blend / upgrade / drop creator and editor, `names` is
 * the WAX premium-name auction reader and bidder. They share nothing but
 * the wallet, so each keeps its own state.
 */
type LabTool = 'recipes' | 'names' | 'crucible';
/** Which of the two share buttons a copy came from. */
type ShareScope = 'tool' | 'auction';

/** One existing recipe, flattened to what the editor can change. */
interface LabExisting {
  id: string;
  kind: LabKind;
  name: string;
  status: string;
  /** Fields the contract lets an author change after creation. */
  hidden: boolean;
  startTime: string;
  endTime: string;
  maxUses: string;
  accountLimit: string;
  cooldown: string;
  description: string;
  image: string;
  category: string;
  securityId: string;
  /** Drops only. */
  free: boolean;
  priceAmount: string;
  priceToken: string;
}

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
  priceRecipient: string;
  /** Read from neftyblocksd's own config, not hardcoded. */
  tokens: DropToken[];
  tokenSearch: string;
  tokenPickerOpen: boolean;
  authRequired: boolean;
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
  tool: LabTool;
  mode: LabMode;
  /** Edit mode: what exists in this collection, and what is being changed. */
  existing: LabExisting[];
  existingState: LoadState;
  editing?: LabExisting;
  /** A snapshot of `editing` as loaded, so only real changes are signed. */
  editingOriginal?: LabExisting;
  step: number;
  /** Steps the author has actually worked on. Problems stay quiet until then,
      so the wizard explains rather than scolds someone who just arrived. */
  visited: boolean[];
  collections: { collection_name: string; name: string }[];
  collectionsState: LoadState;
  /** Which collection the loaded schemas/templates belong to. */
  loadedFor: string;
  dataState: LoadState;
  dataError: string;
  truncated: boolean;
  securities: { id: string; name: string }[];
  /**
   * Can the contract we are about to create on actually mint into this
   * collection? undefined = unknown. false = whatever gets created here
   * will be unrunnable by anyone.
   */
  contractAuthorized?: boolean;
  // ── the name-auction tool ──
  nameQuery: string;
  nameStatus?: NameAvailability;
  /** The name `nameStatus` is about, which is not always what is typed. */
  nameStatusFor: string;
  /** Which button just copied, so only that one says so. Momentary. */
  shareCopied: ShareScope | '';
  nameChecking: boolean;
  nameBidAmount: string;
  myBids: BidHistoryEntry[];
  myBidsState: LoadState;
  refunds: PendingRefund[];
  /** Claiming a name we won: the keys the new account will answer to. */
  claimOwnerKey: string;
  claimActiveKey: string;
  topBids: NameBid[];
  topBidsState: LoadState;

  picking?: { target: 'ingredient' | 'outcome' | 'mint' | 'requirement' };
  search: string;
  busy: boolean;
  dryRun: string;
  lastTx: string;
  lastError: string;
}

const state: LabState = {
  tool: 'recipes',
  mode: 'create',
  existing: [],
  existingState: 'idle',
  kind: 'blend',
  step: 0,
  visited: [],
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
  priceRecipient: '',
  tokens: [],
  tokenSearch: '',
  tokenPickerOpen: false,
  authRequired: false,
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
  nameQuery: '',
  nameStatusFor: '',
  shareCopied: '',
  nameChecking: false,
  nameBidAmount: '',
  myBids: [],
  myBidsState: 'idle',
  refunds: [],
  claimOwnerKey: '',
  claimActiveKey: '',
  topBids: [],
  topBidsState: 'idle',
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

/**
 * The decimals of the selected token, read from the contract's own list
 * rather than typed. A token the list does not know falls back to 8, which
 * is only reachable before the list has loaded.
 */
function tokenPrecision(): number {
  const t = state.tokens.find((x) => x.ticker === state.priceToken.trim().toUpperCase());
  return t ? t.precision : 8;
}

/** The contract that issues the selected token, needed for nothing here
 *  but worth showing: two tokens can share a ticker across contracts. */
function tokenContract(): string {
  return state.tokens.find((x) => x.ticker === state.priceToken.trim().toUpperCase())?.contract ?? '';
}

const totalWeight = () => state.outcomes.reduce((n, o) => n + o.weight, 0) || 1;

const OUTCOME_COLOURS = ['#7c9cff', '#86c97f', '#f0a860', '#e8798f', '#c58cf5', '#5ec8d8', '#d8c85e', '#8fd8b0'];

// ─── loading from the chain ─────────────────────────────────────────────

let rerender: () => void = () => {};

/**
 * Typing into a field and then clicking a button used to lose the click.
 *
 * The sequence: pressing the mouse blurs the input, which fires `change`,
 * which re-renders. A render replaces the whole panel, so by the time the
 * button is released it is a DIFFERENT element, and a click only fires
 * when press and release land on the same one. The first click vanished
 * and the second worked, because by then nothing had changed.
 *
 * So a repaint asked for while the pointer is down waits for the release.
 * The state is already up to date, applied on `input`; only the redraw
 * moves, and only by the length of a click.
 *
 * These listeners live at module level and are attached once. `#root`
 * survives every render, so wiring them inside the render pass would stack
 * a new listener each time.
 */
let pointerHeld = false;
let repaintQueued = false;
let pointerWired = false;

function wirePointerGuard(root: HTMLElement) {
  if (pointerWired) return;
  pointerWired = true;
  root.addEventListener('pointerdown', () => { pointerHeld = true; }, true);
  const release = () => {
    pointerHeld = false;
    if (repaintQueued) { repaintQueued = false; rerender(); }
  };
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
}

/** Repaint now, or right after the pointer is released. */
function deferrableRender() {
  if (pointerHeld) { repaintQueued = true; return; }
  rerender();
}

/**
 * The tokens a drop may be priced in. Loaded lazily the first time the
 * drop path is opened, because a blend author never needs it.
 */
async function loadDropTokens() {
  if (state.tokens.length) return;
  const tokens = await listDropTokens();
  if (!tokens.length) return;
  state.tokens = tokens;
  // Keep whatever was chosen if the list knows it, otherwise start on WAX.
  if (!tokens.some((t) => t.ticker === state.priceToken)) {
    state.priceToken = tokens[0]?.ticker ?? 'WAX';
  }
  rerender();
}

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
    // Checked here rather than at review time: an author who learns this
    // on the last screen has already done all the work.
    void refreshCreateAuth(collection);
    if (!state.schemaName && state.schemas.length) state.schemaName = state.schemas[0].schema_name;
    state.loadedFor = collection;
    state.dataState = 'done';
  } catch (err) {
    state.dataState = 'error';
    state.dataError = err instanceof Error ? err.message : String(err);
  }
  rerender();
}

// ─── edit mode: read what exists, write what changed ───────────────────

const unixToLocal = (t: number) =>
  t ? new Date(t * 1000).toISOString().slice(0, 16) : '';

/**
 * Lists what this collection already has, for the kind being edited. Reads
 * the same discovery each tab uses, including inactive entries, because an
 * author editing something usually wants the hidden or ended one.
 */
async function loadExisting() {
  const collection = state.collection.trim();
  if (!collection) return;
  state.existingState = 'loading';
  state.existing = [];
  rerender();
  try {
    let rows: LabExisting[] = [];
    if (state.kind === 'blend') {
      const { blends } = await listBlends({ collection, includeInactive: true });
      rows = blends.map(fromBlend);
    } else if (state.kind === 'upgrade') {
      const { upgrades } = await listUpgrades({ collection, includeInactive: true });
      rows = upgrades.map(fromUpgrade);
    } else {
      const { drops } = await listDrops({ collection, includeInactive: true });
      rows = drops.map(fromDrop);
    }
    state.existing = rows;
    state.existingState = 'done';
  } catch (err) {
    state.existingState = 'error';
    state.dataError = err instanceof Error ? err.message : String(err);
  }
  rerender();
}

const BLANK_EXISTING = {
  hidden: false, startTime: '', endTime: '', maxUses: '', accountLimit: '',
  cooldown: '', description: '', image: '', category: '', securityId: '',
  free: true, priceAmount: '', priceToken: '',
};

function fromBlend(b: DiscoveredBlend): LabExisting {
  return {
    ...BLANK_EXISTING,
    id: String(b.blend_id), kind: 'blend', name: b.name || `blend ${b.blend_id}`,
    status: String(b.status),
  };
}

function fromUpgrade(u: DiscoveredUpgrade): LabExisting {
  return {
    ...BLANK_EXISTING,
    id: String(u.upgrade_id), kind: 'upgrade', name: u.name || `upgrade ${u.upgrade_id}`,
    status: String(u.status),
    description: u.description ?? '', image: u.image ?? '',
    startTime: unixToLocal(u.start_time), endTime: unixToLocal(u.end_time),
    maxUses: u.max ? String(u.max) : '',
  };
}

function fromDrop(d: DiscoveredDrop): LabExisting {
  const [amount, ticker] = String(d.listing_price ?? '').split(' ');
  return {
    ...BLANK_EXISTING,
    id: String(d.drop_id), kind: 'drop', name: d.name || `drop ${d.drop_id}`,
    status: String(d.status),
    description: d.description ?? '',
    startTime: unixToLocal(d.start_time), endTime: unixToLocal(d.end_time),
    maxUses: d.max_claimable ? String(d.max_claimable) : '',
    accountLimit: d.account_limit ? String(d.account_limit) : '',
    cooldown: d.account_limit_cooldown ? String(d.account_limit_cooldown) : '',
    free: Boolean(d.is_free),
    priceAmount: d.is_free ? '' : (amount ?? ''),
    priceToken: d.is_free ? '' : (ticker ?? ''),
  };
}

/**
 * Only what actually changed, as one action each.
 *
 * Every one of these is a separate on-chain action: the contracts have no
 * "update everything" call. Building only the diff keeps a save from
 * re-signing six unchanged fields, and lets the confirmation list exactly
 * what is about to happen.
 */
function editActions(): { label: string; action: ReturnType<typeof buildSetBlendHide> }[] {
  const e = state.editing, o = state.editingOriginal;
  if (!e || !o) return [];
  const actor = state.actor;
  const out: { label: string; action: ReturnType<typeof buildSetBlendHide> }[] = [];
  const changed = (k: keyof LabExisting) => e[k] !== o[k];

  const displayData = () => {
    const dd: Record<string, string> = {};
    if (e.name.trim()) dd.name = e.name.trim();
    if (e.description.trim()) dd.description = e.description.trim();
    if (e.image.trim()) dd.image = e.image.trim();
    return JSON.stringify(dd);
  };

  if (e.kind === 'blend') {
    if (changed('name') || changed('description') || changed('image')) {
      out.push({ label: 'name, description and image', action: buildSetBlendData(actor, e.id, displayData()) });
    }
    if (changed('category')) out.push({ label: 'category', action: buildSetBlendCat(actor, e.id, e.category.trim()) });
    if (changed('hidden')) out.push({ label: e.hidden ? 'hide it' : 'reveal it', action: buildSetBlendHide(actor, e.id, e.hidden) });
    if (changed('startTime') || changed('endTime')) {
      out.push({ label: 'time window', action: buildSetBlendTime(actor, e.id, toUnix(e.startTime), toUnix(e.endTime)) });
    }
    if (changed('maxUses')) out.push({ label: 'total uses', action: buildSetBlendMax(actor, e.id, intOr(e.maxUses)) });
    if (changed('accountLimit') || changed('cooldown')) {
      out.push({ label: 'per-wallet limit', action: buildSetBlendLim(actor, e.id, intOr(e.accountLimit), intOr(e.cooldown)) });
    }
    if (changed('securityId')) out.push({ label: 'whitelist', action: buildSetBlendSec(actor, e.id, e.securityId || 0) });
  }

  if (e.kind === 'upgrade') {
    if (changed('name') || changed('description') || changed('image')) {
      out.push({ label: 'name, description and image', action: buildSetUpgradeData(actor, e.id, displayData()) });
    }
    if (changed('category')) out.push({ label: 'category', action: buildSetUpgradeCat(actor, e.id, e.category.trim()) });
    if (changed('hidden')) out.push({ label: e.hidden ? 'hide it' : 'reveal it', action: buildSetUpgradeHide(actor, e.id, e.hidden) });
    if (changed('startTime') || changed('endTime')) {
      out.push({ label: 'time window', action: buildSetUpgradeTime(actor, e.id, toUnix(e.startTime), toUnix(e.endTime)) });
    }
    if (changed('maxUses')) out.push({ label: 'total uses', action: buildSetUpgradeMax(actor, e.id, intOr(e.maxUses)) });
    if (changed('securityId')) out.push({ label: 'whitelist', action: buildSetUpgradeSec(actor, e.id, e.securityId || 0) });
  }

  if (e.kind === 'drop') {
    if (changed('name') || changed('description') || changed('image')) {
      out.push({ label: 'name, description and image', action: buildSetDropData(actor, e.id, displayData()) });
    }
    if (changed('hidden')) out.push({ label: e.hidden ? 'hide it' : 'reveal it', action: buildSetDropHidden(actor, e.id, e.hidden) });
    if (changed('startTime') || changed('endTime')) {
      out.push({ label: 'time window', action: buildSetDropTimes(actor, e.id, toUnix(e.startTime), toUnix(e.endTime)) });
    }
    if (changed('maxUses')) out.push({ label: 'total supply', action: buildSetDropMax(actor, e.id, intOr(e.maxUses)) });
    if (changed('accountLimit') || changed('cooldown')) {
      out.push({ label: 'per-wallet limit', action: buildSetDropLimit(actor, e.id, intOr(e.accountLimit), intOr(e.cooldown)) });
    }
    if (changed('free') || changed('priceAmount') || changed('priceToken')) {
      const p = e.free
        ? { listing_price: FREE_LISTING_PRICE, settlement_symbol: FREE_SETTLEMENT_SYMBOL }
        : formatListing(Number(e.priceAmount) || 0, e.priceToken, editTokenPrecision());
      out.push({ label: 'price', action: buildSetDropPrice(actor, e.id, p.listing_price, p.settlement_symbol) });
    }
  }
  return out;
}

/** Precision for the token chosen while editing a drop. */
function editTokenPrecision(): number {
  const t = state.tokens.find((x) => x.ticker === (state.editing?.priceToken ?? '').trim().toUpperCase());
  return t ? t.precision : 8;
}

/** The one action that is not a field edit, and cannot be undone. */
function deleteAction() {
  const e = state.editing;
  if (!e) return undefined;
  if (e.kind === 'blend') return buildDelBlend(state.actor, e.id);
  if (e.kind === 'upgrade') return buildDelUpgrade(state.actor, e.id);
  return buildEraseDrop(state.actor, e.id);
}

/**
 * Is the contract this page is about to create on allowed to mint into
 * the chosen collection? Re-read whenever the kind changes, because the
 * three kinds ask about three different contracts.
 */
const CONTRACT_FOR: Record<LabKind, string> = {
  blend: 'blend.nefty',
  upgrade: 'up.nefty',
  drop: 'neftyblocksd',
};

async function refreshCreateAuth(collection: string) {
  state.contractAuthorized = undefined;
  const ok = await isContractAuthorized(collection, CONTRACT_FOR[state.kind]);
  if (ok !== undefined) {
    state.contractAuthorized = ok;
    rerender();
  }
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
    : formatListing(Number(state.priceAmount) || 0, state.priceToken, tokenPrecision());
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
    // Off, always: see the note on the price step. The payment path it
    // switches on has been dead since neftybrespay stopped signing.
    allow_credit_card_payments: false,
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
type Problem = { step: number; text: string };

/**
 * Every reason this recipe cannot be created, each tagged with the step that
 * owns the field at fault. The tag is the whole point: without it the wizard
 * can only complain on the review screen, which is four steps after the author
 * could have fixed it. Steps are 0 collection, 1 what players give or what it
 * mints, 2 what they get or price or changes, 3 rules, 4 review.
 */
/**
 * The whole-recipe validators, run defensively.
 *
 * They used to be reached only from the review screen, so they could assume a
 * recipe complete enough to assemble into contract arguments. Per-step
 * validation calls them from step 0 onwards, where that assumption does not
 * hold and the argument builders can throw on half-filled state. A throw here
 * is not a silent pass: it can only happen while the recipe is still
 * incomplete, and the field-level checks above already say what is missing.
 */
function wholeRecipe(run: () => string[]): string[] {
  try {
    return run();
  } catch {
    return [];
  }
}

function taggedProblems(): Problem[] {
  const out: Problem[] = [];
  const at = (step: number, text: string) => out.push({ step, text });

  // A missing wallet is deliberately filed under review rather than step 0.
  // It blocks signing, which is correct, but it must not block an author from
  // building a recipe before they connect.
  if (!state.actor) at(4, 'Connect a wallet to sign.');
  if (!state.collection.trim()) at(0, 'Pick the collection this belongs to.');
  // Filed under review, not step 0. Authorisation is not a field the author
  // fills in, it is an external precondition discovered asynchronously, and
  // walling off the wizard on it would stop anyone exploring the tool against
  // a collection they have not authorised yet. It still blocks signing.
  if (state.contractAuthorized === false) {
    at(4,
      `${state.collection} has not authorized ${CONTRACT_FOR[state.kind]}, so the contract could not ` +
      'mint and nobody could ever run this. Add it to the collection on AtomicHub first.',
    );
  }

  if (state.kind === 'drop') {
    if (state.mints.length === 0) at(1, 'Add at least one template for the drop to mint.');
    if (!state.unlimited && intOr(state.maxClaimable) === 0) at(2, 'Set a max supply, or tick "unlimited".');
    if (!state.free) {
      if (!(Number(state.priceAmount) > 0)) at(2, 'Set a price above zero, or make the drop free.');
      const picked = state.priceToken.trim().toUpperCase();
      if (!picked) at(2, 'Pick the token players pay in.');
      else if (state.tokens.length && !state.tokens.some((t) => t.ticker === picked)) {
        // The list is the contract's own, so this is not a style rule: a
        // drop priced in a token neftyblocksd does not know is rejected.
        at(2, `"${picked}" is not in the ${state.tokens.length} tokens neftyblocksd accepts, so the drop would be rejected.`);
      }
    }
  } else {
    if (state.ingredients.length === 0) at(1, 'Add at least one thing the player gives up.');
    // The shared upgrade validator does not look at ingredients at all, so
    // these checks have to run for both contracts rather than only blends.
    for (const i of state.ingredients) {
      if (i.kind === 'token') {
        if (!/^\d+(\.\d+)? [A-Z]{1,7}$/.test(i.quantity.trim())) {
          at(1, `"${i.quantity.trim() || 'empty'}" is not a token amount. Write it with the token's exact decimals, e.g. 10.00000000 WAX.`);
        }
        if (!i.to.trim()) at(1, 'A token cost with no receiving account would burn the tokens. Name an account.');
      } else if ('amount' in i && i.amount < 1) {
        at(1, 'An ingredient asks for fewer than one NFT.');
      }
      if (i.kind === 'attribute' && splitValues(i.values).length === 0) {
        at(1, `Ingredient on ${i.attribute_name} lists no allowed value.`);
      }
    }
  }

  if (state.kind === 'blend') {
    if (state.outcomes.length === 0) at(2, 'Add at least one outcome.');
    if (state.outcomes.length && state.outcomes.every((o) => o.kind === 'nothing')) {
      at(2, 'Every outcome is blank, so a player could never win anything.');
    }
    // The whole-recipe validators are filed under Rules, the last step before
    // review. They judge the assembled arguments rather than one field, so
    // pinning them to an earlier step would block a page whose own fields are
    // all fine and name a problem that lives somewhere else.
    for (const t of wholeRecipe(() => validateNewBlend(blendArgs()))) at(3, t);
  }

  if (state.kind === 'upgrade') {
    if (!state.schemaName) at(2, 'Pick the schema the upgrade applies to.');
    if (state.mutations.length === 0) at(2, 'Add at least one attribute change.');
    for (const m of state.mutations) {
      if (!m.attribute_name) { at(2, 'An attribute change has no attribute selected.'); continue; }
      const type = schemaType(state.schemaName, m.attribute_name);
      const why = attributeBlock(state.schemaName, m.attribute_name, true);
      if (why) at(2, `"${m.attribute_name}" cannot be rewritten: ${why}.`);
      if (!String(m.value).trim()) at(2, `"${m.attribute_name}" has no value.`);
      else if (isNumericType(type) && !Number.isFinite(Number(m.value))) {
        at(2, `"${m.attribute_name}" is declared ${type} on the schema, so its value must be a number.`);
      }
      if (m.op === UPGRADE_OP.ADD && !isNumericType(type)) {
        at(2, `"${m.attribute_name}" is ${type}, which cannot be added to. Use "is set to".`);
      }
    }
    for (const r of state.requirements) {
      if (r.kind === 'attribute' && splitValues(r.values).length === 0) {
        at(2, `The condition on "${r.attribute_name}" lists no value to match.`);
      }
    }
    for (const t of wholeRecipe(() => validateNewUpgrade(upgradeArgs()))) at(3, t);
  }

  const start = toUnix(state.startTime);
  const end = toUnix(state.endTime);
  if (end !== 0 && start !== 0 && end <= start) at(3, 'The end time is not after the start time.');
  // An empty start means "now", so an end in the past would be created
  // already finished. Comparing only start against end misses that.
  if (end !== 0 && end <= Math.floor(Date.now() / 1000)) {
    at(3, 'The end time is in the past, so this would be over before it began.');
  }

  return out;
}

/** Every problem, whatever step owns it. The review screen shows this. */
function problems(): string[] {
  return [...new Set(taggedProblems().map((p) => p.text))];
}

/** Only what an author can fix without leaving the step they are on. */
function stepProblems(step: number): string[] {
  return [...new Set(taggedProblems().filter((p) => p.step === step).map((p) => p.text))];
}

/** The first step that is not complete. The rail cannot jump past it. */
function firstIncompleteStep(): number {
  for (let i = 0; i < STEP_COUNT - 1; i++) if (stepProblems(i).length) return i;
  return STEP_COUNT - 1;
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

/** Whether the wallet's bid history was ever asked for. Test-only. */
export function __myBidsState(): string {
  return state.myBidsState;
}

/** Reads back where the workbench thinks it is. Test-only. */
export function __where(): { tool: string; nameStatusFor: string; kind: string } {
  return {
    tool: state.tool,
    nameStatusFor: state.nameStatusFor,
    kind: state.nameStatus ? state.nameStatus.kind : 'none',
  };
}

/**
 * The page signs real transactions, so it needs its own way to connect.
 *
 * `#/lab` renders standalone: the app's render loop returns before it ever
 * reaches the main Connect card, so a visitor who lands here from a shared
 * link had no way to attach a wallet without going back to the app first.
 */
function walletBar(): string {
  if (state.actor) {
    return `
      <div class="lab-wallet">
        <span class="lab-wallet-dot" aria-hidden="true"></span>
        <span>Signed in as <strong>${esc(state.actor)}</strong></span>
        <button class="lab-ghost lab-wallet-btn" data-lab="logout">Disconnect</button>
      </div>`;
  }
  return `
    <div class="lab-wallet lab-wallet-off">
      <span class="lab-wallet-dot" aria-hidden="true"></span>
      <span>Not connected. Nothing on this page can be signed until a wallet is attached.</span>
      <button class="lab-primary lab-wallet-btn" data-lab="login" ${state.busy ? 'disabled' : ''}>
        ${state.busy ? 'Opening your wallet' : 'Connect wallet'}
      </button>
    </div>`;
}

/** Attaching a wallet changes what every tool on the page can do. */
async function onLabLogin() {
  state.busy = true; state.lastError = '';
  rerender();
  try {
    await login();
    state.actor = String(getCurrentSession()?.actor ?? '');
    // The collection list is per-wallet, so it has to be re-read.
    state.collectionsState = 'idle';
    await loadCollections();
    // So is the bid history, and the names tool is where a shared link
    // lands. Whoever follows one arrives signed out, connects, and would
    // otherwise be told "No bid found" as a fact, with any refund the
    // contract owes them left off the page.
    if (state.tool === 'names' && state.actor) {
      state.myBidsState = 'idle';
      void loadMyBids();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Closing the wallet popup is a choice, not a failure worth shouting.
    if (!/cancel|abort|closed|declin/i.test(msg)) state.lastError = msg;
  }
  state.busy = false;
  rerender();
}

async function onLabLogout() {
  await logout().catch(() => {});
  state.actor = '';
  state.collections = [];
  state.collectionsState = 'idle';
  rerender();
}

// ─── deep links ─────────────────────────────────────────────────────────
//
// The workbench is several tools behind one path, so a bare #/lab is not
// enough to send someone to what you are looking at. The grammar mirrors
// the app's own: #/lab/<tool>, then whatever that tool is showing.
//
//   #/lab                 the workbench, on whichever tool was last used
//   #/lab/recipes         the creator and editor
//   #/lab/names           the name auctions, with the leaderboard
//   #/lab/names/rekt      that auction, already looked up
//
// Writing uses replaceState so it never fires hashchange: the URL follows
// the page, and the page follows an incoming URL, but the two never chase
// each other.

/**
 * Copies the current link. The lab renders standalone, so it cannot reach
 * the app's own share button and gets its own; the label doubles as the
 * feedback, since a silent copy leaves the user wondering.
 */
function shareButton(scope: ShareScope, label: string): string {
  const done = state.shareCopied === scope;
  return `<button class="lab-share" data-lab="share-${scope}">&#9112; ${esc(done ? 'copied' : label)}</button>`;
}

/**
 * The two buttons promise different things, so they copy different
 * things: the tool bar sends someone to the workbench, the auction row
 * sends them to one name already looked up.
 */
function labHref(scope: ShareScope): string {
  const base = location.href.split('#')[0];
  const subject = scope === 'auction' && state.nameStatusFor ? `/${encodeSubject(state.nameStatusFor)}` : '';
  return `${base}#/lab/${state.tool}${subject}`;
}

// A verdict is worth sharing even when the answer is "that is not a name",
// and the input takes anything typed. So the subject is not always made of
// characters a URL leaves alone: a space became %20, and the recipient then
// got a verdict about the literal text "a%20b". Encoding on the way out and
// decoding on the way in is what makes the link reproduce what was on
// screen. Real names are a to z, 1 to 5 and dots, none of which encoding
// touches, so shareable links stay readable.

function encodeSubject(name: string): string {
  try { return encodeURIComponent(name); } catch { return ''; }
}

function decodeSubject(raw: string): string {
  // A lone percent sign is a malformed escape and throws. A hand-mangled
  // URL is still a visitor, so fall back to the literal text.
  try { return decodeURIComponent(raw); } catch { return raw; }
}

async function onCopyLabLink(scope: ShareScope) {
  try {
    await navigator.clipboard?.writeText(labHref(scope));
    state.shareCopied = scope;
    // A copy that worked must not leave the previous failure on screen.
    if (state.lastError.startsWith('Could not reach the clipboard')) state.lastError = '';
    rerender();
    // Back to the neutral label, so the next copy still says something.
    setTimeout(() => {
      // Another button may have been copied since; do not clear its badge.
      if (state.shareCopied === scope) state.shareCopied = '';
      rerender();
    }, 2000);
  } catch {
    state.lastError = 'Could not reach the clipboard. The link is in the address bar.';
    rerender();
  }
}

/**
 * Writes the current position into the address bar.
 *
 * Only while the lab is still the page on screen. A name lookup takes two
 * chain reads, and the visitor can click "Back to the app" while they are
 * outstanding; writing then would leave the app page under a #/lab address,
 * and since replaceState fires no hashchange nothing would ever correct it.
 * Reloading or copying the URL would send them somewhere they had left.
 */
function writeLabHash() {
  try {
    if (!location.hash.startsWith('#/lab')) return;
    const subject = state.tool === 'names' && state.nameStatusFor ? `/${encodeSubject(state.nameStatusFor)}` : '';
    const target = `#/lab/${state.tool}${subject}`;
    if (location.hash === target) return;
    history.replaceState(null, '', target);
  } catch { /* a hash we cannot write is not worth failing a render over */ }
}

/**
 * Opens the workbench where a link points. Called on arrival and on every
 * hash change, so a pasted link, a bookmark and the back button all land
 * in the same place.
 */
export function applyLabRoute(tool: string, subject: string): void {
  if (tool === 'names' || tool === 'recipes' || tool === 'crucible') state.tool = tool;
  const wanted = state.tool === 'names' ? decodeSubject(subject).trim().toLowerCase() : '';
  // A bare #/lab is not a link anyone can share back, so fill it in. Not
  // when a name is still being looked up: that would write the previous
  // name over the one just asked for.
  if (!wanted) writeLabHash();
  if (state.tool !== 'names') return;
  // The same reads the tool bar performs, because arriving by link has to
  // show the same page as arriving by click. Without the bid history the
  // panel states "No bid found" as a fact and hides claimable refunds,
  // which is worse than saying nothing.
  if (state.topBidsState === 'idle') void loadTopBids();
  if (state.actor && state.myBidsState === 'idle') void loadMyBids();
  if (!wanted) return;
  // Skip only what is already answered or already on its way. Comparing
  // against nameQuery alone would also match a name merely TYPED and never
  // submitted, and then the link would be ignored: the address bar would
  // name one auction while the card below still showed another.
  const answered = wanted === state.nameStatusFor;
  const inFlight = state.nameChecking && wanted === state.nameQuery.trim().toLowerCase();
  if (answered || inFlight) return;
  state.nameQuery = wanted;
  void onCheckName();
}

// ─── shared UI pieces ───────────────────────────────────────────────────

/**
 * What is stopping this step, shown at the top of it. Silent until the author
 * has touched the step: arriving on a blank page to a list of complaints reads
 * as being told off for something you have not had a chance to do yet.
 */
function stepBlockers(): string {
  if (state.step === STEP_COUNT - 1) return '';
  const list = stepProblems(state.step);
  if (!list.length || !state.visited[state.step]) return '';
  return `
    <div class="lab-callout danger">
      <strong>${list.length === 1 ? 'One thing to fix' : `${list.length} things to fix`} before this step is done.</strong>
      <ul class="lab-list">${list.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
    </div>`;
}

function stepRail(): string {
  return `
    <ol class="lab-rail">
      ${steps().map((label, i) => {
        const done = i < state.step && stepProblems(i).length === 0;
        // Going back is always allowed. Going forward stops at the first step
        // that is not finished, so the rail cannot be used to skip the
        // Continue button it would otherwise have to get past.
        const reachable = i <= state.step || i <= firstIncompleteStep();
        return `
        <li class="lab-rail-step${i === state.step ? ' current' : ''}${done ? ' done' : ''}"
            data-lab="step" data-step="${i}"${reachable ? '' : ' aria-disabled="true"'}>
          <span class="lab-rail-dot">${done ? '&check;' : i + 1}</span>
          <span class="lab-rail-label">${esc(label)}</span>
        </li>`;
      }).join('')}
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
      ${state.contractAuthorized === false ? `
        <div class="lab-callout danger">
          <strong>${esc(state.collection)} has not authorized <code>${esc(CONTRACT_FOR[state.kind])}</code>.</strong>
          AtomicAssets only lets accounts on a collection's authorized list mint its NFTs, so
          anything created here would exist on chain and be unrunnable by everyone. Add
          <code>${esc(CONTRACT_FOR[state.kind])}</code> to the collection on AtomicHub, then come back.
          This is not a warning you can sign past: 45 live recipes on one collection are in exactly
          this state today because nobody checked.
        </div>` : ''}
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

/**
 * The token control. 162 entries is well past what a plain dropdown is
 * good for, so it is a button that opens a filtered list: type two letters
 * and the list narrows. Closed, it just states the choice.
 */
function tokenPickerControl(): string {
  if (!state.tokenPickerOpen) {
    return `
      <button class="lab-token-btn" data-lab="token-open">
        <strong>${esc(state.priceToken || 'pick a token')}</strong>
        ${state.tokens.length ? `<span>${tokenPrecision()} decimals</span>` : ''}
      </button>`;
  }
  const q = state.tokenSearch.trim().toLowerCase();
  const list = state.tokens.filter(
    (t) => !q || t.ticker.toLowerCase().includes(q) || t.contract.toLowerCase().includes(q),
  );
  const shown = list.slice(0, 60);
  return `
    <div class="lab-token-picker">
      <input id="lab-token-search" type="text" placeholder="Type a ticker, e.g. DUST"
             value="${esc(state.tokenSearch)}" autocomplete="off" />
      ${shown.length
        ? `<div class="lab-token-grid">
             ${shown.map((t) => `
               <button class="lab-token${t.ticker === state.priceToken ? ' on' : ''}"
                       data-lab="token-pick" data-ticker="${esc(t.ticker)}">
                 <strong>${esc(t.ticker)}</strong>
                 <span>${t.precision} dec &middot; ${esc(t.contract)}</span>
               </button>`).join('')}
           </div>
           ${list.length > shown.length ? `<p class="lab-note">${list.length - shown.length} more. Keep typing to narrow it.</p>` : ''}`
        : `<p class="lab-note">No accepted token matches "${esc(state.tokenSearch)}". The list comes from the contract, so anything missing is a token drops cannot be priced in.</p>`}
      <button class="lab-ghost" data-lab="token-close">Cancel</button>
    </div>`;
}

function stepPrice(): string {
  return `
    <h3 class="lab-q">What does a claim cost?</h3>
    <p class="lab-hint">Free drops are the common case. If you charge, pick the token by name: its decimals and its contract come from the chain.</p>

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
          ${tokenPickerControl()}
        </div>
        ${state.tokens.length
          ? `<p class="lab-note">${state.tokens.length} tokens accepted by <code>neftyblocksd</code>.
               <strong>${esc(state.priceToken)}</strong> has ${tokenPrecision()} decimals${
                 tokenContract() ? ` and is issued by <code>${esc(tokenContract())}</code>` : ''
               }, both read from the contract so you never type them.</p>`
          : '<p class="lab-note">Loading the list of accepted tokens from the chain.</p>'}
      </div>

      <div class="lab-field">
        <label>Payments go to</label>
        <input id="lab-price-recipient" type="text" value="${esc(state.priceRecipient)}" placeholder="${esc(state.actor || 'your.wam')}" autocomplete="off" />
        <p class="lab-note">Empty means your own account, ${esc(state.actor || 'the signing wallet')}.</p>
      </div>

      <div class="lab-callout danger">
        <strong>Credit card payments are not offered here, and the flag is left off.</strong>
        They never happened on chain: NeftyBlocks took the card off chain, then had
        <code>neftybrespay</code> call <code>triggerclaim</code> to mint for the buyer. That is the
        same account that used to pay everyone's CPU and stopped signing, and
        <code>triggerclaim</code> has not been called since. Ticking it would only add the drop to a
        list nobody reads, while advertising to players a way to pay that cannot complete.
      </div>`}

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

// ─── edit mode: the screen ──────────────────────────────────────────────

function editPicker(): string {
  const kinds: { k: LabKind; label: string }[] = [
    { k: 'blend', label: 'Blends' }, { k: 'upgrade', label: 'Upgrades' }, { k: 'drop', label: 'Drops' },
  ];
  return `
    <h3 class="lab-q">What do you want to change?</h3>
    <p class="lab-hint">
      Everything below already exists on chain. Pick one and you can change what its
      contract allows an author to change after creation.
    </p>

    <div class="lab-field">
      <label>Collection</label>
      ${state.collections.length
        ? `<select id="lab-collection">
             <option value=""${state.collection ? '' : ' selected'}>Choose a collection</option>
             ${state.collections.map((c) => `<option value="${esc(c.collection_name)}"${c.collection_name === state.collection ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}
           </select>`
        : `<input id="lab-collection-manual" type="text" value="${esc(state.collection)}"
                  placeholder="collection name" autocomplete="off" />`}
    </div>

    <div class="lab-field">
      <label>Kind</label>
      <div class="lab-seg">
        ${kinds.map((k) => `<button class="${state.kind === k.k ? 'on' : ''}" data-lab="edit-kind" data-kind="${k.k}">${k.label}</button>`).join('')}
      </div>
    </div>

    ${!state.collection
      ? '<p class="lab-empty">Pick a collection first.</p>'
      : state.existingState === 'loading'
        ? '<p class="lab-hint">Reading what this collection already has.</p>'
        : state.existingState === 'error'
          ? `<p class="lab-warn">Could not read them: ${esc(state.dataError)} <button class="lab-link" data-lab="reload-existing">Try again</button></p>`
          : state.existing.length === 0
            ? `<p class="lab-empty">No ${state.kind} found on ${esc(state.collection)}, including hidden and ended ones.</p>`
            : `<div class="lab-rows">
                 ${state.existing.map((e, i) => `
                   <div class="lab-row">
                     <span class="lab-tag">#${esc(e.id)}</span>
                     <span class="lab-row-main">
                       <strong>${esc(e.name)}</strong>
                       <span class="lab-tpl-meta">${esc(e.status)}</span>
                     </span>
                     <button class="lab-add" data-lab="edit-pick" data-idx="${i}">Change this one</button>
                   </div>`).join('')}
               </div>`}`;
}

function editForm(): string {
  const e = state.editing!;
  const changes = editActions();
  const isDrop = e.kind === 'drop';
  return `
    <h3 class="lab-q">${esc(e.name)} <span class="lab-tag">#${esc(e.id)}</span></h3>
    <p class="lab-hint">
      Each change below is a separate action the contract has to accept, so only what you
      actually touch gets signed. What is missing from this list is missing because no
      contract action exists for it.
    </p>

    <div class="lab-field">
      <label>Name</label>
      <input id="lab-edit-name" type="text" value="${esc(e.name)}" autocomplete="off" />
    </div>
    <div class="lab-field">
      <label>Description <span class="lab-note">optional</span></label>
      <input id="lab-edit-description" type="text" value="${esc(e.description)}" autocomplete="off" />
    </div>
    <div class="lab-field">
      <label>Thumbnail <span class="lab-note">an IPFS hash, not a URL</span></label>
      <input id="lab-edit-image" type="text" value="${esc(e.image)}" placeholder="Qm... or baf..." autocomplete="off" />
    </div>
    ${isDrop ? '' : `
      <div class="lab-field">
        <label>Category <span class="lab-note">optional, cosmetic</span></label>
        <input id="lab-edit-category" type="text" value="${esc(e.category)}" autocomplete="off" />
      </div>`}

    ${isDrop ? `
      <div class="lab-field">
        <label>Price</label>
        <div class="lab-seg">
          <button class="${e.free ? 'on' : ''}" data-lab="edit-free">Free</button>
          <button class="${e.free ? '' : 'on'}" data-lab="edit-paid">Paid</button>
        </div>
        ${e.free ? '' : `
          <div class="lab-gate" style="margin-top:8px">
            <input id="lab-edit-price" type="text" value="${esc(e.priceAmount)}" placeholder="1" autocomplete="off" />
            ${editTokenControl()}
          </div>`}
      </div>` : ''}

    <div class="lab-field">
      <label>Runs from</label>
      <div class="lab-pair">
        <label class="lab-mini">Starts<input id="lab-edit-start" type="datetime-local" value="${esc(e.startTime)}" /></label>
        <label class="lab-mini">Ends<input id="lab-edit-end" type="datetime-local" value="${esc(e.endTime)}" /></label>
      </div>
    </div>

    <div class="lab-field">
      <label>${isDrop ? 'Total supply' : 'Total uses'} <span class="lab-note">empty means unlimited</span></label>
      <input id="lab-edit-max" type="number" min="0" value="${esc(e.maxUses)}" placeholder="unlimited" />
    </div>

    ${e.kind === 'upgrade' ? '' : `
      <div class="lab-field">
        <label>Per wallet</label>
        <div class="lab-pair">
          <label class="lab-mini">Max per wallet<input id="lab-edit-limit" type="number" min="0" value="${esc(e.accountLimit)}" placeholder="0" /></label>
          <label class="lab-mini">Cooldown in seconds<input id="lab-edit-cooldown" type="number" min="0" value="${esc(e.cooldown)}" placeholder="0" /></label>
        </div>
      </div>`}

    ${isDrop ? '' : `
      <div class="lab-field">
        <label>Who can use it</label>
        ${state.securities.length
          ? `<select id="lab-edit-security">
               <option value=""${e.securityId ? '' : ' selected'}>Everyone, no whitelist</option>
               ${state.securities.map((x) => `<option value="${esc(x.id)}"${x.id === e.securityId ? ' selected' : ''}>Only "${esc(x.name)}" (#${esc(x.id)})</option>`).join('')}
             </select>`
          : '<p class="lab-note">This collection has no whitelist.</p>'}
      </div>`}

    <label class="lab-check">
      <input type="checkbox" ${e.hidden ? 'checked' : ''} data-lab="edit-hidden" />
      <span><strong>Hidden</strong>. It exists on chain but appears in no list.</span>
    </label>

    <div class="lab-callout">
      <strong>What cannot be changed here.</strong>
      ${e.kind === 'blend'
        ? 'A blend\'s outcomes: <code>setrolls</code> takes no authorized_account, so no author can sign it. Its ingredients are editable, from the Manage panel on the main page.'
        : e.kind === 'upgrade'
          ? 'An upgrade\'s attribute rewrites: the ABI has no action for them. Its ingredients are editable through <code>setupgrdmix</code>, not yet wired here.'
          : 'Which templates a drop mints: <code>createdrop</code> fixes them and no action changes them afterwards.'}
      Changing those means deleting this one and creating a new one.
    </div>

    ${changes.length
      ? `<div class="lab-callout ok"><strong>${changes.length} change(s) to sign:</strong>
           <ul class="lab-list">${changes.map((c) => `<li>${esc(c.label)} <code>${esc(c.action.account)}::${esc(c.action.name)}</code></li>`).join('')}</ul></div>`
      : '<div class="lab-callout">Nothing changed yet.</div>'}

    ${state.lastError ? `<p class="lab-warn">${esc(state.lastError)}</p>` : ''}
    ${state.lastTx ? `<p class="lab-ok">Signed. Transaction <a target="_blank" rel="noreferrer" href="https://waxblock.io/transaction/${esc(state.lastTx)}">${esc(state.lastTx)}</a></p>` : ''}

    <div class="lab-nav-actions">
      <button class="lab-ghost" data-lab="edit-back">Back to the list</button>
      <button class="lab-primary" data-lab="edit-save" ${changes.length === 0 || state.busy ? 'disabled' : ''}>
        ${state.busy ? 'Waiting for your wallet' : `Sign ${changes.length || ''} change(s)`}
      </button>
      <button class="lab-ghost lab-danger" data-lab="edit-delete" ${state.busy ? 'disabled' : ''}>Delete it</button>
    </div>`;
}

/** Same token picker as creation, pointed at the edited drop. */
function editTokenControl(): string {
  const e = state.editing!;
  if (!state.tokenPickerOpen) {
    return `<button class="lab-token-btn" data-lab="token-open">
              <strong>${esc(e.priceToken || 'pick a token')}</strong>
              ${state.tokens.length ? `<span>${editTokenPrecision()} decimals</span>` : ''}
            </button>`;
  }
  const q = state.tokenSearch.trim().toLowerCase();
  const list = state.tokens.filter((t) => !q || t.ticker.toLowerCase().includes(q) || t.contract.toLowerCase().includes(q));
  return `
    <div class="lab-token-picker">
      <input id="lab-token-search" type="text" placeholder="Type a ticker" value="${esc(state.tokenSearch)}" autocomplete="off" />
      <div class="lab-token-grid">
        ${list.slice(0, 60).map((t) => `
          <button class="lab-token${t.ticker === e.priceToken ? ' on' : ''}" data-lab="edit-token-pick" data-ticker="${esc(t.ticker)}">
            <strong>${esc(t.ticker)}</strong><span>${t.precision} dec &middot; ${esc(t.contract)}</span>
          </button>`).join('')}
      </div>
      <button class="lab-ghost" data-lab="token-close">Cancel</button>
    </div>`;
}

// ─── tool: WAX premium name auctions ────────────────────────────────────

const waxOf = (units: number) => (units / 1e8).toLocaleString('en-US', { maximumFractionDigits: 8 });

function relativeTime(ms: number): string {
  const d = ms - Date.now();
  const abs = Math.abs(d);
  const h = Math.round(abs / 3_600_000);
  if (h < 1) return d > 0 ? 'in under an hour' : 'less than an hour ago';
  if (h < 48) return d > 0 ? `in about ${h} hour(s)` : `about ${h} hour(s) ago`;
  const days = Math.round(h / 24);
  return d > 0 ? `in about ${days} day(s)` : `about ${days} day(s) ago`;
}

/** Reads the chain for one name. Two calls, because both answers matter. */
async function onCheckName() {
  const q = state.nameQuery.trim().toLowerCase();
  if (!q) { state.nameStatus = undefined; state.nameStatusFor = ''; rerender(); return; }
  state.nameChecking = true;
  state.lastError = '';
  // Drop the old verdict before the new one lands. Keeping it meant the
  // card showed the PREVIOUS name's auction under the name just typed,
  // which reads as a wrong answer rather than as a pending one.
  state.nameStatus = undefined;
  state.nameStatusFor = '';
  rerender();
  try {
    const found = await readNameStatus(q, state.actor);
    // A slower earlier lookup must not overwrite a newer one.
    if (state.nameQuery.trim().toLowerCase() !== q) return;
    state.nameStatus = found;
    state.nameStatusFor = q;
    // The URL now points at this exact auction, ready to be copied.
    writeLabHash();
    // Only reached for a name we won, and only if the fields are untouched.
    if (found.kind === 'won' && found.mine && !state.claimOwnerKey) {
      const keys = await readAccountKeys(state.actor);
      state.claimOwnerKey = keys.owner ?? '';
      state.claimActiveKey = keys.active ?? '';
    }
    // Prefill the bid with the smallest amount the contract will take, so
    // the common case is one click and the number is never guessed.
    if (state.nameStatus.kind === 'auction') {
      state.nameBidAmount = String(minimumNextBid(state.nameStatus.bid));
    } else if (state.nameStatus.kind === 'free') {
      state.nameBidAmount = state.nameBidAmount || '1';
    }
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
    state.nameStatus = undefined;
  }
  state.nameChecking = false;
  rerender();
}

/** The running order: the chain settles the top one, once it goes quiet. */
async function loadTopBids() {
  state.topBidsState = 'loading';
  rerender();
  state.topBids = await readTopBids(10).catch(() => []);
  state.topBidsState = 'done';
  rerender();
}

async function loadMyBids() {
  if (!state.actor) return;
  state.myBidsState = 'loading';
  rerender();
  const bids = await readMyBids(state.actor).catch(() => []);
  state.myBids = bids;
  // There is no index from an account to what it is owed, so the names it
  // bid on are the only way in. A refund the history window has forgotten
  // is invisible here, which is worth saying rather than hiding.
  state.refunds = await readRefundsFor(state.actor, bids.map((b) => b.newname)).catch(() => []);
  state.myBidsState = 'done';
  rerender();
}

async function onPlaceBid() {
  const session = getCurrentSession();
  const st = state.nameStatus;
  if (!session || !st) return;
  const name = state.nameQuery.trim().toLowerCase();
  const amount = Number(state.nameBidAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    state.lastError = 'Enter a bid above zero.';
    rerender();
    return;
  }

  const current = st.kind === 'auction' ? st.bid : undefined;
  const summary = [
    `BID ON THE NAME "${name}"`,
    '',
    `You pay: ${formatWax(amount)}`,
    current
      ? `Current holder: ${current.high_bidder} at ${waxOf(current.high_bid)} WAX`
      : 'Nobody has bid on this name yet.',
    '',
    'The WAX leaves your account NOW, not when the auction ends.',
    'If someone outbids you it is refunded, but not automatically: you',
    'have to claim it back from this same screen.',
    '',
    'The name is created for the highest bidder only after that bid has',
    'stood untouched for 24 hours, and only one name on the whole chain',
    'is settled per day.',
  ].join('\n');
  if (!(await confirmCreate(summary))) return;

  state.busy = true;
  state.lastError = '';
  state.lastTx = '';
  rerender();
  try {
    const result = await session.transact({ actions: [buildBidName(state.actor, name, amount)] });
    state.lastTx =
      (result.response as { transaction_id?: string } | undefined)?.transaction_id ??
      String(result.resolved?.transaction.id ?? '');
    await onCheckName();
    void loadMyBids();
    void loadTopBids();
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
  }
  state.busy = false;
  rerender();
}

/**
 * Creates the account for a name we won. Three actions in one
 * transaction, because an account has to exist before anyone can buy RAM
 * for it or stake to it, and because a half-done claim is worse than none.
 */
async function onClaimName() {
  const session = getCurrentSession();
  const st = state.nameStatus;
  if (!session || !st || st.kind !== 'won' || !st.mine) return;
  const newname = st.bid.newname;
  const owner = state.claimOwnerKey.trim();
  const active = state.claimActiveKey.trim();
  if (!owner || !active) {
    state.lastError = 'Both keys are required. An account with no key can never be used again.';
    rerender();
    return;
  }

  const summary = [
    `CREATE THE ACCOUNT "${newname}"`,
    '',
    `You won it for ${waxOf(st.bid.high_bid)} WAX, already paid.`,
    '',
    'This transaction does three things:',
    `  eosio::newaccount    creates ${newname}`,
    '  eosio::buyrambytes   buys it about 4 KB of RAM, which costs WAX',
    '  eosio::delegatebw    stakes 1 WAX to its CPU and NET',
    '',
    `owner  ${owner}`,
    `active ${active}`,
    '',
    'Check both keys. An account created with a key nobody holds the',
    'private half of is unrecoverable, and the name is spent.',
  ].join('\n');
  if (!(await confirmCreate(summary))) return;

  state.busy = true;
  state.lastError = '';
  state.lastTx = '';
  rerender();
  try {
    const result = await session.transact({
      actions: buildClaimName({ creator: state.actor, newname, ownerKey: owner, activeKey: active }),
    });
    state.lastTx =
      (result.response as { transaction_id?: string } | undefined)?.transaction_id ??
      String(result.resolved?.transaction.id ?? '');
    // The claim erases the bid row, so the verdict changes to "taken".
    await onCheckName();
    void loadTopBids();
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
  }
  state.busy = false;
  rerender();
}

/** Every refund at once. They are separate actions, one signature. */
async function onClaimAllRefunds() {
  const session = getCurrentSession();
  if (!session || state.refunds.length === 0) return;
  const total = state.refunds.reduce((n, r) => n + r.wax, 0);
  const summary = [
    `CLAIM ${state.refunds.length} REFUND(S)`,
    '',
    ...state.refunds.map((r) => `  ${r.newname}  ${r.amount}`),
    '',
    `Total returned to you: ${formatWax(total)}`,
    '',
    'These are bids you were outbid on. The WAX has been yours all along,',
    'it just sits on the contract until asked for.',
  ].join('\n');
  if (!(await confirmCreate(summary))) return;

  state.busy = true;
  state.lastError = '';
  state.lastTx = '';
  rerender();
  try {
    const result = await session.transact({
      actions: state.refunds.map((r) => buildBidRefund(state.actor, r.newname)),
    });
    state.lastTx =
      (result.response as { transaction_id?: string } | undefined)?.transaction_id ??
      String(result.resolved?.transaction.id ?? '');
    void loadMyBids();
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
  }
  state.busy = false;
  rerender();
}

async function onClaimRefund(newname: string) {
  const session = getCurrentSession();
  if (!session) return;
  state.busy = true;
  state.lastError = '';
  rerender();
  try {
    const result = await session.transact({ actions: [buildBidRefund(state.actor, newname)] });
    state.lastTx =
      (result.response as { transaction_id?: string } | undefined)?.transaction_id ??
      String(result.resolved?.transaction.id ?? '');
    void loadMyBids();
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
  }
  state.busy = false;
  rerender();
}

/**
 * Turning a won auction into an account you own.
 *
 * The keys default to the ones the winning wallet already uses, because
 * that is what almost everyone wants and because typing a key by hand is
 * the step where a name gets locked away forever. They stay editable for
 * the case where the new account is meant for someone else.
 */
function claimForm(newname: string): string {
  return `
    <div class="lab-field" style="margin-top:18px">
      <label>Owner key <span class="lab-note">controls everything, including the active key</span></label>
      <input id="lab-claim-owner" type="text" value="${esc(state.claimOwnerKey)}"
             placeholder="EOS... or PUB_K1_..." autocomplete="off" spellcheck="false" />
    </div>
    <div class="lab-field">
      <label>Active key <span class="lab-note">day to day signing</span></label>
      <input id="lab-claim-active" type="text" value="${esc(state.claimActiveKey)}"
             placeholder="EOS... or PUB_K1_..." autocomplete="off" spellcheck="false" />
    </div>
    <div class="lab-callout">
      <strong>These are your own wallet's keys, prefilled.</strong> Keep them and
      <code>${esc(newname)}</code> answers to the same wallet you are signing with. Replace them
      only if the account is for somebody else, and only with a key whose private half exists
      somewhere: an account created with a key nobody holds is gone for good.
    </div>
    <div class="lab-callout danger">
      <strong>Creating it costs WAX on top of the bid you already paid.</strong> A new account owns
      no RAM and no resources, so the transaction also buys it about 4 KB of RAM (a fraction of a
      WAX) and stakes 1 WAX to CPU and NET. The stake is not spent, you can unstake it later. The
      RAM is a purchase.
    </div>
    <div class="lab-nav-actions">
      <button class="lab-primary" data-lab="name-claim" ${state.busy || !state.actor ? 'disabled' : ''}>
        ${state.busy ? 'Waiting for your wallet' : `Create ${esc(newname)}`}
      </button>
    </div>`;
}

/** The verdict card. Each shape says something different to a bidder. */
function nameVerdict(): string {
  const st = state.nameStatus;
  if (!st) return state.nameChecking ? '<p class="lab-hint">Reading the chain.</p>' : '';
  // The name the ANSWER is about. Reading the live input here is what
  // paired a new name with the previous name's result.
  const name = esc(state.nameStatusFor);

  if (st.kind === 'not_biddable') {
    return `<div class="lab-callout"><strong>${name} is not an auctioned name.</strong> ${esc(st.why)}</div>`;
  }
  if (st.kind === 'taken') {
    return `<div class="lab-callout danger">
      <strong>${name} already exists as an account${st.created ? `, created ${esc(String(st.created).slice(0, 10))}` : ''}.</strong>
      There is nothing to bid on. A name is only ever auctioned once.
    </div>`;
  }
  if (st.kind === 'won') {
    if (!st.mine) {
      return `<div class="lab-callout danger">
        <strong>${name} was won by <code>${esc(st.bid.high_bidder)}</code> for ${waxOf(st.bid.high_bid)} WAX.</strong>
        The auction is closed, so nobody can bid on it any more. The account itself has not been
        created yet, and only the winner can do that, but the name is theirs for as long as they
        leave it there. Names sit like this for years.
      </div>`;
    }
    return `
      <div class="lab-callout ok">
        <strong>You won ${name}, for ${waxOf(st.bid.high_bid)} WAX.</strong>
        The account does not exist yet. Winning only closed the auction; creating the account is a
        separate transaction that only you can sign, and nothing does it for you.
      </div>
      ${claimForm(st.bid.newname)}`;
  }
  if (st.kind === 'free') {
    return `<div class="lab-callout ok">
      <strong>${name} is free.</strong> No account, and nobody has ever bid on it. The first bid can be
      any amount above zero, though a name nobody wants and a name everybody wants both start there.
    </div>`;
  }

  const b = st.bid;
  const mine = b.high_bidder === state.actor;
  const settled = st.settlesAt <= Date.now();
  return `
    <div class="lab-callout ${mine ? 'ok' : ''}">
      <strong>${name} is under auction.</strong>
      ${mine ? 'You are the highest bidder.' : `Highest bidder: <code>${esc(b.high_bidder)}</code>.`}
    </div>
    <div class="lab-review">
      <div><span>Highest bid</span><b>${waxOf(b.high_bid)} WAX</b></div>
      <div><span>Bidder</span><b>${esc(b.high_bidder)}${mine ? ' (you)' : ''}</b></div>
      <div><span>Last bid</span><b>${new Date(b.last_bid_time).toLocaleString()}, ${relativeTime(b.last_bid_time)}</b></div>
      <div><span>Quiet since</span><b class="${settled ? '' : 'warn'}">${
        settled
          ? 'over 24 hours, so this one is eligible to settle'
          : `not yet, eligible ${relativeTime(st.settlesAt)}`
      }</b></div>
      <div><span>To outbid</span><b>${minimumNextBid(b)} WAX minimum</b></div>
    </div>
    <div class="lab-callout">
      Being eligible is not the same as winning. The chain settles <strong>one name a day</strong>,
      the single highest bid on the whole chain, so a quiet auction can wait a long time behind
      bigger ones.
    </div>`;
}

/**
 * The ten highest open auctions on the chain, which is also the order in
 * which they will settle: one name a day, the top one, once its bid has
 * been quiet for 24 hours. A reader who sees their own name at rank 7
 * learns more from that than from any single lookup.
 */
function topBidsBoard(): string {
  if (state.topBidsState === 'loading') return '<p class="lab-hint">Reading the highest auctions.</p>';
  if (state.topBids.length === 0) {
    return '<p class="lab-empty">No open auction found. Either the chain is quiet or a node is unhappy.</p>';
  }
  const now = Date.now();
  return `
    <div class="lab-rows">
      ${state.topBids.map((b, i) => {
        const mine = b.high_bidder === state.actor;
        const eligible = now > b.last_bid_time + QUIET_PERIOD_MS;
        return `
          <div class="lab-row${mine ? ' lab-row-mine' : ''}">
            <span class="lab-rank">${i + 1}</span>
            <span class="lab-row-main">
              <strong>${esc(b.newname)}</strong>
              <span class="lab-tpl-meta">
                ${esc(b.high_bidder)}${mine ? ' (you)' : ''} &middot;
                ${eligible ? 'quiet for over 24h, ready to settle' : `quiet ${relativeTime(b.last_bid_time + QUIET_PERIOD_MS)}`}
              </span>
            </span>
            <b class="lab-pct">${waxOf(b.high_bid)} WAX</b>
            <button class="lab-add" data-lab="name-recheck" data-name="${esc(b.newname)}">Open</button>
          </div>`;
      }).join('')}
    </div>
    <p class="lab-note">
      One name is settled per day, chain-wide: the highest bid whose 24 hours of quiet have
      elapsed. Rank 1 is next in line, and a bid placed anywhere on this board resets that
      name's clock.
    </p>
    <button class="lab-ghost" data-lab="top-reload">Refresh</button>`;
}

function nameTool(): string {
  const st = state.nameStatus;
  const standing = st && st.kind === 'auction' ? st.bid : undefined;
  const ours = Boolean(standing && standing.high_bidder === state.actor);
  // The contract refuses a bid from whoever already holds the top one, so
  // showing the form here would only offer a transaction that must fail.
  const canBid = Boolean(st && (st.kind === 'auction' || st.kind === 'free')
    && canOutbid(standing, state.actor));
  return `
    <h3 class="lab-q">WAX premium names</h3>
    <p class="lab-hint">
      A WAX name shorter than 12 characters, with no dot, cannot be created. It is sold by an open
      auction inside the system contract itself. This reads that auction, and bids on it.
    </p>

    <div class="lab-field">
      <label>Name to look up</label>
      <div class="lab-gate">
        <input id="lab-name-query" type="text" value="${esc(state.nameQuery)}"
               placeholder="e.g. rekt" autocomplete="off" spellcheck="false" />
        <button class="lab-primary" data-lab="name-check" ${state.nameChecking ? 'disabled' : ''}>
          ${state.nameChecking ? 'Reading the chain' : 'Look it up'}
        </button>
      </div>
      <p class="lab-note">a to z and 1 to 5 only, 1 to 11 characters. Press Enter to search.</p>
    </div>

    ${nameVerdict()}
    ${state.nameStatusFor ? `<p class="lab-sharerow">${shareButton('auction', 'link to this auction')}
      <span>Opens straight on ${esc(state.nameStatusFor)}, already looked up.</span></p>` : ''}

    ${ours ? `
      <div class="lab-callout ok">
        <strong>You already hold the highest bid, so there is nothing to do.</strong>
        The system contract refuses a bid from whoever is already on top, which means you cannot
        raise your own offer even if you want to. Your bid stands until somebody beats it by 10
        percent, and the clock only restarts when they do.
      </div>` : ''}

    ${canBid ? `
      <div class="lab-field" style="margin-top:18px">
        <label>Your bid, in WAX</label>
        <div class="lab-gate">
          <input id="lab-name-bid" type="text" value="${esc(state.nameBidAmount)}" autocomplete="off" />
          <button class="lab-primary" data-lab="name-bid" ${state.busy || !state.actor ? 'disabled' : ''}>
            ${state.busy ? 'Waiting for your wallet' : 'Place this bid'}
          </button>
        </div>
        ${state.actor ? '' : '<p class="lab-warn">Connect a wallet above to bid.</p>'}
      </div>
      <div class="lab-callout danger">
        <strong>The WAX leaves your account immediately</strong>, not when the auction ends. If someone
        outbids you it is refunded, but the chain does not send it back on its own: it waits in a
        refund row until you claim it, from this screen.
      </div>` : ''}

    ${state.lastError ? `<p class="lab-warn">${esc(state.lastError)}</p>` : ''}
    ${state.lastTx ? `<p class="lab-ok">Signed. Transaction <a target="_blank" rel="noreferrer" href="https://waxblock.io/transaction/${esc(state.lastTx)}">${esc(state.lastTx)}</a></p>` : ''}

    <h4 class="lab-sub">The ten highest auctions on the chain</h4>
    ${topBidsBoard()}

    <h4 class="lab-sub">Your bids</h4>
    ${!state.actor
      ? '<p class="lab-empty">Connect a wallet to see the names you have bid on.</p>'
      : state.myBidsState === 'loading'
        ? '<p class="lab-hint">Reading your history.</p>'
        : `
          ${state.refunds.length ? `
            <div class="lab-callout ok">
              <strong>${formatWax(state.refunds.reduce((n, r) => n + r.wax, 0))} waiting for you,
              across ${state.refunds.length} name(s).</strong>
              These are bids you were outbid on. The WAX has been yours the whole time, it just sits
              on the contract until somebody asks for it, and nothing ever asks on your behalf.
              <ul class="lab-list">
                ${state.refunds.map((r) => `<li>
                  <code>${esc(r.newname)}</code> ${esc(r.amount)}
                  <button class="lab-add" data-lab="name-refund" data-name="${esc(r.newname)}">Claim it</button>
                </li>`).join('')}
              </ul>
              <div class="lab-nav-actions">
                <button class="lab-primary" data-lab="name-refund-all" ${state.busy ? 'disabled' : ''}>
                  ${state.busy ? 'Waiting for your wallet' : `Claim all ${state.refunds.length} in one signature`}
                </button>
              </div>
            </div>` : ''}
          ${state.myBids.length === 0
            ? '<p class="lab-empty">No bid found in the history window. History nodes do not keep everything, so this is not proof you never bid, and a refund on a forgotten name would not show up here either.</p>'
            : `<div class="lab-rows">
                 ${state.myBids.map((b) => `
                   <div class="lab-row">
                     <span class="lab-tag">${esc(b.newname)}</span>
                     <span class="lab-row-main">
                       <strong>${esc(b.bid)}</strong>
                       <span class="lab-tpl-meta">${esc(b.timestamp.slice(0, 19).replace('T', ' '))}</span>
                     </span>
                     <button class="lab-add" data-lab="name-recheck" data-name="${esc(b.newname)}">Check it</button>
                   </div>`).join('')}
               </div>`}
          <button class="lab-ghost" data-lab="name-reload">Refresh</button>`}`;
}

// ─── page ───────────────────────────────────────────────────────────────

export function renderLabPage(): string {
  const blockers = stepProblems(state.step);
  const body = state.step === 0
    ? stepCollection()
    : state.step === 1
      ? (state.kind === 'drop' ? stepMints() : stepGive())
      : state.step === 2
        ? (state.kind === 'drop' ? stepPrice() : state.kind === 'upgrade' ? stepChanges() : stepGet())
        : state.step === 3
          ? stepRules()
          : stepReview();

  // The tool bar sits above everything: it decides which workbench is on
  // screen. The Create / Change switch below it belongs to one tool only.
  const toolBar = `
    <div class="lab-tools">
      <button class="${state.tool === 'recipes' ? 'on' : ''}" data-lab="tool-recipes">
        Recipes<small>blends, upgrades, drops</small>
      </button>
      <button class="${state.tool === 'names' ? 'on' : ''}" data-lab="tool-names">
        WAX names<small>premium name auctions</small>
      </button>
      <button class="${state.tool === 'crucible' ? 'on' : ''}" data-lab="tool-crucible">
        Crucible Contracts<small>our own engine, in preview</small>
      </button>
      ${shareButton('tool', 'link to this tool')}
    </div>`;

  if (state.tool === 'crucible') {
    return `
      <a class="app-link" href="#/nefty" style="margin-bottom:14px">Back to the app</a>
      <section class="lab">
        ${toolBar}
        ${walletBar()}
        ${renderCrucibleTool()}
      </section>`;
  }

  if (state.tool === 'names') {
    return `
      <a class="app-link" href="#/nefty" style="margin-bottom:14px">Back to the app</a>
      <section class="lab">
        ${toolBar}
        ${walletBar()}
        <div class="lab-panel">${nameTool()}</div>
      </section>`;
  }

  const title = state.kind === 'blend' ? 'a blend' : state.kind === 'upgrade' ? 'an upgrade' : 'a drop';
  // The switch sits in the header rather than under it, with a line saying
  // what the current side does. Two bare buttons alone on a row read as
  // leftovers; the same two next to the title read as a choice.
  const modeHeader = (title: string, sub: string) => `
    <div class="lab-topbar">
      <div class="lab-topbar-text">
        <div class="lab-head">
          <span class="lab-badge">GUIDED</span>
          <h2>${esc(title)}</h2>
        </div>
        <p class="lab-topbar-sub">${sub}</p>
      </div>
      <div class="lab-seg lab-mode">
        <button class="${state.mode === 'create' ? 'on' : ''}" data-lab="mode-create">Create<small>something new</small></button>
        <button class="${state.mode === 'edit' ? 'on' : ''}" data-lab="mode-edit">Change<small>something that exists</small></button>
      </div>
    </div>`;

  if (state.mode === 'edit') {
    return `
      <a class="app-link" href="#/nefty" style="margin-bottom:14px">Back to the app</a>
      <section class="lab">
        ${toolBar}
        ${walletBar()}
        ${modeHeader(
          'Change something you already made',
          state.editing
            ? `Editing <strong>${esc(state.editing.name)}</strong> on ${esc(state.collection)}. Only what you touch gets signed.`
            : state.collection
              ? `${state.existing.length} ${esc(state.kind)}(s) found on <strong>${esc(state.collection)}</strong>, hidden and ended ones included.`
              : 'Pick a collection and Crucible lists what it already has on chain.',
        )}
        <div class="lab-panel">${state.editing ? editForm() : editPicker()}</div>
      </section>`;
  }


  return `
    <a class="app-link" href="#/nefty" style="margin-bottom:14px">Back to the app</a>
    <section class="lab">
      ${toolBar}
      ${walletBar()}
      ${modeHeader(
        `Create ${title}`,
        'One question per screen. Templates are picked from your collection instead of typed, odds are drawn instead of counted, and upgrade attribute types are read from the schema. <strong>This signs real transactions.</strong>',
      )}
      ${stepRail()}
      ${state.step === STEP_COUNT - 1 ? '' : `<div class="lab-sentence">${esc(plainSentence())}</div>`}
      <div class="lab-panel">${stepBlockers()}${body}</div>

      <div class="lab-nav">
        <button class="lab-ghost" data-lab="prev" ${state.step === 0 ? 'disabled' : ''}>Back</button>
        <span class="lab-step-of">
          Step ${state.step + 1} of ${STEP_COUNT}${
            blockers.length
              ? ` &middot; ${blockers.length === 1 ? 'one thing is' : `${blockers.length} things are`} still missing`
              : ''}
        </span>
        <button class="lab-primary" data-lab="next" ${
          state.step === STEP_COUNT - 1 || blockers.length
            ? `disabled title="${esc(blockers.length ? 'Fix what is listed above first' : '')}"`
            : ''}>Continue</button>
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

/**
 * Signs only what changed, one action per contract call, in one
 * transaction. The contracts have no bulk update, so a save is genuinely
 * several actions; grouping them means the author approves once and either
 * all of it lands or none of it does.
 */
async function onSaveEdits() {
  const session = getCurrentSession();
  const changes = editActions();
  if (!session || changes.length === 0) return;

  const summary = [
    `${state.editing!.kind.toUpperCase()} #${state.editing!.id} on ${state.collection}`,
    '',
    ...changes.map((c) => `${c.label}  (${c.action.account}::${c.action.name})`),
    '',
    'Each line is a separate contract action, signed together.',
  ].join('\n');
  if (!(await confirmCreate(summary))) return;

  state.busy = true; state.lastError = ''; state.lastTx = '';
  rerender();
  try {
    const result = await session.transact({ actions: changes.map((c) => c.action) });
    state.lastTx =
      (result.response as { transaction_id?: string } | undefined)?.transaction_id ??
      String(result.resolved?.transaction.id ?? '');
    // What was just signed is now the baseline, so the diff empties out.
    state.editingOriginal = { ...state.editing! };
    if (state.kind === 'blend') clearDiscoverCache();
    else if (state.kind === 'upgrade') clearUpgradesCache();
    else clearDropsCache();
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
  }
  state.busy = false;
  rerender();
}

/** Deleting is the one action with no undo, so it asks on its own. */
async function onDeleteEntity() {
  const session = getCurrentSession();
  const action = deleteAction();
  const e = state.editing;
  if (!session || !action || !e) return;
  const summary = [
    `DELETE ${e.kind} #${e.id} (${e.name}) on ${state.collection}`,
    '',
    'This is permanent. The recipe stops existing and players can no longer run it.',
    'Anything it already consumed stays consumed.',
    '',
    `Action: ${action.account}::${action.name}`,
  ].join('\n');
  if (!(await confirmCreate(summary))) return;

  state.busy = true; state.lastError = ''; state.lastTx = '';
  rerender();
  try {
    const result = await executeAdminAction(session, action);
    state.lastTx =
      (result.response as { transaction_id?: string } | undefined)?.transaction_id ??
      String(result.resolved?.transaction.id ?? '');
    state.editing = undefined; state.editingOriginal = undefined;
    if (state.kind === 'blend') clearDiscoverCache();
    else if (state.kind === 'upgrade') clearUpgradesCache();
    else clearDropsCache();
    void loadExisting();
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
/** attachLabHandlers re-binds on every paint, so once-only wiring needs a flag. */
let visitWired = false;

export function attachLabHandlers(root: HTMLElement, render: () => void): void {
  rerender = render;
  wirePointerGuard(root);
  attachCrucibleHandlers(root, render);

  // Leaving a field is when the author has finished thinking about it, and so
  // when this step's problems start being shown. Capture phase, because blur
  // does not bubble.
  if (!visitWired) {
    visitWired = true;
    const worked = (ev: Event) => {
      const el = ev.target as HTMLElement | null;
      if (!el || !['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) return;
      if (state.visited[state.step]) return;
      state.visited[state.step] = true;
      rerender();
    };
    // Both, because neither is enough on its own: blur does not fire for a
    // field committed with Enter, and change does not fire for a field left
    // untouched but tabbed through.
    root.addEventListener('blur', worked, true);
    root.addEventListener('change', worked, true);
  }

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
      'edit-hidden':     (v) => { if (state.editing) state.editing.hidden = v; },
      'drop-auth':       (v) => { state.authRequired = v; },
      'drop-unlimited':  (v) => { state.unlimited = v; },
    };
    if (checkbox[kind]) {
      el.addEventListener('change', () => { checkbox[kind]((el as HTMLInputElement).checked); render(); });
      return;
    }

    el.addEventListener('click', () => {
      const i = idx(el);
      switch (kind) {
        // Leaving a step means the author has had their turn at it, so from
        // here on its problems are shown rather than held back.
        case 'step': {
          const want = Number(el.dataset.step);
          // Backwards is free. Forwards stops where the recipe does.
          if (want > state.step && want > firstIncompleteStep()) break;
          state.visited[state.step] = true;
          state.step = want;
          break;
        }
        case 'next': {
          state.visited[state.step] = true;
          if (stepProblems(state.step).length) break;
          state.step = Math.min(STEP_COUNT - 1, state.step + 1);
          break;
        }
        case 'prev': state.step = Math.max(0, state.step - 1); break;
        case 'kind':
          state.kind = el.dataset.kind as LabKind;
          state.step = 0;
          // Three kinds, three contracts: the answer does not carry over.
          if (state.collection) void refreshCreateAuth(state.collection);
          break;

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
        case 'drop-paid': state.free = false; void loadDropTokens(); break;
        case 'token-open':  state.tokenPickerOpen = true; state.tokenSearch = ''; void loadDropTokens(); break;
        case 'token-close': state.tokenPickerOpen = false; break;
        case 'token-pick':
          state.priceToken = el.dataset.ticker ?? state.priceToken;
          state.tokenPickerOpen = false;
          break;

        case 'tool-recipes': state.tool = 'recipes'; writeLabHash(); break;
        case 'tool-crucible': state.tool = 'crucible'; writeLabHash(); break;
        case 'tool-names':
          state.tool = 'names';
          state.lastTx = ''; state.lastError = '';
          if (state.actor && state.myBidsState === 'idle') void loadMyBids();
          if (state.topBidsState === 'idle') void loadTopBids();
          writeLabHash();
          break;
        case 'login':  void onLabLogin(); return;
        case 'logout': void onLabLogout(); return;

        case 'share-tool':    void onCopyLabLink('tool'); return;
        case 'share-auction': void onCopyLabLink('auction'); return;
        case 'name-check':  void onCheckName(); return;
        case 'name-bid':    void onPlaceBid(); return;
        case 'name-reload': void loadMyBids(); return;
        case 'top-reload':  void loadTopBids(); return;
        case 'name-refund':     void onClaimRefund(el.dataset.name ?? ''); return;
        case 'name-refund-all': void onClaimAllRefunds(); return;
        case 'name-claim':      void onClaimName(); return;
        case 'name-recheck':
          state.nameQuery = el.dataset.name ?? '';
          void onCheckName();
          return;

        case 'mode-create': state.mode = 'create'; state.editing = undefined; break;
        case 'mode-edit':
          state.mode = 'edit'; state.editing = undefined;
          state.lastTx = ''; state.lastError = '';
          if (state.collection) void loadExisting();
          break;
        case 'edit-kind':
          state.kind = el.dataset.kind as LabKind;
          state.editing = undefined;
          if (state.kind === 'drop') void loadDropTokens();
          void loadExisting();
          break;
        case 'reload-existing': void loadExisting(); return;
        case 'edit-pick': {
          const picked = state.existing[i];
          if (picked) {
            state.editing = { ...picked };
            state.editingOriginal = { ...picked };
            state.lastTx = ''; state.lastError = '';
            if (picked.kind === 'drop') void loadDropTokens();
          }
          break;
        }
        case 'edit-back': state.editing = undefined; state.lastTx = ''; state.lastError = ''; break;
        case 'edit-hidden': break; // handled as a checkbox below
        case 'edit-free': if (state.editing) state.editing.free = true; break;
        case 'edit-paid': if (state.editing) { state.editing.free = false; void loadDropTokens(); } break;
        case 'edit-token-pick':
          if (state.editing) state.editing.priceToken = el.dataset.ticker ?? state.editing.priceToken;
          state.tokenPickerOpen = false;
          break;
        case 'edit-save':   void onSaveEdits(); return;
        case 'edit-delete': void onDeleteEntity(); return;

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
    if (!isSelect) el.addEventListener('change', deferrableRender);
  };

  bind('lab-search', (v) => { state.search = v; }, 'live');
  bind('lab-token-search', (v) => { state.tokenSearch = v; }, 'live');
  bind('lab-name-query', (v) => { state.nameQuery = v; });
  bind('lab-name-bid', (v) => { state.nameBidAmount = v; });
  bind('lab-claim-owner', (v) => { state.claimOwnerKey = v; });
  bind('lab-claim-active', (v) => { state.claimActiveKey = v; });
  // Enter searches: typing a name and reaching for the mouse is the wrong
  // rhythm for a tool whose whole loop is "try another name".
  const nameInput = root.querySelector<HTMLInputElement>('#lab-name-query');
  if (nameInput) {
    nameInput.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') void onCheckName();
    });
  }
  bind('lab-name', (v) => { state.name = v; });
  bind('lab-description', (v) => { state.description = v; });
  bind('lab-image', (v) => { state.image = v; });
  bind('lab-category', (v) => { state.category = v; });
  const pickCollection = (v: string) => {
    state.collection = v.trim();
    state.schemas = []; state.templates = []; state.securities = [];
    state.schemaName = ''; state.dataState = 'idle';
    if (state.collection) void loadCollectionData();
    if (state.mode === 'edit' && state.collection) void loadExisting();
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
  bind('lab-price-recipient', (v) => { state.priceRecipient = v; });

  // Edit mode. Every field writes into the working copy; the diff against
  // `editingOriginal` is what decides which actions get built.
  const ed = (id: string, apply: (e: LabExisting, v: string) => void) =>
    bind(id, (v) => { if (state.editing) apply(state.editing, v); });
  ed('lab-edit-name',        (e, v) => { e.name = v; });
  ed('lab-edit-description', (e, v) => { e.description = v; });
  ed('lab-edit-image',       (e, v) => { e.image = v; });
  ed('lab-edit-category',    (e, v) => { e.category = v; });
  ed('lab-edit-price',       (e, v) => { e.priceAmount = v; });
  ed('lab-edit-start',       (e, v) => { e.startTime = v; });
  ed('lab-edit-end',         (e, v) => { e.endTime = v; });
  ed('lab-edit-max',         (e, v) => { e.maxUses = v; });
  ed('lab-edit-limit',       (e, v) => { e.accountLimit = v; });
  ed('lab-edit-cooldown',    (e, v) => { e.cooldown = v; });
  ed('lab-edit-security',    (e, v) => { e.securityId = v; });
  bind('lab-max-claimable', (v) => { state.maxClaimable = v; });
}
