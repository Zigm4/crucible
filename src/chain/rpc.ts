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
      const result = await fn(new APIClient({ url }));
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

/**
 * Try each atomicassets API host until one answers OK.
 * Returns the parsed JSON body of `path` (a path starting with /).
 */
export async function atomicFetch<T = unknown>(path: string): Promise<T> {
  let lastErr: unknown;
  for (const base of ATOMIC_API_ENDPOINTS) {
    try {
      const url = base + path;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      const body = (await res.json()) as { success?: boolean; data?: T; message?: string };
      if (body.success === false) {
        throw new Error(`AtomicAssets API: ${body.message ?? 'unknown error'}`);
      }
      // atomicassets convention: { success: true, data: ..., query_time: ... }
      return (body.data ?? body) as T;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `All AtomicAssets endpoints failed. Last error: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}
