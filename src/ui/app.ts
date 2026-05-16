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
import { dryRunActions } from './dryrun';
import { renderAboutPanels } from './about';

type AppView = 'blends' | 'drops';

const COLLECTION_STORAGE_KEY = 'crucible.collection';
const DEFAULT_COLLECTION = 'underpunks55';

function loadStoredCollection(): string {
  try {
    const v = localStorage.getItem(COLLECTION_STORAGE_KEY);
    if (v && (SUPPORTED_COLLECTIONS as readonly string[]).includes(v)) return v;
  } catch {/* localStorage unavailable */}
  return DEFAULT_COLLECTION;
}
function persistCollection(v: string) {
  try { localStorage.setItem(COLLECTION_STORAGE_KEY, v); } catch {/* ignore */}
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
  showInactive: boolean;
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
  discoveryCollection: loadStoredCollection(),
  discoveryLoading: true,
  showInactive: false,
  pickerOpen: false,
  view: 'blends',
  drops: [],
  dropsLoading: false,
  dropId: '',
  dropPickerOpen: false,
  dropAmount: 1,
  dropTemplateLoading: false,
  dropLoading: false,
  dropShowInactive: false,
};

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

async function loadDiscovered() {
  state.discoveryLoading = true;
  state.discoveryError = undefined;
  state.discoverySource = undefined;
  state.discoveryProgress = undefined;
  render();
  try {
    const session = getCurrentSession();
    const { blends, source } = await listBlends({
      collection: state.discoveryCollection,
      includeInactive: state.showInactive,
      actor: session ? String(session.actor) : undefined,
      onProgress: (p) => {
        state.discoverySource = p.source;
        state.discoveryProgress = { pct: p.progress, message: p.message };
        render();
      },
    });
    state.discovered = blends;
    state.discoverySource = source;
  } catch (err) {
    state.discoveryError = (err as Error).message;
    state.discovered = [];
  } finally {
    state.discoveryLoading = false;
    state.discoveryProgress = undefined;
    render();
  }
}

function onToggleShowInactive(checked: boolean) {
  state.showInactive = checked;
  loadDiscovered();
}

function onChangeCollection(name: string) {
  if (state.discoveryCollection === name) return;
  state.discoveryCollection = name;
  persistCollection(name);
  // Clear loaded blend & drop — they're tied to the previous collection.
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
  state.drops = [];
  loadDiscovered();
  if (state.view === 'drops') loadDropsList();
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
  let mutated = false;
  if (state.pickerOpen && (!target || !target.closest('.picker'))) {
    state.pickerOpen = false;
    mutated = true;
  }
  if (state.dropPickerOpen && (!target || !target.closest('.drop-picker'))) {
    state.dropPickerOpen = false;
    mutated = true;
  }
  if (mutated) render();
}

// ─── drops view handlers ──────────────────────────────────────────────── //

function onSwitchView(v: AppView) {
  if (state.view === v) return;
  state.view = v;
  // Lazy-load drops the first time the user switches.
  if (v === 'drops' && state.drops.length === 0 && !state.dropsLoading && !state.dropsError) {
    loadDropsList();
  }
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
  } catch (err) {
    state.dropsError = (err as Error).message;
    state.drops = [];
  } finally {
    state.dropsLoading = false;
    state.dropsProgress = undefined;
    render();
  }
}

function onToggleDropShowInactive(checked: boolean) {
  state.dropShowInactive = checked;
  loadDropsList();
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
  // Otherwise fetch it ad-hoc — useful for drops from other collections or
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
    // Try to find by id — fall back to a direct chain read if absent.
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
      ok ? `Simulation OK — ${actions.length} action(s) serialize cleanly.` : 'Simulation failed for at least one action.',
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

    const det = isDeterministic(state.blend);
    if (!det.ok) {
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

    state.blendLoading = false; // header info is enough to show — keep skeletons for assets/template
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
        ? `Simulation OK — ${actions.length} action(s) serialize cleanly.`
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

// ─── render ───────────────────────────────────────────────────────────── //

function renderConnect(session: ReturnType<typeof getCurrentSession>): string {
  if (!session) {
    return `
      <div class="card">
        <h2>1 · Connect wallet</h2>
        <p class="term">Anchor or WAX Cloud Wallet. No backend — your key stays in your wallet.</p>
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

function renderCollectionSelector(): string {
  const opts = SUPPORTED_COLLECTIONS.map((c) => {
    const selected = state.discoveryCollection === c ? ' selected' : '';
    return `<option value="${escapeHtml(c)}"${selected}>${escapeHtml(c)}</option>`;
  }).join('');
  return `<select id="collectionPick">${opts}</select>`;
}

function renderPickerToggle(): string {
  let label = 'Select a blend…';
  if (state.blend) {
    label = `[#${state.blend.blend_id}] ${state.blend.collection_name}`;
  } else if (state.discoveryLoading) {
    label = state.discoveryProgress?.message ?? 'Loading blends…';
  } else if (state.discoveryError) {
    label = 'Discovery failed — use manual entry below';
  } else if (state.discovered.length === 0) {
    label = `No blends found for ${state.discoveryCollection}`;
  } else {
    const found = state.discovered.find((b) => b.blend_id === state.blendId);
    if (found) label = `[#${found.blend_id}] ${found.name}`;
  }
  return `
    <button class="picker-toggle" data-action="togglePicker" ${state.discoveryLoading || state.discoveryError ? 'disabled' : ''}>
      <span class="picker-current">${escapeHtml(label)}</span>
      <span class="picker-caret">${state.pickerOpen ? '▴' : '▾'}</span>
    </button>`;
}

function renderPickerPanel(): string {
  if (!state.pickerOpen || state.discoveryLoading || state.discoveryError) return '';
  if (state.discovered.length === 0) {
    return `<div class="picker-panel"><div class="picker-empty">No blends found.</div></div>`;
  }
  const rows = state.discovered
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
      return `
        <div class="${classes.join(' ')}" ${disabled ? '' : `data-action="pickRow" data-blend="${escapeHtml(b.blend_id)}"`}>
          <span class="picker-id">#${escapeHtml(b.blend_id)}</span>
          <span class="picker-name">${escapeHtml(b.name)}</span>
          ${wlBadge}
          <span class="status-chip status-${escapeHtml(b.status)}">${escapeHtml(statusLabel(b.status))}</span>
        </div>`;
    })
    .join('');
  return `<div class="picker-panel"><div class="picker-rows">${rows}</div></div>`;
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
      <span class="legend-item legend-disabled">
        <span class="legend-disabled-swatch"></span>
        greyed = you're not whitelisted for that blend
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

  return `
    <div class="card">
      <h2>2 · Pick a blend</h2>
      <div class="row" style="gap:14px; align-items: flex-end; margin-bottom: 10px">
        <div style="min-width: 220px">
          <label>Collection</label>
          ${renderCollectionSelector()}
        </div>
        <div style="flex:1; min-width: 220px">
          <label>Available blends</label>
          <div class="picker">
            ${renderPickerToggle()}
            ${renderPickerPanel()}
          </div>
        </div>
      </div>
      ${progressBar}
      <div class="row" style="margin-top:10px; gap:14px; align-items:center">
        <label class="inline-toggle">
          <input id="showInactive" type="checkbox" data-action="toggleInactive" ${state.showInactive ? 'checked' : ''} />
          <span>show ended / upcoming / sold-out</span>
        </label>
        <div class="spacer"></div>
        ${sourceTag}
        <span class="term">${escapeHtml(counts)}</span>
      </div>
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
      <p class="status-line">Reading the recipe from <code>blend.nefty</code> — this may take a few seconds, especially if the indexer is down and we're scanning the chain directly.</p>
    </div>`;
}

function renderExpectedMint(): string {
  const b = state.blend;
  if (!b) return '';
  const results = deterministicResults(b);
  if (results.length === 0) {
    return '<p class="status-line warn">No on-demand mint result — output may be empty or out of this app\'s scope.</p>';
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
    const name = t?.name ?? '(unknown — indexer down, name not on-chain readable)';
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
    ? `<p class="term">+ ${results.length - 1} additional mint(s) — IDs: ${results.slice(1).map((r) => `<code>${r.template_id}</code>`).join(', ')}</p>`
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
      <h2>3 · Blend #${escapeHtml(String(b.blend_id))} <span class="term">— ${escapeHtml(b.collection_name)}</span></h2>
      <div class="row">
        ${det.ok ? '<span class="tag ok">deterministic</span>' : '<span class="tag err">non-deterministic</span>'}
        ${
          wl?.required
            ? wl.allowed
              ? '<span class="tag ok">whitelist · allowed</span>'
              : '<span class="tag err">whitelist · denied</span>'
            : '<span class="tag">open · no whitelist</span>'
        }
        <span class="tag">uses ${escapeHtml(remainingUses)}</span>
      </div>
      <h3>Expected mint</h3>
      ${renderExpectedMint()}
      ${wl?.required && !wl.allowed ? `<p class="status-line err">${escapeHtml(wl.reason ?? '')}</p>` : ''}
    </div>
  `;
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
    const name = a.name ?? a.template?.template_id ?? 'asset';
    return `
      <div class="asset${selected}" data-action="toggle" data-slot="${slot.index}" data-asset="${escapeHtml(a.asset_id)}">
        <span>${escapeHtml(String(name))}</span>
        <span class="id">#${escapeHtml(a.asset_id)}</span>
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
          ? `<p class="status-line ok">Trx broadcast: <a target="_blank" href="https://wax.bloks.io/transaction/${escapeHtml(state.lastTrxId)}">${escapeHtml(state.lastTrxId)}</a></p>`
          : ''
      }
    </div>`;
}

function renderStatus(): string {
  if (!state.status) return '';
  return `<p class="status-line ${state.statusKind}">${escapeHtml(state.status)}</p>`;
}

function renderTabs(): string {
  const tab = (id: AppView, label: string, sub: string) => {
    const active = state.view === id ? ' active' : '';
    return `
      <button class="tab${active}" data-action="switchView" data-view="${id}">
        <span class="tab-label">${escapeHtml(label)}</span>
        <span class="tab-sub">${escapeHtml(sub)}</span>
      </button>`;
  };
  return `
    <div class="card tabs-card">
      <div class="tabs">
        ${tab('blends', 'Blend', 'burn NFTs → mint result')}
        ${tab('drops',  'Claim', 'pay (or not) → mint a drop')}
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
  let label = 'Select a drop…';
  if (state.drop) label = `[#${state.drop.drop_id}] ${state.drop.name}`;
  else if (state.dropsLoading) label = state.dropsProgress?.message ?? 'Scanning drops…';
  else if (state.dropsError) label = 'Discovery failed';
  else if (state.drops.length === 0) label = `No drops found for ${state.discoveryCollection}`;
  return `
    <button class="picker-toggle" data-action="toggleDropPicker" ${state.dropsLoading || state.dropsError ? 'disabled' : ''}>
      <span class="picker-current">${escapeHtml(label)}</span>
      <span class="picker-caret">${state.dropPickerOpen ? '▴' : '▾'}</span>
    </button>`;
}

function renderDropPickerPanel(): string {
  if (!state.dropPickerOpen || state.dropsLoading || state.dropsError) return '';
  if (state.drops.length === 0) {
    return `<div class="picker-panel"><div class="picker-empty">No drops found.</div></div>`;
  }
  const rows = state.drops
    .map((d) => {
      const wlDenied = d.auth.kind === 'whitelist' && d.auth.allowed === false;
      const proofNotMet = d.auth.kind === 'proof' && d.auth.resolved && !d.auth.resolved.satisfied;
      const authkey = d.auth.kind === 'authkey';
      const unclaimable = d.auth.kind === 'unclaimable';
      const unverified = d.auth.kind === 'unverified';
      const limitReached = d.account_remaining === 0;
      const disabled = wlDenied || proofNotMet || authkey || unclaimable || limitReached;
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
      return `
        <div class="${classes.join(' ')}" ${disabled ? '' : `data-action="pickDrop" data-drop="${escapeHtml(d.drop_id)}"`}>
          <span class="picker-id">#${escapeHtml(d.drop_id)}</span>
          <span class="picker-name">${escapeHtml(d.name)}</span>
          ${priceTag}
          ${wlBadge}
          <span class="status-chip status-${escapeHtml(d.status)}">${escapeHtml(dropStatusLabel(d.status))}</span>
        </div>`;
    })
    .join('');
  return `<div class="picker-panel"><div class="picker-rows">${rows}</div></div>`;
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
      <span class="legend-item legend-disabled">
        <span class="legend-disabled-swatch"></span>
        greyed = whitelist, NFT proof, key-gated, or per-account limit reached
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

  return `
    <div class="card">
      <h2>2 · Pick a drop</h2>
      <div class="row" style="gap:14px; align-items: flex-end; margin-bottom: 10px">
        <div style="min-width: 220px">
          <label>Collection</label>
          ${renderCollectionSelector()}
        </div>
        <div style="flex:1; min-width: 220px">
          <label>Available drops</label>
          <div class="picker drop-picker">
            ${renderDropPickerToggle()}
            ${renderDropPickerPanel()}
          </div>
        </div>
      </div>
      ${progressBar}
      <div class="row" style="margin-top:10px; gap:14px; align-items:center">
        <label class="inline-toggle">
          <input id="dropShowInactive" type="checkbox" data-action="toggleDropInactive" ${state.dropShowInactive ? 'checked' : ''} />
          <span>show ended / upcoming / sold-out</span>
        </label>
        <div class="spacer"></div>
        ${sourceTag}
        <span class="term">${escapeHtml(counts)}</span>
      </div>
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
      return `<p class="status-line err">This drop has <code>auth_required = true</code> but every on-chain gate (whitelist, NFT proof, authkey) is empty. The contract will refuse every claim until the drop creator populates one. There is nothing you or this app can do — try reaching out to the collection.</p>`;
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
      return '<p class="status-line err">You already hit this drop\'s per-account limit. There is no cooldown — you can\'t claim it again.</p>';
    }
    const wait = d.cooldown_resets_at - Math.floor(Date.now() / 1000);
    if (wait <= 0) {
      return '<p class="status-line warn">Cooldown should have just expired — reload the list to re-check.</p>';
    }
    return `<p class="status-line warn">You hit this drop's per-account limit. Cooldown resets in <strong>${escapeHtml(formatHumanDuration(wait))}</strong>.</p>`;
  })();
  const noSessionHint = !session && d.account_limit > 0
    ? '<p class="term">Connect your wallet to check how many claims you have left on this drop.</p>'
    : '';
  return `
    <div class="card">
      <h2>3 · Drop #${escapeHtml(d.drop_id)} <span class="term">— ${escapeHtml(d.collection_name)}</span></h2>
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
      ${d.auth.kind === 'proof' && d.auth.resolved
        ? `<h3>Proof of ownership</h3>
           <p class="term">The contract will check that you hold ${d.auth.filters.length} specific NFT(s). The page auto-selected ${d.auth.resolved.asset_ids.length} matching asset(s) from your wallet:</p>
           <ul class="mint-info">${d.auth.resolved.asset_ids.map((id) => `<li><code>${escapeHtml(id)}</code></li>`).join('')}</ul>`
        : ''
      }
      ${d.description ? `<details style="margin-top:12px"><summary class="term" style="cursor:pointer">drop description</summary><p style="margin-top:8px; font-size:12px; color:var(--fg-dim)">${escapeHtml(d.description)}</p></details>` : ''}
    </div>`;
}

function renderDropActions(): string {
  const d = state.drop;
  if (!d) return '';
  const ready = readyToClaim();
  return `
    <div class="card">
      <h2>4 · Verify &amp; claim</h2>
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
        ? `<p class="status-line ok">Trx broadcast: <a target="_blank" href="https://wax.bloks.io/transaction/${escapeHtml(state.dropLastTrxId)}">${escapeHtml(state.dropLastTrxId)}</a></p>`
        : ''}
    </div>`;
}

function renderBlendsView(): string {
  return renderPickBlend() + renderBlendInfo() + renderSlots() + renderActions();
}

function renderDropsView(): string {
  return renderPickDrop() + renderDropInfo() + renderDropActions();
}

function render() {
  const session = getCurrentSession();
  rootEl().innerHTML =
    renderAboutPanels() +
    renderConnect(session) +
    renderStatus() +
    renderTabs() +
    (state.view === 'blends' ? renderBlendsView() : renderDropsView());
  attachHandlers();
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

  const collectionSel = document.getElementById('collectionPick') as HTMLSelectElement | null;
  if (collectionSel) {
    collectionSel.addEventListener('change', () => onChangeCollection(collectionSel.value));
  }
  const toggleInactive = document.getElementById('showInactive') as HTMLInputElement | null;
  if (toggleInactive) {
    toggleInactive.addEventListener('change', () => onToggleShowInactive(toggleInactive.checked));
  }
  const toggleDropInactive = document.getElementById('dropShowInactive') as HTMLInputElement | null;
  if (toggleDropInactive) {
    toggleDropInactive.addEventListener('change', () => onToggleDropShowInactive(toggleDropInactive.checked));
  }
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

  rootEl().querySelectorAll<HTMLElement>('[data-action]').forEach((el) => {
    const action = el.dataset.action;
    if (action === 'toggleInactive') return; // handled via change listener above
    el.addEventListener('click', (ev) => {
      switch (action) {
        case 'login':
          login()
            .then(() => {
              // Re-run both discoveries: blends pick up whitelist info,
              // drops pick up per-account remaining counts.
              loadDiscovered();
              if (state.drops.length > 0 || state.view === 'drops') loadDropsList();
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
            loadDiscovered();
            if (state.view === 'drops') loadDropsList();
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
      }
      ev.stopPropagation();
    });
  });
}

let outsideClickAttached = false;

export async function mount() {
  if (!outsideClickAttached) {
    document.addEventListener('click', onPickerOutsideClick);
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
  setStatus('Ready.', 'ok');
  render();
  // Kick off discovery in the background — UI re-renders when it lands.
  loadDiscovered();
}
