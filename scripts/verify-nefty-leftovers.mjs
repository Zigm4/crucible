/**
 * What NeftyBlocks' contracts hold for an account: does the Staking page
 * offer only what the chain will do, and say why for the rest?
 *
 * src/nefty/leftovers.ts reads, for one account, the tokens deposited and
 * never used on neftyblocksd, blend.nefty and up.nefty, the packs opened
 * and never minted (through ui/runFinish), draws the oracle never answered
 * and NFTs blend.nefty kept. Here it runs on real accounts, taken from a
 * scan of every one of those tables on 2026-10-24, and every button it
 * offers goes through compute_transaction as that account (executed by a
 * node, never signed, never written):
 *
 *   - every Withdraw and every Finish is accepted
 *   - a pack partly minted asks only for its open cards (the chain refuses
 *     an index already claimed)
 *   - a pack refused for want of RAM, for token backing or for a missing
 *     authorization offers no button and says which
 *   - draws and kept NFTs are shown with nothing to sign, and each draw
 *     says how NeftyBlocks would relaunch it: that relaunch is asked of the
 *     chain under the contract's own permission (no signature is checked
 *     by compute_transaction), so the card's "accepted" or "refused" stays
 *     true
 *
 * The chain moves on: an account that has since taken its things back is
 * reported as skipped, not failed.
 *
 * Run: npm run verify:nefty-leftovers
 */
const fails = [];
let skipped = 0;
const say = (pass, msg) => { console.log(`   ${pass ? 'ok  ' : 'FAIL'} ${msg}`); if (!pass) fails.push(msg); };
const skip = (msg) => { console.log(`   skip ${msg}`); skipped++; };
let lf, sim, pack, stake;
try {
  lf = await import('./.build/leftovers.mjs');
  stake = await import('./.build/stake.mjs');
  sim = await import('./.build/simulate.mjs');
  pack = await import('./.build/neftyPackExecute.mjs');
} catch {
  console.error('Missing scripts/.build - run `npm run verify:nefty-leftovers`.');
  process.exit(1);
}

/** Every button an account is offered, asked of the chain. */
async function offered(account, items) {
  for (const h of items.filter((x) => x.action)) {
    const r = await sim.simulateActions(h.action.build);
    // The simulating node may lack CPU for the account; that is not a refusal.
    say(r.kind === 'accepted' || r.kind === 'resources',
      `${account}: ${h.action.label} "${h.title}": chain ${r.kind}${r.reason ? ` (${r.reason})` : ''}`);
  }
}

console.log('=== the notes say what the chain says ===');
{
  const N = lf.LEFTOVER_NOTES;
  say(/retryrand/.test(N['draw-blend'].body) && /claimer/.test(N['draw-blend'].body) && /ac\.nefty and ja\.nefty/.test(N['draw-blend'].body) && /accepted/.test(N['draw-blend'].body),
    'recent blend draws: retryrand, the claimer permission, who holds it, and that it is accepted');
  say(/No job entry with the specified claim id exists/.test(N['draw-old'].body), 'older blend draws: the refusal NeftyBlocks itself gets');
  say(/admins\.nefty/.test(N['draw-pack'].body) && /active permission/.test(N['draw-pack'].body), 'pack draws: the active permission and who holds it');
  say(['draw-blend', 'draw-pack'].every((k) => /comes back online/.test(N[k].body)), 'both relaunchable kinds leave NeftyBlocks the way back');
}

console.log('\n=== the claim builder ===');
{
  const all = pack.buildNeftyUnboxClaim({ claimer: 'a', claim_id: 1, roll_count: 3 })[0].data.roll_indexes;
  const open = pack.buildNeftyUnboxClaim({ claimer: 'a', claim_id: 1, roll_count: 2, roll_indexes: [1, 2] })[0].data.roll_indexes;
  say(JSON.stringify(all) === '[0,1,2]' && JSON.stringify(open) === '[1,2]', `indexes: every roll ${JSON.stringify(all)}, only the open ones ${JSON.stringify(open)}`);
}

const CASES = [
  { account: 'b4nwa.wam', want: 'deposit', on: 'up.nefty', what: 'AGAR left on up.nefty' },
  { account: '5i2qw.wam', want: 'deposit', on: 'blend.nefty', what: 'RUST left on blend.nefty' },
  { account: '.3xqu.wam', want: 'deposit', on: 'neftyblocksd', what: 'NEFTY left on neftyblocksd' },
  { account: '4q4ly.c.wam', want: 'deposit', on: 'neftyblocksd', what: 'BRWL left on neftyblocksd' },
  { account: 'pl5b4.wam', want: 'finish', ready: true, what: 'yoshidrops packs ready to mint' },
  { account: 'orsr.wam', want: 'finish', ready: true, partial: true, what: 'a crittercraft pack whose first card went out' },
  { account: 'cfmr.wam', want: 'finish', blocked: 'pack-ram', what: 'a mysteryfarmx pack its collection has no RAM for' },
  { account: 'yvabm.wam', want: 'finish', blocked: 'pack-backing', what: 'terraformers packs of token-backed NFTs' },
  { account: 'czqwa.wam', want: 'finish', blocked: 'pack-authorization', what: 'a funmanbobyjo pack, contract no longer authorized' },
  { account: 'luckyljlucky', want: 'draw', what: 'agar blends the oracle never drew', on: 'blend.nefty',
    drawNote: 'draw-blend', retry: { perm: 'blend.nefty@claimer', accepted: true } },
  { account: 'yu2ho.wam', want: 'draw', what: 'noacollector blends in the older job table', on: 'blend.nefty',
    drawNote: 'draw-old', retry: { perm: 'blend.nefty@claimer', accepted: false } },
  { account: 'zvnr4.wam', want: 'draw', what: 'a yoshidrops pack the oracle never drew', on: 'neftyblocksp',
    drawNote: 'draw-pack', retry: { perm: 'neftyblocksp@active', accepted: true } },
  { account: 'right.meow', want: 'held', what: 'NFTs blend.nefty kept' },
];

for (const c of CASES) {
  console.log(`\n=== ${c.account}: ${c.what} ===`);
  let items;
  try { items = await lf.readNeftyLeftovers(c.account); }
  catch (e) { say(false, `${c.account}: unreadable (${e.message})`); continue; }
  const mine = items.filter((h) => h.group === c.want && (!c.on || h.contract === c.on));
  if (!mine.length) { skip(`${c.account} no longer has ${c.what}`); continue; }
  for (const h of mine) console.log(`        ${h.title}${h.detail ? ` · ${h.detail}` : ''}${h.notes?.length ? ` · notes: ${h.notes.join(', ')}` : ''}`);
  if (c.want === 'deposit' || c.ready) {
    say(mine.every((h) => h.action), `every one is offered (${mine.length})`);
  }
  if (c.partial) {
    const idx = mine.map((h) => h.action?.build[0]?.data?.roll_indexes).filter(Boolean);
    say(idx.length > 0 && idx.every((x) => !x.includes(0)), `only the open cards are asked for: ${JSON.stringify(idx)}`);
  }
  if (c.blocked) {
    say(mine.every((h) => !h.action && h.notes?.includes(c.blocked)), `none is offered, and each points to "${lf.LEFTOVER_NOTES[c.blocked].title}"`);
  }
  if (c.want === 'draw' || c.want === 'held') {
    say(mine.every((h) => !h.action && h.notes?.length), 'shown with nothing to sign, each pointing to a note');
  }
  if (c.drawNote) say(mine.every((h) => h.notes?.includes(c.drawNote)), `each points to "${lf.LEFTOVER_NOTES[c.drawNote].title}"`);
  if (c.retry) {
    const [actor, permission] = c.retry.perm.split('@');
    const id = mine[0].key.split(':').pop();
    const r = await sim.simulateActions([{ account: c.on, name: 'retryrand', authorization: [{ actor, permission }], data: { claim_id: id } }]);
    // Out of the simulator's CPU is not a refusal: the contract got that far.
    const took = r.kind === 'accepted' || r.kind === 'resources';
    say(took === c.retry.accepted, `retryrand #${id} under ${c.retry.perm}: chain ${r.kind}${r.reason ? ` (${r.reason})` : ''}`);
  }
  await offered(c.account, items);
  const all = stake.finishShortcut(c.account, items, new Set());
  if (all) {
    const r = await sim.simulateActions(all.build);
    say(r.kind === 'accepted' || r.kind === 'resources',
      `${c.account}: Finish all, ${all.count} of ${all.total} in one transaction: chain ${r.kind}${r.reason ? ` (${r.reason})` : ''}`);
  }
}

console.log(fails.length ? `\n=== ${fails.length} FAILED ===` : `\n=== ALL NEFTY LEFTOVER CHECKS PASS${skipped ? ` (${skipped} skipped)` : ''} ===`);
process.exit(fails.length ? 1 : 0);
