/**
 * Reader for `blend.nefty`'s NFT pools.
 *
 * A blend roll can hand out its reward two ways:
 *   - ON_DEMAND_NFT_RESULT : the contract mints a fresh NFT from a template
 *     at fuse time. The result is fully known before signing.
 *   - POOL_NFT_RESULT      : the reward NFTs were minted ahead of time and
 *     deposited into a named pool by the collection author. At fuse time the
 *     contract draws ONE of the assets still sitting in that pool, so the
 *     exact `asset_id` is only known once the claim row is staged.
 *
 * Pools are how a capped-supply reward (max_supply already fully minted) can
 * still be used as a blend output. Two tables back them:
 *
 *   pools       scope = collection_name , key = pool_name
 *               { pool_name, pool_id, amount_added, amount_reserved,
 *                 count, used, templates[] }
 *               `count` is what is LEFT to draw; `amount_added` is the
 *               lifetime total; `templates` (a binary-extension field, so
 *               possibly absent on older rows) lists the templates the pool
 *               can hand out.
 *
 *   poolassets  scope = pool_id , single row id=0
 *               { id, assets[] }  -- the concrete asset_ids still in escrow.
 *
 * Everything here is read-only and best-effort: a pool that can't be read
 * degrades the UI to "unknown stock", it never blocks the blend.
 */
import { getTableRows } from '../chain/rpc';

/** Raw `pools` row as returned by the contract. */
interface PoolRow {
  pool_name: string;
  pool_id: number | string;
  amount_added: number;
  amount_reserved: number;
  count: number;
  used: boolean | number;
  /** Binary extension: missing on pools created before the field existed. */
  templates?: (number | string)[];
}

/** Raw `poolassets` row (there is exactly one, id = 0, per pool scope). */
interface PoolAssetsRow {
  id: number | string;
  assets: (number | string)[];
}

export interface PoolInfo {
  pool_name: string;
  pool_id: string;
  /** NFTs still drawable from the pool. */
  remaining: number;
  /** Lifetime total ever deposited. */
  added: number;
  /** Held back for claims already staged but not yet minted out. */
  reserved: number;
  /** Templates this pool can hand out (empty when the row predates the field). */
  templates: number[];
  /** The concrete asset_ids left in escrow. Empty when the table read failed. */
  asset_ids: string[];
}

const cache = new Map<string, { at: number; info: PoolInfo }>();
const TTL_MS = 60_000;

/**
 * Loads one pool by (collection, pool_name), plus the asset_ids still in it.
 * Returns undefined when the pool row doesn't exist (deleted pool, typo in
 * the blend's result, ...), which the caller renders as "pool unavailable".
 */
export async function loadPool(args: {
  collection_name: string;
  pool_name: string;
}): Promise<PoolInfo | undefined> {
  const key = `${args.collection_name}::${args.pool_name}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.info;

  // `pools` is keyed by pool_name (a `name`), so the id bounds are the name
  // itself. Scope is the collection, NOT blend.nefty.
  const rows = await getTableRows<PoolRow>({
    code: 'blend.nefty',
    scope: args.collection_name,
    table: 'pools',
    lower_bound: args.pool_name,
    upper_bound: args.pool_name,
    limit: 1,
  });
  const row = rows[0];
  if (!row) return undefined;

  const pool_id = String(row.pool_id);
  const info: PoolInfo = {
    pool_name: String(row.pool_name),
    pool_id,
    remaining: Number(row.count ?? 0) || 0,
    added: Number(row.amount_added ?? 0) || 0,
    reserved: Number(row.amount_reserved ?? 0) || 0,
    templates: (row.templates ?? []).map((t) => Number(t)).filter((t) => t > 0),
    asset_ids: await readPoolAssets(pool_id),
  };
  cache.set(key, { at: Date.now(), info });
  return info;
}

/**
 * The asset_ids still escrowed for a pool. Scope is the pool_id (as a
 * number-name), and the table holds a single row keyed 0. Failures are
 * swallowed: the pool's `count` alone is enough for the UI.
 */
async function readPoolAssets(pool_id: string): Promise<string[]> {
  try {
    const rows = await getTableRows<PoolAssetsRow>({
      code: 'blend.nefty',
      scope: pool_id,
      table: 'poolassets',
      limit: 10,
    });
    const out: string[] = [];
    for (const r of rows) out.push(...(r.assets ?? []).map(String));
    return out;
  } catch {
    return [];
  }
}

export function clearPoolCache() {
  cache.clear();
}
