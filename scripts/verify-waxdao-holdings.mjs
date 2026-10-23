/**
 * WaxDAO holdings: does every button the staking page offers go through?
 *
 * src/waxdao/holdings.ts reads, for one wallet, what WaxDAO's contracts still
 * hold (farms, pools, token farms, DAOs, locks, backed tokens, the market)
 * and builds the transaction for each button. Here the REAL module reads a
 * few accounts known to hold one of each kind, and every transaction it
 * builds runs through compute_transaction (executed by a node, never
 * signed, never written). A button the chain would refuse is a failure; an
 * account short of its own CPU or NET is not, since a paying wallet covers
 * that.
 *
 * Live data: an account that has since taken everything out is reported.
 *
 * Run: npm run verify:waxdao-holdings
 */
const fails = [];
const say = (pass, msg) => { console.log(`   ${pass ? 'ok  ' : 'FAIL'} ${msg}`); if (!pass) fails.push(msg); };
let holdings, sim;
try {
  holdings = await import('./.build/waxdaoHoldings.mjs');
  sim = await import('./.build/simulate.mjs');
} catch {
  console.error('Missing scripts/.build - run `npm run verify:waxdao-holdings`.');
  process.exit(1);
}
// One account per kind, found by a full read of every WaxDAO table on 2026-10-23.
const ACCOUNTS = [
  ['afjaw.wam', 'NFT farms v1'],
  ['3fxdy.wam', 'token pools v1'],
  ['3rvfa.wam', 'NFT farms v2 rewards'],
  ['1d5bm.wam', 'token farms'],
  ['k2nao.wam', 'DAO staking'],
  ['ig.be.wam', 'backed tokens'],
  ['tkmre.wam', 'backed tokens needing open'],
  ['esabg.wam', 'market RAM'],
  ['mc5wo.wam', 'premint pool'],
];
for (const [actor, kind] of ACCOUNTS) {
  console.log(`\n=== ${actor} · ${kind} ===`);
  const items = await holdings.readWaxdaoHoldings(actor);
  if (!items.length) { console.log('   skip  holds nothing on WaxDAO any more'); continue; }
  console.log(`   ${items.length} holding(s): ${[...new Set(items.map((h) => h.group))].join(', ')}`);
  // Each kind's buttons, up to three of them, so a big wallet stays quick.
  const byGroup = new Map();
  for (const h of items) for (const a of h.actions) { const l = byGroup.get(h.group) ?? []; if (l.length < 6) l.push([h, a]); byGroup.set(h.group, l); }
  for (const [, list] of byGroup) for (const [h, a] of list) {
    const r = await sim.simulateActions(a.build);
    say(r.kind !== 'refused', `${h.title} · ${a.label}: ${r.kind}${r.reason ? ` (${r.reason})` : ''}`);
  }
  for (const h of items.filter((x) => x.broken)) console.log(`   note  ${h.title}: ${h.note}`);
  if (items.some((h) => h.group === 'nft-farm' && h.detail) && !items.some((h) => h.broken)) {
    const r = await sim.simulateActions(holdings.claimAllFarms(actor, items.filter((h) => h.group === 'nft-farm')));
    say(r.kind !== 'refused', `claim every farm's rewards in one action: ${r.kind}${r.reason ? ` (${r.reason})` : ''}`);
  }
  const farms = items.filter((h) => h.group === 'nft-farm' && h.actions.some((a) => a.label.startsWith('Unstake')));
  if (farms.length > 1) {
    const r = await sim.simulateActions(holdings.unstakeManyFarms(actor, farms));
    say(r.kind !== 'refused', `unstake from ${Math.min(farms.length, holdings.FARMS_PER_TRANSACTION)} farms in one transaction: ${r.kind}${r.reason ? ` (${r.reason})` : ''}`);
  }
}
console.log('');
if (fails.length) {
  console.log(`=== ${fails.length} FAILURE(S) ===`);
  for (const f of fails) console.log(`   ${f}`);
  process.exit(1);
}
console.log('=== ALL WAXDAO HOLDINGS CHECKS PASS ===');
