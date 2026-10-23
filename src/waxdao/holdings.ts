/**
 * What WaxDAO's contracts still hold for one account, and how to take it back.
 * ─────────────────────────────────────────────────────────────
 * WaxDAO's website is shut down. Its contracts are not: on 2026-10-23
 * waxdaofarmer alone held 416,386 NFTs that people staked in its farms,
 * and the farms, token pools, token farms, DAOs and market still pay out
 * on demand. Nothing here is new to the chain; it is read from the same
 * tables WaxDAO's site read, for one wallet, through each table's index
 * by account:
 *
 *   waxdaofarmer   stakebackup  NFT farms v1        unstakeall, claimrewards / claimall
 *                  tokens       token pools v1      unstaketoken, claimpoolrwd
 *   farms.waxdao   stakers      NFT farms v2        claim
 *   tf.waxdao      stakers      token farms         unstake, getreward   (scope = account)
 *   dao.waxdao     stakedtokens DAO staking         unstaketoken         (scope = account)
 *   waxdaolocker   locks        token locks         withdraw
 *   waxdaobacker   balances     backed tokens       withdraw, after the token's `open`
 *   waxdaomarket   userram, rambalances, premintpools, tokenbalance
 *                               a creator's RAM, NFTs and tokens
 *
 * Every action below was run through compute_transaction on real holders
 * before this was written (scripts/verify-waxdao-holdings.mjs): accepted,
 * except a lock already withdrawn ("completed"), a locked premint pool, and
 * any payout in a token the wallet has never held: the farms, the pools
 * and the backer all refuse with "you need to use the 'open' action", so
 * the transaction opens that balance first. An NFT counts as
 * held only when AtomicAssets says the contract owns it: rows outlive the
 * stake, and 12,717 of the NFTs listed in such rows are back in a wallet.
 */
import type { BuiltAction } from '../chain/action';
import { atomicFetch, getTableRows, withFailover } from '../chain/rpc';
import { simulateActions } from '../chain/simulate';

export type HoldingGroup = 'nft-farm' | 'nft-farm-v2' | 'token-pool' | 'token-farm' | 'dao' | 'lock' | 'backer' | 'market';

export interface WaxdaoHolding {
  key: string;
  group: HoldingGroup;
  contract: string;
  /** One line, e.g. "5 NFTs staked in chonkfarm". */
  title: string;
  /** What else is waiting there, e.g. "13.33 WAX to claim". */
  detail?: string;
  /** The buttons, each its own transaction. None when nothing can be signed, with `note` saying why. */
  actions: { label: string; build: BuiltAction[] }[];
  /** The `open` actions this holding's payout needs, for the transactions that take several at once. */
  opens?: BuiltAction[];
  /** A farm that can never pay: nothing in it can be signed, and it breaks `claimall` for the wallet. */
  broken?: boolean;
  note?: string;
}

const auth = (actor: string) => [{ actor, permission: 'active' }];
const act = (account: string, name: string, actor: string, data: Record<string, unknown>): BuiltAction =>
  ({ account, name, authorization: auth(actor), data });
const amount = (q: unknown) => parseFloat(String(q ?? '').split(' ')[0]) || 0;
const day = (t: number) => new Date(t * 1000).toLocaleDateString();
/** How many farms one unstake transaction takes: 8 went through in one, as a real holder. */
export const FARMS_PER_TRANSACTION = 8;

async function byIndex<T>(code: string, table: string, index: 'primary' | 'secondary' | 'tertiary', who: string, scope = code): Promise<T[]> {
  return getTableRows<T>({ code, scope, table, index_position: index, key_type: 'name', lower_bound: who, upper_bound: who, limit: 500 })
    .catch(() => [] as T[]);
}

const coded = new Map<string, Promise<boolean>>();
/**
 * Whether a reward contract still holds code. Some farms pay from one that
 * does not (exktra.gm, starcadiatok): its tables outlive the code, so a
 * wallet that once held the token passes waxdaofarmer's balance check and
 * the payment then does nothing, while any other wallet is refused ("you
 * need to use the 'open' action"), on every unstake as well as every
 * claim, with no `open` left to fix it.
 */
function hasCode(contract: string): Promise<boolean> {
  if (!coded.has(contract)) {
    coded.set(contract, withFailover((c) => c.call({ path: '/v1/chain/get_code_hash', params: { account_name: contract } }))
      .then((r) => !/^0+$/.test(String((r as { code_hash?: string }).code_hash ?? '0')))
      .catch(() => true));
  }
  return coded.get(contract)!;
}

const openable = new Map<string, Promise<boolean>>();
/** Whether a token contract has the standard `open(owner, symbol, ram_payer)`. */
function hasOpen(contract: string): Promise<boolean> {
  if (!openable.has(contract)) {
    openable.set(contract, withFailover((c) => c.v1.chain.get_abi(contract))
      .then((r) => {
        const a = r.abi?.actions.find((x) => String(x.name) === 'open');
        const s = a && r.abi?.structs.find((x) => x.name === String(a.type));
        return Boolean(s && ['owner', 'symbol', 'ram_payer'].every((f) => s.fields.some((x) => x.name === f)));
      })
      .catch(() => false));
  }
  return openable.get(contract)!;
}

/**
 * The `open` actions a payout needs: one per token the wallet has no
 * balance row for. A contract paying into a missing row aborts the whole
 * transaction, which is how a claim of 19 FOOD was refused.
 */
async function opensFor(actor: string, tokens: { contract: string; symbol: string; precision: number }[]): Promise<BuiltAction[]> {
  const out: BuiltAction[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    const k = `${t.contract}:${t.symbol}`;
    if (!t.contract || !t.symbol || seen.has(k)) continue;
    seen.add(k);
    const rows = await withFailover((c) => c.v1.chain.get_currency_balance(t.contract, actor, t.symbol)).catch(() => undefined);
    if (!rows || rows.length || !(await hasOpen(t.contract))) continue;
    out.push(act(t.contract, 'open', actor, { owner: actor, symbol: `${t.precision},${t.symbol}`, ram_payer: actor }));
  }
  return out;
}

/** The token in a quantity like "19.28551670 FOOD", with its precision. */
function tokenOf(quantity: string, contract: string) {
  const [q, symbol] = String(quantity ?? '').split(' ');
  return { contract, symbol: symbol ?? '', precision: (q?.split('.')[1] ?? '').length };
}

const OWNER_PAGES_AT_ONCE = 24;

/** Which of these NFTs the given contract owns right now. */
async function heldBy(contract: string, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const pages: string[][] = [];
  for (let i = 0; i < ids.length; i += 100) pages.push(ids.slice(i, i + 100));
  // A page takes the API about 3.5s however many are asked together, so
  // they all go at once: the largest wallet in the scan, 2,144 staked NFTs,
  // is 22 pages. The cap only keeps a bigger one from asking 50 together.
  for (let i = 0; i < pages.length; i += OWNER_PAGES_AT_ONCE) {
    await Promise.all(pages.slice(i, i + OWNER_PAGES_AT_ONCE).map(async (page) => {
      try {
        const rows = await atomicFetch<{ asset_id: string; owner: string | null }[]>(
          `/atomicassets/v1/assets?ids=${page.join(',')}&limit=100`);
        for (const a of rows ?? []) if (a.owner === contract) out.add(String(a.asset_id));
      } catch { /* unknown stays out: nothing is offered that could not be shown */ }
    }));
  }
  return out;
}

interface StakeRow { username: string; farmname: string; claimable: string; assets: (string | number)[]; unlocktime: number | string }
interface PoolRow { poolname: string; user: string; amountstaked: string; claimable: string; unlocktime: number | string; rwdcontract: string; contract: string }
interface FarmV2Row { user: string; farmname: string; asset_ids: (string | number)[]; claimable_balances?: { quantity: string; contract: string }[] }
interface TokenFarmRow { farm_name: string; balance: string; claimable_balances?: { quantity: string; contract: string }[]; vesting_end_time: number | string }
interface DaoStakeRow { dao: string; balance: string; unlock_time: number | string }
interface LockRow { ID: number | string; receiver: string; amount: string; token_contract: string; unlock_time: number | string; status: number }
interface BackerRow { wallet: string; balances?: { quantity: string; token_contract: string }[] }

/** Everything WaxDAO holds for `actor`, read live. Sections that cannot be read are left out rather than guessed. */
export async function readWaxdaoHoldings(actor: string): Promise<WaxdaoHolding[]> {
  if (!actor) return [];
  const now = Date.now() / 1000;
  const out: WaxdaoHolding[] = [];
  const [farms, pools, farmsV2, tokenFarms, daoStakes, locks, backer, userRam, ramBalances, premint, tokenBalances] = await Promise.all([
    byIndex<StakeRow>('waxdaofarmer', 'stakebackup', 'secondary', actor),
    byIndex<PoolRow>('waxdaofarmer', 'tokens', 'secondary', actor),
    byIndex<FarmV2Row>('farms.waxdao', 'stakers', 'tertiary', actor),
    getTableRows<TokenFarmRow>({ code: 'tf.waxdao', scope: actor, table: 'stakers', limit: 200 }).catch(() => [] as TokenFarmRow[]),
    getTableRows<DaoStakeRow>({ code: 'dao.waxdao', scope: actor, table: 'stakedtokens', limit: 200 }).catch(() => [] as DaoStakeRow[]),
    byIndex<LockRow>('waxdaolocker', 'locks', 'tertiary', actor),
    byIndex<BackerRow>('waxdaobacker', 'balances', 'primary', actor),
    byIndex<{ user: string; balance: string }>('waxdaomarket', 'userram', 'secondary', actor),
    byIndex<{ owner: string; collection: string; balance: string }>('waxdaomarket', 'rambalances', 'tertiary', actor),
    byIndex<{ ID: number | string; user: string; collection: string; display_name: string; assets: (string | number)[]; status: string }>('waxdaomarket', 'premintpools', 'secondary', actor),
    getTableRows<{ balance: string; contract: string }>({ code: 'waxdaomarket', scope: actor, table: 'tokenbalance', limit: 200 }).catch(() => [] as { balance: string; contract: string }[]),
  ]);

  // NFT farms v1: the NFTs the contract still holds, and the rewards.
  const mine = farms.filter((r) => String(r.username) === actor);
  const held = await heldBy('waxdaofarmer', mine.flatMap((r) => r.assets.map(String)));
  // Each farm names its reward token; a deleted farm has no row, and the
  // contract then refuses anything for it ("This farm does not exist").
  const farmRows = new Map(await Promise.all(mine.map(async (r) => [r.farmname,
    (await byIndex<{ farmname: string; rewardtoken: string; contract: string; poolsize: string }>('waxdaofarmer', 'farms', 'secondary', r.farmname))
      .find((f) => f.farmname === r.farmname)] as const)));
  // In parallel: a big wallet sits in thirty farms, and each one is a few reads.
  const farmHoldings = await Promise.all(mine.map(async (r): Promise<WaxdaoHolding | undefined> => {
    const nfts = r.assets.map(String).filter((a) => held.has(a));
    const reward = amount(r.claimable) > 0 ? `${r.claimable} to claim` : '';
    if (!nfts.length && !reward) return undefined;
    const farm = farmRows.get(r.farmname);
    const locked = Number(r.unlocktime) > now;
    const unstake = act('waxdaofarmer', 'unstakeall', actor, { user: actor, farmname: r.farmname });
    // A reward contract without code: only the chain can say whether this
    // wallet gets through, so it is asked, once, without signing.
    const codeless = Boolean(farm) && !(await hasCode(farm!.contract));
    const stuck = codeless && nfts.length > 0 && (await simulateActions([unstake])).kind === 'refused';
    const broken = !farm || stuck || (codeless && !nfts.length);
    const opens = farm && !codeless ? await opensFor(actor, [tokenOf(farm.poolsize, farm.contract)]) : [];
    const actions: WaxdaoHolding['actions'] = [];
    if (farm && !codeless && reward) actions.push({ label: `Claim ${r.claimable}`, build: [...opens, act('waxdaofarmer', 'claimrewards', actor, { farm: r.farmname, user: actor })] });
    if (farm && !stuck && nfts.length && !locked) actions.push({ label: `Unstake ${nfts.length} NFT${nfts.length === 1 ? '' : 's'}`, build: [...opens, unstake] });
    return {
      key: `farm:${r.farmname}`, group: 'nft-farm', contract: 'waxdaofarmer',
      title: nfts.length ? `${nfts.length} NFT${nfts.length === 1 ? '' : 's'} staked in ${r.farmname}` : `Rewards in ${r.farmname}`,
      detail: reward || undefined,
      note: !farm ? 'This farm was deleted, and the contract refuses to give anything back for it.'
        : stuck ? `This farm pays its rewards from ${farm!.contract}, which no longer holds any code, and WaxDAO refuses every claim and unstake for it from this wallet. What is in it stays with waxdaofarmer until the farm's creator fixes the farm.`
          : codeless ? `This farm pays its rewards from ${farm!.contract}, which no longer holds any code: unstaking gives your NFTs back, but its rewards cannot arrive.`
            : nfts.length && locked ? `Locked until ${day(Number(r.unlocktime))}.` : undefined,
      actions,
      opens,
      // Out of the batched transactions either way: one refusal sinks them all.
      broken: broken || codeless,
    };
  }));
  out.push(...farmHoldings.filter((h): h is WaxdaoHolding => Boolean(h)));

  // Token pools v1.
  for (const r of pools.filter((x) => String(x.user) === actor)) {
    const staked = amount(r.amountstaked) > 0, reward = amount(r.claimable) > 0;
    if (!staked && !reward) continue;
    const locked = Number(r.unlocktime) > now;
    const opens = await opensFor(actor, [
      ...(reward ? [tokenOf(r.claimable, r.rwdcontract)] : []),
      ...(staked ? [tokenOf(r.amountstaked, r.contract)] : []),
    ]);
    const actions: WaxdaoHolding['actions'] = [];
    if (reward) actions.push({ label: `Claim ${r.claimable}`, build: [...opens, act('waxdaofarmer', 'claimpoolrwd', actor, { pool: r.poolname, user: actor })] });
    if (staked && !locked) actions.push({ label: `Unstake ${r.amountstaked}`, build: [...opens, act('waxdaofarmer', 'unstaketoken', actor, { amount: r.amountstaked, user: actor, poolname: r.poolname })] });
    out.push({
      key: `pool:${r.poolname}`, group: 'token-pool', contract: 'waxdaofarmer',
      title: staked ? `${r.amountstaked} staked in ${r.poolname}` : `Rewards in ${r.poolname}`,
      detail: reward ? `${r.claimable} to claim` : undefined,
      note: staked && locked ? `Locked until ${day(Number(r.unlocktime))}.` : undefined,
      actions,
    });
  }

  // NFT farms v2: the NFTs stay in the wallet, the rewards do not.
  for (const r of farmsV2.filter((x) => String(x.user) === actor)) {
    const claim = (r.claimable_balances ?? []).filter((c) => amount(c.quantity) > 0);
    if (!claim.length) continue;
    out.push({
      key: `farmv2:${r.farmname}`, group: 'nft-farm-v2', contract: 'farms.waxdao',
      title: `Rewards in ${r.farmname}`,
      detail: `${claim.map((c) => c.quantity).join(' + ')} to claim. The ${r.asset_ids.length} NFT${r.asset_ids.length === 1 ? '' : 's'} staked here never left your wallet.`,
      actions: [{ label: 'Claim', build: [...await opensFor(actor, claim.map((c) => tokenOf(c.quantity, c.contract))),
        act('farms.waxdao', 'claim', actor, { user: actor, farmname: r.farmname })] }],
    });
  }

  // Token farms.
  for (const r of tokenFarms) {
    if (amount(r.balance) <= 0) continue;
    const vesting = Number(r.vesting_end_time) > now;
    const claim = (r.claimable_balances ?? []).filter((c) => amount(c.quantity) > 0);
    const opens = await opensFor(actor, (r.claimable_balances ?? []).map((c) => tokenOf(c.quantity, c.contract)));
    const actions: WaxdaoHolding['actions'] = [
      // The figure on the row can lag: getreward settles what is owed when it runs.
      { label: 'Claim rewards', build: [...opens, act('tf.waxdao', 'getreward', actor, { user: actor, farm_name: r.farm_name })] },
    ];
    if (!vesting) actions.push({ label: `Unstake ${r.balance}`, build: [...opens, act('tf.waxdao', 'unstake', actor, { user: actor, farm_name: r.farm_name, amount: r.balance })] });
    out.push({
      key: `tf:${r.farm_name}`, group: 'token-farm', contract: 'tf.waxdao',
      title: `${r.balance} staked in ${r.farm_name}`,
      detail: claim.length ? `${claim.map((c) => c.quantity).join(' + ')} to claim` : undefined,
      note: vesting ? `Vesting until ${day(Number(r.vesting_end_time))}.` : undefined,
      actions,
    });
  }

  // DAO staking.
  for (const r of daoStakes) {
    if (amount(r.balance) <= 0) continue;
    const locked = Number(r.unlock_time) > now;
    out.push({
      key: `dao:${r.dao}`, group: 'dao', contract: 'dao.waxdao',
      title: `${r.balance} staked in the ${r.dao} DAO`,
      note: locked ? `Locked until ${day(Number(r.unlock_time))}.` : undefined,
      actions: locked ? [] : [{ label: `Unstake ${r.balance}`, build: [act('dao.waxdao', 'unstaketoken', actor, { user: actor, dao: r.dao, quantity: r.balance })] }],
    });
  }

  // Locks: status 2 is "completed, cancelled or not funded", as the contract says when asked.
  for (const r of locks.filter((x) => String(x.receiver) === actor && Number(x.status) !== 2 && amount(x.amount) > 0)) {
    const locked = Number(r.unlock_time) > now;
    out.push({
      key: `lock:${r.ID}`, group: 'lock', contract: 'waxdaolocker',
      title: `${r.amount} locked for you`,
      note: locked ? `Unlocks ${day(Number(r.unlock_time))}.` : undefined,
      actions: locked ? [] : [{ label: 'Withdraw', build: [act('waxdaolocker', 'withdraw', actor, { lock_ID: r.ID })] }],
    });
  }

  // Backed-token balances: a token the wallet has never held needs its row opened first.
  for (const r of backer.filter((x) => String(x.wallet) === actor)) {
    const bal = (r.balances ?? []).filter((c) => amount(c.quantity) > 0);
    if (!bal.length) continue;
    const opens = await opensFor(actor, bal.map((b) => tokenOf(b.quantity, b.token_contract)));
    out.push({
      key: 'backer', group: 'backer', contract: 'waxdaobacker',
      title: `${bal.map((c) => c.quantity).join(' + ')} from token-backed NFTs`,
      actions: [{ label: 'Withdraw', build: [...opens, act('waxdaobacker', 'withdraw', actor, { user: actor, contract_ignore_list: [] })] }],
    });
  }

  // The market: what a creator left there.
  for (const r of userRam.filter((x) => String(x.user) === actor && amount(x.balance) > 0)) {
    out.push({ key: 'userram', group: 'market', contract: 'waxdaomarket', title: `${r.balance} of RAM balance`,
      actions: [{ label: 'Withdraw', build: [act('waxdaomarket', 'wthdrawblram', actor, { user: actor, amount_to_withdraw: r.balance })] }] });
  }
  for (const r of ramBalances.filter((x) => String(x.owner) === actor && amount(x.balance) > 0)) {
    out.push({ key: `ram:${r.collection}`, group: 'market', contract: 'waxdaomarket', title: `${r.balance} of RAM for ${r.collection}`,
      actions: [{ label: 'Withdraw', build: [act('waxdaomarket', 'withdrawram', actor, { user: actor, collection: r.collection, amount_to_withdraw: r.balance })] }] });
  }
  for (const r of tokenBalances.filter((x) => amount(x.balance) > 0)) {
    out.push({ key: `tok:${r.contract}:${r.balance}`, group: 'market', contract: 'waxdaomarket', title: `${r.balance} deposited for blends`,
      actions: [{ label: 'Withdraw', build: [act('waxdaomarket', 'wthdrawtoken', actor, { user: actor, amount_to_withdraw: r.balance, contract: r.contract })] }] });
  }
  for (const r of premint.filter((x) => String(x.user) === actor && x.assets.length)) {
    const inPool = [...await heldBy('waxdaomarket', r.assets.map(String))];
    if (!inPool.length) continue;
    out.push({ key: `premint:${r.ID}`, group: 'market', contract: 'waxdaomarket',
      title: `${inPool.length} NFT${inPool.length === 1 ? '' : 's'} in your premint pool "${r.display_name || r.ID}" (${r.collection})`,
      // A locked pool is one a drop or a pack draws from: the contract
      // refuses ("This pool is currently locked") until that is removed.
      // In slices otherwise: hundreds of ids would not fit one transaction.
      actions: r.status === 'locked' ? [] : [{ label: `Take back ${Math.min(inPool.length, 50)}`, build: [act('waxdaomarket', 'removeassets', actor, { pool_id: r.ID, user: actor, assets_to_remove: inPool.slice(0, 50) })] }],
      note: r.status === 'locked' ? 'Locked: a drop or a pack draws from this pool, so it cannot be emptied while that is set up.'
        : inPool.length > 50 ? 'Fifty at a time; the rest stay listed here until they are out.' : undefined });
  }
  return out;
}

/** The opens several holdings need, each once. */
function opensOf(holdings: WaxdaoHolding[]): BuiltAction[] {
  const seen = new Set<string>();
  return holdings.flatMap((h) => h.opens ?? []).filter((a) => {
    const k = `${a.account}:${String(a.data.symbol)}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

/** One transaction that unstakes from several v1 farms at once: the first FARMS_PER_TRANSACTION of these. */
export function unstakeManyFarms(actor: string, farms: WaxdaoHolding[]): BuiltAction[] {
  const chosen = farms.filter((h) => !h.broken).slice(0, FARMS_PER_TRANSACTION);
  return [...opensOf(chosen), ...chosen.map((h) => act('waxdaofarmer', 'unstakeall', actor, { user: actor, farmname: h.key.replace(/^farm:/, '') }))];
}

/**
 * Every v1 farm reward, in one action, with the opens they need. Not
 * offered when one of the farms is broken: claimall pays them all, and
 * the broken one fails the whole transaction.
 */
export function claimAllFarms(actor: string, farms: WaxdaoHolding[]): BuiltAction[] {
  return [...opensOf(farms), act('waxdaofarmer', 'claimall', actor, { user: actor })];
}
