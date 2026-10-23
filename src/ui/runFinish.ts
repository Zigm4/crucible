/**
 * The second half of the recipes that take two transactions.
 * ─────────────────────────────────────────────────────────────
 * Opening a pack is a commit and a reveal. The first transaction sends the
 * pack to its contract, the WAX oracle draws the cards a few seconds later,
 * and a second transaction signed by the player mints them:
 *
 *   atomicpacksx   the draw lands in unboxassets (scope = pack asset id),
 *                  then claimunboxed { pack_asset_id, origin_roll_ids }
 *   neftyblocksp   the draw lands in claimassets (pk = pack asset id),
 *                  then claim { claim_id, roll_indexes }
 *
 * Nobody signs the second one for them: every recent claimunboxed and
 * neftyblocksp claim on chain is signed by the player. The runner used to
 * stop after the first, so a pack opened from it was sent away and its cards
 * never minted.
 *
 * Random blends are different today. The oracle's callback
 * (orng.wax::setrand -> blend.nefty::receiverand) mints the result itself,
 * and claimassets is empty for every account. A staged claim can still
 * happen, so it is watched for and offered by hand when it does, but the
 * usual ending is the result arriving on its own.
 *
 * The same reads find what an account left unfinished, whichever page it
 * started on: all three tables have an index by account.
 */
import { isContractAuthorized } from '../atomic/collections';
import type { BuiltAction } from '../chain/action';
import { getTableRows } from '../chain/rpc';
import { loadBlend } from '../nefty/blend';
import { buildNeftyUnboxClaim } from '../nefty/neftyPackExecute';
import { waitForNeftyClaim } from '../nefty/neftyPackWait';
import { buildUnboxClaim } from '../nefty/packExecute';
import { waitForUnboxAssets } from '../nefty/packWait';
import { buildClaimAction } from '../nefty/rngExecute';
import { waitForClaim, waitForClaimConsumed } from '../nefty/rngWait';

export type FinishKind = 'blend' | 'pack' | 'neftypack';

/** Something signed once and still to be finished. */
export interface PendingFinish {
  kind: FinishKind;
  /** The pack's asset id for packs, blend.nefty's claim id for blends. */
  id: string;
  /** The blend or pack recipe it came from. */
  recipe: string;
  collection: string;
  /** Templates the draw gave, once it has; 0 where a pool decides. */
  drawn: number[];
  /** True once the draw is in and one signature mints it. */
  ready: boolean;
  /** atomicpacksx wants every roll id back. */
  rollIds?: (string | number)[];
  /** blend.nefty and neftyblocksp want one index per roll. */
  rollCount?: number;
  /**
   * Why no signature can finish it: the collection does not let the pack
   * contract mint. Seen live: a neftyblocksp claim refused with "Missing
   * authorization for this collection", stuck for everyone until the
   * collection adds the contract back.
   */
  blocked?: string;
}

/** Where the open recipe is after its first transaction. */
export interface RunFinish {
  kind: FinishKind;
  phase: 'waiting' | 'ready' | 'claiming' | 'done' | 'failed';
  message: string;
  pending?: PendingFinish;
  txId?: string;
}

interface BlendClaimRow {
  claim_id: string | number;
  recipient: string;
  recipe_id: string | number;
  collection_name: string;
  claims?: { claim: [string, { template_id?: number }]; is_claimed?: number | boolean }[];
}

const templatesOf = (claims: BlendClaimRow['claims'] = []) =>
  claims.map((c) => Number(c?.claim?.[1]?.template_id ?? 0));

/** One staged blend result, with the roll count `claim` needs. */
async function blendPending(row: BlendClaimRow): Promise<PendingFinish> {
  let rollCount = 1;
  try {
    rollCount = Math.max(1, (await loadBlend({ blend_id: row.recipe_id })).rolls?.length ?? 1);
  } catch { /* one roll is what nearly every blend has */ }
  return {
    kind: 'blend', id: String(row.claim_id), recipe: String(row.recipe_id),
    collection: String(row.collection_name), drawn: templatesOf(row.claims), ready: true, rollCount,
  };
}

/**
 * Everything this account signed the first half of and never finished.
 * Three indexed reads, plus one per pending atomicpacksx pack for its draw.
 */
export async function readPendingFinishes(actor: string): Promise<PendingFinish[]> {
  const out: PendingFinish[] = [];
  const [blends, packs, nefty] = await Promise.allSettled([
    getTableRows<BlendClaimRow>({ code: 'blend.nefty', scope: actor, table: 'claimassets', limit: 100 }),
    getTableRows<{ pack_asset_id: string | number; pack_id: string | number; unboxer: string }>({
      code: 'atomicpacksx', scope: 'atomicpacksx', table: 'unboxpacks',
      index_position: 'secondary', key_type: 'name', lower_bound: actor, upper_bound: actor, limit: 100,
    }),
    getTableRows<BlendClaimRow>({
      code: 'neftyblocksp', scope: 'neftyblocksp', table: 'claimassets',
      index_position: 'secondary', key_type: 'name', lower_bound: actor, upper_bound: actor, limit: 100,
    }),
  ]);
  if (blends.status === 'fulfilled') {
    for (const r of blends.value) out.push(await blendPending(r));
  }
  if (packs.status === 'fulfilled') {
    for (const p of packs.value.filter((x) => x.unboxer === actor)) {
      const rows = await getTableRows<{ origin_roll_id: number | string; template_id: number }>({
        code: 'atomicpacksx', scope: String(p.pack_asset_id), table: 'unboxassets', limit: 200,
      }).catch(() => []);
      rows.sort((a, b) => Number(a.origin_roll_id) - Number(b.origin_roll_id));
      out.push({
        kind: 'pack', id: String(p.pack_asset_id), recipe: String(p.pack_id), collection: '',
        drawn: rows.map((r) => Number(r.template_id)), ready: rows.length > 0,
        rollIds: rows.map((r) => r.origin_roll_id),
      });
    }
  }
  if (nefty.status === 'fulfilled') {
    for (const r of nefty.value.filter((x) => x.recipient === actor)) {
      const drawn = templatesOf(r.claims);
      out.push({
        kind: 'neftypack', id: String(r.claim_id), recipe: String(r.recipe_id),
        collection: String(r.collection_name), drawn, ready: drawn.length > 0, rollCount: drawn.length,
      });
    }
  }
  await markBlocked(out);
  return out;
}

/** The contract each kind mints through, which the collection must authorize. */
const MINTER: Record<FinishKind, string> = { blend: 'blend.nefty', pack: 'atomicpacksx', neftypack: 'neftyblocksp' };

/** Marks what no signature can finish, and fills in an atomicpacksx pack's collection. */
async function markBlocked(list: PendingFinish[]): Promise<void> {
  for (const p of list) {
    if (p.kind === 'pack' && !p.collection) {
      const [row] = await getTableRows<{ pack_id: string | number; collection_name: string }>({
        code: 'atomicpacksx', scope: 'atomicpacksx', table: 'packs',
        lower_bound: p.recipe, upper_bound: p.recipe, limit: 1,
      }).catch(() => []);
      if (row) p.collection = String(row.collection_name);
    }
    if (!p.collection) continue;
    // Unreadable is not "no": only a clear refusal marks it.
    if (await isContractAuthorized(p.collection, MINTER[p.kind]) === false) {
      p.blocked = `${p.collection} does not let ${MINTER[p.kind]} mint, so it cannot be finished until the collection allows it again`;
    }
  }
}

/** The transaction that mints a pending result. */
export function buildFinishActions(p: PendingFinish, actor: string): BuiltAction[] {
  if (p.kind === 'pack') {
    return buildUnboxClaim({ claimer: actor, pack_asset_id: p.id, origin_roll_ids: p.rollIds ?? [] });
  }
  if (p.kind === 'neftypack') {
    return buildNeftyUnboxClaim({ claimer: actor, claim_id: p.id, roll_count: p.rollCount ?? p.drawn.length });
  }
  return [buildClaimAction({ claimer: actor, claim_id: p.id, roll_count: p.rollCount ?? 1 })];
}

/** Waits for the oracle to draw a pack just sent, and says what to sign next. */
export async function waitForPackDraw(
  kind: 'pack' | 'neftypack', packAssetId: string, signal?: AbortSignal,
): Promise<PendingFinish> {
  const rows = kind === 'pack'
    ? await waitForUnboxAssets({ pack_asset_id: packAssetId, signal })
    : await waitForNeftyClaim({ pack_asset_id: packAssetId, signal });
  return {
    kind, id: packAssetId, recipe: '', collection: '',
    drawn: rows.map((r) => Number(r.template_id)), ready: true,
    rollIds: kind === 'pack' ? rows.map((r) => r.origin_roll_id) : undefined,
    rollCount: kind === 'neftypack' ? rows.length : undefined,
  };
}

/**
 * Watches a random blend just signed. Resolves with nothing when the result
 * was minted by the oracle's callback, the usual case, or with the staged
 * claim when it is waiting to be claimed by hand.
 */
export async function watchBlendResult(
  actor: string, blendId: string, known: Set<string>, signal?: AbortSignal,
): Promise<PendingFinish | undefined> {
  let row;
  try {
    row = await waitForClaim({ claimer: actor, blend_id: blendId, knownClaimIds: known, timeoutMs: 30_000, signal });
  } catch (e) {
    if (/aborted/i.test((e as Error).message)) throw e;
    return undefined; // never staged: the callback minted it
  }
  if (await waitForClaimConsumed(actor, row.claim_id, { timeoutMs: 20_000, signal })) return undefined;
  return blendPending(row as BlendClaimRow);
}
