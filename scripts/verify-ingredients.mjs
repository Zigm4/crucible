/**
 * The ingredients the creator could not write before: NFTs of another
 * collection, NFTs matched on several attributes at once, and time gates.
 *
 * Two questions, both asked of the chain:
 *
 *   1. Change: every live blend and upgrade is read whole, and its
 *      ingredients go through the editor's own rows (lab.__editableRows):
 *      decoded, turned into rows, and accepted only when the rows write
 *      back exactly what the contract holds. Before, a recipe using one of
 *      these shapes was shown read-only; none may be now, unless something
 *      else stops it, which is counted and named.
 *
 *   2. Create: a blend with each shape is built by the REAL lab module from
 *      form state, and run through compute_transaction (executed by a node,
 *      never signed, never written) as an author of the collection: the
 *      chain must take what the form says is fine and refuse what it says
 *      is not.
 *
 * Run: npm run verify:ingredients
 */
const fails = [];
const say = (pass, msg) => { console.log(`   ${pass ? 'ok  ' : 'FAIL'} ${msg}`); if (!pass) fails.push(msg); };
let lab, sim;
try {
  lab = await import('./.build/lab.mjs');
  sim = await import('./.build/simulate.mjs');
} catch {
  console.error('Missing scripts/.build - run `npm run verify:ingredients`.');
  process.exit(1);
}
const RPC = 'https://wax.greymass.com';
const ATOMIC = 'https://wax.api.atomicassets.io';
const post = async (path, body) => (await (await fetch(`${RPC}${path}`, { method: 'POST', body: JSON.stringify(body) })).json());
const atomic = async (path) => (await (await fetch(`${ATOMIC}${path}`, { headers: { 'User-Agent': 'crucible-verify' } })).json()).data;

/** A whole table, paged by its primary key. */
async function readAll(code, table, key) {
  const out = [];
  let lower = '';
  for (let page = 0; page < 80; page++) {
    const r = await post('/v1/chain/get_table_rows', { json: true, code, scope: code, table, limit: 1000, lower_bound: lower });
    out.push(...r.rows);
    if (!r.more) break;
    lower = String(Number(r.rows[r.rows.length - 1][key]) + 1);
  }
  return out;
}

/** Which of the three shapes a recipe uses. */
function shapes(r) {
  const out = new Set();
  for (const [type, d] of r.ingredients ?? []) {
    if (d && 'collection_name' in d && d.collection_name !== r.collection_name) out.add('another collection');
    if (type === 'ATTRIBUTE_INGREDIENT' && d.attributes.length > 1) out.add('several attributes');
    if (type === 'COOLDOWN_INGREDIENT') out.add('a time gate');
  }
  return out;
}

console.log('=== Change: every live recipe, through the editor\'s rows ===');
for (const [code, table, key] of [['blend.nefty', 'blends', 'blend_id'], ['up.nefty', 'upgrades', 'upgrade_id']]) {
  const rows = await readAll(code, table, key);
  let editable = 0, newly = 0;
  const why = new Map();
  const stillRefused = [];
  for (const r of rows) {
    lab.__setForm({ collection: r.collection_name, foreign: {} });
    const res = lab.__editableRows(r.ingredients, r.collection_name);
    const used = shapes(r);
    if ('rows' in res) {
      editable++;
      if (used.size) newly++;
    } else {
      why.set(res.why, (why.get(res.why) ?? 0) + 1);
      if (/another collection|several attributes|time gate/.test(res.why)) stillRefused.push(`${r[key]}: ${res.why}`);
    }
  }
  console.log(`   ${table}: ${rows.length} read, ${editable} editable, ${newly} of them only now`);
  for (const [w, n] of [...why].sort((a, b) => b[1] - a[1])) console.log(`        ${n} not: ${w}`);
  say(stillRefused.length === 0, `${table}: none is refused for another collection, several attributes or a time gate${stillRefused.length ? ` (${stillRefused.slice(0, 3).join('; ')})` : ''}`);
  say(newly > 0, `${table}: ${newly} recipes using these shapes now edit, each written back exactly as it is`);
}

console.log('\n=== Create: each shape, built by the form and asked of the chain ===');
const BASE = {
  tool: 'recipes', mode: 'create', kind: 'blend', name: 'Ingredient check', description: '', image: '', category: '',
  schemaName: '', requirements: [], mutations: [], mints: [], outcomes: [], securityId: '', hidden: true,
  startTime: '', endTime: '', maxUses: '', accountLimit: '', cooldown: '', newListId: '', contractAuthorized: true,
  ingFrom: '', ingFromDraft: '', ingFromOpen: false, foreign: {}, tokens: [],
};
async function judge(label, form, wantAccepted, wantProblem) {
  lab.__setForm({ ...BASE, ...form });
  const problems = lab.__problems();
  const built = lab.__builtAction();
  const r = await sim.simulateActions([built]);
  if (r.kind === 'unavailable') { say(false, `${label}: no answer from the chain (${r.reason})`); return; }
  const accepted = r.kind !== 'refused';
  say(accepted === wantAccepted, `${label}: chain ${accepted ? 'accepts' : `refuses ("${r.reason}")`}`);
  if (wantProblem) say(problems.some((p) => wantProblem.test(p)), `${label}: the form says ${problems.find((p) => wantProblem.test(p)) ?? `nothing about it (${problems.join(' | ') || 'no problem'})`}`);
  else say(problems.length === 0, `${label}: the form finds nothing to fix${problems.length ? ` (${problems.join(' | ')})` : ''}`);
  return built;
}

// pearlhorizon, authored by zigm4.gm: its one template is the outcome.
const PEARL = { actor: 'zigm4.gm', collection: 'pearlhorizon', outcomes: [{ kind: 'nft', template_id: 906693, weight: 1 }] };
const pearlSchemas = (await atomic('/atomicassets/v1/schemas?collection_name=pearlhorizon&limit=10')).map((s) => ({
  schema_name: s.schema_name, format: s.format, pinned: new Map(), pinnedBy: new Map(), templateCount: 1,
}));
const pearlTemplates = [{ template_id: 906693, name: 'Doubloon', schema_name: 'pearl.crew', issued: 0, max: 0 }];
{
  // Another collection: a template real blends already ask for (blend #50 of 1bitcoinlive takes cryptosoltan's).
  const [b50] = (await post('/v1/chain/get_table_rows', { json: true, code: 'blend.nefty', scope: 'blend.nefty', table: 'blends', lower_bound: '50', upper_bound: '50', limit: 1 })).rows;
  const foreign = b50.ingredients.find(([t, d]) => t === 'TEMPLATE_INGREDIENT' && d.collection_name !== b50.collection_name)[1];
  const built = await judge(`an NFT of ${foreign.collection_name} (template ${foreign.template_id}) burned for pearlhorizon's Doubloon`, {
    ...PEARL, schemas: pearlSchemas, templates: pearlTemplates,
    ingredients: [{ kind: 'template', template_id: foreign.template_id, amount: 1, sendTo: '', collection: foreign.collection_name }],
  }, true);
  say(built?.data.ingredients[0][1].collection_name === foreign.collection_name, `the ingredient names ${built?.data.ingredients[0][1].collection_name}, not pearlhorizon`);
  say(/from cryptosoltan|from /.test(lab.__plainSentence()), `the sentence says where it comes from: "${lab.__plainSentence().slice(0, 110)}"`);
}
{
  const built = await judge('pearl.crew NFTs matched on two attributes at once', {
    ...PEARL, schemas: pearlSchemas, templates: pearlTemplates,
    ingredients: [{ kind: 'attribute', schema_name: 'pearl.crew', amount: 1, sendTo: '',
      attributes: [{ attribute_name: 'denomination', values: 'one | two' }, { attribute_name: 'name', values: 'Doubloon' }] }],
  }, true);
  const a = built?.data.ingredients[0][1].attributes ?? [];
  say(a.length === 2 && a[0].allowed_values.length === 2 && a[1].allowed_values[0] === 'Doubloon', `both attributes are in the ingredient: ${JSON.stringify(a)}`);
  await judge('the same attribute named twice', {
    ...PEARL, schemas: pearlSchemas, templates: pearlTemplates,
    ingredients: [{ kind: 'attribute', schema_name: 'pearl.crew', amount: 1, sendTo: '',
      attributes: [{ attribute_name: 'name', values: 'A' }, { attribute_name: 'name', values: 'B' }] }],
  }, true, /same attribute twice/);
}
{
  // A time gate needs a uint64 attribute; uncutnefties' betsy.base has one ("Last Claim Time"), as its
  // blend #37724 uses. Asked as the collection's author: compute_transaction checks no signature.
  const author = (await atomic('/atomicassets/v1/collections/uncutnefties')).author;
  const schemas = (await atomic('/atomicassets/v1/schemas?collection_name=uncutnefties&limit=50')).map((s) => ({
    schema_name: s.schema_name, format: s.format, pinned: new Map(), pinnedBy: new Map(), templateCount: 1,
  }));
  const [t] = await atomic('/atomicassets/v1/templates?ids=641626');
  const templates = [{ template_id: 641626, name: t.name, schema_name: t.schema.schema_name, issued: 0, max: 0 }];
  // An NFT for the result: a blend paying tokens must first be funded by the collection (below).
  const UNCUT = { actor: author, collection: 'uncutnefties', schemas, templates, maxUses: '1000',
    outcomes: [{ kind: 'nft', template_id: 641626, weight: 1 }] };
  await judge('a blend paying tokens with no total number of uses', { ...UNCUT, maxUses: '',
    outcomes: [{ kind: 'token', quantity: '0.00000001 WAX', contract: 'eosio.token', weight: 1 }],
    ingredients: [{ kind: 'cooldown', template_id: 641626, schema_name: 'betsy.base', attribute_name: 'Last Claim Time', wait: '3600', requirements: [] }],
  }, false, /needs a total number of uses/);
  const built = await judge(`a time gate on ${t.name}: one blend per hour, timed by "Last Claim Time"`, {
    ...UNCUT,
    ingredients: [{ kind: 'cooldown', template_id: 641626, schema_name: 'betsy.base', attribute_name: 'Last Claim Time', wait: '3600',
      requirements: [{ attribute_name: 'Artifact', values: '$RJUAN Miner' }] }],
  }, true);
  const c = built?.data.ingredients[0];
  say(c?.[0] === 'COOLDOWN_INGREDIENT' && c[1].wait_time === 3600 && c[1].requirements[0].allowed_values[0] === '$RJUAN Miner',
    `the ingredient is the contract's own shape: ${JSON.stringify(c)}`);
  await judge('a time gate timed by "Artifact", a string', { ...UNCUT,
    ingredients: [{ kind: 'cooldown', template_id: 641626, schema_name: 'betsy.base', attribute_name: 'Artifact', wait: '3600', requirements: [] }],
  }, false, /keeps the time in a uint64 attribute/);
  await judge('a time gate of 0 seconds', { ...UNCUT,
    ingredients: [{ kind: 'cooldown', template_id: 641626, schema_name: 'betsy.base', attribute_name: 'Last Claim Time', wait: '0', requirements: [] }],
  }, true, /whole number of seconds/);
  lab.__setForm({ ...BASE, ...UNCUT, kind: 'upgrade', ingredients: [{ kind: 'cooldown', template_id: 641626, schema_name: 'betsy.base', attribute_name: 'Last Claim Time', wait: '60', requirements: [] }] });
  say(lab.__problems().some((p) => /Only a blend can have a time gate/.test(p)), 'an upgrade with a time gate is stopped before the chain: up.nefty has none');
}

console.log(fails.length ? `\n=== ${fails.length} FAILED ===` : '\n=== ALL INGREDIENT CHECKS PASS ===');
process.exit(fails.length ? 1 : 0);
