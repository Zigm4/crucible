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
        readStakePositions, readStakeRefunds, readStakeScopes, readRefundDelay } = st;

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
              isUnprovenPool, tokenContractFor, buildUnstakeFor } = view;

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
    }
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
