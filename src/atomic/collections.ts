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

export function clearCollectionAuthCache() {
  cache.clear();
}
