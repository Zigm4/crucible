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
  readNameStatus, readNameBid, readTopBids, minimumNextBid, biddableName, formatWax,
  buildBidName, buildBidRefund, canOutbid, readRefundsFor,
  buildClaimName, readAccountKeys,
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

console.log('\n=== PHASE B2 - the leaderboard reads the signed index right ===');
// The secondary index is -high_bid as an unsigned 64-bit integer, so
// CLOSED auctions (negative bid) land at the bottom of the range and open
// ones at the top, biggest bid first. Reading it naively returns settled
// auctions nobody can bid on, which is the failure this guards.
const top = await readTopBids(10);
ok(top.length > 0, 'the leaderboard came back empty');
ok(top.every((b) => !b.closed), 'a settled auction leaked into the leaderboard');
ok(top.every((b) => b.high_bid > 0), 'a non-positive bid leaked into the leaderboard');
const sorted = top.every((b, i) => i === 0 || top[i - 1].high_bid >= b.high_bid);
ok(sorted, 'the leaderboard is not sorted highest first');
console.log(`   ${top.length ? 'ok  ' : 'FAIL'} ${top.length} open auction(s), none settled, sorted highest first`);
for (const b of top.slice(0, 3)) {
  console.log(`        ${b.newname.padEnd(14)} ${(b.high_bid / 1e8).toFixed(2).padStart(10)} WAX  ${b.high_bidder}`);
}

console.log('\n=== PHASE B3 - you cannot outbid yourself ===');
// The system contract refuses a bid from whoever already holds the top
// one. Offering the button anyway is offering a transaction that fails.
// Corroborated on chain: of 496 consecutive bid pairs, zero repeat the
// same bidder.
if (bid) {
  ok(canOutbid(bid, bid.high_bidder) === false, 'the standing bidder must not be offered a raise');
  ok(canOutbid(bid, 'someoneelse11') === true, 'anyone else must be able to outbid');
  console.log(`   ok   ${bid.high_bidder} cannot raise their own bid, others can`);
}
ok(canOutbid(undefined, 'anyone') === true, 'a name with no bid must be biddable');
console.log('   ok   a name nobody has bid on is biddable by anyone');

console.log('\n=== PHASE B4 - refunds are scoped by NAME, not by bidder ===');
// The scope is the name being bid on and the primary key is the bidder,
// the reverse of the obvious reading. Scoping by the bidder returns an
// empty list for everyone forever, so the panel could never show a row.
const owed = await readRefundsFor('croplandgame', ['rekt']);
ok(owed.length === 1, `croplandgame should be owed on rekt, got ${owed.length} row(s)`);
ok(owed[0]?.wax > 0, 'the refund amount must parse to a number');
console.log(`   ${owed.length === 1 ? 'ok  ' : 'FAIL'} croplandgame is owed ${owed[0]?.amount ?? '?'} on rekt`);
const notOwed = await readRefundsFor('zzznobodyzzz', ['rekt']);
ok(notOwed.length === 0, 'an account with no refund must get an empty list');
console.log(`   ${notOwed.length === 0 ? 'ok  ' : 'FAIL'} an unrelated account is owed nothing`);

console.log('\n=== PHASE B5 - a won name is not a created account ===');
// Closing the auction only flips the sign. The account appears when the
// winner calls newaccount, which is what erases the row. Names sit won
// and unclaimed for years, so "won" must not read as "taken".
const won = await readNameStatus('13', '.nzni.c.wam');
ok(won.kind === 'won', `13 should read as won, got ${won.kind}`);
ok(won.kind === 'won' && won.mine === true, 'the winner must be told the name is theirs to claim');
const wonByOther = await readNameStatus('13', 'someoneelse11');
ok(wonByOther.kind === 'won' && wonByOther.mine === false, 'a bystander must not be offered the claim');
console.log(`   ${won.kind === 'won' ? 'ok  ' : 'FAIL'} 13 reads as won by its bidder, and as not-mine to anyone else`);

console.log('\n=== PHASE C - every action against the live eosio ABI ===');
const client = new APIClient({ url: 'https://wax.greymass.com' });
const abi = (await client.v1.chain.get_abi('eosio')).abi;
const claimKeys = await readAccountKeys('croplandgame');
ok(Boolean(claimKeys.owner && claimKeys.active),
  'account keys must be readable, WharfKit returns typed objects rather than strings');
const claim = buildClaimName({
  creator: 'croplandgame', newname: '13',
  ownerKey: claimKeys.owner, activeKey: claimKeys.active,
});
for (const [label, action] of [
  ['bidname',   buildBidName('zigm4.gm', 'rekt', 220.00000001)],
  ['bidrefund', buildBidRefund('zigm4.gm', 'rekt')],
  ['newaccount',  claim[0]],
  ['buyrambytes', claim[1]],
  ['delegatebw',  claim[2]],
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
