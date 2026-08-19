/**
 * Reads AtomicAssets collection metadata, specifically the author and
 * the `authorized_accounts` list, to decide whether the connected
 * wallet is allowed to MANAGE a collection (hide/end/delete blends,
 * edit whitelists, ...).
 *
 * This is purely a UI gate: the on-chain contracts re-check
 * authorization on every admin action, so a user who bypassed the
 * gate would just get their transaction rejected. We use it to avoid
 * showing powerful controls to people who can't use them.
 */

import { atomicFetch, getTableRows } from '../chain/rpc';

export interface AuthorizedCollection {
  collection_name: string;
  /** Human-readable display name (falls back to the raw name). */
  name: string;
}

/**
 * Lists the collections the given account can manage (author or in
 * authorized_accounts), via the AtomicAssets API's `authorized_account`
 * filter. There is no on-chain reverse index for this, so it relies on the
 * indexer; returns [] if the indexer is unreachable.
 */
export async function listAuthorizedCollections(actor: string): Promise<AuthorizedCollection[]> {
  if (!actor) return [];
  const data = await atomicFetch<{ collection_name: string; name?: string }[]>(
    `/atomicassets/v1/collections?authorized_account=${encodeURIComponent(actor)}&limit=100&order=asc&sort=collection_name`,
  );
  return (data ?? []).map((c) => ({
    collection_name: c.collection_name,
    name: c.name || c.collection_name,
  }));
}

export interface CollectionAuth {
  collection_name: string;
  author: string;
  authorized_accounts: string[];
}

const cache = new Map<string, { at: number; data: CollectionAuth | null }>();
const TTL_MS = 5 * 60_000;

interface RawCollectionRow {
  collection_name: string;
  author: string;
  authorized_accounts: string[];
}

/**
 * Fetches the author + authorized_accounts for a collection. Returns
 * null when the collection doesn't exist. Cached for 5 minutes.
 */
export async function getCollectionAuth(collection_name: string): Promise<CollectionAuth | null> {
  const hit = cache.get(collection_name);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

  let data: CollectionAuth | null = null;
  try {
    const rows = await getTableRows<RawCollectionRow>({
      code: 'atomicassets',
      scope: 'atomicassets',
      table: 'collections',
      lower_bound: collection_name,
      upper_bound: collection_name,
      limit: 1,
    });
    if (rows.length > 0 && rows[0].collection_name === collection_name) {
      data = {
        collection_name,
        author: rows[0].author,
        authorized_accounts: rows[0].authorized_accounts ?? [],
      };
    }
  } catch {
    data = null;
  }
  cache.set(collection_name, { at: Date.now(), data });
  return data;
}

/**
 * True when `actor` can manage `collection_name`: it's the author, or
 * it's in the authorized_accounts list. Contract accounts (blend.nefty,
 * atomicpacksx, ...) also appear in authorized_accounts, but a human
 * actor only matches if a human added them, which is exactly the set
 * we want to surface controls to.
 */
export async function canManageCollection(actor: string, collection_name: string): Promise<boolean> {
  if (!actor || !collection_name) return false;
  const a = await getCollectionAuth(collection_name);
  if (!a) return false;
  return a.author === actor || a.authorized_accounts.includes(actor);
}

/**
 * Can `contract` mint into (or rewrite assets of) this collection?
 *
 * AtomicAssets only lets an account in a collection's `authorized_accounts`
 * mint or edit its assets. So a blend whose collection never added
 * `blend.nefty` is a recipe nobody can ever run: the contract cannot mint
 * the reward. The recipe still exists, still reads as active, and still
 * shows a start date and a supply.
 *
 * This is not hypothetical. Measured over the 1000 most recent recipes of
 * each kind: 2 of 52 blend collections and 2 of 135 drop collections do not
 * authorize the contract their own recipes depend on. One of them,
 * `timberlegend`, has 13 blends and 32 drops in that state.
 *
 * How badly it hurts depends on the transaction count. A deterministic
 * blend or a drop claim is one atomic transaction, so the mint failing
 * reverts everything and the player keeps their NFTs, losing only CPU and
 * getting a cryptic error. A random blend or a pack unbox is TWO: the
 * ingredients leave in the first and the reward arrives in the second, so
 * a permanent failure in the second leaves the player with neither.
 *
 * Returns `undefined` when the collection cannot be read, which callers
 * must treat as "unknown", never as "not authorized": a dead indexer
 * should not block a recipe that is actually fine.
 */
export async function isContractAuthorized(
  collection_name: string,
  contract: string,
): Promise<boolean | undefined> {
  try {
    const auth = await getCollectionAuth(collection_name);
    if (!auth) return undefined;
    return auth.author === contract || auth.authorized_accounts.includes(contract);
  } catch {
    return undefined;
  }
}

export function clearCollectionAuthCache() {
  cache.clear();
}
