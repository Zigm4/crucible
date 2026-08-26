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
