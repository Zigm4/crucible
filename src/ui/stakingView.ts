/**
 * `stake.nefty`, the staking NeftyBlocks left running.
 *
 * neftyblocks.com returns a 404. The contract did not. It pays out on
 * demand today, and it still holds 27.7M NEFTY and 129,034 WAX for people
 * who have no front end to reach it with. This is that front end.
 *
 * Three pools, and they are not equal. Two have a reward pool configured
 * and a long history of claims. The third has balances, has 1,244 accounts
 * with rewards on its books, and has never had a single claim or unstake
 * signed against it in the chain's entire history. That difference is not
 * something to smooth over, so this file goes out of its way to show it.
 */
import {
  readStakePositions, readStakeRefunds, readRefundDelay,
  buildClaimRewards, buildUnstake, buildClaimRefund,
  type StakePosition, type StakeRefund,
} from '../nefty/staking';
import { getTableRows } from '../chain/rpc';

/** Pools with a row in `stakerewards`, read rather than assumed. */
export interface RewardPool {
  stakedSymbol: string;
  /** The contract that issues the staked token, needed to build an unstake. */
  tokenContract: string;
  totalStaked: string;
  rewardsBalance: string;
  enabled: boolean;
}

export interface StakingState {
  loaded: boolean;
  loading: boolean;
  actor: string;
  positions: StakePosition[];
  refunds: StakeRefund[];
  pools: RewardPool[];
  refundDelay?: number;
  /** The unproven pool, counted so the page can show its size honestly. */
  census: Record<string, { accounts: number; staked: number; rewards: number }>;
  censusState: 'idle' | 'loading' | 'done';
  /**
   * Whether the background panel is open. A render replaces the subtree,
   * so a native <details> loses its own attribute the moment anything
   * else repaints, and the reader's click is undone under them.
   */
  backgroundOpen: boolean;
  pending: boolean;
  lastTrxId: string;
  error: string;
}

export function emptyStakingState(): StakingState {
  return {
    loaded: false, loading: false, actor: '', positions: [], refunds: [],
    pools: [], census: {}, censusState: 'idle', backgroundOpen: false,
    pending: false, lastTrxId: '', error: '',
  };
}

/** Which pools the contract actually pays, straight from `stakerewards`. */
export async function readRewardPools(): Promise<RewardPool[]> {
  try {
    const rows = await getTableRows<{
      total_staked: string; rewards_balance: string; enabled: number | boolean;
      token_contract: string;
    }>({ code: 'stake.nefty', scope: 'stake.nefty', table: 'stakerewards', limit: 20 });
    return rows.map((r) => ({
      stakedSymbol: String(r.total_staked).split(' ')[1] ?? '',
      tokenContract: String(r.token_contract ?? ''),
      totalStaked: String(r.total_staked),
      rewardsBalance: String(r.rewards_balance),
      enabled: Boolean(r.enabled),
    }));
  } catch {
    return [];
  }
}

/**
 * How big a pool is, counted row by row.
 *
 * Only worth doing for a pool the contract does not describe: for the two
 * configured ones `stakerewards` already says. For the third, the only way
 * to know what is sitting there is to add it up.
 */
export async function censusPool(
  scope: string,
): Promise<{ accounts: number; staked: number; rewards: number }> {
  let accounts = 0, staked = 0, rewards = 0, next = '0';
  for (let page = 0; page < 12; page++) {
    const rows = await getTableRows<{ staked: string; rewards: string }>({
      code: 'stake.nefty', scope, table: 'stakers', lower_bound: next, limit: 1000,
    });
    for (const r of rows) {
      accounts++;
      staked += parseFloat(String(r.staked)) || 0;
      rewards += parseFloat(String(r.rewards)) || 0;
    }
    if (rows.length < 1000) break;
    // getTableRows does not surface next_key, so paging stops at the page
    // boundary rather than pretending to a total it cannot reach.
    break;
  }
  return { accounts, staked, rewards };
}

/** A pool the contract has no reward row for, and nobody has ever claimed. */
export function isUnprovenPool(p: StakePosition, pools: RewardPool[]): boolean {
  return !pools.some((x) => x.stakedSymbol === p.stakedSymbol);
}

export async function loadStaking(state: StakingState, actor: string): Promise<void> {
  state.loading = true;
  state.actor = actor;
  state.error = '';
  const [positions, refunds, pools, delay] = await Promise.all([
    readStakePositions(actor),
    readStakeRefunds(actor),
    readRewardPools(),
    readRefundDelay(),
  ]);
  if (state.actor !== actor) return;   // a wallet switch landed meanwhile
  state.positions = positions;
  state.refunds = refunds;
  state.pools = pools;
  state.refundDelay = delay;
  state.loaded = true;
  state.loading = false;
}

export function buildClaimFor(actor: string, p: StakePosition) {
  return [buildClaimRewards(actor, p.stakedSymbolCode)];
}

/**
 * The contract that issues a staked token, or nothing.
 *
 * `unstake` needs it and there is no honest guess: WAXNEFT is issued by
 * nobody the chain will name, so a page that invented a contract for it
 * would be asking a wallet to sign a lie.
 */
export function tokenContractFor(p: StakePosition, pools: RewardPool[]): string {
  return pools.find((x) => x.stakedSymbol === p.stakedSymbol)?.tokenContract ?? '';
}

export function buildUnstakeFor(actor: string, p: StakePosition, contract: string, amount?: number) {
  const decimals = (p.stakedSymbolCode.split(',')[0] ?? '0');
  const qty = (amount ?? p.staked).toFixed(Number(decimals));
  return [buildUnstake(actor, `${qty} ${p.stakedSymbol}`, contract)];
}

export function buildRefundFor(actor: string, r: StakeRefund) {
  return [buildClaimRefund(actor, r.id)];
}
