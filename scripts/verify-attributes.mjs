/**
 * Attribute rules: does Crucible pick the NFTs the contracts accept?
 *
 * up.nefty and waxdaomarket can ask for an NFT by what its attributes
 * say ("level is 1", "power is on") instead of by template. Neither
 * contract's source is public, so the rules in src/atomic/attributes.ts
 * were settled by running real assets through compute_transaction: a node
 * executes the transaction without signatures and writes nothing.
 *
 *   PHASE A - the cases the chain decided, on 2026-10-23. Each asset's
 *             three data sources are copied as they were, with the chain's
 *             answer; the REAL matchers must give the same one. The case
 *             that decides the reading order is upgrade 170: template says
 *             level "1", mutable data says "2", and the rule "2" passes.
 *   PHASE B - WaxDAO deposit slots. A deposit names the ingredient's
 *             position in the recipe, tokens included. Built with the REAL
 *             builder from the live rows of blends 905 (two tokens first)
 *             and 171 (its token last).
 *   PHASE D - blend.nefty BALANCE ingredients: a number on an NFT that
 *             stays in the wallet pays the cost. The NFT must go in
 *             own_assets, never in the deposit, and hold at least the cost.
 *   PHASE C - live, with --live. Blend 905 and upgrade 170 are run through
 *             compute_transaction again. The owners there are short of the
 *             tokens, so a funded account sends them first in the same
 *             unsigned transaction; nothing is signed, so nothing moves.
 *             An asset that has since moved or burned is reported, not
 *             counted as a failure.
 *
 * Run: npm run verify:attributes   (add -- --live for phase C)
 */
const fails = [];
const say = (pass, msg) => { console.log(`   ${pass ? 'ok  ' : 'FAIL'} ${msg}`); if (!pass) fails.push(msg); };

let attrs, upgrades, waxdao, waxdaoExec, runner;
try {
  attrs = await import('./.build/attributes.mjs');
  runner = await import('./.build/guidedRun.mjs');
  upgrades = await import('./.build/upgrades.mjs');
  waxdao = await import('./.build/waxdaoBlends.mjs');
  waxdaoExec = await import('./.build/waxdaoExecute.mjs');
} catch {
  console.error('Missing scripts/.build - run `npm run verify:attributes`.');
  process.exit(1);
}

// An asset as the AtomicAssets API returns it, with `data` merged the way
// the API merges it: the template wins. The matchers must not read that.
const asset = (id, collection, schema, tpl, { t = {}, i = {}, m = {} }) => ({
  asset_id: id, owner: 'someone',
  collection: { collection_name: collection }, schema: { schema_name: schema },
  template: { template_id: String(tpl), immutable_data: t },
  immutable_data: i, mutable_data: m, data: { ...m, ...i, ...t },
});
const typed = (attribute_name, attribute_type, vector, values) =>
  attrs.decodeTypedRule({ attribute_name, attribute_type, allowed_values: [vector, values], comparator: 0 });
const spec = (schema_name, requirements) => ({ schema_name, requirements, results: [], display_data: '' });
const upgrade = (collection_name, specs, ingredients = []) => ({ collection_name, specs, ingredients });

console.log('\n=== PHASE A · the cases the chain decided ===');
{
  // up.nefty, the NFT to upgrade (TYPED_ATTRIBUTE_REQUIREMENT).
  const u170 = upgrade('paradisexxxx', [spec('characters', [
    { kind: 'template', template_id: 843432 },
    { kind: 'attribute', rule: typed('level', 'string', 'STRING_VEC', ['2']) },
  ])]);
  const split = asset('1099947641493', 'paradisexxxx', 'characters', 843432, { t: { level: '1' }, m: { level: '2' } });
  say(split.data.level === '1' && attrs.attributeOf(split, 'level') === '2',
      'a value in both places reads as the mutable one, where the API\'s merged data says the template\'s');
  say(upgrades.upgradeTargetFits(u170, split) === true, 'upgrade 170 takes it, as the chain did (ACCEPTED)');
  const tplOnly = asset('1099947640205', 'paradisexxxx', 'characters', 843432, { t: { level: '1' } });
  say(upgrades.upgradeTargetFits(u170, tplOnly) === false, 'and refuses the one still at level 1 (REFUSED)');

  const u376 = upgrade('wombatchamps', [spec('wombality', [
    { kind: 'attribute', rule: typed('rarity', 'string', 'STRING_VEC', ['Mythic', 'Legendary', 'Epic', 'Rare', 'Common']) },
  ])]);
  say(upgrades.upgradeTargetFits(u376, asset('1099581381073', 'wombatchamps', 'wombality', 1, { t: { rarity: 'Common' } })) === true,
      'a value only in the template counts (upgrade 376, ACCEPTED)');

  const u63 = upgrade('skekofficial', [spec('rocks', [
    { kind: 'template', template_id: 797974 },
    { kind: 'attribute', rule: typed('level', 'uint64', 'UINT64_VEC', [0]) },
  ])]);
  const rock = (id, m) => asset(id, 'skekofficial', 'rocks', 797974, { m });
  say(upgrades.upgradeTargetFits(u63, rock('1099934985689', { level: '0' })) === true, 'uint64 "0" against [0] passes (upgrade 63, ACCEPTED)');
  say(upgrades.upgradeTargetFits(u63, rock('1099936476505', { level: '3' })) === false, 'uint64 "3" does not (REFUSED)');
  say(upgrades.upgradeTargetFits(u63, rock('1099936830948', {})) === false, 'and an NFT without the attribute does not (REFUSED)');
  say(upgrades.upgradeTargetFits(u63, asset('1', 'skekofficial', 'rocks', 1, { m: { level: '0' } })) === false,
      'nor one of another template, whatever its level');
  say(upgrades.upgradeTargetFits(u63, asset('2', 'someoneelse', 'rocks', 797974, { m: { level: '0' } })) === false,
      'nor one of another collection');

  const u532 = upgrade('myzicklearmy', [spec('iamthezickle', [
    { kind: 'attribute', rule: typed('img', 'image', 'STRING_VEC', ['QmQs8fjboxvzfn5eREdyMbAuzcHqtp6BBMLVp7T8ycN5Hs']) },
  ])]);
  const zickle = (id, img) => asset(id, 'myzicklearmy', 'iamthezickle', 1, { m: { img } });
  say(upgrades.upgradeTargetFits(u532, zickle('1099957917905', 'QmQs8fjboxvzfn5eREdyMbAuzcHqtp6BBMLVp7T8ycN5Hs')) === true,
      'an image is compared as its hash (upgrade 532, ACCEPTED)');
  say(upgrades.upgradeTargetFits(u532, zickle('1099957413635', 'bafybeicy75kwyzwptgbpd6uxeoefub34l2z7gklaghmjx3u3fen6acsxzi')) === false,
      'another image is not (REFUSED)');

  // The 8-bit vectors are hex, and the API sends a bool as 0 or 1.
  const engine = typed('Engine', 'bool', 'UINT8_VEC', '00');
  say(JSON.stringify(engine.allowed) === '[0]', 'UINT8_VEC "00" decodes to [0]');
  say(attrs.passesTypedRule(asset('3', 'c', 's', 1, { m: { Engine: 0 } }), engine) === true
      && attrs.passesTypedRule(asset('4', 'c', 's', 1, { m: { Engine: 1 } }), engine) === false,
      'and a bool 0 passes it where a 1 does not');
  say(attrs.passesTypedRule(asset('5', 'c', 's', 1, { t: { p: 2.01 } }), typed('p', 'double', 'DOUBLE_VEC', ['2.00999999999999979'])) === true,
      'a double matches the long decimal the chain prints for it');
  say(attrs.passesTypedRule(asset('6', 'c', 's', 1, { m: { n: '18446744073709551615' } }), typed('n', 'uint64', 'UINT64_VEC', ['18446744073709551615'])) === true
      && attrs.passesTypedRule(asset('7', 'c', 's', 1, { m: { n: '18446744073709551614' } }), typed('n', 'uint64', 'UINT64_VEC', ['18446744073709551615'])) === false,
      'uint64 past 2^53 is compared exactly, not as a rounded float');
  say(attrs.passesTypedRule(asset('8', 'c', 's', 1, { m: { level: '1' } }), { ...typed('level', 'string', 'STRING_VEC', ['1']), comparator: 3 }) === undefined,
      'a comparator nobody uses yet is "cannot tell", not a guess');

  // up.nefty, the NFT burned for the cost (ATTRIBUTE_INGREDIENT, upgrade 115).
  const ing115 = {
    kind: 'attribute', collection_name: 'crewtoonswax', schema_name: 'spaceships', amount: 1,
    effect: { kind: 'typed', type: 0 },
    attributes: [{ attribute_name: 'name', allowed_values: ['8L-U8'] }, { attribute_name: 'level', allowed_values: ['1'] }],
  };
  const ship = (id, name, level) => asset(id, 'crewtoonswax', 'spaceships', 819562, { t: { name }, m: { level } });
  say(upgrades.upgradeIngredientFits(ing115, ship('1099980895998', '8L-U8', '1')) === true,
      'an ingredient reads the template\'s name and the mutable level together (upgrade 115, ACCEPTED)');
  say(upgrades.upgradeIngredientFits(ing115, ship('1099962000286', 'NF Sea Dragon', '1')) === false,
      'another ship at the right level is refused (REFUSED: Requirements not met)');
  say(upgrades.upgradeIngredientFits(ing115, ship('1099968438414', 'Prawn Predator', '3')) === false,
      'and so is one wrong on both');

  // blend.nefty (ATTRIBUTE_INGREDIENT, blend 37690): template and mutable
  // data read together. Which wins when they disagree is not testable on
  // blend.nefty, no NFT of an open blend has that case; up.nefty's order
  // is used.
  const b37690 = { blend_id: 37690, collection_name: 'crewtoonswax', ingredients: [['ATTRIBUTE_INGREDIENT', {
    collection_name: 'crewtoonswax', schema_name: 'spaceships', display_data: '{}', amount: 2,
    attributes: [{ attribute_name: 'name', allowed_values: ['8L-U8'] }, { attribute_name: 'rarity', allowed_values: ['Common'] }, { attribute_name: 'level', allowed_values: ['1'] }],
  }]] };
  const craft = (id, name, rarity, level) => asset(id, 'crewtoonswax', 'spaceships', 1, { t: { name, rarity }, m: { level } });
  const [shipReq] = runner.requirementsOf(b37690, [craft('a', '8L-U8', 'Common', '1'), craft('b', '8L-U8', 'Common', '1'), craft('c', 'NF Sea Dragon', 'Rare', '1'), craft('d', '8L-U8', 'Common', '2')], true);
  say(JSON.stringify(shipReq.candidates) === '["a","b"]',
      `blend.nefty reads the template's name and rarity with the mutable level (blend 37690, ACCEPTED with two that fit, REFUSED with one that does not): ${shipReq.candidates.join(', ')}`);

  // waxdaomarket ("exact").
  const rule = (name, value) => ({ type: 'string', name, value, criteria: 'exact' });
  const slots = asset('1099916072947', 'jumbiewaxart', 'rgbitslots', 1, { i: { Staking: 'Yes' } });
  say(attrs.passesWaxdaoRule(slots, rule('Staking', 'Yes')) === true, 'WaxDAO reads the asset\'s immutable data (blend 1589, ACCEPTED)');
  say(attrs.passesWaxdaoRule(asset('1099896161844', 'jumbiewaxart', 'rgbitslots', 1, { i: { Staking: 'none' } }), rule('Staking', 'Yes')) === false,
      'and refuses another value (REFUSED: Attribute does not meet the required criteria)');
  say(attrs.passesWaxdaoRule(asset('1099920316842', 'kingsburynft', 'tv', 1, { m: { power: 'on' } }), rule('power', 'on')) === true,
      'and its mutable data (blend 1794, ACCEPTED)');
  say(attrs.passesWaxdaoRule(asset('1099919881549', 'kingsburynft', 'tv', 1, { m: { power: 'off' } }), rule('power', 'on')) === false,
      'power "off" is refused (REFUSED)');
  say(attrs.passesWaxdaoRule(asset('1099939620360', 'tokenumkmnft', 'haragamepack', 1, {}), rule('redeem WINP', '100')) === false,
      'an NFT without the attribute is refused (blend 171, REFUSED: not found on this NFT)');
  say(attrs.passesWaxdaoRule(slots, { ...rule('Staking', 'Yes'), criteria: 'range' }) === undefined,
      'a criteria nobody uses yet is "cannot tell"');
}

console.log('\n=== PHASE B · WaxDAO deposit slots ===');
const memos = (acts) => acts.slice(1).map((a) => `${a.account}:${a.data.memo}`);
{
  const b905 = await waxdao.loadWaxdaoBlendById(905);
  if (!b905) say(false, 'blend 905 could not be read');
  else {
    say(JSON.stringify(b905.nftSlots.map((s) => s.slot)) === '[2,3]', 'blend 905: its two NFTs sit at positions 2 and 3');
    const acts = waxdaoExec.buildWaxdaoBlendActions({ claimer: 'zigm4.gm', blend: b905, nftSelection: new Map([[2, '1'], [3, '2']]), unique_id: 1 });
    const got = memos(acts);
    say(got.join(' ') === 'eosio.token:|blend_deposit|905|0| jumbiedao.gm:|blend_deposit|905|1| atomicassets:|blend_deposit|905|2| atomicassets:|blend_deposit|905|3|',
        `both tokens are paid, each into its own slot: ${got.join(' ')}`);
  }
  const b171 = await waxdao.loadWaxdaoBlendById(171);
  if (!b171) say(false, 'blend 171 could not be read');
  else {
    const acts = waxdaoExec.buildWaxdaoBlendActions({ claimer: 'zigm4.gm', blend: b171, nftSelection: new Map([[0, '1']]), unique_id: 1 });
    say(memos(acts).join(' ').startsWith('atomicassets:|blend_deposit|171|0|'),
        `blend 171, token last: the NFT goes to 0 and the token to 1 (${memos(acts).join(' ')})`);
  }
}

console.log('\n=== PHASE D · blend.nefty balance ingredients ===');
const blend23002 = {
  blend_id: 23002, collection_name: 'agarthagames', security_id: 0,
  ingredients: [['BALANCE_INGREDIENT', { schema_name: 'loyaltycards', template_id: 622617, attribute_name: 'Balance', cost: 100, display_data: '{}' }]],
};
{
  const card = (id, balance) => asset(id, 'agarthagames', 'loyaltycards', 622617, { m: { Balance: balance } });
  const [req] = runner.requirementsOf(blend23002, [card('1', '861'), card('2', '26'), card('3', '100')], true);
  say(req.kind === 'nft' && req.role === 'keep', 'a balance is an NFT to pick, which you keep');
  say(JSON.stringify(req.candidates) === '["1","3"]', `only the cards holding at least 100 are offered (${req.candidates.join(', ')}), as the chain refused one at 26 ("Not enough balance in: Balance")`);
  const acts = await runner.buildRunActions({ source: 'blend', actor: 'zigm4.gm', id: '23002', raw: blend23002, requirements: [req], picked: { 0: ['1'] } });
  const fuse = acts.find((a) => a.name === 'nosecfuse');
  say(JSON.stringify(fuse?.data.own_assets) === '["1"]' && fuse?.data.transferred_assets.length === 0
      && !acts.some((a) => a.account === 'atomicassets'),
      'it goes in own_assets and is never transferred: the card cannot be (the chain says "isn\'t transferable")');
  say(!acts.some((a) => a.name === 'announcedepo'),
      'and with nothing deposited there is no announcedepo, which the chain refuses at 0 ("Count has to be greater than 0")');
}

if (process.argv.includes('--live')) {
  console.log('\n=== PHASE C · live, through compute_transaction ===');
  const { APIClient, Action, SignedTransaction } = await import('@wharfkit/session');
  const client = new APIClient({ url: 'https://wax.greymass.com' });
  const abis = new Map();
  const abiOf = async (c) => { if (!abis.has(c)) abis.set(c, (await client.v1.chain.get_abi(c)).abi); return abis.get(c); };
  const act = async (account, name, actor, data) => Action.from({ account, name, authorization: [{ actor, permission: 'active' }], data }, await abiOf(account));
  const run = async (actions) => {
    const info = await client.v1.chain.get_info();
    try {
      const res = await client.v1.chain.compute_transaction(SignedTransaction.from({ ...info.getTransactionHeader(120), actions, signatures: [] }));
      const ex = res.processed?.except;
      if (!ex) return { ok: true };
      const j = JSON.stringify(ex);
      return { ok: false, error: /"s":"([^"]+)"/.exec(j)?.[1] ?? /"message":"([^"]+)"/.exec(j)?.[1] ?? 'refused' };
    } catch (e) { return { ok: false, error: /"s":"([^"]+)"/.exec(JSON.stringify(e?.error ?? {}))?.[1] ?? String(e?.message ?? e) }; }
  };
  // The signer's own CPU or NET running out is about that account, not the recipe.
  const resources = (r) => !r.ok && /usage limit|CPU|NET|deadline|billed/i.test(r.error);
  const aa = (p) => fetch(`https://wax.api.atomicassets.io/atomicassets/v1/${p}`).then((r) => r.json());
  // Accounts that hold the tokens, sending them first in the same unsigned transaction.
  const WAX_FUNDER = 'huobideposit';

  // Blend 905, by position, as a holder of both templates.
  const b905 = await waxdao.loadWaxdaoBlendById(905);
  const [t1, t2] = b905.nftSlots.map((s) => s.ingredient.template_id);
  let user, a1, a2;
  for (const h of [...new Set(((await aa(`assets?template_id=${t1}&limit=100`)).data ?? []).map((a) => a.owner).filter(Boolean))]) {
    const m1 = (await aa(`assets?owner=${h}&template_id=${t1}&limit=1`)).data?.[0];
    const m2 = (await aa(`assets?owner=${h}&template_id=${t2}&limit=1`)).data?.[0];
    if (m1 && m2) { user = h; a1 = m1.asset_id; a2 = m2.asset_id; break; }
  }
  if (!user) console.log('   skip  blend 905: nobody holds both of its templates any more');
  else {
    const built = waxdaoExec.buildWaxdaoBlendActions({ claimer: user, blend: b905, nftSelection: new Map([[2, a1], [3, a2]]), unique_id: 987654321 });
    const funding = [];
    for (const ing of b905.ingredients.filter((i) => i.kind === 'fungible')) {
      const sym = ing.quantity.split(' ')[1];
      const stat = await client.v1.chain.get_table_rows({ code: ing.contract, scope: sym, table: 'stat', limit: 1 });
      const from = ing.contract === 'eosio.token' ? WAX_FUNDER : String(stat.rows[0]?.issuer);
      funding.push(await act(ing.contract, 'transfer', from, { from, to: user, quantity: ing.quantity, memo: '' }));
    }
    const actions = [...funding, ...await Promise.all(built.map((a) => act(a.account, a.name, user, a.data)))];
    const r = await run(actions);
    say(r.ok, `blend 905 as ${user}, built by the app: ${r.ok ? 'ACCEPTED' : `REFUSED: ${r.error}`}`);
  }

  // Blend 23002, built by the runner, as a holder of a card with enough on it.
  {
    const cards = ((await aa('assets?collection_name=agarthagames&template_id=622617&burned=false&limit=100&order=desc&sort=updated')).data ?? [])
      .filter((a) => a.owner && Number(a.mutable_data?.Balance) >= 1000);
    let tried = 0;
    for (const card of cards.slice(0, 5)) {
      const reqs = runner.requirementsOf(blend23002, [card], true);
      const built = await runner.buildRunActions({ source: 'blend', actor: card.owner, id: '23002', raw: blend23002, requirements: reqs, picked: { 0: [card.asset_id] } });
      const r = await run([...await Promise.all(built.map((a) => act(a.account, a.name, card.owner, a.data)))]);
      if (resources(r)) { console.log(`   skip  ${card.owner} is out of CPU or NET: ${r.error}`); continue; }
      tried++;
      say(r.ok, `blend 23002 as ${card.owner}, card ${card.asset_id} (Balance ${card.mutable_data.Balance}): ${r.ok ? 'ACCEPTED' : `REFUSED: ${r.error}`}`);
      break;
    }
    if (!tried) console.log('   skip  blend 23002: no holder of a card with 1000 on it could be simulated');
  }

  // Upgrade 170, the asset whose template and mutable data disagree.
  const split = (await aa('assets?ids=1099947641493')).data?.[0];
  if (!split?.owner || split.mutable_data?.level !== '2') console.log('   skip  upgrade 170: asset 1099947641493 has moved on since');
  else {
    const u = await upgrades.loadUpgradeById(170);
    say(upgrades.upgradeTargetFits(u, split) === true, 'upgrade 170 read live: the matcher takes asset 1099947641493');
    const owner = split.owner;
    const fts = u.ingredients.filter((i) => i.kind === 'ft').map((i) => i.quantity);
    const total = fts.reduce((n, q) => n + Number(q.split(' ')[0]), 0);
    const bal = await client.v1.chain.get_table_rows({ code: 'up.nefty', scope: 'up.nefty', table: 'extbalances', lower_bound: owner, upper_bound: owner, key_type: 'name', limit: 1 });
    const actions = [await act('eosio.token', 'transfer', WAX_FUNDER, { from: WAX_FUNDER, to: owner, quantity: `${total.toFixed(8)} WAX`, memo: '' })];
    if (!(bal.rows[0]?.quantities ?? []).some((q) => q.quantity.endsWith(' WAX'))) actions.push(await act('up.nefty', 'openbal', owner, { owner, token_symbol: '8,WAX' }));
    for (const q of fts) actions.push(await act('eosio.token', 'transfer', owner, { from: owner, to: 'up.nefty', quantity: q, memo: 'deposit' }));
    actions.push(await act('up.nefty', 'upgrade', owner, { claimer: owner, upgrade_id: 170, transferred_assets: [], own_assets: [], assets_to_upgrade: [split.asset_id] }));
    const r = await run(actions);
    say(r.ok, `and the chain agrees: ${r.ok ? 'ACCEPTED' : `REFUSED: ${r.error}`}`);
  }
}

console.log('');
if (fails.length) {
  console.log(`=== ${fails.length} FAILURE(S) ===`);
  for (const f of fails) console.log(`   ${f}`);
  process.exit(1);
}
console.log('=== ALL ATTRIBUTE CHECKS PASS ===');
