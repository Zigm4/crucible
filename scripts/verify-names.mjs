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
import { Action, APIClient, PublicKey } from '@wharfkit/session';
import {
  readNameStatus, readNameBid, readTopBids, minimumNextBid, biddableName, formatWax,
  buildBidName, buildBidRefund, canOutbid, readRefundsFor,
  buildClaimName, readAccountAuthorities,
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
// Not a fixed name. rekt was hardcoded here and then WON, which closed it,
// and the phase started failing over behaviour that was correct all along.
// The top open auction is always a live one, whatever it happens to be.
const [bid] = await readTopBids(1);
if (!bid) {
  // Not a skip. The chain carries thousands of open auctions, so reading
  // none means the read is broken, and quietly dropping three assertions
  // is how a suite comes to prove nothing while still printing PASS.
  ok(false, 'readTopBids returned no open auction, which cannot be true of this chain');
} else {
  console.log(`   using ${bid.newname}, the highest open auction (${bid.high_bid / 1e8} WAX)`);
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
const claimAuth = await readAccountAuthorities('croplandgame');
ok(Boolean(claimAuth.owner && claimAuth.active),
  'account permissions must be readable, WharfKit returns typed objects rather than strings');
const claim = buildClaimName({
  creator: 'croplandgame', newname: '13',
  owner: claimAuth.owner, active: claimAuth.active,
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

// A permission can carry several keys, and creating the account with one
// of them can leave the winner's own wallet unable to sign for the name
// it just paid for. zigm4.gm is the live case: two active keys, and the
// wallet holds the SECOND, which is the one keys[0] would have dropped.
/** Prints the outcome, and records a failure when there is one. */
function say(pass, msg) {
  console.log(`   ${pass ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!pass) fails.push(msg);
}

console.log('\n=== PHASE D - a claim must carry the whole permission ===');
const multi = await readAccountAuthorities('zigm4.gm');
ok(multi.active.keys.length > 1,
   `zigm4.gm must still carry more than one active key for this to test anything (has ${multi.active?.keys.length})`);
say(multi.active.keys.length > 1, `zigm4.gm carries ${multi.active.keys.length} active keys, threshold ${multi.active.threshold}`);
const mirrored = buildClaimName({
  creator: 'zigm4.gm', newname: 'rekt', owner: multi.owner, active: multi.active,
}).find((a) => a.name === 'newaccount');
ok(mirrored.data.active.keys.length === multi.active.keys.length,
   `every active key must reach newaccount: ${mirrored.data.active.keys.length} of ${multi.active.keys.length}`);
ok(mirrored.data.active.threshold === multi.active.threshold,
   'the threshold must travel with the keys, or the copy is weaker than the original');
say(mirrored.data.active.keys.length === multi.active.keys.length,
    `all ${mirrored.data.active.keys.length} reach newaccount, threshold ${mirrored.data.active.threshold} intact`);
const wanted = String(PublicKey.from('PUB_K1_6rGewGtiqCWQTU6ttSxR8Av6fVGeHZ58JC9KxCW6QmrUxznY1a'));
ok(mirrored.data.active.keys.some((k) => String(PublicKey.from(k.key)) === wanted),
   'the key the wallet actually signs with must be among them, whatever its position in the list');
const clipped = buildClaimName({
  creator: 'zigm4.gm', newname: 'rekt', owner: multi.owner,
  active: { threshold: 1, keys: [multi.active.keys[0]], accounts: [], waits: [] },
}).find((a) => a.name === 'newaccount');
ok(!clipped.data.active.keys.some((k) => String(PublicKey.from(k.key)) === wanted),
   'and taking only the first key must demonstrably lose it, or this phase proves nothing');
say(true, 'the key the wallet signs with survives the mirror, and is lost by keys[0] alone');

// zigm4.gm has threshold 1, weight-1 keys, no delegates and no waits, so
// every assertion above about those is a tautology on it: mutation testing
// showed `threshold: 1`, `accounts: []`, `waits: []` and `weight: 1` all
// survive with the suite still passing. A permission the chain does not
// happen to hand us has to be built to test the rest.
const SHAPED = {
  threshold: 3,
  keys: [
    // Deliberately descending, because the chain refuses an authority whose
    // keys are not in ascending order and nothing downstream sorts a plain
    // object. This is the case a real user reaches by typing an extra key.
    { key: 'PUB_K1_6rGewGtiqCWQTU6ttSxR8Av6fVGeHZ58JC9KxCW6QmrUxznY1a', weight: 2 },
    { key: 'PUB_K1_5c9qrJ3wutD8Hz6LtjioS7frgcXTsy41qcfLVQ6QvMkuRkkA6o', weight: 1 },
  ],
  accounts: [{ actor: 'zigm4.gm', permission: 'active', weight: 1 }],
  waits: [{ wait_sec: 604800, weight: 1 }],
};
const shaped = buildClaimName({
  creator: 'zigm4.gm', newname: 'rekt', owner: SHAPED, active: SHAPED,
}).find((a) => a.name === 'newaccount').data.active;

say(shaped.threshold === 3, `threshold survives: ${shaped.threshold}`);
say(shaped.keys.map((k) => k.weight).join(',') === '1,2',
    `per-key weights survive and follow their own key: ${shaped.keys.map((k) => k.weight).join(',')}`);
say(shaped.accounts.length === 1 && shaped.accounts[0].permission.actor === 'zigm4.gm',
    `delegates survive: ${JSON.stringify(shaped.accounts)}`);
say(shaped.waits.length === 1 && shaped.waits[0].wait_sec === 604800,
    `waits survive: ${JSON.stringify(shaped.waits)}`);
// The ordering rule the chain enforces, and the reason a hand-typed key
// cannot simply be appended.
const order = shaped.keys.map((k) => k.key);
say(order[0].includes('5c9qr'),
    `keys are sorted ascending before they are sent, not left as given (${order[0].slice(0, 18)} first)`);
// And the whole thing must still be something eosio accepts.
try {
  Action.from({
    account: 'eosio', name: 'newaccount',
    authorization: [{ actor: 'zigm4.gm', permission: 'active' }],
    data: { creator: 'zigm4.gm', name: 'rekt', owner: shaped, active: shaped },
  }, abi);
  say(true, 'a threshold-3 authority with a delegate and a wait still encodes against the live ABI');
} catch (e) {
  say(false, `the shaped authority does not encode: ${e.message}`);
}

console.log('');
if (fails.length) {
  console.log(`=== ${fails.length} FAILURE(S) ===`);
  for (const f of fails) console.log('   ' + f);
  process.exit(1);
}
console.log('=== ALL NAME-AUCTION CHECKS PASS ===');
