/**
 * WAX chain client with multi-host failover.
 *
 * Every read in the app goes through `withFailover()` (or its sugar
 * `getTableRows()`), which walks the list of public RPC endpoints in
 * order until one answers. Same idea for `atomicFetch()` against the
 * AtomicAssets API hosts.
 *
 * The cached client is hot-swapped to the last-known-good endpoint, so
 * subsequent calls don't waste time on the dead host.
 *
 * Forks can add or reorder endpoints below; the list is the only thing
 * tying the app to a particular infrastructure provider.
 */
import { APIClient } from '@wharfkit/session';

export const WAX_CHAIN_ID =
  '1064487b3cd1a897ce03ae5b6a865651747e2e152090f99c1d19d44e01aea5a4';

export const WAX_RPC_ENDPOINTS = [
  'https://wax.eosphere.io',
  'https://wax.greymass.com',
  'https://api.wax.alohaeos.com',
  'https://wax.eu.eosamsterdam.net',
];

export const ATOMIC_API_ENDPOINTS = [
  'https://aa.wax.atomichub.io',
  'https://wax.api.atomicassets.io',
  'https://aa-wax-public1.neftyblocks.com',
];

// Per-request deadlines. Without these a host that accepts the connection
// but never responds would block the whole failover loop forever (the UI
// then "searches without ever advancing"). On timeout we move to the next
// endpoint, and ultimately to the on-chain fallback.
const RPC_TIMEOUT_MS = 8_000;
// Indexer (fast-path) deadline before we give up and fall back to the
// on-chain scan. Generous so a slow-but-alive indexer still gets a chance.
const ATOMIC_TIMEOUT_MS = 10_000;

/**
 * Rejects with a timeout error if `p` doesn't settle within `ms`. Used to
 * bound RPC calls whose underlying client offers no timeout of its own.
 */
function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

let cachedClient: APIClient | undefined;

export function getApiClient(): APIClient {
  if (!cachedClient) {
    cachedClient = new APIClient({ url: WAX_RPC_ENDPOINTS[0] });
  }
  return cachedClient;
}

/**
 * Sequentially tries each WAX RPC endpoint until one returns successfully.
 * Used for table reads where any reachable node is fine.
 */
export async function withFailover<T>(
  fn: (client: APIClient) => Promise<T>,
): Promise<T> {
  let lastErr: unknown;
  for (const url of WAX_RPC_ENDPOINTS) {
    try {
      const result = await withDeadline(fn(new APIClient({ url })), RPC_TIMEOUT_MS, url);
      // promote the working endpoint as default for subsequent calls
      cachedClient = new APIClient({ url });
      return result;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `All WAX RPC endpoints failed. Last error: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

export interface GetTableRowsArgs {
  code: string;
  scope: string;
  table: string;
  lower_bound?: string | number;
  upper_bound?: string | number;
  limit?: number;
  index_position?:
    | 'primary'
    | 'secondary'
    | 'tertiary'
    | 'fourth'
    | 'fifth'
    | 'sixth'
    | 'seventh'
    | 'eighth'
    | 'ninth'
    | 'tenth';
  key_type?: 'i64' | 'i128' | 'i256' | 'float64' | 'float128' | 'sha256' | 'ripemd160' | 'name';
  reverse?: boolean;
  show_payer?: boolean;
}

export async function getTableRows<Row = unknown>(
  args: GetTableRowsArgs,
): Promise<Row[]> {
  // Use the untyped JSON RPC call to keep input shape flexible (the typed
  // wrapper requires native Antelope types for lower/upper_bound).
  return withFailover(async (client) => {
    const params: Record<string, unknown> = {
      json: true,
      code: args.code,
      scope: args.scope,
      table: args.table,
      limit: args.limit ?? 100,
    };
    if (args.lower_bound !== undefined) params.lower_bound = String(args.lower_bound);
    if (args.upper_bound !== undefined) params.upper_bound = String(args.upper_bound);
    if (args.index_position) params.index_position = args.index_position;
    if (args.key_type) params.key_type = args.key_type;
    if (args.reverse) params.reverse = true;
    if (args.show_payer) params.show_payer = true;
    const res = (await client.call({
      path: '/v1/chain/get_table_rows',
      params,
    })) as { rows: Row[] };
    return res.rows;
  });
}

export async function getAccount(name: string) {
  return withFailover((client) => client.v1.chain.get_account(name));
}

// ─── contract monitoring helpers (read-only, used by the status page) ──── //

/**
 * Public Hyperion history hosts (separate service from the chain API above).
 * Verified to serve /v2/history for WAX. Used only to read the most recent
 * action timestamp of an account; never required for the rest of the app.
 */
export const HYPERION_ENDPOINTS = [
  'https://wax.eosphere.io',
  'https://api.waxsweden.org',
];

const HYPERION_TIMEOUT_MS = 8_000;

/** Raw `/v1/chain/get_account` across the RPC failover list. */
export async function getAccountInfo(name: string): Promise<Record<string, unknown>> {
  return withFailover(async (client) =>
    (await client.call({
      path: '/v1/chain/get_account',
      params: { account_name: name },
    })) as Record<string, unknown>,
  );
}

/**
 * Code hash for an account. An all-zero hash means there is no contract
 * code deployed (a plain account, or a contract that was wiped).
 */
export async function getCodeHash(name: string): Promise<string> {
  return withFailover(async (client) => {
    const res = (await client.call({
      path: '/v1/chain/get_code_hash',
      params: { account_name: name },
    })) as { code_hash?: string };
    return res.code_hash ?? '';
  });
}

export interface LastAction {
  timestamp: string;
  name: string;
}

/**
 * Most recent action for an account, via Hyperion history. Tries each host
 * with a deadline. Returns null when a host answers but the account has no
 * history; throws only when every host fails (so the caller can show
 * "activity unavailable" without losing the rest of the contract's data).
 */
export async function getLastAction(account: string): Promise<LastAction | null> {
  let lastErr: unknown;
  for (const base of HYPERION_ENDPOINTS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HYPERION_TIMEOUT_MS);
    try {
      const url = `${base}/v2/history/get_actions?account=${encodeURIComponent(account)}&limit=1&sort=desc`;
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${base}`);
      const body = (await res.json()) as {
        actions?: Array<{ timestamp?: string; act?: { name?: string } }>;
      };
      const a = body.actions?.[0];
      if (!a || !a.timestamp) return null;
      return { timestamp: a.timestamp, name: a.act?.name ?? '' };
    } catch (err) {
      lastErr = ctrl.signal.aborted ? new Error(`${base} timed out`) : err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(
    `All Hyperion endpoints failed. Last error: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

/**
 * Try each atomicassets API host until one answers OK.
 * Returns the parsed JSON body of `path` (a path starting with /).
 */
export async function atomicFetch<T = unknown>(path: string): Promise<T> {
  let lastErr: unknown;
  for (const base of ATOMIC_API_ENDPOINTS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ATOMIC_TIMEOUT_MS);
    try {
      const url = base + path;
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      const body = (await res.json()) as { success?: boolean; data?: T; message?: string };
      if (body.success === false) {
        throw new Error(`AtomicAssets API: ${body.message ?? 'unknown error'}`);
      }
      // atomicassets convention: { success: true, data: ..., query_time: ... }
      return (body.data ?? body) as T;
    } catch (err) {
      lastErr = ctrl.signal.aborted ? new Error(`${base} timed out after ${ATOMIC_TIMEOUT_MS}ms`) : err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(
    `All AtomicAssets endpoints failed. Last error: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}
