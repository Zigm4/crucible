import { getTableRows } from '../chain/rpc';

/**
 * Drops live in the `neftyblocksd` contract on WAX, in a single global table
 * scoped by `neftyblocksd` (the contract account itself). Each row defines a
 * "drop": something a user can claim from. A drop typically mints one or more
 * NFTs to the claimer: optionally against a token payment.
 *
 * This module is the read-side companion to `dropExecute.ts`. It mirrors what
 * the indexer would expose, but speaks straight to the chain so we never
 * depend on an external service to even list what exists.
 */

const CACHE_TTL_MS = 5 * 60_000;

// Same parallel-scan strategy as the blends discovery.
const CHAIN_CHUNK_SIZE = 25_000n;
const CHAIN_ROWS_PER_CALL = 1000;
const CHAIN_MAX_CHUNKS = 16;

export type DropStatus =
  | 'active'
  | 'upcoming'
  | 'ended'
  | 'sold_out'
  | 'hidden';

/**
 * The on-chain `auth_required` flag tells us a drop is gated, but not *how*.
 * We resolve the gating mechanism by checking three sibling tables:
 *   - `whitelists` (scoped by drop_id, key = account name) → claimdropwl
 *   - `proofown`   (one row per drop_id, NFT-ownership filter) → claimwproof
 *   - `authkeys`   (scoped by drop_id, public-key gated)       → claimdropkey
 * Out of these: only `claimdropwl` and `claimwproof` are usable without a
 * pre-shared secret, so those are the only auth flavours we surface here.
 */
export type DropAuth =
  | { kind: 'public' }
  | { kind: 'whitelist'; allowed?: boolean }
  | { kind: 'proof'; filters: ProofFilter[]; resolved?: ProofResolution }
  | { kind: 'authkey' /* signed-key gated, unsupported by this tool */ }
  /** auth_required = true, but we haven't connected a wallet yet to verify the gate */
  | { kind: 'unverified' }
  /** auth_required = true, and we checked: NO auth list has any entry. The drop is structurally unclaimable until the creator populates a whitelist/proofown/authkey row. */
  | { kind: 'unclaimable' };

export interface ProofFilter {
  type: 'TEMPLATE_HOLDINGS' | 'SCHEMA_HOLDINGS' | 'COLLECTION_HOLDINGS' | 'TOKEN_HOLDING';
  collection_name?: string;
  schema_name?: string;
  template_id?: number;
  amount: number;
  comparison_operator: number;
}
export interface ProofResolution {
  /** Logical operator from LOGICAL_GROUP: 0 = AND, 1 = OR. */
  logical_operator: number;
  /** asset_ids picked to satisfy each filter (in filter order). */
  asset_ids: string[];
  /** True if every filter could be satisfied (AND) or at least one (OR). */
  satisfied: boolean;
}

export interface DiscoveredDrop {
  drop_id: string;
  collection_name: string;
  name: string;
  description?: string;
  /** "1.00000000 WAX" or "0 NULL" for free drops. */
  listing_price: string;
  /** "8,WAX", what the contract expects payment in. */
  settlement_symbol: string;
  is_free: boolean;
  /** template_id of the primary mint result (drops can mint several but UIs typically show the first). */
  primary_template_id?: number;
  /** All mints this drop produces: in order. */
  assets_to_mint: { template_id: number; tokens_to_back: string[]; use_pool: boolean }[];
  max_claimable: number; // 0 = unlimited
  current_claimed: number;
  start_time: number;
  end_time: number;
  account_limit: number;
  account_limit_cooldown: number;
  status: DropStatus;
  auth: DropAuth;
  /**
   * How many more times the connected user can claim this drop right now.
   * `Infinity` when the drop has no per-account limit.
   * `undefined` when no wallet is connected yet (we can't tell).
   */
  account_remaining?: number;
  /**
   * Unix-seconds timestamp after which the per-account counter would reset
   * (only set when remaining = 0 AND a cooldown is configured).
   */
  cooldown_resets_at?: number;
}

export interface AccStatsRow {
  drop_id: number | string;
  counter: number | string;
  last_claim_time: number;
  used_nonces?: unknown[];
}

/**
 * Computes how many more times `actor` can claim the drop right now.
 * Mirrors the on-chain assertion logic:
 *   - no per-account limit → Infinity
 *   - no prior claim row    → full limit
 *   - cooldown configured AND `now > last + cooldown` → counter is effectively
 *     reset to zero on the next claim, so full limit is again available
 *   - otherwise → `limit - counter`, floored at 0
 */
export function remainingClaims(
  drop: DiscoveredDrop,
  stats: AccStatsRow | undefined,
  nowSec: number = Math.floor(Date.now() / 1000),
): number {
  if (drop.account_limit <= 0) return Infinity;
  if (!stats) return drop.account_limit;
  const counter = Number(stats.counter ?? 0);
  if (
    drop.account_limit_cooldown > 0 &&
    nowSec > Number(stats.last_claim_time ?? 0) + drop.account_limit_cooldown
  ) {
    return drop.account_limit;
  }
  return Math.max(0, drop.account_limit - counter);
}

export type DiscoverySource = 'on_chain'; // indexer integration could be added later

interface RawDropRow {
  drop_id: number | string;
  collection_name: string;
  assets_to_mint: { template_id: number; tokens_to_back: string[]; use_pool: boolean | number }[];
  listing_price: string;
  settlement_symbol: string;
  price_recipient?: string;
  auth_required: boolean | number;
  account_limit: number | string;
  account_limit_cooldown: number;
  max_claimable: number | string;
  current_claimed: number | string;
  start_time: number;
  end_time: number;
  display_data?: string;
  is_hidden?: boolean | number;
}

interface RawWhitelistRow { account: string; account_limit?: number }
interface RawProofownRow {
  drop_id: number | string;
  group: {
    logical_operator: number;
    filters: Array<[string, Record<string, unknown>]>;
  };
}

interface CacheEntry {
  at: number;
  drops: DiscoveredDrop[];
}
const cache = new Map<string, CacheEntry>();

export interface ListDropsOpts {
  collection: string;
  includeInactive: boolean;
  /** When provided: resolve auth_required drops (whitelist + proof check). */
  actor?: string;
  /**
   * When provided alongside actor: used to resolve proof drops. Should be the
   * user's owned NFTs in the same collection (we filter by template/schema).
   */
  ownedAssets?: { asset_id: string; template?: { template_id?: string } | null; schema?: { schema_name?: string }; collection?: { collection_name?: string } }[];
  onProgress?: (msg: string, pct: number) => void;
}

export async function listDrops(
  opts: ListDropsOpts,
): Promise<{ drops: DiscoveredDrop[]; source: DiscoverySource }> {
  const key = `${opts.collection}::${opts.includeInactive}::${opts.actor ?? ''}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { drops: hit.drops, source: 'on_chain' };
  }

  opts.onProgress?.('Probing drops head…', 0.02);
  const tail = await getTableRows<{ drop_id: number | string }>({
    code: 'neftyblocksd',
    scope: 'neftyblocksd',
    table: 'drops',
    limit: 1,
    reverse: true,
  });
  const headFromProbe = tail.length ? BigInt(String(tail[0].drop_id ?? 0)) + 1n : 0n;
  const headId = headFromProbe > 1000n ? headFromProbe : 300_000n;

  const ranges: { from: bigint; to: bigint }[] = [];
  for (let from = 0n; from < headId && ranges.length < CHAIN_MAX_CHUNKS; from += CHAIN_CHUNK_SIZE) {
    ranges.push({ from, to: from + CHAIN_CHUNK_SIZE });
  }

  let done = 0;
  const filtered: RawDropRow[] = [];
  await Promise.all(
    ranges.map(async (range) => {
      try {
        const rows = await scanRange(range.from, range.to);
        for (const r of rows) {
          if (r.collection_name === opts.collection) filtered.push(r);
        }
      } finally {
        done++;
        opts.onProgress?.(`Scanning chain ${done}/${ranges.length} ranges (${filtered.length} match so far)`, 0.05 + 0.85 * (done / ranges.length));
      }
    }),
  );

  let drops = filtered.map(toDiscovered).filter((d): d is DiscoveredDrop => !!d);
  if (!opts.includeInactive) {
    drops = drops.filter((d) => d.status === 'active');
  }
  drops.sort((a, b) => {
    const p = statusPriority(a.status) - statusPriority(b.status);
    if (p !== 0) return p;
    return Number(b.drop_id) - Number(a.drop_id);
  });

  // Resolve auth (whitelist + proof) for `auth_required` drops, in parallel.
  if (opts.actor) {
    opts.onProgress?.('Resolving access (whitelists / proofs)…', 0.92);
    await Promise.all(
      drops
        .filter((d) => d.auth.kind === 'unverified')
        .map((d) => resolveAuth(d, opts.actor!, opts.ownedAssets ?? [])),
    );

    // Per-account claim limits: one batched table read for ALL of the user's
    // historical claims, then a fast in-memory lookup per drop.
    opts.onProgress?.('Reading your claim history…', 0.96);
    const statsByDrop = await loadAllAccStats(opts.actor);
    const now = Math.floor(Date.now() / 1000);
    for (const d of drops) {
      if (d.account_limit <= 0) {
        d.account_remaining = Infinity;
        continue;
      }
      const stats = statsByDrop.get(d.drop_id);
      d.account_remaining = remainingClaims(d, stats, now);
      if (
        d.account_remaining === 0 &&
        d.account_limit_cooldown > 0 &&
        stats
      ) {
        d.cooldown_resets_at =
          Number(stats.last_claim_time) + d.account_limit_cooldown;
      }
    }
  }

  opts.onProgress?.(`${drops.length} drop(s) found.`, 1);
  cache.set(key, { at: Date.now(), drops });
  return { drops, source: 'on_chain' };
}

async function scanRange(from: bigint, to: bigint): Promise<RawDropRow[]> {
  const rows: RawDropRow[] = [];
  let cursor = from;
  while (cursor < to) {
    const batch = await getTableRows<RawDropRow>({
      code: 'neftyblocksd',
      scope: 'neftyblocksd',
      table: 'drops',
      lower_bound: String(cursor),
      upper_bound: String(to),
      limit: CHAIN_ROWS_PER_CALL,
    });
    if (batch.length === 0) break;
    rows.push(...batch);
    const lastId = BigInt(String(batch[batch.length - 1].drop_id ?? cursor));
    if (lastId + 1n <= cursor) break;
    cursor = lastId + 1n;
    if (batch.length < CHAIN_ROWS_PER_CALL) break;
  }
  return rows;
}

function statusPriority(s: DropStatus): number {
  switch (s) {
    case 'active': return 0;
    case 'upcoming': return 1;
    case 'ended': return 2;
    case 'sold_out': return 3;
    case 'hidden': return 4;
  }
}

function parseDisplayData(d: string | undefined): { name?: string; description?: string } {
  if (!d) return {};
  try {
    const o = JSON.parse(d);
    if (typeof o !== 'object' || !o) return {};
    return o as { name?: string; description?: string };
  } catch {
    return {};
  }
}

function computeStatus(r: RawDropRow): DropStatus {
  if (r.is_hidden) return 'hidden';
  const max = Number(r.max_claimable ?? 0);
  const claimed = Number(r.current_claimed ?? 0);
  if (max > 0 && claimed >= max) return 'sold_out';
  const now = Date.now() / 1000; // start/end are seconds on-chain
  if (r.start_time > 0 && r.start_time > now) return 'upcoming';
  if (r.end_time > 0 && r.end_time < now) return 'ended';
  return 'active';
}

function toDiscovered(r: RawDropRow): DiscoveredDrop | undefined {
  if (r.drop_id === undefined || r.drop_id === null) return undefined;
  const dd = parseDisplayData(r.display_data);
  const id = String(r.drop_id);
  const isFree = /^0\s/.test(r.listing_price.trim()) || /^0\.0*\s/.test(r.listing_price.trim());
  const auth_required = !!r.auth_required;
  return {
    drop_id: id,
    collection_name: r.collection_name,
    name: dd.name || `Drop #${id}`,
    description: dd.description,
    listing_price: r.listing_price,
    settlement_symbol: r.settlement_symbol,
    is_free: isFree,
    primary_template_id: r.assets_to_mint?.[0]?.template_id,
    assets_to_mint: (r.assets_to_mint ?? []).map((m) => ({
      template_id: Number(m.template_id),
      tokens_to_back: m.tokens_to_back ?? [],
      use_pool: !!m.use_pool,
    })),
    max_claimable: Number(r.max_claimable ?? 0),
    current_claimed: Number(r.current_claimed ?? 0),
    start_time: Number(r.start_time ?? 0),
    end_time: Number(r.end_time ?? 0),
    account_limit: Number(r.account_limit ?? 0),
    account_limit_cooldown: Number(r.account_limit_cooldown ?? 0),
    status: computeStatus(r),
    auth: auth_required ? { kind: 'unverified' } : { kind: 'public' },
  };
}

/**
 * Resolves the auth flavour of an `auth_required` drop by checking the three
 * possible auth tables and, for proof drops, picking concrete asset_ids from
 * the user's wallet that satisfy each filter.
 */
async function resolveAuth(
  drop: DiscoveredDrop,
  actor: string,
  ownedAssets: ListDropsOpts['ownedAssets'] = [],
): Promise<void> {
  // 1) whitelist?
  try {
    const rows = await getTableRows<RawWhitelistRow>({
      code: 'neftyblocksd',
      scope: drop.drop_id,
      table: 'whitelists',
      limit: 1000,
    });
    if (rows.length > 0) {
      const allowed = rows.some((r) => r.account === actor);
      drop.auth = { kind: 'whitelist', allowed };
      return;
    }
  } catch { /* fall through */ }

  // 2) proof-of-ownership?
  try {
    const rows = await getTableRows<RawProofownRow>({
      code: 'neftyblocksd',
      scope: 'neftyblocksd',
      table: 'proofown',
      lower_bound: drop.drop_id,
      upper_bound: drop.drop_id,
      limit: 1,
    });
    if (rows.length > 0) {
      const filters: ProofFilter[] = (rows[0].group.filters ?? []).map(([type, p]) => ({
        type: type as ProofFilter['type'],
        collection_name: p.collection_name as string | undefined,
        schema_name: p.schema_name as string | undefined,
        template_id: p.template_id !== undefined ? Number(p.template_id) : undefined,
        amount: Number(p.amount ?? 1),
        comparison_operator: Number(p.comparison_operator ?? 3),
      }));
      const resolved = resolveProof(filters, rows[0].group.logical_operator, ownedAssets);
      drop.auth = { kind: 'proof', filters, resolved };
      return;
    }
  } catch { /* fall through */ }

  // 3) authkey gated, not user-signable
  try {
    const rows = await getTableRows<unknown>({
      code: 'neftyblocksd',
      scope: drop.drop_id,
      table: 'authkeys',
      limit: 1,
    });
    if (rows.length > 0) {
      drop.auth = { kind: 'authkey' };
      return;
    }
  } catch { /* ignore */ }

  // auth_required = true but no auth list has any entry. The drop creator
  // turned auth on without populating any gate, the contract will refuse
  // every claim, no matter who tries.
  drop.auth = { kind: 'unclaimable' };
}

function resolveProof(
  filters: ProofFilter[],
  logical_operator: number,
  ownedAssets: ListDropsOpts['ownedAssets'] = [],
): ProofResolution {
  // Pick one matching asset per filter (greedy, in order), avoiding reuse.
  const used = new Set<string>();
  const picks: string[] = [];
  for (const f of filters) {
    const candidate = ownedAssets.find((a) => {
      if (used.has(a.asset_id)) return false;
      if (f.type === 'TEMPLATE_HOLDINGS') {
        return (
          a.collection?.collection_name === f.collection_name &&
          a.template?.template_id === String(f.template_id)
        );
      }
      if (f.type === 'SCHEMA_HOLDINGS') {
        return (
          a.collection?.collection_name === f.collection_name &&
          a.schema?.schema_name === f.schema_name
        );
      }
      if (f.type === 'COLLECTION_HOLDINGS') {
        return a.collection?.collection_name === f.collection_name;
      }
      return false;
    });
    if (candidate) {
      used.add(candidate.asset_id);
      picks.push(candidate.asset_id);
    }
  }
  const satisfied = logical_operator === 1
    ? picks.length > 0
    : picks.length === filters.length;
  return { logical_operator, asset_ids: picks, satisfied };
}

/**
 * Single batched read of `accstats` for the actor, one row per drop they've
 * ever claimed. The contract scopes `accstats` by the claimer's account, so
 * we just need their wallet name as the scope and we get the whole history.
 */
async function loadAllAccStats(actor: string): Promise<Map<string, AccStatsRow>> {
  const rows = await getTableRows<AccStatsRow>({
    code: 'neftyblocksd',
    scope: actor,
    table: 'accstats',
    limit: 1000,
  });
  return new Map(rows.map((r) => [String(r.drop_id), r]));
}

export function clearDropsCache() {
  cache.clear();
}
