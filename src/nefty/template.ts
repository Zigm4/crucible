import { atomicFetch, getTableRows } from '../chain/rpc';

export interface TemplateInfo {
  template_id: string;
  collection_name: string;
  schema_name?: string;
  name?: string;
  image?: string;
  /** Number minted so far. */
  issued_supply: number;
  /** Hard cap, 0 = unlimited. */
  max_supply: number;
  is_burnable: boolean;
  is_transferable: boolean;
}

const cache = new Map<string, { at: number; info: TemplateInfo }>();
const TTL_MS = 5 * 60_000;

/**
 * Loads a template by (collection, template_id). Tries the AtomicAssets
 * indexer first because it resolves `immutable_data` (i.e. gives us the
 * template's display name) without us having to decode the schema. Falls
 * back to the raw `atomicassets/templates` table when the indexer is down.
 */
export async function loadTemplate(args: {
  collection_name: string;
  template_id: string | number;
}): Promise<TemplateInfo | undefined> {
  const key = `${args.collection_name}::${args.template_id}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.info;

  try {
    const info = await fromIndexer(args);
    if (info) {
      cache.set(key, { at: Date.now(), info });
      return info;
    }
  } catch {
    // indexer down — fall back below
  }

  try {
    const info = await fromChain(args);
    if (info) {
      cache.set(key, { at: Date.now(), info });
      return info;
    }
  } catch {
    // both paths failed — return undefined; UI shows template_id only
  }
  return undefined;
}

interface RawIndexerTemplate {
  template_id: string;
  collection_name?: string;
  schema?: { schema_name?: string };
  immutable_data?: Record<string, unknown>;
  issued_supply?: string | number;
  max_supply?: string | number;
  is_burnable?: boolean;
  is_transferable?: boolean;
}

async function fromIndexer(args: {
  collection_name: string;
  template_id: string | number;
}): Promise<TemplateInfo | undefined> {
  const path = `/atomicassets/v1/templates/${encodeURIComponent(args.collection_name)}/${encodeURIComponent(String(args.template_id))}`;
  const raw = await atomicFetch<RawIndexerTemplate>(path);
  if (!raw) return undefined;
  const imm = raw.immutable_data ?? {};
  return {
    template_id: String(raw.template_id),
    collection_name: String(raw.collection_name ?? args.collection_name),
    schema_name: raw.schema?.schema_name,
    name: typeof imm.name === 'string' ? imm.name : undefined,
    image: typeof imm.img === 'string' ? imm.img : typeof imm.image === 'string' ? imm.image : undefined,
    issued_supply: Number(raw.issued_supply ?? 0) || 0,
    max_supply: Number(raw.max_supply ?? 0) || 0,
    is_burnable: !!raw.is_burnable,
    is_transferable: !!raw.is_transferable,
  };
}

interface RawChainTemplate {
  template_id: number | string;
  schema_name?: string;
  transferable?: boolean | number;
  burnable?: boolean | number;
  max_supply?: number | string;
  issued_supply?: number | string;
  immutable_serialized_data?: number[]; // raw bytes — undecoded
}

/**
 * On-chain fallback: reads atomicassets/templates with scope=collection,
 * key=template_id. We don't decode `immutable_serialized_data` (that needs
 * the schema ABI), so the name is unavailable here — the caller falls back
 * to showing just the template_id.
 */
async function fromChain(args: {
  collection_name: string;
  template_id: string | number;
}): Promise<TemplateInfo | undefined> {
  const rows = await getTableRows<RawChainTemplate>({
    code: 'atomicassets',
    scope: args.collection_name,
    table: 'templates',
    lower_bound: String(args.template_id),
    upper_bound: String(args.template_id),
    limit: 1,
  });
  const row = rows[0];
  if (!row) return undefined;
  return {
    template_id: String(row.template_id),
    collection_name: args.collection_name,
    schema_name: row.schema_name,
    name: undefined,
    image: undefined,
    issued_supply: Number(row.issued_supply ?? 0) || 0,
    max_supply: Number(row.max_supply ?? 0) || 0,
    is_burnable: !!row.burnable,
    is_transferable: !!row.transferable,
  };
}

export function clearTemplateCache() {
  cache.clear();
}
