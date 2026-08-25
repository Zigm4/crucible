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

  console.log('\n=== PHASE D - a claim built from a POSITION, not from history ===');
  {
    // What the page will really do: read a position, then build from it.
    // Anything the reader gets wrong about the symbol shows up here and
    // nowhere else.
    const claims = (await history('stake.nefty:claim')).filter((x) => x.act.name === 'claim');
    const symbolFor = new Map();     // pool symbol code -> a real signed claim
    for (const x of claims) symbolFor.set(String(x.act.data.token_symbol), x);

    let done = 0;
    const unproven = new Set();
    for (const actor of [...new Set(claims.map((x) => String((x.act.authorization ?? [])[0]?.actor)))].slice(0, 8)) {
      const positions = await readStakePositions(actor);
      for (const p of positions) {
        const real = symbolFor.get(p.stakedSymbolCode);
        if (!real) {
          // Not automatically a defect. stake.nefty carries a third pool,
          // WAXNEFT, with 1,825 accounts and 115,507 NEFTY of rewards on
          // the books but NO row in stakerewards and no claim or unstake
          // ever recorded against it. The balances are real; whether the
          // contract will pay them is not established, and the page has to
          // say so rather than offer it as routine.
          unproven.add(p.stakedSymbolCode);
          continue;
        }
        // Same actor, so the bytes must match a claim the chain accepted.
        const mine = bytes(buildClaimRewards(String((real.act.authorization ?? [])[0]?.actor), p.stakedSymbolCode));
        const theirs = bytes(real.act);
        if (mine !== theirs) {
          fails.push(`a claim built from a read position does not match the signed one for ${p.stakedSymbolCode}`);
        } else done++;
      }
      if (done >= 3) break;
    }
    say(done >= 1, `${done} claim(s) built from a live position match a real signed claim`);
    // Pools nobody has ever claimed from are reported, never hidden and
    // never asserted as working.
    for (const sym of unproven) {
      console.log(`   note: pool ${sym} has balances but no claim has ever been signed against it`);
    }
    const configured = (await client.v1.chain.get_table_rows({
      json: true, code: 'stake.nefty', scope: 'stake.nefty', table: 'stakerewards', limit: 10,
    })).rows.map((r) => String(r.total_staked).split(' ')[1]);
    say(configured.length >= 2, `${configured.length} reward pool(s) configured on chain: ${configured.join(', ')}`);
    for (const sym of unproven) {
      const bare = sym.split(',')[1];
      if (configured.includes(bare)) {
        fails.push(`${bare} has a configured reward pool yet no claim has ever been built for it, which our reader should have matched`);
      }
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
