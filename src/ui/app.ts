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
  poolDraws,
  oddsAreCertain,
  parsePoolDisplayData,
  type BlendRow,
} from '../nefty/blend';
import { loadPool, type PoolInfo } from '../nefty/pools';
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
  buildCreateBlendAction,
  executeCreateBlend,
  parseIngredientLines,
  parseOutcomeLines,
  describeOdds,
  validateNewBlend,
  type CreateBlendArgs,
} from '../nefty/createBlend';
import {
  listBlenderizerBlends,
  loadBlenderizerBlendById,
  readBlenderizerRam,
  blenderizerTitle,
  LARGE_MIXTURE_WARN,
  type BlenderizerRam,
  type BlenderizerStatus,
  type DiscoveredBlenderizerBlend,
} from '../blenderizer/blends';
import {
  buildBlenderizerBlendActions,
  executeBlenderizerBlend,
} from '../blenderizer/blendExecute';
import { canManageCollection, listAuthorizedCollections } from '../atomic/collections';
import {
  buildSetBlendHide,
  buildSetBlendTime,
  buildDelBlend,
  buildSetBlendMax,
  buildSetBlendLim,
  buildSetBlendData,
  buildSetBlendSec,
  buildAddToWhitelist,
  buildEraseFromWhitelist,
  buildClearWhitelist,
  buildAddWhitelist,
  executeAdminAction,
  readWhitelistMembers,
  readCollectionSecurities,
  type SecurityRow,
} from '../nefty/admin';
import {
  buildCreateDrop,
  buildDropDisplayData,
  formatListing,
  parseTemplateEntries,
  entriesToAssets,
  totalMints,
  FREE_LISTING_PRICE,
  FREE_SETTLEMENT_SYMBOL,
} from '../nefty/createDrop';
import {
  buildDropAddToWhitelist,
  buildDropEraseFromWhitelist,
  buildSetDropAuth,
  buildSetDropHidden,
  buildEraseDrop,
  readDropWhitelist,
  readDropById,
  extractNewDropId,
} from '../nefty/dropAdmin';
import {
  readKnownClaimIds,
  waitForClaim,
  waitForClaimConsumed,
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
  clearDiscoverCache,
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
  type PackDesign,
} from '../nefty/packs';
import {
  executeUnboxAnnounce,
  executeUnboxClaim,
} from '../nefty/packExecute';
import { waitForUnboxAssets, type UnboxAssetRow } from '../nefty/packWait';
import { listNeftyPackDesigns } from '../nefty/neftyPacks';
import {
  executeNeftyUnboxAnnounce,
  executeNeftyUnboxClaim,
} from '../nefty/neftyPackExecute';
import { waitForNeftyClaim } from '../nefty/neftyPackWait';
import { dryRunActions } from './dryrun';
import { renderAboutPanels } from './about';
import { renderStatusPage, runStatusScan, getStatusState } from './status';
import { renderMediaThumb, attachMediaFallbacks } from './media';
import {
  renderCatalogPage,
  runCatalogScan,
  getCatalogState,
  setCatalogCollection,
  setCatalogGrouping,
  setCatalogSearch,
  setCatalogOnlyDoable,
  setCatalogShowInactive,
  toggleCatalogGroup,
  type CatalogGrouping,
} from './catalog';

type AppView =
  | 'blends'   // Nefty: blend.nefty
  | 'drops'    // Nefty: neftyblocksd
  | 'packs'    // Nefty: atomicpacksx
  | 'upgrades' // Nefty: up.nefty
  | 'waxdao-blends' // WaxDAO: waxdaomarket
  | 'blenderizer-blends'; // Blenderizer: blenderizerx

/**
 * Top-level platform switch. Each platform exposes its own set of
 * tabs; the user picks one platform at a time. The choice is reflected
 * in the URL hash (#/nefty, #/waxdao, #/blenderizer) so the page is
 * bookmarkable and shareable.
 */
type Platform = 'nefty' | 'waxdao' | 'blenderizer';

/** Default tab per platform. Used when the platform pill is clicked. */
const DEFAULT_VIEW_FOR_PLATFORM: Record<Platform, AppView> = {
  nefty: 'blends',
  waxdao: 'waxdao-blends',
  blenderizer: 'blenderizer-blends',
};

/** Reverse mapping: which platform a given view belongs to. */
function platformOf(view: AppView): Platform {
  if (view === 'waxdao-blends') return 'waxdao';
  if (view === 'blenderizer-blends') return 'blenderizer';
  return 'nefty';
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
  /**
   * Stock of the pool a POOL_NFT_RESULT blend draws from, keyed by
   * pool_name. Populated only for pool blends; empty otherwise.
   */
  pools: Map<string, PoolInfo>;
  poolsLoading: boolean;
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
  /** Top-level page: the normal app, or the standalone contract-status page. */
  page: 'app' | 'status' | 'catalog';
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
  blenderizer: BlenderizerViewState;
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
  /**
   * Cross-tab cache of `template_id -> artwork reference`, filled by the
   * same lazy lookup that resolves names. Lets views that only know a
   * template id (random-blend outcomes, for one) show its picture
   * without a second round-trip.
   */
  templateImages: Map<number, string>;

  /** Collection-author admin controls (BLEND tab, inline in zone 3). */
  manage: ManageState;
  /** Collection-author "create a drop" panel (CLAIM/drops tab). */
  createDrop: CreateDropState;
  createBlend: CreateBlendState;
  /** Collection-author "manage a drop" panel (whitelist + settings). */
  manageDrop: DropManageState;
}

interface ManageableDrop {
  drop_id: string;
  collection_name: string;
  name: string;
  status: string;
}

interface DropManageState {
  /** Opt-in safety switch - its own, independent of the create panel. */
  enabled: boolean;
  /** Drops the connected account can manage, for the picker (lazy-loaded). */
  myDrops?: ManageableDrop[];
  myDropsLoading: boolean;
  myDropsError?: string;
  /** The drop_id typed/loaded for management. */
  dropIdInput: string;
  /** The loaded drop being managed (undefined until loaded). */
  loaded?: import('../nefty/dropAdmin').DropAdminRow;
  loading: boolean;
  /** Whether the connected wallet can manage the loaded drop's collection. */
  authorized?: boolean;
  /** True while an admin tx is in flight. */
  busy: boolean;
  /** Accounts currently in the loaded drop's whitelist. */
  whitelist?: string[];
  /** Inline form input for adding whitelist accounts. */
  addAccountsInput: string;
}

/**
 * Inline "create a blend" form (BLEND tab, collection authors).
 *
 * Ingredients and outcomes are collected as one-per-line text rather
 * than a widget tree: a blend is a three-level structure (ingredients /
 * weighted outcomes / results) and a form that nests that deeply is
 * worse to use than a recipe you can read, paste and diff. Same choice
 * the drop creator makes for its templates field.
 */
interface CreateBlendState {
  /** Opt-in safety switch, like the drop creator. */
  enabled: boolean;
  collection: string;
  authChecked?: string;
  authorized?: boolean;
  authChecking: boolean;
  busy: boolean;
  /** display_data fields. */
  name: string;
  description: string;
  image: string;
  category: string;
  /** One ingredient per line (see parseIngredientLines). */
  ingredientsInput: string;
  /** One outcome per line (see parseOutcomeLines). */
  outcomesInput: string;
  /** datetime-local strings; empty = now / never. */
  startTime: string;
  endTime: string;
  /** '' or '0' = unlimited. */
  maxUses: string;
  accountLimit: string;
  cooldown: string;
  /** secure.nefty whitelist id; '' or '0' = open. */
  securityId: string;
  hidden: boolean;
  lastDryRun?: unknown;
  lastTrxId?: string;
}

interface CreateDropState {
  /** Opt-in safety switch - the form is collapsed until the author flips it. */
  enabled: boolean;
  /** Target collection; defaults to the drops-tab discovery collection. */
  collection: string;
  /** Auth lookup cache for `collection` (mirrors ManageState pattern). */
  authChecked?: string;
  authorized?: boolean;
  authChecking: boolean;
  /** True while the createdrop tx is in flight. */
  busy: boolean;
  /** Display data. */
  name: string;
  description: string;
  image: string;
  /** "templates to mint" free-form input, e.g. "877088 x20, 889127 x2". */
  templatesInput: string;
  /** Pricing. `free` overrides amount/token. */
  free: boolean;
  priceAmount: string;
  priceToken: string;
  priceDecimals: string;
  /** Supply. `unlimited` sets max_claimable = 0. */
  unlimited: boolean;
  maxClaimable: string;
  /** Per-account limit (0 = none) + cooldown seconds. */
  accountLimit: string;
  cooldown: string;
  /** datetime-local strings; empty = now / never. */
  startTime: string;
  endTime: string;
  /** Whitelist gate + visibility + payout. */
  authRequired: boolean;
  hidden: boolean;
  priceRecipient: string;
  allowCreditCard: boolean;
}

interface ManageState {
  /**
   * Opt-in safety switch. The destructive / parameter controls are
   * collapsed and inert until the author flips this, so nobody
   * fat-fingers a delete while blending normally. Off by default.
   */
  enabled: boolean;
  /**
   * collection_name -> whether the connected actor can manage it.
   * `undefined` means "not checked yet" (an async lookup is pending).
   */
  authByCollection: Map<string, boolean | undefined>;
  /** Members of the currently-selected whitelist, when one is selected. */
  whitelistMembers?: string[];
  /** The loaded blend's collection security definitions (the dropdown). */
  securities: import('../nefty/admin').SecurityRow[];
  /**
   * The whitelist the member editor currently targets. May differ from
   * the blend's attached security_id (the author can manage any of the
   * collection's whitelists). `undefined` means "none selected".
   */
  selectedSecurityId?: string;
  /**
   * Set right before a "create whitelist" tx so the next context
   * refresh auto-selects the newest whitelist - letting the author add
   * wallets to the list they just made without hunting for it.
   */
  autoSelectNewest: boolean;
  /** True while an admin tx is in flight. */
  busy: boolean;
  /** Inline form inputs (kept in state so they survive re-renders). */
  addAccountsInput: string;
  newWhitelistName: string;
  newNameInput: string;
  newMaxInput: string;
  newLimitInput: string;
  newCooldownInput: string;
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

/**
 * State machine for the BLENDERIZER tab. Same picker / info / slots /
 * actions shape as the other two platforms, but simpler underneath:
 * recipes have no token cost and no time window, and blending is a
 * single transfer.
 */
interface BlenderizerViewState {
  /** Free-form target-template-id input (manual entry path). */
  blendIdInput: string;
  list: DiscoveredBlenderizerBlend[];
  loading: boolean;
  progress?: { pct: number; message: string };
  error?: string;
  picked?: DiscoveredBlenderizerBlend;
  pickerOpen: boolean;
  showInactive: boolean;
  /**
   * Picked asset_ids per slot index. Slots hold `amount` NFTs of one
   * template, so this mirrors the Nefty BLEND tab's multi-select
   * rather than WaxDAO's one-asset-per-slot.
   */
  selection: Map<number, string[]>;
  /**
   * The collection's RAM balance on blenderizerx. `undefined` while
   * unread; a missing row is normalised to bytes: 0 by the reader.
   * Zero RAM means the contract cannot mint for this collection.
   */
  ram?: BlenderizerRam;
  ramChecked: boolean;
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
  /**
   * NFTs picked to BURN as cost, keyed by ingredient index (for TEMPLATE /
   * SCHEMA / COLLECTION cost ingredients). Each value is the list of chosen
   * asset_ids (the ingredient's `amount` determines how many are needed).
   * These become `transferred_assets` in the upgrade action.
   */
  costSelection: Map<number, string[]>;
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
  pools: new Map(),
  poolsLoading: false,
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
  page: parseHashRoute().page,
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
    costSelection: new Map(),
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
  blenderizer: {
    blendIdInput: '',
    list: [],
    loading: false,
    pickerOpen: false,
    showInactive: false,
    selection: new Map(),
    ramChecked: false,
    pending: false,
  },
  platform: readPlatformFromHash(),
  pendingDeepLink: (() => {
    const r = parseHashRoute();
    // Only the app page has entity deep links. Standalone pages reuse the
    // `id` slot for their own grammar (#/catalog/<collection>), so queuing
    // one here would send the collection name to the blend loader.
    if (r.page !== 'app') return undefined;
    return r.id ? { view: r.view, id: r.id } : undefined;
  })(),
  templateNames: new Map(),
  templateImages: new Map(),
  manage: {
    enabled: false,
    authByCollection: new Map(),
    securities: [],
    autoSelectNewest: false,
    busy: false,
    addAccountsInput: '',
    newWhitelistName: '',
    newNameInput: '',
    newMaxInput: '',
    newLimitInput: '',
    newCooldownInput: '',
  },
  createBlend: {
    enabled: false,
    collection: '',
    authChecking: false,
    busy: false,
    name: '',
    description: '',
    image: '',
    category: '',
    ingredientsInput: '',
    outcomesInput: '',
    startTime: '',
    endTime: '',
    maxUses: '',
    accountLimit: '',
    cooldown: '',
    securityId: '',
    hidden: false,
  },
  createDrop: {
    enabled: false,
    collection: '',
    authChecking: false,
    busy: false,
    name: '',
    description: '',
    image: '',
    templatesInput: '',
    free: false,
    priceAmount: '',
    priceToken: 'WAX',
    priceDecimals: '8',
    unlimited: false,
    maxClaimable: '',
    accountLimit: '',
    cooldown: '',
    startTime: '',
    endTime: '',
    authRequired: false,
    hidden: false,
    priceRecipient: '',
    allowCreditCard: false,
  },
  manageDrop: {
    enabled: false,
    myDropsLoading: false,
    dropIdInput: '',
    loading: false,
    busy: false,
    addAccountsInput: '',
  },
};

/**
 * Hash routing grammar:
 *
 *   #/<platform>                          platform only, default tab
 *   #/<platform>/<tab>                    specific tab, no entity
 *   #/<platform>/<tab>/<id>               deep link to a specific entity
 *
 * Tab slugs:
 *   nefty       → blend | claim | unpack | upgrade
 *   waxdao      → blend
 *   blenderizer → blend
 *
 * Standalone pages sit outside that grammar:
 *   #/status                  contract health monitor
 *   #/catalog/<collection>    everything one collection offers
 *
 * Entity IDs:
 *   blend    → blend_id  (uint64); on blenderizer this is the target
 *              template_id, which is that contract's primary key
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
  /** Standalone pages that sit outside the platform/tab grammar (e.g. #/status). */
  page: 'app' | 'status' | 'catalog';
}

function tabSlugToView(platform: Platform, slug: string | undefined): AppView {
  if (platform === 'waxdao') return 'waxdao-blends';
  if (platform === 'blenderizer') return 'blenderizer-blends';
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
    case 'upgrades':           return 'upgrade';
    case 'waxdao-blends':      return 'blend';
    case 'blenderizer-blends': return 'blend';
  }
}

function parseHashRoute(): ParsedRoute {
  try {
    const h = (typeof location !== 'undefined' ? location.hash : '') || '';
    const clean = h.replace(/^#\/?/, '');
    const parts = clean.split('/').map((p) => p.trim()).filter(Boolean);
    const platformSlug = (parts[0] || '').toLowerCase();
    const page: ParsedRoute['page'] =
      platformSlug === 'status'
        ? 'status'
        : platformSlug === 'catalog'
          ? 'catalog'
          : 'app';
    const platform: Platform =
      platformSlug === 'waxdao'
        ? 'waxdao'
        : platformSlug === 'blenderizer'
          ? 'blenderizer'
          : 'nefty';
    const view = tabSlugToView(platform, (parts[1] || '').toLowerCase());
    // Standalone pages have their own grammar: #/catalog/<collection>
    // carries the collection where an entity id would normally sit.
    const id = page === 'catalog'
      ? (parts[1] ? parts[1].toLowerCase() : undefined)
      : (parts[2] ? parts[2] : undefined);
    return { platform, view, id, page };
  } catch {
    return { platform: 'nefty', view: 'blends', page: 'app' };
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

function setStatus(msg: string, kind: AppState['statusKind'] = 'info', txId?: string) {
  state.status = msg;
  state.statusKind = kind;
  // Success/error outcomes pop the top banner, visible no matter where the
  // user has scrolled. 'info'/progress and 'warn' hints stay in the inline
  // status line only. When a tx id is supplied the banner offers a
  // "copy tx link" button.
  if (kind === 'ok' || kind === 'err') showToast(msg, kind, txId);
  render();
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * Shows a transient, fixed-position notification independent of render()
 * (it lives outside #root so repaints don't wipe it). Auto-dismisses;
 * errors linger longer than successes.
 */
function showToast(msg: string, kind: 'ok' | 'err', txId?: string) {
  if (typeof document === 'undefined') return;
  let el = document.getElementById('crucible-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'crucible-toast';
    document.body.appendChild(el);
  }
  const banner = el;
  const dismiss = () => banner.classList.remove('show');
  banner.className = `toast toast-${kind} show`;
  banner.innerHTML = '';

  const message = document.createElement('span');
  message.className = 'toast-msg';
  message.textContent = `${kind === 'ok' ? '✓' : '✕'}  ${msg}`;
  banner.appendChild(message);

  // "copy tx link" - only when we have a transaction id to point at.
  if (txId) {
    const url = `https://waxblock.io/transaction/${txId}`;
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'toast-btn';
    copyBtn.textContent = 'copy tx link';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      try {
        void navigator.clipboard?.writeText(url);
        copyBtn.textContent = 'copied!';
      } catch {
        copyBtn.textContent = 'copy failed';
      }
    });
    banner.appendChild(copyBtn);
  }

  // Explicit confirm/close button (banner also dismisses on background click).
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'toast-btn toast-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = 'OK ✕';
  closeBtn.addEventListener('click', (e) => { e.stopPropagation(); dismiss(); });
  banner.appendChild(closeBtn);

  banner.onclick = dismiss;

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(dismiss, kind === 'err' ? 12000 : 6000);
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
  if (state.blenderizer.pickerOpen && (!target || (!target.closest('.blenderizer-picker') && !insidePanel))) {
    state.blenderizer.pickerOpen = false;
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
      case 'blenderizer-blends':
        state.blenderizer.blendIdInput = dl.id;
        await onLoadBlenderizerBlendManual();
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

/**
 * Kicks off the contract-status scan the first time the user opens #/status
 * (lazy: nothing heavy runs at app mount). The Refresh button re-scans
 * explicitly. `render` is passed so cards paint as each contract resolves.
 */
function maybeScanStatus() {
  const s = getStatusState();
  if (!s.scanned && !s.scanning) void runStatusScan(render);
}

/**
 * Opens #/catalog. The route can carry the collection
 * (`#/catalog/underpunks55`), in which case we scan straight away so a
 * shared link lands on a populated page. Without one we just render the
 * empty form and wait for the user to pick.
 *
 * Re-scans when the routed collection differs from the loaded one, so
 * editing the hash switches collection rather than showing stale rows.
 */
function maybeScanCatalog(routedCollection?: string) {
  const c = getCatalogState();
  if (routedCollection && routedCollection !== c.loaded) {
    setCatalogCollection(routedCollection);
    void startCatalogScan();
    return;
  }
  if (!routedCollection && !c.collection && state.discoveryCollection) {
    // Carry over whatever collection the user was already working with.
    setCatalogCollection(state.discoveryCollection);
    render();
  }
}

/** Runs the scan for the collection currently in the catalogue input. */
async function startCatalogScan() {
  const c = getCatalogState();
  if (!c.collection) {
    setStatus('Enter a collection name first.', 'err');
    return;
  }
  if (!isValidWaxName(c.collection)) {
    setStatus(`"${c.collection}" is not a valid WAX collection name.`, 'err');
    return;
  }
  writeCatalogHash(c.collection);
  const session = getCurrentSession();
  await runCatalogScan(c.collection, session ? String(session.actor) : undefined, render);
}

/** Keeps #/catalog/<collection> in sync without firing a hashchange. */
function writeCatalogHash(collection: string) {
  try {
    const target = `#/catalog/${collection}`;
    if (location.hash === target) return;
    history.replaceState(null, '', target);
  } catch {
    // non-fatal: the page works, only the URL lags
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
    // Both pack contracts: AtomicHub (atomicpacksx) AND NeftyBlocks
    // (neftyblocksp). Their designs are matched against the same wallet
    // inventory; each OwnedPack carries pack.source so the unbox flow can
    // route to the right contract.
    const designsP = Promise.all([
      listPackDesigns().catch(() => [] as PackDesign[]),
      listNeftyPackDesigns().catch(() => [] as PackDesign[]),
    ]).then(([a, n]) => [...a, ...n]);
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

  // neftyblocksp packs don't expose per-roll odds in a packrolls table
  // (their outcomes come from a recipe and are only staged at unbox time),
  // so skip the pre-open odds fetch - the resolved cards still show after
  // the announce step.
  if (pack.pack.source === 'neftyblocksp') return;

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
  const nefty = pack.pack.source === 'neftyblocksp';
  const contract = nefty ? 'neftyblocksp' : 'atomicpacksx';
  state.packPhase = 'announcing';
  state.packPhaseMessage = `Awaiting wallet signature for step 1 (send pack to ${contract})…`;
  render();
  try {
    const result = nefty
      ? await executeNeftyUnboxAnnounce(session, pack.asset_id)
      : await executeUnboxAnnounce(session, pack.asset_id);
    state.packTx1Id =
      (result.response as { transaction_id?: string } | undefined)?.transaction_id ??
      String(result.resolved?.transaction.id ?? '');
    state.packPhase = 'waiting';
    state.packPhaseMessage = 'TX1 broadcast. Waiting for ORNG randomness…';
    state.packWaitElapsedMs = 0;
    state.packAbort = new AbortController();
    render();

    const onTick = (elapsedMs: number) => {
      state.packWaitElapsedMs = elapsedMs;
      // re-render the elapsed time without trashing other state
      if (state.view === 'packs') render();
    };
    const rows = nefty
      ? await waitForNeftyClaim({ pack_asset_id: pack.asset_id, onTick, signal: state.packAbort.signal })
      : await waitForUnboxAssets({ pack_asset_id: pack.asset_id, onTick, signal: state.packAbort.signal });
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
    const result = pack.pack.source === 'neftyblocksp'
      ? await executeNeftyUnboxClaim(session, {
          claim_id: pack.asset_id, // neftyblocksp stages the claim under the pack's own asset_id
          roll_count: state.packUnboxAssets.length,
        })
      : await executeUnboxClaim(session, {
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
    setStatus(`Drop claimed: ${trxId}`, 'ok', trxId);
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
  state.pools.clear();
  state.poolsLoading = false;
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
    // Fire off the admin-detection + whitelist/security reads in the
    // background. They only matter for collection authors; failures
    // are swallowed and the Manage section just stays hidden.
    void refreshManageContext(state.blend);
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

    // Every blend shape is loadable. The execute button routes on
    // isDeterministic(): true -> one-shot nosecfuse, false -> the
    // announce+fuse / wait / claim state machine. Pool draws take that
    // second path too (the contract picks the escrowed asset at fuse
    // time), and the action list is identical either way.
    const session = getCurrentSession();
    if (session) {
      state.whitelist = await checkWhitelist({
        security_id: state.blend.security_id,
        actor: String(session.actor),
      });
    }

    state.blendLoading = false; // header info is enough to show, keep skeletons for assets/template
    render();

    // Kick off template enrichment + pool stock + asset refresh in parallel.
    const blend = state.blend;
    const results = deterministicResults(blend);
    const firstResult = results[0];
    const draws = poolDraws(blend);
    state.templateLoading = !!firstResult;
    state.poolsLoading = draws.length > 0;
    render();

    const tasks: Promise<unknown>[] = [];
    if (firstResult) {
      tasks.push(
        loadTemplate({
          collection_name: blend.collection_name,
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
    if (draws.length > 0) {
      tasks.push(loadPoolsFor(blend, draws.map((d) => d.pool_name)));
    }
    tasks.push(refreshAssets());
    await Promise.all(tasks);
  } catch (err) {
    setStatus(`Error: ${(err as Error).message}`, 'err');
  } finally {
    state.pending = false;
    state.blendLoading = false;
    state.templateLoading = false;
    state.poolsLoading = false;
    render();
  }
}

/**
 * Reads the stock of every pool a blend draws from, plus the template
 * each pool hands out (pool results carry no template_id, only the pool
 * name, so the reward preview has to come from the pool row).
 *
 * Best-effort by design: a pool that fails to read leaves the card
 * showing "stock unknown" instead of blocking the blend.
 */
async function loadPoolsFor(blend: BlendRow, poolNames: string[]): Promise<void> {
  state.poolsLoading = true;
  try {
    await Promise.all(
      [...new Set(poolNames)].map(async (pool_name) => {
        try {
          const info = await loadPool({
            collection_name: blend.collection_name,
            pool_name,
          });
          if (info) state.pools.set(pool_name, info);
        } catch {
          // leave it out of the map; the UI renders "stock unknown"
        }
      }),
    );
    // A pool's templates give us a real name/supply for the reward panel.
    // Only fill `state.template` when nothing else claimed it.
    const firstTemplate = [...state.pools.values()]
      .flatMap((p) => p.templates)
      .find((t) => t > 0);
    if (firstTemplate && !state.template && !state.templateLoading) {
      state.templateLoading = true;
      render();
      try {
        state.template = await loadTemplate({
          collection_name: blend.collection_name,
          template_id: firstTemplate,
        });
      } finally {
        state.templateLoading = false;
      }
    }
  } finally {
    state.poolsLoading = false;
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
      secure: blendIsSecure(state.blend),
      security_check: defaultSecurityCheck(String(session.actor)),
    });
  }
  return buildBlendActions({
    claimer: String(session.actor),
    blend_id: state.blend.blend_id,
    asset_ids,
    ft_payments,
    secure: blendIsSecure(state.blend),
    security_check: defaultSecurityCheck(String(session.actor)),
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
      secure: blendIsSecure(state.blend),
      security_check: defaultSecurityCheck(String(session.actor)),
    });
    const trxId =
      (result.response as { transaction_id?: string } | undefined)?.transaction_id ??
      String(result.resolved?.transaction.id ?? '');
    state.lastTrxId = trxId;
    setStatus(`Transaction broadcast: ${trxId}`, 'ok', trxId);
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

/** True when the blend is gated by a security_id (whitelist/ownership). This
 *  decides fuse (secure) vs nosecfuse (non-secure), independently of whether
 *  the blend is random. */
function blendIsSecure(b: BlendRow): boolean {
  return b.security_id !== undefined && String(b.security_id) !== '0';
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
  const secure = blendIsSecure(state.blend);
  const actions = await buildFuseActions({
    claimer,
    blend_id: state.blend.blend_id,
    asset_ids: flattenNftSelection(state.slots, state.selection),
    ft_payments: ftSlots(state.slots).map((s) => s.quantity),
    secure,
    security_check,
  });
  const why = poolDraws(state.blend).length > 0
    ? `\n\nThe reward comes out of a pre-filled pool: the contract picks which escrowed ` +
      `NFT you get, then Nefty's claim service delivers it to your wallet a few seconds ` +
      `later - usually no second signature is needed.`
    : `\n\nThis is a random blend: the oracle resolves the result and Nefty's claim ` +
      `service mints it to your wallet automatically a few seconds later - usually no ` +
      `second signature is needed.`;
  if (
    !confirm(
      `Sign ${actions.length} action(s) to blend?\n\n` +
        actions.map((a, i) => `${i + 1}. ${a.account}::${a.name}`).join('\n') +
        why,
    )
  ) {
    return;
  }
  // Snapshot before broadcasting so we can spot the freshly created row.
  const known = await readKnownClaimIds(claimer);
  state.rngPhase = 'announcing';
  state.rngPhaseMessage = 'Awaiting wallet signature…';
  render();
  try {
    const result = await executeFuse(session, {
      blend_id: state.blend.blend_id,
      asset_ids: flattenNftSelection(state.slots, state.selection),
      ft_payments: ftSlots(state.slots).map((s) => s.quantity),
      secure,
      security_check,
    });
    state.rngTx1Id =
      (result.response as { transaction_id?: string } | undefined)?.transaction_id ??
      String(result.resolved?.transaction.id ?? '');
    const shortTx = state.rngTx1Id ? state.rngTx1Id.slice(0, 8) : '';
    state.rngPhase = 'waiting';
    state.rngPhaseMessage = 'Submitted. The oracle resolves the result, then it mints automatically - watching…';
    state.rngWaitElapsedMs = 0;
    state.rngAbort = new AbortController();
    render();

    const onTick = (elapsedMs: number) => {
      state.rngWaitElapsedMs = elapsedMs;
      if (state.view === 'blends') render();
    };

    // Try to catch the staged row. It is short-lived because setup.nefty
    // auto-claims it; a timeout here almost always means it was already
    // minted before our first poll - NOT a failure.
    let row: ClaimAssetsRow | undefined;
    try {
      row = await waitForClaim({
        claimer,
        blend_id: state.blend.blend_id,
        knownClaimIds: known,
        timeoutMs: 45_000,
        onTick,
        signal: state.rngAbort.signal,
      });
    } catch (e) {
      if (/aborted/i.test((e as Error).message)) throw e; // user cancelled
      row = undefined; // timeout: most likely already auto-claimed
    }

    if (!row) {
      state.rngPhase = 'done';
      state.rngPhaseMessage =
        `✓ Blend submitted${shortTx ? ` (tx ${shortTx}…)` : ''}. Your result is minted to your wallet ` +
        `automatically by Nefty's claim service within ~30s - check your wallet. ` +
        `If it doesn't arrive, reload the blend to claim it manually.`;
      state.rngAbort = undefined;
      render();
      return;
    }

    // The row is staged. Watch whether the auto-claim service mints it.
    state.rngClaim = row;
    state.rngPhase = 'waiting';
    state.rngPhaseMessage =
      `Result resolved (${row.claims.length} card${row.claims.length === 1 ? '' : 's'}). ` +
      `Nefty's claim service is minting it to your wallet…`;
    render();
    const consumed = await waitForClaimConsumed(claimer, row.claim_id, {
      timeoutMs: 20_000,
      onTick,
      signal: state.rngAbort.signal,
    });
    state.rngAbort = undefined;
    if (consumed) {
      state.rngPhase = 'done';
      state.rngPhaseMessage = `✓ Done - ${row.claims.length} NFT(s) minted to your wallet automatically.`;
    } else {
      // Auto-claim service didn't mint it - let the user claim it themselves.
      state.rngPhase = 'ready';
      state.rngPhaseMessage =
        `Result is staged (${row.claims.length} card${row.claims.length === 1 ? '' : 's'}) but hasn't auto-minted yet. ` +
        `You can claim it yourself below.`;
    }
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
    state.rngPhaseMessage = `✓ Claimed. ${state.rngClaim.claims.length} NFT(s) minted to your wallet.`;
    render();
  } catch (err) {
    const msg = (err as Error).message;
    // If setup.nefty's auto-claim service got there first, the row is gone -
    // that's a success (the NFTs are already in the wallet), not an error.
    if (/already|not exist|does not exist|not found|unable to find|no claim/i.test(msg)) {
      state.rngPhase = 'done';
      state.rngPhaseMessage = `✓ Already minted - Nefty's auto-claim service delivered your NFT(s) first.`;
    } else {
      state.rngPhase = 'error';
      state.rngPhaseMessage = msg;
    }
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

// ─── BLEND admin (collection-author) handlers ────────────────────────── //

/**
 * After a blend loads, work out whether the connected wallet can
 * manage that collection and, if so, pre-load the whitelist members +
 * the collection's security definitions for the Manage panel.
 */
async function refreshManageContext(blend: BlendRow) {
  const m = state.manage;
  m.whitelistMembers = undefined;
  m.securities = [];
  const session = getCurrentSession();
  const actor = session ? String(session.actor) : '';
  const collection = blend.collection_name;
  if (!actor) {
    m.authByCollection.set(collection, false);
    render();
    return;
  }
  // Auth check (cached in atomic/collections.ts).
  try {
    const can = await canManageCollection(actor, collection);
    m.authByCollection.set(collection, can);
    render();
    if (!can) return;
  } catch {
    m.authByCollection.set(collection, false);
    render();
    return;
  }
  // We're authorized: load the collection's securities (the whitelist
  // dropdown) and decide which one the member editor should target.
  try {
    m.securities = await readCollectionSecurities(collection);
  } catch {
    m.securities = [];
  }

  // Default selection: the blend's attached whitelist. After a "create"
  // we instead jump to the newest security so the author can populate
  // it immediately.
  const attached = blend.security_id !== undefined ? String(blend.security_id) : '0';
  if (m.autoSelectNewest && m.securities.length > 0) {
    const newest = m.securities.reduce((a, b) => (Number(b.id) > Number(a.id) ? b : a));
    m.selectedSecurityId = newest.id;
    m.autoSelectNewest = false;
  } else {
    m.selectedSecurityId = attached !== '0' ? attached : undefined;
  }

  await loadSelectedWhitelistMembers();
  render();
}

/**
 * Reads the members of the currently-selected whitelist into
 * state.manage.whitelistMembers. No-op when nothing is selected.
 */
async function loadSelectedWhitelistMembers() {
  const m = state.manage;
  if (!m.selectedSecurityId || m.selectedSecurityId === '0') {
    m.whitelistMembers = undefined;
    return;
  }
  try {
    m.whitelistMembers = await readWhitelistMembers(m.selectedSecurityId);
  } catch {
    m.whitelistMembers = [];
  }
}

/**
 * The author picked a different whitelist to manage from the dropdown.
 * Loads its members. Selecting "0" (none) clears the editor.
 */
async function onManageSelectSecurity(security_id: string) {
  const m = state.manage;
  m.selectedSecurityId = security_id && security_id !== '0' ? security_id : undefined;
  m.whitelistMembers = undefined;
  render();
  await loadSelectedWhitelistMembers();
  render();
}

function manageActor(): string | undefined {
  const s = getCurrentSession();
  return s ? String(s.actor) : undefined;
}

function onToggleManageEnabled(checked: boolean) {
  state.manage.enabled = checked;
  render();
}

// ─── create-drop handlers ─────────────────────────────────────────────── //

function onToggleCreateEnabled(checked: boolean) {
  const c = state.createDrop;
  c.enabled = checked;
  // Default the target collection to whatever the drops tab is browsing.
  if (checked && !c.collection && state.discoveryCollection) {
    c.collection = state.discoveryCollection;
  }
  render();
  if (checked && c.collection) void refreshCreateDropAuth();
}

/**
 * Looks up whether the connected wallet can manage the entered collection
 * (same authorized_accounts check the Manage panel uses) and caches it on
 * the create-drop state so the form can enable/disable the submit button.
 */
async function refreshCreateDropAuth() {
  const c = state.createDrop;
  const collection = c.collection.trim();
  const session = getCurrentSession();
  const actor = session ? String(session.actor) : '';
  if (!collection || !actor) {
    c.authChecked = collection;
    c.authorized = false;
    render();
    return;
  }
  if (c.authChecked === collection && c.authorized !== undefined && !c.authChecking) return;
  c.authChecking = true;
  render();
  try {
    c.authorized = await canManageCollection(actor, collection);
  } catch {
    c.authorized = false;
  } finally {
    c.authChecked = collection;
    c.authChecking = false;
    render();
  }
}

/** Parses a datetime-local string to unix seconds; '' → 0 (now/never). */
function datetimeLocalToUnix(v: string): number {
  if (!v.trim()) return 0;
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

/**
 * Validates and submits a createdrop transaction. Builds the action from the
 * form, shows a full confirmation summary (these are consequential), signs a
 * single action, then resets the form on success.
 */
async function onCreateDrop() {
  const c = state.createDrop;
  const session = getCurrentSession();
  const actor = session ? String(session.actor) : '';
  const collection = c.collection.trim();
  if (!session || !actor) { setStatus('Connect a wallet first.', 'err'); return; }
  if (!collection) { setStatus('Enter the collection to create the drop in.', 'err'); return; }
  if (!(c.authChecked === collection && c.authorized)) {
    setStatus('That account is not authorized for this collection (the contract would reject it).', 'err');
    return;
  }

  const entries = parseTemplateEntries(c.templatesInput);
  if (entries.length === 0) {
    setStatus('Add at least one template id to mint (e.g. "877088 x20").', 'err');
    return;
  }
  const assets = entriesToAssets(entries);
  const mints = totalMints(entries);

  // Pricing.
  let listing_price: string;
  let settlement_symbol: string;
  if (c.free) {
    listing_price = FREE_LISTING_PRICE;
    settlement_symbol = FREE_SETTLEMENT_SYMBOL;
  } else {
    const amount = Number(c.priceAmount);
    const decimals = Number(c.priceDecimals);
    const token = c.priceToken.trim().toUpperCase();
    if (!Number.isFinite(amount) || amount < 0) { setStatus('Enter a valid price amount (or tick "free").', 'err'); return; }
    if (!token || !/^[A-Z]{1,7}$/.test(token)) { setStatus('Enter a valid token symbol code (e.g. WAX).', 'err'); return; }
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) { setStatus('Enter valid token decimals (WAX = 8).', 'err'); return; }
    ({ listing_price, settlement_symbol } = formatListing(amount, token, decimals));
  }

  // Supply / limits.
  const max_claimable = c.unlimited ? 0 : Math.max(0, Math.floor(Number(c.maxClaimable) || 0));
  if (!c.unlimited && max_claimable === 0) {
    setStatus('Set a max supply, or tick "unlimited".', 'err');
    return;
  }
  const account_limit = Math.max(0, Math.floor(Number(c.accountLimit) || 0));
  const account_limit_cooldown = Math.max(0, Math.floor(Number(c.cooldown) || 0));
  const start_time = datetimeLocalToUnix(c.startTime);
  const end_time = datetimeLocalToUnix(c.endTime);
  if (end_time !== 0 && start_time !== 0 && end_time <= start_time) {
    setStatus('End time must be after start time.', 'err');
    return;
  }

  const price_recipient = (c.priceRecipient.trim() || actor).toLowerCase();
  const display_data = buildDropDisplayData(c.name, c.description, c.image);

  const action = buildCreateDrop({
    authorized_account: actor,
    collection_name: collection,
    assets_to_mint: assets,
    listing_price,
    alternative_prices: [],
    settlement_symbol,
    price_recipient,
    auth_required: c.authRequired,
    is_hidden: c.hidden,
    max_claimable,
    account_limit,
    account_limit_cooldown,
    start_time,
    end_time,
    display_data,
    distribution_id: 0,
    allow_credit_card_payments: c.allowCreditCard,
    referral_fee: 0,
    referral_whitelist_id: 0,
  });

  const summary =
    `Create a drop on ${collection}?\n\n` +
    `• Mints: ${mints} NFT(s) from ${entries.length} template(s)\n` +
    `• Price: ${c.free ? 'FREE' : listing_price}\n` +
    `• Supply: ${c.unlimited ? 'unlimited' : max_claimable}\n` +
    `• Per-account: ${account_limit === 0 ? 'no limit' : account_limit}${account_limit_cooldown ? ` (cooldown ${account_limit_cooldown}s)` : ''}\n` +
    `• Window: ${start_time ? new Date(start_time * 1000).toLocaleString() : 'now'} → ${end_time ? new Date(end_time * 1000).toLocaleString() : 'never'}\n` +
    `• Payments to: ${price_recipient}\n` +
    `• Whitelist required: ${c.authRequired ? 'yes' : 'no'} · Hidden: ${c.hidden ? 'yes' : 'no'}\n\n` +
    `This is an on-chain action that costs RAM and commits these mints.`;
  if (!confirm(summary)) return;

  c.busy = true;
  render();
  try {
    setStatus(`Awaiting signature: neftyblocksd::createdrop…`, 'info');
    const result = await executeAdminAction(session, action);
    const trxId =
      (result.response as { transaction_id?: string } | undefined)?.transaction_id ??
      String(result.resolved?.transaction.id ?? '');
    const newDropId = extractNewDropId(result);
    const gatedNote = c.authRequired
      ? ' It is whitelist-gated and the whitelist is EMPTY - add the allowed accounts in "Manage a drop" below before anyone can claim.'
      : '';
    setStatus(
      newDropId
        ? `✓ Drop #${newDropId} created on ${collection}.${gatedNote} Tx: ${trxId}`
        : `✓ Drop created on ${collection}.${gatedNote} Tx: ${trxId}`,
      'ok',
      trxId,
    );
    // Reset the volatile form fields, keep the collection + safety toggle.
    c.name = '';
    c.description = '';
    c.image = '';
    c.templatesInput = '';
    c.maxClaimable = '';
    c.priceAmount = '';
    c.accountLimit = '';
    c.cooldown = '';
    c.startTime = '';
    c.endTime = '';
    // Auto-load the freshly created drop into the Manage panel so the author
    // can immediately populate the whitelist / tweak it - the step that used
    // to be impossible.
    if (newDropId) {
      state.manageDrop.dropIdInput = newDropId;
      void loadDropToManage(newDropId);
    }
  } catch (err) {
    setStatus(`createdrop failed: ${(err as Error).message}`, 'err');
  } finally {
    c.busy = false;
    render();
  }
}

// ─── manage-drop handlers (whitelist + settings for an existing drop) ──── //

/**
 * Loads a drop by id straight from chain (works for hidden/gated drops the
 * discovery scan skips), reads its whitelist, and checks whether the
 * connected wallet can manage its collection.
 */
async function loadDropToManage(dropId: string) {
  const m = state.manageDrop;
  const id = dropId.trim();
  if (!id) { setStatus('Enter a drop_id to manage.', 'err'); return; }
  m.loading = true;
  m.loaded = undefined;
  m.whitelist = undefined;
  m.authorized = undefined;
  render();
  try {
    const row = await readDropById(id);
    if (!row) { setStatus(`No drop #${id} found on-chain.`, 'err'); m.loading = false; render(); return; }
    m.loaded = row;
    // Pin the URL to the CLAIM tab + this drop. Without this the hash stays at
    // its default and a wallet round-trip that reloads the page (e.g. WAX Cloud
    // Wallet's redirect fallback when the popup is blocked) would boot the app
    // back onto the default BLEND tab and lose the drop being managed.
    writeHashRoute('nefty', 'drops', id);
    const session = getCurrentSession();
    const actor = session ? String(session.actor) : '';
    m.authorized = actor ? await canManageCollection(actor, row.collection_name).catch(() => false) : false;
    m.whitelist = await readDropWhitelist(id).catch(() => []);
  } catch (err) {
    setStatus(`Could not load drop #${id}: ${(err as Error).message}`, 'err');
  } finally {
    m.loading = false;
    render();
  }
}

function onManageDropLoad() {
  void loadDropToManage(state.manageDrop.dropIdInput);
}

function onToggleManageDropEnabled(checked: boolean) {
  state.manageDrop.enabled = checked;
  render();
}

/**
 * Builds the "drops I can manage" list: finds the collections the connected
 * account is authorized on (indexer), then scans each for its drops
 * (on-chain, cached). Lets the author pick a drop from a dropdown instead of
 * hunting for its id.
 */
async function onFindMyDrops() {
  const m = state.manageDrop;
  const session = getCurrentSession();
  const actor = session ? String(session.actor) : '';
  if (!actor) { setStatus('Connect a wallet first.', 'err'); return; }
  m.myDropsLoading = true;
  m.myDropsError = undefined;
  render();
  try {
    const collections = await listAuthorizedCollections(actor);
    if (collections.length === 0) {
      m.myDrops = [];
      m.myDropsError = 'No collections found for this account (or the indexer is unreachable).';
      return;
    }
    const all: ManageableDrop[] = [];
    for (const col of collections) {
      setStatus(`Scanning drops in ${col.collection_name}… (${all.length} found so far)`, 'info');
      try {
        const { drops } = await listDrops({ collection: col.collection_name, includeInactive: true });
        for (const d of drops) {
          all.push({ drop_id: d.drop_id, collection_name: col.collection_name, name: d.name || '(unnamed)', status: d.status });
        }
      } catch {
        /* skip a collection that fails to scan */
      }
    }
    all.sort((a, b) =>
      a.collection_name === b.collection_name
        ? Number(b.drop_id) - Number(a.drop_id)
        : a.collection_name.localeCompare(b.collection_name),
    );
    m.myDrops = all;
    setStatus(`Found ${all.length} drop(s) across ${collections.length} collection(s) you manage.`, 'ok');
  } catch (err) {
    m.myDropsError = `Could not list your drops: ${(err as Error).message}`;
  } finally {
    m.myDropsLoading = false;
    render();
  }
}

function onPickMyDrop(dropId: string) {
  if (!dropId) return;
  state.manageDrop.dropIdInput = dropId;
  void loadDropToManage(dropId);
}

function manageDropActor(): string | undefined {
  const s = getCurrentSession();
  return s ? String(s.actor) : undefined;
}

/**
 * Confirms, signs, then refreshes either the whole drop or just its
 * whitelist members (so a membership edit doesn't reset other state).
 */
async function runDropAdminAction(
  action: import('../nefty/execute').BuiltAction,
  confirmMsg: string,
  opts: { refresh?: 'drop' | 'whitelist' } = {},
) {
  const session = getCurrentSession();
  const m = state.manageDrop;
  if (!session || !m.loaded) return;
  if (!confirm(confirmMsg)) return;
  m.busy = true;
  render();
  try {
    setStatus(`Awaiting signature: ${action.account}::${action.name}…`, 'info');
    const result = await executeAdminAction(session, action);
    const trxId =
      (result.response as { transaction_id?: string } | undefined)?.transaction_id ??
      String(result.resolved?.transaction.id ?? '');
    setStatus(`${action.name} confirmed${trxId ? ` · tx ${trxId.slice(0, 8)}…` : ''}`, 'ok', trxId);
    // Give the RPC node a moment to index the new block before we re-read,
    // otherwise the refresh can return the pre-action (stale) state and the
    // panel would show outdated info right after a successful change.
    await new Promise((r) => setTimeout(r, 1200));
    if ((opts.refresh ?? 'drop') === 'whitelist') {
      m.whitelist = await readDropWhitelist(m.loaded.drop_id).catch(() => []);
    } else {
      const fresh = await readDropById(m.loaded.drop_id).catch(() => undefined);
      if (fresh) m.loaded = fresh;
    }
  } catch (err) {
    setStatus(`${action.name} failed: ${(err as Error).message}`, 'err');
  } finally {
    m.busy = false;
    // Pin the author back to the CLAIM tab on the drop they were managing.
    // A wallet round-trip can flip the active view from under us (e.g. the
    // signing flow fires a hashchange), which otherwise bounced the author
    // onto the default BLEND tab the moment the action returned. We know the
    // intended context here, so restore it explicitly (state + URL).
    state.platform = 'nefty';
    state.view = 'drops';
    // Drop any deep link a stray hashchange may have queued during signing,
    // so applyPendingDeepLink can't re-flip us onto another entity afterwards.
    state.pendingDeepLink = undefined;
    if (m.loaded) writeHashRoute('nefty', 'drops', m.loaded.drop_id);
    render();
  }
}

function onManageDropAddAccounts() {
  const actor = manageDropActor();
  const m = state.manageDrop;
  if (!actor || !m.loaded) return;
  const accounts = parseAccountList(m.addAccountsInput);
  if (accounts.length === 0) { setStatus('Enter at least one account.', 'err'); return; }
  m.addAccountsInput = '';
  void runDropAdminAction(
    buildDropAddToWhitelist(actor, m.loaded.drop_id, accounts),
    `Add ${accounts.length} account(s) to drop #${m.loaded.drop_id}'s whitelist?\n\n${accounts.join(', ')}`,
    { refresh: 'whitelist' },
  );
}

function onManageDropRemoveAccount(account: string) {
  const actor = manageDropActor();
  const m = state.manageDrop;
  if (!actor || !m.loaded) return;
  void runDropAdminAction(
    buildDropEraseFromWhitelist(actor, m.loaded.drop_id, [account]),
    `Remove ${account} from drop #${m.loaded.drop_id}'s whitelist?`,
    { refresh: 'whitelist' },
  );
}

function onManageDropClearWhitelist() {
  const actor = manageDropActor();
  const m = state.manageDrop;
  if (!actor || !m.loaded || !m.whitelist || m.whitelist.length === 0) return;
  void runDropAdminAction(
    buildDropEraseFromWhitelist(actor, m.loaded.drop_id, m.whitelist.slice()),
    `Clear ALL ${m.whitelist.length} account(s) from drop #${m.loaded.drop_id}'s whitelist?`,
    { refresh: 'whitelist' },
  );
}

function onManageDropToggleAuth() {
  const actor = manageDropActor();
  const m = state.manageDrop;
  if (!actor || !m.loaded) return;
  const next = !m.loaded.auth_required;
  void runDropAdminAction(
    buildSetDropAuth(actor, m.loaded.drop_id, next),
    next
      ? `Require a whitelist for drop #${m.loaded.drop_id}? Only whitelisted accounts will be able to claim.`
      : `Remove the whitelist requirement from drop #${m.loaded.drop_id}? Anyone will be able to claim.`,
  );
}

function onManageDropToggleHidden() {
  const actor = manageDropActor();
  const m = state.manageDrop;
  if (!actor || !m.loaded) return;
  const next = !m.loaded.is_hidden;
  void runDropAdminAction(
    buildSetDropHidden(actor, m.loaded.drop_id, next),
    `${next ? 'Hide' : 'Unhide'} drop #${m.loaded.drop_id}?`,
  );
}

function onManageDropDelete() {
  const actor = manageDropActor();
  const m = state.manageDrop;
  if (!actor || !m.loaded) return;
  void runDropAdminAction(
    buildEraseDrop(actor, m.loaded.drop_id),
    `DELETE drop #${m.loaded.drop_id}? This is permanent and cannot be undone.`,
  );
}

/**
 * Runs a single admin action: confirm (always, since these are
 * powerful), sign, then reload the blend so the UI reflects the new
 * on-chain state.
 */
/**
 * Runs a single admin action: confirm, sign, then refresh. By default
 * the whole blend is reloaded (so name/status/security reflect the
 * change). For whitelist MEMBER edits, pass `refresh: 'members'` so we
 * only re-read the selected whitelist instead of reloading the blend,
 * which would otherwise reset the author's selected (possibly
 * unattached) whitelist back to the blend's attached one.
 */
async function runAdminAction(
  action: import('../nefty/execute').BuiltAction,
  confirmMsg: string,
  opts: { refresh?: 'blend' | 'members' } = {},
) {
  const session = getCurrentSession();
  if (!session) return;
  if (!confirm(confirmMsg)) return;
  state.manage.busy = true;
  render();
  try {
    setStatus(`Awaiting signature: ${action.account}::${action.name}…`, 'info');
    const result = await executeAdminAction(session, action);
    const trxId =
      (result.response as { transaction_id?: string } | undefined)?.transaction_id ??
      String(result.resolved?.transaction.id ?? '');
    setStatus(`${action.name} broadcast: ${trxId}`, 'ok', trxId);
    if ((opts.refresh ?? 'blend') === 'members') {
      // Whitelist membership changed but the blend didn't: just re-read
      // the selected whitelist's members, keep everything else.
      await loadSelectedWhitelistMembers();
    } else if (state.blend) {
      state.blendId = String(state.blend.blend_id);
      await onLoadBlend();
    }
  } catch (err) {
    setStatus(`${action.name} failed: ${(err as Error).message}`, 'err');
  } finally {
    state.manage.busy = false;
    render();
  }
}

function onManageHide(hide: boolean) {
  const actor = manageActor();
  if (!actor || !state.blend) return;
  void runAdminAction(
    buildSetBlendHide(actor, state.blend.blend_id, hide),
    `${hide ? 'Hide' : 'Unhide'} blend #${state.blend.blend_id}?`,
  );
}

function onManageEndNow() {
  const actor = manageActor();
  if (!actor || !state.blend) return;
  const now = Math.floor(Date.now() / 1000);
  // Keep the original start_time, set end_time to now so the blend
  // immediately reads as "ended" without deleting it.
  const start = Number(state.blend.start_time ?? 0);
  void runAdminAction(
    buildSetBlendTime(actor, state.blend.blend_id, start, now),
    `End blend #${state.blend.blend_id} now? It stays on-chain but can no longer be executed.`,
  );
}

function onManageDelete() {
  const actor = manageActor();
  if (!actor || !state.blend) return;
  void runAdminAction(
    buildDelBlend(actor, state.blend.blend_id),
    `DELETE blend #${state.blend.blend_id}? This is permanent and cannot be undone.`,
  );
}

function onManageSetMax() {
  const actor = manageActor();
  if (!actor || !state.blend) return;
  const v = Number(state.manage.newMaxInput);
  if (!Number.isFinite(v) || v < 0) { setStatus('Enter a valid max uses (0 = unlimited).', 'err'); return; }
  void runAdminAction(
    buildSetBlendMax(actor, state.blend.blend_id, v),
    `Set max uses of blend #${state.blend.blend_id} to ${v} (0 = unlimited)?`,
  );
}

function onManageSetLimits() {
  const actor = manageActor();
  if (!actor || !state.blend) return;
  const lim = Number(state.manage.newLimitInput);
  const cd = Number(state.manage.newCooldownInput || '0');
  if (!Number.isFinite(lim) || lim < 0) { setStatus('Enter a valid per-account limit (0 = none).', 'err'); return; }
  void runAdminAction(
    buildSetBlendLim(actor, state.blend.blend_id, lim, cd),
    `Set per-account limit to ${lim} (cooldown ${cd}s) on blend #${state.blend.blend_id}?`,
  );
}

function onManageSetName() {
  const actor = manageActor();
  if (!actor || !state.blend) return;
  const newName = state.manage.newNameInput.trim();
  if (!newName) { setStatus('Enter a name.', 'err'); return; }
  // Preserve the rest of display_data (image, description) and just
  // swap the name.
  let dd: Record<string, unknown> = {};
  try { dd = JSON.parse(state.blend.display_data || '{}'); } catch { dd = {}; }
  dd.name = newName;
  void runAdminAction(
    buildSetBlendData(actor, state.blend.blend_id, JSON.stringify(dd)),
    `Rename blend #${state.blend.blend_id} to "${newName}"?`,
  );
}

function onManageAttachSecurity() {
  const actor = manageActor();
  if (!actor || !state.blend) return;
  // Attach the currently-selected whitelist to this blend. Selecting
  // "none" in the dropdown (selectedSecurityId undefined) detaches it.
  const sid = state.manage.selectedSecurityId ?? '0';
  void runAdminAction(
    buildSetBlendSec(actor, state.blend.blend_id, sid),
    sid === '0'
      ? `Remove the whitelist gate from blend #${state.blend.blend_id}?`
      : `Attach whitelist #${sid} to blend #${state.blend.blend_id}?`,
  );
}

function onManageAddAccounts() {
  const actor = manageActor();
  if (!actor || !state.blend) return;
  const sid = state.manage.selectedSecurityId;
  if (!sid || sid === '0') { setStatus('Select or create a whitelist first.', 'err'); return; }
  const accounts = parseAccountList(state.manage.addAccountsInput);
  if (accounts.length === 0) { setStatus('Enter at least one account.', 'err'); return; }
  state.manage.addAccountsInput = '';
  void runAdminAction(
    buildAddToWhitelist(actor, state.blend.collection_name, sid, accounts),
    `Add ${accounts.length} account(s) to whitelist #${sid}?\n\n${accounts.join(', ')}`,
    { refresh: 'members' },
  );
}

function onManageRemoveAccount(account: string) {
  const actor = manageActor();
  if (!actor || !state.blend) return;
  const sid = state.manage.selectedSecurityId;
  if (!sid || sid === '0') return;
  void runAdminAction(
    buildEraseFromWhitelist(actor, state.blend.collection_name, sid, [account]),
    `Remove ${account} from whitelist #${sid}?`,
    { refresh: 'members' },
  );
}

function onManageClearWhitelist() {
  const actor = manageActor();
  if (!actor || !state.blend) return;
  const sid = state.manage.selectedSecurityId;
  if (!sid || sid === '0') return;
  void runAdminAction(
    buildClearWhitelist(actor, state.blend.collection_name, sid),
    `Clear ALL accounts from whitelist #${sid}? This cannot be undone.`,
    { refresh: 'members' },
  );
}

function onManageCreateWhitelist() {
  const actor = manageActor();
  if (!actor || !state.blend) return;
  const name = state.manage.newWhitelistName.trim();
  if (!name) { setStatus('Name the whitelist first (a label like "OG holders"), then add wallets to it below.', 'err'); return; }
  // After creation, refreshManageContext auto-selects the newest
  // whitelist so the author can immediately add wallets to it.
  state.manage.autoSelectNewest = true;
  state.manage.newWhitelistName = '';
  void runAdminAction(
    buildAddWhitelist(actor, state.blend.collection_name, name, ''),
    `Create a new whitelist "${name}" on ${state.blend.collection_name}?\n\nThis just makes an empty list. You'll then add wallets to it and (optionally) attach it to a blend.`,
  );
}

/** Splits a textarea of accounts (comma / whitespace / newline separated). */
function parseAccountList(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
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
  u.costSelection.clear();
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
  u.costSelection.clear();
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

/** NFT-cost ingredients (burn these as cost) that need an asset picker. */
function isCostNftIngredient(ing: UpgradeIngredient): boolean {
  return ing.kind === 'template' || ing.kind === 'schema' || ing.kind === 'collection';
}
function costIngredientAmount(ing: UpgradeIngredient): number {
  return (ing as { amount?: number }).amount ?? 1;
}

/** Owned assets that satisfy an NFT-cost ingredient (to be burned). */
function ownedAssetsForCostIngredient(ing: UpgradeIngredient): AtomicAsset[] {
  const owned = state.discoveryOwnedAssets;
  if (ing.kind === 'template') {
    return owned.filter(
      (a) => a.collection?.collection_name === ing.collection_name && String(a.template?.template_id) === String(ing.template_id),
    );
  }
  if (ing.kind === 'schema') {
    return owned.filter(
      (a) => a.collection?.collection_name === ing.collection_name && a.schema?.schema_name === ing.schema_name,
    );
  }
  if (ing.kind === 'collection') {
    return owned.filter((a) => a.collection?.collection_name === ing.collection_name);
  }
  return [];
}

/** True if an asset is already committed to a spec slot or another cost slot. */
function upgradeAssetUsedElsewhere(asset_id: string, exceptCostIdx: number): boolean {
  const u = state.upgrades;
  for (const id of u.selection.values()) if (id === asset_id) return true;
  for (const [idx, ids] of u.costSelection.entries()) {
    if (idx !== exceptCostIdx && ids.includes(asset_id)) return true;
  }
  return false;
}

function onPickUpgradeCostAsset(ingIdx: number, asset_id: string) {
  const u = state.upgrades;
  const ing = u.picked?.ingredients[ingIdx];
  if (!ing || !isCostNftIngredient(ing)) return;
  const amount = costIngredientAmount(ing);
  const current = u.costSelection.get(ingIdx) ?? [];
  if (current.includes(asset_id)) {
    u.costSelection.set(ingIdx, current.filter((id) => id !== asset_id));
  } else {
    if (upgradeAssetUsedElsewhere(asset_id, ingIdx)) {
      setStatus(`Asset ${asset_id} is already picked for another slot.`, 'warn');
      return;
    }
    // At capacity (commonly amount=1): drop the oldest pick to make room.
    u.costSelection.set(ingIdx, current.length >= amount ? [...current.slice(1), asset_id] : [...current, asset_id]);
  }
  render();
}

/** Flattened list of every NFT picked to burn as cost (the transferred_assets). */
function collectUpgradeCostAssets(): string[] {
  const out: string[] = [];
  for (const ids of state.upgrades.costSelection.values()) out.push(...ids);
  return out;
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
  // Every cost ingredient must be covered.
  for (let i = 0; i < u.picked.ingredients.length; i++) {
    const ing = u.picked.ingredients[i];
    if (ing.kind === 'ft') {
      const st = u.ftStatus.get(i);
      if (!st || st.balance < 0 || st.balance < st.required) return false;
    } else if (isCostNftIngredient(ing)) {
      if ((u.costSelection.get(i) ?? []).length < costIngredientAmount(ing)) return false;
    } else {
      // balance / attribute / unknown cost types aren't pickable yet.
      return false;
    }
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
    transferred_assets: collectUpgradeCostAssets(),
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
      transferred_assets: collectUpgradeCostAssets(),
      own_assets: [],
      ft_payments,
    });
    const trxId =
      (result.response as { transaction_id?: string } | undefined)?.transaction_id ??
      String(result.resolved?.transaction.id ?? '');
    u.lastTrxId = trxId;
    setStatus(`Upgrade broadcast: ${trxId}`, 'ok', trxId);
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
    case 'blenderizer-blends':
      return `recipe #${r.id} (Blenderizer)`;
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
    label = `[#${state.blend.blend_id}] ${blendDisplayName(state.blend)}`;
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
      // Prefer a meaningful name: the blend's own, else its result template's.
      let rowName = b.name;
      if (rowName.startsWith('Blend #')) {
        if (b.result_template_name) rowName = b.result_template_name;
        else if (b.result_template_id != null) rowName = displayTemplateName(b.result_template_id, b.collection_name);
      }
      return `
        <div class="${classes.join(' ')}" ${disabled ? '' : `data-action="pickRow" data-blend="${escapeHtml(b.blend_id)}"`}>
          <span class="picker-id">#${escapeHtml(b.blend_id)}</span>
          <span class="picker-name">${escapeHtml(rowName)}</span>
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

  // Artwork sits beside the facts, not above them: the numbers are what
  // you check before signing. It collapses away entirely when the
  // template has no image or every gateway fails.
  //
  // Two references, in order: the result template's own art, then the
  // blend row's display_data. Authors fill one or the other - 11 of
  // underpunks55's 102 blends have art only on the blend row.
  const art = renderMediaThumb({
    ref: [t?.image, parsePoolDisplayData(b.display_data).image],
    alt: t?.name ? `${t.name} artwork` : 'result artwork',
  });

  return `
    <div class="mint-with-art">
      ${art}
      <div class="mint-with-art-body">
        <ul class="mint-info">${rowsForPrimary}</ul>
        ${extras}
      </div>
    </div>
  `;
}

/**
 * Reward panel for a blend whose output comes out of a pool.
 *
 * Pool results carry no template_id, only a `pool_name` and the author's
 * `display_data` blob, so the name/image come from there and the hard
 * numbers (stock left, template) from the `pools` row we fetched.
 *
 * The point of this panel is to make the guarantee explicit: when the
 * pool hands out a single template, the user knows exactly which NFT
 * they get, only the serial is drawn.
 */
function renderPoolReward(b: BlendRow): string {
  const draws = poolDraws(b);
  if (draws.length === 0) return '';

  const blocks = draws.map((d) => {
    const meta = parsePoolDisplayData(d.display_data);
    const pool = state.pools.get(d.pool_name);
    const t = state.template;

    const stock = pool
      ? `${pool.remaining} left <span class="term">(of ${pool.added} ever added${pool.reserved > 0 ? `, ${pool.reserved} reserved` : ''})</span>`
      : state.poolsLoading
        ? '<span class="shimmer skeleton-inline">reading pool…</span>'
        : '<span class="term">stock unknown (pool row unreadable)</span>';

    // One template in the pool = the reward NFT is fully known up front.
    const single = pool && pool.templates.length === 1 ? pool.templates[0] : undefined;
    const templateLine = single
      ? `<li><strong>Template:</strong> <code>${escapeHtml(String(single))}</code>${
          t && String(t.template_id) === String(single) && t.name
            ? ` <span class="term">${escapeHtml(t.name)}</span>`
            : ''
        }</li>`
      : pool && pool.templates.length > 1
        ? `<li><strong>Templates:</strong> ${pool.templates.map((x) => `<code>${escapeHtml(String(x))}</code>`).join(', ')} <span class="term">(the draw decides which)</span></li>`
        : '';

    const guarantee = single
      ? `<p class="status-line ok">Guaranteed outcome: every asset in this pool is template <code>${escapeHtml(String(single))}</code>, so the reward NFT is certain - only its serial number is drawn.</p>`
      : pool && pool.templates.length > 1
        ? `<p class="status-line warn">This pool holds ${pool.templates.length} different templates: which one you get is decided by the contract at fuse time.</p>`
        : '';

    const empty = pool && pool.remaining === 0
      ? `<p class="status-line err">This pool is empty: the blend cannot pay out until the collection author refills it.</p>`
      : '';

    // A pool result carries its own image in display_data, and the
    // pool's template usually has one too. Prefer the template's (it is
    // what actually lands in the wallet) and fall back to the blob's.
    const art = renderMediaThumb({
      ref: (single && t && String(t.template_id) === String(single) ? t.image : undefined) ?? meta.image,
      alt: meta.name ? `${meta.name} artwork` : 'pool reward artwork',
    });

    return `
      <div class="mint-with-art">
        ${art}
        <div class="mint-with-art-body">
          <ul class="mint-info">
            <li><strong>Name:</strong> ${escapeHtml(meta.name ?? '(no display name on the pool result)')}</li>
            <li><strong>Source:</strong> pool <code>${escapeHtml(d.pool_name)}</code>${pool ? ` <span class="term">(pool_id ${escapeHtml(pool.pool_id)})</span>` : ''} <span class="term">· roll #${d.roll_index}</span></li>
            ${templateLine}
            <li><strong>Pool stock:</strong> ${stock}</li>
          </ul>
        </div>
      </div>
      ${guarantee}
      ${empty}`;
  });

  return `
    <p class="status-line">The reward is <strong>not minted on demand</strong>: it was pre-minted and deposited into a pool on <code>blend.nefty</code>. The contract hands you one of the escrowed assets, which is why this runs as a two-step fuse → claim.</p>
    ${blocks.join('')}`;
}

function renderBlendInfo(): string {
  if (state.blendLoading) {
    return renderSkeleton('3 · Loading blend recipe…');
  }
  const b = state.blend;
  if (!b) return '';
  const det = isDeterministic(b);
  const draws = poolDraws(b);
  // A pool blend with single-outcome, full-odds rolls is NOT a lottery: the
  // reward is certain, only the escrowed serial is drawn. Label it honestly
  // instead of lumping it in with multi-outcome random blends.
  const certainPool = draws.length > 0 && oddsAreCertain(b);
  const wl = state.whitelist;
  // security_id != 0 means the blend IS gated; `wl` only gets filled once a
  // wallet is connected (that's what we check eligibility against).
  const gatedButUnchecked = !wl && blendIsSecure(b);
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
          : certainPool
            ? '<span class="tag ok">guaranteed · drawn from a pool</span>'
            : '<span class="tag warn">random · oracle picks one outcome per roll</span>'}
        ${
          wl?.required
            ? wl.allowed
              ? '<span class="tag ok">whitelist · allowed</span>'
              : '<span class="tag err">whitelist · denied</span>'
            : gatedButUnchecked
              // The eligibility read only runs with a wallet connected, so
              // without one we know the blend is gated but not whether the
              // user passes. Saying "open" there would be a lie.
              ? '<span class="tag warn">whitelist · connect a wallet to check</span>'
              : '<span class="tag">open · no whitelist</span>'
        }
        <span class="tag">uses ${escapeHtml(remainingUses)}</span>
      </div>
      ${det.ok
        ? `<h3>Expected mint</h3>${renderExpectedMint()}`
        : certainPool
          ? `<h3>Expected reward</h3>${renderPoolReward(b)}`
          : `${renderRngOdds(b)}${draws.length > 0 ? `<h3>Pool draws</h3>${renderPoolReward(b)}` : ''}`}
      ${wl?.required && !wl.allowed ? `<p class="status-line err">${escapeHtml(wl.reason ?? '')}</p>` : ''}
      ${renderBlendManage(b)}
    </div>
  `;
}

/**
 * Inline collection-author admin panel. Renders nothing unless the
 * connected wallet is detected as an authorized manager of the blend's
 * collection. Powered-off by default behind an "enable management
 * controls" opt-in so destructive buttons are never one tap away.
 */
function renderBlendManage(b: BlendRow): string {
  const m = state.manage;
  const can = m.authByCollection.get(b.collection_name);
  if (can !== true) return ''; // undefined (checking) or false → hide entirely

  const sid = b.security_id !== undefined ? String(b.security_id) : '0';
  const disabled = m.busy ? 'disabled' : '';

  if (!m.enabled) {
    return `
      <div class="manage-section">
        <div class="manage-head">
          <span class="manage-title">⚙ MANAGE · you're an authorized account for ${escapeHtml(b.collection_name)}</span>
          <label class="inline-toggle">
            <input id="manageEnable" type="checkbox" data-action="toggleManageEnable" />
            <span>enable management controls</span>
          </label>
        </div>
      </div>`;
  }

  // ── whitelist / security management ──
  // The member editor operates on the SELECTED whitelist, which may or
  // may not be the one attached to this blend. The dropdown lets the
  // author pick which whitelist to manage (or one they just created).
  const attachedSid = sid; // the blend's currently-attached security_id
  const selectedSid = m.selectedSecurityId ?? '';
  const selectOptions = [
    `<option value=""${selectedSid === '' ? ' selected' : ''}>none selected…</option>`,
    ...m.securities.map((s: SecurityRow) => {
      const isAttached = s.id === attachedSid;
      const label = `#${s.id}${s.name ? ' · ' + s.name : ''}${isAttached ? '  ← attached to this blend' : ''}`;
      return `<option value="${escapeHtml(s.id)}"${selectedSid === s.id ? ' selected' : ''}>${escapeHtml(label)}</option>`;
    }),
  ].join('');

  const selectedIsAttached = selectedSid !== '' && selectedSid === attachedSid;
  const attachBtn = selectedSid === ''
    ? (attachedSid !== '0'
        ? `<button data-action="manageAttachSecurity" ${disabled}>Detach current whitelist</button>`
        : '')
    : selectedIsAttached
      ? `<span class="term">already attached to this blend</span>`
      : `<button data-action="manageAttachSecurity" ${disabled}>Attach #${escapeHtml(selectedSid)} to this blend</button>`;

  // Member editor for the selected whitelist.
  const memberEditor = selectedSid !== ''
    ? `
        <div class="manage-members-wrap">
          <div class="term" style="margin-bottom:4px">members of whitelist #${escapeHtml(selectedSid)}:</div>
          ${m.whitelistMembers
            ? `<div class="manage-members">${
                m.whitelistMembers.length === 0
                  ? '<span class="term">empty, add wallets below</span>'
                  : m.whitelistMembers.slice(0, 300).map((acc) =>
                      `<span class="manage-chip">${escapeHtml(acc)} <button data-action="manageRemoveAccount" data-account="${escapeHtml(acc)}" title="remove" ${disabled}>×</button></span>`,
                    ).join('')
              }${m.whitelistMembers.length > 300 ? `<span class="term">+ ${m.whitelistMembers.length - 300} more…</span>` : ''}</div>`
            : '<span class="term">loading members…</span>'}
          <div class="row" style="gap:8px; margin-top:8px; align-items:flex-start">
            <textarea id="manageAddAccounts" placeholder="wallets to add, e.g. zigm4.gm (comma / space / newline separated)" rows="2" style="flex:1; min-width:220px">${escapeHtml(m.addAccountsInput)}</textarea>
            <button data-action="manageAddAccounts" ${disabled}>Add wallets</button>
            <button class="danger-btn" data-action="manageClearWhitelist" ${disabled}>Clear all</button>
          </div>
        </div>`
    : '<p class="term">Pick a whitelist above to see and edit its wallets, or create a new one below.</p>';

  return `
    <div class="manage-section">
      <div class="manage-head">
        <span class="manage-title">⚙ MANAGE · authorized for ${escapeHtml(b.collection_name)}</span>
        <label class="inline-toggle">
          <input id="manageEnable" type="checkbox" data-action="toggleManageEnable" checked />
          <span>controls enabled</span>
        </label>
      </div>
      ${m.busy ? '<p class="status-line">Broadcasting admin action…</p>' : ''}

      <div class="manage-row">
        <span class="manage-label">status</span>
        <div class="manage-ctl row" style="gap:8px">
          ${b.is_hidden
            ? `<button data-action="manageUnhide" ${disabled}>Unhide</button>`
            : `<button data-action="manageHide" ${disabled}>Hide</button>`}
          <button data-action="manageEndNow" ${disabled}>End now</button>
        </div>
      </div>

      <div class="manage-row">
        <span class="manage-label">rename</span>
        <div class="manage-ctl row" style="gap:8px">
          <input id="manageName" type="text" placeholder="new display name" value="${escapeHtml(m.newNameInput)}" style="flex:1; min-width:200px" />
          <button data-action="manageSetName" ${disabled}>Apply</button>
        </div>
      </div>

      <div class="manage-row">
        <span class="manage-label">max uses</span>
        <div class="manage-ctl row" style="gap:8px">
          <input id="manageMax" type="number" min="0" placeholder="0 = unlimited" value="${escapeHtml(m.newMaxInput)}" style="width:140px" />
          <button data-action="manageSetMax" ${disabled}>Apply</button>
        </div>
      </div>

      <div class="manage-row">
        <span class="manage-label">per-account limit</span>
        <div class="manage-ctl row" style="gap:8px">
          <input id="manageLimit" type="number" min="0" placeholder="0 = none" value="${escapeHtml(m.newLimitInput)}" style="width:120px" />
          <input id="manageCooldown" type="number" min="0" placeholder="cooldown (s)" value="${escapeHtml(m.newCooldownInput)}" style="width:140px" />
          <button data-action="manageSetLimits" ${disabled}>Apply</button>
        </div>
      </div>

      <div class="manage-row">
        <span class="manage-label">whitelist</span>
        <div class="manage-ctl">
          <div class="row" style="gap:8px; align-items:center; flex-wrap:wrap">
            <select id="manageWlSelect" class="manage-sec-select">${selectOptions}</select>
            ${attachBtn}
          </div>
          ${memberEditor}
          <div class="manage-create">
            <div class="term" style="margin-bottom:4px">create a new whitelist (this only names an empty list, you add wallets to it after):</div>
            <div class="row" style="gap:8px">
              <input id="manageNewWl" type="text" placeholder="whitelist name, e.g. &quot;OG holders&quot; (a label, NOT a wallet)" value="${escapeHtml(m.newWhitelistName)}" style="flex:1; min-width:220px" />
              <button data-action="manageCreateWhitelist" ${disabled}>Create whitelist</button>
            </div>
          </div>
          <p class="term" style="margin-top:6px">A whitelist (security_id) can be shared by several blends; editing its wallets affects all of them. "Attach" gates THIS blend behind the selected whitelist.</p>
        </div>
      </div>

      <div class="manage-row danger">
        <span class="manage-label">danger</span>
        <div class="manage-ctl">
          <button class="danger-btn" data-action="manageDelete" ${disabled}>Delete blend permanently</button>
        </div>
      </div>
    </div>`;
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
          const tid = (r[1] as { template_id?: number }).template_id;
          const nm = displayTemplateName(tid, b.collection_name);
          return nm.startsWith('template #')
            ? `<code>template ${escapeHtml(String(tid))}</code>`
            : `${escapeHtml(nm)} <code>#${escapeHtml(String(tid))}</code>`;
        }
        if (kind === 'POOL_NFT_RESULT') {
          const p = r[1] as { pool_name?: string; display_data?: string };
          const nm = parsePoolDisplayData(p.display_data).name;
          const stock = p.pool_name ? state.pools.get(p.pool_name) : undefined;
          return `${nm ? `${escapeHtml(nm)} ` : ''}<span class="term">from pool <code>${escapeHtml(p.pool_name ?? '?')}</code>${stock ? ` · ${stock.remaining} left` : ''}</span>`;
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
  // A random blend has no single "expected mint", so it never went
  // through renderExpectedMint and used to show no artwork at all -
  // which is why e.g. blend 22807 looked image-less on its own page
  // while the catalogue (which just takes the first result template)
  // showed one. Use the blend's own display_data, falling back to the
  // most likely outcome's template.
  const best = rolls[0]?.outcomes?.slice().sort((a, b2) => b2.odds - a.odds)[0];
  const bestTid = (best?.results ?? []).find((r) => r[0] === 'ON_DEMAND_NFT_RESULT')?.[1] as
    | { template_id?: number }
    | undefined;
  const art = renderMediaThumb({
    ref: [
      parsePoolDisplayData(b.display_data).image,
      bestTid?.template_id ? state.templateImages.get(Number(bestTid.template_id)) : undefined,
    ],
    alt: 'blend artwork',
  });

  return `<h3>Possible mints</h3>
    <div class="mint-with-art">
      ${art}
      <div class="mint-with-art-body">
        <p class="status-line" style="margin-bottom:6px">This blend has multiple outcomes per roll. The on-chain contract will randomly pick one outcome per roll when you submit. Probabilities below are the in-roll odds.</p>
      </div>
    </div>
    ${blocks.join('')}`;
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

/**
 * Resolves a template_id to a human name from the shared cache, firing a
 * best-effort fetch (and a re-render) on a miss. Works from a raw id +
 * collection, so it covers cases where we don't have a full asset object:
 * blend ingredient headers, RNG outcome odds, the picker label, etc.
 * Returns "template #<id>" until the name lands.
 */
/**
 * Artwork reference for a template, from the same lazy cache that backs
 * displayTemplateName(). Returns undefined until the lookup lands; the
 * render that follows picks it up.
 */
function displayTemplateImage(
  template_id: number | string | undefined,
  collection: string | undefined,
): string | undefined {
  if (template_id == null || template_id === '') return undefined;
  const n = Number(template_id);
  if (!Number.isFinite(n)) return undefined;
  const cached = state.templateImages.get(n);
  if (cached) return cached;
  if (collection) void enrichTemplateName(n, collection);
  return undefined;
}

function displayTemplateName(template_id: number | string | undefined, collection: string | undefined): string {
  if (template_id == null || template_id === '') return 'template';
  const n = Number(template_id);
  const cached = state.templateNames.get(n);
  if (cached) return cached;
  if (collection) void enrichTemplateName(n, collection);
  return `template #${n}`;
}

async function enrichTemplateName(n: number, collection: string): Promise<void> {
  if (!Number.isFinite(n) || state.templateNames.has(n) || _templateFetchInflight.has(n)) return;
  _templateFetchInflight.add(n);
  try {
    // loadTemplate (rather than fetchTemplateName) so the same call also
    // yields the artwork reference, which several views need.
    const info = await loadTemplate({ collection_name: collection, template_id: n });
    if (info?.name) state.templateNames.set(n, info.name);
    if (info?.image) state.templateImages.set(n, info.image);
    if (info?.name || info?.image) render();
  } catch {
    // ignore: callers keep the "template #<id>" fallback
  } finally {
    _templateFetchInflight.delete(n);
  }
}

/** First ON_DEMAND mint template a blend produces (its "result"), if any. */
function primaryResultTemplateId(b: BlendRow): number | undefined {
  for (const roll of b.rolls ?? []) {
    for (const o of roll.outcomes ?? []) {
      for (const r of o.results ?? []) {
        if (r[0] === 'ON_DEMAND_NFT_RESULT') {
          const tid = (r[1] as { template_id?: number }).template_id;
          if (tid != null) return Number(tid);
        }
      }
    }
  }
  return undefined;
}

/** Best label for a loaded blend: its display name, else its result
 *  template's name, else the collection as a last resort. */
function blendDisplayName(b: BlendRow): string {
  let ddName = '';
  try { ddName = (JSON.parse(b.display_data || '{}') as { name?: string }).name ?? ''; } catch { /* ignore */ }
  if (ddName) return ddName;
  const tid = primaryResultTemplateId(b);
  if (tid != null) {
    const nm = displayTemplateName(tid, b.collection_name);
    if (!nm.startsWith('template #')) return nm;
  }
  return b.collection_name;
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
  // For a TEMPLATE slot, surface the template's NAME in the header too, so
  // the author knows which NFT is required even with none in the wallet.
  const slotName =
    slot.kind === 'TEMPLATE' && slot.template_id != null
      ? displayTemplateName(slot.template_id, slot.collection_name)
      : '';
  const slotHeading = slotName && !slotName.startsWith('template #')
    ? `${escapeHtml(slotName)} <span class="term">· ${escapeHtml(slot.label)}</span>`
    : escapeHtml(slot.label);
  return `
    <div class="slot">
      <div class="slot-header">
        <div class="slot-label">${slotHeading}</div>
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

  // Pool blends run the exact same two-step flow, but the reason is
  // different (the asset is drawn from escrow, not rolled), so the
  // explanation has to match or it reads as a lottery warning.
  const isPoolDraw = state.blend ? poolDraws(state.blend).length > 0 : false;
  const twoStepWhy = isPoolDraw
    ? 'The reward is drawn from a pre-filled pool, so the contract decides which escrowed NFT you get at fuse time. Crucible signs a first transaction (announce + fuse), waits for the contract to stage the drawn asset, then claims it - usually the claim happens automatically.'
    : 'This blend has at least one roll with multiple possible outcomes. Crucible signs a first transaction (announce + fuse), waits for the contract to stage the result, then prompts you for a second signature (claim) that actually mints the cards.';

  let body = '';
  if (phase === 'idle') {
    body = `
      <p class="status-line">${escapeHtml(twoStepWhy)}</p>
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
      // The pool draw resolves to a concrete, already-existing asset_id.
      tidStr = `pool asset ${String((payload as { asset_id?: string }).asset_id ?? '')}`;
    } else if (variant === 'FT_CLAIM') {
      tidStr = String((payload as { amount?: { quantity?: string } }).amount?.quantity ?? '');
    } else if (variant === 'EMPTY_CLAIM') {
      tidStr = 'empty (no mint)';
    }
    const rolls = state.blend?.rolls ?? [];
    const roll = rolls[idx];
    let pctLabel = '?';
    if (roll && variant === 'POOL_NFT_CLAIM') {
      // A single full-odds outcome means the pool draw was never a gamble
      // on WHAT you get, only on which serial: report it as certain.
      const total = roll.total_odds || roll.outcomes.reduce((a, o) => a + o.odds, 0);
      if (roll.outcomes.length === 1 && total > 0 && roll.outcomes[0].odds === total) {
        pctLabel = '100.00%';
      }
    } else if (roll && variant === 'ON_DEMAND_NFT_CLAIM') {
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
  // Success outcomes are shown by the top banner only, so we don't echo a
  // second "... confirmed" / idle "Ready" line under the Connect-wallet card.
  // Progress ('info'), hints ('warn') and errors ('err') still render inline.
  if (!state.status || state.statusKind === 'ok') return '';
  return `<p class="status-line ${state.statusKind}">${escapeHtml(state.status)}</p>`;
}

/**
 * Renders the top-level platform pills + the tab bar of the active
 * platform. Three platforms exist (Nefty / WaxDAO / Blenderizer) and each exposes
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
    : state.platform === 'waxdao'
      ? `
        ${tab('waxdao-blends', 'Blend', 'waxdaomarket: burn NFTs → mint result')}`
      : `
        ${tab('blenderizer-blends', 'Blend', 'blenderizerx: burn NFTs → mint result')}`;
  // The pills split the app by contract, which is what you want when
  // signing. Players browsing for "what can I make?" want the opposite
  // cut, so point them at the catalogue from the same card.
  const catalogHref = state.discoveryCollection
    ? `#/catalog/${encodeURIComponent(state.discoveryCollection)}`
    : '#/catalog';
  const catalogLabel = state.discoveryCollection
    ? `Browse everything in ${state.discoveryCollection} →`
    : 'Browse everything in one collection →';
  return `
    <div class="card platform-card">
      <div class="platform-pills">
        ${pill('nefty',       'NeftyBlocks', 'blend.nefty · neftyblocksd · atomicpacksx · up.nefty')}
        ${pill('waxdao',      'WaxDAO',      'waxdaomarket')}
        ${pill('blenderizer', 'Blenderizer', 'blenderizerx · by 3DkRender')}
      </div>
      <a class="catalog-link" href="${escapeHtml(catalogHref)}">${escapeHtml(catalogLabel)}</a>
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
    <div class="mint-with-art">
      ${renderMediaThumb({ ref: t?.image, alt: name ? `${name} artwork` : 'drop artwork' })}
      <div class="mint-with-art-body">
        <ul class="mint-info">
          <li><strong>Name:</strong> ${escapeHtml(String(name))}</li>
          <li><strong>Template:</strong> <code>${escapeHtml(String(t?.template_id ?? d.primary_template_id))}</code></li>
          ${t?.schema_name ? `<li><strong>Schema:</strong> <code>${escapeHtml(t.schema_name)}</code></li>` : ''}
          <li><strong>Issued / max:</strong> ${escapeHtml(String(issued))} / ${escapeHtml(max)} ${left !== null ? `<span class="term">(${left} left)</span>` : ''}</li>
          ${t ? `<li class="term">${t.is_transferable ? 'transferable' : 'soulbound'} · ${t.is_burnable ? 'burnable' : 'non-burnable'}</li>` : ''}
        </ul>
        ${d.assets_to_mint.length > 1 ? `<p class="term">+ ${d.assets_to_mint.length - 1} additional mint(s) per claim</p>` : ''}
      </div>
    </div>`;
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
      <div class="mint-with-art">
        ${renderMediaThumb({ ref: d.image, alt: `${d.name} artwork` })}
        <div class="mint-with-art-body">
          <div class="row">
            <span class="tag">asset <code>#${escapeHtml(pack.asset_id)}</code></span>
            <span class="tag">${escapeHtml(String(d.roll_counter))} mint${d.roll_counter === 1 ? '' : 's'} per pack</span>
            ${d.pack_template_id ? `<span class="tag">template <code>${escapeHtml(String(d.pack_template_id))}</code></span>` : ''}
            ${unlocked ? '<span class="tag ok">unlocked</span>' : `<span class="tag err">unlocks at ${escapeHtml(new Date(d.unlock_time * 1000).toISOString().slice(0, 16).replace('T', ' '))} UTC</span>`}
          </div>
        </div>
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
  // The author panel sits at the bottom, behind its own opt-in, so the
  // blending flow above is untouched for the 99% who are not authors.
  return renderPickBlend() + renderBlendInfo() + renderSlots() + renderActions() + renderBlendCreate();
}

function renderDropsView(): string {
  return renderPickDrop() + renderDropInfo() + renderDropActions() + renderDropCreate() + renderDropManage();
}

/**
 * Manage an existing drop (whitelist + key settings). Shares the create
 * panel's safety toggle. Loads any drop by id straight from chain - so the
 * author can manage hidden / gated drops that the discovery list won't show
 * (the exact case of a freshly created whitelist-gated drop).
 */
function renderDropManage(): string {
  const m = state.manageDrop;
  // Own safety toggle, independent of the create panel.
  if (!m.enabled) {
    return `
      <div class="manage-section create-section" style="margin-top:14px">
        <div class="manage-head">
          <span class="manage-title create-title">✦ MANAGE A DROP · neftyblocksd</span>
          <label class="inline-toggle">
            <input id="manageDropEnable" type="checkbox" data-action="toggleManageDropEnable" />
            <span>enable drop management</span>
          </label>
        </div>
        <p class="term" style="margin-top:6px">Edit the whitelist, visibility and settings of a drop you manage (incl. hidden/gated ones).</p>
      </div>`;
  }
  const actor = manageDropActor();
  const disabled = m.busy ? 'disabled' : '';

  // Picker: drops the connected account can manage (lazy - only on click).
  const myDropsOptions = (m.myDrops ?? [])
    .map((d) => `<option value="${escapeHtml(d.drop_id)}">${escapeHtml(d.collection_name)} · #${escapeHtml(d.drop_id)} ${escapeHtml(d.name)} (${escapeHtml(d.status)})</option>`)
    .join('');
  const picker = `
    <div class="manage-row">
      <span class="manage-label">my drops</span>
      <div class="manage-ctl">
        <div class="row" style="gap:8px; align-items:center; flex-wrap:wrap">
          <button data-action="findMyDrops" ${m.myDropsLoading ? 'disabled' : ''}>${m.myDropsLoading ? 'Scanning…' : 'Find drops I can manage'}</button>
          ${m.myDrops
            ? (m.myDrops.length
                ? `<select id="myDropsSelect" class="manage-sec-select"><option value="">${m.myDrops.length} drop(s) - pick one…</option>${myDropsOptions}</select>`
                : '<span class="term">no drops found</span>')
            : '<span class="term">lists your collections’ drops so you don’t need the id</span>'}
        </div>
        ${m.myDropsError ? `<p class="status-line err" style="margin-top:4px">${escapeHtml(m.myDropsError)}</p>` : ''}
      </div>
    </div>`;

  const loader = `
    <div class="manage-row">
      <span class="manage-label">or by id</span>
      <div class="manage-ctl">
        <div class="row" style="gap:8px; align-items:center; flex-wrap:wrap">
          <input id="manageDropId" type="text" inputmode="numeric" placeholder="drop_id to manage" value="${escapeHtml(m.dropIdInput)}" style="width:180px" />
          <button data-action="manageDropLoad" ${m.loading ? 'disabled' : ''}>${m.loading ? 'Loading…' : 'Load drop'}</button>
        </div>
        <p class="term" style="margin-top:4px">Loads any drop by id - including hidden or whitelist-gated ones that don't appear in the claim list.</p>
      </div>
    </div>`;

  let body = '';
  if (m.loaded) {
    const d = m.loaded;
    if (!m.authorized) {
      body = `<p class="status-line err" style="margin-top:8px">${escapeHtml(actor ?? '(no wallet)')} is not an authorized account of ${escapeHtml(d.collection_name)} - you can't manage drop #${escapeHtml(d.drop_id)}.</p>`;
    } else {
      const supply = d.max_claimable === 0 ? `${d.current_claimed}/∞` : `${d.current_claimed}/${d.max_claimable}`;
      const wl = m.whitelist;
      const whitelistEditor = `
        <div class="manage-members-wrap">
          <div class="term" style="margin-bottom:4px">whitelisted accounts for drop #${escapeHtml(d.drop_id)}:</div>
          <p class="term" style="margin:-2px 0 6px">Note: a drop's whitelist is a list of accounts that belongs to <em>this drop only</em> - NeftyBlocks drops have no reusable/named whitelists (unlike blend whitelists), so you add wallets directly here.</p>
          ${wl
            ? `<div class="manage-members">${
                wl.length === 0
                  ? '<span class="term">empty - nobody can claim this gated drop until you add accounts below</span>'
                  : wl.slice(0, 300).map((acc) =>
                      `<span class="manage-chip">${escapeHtml(acc)} <button data-action="manageDropRemoveAccount" data-account="${escapeHtml(acc)}" title="remove" ${disabled}>×</button></span>`,
                    ).join('')
              }${wl.length > 300 ? `<span class="term">+ ${wl.length - 300} more…</span>` : ''}</div>`
            : '<span class="term">loading members…</span>'}
          <div class="row" style="gap:8px; margin-top:8px; align-items:flex-start">
            <textarea id="manageDropAddAccounts" placeholder="accounts to add, e.g. zigm4.gm (comma / space / newline separated)" rows="2" style="flex:1; min-width:220px">${escapeHtml(m.addAccountsInput)}</textarea>
            <button data-action="manageDropAddAccounts" ${disabled}>Add accounts</button>
            <button class="danger-btn" data-action="manageDropClearWhitelist" ${disabled}>Clear all</button>
          </div>
        </div>`;

      const gateWarn = d.auth_required && (wl?.length ?? 0) === 0
        ? riskBox('This drop requires a whitelist but the whitelist is EMPTY - right now nobody can claim it. Add accounts below, or turn off "whitelist required".', '')
        : '';

      body = `
        <div class="manage-row">
          <span class="manage-label">drop #${escapeHtml(d.drop_id)}</span>
          <div class="manage-ctl">
            <div class="term">${escapeHtml(d.name || '(unnamed)')} · ${escapeHtml(d.collection_name)} · ${escapeHtml(d.listing_price)} · claimed ${escapeHtml(supply)}</div>
            <div class="row" style="gap:8px; margin-top:8px; flex-wrap:wrap">
              <button data-action="manageDropToggleAuth" ${disabled}>${d.auth_required ? 'Disable whitelist requirement' : 'Require whitelist'}</button>
              <button data-action="manageDropToggleHidden" ${disabled}>${d.is_hidden ? 'Unhide' : 'Hide'}</button>
            </div>
          </div>
        </div>
        ${gateWarn}
        <div class="manage-row">
          <span class="manage-label">whitelist</span>
          <div class="manage-ctl">${whitelistEditor}</div>
        </div>
        <div class="manage-row danger">
          <span class="manage-label">danger</span>
          <div class="manage-ctl">
            <button class="danger-btn" data-action="manageDropDelete" ${disabled}>Delete drop #${escapeHtml(d.drop_id)}</button>
          </div>
        </div>`;
    }
  }

  return `
    <div class="manage-section create-section" style="margin-top:14px">
      <div class="manage-head">
        <span class="manage-title create-title">✦ MANAGE A DROP · neftyblocksd</span>
        <label class="inline-toggle">
          <input id="manageDropEnable" type="checkbox" data-action="toggleManageDropEnable" checked />
          <span>management enabled</span>
        </label>
      </div>
      ${m.busy ? '<p class="status-line" style="margin-top:8px">Action in progress, confirm it in your wallet…</p>' : ''}
      ${picker}
      ${loader}
      ${body}
    </div>`;
}


// ─── create-blend panel (collection authors, BLEND tab) ───────────────── //

function onToggleCreateBlendEnabled(checked: boolean) {
  const c = state.createBlend;
  c.enabled = checked;
  if (checked && !c.collection) {
    // Default to whatever collection the author is already looking at.
    c.collection = state.blend?.collection_name || state.discoveryCollection || '';
  }
  render();
  if (checked && c.collection) void refreshCreateBlendAuth();
}

/** Same authorized_accounts check the Manage panel and drop creator use. */
async function refreshCreateBlendAuth() {
  const c = state.createBlend;
  const collection = c.collection.trim();
  const session = getCurrentSession();
  const actor = session ? String(session.actor) : '';
  if (!collection || !actor) {
    c.authChecked = collection;
    c.authorized = false;
    render();
    return;
  }
  if (c.authChecked === collection && c.authorized !== undefined && !c.authChecking) return;
  c.authChecking = true;
  render();
  try {
    c.authorized = await canManageCollection(actor, collection);
  } catch {
    c.authorized = false;
  } finally {
    c.authChecked = collection;
    c.authChecking = false;
    render();
  }
}

/**
 * Folds the form into the builder's argument shape. Returns the parse
 * and validation problems alongside, so the caller can block on them
 * and the panel can show them live as the author types.
 */
function readCreateBlendForm(): { args: CreateBlendArgs; problems: string[] } {
  const c = state.createBlend;
  const session = getCurrentSession();
  const collection = c.collection.trim();

  const ing = parseIngredientLines(c.ingredientsInput, collection);
  const out = parseOutcomeLines(c.outcomesInput);

  const display: Record<string, string> = {};
  if (c.name.trim()) display.name = c.name.trim();
  if (c.description.trim()) display.description = c.description.trim();
  if (c.image.trim()) display.image = c.image.trim();

  const args: CreateBlendArgs = {
    authorized_account: session ? String(session.actor) : '',
    collection_name: collection,
    ingredients: ing.items,
    rolls: [{ outcomes: out.items }],
    start_time: datetimeLocalToUnix(c.startTime),
    end_time: datetimeLocalToUnix(c.endTime),
    max_uses: Number(c.maxUses) || 0,
    display_data: Object.keys(display).length ? JSON.stringify(display) : '',
    security_id: c.securityId.trim() || 0,
    is_hidden: c.hidden,
    category: c.category.trim(),
    account_limit: Number(c.accountLimit) || 0,
    account_limit_cooldown: Number(c.cooldown) || 0,
  };

  return {
    args,
    problems: [...ing.errors, ...out.errors, ...validateNewBlend(args)],
  };
}

async function onCreateBlendDryRun() {
  const { args, problems } = readCreateBlendForm();
  if (problems.length) { setStatus(problems[0], 'err'); render(); return; }
  try {
    setStatus('Simulating createblend (local ABI serialisation)…', 'info');
    const action = buildCreateBlendAction(args);
    const out = await dryRunActions([action]);
    state.createBlend.lastDryRun = { action, abi_serialization: out };
    const ok = out.every((r) => !r.error);
    setStatus(ok ? 'Simulation OK, the action serialises cleanly.' : 'Simulation failed.', ok ? 'ok' : 'err');
  } catch (err) {
    setStatus((err as Error).message, 'err');
  }
  render();
}

async function onCreateBlendSubmit() {
  const c = state.createBlend;
  const session = getCurrentSession();
  if (!session) { setStatus('Connect a wallet first.', 'err'); return; }
  const { args, problems } = readCreateBlendForm();
  if (problems.length) { setStatus(problems[0], 'err'); render(); return; }
  if (!(c.authChecked === args.collection_name && c.authorized)) {
    setStatus('That account is not authorized for this collection (the contract would reject it).', 'err');
    return;
  }

  // Consequential and effectively irreversible once people start using
  // it, so spell out what is being registered before the wallet opens.
  const consumed = args.ingredients.filter((i) => i.kind !== 'ft' && i.kind !== 'cooldown');
  const burned = consumed.filter((i) => !i.transfer_to).length;
  const moved = consumed.filter((i) => i.transfer_to).length;
  const odds = describeOdds(args.rolls[0]?.outcomes ?? []);
  if (!confirm(
    `Create this blend on ${args.collection_name}?\n\n` +
    `${args.ingredients.length} ingredient(s): ${burned} burned` +
    `${moved ? `, ${moved} transferred away` : ''}\n` +
    `Outcomes:\n${odds.map((o) => '  ' + o).join('\n')}\n\n` +
    `${args.max_uses ? `Max ${args.max_uses} use(s).` : 'Unlimited uses.'}` +
    `${args.security_id && String(args.security_id) !== '0' ? ` Whitelist ${args.security_id}.` : ''}\n\n` +
    `Anyone can run it as soon as it exists, and the NFTs it consumes are gone.`,
  )) return;

  c.busy = true;
  render();
  try {
    setStatus('Awaiting wallet signature for createblend…', 'info');
    const result = await executeCreateBlend(session, args);
    const trxId =
      (result.response as { transaction_id?: string } | undefined)?.transaction_id ??
      String(result.resolved?.transaction.id ?? '');
    c.lastTrxId = trxId;
    setStatus(`Blend created: ${trxId}`, 'ok', trxId);
    // The new blend is not in any cached list yet.
    clearDiscoverCache();
  } catch (err) {
    setStatus(`Create blend failed: ${(err as Error).message}`, 'err');
  } finally {
    c.busy = false;
    render();
  }
}


/**
 * Inline "create a blend" form. Renders nothing until the author opts in
 * AND the connected wallet is authorized on the collection. The chain is
 * the real guard - blend.nefty verifies authorized_account - this is
 * just so the button is not a trap.
 */
function renderBlendCreate(): string {
  const c = state.createBlend;
  const session = getCurrentSession();
  const actor = session ? String(session.actor) : '';

  if (!c.enabled) {
    return `
      <div class="manage-section create-section" style="margin-top:18px">
        <div class="manage-head">
          <span class="manage-title create-title">✦ CREATE A BLEND · blend.nefty</span>
          <label class="inline-toggle">
            <input id="createBlendEnable" type="checkbox" data-action="toggleCreateBlendEnable" />
            <span>enable blend creation</span>
          </label>
        </div>
        <p class="term" style="margin-top:6px">Register a new recipe on a collection you manage: what gets consumed, and what it mints.</p>
      </div>`;
  }

  const collection = c.collection.trim();
  const authLine = !actor
    ? '<p class="status-line warn">Connect a wallet to create a blend.</p>'
    : c.authChecking
      ? '<p class="status-line">Checking whether you can manage this collection…</p>'
      : c.authChecked === collection && c.authorized
        ? `<p class="status-line ok">${escapeHtml(actor)} is authorized on ${escapeHtml(collection)}.</p>`
        : collection
          ? `<p class="status-line err">${escapeHtml(actor)} is not an authorized account of ${escapeHtml(collection)} — the contract would reject this.</p>`
          : '';

  // Live feedback: parse as the author types so mistakes surface before
  // the wallet opens, not after.
  const { args, problems } = readCreateBlendForm();
  const odds = describeOdds(args.rolls[0]?.outcomes ?? []);
  const consumed = args.ingredients.filter((i) => i.kind !== 'ft' && i.kind !== 'cooldown');
  const burned = consumed.filter((i) => !i.transfer_to);
  const moved = consumed.filter((i) => i.transfer_to);
  const tokens = args.ingredients.filter((i) => i.kind === 'ft');

  const preview = args.ingredients.length || odds.length
    ? `
      <h3 style="margin-top:12px">Preview</h3>
      <ul class="mint-info">
        ${burned.length ? `<li><strong>Burned:</strong> ${burned.length} ingredient(s) — destroyed for good</li>` : ''}
        ${moved.length ? `<li><strong>Transferred:</strong> ${moved.length} ingredient(s) sent to ${escapeHtml([...new Set(moved.map((i) => (i as { transfer_to?: string }).transfer_to ?? ''))].join(', '))}</li>` : ''}
        ${tokens.length ? `<li><strong>Token cost:</strong> ${tokens.map((t) => escapeHtml((t as { quantity: string }).quantity)).join(' + ')}</li>` : ''}
        ${odds.length ? `<li><strong>Draw:</strong><ul>${odds.map((o) => `<li>${escapeHtml(o)}</li>`).join('')}</ul></li>` : ''}
      </ul>`
    : '';

  const problemList = problems.length
    ? `<div class="risk-box"><div class="risk-why">⚠ Fix before signing</div><ul class="mint-info">${problems.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul></div>`
    : '';

  const ready = problems.length === 0 && !!actor && c.authChecked === collection && c.authorized && !c.busy;
  const disabled = ready ? '' : 'disabled';

  return `
    <div class="manage-section create-section" style="margin-top:18px">
      <div class="manage-head">
        <span class="manage-title create-title">✦ CREATE A BLEND · blend.nefty</span>
        <label class="inline-toggle">
          <input id="createBlendEnable" type="checkbox" data-action="toggleCreateBlendEnable" checked />
          <span>blend creation enabled</span>
        </label>
      </div>

      <div class="manage-row">
        <span class="manage-label">collection</span>
        <div class="manage-ctl"><input id="cbCollection" type="text" value="${escapeHtml(c.collection)}" placeholder="e.g. underpunks55" autocomplete="off" /></div>
      </div>
      ${authLine}

      <div class="manage-row">
        <span class="manage-label">name</span>
        <div class="manage-ctl"><input id="cbName" type="text" value="${escapeHtml(c.name)}" placeholder="shown in the picker" autocomplete="off" /></div>
      </div>
      <div class="manage-row">
        <span class="manage-label">image</span>
        <div class="manage-ctl"><input id="cbImage" type="text" value="${escapeHtml(c.image)}" placeholder="IPFS hash (Qm… / baf…)" autocomplete="off" /></div>
      </div>
      <div class="manage-row">
        <span class="manage-label">description</span>
        <div class="manage-ctl"><input id="cbDescription" type="text" value="${escapeHtml(c.description)}" autocomplete="off" /></div>
      </div>
      <div class="manage-row">
        <span class="manage-label">category</span>
        <div class="manage-ctl"><input id="cbCategory" type="text" value="${escapeHtml(c.category)}" placeholder="optional grouping label" autocomplete="off" /></div>
      </div>

      ${riskBox(
        'These NFTs are consumed every time someone blends. "-> account" sends them there instead of burning them; without it they are destroyed permanently.',
        `<label>Ingredients — one per line</label>
         <textarea id="cbIngredients" rows="5" spellcheck="false" placeholder="template 877088 x5
template 877088 x5 -> vault.wam
template othercoll:741859 x1
schema up.tools x3
collection x2
token 10.0000 TLM -> payout.wam">${escapeHtml(c.ingredientsInput)}</textarea>`,
      )}

      ${riskBox(
        'Weights are relative and the draw is final. One line = a guaranteed result; several lines = a lottery. "nothing" is a blank branch that mints nothing at all.',
        `<label>Outcomes — one per line</label>
         <textarea id="cbOutcomes" rows="4" spellcheck="false" placeholder="907173
907173 @50
907173+906880 @3
nothing @20">${escapeHtml(c.outcomesInput)}</textarea>`,
      )}

      <div class="manage-row">
        <span class="manage-label">starts</span>
        <div class="manage-ctl"><input id="cbStart" type="datetime-local" value="${escapeHtml(c.startTime)}" /> <span class="term">empty = immediately</span></div>
      </div>
      <div class="manage-row">
        <span class="manage-label">ends</span>
        <div class="manage-ctl"><input id="cbEnd" type="datetime-local" value="${escapeHtml(c.endTime)}" /> <span class="term">empty = never</span></div>
      </div>
      <div class="manage-row">
        <span class="manage-label">max uses</span>
        <div class="manage-ctl"><input id="cbMaxUses" type="number" min="0" value="${escapeHtml(c.maxUses)}" placeholder="0" /> <span class="term">0 = unlimited</span></div>
      </div>
      <div class="manage-row">
        <span class="manage-label">per account</span>
        <div class="manage-ctl"><input id="cbAccountLimit" type="number" min="0" value="${escapeHtml(c.accountLimit)}" placeholder="0" /> <span class="term">0 = unlimited · cooldown</span> <input id="cbCooldown" type="number" min="0" value="${escapeHtml(c.cooldown)}" placeholder="0" style="max-width:120px" /> <span class="term">seconds</span></div>
      </div>
      <div class="manage-row">
        <span class="manage-label">whitelist</span>
        <div class="manage-ctl"><input id="cbSecurityId" type="text" value="${escapeHtml(c.securityId)}" placeholder="0" autocomplete="off" /> <span class="term">secure.nefty id · 0 = open to everyone</span></div>
      </div>
      <div class="manage-row">
        <span class="manage-label">hidden</span>
        <div class="manage-ctl"><label class="inline-toggle"><input id="cbHidden" type="checkbox" ${c.hidden ? 'checked' : ''} /> <span>create it hidden</span></label></div>
      </div>

      ${preview}
      ${problemList}

      <div class="row" style="margin-top:12px">
        <button data-action="createBlendDryRun" ${problems.length ? 'disabled' : ''}>Simulate (no signature)</button>
        <button class="create-btn" data-action="createBlendSubmit" ${disabled}>${c.busy ? 'Creating…' : 'Create blend'}</button>
      </div>
      ${c.lastDryRun ? `<h3>Dry-run output</h3><pre>${escapeHtml(JSON.stringify(c.lastDryRun, null, 2))}</pre>` : ''}
      ${c.lastTrxId ? `<p class="status-line ok">Created: <a target="_blank" href="https://waxblock.io/transaction/${escapeHtml(c.lastTrxId)}">${escapeHtml(c.lastTrxId)}</a></p>` : ''}
    </div>`;
}

// ─── create-drop panel (collection authors, CLAIM/drops tab) ──────────── //

/**
 * Wraps a touchy / risky control in a red-outlined box with a plain-language
 * explanation of WHY it's risky. Visually distinct from the amber Manage
 * panel so dangerous knobs read as "stop and think" rather than "routine".
 */
function riskBox(why: string, innerHtml: string): string {
  return `
    <div class="risk-box">
      <div class="risk-why">⚠ ${escapeHtml(why)}</div>
      ${innerHtml}
    </div>`;
}

/**
 * Inline "create a NeftyBlocks drop" form. Renders nothing unless management
 * is enabled (opt-in) and the connected wallet is an authorized account of
 * the chosen collection. Mirrors the Manage panel's auth model; the chain is
 * the real guard (neftyblocksd verifies authorized_account).
 */
function renderDropCreate(): string {
  const c = state.createDrop;
  const session = getCurrentSession();
  const actor = session ? String(session.actor) : '';

  // Collapsed header + safety toggle (always visible so the author can find it).
  if (!c.enabled) {
    return `
      <div class="manage-section create-section" style="margin-top:18px">
        <div class="manage-head">
          <span class="manage-title create-title">✦ CREATE A DROP · neftyblocksd</span>
          <label class="inline-toggle">
            <input id="createEnable" type="checkbox" data-action="toggleCreateEnable" />
            <span>enable drop creation</span>
          </label>
        </div>
        <p class="term" style="margin-top:6px">Mint a NeftyBlocks claim/drop from existing templates of a collection you manage.</p>
      </div>`;
  }

  if (!actor) {
    return `
      <div class="manage-section create-section" style="margin-top:18px">
        <div class="manage-head">
          <span class="manage-title create-title">✦ CREATE A DROP · neftyblocksd</span>
          <label class="inline-toggle">
            <input id="createEnable" type="checkbox" data-action="toggleCreateEnable" checked />
            <span>creation enabled</span>
          </label>
        </div>
        <p class="status-line warn" style="margin-top:8px">Connect a wallet that's an authorized account of the collection to create a drop.</p>
      </div>`;
  }

  // Auth banner for the entered collection.
  let authBanner = '';
  if (c.collection.trim()) {
    if (c.authChecking) {
      authBanner = `<p class="term" style="margin-top:6px">Checking whether ${escapeHtml(actor)} can manage ${escapeHtml(c.collection.trim())}…</p>`;
    } else if (c.authChecked === c.collection.trim()) {
      authBanner = c.authorized
        ? `<p class="status-line ok" style="margin-top:6px">✓ ${escapeHtml(actor)} is authorized for ${escapeHtml(c.collection.trim())}.</p>`
        : `<p class="status-line err" style="margin-top:6px">✗ ${escapeHtml(actor)} is NOT an authorized account of ${escapeHtml(c.collection.trim())}. The contract will reject createdrop.</p>`;
    }
  }
  const authorized = c.authChecked === c.collection.trim() && c.authorized === true;

  // Live preview of the parsed templates + total mint count.
  const entries = parseTemplateEntries(c.templatesInput);
  const mints = totalMints(entries);
  const templatesSummary = entries.length
    ? `<div class="term" style="margin-top:4px">→ ${entries.map((e) => `#${e.template_id}×${e.quantity}`).join(', ')} = <strong>${mints}</strong> NFT(s) total to mint</div>`
    : `<div class="term" style="margin-top:4px">No valid template id parsed yet.</div>`;

  const priceLabel = c.free
    ? 'FREE'
    : `${(Number(c.priceAmount) || 0)} ${escapeHtml(c.priceToken || 'WAX')}`;

  const submitDisabled = (!authorized || c.busy) ? 'disabled' : '';

  return `
    <div class="manage-section create-section" style="margin-top:18px">
      <div class="manage-head">
        <span class="manage-title create-title">✦ CREATE A DROP · neftyblocksd</span>
        <label class="inline-toggle">
          <input id="createEnable" type="checkbox" data-action="toggleCreateEnable" checked />
          <span>creation enabled</span>
        </label>
      </div>

      <div class="manage-row">
        <span class="manage-label">collection</span>
        <div class="manage-ctl">
          <input id="createCollection" type="text" placeholder="collection name you manage, e.g. underpunks55" value="${escapeHtml(c.collection)}" style="width:100%; max-width:320px" />
          ${authBanner}
        </div>
      </div>

      <div class="manage-row">
        <span class="manage-label">display</span>
        <div class="manage-ctl">
          <input id="createName" type="text" placeholder="drop name (shown to claimers)" value="${escapeHtml(c.name)}" style="width:100%; max-width:420px" />
          <textarea id="createDescription" placeholder="description (optional)" rows="2" style="width:100%; margin-top:6px">${escapeHtml(c.description)}</textarea>
          <input id="createImage" type="text" placeholder="image: IPFS CID or https URL (optional)" value="${escapeHtml(c.image)}" style="width:100%; margin-top:6px" />
        </div>
      </div>

      ${riskBox(
        'These exact templates will be minted and handed to claimers, in this order. A wrong template id gives away the wrong NFTs, and the drop cannot mint templates that do not already exist on the collection.',
        `<span class="manage-label" style="flex:none">templates to mint</span>
         <textarea id="createTemplates" placeholder="template ids with optional quantity - e.g. 877088 x20, 889127 x2" rows="2" style="width:100%; margin-top:6px">${escapeHtml(c.templatesInput)}</textarea>
         ${templatesSummary}`,
      )}

      <div class="manage-row">
        <span class="manage-label">price</span>
        <div class="manage-ctl">
          <label class="inline-mini"><input id="createFree" type="checkbox" data-action="toggleCreateFree" ${c.free ? 'checked' : ''}/> <span>free drop (no payment)</span></label>
          ${c.free
            ? `<div class="term" style="margin-top:6px">listing: <strong>FREE</strong> (encoded on-chain as "0 NULL")</div>`
            : `<div class="row" style="gap:8px; margin-top:6px; flex-wrap:wrap; align-items:center">
                 <input id="createPriceAmount" type="text" inputmode="decimal" placeholder="amount, e.g. 1.5" value="${escapeHtml(c.priceAmount)}" style="width:140px" />
                 <input id="createPriceToken" type="text" placeholder="token (WAX)" value="${escapeHtml(c.priceToken)}" style="width:120px" />
                 <input id="createPriceDecimals" type="text" inputmode="numeric" placeholder="decimals (8)" value="${escapeHtml(c.priceDecimals)}" style="width:120px" title="token precision - WAX is 8" />
                 <span class="term">→ ${escapeHtml(priceLabel)}</span>
               </div>
               <p class="term" style="margin-top:4px">Most WAX tokens use 8 decimals. Get the token's precision wrong and the price is off by orders of magnitude.</p>`}
        </div>
      </div>

      ${c.free
        ? riskBox(
            'A free drop can be claimed without paying. Combined with unlimited supply, claimers can drain your minted NFTs at will. Set a per-account limit and/or a max supply if unsure.',
            '',
          )
        : ''}

      ${riskBox(
        'Supply is how many times the drop can be claimed in total. "Unlimited" keeps minting until your templates are exhausted - only use it if that is genuinely what you want.',
        `<div class="row" style="gap:12px; align-items:center; flex-wrap:wrap">
           <span class="manage-label" style="flex:none">max supply</span>
           <label class="inline-mini"><input id="createUnlimited" type="checkbox" data-action="toggleCreateUnlimited" ${c.unlimited ? 'checked' : ''}/> <span>unlimited</span></label>
           ${c.unlimited ? '<span class="term">max_claimable = 0 (no cap)</span>'
             : `<input id="createMax" type="text" inputmode="numeric" placeholder="e.g. 1000" value="${escapeHtml(c.maxClaimable)}" style="width:140px" />`}
         </div>`,
      )}

      <div class="manage-row">
        <span class="manage-label">per account</span>
        <div class="manage-ctl">
          <div class="row" style="gap:8px; align-items:center; flex-wrap:wrap">
            <input id="createAccountLimit" type="text" inputmode="numeric" placeholder="limit per account (0 = none)" value="${escapeHtml(c.accountLimit)}" style="width:200px" />
            <input id="createCooldown" type="text" inputmode="numeric" placeholder="cooldown seconds (0 = none)" value="${escapeHtml(c.cooldown)}" style="width:200px" />
          </div>
        </div>
      </div>

      <div class="manage-row">
        <span class="manage-label">schedule</span>
        <div class="manage-ctl">
          <div class="row" style="gap:8px; align-items:center; flex-wrap:wrap">
            <label class="inline-mini">start <input id="createStart" type="datetime-local" value="${escapeHtml(c.startTime)}" /></label>
            <label class="inline-mini">end <input id="createEnd" type="datetime-local" value="${escapeHtml(c.endTime)}" /></label>
          </div>
          <p class="term" style="margin-top:4px">Leave start empty to begin immediately. ${c.endTime ? '' : '<span class="risk-inline">Leaving end empty means the drop never ends - it stays claimable indefinitely.</span>'}</p>
        </div>
      </div>

      <div class="manage-row">
        <span class="manage-label">options</span>
        <div class="manage-ctl">
          <label class="inline-mini"><input id="createAuthReq" type="checkbox" data-action="toggleCreateAuthReq" ${c.authRequired ? 'checked' : ''}/> <span>require whitelist (auth_required)</span></label>
          <label class="inline-mini" style="margin-left:12px"><input id="createHidden" type="checkbox" data-action="toggleCreateHidden" ${c.hidden ? 'checked' : ''}/> <span>hidden</span></label>
          <label class="inline-mini" style="margin-left:12px"><input id="createCC" type="checkbox" data-action="toggleCreateCC" ${c.allowCreditCard ? 'checked' : ''}/> <span>allow credit-card payments</span></label>
        </div>
      </div>

      ${c.authRequired
        ? riskBox(
            'Two-step by design: createdrop only flips the "whitelist required" switch - it can\'t take the list of accounts. The drop is created with an EMPTY whitelist (nobody can claim yet). Right after creating, it loads into "Manage a drop" below and you add the allowed wallets there.',
            '',
          )
        : ''}

      ${riskBox(
        'All payments go to this account. Double-check it - a typo sends every claim payment to the wrong (or a non-existent) account, and that is irreversible.',
        `<span class="manage-label" style="flex:none">price recipient</span>
         <input id="createRecipient" type="text" placeholder="defaults to your account: ${escapeHtml(actor)}" value="${escapeHtml(c.priceRecipient)}" style="width:100%; max-width:320px; margin-top:6px" />`,
      )}

      <div class="manage-row">
        <span class="manage-label"></span>
        <div class="manage-ctl">
          <button class="create-btn" data-action="createDropSubmit" ${submitDisabled}>Create drop (${escapeHtml(priceLabel)}${c.unlimited ? ', ∞' : ''})</button>
          ${authorized ? '' : '<p class="term" style="margin-top:6px">Enter a collection you manage to enable the button.</p>'}
          <p class="term" style="margin-top:6px">Creating a drop is an on-chain action that costs RAM and commits these mints. Review every red box above before signing.</p>
        </div>
      </div>
    </div>`;
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

function ingredientLabel(ing: UpgradeIngredient, collection?: string): string {
  switch (ing.kind) {
    case 'ft':           return `Pay ${escapeHtml(ing.quantity)}`;
    case 'template': {
      const nm = displayTemplateName(ing.template_id, collection);
      return nm.startsWith('template #')
        ? `Burn ${ing.amount} NFT(s) of template ${ing.template_id}`
        : `Burn ${ing.amount} NFT(s) of ${nm} (template ${ing.template_id})`;
    }
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
        up.ingredients.map((ing) => `<li>${escapeHtml(ingredientLabel(ing, up.collection_name))}</li>`).join('')
      }</ul>`
    : '';

  const specsBlock = up.specs.map((spec, i) => {
    const reqText = spec.requirements.map((req) => {
      if (req.kind === 'template') {
        const nm = displayTemplateName(req.template_id, up.collection_name);
        return nm.startsWith('template #')
          ? `template <code>${req.template_id}</code>`
          : `${escapeHtml(nm)} <code>#${req.template_id}</code>`;
      }
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
      <div class="mint-with-art">
        ${renderMediaThumb({
          // The upgrade row's own display_data first, then the artwork of
          // an NFT it accepts. Needed because some authors' display_data
          // hashes are no longer served anywhere (every Diya upgrade on
          // underpunks55 is in that state), while the templates those
          // upgrades apply to are still perfectly resolvable.
          ref: [
            up.image,
            ...(up.acceptedTemplateIds ?? [])
              .slice(0, 3)
              .map((tid) => displayTemplateImage(tid, up.collection_name)),
          ],
          alt: `${up.name} artwork`,
        })}
        <div class="mint-with-art-body">
          ${ingredientsList}
        </div>
      </div>
      <h3>What gets mutated</h3>
      ${specsBlock}
      ${up.description ? `<details style="margin-top:12px"><summary class="term" style="cursor:pointer">upgrade description</summary><p style="margin-top:8px; font-size:12px; color:var(--fg-dim)">${escapeHtml(up.description)}</p></details>` : ''}
    </div>`;
}

function renderUpgradeAssetSlot(spec: DiscoveredUpgrade['specs'][number], specIdx: number): string {
  const u = state.upgrades;
  const owned = ownedAssetsForSpec(spec);
  const picked = u.selection.get(specIdx);
  const reqCollection = state.upgrades.picked?.collection_name;
  const reqLabel = spec.requirements.map((req) => {
    if (req.kind === 'template') {
      const nm = displayTemplateName(req.template_id, reqCollection);
      return nm.startsWith('template #') ? `template ${req.template_id}` : `${nm} (template ${req.template_id})`;
    }
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

function renderUpgradeCostSlot(ing: UpgradeIngredient, ingIdx: number): string {
  const u = state.upgrades;
  const owned = ownedAssetsForCostIngredient(ing);
  const picked = u.costSelection.get(ingIdx) ?? [];
  const amount = costIngredientAmount(ing);
  const label = ingredientLabel(ing, u.picked?.collection_name);
  const items = owned.map((a) => {
    const selected = picked.includes(a.asset_id) ? ' selected' : '';
    const name = displayAssetName(a);
    return `
      <div class="asset${selected}" data-action="pickUpgradeCostAsset" data-cost="${ingIdx}" data-asset="${escapeHtml(a.asset_id)}">
        <span>${escapeHtml(name)}</span>
        <span class="id">#${escapeHtml(a.asset_id)}${a.template_mint ? ' · mint ' + escapeHtml(a.template_mint) : ''}</span>
      </div>`;
  });
  return `
    <div class="slot">
      <div class="slot-header">
        <div class="slot-label">${escapeHtml(label)}</div>
        <div class="slot-progress">${picked.length}/${amount} picked · ${owned.length} eligible</div>
      </div>
      ${owned.length === 0
        ? '<p class="status-line err">No matching NFT in your wallet to burn for this cost.</p>'
        : `<div class="asset-grid">${items.join('')}</div>`}
    </div>`;
}

function renderUpgradeSlots(): string {
  const u = state.upgrades;
  if (!u.picked) return '';
  const slots = u.picked.specs.map((spec, i) => renderUpgradeAssetSlot(spec, i)).join('');
  // NFT-cost ingredients: pick which owned NFT(s) to burn.
  const costBlocks = u.picked.ingredients
    .map((ing, idx) => (isCostNftIngredient(ing) ? renderUpgradeCostSlot(ing, idx) : ''))
    .join('');
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
      ${costBlocks}
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
    setStatus(`WaxDAO blend broadcast: ${trxId}`, 'ok', trxId);
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
  // WaxDAO carries the artwork on the result itself (nft_image), with the
  // blend's cover_image as a fallback for recipes that leave it blank.
  const outList = b.results.length > 0
    ? `<h3>Expected mint</h3>
       <div class="mint-with-art">
         ${renderMediaThumb({
           ref: b.results.find((r) => r.nft_image)?.nft_image ?? b.cover_image,
           alt: `${b.title} artwork`,
         })}
         <div class="mint-with-art-body">
           <ul class="mint-info">${
             b.results.map((r) => {
               const tid = r.template_id ? `template <code>${r.template_id}</code>` : '<span class="term">no template</span>';
               const sch = r.schema_name ? ` · schema <code>${escapeHtml(r.schema_name)}</code>` : '';
               const name = r.nft_name ? ` (${escapeHtml(r.nft_name)})` : '';
               return `<li>${tid}${sch}${name}</li>`;
             }).join('')
           }</ul>
         </div>
       </div>`
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

// ─── BLENDERIZER view: handlers + rendering ──────────────────────── //

/**
 * Discovers blenderizerx recipes for the active collection, then reads
 * the collection's RAM balance and refreshes the wallet inventory so
 * the per-slot pickers have data.
 *
 * `blenders` has no index on collection, so this walks the whole table
 * (~17.7K rows) in parallel chunks. Progress is reported the same way
 * the on-chain blend.nefty scan does.
 */
async function loadBlenderizerList() {
  const bz = state.blenderizer;
  bz.loading = true;
  bz.error = undefined;
  bz.progress = undefined;
  render();
  try {
    const { blends } = await listBlenderizerBlends({
      collection: state.discoveryCollection,
      includeInactive: bz.showInactive,
      onProgress: (message, pct) => {
        bz.progress = { pct, message };
        render();
      },
    });
    bz.list = blends;
    await refreshBlenderizerRam(state.discoveryCollection);
    const session = getCurrentSession();
    if (session) {
      try {
        state.discoveryOwnedAssets = await listAssetsForOwner({
          owner: String(session.actor),
          collection_name: state.discoveryCollection,
        });
      } catch { /* non-fatal: slots just show 0 eligible */ }
    }
  } catch (err) {
    bz.error = (err as Error).message;
    bz.list = [];
  } finally {
    bz.loading = false;
    bz.progress = undefined;
    render();
  }
}

/**
 * Reads the collection's RAM balance on blenderizerx. A missing row is
 * normalised to 0 bytes: both mean the contract cannot mint for this
 * collection until the author funds it.
 */
async function refreshBlenderizerRam(collection: string) {
  const bz = state.blenderizer;
  bz.ramChecked = false;
  bz.ram = undefined;
  if (!collection) return;
  const ram = await readBlenderizerRam(collection);
  bz.ram = ram ?? { collection, bytes: 0 };
  bz.ramChecked = true;
  render();
}

function onToggleBlenderizerShowInactive(checked: boolean) {
  const bz = state.blenderizer;
  bz.showInactive = checked;
  bz.list = [];
  bz.error = undefined;
  render();
}

function onToggleBlenderizerPicker() {
  state.blenderizer.pickerOpen = !state.blenderizer.pickerOpen;
  render();
}

async function onPickBlenderizerBlend(blend_id: string) {
  const bz = state.blenderizer;
  bz.pickerOpen = false;
  const found = bz.list.find((b) => b.blend_id === blend_id);
  if (!found) return;
  bz.picked = found;
  bz.blendIdInput = blend_id;
  bz.selection.clear();
  bz.lastDryRun = undefined;
  bz.lastTrxId = undefined;
  writeHashRoute('blenderizer', 'blenderizer-blends', blend_id);
  render();
}

/**
 * Manual-entry / deep-link path. The id is the TARGET template, which
 * is also the recipe's primary key on blenderizerx.
 */
async function onLoadBlenderizerBlendManual() {
  const bz = state.blenderizer;
  if (!bz.blendIdInput) {
    setStatus('Enter a Blenderizer recipe id (the target template_id) first.', 'err');
    return;
  }
  const local = bz.list.find((b) => b.blend_id === bz.blendIdInput);
  if (local) {
    void onPickBlenderizerBlend(bz.blendIdInput);
    return;
  }
  bz.loading = true;
  render();
  try {
    const b = await loadBlenderizerBlendById(bz.blendIdInput);
    if (!b) {
      setStatus(
        `No Blenderizer recipe targets template ${bz.blendIdInput}. ` +
          `On blenderizerx the recipe id IS the template it mints.`,
        'err',
      );
      return;
    }
    bz.picked = b;
    bz.selection.clear();
    bz.lastDryRun = undefined;
    bz.lastTrxId = undefined;
    writeHashRoute('blenderizer', 'blenderizer-blends', b.blend_id);
    if (b.collection && b.collection !== state.discoveryCollection) {
      state.discoveryCollection = b.collection;
    }
    await refreshBlenderizerRam(b.collection);
    try {
      const session = getCurrentSession();
      if (session) {
        state.discoveryOwnedAssets = await listAssetsForOwner({
          owner: String(session.actor),
          collection_name: b.collection,
        });
      }
    } catch { /* non-fatal */ }
  } catch (err) {
    setStatus(`Error: ${(err as Error).message}`, 'err');
  } finally {
    bz.loading = false;
    render();
  }
}

/** NFTs in the wallet that satisfy a slot: same collection + template. */
function ownedAssetsForBlenderizerSlot(template_id: number, collection: string): AtomicAsset[] {
  return state.discoveryOwnedAssets.filter(
    (a) =>
      a.collection?.collection_name === collection &&
      a.template?.template_id != null &&
      Number(a.template.template_id) === template_id,
  );
}

/**
 * Multi-select toggle for a slot. Slots take `amount` NFTs, so this
 * mirrors the Nefty BLEND tab rather than WaxDAO's single pick: click
 * to add until the slot is full, click again to remove.
 */
function onPickBlenderizerAsset(slotIndex: number, asset_id: string) {
  const bz = state.blenderizer;
  const slot = bz.picked?.slots.find((s) => s.index === slotIndex);
  if (!slot) return;
  const current = bz.selection.get(slotIndex) ?? [];
  if (current.includes(asset_id)) {
    bz.selection.set(slotIndex, current.filter((id) => id !== asset_id));
    render();
    return;
  }
  if (current.length >= slot.amount) {
    setStatus(`Slot #${slotIndex} is already full (${slot.amount} NFTs).`, 'warn');
    return;
  }
  // The same asset can satisfy only one slot: a recipe that lists the
  // same template twice would otherwise let one NFT count double.
  for (const [otherIdx, ids] of bz.selection.entries()) {
    if (otherIdx !== slotIndex && ids.includes(asset_id)) {
      setStatus(`Asset ${asset_id} is already used by slot #${otherIdx}.`, 'warn');
      return;
    }
  }
  bz.selection.set(slotIndex, [...current, asset_id]);
  render();
}

/**
 * Conditions that would make the contract reject the transfer, checked
 * before the user deposits anything. Same spirit as the drop tab's
 * blocker notices: explain rather than silently disable.
 */
interface BlenderizerBlocker {
  fatal: boolean;
  message: string;
}
function blenderizerBlockers(b: DiscoveredBlenderizerBlend): BlenderizerBlocker[] {
  const bz = state.blenderizer;
  const out: BlenderizerBlocker[] = [];
  if (b.status === 'sold_out') {
    out.push({
      fatal: true,
      message:
        `Target template ${b.target} is capped at ${b.target_max} and ${b.target_issued} are already minted. ` +
        `The contract cannot mint another one, so this recipe can no longer pay out.`,
    });
  }
  if (bz.ramChecked && bz.ram && bz.ram.bytes <= 0) {
    out.push({
      fatal: true,
      message:
        `Collection "${b.collection}" has no RAM balance on blenderizerx. The contract mints from RAM the ` +
        `collection author pre-paid, so every blend for this collection fails until they fund it again.`,
    });
  }
  if (b.total_nfts > LARGE_MIXTURE_WARN) {
    out.push({
      fatal: false,
      message:
        `This recipe burns ${b.total_nfts} NFTs in a single transfer. Large transfers cost a lot of CPU and ` +
        `some wallets struggle to display them: make sure you have CPU staked before signing.`,
    });
  }
  return out;
}

function readyToBlenderizerBlend(): boolean {
  const bz = state.blenderizer;
  const b = bz.picked;
  if (!b) return false;
  if (blenderizerBlockers(b).some((x) => x.fatal)) return false;
  for (const slot of b.slots) {
    if ((bz.selection.get(slot.index) ?? []).length !== slot.amount) return false;
  }
  return true;
}

async function onBlenderizerDryRun() {
  const bz = state.blenderizer;
  const session = getCurrentSession();
  if (!session || !bz.picked) return;
  try {
    setStatus('Simulating Blenderizer blend (local ABI serialisation)…', 'info');
    const actions = buildBlenderizerBlendActions({
      claimer: String(session.actor),
      blend: bz.picked,
      selection: bz.selection,
    });
    const out = await dryRunActions(actions);
    bz.lastDryRun = { actions, abi_serialization: out };
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

async function onExecuteBlenderizerBlend() {
  const bz = state.blenderizer;
  const session = getCurrentSession();
  if (!session || !bz.picked) return;
  const b = bz.picked;
  const total = b.total_nfts;
  if (
    !confirm(
      `Burn ${total} NFT${total === 1 ? '' : 's'} to mint template ${b.target}` +
        `${b.name ? ` (${b.name})` : ''}?\n\n` +
        `1. atomicassets::transfer → blenderizerx  memo="${b.target}"\n\n` +
        `blenderizerx mints the target to your wallet and burns the deposit in the same ` +
        `transaction. There is no second signature and no way to undo it.`,
    )
  ) {
    return;
  }
  bz.pending = true;
  render();
  try {
    setStatus('Awaiting wallet signature for the Blenderizer blend…', 'info');
    const result = await executeBlenderizerBlend(session, {
      blend: b,
      selection: bz.selection,
    });
    const trxId =
      (result.response as { transaction_id?: string } | undefined)?.transaction_id ??
      String(result.resolved?.transaction.id ?? '');
    bz.lastTrxId = trxId;
    bz.selection.clear();
    setStatus(`Blenderizer blend broadcast: ${trxId}`, 'ok', trxId);
    // The burn changes the wallet, so re-read it for the next blend.
    try {
      state.discoveryOwnedAssets = await listAssetsForOwner({
        owner: String(session.actor),
        collection_name: b.collection,
        force: true,
      });
    } catch { /* non-fatal */ }
  } catch (err) {
    setStatus(`Blenderizer blend failed: ${(err as Error).message}`, 'err');
  } finally {
    bz.pending = false;
    render();
  }
}

// ── render ── //

function blenderizerStatusLabel(s: BlenderizerStatus): string {
  switch (s) {
    case 'active':   return 'active';
    case 'sold_out': return 'sold out';
    case 'unknown':  return 'template unread';
  }
}

/** Maps our 3 statuses onto the shared status-chip CSS classes. */
function blenderizerStatusClass(s: BlenderizerStatus): string {
  return s === 'unknown' ? 'upcoming' : s;
}

function renderBlenderizerPickerToggle(): string {
  const bz = state.blenderizer;
  let label = 'Select a Blenderizer recipe…';
  const notLoadedYet = bz.list.length === 0 && !bz.loading && !bz.error;
  if (notLoadedYet) {
    label = `Click "Discover recipes" to load ${state.discoveryCollection || 'a collection'}’s list`;
  } else if (bz.picked) {
    label = `[#${bz.picked.blend_id}] ${blenderizerTitle(bz.picked)}`;
  } else if (bz.loading) {
    label = bz.progress?.message ?? 'Scanning blenderizerx…';
  } else if (bz.error) {
    label = 'Discovery failed';
  }
  const disabled = bz.loading || bz.error || notLoadedYet;
  return `
    <button class="picker-toggle" data-action="toggleBlenderizerPicker" ${disabled ? 'disabled' : ''}>
      <span class="picker-current">${escapeHtml(label)}</span>
      <span class="picker-caret">${bz.pickerOpen ? '▴' : '▾'}</span>
    </button>`;
}

function renderBlenderizerPickerPanel(): string {
  const bz = state.blenderizer;
  if (!bz.pickerOpen || bz.loading || bz.error) return '';
  if (bz.list.length === 0) {
    return `<div class="picker-panel"><div class="picker-empty">${escapeHtml('No Blenderizer recipe found for this collection.')}</div></div>`;
  }
  const rows = bz.list.map((b) => {
    const disabled = b.status === 'sold_out';
    const cls = ['picker-row'];
    if (disabled) cls.push('picker-row-disabled');
    return `
      <div class="${cls.join(' ')}" ${disabled ? '' : `data-action="pickBlenderizerBlend" data-blenderizer-blend="${escapeHtml(b.blend_id)}"`}>
        <span class="picker-id">#${escapeHtml(b.blend_id)}</span>
        <span class="picker-name">${escapeHtml(blenderizerTitle(b))}</span>
        <span class="picker-price">${b.total_nfts} NFT${b.total_nfts === 1 ? '' : 's'}</span>
        <span class="status-chip status-${escapeHtml(blenderizerStatusClass(b.status))}">${escapeHtml(blenderizerStatusLabel(b.status))}</span>
      </div>`;
  }).join('');
  return `<div class="picker-panel"><div class="picker-rows">${rows}</div></div>`;
}

function renderBlenderizerLegend(): string {
  return `
    <div class="legend">
      <span class="legend-label">Color codes</span>
      <span class="legend-item"><span class="status-chip status-active">active</span></span>
      <span class="legend-item"><span class="status-chip status-sold_out">sold out</span> <span class="term">target template capped and fully minted</span></span>
      <span class="legend-item"><span class="status-chip status-upcoming">template unread</span> <span class="term">indexer didn't resolve the target</span></span>
    </div>`;
}

/** Collection-wide RAM notice, shown once the balance has been read. */
function renderBlenderizerRamNotice(): string {
  const bz = state.blenderizer;
  if (!bz.ramChecked || !bz.ram) return '';
  if (bz.ram.bytes > 0) {
    return `<p class="status-line term">Collection RAM on <code>blenderizerx</code>: <code>${bz.ram.bytes.toLocaleString('en-US')}</code> bytes available for minting.</p>`;
  }
  return `<p class="status-line err">Collection "${escapeHtml(bz.ram.collection)}" has no RAM balance on <code>blenderizerx</code>. Every blend for this collection will fail until the author funds it.</p>`;
}

function renderPickBlenderizer(): string {
  const bz = state.blenderizer;
  const session = getCurrentSession();
  const refreshLabel = bz.loading
    ? 'Scanning…'
    : bz.list.length > 0
      ? 'Refresh recipes'
      : 'Discover recipes';
  const counts = bz.list.length > 0
    ? `${bz.list.length} recipe${bz.list.length === 1 ? '' : 's'} found`
    : '';
  const progressBar = bz.loading && bz.progress
    ? `<div class="progress"><div class="progress-fill" style="width:${Math.round(bz.progress.pct * 100)}%"></div></div>`
    : '';
  return `
    <div class="card">
      <h2>2 · Pick a Blenderizer recipe</h2>
      <p style="margin-top:0; color:var(--fg-dim); font-size:12px">
        <code>blenderizerx</code> is 3DkRender's Blenderizer, not a Nefty
        contract. Recipes are dead simple: burn a fixed list of templates,
        mint one target. No odds, no whitelist, no token cost, and a single
        <code>atomicassets::transfer</code> to sign. The recipe id IS the
        template it mints.
      </p>
      <div class="row" style="gap:14px; align-items: flex-end; margin-bottom: 8px">
        <div style="width: 140px; flex: 0 0 140px">
          <label>Collection</label>
          ${renderCollectionInput()}
        </div>
        <div style="flex: 1 1 380px; min-width: 280px">
          <label>Available recipes</label>
          <div class="picker blenderizer-picker">
            ${renderBlenderizerPickerToggle()}
            ${renderBlenderizerPickerPanel()}
          </div>
        </div>
        <button class="primary" data-action="refreshBlenderizer" ${bz.loading || !isValidWaxName(state.discoveryCollection) ? 'disabled' : ''}>
          ${escapeHtml(refreshLabel)}
        </button>
      </div>
      ${renderCollectionChips()}
      ${progressBar}
      <div class="row" style="margin-top:10px; gap:14px; align-items:center; flex-wrap:wrap">
        <label class="inline-toggle">
          <input id="blenderizerShowInactive" type="checkbox" data-action="toggleBlenderizerInactive" ${bz.showInactive ? 'checked' : ''} />
          <span>show sold-out recipes</span>
        </label>
        <div class="spacer"></div>
        <span class="term">${escapeHtml(counts)}</span>
      </div>
      ${renderBlenderizerLegend()}
      ${renderBlenderizerRamNotice()}
      ${session ? '' : '<p class="status-line term">Connect your wallet to match owned NFTs against each ingredient slot.</p>'}

      <div class="divider"></div>

      <label>Or enter a recipe id manually (= the target template_id)</label>
      <div class="row" style="gap:14px; align-items: flex-end">
        <div style="flex:1; min-width: 200px">
          <input id="blenderizerBlendIdInput" type="text" value="${escapeHtml(bz.blendIdInput)}" placeholder="e.g. 336429" autocomplete="off" />
        </div>
        <button class="primary" data-action="loadBlenderizerManual" ${bz.loading ? 'disabled' : ''}>
          ${bz.loading ? 'Loading…' : 'Load recipe'}
        </button>
      </div>
      ${bz.error ? `<p class="status-line warn">Discovery: ${escapeHtml(bz.error)}</p>` : ''}
    </div>`;
}

function renderBlenderizerInfo(): string {
  const bz = state.blenderizer;
  const b = bz.picked;
  if (!b) return '';
  const supply = b.target_max === undefined
    ? '<span class="term">unknown</span>'
    : b.target_max > 0
      ? `${b.target_issued} / ${b.target_max} <span class="term">(${Math.max(0, b.target_max - (b.target_issued ?? 0))} left to mint)</span>`
      : `${b.target_issued} / ∞`;
  const cost = b.slots.map((s) => {
    const nm = displayTemplateName(s.template_id, b.collection);
    const label = nm.startsWith('template #')
      ? `<code>template ${s.template_id}</code>`
      : `${escapeHtml(nm)} <code>#${s.template_id}</code>`;
    return `<li>Burn <strong>${s.amount}×</strong> ${label}</li>`;
  }).join('');
  const blockers = blenderizerBlockers(b)
    .map((x) => `<p class="status-line ${x.fatal ? 'err' : 'warn'}">${escapeHtml(x.message)}</p>`)
    .join('');
  return `
    <div class="card">
      <div class="card-header">
        <h2>3 · ${escapeHtml(blenderizerTitle(b))} <span class="term">-- #${escapeHtml(b.blend_id)} · ${escapeHtml(b.collection)}</span></h2>
        ${renderShareButton()}
      </div>
      <div class="row">
        <span class="status-chip status-${escapeHtml(blenderizerStatusClass(b.status))}">${escapeHtml(blenderizerStatusLabel(b.status))}</span>
        <span class="tag ok">deterministic · single output</span>
        <span class="tag">burns ${b.total_nfts} NFT${b.total_nfts === 1 ? '' : 's'}</span>
      </div>
      <h3>Expected mint</h3>
      <div class="mint-with-art">
        ${renderMediaThumb({ ref: b.image, alt: `${blenderizerTitle(b)} artwork` })}
        <div class="mint-with-art-body">
          <ul class="mint-info">
            <li><strong>Name:</strong> ${escapeHtml(b.name ?? '(unknown, indexer down)')}</li>
            <li><strong>Template:</strong> <code>${b.target}</code></li>
            ${b.schema_name ? `<li><strong>Schema:</strong> <code>${escapeHtml(b.schema_name)}</code></li>` : ''}
            <li><strong>Issued / max:</strong> ${supply}</li>
          </ul>
        </div>
      </div>
      <h3>Cost</h3>
      <ul class="mint-info">${cost}</ul>
      ${blockers}
      <p class="status-line term">Recipe registered by <code>${escapeHtml(b.owner)}</code>. One signature: a single <code>atomicassets::transfer</code> to <code>blenderizerx</code> with memo <code>${b.target}</code>.</p>
    </div>`;
}

function renderBlenderizerSlots(): string {
  const bz = state.blenderizer;
  const b = bz.picked;
  if (!b) return '';
  const slots = b.slots.map((slot) => {
    const owned = ownedAssetsForBlenderizerSlot(slot.template_id, b.collection);
    const picked = bz.selection.get(slot.index) ?? [];
    const nm = displayTemplateName(slot.template_id, b.collection);
    const label = nm.startsWith('template #')
      ? `template ${slot.template_id}`
      : `${nm} · template ${slot.template_id}`;
    const items = owned.map((a) => {
      const selected = picked.includes(a.asset_id) ? ' selected' : '';
      return `
        <div class="asset${selected}" data-action="pickBlenderizerAsset" data-blenderizer-slot="${slot.index}" data-asset="${escapeHtml(a.asset_id)}">
          <span>${escapeHtml(displayAssetName(a))}</span>
          <span class="id">#${escapeHtml(a.asset_id)}${a.template_mint ? ' · mint ' + escapeHtml(a.template_mint) : ''}</span>
        </div>`;
    });
    const short = owned.length < slot.amount;
    return `
      <div class="slot">
        <div class="slot-header">
          <div class="slot-label">${escapeHtml(label)} <span class="term">(${slot.amount}× required)</span></div>
          <div class="slot-progress">${picked.length}/${slot.amount} picked · ${owned.length} eligible</div>
        </div>
        ${owned.length === 0
          ? '<p class="status-line err">No eligible NFT in your wallet for this slot.</p>'
          : `${short ? `<p class="status-line err">You hold ${owned.length} of the ${slot.amount} needed for this slot.</p>` : ''}<div class="asset-grid">${items.join('')}</div>`}
      </div>`;
  }).join('');
  const totalPicked = [...bz.selection.values()].reduce((n, ids) => n + ids.length, 0);
  return `
    <div class="card">
      <h2>4 · Select inputs <span class="term">(${totalPicked}/${b.total_nfts} NFTs)</span></h2>
      ${slots}
    </div>`;
}

function renderBlenderizerActions(): string {
  const bz = state.blenderizer;
  const b = bz.picked;
  if (!b) return '';
  const ready = readyToBlenderizerBlend();
  const totalPicked = [...bz.selection.values()].reduce((n, ids) => n + ids.length, 0);
  return `
    <div class="card">
      <h2>5 · Verify &amp; execute</h2>
      <p class="status-line">One transaction, one action: <code>atomicassets::transfer</code> to <code>blenderizerx</code>. The contract mints the target and burns your deposit in the same transaction, so there is no waiting and no second signature.</p>
      <div class="row">
        <button data-action="blenderizerDryRun" ${ready ? '' : 'disabled'}>Simulate (no signature)</button>
        <button class="primary" data-action="blenderizerExecute" ${ready ? '' : 'disabled'}>${bz.pending ? 'Signing…' : 'Sign &amp; broadcast'}</button>
        <div class="spacer"></div>
        <span class="term">NFTs ${totalPicked}/${b.total_nfts}</span>
      </div>
      ${bz.lastDryRun
        ? `<h3>Dry-run output</h3><pre>${escapeHtml(JSON.stringify(bz.lastDryRun, null, 2))}</pre>`
        : ''}
      ${bz.lastTrxId
        ? `<p class="status-line ok">Trx broadcast: <a target="_blank" href="https://waxblock.io/transaction/${escapeHtml(bz.lastTrxId)}">${escapeHtml(bz.lastTrxId)}</a></p>`
        : ''}
    </div>`;
}

function renderBlenderizerBlendsView(): string {
  return (
    renderPickBlenderizer() +
    renderBlenderizerInfo() +
    renderBlenderizerSlots() +
    renderBlenderizerActions()
  );
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

  // Standalone contract-status page: a full-page view outside the platform
  // tabs. Works with no wallet; it only ever reads the chain.
  if (state.page === 'status') {
    rootEl().innerHTML = renderStatusPage();
    const refresh = document.getElementById('status-refresh');
    if (refresh) refresh.addEventListener('click', () => { void runStatusScan(render); });
    restoreRenderSnapshot(snap);
    return;
  }

  // Standalone collection catalogue: every contract's offering for one
  // collection, grouped by what the item is. Read-only; rows deep-link
  // back into the normal per-contract flow to sign.
  if (state.page === 'catalog') {
    rootEl().innerHTML = renderCatalogPage();
    attachCatalogHandlers();
    attachMediaFallbacks(rootEl());
    restoreRenderSnapshot(snap);
    return;
  }

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
            : state.view === 'blenderizer-blends'
              ? renderBlenderizerBlendsView()
              : renderWaxdaoBlendsView());
  attachHandlers();
  // Thumbnails only start loading here, after the markup is in the DOM,
  // so a render that produced no artwork costs no network at all.
  attachMediaFallbacks(rootEl());
  positionOpenPickers();
  restoreRenderSnapshot(snap);
}

/**
 * Wires the catalogue page. It renders standalone (outside the tab
 * grammar), so it gets its own handler pass rather than sharing the
 * app's big delegation block.
 *
 * Filters are pure client-side state over the already-scanned entries,
 * so they re-render instantly and never re-hit the chain. Only the
 * collection input triggers a new scan, and only on Enter/button.
 */
function attachCatalogHandlers() {
  const root = rootEl();

  const collection = document.getElementById('catalog-collection') as HTMLInputElement | null;
  if (collection) {
    collection.addEventListener('input', (e) => {
      setCatalogCollection((e.target as HTMLInputElement).value);
    });
    collection.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') void startCatalogScan();
    });
  }

  const refresh = document.getElementById('catalog-refresh');
  if (refresh) refresh.addEventListener('click', () => { void startCatalogScan(); });

  const search = document.getElementById('catalog-search') as HTMLInputElement | null;
  if (search) {
    search.addEventListener('input', (e) => {
      setCatalogSearch((e.target as HTMLInputElement).value);
      render();
    });
  }

  const onlyDoable = document.getElementById('catalog-only-doable') as HTMLInputElement | null;
  if (onlyDoable) {
    onlyDoable.addEventListener('change', () => {
      setCatalogOnlyDoable(onlyDoable.checked);
      render();
    });
  }

  const showInactive = document.getElementById('catalog-show-inactive') as HTMLInputElement | null;
  if (showInactive) {
    showInactive.addEventListener('change', () => {
      setCatalogShowInactive(showInactive.checked);
      render();
    });
  }

  root.querySelectorAll<HTMLElement>('[data-action]').forEach((el) => {
    el.addEventListener('click', () => {
      switch (el.dataset.action) {
        case 'catalogPickCollection':
          setCatalogCollection(el.dataset.collection ?? '');
          void startCatalogScan();
          break;
        case 'catalogGroupBy':
          setCatalogGrouping((el.dataset.grouping as CatalogGrouping) ?? 'category');
          render();
          break;
        case 'catalogToggleGroup':
          toggleCatalogGroup(el.dataset.group ?? '');
          render();
          break;
      }
    });
  });
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
      // Re-render so the "Discover" button's enabled state tracks what's
      // typed (it's gated on a valid name). Focus/caret are preserved by
      // the render snapshot, and discovery itself is still on-demand.
      render();
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
  // CREATE A BLEND panel inputs.
  const cbEnable = document.getElementById('createBlendEnable') as HTMLInputElement | null;
  if (cbEnable) {
    cbEnable.addEventListener('change', () => onToggleCreateBlendEnabled(cbEnable.checked));
  }
  const bindCb = (id: string, set: (v: string) => void, opts: { commit?: boolean } = {}) => {
    const el = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
    if (!el) return;
    el.addEventListener('input', (e) => {
      set((e.target as HTMLInputElement).value);
      // The panel shows live parse feedback, so it has to re-render as
      // the author types. Focus and caret survive via the render snapshot.
      render();
    });
    if (opts.commit) {
      // Collection changes trigger the authorization lookup on blur/Enter
      // rather than per keystroke.
      el.addEventListener('change', () => { void refreshCreateBlendAuth(); });
      el.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Enter') void refreshCreateBlendAuth();
      });
    }
  };
  bindCb('cbCollection', (v) => { state.createBlend.collection = v.trim().toLowerCase(); }, { commit: true });
  bindCb('cbName', (v) => { state.createBlend.name = v; });
  bindCb('cbImage', (v) => { state.createBlend.image = v; });
  bindCb('cbDescription', (v) => { state.createBlend.description = v; });
  bindCb('cbCategory', (v) => { state.createBlend.category = v; });
  bindCb('cbIngredients', (v) => { state.createBlend.ingredientsInput = v; });
  bindCb('cbOutcomes', (v) => { state.createBlend.outcomesInput = v; });
  bindCb('cbStart', (v) => { state.createBlend.startTime = v; });
  bindCb('cbEnd', (v) => { state.createBlend.endTime = v; });
  bindCb('cbMaxUses', (v) => { state.createBlend.maxUses = v; });
  bindCb('cbAccountLimit', (v) => { state.createBlend.accountLimit = v; });
  bindCb('cbCooldown', (v) => { state.createBlend.cooldown = v; });
  bindCb('cbSecurityId', (v) => { state.createBlend.securityId = v; });
  const cbHidden = document.getElementById('cbHidden') as HTMLInputElement | null;
  if (cbHidden) cbHidden.addEventListener('change', () => { state.createBlend.hidden = cbHidden.checked; render(); });

  // BLENDERIZER tab inputs.
  const blenderizerIdInput = document.getElementById('blenderizerBlendIdInput') as HTMLInputElement | null;
  if (blenderizerIdInput) {
    blenderizerIdInput.addEventListener('input', (e) => {
      state.blenderizer.blendIdInput = (e.target as HTMLInputElement).value.trim();
    });
    blenderizerIdInput.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') void onLoadBlenderizerBlendManual();
    });
  }
  const toggleBlenderizerInactive = document.getElementById('blenderizerShowInactive') as HTMLInputElement | null;
  if (toggleBlenderizerInactive) {
    toggleBlenderizerInactive.addEventListener('change', () =>
      onToggleBlenderizerShowInactive(toggleBlenderizerInactive.checked),
    );
  }
  // BLEND admin (Manage section) inputs.
  const manageEnable = document.getElementById('manageEnable') as HTMLInputElement | null;
  if (manageEnable) {
    manageEnable.addEventListener('change', () => onToggleManageEnabled(manageEnable.checked));
  }
  const bindManageText = (id: string, set: (v: string) => void) => {
    const el = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
    if (el) el.addEventListener('input', (e) => set((e.target as HTMLInputElement).value));
  };
  bindManageText('manageName', (v) => { state.manage.newNameInput = v; });
  bindManageText('manageMax', (v) => { state.manage.newMaxInput = v; });
  bindManageText('manageLimit', (v) => { state.manage.newLimitInput = v; });
  bindManageText('manageCooldown', (v) => { state.manage.newCooldownInput = v; });
  bindManageText('manageNewWl', (v) => { state.manage.newWhitelistName = v; });
  bindManageText('manageAddAccounts', (v) => { state.manage.addAccountsInput = v; });
  const manageWlSelect = document.getElementById('manageWlSelect') as HTMLSelectElement | null;
  if (manageWlSelect) {
    manageWlSelect.addEventListener('change', () => { void onManageSelectSecurity(manageWlSelect.value); });
  }

  // CREATE-DROP panel (CLAIM/drops tab) inputs.
  const bindCreateText = (id: string, set: (v: string) => void) => {
    const el = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
    if (el) el.addEventListener('input', (e) => set((e.target as HTMLInputElement).value));
  };
  const createEnable = document.getElementById('createEnable') as HTMLInputElement | null;
  if (createEnable) createEnable.addEventListener('change', () => onToggleCreateEnabled(createEnable.checked));
  const createCollection = document.getElementById('createCollection') as HTMLInputElement | null;
  if (createCollection) {
    createCollection.addEventListener('input', (e) => { state.createDrop.collection = (e.target as HTMLInputElement).value; });
    // Auth lookup on blur (avoids one RPC per keystroke).
    createCollection.addEventListener('change', () => { void refreshCreateDropAuth(); });
  }
  bindCreateText('createName', (v) => { state.createDrop.name = v; });
  bindCreateText('createDescription', (v) => { state.createDrop.description = v; });
  bindCreateText('createImage', (v) => { state.createDrop.image = v; });
  const createTemplates = document.getElementById('createTemplates') as HTMLTextAreaElement | null;
  if (createTemplates) {
    createTemplates.addEventListener('input', (e) => { state.createDrop.templatesInput = (e.target as HTMLTextAreaElement).value; });
    // Refresh the parsed-count preview when the author clicks away.
    createTemplates.addEventListener('change', () => render());
  }
  bindCreateText('createPriceAmount', (v) => { state.createDrop.priceAmount = v; });
  bindCreateText('createPriceToken', (v) => { state.createDrop.priceToken = v; });
  bindCreateText('createPriceDecimals', (v) => { state.createDrop.priceDecimals = v; });
  bindCreateText('createMax', (v) => { state.createDrop.maxClaimable = v; });
  bindCreateText('createAccountLimit', (v) => { state.createDrop.accountLimit = v; });
  bindCreateText('createCooldown', (v) => { state.createDrop.cooldown = v; });
  bindCreateText('createRecipient', (v) => { state.createDrop.priceRecipient = v; });
  bindCreateText('createStart', (v) => { state.createDrop.startTime = v; });
  bindCreateText('createEnd', (v) => { state.createDrop.endTime = v; });
  const bindCreateToggle = (id: string, set: (b: boolean) => void) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.addEventListener('change', () => { set(el.checked); render(); });
  };
  bindCreateToggle('createFree', (b) => { state.createDrop.free = b; });
  bindCreateToggle('createUnlimited', (b) => { state.createDrop.unlimited = b; });
  bindCreateToggle('createAuthReq', (b) => { state.createDrop.authRequired = b; });
  bindCreateToggle('createHidden', (b) => { state.createDrop.hidden = b; });
  bindCreateToggle('createCC', (b) => { state.createDrop.allowCreditCard = b; });

  // MANAGE-DROP panel inputs.
  const manageDropEnable = document.getElementById('manageDropEnable') as HTMLInputElement | null;
  if (manageDropEnable) manageDropEnable.addEventListener('change', () => onToggleManageDropEnabled(manageDropEnable.checked));
  bindCreateText('manageDropId', (v) => { state.manageDrop.dropIdInput = v; });
  bindCreateText('manageDropAddAccounts', (v) => { state.manageDrop.addAccountsInput = v; });
  const myDropsSelect = document.getElementById('myDropsSelect') as HTMLSelectElement | null;
  if (myDropsSelect) myDropsSelect.addEventListener('change', () => onPickMyDrop(myDropsSelect.value));

  rootEl().querySelectorAll<HTMLElement>('[data-action]').forEach((el) => {
    const action = el.dataset.action;
    // These actions are wired via 'change' listeners above, not click.
    if (
      action === 'toggleInactive' ||
      action === 'toggleOnlyExecutable' ||
      action === 'toggleDropInactive' ||
      action === 'toggleDropOnlyEligible' ||
      action === 'toggleUpgradesInactive' ||
      action === 'toggleWaxdaoInactive' ||
      action === 'toggleBlenderizerInactive' ||
      action === 'toggleManageEnable' ||
      action === 'toggleCreateEnable' ||
      action === 'toggleCreateBlendEnable' ||
      action === 'toggleCreateFree' ||
      action === 'toggleCreateUnlimited' ||
      action === 'toggleCreateAuthReq' ||
      action === 'toggleCreateHidden' ||
      action === 'toggleCreateCC' ||
      action === 'toggleManageDropEnable'
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
        case 'pickUpgradeCostAsset':
          onPickUpgradeCostAsset(Number(el.dataset.cost), el.dataset.asset ?? '');
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
        case 'refreshBlenderizer':
          void loadBlenderizerList();
          break;
        case 'toggleBlenderizerPicker':
          onToggleBlenderizerPicker();
          break;
        case 'pickBlenderizerBlend':
          void onPickBlenderizerBlend(el.dataset.blenderizerBlend ?? '');
          break;
        case 'loadBlenderizerManual':
          void onLoadBlenderizerBlendManual();
          break;
        case 'pickBlenderizerAsset':
          onPickBlenderizerAsset(Number(el.dataset.blenderizerSlot), el.dataset.asset ?? '');
          break;
        case 'blenderizerDryRun':
          void onBlenderizerDryRun();
          break;
        case 'blenderizerExecute':
          void onExecuteBlenderizerBlend();
          break;
        case 'manageHide':
          onManageHide(true);
          break;
        case 'manageUnhide':
          onManageHide(false);
          break;
        case 'manageEndNow':
          onManageEndNow();
          break;
        case 'manageSetName':
          onManageSetName();
          break;
        case 'manageSetMax':
          onManageSetMax();
          break;
        case 'manageSetLimits':
          onManageSetLimits();
          break;
        case 'manageAttachSecurity':
          onManageAttachSecurity();
          break;
        case 'manageCreateWhitelist':
          onManageCreateWhitelist();
          break;
        case 'manageAddAccounts':
          onManageAddAccounts();
          break;
        case 'manageRemoveAccount':
          onManageRemoveAccount(el.dataset.account ?? '');
          break;
        case 'manageClearWhitelist':
          onManageClearWhitelist();
          break;
        case 'manageDelete':
          onManageDelete();
          break;
        case 'createBlendDryRun':
          void onCreateBlendDryRun();
          break;
        case 'createBlendSubmit':
          void onCreateBlendSubmit();
          break;
        case 'createDropSubmit':
          void onCreateDrop();
          break;
        case 'manageDropLoad':
          onManageDropLoad();
          break;
        case 'findMyDrops':
          void onFindMyDrops();
          break;
        case 'manageDropAddAccounts':
          onManageDropAddAccounts();
          break;
        case 'manageDropRemoveAccount':
          onManageDropRemoveAccount(el.dataset.account ?? '');
          break;
        case 'manageDropClearWhitelist':
          onManageDropClearWhitelist();
          break;
        case 'manageDropToggleAuth':
          onManageDropToggleAuth();
          break;
        case 'manageDropToggleHidden':
          onManageDropToggleHidden();
          break;
        case 'manageDropDelete':
          onManageDropDelete();
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
      if (r.page !== state.page) {
        state.page = r.page;
        mutated = true;
        if (r.page === 'status') maybeScanStatus();
        if (r.page === 'catalog') maybeScanCatalog(r.id);
      } else if (r.page === 'catalog') {
        // Same page, different collection in the hash: switch to it.
        maybeScanCatalog(r.id);
      }
      // Platform/tab/deep-link only matter for the normal app page.
      if (r.page === 'app') {
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
      }
      if (mutated) {
        render();
        if (r.page === 'app') void applyPendingDeepLink();
      }
    });
    // Normalise the hash on first load (write back the canonical form
    // so a refresh keeps you exactly where you were). Standalone pages
    // (e.g. #/status) sit outside the platform/tab grammar, so leave their
    // hash untouched rather than rewriting it to a default tab.
    const r0 = parseHashRoute();
    if (r0.page === 'app') writeHashRoute(r0.platform, r0.view, r0.id);
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
  // Clear the boot status: no idle "Ready" line under Connect-wallet, and no
  // banner. The empty picker (placeholder + Discover button) is guidance enough.
  state.status = '';
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
  // Direct landing on #/status (bookmark / shared link): start the scan.
  if (state.page === 'status') maybeScanStatus();
  // Same for #/catalog/<collection>.
  if (state.page === 'catalog') maybeScanCatalog(parseHashRoute().id);
}
