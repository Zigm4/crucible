/**
 * Pack discovery + design lookup for atomicpacksx.
 *
 * A "pack" on WAX is a regular AtomicAssets NFT whose template_id is
 * registered as a "pack template" in the atomicpacksx contract's `packs`
 * table. Opening a pack is a two-transaction commit-reveal dance built
 * around the ORNG oracle:
 *
 *   tx1: atomicassets::transfer(pack -> atomicpacksx, memo "unbox")
 *   ... wait ~10-30s for ORNG to call the contract back ...
 *   tx2: atomicpacksx::claimunboxed(pack_asset_id, origin_roll_ids)
 *
 * This module is the read side: it lists pack designs for a collection,
 * lists which packs the user currently owns, and reads the "rolls" that
 * define what each pack design mints (so we can show "expected mints").
 */

import { atomicFetch, getTableRows } from '../chain/rpc';

const CHAIN_CHUNK_SIZE = 5_000n;
const CHAIN_ROWS_PER_CALL = 1000;
const CHAIN_MAX_CHUNKS = 16;

export type PackSource = 'atomicpacksx' | 'neftyblocksp';

export interface PackDesign {
  /** Which contract this pack lives on (drives the open/claim flow). */
  source: PackSource;
  pack_id: string;
  collection_name: string;
  /** AtomicAssets template_id whose NFTs ARE packs of this design. */
  pack_template_id: number;
  /** Unix-seconds. Packs can't be unboxed before this. 0 = no gate. */
  unlock_time: number;
  /** Number of rolls this pack produces per unbox (= NFTs minted). */
  roll_counter: number;
  name: string;
  description?: string;
  image?: string;
}

export interface OwnedPack {
  /** AtomicAssets asset_id of this specific pack NFT in the user's wallet. */
  asset_id: string;
  /** Template-level info: which pack design this NFT is an instance of. */
  pack: PackDesign;
  /** Mint number on the pack NFT itself, just for display. */
  mint?: string;
}

export interface PackRollOutcome {
  odds: number;
  template_id: number;
}
export interface PackRoll {
  roll_id: number;
  outcomes: PackRollOutcome[];
  total_odds: number;
}

interface RawPackRow {
  pack_id: number | string;
  collection_name: string;
  unlock_time: number;
  pack_template_id: number;
  roll_counter: number | string;
  display_data?: string;
}

interface RawRollRow {
  roll_id: number | string;
  outcomes: PackRollOutcome[];
  total_odds: number | string;
}

const designsCache = new Map<string, { at: number; data: PackDesign[] }>();
const TTL_MS = 5 * 60_000;

/**
 * Lists pack DESIGNS from the global atomicpacksx::packs table.
 *
 * When `collection` is provided, the result is filtered to that
 * collection. When omitted, EVERY design on the chain is returned --
 * useful for the cross-collection inventory flow ("what packs do I own,
 * across every collection?"). The same chunked scan walks the table
 * either way, so the marginal cost of "no collection" is one client-
 * side filter avoided.
 *
 * Cached for 5 minutes, keyed by `collection ?? '*'` so the broad and
 * narrow lookups don't collide.
 */
export async function listPackDesigns(collection?: string): Promise<PackDesign[]> {
  const cacheKey = collection ?? '*';
  const hit = designsCache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

  const tail = await getTableRows<RawPackRow>({
    code: 'atomicpacksx',
    scope: 'atomicpacksx',
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

  const matched: RawPackRow[] = [];
  await Promise.all(
    ranges.map(async (r) => {
      const rows = await scanPackRange(r.from, r.to);
      for (const row of rows) {
        if (!collection || row.collection_name === collection) matched.push(row);
      }
    }),
  );

  const designs = matched.map(toDesign);
  designsCache.set(cacheKey, { at: Date.now(), data: designs });
  return designs;
}

async function scanPackRange(from: bigint, to: bigint): Promise<RawPackRow[]> {
  const rows: RawPackRow[] = [];
  let cursor = from;
  while (cursor < to) {
    const batch = await getTableRows<RawPackRow>({
      code: 'atomicpacksx',
      scope: 'atomicpacksx',
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

function parseDisplayData(d: string | undefined): { name?: string; description?: string; image?: string } {
  if (!d) return {};
  try {
    const o = JSON.parse(d);
    if (typeof o !== 'object' || !o) return {};
    return o as { name?: string; description?: string; image?: string };
  } catch {
    return {};
  }
}

function toDesign(r: RawPackRow): PackDesign {
  const id = String(r.pack_id);
  const dd = parseDisplayData(r.display_data);
  return {
    source: 'atomicpacksx',
    pack_id: id,
    collection_name: r.collection_name,
    pack_template_id: Number(r.pack_template_id),
    unlock_time: Number(r.unlock_time),
    roll_counter: Number(r.roll_counter),
    name: dd.name ?? `Pack #${id}`,
    description: dd.description,
    image: dd.image,
  };
}

interface RawAtomicAsset {
  asset_id: string;
  template?: { template_id?: string } | null;
  template_mint?: string;
  name?: string;
}

/**
 * Returns the packs the user actually OWNS in a given collection. Cross-
 * references their atomicassets inventory with the collection's known
 * pack designs.
 *
 * `ownedAssets` should be the same list we use for blend matching --
 * fetched once via atomic/assets.ts::listAssetsForOwner.
 */
export function pickOwnedPacks(
  ownedAssets: RawAtomicAsset[],
  designs: PackDesign[],
): OwnedPack[] {
  const designByTemplate = new Map<string, PackDesign>();
  for (const d of designs) {
    designByTemplate.set(String(d.pack_template_id), d);
  }
  const out: OwnedPack[] = [];
  for (const a of ownedAssets) {
    const tid = a.template?.template_id;
    if (!tid) continue;
    const design = designByTemplate.get(String(tid));
    if (!design) continue;
    out.push({
      asset_id: a.asset_id,
      pack: design,
      mint: a.template_mint,
    });
  }
  // Stable order: newest pack design first, then by asset_id desc within design
  out.sort((x, y) => {
    const a = Number(y.pack.pack_id) - Number(x.pack.pack_id);
    if (a !== 0) return a;
    return Number(y.asset_id) - Number(x.asset_id);
  });
  return out;
}

/**
 * Reads every roll definition for a pack design. Used to display the
 * "expected mint" odds in the pack info card. The number of rolls equals
 * `pack.roll_counter` and equals the length of `origin_roll_ids` we
 * must pass to claimunboxed.
 */
export async function loadPackRolls(pack_id: string | number): Promise<PackRoll[]> {
  const rows = await getTableRows<RawRollRow>({
    code: 'atomicpacksx',
    scope: String(pack_id),
    table: 'packrolls',
    limit: 200,
  });
  return rows.map((r) => ({
    roll_id: Number(r.roll_id),
    outcomes: r.outcomes ?? [],
    total_odds: Number(r.total_odds ?? 0),
  }));
}

/**
 * Best-effort name lookup for a template via the AtomicAssets indexer.
 * Returns undefined when the indexer is unreachable -- the caller can
 * fall back to displaying just the template_id.
 */
export async function fetchTemplateName(
  collection_name: string,
  template_id: string | number,
): Promise<string | undefined> {
  try {
    const t = await atomicFetch<{ immutable_data?: { name?: string } }>(
      `/atomicassets/v1/templates/${encodeURIComponent(collection_name)}/${encodeURIComponent(String(template_id))}`,
    );
    return t?.immutable_data?.name;
  } catch {
    return undefined;
  }
}

export function clearPacksCache() {
  designsCache.clear();
}
