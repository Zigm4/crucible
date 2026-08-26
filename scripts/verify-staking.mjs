/**
 * Does our staking layer build what the chain already accepted?
 *
 * `stake.nefty` is live and holds tokens belonging to people whose front
 * end disappeared. Before any page offers to move them, our actions have
 * to reproduce, byte for byte, transactions the contract has already
 * executed.
 *
 *   PHASE A - replay. Every recent claim, unstake and claimtokuser is
 *             pulled from history, folded back into our builders, and the
 *             serialised bytes compared against what was really signed.
 *   PHASE B - the readers, against live positions. What the contract says
 *             an account holds is what we must report, including the
 *             three separate pools and the refund clock.
 *   PHASE D - read then build. The replay feeds our builders data taken
 *             from history, so it never exercises the reader that will
 *             actually feed them in the page. A symbol read with the wrong
 *             precision is a claim the contract refuses, and the replay
 *             alone cannot see it.
 *   PHASE E - the view layer, which nothing covered at all. A reload that
 *             leaves the previous account's balances on screen, or a delay
 *             stated for the wrong pool, is a wrong transaction offered to
 *             somebody who trusted the page.
 *   PHASE C - the shape of the answer. A refund that is not ready must not
 *             read as ready, and a pool with nothing in it must not appear
 *             as an opportunity.
 *
 * As everywhere in this repo, this imports the SHIPPED module. It does not
 * reimplement it: a harness that reimplemented the parsers once passed
 * while the shipped code was broken.
 */
import { Action, APIClient, Serializer } from '@wharfkit/session';

let st;
try { st = await import('./.build/staking.mjs'); }
catch { console.error('Missing scripts/.build/staking.mjs - run `npm run build:verify`.'); process.exit(1); }
const { buildClaimRewards, buildUnstake, buildClaimRefund,
        buildUnstakeCollection, buildClaimCollectionRefund,
        readStakePositions, readStakeRefunds, readStakeScopes, readRefundDelay,
        readCollectionStakes, readCollectionRefunds } = st;

const HYPERION = ['https://wax.eosphere.io', 'https://api.waxsweden.org'];
const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); return cond; };
const say = (pass, msg) => { console.log(`   ${pass ? 'ok  ' : 'FAIL'} ${msg}`); if (!pass) fails.push(msg); };

async function history(filter, limit = 250) {
  for (const host of HYPERION) {
    try {
      const r = await fetch(`${host}/v2/history/get_actions?account=stake.nefty&filter=${encodeURIComponent(filter)}&limit=${limit}&sort=desc`);
      if (!r.ok) continue;
      const d = await r.json();
      if (Array.isArray(d.actions)) return d.actions;
    } catch { /* next host */ }
  }
  return [];
}

async function main() {
  const client = new APIClient({ url: 'https://wax.greymass.com' });
  const abi = (await client.v1.chain.get_abi('stake.nefty')).abi;
  const bytes = (a) => String(Action.from({
    account: a.account, name: a.name, authorization: a.authorization, data: a.data,
  }, abi).data);

  console.log('=== PHASE A - replay real signed actions, byte for byte ===');
  const cases = [
    ['stake.nefty:claim', 'claim', (d, actor) => buildClaimRewards(actor, d.token_symbol)],
    ['stake.nefty:unstake', 'unstake', (d, actor) => buildUnstake(actor, d.to_refund.quantity, d.to_refund.contract)],
    ['stake.nefty:claimtokuser', 'claimtokuser', (d, actor) => buildClaimRefund(actor, Number(d.refund_id))],
    // The collection side. A different table, a different action, and the
    // only stake on these contracts that still buys a capability, so it
    // gets the same byte-for-byte treatment as the rest.
    ['stake.nefty:unstakecoll', 'unstakecoll',
      (d, actor) => buildUnstakeCollection(actor, d.collection, d.to_refund.quantity, d.to_refund.contract)],
    ['stake.nefty:claimtokcoll', 'claimtokcoll',
      (d, actor) => buildClaimCollectionRefund(actor, Number(d.refund_id))],
  ];
  for (const [filter, name, build] of cases) {
    const acts = (await history(filter)).filter((x) => x.act.name === name);
    if (!acts.length) { fails.push(`${name}: no historical action to replay, so nothing was proven`); continue; }
    let matched = 0, checked = 0;
    for (const x of acts) {
      const actor = (x.act.authorization ?? [])[0]?.actor;
      if (!actor) continue;
      checked++;
      // What the chain really executed, re-serialised from its own data.
      const theirs = bytes({ ...x.act, authorization: x.act.authorization });
      const ours = bytes(build(x.act.data, String(actor)));
      if (ours === theirs) matched++;
      else if (matched + 1 === checked) {
        fails.push(`${name}: our bytes differ from the signed action ${x.trx_id?.slice(0, 16)}`);
        console.log(`     signed: ${theirs}\n     ours  : ${ours}\n     data  : ${JSON.stringify(x.act.data)}`);
      }
    }
    say(matched === checked && checked > 0,
        `${name}: ${matched}/${checked} real transactions rebuilt exactly`);
  }

  console.log('\n=== PHASE B - the readers, against live positions ===');
  const scopes = await readStakeScopes();
  say(scopes.length >= 2, `${scopes.length} pool(s) discovered rather than hardcoded: ${scopes.join(', ')}`);

  const delay = await readRefundDelay();
  say(delay === 259200, `the unstaking delay is read from config: ${delay} seconds`);

  // An account with a real position today, taken from the history itself
  // so this does not rot the way a hardcoded name does.
  const recent = (await history('stake.nefty:claim')).map((x) => String((x.act.authorization ?? [])[0]?.actor)).filter(Boolean);
  let probed = 0;
  for (const actor of [...new Set(recent)].slice(0, 6)) {
    const pos = await readStakePositions(actor);
    if (!pos.length) continue;
    probed++;
    for (const p of pos) {
      // Cross-check against the raw table, so a decoding slip cannot pass.
      const raw = await (await fetch('https://wax.greymass.com/v1/chain/get_table_rows', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ json: true, code: 'stake.nefty', scope: p.scope, table: 'stakers',
          lower_bound: actor, upper_bound: actor, key_type: 'name', limit: 1 }),
      })).json();
      const r = (raw.rows ?? [])[0];
      if (!r) { fails.push(`${actor}: reported a position in ${p.scope} the raw table does not have`); continue; }
      const rawStaked = parseFloat(String(r.staked).split(' ')[0]);
      const rawRewards = parseFloat(String(r.rewards).split(' ')[0]);
      if (Math.abs(rawStaked - p.staked) > 1e-8) fails.push(`${actor}/${p.scope}: staked ${p.staked} but the table says ${rawStaked}`);
      if (Math.abs(rawRewards - p.rewards) > 1e-8) fails.push(`${actor}/${p.scope}: rewards ${p.rewards} but the table says ${rawRewards}`);
      // The symbol code is what claim() is given, so a wrong precision is
      // a transaction the contract refuses.
      if (!/^\d+,[A-Z]+$/.test(p.stakedSymbolCode)) fails.push(`${actor}/${p.scope}: symbol code "${p.stakedSymbolCode}" is not precision,SYMBOL`);
    }
    if (probed >= 3) break;
  }
  say(probed >= 1, `${probed} live account(s) cross-checked against the raw table`);

  console.log('\n=== PHASE C - the shape of the answer ===');
  const refunds = await readStakeRefunds('cn1qw.wam');
  const nowSec = Date.now() / 1000;
  const wrong = refunds.filter((r) => r.ready !== (r.unlockTime <= nowSec));
  say(wrong.length === 0, `refund readiness follows the clock, not a guess (${refunds.length} row(s) for that account)`);
  say(refunds.every((r) => r.id > 0 && r.contract), 'every refund carries the id and contract claimtokuser needs');

  // A pool the account is not in must not be invented.
  const empty = await readStakePositions('eosio');
  say(empty.length === 0, 'an account with no position reports none, rather than a row of zeroes');

  // And an unknown account must not throw.
  const nobody = await readStakePositions('thisisnotreal');
  say(Array.isArray(nobody) && nobody.length === 0, 'an unreadable account returns nothing rather than failing');

  console.log('\n=== PHASE D - the symbol the reader derives, checked independently ===');
  {
    // The first version of this phase looked the historical claim up BY
    // the very field it was testing, then compared bytes against it. Those
    // are equal by construction: change the precision and it simply found
    // a different claim that happened to use the wrong value, of which
    // history has four. It printed ok while every NEFTY claim was being
    // built as "4,NEFTY". The expectation has to come from somewhere the
    // module under test cannot influence, so it comes from the raw table.
    const claims = (await history('stake.nefty:claim')).filter((x) => x.act.name === 'claim');
    const actors = [...new Set(claims.map((x) => String((x.act.authorization ?? [])[0]?.actor)))].filter(Boolean);

    let checked = 0;
    for (const actor of actors.slice(0, 10)) {
      const positions = await readStakePositions(actor);
      for (const p of positions) {
        const raw = await (await fetch('https://wax.greymass.com/v1/chain/get_table_rows', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ json: true, code: 'stake.nefty', scope: p.scope, table: 'stakers',
            lower_bound: actor, upper_bound: actor, key_type: 'name', limit: 1 }),
        })).json();
        const staked = String((raw.rows ?? [])[0]?.staked ?? '');
        const rewards = String((raw.rows ?? [])[0]?.rewards ?? '');
        if (!staked) continue;
        // Derived here, from the asset string, with no help from the module.
        const [amount, symbol] = staked.split(' ');
        const dot = amount.indexOf('.');
        const expected = `${dot < 0 ? 0 : amount.length - dot - 1},${symbol}`;
        checked++;
        // What the screen prints has to be what the table says, digit for
        // digit. toLocaleString rounded 6498.78574115 up to "6,498.786",
        // which reads as more than the account holds and does not match
        // any explorer.
        if (p.stakedRaw !== staked) {
          fails.push(`${actor}/${p.scope}: displays "${p.stakedRaw}" but the table says "${staked}"`);
        }
        // The reward figure is the one printed on the Claim button, so it
        // is held to exactly the same rule.
        if (rewards && p.rewardsRaw !== rewards) {
          fails.push(`${actor}/${p.scope}: the claim button offers "${p.rewardsRaw}" but the table says "${rewards}"`);
        }
        if (p.stakedSymbolCode !== expected) {
          fails.push(`${actor}/${p.scope}: reader says "${p.stakedSymbolCode}", the table says "${staked}" so it must be "${expected}"`);
        }
      }
      if (checked >= 4) break;
    }
    say(checked >= 2, `${checked} symbol code(s) derived from the raw asset string and matched`);

    // And separately: the symbol the reader produces has to be one the
    // contract actually pays, which is what stakerewards lists.
    const configured = (await client.v1.chain.get_table_rows({
      json: true, code: 'stake.nefty', scope: 'stake.nefty', table: 'stakerewards', limit: 10,
    })).rows.map((r) => String(r.total_staked).split(' ')[1]);
    say(configured.length >= 2, `${configured.length} reward pool(s) configured on chain: ${configured.join(', ')}`);

    // The per-pool refund delay, which is NOT the global config value.
    const delays = (await client.v1.chain.get_table_rows({
      json: true, code: 'stake.nefty', scope: 'stake.nefty', table: 'stakerewards', limit: 10,
    })).rows.map((r) => [String(r.total_staked).split(' ')[1], Number(r.refund_delay)]);
    const differing = new Set(delays.map(([, d]) => d)).size > 1;
    say(differing, `refund delays differ between pools, so no single number describes them: ${delays.map(([s, d]) => `${s}=${d}`).join(', ')}`);
  }

  console.log('\n=== PHASE E - the view layer ===');
  {
    let view;
    try { view = await import('./.build/stakingView.mjs'); }
    catch { fails.push('scripts/.build/stakingView.mjs missing, so the view layer was not checked at all'); }
    if (view) {
      const { emptyStakingState, loadStaking, readRewardPools, refundDelayFor,
              isUnprovenPool, tokenContractFor, buildUnstakeFor,
              poolShortfall, readHeldBalance, censusPool } = view;

      // A reload for a DIFFERENT account must not leave the previous one on
      // screen. renderStakingView gates on `loaded`, so anything still true
      // there is drawn, with live buttons, under the new account's name.
      const st = emptyStakingState();
      st.loaded = true;
      st.actor = 'aaa';
      st.positions = [{ scope: 'x', stakedSymbol: 'NEFTY', stakedSymbolCode: '8,NEFTY', staked: 999, refunding: 0, rewards: 5, rewardsSymbol: 'WAX' }];
      st.refunds = [{ id: 1, quantity: '1.0 NEFTY', amount: 1, symbol: 'NEFTY', contract: 'token.nefty', unlockTime: 1, ready: true }];
      const inFlight = loadStaking(st, 'bbb');
      say(st.loaded === false && st.positions.length === 0 && st.refunds.length === 0,
          `a reload for another account clears what was on screen (loaded=${st.loaded}, ${st.positions.length} position(s) left)`);
      await inFlight;

      // The delay is per pool, and stating one number for all of them tells
      // 4,031 NEFWAX stakers to expect a wait that does not exist.
      const pools = await readRewardPools();
      const byPool = pools.map((p) => [p.stakedSymbol, p.refundDelay]);
      say(pools.length >= 2 && new Set(pools.map((p) => p.refundDelay)).size > 1,
          `pools carry their own refund delay: ${byPool.map(([s, d]) => `${s}=${d}`).join(', ')}`);
      const nefty = { stakedSymbol: 'NEFTY' };
      const nefwax = { stakedSymbol: 'NEFWAX' };
      say(refundDelayFor(nefty, pools) === 259200, `NEFTY waits ${refundDelayFor(nefty, pools)}`);
      say(refundDelayFor(nefwax, pools) === 0, `NEFWAX waits ${refundDelayFor(nefwax, pools)}, so it returns in the same transaction`);

      // A retired pool has no row, and must be flagged rather than shown as
      // ordinary. A live one must NOT be flagged.
      say(isUnprovenPool({ stakedSymbol: 'WAXNEFT' }, pools) === true, 'the retired pool is flagged');
      say(isUnprovenPool(nefty, pools) === false, 'a live pool is not flagged');
      say(tokenContractFor(nefty, pools) === 'token.nefty', `NEFTY resolves to ${tokenContractFor(nefty, pools)}`);
      say(tokenContractFor({ stakedSymbol: 'WAXNEFT' }, pools) === '',
          'the retired pool resolves to no contract, so no unstake can be built for it');

      // The quantity string must carry the token's own precision, or the
      // contract refuses it.
      const built = buildUnstakeFor('zigm4.gm',
        { stakedSymbol: 'NEFTY', stakedSymbolCode: '8,NEFTY', staked: 6498.79123456 }, 'token.nefty');
      const q = built[0]?.data?.to_refund?.quantity;
      say(q === '6498.79123456 NEFTY', `an unstake carries full precision: ${q}`);

      // -------- what the contract HOLDS, against what its books claim -----
      // The page used to print rewards_balance as "the reward pot". For WAX
      // that advertises about 39,702 WAX more than exists. These checks
      // exist so nobody quietly reverts to the books.
      for (const p of pools) {
        const sym = p.rewardsBalance.split(' ')[1];
        const raw = await client.v1.chain.get_currency_balance(p.rewardsContract, 'stake.nefty', sym);
        const expected = raw.length ? String(raw[0]) : '';
        if (p.heldBalance !== expected) {
          fails.push(`${p.stakedSymbol} pool: heldBalance says "${p.heldBalance}", the chain says "${expected}"`);
        }
      }
      say(pools.every((p) => p.heldBalance),
          `each pool carries the real balance: ${pools.map((p) => `${p.stakedSymbol}->${p.heldBalance}`).join(', ')}`);

      // The WAX pot is short and must be reported short. If this ever stops
      // failing it means either the pot was refilled (good, and the page
      // will say so on its own) or the comparison broke (bad).
      const waxPool = pools.find((p) => p.rewardsBalance.endsWith(' WAX'));
      const short = waxPool ? poolShortfall(waxPool) : undefined;
      say(Boolean(short),
          short
            ? `the WAX pot is reported short by ${short.short} ${short.symbol}, covering ${short.coverage}%`
            : 'the WAX pot is NOT reported short, which needs a human to look at it');

      // And the NEFTY-paying pool must NOT be reported short, because its
      // balance backs staked principal first. Calling that a shortfall, or
      // calling it solvent, would both be wrong; the honest answer is to
      // decline the comparison.
      const neftyPaying = pools.find((p) => p.rewardsBalance.endsWith(' NEFTY'));
      say(neftyPaying && neftyPaying.rewardTokenIsStaked && poolShortfall(neftyPaying) === undefined,
          'the pool that pays a token it also stakes declines the solvency comparison rather than guessing');

      // Nothing has accrued since the last fill. next_reward_time is the
      // contract's own clock, and the notice on the page is derived from it.
      const behind = pools.map((p) => Math.floor(Date.now() / 1000 - p.nextRewardTime));
      say(behind.every((b) => b > 86400),
          `every pool's reward clock is in the past: ${pools.map((p, i) => `${p.stakedSymbol}=${Math.floor(behind[i] / 86400)}d`).join(', ')}`);

      // next_reward_time is the boundary of the NEXT cycle, not the moment
      // of the last fill. The page said "the last reward cycle ran at" and
      // printed a time 3,400 seconds after the last fill actually was. If
      // this stops holding, the sentence on the page has to change with it.
      const boundary = pools.every((p) => p.nextRewardTime % 3600 === 0);
      say(boundary,
          `the reward clock is a period boundary, so it is a due time and not a run time: ${pools.map((p) => new Date(p.nextRewardTime * 1000).toISOString()).join(', ')}`);
      const lastFill = Date.parse('2026-04-28T10:03:20Z') / 1000;
      say(pools.every((p) => p.nextRewardTime > lastFill),
          'the clock sits after the last fill ever signed, which is why it reads as a cycle that came due and never ran');

      // The NEFTY pool's total_staked counts collection staking too, which
      // is why the page must not print it as "what wallets have in it".
      // Checked rather than asserted: header minus user rows has to be the
      // collstaking sum, or the sentence on the page is wrong.
      {
        let userUnits = 0n;
        for (let lb = '', page = 0; page < 20; page++) {
          const r = await client.v1.chain.get_table_rows({
            json: true, code: 'stake.nefty', scope: '.....qeoct2oi', table: 'stakers',
            limit: 1000, key_type: 'name', lower_bound: lb || undefined,
          });
          for (const x of (lb ? r.rows.slice(1) : r.rows)) {
            userUnits += BigInt(String(x.staked).split(' ')[0].replace('.', ''));
          }
          if (!r.more) break;
          lb = String(r.rows[r.rows.length - 1].account);
        }
        let collUnits = 0n;
        for (let lb = '', page = 0; page < 10; page++) {
          const r = await client.v1.chain.get_table_rows({
            json: true, code: 'stake.nefty', scope: 'stake.nefty', table: 'collstaking',
            limit: 1000, key_type: 'name', lower_bound: lb || undefined,
          });
          for (const x of (lb ? r.rows.slice(1) : r.rows)) {
            for (const q of x.stakings ?? []) collUnits += BigInt(String(q.quantity).split(' ')[0].replace('.', ''));
          }
          if (!r.more) break;
          lb = String(r.rows[r.rows.length - 1].collection_name);
        }
        const neftyPool = pools.find((p) => p.stakedSymbol === 'NEFTY');
        const headerUnits = BigInt(String(neftyPool.totalStaked).split(' ')[0].replace('.', ''));
        const fmt = (u) => `${u / 100000000n}.${String(u % 100000000n).padStart(8, '0')}`;
        say(headerUnits > userUnits && collUnits > 0n,
            `the NEFTY header counts collections too: header ${fmt(headerUnits)}, wallets ${fmt(userUnits)}, collections ${fmt(collUnits)}`);
        // Collections stake NEFTY and nothing else, which is why the note is
        // written about the NEFTY figure alone.
        const nefwaxPool = pools.find((p) => p.stakedSymbol === 'NEFWAX');
        const nwHeader = BigInt(String(nefwaxPool.totalStaked).split(' ')[0].replace('.', ''));
        let nwUsers = 0n;
        for (let lb = '', page = 0; page < 10; page++) {
          const r = await client.v1.chain.get_table_rows({
            json: true, code: 'stake.nefty', scope: '...5kkerct2oi', table: 'stakers',
            limit: 1000, key_type: 'name', lower_bound: lb || undefined,
          });
          for (const x of (lb ? r.rows.slice(1) : r.rows)) {
            nwUsers += BigInt(String(x.staked).split(' ')[0].replace('.', ''));
          }
          if (!r.more) break;
          lb = String(r.rows[r.rows.length - 1].account);
        }
        // Within a rounding hair, NEFWAX has no collection side at all.
        const gap = nwHeader > nwUsers ? nwHeader - nwUsers : nwUsers - nwHeader;
        say(gap < 10000n,
            `NEFWAX has no collection side, so its header matches the wallet rows (gap ${gap} minor units)`);
      }

      // -------- the census, summed as integers -----------------------------
      // parseFloat + += over 1,825 assets of 8 decimals loses the low
      // digits, and this total is printed as a fact about other people's
      // money. Verified against an independent sum of the same rows.
      const cen = await censusPool('.1e4gleif1.pb');
      let units = 0n, rows = 0, withStake = 0;
      for (let lb = '', page = 0; page < 12; page++) {
        const r = await client.v1.chain.get_table_rows({
          json: true, code: 'stake.nefty', scope: '.1e4gleif1.pb', table: 'stakers',
          limit: 1000, key_type: 'name', lower_bound: lb || undefined,
        });
        const fresh = lb ? r.rows.slice(1) : r.rows;
        for (const x of fresh) {
          rows++;
          const u = BigInt(String(x.staked).split(' ')[0].replace('.', ''));
          units += u;
          if (u > 0n) withStake++;
        }
        if (!r.more) break;
        lb = String(r.rows[r.rows.length - 1].account);
      }
      const exact = `${units / 100000000n}.${String(units % 100000000n).padStart(8, '0')}`;
      say(cen.staked === exact && cen.accounts === rows && cen.withStake === withStake,
          `the census sums exactly: ${cen.accounts} rows (${cen.withStake} with a stake), ${cen.staked} ${cen.stakedSymbol}`);
      if (cen.staked !== exact) {
        fails.push(`census says "${cen.staked}", an independent integer sum of the same rows says "${exact}"`);
      }
      // The row count is not the holder count, and the page says both.
      say(cen.accounts > cen.withStake,
          `rows and holders are reported separately: ${cen.accounts} rows, ${cen.withStake} with a stake, ${cen.withRewards} with rewards`);
    }
  }

  console.log('\n=== PHASE F - collection staking, which is a different table ===');
  {
    const raw = async (table, extra = {}) => (await client.v1.chain.get_table_rows({
      json: true, code: 'stake.nefty', scope: 'stake.nefty', table, limit: 1000, ...extra,
    }));

    // Page collstaking independently of the module. The node caps a page at
    // 1000 however large a limit is asked for, and this table is over that,
    // so a single call would silently see two thirds of it.
    const all = [];
    for (let lb = '', page = 0; page < 8; page++) {
      const r = await raw('collstaking', { key_type: 'name', lower_bound: lb || undefined });
      all.push(...(lb ? r.rows.slice(1) : r.rows));
      if (!r.more) break;
      lb = String(r.rows[r.rows.length - 1].collection_name);
    }
    say(all.length > 1000, `collstaking paged past the node's 1000-row ceiling: ${all.length} rows`);

    // Every row must name an author, or a wallet could never be matched to
    // its own collections. `author` is a binary extension in the ABI, so
    // this is not guaranteed by the schema.
    const authored = all.filter((r) => r.author);
    say(authored.length === all.length,
        `every collstaking row names an author (${authored.length}/${all.length})`);

    // And every collection refund must resolve to one, or the page would
    // hold money it can never attribute to anybody.
    const refunds = (await raw('colrefund')).rows;
    const authorOf = new Map(all.map((r) => [String(r.collection_name), String(r.author ?? '')]));
    const orphan = refunds.filter((r) => !authorOf.get(String(r.collection_name)));
    say(orphan.length === 0,
        `all ${refunds.length} collection refunds resolve to an author (${orphan.length} orphaned)`);

    // Pick a real author with the most collections and check the reader
    // against the rows we paged ourselves.
    const byAuthor = new Map();
    for (const r of all) {
      const a = String(r.author ?? '');
      if (a) byAuthor.set(a, [...(byAuthor.get(a) ?? []), r]);
    }
    // Pick an author whose collections actually hold something, or the
    // amount and tier comparisons below compare nothing to nothing and
    // pass without ever running.
    const holds = (r) => {
      const s0 = (r.stakings ?? [])[0]?.quantity ?? '0';
      const r0 = (r.refundings ?? [])[0]?.quantity ?? '0';
      return /[1-9]/.test(s0.split(' ')[0].replace('.', '')) || /[1-9]/.test(r0.split(' ')[0].replace('.', ''));
    };
    const ranked = [...byAuthor.entries()]
      .map(([a, rs]) => [a, rs, rs.filter(holds).length])
      .filter(([, , n]) => n > 0)
      .sort((x, y) => y[2] - x[2]);
    if (!ranked.length) fails.push('no author holds anything, so the collection reader was never really exercised');
    const [who, mine] = ranked[0] ?? ['zzzzzzzzzzzz', []];
    const read = await readCollectionStakes(who);
    const live = mine.filter((r) => {
      const st0 = (r.stakings ?? [])[0]?.quantity ?? '0';
      const rf0 = (r.refundings ?? [])[0]?.quantity ?? '0';
      return /[1-9]/.test(st0.split(' ')[0].replace('.', '')) || /[1-9]/.test(rf0.split(' ')[0].replace('.', ''));
    });
    say(read.length === live.length,
        `${who} authors ${mine.length} collection(s), ${live.length} with something on them, reader returned ${read.length}`);
    for (const c of read) {
      const row = mine.find((r) => String(r.collection_name) === c.collection);
      const expected = String((row?.stakings ?? [])[0]?.quantity ?? '');
      if (c.stakedRaw !== expected) {
        fails.push(`${c.collection}: displays "${c.stakedRaw}" but collstaking says "${expected}"`);
      }
      if (c.level !== String(row?.stakinglevel ?? '')) {
        fails.push(`${c.collection}: reader says tier "${c.level}", the row says "${row?.stakinglevel}"`);
      }
    }
    say(read.every((c) => c.author === who), 'every position the reader returns belongs to the wallet that asked');

    // A wallet with no collections gets nothing, rather than everybody's.
    const none = await readCollectionStakes('zzzzzzzzzzzz');
    say(none.length === 0, 'a wallet that authors no collection reads none, rather than the whole table');

    // The tier is not stale: the contract recomputes it, so no row may
    // claim a level its own balance no longer reaches. If this ever fails,
    // the page must stop presenting the tier as current.
    const tiers = (await client.v1.chain.get_table_rows({
      json: true, code: 'stake.nefty', scope: 'collections', table: 'stakinglevel', limit: 20,
    })).rows;
    const floor = new Map(tiers.map((t) => [String(t.stakingname),
      BigInt(String(t.thresholds[0].quantity).split(' ')[0].replace('.', ''))]));
    const stale = all.filter((r) => {
      const need = floor.get(String(r.stakinglevel));
      if (need === undefined) return false;
      const held = BigInt(String((r.stakings ?? [])[0]?.quantity ?? '0 X').split(' ')[0].replace('.', ''));
      return held < need;
    });
    say(stale.length === 0,
        `no collection claims a tier its balance no longer reaches (${stale.length} of ${all.length} stale)`);

    // The refund readiness has to follow the clock, not a guess.
    const readyRows = refunds.filter((r) => Number(r.unlock_time) <= Date.now() / 1000);
    const someone = refunds.length
      ? String(authorOf.get(String(refunds[0].collection_name)))
      : '';
    if (someone) {
      const rr = await readCollectionRefunds(someone);
      say(rr.every((r) => r.ready === (r.unlockTime <= Date.now() / 1000)),
          `refund readiness follows the clock (${rr.length} row(s) for ${someone})`);
      say(rr.every((r) => r.id >= 0 && r.contract && r.collection),
          'every collection refund carries the id, contract and collection claimtokcoll needs');
    }
    // Reported, not asserted. Every collection refund happens to be unlocked
    // today, which is why so much is sitting forgotten, but somebody
    // unstaking a collection this afternoon would create a locked one. That
    // is normal use, not a regression, so it must not turn this suite red.
    // The rule the page actually depends on is the per-row clock above.
    console.log(`   info ${readyRows.length}/${refunds.length} collection refunds are past their unlock time`
      + `, holding ${refunds.reduce((n, r) => n + Number(String(r.refunding.quantity).split(' ')[0]), 0).toFixed(8)} NEFTY`);
  }

  console.log('');
  if (fails.length) {
    console.log(`=== ${fails.length} FAILURE(S) ===`);
    for (const f of fails) console.log('   ' + f);
    process.exit(1);
  }
  console.log('=== ALL STAKING CHECKS PASS ===');
}
main().catch((e) => { console.error(e); process.exit(1); });
