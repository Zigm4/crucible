/**
 * After a signature: the page stays put, and says what happened.
 *
 * Signing with Anchor on an iPhone sent people to the home page, with no
 * word on what they had signed. The wallet comes back to the page with an
 * address of its own (#Ab12Cd34) that the router did not know, so it drew
 * the home. And the only confirmation was one line by the button.
 *
 * Here the REAL modules go through it:
 *
 *   1. the wallet's return address is told apart from every address the
 *      two routers use, so it moves nothing;
 *   2. a page reloaded while the wallet was open finds what was being
 *      signed, and only at the address the wallet comes back to;
 *   3. creating a recipe opens the confirmation: what was made, its
 *      transaction, the way to Explore, and closing shows the created
 *      screen (Make another / Start from scratch);
 *   4. running a recipe opens it too, and closing goes back where the
 *      player came from (Explore, their NFTs) or to that kind of recipe
 *      in the collection; a draw still landing keeps them on the recipe,
 *      and shows in it as it lands;
 *   5. saving a change goes back to the collection's list, read again;
 *   6. the markup itself: the waxblock links, and the "cannot tell" box.
 *
 * Nothing is signed: the confirmations are built from the screen the way
 * the buttons build them once a wallet has answered.
 */
const fails = [];
const say = (pass, msg) => { console.log(`   ${pass ? 'ok  ' : 'FAIL'} ${msg}`); if (!pass) fails.push(msg); };
let lab, popup, ret, guided;
try {
  lab = await import('./.build/lab.mjs');
  popup = await import('./.build/signedPopup.mjs');
  ret = await import('./.build/walletReturn.mjs');
  guided = await import('./.build/guidedRun.mjs');
} catch (e) {
  console.error('Missing scripts/.build - run `npm run verify:signed-popup`.', e.message);
  process.exit(1);
}
const { __setForm, __labState, __signedAndCreated, __makeAnother, __emptyListDraft, __runNotice, __savedNotice,
  __backToRecipeList, __mintedNotice, embedLab, renderLabPage } = lab;
const { signedNotice, signedMarkup, closeSigned } = popup;
const { isWalletReturn, returnedSignature } = ret;
const S = () => __labState();
const page = () => renderLabPage().replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const TX = 'c0ffee'.repeat(10) + 'beef';

console.log('\n=== 1. the wallet\'s return address moves nothing ===');
// WharfKit's generateReturnUrl on an iPhone or an iPad: "#" and eight of these.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const wharf = () => '#' + Array.from({ length: 8 }, () => ALPHABET[Math.floor(Math.random() * 62)]).join('');
const made = Array.from({ length: 1000 }, wharf);
say(made.every(isWalletReturn), `1000 return addresses made the way WharfKit makes them are all recognised (e.g. ${made[0]})`);
const routes = [
  '', '#', '#/', '#/create', '#/use', '#/use/drop', '#/use/drop~northshireup~239068', '#/explore', '#/explore/pearlhorizon',
  '#/nfts/zigm4.gm', '#/names/rekt', '#/stake', '#/stake/zigm4.gm', '#/guide/drops', '#/status/blend.nefty',
  '#/lab/names/rekt', '#/catalog/pearlhorizon', '#/nefty/blend/43444', '#/waxdao/blends', '#nefty', '#waxdao',
  '#blenderizer', '#status', '#catalog', '#lab', '#/nefty/stake', '#Ab12Cd3', '#Ab12Cd345', '#Ab12-d34',
];
const taken = routes.filter(isWalletReturn);
say(!taken.length, `none of the ${routes.length} addresses the routers use is mistaken for one${taken.length ? `: ${taken.join(', ')}` : ''}`);

console.log('\n=== 2. a page reloaded while the wallet was open ===');
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const BACK = 'https://zigm4.github.io/crucible/#Ab12Cd34';
const note = { version: 1, returnUrl: BACK, transactionId: TX, actor: 'zigm4.gm', permission: 'active', chainId: 'x', callback: {}, expiresAt: new Date(Date.now() + 60_000).toISOString() };
say(returnedSignature(BACK) === undefined, 'no note from the wallet: nothing to say');
store.set('wharfkit:anchor-transaction-handoff', JSON.stringify(note));
const found = returnedSignature(BACK);
say(found?.transactionId === TX && found?.actor === 'zigm4.gm', 'at the address the wallet comes back to, the transaction it was signing is found');
say(returnedSignature('https://zigm4.github.io/crucible/#Zz99Yy88') === undefined, 'at another return address, nothing (an older signature is not this one)');
say(returnedSignature('https://zigm4.github.io/crucible/#/create') === undefined, 'at an ordinary address, nothing');
say(returnedSignature('https://zigm4.github.io/crucible/backup/#Ab12Cd34') === undefined, 'on the other page, nothing');
store.set('wharfkit:anchor-transaction-handoff', '{not json');
say(returnedSignature(BACK) === undefined, 'a note that is not readable is ignored, never a crash');
delete globalThis.localStorage;

console.log('\n=== 3. creating a recipe ===');
const RPC = 'https://wax.greymass.com/v1/chain/get_table_rows';
const table = async (p) => (await (await fetch(RPC, { method: 'POST', body: JSON.stringify({ json: true, ...p }) })).json()).rows;
const [row] = await table({ code: 'neftyblocksd', scope: 'neftyblocksd', table: 'drops', lower_bound: '239068', limit: 1 });
const whitelist = (await table({ code: 'neftyblocksd', scope: '239068', table: 'whitelists', limit: 100 })).map((r) => r.account);
const templateId = Number(row.assets_to_mint[0].template_id);
const T = (await (await fetch(`https://wax.api.atomicassets.io/atomicassets/v1/templates/northshireup/${templateId}`)).json()).data;
const author = (await (await fetch('https://wax.api.atomicassets.io/atomicassets/v1/collections/northshireup')).json()).data.author;
const pasted = whitelist.join('\n');
const HYPE = {
  tool: 'recipes', mode: 'create', kind: 'drop', step: 4, visited: [true, true, true, true, true],
  actor: author, collection: 'northshireup', collections: [{ collection_name: 'northshireup', name: 'northshireup' }],
  loadedFor: 'northshireup', dataState: 'done', schemas: [], securities: [], contractAuthorized: true,
  templates: [{ template_id: templateId, name: T.name, schema_name: T.schema.schema_name, issued: Number(T.issued_supply), max: Number(T.max_supply), transferable: T.is_transferable, burnable: T.is_burnable }],
  name: 'Hype! - 400', description: '', image: '', mints: [{ template_id: templateId, quantity: 1 }], free: true, unlimited: true,
  accountLimit: '1', cooldown: '', authRequired: true, hidden: false, priceRecipient: row.price_recipient,
  list: { ...__emptyListDraft(), addText: pasted, checkedText: pasted, checkState: 'done', missing: [] },
  newDropId: '239068', created: undefined, anotherOf: undefined, signedTxs: [], lastTx: '', lastError: '',
  dropRam: { for: 'northshireup', state: 'done', bytes: 259066, hasRow: true },
};
// The classic page first: there the collection's page is the catalogue.
__setForm(structuredClone(HYPE));
__signedAndCreated([TX]);
let n = signedNotice();
say(n?.other?.href === '#/catalog/northshireup' && n.other.label === 'Open northshireup in the catalogue', 'on the classic page, the way on is the catalogue');
closeSigned();
// The site: the lab inside v2.
let from = '';
embedLab(() => {}, () => from);
__setForm(structuredClone(HYPE));
__signedAndCreated([TX]);
n = signedNotice();
console.log(`   "${n?.title}"`);
say(n?.id === 'created' && n.title === 'Drop "Hype! - 400" (#239068) is created', 'the confirmation opens on its own, named with the drop\'s id');
say(n?.lines?.[0] === S().created.sentence && /Only the 2 whitelisted accounts can claim\.$/.test(n.lines[0]), 'it says what was created, the same sentence as the review');
say(n?.lines?.[1] === 'Players can see it now.', 'and that players see it');
say(n?.txs?.length === 1 && n.txs[0] === TX, 'with its transaction');
say(n?.other?.href === '#/explore/northshireup' && n.other.label === 'Open northshireup in Explore', 'and the way to it in Explore');
const markup = signedMarkup(n).replace(/&quot;/g, '"');
say(markup.includes(`href="https://waxblock.io/transaction/${TX}"`) && markup.includes('View on waxblock'), 'the box links the transaction on waxblock');
say(markup.includes(`data-copy="${TX}"`) && markup.includes(`${TX.slice(0, 10)}…${TX.slice(-6)}`), 'and shows its ends, with the whole id to copy');
say(markup.includes('id="signed-close"') && markup.includes('>Close<'), 'and closes with "Close"');
closeSigned();
say(!signedNotice(), 'closing takes it away');
let html = page();
say(/data-lab="make-another"/.test(html) && /data-lab="from-scratch"/.test(html) && /is created\./.test(html),
  'under it, the created screen: what was made, Make another like it, Start from scratch');
__makeAnother();
__setForm({ name: 'Hype! - 401', hidden: true, lastError: 'Transaction 2 of 2: the chain would refuse it: x. The 1 before it are signed. It exists: the rest of the whitelist can be added from Change.' });
__signedAndCreated([TX, '']);
n = signedNotice();
say(n?.lines?.[1] === 'It is hidden: players do not see it until you reveal it from Change.' && !n.other, 'a hidden one says it is hidden, and offers no Explore link to an empty page');
say(/It exists: the rest of the whitelist can be added from Change\./.test(n?.warn ?? ''), 'what did not go through is said in the box');
say(n?.txs?.filter(Boolean).length === 1, 'only the transactions that exist are linked');
closeSigned();

console.log('\n=== 4. running a recipe ===');
globalThis.location = { hash: '#/use/drop~northshireup~239068', href: 'https://zigm4.github.io/crucible/#/use/drop~northshireup~239068' };
const run = (extra) => {
  __setForm({ tool: 'run', run: { ...guided.emptyRunState(), action: 'drop', source: 'drop', collection: 'northshireup', blendId: '239068', step: 4, lastTrxId: TX, ...extra } });
  return S().run;
};
const what = { name: 'Hype! - 400', summary: ['you pay 1 WAX'], later: false };
let r = run();
from = '';
n = __runNotice(what);
say(n.title === 'Drop claimed' && n.lines[0] === 'Hype! - 400, in northshireup.' && n.lines[1] === 'Signed: you pay 1 WAX.',
  `it says what was claimed and what it cost: "${n.title}", "${n.lines[0]}", "${n.lines[1]}"`);
say(n.txs[0] === TX, 'with its transaction');
const label = (x) => (typeof x.close.label === 'function' ? x.close.label() : x.close.label);
say(label(n) === 'Back to the drops of northshireup', `arrived by the steps or a link, closing goes to the collection's drops: "${label(n)}"`);
say(n.other?.label === 'Stay on this recipe' && !n.other.hidden?.(), 'or stays on the recipe, for another claim');
n.close.go();
say(r.step === 3 && r.listing, 'closing goes to that list, read again since the claim changed it');
r = run({ collection: '' });
n = __runNotice(what);
n.close.go();
say(r.step === 2 && label(n) === 'Back to the drops', 'without a collection known, it goes to the question that asks for one');
for (const [prev, want, why] of [
  ['#/explore/pearlhorizon', 'Back to pearlhorizon in Explore', 'from a collection in Explore, back there'],
  ['#/explore', 'Back to Explore', 'from Explore, back to Explore'],
  ['#/nfts/zigm4.gm~q=hype', 'Back to your NFTs', 'from their NFTs, back to them'],
  ['#/', 'Back to the drops of northshireup', 'from the home, to the drops (the home is not where the drop was)'],
]) {
  run(); from = prev;
  n = __runNotice(what);
  location.hash = '#/use/drop~northshireup~239068';
  n.close.go();
  const went = prev.startsWith('#/explore') || prev.startsWith('#/nfts') ? location.hash === prev : S().run.step === 3;
  say(label(n) === want && went, `${why}: "${label(n)}"`);
}
from = '';
r = run({ action: 'blend', source: 'blend' });
n = __runNotice({ name: 'Rare roll', summary: ['3 NFTs leave your wallet'], later: true });
say(n.title === 'Blend signed' && n.lines.filter(Boolean).length === 2, 'a random blend is "signed", not yet "blended": the draw comes after');
r.finish = { kind: 'blend', phase: 'waiting', message: 'The WAX oracle draws the result and mints it to your wallet, usually within a few seconds.' };
let live = n.live();
say(/Drawing/.test(live) && /oracle draws the result/.test(live), 'while the draw is out, the box says so');
say(label(n) === 'Close' && n.other.hidden(), 'and closing stays on the recipe, where the draw goes on');
r.step = 4;
n.close.go();
say(S().run.step === 4, 'closing then did not leave the recipe');
r.finish = { kind: 'blend', phase: 'ready', message: 'The result is drawn and waiting to be claimed. One more signature mints it.', pending: { kind: 'blend', id: '1', recipe: '1', drawn: [1], ready: true } };
live = n.live();
say(/data-signed="finish-claim"/.test(live) && /Claim the result/.test(live), 'a result waiting to be claimed gets its button in the box');
r.finish = { kind: 'blend', phase: 'done', message: 'Minted: 1 NFT on the way to your wallet.', txId: 'ab'.repeat(32) };
live = n.live();
say(/Minted: 1 NFT/.test(live) && live.includes(`https://waxblock.io/transaction/${'ab'.repeat(32)}`), 'once minted, the box says so, with the second transaction');
say(label(n) === 'Back to the blends of northshireup' && !n.other.hidden(), 'and closing goes back to the blends again');
r = run({ action: 'unpack', source: 'pack' });
n = __runNotice({ name: 'Starter pack', summary: ['1 NFT leave your wallet'], later: true });
say(n.title === 'Pack sent to be opened', 'a pack is "sent to be opened": the cards are drawn after');
const m = __mintedNotice('Minted: 5 NFTs on the way to your wallet.', TX);
say(m.title === 'Minted' && m.txs[0] === TX, 'a second signature on its own gets its own box, "Minted"');
delete globalThis.location;

console.log('\n=== 5. saving a change ===');
__setForm({
  tool: 'recipes', mode: 'edit', kind: 'drop', collection: 'northshireup', actor: author,
  editing: { id: '239068', kind: 'drop', name: 'Hype! - 400', status: 'live', hidden: false, startTime: '', endTime: '' },
  signedTxs: [TX], lastTx: TX, lastError: '',
});
n = __savedNotice(['Start time: now', 'Hidden: no']);
say(n.title === 'Drop "Hype! - 400" (#239068) is saved', `named with its id: "${n.title}"`);
say(/<li>Start time: now<\/li><li>Hidden: no<\/li>/.test(n.html), 'it lists what changed');
say(n.close.label === 'Back to the drops of northshireup' && n.other?.label === 'Keep editing it', 'closing goes to the collection\'s drops, or stays on the drop');
__backToRecipeList();
html = page();
say(!S().editing && !S().lastTx && S().existingState === 'loading', 'back on the list, read again');
say(!/Deleted\./.test(html), 'and the list does not say "Deleted." about a save');

console.log('\n=== 6. the box itself ===');
const lost = signedMarkup({ tone: 'unknown', title: 'Not sent: the page was reloaded', lines: ['a', 'b'], txs: [TX], close: { label: 'Close' } });
say(/seal-card unknown/.test(lost) && /NOT CONFIRMED/.test(lost) && /seal-dot/.test(lost) && !/SIGNED ON WAX/.test(lost)
  && /Look it up on waxblock/.test(lost),
  'when Crucible cannot tell, the box says so: a question-mark seal, "Not confirmed", and "Look it up on waxblock"');
const fine = signedMarkup({ title: 't', txs: [TX], close: { label: 'Close' } });
say(/SIGNED ON WAX/.test(fine) && /Signed and sent/.test(fine) && !/seal-dot/.test(fine), 'and a signature that went through carries the check seal');
const two = signedMarkup({ title: 't', txs: [TX, 'ab'.repeat(32)], close: { label: 'Close' } });
say(/Transaction 1 of 2/.test(two) && /Transaction 2 of 2/.test(two) && (two.match(/View on waxblock/g) ?? []).length === 2,
  'several transactions: one row each, numbered, each with its link');
const sneaky = signedMarkup({ title: '<img src=x onerror=alert(1)>', lines: ['<b>x</b>'], txs: [TX], close: { label: '<i>' } });
say(!/<img|<b>|<i>/.test(sneaky), 'a recipe name with markup in it is shown as text, never run');

console.log(`\n=== ${fails.length ? `${fails.length} SIGNED POPUP CHECK(S) FAILED` : 'ALL SIGNED POPUP CHECKS PASS'} ===`);
process.exit(fails.length ? 1 : 0);
