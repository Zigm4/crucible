/**
 * NeftyBlocks staking: `stake.nefty`, still running with no website.
 *
 * Nefty's front end is gone. The contract never noticed: it pays out on
 * demand today, and at the time of writing it holds 27.7M NEFTY and
 * 129,034 WAX belonging to people who cannot reach it. Two of the reward
 * pools are still enabled and still accruing.
 *
 * Three actions matter to somebody trying to get their tokens out:
 *
 *   claim(account, token_symbol)          the rewards, paid immediately
 *   unstake(account, to_refund)           starts a 3 day countdown
 *   claimtokuser(refund_id)               collects it once the clock runs out
 *
 * Unstaking is deliberately two steps. The first moves the stake into a
 * refund row with an `unlock_time`, and nothing returns it on its own: 45
 * collection refunds on this chain have been unlocked and unclaimed since
 * 2022, one of them for nearly four years. Whoever unstakes has to come
 * back, which is exactly the kind of thing a page has to say out loud.
 */
import { getTableRows, getTableByScope } from '../chain/rpc';

import type { BuiltAction } from '../chain/action';

const STAKE = 'stake.nefty';

/**
 * One pool's position for one account.
 *
 * A pool is identified by what you put in, and pays out in something
 * else: NEFTY earns WAX, the two liquidity tokens earn NEFTY.
 */
export interface StakePosition {
  /** The table scope this row lives in, needed to read it again. */
  scope: string;
  /** e.g. "NEFTY". The `claim` action wants the full symbol, see below. */
  stakedSymbol: string;
  /** Precision and symbol as the contract spells them, e.g. "8,NEFTY". */
  stakedSymbolCode: string;
  staked: number;
  /** Already unstaked and waiting out its delay, in the same token. */
  refunding: number;
  rewards: number;
  rewardsSymbol: string;
  /**
   * Exactly what the table says, digits and all.
   *
   * The numbers above are for arithmetic. These are for the screen: a page
   * that offers to move 6498.78574115 NEFTY must not print "6,498.786",
   * which rounds UP and reads as more than the account holds. Anyone
   * checking against an explorer would see two different figures.
   */
  stakedRaw: string;
  rewardsRaw: string;
}

/** A finished unstake, waiting for somebody to come and collect it. */
export interface StakeRefund {
  id: number;
  quantity: string;
  amount: number;
  symbol: string;
  contract: string;
  unlockTime: number;
  /** The delay has run out and this can be collected now. */
  ready: boolean;
}

function parseAsset(raw: unknown): { amount: number; symbol: string } {
  const [q, sym] = String(raw ?? '').split(' ');
  return { amount: parseFloat(q) || 0, symbol: sym ?? '' };
}

/** Precision is part of the symbol the contract expects, and 0 is not a default. */
function symbolCode(raw: unknown): string {
  const [q, sym] = String(raw ?? '').split(' ');
  const dot = q?.indexOf('.') ?? -1;
  const precision = dot < 0 ? 0 : q.length - dot - 1;
  return `${precision},${sym}`;
}

/**
 * Which pools exist, read rather than hardcoded.
 *
 * The scopes are packed extended symbols rendered as names, so they look
 * like nonsense: `.....qeoct2oi` is the NEFTY pool. Listing them costs one
 * call and means a pool added later is found instead of missed.
 */
export async function readStakeScopes(): Promise<string[]> {
  try {
    const rows = await getTableByScope({ code: STAKE, table: 'stakers', limit: 50 });
    return rows.map((r: { scope: string }) => r.scope);
  } catch {
    return [];
  }
}

/** Every pool this account has a position in, across all of them. */
export async function readStakePositions(actor: string): Promise<StakePosition[]> {
  if (!actor) return [];
  const scopes = await readStakeScopes();
  const found = await Promise.all(scopes.map(async (scope) => {
    try {
      const rows = await getTableRows<{
        account: string; staked: string; refunding: string; rewards: string;
      }>({
        code: STAKE,
        scope,
        table: 'stakers',
        // Without key_type the node reads a numeric-looking account as an
        // integer, the same trap the name auctions hit.
        lower_bound: actor,
        upper_bound: actor,
        key_type: 'name',
        limit: 1,
      });
      const r = rows[0];
      if (!r || String(r.account) !== actor) return undefined;
      const staked = parseAsset(r.staked);
      const refunding = parseAsset(r.refunding);
      const rewards = parseAsset(r.rewards);
      return {
        scope,
        stakedSymbol: staked.symbol,
        stakedSymbolCode: symbolCode(r.staked),
        staked: staked.amount,
        refunding: refunding.amount,
        rewards: rewards.amount,
        rewardsSymbol: rewards.symbol,
        stakedRaw: String(r.staked),
        rewardsRaw: String(r.rewards),
      } satisfies StakePosition;
    } catch {
      return undefined;
    }
  }));
  return found.filter((p): p is StakePosition => !!p);
}

/**
 * Unstakes this account has started and not finished.
 *
 * Keyed by an id the contract assigns, which `claimtokuser` needs. There
 * is no index from an account to its refunds, so the whole table is read
 * and filtered, which is cheap while it holds a few dozen rows.
 */
export async function readStakeRefunds(actor: string): Promise<StakeRefund[]> {
  if (!actor) return [];
  try {
    const rows = await getTableRows<{
      id: number | string;
      user: string;
      refunding: { quantity: string; contract: string };
      unlock_time: number | string;
    }>({ code: STAKE, scope: STAKE, table: 'usrrefund', limit: 1000 });
    const now = Date.now() / 1000;
    return rows
      .filter((r) => String(r.user) === actor)
      .map((r) => {
        const a = parseAsset(r.refunding?.quantity);
        const unlockTime = Number(r.unlock_time) || 0;
        return {
          id: Number(r.id),
          quantity: String(r.refunding?.quantity ?? ''),
          amount: a.amount,
          symbol: a.symbol,
          contract: String(r.refunding?.contract ?? ''),
          unlockTime,
          ready: unlockTime <= now,
        };
      });
  } catch {
    return [];
  }
}

/**
 * A collection this account staked NEFTY against.
 *
 * The contract keeps collection staking in a table of its own, keyed by
 * collection rather than by wallet, with the staker recorded in `author`.
 * That field is a binary extension in the ABI (`name$`), so old rows could
 * in principle lack it. All 1,071 rows carry one today, and a row without
 * an author is dropped rather than shown to somebody who could not sign
 * for it anyway.
 */
export interface CollectionStake {
  collection: string;
  author: string;
  /** `level.zero` through `level.3`. Recomputed by the contract on every
   *  stake and unstake, so it is never stale: 0 of 1,071 rows disagree
   *  with their own balance. */
  level: string;
  staked: number;
  stakedRaw: string;
  stakedSymbol: string;
  stakedSymbolCode: string;
  tokenContract: string;
  refunding: number;
  refundingRaw: string;
}

/** A finished collection unstake, waiting for `claimtokcoll`. */
export interface CollectionRefund {
  id: number;
  collection: string;
  author: string;
  quantity: string;
  amount: number;
  symbol: string;
  contract: string;
  unlockTime: number;
  ready: boolean;
}

/**
 * Every collstaking row, paged to the end.
 *
 * There is no index from an author to their collections, so the table is
 * read whole and filtered. It is 1,071 rows over two pages, and the node
 * caps a page at 1000 however large a limit is asked for, so the paging is
 * real rather than decorative.
 */
async function readCollectionRows(): Promise<{
  collection_name: string; stakinglevel: string; author?: string;
  stakings?: { quantity: string; contract: string }[];
  refundings?: { quantity: string; contract: string }[];
}[]> {
  const out: {
    collection_name: string; stakinglevel: string; author?: string;
    stakings?: { quantity: string; contract: string }[];
    refundings?: { quantity: string; contract: string }[];
  }[] = [];
  // The empty string, not '0': this table is keyed by collection name and
  // '0' is not a character an eosio name can hold, so a name-typed query
  // for it comes back empty and the whole table reads as missing.
  let bound = '';
  for (let page = 0; page < 8; page++) {
    const rows = await getTableRows<typeof out[number]>({
      code: STAKE, scope: STAKE, table: 'collstaking',
      lower_bound: bound, key_type: 'name', limit: 1000,
    });
    // lower_bound is inclusive, so every page after the first repeats the
    // row it resumed from.
    out.push(...(page === 0 ? rows : rows.slice(1)));
    if (rows.length < 1000) break;
    const last = rows[rows.length - 1]?.collection_name;
    if (!last || String(last) === bound) break;
    bound = String(last);
  }
  return out;
}

/** The collections this wallet staked for, whatever is left on them. */
export async function readCollectionStakes(actor: string): Promise<CollectionStake[]> {
  if (!actor) return [];
  try {
    const rows = await readCollectionRows();
    return rows
      .filter((r) => String(r.author ?? '') === actor)
      .map((r) => {
        // stakings is a vector, though every live row holds exactly one
        // entry and every one of them is NEFTY on token.nefty. Taking the
        // first is honest for what exists; summing across different
        // symbols would invent a number.
        const st = (r.stakings ?? [])[0];
        const rf = (r.refundings ?? [])[0];
        const a = parseAsset(st?.quantity);
        return {
          collection: String(r.collection_name),
          author: String(r.author ?? ''),
          level: String(r.stakinglevel ?? ''),
          staked: a.amount,
          stakedRaw: String(st?.quantity ?? ''),
          stakedSymbol: a.symbol,
          stakedSymbolCode: symbolCode(String(st?.quantity ?? '')),
          tokenContract: String(st?.contract ?? ''),
          refunding: parseAsset(rf?.quantity).amount,
          refundingRaw: String(rf?.quantity ?? ''),
        } satisfies CollectionStake;
      })
      .filter((c) => c.staked > 0 || c.refunding > 0);
  } catch {
    return [];
  }
}

/**
 * Collection unstakes that finished and were never collected.
 *
 * `colrefund` is keyed by an id and names only the collection, so the
 * author is resolved through `collstaking`. Every one of the 45 live rows
 * resolves; a row that did not would be dropped rather than offered to a
 * wallet that cannot sign for it.
 *
 * These are the forgotten ones. All 45 are already past their unlock time,
 * the oldest since September 2022, and they hold 685,747.18907484 NEFTY
 * between them.
 */
export async function readCollectionRefunds(actor: string): Promise<CollectionRefund[]> {
  if (!actor) return [];
  try {
    const [rows, colls] = await Promise.all([
      getTableRows<{
        id: number | string; collection_name: string;
        refunding: { quantity: string; contract: string };
        unlock_time: number | string;
      }>({ code: STAKE, scope: STAKE, table: 'colrefund', limit: 1000 }),
      readCollectionRows(),
    ]);
    const authorOf = new Map(colls.map((c) => [String(c.collection_name), String(c.author ?? '')]));
    const now = Date.now() / 1000;
    return rows
      .filter((r) => authorOf.get(String(r.collection_name)) === actor)
      .map((r) => {
        const a = parseAsset(r.refunding?.quantity);
        const unlockTime = Number(r.unlock_time) || 0;
        return {
          id: Number(r.id),
          collection: String(r.collection_name),
          author: actor,
          quantity: String(r.refunding?.quantity ?? ''),
          amount: a.amount,
          symbol: a.symbol,
          contract: String(r.refunding?.contract ?? ''),
          unlockTime,
          ready: unlockTime <= now,
        } satisfies CollectionRefund;
      });
  } catch {
    return [];
  }
}

/** How long the contract makes an unstake wait, read rather than assumed. */
export async function readRefundDelay(): Promise<number | undefined> {
  try {
    const rows = await getTableRows<{ refund_delay?: number | string }>({
      code: STAKE, scope: STAKE, table: 'config', limit: 1,
    });
    const d = Number(rows[0]?.refund_delay);
    return Number.isFinite(d) && d > 0 ? d : undefined;
  } catch {
    return undefined;
  }
}

const auth = (actor: string) => [{ actor, permission: 'active' }];

/** Takes the rewards one pool owes, paid on the spot. */
export function buildClaimRewards(actor: string, stakedSymbolCode: string): BuiltAction {
  return {
    account: STAKE,
    name: 'claim',
    authorization: auth(actor),
    // The symbol identifies the POOL, and it is the staked token that
    // names it, not the reward. Claiming WAX from the NEFTY pool is
    // claim(account, "8,NEFTY").
    data: { account: actor, token_symbol: stakedSymbolCode },
  };
}

/**
 * Starts an unstake. This does NOT return anything yet.
 *
 * The tokens move to a refund row and sit there for the contract's delay.
 * Forgetting the second step is the single most common way people lose
 * track of this money.
 */
export function buildUnstake(
  actor: string, quantity: string, tokenContract: string,
): BuiltAction {
  return {
    account: STAKE,
    name: 'unstake',
    authorization: auth(actor),
    data: { account: actor, to_refund: { quantity, contract: tokenContract } },
  };
}

/** Collects a refund whose delay has run out. */
export function buildClaimRefund(actor: string, refundId: number): BuiltAction {
  return {
    account: STAKE,
    name: 'claimtokuser',
    authorization: auth(actor),
    data: { refund_id: refundId },
  };
}

/**
 * Pulls a collection's stake back out.
 *
 * Signed by the author, and the author is named in the data as well as in
 * the authorization: every one of the 908 real `unstakecoll` calls carries
 * the same account in both, so the two are never allowed to drift here.
 *
 * This is the action that drops the collection's tier, which for a level.3
 * collection means `up.nefty` stops accepting single-ingredient upgrade
 * recipes from it. The caller is expected to have said so first.
 */
export function buildUnstakeCollection(
  author: string, collection: string, quantity: string, tokenContract: string,
): BuiltAction {
  return {
    account: STAKE,
    name: 'unstakecoll',
    authorization: auth(author),
    data: { author, collection, to_refund: { quantity, contract: tokenContract } },
  };
}

/** Collects a finished collection unstake. Keyed only by the refund id. */
export function buildClaimCollectionRefund(actor: string, refundId: number): BuiltAction {
  return {
    account: STAKE,
    name: 'claimtokcoll',
    authorization: auth(actor),
    data: { refund_id: refundId },
  };
}
