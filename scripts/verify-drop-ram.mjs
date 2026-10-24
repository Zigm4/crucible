/**
 * The RAM a drop mints from: does Crucible say what the chain will refuse?
 *
 * neftyblocksd pays for every NFT a claim mints out of the collection's own
 * RAM balance (src/nefty/dropRam.ts). The creator shows that balance and
 * offers a deposit; Use a recipe blocks a drop whose collection has none.
 * Every chain case here goes through compute_transaction (executed by a
 * node, never signed, never written), so the sentences are held to the
 * chain's own answer:
 *
 *   - a claim with too little RAM is refused, and Crucible blocks it
 *   - a first deposit under 128 bytes is refused, and the creator says so
 *   - a deposit and a claim in one transaction go through
 *
 * pearlhorizon's drop #239019 is list-only, with zigm4.gm on its list. Its
 * collection had no RAM row on 2026-10-24; once it has one, the cases that
 * need an empty balance say they were skipped instead of failing.
 *
 * Run: npm run verify:drop-ram
 */
const fails = [];
const say = (pass, msg) => { console.log(`   ${pass ? 'ok  ' : 'FAIL'} ${msg}`); if (!pass) fails.push(msg); };
let ram, sim, checks;
try {
  ram = await import('./.build/dropRam.mjs');
  sim = await import('./.build/simulate.mjs');
  checks = await import('./.build/runChecks.mjs');
} catch {
  console.error('Missing scripts/.build - run `npm run verify:drop-ram`.');
  process.exit(1);
}

const COLLECTION = 'pearlhorizon', DROP = 239019, CLAIMER = 'zigm4.gm', TEMPLATE = 906693;
const claim = {
  account: 'neftyblocksd', name: 'claimdropwl',
  authorization: [{ actor: CLAIMER, permission: 'active' }],
  data: {
    claimer: CLAIMER, drop_id: DROP, amount: 1, intended_delphi_median: '0',
    referrer: 'Crucible', country: '', currency: '8,WAX', referrer_account: '',
  },
};

console.log('=== the helpers ===');
{
  say(ram.waxAmount('1') === '1.00000000 WAX', `"1" is ${ram.waxAmount('1')}`);
  say(ram.waxAmount('0.5') === '0.50000000 WAX', `"0.5" is ${ram.waxAmount('0.5')}`);
  say(ram.waxAmount('0') === '' && ram.waxAmount('-1') === '' && ram.waxAmount('1.123456789') === '' && ram.waxAmount('abc') === '',
    'zero, negative, 9 decimals and words are refused');
  say(ram.bytesPerClaim([{ use_pool: false }, { use_pool: 0 }, { use_pool: true }, { use_pool: 1 }]) === 2 * ram.BYTES_PER_MINT,
    'a claim needs bytes for what it mints, none for what it draws from a pool');
  const d = ram.buildRamDeposit(CLAIMER, COLLECTION, '1.00000000 WAX');
  say(d.account === 'eosio.token' && d.data.to === 'neftyblocksd' && d.data.memo === `deposit_collection_ram:${COLLECTION}`,
    `the deposit is a WAX transfer to neftyblocksd with the memo "${d.data.memo}"`);
  const perWax = await ram.bytesPerWax();
  say(perWax > 500 && perWax < 50000, `1 WAX buys about ${Math.round(perWax)} bytes today`);
}

console.log(`\n=== ${COLLECTION}'s balance and drop #${DROP} ===`);
const balance = await ram.readDropRam(COLLECTION);
console.log(`   ${COLLECTION} has ${balance.bytes} bytes${balance.hasRow ? '' : ' and no row yet'}`);
const empty = balance.bytes < ram.BYTES_PER_MINT;
{
  const r = await sim.simulateActions([claim]);
  if (r.kind === 'unavailable') say(false, `the claim alone: no answer from the chain (${r.reason})`);
  else if (empty) {
    say(r.kind === 'refused' && /enough RAM/i.test(r.reason), `the claim alone: chain ${r.kind === 'refused' ? `refuses ("${r.reason}")` : 'accepts'}`);
  } else {
    console.log(`   skip the claim alone: ${COLLECTION} has RAM now (chain ${r.kind})`);
  }
}
{
  const first = ram.buildRamDeposit(CLAIMER, COLLECTION, ram.waxAmount('0.01'));
  const r = await sim.simulateActions([first]);
  if (r.kind === 'unavailable') say(false, `0.01 WAX: no answer from the chain (${r.reason})`);
  else if (!balance.hasRow) {
    say(r.kind === 'refused' && /at least 128/.test(r.reason),
      `a first deposit of 0.01 WAX (about ${Math.floor(0.01 * await ram.bytesPerWax())} bytes): chain ${r.kind === 'refused' ? `refuses ("${r.reason}")` : 'accepts'}`);
  } else {
    say(r.kind !== 'refused', `0.01 WAX on an existing row: chain ${r.kind === 'refused' ? `refuses ("${r.reason}")` : 'accepts'}`);
  }
}
{
  const r = await sim.simulateActions([ram.buildRamDeposit(CLAIMER, COLLECTION, ram.waxAmount('1')), claim]);
  if (r.kind === 'unavailable') say(false, `1 WAX then the claim: no answer from the chain (${r.reason})`);
  else say(r.kind !== 'refused', `1 WAX of RAM then the claim, one transaction: chain ${r.kind === 'refused' ? `refuses ("${r.reason}")` : 'accepts'}`);
}

console.log('\n=== what Use a recipe says ===');
{
  const drop = {
    drop_id: DROP, collection_name: COLLECTION, is_free: true, listing_price: '0 NULL', settlement_symbol: '8,WAX',
    account_limit: 1, account_limit_cooldown: 0, account_remaining: 1, max_claimable: 0, current_claimed: 0,
    auth: { kind: 'whitelist', allowed: true }, status: 'active',
    assets_to_mint: [{ template_id: TEMPLATE, tokens_to_back: [], use_pool: false }],
  };
  const choice = { id: String(DROP), name: 'RAM check', note: '', live: true, source: 'drop', raw: drop };
  const verdict = (bytes) => {
    const ctx = checks.emptyCheckContext();
    ctx.actor = CLAIMER;
    ctx.dropRam = bytes;
    return checks.checksFor(choice, ctx).filter((c) => /RAM/.test(c.text));
  };
  const none = verdict(0), short = verdict(100), enough = verdict(ram.BYTES_PER_MINT), unread = verdict(undefined);
  say(none.length === 1 && none[0].tone === 'block', `0 bytes: ${none.map((c) => `${c.tone}: ${c.text}`).join('; ') || 'nothing said'}`);
  say(short.length === 1 && short[0].tone === 'warn', `100 bytes: ${short.map((c) => `${c.tone}: ${c.text}`).join('; ') || 'nothing said'}`);
  say(enough.length === 0, `${ram.BYTES_PER_MINT} bytes: ${enough.length ? enough.map((c) => c.text).join('; ') : 'nothing said'}`);
  say(unread.length === 0, `not read yet: ${unread.length ? unread.map((c) => c.text).join('; ') : 'nothing said'}`);
  say(checks.verdictFor(choice, Object.assign(checks.emptyCheckContext(), { actor: CLAIMER, dropRam: 0 })).closed,
    'with no RAM the drop is closed: Run it stays off');
}

console.log(fails.length ? `\n=== ${fails.length} FAILED ===` : '\n=== ALL DROP RAM CHECKS PASS ===');
process.exit(fails.length ? 1 : 0);
