/**
 * Crucible UI shell.
 *
 * This module owns the single mutable `state` object, the top-level render
 * loop, and every event handler the page wires up. There is no framework
 * underneath: state mutates, render() rebuilds the DOM, captureRenderSnapshot
 * preserves scroll + focus + caret position so the user doesn't feel the
 * re-render.
 *
 * Two views share the same shell:
 *   - 'blends' , pick a blend, choose ingredients, sign nosecfuse.
 *   - 'drops'  , pick a drop, claim against neftyblocksd.
 *
 * Discovery (listing what's available per collection) is *on-demand*: the
 * user clicks "Refresh" on the picker card. No automatic fetch on mount,
 * tab switch, or login. The page never spams RPC calls.
 *
 * Sub-modules:
 *   - nefty/discover , on-chain blend list
 *   - nefty/blend    : single-blend reader + isDeterministic check
 *   - nefty/execute  : builds the blend transaction
 *   - nefty/drops    : on-chain drop list + auth resolution
 *   - nefty/dropExecute, builds the claim transaction
 *   - atomic/assets  : user's NFTs (via AtomicAssets API)
 *   - atomic/matcher , maps blend ingredients to owned NFTs
 *   - ui/about       : collapsible inline guide panels
 *   - ui/dryrun      : local ABI serialization (Simulate button)
 */
import {
  getCurrentSession,
  login,
  logout,
  restoreSession,
} from '../chain/session';
import { loadBlendContractShape } from '../nefty/abi';
import {
  isDeterministic,
  loadBlend,
  deterministicResults,
  type BlendRow,
} from '../nefty/blend';
import { checkWhitelist, type WhitelistStatus } from '../nefty/whitelist';
import { listAssetsForOwner, type AtomicAsset } from '../atomic/assets';
import {
  buildSlots,
  flattenNftSelection,
  ftSlots,
  nftSlots,
  totalRequiredNfts,
  type FtSlot,
  type IngredientSlot,
} from '../atomic/matcher';
import { buildBlendActions, executeBlend, type BuiltAction } from '../nefty/execute';
import {
  buildFuseActions,
  executeFuse,
  executeClaim as executeRngClaim,
  type SecurityCheck,
} from '../nefty/rngExecute';
import {
  listUpgrades,
  loadUpgradeById,
  type DiscoveredUpgrade,
  type UpgradeStatus,
  type UpgradeIngredient,
} from '../nefty/upgrades';
import { buildUpgradeActions, executeUpgrade } from '../nefty/upgradeExecute';
import {
  listWaxdaoBlends,
  loadWaxdaoBlendById,
  type DiscoveredWaxdaoBlend,
  type WaxdaoBlendStatus,
  type WaxdaoIngredient,
} from '../waxdao/blends';
import { buildWaxdaoBlendActions, executeWaxdaoBlend } from '../waxdao/blendExecute';
import {
  readKnownClaimIds,
  waitForClaim,
  type ClaimAssetsRow,
} from '../nefty/rngWait';
import {
  parseAssetAmount,
  readTokenBalance,
  resolveTokenContract,
  tickerFromQuantity,
} from '../nefty/tokens';
import {
  listBlends,
  SUPPORTED_COLLECTIONS,
  type DiscoveredBlend,
  type DiscoveredStatus,
  type DiscoveryFlavour,
} from '../nefty/discover';
import { loadTemplate, type TemplateInfo } from '../nefty/template';
import { listDrops, type DiscoveredDrop, type DropStatus } from '../nefty/drops';
import { buildClaimActions, executeClaim } from '../nefty/dropExecute';
import {
  listPackDesigns,
  pickOwnedPacks,
  loadPackRolls,
  fetchTemplateName,
  type OwnedPack,
  type PackRoll,
} from '../nefty/packs';
import {
  executeUnboxAnnounce,
  executeUnboxClaim,
} from '../nefty/packExecute';
import { waitForUnboxAssets, type UnboxAssetRow } from '../nefty/packWait';
import { dryRunActions } from './dryrun';
import { renderAboutPanels } from './about';

type AppView =
  | 'blends'   // Nefty: blend.nefty
  | 'drops'    // Nefty: neftyblocksd
  | 'packs'    // Nefty: atomicpacksx
  | 'upgrades' // Nefty: up.nefty
  | 'waxdao-blends'; // WaxDAO: waxdaomarket

/**
 * Top-level platform switch. Each platform exposes its own set of
 * tabs; the user picks one platform at a time. The choice is reflected
 * in the URL hash (#/nefty or #/waxdao) so the page is bookmarkable
 * and shareable.
 */
type Platform = 'nefty' | 'waxdao';

/** Default tab per platform. Used when the platform pill is clicked. */
const DEFAULT_VIEW_FOR_PLATFORM: Record<Platform, AppView> = {
  nefty: 'blends',
  waxdao: 'waxdao-blends',
};

/** Reverse mapping: which platform a given view belongs to. */
function platformOf(view: AppView): Platform {
  return view === 'waxdao-blends' ? 'waxdao' : 'nefty';
}

/**
 * Multi-phase state machine for the auto-wait pack unbox flow.
 *   - idle:      no pack selected
 *   - selected:  user picked a pack, no transaction signed yet
 *   - announcing:tx1 sent to the wallet, awaiting signature/broadcast
 *   - waiting:   tx1 confirmed, polling unboxassets for ORNG callback
 *   - ready:     ORNG arrived, awaiting user click on "Sign claim"
 *   - claiming:  tx2 sent to the wallet, awaiting signature/broadcast
 *   - done:      tx2 broadcast; trx_id available for the success link
 *   - error:     irrecoverable failure; show message + retry options
 */
type PackPhase =
  | 'idle'
  | 'selected'
  | 'announcing'
  | 'waiting'
  | 'ready'
  | 'claiming'
  | 'done'
  | 'error';

/**
 * No default collection, no persistence. Every page load starts with
 * the collection input empty. The user picks one explicitly each time
 * (typing or clicking a suggestion chip). This keeps the threat model
 * minimal (zero localStorage writes) and makes the discovery step a
 * conscious decision rather than a silent auto-load of stale state.
 */
function persistCollection(_v: string) {
  // Intentionally a no-op. Kept as a hook in case a future build wants
  // to opt back into "remember my last collection" behaviour.
}

/**
 * WAX account names are 1..12 chars, [a-z1-5.], no leading/trailing dot,
 * no consecutive dots. We're lenient: we accept anything that COULD be a
 * valid account, since we'll let the on-chain query be the final judge.
 */
function isValidWaxName(s: string): boolean {
  if (!s || s.length > 12) return false;
  return /^[a-z1-5]([a-z1-5.]*[a-z1-5])?$/.test(s);
}

interface FtStatus {
  contract: string;
  required: number;
  balance: number;
}

interface AppState {
  blendId: string;
  collection: string;
  blend?: BlendRow;
  template?: TemplateInfo;
  templateLoading: boolean;
  slots: IngredientSlot[];
  selection: Map<number, string[]>;
  ownedAssets: AtomicAsset[];
  assetsLoading: boolean;
  whitelist?: WhitelistStatus;
  ftStatus: Map<number, FtStatus>; // slot index -> token status
  status: string;
  statusKind: 'info' | 'err' | 'ok' | 'warn';
  pending: boolean;
  blendLoading: boolean;
  lastDryRun?: unknown;
  lastTrxId?: string;
  discovered: DiscoveredBlend[];
  discoveryCollection: string;
  discoveryLoading: boolean;
  discoveryError?: string;
  discoverySource?: DiscoveryFlavour;
  discoveryProgress?: { pct: number; message: string };
  /**
   * Snapshot of the user's NFT inventory for the discovery collection,
   * fetched in parallel with the blend list when a wallet is connected.
   * Used by the "only show blends I can do" filter to skip rows whose
   * ingredient slots cannot all be satisfied from the wallet.
   */
  discoveryOwnedAssets: AtomicAsset[];
  showInactive: boolean;
  /** When true, the picker hides blends the wallet cannot satisfy. */
  onlyExecutable: boolean;
  pickerOpen: boolean;
  // ── drops view ──
  view: AppView;
  drops: DiscoveredDrop[];
  dropsLoading: boolean;
  dropsError?: string;
  dropsProgress?: { pct: number; message: string };
  dropId: string;
  drop?: DiscoveredDrop;
  dropPickerOpen: boolean;
  dropAmount: number;
  dropTemplate?: TemplateInfo;
  dropTemplateLoading: boolean;
  dropLoading: boolean;
  dropLastDryRun?: unknown;
  dropLastTrxId?: string;
  dropShowInactive: boolean;
  /** When true, hides drops the wallet cannot currently claim. */
  dropOnlyEligible: boolean;
  /**
   * Cache of `primary_template_id -> resolved on-chain name`, populated
   * lazily after a discover run completes. Many drops have empty
   * display_data on-chain, the canonical user-facing name is on the
   * primary mint template instead. This map lets the picker show
   * something readable for those rows.
   */
  dropNameByTemplate: Map<number, string>;
  /** Cache of `drop_id -> token balance status` for paid-drop affordability. */
  dropFtStatus: Map<string, { ticker: string; required: number; balance: number }>;

  // ── packs view ──
  /**
   * Every pack design registered on `atomicpacksx`, across every
   * collection. The unpack flow doesn't care about a "current
   * collection" -- it works off the user's full pack inventory and lets
   * them filter by collection in a cascading dropdown.
   */
  packDesigns: ReturnType<typeof Array.prototype.slice> extends never ? never : import('../nefty/packs').PackDesign[];
  /** Every pack NFT the wallet currently holds, across all collections. */
  ownedPacks: OwnedPack[];
  /** Currently picked collection in the cascading dropdown (step 1). */
  packPickCollection?: string;
  /** Currently picked pack design id within that collection (step 2). */
  packPickDesignId?: string;
  packsLoading: boolean;
  packsError?: string;
  packsProgress?: string;
  /** Selected pack (the user's specific NFT instance), if any. */
  selectedPack?: OwnedPack;
  /** Roll definitions of the selected pack's design, fetched on pick. */
  packRolls: PackRoll[];
  /** Resolved template names for the rolls' outcomes (best-effort, async). */
  packRollNames: Map<number, string>;
  /** State machine for the auto-wait flow. */
  packPhase: PackPhase;
  /** Status message for the current phase (visible in the action card). */
  packPhaseMessage?: string;
  /** Elapsed ms in 'waiting' phase, for the countdown display. */
  packWaitElapsedMs: number;
  /** Resolved outcomes from ORNG (populated once 'waiting' completes). */
  packUnboxAssets: UnboxAssetRow[];
  /** Broadcast trx_ids for the two-step flow. */
  packTx1Id?: string;
  packTx2Id?: string;
  /** Abort signal source for the polling wait (lets the user cancel). */
  packAbort?: AbortController;

  // ── RNG blend state machine (announce + fuse, wait, claim) ──
  /**
   * Phase tracker mirroring the pack-unbox flow. Idle for deterministic
   * blends (the existing single-click execute path); meaningful only
   * once a random blend has been picked and the user clicks Execute.
   */
  rngPhase: RngPhase;
  rngPhaseMessage?: string;
  /** Trx ID of the fuse transaction (TX1). */
  rngTx1Id?: string;
  /** Trx ID of the claim transaction (TX2). */
  rngTx2Id?: string;
  /** Polling countdown for the UI between TX1 and the claimassets row arriving. */
  rngWaitElapsedMs: number;
  /** The resolved claimassets row, populated once waitForClaim returns. */
  rngClaim?: ClaimAssetsRow;
  /** Cancel handle for the wait loop. */
  rngAbort?: AbortController;

  // ── UPGRADE view state machine ──
  upgrades: UpgradeViewState;
  /** WaxDAO blend tab state. */
  waxdao: WaxdaoViewState;
  /**
   * Top-level platform pill. 'nefty' = blend.nefty / neftyblocksd /
   * atomicpacksx / up.nefty. 'waxdao' = waxdaomarket. Mirrors
   * location.hash (#/nefty, #/waxdao) so the page is bookmarkable.
   */
  platform: Platform;
  /**
   * Set when the URL hash carries an entity ID (e.g.
   * `#/nefty/blend/43444`). Cleared once the entity has been loaded
   * into the corresponding tab. Used to (a) trigger the load on mount
   * and (b) surface a "connect to sign this" banner when no wallet is
   * active yet.
   */
  pendingDeepLink?: { view: AppView; id: string };

  /**
   * Cross-tab cache of `template_id -> human-readable name`. Populated
   * lazily by displayAssetName() the first time an asset with no
   * `name` field is rendered. Survives tab switches so the second
   * paint of the same template is instant.
   */
  templateNames: Map<number, string>;
}

type RngPhase =
  | 'idle'
  | 'announcing'
  | 'waiting'
  | 'ready'
  | 'claiming'
  | 'done'
  | 'error';

/** Slot machine sub-state for the UPGRADE tab. */
/**
 * State machine for the WAXDAO BLEND tab. Mirrors UpgradeViewState
 * because the picker / info / slots / actions flow is the same shape,
 * just against a different contract.
 */
interface WaxdaoViewState {
  /** Free-form blend_ID input (manual entry path). */
  blendIdInput: string;
  /** Discovered blends for the active collection. */
  list: DiscoveredWaxdaoBlend[];
  loading: boolean;
  progress?: { pct: number; message: string };
  error?: string;
  /** Currently picked blend. */
  picked?: DiscoveredWaxdaoBlend;
  pickerOpen: boolean;
  showInactive: boolean;
  /**
   * NFT picks by ingredient slot. WaxDAO slot indexing: slot 0 is the
   * FT cost (no NFT), then slots 1..N are NFT ingredients in order.
   * Single-asset slots store a single asset_id; multi-asset slots
   * (when an ingredient's amount > 1) store an array.
   */
  selection: Map<number, string | string[]>;
  /** Per-FT-ingredient affordability (index in `ingredients`). */
  ftStatus: Map<number, { ticker: string; required: number; balance: number }>;
  lastTrxId?: string;
  lastDryRun?: unknown;
  pending: boolean;
}

interface UpgradeViewState {
  /** Free-form Upgrade-id input (manual entry path). */
  upgradeIdInput: string;
  /** All upgrades for the active collection, on-chain ordered. */
  list: DiscoveredUpgrade[];
  loading: boolean;
  progress?: { pct: number; message: string };
  error?: string;
  /** Currently picked upgrade (after click in the picker). */
  picked?: DiscoveredUpgrade;
  /** Picker dropdown open state. */
  pickerOpen: boolean;
  /** When true, includes ended / upcoming / sold-out / hidden upgrades. */
  showInactive: boolean;
  /**
   * The assets the user picked from their wallet to upgrade. Keyed by
   * spec index (each upgrade can have multiple specs each requiring one
   * NFT). Value is the asset_id chosen for that spec slot.
   */
  selection: Map<number, string>;
  /** Per-FT-ingredient status: required vs balance, indexed by ingredient idx. */
  ftStatus: Map<number, { ticker: string; required: number; balance: number }>;
  /** Last broadcast trx_id (success). */
  lastTrxId?: string;
  /** Local dry-run output. */
  lastDryRun?: unknown;
  /** UI flag while a transaction is in flight. */
  pending: boolean;
}

const state: AppState = {
  blendId: '',
  collection: '',
  templateLoading: false,
  slots: [],
  selection: new Map(),
  ownedAssets: [],
  assetsLoading: false,
  ftStatus: new Map(),
  status: '',
  statusKind: 'info',
  pending: false,
  blendLoading: false,
  discovered: [],
  discoveryCollection: '',
  discoveryLoading: false,
  discoveryOwnedAssets: [],
  showInactive: false,
  onlyExecutable: false,
  pickerOpen: false,
  view: parseHashRoute().view,
  drops: [],
  dropsLoading: false,
  dropId: '',
  dropPickerOpen: false,
  dropAmount: 1,
  dropTemplateLoading: false,
  dropLoading: false,
  dropShowInactive: false,
  dropOnlyEligible: false,
  dropNameByTemplate: new Map(),
  dropFtStatus: new Map(),
  packDesigns: [],
  ownedPacks: [],
  packsLoading: false,
  packRolls: [],
  packRollNames: new Map(),
  packPhase: 'idle',
  packWaitElapsedMs: 0,
  packUnboxAssets: [],
  rngPhase: 'idle',
  rngWaitElapsedMs: 0,
  upgrades: {
    upgradeIdInput: '',
    list: [],
    loading: false,
    pickerOpen: false,
    showInactive: false,
    selection: new Map(),
    ftStatus: new Map(),
    pending: false,
  },
  waxdao: {
    blendIdInput: '',
    list: [],
    loading: false,
    pickerOpen: false,
    showInactive: false,
    selection: new Map(),
    ftStatus: new Map(),
    pending: false,
  },
  platform: readPlatformFromHash(),
  pendingDeepLink: (() => {
    const r = parseHashRoute();
    return r.id ? { view: r.view, id: r.id } : undefined;
  })(),
  templateNames: new Map(),
};

/**
 * Hash routing grammar:
 *
 *   #/<platform>                          platform only, default tab
 *   #/<platform>/<tab>                    specific tab, no entity
 *   #/<platform>/<tab>/<id>               deep link to a specific entity
 *
 * Tab slugs:
 *   nefty   → blend | claim | unpack | upgrade
 *   waxdao  → blend
 *
 * Entity IDs:
 *   blend    → blend_id  (uint64)
 *   claim    → drop_id   (uint64)
 *   upgrade  → upgrade_id (uint64)
 *   unpack   → unsupported (you can only open packs you own)
 *
 * `#/nefty/blend/43444` is shareable: when a fresh user lands on that
 * URL we auto-select the BLEND tab, fetch blend 43444, and show a
 * "connect your wallet to sign" banner if no session is active.
 */
export interface ParsedRoute {
  platform: Platform;
  view: AppView;
  id?: string;
}

function tabSlugToView(platform: Platform, slug: string | undefined): AppView {
  if (platform === 'waxdao') return 'waxdao-blends';
  switch (slug) {
    case 'claim':
    case 'drop':
    case 'drops':
      return 'drops';
    case 'unpack':
    case 'pack':
    case 'packs':
      return 'packs';
    case 'upgrade':
    case 'upgrades':
      return 'upgrades';
    case 'blend':
    case 'blends':
    default:
      return 'blends';
  }
}

function viewToTabSlug(view: AppView): string {
  switch (view) {
    case 'blends':         return 'blend';
    case 'drops':          return 'claim';
    case 'packs':          return 'unpack';
    case 'upgrades':       return 'upgrade';
    case 'waxdao-blends':  return 'blend';
  }
}

function parseHashRoute(): ParsedRoute {
  try {
    const h = (typeof location !== 'undefined' ? location.hash : '') || '';
    const clean = h.replace(/^#\/?/, '');
    const parts = clean.split('/').map((p) => p.trim()).filter(Boolean);
    const platformSlug = (parts[0] || '').toLowerCase();
    const platform: Platform = platformSlug === 'waxdao' ? 'waxdao' : 'nefty';
    const view = tabSlugToView(platform, (parts[1] || '').toLowerCase());
    const id = parts[2] ? parts[2] : undefined;
    return { platform, view, id };
  } catch {
    return { platform: 'nefty', view: 'blends' };
  }
}

function readPlatformFromHash(): Platform {
  return parseHashRoute().platform;
}

/**
 * Writes a platform / tab / id triple into the hash without firing a
 * hashchange (uses history.replaceState). Skip the call when the hash
 * is already at the target so we don't pollute the back stack.
 */
function writeHashRoute(platform: Platform, view: AppView, id?: string) {
  try {
    const slug = viewToTabSlug(view);
    const target = id
      ? `#/${platform}/${slug}/${id}`
      : `#/${platform}/${slug}`;
    if (location.hash === target) return;
    // replaceState avoids browser history pollution and does NOT fire
    // hashchange, so our hashchange listener stays a one-way "incoming
    // URL → state" bridge.
    history.replaceState(null, '', target);
  } catch { /* ignore */ }
}

function writePlatformToHash(p: Platform) {
  writeHashRoute(p, DEFAULT_VIEW_FOR_PLATFORM[p]);
}

function setStatus(msg: string, kind: AppState['statusKind'] = 'info') {
  state.status = msg;
  state.statusKind = kind;
  render();
}

function rootEl(): HTMLElement {
  const el = document.getElementById('root');
  if (!el) throw new Error('#root not in DOM');
  return el;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[c]!,
  );
}

function rebuildSlots() {
  if (state.blend) {
    state.slots = buildSlots(state.blend.ingredients, state.ownedAssets);
  }
}

async function refreshFtStatus() {
  const session = getCurrentSession();
  state.ftStatus.clear();
  if (!session) return;
  const fts = ftSlots(state.slots);
  for (const slot of fts) {
    try {
      const contract = await resolveTokenContract(slot.quantity);
      const ticker = tickerFromQuantity(slot.quantity);
      const balance = await readTokenBalance({
        owner: String(session.actor),
        contract,
        symbolCode: ticker,
      });
      state.ftStatus.set(slot.index, {
        contract,
        required: parseAssetAmount(slot.quantity),
        balance,
      });
    } catch (err) {
      state.ftStatus.set(slot.index, {
        contract: '?',
        required: parseAssetAmount(slot.quantity),
        balance: -1,
      });
      console.warn('FT resolve failed', err);
    }
  }
}

async function refreshAssets() {
  const session = getCurrentSession();
  if (!session || !state.collection) {
    state.ownedAssets = [];
    rebuildSlots();
    await refreshFtStatus();
    return;
  }
  state.assetsLoading = true;
  setStatus(`Fetching NFTs owned by ${session.actor}…`, 'info');
  try {
    state.ownedAssets = await listAssetsForOwner({
      owner: String(session.actor),
      collection_name: state.collection,
      force: true,
    });
    rebuildSlots();
    await refreshFtStatus();
    setStatus(
      `Indexed ${state.ownedAssets.length} NFT(s) in ${state.collection}.`,
      'ok',
    );
  } catch (err) {
    setStatus(`Asset fetch failed: ${(err as Error).message}`, 'err');
  } finally {
    state.assetsLoading = false;
  }
}

/**
 * Returns true if the user's wallet can satisfy every NFT ingredient slot
 * of `blend`. Token (FT) slots are ignored: their balance is shown in the
 * detail card after a blend is selected, so we don't pre-gate on cash.
 *
 * When `ingredients` is missing (e.g. indexer dropped them), we err on the
 * side of "executable" so the row stays visible rather than vanishing.
 */
function isBlendExecutable(blend: DiscoveredBlend, ownedAssets: AtomicAsset[]): boolean {
  if (!blend.ingredients || blend.ingredients.length === 0) return true;
  const slots = buildSlots(blend.ingredients, ownedAssets);
  for (const slot of slots) {
    if (slot.kind === 'FT' || slot.kind === 'UNSUPPORTED') continue;
    if (slot.eligible.length < slot.amount) return false;
  }
  return true;
}

/**
 * Returns true when the wallet currently appears able to claim `drop`:
 *   - public drops are always eligible
 *   - whitelist drops require allowed === true
 *   - proof drops require the proof rule to be satisfiable from the wallet
 *   - authkey + unclaimable + structurally-broken drops are never eligible
 *   - the per-account limit must allow at least one more claim
 * The "active status" check is left to the existing showInactive toggle so
 * the two toggles compose cleanly.
 */
function isDropClaimable(drop: DiscoveredDrop): boolean {
  if (drop.account_remaining === 0) return false;
  switch (drop.auth.kind) {
    case 'public':      return true;
    case 'whitelist':   return drop.auth.allowed === true;
    case 'proof':       return !!drop.auth.resolved?.satisfied;
    case 'authkey':     return false;
    case 'unclaimable': return false;
    case 'unverified':  return false; // no session, can't tell
  }
}

/**
 * Refreshes the blend list for the current collection. When a wallet is
 * connected, the user's NFT inventory for that collection is fetched in
 * parallel so the "only show blends I can do" filter has data to work
 * with the moment the discovery returns.
 */
async function loadDiscovered() {
  state.discoveryLoading = true;
  state.discoveryError = undefined;
  state.discoverySource = undefined;
  state.discoveryProgress = undefined;
  render();
  try {
    const session = getCurrentSession();
    const actor = session ? String(session.actor) : undefined;
    const blendsP = listBlends({
      collection: state.discoveryCollection,
      includeInactive: state.showInactive,
      actor,
      onProgress: (p) => {
        state.discoverySource = p.source;
        state.discoveryProgress = { pct: p.progress, message: p.message };
        render();
      },
    });
    // Fire the inventory fetch in parallel. We only need it for the
    // executable-only filter, so failures are silently swallowed: the
    // filter just renders fewer (or no) rows in the worst case.
    const inventoryP = actor
      ? listAssetsForOwner({ owner: actor, collection_name: state.discoveryCollection })
          .catch(() => [] as AtomicAsset[])
      : Promise.resolve([] as AtomicAsset[]);
    const [{ blends, source }, owned] = await Promise.all([blendsP, inventoryP]);
    state.discovered = blends;
    state.discoverySource = source;
    state.discoveryOwnedAssets = owned;
  } catch (err) {
    state.discoveryError = (err as Error).message;
    state.discovered = [];
    state.discoveryOwnedAssets = [];
  } finally {
    state.discoveryLoading = false;
    state.discoveryProgress = undefined;
    render();
  }
}

/**
 * Toggling "include inactive" purges the stale list (because we cache by
 * (collection, includeInactive, actor)) but does NOT auto-refetch, the
 * user clicks Refresh when ready. On-demand by design.
 */
function onToggleShowInactive(checked: boolean) {
  state.showInactive = checked;
  state.discovered = [];
  state.discoveryError = undefined;
  state.discoverySource = undefined;
  render();
}

/**
 * Toggling the "only show executable" filter doesn't re-fetch anything,
 * it just changes how the existing list is rendered. The user's NFT
 * inventory was already fetched alongside the blend list in
 * loadDiscovered().
 */
function onToggleOnlyExecutable(checked: boolean) {
  state.onlyExecutable = checked;
  render();
}

/**
 * Switches the active collection. Discards anything tied to the previous
 * collection (loaded blend/drop, owned NFTs, whitelist results, dry-run
 * output) and clears the discovery lists. Does NOT trigger a fetch,
 * discovery is on-demand; the user picks the moment.
 */
function onChangeCollection(name: string) {
  if (state.discoveryCollection === name) return;
  state.discoveryCollection = name;
  persistCollection(name);
  // Per-collection state, gone.
  state.blend = undefined;
  state.template = undefined;
  state.slots = [];
  state.selection.clear();
  state.ownedAssets = [];
  state.whitelist = undefined;
  state.ftStatus.clear();
  state.lastDryRun = undefined;
  state.lastTrxId = undefined;
  state.drop = undefined;
  state.dropTemplate = undefined;
  state.dropLastDryRun = undefined;
  state.dropLastTrxId = undefined;
  // Per-collection LISTS, gone too. User triggers refetch explicitly.
  state.discovered = [];
  state.discoveryError = undefined;
  state.discoverySource = undefined;
  state.drops = [];
  state.dropsError = undefined;
  render();
}

function onPickDiscovered(blendId: string) {
  if (!blendId) return;
  const found = state.discovered.find((b) => b.blend_id === blendId);
  if (found && found.whitelist_required && found.whitelist_allowed === false) return;
  state.blendId = blendId;
  state.pickerOpen = false;
  onLoadBlend();
}

function onTogglePicker() {
  state.pickerOpen = !state.pickerOpen;
  render();
}

function onPickerOutsideClick(ev: MouseEvent) {
  const target = ev.target as HTMLElement | null;
  // Once positionOpenPickers portals the dropdown panel to <body>, the
  // panel is no longer a descendant of its `.picker` toggle. Clicks
  // INSIDE the panel must still count as "inside the picker", otherwise
  // the panel would close on the first row click. We treat any click
  // inside any `.picker-panel` as a click inside the matching picker.
  const insidePanel = target?.closest('.picker-panel');
  let mutated = false;
  if (state.pickerOpen && (!target || (!target.closest('.picker') && !insidePanel))) {
    state.pickerOpen = false;
    mutated = true;
  }
  if (state.dropPickerOpen && (!target || (!target.closest('.drop-picker') && !insidePanel))) {
    state.dropPickerOpen = false;
    mutated = true;
  }
  if (state.waxdao.pickerOpen && (!target || (!target.closest('.waxdao-picker') && !insidePanel))) {
    state.waxdao.pickerOpen = false;
    mutated = true;
  }
  if (state.upgrades.pickerOpen && (!target || (!target.closest('.upgrade-picker') && !insidePanel))) {
    state.upgrades.pickerOpen = false;
    mutated = true;
  }
  if (mutated) render();
}

// ─── drops view handlers ──────────────────────────────────────────────── //

/**
 * Switches between BLEND and CLAIM tabs. The new tab's list stays empty
 * until the user explicitly hits Refresh, on-demand fetching everywhere.
 */
function onSwitchView(v: AppView) {
  if (state.view === v) return;
  // Switching away from the packs tab mid-wait must NOT silently keep
  // polling in the background -- cancel the abort controller so the
  // user can leave cleanly.
  if (state.view === 'packs' && state.packAbort) {
    state.packAbort.abort();
    state.packAbort = undefined;
  }
  state.view = v;
  // Keep platform in sync with view, in case the user clicked a tab
  // that belongs to the OTHER platform (the tabs we render are always
  // platform-scoped, but defensive code is cheap).
  const newPlatform = platformOf(v);
  if (state.platform !== newPlatform) {
    state.platform = newPlatform;
  }
  // Reset hash to the new tab WITHOUT an entity id (user is switching
  // contexts, the previously linked entity is no longer relevant).
  writeHashRoute(state.platform, v);
  render();
}

/**
 * Switches the top-level platform pill. Resets `state.view` to the
 * default view of the target platform (e.g. clicking the WaxDAO pill
 * lands you on the WaxDAO Blend tab). Hash is updated so the new
 * platform is bookmarkable.
 */
function onSwitchPlatform(p: Platform) {
  if (state.platform === p) return;
  // Defensive: cancel any pending pack-tab wait if we're walking
  // away from it via a platform switch.
  if (state.view === 'packs' && state.packAbort) {
    state.packAbort.abort();
    state.packAbort = undefined;
  }
  state.platform = p;
  state.view = DEFAULT_VIEW_FOR_PLATFORM[p];
  // Clear any pending deep link, the user clicked away from it.
  state.pendingDeepLink = undefined;
  writePlatformToHash(p);
  render();
}

/**
 * Reads `state.pendingDeepLink` and triggers the appropriate
 * `onLoadXManual()` for the carried entity. Idempotent: once the
 * entity loads, the deep link is cleared.
 *
 * Called once after `mount()` and again whenever a hashchange brings
 * a new ID. Wallet connection is NOT required: the entity loads and
 * renders so the user can see what the link points to. A banner in
 * the Connect-wallet card prompts them to sign in when they're ready.
 */
async function applyPendingDeepLink() {
  const dl = state.pendingDeepLink;
  if (!dl) return;
  // Mark consumed up front so re-entry doesn't double-load.
  state.pendingDeepLink = undefined;
  try {
    switch (dl.view) {
      case 'blends':
        state.blendId = dl.id;
        await onLoadBlend();
        break;
      case 'drops':
        state.dropId = dl.id;
        await onLoadDropManual();
        break;
      case 'upgrades':
        state.upgrades.upgradeIdInput = dl.id;
        await onLoadUpgradeManual();
        break;
      case 'waxdao-blends':
        state.waxdao.blendIdInput = dl.id;
        await onLoadWaxdaoBlendManual();
        break;
      case 'packs':
        // Deep links to packs are not meaningful: the user can only
        // unbox what they own. We ignore the id and stay on the tab.
        break;
    }
  } catch (err) {
    setStatus(`Deep link failed: ${(err as Error).message}`, 'err');
  }
}

// ─── packs view: discovery + auto-wait state machine ─────────────────── //

/**
 * Scans the global atomicpacksx::packs table for EVERY known pack design
 * and cross-references with the wallet's full inventory (no collection
 * filter). This makes the cascading dropdown self-populating: only the
 * collections where the user actually owns at least one pack appear in
 * step 1.
 *
 * The scan is heavy (chunked walk of the global table + full-wallet
 * indexer call) but cached for 5 minutes inside `listPackDesigns`, so
 * a "Refresh" click after the first run is mostly free.
 */
async function loadPacks() {
  state.packsLoading = true;
  state.packsError = undefined;
  state.packsProgress = 'Scanning every pack design on atomicpacksx…';
  render();
  try {
    const session = getCurrentSession();
    const actor = session ? String(session.actor) : undefined;
    // No collection filter on either side: we want the complete picture.
    // Force-refresh the wallet inventory so a freshly-burned pack drops
    // out of the cached snapshot after every unbox.
    const designsP = listPackDesigns();
    const inventoryP = actor
      ? listAssetsForOwner({ owner: actor, force: true })
          .catch(() => [] as AtomicAsset[])
      : Promise.resolve([] as AtomicAsset[]);
    const [designs, owned] = await Promise.all([designsP, inventoryP]);
    state.packDesigns = designs;
    state.ownedPacks = pickOwnedPacks(owned, designs);

    // If the previously picked collection no longer has any owned pack
    // (e.g. the user just opened the last one), drop the selection so
    // the dropdown defaults back to the placeholder. Same logic for the
    // design pick.
    const collections = new Set(state.ownedPacks.map((p) => p.pack.collection_name));
    if (state.packPickCollection && !collections.has(state.packPickCollection)) {
      state.packPickCollection = undefined;
      state.packPickDesignId = undefined;
    }
    if (state.packPickDesignId) {
      const stillThere = state.ownedPacks.some(
        (p) => p.pack.pack_id === state.packPickDesignId,
      );
      if (!stillThere) state.packPickDesignId = undefined;
    }
  } catch (err) {
    state.packsError = (err as Error).message;
    state.packDesigns = [];
    state.ownedPacks = [];
  } finally {
    state.packsLoading = false;
    state.packsProgress = undefined;
    render();
  }
}

/**
 * Step 1 of the cascading dropdown: user picked a collection. Resets
 * the downstream picks and the unbox state machine (since any prior
 * selection belonged to the previous collection).
 */
function onPackPickCollection(collection: string) {
  if (state.packPickCollection === collection) return;
  state.packPickCollection = collection || undefined;
  state.packPickDesignId = undefined;
  onPackReset();
}

/**
 * Step 2 of the cascading dropdown: user picked a pack DESIGN within
 * the currently selected collection. If the wallet only owns one mint
 * of that design we auto-pick it; otherwise step 3 shows a mint
 * dropdown for them to disambiguate.
 */
function onPackPickDesign(designId: string) {
  if (state.packPickDesignId === designId) return;
  state.packPickDesignId = designId || undefined;
  // Discard any previous pack selection -- a different design needs a
  // fresh unbox cycle, regardless of which mint the user eventually
  // picks within the new design.
  if (state.selectedPack && state.selectedPack.pack.pack_id !== designId) {
    onPackReset();
  }
  if (!designId) {
    render();
    return;
  }
  const owned = state.ownedPacks.filter(
    (p) => p.pack.collection_name === state.packPickCollection && p.pack.pack_id === designId,
  );
  if (owned.length === 1) {
    onPickPack(owned[0].asset_id);
  } else {
    render();
  }
}

/**
 * Called when the user picks one of their owned packs to open. Resets
 * the state machine and pre-fetches the roll definitions + result
 * template names for the info card.
 */
async function onPickPack(asset_id: string) {
  const pack = state.ownedPacks.find((p) => p.asset_id === asset_id);
  if (!pack) return;
  // Any prior wait must be cancelled before we start a new flow.
  if (state.packAbort) {
    state.packAbort.abort();
    state.packAbort = undefined;
  }
  state.selectedPack = pack;
  state.packRolls = [];
  state.packRollNames = new Map();
  state.packUnboxAssets = [];
  state.packTx1Id = undefined;
  state.packTx2Id = undefined;
  state.packPhase = 'selected';
  state.packPhaseMessage = undefined;
  render();

  try {
    const rolls = await loadPackRolls(pack.pack.pack_id);
    state.packRolls = rolls;
    render();
    // Enrich the most-frequent template names asynchronously, best-effort.
    const seen = new Set<number>();
    for (const roll of rolls) {
      for (const o of roll.outcomes.slice(0, 3)) {
        if (seen.has(o.template_id)) continue;
        seen.add(o.template_id);
        fetchTemplateName(pack.pack.collection_name, o.template_id).then((name) => {
          if (name) {
            state.packRollNames.set(o.template_id, name);
            render();
          }
        });
      }
    }
  } catch (err) {
    state.packPhase = 'error';
    state.packPhaseMessage = `Failed to read pack rolls: ${(err as Error).message}`;
    render();
  }
}

/**
 * Step 1 of the unbox flow: ask the wallet to sign the transfer-with-
 * memo-"unbox". On broadcast, immediately enter the 'waiting' phase
 * and start polling unboxassets for ORNG callback.
 */
async function onPackAnnounce() {
  const session = getCurrentSession();
  const pack = state.selectedPack;
  if (!session || !pack) return;
  state.packPhase = 'announcing';
  state.packPhaseMessage = 'Awaiting wallet signature for step 1 (send pack to atomicpacksx)…';
  render();
  try {
    const result = await executeUnboxAnnounce(session, pack.asset_id);
    state.packTx1Id =
      (result.response as { transaction_id?: string } | undefined)?.transaction_id ??
      String(result.resolved?.transaction.id ?? '');
    state.packPhase = 'waiting';
    state.packPhaseMessage = 'TX1 broadcast. Waiting for ORNG randomness…';
    state.packWaitElapsedMs = 0;
    state.packAbort = new AbortController();
    render();

    const rows = await waitForUnboxAssets({
      pack_asset_id: pack.asset_id,
      onTick: (elapsedMs) => {
        state.packWaitElapsedMs = elapsedMs;
        // re-render the elapsed time without trashing other state
        if (state.view === 'packs') render();
      },
      signal: state.packAbort.signal,
    });
    state.packUnboxAssets = rows;
    state.packPhase = 'ready';
    state.packPhaseMessage = `ORNG arrived. ${rows.length} card${rows.length === 1 ? '' : 's'} ready to mint.`;
    state.packAbort = undefined;
    render();
    // Best-effort: fetch the name of each resolved template (the ones
    // the oracle actually picked) so the outcome list shows readable
    // names instead of bare template IDs. Already-cached names are
    // skipped via the same Set we use during onPickPack.
    const seen = new Set<number>(state.packRollNames.keys());
    for (const row of rows) {
      const tid = Number(row.template_id);
      if (seen.has(tid)) continue;
      seen.add(tid);
      fetchTemplateName(pack.pack.collection_name, tid).then((name) => {
        if (name) {
          state.packRollNames.set(tid, name);
          render();
        }
      });
    }
  } catch (err) {
    state.packPhase = 'error';
    state.packPhaseMessage = (err as Error).message;
    state.packAbort = undefined;
    render();
  }
}

/**
 * Step 2 of the unbox flow: claim the resolved outcomes. Builds
 * claimunboxed with the roll IDs the ORNG callback wrote to chain.
 */
async function onPackClaim() {
  const session = getCurrentSession();
  const pack = state.selectedPack;
  if (!session || !pack) return;
  if (state.packUnboxAssets.length === 0) return;
  state.packPhase = 'claiming';
  state.packPhaseMessage = 'Awaiting wallet signature for step 2 (mint the cards)…';
  render();
  try {
    const result = await executeUnboxClaim(session, {
      pack_asset_id: pack.asset_id,
      origin_roll_ids: state.packUnboxAssets.map((r) => r.origin_roll_id),
    });
    state.packTx2Id =
      (result.response as { transaction_id?: string } | undefined)?.transaction_id ??
      String(result.resolved?.transaction.id ?? '');
    state.packPhase = 'done';
    state.packPhaseMessage = `Pack opened. ${state.packUnboxAssets.length} NFT(s) minted to your wallet.`;
    render();
    // The pack NFT is burned by the contract during claimunboxed: drop
    // it from the cached inventory immediately so the cascade dropdowns
    // can't offer it again. We don't await this: it's a fire-and-forget
    // refresh that updates the lists for the user's next click.
    void loadPacks();
  } catch (err) {
    state.packPhase = 'error';
    state.packPhaseMessage = (err as Error).message;
    render();
  }
}

/** Cancels an in-progress 'waiting' phase. The on-chain unbox state is
 *  preserved, the user can come back later and claim. */
function onPackCancelWait() {
  state.packAbort?.abort();
  state.packAbort = undefined;
  state.packPhase = 'error';
  state.packPhaseMessage =
    'You cancelled the wait. The pack is still in atomicpacksx; refresh and pick it again to resume.';
  render();
}

/** Resets the state machine so the user can pick another pack. */
function onPackReset() {
  if (state.packAbort) {
    state.packAbort.abort();
    state.packAbort = undefined;
  }
  state.selectedPack = undefined;
  state.packRolls = [];
  state.packRollNames = new Map();
  state.packUnboxAssets = [];
  state.packPhase = 'idle';
  state.packPhaseMessage = undefined;
  state.packTx1Id = undefined;
  state.packTx2Id = undefined;
  state.packWaitElapsedMs = 0;
  render();
}

async function loadDropsList() {
  state.dropsLoading = true;
  state.dropsError = undefined;
  state.dropsProgress = undefined;
  render();
  try {
    const session = getCurrentSession();
    const { drops } = await listDrops({
      collection: state.discoveryCollection,
      includeInactive: state.dropShowInactive,
      actor: session ? String(session.actor) : undefined,
      ownedAssets: state.ownedAssets,
      onProgress: (message, pct) => {
        state.dropsProgress = { pct, message };
        render();
      },
    });
    state.drops = drops;
    // Kick off best-effort name resolution for drops whose on-chain
    // display_data is empty. The picker falls back to the primary mint
    // template's name, fetched from the AtomicAssets indexer. Failures
    // are silently swallowed, the row keeps its "Drop #<id>" fallback.
    void enrichDropNames(drops);
    // Same idea for paid drops: precompute whether the user has the
    // required balance. Sets state.dropFtStatus[drop_id] when we can,
    // leaves it unset when the session is missing or the token is exotic.
    void enrichDropAffordability(drops);
  } catch (err) {
    state.dropsError = (err as Error).message;
    state.drops = [];
  } finally {
    state.dropsLoading = false;
    state.dropsProgress = undefined;
    render();
  }
}

/**
 * Best-effort name resolution for drops with empty display_data. Looks
 * up each unique primary template_id via the AtomicAssets indexer (one
 * request per template, dedup'd) and stashes the resolved name in
 * `state.dropNameByTemplate`. The picker checks this cache when the
 * raw `d.name` is still the auto-generated `Drop #<id>` fallback.
 */
async function enrichDropNames(drops: DiscoveredDrop[]): Promise<void> {
  const seen = new Set<number>();
  const tasks: Promise<void>[] = [];
  for (const d of drops) {
    const tid = d.primary_template_id;
    if (!tid) continue;
    if (seen.has(tid)) continue;
    if (state.dropNameByTemplate.has(tid)) continue;
    seen.add(tid);
    tasks.push(
      fetchTemplateName(d.collection_name, tid).then((name) => {
        if (name) {
          state.dropNameByTemplate.set(tid, name);
          if (state.view === 'drops') render();
        }
      }).catch(() => {}),
    );
  }
  await Promise.all(tasks);
}

/**
 * Reads the user's balance for each paid drop's settlement token and
 * stashes a small {required, balance} record per drop_id. The picker
 * uses this to flag "insufficient funds" inline so the user knows they
 * need to top up before signing.
 */
async function enrichDropAffordability(drops: DiscoveredDrop[]): Promise<void> {
  const session = getCurrentSession();
  if (!session) return;
  const owner = String(session.actor);
  const byTicker = new Map<string, number>();
  const tasks: Promise<void>[] = [];
  for (const d of drops) {
    if (d.is_free) continue;
    const required = parseAssetAmount(d.listing_price);
    const ticker = tickerFromQuantity(d.listing_price);
    if (!ticker || !Number.isFinite(required)) continue;
    // Avoid hammering the chain: one balance read per ticker, cached.
    if (!byTicker.has(ticker)) {
      byTicker.set(ticker, -1);
      tasks.push(
        (async () => {
          try {
            const contract = await resolveTokenContract(d.listing_price);
            const balance = await readTokenBalance({
              owner,
              contract,
              symbolCode: ticker,
            });
            byTicker.set(ticker, balance);
          } catch {
            byTicker.set(ticker, -1);
          }
        })(),
      );
    }
  }
  await Promise.all(tasks);
  for (const d of drops) {
    if (d.is_free) continue;
    const required = parseAssetAmount(d.listing_price);
    const ticker = tickerFromQuantity(d.listing_price);
    if (!ticker || !Number.isFinite(required)) continue;
    const balance = byTicker.get(ticker) ?? -1;
    state.dropFtStatus.set(d.drop_id, { ticker, required, balance });
  }
  if (state.view === 'drops') render();
}

/**
 * Returns the user-facing name for a drop: prefers the on-chain
 * display_data name, falls back to the resolved primary-template name
 * (best-effort), and finally to the auto-generated "Drop #<id>".
 */
function displayDropName(d: DiscoveredDrop): string {
  const fallback = `Drop #${d.drop_id}`;
  if (d.name && d.name !== fallback) return d.name;
  const tid = d.primary_template_id;
  if (tid) {
    const resolved = state.dropNameByTemplate.get(tid);
    if (resolved) return resolved;
  }
  return d.name || fallback;
}

function onToggleDropShowInactive(checked: boolean) {
  state.dropShowInactive = checked;
  state.drops = [];
  state.dropsError = undefined;
  render();
}

/**
 * Toggle for the "only show drops I can claim" filter. Pure client-side
 * filter on the already-fetched list, no refetch.
 */
function onToggleDropOnlyEligible(checked: boolean) {
  state.dropOnlyEligible = checked;
  render();
}

function onToggleDropPicker() {
  state.dropPickerOpen = !state.dropPickerOpen;
  render();
}

async function onPickDrop(dropId: string) {
  state.dropPickerOpen = false;
  state.dropId = dropId;
  const drop = state.drops.find((d) => d.drop_id === dropId);
  if (!drop) return;
  if (drop.auth.kind === 'whitelist' && drop.auth.allowed === false) return;
  if (drop.auth.kind === 'authkey') return;
  state.drop = drop;
  state.dropLoading = true;
  state.dropTemplate = undefined;
  state.dropTemplateLoading = !!drop.primary_template_id;
  state.dropLastDryRun = undefined;
  state.dropLastTrxId = undefined;
  writeHashRoute('nefty', 'drops', drop.drop_id);
  render();

  if (drop.primary_template_id) {
    try {
      const info = await loadTemplate({
        collection_name: drop.collection_name,
        template_id: drop.primary_template_id,
      });
      state.dropTemplate = info;
    } catch (err) {
      console.warn('drop template load failed', err);
    } finally {
      state.dropTemplateLoading = false;
    }
  }
  // Make sure the affordability check is fresh for the picked drop:
  // when the user comes in via manual entry, the discover-time
  // enrichment never ran for this drop. Single drop, single fetch.
  if (!drop.is_free && !state.dropFtStatus.has(drop.drop_id)) {
    void enrichDropAffordability([drop]);
  }
  state.dropLoading = false;
  render();
}

function onChangeDropAmount(n: number) {
  if (!Number.isFinite(n) || n < 1) n = 1;
  state.dropAmount = Math.floor(n);
  render();
}

async function onLoadDropManual() {
  if (!state.dropId) {
    setStatus('Enter a drop_id first.', 'err');
    return;
  }
  // If it's already in the discovered list, just pick it.
  const found = state.drops.find((d) => d.drop_id === state.dropId);
  if (found) {
    onPickDrop(state.dropId);
    return;
  }
  // Otherwise fetch it ad-hoc, useful for drops from other collections or
  // drops the user knows by ID but that aren't in the active filter view.
  state.dropLoading = true;
  state.drop = undefined;
  state.dropTemplate = undefined;
  state.dropLastDryRun = undefined;
  state.dropLastTrxId = undefined;
  render();
  try {
    const session = getCurrentSession();
    const { drops } = await listDrops({
      collection: state.discoveryCollection,
      includeInactive: true,
      actor: session ? String(session.actor) : undefined,
      ownedAssets: state.ownedAssets,
    });
    // Try to find by id, fall back to a direct chain read if absent.
    const drop = drops.find((d) => d.drop_id === state.dropId);
    if (drop) {
      onPickDrop(state.dropId);
    } else {
      setStatus(`Drop ${state.dropId} not found in ${state.discoveryCollection}.`, 'err');
    }
  } catch (err) {
    setStatus(`Error: ${(err as Error).message}`, 'err');
  } finally {
    state.dropLoading = false;
    render();
  }
}

function readyToClaim(): boolean {
  const d = state.drop;
  if (!d) return false;
  if (d.status !== 'active') return false;
  if (d.auth.kind === 'authkey') return false;
  if (d.auth.kind === 'unclaimable') return false;
  if (d.auth.kind === 'unverified') return false;
  if (d.auth.kind === 'whitelist' && d.auth.allowed !== true) return false;
  if (d.auth.kind === 'proof' && !d.auth.resolved?.satisfied) return false;
  if (state.dropAmount < 1) return false;
  if (typeof d.account_remaining === 'number' && d.account_remaining < state.dropAmount) return false;
  // Paid drop with a known insufficient balance? Block the Sign &
  // claim button. We don't block on `balance === -1` (failed to read)
  // because the contract will surface its own error in that case.
  const ft = state.dropFtStatus.get(d.drop_id);
  if (ft && ft.balance >= 0 && ft.balance < ft.required * state.dropAmount) return false;
  return true;
}

function formatHumanDuration(seconds: number): string {
  if (seconds <= 0) return 'now';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

async function buildDropPlan() {
  const session = getCurrentSession();
  if (!session || !state.drop) throw new Error('No session or no drop selected');
  return buildClaimActions({
    claimer: String(session.actor),
    drop: state.drop,
    amount: state.dropAmount,
  });
}

async function onDropDryRun() {
  try {
    setStatus('Simulating drop claim (local ABI serialization)…', 'info');
    const actions = await buildDropPlan();
    const out = await dryRunActions(actions);
    state.dropLastDryRun = { actions, abi_serialization: out };
    const ok = out.every((r) => !r.error);
    setStatus(
      ok ? `Simulation OK, ${actions.length} action(s) serialize cleanly.` : 'Simulation failed for at least one action.',
      ok ? 'ok' : 'err',
    );
  } catch (err) {
    setStatus((err as Error).message, 'err');
  }
  render();
}

async function onDropExecute() {
  const session = getCurrentSession();
  if (!session || !state.drop) return;
  const actions = await buildDropPlan().catch((e) => {
    setStatus((e as Error).message, 'err');
    return null;
  });
  if (!actions) return;
  if (
    !confirm(
      `Sign ${actions.length} action(s) to claim drop #${state.drop.drop_id}?\n\n` +
        actions.map((a, i) => `${i + 1}. ${a.account}::${a.name}`).join('\n'),
    )
  )
    return;
  try {
    setStatus('Awaiting wallet signature…', 'info');
    const result = await executeClaim(session, {
      drop: state.drop,
      amount: state.dropAmount,
    });
    const trxId =
      (result.response as { transaction_id?: string } | undefined)?.transaction_id ??
      String(result.resolved?.transaction.id ?? '');
    state.dropLastTrxId = trxId;
    setStatus(`Drop claimed: ${trxId}`, 'ok');
  } catch (err) {
    setStatus(`Claim failed: ${(err as Error).message}`, 'err');
  }
  render();
}

async function onLoadBlend() {
  if (!state.blendId) {
    setStatus('Enter a blend_id first.', 'err');
    return;
  }
  state.pending = true;
  state.blendLoading = true;
  state.blend = undefined;
  state.template = undefined;
  state.templateLoading = false;
  state.slots = [];
  state.selection.clear();
  state.ownedAssets = [];
  state.assetsLoading = false;
  state.whitelist = undefined;
  state.ftStatus.clear();
  state.lastDryRun = undefined;
  state.lastTrxId = undefined;
  render();
  try {
    setStatus(`Reading blend ${state.blendId}…`, 'info');
    state.blend = await loadBlend({ blend_id: state.blendId });
    state.collection = state.blend.collection_name;
    // Reflect the picked blend in the URL so the user can share it.
    writeHashRoute('nefty', 'blends', String(state.blend.blend_id));
    // Reset any pending RNG state from a previous blend.
    state.rngPhase = 'idle';
    state.rngPhaseMessage = undefined;
    state.rngTx1Id = undefined;
    state.rngTx2Id = undefined;
    state.rngClaim = undefined;
    state.rngWaitElapsedMs = 0;
    if (state.rngAbort) {
      state.rngAbort.abort();
      state.rngAbort = undefined;
    }

    // Both deterministic and random blends are loadable now. The
    // execute button below routes to the right state machine based on
    // isDeterministic(). The only thing that genuinely can't run is a
    // pool-NFT result, which we still reject up-front because we can't
    // even build the right action list.
    const det = isDeterministic(state.blend);
    if (!det.ok && /POOL_NFT/.test(det.reason ?? '')) {
      setStatus(`Unsupported blend: ${det.reason}`, 'err');
      return;
    }

    const session = getCurrentSession();
    if (session) {
      state.whitelist = await checkWhitelist({
        security_id: state.blend.security_id,
        actor: String(session.actor),
      });
    }

    state.blendLoading = false; // header info is enough to show, keep skeletons for assets/template
    render();

    // Kick off template enrichment + asset refresh in parallel.
    const results = deterministicResults(state.blend);
    const firstResult = results[0];
    state.templateLoading = !!firstResult;
    render();

    const tasks: Promise<unknown>[] = [];
    if (firstResult) {
      tasks.push(
        loadTemplate({
          collection_name: state.blend.collection_name,
          template_id: firstResult.template_id,
        })
          .then((info) => {
            state.template = info;
          })
          .finally(() => {
            state.templateLoading = false;
            render();
          }),
      );
    }
    tasks.push(refreshAssets());
    await Promise.all(tasks);
  } catch (err) {
    setStatus(`Error: ${(err as Error).message}`, 'err');
  } finally {
    state.pending = false;
    state.blendLoading = false;
    state.templateLoading = false;
    render();
  }
}

function toggleSelect(slotIndex: number, assetId: string) {
  const slot = state.slots[slotIndex];
  if (slot.kind === 'UNSUPPORTED' || slot.kind === 'FT') return;
  const current = state.selection.get(slotIndex) ?? [];
  if (current.includes(assetId)) {
    state.selection.set(slotIndex, current.filter((id) => id !== assetId));
  } else {
    if (current.length >= slot.amount) {
      setStatus(`Slot #${slotIndex} is already full (${slot.amount} NFTs).`, 'warn');
      return;
    }
    for (const [otherIdx, ids] of state.selection.entries()) {
      if (otherIdx !== slotIndex && ids.includes(assetId)) {
        setStatus(`Asset ${assetId} is already used by slot #${otherIdx}.`, 'warn');
        return;
      }
    }
    state.selection.set(slotIndex, [...current, assetId]);
  }
  render();
}

function readyToSubmit(): boolean {
  if (!state.blend) return false;
  if (state.whitelist?.required && !state.whitelist.allowed) return false;
  // NFT slots must be filled
  for (const s of nftSlots(state.slots)) {
    if ((state.selection.get(s.index) ?? []).length !== s.amount) return false;
  }
  // FT balances must cover required
  for (const s of ftSlots(state.slots)) {
    const st = state.ftStatus.get(s.index);
    if (!st || st.balance < 0 || st.balance < st.required) return false;
  }
  return true;
}

async function buildPlan(): Promise<BuiltAction[]> {
  const session = getCurrentSession();
  if (!session || !state.blend) throw new Error('No session / blend loaded');
  const asset_ids = flattenNftSelection(state.slots, state.selection);
  const ft_payments = ftSlots(state.slots).map((s) => s.quantity);
  if (!isDeterministic(state.blend).ok) {
    // RNG blend: simulate the TX1 leg (announce + fuse). The TX2 leg
    // can't be simulated up front because we don't yet have the
    // claim_id the contract will assign.
    return buildFuseActions({
      claimer: String(session.actor),
      blend_id: state.blend.blend_id,
      asset_ids,
      ft_payments,
      security_check: defaultSecurityCheck(String(session.actor)),
    });
  }
  return buildBlendActions({
    claimer: String(session.actor),
    blend_id: state.blend.blend_id,
    asset_ids,
    ft_payments,
  });
}

async function onDryRun() {
  try {
    setStatus('Simulating (local ABI serialization)…', 'info');
    const actions = await buildPlan();
    const out = await dryRunActions(actions);
    state.lastDryRun = { actions, abi_serialization: out };
    const ok = out.every((r) => !r.error);
    setStatus(
      ok
        ? `Simulation OK, ${actions.length} action(s) serialize cleanly.`
        : 'Simulation failed for at least one action.',
      ok ? 'ok' : 'err',
    );
  } catch (err) {
    setStatus((err as Error).message, 'err');
  }
  render();
}

async function onExecute() {
  const session = getCurrentSession();
  if (!session || !state.blend) return;
  // Random blends take a different on-chain path (fuse + claim) and a
  // different UI flow (state machine with auto-wait). Route to the RNG
  // handler when the blend is not fully deterministic.
  if (!isDeterministic(state.blend).ok) {
    await onExecuteRng();
    return;
  }
  const actions = await buildPlan().catch((e) => {
    setStatus((e as Error).message, 'err');
    return null;
  });
  if (!actions) return;
  if (
    !confirm(
      `Sign ${actions.length} action(s)?\n\n` +
        actions.map((a, i) => `${i + 1}. ${a.account}::${a.name}`).join('\n'),
    )
  )
    return;
  try {
    setStatus('Awaiting wallet signature…', 'info');
    const result = await executeBlend(session, {
      blend_id: state.blend.blend_id,
      asset_ids: flattenNftSelection(state.slots, state.selection),
      ft_payments: ftSlots(state.slots).map((s) => s.quantity),
    });
    const trxId =
      (result.response as { transaction_id?: string } | undefined)?.transaction_id ??
      String(result.resolved?.transaction.id ?? '');
    state.lastTrxId = trxId;
    setStatus(`Transaction broadcast: ${trxId}`, 'ok');
  } catch (err) {
    setStatus(`Transaction failed: ${(err as Error).message}`, 'err');
  }
  render();
}

// ─── RNG blend execution (fuse + wait + claim) ─────────────────────── //

/**
 * Picks the right `SECURITY_CHECK` payload for the current blend. For
 * non-secured or whitelist-secured blends we send a no-op WHITELIST_CHECK
 * with the user's own account, which is also exactly what every recent
 * on-chain trace does for non-ownership-gated blends. Ownership-secured
 * blends would need extra UI to pick proof NFTs and are out of scope
 * for this first pass; we surface a friendly error in that case.
 */
function defaultSecurityCheck(claimer: string): SecurityCheck {
  return { kind: 'whitelist', account_name: claimer };
}

/**
 * Step 1 of the random-blend flow: announce, deposit, and request a
 * fuse. On success, snapshot the user's existing `claimassets` rows
 * (so we don't accidentally claim an older pending one), broadcast TX1,
 * and immediately start polling for the new claimassets row.
 */
async function onExecuteRng() {
  const session = getCurrentSession();
  if (!session || !state.blend) return;
  const claimer = String(session.actor);
  // Confirm with the user (same UX as deterministic execute).
  const security_check = defaultSecurityCheck(claimer);
  const actions = await buildFuseActions({
    claimer,
    blend_id: state.blend.blend_id,
    asset_ids: flattenNftSelection(state.slots, state.selection),
    ft_payments: ftSlots(state.slots).map((s) => s.quantity),
    security_check,
  });
  if (
    !confirm(
      `Sign ${actions.length} action(s)? Then a second signature will be required after the oracle resolves the result.\n\n` +
        actions.map((a, i) => `${i + 1}. ${a.account}::${a.name}`).join('\n'),
    )
  ) {
    return;
  }
  // Snapshot before broadcasting so we can spot the freshly created row.
  const known = await readKnownClaimIds(claimer);
  state.rngPhase = 'announcing';
  state.rngPhaseMessage = 'Awaiting wallet signature for step 1 (announce + fuse)…';
  render();
  try {
    const result = await executeFuse(session, {
      blend_id: state.blend.blend_id,
      asset_ids: flattenNftSelection(state.slots, state.selection),
      ft_payments: ftSlots(state.slots).map((s) => s.quantity),
      security_check,
    });
    state.rngTx1Id =
      (result.response as { transaction_id?: string } | undefined)?.transaction_id ??
      String(result.resolved?.transaction.id ?? '');
    state.rngPhase = 'waiting';
    state.rngPhaseMessage = 'TX1 broadcast. Waiting for the contract to stage the result...';
    state.rngWaitElapsedMs = 0;
    state.rngAbort = new AbortController();
    render();
    const row = await waitForClaim({
      claimer,
      blend_id: state.blend.blend_id,
      knownClaimIds: known,
      onTick: (elapsedMs) => {
        state.rngWaitElapsedMs = elapsedMs;
        if (state.view === 'blends') render();
      },
      signal: state.rngAbort.signal,
    });
    state.rngClaim = row;
    state.rngPhase = 'ready';
    state.rngPhaseMessage = `Result staged. ${row.claims.length} card${row.claims.length === 1 ? '' : 's'} ready to mint.`;
    state.rngAbort = undefined;
    render();
  } catch (err) {
    state.rngPhase = 'error';
    state.rngPhaseMessage = (err as Error).message;
    state.rngAbort = undefined;
    render();
  }
}

/**
 * Step 2: claim the staged outcome. `roll_count` matches the blend's
 * roll count (one entry per roll in `roll_indexes`).
 */
async function onClaimRng() {
  const session = getCurrentSession();
  if (!session || !state.blend || !state.rngClaim) return;
  state.rngPhase = 'claiming';
  state.rngPhaseMessage = 'Awaiting wallet signature for step 2 (mint the cards)…';
  render();
  try {
    const result = await executeRngClaim(session, {
      claim_id: state.rngClaim.claim_id,
      roll_count: state.blend.rolls?.length ?? 1,
    });
    state.rngTx2Id =
      (result.response as { transaction_id?: string } | undefined)?.transaction_id ??
      String(result.resolved?.transaction.id ?? '');
    state.rngPhase = 'done';
    state.rngPhaseMessage = `Pack opened. ${state.rngClaim.claims.length} NFT(s) minted to your wallet.`;
    render();
  } catch (err) {
    state.rngPhase = 'error';
    state.rngPhaseMessage = (err as Error).message;
    render();
  }
}

/** Cancels an in-progress wait for the claimassets row. */
function onCancelRngWait() {
  state.rngAbort?.abort();
  state.rngAbort = undefined;
  state.rngPhase = 'error';
  state.rngPhaseMessage =
    'You cancelled the wait. Your deposit is still locked in blend.nefty; reload the blend to resume the claim.';
  render();
}

/** Resets the RNG state machine so the user can try another blend. */
function onResetRng() {
  if (state.rngAbort) {
    state.rngAbort.abort();
    state.rngAbort = undefined;
  }
  state.rngPhase = 'idle';
  state.rngPhaseMessage = undefined;
  state.rngTx1Id = undefined;
  state.rngTx2Id = undefined;
  state.rngClaim = undefined;
  state.rngWaitElapsedMs = 0;
  render();
}

// ─── UPGRADE view handlers ───────────────────────────────────────────── //

/**
 * Fetches all `up.nefty` upgrades for the active collection and
 * refreshes the wallet inventory used to pre-pick assets_to_upgrade.
 */
async function loadUpgradesList() {
  const u = state.upgrades;
  u.loading = true;
  u.error = undefined;
  u.progress = undefined;
  render();
  try {
    const { upgrades } = await listUpgrades({
      collection: state.discoveryCollection,
      includeInactive: u.showInactive,
      onProgress: (message, pct) => {
        u.progress = { pct, message };
        render();
      },
    });
    u.list = upgrades;
    // Refresh wallet inventory for the same collection so we can match
    // template requirements to owned assets.
    const session = getCurrentSession();
    if (session) {
      try {
        state.discoveryOwnedAssets = await listAssetsForOwner({
          owner: String(session.actor),
          collection_name: state.discoveryCollection,
        });
      } catch {
        // non-fatal: matcher will fall back to empty
      }
    }
  } catch (err) {
    u.error = (err as Error).message;
    u.list = [];
  } finally {
    u.loading = false;
    u.progress = undefined;
    render();
  }
}

function onToggleUpgradesShowInactive(checked: boolean) {
  state.upgrades.showInactive = checked;
  state.upgrades.list = [];
  state.upgrades.error = undefined;
  render();
}

function onToggleUpgradesPicker() {
  state.upgrades.pickerOpen = !state.upgrades.pickerOpen;
  render();
}

async function onPickUpgrade(upgrade_id: string) {
  const u = state.upgrades;
  u.pickerOpen = false;
  const found = u.list.find((up) => up.upgrade_id === upgrade_id);
  if (!found) return;
  u.picked = found;
  u.upgradeIdInput = upgrade_id;
  u.selection.clear();
  u.lastDryRun = undefined;
  u.lastTrxId = undefined;
  writeHashRoute('nefty', 'upgrades', upgrade_id);
  render();
  await refreshUpgradeFtStatus();
}

async function onLoadUpgradeManual() {
  const u = state.upgrades;
  if (!u.upgradeIdInput) {
    setStatus('Enter an upgrade_id first.', 'err');
    return;
  }
  // If it's already in the discovered list, just pick it.
  const local = u.list.find((up) => up.upgrade_id === u.upgradeIdInput);
  if (local) {
    onPickUpgrade(u.upgradeIdInput);
    return;
  }
  u.loading = true;
  render();
  try {
    const up = await loadUpgradeById(u.upgradeIdInput);
    if (!up) {
      setStatus(`Upgrade ${u.upgradeIdInput} not found.`, 'err');
      return;
    }
    u.picked = up;
    u.selection.clear();
    u.lastDryRun = undefined;
    u.lastTrxId = undefined;
    // If the upgrade's collection differs from the active one, switch
    // implicitly so the wallet match works.
    if (up.collection_name && up.collection_name !== state.discoveryCollection) {
      state.discoveryCollection = up.collection_name;
    }
    try {
      const session = getCurrentSession();
      if (session) {
        state.discoveryOwnedAssets = await listAssetsForOwner({
          owner: String(session.actor),
          collection_name: up.collection_name,
        });
      }
    } catch { /* non-fatal */ }
    await refreshUpgradeFtStatus();
  } catch (err) {
    setStatus(`Error: ${(err as Error).message}`, 'err');
  } finally {
    u.loading = false;
    render();
  }
}

/**
 * Reads the user's balance for each FT ingredient of the picked
 * upgrade so we can show insufficient-balance warnings in zone 4.
 */
async function refreshUpgradeFtStatus() {
  const u = state.upgrades;
  u.ftStatus.clear();
  if (!u.picked) return;
  const session = getCurrentSession();
  if (!session) return;
  const owner = String(session.actor);
  u.picked.ingredients.forEach((ing, idx) => {
    if (ing.kind !== 'ft') return;
    const required = parseAssetAmount(ing.quantity);
    const ticker = tickerFromQuantity(ing.quantity);
    if (!ticker || !Number.isFinite(required)) return;
    void (async () => {
      try {
        const contract = await resolveTokenContract(ing.quantity);
        const balance = await readTokenBalance({ owner, contract, symbolCode: ticker });
        u.ftStatus.set(idx, { ticker, required, balance });
      } catch {
        u.ftStatus.set(idx, { ticker, required, balance: -1 });
      } finally {
        render();
      }
    })();
  });
}

function onPickUpgradeAsset(specIdx: number, asset_id: string) {
  const u = state.upgrades;
  // Toggle: re-clicking the same asset deselects it.
  const current = u.selection.get(specIdx);
  if (current === asset_id) {
    u.selection.delete(specIdx);
  } else {
    // Prevent the same asset being used by two different specs.
    for (const [other, id] of u.selection.entries()) {
      if (other !== specIdx && id === asset_id) {
        setStatus(`Asset ${asset_id} is already picked by spec #${other}.`, 'warn');
        return;
      }
    }
    u.selection.set(specIdx, asset_id);
  }
  render();
}

/**
 * Returns the list of owned assets that satisfy a given UpgradeSpec
 * (currently: just template_ids from TEMPLATE / TEMPLATES requirements).
 * Attribute requirements are not enforced client-side, the contract
 * will reject if the user picks a non-matching asset.
 */
function ownedAssetsForSpec(spec: DiscoveredUpgrade['specs'][number]): AtomicAsset[] {
  const owned = state.discoveryOwnedAssets;
  // Collect template_ids from each requirement.
  const accepted = new Set<number>();
  for (const req of spec.requirements) {
    if (req.kind === 'template') accepted.add(req.template_id);
    if (req.kind === 'templates') for (const id of req.template_ids) accepted.add(id);
  }
  // Filter by schema first, then by template.
  return owned.filter((a) => {
    if (a.schema?.schema_name && a.schema.schema_name !== spec.schema_name) return false;
    if (accepted.size === 0) return true; // attribute-only filters: show all in the schema
    const tid = a.template?.template_id;
    return tid != null && accepted.has(Number(tid));
  });
}

function readyToUpgrade(): boolean {
  const u = state.upgrades;
  if (!u.picked) return false;
  if (u.picked.status !== 'active') return false;
  if (u.picked.is_random) return false; // out of scope for v1
  if (u.picked.whitelist_required) return false; // gated upgrades not supported in v1
  // Every spec must have a picked asset.
  for (let i = 0; i < u.picked.specs.length; i++) {
    if (!u.selection.get(i)) return false;
  }
  // Every FT ingredient must be covered.
  for (let i = 0; i < u.picked.ingredients.length; i++) {
    const ing = u.picked.ingredients[i];
    if (ing.kind !== 'ft') {
      // NFT cost ingredients not supported via UI in v1.
      return false;
    }
    const st = u.ftStatus.get(i);
    if (!st || st.balance < 0 || st.balance < st.required) return false;
  }
  return true;
}

async function buildUpgradePlan(): Promise<BuiltAction[]> {
  const session = getCurrentSession();
  const u = state.upgrades;
  if (!session || !u.picked) throw new Error('No session / upgrade loaded');
  const assets_to_upgrade = Array.from(
    { length: u.picked.specs.length },
    (_, i) => u.selection.get(i),
  ).filter((x): x is string => !!x);
  const ft_payments = u.picked.ingredients
    .filter((ing): ing is Extract<UpgradeIngredient, { kind: 'ft' }> => ing.kind === 'ft')
    .map((ing) => ing.quantity);
  return buildUpgradeActions({
    claimer: String(session.actor),
    upgrade_id: u.picked.upgrade_id,
    assets_to_upgrade,
    transferred_assets: [],
    own_assets: [],
    ft_payments,
  });
}

async function onUpgradeDryRun() {
  const u = state.upgrades;
  try {
    setStatus('Simulating upgrade (local ABI serialisation)...', 'info');
    const actions = await buildUpgradePlan();
    const out = await dryRunActions(actions);
    u.lastDryRun = { actions, abi_serialization: out };
    const ok = out.every((r) => !r.error);
    setStatus(ok ? `Simulation OK, ${actions.length} action(s) serialize cleanly.` : 'Simulation failed.', ok ? 'ok' : 'err');
  } catch (err) {
    setStatus((err as Error).message, 'err');
  }
  render();
}

async function onExecuteUpgrade() {
  const session = getCurrentSession();
  const u = state.upgrades;
  if (!session || !u.picked) return;
  u.pending = true;
  render();
  try {
    const assets_to_upgrade = Array.from(
      { length: u.picked.specs.length },
      (_, i) => u.selection.get(i),
    ).filter((x): x is string => !!x);
    const ft_payments = u.picked.ingredients
      .filter((ing): ing is Extract<UpgradeIngredient, { kind: 'ft' }> => ing.kind === 'ft')
      .map((ing) => ing.quantity);
    setStatus('Awaiting wallet signature for the upgrade...', 'info');
    const result = await executeUpgrade(session, {
      upgrade_id: u.picked.upgrade_id,
      assets_to_upgrade,
      transferred_assets: [],
      own_assets: [],
      ft_payments,
    });
    const trxId =
      (result.response as { transaction_id?: string } | undefined)?.transaction_id ??
      String(result.resolved?.transaction.id ?? '');
    u.lastTrxId = trxId;
    setStatus(`Upgrade broadcast: ${trxId}`, 'ok');
  } catch (err) {
    setStatus(`Upgrade failed: ${(err as Error).message}`, 'err');
  } finally {
    u.pending = false;
    render();
  }
}

// ─── render ───────────────────────────────────────────────────────────── //

/**
 * Renders a small "share link" button. Click copies the current page
 * URL (already pointing at the picked entity via the hash) to the
 * clipboard. Used by every info card (blend, drop, upgrade, waxdao)
 * so a user can share what they're looking at in one click.
 */
function renderShareButton(): string {
  return `
    <button class="share-btn" data-action="copyShareLink"
            title="Copy a direct link to this. Anyone opening it will see this exact entity and be prompted to connect their wallet.">
      ⎘ share link
    </button>`;
}

/**
 * Copies the current location.href to the clipboard. The URL already
 * carries the hash route (#/<platform>/<tab>/<id>) for whatever the
 * user is currently looking at, so the recipient lands on the same
 * entity.
 */
async function onCopyShareLink() {
  try {
    const url = location.href;
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(url);
      setStatus(`Link copied: ${url}`, 'ok');
    } else {
      // Fallback: legacy execCommand. Some embedded webviews still
      // ship without the async clipboard API.
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setStatus(`Link copied: ${url}`, 'ok');
    }
  } catch {
    setStatus('Could not copy link, copy the URL bar manually.', 'warn');
  }
}

/**
 * Produces a short human label describing the entity currently loaded
 * via a deep link, used in the Connect-wallet banner.
 */
function activeDeepLinkLabel(): string | undefined {
  const r = parseHashRoute();
  if (!r.id) return undefined;
  switch (r.view) {
    case 'blends':
      return `blend #${r.id} (NeftyBlocks)`;
    case 'drops':
      return `drop #${r.id} (NeftyBlocks)`;
    case 'upgrades':
      return `upgrade #${r.id} (NeftyBlocks)`;
    case 'waxdao-blends':
      return `blend #${r.id} (WaxDAO)`;
    default:
      return undefined;
  }
}

function renderConnect(session: ReturnType<typeof getCurrentSession>): string {
  if (!session) {
    const label = activeDeepLinkLabel();
    const banner = label
      ? `<p class="status-line warn" style="margin-bottom:10px">
           <strong>Shared link detected.</strong> You're looking at
           <code>${escapeHtml(label)}</code>. Connect a wallet to be able to
           sign it.
         </p>`
      : '';
    return `
      <div class="card">
        <h2>1 · Connect wallet</h2>
        ${banner}
        <p class="term">Anchor or WAX Cloud Wallet. No backend, your key stays in your wallet.</p>
        <div class="row" style="margin-top:10px">
          <button class="primary" data-action="login">Initialize session</button>
        </div>
      </div>`;
  }
  const walletName = (session.walletPlugin as { metadata?: { name?: string } }).metadata?.name ?? 'wallet';
  return `
    <div class="card">
      <h2>session</h2>
      <div class="row">
        <span class="tag accent">${escapeHtml(String(session.actor))}@${escapeHtml(String(session.permission))}</span>
        <span class="tag">${escapeHtml(walletName)}</span>
        <div class="spacer"></div>
        <button data-action="logout">Disconnect</button>
      </div>
    </div>`;
}

function statusLabel(s: DiscoveredStatus): string {
  switch (s) {
    case 'active':   return 'active';
    case 'upcoming': return 'upcoming';
    case 'ended':    return 'ended';
    case 'sold_out': return 'sold out';
    case 'hidden':   return 'hidden';
  }
}

/**
 * Free-form collection input. Starts empty. Any WAX account name can be
 * typed. Underneath the input, SUPPORTED_COLLECTIONS are rendered as
 * clickable chips: clicking one fills the input and commits the change
 * (same effect as typing the name + pressing Enter).
 */
/**
 * Just the text input for the discovery collection. The suggestion
 * chips live on their own row below so the input + picker dropdown can
 * sit on the same horizontal baseline at the top of the card.
 */
function renderCollectionInput(): string {
  return `
    <input
      id="collectionPick"
      type="text"
      autocomplete="off"
      spellcheck="false"
      maxlength="12"
      placeholder="type a collection..."
      value="${escapeHtml(state.discoveryCollection)}"
    />`;
}

/**
 * Suggestion chips for the SUPPORTED_COLLECTIONS list. Free-form
 * collection names are still accepted, this is a convenience.
 */
function renderCollectionChips(): string {
  const chips = SUPPORTED_COLLECTIONS
    .map((c) => {
      const active = state.discoveryCollection === c ? ' active' : '';
      return `<button type="button" class="collection-chip${active}" data-action="pickCollection" data-collection="${escapeHtml(c)}">${escapeHtml(c)}</button>`;
    })
    .join('');
  return `
    <div class="collection-chips">
      <span class="collection-chips-label">suggestions:</span>
      ${chips}
    </div>`;
}

function renderPickerToggle(): string {
  let label = 'Select a blend...';
  const notLoadedYet = state.discovered.length === 0 && !state.discoveryLoading && !state.discoveryError;
  if (notLoadedYet) {
    label = `Click "Discover blends" to load ${state.discoveryCollection || 'a collection'}’s list`;
  } else if (state.discoveryLoading) {
    label = state.discoveryProgress?.message ?? 'Loading blends...';
  } else if (state.discoveryError) {
    label = 'Discovery failed, use manual entry below';
  } else if (state.blend) {
    label = `[#${state.blend.blend_id}] ${state.blend.collection_name}`;
  } else {
    const found = state.discovered.find((b) => b.blend_id === state.blendId);
    if (found) label = `[#${found.blend_id}] ${found.name}`;
  }
  const disabled = state.discoveryLoading || state.discoveryError || notLoadedYet;
  return `
    <button class="picker-toggle" data-action="togglePicker" ${disabled ? 'disabled' : ''}>
      <span class="picker-current">${escapeHtml(label)}</span>
      <span class="picker-caret">${state.pickerOpen ? '▴' : '▾'}</span>
    </button>`;
}

function renderPickerPanel(): string {
  if (!state.pickerOpen || state.discoveryLoading || state.discoveryError) return '';
  // Apply the "only show executable" filter when the user enabled it.
  const visible = state.onlyExecutable
    ? state.discovered.filter((b) => isBlendExecutable(b, state.discoveryOwnedAssets))
    : state.discovered;
  if (visible.length === 0) {
    const msg = state.onlyExecutable && state.discovered.length > 0
      ? `No blends your wallet can satisfy right now. Untick "only show what I can blend" to see all ${state.discovered.length}.`
      : 'No blends found.';
    return `<div class="picker-panel"><div class="picker-empty">${escapeHtml(msg)}</div></div>`;
  }
  const rows = visible
    .map((b) => {
      const wlDenied = b.whitelist_required && b.whitelist_allowed === false;
      const wlPending = b.whitelist_required && b.whitelist_allowed === undefined;
      const disabled = wlDenied;
      const classes = ['picker-row'];
      if (disabled) classes.push('picker-row-disabled');
      const wlBadge = wlDenied
        ? '<span class="picker-wl-badge">not whitelisted</span>'
        : wlPending
          ? '<span class="picker-wl-badge pending">whitelist?</span>'
          : '';
      const rngBadge = b.is_random
        ? '<span class="picker-wl-badge pending" title="Random blend: 2 signatures (fuse + claim) instead of 1.">RNG</span>'
        : '';
      return `
        <div class="${classes.join(' ')}" ${disabled ? '' : `data-action="pickRow" data-blend="${escapeHtml(b.blend_id)}"`}>
          <span class="picker-id">#${escapeHtml(b.blend_id)}</span>
          <span class="picker-name">${escapeHtml(b.name)}</span>
          ${rngBadge}
          ${wlBadge}
          <span class="status-chip status-${escapeHtml(b.status)}">${escapeHtml(statusLabel(b.status))}</span>
        </div>`;
    })
    .join('');
  return `<div class="picker-panel"><div class="picker-rows">${rows}</div></div>`;
}

/**
 * Inline notice that appears under the toggles when the "only show
 * what I can blend" filter is active and the wallet cannot satisfy any
 * blend in the loaded list. Without this, the user just sees an empty
 * dropdown and might think the filter is broken.
 */
function noBlendsEligibleNotice(): string {
  if (!state.onlyExecutable) return '';
  if (state.discovered.length === 0) return '';
  const eligible = state.discovered.filter((b) => isBlendExecutable(b, state.discoveryOwnedAssets));
  if (eligible.length > 0) return '';
  return `<p class="status-line warn">Your wallet can't fully cover any of the ${state.discovered.length} blends in this list right now. Untick "only show what I can blend" to see them all, or change collection.</p>`;
}

function renderLegend(): string {
  return `
    <div class="legend">
      <span class="legend-label">Color codes</span>
      <span class="legend-item"><span class="status-chip status-active">active</span></span>
      <span class="legend-item"><span class="status-chip status-sold_out">sold out</span></span>
      <span class="legend-item"><span class="status-chip status-ended">ended</span></span>
      <span class="legend-item"><span class="status-chip status-upcoming">upcoming</span></span>
      <span class="legend-item"><span class="status-chip status-hidden">hidden</span></span>
      <span class="legend-sep">·</span>
      <span class="legend-item">
        <span class="picker-wl-badge pending">RNG</span>
        random blend, signs in two transactions (fuse + claim)
      </span>
      <span class="legend-item">
        <span class="picker-wl-badge">not whitelisted</span>
        your account isn't on this blend's whitelist (row stays disabled)
      </span>
      <span class="legend-item">
        <span class="picker-wl-badge pending">whitelist?</span>
        whitelist not yet checked (connect your wallet)
      </span>
    </div>`;
}

function renderPickBlend(): string {
  const sourceTag = state.discoverySource === 'on_chain'
    ? '<span class="tag warn">on-chain scan</span>'
    : state.discoverySource === 'indexer'
      ? '<span class="tag ok">indexed</span>'
      : '';
  const counts = state.discovered.length > 0
    ? `${state.discovered.length} blend${state.discovered.length === 1 ? '' : 's'} found`
    : '';
  const progressBar = state.discoveryLoading && state.discoveryProgress
    ? `<div class="progress"><div class="progress-fill" style="width:${Math.round(state.discoveryProgress.pct * 100)}%"></div></div>`
    : '';

  const refreshLabel = state.discoveryLoading
    ? 'Refreshing...'
    : state.discovered.length > 0
      ? 'Refresh blends'
      : 'Discover blends';
  return `
    <div class="card">
      <h2>2 · Pick a blend</h2>
      <div class="row" style="gap:14px; align-items: flex-end; margin-bottom: 8px">
        <div style="width: 140px; flex: 0 0 140px">
          <label>Collection</label>
          ${renderCollectionInput()}
        </div>
        <div style="flex: 1 1 380px; min-width: 280px">
          <label>Available blends</label>
          <div class="picker">
            ${renderPickerToggle()}
            ${renderPickerPanel()}
          </div>
        </div>
        <button class="primary" data-action="refreshBlends" ${state.discoveryLoading || !isValidWaxName(state.discoveryCollection) ? 'disabled' : ''}>
          ${escapeHtml(refreshLabel)}
        </button>
      </div>
      ${renderCollectionChips()}
      ${progressBar}
      <div class="row" style="margin-top:10px; gap:14px; align-items:center; flex-wrap:wrap">
        <label class="inline-toggle">
          <input id="showInactive" type="checkbox" data-action="toggleInactive" ${state.showInactive ? 'checked' : ''} />
          <span>show ended / upcoming / sold-out</span>
        </label>
        <label class="inline-toggle" title="${getCurrentSession() ? 'Filter the list to blends your wallet can satisfy right now (NFT slots).' : 'Connect your wallet first; we need to know which NFTs you own.'}">
          <input id="onlyExecutable" type="checkbox" data-action="toggleOnlyExecutable" ${state.onlyExecutable ? 'checked' : ''} ${getCurrentSession() ? '' : 'disabled'} />
          <span>only show what I can blend</span>
        </label>
        <div class="spacer"></div>
        ${sourceTag}
        <span class="term">${escapeHtml(counts)}</span>
      </div>
      ${noBlendsEligibleNotice()}
      ${renderLegend()}

      <div class="divider"></div>

      <label>Or enter a blend_id manually</label>
      <div class="row" style="gap:14px; align-items: flex-end">
        <div style="flex:1; min-width: 200px">
          <input id="blendId" type="text" value="${escapeHtml(state.blendId)}" placeholder="e.g. 43444" autocomplete="off" />
        </div>
        <button class="primary" data-action="loadBlend" ${state.pending ? 'disabled' : ''}>
          ${state.pending ? 'Loading…' : 'Load blend'}
        </button>
      </div>
      ${state.discoveryError ? `<p class="status-line warn">Discovery: ${escapeHtml(state.discoveryError)}</p>` : ''}
    </div>`;
}

function renderSkeleton(label: string): string {
  return `
    <div class="card skeleton-card">
      <h2>${escapeHtml(label)}</h2>
      <div class="skeleton-bar shimmer" style="width: 60%"></div>
      <div class="skeleton-bar shimmer" style="width: 40%"></div>
      <div class="skeleton-bar shimmer" style="width: 75%"></div>
      <p class="status-line">Reading the recipe from <code>blend.nefty</code>: this may take a few seconds, especially if the indexer is down and we're scanning the chain directly.</p>
    </div>`;
}

function renderExpectedMint(): string {
  const b = state.blend;
  if (!b) return '';
  const results = deterministicResults(b);
  if (results.length === 0) {
    return '<p class="status-line warn">No on-demand mint result, output may be empty or out of this app\'s scope.</p>';
  }
  const t = state.template;
  const loading = state.templateLoading;
  const primary = results[0];

  const rowsForPrimary = (() => {
    if (loading && !t) {
      return `
        <li><strong>Name:</strong> <span class="shimmer skeleton-inline">loading…</span></li>
        <li><strong>Template:</strong> <code>${escapeHtml(String(primary.template_id))}</code></li>
        <li><strong>Schema:</strong> <span class="shimmer skeleton-inline">loading…</span></li>
        <li><strong>Issued / max:</strong> <span class="shimmer skeleton-inline">loading…</span></li>`;
    }
    const name = t?.name ?? '(unknown, indexer down, name not on-chain readable)';
    const max = t?.max_supply ? String(t.max_supply) : '∞';
    const issued = t?.issued_supply ?? '?';
    const remaining = t && t.max_supply > 0
      ? Math.max(0, t.max_supply - t.issued_supply)
      : null;
    const flags = t
      ? `${t.is_transferable ? 'transferable' : 'soulbound'} · ${t.is_burnable ? 'burnable' : 'non-burnable'}`
      : '';
    return `
      <li><strong>Name:</strong> ${escapeHtml(String(name))}</li>
      <li><strong>Template:</strong> <code>${escapeHtml(String(t?.template_id ?? primary.template_id))}</code></li>
      ${t?.schema_name ? `<li><strong>Schema:</strong> <code>${escapeHtml(t.schema_name)}</code></li>` : ''}
      <li><strong>Issued / max:</strong> ${escapeHtml(String(issued))} / ${escapeHtml(max)} ${remaining !== null ? `<span class="term">(${remaining} left to mint)</span>` : ''}</li>
      ${flags ? `<li class="term">${flags}</li>` : ''}`;
  })();

  const extras = results.length > 1
    ? `<p class="term">+ ${results.length - 1} additional mint(s), IDs: ${results.slice(1).map((r) => `<code>${r.template_id}</code>`).join(', ')}</p>`
    : '';

  return `
    <ul class="mint-info">${rowsForPrimary}</ul>
    ${extras}
  `;
}

function renderBlendInfo(): string {
  if (state.blendLoading) {
    return renderSkeleton('3 · Loading blend recipe…');
  }
  const b = state.blend;
  if (!b) return '';
  const det = isDeterministic(b);
  const wl = state.whitelist;
  const remainingUses = b.max && Number(b.max) > 0
    ? `${b.use_count}/${b.max} (${Math.max(0, Number(b.max) - Number(b.use_count))} left)`
    : `${b.use_count}/∞`;
  return `
    <div class="card">
      <div class="card-header">
        <h2>3 · Blend #${escapeHtml(String(b.blend_id))} <span class="term">-- ${escapeHtml(b.collection_name)}</span></h2>
        ${renderShareButton()}
      </div>
      <div class="row">
        ${det.ok
          ? '<span class="tag ok">deterministic · single output</span>'
          : '<span class="tag warn">random · oracle picks one outcome per roll</span>'}
        ${
          wl?.required
            ? wl.allowed
              ? '<span class="tag ok">whitelist · allowed</span>'
              : '<span class="tag err">whitelist · denied</span>'
            : '<span class="tag">open · no whitelist</span>'
        }
        <span class="tag">uses ${escapeHtml(remainingUses)}</span>
      </div>
      ${det.ok ? `<h3>Expected mint</h3>${renderExpectedMint()}` : renderRngOdds(b)}
      ${wl?.required && !wl.allowed ? `<p class="status-line err">${escapeHtml(wl.reason ?? '')}</p>` : ''}
    </div>
  `;
}

/**
 * Renders the per-roll outcome table for a random blend, including the
 * percentage chance of each outcome. Same `pack-roll` accordion CSS the
 * UNPACK tab uses, for visual consistency.
 */
function renderRngOdds(b: BlendRow): string {
  const rolls = b.rolls ?? [];
  if (rolls.length === 0) return '<p class="status-line warn">No rolls declared on this blend.</p>';
  const blocks = rolls.map((roll, i) => {
    const total = roll.total_odds || roll.outcomes.reduce((a, o) => a + o.odds, 0);
    const items = roll.outcomes.slice(0, 8).map((o) => {
      const pct = total > 0 ? ((o.odds / total) * 100).toFixed(2) : '?';
      const desc = (o.results ?? []).map((r) => {
        const kind = r[0];
        if (kind === 'ON_DEMAND_NFT_RESULT') {
          return `<code>template ${escapeHtml(String((r[1] as { template_id?: number }).template_id))}</code>`;
        }
        if (kind === 'POOL_NFT_RESULT') {
          return `<span class="term">pool draw</span>`;
        }
        if (kind === 'FT_RESULT') {
          const amt = (r[1] as { amount?: { quantity?: string } })?.amount?.quantity;
          return `<code>${escapeHtml(amt ?? 'token reward')}</code>`;
        }
        return `<span class="term">${escapeHtml(String(kind))}</span>`;
      }).join(' + ') || '<span class="term">no result entry</span>';
      return `<li>${desc} <span class="term">${pct}%</span></li>`;
    });
    const more = roll.outcomes.length > 8
      ? `<li class="term">+ ${roll.outcomes.length - 8} more outcome${roll.outcomes.length - 8 === 1 ? '' : 's'}…</li>`
      : '';
    return `<details class="pack-roll" open><summary>Roll #${i} · ${roll.outcomes.length} possible outcome${roll.outcomes.length === 1 ? '' : 's'}</summary><ul class="mint-info">${items.join('')}${more}</ul></details>`;
  });
  return `<h3>Possible mints</h3><p class="status-line" style="margin-bottom:6px">This blend has multiple outcomes per roll. The on-chain contract will randomly pick one outcome per roll when you submit. Probabilities below are the in-roll odds.</p>${blocks.join('')}`;
}

/**
 * Returns the best human-readable name for an asset. Priority:
 *   1. The asset's own `name` (immutable_data.name surfaced by the
 *      AtomicAssets indexer)
 *   2. The asset's `data.name` (mutable-data fallback)
 *   3. The cached resolved template name for `a.template.template_id`
 *      (populated lazily by enrichAssetTemplateNames)
 *   4. "template #<id>" if all else fails
 *
 * The cache lives in `state.templateNames`. When a row needs an
 * unresolved name we fire-and-forget a fetch through the AtomicAssets
 * indexer; the row re-renders once the name lands.
 */
function displayAssetName(a: AtomicAsset): string {
  if (a.name) return a.name;
  const dataName = (a.data && typeof a.data === 'object' && (a.data as Record<string, unknown>).name);
  if (typeof dataName === 'string' && dataName) return dataName;
  const tid = a.template?.template_id;
  if (tid != null) {
    const cached = state.templateNames.get(Number(tid));
    if (cached) return cached;
    // Kick off a best-effort name fetch (will trigger a re-render).
    void enrichAssetTemplateName(a);
    return `template #${tid}`;
  }
  return 'asset';
}

const _templateFetchInflight = new Set<number>();
async function enrichAssetTemplateName(a: AtomicAsset): Promise<void> {
  const tid = a.template?.template_id;
  if (tid == null) return;
  const n = Number(tid);
  if (state.templateNames.has(n)) return;
  if (_templateFetchInflight.has(n)) return;
  _templateFetchInflight.add(n);
  try {
    const coll = a.collection?.collection_name ?? state.collection;
    if (!coll) return;
    const name = await fetchTemplateName(coll, n);
    if (name) {
      state.templateNames.set(n, name);
      render();
    }
  } catch {
    // silently ignore: row keeps the "template #<id>" fallback
  } finally {
    _templateFetchInflight.delete(n);
  }
}

function renderNftSlot(slot: IngredientSlot): string {
  if (slot.kind === 'UNSUPPORTED') {
    return `
      <div class="slot unsupported">
        <div class="slot-header"><div class="slot-label">${escapeHtml(slot.label)}</div></div>
        <p class="status-line err">This ingredient type is not handled by this app.</p>
      </div>`;
  }
  if (slot.kind === 'FT') return ''; // rendered separately
  const picked = state.selection.get(slot.index) ?? [];
  const items = slot.eligible.map((a) => {
    const selected = picked.includes(a.asset_id) ? ' selected' : '';
    const name = displayAssetName(a);
    const tid = a.template?.template_id;
    return `
      <div class="asset${selected}" data-action="toggle" data-slot="${slot.index}" data-asset="${escapeHtml(a.asset_id)}">
        <span>${escapeHtml(name)}</span>
        <span class="id">#${escapeHtml(a.asset_id)}${tid != null ? ' · tpl ' + escapeHtml(String(tid)) : ''}${a.template_mint ? ' · mint ' + escapeHtml(a.template_mint) : ''}</span>
      </div>`;
  });
  return `
    <div class="slot">
      <div class="slot-header">
        <div class="slot-label">${escapeHtml(slot.label)}</div>
        <div class="slot-progress">${picked.length}/${slot.amount} picked · ${slot.eligible.length} eligible</div>
      </div>
      ${
        slot.eligible.length === 0
          ? '<p class="status-line err">No eligible NFT in your wallet for this slot.</p>'
          : `<div class="asset-grid">${items.join('')}</div>`
      }
    </div>`;
}

function renderFtSlot(slot: FtSlot): string {
  const st = state.ftStatus.get(slot.index);
  const session = getCurrentSession();
  if (!session) {
    return `
      <div class="slot ft">
        <div class="slot-header">
          <div class="slot-label">${escapeHtml(slot.label)}</div>
          <div class="slot-progress">connect wallet to check balance</div>
        </div>
      </div>`;
  }
  if (!st) {
    return `
      <div class="slot ft">
        <div class="slot-header">
          <div class="slot-label">${escapeHtml(slot.label)}</div>
          <div class="slot-progress">resolving…</div>
        </div>
      </div>`;
  }
  if (st.balance < 0) {
    return `
      <div class="slot ft unsupported">
        <div class="slot-header">
          <div class="slot-label">${escapeHtml(slot.label)}</div>
          <div class="slot-progress">token not registered in blend.nefty config</div>
        </div>
      </div>`;
  }
  const sufficient = st.balance >= st.required;
  const ticker = tickerFromQuantity(slot.quantity);
  return `
    <div class="slot ft">
      <div class="slot-header">
        <div class="slot-label">${escapeHtml(slot.label)}</div>
        <div class="slot-progress ${sufficient ? '' : 'warn'}">
          balance ${st.balance} ${escapeHtml(ticker)} ${sufficient ? '✓' : '· INSUFFICIENT'}
        </div>
      </div>
      <p class="term">token contract <code>${escapeHtml(st.contract)}</code></p>
    </div>`;
}

function renderSlots(): string {
  if (state.blendLoading) return ''; // covered by section 3 skeleton
  if (!state.blend) return '';
  if (state.assetsLoading && state.slots.length === 0) {
    return renderSkeleton('4 · Indexing your eligible NFTs…');
  }
  if (state.slots.length === 0) return '';
  return `
    <div class="card">
      <h2>4 · Select inputs ${state.assetsLoading ? '<span class="term">(refreshing your wallet…)</span>' : ''}</h2>
      ${state.slots
        .map((s) => (s.kind === 'FT' ? renderFtSlot(s) : renderNftSlot(s)))
        .join('')}
    </div>`;
}

function renderActions(): string {
  if (!state.blend) return '';
  const totalRequired = totalRequiredNfts(state.slots);
  const totalPicked = Array.from(state.selection.values()).reduce((n, ids) => n + ids.length, 0);
  const ready = readyToSubmit();
  const isRandom = !isDeterministic(state.blend).ok;
  // Random blends route through a 2-step state machine. The state of
  // that machine drives a different button surface below.
  if (isRandom) return renderRngActions(ready, totalPicked, totalRequired);
  return `
    <div class="card">
      <h2>5 · Verify &amp; execute</h2>
      <div class="row">
        <button data-action="dryrun" ${ready ? '' : 'disabled'}>Simulate (no signature)</button>
        <button class="primary" data-action="execute" ${ready ? '' : 'disabled'}>Sign &amp; broadcast</button>
        <div class="spacer"></div>
        <span class="term">NFTs ${totalPicked}/${totalRequired}</span>
      </div>
      ${
        state.lastDryRun
          ? `<h3>Dry-run output</h3><pre>${escapeHtml(JSON.stringify(state.lastDryRun, null, 2))}</pre>`
          : ''
      }
      ${
        state.lastTrxId
          ? `<p class="status-line ok">Trx broadcast: <a target="_blank" href="https://waxblock.io/transaction/${escapeHtml(state.lastTrxId)}">${escapeHtml(state.lastTrxId)}</a></p>`
          : ''
      }
    </div>`;
}

/**
 * Renders the action card for the random-blend flow. Mirrors the pack
 * unbox state machine: idle -> announcing -> waiting -> ready ->
 * claiming -> done (or error at any point with a Reset button).
 */
function renderRngActions(ready: boolean, totalPicked: number, totalRequired: number): string {
  const phase = state.rngPhase;
  const cls = (kind: 'ok' | 'warn' | 'err' | 'info') =>
    `status-line ${kind === 'info' ? '' : kind}`;
  const txLink = (id?: string) =>
    id
      ? `<a target="_blank" href="https://waxblock.io/transaction/${escapeHtml(id)}">${escapeHtml(id.slice(0, 16))}…</a>`
      : '';

  let body = '';
  if (phase === 'idle') {
    body = `
      <p class="status-line">This blend has at least one roll with multiple possible outcomes. Crucible signs a first transaction (announce + fuse), waits for the contract to stage the result, then prompts you for a second signature (claim) that actually mints the cards.</p>
      <div class="row">
        <button data-action="dryrun" ${ready ? '' : 'disabled'}>Simulate (no signature)</button>
        <button class="primary" data-action="execute" ${ready ? '' : 'disabled'}>Sign step 1: announce + fuse</button>
        <div class="spacer"></div>
        <span class="term">NFTs ${totalPicked}/${totalRequired}</span>
      </div>
      ${state.lastDryRun ? `<h3>Dry-run output</h3><pre>${escapeHtml(JSON.stringify(state.lastDryRun, null, 2))}</pre>` : ''}`;
  } else if (phase === 'announcing') {
    body = `<p class="${cls('info')}">${escapeHtml(state.rngPhaseMessage ?? 'Awaiting signature…')}</p>`;
  } else if (phase === 'waiting') {
    const sec = Math.floor(state.rngWaitElapsedMs / 1000);
    body = `
      <p class="${cls('ok')}">TX1 broadcast: ${txLink(state.rngTx1Id)}</p>
      <p class="${cls('warn')}">Waiting for the contract to stage the result... ${sec}s elapsed</p>
      <div class="progress"><div class="progress-fill" style="width:${Math.min(100, (sec / 90) * 100)}%"></div></div>
      <div class="row" style="margin-top:10px">
        <button data-action="rngCancelWait">Cancel wait (deposit stays locked, reload to resume)</button>
      </div>`;
  } else if (phase === 'ready') {
    body = `
      <p class="${cls('ok')}">TX1 confirmed: ${txLink(state.rngTx1Id)}</p>
      <p class="${cls('ok')}">${escapeHtml(state.rngPhaseMessage ?? 'Ready to claim.')}</p>
      ${renderRngOutcome(false)}
      <div class="row">
        <button class="primary" data-action="rngClaim">Sign step 2: claim ${state.rngClaim?.claims.length ?? 1} card${(state.rngClaim?.claims.length ?? 1) === 1 ? '' : 's'}</button>
        <div class="spacer"></div>
      </div>`;
  } else if (phase === 'claiming') {
    body = `
      <p class="${cls('ok')}">TX1: ${txLink(state.rngTx1Id)}</p>
      <p class="${cls('info')}">${escapeHtml(state.rngPhaseMessage ?? 'Awaiting signature…')}</p>
      ${renderRngOutcome(false)}`;
  } else if (phase === 'done') {
    body = `
      <p class="${cls('ok')}">TX1: ${txLink(state.rngTx1Id)}</p>
      <p class="${cls('ok')}">TX2: ${txLink(state.rngTx2Id)}</p>
      <p class="${cls('ok')}">${escapeHtml(state.rngPhaseMessage ?? 'Done.')}</p>
      ${renderRngOutcome(true)}
      <div class="row">
        <button data-action="rngReset">Open another</button>
      </div>`;
  } else if (phase === 'error') {
    body = `
      <p class="${cls('err')}">${escapeHtml(state.rngPhaseMessage ?? 'Error.')}</p>
      ${state.rngTx1Id ? `<p class="status-line">TX1 (still valid on-chain): ${txLink(state.rngTx1Id)}</p>` : ''}
      <div class="row">
        <button data-action="rngReset">Reset</button>
      </div>`;
  }

  return `<div class="card"><h2>5 · Verify &amp; execute</h2>${body}</div>`;
}

/**
 * Renders the resolved claims from a random blend, with the in-roll
 * odds of each outcome shown next to it. Same layout as the pack
 * outcomes panel so the two flows feel symmetric.
 */
function renderRngOutcome(claimed: boolean): string {
  const row = state.rngClaim;
  if (!row || row.claims.length === 0) return '';
  const cls = claimed ? 'unbox-outcome claimed' : 'unbox-outcome rolled';

  const items = row.claims.map((c, idx) => {
    const variant = c.claim?.[0];
    const payload = c.claim?.[1] ?? {};
    let tidStr = '';
    if (variant === 'ON_DEMAND_NFT_CLAIM') {
      tidStr = String((payload as { template_id?: number }).template_id ?? '');
    } else if (variant === 'POOL_NFT_CLAIM') {
      tidStr = `pool asset ${String((payload as { asset_id?: string }).asset_id ?? '')}`;
    } else if (variant === 'FT_CLAIM') {
      tidStr = String((payload as { amount?: { quantity?: string } }).amount?.quantity ?? '');
    } else if (variant === 'EMPTY_CLAIM') {
      tidStr = 'empty (no mint)';
    }
    const rolls = state.blend?.rolls ?? [];
    const roll = rolls[idx];
    let pctLabel = '?';
    if (roll && variant === 'ON_DEMAND_NFT_CLAIM') {
      const total = roll.total_odds || roll.outcomes.reduce((a, o) => a + o.odds, 0);
      const tid = Number((payload as { template_id?: number }).template_id);
      const match = roll.outcomes.find((o) =>
        (o.results ?? []).some((r) => r[0] === 'ON_DEMAND_NFT_RESULT' && Number((r[1] as { template_id?: number }).template_id) === tid),
      );
      if (match && total > 0) pctLabel = `${((match.odds / total) * 100).toFixed(2)}%`;
    }
    const label = row.claims.length === 1 ? 'Card' : `Card ${idx + 1}`;
    return `
      <li class="${cls}">
        <span class="unbox-outcome-label">${escapeHtml(label)} <span class="term">(roll #${idx})</span></span>
        <span class="unbox-outcome-name"><span class="term">${escapeHtml(variant ?? 'unknown variant')}</span></span>
        <code class="unbox-outcome-tid">${escapeHtml(tidStr || '-')}</code>
        <span class="unbox-outcome-odds">${escapeHtml(pctLabel)}</span>
      </li>`;
  });

  const heading = claimed
    ? `<h3>Minted to your wallet</h3>`
    : `<h3>Oracle resolved</h3><p class="status-line" style="margin:4px 0 6px">The contract has staged the outcome below. Click step 2 to mint the result to your wallet. Percentages are the in-roll odds (chance of this exact outcome).</p>`;
  return `${heading}<ul class="unbox-outcomes">${items.join('')}</ul>`;
}

function renderStatus(): string {
  if (!state.status) return '';
  return `<p class="status-line ${state.statusKind}">${escapeHtml(state.status)}</p>`;
}

/**
 * Renders the top-level platform pills + the tab bar of the active
 * platform. Two platforms exist (Nefty / WaxDAO) and each one exposes
 * its own set of tabs. The pills update location.hash so the choice
 * is bookmarkable.
 */
function renderTabs(): string {
  const tab = (id: AppView, label: string, sub: string) => {
    const active = state.view === id ? ' active' : '';
    return `
      <button class="tab${active}" data-action="switchView" data-view="${id}">
        <span class="tab-label">${escapeHtml(label)}</span>
        <span class="tab-sub">${escapeHtml(sub)}</span>
      </button>`;
  };
  const pill = (p: Platform, label: string, sub: string) => {
    const active = state.platform === p ? ' active' : '';
    return `
      <button class="platform-pill${active}" data-action="switchPlatform" data-platform="${p}">
        <span class="platform-pill-label">${escapeHtml(label)}</span>
        <span class="platform-pill-sub">${escapeHtml(sub)}</span>
      </button>`;
  };
  const tabs = state.platform === 'nefty'
    ? `
        ${tab('blends',   'Blend',   'burn NFTs → mint result')}
        ${tab('drops',    'Claim',   'pay (or not) → mint a drop')}
        ${tab('packs',    'Unpack',  'open packs you own')}
        ${tab('upgrades', 'Upgrade', 'mutate NFTs you own')}`
    : `
        ${tab('waxdao-blends', 'Blend', 'waxdaomarket: burn NFTs → mint result')}`;
  return `
    <div class="card platform-card">
      <div class="platform-pills">
        ${pill('nefty',  'NeftyBlocks', 'blend.nefty · neftyblocksd · atomicpacksx · up.nefty')}
        ${pill('waxdao', 'WaxDAO',      'waxdaomarket')}
      </div>
    </div>
    <div class="card tabs-card">
      <div class="tabs">
        ${tabs}
      </div>
    </div>`;
}

// ─── drops view rendering ─────────────────────────────────────────────── //

function dropStatusLabel(s: DropStatus): string {
  switch (s) {
    case 'active':   return 'active';
    case 'upcoming': return 'upcoming';
    case 'ended':    return 'ended';
    case 'sold_out': return 'sold out';
    case 'hidden':   return 'hidden';
  }
}

function renderDropPickerToggle(): string {
  let label = 'Select a drop...';
  const notLoadedYet = state.drops.length === 0 && !state.dropsLoading && !state.dropsError;
  if (notLoadedYet) {
    label = `Click "Discover drops" to load ${state.discoveryCollection || 'a collection'}’s list`;
  } else if (state.drop) {
    label = `[#${state.drop.drop_id}] ${displayDropName(state.drop)}`;
  } else if (state.dropsLoading) {
    label = state.dropsProgress?.message ?? 'Scanning drops...';
  } else if (state.dropsError) {
    label = 'Discovery failed';
  }
  const disabled = state.dropsLoading || state.dropsError || notLoadedYet;
  return `
    <button class="picker-toggle" data-action="toggleDropPicker" ${disabled ? 'disabled' : ''}>
      <span class="picker-current">${escapeHtml(label)}</span>
      <span class="picker-caret">${state.dropPickerOpen ? '▴' : '▾'}</span>
    </button>`;
}

function renderDropPickerPanel(): string {
  if (!state.dropPickerOpen || state.dropsLoading || state.dropsError) return '';
  // Apply the "only eligible" filter when on.
  const visible = state.dropOnlyEligible
    ? state.drops.filter(isDropClaimable)
    : state.drops;
  if (visible.length === 0) {
    const msg = state.dropOnlyEligible && state.drops.length > 0
      ? `No drops your wallet can claim right now. Untick "only show what I can claim" to see all ${state.drops.length}.`
      : 'No drops found.';
    return `<div class="picker-panel"><div class="picker-empty">${escapeHtml(msg)}</div></div>`;
  }
  const rows = visible
    .map((d) => {
      const wlDenied = d.auth.kind === 'whitelist' && d.auth.allowed === false;
      const proofNotMet = d.auth.kind === 'proof' && d.auth.resolved && !d.auth.resolved.satisfied;
      const authkey = d.auth.kind === 'authkey';
      const unclaimable = d.auth.kind === 'unclaimable';
      const unverified = d.auth.kind === 'unverified';
      const limitReached = d.account_remaining === 0;
      // "Fixable" blockers (missing NFT proof, insufficient funds)
      // keep the row clickable so the user can open the drop and see
      // exactly what's missing in the action card below. Hard blockers
      // (whitelist denial, key-gated, structurally unclaimable, hit
      // their per-account limit) stay disabled.
      const disabled = wlDenied || authkey || unclaimable || limitReached;
      const wlBadge = unclaimable
        ? '<span class="picker-wl-badge">no auth defined</span>'
        : unverified
          ? '<span class="picker-wl-badge pending">connect to verify</span>'
          : limitReached
            ? '<span class="picker-wl-badge">limit reached</span>'
            : wlDenied
              ? '<span class="picker-wl-badge">not whitelisted</span>'
              : proofNotMet
                ? '<span class="picker-wl-badge">missing NFT proof</span>'
                : authkey
                  ? '<span class="picker-wl-badge">key-gated</span>'
                  : d.auth.kind === 'proof'
                    ? '<span class="picker-wl-badge pending">proof OK</span>'
                    : d.auth.kind === 'whitelist'
                      ? '<span class="picker-wl-badge pending">whitelisted</span>'
                      : '';
      const priceTag = d.is_free
        ? '<span class="status-chip status-active">free</span>'
        : `<span class="picker-price">${escapeHtml(d.listing_price)}</span>`;
      const classes = ['picker-row'];
      if (disabled) classes.push('picker-row-disabled');
      const ft = state.dropFtStatus.get(d.drop_id);
      const insufficient = ft && ft.balance >= 0 && ft.balance < ft.required;
      const fundsBadge = insufficient
        ? `<span class="picker-wl-badge" title="You're eligible but your wallet doesn't hold enough ${escapeHtml(ft!.ticker)} (have ${ft!.balance.toFixed(4)}, need ${ft!.required.toFixed(4)}).">insufficient ${escapeHtml(ft!.ticker)}</span>`
        : '';
      return `
        <div class="${classes.join(' ')}" ${disabled ? '' : `data-action="pickDrop" data-drop="${escapeHtml(d.drop_id)}"`}>
          <span class="picker-id">#${escapeHtml(d.drop_id)}</span>
          <span class="picker-name">${escapeHtml(displayDropName(d))}</span>
          ${priceTag}
          ${fundsBadge}
          ${wlBadge}
          <span class="status-chip status-${escapeHtml(d.status)}">${escapeHtml(dropStatusLabel(d.status))}</span>
        </div>`;
    })
    .join('');
  return `<div class="picker-panel"><div class="picker-rows">${rows}</div></div>`;
}

/**
 * Same idea as noBlendsEligibleNotice but for the drops view. Lists the
 * possible blockers (whitelist, NFT proof, per-account limit, authkey)
 * so the user understands WHY nothing showed up.
 */
function noDropsEligibleNotice(): string {
  if (!state.dropOnlyEligible) return '';
  if (state.drops.length === 0) return '';
  const eligible = state.drops.filter(isDropClaimable);
  if (eligible.length > 0) return '';
  return `<p class="status-line warn">None of the ${state.drops.length} drops in this list are claimable by your wallet right now (whitelist, NFT proof, per-account limit, or auth-key gated). Untick "only show what I can claim" to see them all.</p>`;
}

function renderDropLegend(): string {
  return `
    <div class="legend">
      <span class="legend-label">Color codes</span>
      <span class="legend-item"><span class="status-chip status-active">active / free</span></span>
      <span class="legend-item"><span class="status-chip status-sold_out">sold out</span></span>
      <span class="legend-item"><span class="status-chip status-ended">ended</span></span>
      <span class="legend-item"><span class="status-chip status-upcoming">upcoming</span></span>
      <span class="legend-sep">·</span>
      <span class="legend-item">
        <span class="picker-wl-badge">not whitelisted</span>
        whitelist required and your account isn't on it (row disabled)
      </span>
      <span class="legend-item">
        <span class="picker-wl-badge">missing NFT proof</span>
        you don't hold the required NFT(s) (row still clickable)
      </span>
      <span class="legend-item">
        <span class="picker-wl-badge">insufficient TICKER</span>
        you're eligible but short on the settlement token (row still clickable)
      </span>
      <span class="legend-item">
        <span class="picker-wl-badge">limit reached</span>
        you hit this drop's per-account limit (row disabled)
      </span>
      <span class="legend-item">
        <span class="picker-wl-badge">key-gated</span>
        claimdropkey, needs an off-chain signature (row disabled)
      </span>
      <span class="legend-item">
        <span class="picker-wl-badge pending">connect to verify</span>
        connect a wallet so eligibility can be checked
      </span>
    </div>`;
}

function renderPickDrop(): string {
  const sourceTag = state.dropsLoading
    ? ''
    : '<span class="tag warn">on-chain scan</span>';
  const counts = state.drops.length > 0
    ? `${state.drops.length} drop${state.drops.length === 1 ? '' : 's'} found`
    : '';
  const progressBar = state.dropsLoading && state.dropsProgress
    ? `<div class="progress"><div class="progress-fill" style="width:${Math.round(state.dropsProgress.pct * 100)}%"></div></div>`
    : '';

  const refreshLabel = state.dropsLoading
    ? 'Refreshing...'
    : state.drops.length > 0
      ? 'Refresh drops'
      : 'Discover drops';
  return `
    <div class="card">
      <h2>2 · Pick a drop</h2>
      <div class="row" style="gap:14px; align-items: flex-end; margin-bottom: 8px">
        <div style="width: 140px; flex: 0 0 140px">
          <label>Collection</label>
          ${renderCollectionInput()}
        </div>
        <div style="flex: 1 1 380px; min-width: 280px">
          <label>Available drops</label>
          <div class="picker drop-picker">
            ${renderDropPickerToggle()}
            ${renderDropPickerPanel()}
          </div>
        </div>
        <button class="primary" data-action="refreshDrops" ${state.dropsLoading || !isValidWaxName(state.discoveryCollection) ? 'disabled' : ''}>
          ${escapeHtml(refreshLabel)}
        </button>
      </div>
      ${renderCollectionChips()}
      ${progressBar}
      <div class="row" style="margin-top:10px; gap:14px; align-items:center; flex-wrap:wrap">
        <label class="inline-toggle">
          <input id="dropShowInactive" type="checkbox" data-action="toggleDropInactive" ${state.dropShowInactive ? 'checked' : ''} />
          <span>show ended / upcoming / sold-out</span>
        </label>
        <label class="inline-toggle" title="${getCurrentSession() ? 'Filter to drops you can actually claim right now (whitelist, NFT proof, per-account limit).' : 'Connect your wallet first; we need to check your eligibility.'}">
          <input id="dropOnlyEligible" type="checkbox" data-action="toggleDropOnlyEligible" ${state.dropOnlyEligible ? 'checked' : ''} ${getCurrentSession() ? '' : 'disabled'} />
          <span>only show what I can claim</span>
        </label>
        <div class="spacer"></div>
        ${sourceTag}
        <span class="term">${escapeHtml(counts)}</span>
      </div>
      ${noDropsEligibleNotice()}
      ${renderDropLegend()}

      <div class="divider"></div>

      <label>Or enter a drop_id manually</label>
      <div class="row" style="gap:14px; align-items: flex-end">
        <div style="flex:1; min-width: 200px">
          <input id="dropId" type="text" value="${escapeHtml(state.dropId)}" placeholder="e.g. 237418" autocomplete="off" />
        </div>
        <button class="primary" data-action="loadDropManual" ${state.dropLoading ? 'disabled' : ''}>
          ${state.dropLoading ? 'Loading…' : 'Load drop'}
        </button>
      </div>
      ${state.dropsError ? `<p class="status-line warn">Discovery: ${escapeHtml(state.dropsError)}</p>` : ''}
    </div>`;
}

function renderDropAuth(d: DiscoveredDrop): string {
  switch (d.auth.kind) {
    case 'public':
      return '<span class="tag">open · public claim</span>';
    case 'whitelist':
      return d.auth.allowed
        ? '<span class="tag ok">whitelist · allowed</span>'
        : '<span class="tag err">whitelist · denied</span>';
    case 'proof':
      return d.auth.resolved?.satisfied
        ? `<span class="tag ok">NFT proof · ready (${d.auth.resolved.asset_ids.length})</span>`
        : '<span class="tag err">NFT proof · missing eligible NFTs</span>';
    case 'authkey':
      return '<span class="tag err">authkey-gated · unsupported</span>';
    case 'unverified':
      return '<span class="tag warn">connect wallet to verify access</span>';
    case 'unclaimable':
      return '<span class="tag err">no auth defined · unclaimable</span>';
  }
}

function renderDropAuthExplainer(d: DiscoveredDrop): string {
  switch (d.auth.kind) {
    case 'unclaimable':
      return `<p class="status-line err">This drop has <code>auth_required = true</code> but every on-chain gate (whitelist, NFT proof, authkey) is empty. The contract will refuse every claim until the drop creator populates one. There is nothing you or this app can do, try reaching out to the collection.</p>`;
    case 'authkey':
      return `<p class="status-line err">This drop is gated by <code>claimdropkey</code>: the creator pre-signs a per-user message off-chain. Without that signed message the contract refuses. Crucible can't fabricate it.</p>`;
    case 'unverified':
      return `<p class="status-line warn">This drop is gated. Connect your wallet so Crucible can check whether you're whitelisted, hold the required NFTs, or are otherwise allowed.</p>`;
    case 'whitelist':
      if (d.auth.allowed === false) {
        return `<p class="status-line err">Your account isn't on this drop's whitelist. Contact the collection if you think that's wrong.</p>`;
      }
      return '';
    case 'proof':
      if (d.auth.resolved && !d.auth.resolved.satisfied) {
        return `<p class="status-line err">This drop requires you to hold specific NFT(s) as proof of eligibility. Your wallet doesn't match the rule.</p>`;
      }
      return '';
    default:
      return '';
  }
}

function renderDropMintInfo(): string {
  const d = state.drop!;
  const t = state.dropTemplate;
  if (state.dropTemplateLoading && !t) {
    return `
      <ul class="mint-info">
        <li><strong>Name:</strong> <span class="shimmer skeleton-inline">loading…</span></li>
        <li><strong>Template:</strong> <code>${escapeHtml(String(d.primary_template_id))}</code></li>
      </ul>`;
  }
  if (!d.primary_template_id) {
    return '<p class="status-line warn">No primary template found in this drop.</p>';
  }
  const name = t?.name ?? '(template name unavailable)';
  const issued = t?.issued_supply ?? '?';
  const max = t && t.max_supply ? String(t.max_supply) : '∞';
  const left = t && t.max_supply > 0
    ? Math.max(0, t.max_supply - t.issued_supply)
    : null;
  return `
    <ul class="mint-info">
      <li><strong>Name:</strong> ${escapeHtml(String(name))}</li>
      <li><strong>Template:</strong> <code>${escapeHtml(String(t?.template_id ?? d.primary_template_id))}</code></li>
      ${t?.schema_name ? `<li><strong>Schema:</strong> <code>${escapeHtml(t.schema_name)}</code></li>` : ''}
      <li><strong>Issued / max:</strong> ${escapeHtml(String(issued))} / ${escapeHtml(max)} ${left !== null ? `<span class="term">(${left} left)</span>` : ''}</li>
      ${t ? `<li class="term">${t.is_transferable ? 'transferable' : 'soulbound'} · ${t.is_burnable ? 'burnable' : 'non-burnable'}</li>` : ''}
    </ul>
    ${d.assets_to_mint.length > 1 ? `<p class="term">+ ${d.assets_to_mint.length - 1} additional mint(s) per claim</p>` : ''}`;
}

function renderDropInfo(): string {
  if (state.dropLoading) return renderSkeleton('3 · Loading drop…');
  const d = state.drop;
  if (!d) return '';
  const remaining = d.max_claimable > 0
    ? `${d.current_claimed}/${d.max_claimable} (${Math.max(0, d.max_claimable - d.current_claimed)} left)`
    : `${d.current_claimed}/∞`;
  const session = getCurrentSession();
  const limitTag = d.account_limit > 0
    ? typeof d.account_remaining === 'number'
      ? d.account_remaining === 0
        ? '<span class="tag err">your limit reached</span>'
        : `<span class="tag ok">your remaining: ${d.account_remaining}/${d.account_limit}</span>`
      : `<span class="tag">limit ${d.account_limit}/account</span>`
    : '';
  const cooldownNote = (() => {
    if (d.account_remaining !== 0) return '';
    if (!d.cooldown_resets_at) {
      return '<p class="status-line err">You already hit this drop\'s per-account limit. There is no cooldown, you can\'t claim it again.</p>';
    }
    const wait = d.cooldown_resets_at - Math.floor(Date.now() / 1000);
    if (wait <= 0) {
      return '<p class="status-line warn">Cooldown should have just expired, reload the list to re-check.</p>';
    }
    return `<p class="status-line warn">You hit this drop's per-account limit. Cooldown resets in <strong>${escapeHtml(formatHumanDuration(wait))}</strong>.</p>`;
  })();
  const noSessionHint = !session && d.account_limit > 0
    ? '<p class="term">Connect your wallet to check how many claims you have left on this drop.</p>'
    : '';
  return `
    <div class="card">
      <div class="card-header">
        <h2>3 · ${escapeHtml(displayDropName(d))} <span class="term">-- #${escapeHtml(d.drop_id)} · ${escapeHtml(d.collection_name)}</span></h2>
        ${renderShareButton()}
      </div>
      <div class="row">
        <span class="status-chip status-${escapeHtml(d.status)}">${escapeHtml(dropStatusLabel(d.status))}</span>
        ${d.is_free ? '<span class="tag ok">free</span>' : `<span class="tag">${escapeHtml(d.listing_price)}</span>`}
        ${renderDropAuth(d)}
        <span class="tag">claims ${escapeHtml(remaining)}</span>
        ${limitTag}
      </div>
      ${renderDropAuthExplainer(d)}
      ${cooldownNote}
      ${noSessionHint}
      <h3>Expected mint</h3>
      ${renderDropMintInfo()}
      ${d.auth.kind === 'proof' && d.auth.resolved && d.auth.resolved.satisfied
        ? `<h3>Proof of ownership</h3>
           <p class="term">The contract will check that you hold ${d.auth.filters.length} specific NFT(s). The page auto-selected ${d.auth.resolved.asset_ids.length} matching asset(s) from your wallet:</p>
           <ul class="mint-info">${d.auth.resolved.asset_ids.map((id) => `<li><code>${escapeHtml(id)}</code></li>`).join('')}</ul>`
        : ''
      }
      ${d.description ? `<details style="margin-top:12px"><summary class="term" style="cursor:pointer">drop description</summary><p style="margin-top:8px; font-size:12px; color:var(--fg-dim)">${escapeHtml(d.description)}</p></details>` : ''}
    </div>`;
}

/**
 * Plain-English description of a single ProofFilter. Used in the
 * blocker notices when the wallet doesn't satisfy a drop's
 * NFT-ownership rule.
 */
function describeProofFilter(f: import('../nefty/drops').ProofFilter): string {
  const verb = f.amount === 1 ? '1 NFT' : `${f.amount} NFTs`;
  switch (f.type) {
    case 'TEMPLATE_HOLDINGS':
      return `${verb} from template <code>${escapeHtml(String(f.template_id ?? '?'))}</code>` +
        (f.collection_name ? ` (collection <code>${escapeHtml(f.collection_name)}</code>)` : '');
    case 'SCHEMA_HOLDINGS':
      return `${verb} from schema <code>${escapeHtml(f.schema_name ?? '?')}</code>` +
        (f.collection_name ? ` in <code>${escapeHtml(f.collection_name)}</code>` : '');
    case 'COLLECTION_HOLDINGS':
      return `${verb} from collection <code>${escapeHtml(f.collection_name ?? '?')}</code>`;
    case 'TOKEN_HOLDING':
      return `a token-holding proof (amount ${f.amount})`;
    default:
      return `<span class="term">${escapeHtml(String(f.type))}</span>`;
  }
}

/**
 * Returns the HTML notices for the two "fixable" blockers that keep
 * the Sign & claim button disabled:
 *   - insufficient settlement-token balance (paid drop)
 *   - missing NFT proof (proof-gated drop the wallet doesn't satisfy)
 *
 * Both are rendered prominently above the action row so users always
 * see WHY their button is greyed out, with concrete remediation steps.
 * Returns an empty string when nothing is blocking.
 */
function renderDropBlockerNotices(d: DiscoveredDrop): string {
  const blocks: string[] = [];

  // Missing NFT proof
  if (d.auth.kind === 'proof' && d.auth.resolved && !d.auth.resolved.satisfied) {
    const op = d.auth.resolved.logical_operator === 1 ? 'any one of' : 'all of';
    const lines = d.auth.filters.map((f) => `<li>${describeProofFilter(f)}</li>`).join('');
    blocks.push(`
      <p class="status-line warn">
        <strong>Missing NFT proof.</strong>
        This drop requires you to hold ${escapeHtml(op)} the following in your wallet
        before <code>claimwproof</code> can sign:
      </p>
      <ul class="mint-info" style="margin-top:-4px">${lines}</ul>
      <p class="status-line term" style="margin-top:-4px">
        Pick those NFTs up on a secondary market (AtomicHub, NeftyBlocks
        marketplace), wait for the indexer to reflect your wallet, then come
        back and the button will unlock.
      </p>`);
  }

  // Insufficient settlement-token balance
  const ft = state.dropFtStatus.get(d.drop_id);
  if (!d.is_free && ft && ft.balance >= 0 && ft.balance < ft.required * state.dropAmount) {
    const totalReq = ft.required * state.dropAmount;
    const missing = totalReq - ft.balance;
    const perClaim = state.dropAmount > 1
      ? ` (${ft.required.toFixed(4)} × ${state.dropAmount} claims)`
      : '';
    blocks.push(`
      <p class="status-line warn">
        <strong>Insufficient ${escapeHtml(ft.ticker)} balance.</strong>
        Your wallet holds <code>${ft.balance.toFixed(4)} ${escapeHtml(ft.ticker)}</code>
        but the claim costs <code>${totalReq.toFixed(4)} ${escapeHtml(ft.ticker)}</code>${escapeHtml(perClaim)}.
        Top up at least <code>${missing.toFixed(4)} ${escapeHtml(ft.ticker)}</code>
        (Alcor, TacoSwap, or a wallet transfer all work) and the Sign &amp; claim
        button will unlock automatically.
      </p>`);
  }
  return blocks.join('');
}

function renderDropActions(): string {
  const d = state.drop;
  if (!d) return '';
  const ready = readyToClaim();
  const blockers = renderDropBlockerNotices(d);
  return `
    <div class="card">
      <h2>4 · Verify &amp; claim</h2>
      ${blockers}
      <div class="row" style="align-items:center">
        <label class="inline-toggle" style="text-transform:none; letter-spacing:0.5px">
          <span>amount</span>
        </label>
        <input id="dropAmount" type="number" min="1" value="${state.dropAmount}" style="width: 80px" />
        <div class="spacer"></div>
        <button data-action="dropDryRun" ${ready ? '' : 'disabled'}>Simulate (no signature)</button>
        <button class="primary" data-action="dropExecute" ${ready ? '' : 'disabled'}>Sign &amp; claim</button>
      </div>
      ${state.dropLastDryRun
        ? `<h3>Dry-run output</h3><pre>${escapeHtml(JSON.stringify(state.dropLastDryRun, null, 2))}</pre>`
        : ''}
      ${state.dropLastTrxId
        ? `<p class="status-line ok">Trx broadcast: <a target="_blank" href="https://waxblock.io/transaction/${escapeHtml(state.dropLastTrxId)}">${escapeHtml(state.dropLastTrxId)}</a></p>`
        : ''}
    </div>`;
}

// ─── packs view rendering ─────────────────────────────────────────────── //

function renderPickPack(): string {
  const session = getCurrentSession();
  const scanned = state.packDesigns.length > 0 || state.packsError !== undefined;
  const refreshLabel = state.packsLoading
    ? 'Refreshing...'
    : scanned
      ? 'Refresh my packs'
      : 'Discover my packs';

  // Group the user's owned packs by (collection -> design -> mints).
  // Cascading dropdown is built off this aggregate.
  const byCollection = new Map<
    string,
    {
      total: number;
      designs: Map<string, { design: OwnedPack['pack']; mints: OwnedPack[] }>;
    }
  >();
  for (const owned of state.ownedPacks) {
    const cn = owned.pack.collection_name;
    let coll = byCollection.get(cn);
    if (!coll) {
      coll = { total: 0, designs: new Map() };
      byCollection.set(cn, coll);
    }
    coll.total += 1;
    const k = owned.pack.pack_id;
    let bucket = coll.designs.get(k);
    if (!bucket) {
      bucket = { design: owned.pack, mints: [] };
      coll.designs.set(k, bucket);
    }
    bucket.mints.push(owned);
  }

  const collections = Array.from(byCollection.entries())
    .map(([name, info]) => ({ name, total: info.total }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // ── all three cascading dropdowns are ALWAYS rendered so the
  // structure of the form is visible from the start. Downstream
  // dropdowns are `disabled` (greyed and unclickable) until their
  // prerequisite is picked, which makes the cascade obvious without
  // requiring a click first.
  const cascadeReady = !state.packsLoading && collections.length > 0;

  // Step 1: collection
  const collOptions = collections.map(({ name, total }) => {
    const sel = state.packPickCollection === name ? ' selected' : '';
    return `<option value="${escapeHtml(name)}"${sel}>${escapeHtml(name)} (${total} pack${total === 1 ? '' : 's'})</option>`;
  }).join('');
  const collDisabled = !cascadeReady ? ' disabled' : '';
  const collPicker = `
    <div style="flex:1; min-width: 220px">
      <label>Collection</label>
      <select class="pack-pick-collection pack-cascade"${collDisabled}>
        <option value="" ${state.packPickCollection ? '' : 'selected'} disabled>Pick a collection...</option>
        ${collOptions}
      </select>
    </div>`;

  // Step 2: pack design. Disabled when no collection picked.
  let designOptions = '';
  if (cascadeReady && state.packPickCollection) {
    const coll = byCollection.get(state.packPickCollection);
    const designs = coll ? Array.from(coll.designs.values()) : [];
    designs.sort((a, b) => Number(b.design.pack_id) - Number(a.design.pack_id));
    designOptions = designs.map(({ design, mints }) => {
      const sel = state.packPickDesignId === design.pack_id ? ' selected' : '';
      const rolls = design.roll_counter;
      return `<option value="${escapeHtml(design.pack_id)}"${sel}>${escapeHtml(design.name)} - ${mints.length}× owned (${rolls} card${rolls === 1 ? '' : 's'} per pack)</option>`;
    }).join('');
  }
  const designDisabled = !cascadeReady || !state.packPickCollection ? ' disabled' : '';
  const designPicker = `
    <div style="flex:1; min-width: 260px">
      <label>Pack type</label>
      <select class="pack-pick-design pack-cascade"${designDisabled}>
        <option value="" ${state.packPickDesignId ? '' : 'selected'} disabled>Pick a pack type...</option>
        ${designOptions}
      </select>
    </div>`;

  // Step 3: mint. Always rendered, but greyed out when no design picked
  // OR when the picked design only has one owned mint (auto-selected,
  // dropdown is decorative). Showing it always keeps the form layout
  // stable as the user moves through the cascade.
  let mintOptions = '';
  let mintHasMultiple = false;
  let singleAutoLabel = '';
  if (cascadeReady && state.packPickCollection && state.packPickDesignId) {
    const coll = byCollection.get(state.packPickCollection);
    const bucket = coll?.designs.get(state.packPickDesignId);
    if (bucket) {
      mintHasMultiple = bucket.mints.length > 1;
      if (mintHasMultiple) {
        const sorted = [...bucket.mints].sort((a, b) => Number(b.asset_id) - Number(a.asset_id));
        mintOptions = sorted.map((m) => {
          const sel = state.selectedPack?.asset_id === m.asset_id ? ' selected' : '';
          const mintLabel = m.mint ? ` · mint ${m.mint}` : '';
          return `<option value="${escapeHtml(m.asset_id)}"${sel}>#${escapeHtml(m.asset_id)}${escapeHtml(mintLabel)}</option>`;
        }).join('');
      } else if (bucket.mints.length === 1) {
        const only = bucket.mints[0];
        const mintLabel = only.mint ? ` · mint ${only.mint}` : '';
        singleAutoLabel = `#${only.asset_id}${mintLabel} (only one owned, auto-picked)`;
      }
    }
  }
  const mintDisabled = !mintHasMultiple ? ' disabled' : '';
  const mintPickerInner = mintHasMultiple
    ? `<option value="" ${state.selectedPack ? '' : 'selected'} disabled>Pick a specific mint...</option>${mintOptions}`
    : `<option value="" selected disabled>${escapeHtml(singleAutoLabel || 'Pick a pack type first...')}</option>`;
  const mintPicker = `
    <div style="flex:1; min-width: 240px">
      <label>Which mint?</label>
      <select class="pack-mint-pick pack-cascade"${mintDisabled}>
        ${mintPickerInner}
      </select>
    </div>`;

  // ── status / empty messages, shown below the dropdowns. The dropdowns
  // themselves are always present so the form structure is constant.
  let statusLine = '';
  if (state.packsError) {
    statusLine = `<p class="status-line err">${escapeHtml(state.packsError)}</p>`;
  } else if (state.packsLoading) {
    statusLine = `<p class="status-line">${escapeHtml(state.packsProgress ?? 'Scanning...')}</p>`;
  } else if (!session) {
    statusLine = `<p class="status-line warn">Connect your wallet so Crucible can scan it for openable packs.</p>`;
  } else if (!scanned) {
    statusLine = `<p class="status-line">Click <strong>Discover my packs</strong> to scan the chain for every pack your wallet currently holds, across every collection.</p>`;
  } else if (state.ownedPacks.length === 0) {
    statusLine = `<p class="status-line warn">No openable packs in your wallet. ${state.packDesigns.length} pack design${state.packDesigns.length === 1 ? '' : 's'} exist on <code>atomicpacksx</code>, but none belong to you right now.</p>`;
  }

  const totalLine = state.ownedPacks.length > 0
    ? `<span class="term">${state.ownedPacks.length} pack${state.ownedPacks.length === 1 ? '' : 's'} across ${collections.length} collection${collections.length === 1 ? '' : 's'}</span>`
    : '';

  // Layout mirrors blends/drops: pickers on the left, Discover button
  // on the right of the same row, with wrap-to-bottom on narrow screens.
  return `
    <div class="card">
      <h2>2 · Pick a pack to open</h2>
      <p style="margin-top:0; color:var(--fg-dim); font-size:12px">
        Opening a pack always takes <strong>two wallet signatures</strong> (one to send the pack to <code>atomicpacksx</code>, one to mint the resolved cards). This is how the contract works for every collection on WAX, not something specific to your wallet. Crucible scans the chain globally and only lists the collections where you currently hold at least one openable pack.
      </p>
      <div class="row" style="gap:14px; align-items:center; margin-bottom: 14px; flex-wrap:wrap">
        <button class="primary" data-action="refreshPacks" ${state.packsLoading || !session ? 'disabled' : ''}>
          ${escapeHtml(refreshLabel)}
        </button>
        <div class="spacer"></div>
        ${totalLine}
      </div>
      ${statusLine}
      <div class="row" style="gap:14px; align-items: flex-end; flex-wrap: wrap; margin-top: 8px">
        ${collPicker}
        ${designPicker}
        ${mintPicker}
      </div>
    </div>`;
}

function renderPackInfo(): string {
  const pack = state.selectedPack;
  if (!pack) return '';
  const d = pack.pack;
  const unlocked = d.unlock_time === 0 || d.unlock_time * 1000 < Date.now();
  return `
    <div class="card">
      <h2>3 · Pack #${escapeHtml(d.pack_id)} <span class="term">${escapeHtml(d.name)} (${escapeHtml(d.collection_name)})</span></h2>
      <div class="row">
        <span class="tag">asset <code>#${escapeHtml(pack.asset_id)}</code></span>
        <span class="tag">${escapeHtml(String(d.roll_counter))} mint${d.roll_counter === 1 ? '' : 's'} per pack</span>
        ${d.pack_template_id ? `<span class="tag">template <code>${escapeHtml(String(d.pack_template_id))}</code></span>` : ''}
        ${unlocked ? '<span class="tag ok">unlocked</span>' : `<span class="tag err">unlocks at ${escapeHtml(new Date(d.unlock_time * 1000).toISOString().slice(0, 16).replace('T', ' '))} UTC</span>`}
      </div>
      ${state.packRolls.length > 0 ? renderPackRollsList() : '<p class="status-line">Loading roll definitions…</p>'}
      ${d.description ? `<details style="margin-top:12px"><summary class="term" style="cursor:pointer">pack description</summary><p style="margin-top:8px; font-size:12px; color:var(--fg-dim)">${escapeHtml(d.description)}</p></details>` : ''}
    </div>`;
}

function renderPackRollsList(): string {
  // Compact roll display: for each roll, list its outcomes with odds and
  // (when known) the template name. Truncates long outcome lists.
  const blocks = state.packRolls.map((r) => {
    const total = r.total_odds || r.outcomes.reduce((a, o) => a + o.odds, 0);
    const items = r.outcomes.slice(0, 6).map((o) => {
      const name = state.packRollNames.get(o.template_id);
      const pct = total > 0 ? ((o.odds / total) * 100).toFixed(2) : '?';
      return `<li><code>${escapeHtml(String(o.template_id))}</code> ${name ? `<strong>${escapeHtml(name)}</strong>` : ''} <span class="term">${pct}%</span></li>`;
    });
    const more = r.outcomes.length > 6 ? `<li class="term">+ ${r.outcomes.length - 6} more outcome${r.outcomes.length - 6 === 1 ? '' : 's'}…</li>` : '';
    return `<details class="pack-roll" open><summary>Roll #${r.roll_id} · ${r.outcomes.length} possible outcome${r.outcomes.length === 1 ? '' : 's'}</summary><ul class="mint-info">${items.join('')}${more}</ul></details>`;
  });
  return `<h3>Possible mints</h3>${blocks.join('')}`;
}

function renderPackActions(): string {
  const pack = state.selectedPack;
  if (!pack) return '';
  const phase = state.packPhase;
  const cls = (kind: 'ok' | 'warn' | 'err' | 'info') =>
    `status-line ${kind === 'info' ? '' : kind}`;
  const txLink = (id?: string) =>
    id
      ? `<a target="_blank" href="https://waxblock.io/transaction/${escapeHtml(id)}">${escapeHtml(id.slice(0, 16))}…</a>`
      : '';

  let body = '';
  if (phase === 'selected' || phase === 'idle') {
    body = `
      <p class="status-line">Ready when you are. Click step 1 to send the pack to <code>atomicpacksx</code>. Crucible will then poll the chain for the ORNG callback (typically 5 to 30 seconds) and prompt you for step 2 automatically.</p>
      <div class="row">
        <button class="primary" data-action="packAnnounce">Sign step 1: send pack to atomicpacksx</button>
        <div class="spacer"></div>
      </div>`;
  } else if (phase === 'announcing') {
    body = `
      <p class="${cls('info')}">${escapeHtml(state.packPhaseMessage ?? 'Awaiting signature…')}</p>`;
  } else if (phase === 'waiting') {
    const sec = Math.floor(state.packWaitElapsedMs / 1000);
    body = `
      <p class="${cls('ok')}">TX1 broadcast: ${txLink(state.packTx1Id)}</p>
      <p class="${cls('warn')}">Waiting for ORNG randomness... ${sec}s elapsed</p>
      <div class="progress"><div class="progress-fill" style="width:${Math.min(100, (sec / 90) * 100)}%"></div></div>
      <div class="row" style="margin-top:10px">
        <button data-action="packCancelWait">Cancel wait (pack stays safe on-chain)</button>
      </div>`;
  } else if (phase === 'ready') {
    body = `
      <p class="${cls('ok')}">TX1 confirmed: ${txLink(state.packTx1Id)}</p>
      <p class="${cls('ok')}">${escapeHtml(state.packPhaseMessage ?? 'Ready to claim.')}</p>
      ${renderUnboxOutcomes(false)}
      <div class="row">
        <button class="primary" data-action="packClaim">Sign step 2: claim ${state.packUnboxAssets.length} card${state.packUnboxAssets.length === 1 ? '' : 's'}</button>
        <div class="spacer"></div>
      </div>`;
  } else if (phase === 'claiming') {
    body = `
      <p class="${cls('ok')}">TX1: ${txLink(state.packTx1Id)}</p>
      <p class="${cls('info')}">${escapeHtml(state.packPhaseMessage ?? 'Awaiting signature…')}</p>
      ${renderUnboxOutcomes(false)}`;
  } else if (phase === 'done') {
    body = `
      <p class="${cls('ok')}">TX1: ${txLink(state.packTx1Id)}</p>
      <p class="${cls('ok')}">TX2: ${txLink(state.packTx2Id)}</p>
      <p class="${cls('ok')}">${escapeHtml(state.packPhaseMessage ?? 'Done.')}</p>
      ${renderUnboxOutcomes(true)}
      <div class="row">
        <button data-action="packReset">Open another pack</button>
      </div>`;
  } else if (phase === 'error') {
    body = `
      <p class="${cls('err')}">${escapeHtml(state.packPhaseMessage ?? 'Error.')}</p>
      ${state.packTx1Id ? `<p class="status-line">TX1 (still valid on-chain): ${txLink(state.packTx1Id)}</p>` : ''}
      <div class="row">
        <button data-action="packReset">Reset and pick another pack</button>
      </div>`;
  }

  return `
    <div class="card">
      <h2>4 · Unbox flow</h2>
      ${body}
    </div>`;
}

/**
 * Renders the resolved outcomes after ORNG callback: for each card the
 * oracle rolled, show which template was picked, its (best-effort) name,
 * and the probability that exact outcome had within its roll.
 *
 * `claimed` flips the visual from "about to mint" (pulsing accent) to
 * "minted" (calm green), but the same data is shown.
 *
 * Both states draw from:
 *   - state.packUnboxAssets: the on-chain ORNG result rows (origin_roll_id
 *     + template_id), populated by waitForUnboxAssets().
 *   - state.packRolls: the pack design's full roll table, so we can
 *     compute "this template_id had X% odds in this roll".
 *   - state.packRollNames: opportunistically-fetched template names.
 */
function renderUnboxOutcomes(claimed: boolean): string {
  if (state.packUnboxAssets.length === 0) return '';
  const rollById = new Map<number, PackRoll>();
  for (const r of state.packRolls) rollById.set(Number(r.roll_id), r);

  const cls = claimed ? 'unbox-outcome claimed' : 'unbox-outcome rolled';
  const items = state.packUnboxAssets.map((row, idx) => {
    const rollId = Number(row.origin_roll_id);
    const roll = rollById.get(rollId);
    const tid = Number(row.template_id);
    const name = state.packRollNames.get(tid);
    let pctLabel = '?';
    if (roll) {
      const total = roll.total_odds || roll.outcomes.reduce((a, o) => a + o.odds, 0);
      const match = roll.outcomes.find((o) => Number(o.template_id) === tid);
      if (match && total > 0) pctLabel = `${((match.odds / total) * 100).toFixed(2)}%`;
    }
    const cardLabel = state.packUnboxAssets.length === 1 ? 'Card' : `Card ${idx + 1}`;
    return `
      <li class="${cls}">
        <span class="unbox-outcome-label">${escapeHtml(cardLabel)} <span class="term">(roll #${rollId})</span></span>
        <span class="unbox-outcome-name">${name ? escapeHtml(name) : `<span class="term">resolving name…</span>`}</span>
        <code class="unbox-outcome-tid">template ${escapeHtml(String(tid))}</code>
        <span class="unbox-outcome-odds" title="probability of this exact outcome within roll #${rollId}">${escapeHtml(pctLabel)}</span>
      </li>`;
  });

  const heading = claimed
    ? `<h3>Minted to your wallet</h3>`
    : `<h3>Oracle rolled</h3><p class="status-line" style="margin:4px 0 6px">These are the exact templates ORNG picked for your pack. Step 2 mints them to your wallet, the percentages are the in-roll odds (what was the chance of this particular result?).</p>`;
  return `${heading}<ul class="unbox-outcomes">${items.join('')}</ul>`;
}

function renderPacksView(): string {
  return renderPickPack() + renderPackInfo() + renderPackActions();
}

function renderBlendsView(): string {
  return renderPickBlend() + renderBlendInfo() + renderSlots() + renderActions();
}

function renderDropsView(): string {
  return renderPickDrop() + renderDropInfo() + renderDropActions();
}

// ─── UPGRADE view rendering ────────────────────────────────────────── //

function upgradeStatusLabel(s: UpgradeStatus): string {
  switch (s) {
    case 'active':   return 'active';
    case 'upcoming': return 'upcoming';
    case 'ended':    return 'ended';
    case 'sold_out': return 'sold out';
    case 'hidden':   return 'hidden';
  }
}

function renderUpgradeLegend(): string {
  return `
    <div class="legend">
      <span class="legend-label">Color codes</span>
      <span class="legend-item"><span class="status-chip status-active">active</span></span>
      <span class="legend-item"><span class="status-chip status-sold_out">sold out</span></span>
      <span class="legend-item"><span class="status-chip status-ended">ended</span></span>
      <span class="legend-item"><span class="status-chip status-upcoming">upcoming</span></span>
      <span class="legend-item"><span class="status-chip status-hidden">hidden</span></span>
      <span class="legend-sep">·</span>
      <span class="legend-item">
        <span class="picker-wl-badge">RNG</span>
        random results, not yet executable
      </span>
      <span class="legend-item">
        <span class="picker-wl-badge">gated</span>
        whitelist / ownership gate, not yet executable
      </span>
    </div>`;
}

function ingredientLabel(ing: UpgradeIngredient): string {
  switch (ing.kind) {
    case 'ft':           return `Pay ${escapeHtml(ing.quantity)}`;
    case 'template':     return `Burn ${ing.amount} NFT(s) of template ${ing.template_id}`;
    case 'schema':       return `Burn ${ing.amount} NFT(s) from schema ${escapeHtml(ing.schema_name)}`;
    case 'collection':   return `Burn ${ing.amount} NFT(s) from collection ${escapeHtml(ing.collection_name)}`;
    case 'attribute':    return `Burn ${ing.amount} NFT(s) matching specific attributes`;
    case 'typed_attribute': return `Burn ${ing.amount} NFT(s) matching typed attributes`;
    case 'balance':      return `Reduce ${ing.attribute_name} by ${ing.cost} on a held NFT`;
    case 'unknown':      return 'Unknown ingredient type';
  }
}

function renderUpgradePickerToggle(): string {
  const u = state.upgrades;
  let label = 'Select an upgrade...';
  const notLoadedYet = u.list.length === 0 && !u.loading && !u.error;
  if (notLoadedYet) {
    label = `Click "Discover upgrades" to load ${state.discoveryCollection || 'a collection'}’s list`;
  } else if (u.picked) {
    label = `[#${u.picked.upgrade_id}] ${u.picked.name}`;
  } else if (u.loading) {
    label = u.progress?.message ?? 'Scanning upgrades...';
  } else if (u.error) {
    label = 'Discovery failed';
  }
  const disabled = u.loading || u.error || notLoadedYet;
  return `
    <button class="picker-toggle" data-action="toggleUpgradesPicker" ${disabled ? 'disabled' : ''}>
      <span class="picker-current">${escapeHtml(label)}</span>
      <span class="picker-caret">${u.pickerOpen ? '▴' : '▾'}</span>
    </button>`;
}

function renderUpgradePickerPanel(): string {
  const u = state.upgrades;
  if (!u.pickerOpen || u.loading || u.error) return '';
  const visible = u.list;
  if (visible.length === 0) {
    return `<div class="picker-panel"><div class="picker-empty">${escapeHtml('No upgrades found.')}</div></div>`;
  }
  const rows = visible.map((up) => {
    const random = up.is_random;
    const wl = up.whitelist_required;
    const disabled = random || wl;
    const cls = ['picker-row'];
    if (disabled) cls.push('picker-row-disabled');
    const rngBadge = random
      ? '<span class="picker-wl-badge" title="Random upgrade results need an ORNG wait, not supported yet.">RNG</span>'
      : '';
    const wlBadge = wl
      ? '<span class="picker-wl-badge" title="Whitelist or ownership gate, not supported yet.">gated</span>'
      : '';
    // Show first FT ingredient cost as the price tag (most common case).
    const ft = up.ingredients.find((ing) => ing.kind === 'ft');
    const priceTag = ft
      ? `<span class="picker-price">${escapeHtml((ft as Extract<UpgradeIngredient, {kind:'ft'}>).quantity)}</span>`
      : '';
    return `
      <div class="${cls.join(' ')}" ${disabled ? '' : `data-action="pickUpgrade" data-upgrade="${escapeHtml(up.upgrade_id)}"`}>
        <span class="picker-id">#${escapeHtml(up.upgrade_id)}</span>
        <span class="picker-name">${escapeHtml(up.name)}</span>
        ${priceTag}
        ${rngBadge}
        ${wlBadge}
        <span class="status-chip status-${escapeHtml(up.status)}">${escapeHtml(upgradeStatusLabel(up.status))}</span>
      </div>`;
  }).join('');
  return `<div class="picker-panel"><div class="picker-rows">${rows}</div></div>`;
}

function renderPickUpgrade(): string {
  const u = state.upgrades;
  const session = getCurrentSession();
  const refreshLabel = u.loading
    ? 'Refreshing...'
    : u.list.length > 0
      ? 'Refresh upgrades'
      : 'Discover upgrades';
  const counts = u.list.length > 0
    ? `${u.list.length} upgrade${u.list.length === 1 ? '' : 's'} found`
    : '';
  const progressBar = u.loading && u.progress
    ? `<div class="progress"><div class="progress-fill" style="width:${Math.round(u.progress.pct * 100)}%"></div></div>`
    : '';
  return `
    <div class="card">
      <h2>2 · Pick an upgrade</h2>
      <div class="row" style="gap:14px; align-items: flex-end; margin-bottom: 8px">
        <div style="width: 140px; flex: 0 0 140px">
          <label>Collection</label>
          ${renderCollectionInput()}
        </div>
        <div style="flex: 1 1 380px; min-width: 280px">
          <label>Available upgrades</label>
          <div class="picker upgrade-picker">
            ${renderUpgradePickerToggle()}
            ${renderUpgradePickerPanel()}
          </div>
        </div>
        <button class="primary" data-action="refreshUpgrades" ${u.loading || !isValidWaxName(state.discoveryCollection) ? 'disabled' : ''}>
          ${escapeHtml(refreshLabel)}
        </button>
      </div>
      ${renderCollectionChips()}
      ${progressBar}
      <div class="row" style="margin-top:10px; gap:14px; align-items:center; flex-wrap:wrap">
        <label class="inline-toggle">
          <input id="upgradesShowInactive" type="checkbox" data-action="toggleUpgradesInactive" ${u.showInactive ? 'checked' : ''} />
          <span>show ended / upcoming / sold-out</span>
        </label>
        <div class="spacer"></div>
        <span class="term">${escapeHtml(counts)}</span>
      </div>
      ${renderUpgradeLegend()}
      ${session ? '' : '<p class="status-line term">Connect your wallet to match owned NFTs against each upgrade\'s requirements.</p>'}

      <div class="divider"></div>

      <label>Or enter an upgrade_id manually</label>
      <div class="row" style="gap:14px; align-items: flex-end">
        <div style="flex:1; min-width: 200px">
          <input id="upgradeIdInput" type="text" value="${escapeHtml(u.upgradeIdInput)}" placeholder="e.g. 447" autocomplete="off" />
        </div>
        <button class="primary" data-action="loadUpgradeManual" ${u.loading ? 'disabled' : ''}>
          ${u.loading ? 'Loading…' : 'Load upgrade'}
        </button>
      </div>
      ${u.error ? `<p class="status-line warn">Discovery: ${escapeHtml(u.error)}</p>` : ''}
    </div>`;
}

function renderUpgradeInfo(): string {
  const u = state.upgrades;
  const up = u.picked;
  if (!up) return '';
  const remainingUses = up.max > 0
    ? `${up.use_count}/${up.max} (${Math.max(0, up.max - up.use_count)} left)`
    : `${up.use_count}/∞`;

  const ingredientsList = up.ingredients.length
    ? `<h3>Cost</h3><ul class="mint-info">${
        up.ingredients.map((ing) => `<li>${escapeHtml(ingredientLabel(ing))}</li>`).join('')
      }</ul>`
    : '';

  const specsBlock = up.specs.map((spec, i) => {
    const reqText = spec.requirements.map((req) => {
      if (req.kind === 'template') return `template <code>${req.template_id}</code>`;
      if (req.kind === 'templates') return `one of templates [${req.template_ids.map((id) => `<code>${id}</code>`).join(', ')}]`;
      return `<span class="term">attribute-based requirement</span>`;
    }).join(' · ');
    const resultText = spec.results.map((res) => {
      if (res.is_random) {
        return `<li><strong>${escapeHtml(res.attribute_name)}</strong> <span class="term">(${escapeHtml(res.attribute_type)})</span>: <span class="term">random / oracle-driven (not yet supported)</span></li>`;
      }
      return `<li><strong>${escapeHtml(res.attribute_name)}</strong> <span class="term">(${escapeHtml(res.attribute_type)})</span> = <code>${escapeHtml(String(res.immediate_value ?? ''))}</code></li>`;
    }).join('');
    return `
      <details class="pack-roll" open>
        <summary>Spec #${i} · schema <code>${escapeHtml(spec.schema_name)}</code> · ${reqText || 'no template constraint'}</summary>
        <ul class="mint-info">${resultText}</ul>
      </details>`;
  }).join('');

  const flags: string[] = [];
  if (up.is_random) flags.push('<span class="tag warn">random results · not yet executable</span>');
  if (up.whitelist_required) flags.push('<span class="tag warn">whitelist / ownership gate · not yet executable</span>');

  return `
    <div class="card">
      <div class="card-header">
        <h2>3 · ${escapeHtml(up.name)} <span class="term">-- #${escapeHtml(up.upgrade_id)} · ${escapeHtml(up.collection_name)}</span></h2>
        ${renderShareButton()}
      </div>
      <div class="row">
        <span class="status-chip status-${escapeHtml(up.status)}">${escapeHtml(upgradeStatusLabel(up.status))}</span>
        <span class="tag">uses ${escapeHtml(remainingUses)}</span>
        ${flags.join('')}
      </div>
      ${ingredientsList}
      <h3>What gets mutated</h3>
      ${specsBlock}
      ${up.description ? `<details style="margin-top:12px"><summary class="term" style="cursor:pointer">upgrade description</summary><p style="margin-top:8px; font-size:12px; color:var(--fg-dim)">${escapeHtml(up.description)}</p></details>` : ''}
    </div>`;
}

function renderUpgradeAssetSlot(spec: DiscoveredUpgrade['specs'][number], specIdx: number): string {
  const u = state.upgrades;
  const owned = ownedAssetsForSpec(spec);
  const picked = u.selection.get(specIdx);
  const reqLabel = spec.requirements.map((req) => {
    if (req.kind === 'template') return `template ${req.template_id}`;
    if (req.kind === 'templates') return `one of templates [${req.template_ids.join(', ')}]`;
    return 'attribute constraint';
  }).join(' · ');
  const items = owned.map((a) => {
    const selected = picked === a.asset_id ? ' selected' : '';
    const name = displayAssetName(a);
    return `
      <div class="asset${selected}" data-action="pickUpgradeAsset" data-spec="${specIdx}" data-asset="${escapeHtml(a.asset_id)}">
        <span>${escapeHtml(name)}</span>
        <span class="id">#${escapeHtml(a.asset_id)}${a.template_mint ? ' · mint ' + escapeHtml(a.template_mint) : ''}</span>
      </div>`;
  });
  return `
    <div class="slot">
      <div class="slot-header">
        <div class="slot-label">Spec #${specIdx} · ${escapeHtml(reqLabel)}</div>
        <div class="slot-progress">${picked ? '1/1 picked' : '0/1 picked'} · ${owned.length} eligible</div>
      </div>
      ${owned.length === 0
        ? '<p class="status-line err">No matching NFT in your wallet for this spec.</p>'
        : `<div class="asset-grid">${items.join('')}</div>`}
    </div>`;
}

function renderUpgradeSlots(): string {
  const u = state.upgrades;
  if (!u.picked) return '';
  const slots = u.picked.specs.map((spec, i) => renderUpgradeAssetSlot(spec, i)).join('');
  // FT ingredient status (cost / balance).
  const ftBlocks = u.picked.ingredients.map((ing, idx) => {
    if (ing.kind !== 'ft') return '';
    const st = u.ftStatus.get(idx);
    const required = parseAssetAmount(ing.quantity);
    if (!st) {
      return `
        <div class="slot ft-slot">
          <div class="slot-header"><div class="slot-label">${escapeHtml(`Pay ${ing.quantity}`)}</div></div>
          <p class="status-line">Reading your wallet balance…</p>
        </div>`;
    }
    const okBalance = st.balance >= 0 && st.balance >= required;
    return `
      <div class="slot ft-slot">
        <div class="slot-header"><div class="slot-label">${escapeHtml(`Pay ${ing.quantity}`)}</div></div>
        <p class="status-line ${okBalance ? 'ok' : 'err'}">
          Balance: <code>${st.balance >= 0 ? st.balance.toFixed(4) : '?'}</code> · required <code>${required.toFixed(4)}</code>
        </p>
      </div>`;
  }).join('');
  return `
    <div class="card">
      <h2>4 · Select NFTs to upgrade ${state.assetsLoading ? '<span class="term">(refreshing your wallet…)</span>' : ''}</h2>
      ${slots}
      ${ftBlocks}
    </div>`;
}

function renderUpgradeActions(): string {
  const u = state.upgrades;
  if (!u.picked) return '';
  const ready = readyToUpgrade();
  const blockers: string[] = [];
  if (u.picked.is_random) blockers.push('<p class="status-line warn">Random-result upgrades use the ORNG oracle and are not yet implemented in Crucible.</p>');
  if (u.picked.whitelist_required) blockers.push('<p class="status-line warn">Whitelist / ownership-gated upgrades are not yet implemented in Crucible.</p>');
  return `
    <div class="card">
      <h2>5 · Verify &amp; execute</h2>
      ${blockers.join('')}
      <div class="row">
        <button data-action="upgradeDryRun" ${ready ? '' : 'disabled'}>Simulate (no signature)</button>
        <button class="primary" data-action="upgradeExecute" ${ready ? '' : 'disabled'}>${u.pending ? 'Signing…' : 'Sign &amp; broadcast'}</button>
      </div>
      ${u.lastDryRun
        ? `<h3>Dry-run output</h3><pre>${escapeHtml(JSON.stringify(u.lastDryRun, null, 2))}</pre>`
        : ''}
      ${u.lastTrxId
        ? `<p class="status-line ok">Trx broadcast: <a target="_blank" href="https://waxblock.io/transaction/${escapeHtml(u.lastTrxId)}">${escapeHtml(u.lastTrxId)}</a></p>`
        : ''}
    </div>`;
}

function renderUpgradesView(): string {
  return renderPickUpgrade() + renderUpgradeInfo() + renderUpgradeSlots() + renderUpgradeActions();
}

// ─── WAXDAO BLEND view: handlers + rendering ─────────────────────── //

/**
 * Discovers waxdaomarket blends for the active collection. Refreshes
 * the wallet inventory too so the per-slot NFT picker has data.
 */
async function loadWaxdaoList() {
  const w = state.waxdao;
  w.loading = true;
  w.error = undefined;
  w.progress = undefined;
  render();
  try {
    const { blends } = await listWaxdaoBlends({
      collection: state.discoveryCollection,
      includeInactive: w.showInactive,
      onProgress: (message, pct) => {
        w.progress = { pct, message };
        render();
      },
    });
    w.list = blends;
    const session = getCurrentSession();
    if (session) {
      try {
        state.discoveryOwnedAssets = await listAssetsForOwner({
          owner: String(session.actor),
          collection_name: state.discoveryCollection,
        });
      } catch { /* non-fatal */ }
    }
  } catch (err) {
    w.error = (err as Error).message;
    w.list = [];
  } finally {
    w.loading = false;
    w.progress = undefined;
    render();
  }
}

function onToggleWaxdaoShowInactive(checked: boolean) {
  state.waxdao.showInactive = checked;
  state.waxdao.list = [];
  state.waxdao.error = undefined;
  render();
}

function onToggleWaxdaoPicker() {
  state.waxdao.pickerOpen = !state.waxdao.pickerOpen;
  render();
}

async function onPickWaxdaoBlend(blend_id: string) {
  const w = state.waxdao;
  w.pickerOpen = false;
  const found = w.list.find((b) => b.blend_id === blend_id);
  if (!found) return;
  w.picked = found;
  w.blendIdInput = blend_id;
  w.selection.clear();
  w.lastDryRun = undefined;
  w.lastTrxId = undefined;
  writeHashRoute('waxdao', 'waxdao-blends', blend_id);
  render();
  await refreshWaxdaoFtStatus();
}

async function onLoadWaxdaoBlendManual() {
  const w = state.waxdao;
  if (!w.blendIdInput) {
    setStatus('Enter a WaxDAO blend ID first.', 'err');
    return;
  }
  const local = w.list.find((b) => b.blend_id === w.blendIdInput);
  if (local) {
    onPickWaxdaoBlend(w.blendIdInput);
    return;
  }
  w.loading = true;
  render();
  try {
    const b = await loadWaxdaoBlendById(w.blendIdInput);
    if (!b) {
      setStatus(`WaxDAO blend ${w.blendIdInput} not found.`, 'err');
      return;
    }
    w.picked = b;
    w.selection.clear();
    w.lastDryRun = undefined;
    w.lastTrxId = undefined;
    if (b.creator && b.creator !== state.discoveryCollection) {
      state.discoveryCollection = b.creator;
    }
    try {
      const session = getCurrentSession();
      if (session) {
        state.discoveryOwnedAssets = await listAssetsForOwner({
          owner: String(session.actor),
          collection_name: b.creator,
        });
      }
    } catch { /* non-fatal */ }
    await refreshWaxdaoFtStatus();
  } catch (err) {
    setStatus(`Error: ${(err as Error).message}`, 'err');
  } finally {
    w.loading = false;
    render();
  }
}

async function refreshWaxdaoFtStatus() {
  const w = state.waxdao;
  w.ftStatus.clear();
  if (!w.picked) return;
  const session = getCurrentSession();
  if (!session) return;
  const owner = String(session.actor);
  w.picked.ingredients.forEach((ing, idx) => {
    if (ing.kind !== 'fungible') return;
    const required = parseAssetAmount(ing.quantity);
    const ticker = tickerFromQuantity(ing.quantity);
    if (!ticker || !Number.isFinite(required)) return;
    void (async () => {
      try {
        const balance = await readTokenBalance({
          owner,
          contract: ing.contract,
          symbolCode: ticker,
        });
        w.ftStatus.set(idx, { ticker, required, balance });
      } catch {
        w.ftStatus.set(idx, { ticker, required, balance: -1 });
      } finally {
        render();
      }
    })();
  });
}

function onPickWaxdaoAsset(slot: number, asset_id: string) {
  const w = state.waxdao;
  const current = w.selection.get(slot);
  // Each slot in v1 holds a single asset_id (multi-asset slots come
  // later when an ingredient's amount > 1). Toggle re-clicking.
  if (current === asset_id) {
    w.selection.delete(slot);
  } else {
    for (const [other, id] of w.selection.entries()) {
      if (other !== slot && id === asset_id) {
        setStatus(`Asset ${asset_id} is already picked by slot ${other}.`, 'warn');
        return;
      }
    }
    w.selection.set(slot, asset_id);
  }
  render();
}

/**
 * Eligible NFTs for a WaxDAO slot, matching the ingredient's filter.
 * Today we support template / schema / collection filters; attribute
 * filters are surfaced but not enforced client-side (the contract
 * will catch any mismatch).
 */
function ownedAssetsForWaxdaoSlot(ing: WaxdaoIngredient): AtomicAsset[] {
  const owned = state.discoveryOwnedAssets;
  return owned.filter((a) => {
    if (ing.kind === 'nft_template') {
      if (a.collection?.collection_name && ing.collection_name && a.collection.collection_name !== ing.collection_name) return false;
      if (a.schema?.schema_name && ing.schema_name && a.schema.schema_name !== ing.schema_name) return false;
      const tid = a.template?.template_id;
      return tid != null && Number(tid) === ing.template_id;
    }
    if (ing.kind === 'nft_schema') {
      if (ing.collection_name && a.collection?.collection_name !== ing.collection_name) return false;
      return a.schema?.schema_name === ing.schema_name;
    }
    if (ing.kind === 'nft_collection') {
      return a.collection?.collection_name === ing.collection_name;
    }
    if (ing.kind === 'nft_attribute') {
      // Schema match only -- attribute matching is left to the contract.
      if (ing.collection_name && a.collection?.collection_name !== ing.collection_name) return false;
      return a.schema?.schema_name === ing.schema_name;
    }
    return false;
  });
}

function readyToWaxdaoBlend(): boolean {
  const w = state.waxdao;
  if (!w.picked) return false;
  if (w.picked.status !== 'active') return false;
  // Every NFT slot must have a pick.
  for (const { slot } of w.picked.nftSlots) {
    if (!w.selection.get(slot)) return false;
  }
  // Every FT ingredient must be covered.
  w.picked.ingredients.forEach((ing, idx) => {
    if (ing.kind !== 'fungible') return;
    const st = w.ftStatus.get(idx);
    if (!st || st.balance < 0 || st.balance < st.required) {
      // shortcut: can't `return` from forEach to exit early, so we set a flag below
    }
  });
  for (const [idx, ing] of w.picked.ingredients.entries()) {
    if (ing.kind !== 'fungible') continue;
    const st = w.ftStatus.get(idx);
    if (!st || st.balance < 0 || st.balance < st.required) return false;
  }
  return true;
}

function selectionForBuilder(): Map<number, string | string[]> {
  const out = new Map<number, string | string[]>();
  for (const [k, v] of state.waxdao.selection.entries()) out.set(k, v);
  return out;
}

async function onWaxdaoDryRun() {
  const w = state.waxdao;
  const session = getCurrentSession();
  if (!session || !w.picked) return;
  try {
    setStatus('Simulating WaxDAO blend (local ABI serialisation)...', 'info');
    const actions = buildWaxdaoBlendActions({
      claimer: String(session.actor),
      blend: w.picked,
      nftSelection: selectionForBuilder(),
    });
    const out = await dryRunActions(actions);
    w.lastDryRun = { actions, abi_serialization: out };
    const ok = out.every((r) => !r.error);
    setStatus(ok ? `Simulation OK, ${actions.length} action(s) serialize cleanly.` : 'Simulation failed.', ok ? 'ok' : 'err');
  } catch (err) {
    setStatus((err as Error).message, 'err');
  }
  render();
}

async function onExecuteWaxdaoBlend() {
  const w = state.waxdao;
  const session = getCurrentSession();
  if (!session || !w.picked) return;
  w.pending = true;
  render();
  try {
    setStatus('Awaiting wallet signature for the WaxDAO blend...', 'info');
    const result = await executeWaxdaoBlend(session, {
      blend: w.picked,
      nftSelection: selectionForBuilder(),
    });
    const trxId =
      (result.response as { transaction_id?: string } | undefined)?.transaction_id ??
      String(result.resolved?.transaction.id ?? '');
    w.lastTrxId = trxId;
    setStatus(`WaxDAO blend broadcast: ${trxId}`, 'ok');
  } catch (err) {
    setStatus(`WaxDAO blend failed: ${(err as Error).message}`, 'err');
  } finally {
    w.pending = false;
    render();
  }
}

// ── render ── //

function waxdaoStatusLabel(s: WaxdaoBlendStatus): string {
  switch (s) {
    case 'active':   return 'active';
    case 'upcoming': return 'upcoming';
    case 'sold_out': return 'sold out';
    case 'ended':    return 'ended';
  }
}

function waxdaoIngredientLabel(ing: WaxdaoIngredient): string {
  switch (ing.kind) {
    case 'fungible':       return `Pay ${ing.quantity}`;
    case 'nft_template':   return `Burn ${ing.amount} NFT(s) of template ${ing.template_id} (${ing.collection_name})`;
    case 'nft_schema':     return `Burn ${ing.amount} NFT(s) from schema ${ing.schema_name}`;
    case 'nft_collection': return `Burn ${ing.amount} NFT(s) from collection ${ing.collection_name}`;
    case 'nft_attribute':  return `Burn ${ing.amount} NFT(s) matching attribute filter`;
    case 'unknown':        return 'Unknown ingredient type';
  }
}

function renderWaxdaoPickerToggle(): string {
  const w = state.waxdao;
  let label = 'Select a WaxDAO blend...';
  const notLoadedYet = w.list.length === 0 && !w.loading && !w.error;
  if (notLoadedYet) {
    label = `Click "Discover WaxDAO blends" to load ${state.discoveryCollection || 'a collection'}’s list`;
  } else if (w.picked) {
    label = `[#${w.picked.blend_id}] ${w.picked.title}`;
  } else if (w.loading) {
    label = w.progress?.message ?? 'Scanning waxdaomarket...';
  } else if (w.error) {
    label = 'Discovery failed';
  }
  const disabled = w.loading || w.error || notLoadedYet;
  return `
    <button class="picker-toggle" data-action="toggleWaxdaoPicker" ${disabled ? 'disabled' : ''}>
      <span class="picker-current">${escapeHtml(label)}</span>
      <span class="picker-caret">${w.pickerOpen ? '▴' : '▾'}</span>
    </button>`;
}

function renderWaxdaoPickerPanel(): string {
  const w = state.waxdao;
  if (!w.pickerOpen || w.loading || w.error) return '';
  const visible = w.list;
  if (visible.length === 0) {
    return `<div class="picker-panel"><div class="picker-empty">${escapeHtml('No WaxDAO blends found for this collection.')}</div></div>`;
  }
  const rows = visible.map((b) => {
    const disabled = b.status !== 'active';
    const cls = ['picker-row'];
    if (disabled) cls.push('picker-row-disabled');
    const ft = b.ingredients.find((i) => i.kind === 'fungible');
    const priceTag = ft
      ? `<span class="picker-price">${escapeHtml((ft as Extract<WaxdaoIngredient,{kind:'fungible'}>).quantity)}</span>`
      : '';
    return `
      <div class="${cls.join(' ')}" ${disabled ? '' : `data-action="pickWaxdaoBlend" data-waxdao-blend="${escapeHtml(b.blend_id)}"`}>
        <span class="picker-id">#${escapeHtml(b.blend_id)}</span>
        <span class="picker-name">${escapeHtml(b.title)}</span>
        ${priceTag}
        <span class="status-chip status-${escapeHtml(b.status)}">${escapeHtml(waxdaoStatusLabel(b.status))}</span>
      </div>`;
  }).join('');
  return `<div class="picker-panel"><div class="picker-rows">${rows}</div></div>`;
}

function renderWaxdaoLegend(): string {
  return `
    <div class="legend">
      <span class="legend-label">Color codes</span>
      <span class="legend-item"><span class="status-chip status-active">active</span></span>
      <span class="legend-item"><span class="status-chip status-sold_out">sold out</span></span>
      <span class="legend-item"><span class="status-chip status-ended">ended</span></span>
      <span class="legend-item"><span class="status-chip status-upcoming">upcoming</span></span>
    </div>`;
}

function renderPickWaxdao(): string {
  const w = state.waxdao;
  const session = getCurrentSession();
  const refreshLabel = w.loading
    ? 'Refreshing...'
    : w.list.length > 0
      ? 'Refresh WaxDAO blends'
      : 'Discover WaxDAO blends';
  const counts = w.list.length > 0
    ? `${w.list.length} blend${w.list.length === 1 ? '' : 's'} found`
    : '';
  const progressBar = w.loading && w.progress
    ? `<div class="progress"><div class="progress-fill" style="width:${Math.round(w.progress.pct * 100)}%"></div></div>`
    : '';
  return `
    <div class="card">
      <h2>2 · Pick a WaxDAO blend</h2>
      <p style="margin-top:0; color:var(--fg-dim); font-size:12px">
        WaxDAO's website is down but the <code>waxdaomarket</code> contract
        is still live. Crucible drives it directly: one
        <code>assertblend</code> + one transfer per ingredient slot, slot
        index in the memo.
      </p>
      <div class="row" style="gap:14px; align-items: flex-end; margin-bottom: 8px">
        <div style="width: 140px; flex: 0 0 140px">
          <label>Collection</label>
          ${renderCollectionInput()}
        </div>
        <div style="flex: 1 1 380px; min-width: 280px">
          <label>Available blends</label>
          <div class="picker waxdao-picker">
            ${renderWaxdaoPickerToggle()}
            ${renderWaxdaoPickerPanel()}
          </div>
        </div>
        <button class="primary" data-action="refreshWaxdao" ${w.loading || !isValidWaxName(state.discoveryCollection) ? 'disabled' : ''}>
          ${escapeHtml(refreshLabel)}
        </button>
      </div>
      ${renderCollectionChips()}
      ${progressBar}
      <div class="row" style="margin-top:10px; gap:14px; align-items:center; flex-wrap:wrap">
        <label class="inline-toggle">
          <input id="waxdaoShowInactive" type="checkbox" data-action="toggleWaxdaoInactive" ${w.showInactive ? 'checked' : ''} />
          <span>show ended / upcoming / sold-out</span>
        </label>
        <div class="spacer"></div>
        <span class="term">${escapeHtml(counts)}</span>
      </div>
      ${renderWaxdaoLegend()}
      ${session ? '' : '<p class="status-line term">Connect your wallet to match owned NFTs against each ingredient slot.</p>'}

      <div class="divider"></div>

      <label>Or enter a WaxDAO blend ID manually</label>
      <div class="row" style="gap:14px; align-items: flex-end">
        <div style="flex:1; min-width: 200px">
          <input id="waxdaoBlendIdInput" type="text" value="${escapeHtml(w.blendIdInput)}" placeholder="e.g. 1921" autocomplete="off" />
        </div>
        <button class="primary" data-action="loadWaxdaoManual" ${w.loading ? 'disabled' : ''}>
          ${w.loading ? 'Loading…' : 'Load blend'}
        </button>
      </div>
      ${w.error ? `<p class="status-line warn">Discovery: ${escapeHtml(w.error)}</p>` : ''}
    </div>`;
}

function renderWaxdaoInfo(): string {
  const w = state.waxdao;
  const b = w.picked;
  if (!b) return '';
  const remaining = b.max_blends > 0
    ? `${b.max_blends - b.blends_remaining}/${b.max_blends} (${b.blends_remaining} left)`
    : `unlimited (${b.max_blends - b.blends_remaining}/∞ used)`;
  const ingList = `<h3>Cost</h3><ul class="mint-info">${
    b.ingredients.map((ing) => `<li>${escapeHtml(waxdaoIngredientLabel(ing))}</li>`).join('')
  }</ul>`;
  const outList = b.results.length > 0
    ? `<h3>Expected mint</h3><ul class="mint-info">${
        b.results.map((r) => {
          const tid = r.template_id ? `template <code>${r.template_id}</code>` : '<span class="term">no template</span>';
          const sch = r.schema_name ? ` · schema <code>${escapeHtml(r.schema_name)}</code>` : '';
          const name = r.nft_name ? ` (${escapeHtml(r.nft_name)})` : '';
          return `<li>${tid}${sch}${name}</li>`;
        }).join('')
      }</ul>`
    : '';
  return `
    <div class="card">
      <div class="card-header">
        <h2>3 · ${escapeHtml(b.title)} <span class="term">-- #${escapeHtml(b.blend_id)} · ${escapeHtml(b.creator)}</span></h2>
        ${renderShareButton()}
      </div>
      <div class="row">
        <span class="status-chip status-${escapeHtml(b.status)}">${escapeHtml(waxdaoStatusLabel(b.status))}</span>
        <span class="tag">uses ${escapeHtml(remaining)}</span>
      </div>
      ${ingList}
      ${outList}
      ${b.description ? `<details style="margin-top:12px"><summary class="term" style="cursor:pointer">blend description</summary><p style="margin-top:8px; font-size:12px; color:var(--fg-dim); white-space:pre-wrap">${escapeHtml(b.description)}</p></details>` : ''}
    </div>`;
}

function renderWaxdaoSlotEntry(slot: number, ing: WaxdaoIngredient): string {
  const w = state.waxdao;
  const owned = ownedAssetsForWaxdaoSlot(ing);
  const pickedAsset = w.selection.get(slot);
  const items = owned.map((a) => {
    const selected = pickedAsset === a.asset_id ? ' selected' : '';
    const name = displayAssetName(a);
    return `
      <div class="asset${selected}" data-action="pickWaxdaoAsset" data-waxdao-slot="${slot}" data-asset="${escapeHtml(a.asset_id)}">
        <span>${escapeHtml(name)}</span>
        <span class="id">#${escapeHtml(a.asset_id)}${a.template_mint ? ' · mint ' + escapeHtml(a.template_mint) : ''}</span>
      </div>`;
  });
  return `
    <div class="slot">
      <div class="slot-header">
        <div class="slot-label">Slot ${slot} · ${escapeHtml(waxdaoIngredientLabel(ing))}</div>
        <div class="slot-progress">${pickedAsset ? '1/1 picked' : '0/1 picked'} · ${owned.length} eligible</div>
      </div>
      ${owned.length === 0
        ? '<p class="status-line err">No matching NFT in your wallet for this slot.</p>'
        : `<div class="asset-grid">${items.join('')}</div>`}
    </div>`;
}

function renderWaxdaoSlots(): string {
  const w = state.waxdao;
  if (!w.picked) return '';
  const slotsHtml = w.picked.nftSlots
    .map(({ slot, ingredient }) => renderWaxdaoSlotEntry(slot, ingredient))
    .join('');
  const ftHtml = w.picked.ingredients.map((ing, idx) => {
    if (ing.kind !== 'fungible') return '';
    const st = w.ftStatus.get(idx);
    const required = parseAssetAmount(ing.quantity);
    if (!st) {
      return `
        <div class="slot ft-slot">
          <div class="slot-header"><div class="slot-label">${escapeHtml(`Slot 0 · Pay ${ing.quantity}`)}</div></div>
          <p class="status-line">Reading your wallet balance…</p>
        </div>`;
    }
    const okBalance = st.balance >= 0 && st.balance >= required;
    return `
      <div class="slot ft-slot">
        <div class="slot-header"><div class="slot-label">${escapeHtml(`Slot 0 · Pay ${ing.quantity}`)}</div></div>
        <p class="status-line ${okBalance ? 'ok' : 'err'}">
          Balance: <code>${st.balance >= 0 ? st.balance.toFixed(4) : '?'}</code> · required <code>${required.toFixed(4)}</code>
        </p>
      </div>`;
  }).join('');
  return `
    <div class="card">
      <h2>4 · Pick the inputs ${state.assetsLoading ? '<span class="term">(refreshing your wallet…)</span>' : ''}</h2>
      ${ftHtml}
      ${slotsHtml}
    </div>`;
}

function renderWaxdaoActions(): string {
  const w = state.waxdao;
  if (!w.picked) return '';
  const ready = readyToWaxdaoBlend();
  return `
    <div class="card">
      <h2>5 · Verify &amp; execute</h2>
      <div class="row">
        <button data-action="waxdaoDryRun" ${ready ? '' : 'disabled'}>Simulate (no signature)</button>
        <button class="primary" data-action="waxdaoExecute" ${ready ? '' : 'disabled'}>${w.pending ? 'Signing…' : 'Sign &amp; broadcast'}</button>
      </div>
      ${w.lastDryRun
        ? `<h3>Dry-run output</h3><pre>${escapeHtml(JSON.stringify(w.lastDryRun, null, 2))}</pre>`
        : ''}
      ${w.lastTrxId
        ? `<p class="status-line ok">Trx broadcast: <a target="_blank" href="https://waxblock.io/transaction/${escapeHtml(w.lastTrxId)}">${escapeHtml(w.lastTrxId)}</a></p>`
        : ''}
    </div>`;
}

function renderWaxdaoBlendsView(): string {
  return renderPickWaxdao() + renderWaxdaoInfo() + renderWaxdaoSlots() + renderWaxdaoActions();
}

/**
 * Captures the window scroll position and the currently-focused input
 * (with its cursor offset and selection range) so we can restore them
 * after re-rendering. Without this, every state change would yank the
 * page back to the top and steal focus mid-typing, which is the visual
 * "the whole page is refreshing" effect we want to avoid.
 */
interface RenderSnapshot {
  scrollY: number;
  activeId: string | null;
  selStart: number | null;
  selEnd: number | null;
}
function captureRenderSnapshot(): RenderSnapshot {
  const el = document.activeElement as HTMLInputElement | null;
  const tag = el?.tagName;
  const isInput = tag === 'INPUT' || tag === 'TEXTAREA';
  return {
    scrollY: window.scrollY,
    activeId: el?.id ?? null,
    selStart: isInput ? el!.selectionStart : null,
    selEnd: isInput ? el!.selectionEnd : null,
  };
}
function restoreRenderSnapshot(snap: RenderSnapshot) {
  // Restore scroll first, doing it after focus would cause the browser
  // to jump back to the focused element.
  window.scrollTo({ top: snap.scrollY, behavior: 'instant' as ScrollBehavior });
  if (snap.activeId) {
    const el = document.getElementById(snap.activeId) as HTMLInputElement | null;
    if (el) {
      el.focus({ preventScroll: true });
      if (snap.selStart !== null && snap.selEnd !== null && typeof el.setSelectionRange === 'function') {
        try { el.setSelectionRange(snap.selStart, snap.selEnd); } catch { /* noop */ }
      }
    }
  }
}

/**
 * Walks every open picker panel and:
 *   1. portals it to <body> so `position: fixed` actually escapes its
 *      card's containing block (cards use `backdrop-filter` which, per
 *      CSS spec, captures `position: fixed` exactly like a `transform`
 *      would, otherwise the panel would jump or sit behind sibling
 *      cards)
 *   2. anchors it to the toggle via viewport coordinates from
 *      `getBoundingClientRect`
 *   3. decides whether to drop down or flip up based on available
 *      space, and caps `max-height` to the remaining viewport
 *
 * Runs after each render(). The render() output places the panel
 * inside the picker DOM; this function moves it out so the dropdown
 * paints above ALL cards regardless of their backdrop-filter stacking
 * contexts.
 */
function positionOpenPickers() {
  // 1. Clean up any panels that this same routine portaled to <body> in
  //    a previous render. They'll be re-portaled below if the picker is
  //    still open (and re-rendered the panel inside its card again).
  for (const stale of document.querySelectorAll<HTMLElement>(
    'body > .picker-panel[data-portaled]',
  )) {
    stale.remove();
  }

  const panels = document.querySelectorAll<HTMLElement>('.picker-panel');
  for (const panel of panels) {
    const picker = panel.closest<HTMLElement>('.picker');
    const toggle = picker?.querySelector<HTMLElement>('.picker-toggle');
    if (!toggle) continue;
    const rect = toggle.getBoundingClientRect();
    const viewportH = window.innerHeight;
    const margin = 16;
    const spaceBelow = viewportH - rect.bottom - margin;
    const spaceAbove = rect.top - margin;
    const minRoom = 200;

    let placeAbove = false;
    if (spaceBelow < minRoom && spaceAbove > spaceBelow) {
      placeAbove = true;
    }
    panel.dataset.position = placeAbove ? 'above' : 'below';

    const availableH = Math.max(120, placeAbove ? spaceAbove : spaceBelow);
    const cap = Math.min(420, availableH);
    panel.style.maxHeight = `${cap}px`;
    const rows = panel.querySelector<HTMLElement>('.picker-rows');
    if (rows) rows.style.maxHeight = `${cap}px`;

    // Inline anchor in viewport coordinates.
    panel.style.left = `${rect.left}px`;
    panel.style.width = `${rect.width}px`;
    if (placeAbove) {
      panel.style.top = 'auto';
      panel.style.bottom = `${viewportH - rect.top + 4}px`;
    } else {
      panel.style.top = `${rect.bottom + 4}px`;
      panel.style.bottom = 'auto';
    }

    // 2. Portal: move the panel out of its card and into <body> so it
    //    isn't captured by the card's backdrop-filter containing block.
    //    Tag it so the cleanup at the top of this function can find it
    //    on the next render.
    panel.dataset.portaled = 'true';
    document.body.appendChild(panel);
  }
}

/**
 * Public render() entry point. Coalesces multiple synchronous calls
 * into a single DOM rebuild per animation frame via requestAnimationFrame.
 *
 * Why this matters: during a discovery scan, 16 parallel chunks each
 * fire `onProgress` callbacks at different times. Without batching,
 * each callback triggered a full innerHTML rebuild, restarting CSS
 * animations and producing visible flicker. With rAF batching, at most
 * one rebuild happens per frame (~60Hz), even if state mutates 100x
 * within that 16ms.
 *
 * Callers don't need to think about this -- just call render() whenever
 * state changes and trust the scheduler.
 */
let renderScheduled = false;
function render() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(performRender);
}

/**
 * The actual rebuild. Wrapped in a snapshot/restore so the user doesn't
 * feel the page "refresh": scroll stays where it was, the input they
 * were typing in keeps its focus and caret position.
 */
function performRender() {
  renderScheduled = false;
  const snap = captureRenderSnapshot();
  const session = getCurrentSession();
  rootEl().innerHTML =
    renderAboutPanels() +
    renderConnect(session) +
    renderStatus() +
    renderTabs() +
    (state.view === 'blends'
      ? renderBlendsView()
      : state.view === 'drops'
        ? renderDropsView()
        : state.view === 'packs'
          ? renderPacksView()
          : state.view === 'upgrades'
            ? renderUpgradesView()
            : renderWaxdaoBlendsView());
  attachHandlers();
  positionOpenPickers();
  restoreRenderSnapshot(snap);
}

function attachHandlers() {
  const blendInput = document.getElementById('blendId') as HTMLInputElement | null;
  if (blendInput) {
    blendInput.addEventListener('input', (e) => {
      state.blendId = (e.target as HTMLInputElement).value.trim();
    });
    blendInput.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') onLoadBlend();
    });
  }

  const collectionSel = document.getElementById('collectionPick') as HTMLInputElement | null;
  if (collectionSel) {
    // Track typing into state so the value survives re-renders, but don't
    // trigger discovery on every keystroke, discovery is on-demand now.
    collectionSel.addEventListener('input', (e) => {
      const v = (e.target as HTMLInputElement).value.trim().toLowerCase();
      state.discoveryCollection = v;
    });
    // Commit on blur (focus leaves the field) or Enter, standard UX for
    // "I'm done editing this, now act on it".
    collectionSel.addEventListener('change', () => onChangeCollection(collectionSel.value.trim().toLowerCase()));
    collectionSel.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') {
        onChangeCollection(collectionSel.value.trim().toLowerCase());
      }
    });
  }
  const toggleInactive = document.getElementById('showInactive') as HTMLInputElement | null;
  if (toggleInactive) {
    toggleInactive.addEventListener('change', () => onToggleShowInactive(toggleInactive.checked));
  }
  const toggleOnlyExecutable = document.getElementById('onlyExecutable') as HTMLInputElement | null;
  if (toggleOnlyExecutable) {
    toggleOnlyExecutable.addEventListener('change', () => onToggleOnlyExecutable(toggleOnlyExecutable.checked));
  }
  const toggleDropInactive = document.getElementById('dropShowInactive') as HTMLInputElement | null;
  if (toggleDropInactive) {
    toggleDropInactive.addEventListener('change', () => onToggleDropShowInactive(toggleDropInactive.checked));
  }
  const toggleDropOnlyEligible = document.getElementById('dropOnlyEligible') as HTMLInputElement | null;
  if (toggleDropOnlyEligible) {
    toggleDropOnlyEligible.addEventListener('change', () => onToggleDropOnlyEligible(toggleDropOnlyEligible.checked));
  }
  // Cascading dropdowns in the UNPACK tab: collection -> design -> mint.
  // Each step narrows the choices, and selecting the final step kicks
  // off the unbox flow for that specific asset_id. The design step
  // auto-picks the only mint when a design has exactly one owned mint,
  // skipping the mint dropdown entirely.
  rootEl().querySelectorAll<HTMLSelectElement>('.pack-pick-collection').forEach((sel) => {
    sel.addEventListener('change', () => onPackPickCollection(sel.value));
  });
  rootEl().querySelectorAll<HTMLSelectElement>('.pack-pick-design').forEach((sel) => {
    sel.addEventListener('change', () => onPackPickDesign(sel.value));
  });
  rootEl().querySelectorAll<HTMLSelectElement>('.pack-mint-pick').forEach((sel) => {
    sel.addEventListener('change', () => {
      const asset = sel.value;
      if (asset) onPickPack(asset);
    });
  });
  const dropIdInput = document.getElementById('dropId') as HTMLInputElement | null;
  if (dropIdInput) {
    dropIdInput.addEventListener('input', (e) => {
      state.dropId = (e.target as HTMLInputElement).value.trim();
    });
    dropIdInput.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') void onLoadDropManual();
    });
  }
  const amountInput = document.getElementById('dropAmount') as HTMLInputElement | null;
  if (amountInput) {
    amountInput.addEventListener('input', (e) => onChangeDropAmount(Number((e.target as HTMLInputElement).value)));
  }
  // UPGRADE tab inputs.
  const upgradeIdInput = document.getElementById('upgradeIdInput') as HTMLInputElement | null;
  if (upgradeIdInput) {
    upgradeIdInput.addEventListener('input', (e) => {
      state.upgrades.upgradeIdInput = (e.target as HTMLInputElement).value.trim();
    });
    upgradeIdInput.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') void onLoadUpgradeManual();
    });
  }
  const toggleUpgradesInactive = document.getElementById('upgradesShowInactive') as HTMLInputElement | null;
  if (toggleUpgradesInactive) {
    toggleUpgradesInactive.addEventListener('change', () => onToggleUpgradesShowInactive(toggleUpgradesInactive.checked));
  }
  // WAXDAO blend tab inputs.
  const waxdaoIdInput = document.getElementById('waxdaoBlendIdInput') as HTMLInputElement | null;
  if (waxdaoIdInput) {
    waxdaoIdInput.addEventListener('input', (e) => {
      state.waxdao.blendIdInput = (e.target as HTMLInputElement).value.trim();
    });
    waxdaoIdInput.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') void onLoadWaxdaoBlendManual();
    });
  }
  const toggleWaxdaoInactive = document.getElementById('waxdaoShowInactive') as HTMLInputElement | null;
  if (toggleWaxdaoInactive) {
    toggleWaxdaoInactive.addEventListener('change', () => onToggleWaxdaoShowInactive(toggleWaxdaoInactive.checked));
  }

  rootEl().querySelectorAll<HTMLElement>('[data-action]').forEach((el) => {
    const action = el.dataset.action;
    // These actions are wired via 'change' listeners above, not click.
    if (
      action === 'toggleInactive' ||
      action === 'toggleOnlyExecutable' ||
      action === 'toggleDropInactive' ||
      action === 'toggleDropOnlyEligible' ||
      action === 'toggleUpgradesInactive' ||
      action === 'toggleWaxdaoInactive'
    ) return;
    el.addEventListener('click', (ev) => {
      switch (action) {
        case 'login':
          login()
            .then(() => {
              // On-demand discovery: don't auto-refetch. The lists we have
              // (if any) become stale because they don't know the actor's
              // whitelist/claim status yet, mark them empty so the user
              // can hit Refresh when they want the per-account info.
              if (state.discovered.length > 0) state.discovered = [];
              if (state.drops.length > 0) state.drops = [];
              render();
            })
            .catch((e) => setStatus((e as Error).message, 'err'));
          break;
        case 'logout':
          logout().then(() => {
            state.blend = undefined;
            state.template = undefined;
            state.slots = [];
            state.selection.clear();
            state.ownedAssets = [];
            state.whitelist = undefined;
            state.ftStatus.clear();
            state.drops = [];
            state.drop = undefined;
            state.dropTemplate = undefined;
            state.discovered = [];
            // On-demand: no auto-refetch after logout.
            render();
          });
          break;
        case 'loadBlend':
          onLoadBlend();
          break;
        case 'dryrun':
          onDryRun();
          break;
        case 'execute':
          onExecute();
          break;
        case 'togglePicker':
          onTogglePicker();
          break;
        case 'pickCollection': {
          const c = el.dataset.collection ?? '';
          onChangeCollection(c);
          break;
        }
        case 'pickRow': {
          const blend = el.dataset.blend!;
          onPickDiscovered(blend);
          break;
        }
        case 'toggle': {
          const slot = Number(el.dataset.slot);
          const asset = el.dataset.asset!;
          toggleSelect(slot, asset);
          break;
        }
        case 'switchView':
          onSwitchView(el.dataset.view as AppView);
          break;
        case 'toggleDropPicker':
          onToggleDropPicker();
          break;
        case 'pickDrop':
          onPickDrop(el.dataset.drop!);
          break;
        case 'loadDropManual':
          onLoadDropManual();
          break;
        case 'dropDryRun':
          onDropDryRun();
          break;
        case 'dropExecute':
          onDropExecute();
          break;
        case 'refreshBlends':
          loadDiscovered();
          break;
        case 'refreshDrops':
          loadDropsList();
          break;
        case 'refreshPacks':
          loadPacks();
          break;
        case 'pickPack':
          onPickPack(el.dataset.asset ?? '');
          break;
        case 'packAnnounce':
          onPackAnnounce();
          break;
        case 'packClaim':
          onPackClaim();
          break;
        case 'packCancelWait':
          onPackCancelWait();
          break;
        case 'packReset':
          onPackReset();
          break;
        case 'rngClaim':
          onClaimRng();
          break;
        case 'rngCancelWait':
          onCancelRngWait();
          break;
        case 'rngReset':
          onResetRng();
          break;
        case 'refreshUpgrades':
          loadUpgradesList();
          break;
        case 'toggleUpgradesPicker':
          onToggleUpgradesPicker();
          break;
        case 'pickUpgrade':
          void onPickUpgrade(el.dataset.upgrade!);
          break;
        case 'loadUpgradeManual':
          void onLoadUpgradeManual();
          break;
        case 'pickUpgradeAsset':
          onPickUpgradeAsset(Number(el.dataset.spec), el.dataset.asset ?? '');
          break;
        case 'upgradeDryRun':
          onUpgradeDryRun();
          break;
        case 'upgradeExecute':
          onExecuteUpgrade();
          break;
        case 'switchPlatform':
          onSwitchPlatform(el.dataset.platform as Platform);
          break;
        case 'copyShareLink':
          void onCopyShareLink();
          break;
        case 'refreshWaxdao':
          loadWaxdaoList();
          break;
        case 'toggleWaxdaoPicker':
          onToggleWaxdaoPicker();
          break;
        case 'pickWaxdaoBlend':
          void onPickWaxdaoBlend(el.dataset.waxdaoBlend ?? '');
          break;
        case 'loadWaxdaoManual':
          void onLoadWaxdaoBlendManual();
          break;
        case 'pickWaxdaoAsset':
          onPickWaxdaoAsset(Number(el.dataset.waxdaoSlot), el.dataset.asset ?? '');
          break;
        case 'waxdaoDryRun':
          onWaxdaoDryRun();
          break;
        case 'waxdaoExecute':
          onExecuteWaxdaoBlend();
          break;
      }
      ev.stopPropagation();
    });
  });
}

let outsideClickAttached = false;

export async function mount() {
  if (!outsideClickAttached) {
    document.addEventListener('click', onPickerOutsideClick);
    // Reposition any open picker when the viewport changes (scroll, resize,
    // mobile keyboard, dev-tools open, ...). Skip if no panel is open.
    const reflow = () => {
      if (state.pickerOpen || state.dropPickerOpen || state.upgrades.pickerOpen || state.waxdao.pickerOpen) positionOpenPickers();
    };
    window.addEventListener('scroll', reflow, { passive: true });
    window.addEventListener('resize', reflow);
    // Reflect URL hash changes (forward/back navigation, manual edits,
    // paste of a deep link into the address bar) back into state.
    // We compare the parsed route to the current state and apply any
    // differences, then re-trigger the deep-link loader if an ID is
    // present.
    window.addEventListener('hashchange', () => {
      const r = parseHashRoute();
      let mutated = false;
      if (r.platform !== state.platform) {
        state.platform = r.platform;
        mutated = true;
      }
      if (r.view !== state.view) {
        state.view = r.view;
        mutated = true;
      }
      if (r.id) {
        state.pendingDeepLink = { view: r.view, id: r.id };
        mutated = true;
      }
      if (mutated) {
        render();
        void applyPendingDeepLink();
      }
    });
    // Normalise the hash on first load (write back the canonical form
    // so a refresh keeps you exactly where you were).
    const r0 = parseHashRoute();
    writeHashRoute(r0.platform, r0.view, r0.id);
    outsideClickAttached = true;
  }
  setStatus('Verifying live blend.nefty ABI…', 'info');
  try {
    await loadBlendContractShape();
  } catch (err) {
    setStatus(`blend.nefty contract incompatible: ${(err as Error).message}`, 'err');
    return;
  }
  await restoreSession();
  setStatus('Ready. Pick a collection, then click Discover to load its blends or drops.', 'ok');
  render();
  // On-demand fetching: NO auto-discovery at mount. The user clicks
  // Refresh on the picker card when they're ready, this avoids spinning
  // up ~30 RPC calls before they've even decided what to look at.
  //
  // EXCEPT for deep links: if the user landed on a URL carrying an
  // entity ID (#/nefty/blend/43444), load that entity right away so
  // they see what was shared with them. The wallet connection prompt
  // still appears at the top when no session is active.
  void applyPendingDeepLink();
}
