import { atomicFetch } from '../chain/rpc';

export interface AtomicAsset {
  asset_id: string;
  owner: string;
  template?: { template_id: string } | null;
  schema?: { schema_name: string };
  collection?: { collection_name: string };
  name?: string;
  data?: Record<string, unknown>;
  template_mint?: string;
}

const cache = new Map<string, AtomicAsset[]>();

export async function listAssetsForOwner(args: {
  owner: string;
  collection_name?: string;
  force?: boolean;
}): Promise<AtomicAsset[]> {
  const key = `${args.owner}::${args.collection_name ?? ''}`;
  if (!args.force && cache.has(key)) return cache.get(key)!;

  const all: AtomicAsset[] = [];
  let page = 1;
  const pageSize = 1000;
  while (true) {
    const qs = new URLSearchParams({
      owner: args.owner,
      page: String(page),
      limit: String(pageSize),
      order: 'desc',
      sort: 'asset_id',
    });
    if (args.collection_name) qs.set('collection_name', args.collection_name);
    const batch = await atomicFetch<AtomicAsset[]>(`/atomicassets/v1/assets?${qs.toString()}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < pageSize) break;
    page += 1;
    if (page > 20) break; // safety stop: 20k assets max
  }
  cache.set(key, all);
  return all;
}

export function clearAssetsCache() {
  cache.clear();
}
