/**
 * `stake.nefty`, the staking NeftyBlocks left running.
 *
 * neftyblocks.com returns a 404. The contract did not. It still pays out
 * on demand, and this is the front end for that.
 *
 * Two things it would be easy, and wrong, to say. The NEFTY it holds does
 * cover every staked principal, so unstaking is safe. The WAX it holds
 * does NOT cover what it owes: the pot is roughly three quarters of the
 * promises against it, the gap opened in 2023 when the contract spent
 * stakers' WAX buying NEFTY for the operator, and nothing has topped it up
 * since. It pays first come, first served. The page has to say so.
 *
 * The second thing: both pools read `enabled`, and neither has credited
 * anything since the last `fill`. Enabled is not paying.
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
  readCollectionStakes, readCollectionRefunds,
  buildClaimRewards, buildUnstake, buildClaimRefund,
  buildUnstakeCollection, buildClaimCollectionRefund,
  type StakePosition, type StakeRefund,
  type CollectionStake, type CollectionRefund,
} from '../nefty/staking';
import { levelGrants, UPGRADE_FEATURE } from '../nefty/upgradeGate';
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
  /**
   * What the pool's books SAY is in the reward pot. Not what the contract
   * holds: see heldBalance. On 2026-08-26 the WAX pool declared
   * 168737.51253157 WAX against 129034.92982131 WAX actually on hand.
   */
  rewardsBalance: string;
  /**
   * Total staked as the contract counts it, which INCLUDES collection
   * staking. The 24298265.08831688 NEFTY on this row is user rows
   * (17425530.89643307) plus collstaking (6872732.19188381). Printing it
   * beside a per-user table overstates the user pool by about 6.87M.
   */
  totalStakedIncludesCollections: true;
  /** The contract that issues the REWARD token, needed to read the real balance. */
  rewardsContract: string;
  /**
   * What `stake.nefty` actually holds of the reward token, read live from
   * that token's `accounts` table. Empty when it could not be read.
   */
  heldBalance: string;
  /**
   * True when the reward token is also staked in this contract. Then
   * heldBalance backs principal FIRST and is not a solvency measure for
   * the reward pot. NEFTY is such a token; WAX is not.
   */
  rewardTokenIsStaked: boolean;
  /**
   * `next_reward_time`. The contract sets this forward on every `fill`, so
   * it is also a live timestamp of the last reward cycle it ran. When it
   * sits in the past, nothing is accruing.
   */
  nextRewardTime: number;
  enabled: boolean;
}

/**
 * A pool added up row by row.
 *
 * `accounts` is every row, which is not the same as every holder: 600 of
 * the retired pool's 1,825 rows have a zero stake. Both numbers are here
 * so the page can say which it means.
 */
export interface PoolCensus {
  accounts: number;
  withStake: number;
  withRewards: number;
  /** Exact decimal strings, summed as integers. Never rounded. */
  staked: string;
  rewards: string;
  stakedSymbol: string;
  rewardsSymbol: string;
  partial: boolean;
}

export interface StakingState {
  loaded: boolean;
  loading: boolean;
  actor: string;
  positions: StakePosition[];
  refunds: StakeRefund[];
  /**
   * Collection staking, which is a different table, a different action and
   * a different set of consequences from a wallet's own stake. Unstaking a
   * collection drops its tier, and at level.3 that is the one thing on
   * these contracts a stake still buys: `up.nefty` stops accepting
   * single-ingredient upgrade recipes from it.
   */
  collections: CollectionStake[];
  collectionRefunds: CollectionRefund[];
  /** Tiers that grant up.nefty's feature, read rather than hardcoded. */
  tierGrantsUpgrade: Record<string, boolean>;
  pools: RewardPool[];
  refundDelay?: number;
  /** The unproven pool, counted so the page can show its size honestly. */
  census: Record<string, PoolCensus>;
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
    collections: [], collectionRefunds: [], tierGrantsUpgrade: {},
    pools: [], census: {}, censusState: 'idle', backgroundOpen: false,
    pending: false, lastTrxId: '', error: '',
  };
}

/**
 * What `stake.nefty` really holds of one token.
 *
 * Read from the token contract's own `accounts` table rather than trusted
 * from `stakerewards`. The two disagree: the WAX pool's books claim
 * 168737.51253157 WAX and the contract holds 129034.92982131. A page that
 * prints only the books advertises a pot 39702 WAX larger than exists.
 */
export async function readHeldBalance(contract: string, symbol: string): Promise<string> {
  if (!contract || !symbol) return '';
  try {
    const rows = await getTableRows<{ balance: string }>({
      code: contract, scope: 'stake.nefty', table: 'accounts', limit: 50,
    });
    const hit = rows.find((r) => String(r.balance).split(' ')[1] === symbol);
    return hit ? String(hit.balance) : '';
  } catch {
    return '';
  }
}

/** Which pools the contract actually pays, straight from `stakerewards`. */
export async function readRewardPools(): Promise<RewardPool[]> {
  try {
    const rows = await getTableRows<{
      total_staked: string; rewards_balance: string; enabled: number | boolean;
      token_contract: string; rewards_contract: string;
      refund_delay: number | string; next_reward_time: number | string;
    }>({ code: 'stake.nefty', scope: 'stake.nefty', table: 'stakerewards', limit: 20 });

    const staked = new Set(rows.map((r) => String(r.total_staked).split(' ')[1] ?? ''));

    return await Promise.all(rows.map(async (r) => {
      const rewardsContract = String(r.rewards_contract ?? '');
      const rewardSymbol = String(r.rewards_balance).split(' ')[1] ?? '';
      return {
        stakedSymbol: String(r.total_staked).split(' ')[1] ?? '',
        tokenContract: String(r.token_contract ?? ''),
        rewardsContract,
        refundDelay: Number(r.refund_delay ?? 0),
        totalStaked: String(r.total_staked),
        totalStakedIncludesCollections: true as const,
        rewardsBalance: String(r.rewards_balance),
        heldBalance: await readHeldBalance(rewardsContract, rewardSymbol),
        // NEFTY is staked here as well as paid out, so its balance backs
        // principal before it backs any reward. WAX is not staked, so for
        // the WAX pot the held balance IS the whole story.
        rewardTokenIsStaked: staked.has(rewardSymbol),
        nextRewardTime: Number(r.next_reward_time ?? 0),
        enabled: Boolean(r.enabled),
      };
    }));
  } catch {
    return [];
  }
}

/** An asset string split into a signed integer of minor units and its scale. */
function minorUnits(asset: string): { units: bigint; decimals: number; symbol: string } {
  const [amount = '0', symbol = ''] = String(asset).split(' ');
  const dot = amount.indexOf('.');
  const decimals = dot < 0 ? 0 : amount.length - dot - 1;
  return { units: BigInt(amount.replace('.', '')), decimals, symbol };
}

/** Minor units back to the exact decimal string the chain would print. */
function formatUnits(units: bigint, decimals: number): string {
  const neg = units < 0n;
  const digits = (neg ? -units : units).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const frac = decimals ? `.${digits.slice(digits.length - decimals)}` : '';
  return `${neg ? '-' : ''}${whole}${frac}`;
}

/**
 * How much of `owed` the contract can actually pay, or nothing when the
 * question does not apply.
 *
 * Returns nothing when the reward token is also staked here, because then
 * the held balance backs principal first and comparing it to the reward
 * pot would call an insolvent pool solvent.
 */
export function poolShortfall(p: RewardPool): { short: string; coverage: number; symbol: string } | undefined {
  if (!p.heldBalance || !p.rewardsBalance || p.rewardTokenIsStaked) return undefined;
  const owed = minorUnits(p.rewardsBalance);
  const held = minorUnits(p.heldBalance);
  if (owed.symbol !== held.symbol || owed.units <= 0n) return undefined;
  if (held.units >= owed.units) return undefined;
  return {
    short: formatUnits(owed.units - held.units, owed.decimals),
    coverage: Number((held.units * 10000n) / owed.units) / 100,
    symbol: owed.symbol,
  };
}

/**
 * How big a pool is, counted row by row.
 *
 * Only worth doing for a pool the contract does not describe: for the two
 * configured ones `stakerewards` already says. For the third, the only way
 * to know what is sitting there is to add it up.
 */
export async function censusPool(scope: string): Promise<PoolCensus> {
  let accounts = 0, withStake = 0, withRewards = 0;
  // Summed as integer minor units, never as floats. Adding 1,825 values of
  // 8 decimals with `+=` on a double loses the low digits, and this total
  // is printed as a fact about other people's money.
  let stakedUnits = 0n, rewardsUnits = 0n;
  let stakedDec = 0, rewardsDec = 0, stakedSym = '', rewardsSym = '';
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
      const st = minorUnits(String(r.staked));
      const rw = minorUnits(String(r.rewards));
      stakedUnits += st.units; rewardsUnits += rw.units;
      if (st.units > 0n) withStake++;
      if (rw.units > 0n) withRewards++;
      stakedDec = st.decimals; stakedSym = st.symbol;
      rewardsDec = rw.decimals; rewardsSym = rw.symbol;
    }
    if (rows.length < 1000) { partial = false; break; }
    const last = rows[rows.length - 1]?.account;
    if (!last || last === bound) break;   // no progress, stop rather than spin
    bound = String(last);
  }
  return {
    accounts, withStake, withRewards, partial,
    staked: formatUnits(stakedUnits, stakedDec),
    rewards: formatUnits(rewardsUnits, rewardsDec),
    stakedSymbol: stakedSym, rewardsSymbol: rewardsSym,
  };
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
  state.collections = [];
  state.collectionRefunds = [];
  state.error = '';
  const [positions, refunds, pools, delay, collections, collectionRefunds] = await Promise.all([
    readStakePositions(actor),
    readStakeRefunds(actor),
    readRewardPools(),
    readRefundDelay(),
    readCollectionStakes(actor),
    readCollectionRefunds(actor),
  ]);
  if (state.actor !== actor) return;   // a wallet switch landed meanwhile
  state.positions = positions;
  state.refunds = refunds;
  state.pools = pools;
  state.refundDelay = delay;
  state.collections = collections;
  state.collectionRefunds = collectionRefunds;
  // Only the tiers this wallet actually holds, so a wallet with no
  // collections pays for no extra reads.
  const tiers: Record<string, boolean> = {};
  for (const level of new Set(collections.map((c) => c.level))) {
    if (!level || level === 'level.zero') { tiers[level] = false; continue; }
    tiers[level] = await levelGrants(level, UPGRADE_FEATURE);
  }
  if (state.actor !== actor) return;
  state.tierGrantsUpgrade = tiers;
  state.loaded = true;
  state.loading = false;
}

/**
 * Whether unstaking this collection would cost it the one capability a
 * NEFTY stake still buys anywhere on these contracts.
 *
 * Read from the tier table rather than compared against the string
 * 'level.3', because `upsertstklvl` has rewritten those rows 12 times and
 * could again. A hardcoded tier name would go stale in silence.
 */
export function collectionLosesUpgradeRight(
  c: CollectionStake, tiers: Record<string, boolean>,
): boolean {
  return Boolean(tiers[c.level]);
}

export function buildCollectionUnstakeFor(c: CollectionStake, amount?: number) {
  const decimals = c.stakedSymbolCode.split(',')[0] ?? '0';
  const qty = (amount ?? c.staked).toFixed(Number(decimals));
  return [buildUnstakeCollection(c.author, c.collection, `${qty} ${c.stakedSymbol}`, c.tokenContract)];
}

export function buildCollectionRefundFor(actor: string, r: CollectionRefund) {
  return [buildClaimCollectionRefund(actor, r.id)];
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
