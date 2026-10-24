/**
 * The staking page must not ask for the same signature twice.
 *
 * On 2026-10-24 ineek.wam emptied its WaxDAO farms through the staking page.
 * The page builds "Unstake all" as the next eight farms, most NFTs first,
 * and after the first signature it read the chain again at once. That read
 * still showed the eight farms (the node asked had not applied the
 * transaction yet), so the next press signed the same eight again:
 *
 *   ccb4369bcc  open LOOT + unstakeall x8   thequackfarm .. chibixloot
 *   d6f44905e4             unstakeall x8   the same eight, which did nothing
 *   362deaceb0             unstakeall x5   g123thepark1 .. goldencat123
 *
 * and claimall twice the same way. Here the REAL page code (src/v2/stake.ts,
 * src/v2/signedRecently.ts) is given the wallet's 13 farms as the export of
 * 2026-10-23 read them, and must:
 *   - build the first transaction it really signed, action for action
 *   - with the read NOT caught up, build the other five next, not the eight
 *   - not offer claimall again once it was signed
 *   - clear its marks once a read no longer shows the farms, keep them
 *     while it does, and drop them after their time either way
 *
 * Run: npm run verify:signed-recently
 */
const fails = [];
const say = (pass, msg) => { console.log(`   ${pass ? 'ok  ' : 'FAIL'} ${msg}`); if (!pass) fails.push(msg); };
let page, recentMod;
try {
  page = await import('./.build/stake.mjs');
  recentMod = await import('./.build/signedRecently.mjs');
} catch (e) {
  console.error('Missing scripts/.build - run `npm run verify:signed-recently`.', e.message);
  process.exit(1);
}
const { farmShortcuts, wdMark, wdStillThere } = page;
const { SignedRecently } = recentMod;

const W = 'ineek.wam';
const open = (account, symbol) => ({ account, name: 'open', authorization: [{ actor: W, permission: 'active' }], data: { owner: W, symbol, ram_payer: W } });
// ineek.wam's v1 farms on 2026-10-23, from the export: NFTs held, and rewards waiting.
const FARMS = [
  ['g123nftgroup', 1, '8868.71881183 XYTE'], ['g123theteam1', 38, '2691360.000000 ECR'], ['niftyseeds', 20, '276.8250 DUST'],
  ['g123thepark1', 2, '52260.000000 ECR'], ['chibixloot', 5, '3189.3200 LOOT'], ['waxapes', 0, '10.24616766 WAX'],
  ['antlers.2', 0, '0.0016 ANTLERS'], ['sketch.art', 24, '9.89596008 SKART'], ['sktchartleef', 1, '107975.0000 LEEF'],
  ['skartsqjdust', 9, '1052.6140 DUST'], ['hyperhuskyht', 0, '7368.11109463 HOWL'], ['thequackfarm', 52, '68.35200000 QUACK'],
  ['wuf.sketch', 17, '127592.0000 WUF'], ['g123thecave2', 1, '18.8123 DUST'], ['nethrim.wax', 31, '1.07996374 WAX'],
  ['goldencat123', 1, '7.11870508 WAX'],
];
// It held no LOOT and no HOWL yet: the page opens those balances first.
const OPENS = { chibixloot: [open('warsaken', '4,LOOT')], hyperhuskyht: [open('husky.gm', '8,HOWL')] };
const holding = ([farm, nfts, reward]) => ({
  key: `farm:${farm}`, group: 'nft-farm', contract: 'waxdaofarmer',
  title: nfts ? `${nfts} NFT${nfts === 1 ? '' : 's'} staked in ${farm}` : `Rewards in ${farm}`,
  detail: `${reward} to claim`,
  actions: [{ label: `Claim ${reward}`, build: [] }, ...(nfts ? [{ label: `Unstake ${nfts} NFT${nfts === 1 ? '' : 's'}`, build: [] }] : [])],
  opens: OPENS[farm] ?? [],
});
const items = FARMS.map(holding);
const shape = (acts) => acts.map((a) => (a.name === 'open' ? `open ${a.data.symbol}` : a.data.farmname ?? a.name));

// What it really signed, read from the chain.
const SIGNED_FIRST = ['open 4,LOOT', 'thequackfarm', 'g123theteam1', 'nethrim.wax', 'sketch.art', 'niftyseeds', 'wuf.sketch', 'skartsqjdust', 'chibixloot'];
const SIGNED_THIRD = ['g123thepark1', 'g123nftgroup', 'sktchartleef', 'g123thecave2', 'goldencat123'];

console.log('=== "Unstake all", as ineek.wam pressed it ===');
let clock = Date.parse('2026-10-23T23:53:25Z');
const recent = new SignedRecently(180_000, () => clock);
const first = farmShortcuts(W, items, recent);
say(JSON.stringify(shape(first.unstake.build)) === JSON.stringify(SIGNED_FIRST),
  `the first press builds the transaction it signed: ${shape(first.unstake.build).join(', ')}`);
recent.add(first.unstake.marks, 'ccb4369bcc');

// Thirty seconds later, and the read has not caught up: same 13 farms.
clock += 30_000;
const second = farmShortcuts(W, items, recent);
say(JSON.stringify(shape(second.unstake?.build ?? [])) === JSON.stringify(SIGNED_THIRD),
  `with the read not caught up, the second press goes on to the other five: ${shape(second.unstake?.build ?? []).join(', ')}`);
say(second.unstakable.length === 5, `the shortcut now counts ${second.unstakable.length} farms, not 13`);
recent.add(second.unstake.marks, '362deaceb0');
const third = farmShortcuts(W, items, recent);
say(!third.unstake, 'once all thirteen are signed, "Unstake all" is not offered again');

console.log('\n=== claimall ===');
const fresh = new SignedRecently(180_000, () => clock);
const c1 = farmShortcuts(W, items, fresh);
say(c1.claim?.build.at(-1)?.name === 'claimall' && c1.claim.build.filter((a) => a.name === 'open').length === 2,
  `claimall is offered with both opens: ${shape(c1.claim?.build ?? []).join(', ')}`);
fresh.add(c1.claim.marks, '9fa91e1099');
say(!farmShortcuts(W, items, fresh).claim, 'once signed, claimall is not offered again while the read still shows rewards');

console.log('\n=== the marks settle ===');
const marks = first.unstake.marks;
const stale = wdStillThere(items);
recent.settle(`${W}|wd:`, stale);
say(marks.every((m) => recent.has(m)), 'a read that still shows the eight farms keeps their marks');
const after = items.filter((h) => !SIGNED_FIRST.includes(h.key.slice(5)));
recent.settle(`${W}|wd:`, wdStillThere(after));
say(marks.every((m) => !recent.has(m)), 'a read without them clears their marks');
say(second.unstake.marks.every((m) => recent.has(m)), 'and leaves the marks of the five it still shows');
clock += 181_000;
say(second.unstake.marks.every((m) => !recent.has(m)), 'after three minutes a mark is dropped, whatever the reads show');
say(wdMark(W, items[0], 'second') === `${W}|wd:farm:g123nftgroup:second`, 'marks are per account, so another wallet\'s page is untouched');

console.log(fails.length ? `\n=== ${fails.length} SIGNED-RECENTLY CHECK(S) FAILED ===` : '\n=== ALL SIGNED-RECENTLY CHECKS PASS ===');
for (const f of fails) console.log(`  - ${f}`);
process.exit(fails.length ? 1 : 0);
