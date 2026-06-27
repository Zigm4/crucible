/**
 * Pack discovery for neftyblocksp (NeftyBlocks-native packs).
 *
 * Same idea as atomicpacksx (packs.ts): a pack is a regular AtomicAssets
 * NFT whose template_id is registered in a contract's `packs` table. The
 * difference is the contract and the open/claim mechanics (see
 * neftyPackExecute.ts / neftyPackWait.ts). This module is the read side:
 * it lists the pack designs registered on neftyblocksp so the Unpack tab
 * can match them against the wallet's NFTs.
 *
 * The neftyblocksp `packs` row is { pack_id, collection_name, unlock_time,
 * pack_template_id, recipe_id, use_count, display_data }. What a pack mints
 * comes from its `recipe_id` (recipes/results tables) and is only fully
 * known once the ORNG callback stages the result, so we don't pre-compute
 * per-roll odds here - `roll_counter` is left 0 and the resolved cards are
 * shown after the announce step, exactly like atomicpacksx.
 */
import { getTableRows } from '../chain/rpc';
import type { PackDesign } from './packs';

const CHAIN_CHUNK_SIZE = 5_000n;
const CHAIN_ROWS_PER_CALL = 1000;
const CHAIN_MAX_CHUNKS = 16;

interface RawNeftyPackRow {
  pack_id: number | string;
  collection_name: string;
  unlock_time: number;
  pack_template_id: number;
  recipe_id: number | string;
  display_data?: string;
}

const cache = new Map<string, { at: number; data: PackDesign[] }>();
const TTL_MS = 5 * 60_000;

function parseDisplayData(d: string | undefined): { name?: string; description?: string; image?: string } {
  if (!d) return {};
  try {
    const o = JSON.parse(d);
    return o && typeof o === 'object' ? (o as { name?: string; description?: string; image?: string }) : {};
  } catch {
    return {};
  }
}

/**
 * Lists pack DESIGNS from the global neftyblocksp::packs table (chunked
 * scan, like the atomicpacksx one). Filtered to `collection` when given,
 * else every design. Cached 5 minutes.
 */
export async function listNeftyPackDesigns(collection?: string): Promise<PackDesign[]> {
  const key = collection ?? '*';
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

  const tail = await getTableRows<RawNeftyPackRow>({
    code: 'neftyblocksp',
    scope: 'neftyblocksp',
    table: 'packs',
    limit: 1,
    reverse: true,
  });
  const head = tail.length ? BigInt(String(tail[0].pack_id ?? 0)) + 1n : 0n;
  const headId = head > 100n ? head : 5_000n;

  const ranges: { from: bigint; to: bigint }[] = [];
  for (let from = 0n; from < headId && ranges.length < CHAIN_MAX_CHUNKS; from += CHAIN_CHUNK_SIZE) {
    ranges.push({ from, to: from + CHAIN_CHUNK_SIZE });
  }

  const matched: RawNeftyPackRow[] = [];
  await Promise.all(
    ranges.map(async (r) => {
      const rows = await scanRange(r.from, r.to);
      for (const row of rows) {
        if (!collection || row.collection_name === collection) matched.push(row);
      }
    }),
  );

  const designs = matched.map(toDesign);
  cache.set(key, { at: Date.now(), data: designs });
  return designs;
}

async function scanRange(from: bigint, to: bigint): Promise<RawNeftyPackRow[]> {
  const rows: RawNeftyPackRow[] = [];
  let cursor = from;
  while (cursor < to) {
    const batch = await getTableRows<RawNeftyPackRow>({
      code: 'neftyblocksp',
      scope: 'neftyblocksp',
      table: 'packs',
      lower_bound: String(cursor),
      upper_bound: String(to),
      limit: CHAIN_ROWS_PER_CALL,
    });
    if (batch.length === 0) break;
    rows.push(...batch);
    const last = BigInt(String(batch[batch.length - 1].pack_id ?? cursor));
    if (last + 1n <= cursor) break;
    cursor = last + 1n;
    if (batch.length < CHAIN_ROWS_PER_CALL) break;
  }
  return rows;
}

function toDesign(r: RawNeftyPackRow): PackDesign {
  const id = String(r.pack_id);
  const dd = parseDisplayData(r.display_data);
  return {
    source: 'neftyblocksp',
    pack_id: id,
    collection_name: r.collection_name,
    pack_template_id: Number(r.pack_template_id),
    unlock_time: Number(r.unlock_time),
    roll_counter: 0, // resolved at unbox time from the recipe
    name: dd.name ?? `Pack #${id}`,
    description: dd.description,
    image: dd.image,
  };
}

export function clearNeftyPacksCache() {
  cache.clear();
}
