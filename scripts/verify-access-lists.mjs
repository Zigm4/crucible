/**
 * Account lists: does every list the creator and the editor build go through?
 *
 * Who may run a blend, an upgrade or a drop is a list of accounts, kept by
 * secure.nefty for a collection or by neftyblocksd for one drop. The lab
 * writes them while creating a recipe and in Change. Here the REAL lab
 * module (scripts/.build/lab.mjs) is given a form, builds its actions, and
 * every transaction runs through compute_transaction as the collection's
 * own author: executed by a node, never signed, never written.
 *
 *   PHASE A - reading a paste: names folded, repeats counted once, what
 *             cannot be a name kept apart; plans and transaction packing.
 *   PHASE B - creating on pearlhorizon (zigm4.gm is one of its authors):
 *             a blend, an upgrade and a drop, each with its list in the
 *             same transaction; a list too long for one transaction.
 *   PHASE C - Change, on recipes that exist: a blend behind a 249-account
 *             list (bluemob4life), and pearlhorizon's protected drop.
 *   PHASE D - reading a list past the 1,000 rows one read returns.
 *
 * Live data: a recipe deleted or a list emptied since is reported, not
 * guessed around.
 *
 * Run: npm run verify:access-lists
 */
const fails = [];
const say = (pass, msg) => { console.log(`   ${pass ? 'ok  ' : 'FAIL'} ${msg}`); if (!pass) fails.push(msg); };
let lab, sim;
try {
  lab = await import('./.build/lab.mjs');
  sim = await import('./.build/simulate.mjs');
} catch {
  console.error('Missing scripts/.build - run `npm run verify:access-lists`.');
  process.exit(1);
}
const lists = await import('./.build/accessLists.mjs');
const {
  __setForm, __createActions, __editActions, __listTarget, __listPlan, __listProblems,
  __resolveNewIds, __checkListAccounts, __emptyListDraft, __warnings, renderLabPage,
} = lab;

const RPC = 'https://wax.greymass.com';
const rows = async (body) => (await (await fetch(`${RPC}/v1/chain/get_table_rows`, {
  method: 'POST', body: JSON.stringify({ json: true, ...body }),
})).json()).rows;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Simulates each transaction of a packed list. Only the first is asked: the rest add to what it makes. */
async function first(actions, label) {
  const txs = lists.packTransactions(actions);
  const r = await sim.simulateActions(txs[0]);
  const shape = actions.map((a) => `${a.account}::${a.name}`).join(' + ');
  const ok = r.kind === 'accepted' || r.kind === 'resources';
  say(ok, `${label}: ${r.kind}${r.reason ? ` (${r.reason})` : ''}${txs.length > 1 ? ` · ${txs.length} transactions` : ''}`);
  if (!ok) console.log(`        ${shape}`);
  return txs;
}

const PEARL = 'pearlhorizon', AUTHOR = 'zigm4.gm', TEMPLATE = 906693;
const PEARL_SCHEMA = {
  schema_name: 'pearl.crew',
  format: [
    ['name', 'string'], ['img', 'image'], ['video', 'string'], ['dynamic_img', 'image'],
    ['description', 'string'], ['rarity', 'string'], ['crew', 'string'], ['coin_type', 'string'],
    ['metal', 'string'], ['denomination', 'string'], ['treasure_origin', 'string'], ['is_unique', 'bool'],
  ].map(([name, type]) => ({ name, type })),
  pinned: new Map(['img', 'crew', 'name', 'metal', 'rarity', 'coin_type', 'is_unique', 'description', 'treasure_origin'].map((k) => [k, 1])),
  pinnedBy: new Map([[TEMPLATE, new Set(['img', 'crew', 'name', 'metal', 'rarity', 'coin_type', 'is_unique', 'description', 'treasure_origin'])]]),
  templateCount: 1,
};
const BASE = {
  tool: 'recipes', mode: 'create', actor: AUTHOR, collection: PEARL, name: 'List check',
  description: '', image: '', category: '', schemas: [PEARL_SCHEMA],
  templates: [{ template_id: TEMPLATE, name: 'Doubloon', schema_name: 'pearl.crew', image: undefined, issued: 0, max: 0 }],
  // pearlhorizon's only template is not transferable, which no contract takes as an ingredient.
  ingredients: [{ kind: 'token', quantity: '1.00000000 WAX', to: AUTHOR }],
  outcomes: [{ kind: 'nft', template_id: TEMPLATE, weight: 1 }],
  schemaName: 'pearl.crew', requirements: [], mutations: [{ attribute_name: 'denomination', op: 0, value: 'one' }],
  mints: [{ template_id: TEMPLATE, quantity: 1 }], free: true, priceAmount: '1', priceToken: 'WAX', tokens: [],
  priceRecipient: '', authRequired: false, maxClaimable: '10', unlimited: false,
  startTime: '', endTime: '', maxUses: '', accountLimit: '', cooldown: '', securityId: '', hidden: true,
  contractAuthorized: true, securities: [], newListId: '', newDropId: '', editing: undefined, editingOriginal: undefined,
};
/** A form with a fresh list draft, its paste already looked up. */
async function form(patch, paste = '') {
  __setForm({ ...BASE, ...patch, list: { ...__emptyListDraft(), addText: paste } });
  if (paste) await __checkListAccounts();
  await __resolveNewIds();
}

// Accounts known to exist: AtomicAssets holders, enough for a list past one transaction.
async function holders(n) {
  const out = [];
  for (let page = 1; out.length < n && page <= 5; page++) {
    const res = await (await fetch(`https://wax.api.atomicassets.io/atomicassets/v1/accounts?limit=1000&page=${page}`)).json();
    for (const a of res.data ?? []) out.push(a.account);
  }
  return out.slice(0, n);
}

console.log('=== PHASE A - reading a paste ===');
{
  const p = lists.parseAccountList('Alice.WAM, bob.gm\n@carol.wam  bob.gm;  bad_name\ntoolongaccount1 x. bob.gm');
  say(JSON.stringify(p.accounts) === '["alice.wam","bob.gm","carol.wam"]', `accounts folded and kept once: ${p.accounts.join(', ')}`);
  say(JSON.stringify(p.invalid) === '["bad_name","toolongaccount1","x."]', `what cannot be a name kept apart: ${p.invalid.join(', ')}`);
  say(p.repeated === 2, `a name typed three times is counted once (${p.repeated} repeats)`);
  const plan = lists.planListChange(['a.wam', 'b.wam'], ['b.wam', 'c.wam'], ['a.wam', 'z.wam']);
  say(plan.add.join() === 'c.wam' && plan.already.join() === 'b.wam' && plan.remove.join() === 'a.wam',
    'a plan adds the new, leaves out who is on it, takes off only members');
  const many = Array.from({ length: 4000 }, (_, i) => `acct${String(i).padStart(4, '0')}`.replace(/[06789]/g, '1'));
  const acts = [{ account: 'x', name: 'create', authorization: [], data: {} },
    ...lists.addToCollectionList(AUTHOR, PEARL, 1, many)];
  const txs = lists.packTransactions(acts);
  say(txs.length === 3 && txs[0][0].name === 'create' && txs.every((t) => t.length <= 4),
    `4,000 accounts are 8 actions of 500 in 3 transactions, creation first (${txs.map((t) => t.length).join('+')})`);
}

console.log('\n=== PHASE B - creating, with the list in the same transaction ===');
const wallets = (await holders(1700)).filter((a) => lists.isAccountName(a));
const three = wallets.slice(0, 3);
{
  await form({ kind: 'blend', securityId: 'new' }, three.join('\n'));
  const acts = __createActions();
  say(acts[0].name === 'addwhitelist' && acts[1].name === 'createblend' && acts[2].name === 'addtowl'
    && String(acts[1].data.security_id) === String(acts[2].data.security_id),
    `blend: the list, then the blend behind it (#${acts[1].data.security_id}), then its accounts`);
  await first(acts, 'blend with a new list of 3');

  await form({ kind: 'blend', securityId: 'new' });
  await first(__createActions(), 'blend with a new, empty list');
  say(__warnings().some((w) => /Nobody is on/.test(w)), 'an empty list warns that nobody can use it yet');

  // Below level.3 of NEFTY stake, up.nefty wants its fixed fee as an ingredient, sent to
  // fees.nefty, and one more besides it (refused otherwise, by simulation on 2026-10-23).
  await form({ kind: 'upgrade', securityId: 'new', ingredients: [
    { kind: 'token', quantity: '0.01000000 WAX', to: 'fees.nefty' }, { kind: 'token', quantity: '1.00000000 WAX', to: AUTHOR },
  ] }, three.slice(0, 2).join(', '));
  await first(__createActions(), 'upgrade with a new list of 2');

  await form({ kind: 'drop', authRequired: true }, three.join(' '));
  const drop = __createActions();
  say(drop[0].name === 'createdrop' && drop[0].data.auth_required === true && drop[1].name === 'addtowl'
    && drop[1].account === 'neftyblocksd', `drop: created protected, then its own list (drop #${drop[1].data.drop_id})`);
  await first(drop, 'drop with its list of 3');

  await form({ kind: 'blend', securityId: 'new' }, `${three[0]}\n${three[0].toUpperCase()}\n${three[1]}`);
  const twice = __listPlan(__listTarget());
  say(twice.add.length === 2 && twice.repeated === 1, 'an account typed twice goes on once');
  await first(__createActions(), 'blend with an account typed twice');

  await form({ kind: 'blend', securityId: 'new' }, `${three[0]}\nzzzzqqqq1111\nnot_a_name`);
  const bad = __listProblems(__listTarget()).join(' | ');
  say(/do not exist on WAX: zzzzqqqq1111/.test(bad), 'an account that does not exist blocks signing, by name');
  say(/cannot be account names: not_a_name/.test(bad), 'what cannot be an account name blocks signing, by name');

  if (wallets.length >= 1600) {
    await form({ kind: 'blend', securityId: 'new' }, wallets.slice(0, 1600).join('\n'));
    const long = __createActions();
    const txs = await first(long, 'blend with a new list of 1,600');
    say(txs.length === 2 && txs[0].some((a) => a.name === 'createblend'), 'a list of 1,600 is 2 transactions, the blend in the first');
  } else {
    console.log(`   note only ${wallets.length} holder accounts read, the long list is not tried`);
  }
}

console.log('\n=== PHASE C - Change, on recipes that exist ===');
{
  // bluemob4life blend 44526, behind its list 1295 "Whally holders Whitelist".
  const BLUE = 'bluemob4life', BLUE_AUTHOR = 'bluemobwally', LIST = '1295';
  const members = await lists.readCollectionListMembers(LIST);
  const editing = {
    // Opened: the form shows its lists only once the recipe's own row is read.
    ...lab.__BLANK_EXISTING, loaded: true,
    id: '44526', kind: 'blend', name: 'Whally blend', status: 'active', hidden: false, startTime: '', endTime: '',
    maxUses: '', accountLimit: '', cooldown: '', description: '', image: '', category: '', securityId: LIST,
    free: true, priceAmount: '', priceToken: '', authRequired: false,
  };
  const change = async (patch, draft = {}) => {
    __setForm({
      ...BASE, mode: 'edit', kind: 'blend', actor: BLUE_AUTHOR, collection: BLUE,
      securities: [{ id: LIST, name: 'Whally holders Whitelist', type: 0 }],
      editing: { ...editing, ...patch }, editingOriginal: { ...editing },
      list: { ...__emptyListDraft(), ...draft },
    });
    renderLabPage(); // reads who is on the list, as the screen does
    for (let i = 0; i < 40 && lab.__listPlan && __listTarget() && !__listPlan(__listTarget()).membersKnown; i++) await wait(250);
    if (draft.addText) await __checkListAccounts();
    await __resolveNewIds();
    return __editActions().map((c) => c.action);
  };
  if (!members.length) {
    console.log('   note list 1295 is empty now, the blend tests are skipped');
  } else {
    const fresh = wallets.filter((a) => !members.includes(a)).slice(0, 2);
    let acts = await change({}, { addText: [...fresh, members[0]].join('\n'), removing: [members[1]] });
    say(acts.length === 2 && acts[0].name === 'erasefromwl' && acts[1].name === 'addtowl'
      && acts[1].data.accounts_to_add.length === 2,
      `${members.length} on the list: a member pasted again is left out, one taken off, two added`);
    await first(acts, 'add 2 and take 1 off a shared list');

    acts = await change({}, { addText: fresh.join('\n'), clear: true });
    say(acts[0].name === 'clearwl' && acts[1].name === 'addtowl', 'starting over empties the list, then adds the paste');
    await first(acts, 'start the list over with 2');

    acts = await change({ securityId: 'new' }, { addText: fresh.join('\n'), newName: 'Second list' });
    say(acts[0].name === 'addwhitelist' && acts[1].name === 'setblendsec' && acts[2].name === 'addtowl'
      && String(acts[1].data.security_id) === String(acts[2].data.security_id),
      `moving the blend to a new list: made, pointed at (#${acts[1].data.security_id}), filled`);
    await first(acts, 'move the blend to a new list of 2');

    acts = await change({ securityId: '' });
    say(acts.length === 1 && acts[0].name === 'setblendsec' && String(acts[0].data.security_id) === '0', 'opening it to everyone is one action');
    await first(acts, 'open the blend to everyone');
  }

  // pearlhorizon drop 239019, protected, with its own list.
  const DROP = '239019';
  const onDrop = await lists.readDropListMembers(DROP);
  const dropEditing = {
    // Opened: the form shows its lists only once the recipe's own row is read.
    ...lab.__BLANK_EXISTING, loaded: true,
    id: DROP, kind: 'drop', name: 'Pearl drop', status: 'active', hidden: true, startTime: '', endTime: '',
    maxUses: '', accountLimit: '', cooldown: '', description: '', image: '', category: '', securityId: '',
    free: true, priceAmount: '', priceToken: '', authRequired: true,
  };
  const changeDrop = async (patch, draft = {}, original = {}) => {
    __setForm({
      ...BASE, mode: 'edit', kind: 'drop', actor: AUTHOR, collection: PEARL,
      editing: { ...dropEditing, ...patch }, editingOriginal: { ...dropEditing, ...original },
      list: { ...__emptyListDraft(), ...draft },
    });
    renderLabPage();
    for (let i = 0; i < 40 && __listTarget() && !__listPlan(__listTarget()).membersKnown; i++) await wait(250);
    if (draft.addText) await __checkListAccounts();
    return __editActions().map((c) => c.action);
  };
  if (!onDrop.length) {
    console.log(`   note drop ${DROP} has nobody on its list now, the drop tests are skipped`);
  } else {
    const fresh = wallets.filter((a) => !onDrop.includes(a)).slice(0, 2);
    let acts = await changeDrop({}, { addText: fresh.join(', '), removing: [onDrop[0]] });
    say(acts.length === 2 && acts[0].name === 'erasefromwl' && acts[1].name === 'addtowl',
      `drop with ${onDrop.length} on its list: one taken off, two added`);
    await first(acts, 'drop: add 2 and take 1 off');

    acts = await changeDrop({}, { addText: fresh[0], clear: true });
    say(acts.length === 2 && acts[0].data.accounts_to_remove?.length === onDrop.length && acts[1].data.accounts_to_add?.length === 1,
      'starting a drop\'s list over takes everyone off and adds the paste');
    await first(acts, 'drop: start its list over');

    acts = await changeDrop({ authRequired: false });
    say(acts.length === 1 && acts[0].name === 'setdropauth' && acts[0].data.auth_required === false,
      'opening the drop to everyone touches nothing on its list');
    await first(acts, 'drop: open to everyone');

    acts = await changeDrop({}, { addText: fresh[0] }, { authRequired: false });
    say(acts[0].name === 'setdropauth' && acts[0].data.auth_required === true && acts[1].name === 'addtowl',
      'protecting a drop comes before adding to its list');
    await first(acts, 'drop: protect it and add 1');
  }
}

console.log('\n=== PHASE D - a list past one read ===');
{
  // The longest secure.nefty list on chain when this was written: 6,426 accounts.
  const all = await lists.readCollectionListMembers('..........2f');
  say(all.length > 1000 && new Set(all).size === all.length, `${all.length} accounts read, each once (one read stops at 1,000)`);
}

console.log(fails.length ? `\n=== ${fails.length} ACCESS LIST CHECK(S) FAILED ===` : '\n=== ALL ACCESS LIST CHECKS PASS ===');
for (const f of fails) console.log(`  - ${f}`);
process.exit(fails.length ? 1 : 0);
