/**
 * up.nefty's fixed fee: does the creator say what the chain will refuse, and
 * nothing more?
 *
 * Below level.3 of NEFTY staking, up.nefty creates an upgrade only if one of
 * its ingredients pays the fixed fee to the fee recipient, and one more
 * ingredient stands beside it. src/nefty/upgradeGate.ts states that rule and
 * the creator offers the fee line from it. Here every case goes through
 * compute_transaction (executed by a node, never signed, never written) as a
 * collection's own author, and the module's verdict must match the chain's:
 * a warning on a recipe the chain takes is as wrong as silence on one it
 * refuses.
 *
 *   pearlhorizon  never staked: the fee is due
 *   underpunks55  level.3: no fee, one line of anything
 *
 * The upgrade itself is built by the REAL lab module, so this also covers
 * what the creator's "Add the fee" button puts in the recipe.
 *
 * Run: npm run verify:upgrade-fee
 */
const fails = [];
const say = (pass, msg) => { console.log(`   ${pass ? 'ok  ' : 'FAIL'} ${msg}`); if (!pass) fails.push(msg); };
let lab, sim, gateMod;
try {
  lab = await import('./.build/lab.mjs');
  sim = await import('./.build/simulate.mjs');
  gateMod = await import('./.build/upgradeGate.mjs');
} catch {
  console.error('Missing scripts/.build - run `npm run verify:upgrade-fee`.');
  process.exit(1);
}
const RPC = 'https://wax.greymass.com';
const post = async (path, body) => (await (await fetch(`${RPC}${path}`, { method: 'POST', body: JSON.stringify(body) })).json());

/** Asks the chain, and holds the module's sentence to its answer. */
async function judge(label, gate, ingredients, actions) {
  const r = await sim.simulateActions(actions);
  if (r.kind === 'unavailable') { say(false, `${label}: no answer from the chain (${r.reason})`); return; }
  const refused = r.kind === 'refused';
  const sentence = gateMod.upgradeGateProblem(gate, ingredients);
  const agree = refused === Boolean(sentence);
  say(agree, `${label}: chain ${refused ? `refuses ("${r.reason}")` : 'accepts'}, the creator ${sentence ? 'warns' : 'says nothing'}`);
}

console.log('=== pearlhorizon, never staked: the fee is due ===');
{
  const AUTHOR = 'zigm4.gm', T = 906693;
  const gate = await gateMod.readUpgradeGate('pearlhorizon');
  say(gate.known && gate.feeRequired && gate.minIngredients === 2 && gate.feeRecipient === 'fees.nefty',
    `the gate reads level "${gate.level}", fee ${gate.fixedFee} to ${gate.feeRecipient}, required: ${gate.feeRequired}`);
  const schema = {
    schema_name: 'pearl.crew',
    format: [{ name: 'denomination', type: 'string' }, { name: 'name', type: 'string' }],
    pinned: new Map([['name', 1]]), pinnedBy: new Map([[T, new Set(['name'])]]), templateCount: 1,
  };
  const base = {
    tool: 'recipes', mode: 'create', kind: 'upgrade', actor: AUTHOR, collection: 'pearlhorizon', name: 'Fee check',
    schemas: [schema], templates: [{ template_id: T, name: 'Doubloon', schema_name: 'pearl.crew', issued: 0, max: 0 }],
    schemaName: 'pearl.crew', requirements: [], mutations: [{ attribute_name: 'denomination', op: 0, value: 'one' }],
    securityId: '', hidden: true, startTime: '', endTime: '', maxUses: '', category: '', description: '', image: '',
    newListId: '', upgradeGate: gate,
  };
  const tok = (quantity, to) => ({ kind: 'token', quantity, to });
  const fee = { kind: 'token', ...gateMod.feeLine(gate) };
  const own = tok('1.00000000 WAX', AUTHOR);
  const cases = [
    ['one line of its own, no fee', [own]],
    ['two lines, neither the fee', [own, tok('0.01000000 WAX', AUTHOR)]],
    ['half the fee, and a line', [tok('0.00500000 WAX', gate.feeRecipient), own]],
    ['the fee in NEFTY, and a line', [tok('0.01000000 NEFTY', gate.feeRecipient), own]],
    ['the fee alone', [fee]],
    ['the fee and a line (what the button makes)', [fee, own]],
    ['a line, then the fee', [own, fee]],
    ['twice the fee, and a line', [tok('0.02000000 WAX', gate.feeRecipient), own]],
  ];
  for (const [label, ingredients] of cases) {
    lab.__setForm({ ...base, ingredients });
    const asGate = ingredients.map((i) => ({ quantity: i.quantity, to: i.to }));
    await judge(label, gate, asGate, [lab.__builtAction()]);
  }
}

console.log('\n=== underpunks55, level.3: one line of anything ===');
{
  const gate = await gateMod.readUpgradeGate('underpunks55');
  say(gate.known && !gate.feeRequired && gate.minIngredients === 1, `the gate reads level "${gate.level}", fee required: ${gate.feeRequired}`);
  // Their own upgrade, re-created as it is but with other ingredients.
  let row, upper = '';
  for (let page = 0; page < 10 && !row; page++) {
    const r = await post('/v1/chain/get_table_rows', {
      json: true, code: 'up.nefty', scope: 'up.nefty', table: 'upgrades', reverse: true, limit: 500,
      ...(upper ? { upper_bound: upper } : {}),
    });
    row = r.rows.find((u) => u.collection_name === 'underpunks55');
    if (!r.rows.length) break;
    upper = String(Number(r.rows[r.rows.length - 1].upgrade_id) - 1);
  }
  if (!row) {
    console.log('   note no underpunks55 upgrade found in the recent ones, skipped');
  } else {
    const author = 'underpunks55';
    const make = (lines) => [{
      account: 'up.nefty', name: 'createupgrde', authorization: [{ actor: author, permission: 'active' }],
      data: {
        authorized_account: author, collection_name: 'underpunks55', upgrade_specs: row.upgrade_specs,
        ingredients: lines.map((l) => ['FT_INGREDIENT', { quantity: l.quantity, effect: ['TRANSFER_EFFECT', { to: l.to }] }]),
        start_time: 0, end_time: 0, max_uses: 0, display_data: JSON.stringify({ name: 'Fee check' }),
        security_id: 0, is_hidden: true, category: '',
      },
    }];
    const own = { quantity: '1.00000000 WAX', to: author };
    await judge('one line of its own, no fee', gate, [own], make([own]));
    await judge('the fee alone', gate, [gateMod.feeLine(gate)], make([gateMod.feeLine(gate)]));
  }
}

console.log(fails.length ? `\n=== ${fails.length} UPGRADE FEE CHECK(S) FAILED ===` : '\n=== ALL UPGRADE FEE CHECKS PASS ===');
for (const f of fails) console.log(`  - ${f}`);
process.exit(fails.length ? 1 : 0);
