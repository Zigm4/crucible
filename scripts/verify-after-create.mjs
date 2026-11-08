/**
 * After "Sign and create": what the creator shows, and what each way on does.
 *
 * Signing used to empty the whitelist and leave the rest of the form, the
 * review included, on screen. A drop created with its whitelist then read
 * as "only the 0 accounts on its own list", with "Sign and create" still
 * there to make it a second time (reported on northshireup's "Hype! - 400",
 * drop #239068, which the chain holds once, whitelist and all).
 *
 * Here the REAL lab module goes through it the way the screen does:
 *
 *   1. the drop as Qù Sith made it reads right: no total cap, once per
 *      wallet, the 2 whitelisted accounts, and the template's trade and
 *      burn values said to be the template's;
 *   2. once signed (the same afterSigning the button runs, minus the
 *      wallet), the screen shows what was created, as it was signed, with
 *      no way to sign it again, only "Make another like it" and "Start
 *      from scratch";
 *   3. "Make another like it" keeps every field, the whitelist too, and
 *      will not sign until something changes: each kind of change unlocks
 *      it, changing it back locks it again, and no step but the review is
 *      held back, so the author can always go and change something;
 *   4. the kept form, renamed, is a transaction the chain accepts
 *      (compute_transaction as the collection's author: never signed);
 *   5. "Start from scratch" empties every field, the collection too;
 *   6. a blend made with a new whitelist points the next one at that
 *      whitelist instead of making a copy, and is held the same way.
 */
const fails = [];
const say = (pass, msg) => { console.log(`   ${pass ? 'ok  ' : 'FAIL'} ${msg}`); if (!pass) fails.push(msg); };
let lab, sim;
try {
  lab = await import('./.build/lab.mjs');
  sim = await import('./.build/simulate.mjs');
} catch {
  console.error('Missing scripts/.build - run `npm run verify:after-create`.');
  process.exit(1);
}
const {
  __setForm, __labState, __signedAndCreated, __makeAnother, __startFromScratch, __blankForm, __unchangedCopy,
  __plainSentence, __reviewRows, __problems, __stepProblems, __emptyListDraft, __createActions, __resolveNewIds,
  renderLabPage,
} = lab;

const RPC = 'https://wax.greymass.com/v1/chain/get_table_rows';
const table = async (p) => (await (await fetch(RPC, { method: 'POST', body: JSON.stringify({ json: true, ...p }) })).json()).rows;

// The drop as it is on chain, so the form below is the one that made it.
const [row] = await table({ code: 'neftyblocksd', scope: 'neftyblocksd', table: 'drops', lower_bound: '239068', limit: 1 });
const whitelist = (await table({ code: 'neftyblocksd', scope: '239068', table: 'whitelists', limit: 100 })).map((r) => r.account);
const templateId = Number(row.assets_to_mint[0].template_id);
const tplInfo = await (await fetch(`https://wax.api.atomicassets.io/atomicassets/v1/templates/northshireup/${templateId}`)).json();
const author = (await (await fetch('https://wax.api.atomicassets.io/atomicassets/v1/collections/northshireup')).json()).data.author;
const T = tplInfo.data;
console.log(`   drop #239068 "${JSON.parse(row.display_data).name}": template ${templateId}, whitelist ${whitelist.join(', ')}, ${row.account_limit} per wallet`);

const TEMPLATE = {
  template_id: templateId, name: T.name, schema_name: T.schema.schema_name, issued: Number(T.issued_supply), max: Number(T.max_supply),
  transferable: T.is_transferable, burnable: T.is_burnable,
};
const pasted = whitelist.join('\n');
const HYPE = {
  tool: 'recipes', mode: 'create', kind: 'drop', step: 4, visited: [true, true, true, true, true],
  actor: author, collection: 'northshireup', collections: [{ collection_name: 'northshireup', name: 'northshireup' }],
  loadedFor: 'northshireup', dataState: 'done', templates: [TEMPLATE], schemas: [], securities: [],
  contractAuthorized: true, name: 'Hype! - 400', description: '', image: '',
  mints: [{ template_id: templateId, quantity: 1 }], free: true, unlimited: true, accountLimit: '1', cooldown: '',
  authRequired: true, hidden: false, priceRecipient: row.price_recipient,
  // Looked up already: the screen does it when the box is left.
  list: { ...__emptyListDraft(), addText: pasted, checkedText: pasted, checkState: 'done', missing: [] },
  newDropId: '239068', created: undefined, anotherOf: undefined, signedTxs: [], lastTx: '', lastError: '',
  dropRam: { for: 'northshireup', state: 'done', bytes: 259066, hasRow: true },
};
const S = () => __labState();
// The markup escapes quotes; read it as the eye does.
const page = () => renderLabPage().replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const hasSign = (html) => /data-lab="submit"/.test(html);
const signOff = (html) => /data-lab="submit"[^>]*disabled/.test(html);
const DUP = /This is exactly the drop "Hype! - 400" \(#239068\) you just created/;

console.log('\n=== 1. the drop reads the way it was meant ===');
__setForm(structuredClone(HYPE));
const sentence = __plainSentence();
console.log(`   "${sentence}"`);
say(/No total cap; each wallet can claim once\. Only the 2 whitelisted accounts can claim\.$/.test(sentence),
  'no total cap, once per wallet, the 2 whitelisted accounts');
say(!/as many times as players want/.test(sentence), 'it no longer says "as many times as players want"');
const rows = __reviewRows();
say(/Per wallet<\/span><b>once, never resets/.test(rows), 'the review has a Per wallet row');
const tradeWords = `${T.is_transferable ? 'tradable' : 'not tradable'}, ${T.is_burnable ? 'burnable' : 'not burnable'}`;
say(rows.includes(`${T.name}: ${tradeWords} (set on the template, not on the drop)`), `the review says the template is ${tradeWords}, and that it is the template's`);
say(/Who can claim<\/span><b>only the 2 whitelisted accounts/.test(rows), 'Who can claim: only the 2 whitelisted accounts');
__setForm({ step: 1 });
say(page().includes(`${tradeWords[0].toUpperCase()}${tradeWords.slice(1)}. Set on the template, not on this drop.`), 'step 1, under the template: its trade and burn values, the template\'s');
__setForm({ step: 3 });
const rules = page();
say(rules.includes('Only whitelisted accounts') && rules.includes('Whitelisted accounts') && rules.includes('Claims per whitelisted account'),
  'step 4 says whitelist: "Only whitelisted accounts", "Whitelisted accounts", "Claims per whitelisted account"');
say(!rules.includes('Only some accounts'), '"Only some accounts" is gone');
__setForm({ step: 4 });
say(hasSign(page()) && !signOff(page()), `before signing, "Sign and create" is there and on (problems: ${__problems().join(' | ') || 'none'})`);

console.log('\n=== 2. once signed: what was created, and no second signature ===');
__signedAndCreated(['b0b0'.repeat(16)]);
let html = page();
say(S().created && /Drop "Hype! - 400" \(#239068\) is created\./.test(html), 'it says the drop is created, with its id');
say(!hasSign(html), '"Sign and create" is gone');
say(/data-lab="make-another"/.test(html) && /data-lab="from-scratch"/.test(html), 'the two ways on are offered');
say(html.includes('Only the 2 whitelisted accounts can claim.') && !/0 accounts|Nobody is on/.test(html),
  'what it shows is what was signed: 2 whitelisted accounts, never 0');
say(!/lab-rail/.test(html), 'the steps are not on screen, so nothing can be edited under it by mistake');
say(S().list.addText === pasted, 'the whitelist is still in the form, for the next one');
say(!/data-lab="step"/.test(html), 'the step rail cannot be clicked into');

console.log('\n=== 3. Make another like it: everything kept, nothing signed twice ===');
__makeAnother();
say(!S().created && S().step === 0, 'back to the first step, the created screen gone');
say(S().name === 'Hype! - 400' && S().list.addText === pasted && S().accountLimit === '1' && S().mints.length === 1,
  'every field kept: name, whitelist, per-wallet limit, what it mints');
say(__unchangedCopy() && __problems().some((p) => DUP.test(p)), 'unchanged, it is refused: "This is exactly the drop … you just created"');
say([0, 1, 2, 3].every((i) => !__stepProblems(i).some((p) => DUP.test(p))), 'no step but the review is held: the author can go and change anything');
__setForm({ step: 4 });
html = page();
say(signOff(html) && DUP.test(html), 'on the review, "Sign and create" is off, and says why');
const unlocks = [
  ['the name', { name: 'Hype! - 500' }, { name: 'Hype! - 400' }],
  ['the whitelist', { list: { ...S().list, addText: `${pasted}\nt1cbk.wam`, checkedText: `${pasted}\nt1cbk.wam` } }, { list: { ...S().list } }],
  ['the claims per whitelisted account', { list: { ...S().list, limit: '1' } }, { list: { ...S().list } }],
  ['the per-wallet limit', { accountLimit: '2' }, { accountLimit: '1' }],
  ['what it mints', { mints: [{ template_id: templateId, quantity: 2 }] }, { mints: [{ template_id: templateId, quantity: 1 }] }],
  ['hidden or not', { hidden: true }, { hidden: false }],
  ['the price', { free: false, priceAmount: '1', priceToken: 'WAX' }, { free: true }],
  ['the total supply', { unlimited: false, maxClaimable: '400' }, { unlimited: true }],
  ['who can claim', { authRequired: false }, { authRequired: true }],
  ['who is paid', { priceRecipient: 'iwodw.wam' }, { priceRecipient: HYPE.priceRecipient }],
];
// Another wallet of the collection signing the same drop is still the same drop.
__setForm({ actor: 'zigm4.gm' });
say(__unchangedCopy(), 'signed from another wallet, the same drop is still refused');
__setForm({ actor: author });
for (const [what, change, back] of unlocks) {
  __setForm(change);
  const free = !__unchangedCopy() && !__problems().some((p) => DUP.test(p));
  __setForm(back);
  say(free && __unchangedCopy(), `changing ${what} unlocks it, changing it back locks it again`);
}

console.log('\n=== 4. the kept form, renamed, is one the chain accepts ===');
__setForm({ name: 'Hype! - 600', newDropId: '' });
await __resolveNewIds();
const acts = __createActions();
say(acts.map((a) => a.name).join(' ') === 'createdrop addtowl', `createdrop, then its whitelist again (${acts.map((a) => a.name).join(' + ')})`);
say(JSON.stringify(acts[1].data.accounts_to_add) === JSON.stringify(whitelist), `the same ${whitelist.length} accounts`);
const r = await sim.simulateActions(acts);
say(r.kind === 'accepted' || r.kind === 'resources', `compute_transaction as ${author}: ${r.kind}${r.reason ? ` (${r.reason})` : ''}`);

console.log('\n=== 5. Start from scratch: every field empty ===');
__setForm({ name: 'Hype! - 600' });
__signedAndCreated(['c0c0'.repeat(16)]);
__startFromScratch();
const blank = __blankForm();
const off = Object.keys(blank).filter((k) => JSON.stringify(S()[k]) !== JSON.stringify(blank[k]));
say(off.length === 0, `every one of the ${Object.keys(blank).length} fields is back to empty${off.length ? `; not: ${off.join(', ')}` : ''}`);
say(S().collection === '' && S().name === '' && S().mints.length === 0 && S().accountLimit === '' && S().authRequired === false,
  'the collection, the name, what it mints, the limit and the whitelist switch are empty');
say(JSON.stringify(S().list) === JSON.stringify(__emptyListDraft()), 'the whitelist draft is empty');
say(!S().created && !S().anotherOf && S().step === 0 && S().signedTxs.length === 0 && S().newDropId === '',
  'nothing left of the last one: no created screen, no guard, first step');
say(S().kind === 'drop', 'it is still a drop that is being made');
html = page();
say(/id="lab-name" type="text" value=""/.test(html) && /<option value="" selected>Choose a collection<\/option>/.test(html),
  'on screen: the name is empty and the collection is to be chosen again');

console.log('\n=== 6. a blend made with a new whitelist ===');
__setForm({
  ...structuredClone(HYPE), kind: 'blend', name: 'Forge', securityId: 'new', authRequired: false,
  ingredients: [{ kind: 'template', template_id: templateId, amount: 1, sendTo: '' }],
  outcomes: [{ kind: 'nft', template_id: templateId, weight: 1 }],
  accountLimit: '3', cooldown: '86400', maxUses: '',
  list: { ...__emptyListDraft(), addText: pasted, checkedText: pasted, checkState: 'done', missing: [], newName: 'Forge whitelist' },
  newListId: '1300',
});
console.log(`   "${__plainSentence()}"`);
say(/No total cap; each wallet can use it 3 times every day\. Only the 2 accounts on a new whitelist "Forge whitelist" can use it\.$/.test(__plainSentence()),
  'a blend says its total, its per-wallet limit with the cooldown, and its whitelist');
__signedAndCreated(['d0d0'.repeat(16)]);
say(S().securityId === '1300' && S().securities.some((x) => x.id === '1300' && x.type === 0 && x.name === 'Forge whitelist'),
  'the whitelist it made is now the one the form points at');
say(S().list.addText === '', 'its accounts are on it already, so they are not pasted again');
__makeAnother();
say(__unchangedCopy(), 'the same blend behind the same whitelist is refused');
__setForm({ name: 'Forge II' });
say(!__unchangedCopy(), 'renamed, it can be signed, behind the same whitelist');
__startFromScratch();

console.log(fails.length ? `\n=== ${fails.length} AFTER-CREATE CHECK(S) FAILED ===` : '\n=== ALL AFTER-CREATE CHECKS PASS ===');
for (const f of fails) console.log(`  - ${f}`);
process.exit(fails.length ? 1 : 0);
