/**
 * Can the contract actually mint into the collection its recipes target?
 *
 * AtomicAssets only lets an account listed in a collection's
 * `authorized_accounts` mint or edit its assets. A blend whose collection
 * never added `blend.nefty` is therefore a recipe NOBODY can run, while
 * still reading as active with a start date and a supply. Crucible showed
 * such recipes as green and executable until this check existed.
 *
 * How badly it hurts depends on the transaction count:
 *   one transaction  (deterministic blend, drop claim, Blenderizer)
 *                    the mint fails, the whole tx reverts, the player
 *                    keeps their NFTs and loses only CPU.
 *   two transactions (random blend, pack unbox)
 *                    the ingredients leave in TX1 and the reward arrives
 *                    in TX2, so a permanent failure in TX2 leaves the
 *                    player with neither.
 *
 * PHASE A  the reader agrees with the chain on known collections, and
 *          answers `undefined` (not false) for one it cannot read.
 * PHASE B  a live census: how many recent recipes target a collection
 *          that has not authorized their contract.
 *
 * As with every harness here, this imports the REAL module.
 */
import { isContractAuthorized } from './.build/collections.mjs';

const RPC = 'https://wax.greymass.com';

async function rows(code, scope, table, extra = {}) {
  const r = await fetch(`${RPC}/v1/chain/get_table_rows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ json: true, code, scope, table, limit: 1000, ...extra }),
  });
  return (await r.json()).rows ?? [];
}

// ── PHASE A ─────────────────────────────────────────────────────────────
// Fixed cases, each chosen because it says something the others do not.
const CASES = [
  ['underpunks55',  'blend.nefty',  true,      'a healthy collection'],
  ['crewtoonswax',  'blend.nefty',  true,      'another, to catch a reader stuck on false'],
  ['timberlegend',  'blend.nefty',  false,     '13 blends nobody can run'],
  ['timberlegend',  'neftyblocksd', false,     'and 32 drops, same cause'],
  ['outlawtroops',  'blend.nefty',  false,     'authorization removed, 2 players stranded mid-blend'],
  ['zzznotexistzz', 'blend.nefty',  undefined, 'unreadable must be undefined, never false'],
];

console.log('=== PHASE A - the reader against known collections ===');
const fails = [];
for (const [collection, contract, expected, why] of CASES) {
  const got = await isContractAuthorized(collection, contract);
  const ok = got === expected;
  if (!ok) fails.push(`${collection}/${contract}: got ${got}, expected ${expected}`);
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${collection.padEnd(14)} ${contract.padEnd(13)} -> ${String(got).padEnd(9)} ${why}`);
}

// ── PHASE B ─────────────────────────────────────────────────────────────
console.log('\n=== PHASE B - live census over the most recent recipes ===');
const SOURCES = [
  ['blend.nefty',  'blends',   'blend.nefty',  'BLEND'],
  ['up.nefty',     'upgrades', 'up.nefty',     'UPGRADE'],
  ['neftyblocksd', 'drops',    'neftyblocksd', 'DROP'],
];

for (const [code, table, contract, label] of SOURCES) {
  const recipes = await rows(code, code, table, { reverse: true });
  const byCollection = new Map();
  for (const r of recipes) {
    const c = r.collection_name;
    byCollection.set(c, (byCollection.get(c) ?? 0) + 1);
  }
  const broken = [];
  for (const c of byCollection.keys()) {
    if ((await isContractAuthorized(c, contract)) === false) broken.push(c);
  }
  const affected = broken.reduce((n, c) => n + byCollection.get(c), 0);
  console.log(
    `   ${label.padEnd(8)} ${String(byCollection.size).padStart(3)} collections, ` +
    `${String(broken.length).padStart(2)} unauthorized, ` +
    `${String(affected).padStart(3)}/${recipes.length} recipes cannot run`,
  );
  for (const c of broken) console.log(`        ${c} (${byCollection.get(c)} recipe(s))`);
}

console.log('');
if (fails.length) {
  console.log(`=== ${fails.length} FAILURE(S) ===`);
  for (const f of fails) console.log('   ' + f);
  process.exit(1);
}
console.log('=== ALL CONTRACT-AUTH CHECKS PASS ===');
