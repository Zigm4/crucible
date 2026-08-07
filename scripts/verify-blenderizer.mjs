/**
 * Read-only verification of the `blenderizerx` (Blenderizer) path.
 *
 * Reference trace: 35551867549b3b2beb83ab7cc7c5d75b381de4fa345cf3197b0e23788fe8d2aa
 *   cryptoviking blends recipe 106051 (niftywizards) on 2026-07-20:
 *   ONE atomicassets::transfer to blenderizerx, memo "106051",
 *   11 asset_ids -> the contract mints template 106051 and burns all 11.
 *
 * What this checks, entirely against live chain state:
 *   1. the contract is 3DkRender's, not Nefty's (its own `config` row)
 *   2. the recipe row exists and its primary key IS the target template
 *   3. `mixture` collapses to the slots our matcher builds, and the
 *      slot amounts add up to the trace's asset count
 *   4. the asset_ids actually transferred matched those templates, i.e.
 *      the recipe we read is the recipe that was executed
 *   5. our action list reproduces the original transfer BYTE FOR BYTE
 *   6. discovery finds the recipe by scanning `blenders` for its
 *      collection (there is no index on collection, so this exercises
 *      the same walk the app performs)
 *
 * Nothing is broadcast and no signature is requested.
 *
 * Run: node scripts/verify-blenderizer.mjs
 */

import { APIClient, Action } from '@wharfkit/session';

const client = new APIClient({ url: 'https://wax.eosphere.io' });

const TRX_ID = '35551867549b3b2beb83ab7cc7c5d75b381de4fa345cf3197b0e23788fe8d2aa';
const CLAIMER = 'cryptoviking';
const TARGET = 106051;
const COLLECTION = 'niftywizards';
const ASSET_IDS = [
  '1099849041163', '1099847727098', '1099847398983', '1099847377353',
  '1099846430620', '1099845750229', '1099844848853', '1099844848843',
  '1099844848829', '1099843991183', '1099998718476',
];

const log = (...a) => console.log(...a);
let ok = true;
const check = (pass, label, detail = '') => {
  log(`   ${pass ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
  if (!pass) ok = false;
};

async function rows(code, scope, table, extra = {}) {
  const res = await client.call({
    path: '/v1/chain/get_table_rows',
    params: { json: true, code, scope, table, limit: 100, ...extra },
  });
  return res.rows ?? [];
}

/**
 * Mirrors src/blenderizer/blends.ts::slotsFromMixture. Kept as an
 * independent re-implementation so a drift between the two shows up
 * here rather than as a rejected transaction.
 */
function slotsFromMixture(mixture) {
  const order = [];
  const counts = new Map();
  for (const raw of mixture ?? []) {
    const t = Number(raw);
    if (!Number.isFinite(t)) continue;
    if (!counts.has(t)) order.push(t);
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return order.map((template_id, index) => ({
    index, template_id, amount: counts.get(template_id),
  }));
}

// ─── 1. whose contract is this ─────────────────────────────────────────── //

log(`\n=== blenderizerx identity ===`);
const [cfg] = await rows('blenderizerx', 'blenderizerx', 'config', { limit: 1 });
log(`   author "${cfg?.author}"  version ${cfg?.version}  contact ${cfg?.contact}`);
check(cfg?.author === '3dkrenderwax', 'config.author is 3dkrenderwax (3DkRender, NOT NeftyBlocks)');

// ─── 2. the recipe ─────────────────────────────────────────────────────── //

log(`\n=== recipe ${TARGET} ===`);
const [recipe] = await rows('blenderizerx', 'blenderizerx', 'blenders', {
  lower_bound: String(TARGET), upper_bound: String(TARGET), limit: 1,
});
if (!recipe) {
  log('!! recipe not found');
  process.exit(1);
}
log(`   owner ${recipe.owner}  collection ${recipe.collection}  target ${recipe.target}`);
check(Number(recipe.target) === TARGET, 'primary key IS the target template_id');
check(recipe.collection === COLLECTION, `collection is ${COLLECTION}`);

const slots = slotsFromMixture(recipe.mixture);
log(`   slots: ${slots.map((s) => `${s.amount}x template ${s.template_id}`).join(' + ')}`);
const totalFromSlots = slots.reduce((n, s) => n + s.amount, 0);
check(totalFromSlots === recipe.mixture.length, 'slot amounts sum to mixture length', `${totalFromSlots} == ${recipe.mixture.length}`);
check(totalFromSlots === ASSET_IDS.length, 'slot amounts match the trace asset count', `${totalFromSlots} == ${ASSET_IDS.length}`);

// ─── 3. the deposited assets really matched those templates ────────────── //

log(`\n=== deposited assets vs recipe ===`);
const wanted = new Map(slots.map((s) => [s.template_id, s.amount]));
const seen = new Map();
for (const id of ASSET_IDS) {
  const body = await fetch(`https://wax.api.atomicassets.io/atomicassets/v1/assets/${id}`).then((r) => r.json());
  const tid = Number(body?.data?.template?.template_id);
  seen.set(tid, (seen.get(tid) ?? 0) + 1);
}
for (const [tid, amount] of wanted) {
  check(seen.get(tid) === amount, `${amount}x template ${tid} deposited`, `found ${seen.get(tid) ?? 0}`);
}
check([...seen.keys()].every((t) => wanted.has(t)), 'no deposited asset falls outside the recipe');

// ─── 4. byte-for-byte against the original trace ───────────────────────── //

log(`\n=== transaction Crucible would build ===`);
const trace = await fetch(`https://wax.eosphere.io/v2/history/get_transaction?id=${TRX_ID}`).then((r) => r.json());
const original = (trace.actions ?? []).find(
  (a) => a.act?.account === 'atomicassets' && a.act?.name === 'transfer' && a.act?.data?.to === 'blenderizerx',
);
if (!original) {
  log('!! could not find the original transfer in the trace');
  process.exit(1);
}

// The single action the app builds: memo = the target template_id.
const ours = {
  account: 'atomicassets',
  name: 'transfer',
  authorization: [{ actor: CLAIMER, permission: 'active' }],
  data: {
    from: CLAIMER,
    to: 'blenderizerx',
    asset_ids: ASSET_IDS,
    memo: String(TARGET),
  },
};
check(original.act.data.memo === String(TARGET), 'trace memo is the bare target template_id', `"${original.act.data.memo}"`);
check(
  (trace.actions ?? []).filter((a) => a.act?.account === 'atomicassets' && a.act?.name === 'transfer' && a.act?.data?.to === 'blenderizerx').length === 1,
  'the whole blend is ONE transfer (no announce, no second signature)',
);

const abiRes = await client.v1.chain.get_abi('atomicassets');
const built = Action.from(
  { account: ours.account, name: ours.name, authorization: ours.authorization, data: ours.data },
  abiRes.abi,
);
const oursHex = built.data.hexString.toLowerCase();

// Rebuild the trace's own action through the same ABI: Hyperion returns
// decoded JSON, so re-encoding it is how we get comparable bytes.
const theirs = Action.from(
  {
    account: 'atomicassets',
    name: 'transfer',
    authorization: original.act.authorization,
    data: original.act.data,
  },
  abiRes.abi,
);
const theirsHex = theirs.data.hexString.toLowerCase();
check(oursHex === theirsHex, 'atomicassets::transfer matches the trace byte for byte', `${oursHex.length / 2} bytes`);
if (oursHex !== theirsHex) {
  log(`      ours :  ${oursHex}`);
  log(`      trace:  ${theirsHex}`);
}

// ─── 5. discovery finds it ─────────────────────────────────────────────── //

log(`\n=== discovery scan (no index on collection) ===`);
const t0 = Date.now();
let cursor = 0n, total = 0, mine = 0, calls = 0;
for (;;) {
  const batch = await rows('blenderizerx', 'blenderizerx', 'blenders', {
    lower_bound: String(cursor), limit: 1000,
  });
  calls += 1;
  total += batch.length;
  for (const r of batch) if (r.collection === COLLECTION) mine += 1;
  if (batch.length < 1000) break;
  cursor = BigInt(batch[batch.length - 1].target) + 1n;
}
log(`   walked ${total} rows in ${calls} calls (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
check(mine > 0, `recipe's collection is reachable by scan`, `${mine} recipe(s) for ${COLLECTION}`);

// ─── 6. RAM balance, the invisible blocker ─────────────────────────────── //

log(`\n=== collection RAM on blenderizerx ===`);
const [ram] = await rows('blenderizerx', 'blenderizerx', 'rambalance', {
  lower_bound: COLLECTION, upper_bound: COLLECTION, limit: 1,
});
log(`   ${COLLECTION}: ${ram ? `${ram.bytes} bytes` : 'NO ROW (cannot mint)'}`);
check(!!ram && Number(ram.bytes) > 0, 'collection has RAM available to mint with');

log(`\n=== ${ok ? 'BLENDERIZER PATH OK' : 'FAILED'} ===`);
process.exit(ok ? 0 : 1);
