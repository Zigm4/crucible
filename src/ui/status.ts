/**
 * Contract status / monitoring page (client-side, read-only).
 * ─────────────────────────────────────────────────────────────
 * A standalone full-page view (route #/status) that watches the health of
 * every on-chain contract Crucible talks to, plus their dependencies. It
 * never writes anything: for each account it reads
 *
 *   1. /v1/chain/get_account   -> last_code_update (the headline figure:
 *                                 when the contract code last changed),
 *                                 created date, balance, RAM, keys.
 *   2. /v1/chain/get_code_hash -> is contract code present, or wiped (all
 *                                 zero hash = disabled).
 *   3. Hyperion get_actions    -> timestamp of the most recent action, to
 *                                 spot a contract that has gone silent.
 *
 * "Monitoring without a backend" works by comparing the live readings to a
 * baseline captured at implementation time (the expected code hash + last
 * code update of each account). If the owner redeploys a contract, its
 * last_code_update and code hash move away from the baseline and the card
 * turns amber/red so you know to re-check it before trusting it again.
 *
 * Everything is read through the app's existing RPC failover (src/chain/rpc),
 * so a single dead endpoint does not break the page; failures are handled per
 * contract, never globally.
 */

import {
  getAccountInfo,
  getCodeHash,
  getLastAction,
} from '../chain/rpc';

// ─── config ─────────────────────────────────────────────────────────────

/** A monitored account. The list is the single source of truth; add a row to
 *  watch another contract. Roles are written for a non-technical reader. */
export interface ContractSpec {
  account: string;
  label: string;
  /** Plain-language explanation of what this account does (1-2 sentences). */
  role: string;
  group: 'NeftyBlocks' | 'WaxDAO' | 'Infrastructure';
  /**
   * contract = a normal smart contract we expect to be stable.
   * infra    = a dependency we do not own; legitimate updates are common, so
   *            a code change is shown as information, not a red alarm.
   * service = an account with NO contract code (e.g. an off-chain signer);
   *            only its activity is monitored, never its code.
   */
  kind: 'contract' | 'infra' | 'service';
  /** Baseline captured on-chain at implementation time (2026-06-28). */
  baselineCodeHash: string;
  baselineLastCodeUpdate: string;
  /** Known-inactive legacy account: do not flag it as "silent". */
  expectInactive?: boolean;
}

const ZERO_HASH = '0'.repeat(64);

/** Number of days without any action before a contract is flagged "silent". */
const SILENT_DAYS = 14;

export const CONTRACTS: ContractSpec[] = [
  // ── NeftyBlocks ──────────────────────────────────────────────────────
  {
    account: 'blend.nefty', label: 'Blends', group: 'NeftyBlocks', kind: 'contract',
    role: 'NFT blends: burn one or more NFTs to mint a result NFT.',
    baselineCodeHash: '559d6011cb61fcccc47b5bbde2123428580f0c711c18b5538474d49e793c8de1',
    baselineLastCodeUpdate: '2024-09-23T00:30:16.000',
  },
  {
    account: 'neftyblocksd', label: 'Drops', group: 'NeftyBlocks', kind: 'contract',
    role: 'NFT drops: claim NFTs, for free or for a price.',
    baselineCodeHash: 'ab8377de02dca3b2453be8d97d9f7460f426d98dccb25aab918e2f2cde49b906',
    baselineLastCodeUpdate: '2024-09-12T12:23:24.000',
  },
  {
    account: 'neftyblocksp', label: 'Packs', group: 'NeftyBlocks', kind: 'contract',
    role: 'NeftyBlocks packs: open a pack to reveal the NFTs inside.',
    baselineCodeHash: 'db2815f7944a9f96dc6387022a067030db22b2e888fc6f772301ce794aead97f',
    baselineLastCodeUpdate: '2024-04-09T13:18:52.500',
  },
  {
    account: 'up.nefty', label: 'Upgrades', group: 'NeftyBlocks', kind: 'contract',
    role: "Upgrades: change an NFT's data in place (e.g. level it up) without burning it.",
    baselineCodeHash: '0a23da913a516d73702d35a727d73b8364ec53c5e5f9138f4282d5615a6007a7',
    baselineLastCodeUpdate: '2025-01-06T23:03:39.500',
  },
  {
    account: 'secure.nefty', label: 'Security checks', group: 'NeftyBlocks', kind: 'contract',
    role: 'Enforces whitelist and ownership gates for blends and drops.',
    baselineCodeHash: 'ccfeb62006d601d08ab926646645a4efde660e2427d285340bf21e45ea47c191',
    baselineLastCodeUpdate: '2023-09-23T17:08:15.500',
  },
  {
    account: 'market.nefty', label: 'Marketplace', group: 'NeftyBlocks', kind: 'contract',
    role: 'NeftyBlocks marketplace and NFT listings.',
    baselineCodeHash: 'f6d6e241e312a750d55b66cfc1802a39a328b16f1321af0723cf5dc60b4f4903',
    baselineLastCodeUpdate: '2024-07-17T10:53:06.000',
  },
  {
    account: 'swap.nefty', label: 'Swaps', group: 'NeftyBlocks', kind: 'contract',
    role: 'NFT-for-NFT swaps between users.',
    baselineCodeHash: 'b6c958c8e13a2fad88c5cb2a8e32b871ec80053d8682b4ffee8bcc32e9ec6983',
    baselineLastCodeUpdate: '2024-09-10T14:08:18.000',
  },
  {
    account: 'redeem.nefty', label: 'Redemptions', group: 'NeftyBlocks', kind: 'contract',
    role: 'Redeem NFTs for physical or off-chain rewards.',
    baselineCodeHash: '5c53cbc8208e8325c2e665afc34b881ad94c2cc9a995b6276e34d310d12f704a',
    baselineLastCodeUpdate: '2022-04-29T11:44:50.500',
  },
  {
    account: 'fees.nefty', label: 'Fee collector', group: 'NeftyBlocks', kind: 'contract',
    role: 'Account that receives the platform fees built into the contracts.',
    baselineCodeHash: '11cd23a66c4c1965503624db2731848ac86482d0852977979d4f7ac3b9dfbe56',
    baselineLastCodeUpdate: '2022-05-25T09:29:47.000',
  },
  {
    account: 'neftybrespay', label: 'Legacy CPU payer', group: 'NeftyBlocks', kind: 'contract',
    role: 'Used to pay CPU for users (free transactions). Inactive since 2021; you now stake your own CPU.',
    baselineCodeHash: '37577fd842d78c25b785e7ab343198d9712dee46f3f2939c0d18d6610cbfc9c4',
    baselineLastCodeUpdate: '2021-05-24T16:51:54.000',
    expectInactive: true,
  },
  {
    account: 'setup.nefty', label: 'Auto-claim signer', group: 'NeftyBlocks', kind: 'service',
    role: 'Off-chain helper that auto-delivers the result of a random blend/pack. It has no contract code, so only its activity is monitored.',
    baselineCodeHash: ZERO_HASH,
    baselineLastCodeUpdate: '1970-01-01T00:00:00.000',
  },

  // ── WaxDAO ───────────────────────────────────────────────────────────
  {
    account: 'waxdaomarket', label: 'Blends & market', group: 'WaxDAO', kind: 'contract',
    role: 'WaxDAO blends and marketplace (the WAXDAO platform tab uses this).',
    baselineCodeHash: 'c728b4a86ca55845276b70bc78a2cd053a33f37950c523041c089382f525821e',
    baselineLastCodeUpdate: '2024-02-18T04:16:03.500',
  },
  {
    account: 'waxdaofarmer', label: 'Staking farms', group: 'WaxDAO', kind: 'contract',
    role: 'Token and NFT staking farms (earn rewards by staking).',
    baselineCodeHash: 'b62fc6f027752a65e05826da95ce6239679b85a8397ad5b82d6f81f20181b092',
    baselineLastCodeUpdate: '2024-12-23T15:35:25.000',
  },
  {
    account: 'waxdaobacker', label: 'Pack backing', group: 'WaxDAO', kind: 'contract',
    role: 'Pack openings and the assets backing them.',
    baselineCodeHash: 'b23a327fe235a159890bf3dea3eac496829d92ac7de3ada6aa0651f06173ec8a',
    baselineLastCodeUpdate: '2024-08-25T22:02:40.000',
  },
  {
    account: 'buildawaxdao', label: 'DAO & creator tools', group: 'WaxDAO', kind: 'contract',
    role: 'Tooling to create DAOs and creator projects.',
    baselineCodeHash: '97a0029366fbda6fd7e66947401796257fa9a46243027ac6f88c032173108593',
    baselineLastCodeUpdate: '2023-07-05T15:44:13.500',
  },
  {
    account: 'waxdaoescrow', label: 'Escrow & vesting', group: 'WaxDAO', kind: 'contract',
    role: 'Holds funds/NFTs in escrow and handles vesting schedules.',
    baselineCodeHash: '2669100794356dfc5d64228c6fb0b4dd822584e7ce95b505e078239e71224ff1',
    baselineLastCodeUpdate: '2024-04-23T12:55:17.000',
  },
  {
    account: 'dao.waxdao', label: 'DAO governance', group: 'WaxDAO', kind: 'contract',
    role: 'On-chain governance: proposals and voting.',
    baselineCodeHash: '044da49dc806440e7c11a428c36052a9699606418bfebb2281bf39eadea199eb',
    baselineLastCodeUpdate: '2024-05-22T01:21:36.000',
  },
  {
    account: 'token.waxdao', label: 'Token creation', group: 'WaxDAO', kind: 'contract',
    role: 'Creates and manages custom tokens.',
    baselineCodeHash: '1ad589628f7100a3757bd1b1438ce8f57cc0825dafb9c4c2730d8483646118c8',
    baselineLastCodeUpdate: '2023-12-20T12:07:35.000',
  },

  // ── Infrastructure (not owned by Nefty/WaxDAO) ───────────────────────
  {
    account: 'atomicassets', label: 'AtomicAssets standard', group: 'Infrastructure', kind: 'infra',
    role: 'The NFT standard itself (by pink.network). Every NFT and template on WAX lives here.',
    baselineCodeHash: 'a1657eab57b333beb69608959d4f9afd608e4cee26ce5272654408022c904f2b',
    baselineLastCodeUpdate: '2020-09-30T10:20:40.500',
  },
  {
    account: 'atomicpacksx', label: 'AtomicHub packs', group: 'Infrastructure', kind: 'infra',
    role: 'AtomicHub pack contract used by the UNPACK tab.',
    baselineCodeHash: '13902f2b3cace533e8dba8f31fc2f1fd03c9dcf9d83f036d0d423a5b7382c96d',
    baselineLastCodeUpdate: '2022-05-26T13:03:36.500',
  },
  {
    account: 'atomicmarket', label: 'AtomicHub market', group: 'Infrastructure', kind: 'infra',
    role: 'AtomicHub marketplace contract.',
    baselineCodeHash: 'a8979fa520feb59203b7a5b1ee6cf6154c34c4101d4fdc272b56d15ad3278697',
    baselineLastCodeUpdate: '2023-12-19T11:30:50.500',
  },
  {
    account: 'orng.wax', label: 'RNG oracle', group: 'Infrastructure', kind: 'infra',
    role: "WAX's native randomness oracle. Supplies the random results for random blends and pack openings. Updated by WAX more often than the other contracts.",
    baselineCodeHash: 'c913ee95943be5d02a321069238eb57816d7319acd763d174b7ca494b7c021ea',
    baselineLastCodeUpdate: '2026-06-03T14:41:40.000',
  },
];

// ─── health model ───────────────────────────────────────────────────────

export type Health =
  | 'ok'          // code present, matches baseline, recent activity
  | 'changed'     // code hash or last_code_update differs from baseline
  | 'disabled'    // code hash is all zero -> no contract code
  | 'silent'      // no action for SILENT_DAYS+ days
  | 'unreachable' // could not read the account at all
  | 'service'     // service account with no code; activity-only
  | 'inactive';   // legacy account, expected to be idle

export type Severity =
  | 'ok'         // healthy
  | 'attention'  // real problem: code wiped or redeployed vs baseline (red)
  | 'watch'      // worth noting but not an alarm: silent / low-traffic (amber)
  | 'info'       // informational: infra updated, legacy inactive
  | 'unknown';   // could not be read

export interface ContractHealth {
  spec: ContractSpec;
  loading: boolean;
  health: Health;
  severity: Severity;
  codeChanged: boolean;
  lastCodeUpdate?: string;
  created?: string;
  codeHash?: string;
  balance?: string;
  ramUsage?: number;
  ramQuota?: number;
  keyCount?: number;
  lastActionTs?: string;
  lastActionName?: string;
  activityUnavailable?: boolean;
  error?: string;
}

interface StatusState {
  results: Map<string, ContractHealth>;
  scanning: boolean;
  lastScanAt?: number;
  scanned: boolean;
}

const state: StatusState = {
  results: new Map(),
  scanning: false,
  scanned: false,
};

export function getStatusState(): StatusState {
  return state;
}

function isZeroHash(h: string | undefined): boolean {
  return !h || /^0+$/.test(h);
}

function parseChainDateMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  // Chain/Hyperion timestamps are UTC but lack the trailing Z. Force UTC.
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Fetches and scores one contract. Never throws: failures land in the result. */
async function fetchOne(spec: ContractSpec): Promise<ContractHealth> {
  const base: ContractHealth = {
    spec,
    loading: false,
    health: 'unreachable',
    severity: 'unknown',
    codeChanged: false,
  };

  const [acctR, hashR, actR] = await Promise.allSettled([
    getAccountInfo(spec.account),
    getCodeHash(spec.account),
    getLastAction(spec.account),
  ]);

  // Account info.
  if (acctR.status === 'fulfilled') {
    const a = acctR.value;
    base.lastCodeUpdate = typeof a.last_code_update === 'string' ? a.last_code_update : undefined;
    base.created = typeof a.created === 'string' ? a.created : undefined;
    base.balance = typeof a.core_liquid_balance === 'string' ? a.core_liquid_balance : undefined;
    base.ramUsage = typeof a.ram_usage === 'number' ? a.ram_usage : Number(a.ram_usage) || undefined;
    base.ramQuota = typeof a.ram_quota === 'number' ? a.ram_quota : Number(a.ram_quota) || undefined;
    const perms = a.permissions;
    if (Array.isArray(perms)) base.keyCount = perms.length;
  }

  // Code hash.
  if (hashR.status === 'fulfilled') {
    base.codeHash = hashR.value;
  }

  // Last action (Hyperion). A throw here only means "activity unavailable".
  if (actR.status === 'fulfilled') {
    if (actR.value) {
      base.lastActionTs = actR.value.timestamp;
      base.lastActionName = actR.value.name;
    }
  } else {
    base.activityUnavailable = true;
  }

  // If neither the account nor the code hash could be read, it is unreachable.
  if (acctR.status === 'rejected' && hashR.status === 'rejected') {
    base.health = 'unreachable';
    base.severity = 'unknown';
    base.error = acctR.reason instanceof Error ? acctR.reason.message : String(acctR.reason);
    return base;
  }

  score(base);
  return base;
}

function isSilent(h: ContractHealth): boolean {
  if (h.activityUnavailable || !h.lastActionTs) return false;
  const ms = parseChainDateMs(h.lastActionTs);
  if (ms === undefined) return false;
  return Date.now() - ms > SILENT_DAYS * 86_400_000;
}

/** Derives health + severity from the raw readings. */
function score(h: ContractHealth): void {
  const spec = h.spec;

  // Service account (no code by design): only activity matters.
  if (spec.kind === 'service' || (isZeroHash(h.codeHash) && isZeroHash(spec.baselineCodeHash))) {
    if (isSilent(h)) {
      h.health = 'silent';
      h.severity = 'watch';
    } else {
      h.health = 'service';
      h.severity = 'ok';
    }
    return;
  }

  // Real contract: code present?
  if (isZeroHash(h.codeHash)) {
    h.health = 'disabled';
    h.severity = 'attention';
    return;
  }

  // Compare to the baseline captured at implementation time.
  const hashChanged = !!h.codeHash && h.codeHash !== spec.baselineCodeHash;
  const dateChanged = !!h.lastCodeUpdate && h.lastCodeUpdate !== spec.baselineLastCodeUpdate;
  h.codeChanged = hashChanged || dateChanged;

  if (h.codeChanged) {
    h.health = 'changed';
    // Infra updates legitimately and often: information, not an alarm.
    h.severity = spec.kind === 'infra' ? 'info' : 'attention';
    return;
  }

  // Code matches baseline. Legacy accounts are expected to be idle.
  if (spec.expectInactive) {
    h.health = 'inactive';
    h.severity = 'info';
    return;
  }

  if (isSilent(h)) {
    h.health = 'silent';
    h.severity = 'watch';
    return;
  }

  h.health = 'ok';
  h.severity = 'ok';
}

/**
 * Runs a full scan. Every contract is fetched in parallel; `onProgress` is
 * called once after each contract resolves so the UI can paint results as
 * they arrive. Safe to call again (the Refresh button does).
 */
export async function runStatusScan(onProgress: () => void): Promise<void> {
  if (state.scanning) return;
  state.scanning = true;
  // Seed every card in a loading state up front.
  for (const spec of CONTRACTS) {
    state.results.set(spec.account, {
      spec, loading: true, health: 'ok', severity: 'unknown', codeChanged: false,
    });
  }
  onProgress();

  await Promise.all(
    CONTRACTS.map(async (spec) => {
      const health = await fetchOne(spec).catch((err): ContractHealth => ({
        spec, loading: false, health: 'unreachable', severity: 'unknown',
        codeChanged: false, error: err instanceof Error ? err.message : String(err),
      }));
      state.results.set(spec.account, health);
      onProgress();
    }),
  );

  state.scanning = false;
  state.scanned = true;
  state.lastScanAt = Date.now();
  onProgress();
}

// ─── rendering ──────────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatBytes(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/** Theme-token colour for a severity, used for the status accents. */
function sevColor(s: Severity): string {
  switch (s) {
    case 'ok':        return 'var(--ok)';
    case 'attention': return 'var(--danger)';
    case 'watch':     return 'var(--warn)';
    case 'info':      return 'var(--accent)';
    default:          return 'var(--muted)';
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "23 Sep 2024" - a compact, locale-independent calendar date (UTC). */
function formatDate(iso: string | undefined): string {
  const ms = parseChainDateMs(iso);
  if (ms === undefined) return 'unknown';
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "3 days", "5 hours", "~2 years" - a coarse, human duration. */
function durationWords(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  const mo = Math.floor(d / 30), y = Math.floor(d / 365);
  if (y >= 1) return `~${y} year${y > 1 ? 's' : ''}`;
  if (mo >= 1) return `~${mo} month${mo > 1 ? 's' : ''}`;
  if (d >= 1) return `${d} day${d > 1 ? 's' : ''}`;
  if (h >= 1) return `${h} hour${h > 1 ? 's' : ''}`;
  if (m >= 1) return `${m} minute${m > 1 ? 's' : ''}`;
  return 'moments';
}

function relAgo(iso: string | undefined): string {
  const ms = parseChainDateMs(iso);
  if (ms === undefined) return 'unknown';
  return `${durationWords(Date.now() - ms)} ago`;
}

function exactUtc(iso: string | undefined): string {
  const ms = parseChainDateMs(iso);
  if (ms === undefined) return 'unknown';
  return `${new Date(ms).toISOString().replace('T', ' ').replace('.000Z', ' UTC').replace(/\.\d+Z$/, ' UTC')}`;
}

interface Badge { label: string; cls: string; }

function badgeFor(h: ContractHealth): Badge {
  if (h.loading) return { label: 'checking…', cls: '' };
  switch (h.health) {
    case 'ok':          return { label: 'healthy', cls: 'ok' };
    case 'changed':     return h.severity === 'info'
                          ? { label: 'code updated', cls: 'accent' }
                          : { label: 'code changed', cls: 'warn' };
    case 'disabled':    return { label: 'no contract code', cls: 'err' };
    case 'silent':      return { label: `silent ${SILENT_DAYS}d+`, cls: 'warn' };
    case 'unreachable': return { label: 'unreachable', cls: '' };
    case 'service':     return { label: 'service account', cls: 'accent' };
    case 'inactive':    return { label: 'inactive (expected)', cls: '' };
  }
}

function codeLine(h: ContractHealth): string {
  if (h.loading) return '<span class="skeleton-inline shimmer">loading</span>';
  if (h.health === 'service' || isZeroHash(h.codeHash)) {
    return h.health === 'service'
      ? '<span class="term">no contract code (service account)</span>'
      : '<strong style="color:var(--danger)">no contract code deployed</strong>';
  }
  if (!h.lastCodeUpdate) return 'unknown';
  const ms = parseChainDateMs(h.lastCodeUpdate);
  const age = ms === undefined ? '' : durationWords(Date.now() - ms);
  const recent = ms !== undefined && Date.now() - ms < 30 * 86_400_000;
  const phrase = recent ? `changed ${age} ago` : `unchanged for ${age}`;
  const dateColor = h.codeChanged ? 'var(--danger)' : sevColor(h.severity);
  const flag = h.codeChanged ? ' <strong style="color:var(--danger)">differs from baseline!</strong>' : '';
  return `<strong style="color:${dateColor}">${esc(formatDate(h.lastCodeUpdate))}</strong> <span class="term">(${esc(phrase)})</span>${flag}`;
}

function activityLine(h: ContractHealth): string {
  if (h.loading) return '<span class="skeleton-inline shimmer">loading</span>';
  if (h.activityUnavailable) return 'activity history unavailable';
  if (!h.lastActionTs) return 'no recorded activity';
  return `last action ${esc(relAgo(h.lastActionTs))}${h.lastActionName ? ` (<code>${esc(h.lastActionName)}</code>)` : ''}`;
}

function renderCard(h: ContractHealth): string {
  const b = badgeFor(h);
  const explorer = `https://waxblock.io/account/${esc(h.spec.account)}`;
  const ram = h.ramUsage !== undefined ? `${formatBytes(h.ramUsage)}${h.ramQuota ? ` / ${formatBytes(h.ramQuota)}` : ''}` : '?';
  const balance = h.balance ?? '0 WAX';
  const color = sevColor(h.severity);
  return `
    <div class="card" style="margin-bottom:0; border-left:4px solid ${color}">
      <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:10px; flex-wrap:wrap">
        <div style="display:flex; align-items:center; gap:8px">
          <span aria-hidden="true" style="width:9px; height:9px; border-radius:50%; background:${color}; box-shadow:0 0 6px ${color}; flex:0 0 auto"></span>
          <div>
            <div style="font-weight:600; letter-spacing:0.4px">${esc(h.spec.label)}</div>
            <a href="${explorer}" target="_blank" rel="noopener"><code>${esc(h.spec.account)}</code></a>
          </div>
        </div>
        <span class="tag ${b.cls}">${esc(b.label)}</span>
      </div>
      <p class="term" style="margin:8px 0 10px; line-height:1.5; color:var(--fg-dim)">${esc(h.spec.role)}</p>
      <div style="font-size:12px; line-height:1.9">
        <div title="${esc(exactUtc(h.lastCodeUpdate))}">
          <span style="color:var(--muted)">Last code change:</span> ${codeLine(h)}
        </div>
        <div><span style="color:var(--muted)">Activity:</span> ${activityLine(h)}</div>
        <div>
          <span style="color:var(--muted)">RAM:</span> ${esc(ram)}
          &nbsp;·&nbsp; <span style="color:var(--muted)">Balance:</span> ${esc(balance)}
          ${h.keyCount !== undefined ? `&nbsp;·&nbsp; <span style="color:var(--muted)">Keys:</span> ${esc(h.keyCount)}` : ''}
        </div>
        ${h.created ? `<div title="${esc(exactUtc(h.created))}"><span style="color:var(--muted)">Created:</span> ${esc(relAgo(h.created))}</div>` : ''}
        ${h.error ? `<div class="status-line err" style="margin-top:6px">${esc(h.error)}</div>` : ''}
      </div>
      <div style="margin-top:10px">
        <a href="${explorer}" target="_blank" rel="noopener" class="term">view on waxblock.io →</a>
      </div>
    </div>`;
}

function renderGroup(name: ContractSpec['group']): string {
  const cards = CONTRACTS
    .filter((c) => c.group === name)
    .map((c) => state.results.get(c.account) ?? { spec: c, loading: true, health: 'ok', severity: 'unknown', codeChanged: false } as ContractHealth)
    .map(renderCard)
    .join('');
  return `
    <section style="background:transparent; border:none; box-shadow:none; padding:0; margin-bottom:22px">
      <h2>${esc(name)}</h2>
      <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(300px, 1fr)); gap:12px">
        ${cards}
      </div>
    </section>`;
}

function summaryBanner(): string {
  const loaded = [...state.results.values()].filter((h) => !h.loading);
  const attention = loaded.filter((h) => h.severity === 'attention'); // code wiped/changed
  const watch = loaded.filter((h) => h.severity === 'watch');         // silent / low traffic
  const unknown = loaded.filter((h) => h.severity === 'unknown');     // unreadable
  const total = CONTRACTS.length;
  const names = (list: ContractHealth[]) => list.map((h) => h.spec.account).join(', ');

  let cls = 'ok';
  let text: string;
  if (!state.scanned && state.scanning) {
    cls = '';
    text = `Scanning ${total} contracts…`;
  } else if (attention.length > 0) {
    // The only red-alarm case: code is missing or differs from the baseline.
    cls = 'err';
    text = `${attention.length} contract(s) need attention (code changed or missing): ${names(attention)}`;
  } else if (watch.length > 0 || unknown.length > 0) {
    cls = 'warn';
    const bits = [`All contract code is unchanged from the baseline`];
    if (watch.length) bits.push(`${watch.length} quiet (no activity in ${SILENT_DAYS}d+): ${names(watch)}`);
    if (unknown.length) bits.push(`${unknown.length} could not be read right now`);
    text = `${bits.join('. ')}.`;
  } else {
    cls = 'ok';
    text = `All ${total} contracts healthy: code unchanged and recently active.`;
  }

  return `<div class="tag ${cls}" style="display:block; padding:12px 16px; font-size:13px; letter-spacing:0.4px; text-transform:none">${esc(text)}</div>`;
}

function legend(): string {
  const item = (cls: string, label: string, meaning: string) =>
    `<span class="legend-item"><span class="tag ${cls}" style="padding:1px 7px">${esc(label)}</span> <span class="term">${esc(meaning)}</span></span>`;
  return `
    <div class="legend" style="margin-top:14px">
      <span class="legend-label">status</span>
      ${item('ok', 'healthy', 'code matches baseline, active')}
      <span class="legend-sep">·</span>
      ${item('warn', 'code changed', 'redeployed - review before trusting')}
      <span class="legend-sep">·</span>
      ${item('err', 'no code', 'contract wiped/disabled')}
      <span class="legend-sep">·</span>
      ${item('warn', `silent ${SILENT_DAYS}d+`, 'no recent activity')}
      <span class="legend-sep">·</span>
      ${item('accent', 'code updated', 'infra dependency changed (informational)')}
      <span class="legend-sep">·</span>
      ${item('', 'unreachable', 'could not read right now')}
    </div>`;
}

/** Full-page status view. Read by app.ts's render loop for route #/status. */
export function renderStatusPage(): string {
  const lastScan = state.lastScanAt
    ? `last scan ${esc(relAgo(new Date(state.lastScanAt).toISOString()))}`
    : (state.scanning ? 'scanning…' : 'not scanned yet');

  return `
    <a class="app-link" href="#/nefty" style="margin-bottom:14px">← Open the app</a>
    <section>
      <div class="card-header">
        <h2>Contract status monitor</h2>
        <button id="status-refresh" ${state.scanning ? 'disabled' : ''}>${state.scanning ? 'Scanning…' : 'Refresh'}</button>
      </div>
      <p class="term" style="margin:2px 0 12px; line-height:1.6; color:var(--fg-dim)">
        Live, read-only health of every on-chain contract Crucible relies on, plus
        their dependencies. The headline figure is <strong>when each contract's code
        last changed</strong>. A smart contract is only trustworthy as long as it
        behaves the way it did when you last checked it: if the owner
        <em>redeploys</em> (changes the code), this page flags it so you can
        re-verify it before signing anything. Nothing here is signed or written;
        it is pure observation.
      </p>
      ${summaryBanner()}
      ${legend()}
      <p class="term" style="margin-top:8px">${esc(lastScan)}</p>
    </section>
    ${renderGroup('NeftyBlocks')}
    ${renderGroup('WaxDAO')}
    ${renderGroup('Infrastructure')}`;
}
