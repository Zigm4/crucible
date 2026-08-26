/**
 * `stake.nefty`, the staking NeftyBlocks left running.
 *
 * neftyblocks.com returns a 404. The contract did not. It pays out on
 * demand today, and it still holds 27.7M NEFTY and 129,034 WAX for people
 * who have no front end to reach it with. This is that front end.
 *
 * Three pools, and they are not equal. Two have a reward pool configured
 * and a long history of claims. The third, WAXNEFT, was RETIRED: on
 * 2022-10-04 its operator called disable, enabled NEFWAX in its place, and
 * then delrewards, the only time that action has ever been used here. The
 * staking rows were never cleared, so 1,825 accounts still carry balances
 * for a pool that no longer has anything to pay them with. That is a
 * different story from "never configured", and the page tells the real
 * one.
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
  /**
   * Seconds this pool makes an unstake wait. NOT the same across pools:
   * NEFTY is 259200 and NEFWAX is 0, so a NEFWAX unstake returns the
   * tokens in the same transaction and never creates a refund row. Telling
   * its 4,031 stakers to expect a 3 day wait would have them either not
   * unstake at all, or unstake and go looking for a row that will never
   * exist.
   */
  refundDelay: number;
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
  census: Record<string, { accounts: number; staked: number; rewards: number; partial: boolean }>;
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
      token_contract: string; refund_delay: number | string;
    }>({ code: 'stake.nefty', scope: 'stake.nefty', table: 'stakerewards', limit: 20 });
    return rows.map((r) => ({
      stakedSymbol: String(r.total_staked).split(' ')[1] ?? '',
      tokenContract: String(r.token_contract ?? ''),
      refundDelay: Number(r.refund_delay ?? 0),
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
): Promise<{ accounts: number; staked: number; rewards: number; partial: boolean }> {
  let accounts = 0, staked = 0, rewards = 0;
  // The empty string, not '0'. This table is keyed by account name, and
  // '0' is not a character a WAX name can contain, so the node answers a
  // name-typed query for it with nothing at all. That silently counted the
  // pool as empty.
  let bound = '';
  let partial = true;
  for (let page = 0; page < 12; page++) {
    const rows = await getTableRows<{ account: string; staked: string; rewards: string }>({
      code: 'stake.nefty', scope, table: 'stakers', lower_bound: bound, key_type: 'name', limit: 1000,
    });
    // A page is walked by asking again from the last account seen. The row
    // is returned twice, so the first of each page after the first is
    // dropped: counting it again would inflate a number the page prints as
    // a fact about somebody else's money.
    const fresh = page === 0 ? rows : rows.slice(1);
    for (const r of fresh) {
      accounts++;
      staked += parseFloat(String(r.staked)) || 0;
      rewards += parseFloat(String(r.rewards)) || 0;
    }
    if (rows.length < 1000) { partial = false; break; }
    const last = rows[rows.length - 1]?.account;
    if (!last || last === bound) break;   // no progress, stop rather than spin
    bound = String(last);
  }
  return { accounts, staked, rewards, partial };
}

/** A pool the contract has no reward row for, and nobody has ever claimed. */
export function isUnprovenPool(p: StakePosition, pools: RewardPool[]): boolean {
  return !pools.some((x) => x.stakedSymbol === p.stakedSymbol);
}

export async function loadStaking(state: StakingState, actor: string): Promise<void> {
  state.loading = true;
  state.actor = actor;
  // Cleared, not left standing. Without this the previous account's pools
  // stay on screen with live buttons under the new account's name for the
  // whole round trip, which can be several seconds across a dead endpoint.
  state.loaded = false;
  state.positions = [];
  state.refunds = [];
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

/** What THIS pool makes an unstake wait, or nothing when it is not known. */
export function refundDelayFor(p: StakePosition, pools: RewardPool[]): number | undefined {
  const found = pools.find((x) => x.stakedSymbol === p.stakedSymbol);
  return found ? found.refundDelay : undefined;
}

export function buildClaimFor(actor: string, p: StakePosition) {
  return [buildClaimRewards(actor, p.stakedSymbolCode)];
}

/**
 * The contract that issues a staked token, or nothing.
 *
 * Read from `stakerewards`, which is also why WAXNEFT comes back empty:
 * its row was deleted in 2022. That is the honest reason to withhold an
 * unstake, and it is not the same as the token having no issuer. It does
 * have one, `alcorammswap`, discovered only after this said otherwise.
 * Its supply is 0.00000000 and stake.nefty holds none, so the refund could
 * never be filled anyway.
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
