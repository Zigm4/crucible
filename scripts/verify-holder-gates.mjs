/**
 * Holder gates: does every rule the creator and Change build go through,
 * and does the editor refuse what the chain would?
 *
 * A holder gate lets in whoever holds what its rule names (NFTs of a
 * template, a schema or a collection, or a token). secure.nefty keeps them
 * for a collection's blends and upgrades, neftyblocksd for one drop. Here the
 * REAL lab module builds every transaction, and each goes through
 * compute_transaction as the collection's own author: executed by a node,
 * never signed, never written.
 *
 *   PHASE A - the rule's shape: written and read back alike, and what the
 *             contracts refuse is said before signing.
 *   PHASE B - creating on pearlhorizon (zigm4.gm is one of its authors):
 *             a blend and an upgrade behind a new gate, a drop with a list
 *             and a rule, a drop list with a per-account claim limit.
 *   PHASE C - Change, on recipes that exist: captainshelm's blends behind
 *             their shared gate #1153, and pearlhorizon's drop #239019.
 *   PHASE D - the gate list: who uses what, and deleting an unused gate.
 *
 * Run: npm run verify:holder-gates
 */
const fails = [];
const say = (pass, msg) => { console.log(`   ${pass ? 'ok  ' : 'FAIL'} ${msg}`); if (!pass) fails.push(msg); };
let lab, sim, gates, gateMod;
try {
  lab = await import('./.build/lab.mjs');
  sim = await import('./.build/simulate.mjs');
  gates = await import('./.build/holderGates.mjs');
  gateMod = await import('./.build/upgradeGate.mjs');
} catch {
  console.error('Missing scripts/.build - run `npm run verify:holder-gates`.');
  process.exit(1);
}
const {
  __setForm, __createActions, __editActions, __ensureRule, __ruleProblems, __resolveNewIds, __emptyListDraft,
  __checkListAccounts, __loadEditing, __editingState, __ensureGates, __whoCanUseIt, __BLANK_EXISTING, renderLabPage,
} = lab;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = async (body) => (await (await fetch('https://wax.greymass.com/v1/chain/get_table_rows', {
  method: 'POST', body: JSON.stringify({ json: true, ...body }),
})).json()).rows;
const authorOf = async (c) => (await (await fetch(`https://wax.api.atomicassets.io/atomicassets/v1/collections/${c}`)).json()).data?.author;

async function simulate(label, actions) {
  const r = await sim.simulateActions(actions);
  const ok = r.kind === 'accepted' || r.kind === 'resources';
  say(ok, `${label}: ${actions.map((a) => a.name).join(' + ')} · ${r.kind}${r.reason ? ` (${r.reason})` : ''}`);
}
/** Lets the rule a screen reads arrive, as a render would. */
async function settle() {
  for (let i = 0; i < 40; i++) {
    renderLabPage();
    const r = __ensureRule();
    if (r.state !== 'loading' && !__ruleProblems().some((p) => /^Reading/.test(p))) return r;
    await wait(250);
  }
  return __ensureRule();
}

const PEARL = 'pearlhorizon', ME = 'zigm4.gm', T = 906693;
const PEARL_SCHEMA = {
  schema_name: 'pearl.crew', format: [{ name: 'denomination', type: 'string' }, { name: 'name', type: 'string' }],
  pinned: new Map([['name', 1]]), pinnedBy: new Map([[T, new Set(['name'])]]), templateCount: 1,
};
const BASE = {
  tool: 'recipes', mode: 'create', actor: ME, collection: PEARL, name: 'Holder check', description: '', image: '', category: '',
  schemas: [PEARL_SCHEMA], templates: [{ template_id: T, name: 'Doubloon', schema_name: 'pearl.crew', issued: 0, max: 0 }],
  ingredients: [{ kind: 'token', quantity: '1.00000000 WAX', to: ME }], outcomes: [{ kind: 'nft', template_id: T, weight: 1 }],
  schemaName: 'pearl.crew', requirements: [], mutations: [{ attribute_name: 'denomination', op: 0, value: 'one' }],
  mints: [{ template_id: T, quantity: 1 }], free: true, priceAmount: '1', priceToken: 'WAX', tokens: [], priceRecipient: '',
  authRequired: false, maxClaimable: '10', unlimited: false, startTime: '', endTime: '', maxUses: '', accountLimit: '',
  cooldown: '', securityId: '', hidden: true, contractAuthorized: true, securities: [], newListId: '', newDropId: '',
  editing: undefined, editingOriginal: undefined, upgradeGate: undefined,
};
const fresh = (patch) => {
  __setForm({ ...BASE, ...patch, list: { ...__emptyListDraft(), ...(patch.list ?? {}) }, rule: { for: '__none__', state: 'idle', group: { any: false, rules: [] }, original: '', on: false, name: '', readOnly: '', error: '' } });
};

console.log('=== PHASE A - the rule\'s shape ===');
{
  const g = { any: true, rules: [
    { kind: 'template', collection: PEARL, template_id: T, amount: 2, more: false },
    { kind: 'schema', collection: PEARL, schema_name: 'pearl.crew', amount: 1, more: true },
    { kind: 'collection', collection: 'alien.worlds', amount: 3, more: false },
    { kind: 'token', contract: 'eosio.token', amount: '10.00000000 WAX', op: 5 },
  ] };
  const enc = gates.encodeGroup(g);
  const back = gates.decodeGroup(JSON.parse(JSON.stringify(enc)));
  say(JSON.stringify(back) === JSON.stringify(g), 'a rule of all four holdings reads back as written');
  say(enc.filters[3][1].token_symbol === '8,WAX' && enc.logical_operator === 1, 'the token symbol comes from the amount, "any" is 1');
  say(gates.decodeGroup({ logical_operator: 0, filters: [['TEMPLATE_HOLDINGS', { collection_name: 'x', template_id: 1, comparison_operator: 0, amount: 1 }]] }) === undefined,
    'a rule the editor cannot offer ("exactly" on NFTs) is not decoded, so it is never rewritten');
  const bad = gates.groupProblems({ any: false, rules: [{ kind: 'template', collection: PEARL, template_id: T, amount: 0, more: false }, { kind: 'token', contract: '', amount: '10 WAX', op: 3 }] });
  say(bad.length === 2 && bad.some((p) => /at least 1/.test(p)) && bad.some((p) => /contract/.test(p)), `refused before signing: ${bad.join(' | ')}`);
  say(gates.groupProblems({ any: false, rules: [] }).length === 1, 'a rule with nothing to hold is refused');
}

console.log('\n=== PHASE B - creating on pearlhorizon ===');
{
  fresh({ kind: 'blend', securityId: 'new-holders' });
  await __resolveNewIds();
  const r = await settle();
  say(r.group.rules.length === 1 && r.group.rules[0].kind === 'template', 'a new holder gate starts with one template holding');
  r.name = 'Doubloon holders';
  const acts = __createActions();
  say(acts[0].name === 'addproofown' && acts[1].name === 'createblend' && String(acts[1].data.security_id) === String(lab.__editingState && (await rows({ code: 'secure.nefty', scope: 'secure.nefty', table: 'counters' })).find((c) => c.counter_name === 'security').counter_value),
    `the gate, then the blend behind it (#${acts[1].data.security_id})`);
  say(/whoever holds at least 1 Doubloon/.test(__whoCanUseIt()), `the review says: ${__whoCanUseIt()}`);
  await simulate('blend behind a new holder gate', acts);

  const gate = await gateMod.readUpgradeGate(PEARL);
  fresh({ kind: 'upgrade', securityId: 'new-holders', upgradeGate: gate, ingredients: [
    { kind: 'token', quantity: '0.01000000 WAX', to: 'fees.nefty' }, { kind: 'token', quantity: '1.00000000 WAX', to: ME }] });
  await __resolveNewIds();
  (await settle()).group.rules = [{ kind: 'token', contract: 'eosio.token', amount: '5.00000000 WAX', op: 3 }];
  await settle();
  await simulate('upgrade behind a new gate holding 5 WAX', __createActions());

  fresh({ kind: 'upgrade', securityId: 'new-holders', upgradeGate: gate });
  await __resolveNewIds();
  (await settle()).group.rules = [{ kind: 'token', contract: 'eosio.token', amount: '5.0000 WAX', op: 3 }];
  const dec = (await settle(), __ruleProblems());
  say(dec.some((p) => /has 8 decimals/.test(p)), `a token amount at the wrong precision is refused: ${dec.find((p) => /decimals/.test(p))}`);

  fresh({ kind: 'drop', authRequired: true, list: { addText: 'zigm4.gm\nlijb4.wam' } });
  await __checkListAccounts();
  await __resolveNewIds();
  const dr = await settle();
  dr.on = true;
  dr.group.rules = [{ kind: 'template', collection: PEARL, template_id: T, amount: 1, more: false }];
  const drop = __createActions();
  say(drop.map((a) => a.name).join(' ') === 'createdrop addtowl setproofown', `drop: ${drop.map((a) => a.name).join(' + ')}`);
  await simulate('drop with a list and a holder rule', drop);
  say(/on its own list, or whoever holds/.test(__whoCanUseIt()), `the review says: ${__whoCanUseIt()}`);

  // Ticked, then the drop opened to everyone: the rule must not go, and must not block.
  fresh({ kind: 'drop', authRequired: true });
  await __resolveNewIds();
  const left = await settle();
  left.on = true;
  left.group.rules = [];
  __setForm({ authRequired: false });
  const open = __createActions().map((a) => a.name).join(' + ');
  say(open === 'createdrop' && __ruleProblems().length === 0, `a rule left ticked on a drop opened to everyone is dropped: ${open}`);

  fresh({ kind: 'drop', authRequired: true, list: { addText: 'zigm4.gm', limit: '2' } });
  await __checkListAccounts();
  await __resolveNewIds();
  await settle();
  const lim = __createActions();
  say(lim[1]?.name === 'addtowlwlim' && lim[1].data.accounts_to_add[0].limit === 2, 'a claim limit adds through addtowlwlim');
  await simulate('drop list with a claim limit of 2', lim);
}

console.log('\n=== PHASE C - Change, on recipes that exist ===');
{
  // captainshelm: blends behind the shared holder gate #1153 "Helmsman's Token".
  const CAP = 'captainshelm';
  const author = await authorOf(CAP);
  const securities = (await rows({ code: 'secure.nefty', scope: CAP, table: 'security', limit: 50 })).map((r) => ({ id: String(r.id), name: r.name, type: Number(r.type) }));
  const picked = { ...__BLANK_EXISTING, id: '45800', kind: 'blend', name: 'blend 45800', status: '' };
  __setForm({ ...BASE, mode: 'edit', kind: 'blend', actor: author, collection: CAP, securities, templates: [], schemas: [],
    editing: { ...picked }, editingOriginal: { ...picked }, list: __emptyListDraft(), lastError: '' });
  await __loadEditing(picked);
  const { editing } = __editingState();
  say(editing?.securityId === '1153', `blend 45800 opens behind gate #${editing?.securityId}`);
  const r = await settle();
  say(r.on && r.group.rules.length > 0 && !r.readOnly, `its rule is read and editable: ${gates.describeGroup(r.group)}`);
  for (let i = 0; i < 80 && __ensureGates().state === 'loading'; i++) await wait(500);
  const g = __ensureGates();
  say((g.users['1153'] ?? []).includes('blend #45762'), `the gate is shared: ${(g.users['1153'] ?? []).join(', ')}`);
  say(__editActions().length === 0, 'opened and untouched, nothing to sign');
  r.group.rules[0].amount += 1;
  const set = __editActions().map((c) => c.action);
  say(set.length === 1 && set[0].name === 'setproofown', 'one more to hold rewrites the gate in place');
  await simulate('rewrite the shared rule', set);
  r.group.rules[0].amount -= 1;

  editing.securityId = 'new-holders';
  await __resolveNewIds();
  const nr = await settle();
  nr.group.rules = [{ kind: 'collection', collection: CAP, amount: 1, more: false }];
  const move = __editActions().map((c) => c.action);
  say(move.map((a) => a.name).join(' ') === 'addproofown setblendsec' && String(move[1].data.security_id) !== '1153',
    `moving the blend to a new gate: ${move.map((a) => a.name).join(' + ')} (#${move[1]?.data.security_id})`);
  await simulate('move the blend to a new holder gate', move);

  // pearlhorizon drop #239019, protected, with a list and no rule.
  const dropPicked = { ...__BLANK_EXISTING, id: '239019', kind: 'drop', name: 'drop', status: '' };
  __setForm({ ...BASE, mode: 'edit', kind: 'drop', actor: ME, collection: PEARL, editing: { ...dropPicked }, editingOriginal: { ...dropPicked }, list: __emptyListDraft(), lastError: '' });
  await __loadEditing(dropPicked);
  const d = await settle();
  say(!d.on && !d.original, 'drop #239019 has no holder rule yet');
  d.on = true;
  d.group.rules = [{ kind: 'template', collection: PEARL, template_id: T, amount: 1, more: false }];
  const add = __editActions().map((c) => c.action);
  say(add.length === 1 && add[0].name === 'setproofown', 'ticking "Also let in holders" sets its rule');
  await simulate('give the drop a holder rule', add);
}

console.log('\n=== PHASE D - the gate list ===');
{
  // A collection with several gates, some unused: find one, then delete it in simulation.
  for (const c of ['bluemob4life', 'captainshelm']) {
    const author = await authorOf(c);
    const securities = (await rows({ code: 'secure.nefty', scope: c, table: 'security', limit: 50 })).map((r) => ({ id: String(r.id), name: r.name, type: Number(r.type) }));
    __setForm({ ...BASE, mode: 'edit', actor: author, collection: c, securities, editing: undefined, gates: { for: '', state: 'idle', users: {}, counts: {}, rules: {}, deletable: {}, error: '' } });
    for (let i = 0; i < 80 && __ensureGates().state !== 'done' && __ensureGates().state !== 'error'; i++) await wait(500);
    const g = __ensureGates();
    if (g.state !== 'done') { say(false, `${c}: its gates could not be read (${g.error})`); continue; }
    const unused = securities.filter((s) => !(g.users[s.id] ?? []).length);
    const used = securities.filter((s) => (g.users[s.id] ?? []).length);
    console.log(`   ${c}: ${securities.length} gates, ${used.length} in use, ${unused.length} unused`);
    for (const s of used.slice(0, 1)) {
      if (s.type === 0) {
        const r = await sim.simulateActions([gates.buildDeleteList(author, c, s.id)]);
        say(r.kind === 'refused', `deleting the list #${s.id} a blend uses is refused by the chain (${r.reason}), and not offered`);
      }
    }
    for (const s of unused) {
      const why = g.deletable[s.id];
      const actions = s.type === 0 ? [gates.buildDeleteList(author, c, s.id)] : gates.buildDeleteHolderGate(author, c, s.id);
      const r = await sim.simulateActions(actions);
      // Offered exactly when the chain accepts: a button that fails is as wrong as a missing one.
      say((why === '') === (r.kind !== 'refused'), `#${s.id} of ${c}: chain ${r.kind}${r.reason ? ` (${r.reason})` : ''}, ${why === '' ? 'delete offered' : `not offered: ${why}`}`);
    }
  }
}

console.log(fails.length ? `\n=== ${fails.length} HOLDER GATE CHECK(S) FAILED ===` : '\n=== ALL HOLDER GATE CHECKS PASS ===');
for (const f of fails) console.log(`  - ${f}`);
process.exit(fails.length ? 1 : 0);
