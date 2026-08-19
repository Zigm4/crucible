/**
 * The WAX premium-name auction reader and bidder.
 *
 * PHASE A  the verdict, against names whose real state is known and
 *          stable. Includes numeric-looking names, which is where the
 *          reader was wrong first: `lower_bound: "13"` makes a node read
 *          the primary key as the INTEGER 13 rather than the encoded
 *          name, so the query silently answers about another row. Names
 *          like 13, 1111 and 55555 are exactly the ones people bid on,
 *          and the fix is `key_type: 'name'`.
 * PHASE B  the ten percent rule, checked against the real minimum
 *          observed on chain rather than against the rule as remembered.
 * PHASE C  both actions serialised against the LIVE eosio ABI.
 *
 * As everywhere here, this imports the REAL module.
 */
import { Action, APIClient } from '@wharfkit/session';
import {
  readNameStatus, readNameBid, minimumNextBid, biddableName, formatWax,
  buildBidName, buildBidRefund,
} from './.build/names.mjs';

const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); return cond; };

console.log('=== PHASE A - the verdict on names whose state is known ===');
const CASES = [
  ['13',           'won',          'numeric name, already claimed. The key_type regression hides here'],
  ['133',          'won',          'another numeric one, different bidder'],
  ['1111',         'auction',      'numeric AND open, the hardest shape to read'],
  ['aaaaaaaaaaaa', 'not_biddable', '12 characters, never auctioned'],
  ['wax.io',       'not_biddable', 'a dot makes it a subaccount'],
  ['name0',        'not_biddable', '0 is not in the WAX name alphabet'],
  ['',             'not_biddable', 'empty input must not reach the chain'],
];
for (const [name, expected, why] of CASES) {
  const st = await readNameStatus(name);
  const good = ok(st.kind === expected, `${name || '(empty)'}: got ${st.kind}, expected ${expected}`);
  console.log(`   ${good ? 'ok  ' : 'FAIL'} ${(name || '(empty)').padEnd(14)} ${st.kind.padEnd(13)} ${why}`);
}

// A name nobody has ever touched must read as free, not as an error.
const free = await readNameStatus('zzqqxxjjvv');
ok(free.kind === 'free', `zzqqxxjjvv should be free, got ${free.kind}`);
console.log(`   ${free.kind === 'free' ? 'ok  ' : 'FAIL'} zzqqxxjjvv     ${free.kind.padEnd(13)} untouched name reads as free`);

// The alphabet check must be case-forgiving, not case-strict: a user
// typing REKT means rekt, and the chain would accept the lowercase form.
const upper = biddableName('REKT');
ok(upper.ok === true && upper.name === 'rekt', 'REKT should normalise to rekt');
console.log(`   ${upper.ok ? 'ok  ' : 'FAIL'} REKT           normalised to "${upper.ok ? upper.name : '?'}"`);

console.log('\n=== PHASE B - the ten percent rule ===');
// Measured on chain: the smallest accepted increment across hundreds of
// consecutive bids is exactly 1.1000x, so the suggestion must clear it.
const bid = await readNameBid('rekt');
if (!bid) {
  console.log('   skipped: rekt has no auction row right now');
} else {
  const min = minimumNextBid(bid);
  const ratio = (min * 1e8) / bid.high_bid;
  const good = ok(ratio > 1.1, `minimum ${min} is only ${ratio}x the standing bid, must exceed 1.1x`);
  console.log(`   ${good ? 'ok  ' : 'FAIL'} standing ${bid.high_bid / 1e8} WAX -> suggests ${min} WAX (${ratio.toFixed(6)}x)`);
}
const first = minimumNextBid(undefined);
ok(first > 0, 'a name with no bid must still suggest something above zero');
console.log(`   ${first > 0 ? 'ok  ' : 'FAIL'} no standing bid -> suggests ${first} WAX`);
// A closed auction is not something to outbid.
const closed = await readNameBid('13');
ok(closed?.closed === true, '13 must decode as a closed auction');
console.log(`   ${closed?.closed ? 'ok  ' : 'FAIL'} 13 decodes as closed, winning bid ${closed ? closed.high_bid / 1e8 : '?'} WAX`);

console.log('\n=== PHASE C - both actions against the live eosio ABI ===');
const client = new APIClient({ url: 'https://wax.greymass.com' });
const abi = (await client.v1.chain.get_abi('eosio')).abi;
for (const [label, action] of [
  ['bidname',   buildBidName('zigm4.gm', 'rekt', 220.00000001)],
  ['bidrefund', buildBidRefund('zigm4.gm', 'rekt')],
]) {
  try {
    Action.from({ account: action.account, name: action.name, authorization: action.authorization, data: action.data }, abi);
    console.log(`   ok   eosio::${label}  ${JSON.stringify(action.data)}`);
  } catch (e) {
    fails.push(`${label}: ${e.message}`);
    console.log(`   FAIL eosio::${label}  ${e.message}`);
  }
}
// WAX carries 8 decimals and the contract rejects any other precision.
ok(formatWax(1) === '1.00000000 WAX', `formatWax(1) gave ${formatWax(1)}`);
console.log(`   ok   formatWax(1) = ${formatWax(1)}`);

console.log('');
if (fails.length) {
  console.log(`=== ${fails.length} FAILURE(S) ===`);
  for (const f of fails) console.log('   ' + f);
  process.exit(1);
}
console.log('=== ALL NAME-AUCTION CHECKS PASS ===');
