/**
 * WaxDAO's drops and packs, and blend.nefty's time gates, as a player runs
 * them from Use a recipe.
 *
 *   1. Replay: the real transactions still in the history servers are
 *      rebuilt by the REAL builders (src/waxdao/drops.ts), field for field:
 *      a paid drop (#2107, 25 KASH), a paid drop bought 57 at a time
 *      (#2599, 427,443 OWLZ) and a pack opening (#558).
 *   2. The chain: through compute_transaction (executed by a node, never
 *      signed, never written), as real holders, each verdict of the Check
 *      step held to the chain's answer: a pack whose pool still holds NFTs,
 *      a pack whose pool is empty, a free drop whose collection has no RAM
 *      on waxdaomarket, a paid drop as an account that bought it.
 *   3. A time gate: uncutnefties' blend #37724, run 1,081,706 times, built
 *      by the runner from a real holder's NFTs. It is sold out, so the
 *      chain's answer must be the max, which it only reaches once the NFT,
 *      its requirements and its rest have passed.
 *
 * Run: npm run verify:waxdao-drops
 */
const fails = [];
const say = (pass, msg) => { console.log(`   ${pass ? 'ok  ' : 'FAIL'} ${msg}`); if (!pass) fails.push(msg); };
let drops, run, checks, sim;
try {
  drops = await import('./.build/waxdaoDrops.mjs');
  run = await import('./.build/guidedRun.mjs');
  checks = await import('./.build/runChecks.mjs');
  sim = await import('./.build/simulate.mjs');
} catch {
  console.error('Missing scripts/.build - run `npm run verify:waxdao-drops`.');
  process.exit(1);
}
const HISTORY = 'https://wax.eosusa.io';
const ATOMIC = 'https://wax.api.atomicassets.io';
const atomic = async (path) => (await (await fetch(`${ATOMIC}${path}`, { headers: { 'User-Agent': 'crucible-verify' } })).json()).data;
const trace = async (id) => (await (await fetch(`${HISTORY}/v2/history/get_transaction?id=${id}`)).json()).actions ?? [];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The player's actions of a real transaction, in their own shape. */
async function signed(id, player) {
  return (await trace(id)).filter((a) => a.act.authorization.some((x) => x.actor === player) && a.creator_action_ordinal === 0)
    .map((a) => ({ account: a.act.account, name: a.act.name, data: a.act.data }));
}
const shape = (built) => built.map((a) => ({ account: a.account, name: a.name, data: a.data }));
/** What a history server prints, against what the builder sends: numbers as the server writes them. */
function comparable(built) {
  return shape(built).map((a) => {
    const d = { ...a.data };
    if (a.name === 'transfer' && d.quantity && d.from) {
      const [amount, symbol] = d.quantity.split(' ');
      Object.assign(d, { amount: Number(amount), symbol });
    }
    if ('quantity_to_assert' in d) d.quantity_to_assert = Number(d.quantity_to_assert);
    return a.name === 'transfer' && 'asset_ids' in d ? { ...a, data: d } : { ...a, data: d };
  });
}
const sortKeys = (o) => (Array.isArray(o) ? o.map(sortKeys) : o && typeof o === 'object'
  ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortKeys(o[k])])) : o);

console.log('=== replay: real transactions, rebuilt ===');
{
  const real = await signed('47cc05fe0f9db665d1b06e62d68210d2b80bea6ad60ed97c0c666f22ef83391c', 's.4bi.wam');
  const d = await drops.loadWaxdaoDropById('2107');
  const built = drops.buildWaxdaoDropClaim({ claimer: 's.4bi.wam', drop: d, quantity: 1, unique_id: '1123312971' });
  say(real.length === 2 && same(sortKeys(comparable(built)), sortKeys(real)), `#2107, 1 x ${d?.price}: assertdrop + ${d?.price_contract}::transfer "${built[1]?.data.memo}"`);
}
{
  const real = await signed('c0ff0eb097f87d472b3e64709a396f3c221ae3e952d8cf966e68332f6ea3688a', 'welshdanft55');
  const d = await drops.loadWaxdaoDropById('2599');
  const built = drops.buildWaxdaoDropClaim({ claimer: 'welshdanft55', drop: d, quantity: 57, unique_id: '123646822' });
  say(real.length === 2 && same(sortKeys(comparable(built)), sortKeys(real)), `#2599, 57 x ${d?.price} = ${built[1]?.data.quantity}`);
}
{
  const real = await signed('d43e64709e86023480f6c575fce6cc167abc251769a24c0e5d3f33fe0b630dca', 'fohrerslayer');
  const built = drops.buildWaxdaoUnbox({ claimer: 'fohrerslayer', drop_id: '558', pack_asset_id: '1099948961050', unique_id: '851250834' });
  if (!real.length) console.log('   skip #558 opening: the history server no longer serves it');
  else say(same(sortKeys(shape(built)), sortKeys(real)), `#558, a pack opened: atomicassets::transfer "${built[0].data.memo}"`);
}
say(drops.timesQuantity('7499.00000000 OWLZ', 57) === '427443.00000000 OWLZ' && drops.timesQuantity('1 WAX', 3) === '3 WAX'
  && drops.timesQuantity('0.0001 TLM', 12) === '0.0012 TLM', 'price x quantity keeps the token\'s decimals');

/** Checks for one choice, with what the Check step loads for it. */
async function verdict(choice, actor, assets) {
  const ctx = checks.emptyCheckContext();
  ctx.actor = actor; ctx.assets = assets; ctx.assetsKnown = true; ctx.collection = choice.raw.collection;
  await checks.loadCheckContext(ctx, [choice], choice.raw.collection, () => {});
  return checks.verdictFor(choice, ctx);
}
const choiceOf = (d) => ({ id: d.drop_id, name: d.name, note: '', live: d.status === 'active', source: d.kind === 'pack' ? 'waxdaopack' : 'waxdaodrop', raw: d });
const ownerAssets = async (owner, template) => atomic(`/atomicassets/v1/assets?owner=${owner}&template_id=${template}&limit=20`);

console.log('\n=== the chain: Use a recipe against live drops ===');
{
  // The listing: one table, two sources.
  const r = await run.listRecipes('unpack', 'theonlineinn', '');
  const packs = r.choices.filter((c) => c.source === 'waxdaopack');
  say(packs.length > 0, `Use a recipe > open a pack > theonlineinn lists ${packs.length} WaxDAO pack(s) beside the other contracts`);
}
{
  // A pack whose pool holds NFTs, opened by someone holding one.
  const all = (await drops.listWaxdaoDrops('theonlineinn')).filter((d) => d.kind === 'pack' && d.status === 'active');
  let done = false;
  for (const d of all) {
    const pools = await drops.readPackPools(d.pools);
    if (!pools || pools.reduce((n, p) => n + p.left, 0) === 0) continue;
    const [asset] = await atomic(`/atomicassets/v1/assets?template_id=${d.template_id}&burned=false&limit=1&order=desc&sort=updated`) ?? [];
    if (!asset?.owner || asset.owner === 'waxdaomarket') continue;
    const mine = await ownerAssets(asset.owner, d.template_id);
    const c = choiceOf(d);
    const v = await verdict(c, asset.owner, mine);
    const reqs = run.describeRecipe('waxdaopack', d, mine, true).requirements;
    const built = await run.buildRunActions({ source: 'waxdaopack', actor: asset.owner, id: d.drop_id, raw: d, requirements: reqs, picked: run.autoPick(reqs, {}) });
    const r = await sim.simulateActions(built);
    say(!v.closed && (r.kind === 'accepted' || r.kind === 'resources'), `#${d.drop_id} (${d.name}), opened by ${asset.owner}: the page lets it run, chain ${r.kind}${r.reason ? ` (${r.reason})` : ''}`);
    done = true;
    break;
  }
  if (!done) console.log('   skip no theonlineinn pack with NFTs left and a holder');
}
{
  // A pack whose pool is empty: closed by the page, refused by the chain.
  const candidates = (await drops.listAllWaxdaoDrops()).filter((d) => d.kind === 'pack' && d.status === 'active');
  let done = false;
  for (const d of candidates) {
    const pools = await drops.readPackPools(d.pools);
    if (!pools || pools.reduce((n, p) => n + p.left, 0) > 0) continue;
    const [asset] = await atomic(`/atomicassets/v1/assets?template_id=${d.template_id}&burned=false&limit=1`) ?? [];
    if (!asset?.owner || asset.owner === 'waxdaomarket') continue;
    const v = await verdict(choiceOf(d), asset.owner, await ownerAssets(asset.owner, d.template_id));
    const r = await sim.simulateActions(drops.buildWaxdaoUnbox({ claimer: asset.owner, drop_id: d.drop_id, pack_asset_id: asset.asset_id }));
    say(v.closed && r.kind === 'refused', `#${d.drop_id}, its pool empty: the page closes it (${v.checks.find((x) => x.tone === 'block')?.text}), chain ${r.kind}${r.reason ? ` ("${r.reason}")` : ''}`);
    done = true;
    break;
  }
  if (!done) console.log('   skip no open pack with an empty pool and a holder found');
}
{
  // A free drop whose collection has no RAM to mint with.
  const d = await drops.loadWaxdaoDropById('2143');
  if (d?.status === 'active') {
    const v = await verdict(choiceOf(d), 'zigm4.gm', []);
    const r = await sim.simulateActions(drops.buildWaxdaoDropClaim({ claimer: 'zigm4.gm', drop: d }));
    const ram = /RAM/.test(r.reason ?? '');
    say(v.closed === ram, `#2143 (${d.collection}), free: the page ${v.closed ? `closes it (${v.checks.find((x) => x.tone === 'block')?.text})` : 'lets it run'}, chain ${r.kind}${r.reason ? ` ("${r.reason}")` : ''}`);
  } else console.log('   skip #2143 is no longer open');
}
{
  // A paid drop, as the account that bought it in the trace.
  const d = await drops.loadWaxdaoDropById('2107');
  const r = await sim.simulateActions(drops.buildWaxdaoDropClaim({ claimer: 's.4bi.wam', drop: d }));
  const v = await verdict(choiceOf(d), 's.4bi.wam', []);
  const refusedForMoney = r.kind === 'refused' && /overdrawn|balance|enough/i.test(r.reason ?? '');
  say((r.kind === 'accepted' || r.kind === 'resources') ? !v.closed : refusedForMoney,
    `#2107, 1 x ${d.price} as s.4bi.wam: chain ${r.kind}${r.reason ? ` ("${r.reason}")` : ''}, the page ${v.closed ? 'closes it' : 'lets it run'}${v.checks.filter((x) => x.tone !== 'info').map((x) => `; ${x.text}`).join('')}`);
}

console.log('\n=== a time gate, run as a player ===');
{
  const [row37724] = (await (await fetch('https://wax.greymass.com/v1/chain/get_table_rows', { method: 'POST', body: JSON.stringify({
    json: true, code: 'blend.nefty', scope: 'blend.nefty', table: 'blends', lower_bound: '37724', upper_bound: '37724', limit: 1 }) })).json()).rows;
  const blend = { raw: row37724 };
  // A Betsy with the "$RJUAN Miner" artifact, last used in 2024.
  const holder = 'jbdds.wam';
  const mine = await ownerAssets(holder, 641626);
  const row = { ingredients: blend?.raw?.ingredients ?? [], collection_name: 'uncutnefties' };
  const reqs = run.requirementsOf(row, mine, true);
  const gate = reqs[0];
  say(gate?.role === 'keep' && gate.candidates.includes('1099940655030'), `the runner offers ${holder}'s rested $RJUAN Miner: "${gate?.text}"`);
  const built = await run.buildRunActions({ source: 'blend', actor: holder, id: '37724', raw: blend.raw, requirements: reqs, picked: run.autoPick(reqs, {}) });
  const fuse = built.find((a) => a.name === 'nosecfuse' || a.name === 'fuse');
  say(fuse && same(fuse.data.own_assets, gate.candidates.slice(0, 1)) && fuse.data.transferred_assets.length === 0, `it goes in own_assets, nothing is transferred: ${JSON.stringify(fuse?.data.own_assets)}`);
  const r = await sim.simulateActions(built);
  say(r.kind === 'refused' && /max usage/i.test(r.reason), `chain: "${r.reason}", past the NFT, its requirements and its rest`);
  const bare = await atomic('/atomicassets/v1/assets?owner=pzyas.wam&template_id=641626&limit=5');
  const none = run.requirementsOf(row, bare, true)[0];
  say(none.have === 0 && none.candidates.length === 0, `an owner of Betsies without the artifact is offered none (${none.have} of 1)`);
}

console.log(fails.length ? `\n=== ${fails.length} FAILED ===` : '\n=== ALL WAXDAO DROP CHECKS PASS ===');
process.exit(fails.length ? 1 : 0);
