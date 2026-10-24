/**
 * The contract monitor, as a page of v2.
 * ─────────────────────────────────────────────────────────────
 * Crucible trusts contracts it checked once. This page says whether each of
 * them is still the contract that was checked: its code against the
 * fingerprint taken then (the baseline, ui/status.ts, which also scores the
 * health), whether it is still in use, and who could change it.
 *
 * Beyond the classic page:
 *   - who can redeploy the code: the permission linked to eosio::setcode
 *     when there is one (blend.nefty and up.nefty have a `deploy` key),
 *     else `active`, read from the account itself
 *   - activity over the last 24 hours, and the last action's transaction
 *   - what Crucible uses the contract for, with the pages that depend on it
 *   - when the code moved from its baseline, what moved, and how:
 *       the block of the change, found from last_code_update by walking
 *         get_block on the block's own timestamp (the chain does not make
 *         exactly two blocks a second over months; one or two hops land it)
 *       the transaction that deployed it and who signed it, or the
 *         multisig proposal it went through (atomicassets, 2026-09-10:
 *         eosio.msig::exec of atomic/aa.caa)
 *       the interface before and after: actions and tables added or
 *         removed, and the fields of those whose shape changed, from the
 *         history servers' ABI snapshot at the block before. When they hold
 *         no earlier ABI (atomicassets' dates from 2020), it says so.
 *     Hyperion does not index setcode, hence the block walk. These reads
 *     run by themselves only for a contract whose code moved, and on demand
 *     for the others, so a scan stays light on the public nodes.
 *
 * History goes to eosusa then waxsweden; blocks to greymass, then eosphere,
 * the one that still serves blocks from 2025.
 */
import type { APIClient } from '@wharfkit/session';

import { getAccountInfo, getCodeHash, withFailover } from '../chain/rpc';
import {
  CONTRACTS, SILENT_AFTER_DAYS, isZeroHash, parseChainDateMs, score,
  type ContractHealth, type ContractSpec, type Severity,
} from '../ui/status';

const HISTORY = ['https://wax.eosusa.io', 'https://api.waxsweden.org'];
/**
 * An empty answer is not proof of silence: eosusa holds no history at all
 * for redeem.nefty or buildawaxdao, which EOSphere still has from 2023. So
 * a last action nobody returned is asked of the next server, EOSphere last,
 * which only these few contracts ever reach.
 */
const HISTORY_FOR_EMPTY = [...HISTORY, 'https://wax.eosphere.io'];
const BLOCKS = ['https://wax.greymass.com', 'https://wax.eosphere.io'];
const GROUPS: ContractSpec['group'][] = ['NeftyBlocks', 'WaxDAO', 'Blenderizer', 'Infrastructure'];
const DEFAULT_BASELINE_AT = '2026-06-28';

/** What Crucible does with each contract, and where. */
const USES: Record<string, { label: string; href: string }[]> = {
  'blend.nefty': [{ label: 'Blend NFTs', href: '#/use' }, { label: 'Create a blend', href: '#/create' }],
  neftyblocksd: [{ label: 'Claim a drop', href: '#/use' }, { label: 'Create a drop', href: '#/create' }],
  neftyblocksp: [{ label: 'Open a pack', href: '#/use' }],
  'up.nefty': [{ label: 'Upgrade an NFT', href: '#/use' }, { label: 'Create an upgrade', href: '#/create' }],
  'secure.nefty': [{ label: 'Whitelists and holder gates', href: '#/guide/create' }],
  'stake.nefty': [{ label: 'Staking', href: '#/stake' }],
  'fees.nefty': [{ label: 'Receives the upgrade fee', href: '#/guide/upgrades' }],
  waxdaomarket: [{ label: 'WaxDAO blends', href: '#/use' }, { label: 'Staking (market balances)', href: '#/stake' }],
  waxdaofarmer: [{ label: 'Staking (farms and pools)', href: '#/stake' }],
  'farms.waxdao': [{ label: 'Staking (farms v2)', href: '#/stake' }],
  'tf.waxdao': [{ label: 'Staking (token farms)', href: '#/stake' }],
  waxdaolocker: [{ label: 'Staking (token locks)', href: '#/stake' }],
  waxdaobacker: [{ label: 'Staking (backed tokens)', href: '#/stake' }],
  'dao.waxdao': [{ label: 'Staking (DAO stakes)', href: '#/stake' }],
  blenderizerx: [{ label: 'Blenderizer blends', href: '#/use' }],
  atomicassets: [{ label: 'Every NFT read or moved', href: '#/nfts' }],
  atomicpacksx: [{ label: 'Open a pack', href: '#/use' }],
  'orng.wax': [{ label: 'Random blends and packs', href: '#/guide/blends' }],
  eosio: [{ label: 'WAX names', href: '#/names' }],
  'setup.nefty': [{ label: 'Delivers random results', href: '#/guide/blends' }],
};

/** Who can change the code: one permission, as the account states it. */
interface Controller {
  permission: string;
  /** Linked to setcode itself, rather than falling back to active. */
  linked: boolean;
  threshold: number;
  keys: number;
  accounts: string[];
}

interface CodeHistory {
  block: number;
  /** The transaction in that block that deployed the code, when found. */
  trx?: string;
  signers: string[];
  /** When it went through a multisig proposal. */
  proposal?: { proposer: string; name: string; executer: string };
  abi: AbiDiff | 'unknown';
}

interface AbiDiff {
  actionsAdded: string[];
  actionsRemoved: string[];
  tablesAdded: string[];
  tablesRemoved: string[];
  /** Action or table name -> fields added and removed. */
  reshaped: { name: string; added: string[]; removed: string[] }[];
}

interface Row extends ContractHealth {
  controller?: Controller;
  lastActionTrx?: string;
  /** Actions involving it in the last 24 hours; `capped` past the indexer's 10,000. */
  day?: { count: number; capped: boolean };
  history?: CodeHistory | 'loading' | { error: string };
}

const state: { rows: Map<string, Row>; scanning: boolean; scannedAt?: number; onlyIssues: boolean } =
  { rows: new Map(), scanning: false, onlyIssues: false };

// ─── reading ────────────────────────────────────────────────────────────

async function history<T>(path: string): Promise<T> {
  let last: unknown;
  for (const host of HISTORY) {
    try {
      const r = await fetch(`${host}${path}`, { signal: AbortSignal.timeout(12_000) });
      if (r.ok) return (await r.json()) as T;
      last = new Error(`HTTP ${r.status} from ${host}`);
    } catch (e) { last = e; }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

type RawPermission = {
  perm_name: string;
  required_auth: { threshold: number; keys: unknown[]; accounts: { permission: { actor: string; permission: string } }[] };
  linked_actions?: { account: string; action?: string }[];
};

function controllerOf(perms: RawPermission[] | undefined): Controller | undefined {
  if (!perms?.length) return undefined;
  const linked = perms.find((p) => (p.linked_actions ?? []).some((l) => l.account === 'eosio' && l.action === 'setcode'));
  const p = linked ?? perms.find((x) => x.perm_name === 'active');
  if (!p) return undefined;
  return {
    permission: p.perm_name,
    linked: Boolean(linked),
    threshold: Number(p.required_auth.threshold),
    keys: p.required_auth.keys.length,
    accounts: p.required_auth.accounts
      .map((a) => `${a.permission.actor}@${a.permission.permission}`)
      // A contract lists itself (@eosio.code) to send inline actions: that is not a person.
      .filter((a) => !a.endsWith('@eosio.code')),
  };
}

type RawAction = { timestamp: string; trx_id: string; act: { name: string } };

/** The most recent action involving `account`, from the first server that has any; undefined when none does. */
async function lastAction(account: string): Promise<RawAction | undefined> {
  let answered = false;
  let last: unknown;
  for (const host of HISTORY_FOR_EMPTY) {
    try {
      const r = await fetch(`${host}/v2/history/get_actions?account=${account}&limit=1&sort=desc`, { signal: AbortSignal.timeout(12_000) });
      if (!r.ok) { last = new Error(`HTTP ${r.status} from ${host}`); continue; }
      answered = true;
      const act = ((await r.json()) as { actions?: RawAction[] }).actions?.[0];
      if (act) return act;
    } catch (e) { last = e; }
  }
  if (answered) return undefined;
  throw last instanceof Error ? last : new Error(String(last));
}

async function readOne(spec: ContractSpec): Promise<Row> {
  const row: Row = { spec, loading: false, health: 'unreachable', severity: 'unknown', codeChanged: false };
  const [acct, hash, last] = await Promise.allSettled([
    getAccountInfo(spec.account),
    getCodeHash(spec.account),
    lastAction(spec.account),
  ]);
  if (acct.status === 'fulfilled') {
    const a = acct.value;
    row.lastCodeUpdate = typeof a.last_code_update === 'string' ? a.last_code_update : undefined;
    row.created = typeof a.created === 'string' ? a.created : undefined;
    row.balance = typeof a.core_liquid_balance === 'string' ? a.core_liquid_balance : undefined;
    row.ramUsage = Number(a.ram_usage) || undefined;
    row.ramQuota = Number(a.ram_quota) || undefined;
    row.controller = controllerOf(a.permissions as RawPermission[] | undefined);
  }
  if (hash.status === 'fulfilled') row.codeHash = hash.value;
  if (last.status === 'fulfilled') {
    const act = last.value;
    if (act) { row.lastActionTs = act.timestamp; row.lastActionName = act.act.name; row.lastActionTrx = act.trx_id; }
  } else {
    row.activityUnavailable = true;
  }
  if (acct.status === 'rejected' && hash.status === 'rejected') {
    row.error = acct.reason instanceof Error ? acct.reason.message : String(acct.reason);
    return row;
  }
  score(row);
  // Counted only when something happened today: an idle contract costs no extra read.
  const lastMs = parseChainDateMs(row.lastActionTs);
  if (lastMs !== undefined && Date.now() - lastMs < 86_400_000) {
    const after = new Date(Date.now() - 86_400_000).toISOString();
    const day = await history<{ total?: { value: number; relation: string } }>(
      `/v2/history/get_actions?account=${spec.account}&after=${after}&limit=1`).catch(() => undefined);
    if (day?.total) row.day = { count: day.total.value, capped: day.total.relation !== 'eq' };
  } else if (lastMs !== undefined) {
    row.day = { count: 0, capped: false };
  }
  return row;
}

async function postJson<T>(host: string, path: string, body: unknown): Promise<T> {
  const r = await fetch(`${host}${path}`, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(12_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${host}`);
  return (await r.json()) as T;
}

type RawBlock = {
  timestamp: string;
  transactions?: { trx: string | { id: string; transaction: { actions: { account: string; name: string; authorization: { actor: string; permission: string }[]; data: Record<string, unknown> }[] } } }[];
};

/** One block, from the first node that still serves it. */
async function block(num: number): Promise<RawBlock> {
  let last: unknown;
  for (const host of BLOCKS) {
    try { return await postJson<RawBlock>(host, '/v1/chain/get_block', { block_num_or_id: num }); } catch (e) { last = e; }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

const fieldsOf = (abi: { structs?: { name: string; fields: { name: string; type: string }[] }[] }, type: string) =>
  (abi.structs?.find((s) => s.name === type)?.fields ?? []).map((f) => `${f.name}: ${f.type}`);

type RawAbi = {
  actions?: { name: string; type: string }[];
  tables?: { name: string; type: string }[];
  structs?: { name: string; fields: { name: string; type: string }[] }[];
};

export function diffAbi(before: RawAbi, after: RawAbi): AbiDiff {
  const names = (abi: RawAbi, k: 'actions' | 'tables') => new Map((abi[k] ?? []).map((x) => [x.name, x.type]));
  const out: AbiDiff = { actionsAdded: [], actionsRemoved: [], tablesAdded: [], tablesRemoved: [], reshaped: [] };
  for (const k of ['actions', 'tables'] as const) {
    const x = names(before, k), y = names(after, k);
    const added = [...y.keys()].filter((n) => !x.has(n)), removed = [...x.keys()].filter((n) => !y.has(n));
    if (k === 'actions') { out.actionsAdded = added; out.actionsRemoved = removed; } else { out.tablesAdded = added; out.tablesRemoved = removed; }
    for (const [n, type] of y) {
      if (!x.has(n)) continue;
      const f0 = fieldsOf(before, x.get(n)!), f1 = fieldsOf(after, type);
      const plus = f1.filter((f) => !f0.includes(f)), minus = f0.filter((f) => !f1.includes(f));
      if (plus.length || minus.length) out.reshaped.push({ name: `${k === 'actions' ? 'action' : 'table'} ${n}`, added: plus, removed: minus });
    }
  }
  return out;
}

/** How the current code got there: the block, the transaction, and what changed in the interface. */
async function readHistory(account: string, lastCodeUpdate: string): Promise<CodeHistory> {
  const info = await postJson<{ head_block_num: number; head_block_time: string }>(BLOCKS[0], '/v1/chain/get_info', {});
  const target = parseChainDateMs(lastCodeUpdate)!;
  let num = info.head_block_num - Math.round((parseChainDateMs(info.head_block_time)! - target) / 500);
  let blk = await block(num);
  for (let hop = 0; hop < 8; hop++) {
    const off = Math.round((target - parseChainDateMs(blk.timestamp)!) / 500);
    if (!off) break;
    num += off;
    blk = await block(num);
  }
  const out: CodeHistory = { block: num, signers: [], abi: 'unknown' };
  for (const t of blk.transactions ?? []) {
    if (typeof t.trx !== 'object') continue;
    const acts = t.trx.transaction.actions;
    const set = acts.find((a) => a.account === 'eosio' && a.name === 'setcode' && a.data.account === account);
    const exec = acts.find((a) => a.account === 'eosio.msig' && a.name === 'exec');
    if (set) {
      out.trx = t.trx.id;
      out.signers = set.authorization.map((a) => `${a.actor}@${a.permission}`);
      break;
    }
    // A multisig executes the deployment inside its own action: the block shows the exec, not the setcode.
    if (exec && !out.proposal) {
      out.trx = t.trx.id;
      out.proposal = { proposer: String(exec.data.proposer), name: String(exec.data.proposal_name), executer: String(exec.data.executer) };
    }
  }
  try {
    const snap = await history<{ abi?: RawAbi }>(`/v2/history/get_abi_snapshot?contract=${account}&fetch=true&block=${num - 1}`);
    const now = await withFailover(async (c: APIClient) => (await c.v1.chain.get_abi(account)).abi as unknown as RawAbi);
    if (snap.abi && now) out.abi = diffAbi(snap.abi, JSON.parse(JSON.stringify(now)) as RawAbi);
  } catch { /* the interface stays "unknown" */ }
  return out;
}

export async function scanContracts(repaint: () => void): Promise<void> {
  if (state.scanning) return;
  state.scanning = true;
  for (const spec of CONTRACTS) {
    if (!state.rows.has(spec.account)) state.rows.set(spec.account, { spec, loading: true, health: 'ok', severity: 'unknown', codeChanged: false });
  }
  repaint();
  await Promise.all(CONTRACTS.map(async (spec) => {
    const row = await readOne(spec).catch((e: unknown): Row => ({
      spec, loading: false, health: 'unreachable', severity: 'unknown', codeChanged: false,
      error: e instanceof Error ? e.message : String(e),
    }));
    const before = state.rows.get(spec.account);
    if (before?.history && typeof before.history === 'object' && !('error' in before.history)) row.history = before.history;
    state.rows.set(spec.account, row);
    // A moved contract explains itself without being asked.
    if (row.codeChanged && row.lastCodeUpdate && !row.history) void loadHistory(spec.account, repaint);
    repaint();
  }));
  state.scanning = false;
  state.scannedAt = Date.now();
  repaint();
}

function loadHistory(account: string, repaint: () => void): void {
  const row = state.rows.get(account);
  if (!row?.lastCodeUpdate || row.history === 'loading') return;
  row.history = 'loading';
  repaint();
  readHistory(account, row.lastCodeUpdate).then(
    (h) => { const r = state.rows.get(account); if (r) r.history = h; repaint(); },
    (e: unknown) => { const r = state.rows.get(account); if (r) r.history = { error: e instanceof Error ? e.message : String(e) }; repaint(); },
  );
}

// ─── rendering ──────────────────────────────────────────────────────────

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function day(iso: string | undefined): string {
  const ms = parseChainDateMs(iso);
  if (ms === undefined) return 'unknown';
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function ago(iso: string | undefined): string {
  const ms = parseChainDateMs(iso);
  if (ms === undefined) return 'unknown';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  const units: [number, string][] = [[365 * 86400, 'year'], [30 * 86400, 'month'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
  for (const [n, u] of units) if (s >= n) { const k = Math.floor(s / n); return `${k} ${u}${k > 1 ? 's' : ''} ago`; }
  return 'just now';
}

const short = (h: string | undefined) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : 'none');
const tx = (id: string, label = 'view the transaction') => `<a href="https://waxblock.io/transaction/${esc(id)}" target="_blank" rel="noreferrer">${label}</a>`;
const acc = (name: string) => `<a href="https://waxblock.io/account/${esc(name)}" target="_blank" rel="noreferrer"><code>${esc(name)}</code></a>`;

function status(r: Row): { word: string; tone: Severity | 'loading' } {
  if (r.loading) return { word: 'Checking', tone: 'loading' };
  switch (r.health) {
    case 'ok': return { word: 'Healthy', tone: 'ok' };
    case 'changed': return r.severity === 'info' ? { word: 'Updated', tone: 'info' } : { word: 'Code changed', tone: 'attention' };
    case 'disabled': return { word: 'No code', tone: 'attention' };
    case 'silent': return { word: 'Quiet', tone: 'watch' };
    case 'service': return { word: 'Service', tone: 'ok' };
    case 'inactive': return { word: 'Retired', tone: 'info' };
    default: return { word: 'Unreachable', tone: 'unknown' };
  }
}

const needsLook = (r: Row) => r.severity === 'attention' || r.severity === 'watch' || r.severity === 'unknown' || (r.health === 'changed');

function summary(): string {
  const rows = [...state.rows.values()].filter((r) => !r.loading);
  const count = (f: (r: Row) => boolean) => rows.filter(f).length;
  const chips: [string, number, string][] = [
    ['ok', count((r) => r.severity === 'ok'), 'healthy'],
    ['attention', count((r) => r.severity === 'attention'), 'code changed or gone'],
    ['info', count((r) => r.health === 'changed' && r.severity === 'info'), count((r) => r.health === 'changed' && r.severity === 'info') === 1 ? 'dependency updated' : 'dependencies updated'],
    ['watch', count((r) => r.severity === 'watch'), `quiet ${SILENT_AFTER_DAYS} days or more`],
    ['info', count((r) => r.health === 'inactive'), 'retired, as expected'],
    ['unknown', count((r) => r.severity === 'unknown'), 'could not be read'],
  ];
  const alarm = rows.filter((r) => r.severity === 'attention');
  const updated = rows.filter((r) => r.health === 'changed' && r.severity === 'info');
  const names = (list: Row[]) => list.map((r) => r.spec.label).join(', ');
  const headline = state.scanning && !state.scannedAt ? `Reading ${CONTRACTS.length} contracts…`
    : alarm.length ? `${alarm.length} contract${alarm.length > 1 ? 's' : ''} Crucible relies on changed code (${names(alarm)}): read what changed before you sign there.`
      : updated.length ? `The NeftyBlocks, WaxDAO and Blenderizer contracts run the code they were checked against. ${updated.length} dependenc${updated.length > 1 ? 'ies were' : 'y was'} updated by ${updated.length > 1 ? 'their' : 'its'} own team: ${names(updated)}.`
        : 'Every contract Crucible signs with runs the code it was checked against.';
  return `
    <p class="v2-status-headline ${alarm.length ? 'alarm' : ''}">${esc(headline)}</p>
    <div class="v2-status-chips">
      ${chips.filter(([, n]) => n > 0).map(([tone, n, label]) => `<span class="v2-status-chip ${tone}"><b>${n}</b> ${esc(label)}</span>`).join('')}
    </div>`;
}

function controllerLine(c: Controller | undefined): string {
  if (!c) return 'unknown';
  const who = [
    c.keys ? `${c.keys} key${c.keys > 1 ? 's' : ''}` : '',
    ...c.accounts.map((a) => `<code>${esc(a)}</code>`),
  ].filter(Boolean);
  const parts = who.length > 1 ? `${c.threshold} of ${who.length}: ${who.join(', ')}` : who.join('') || 'nobody listed';
  return `<code>${esc(c.permission)}</code> ${c.linked ? '(linked to setcode)' : ''} · ${parts}`;
}

function historyPanel(r: Row): string {
  const h = r.history;
  if (!h) return r.lastCodeUpdate && !isZeroHash(r.codeHash)
    ? `<button class="v2-status-more" data-status-history="${esc(r.spec.account)}">How did this code get here?</button>` : '';
  if (h === 'loading') return '<p class="lab-hint">Finding the block, the transaction and the interface before it.</p>';
  if ('error' in h) return `<p class="lab-warn">Could not trace it: ${esc(h.error)} <button class="lab-link" data-status-history="${esc(r.spec.account)}">Try again</button></p>`;
  const how = h.proposal
    ? `through the multisig proposal <code>${esc(h.proposal.name)}</code> by ${acc(h.proposal.proposer)}, executed by ${acc(h.proposal.executer)}`
    : h.signers.length ? `signed by ${h.signers.map((s) => `<code>${esc(s)}</code>`).join(', ')}` : 'by a transaction this page could not find in the block';
  let iface: string;
  if (h.abi === 'unknown') {
    iface = '<p class="lab-hint">The history servers hold no earlier version of its interface, so what changed in it cannot be compared.</p>';
  } else {
    const d = h.abi;
    const lines = [
      ...d.actionsAdded.map((a) => `<li class="plus">action <code>${esc(a)}</code> added</li>`),
      ...d.actionsRemoved.map((a) => `<li class="minus">action <code>${esc(a)}</code> removed</li>`),
      ...d.tablesAdded.map((a) => `<li class="plus">table <code>${esc(a)}</code> added</li>`),
      ...d.tablesRemoved.map((a) => `<li class="minus">table <code>${esc(a)}</code> removed</li>`),
      ...d.reshaped.map((x) => `<li class="shape">${esc(x.name)}: ${[
        ...x.added.map((f) => `<span class="plus">+ ${esc(f)}</span>`), ...x.removed.map((f) => `<span class="minus">− ${esc(f)}</span>`)].join(' ')}</li>`),
    ];
    iface = lines.length
      ? `<ul class="v2-status-diff">${lines.join('')}</ul>`
      : '<p class="lab-hint">Its interface is identical to the version before: every action and table kept its shape. The change is inside the code.</p>';
  }
  return `
    <div class="v2-status-history">
      <p>Deployed on <strong>${esc(day(r.lastCodeUpdate))}</strong> in block ${h.block.toLocaleString('en')}, ${how}.
        ${h.trx ? tx(h.trx) : ''}</p>
      ${iface}
    </div>`;
}

function card(r: Row): string {
  const s = status(r);
  const spec = r.spec;
  const uses = USES[spec.account] ?? [];
  const baselineAt = spec.baselineAt ?? DEFAULT_BASELINE_AT;
  const ram = r.ramUsage && r.ramQuota ? Math.min(100, Math.round((r.ramUsage / r.ramQuota) * 100)) : undefined;
  const changed = r.codeChanged && !r.loading;
  const code = r.loading ? 'reading'
    : r.health === 'service' ? 'none, by design: it signs from outside the chain'
      : isZeroHash(r.codeHash) ? '<strong class="bad">no code: the contract was wiped</strong>'
        : `${esc(day(r.lastCodeUpdate))} <span class="dim">(${esc(ago(r.lastCodeUpdate))})</span> · ${changed
          ? `<strong class="${r.severity === 'info' ? 'info' : 'bad'}">differs from the version checked on ${esc(baselineAt)}</strong>`
          : `<span class="good">the version checked on ${esc(baselineAt)}</span>`}`;
  const activity = r.loading ? 'reading'
    : r.activityUnavailable ? 'history unavailable right now'
      : !r.lastActionTs ? 'no recorded activity'
        : `last action ${esc(ago(r.lastActionTs))}${r.lastActionName ? ` (<code>${esc(r.lastActionName)}</code>)` : ''}${r.lastActionTrx ? ` · ${tx(r.lastActionTrx, 'see it')}` : ''}${
          r.day ? ` · <strong>${r.day.capped ? `${r.day.count.toLocaleString('en')}+` : r.day.count.toLocaleString('en')}</strong> in the last 24 h` : ''}`;
  return `
    <article class="v2-status-card tone-${s.tone}" id="status-${esc(spec.account)}">
      <header>
        <span class="v2-status-dot" aria-hidden="true"></span>
        <div class="v2-status-name">
          <h3>${esc(spec.label)}</h3>
          ${acc(spec.account)}
        </div>
        <span class="v2-status-badge">${esc(s.word)}</span>
      </header>
      <p class="v2-status-role">${esc(spec.role)}</p>
      ${uses.length ? `<p class="v2-status-uses">Crucible uses it for ${uses.map((u) => `<a href="${u.href}">${esc(u.label)}</a>`).join(', ')}.</p>` : ''}
      <dl class="v2-status-facts">
        <dt>Code</dt><dd>${code}</dd>
        <dt>Activity</dt><dd>${activity}</dd>
        <dt>Can change the code</dt><dd>${r.loading ? 'reading' : controllerLine(r.controller)}</dd>
        <dt>Resources</dt><dd>${ram !== undefined
          ? `<span class="v2-status-ram" title="${ram}% of its RAM"><span style="width:${ram}%"></span></span> ${ram}% of RAM used · ${esc(r.balance ?? '0 WAX')}`
          : esc(r.balance ?? '—')}</dd>
        ${r.created ? `<dt>Created</dt><dd>${esc(day(r.created))}</dd>` : ''}
      </dl>
      ${changed ? `
        <div class="v2-status-changed">
          <p><strong>What changed.</strong> Checked on ${esc(baselineAt)} at version
            <code>${esc(short(spec.baselineCodeHash))}</code> deployed ${esc(day(spec.baselineLastCodeUpdate))};
            it now runs <code>${esc(short(r.codeHash))}</code>.
            ${r.severity === 'info' ? 'This is a dependency its owner maintains, so updates are expected: worth reading, not an alarm.' : 'Until someone has looked at the new code, sign here only what you would sign blind.'}</p>
          ${historyPanel(r)}
        </div>` : historyPanel(r)}
      ${r.error ? `<p class="lab-warn">${esc(r.error)}</p>` : ''}
      <footer>
        <a href="https://waxblock.io/account/${esc(spec.account)}?tab=Contract" target="_blank" rel="noreferrer">Code and ABI on waxblock</a>
        <a class="v2-guide-back" href="#/status/contents">↑ Back to contents</a>
      </footer>
    </article>`;
}

export function renderStatus(repaint: () => void): string {
  if (!state.scanning && !state.scannedAt) void scanContracts(repaint);
  const rows = CONTRACTS.map((c) => state.rows.get(c.account) ?? { spec: c, loading: true, health: 'ok', severity: 'unknown', codeChanged: false } as Row);
  const shown = (r: Row) => !state.onlyIssues || r.loading || needsLook(r);
  const toc = GROUPS.map((g) => {
    const items = rows.filter((r) => r.spec.group === g && shown(r));
    if (!items.length) return '';
    return `
      <div class="v2-guide-tocgroup">
        <h2>${esc(g)}</h2>
        <div class="v2-status-tocitems">
          ${items.map((r) => { const s = status(r); return `
            <a class="v2-status-tocitem tone-${s.tone}" href="#/status/${esc(r.spec.account)}">
              <span class="v2-status-dot" aria-hidden="true"></span>
              <span><strong>${esc(r.spec.label)}</strong><small>${esc(r.spec.account)} · ${esc(s.word)}</small></span>
            </a>`; }).join('')}
        </div>
      </div>`;
  }).join('');
  const groups = GROUPS.map((g) => {
    const items = rows.filter((r) => r.spec.group === g && shown(r));
    return items.length ? `<section class="v2-status-group"><h2>${esc(g)}</h2>${items.map(card).join('')}</section>` : '';
  }).join('');
  return `
    <div class="v2-status">
      <div class="v2-hero">
        <p class="v2-eyebrow">Contract monitor</p>
        <h1>Are the contracts still the ones Crucible checked?</h1>
        <p class="v2-lead">Crucible signs with ${CONTRACTS.length} contracts it does not own. A contract can be redeployed
          by whoever controls it, so this reads each one live: its code against the version that was checked, whether
          it still runs, and who could change it. Nothing here signs anything.</p>
        ${summary()}
        <div class="v2-status-tools">
          <button class="lab-primary" data-status-refresh ${state.scanning ? 'disabled' : ''}>${state.scanning ? 'Reading the chain' : 'Read again'}</button>
          <label class="lab-check"><input type="checkbox" data-status-issues ${state.onlyIssues ? 'checked' : ''}/> <span>Only what needs a look</span></label>
          ${state.scannedAt ? `<span class="lab-hint">Read ${esc(ago(new Date(state.scannedAt).toISOString().replace('Z', '')))}.</span>` : ''}
        </div>
      </div>
      <nav class="v2-guide-toc" id="status-contents" aria-label="Contracts">
        <h2 class="v2-guide-toctitle">Contracts</h2>
        ${toc || '<p class="lab-hint">Nothing needs a look right now.</p>'}
      </nav>
      ${groups}
      <section class="v2-status-key">
        <h2>Reading this page</h2>
        <dl class="v2-guide-faq">
          <dt>The version checked</dt>
          <dd>Each contract's code fingerprint was recorded when Crucible was verified against it (on ${DEFAULT_BASELINE_AT}, or the date shown on its card). A different fingerprint means new code: not necessarily bad, but not what was checked.</dd>
          <dt>Updated, for a dependency</dt>
          <dd>AtomicAssets, the system contract and the oracle belong to their own teams, who update them on purpose. Shown so you know, not as an alarm.</dd>
          <dt>Quiet</dt>
          <dd>No action for ${SILENT_AFTER_DAYS} days or more. A contract can be quiet and fine; it is a reason to check, not a fault.</dd>
          <dt>Can change the code</dt>
          <dd>The permission the chain accepts for <code>setcode</code>: a key, an account, or several that must agree. The fewer and the more personal, the more a single party could change the contract.</dd>
        </dl>
      </section>
    </div>`;
}

export function attachStatusHandlers(root: HTMLElement, repaint: () => void): void {
  root.querySelector('[data-status-refresh]')?.addEventListener('click', () => {
    state.scannedAt = undefined;
    void scanContracts(repaint);
  });
  root.querySelector<HTMLInputElement>('[data-status-issues]')?.addEventListener('change', (e) => {
    state.onlyIssues = (e.target as HTMLInputElement).checked;
    repaint();
  });
  root.querySelectorAll<HTMLElement>('[data-status-history]').forEach((el) =>
    el.addEventListener('click', () => loadHistory(el.dataset.statusHistory ?? '', repaint)));
}

/** Brings a contract's card, or the contents, into view. */
export function scrollStatus(account: string): void {
  const el = document.getElementById(account && account !== 'contents' ? `status-${account}` : 'status-contents');
  if (el && account) el.scrollIntoView({ block: 'start' });
}
