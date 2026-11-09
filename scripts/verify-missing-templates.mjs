/**
 * verify-missing-templates.mjs: "templates I don't own", and sending a
 * selection.
 *
 * On somebody else's wallet, My NFTs can keep only the NFTs whose template
 * the connected wallet does not hold, on top of every other filter. And
 * NFTs can be picked, then sent as a link that opens on those NFTs alone.
 * This checks, with no network (fetch is answered here):
 *
 *   1. the comparison: what it keeps, what it waits for, where it does
 *      nothing, and that the other filters and the facet counts follow it;
 *   2. reading your templates: only the collections on screen, once, and
 *      nothing at all when the page already read your wallet;
 *   3. picks: adding, removing, picking everything shown, the cap;
 *   4. the link: the comparison and the picks survive it, a selection
 *      opens on the picks whatever the filters say, a saved view leaves
 *      the picks out;
 *   5. the screen: the switch at the top of the filters, the discs, the
 *      dock, and what a selection link opens on.
 */
const fails = [];
const say = (pass, msg) => { console.log(`   ${pass ? 'ok  ' : 'FAIL'} ${msg}`); if (!pass) fails.push(msg); };

// ── the indexer, answered here ──────────────────────────────────────────
const asked = [];
const WALLETS = {};
const reply = (data) => ({ ok: true, status: 200, json: async () => ({ success: true, data }) });
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  asked.push(u.pathname + u.search);
  const acct = u.pathname.match(/\/atomicassets\/v1\/accounts\/([^/]+)$/);
  if (acct) {
    const who = decodeURIComponent(acct[1]);
    if (who === 'broken.wam') return reply({});
    const only = (u.searchParams.get('collection_whitelist') ?? '').split(',').filter(Boolean);
    const rows = (WALLETS[who] ?? [])
      .filter((a) => a.template && (!only.length || only.includes(a.collection.collection_name)))
      .map((a) => ({ template_id: a.template.template_id, collection_name: a.collection.collection_name, assets: '1' }));
    const uniq = [...new Map(rows.map((r) => [r.template_id, r])).values()];
    return reply({ templates: uniq, collections: [], assets: String(rows.length) });
  }
  if (u.pathname === '/atomicassets/v1/assets') {
    const page = Number(u.searchParams.get('page') ?? '1');
    return reply(page === 1 ? (WALLETS[u.searchParams.get('owner')] ?? []) : []);
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

let inv, lab;
try {
  inv = await import('./.build/inventory.mjs');
  lab = await import('./.build/lab.mjs');
} catch (e) {
  console.error('Missing scripts/.build - run `npm run verify:missing-templates`.', e.message);
  process.exit(1);
}

let nextId = 1099512000000n;
const nft = (owner, collection, template, name) => ({
  asset_id: String(nextId++), owner, name: name ?? `${collection} ${template ?? 'one-off'}`,
  collection: { collection_name: collection, name: collection },
  schema: { schema_name: 'items' },
  template: template ? { template_id: String(template) } : null,
  data: { name: name ?? `${collection} ${template}`, rarity: Number(template) % 2 ? 'Rare' : 'Common' },
});

// Their wallet: two collections, one NFT without a template.
const THEM = 'friend.wam';
const ME = 'zigm4.gm';
const theirs = [
  nft(THEM, 'pearlhorizon', 101), nft(THEM, 'pearlhorizon', 101), nft(THEM, 'pearlhorizon', 102),
  nft(THEM, 'pearlhorizon', 103), nft(THEM, 'underpunks55', 201), nft(THEM, 'underpunks55', 202),
  nft(THEM, 'underpunks55', null, 'a one-off'),
];
// Mine: 101 and 201, and a collection they do not have.
const mine = [nft(ME, 'pearlhorizon', 101), nft(ME, 'underpunks55', 201), nft(ME, 'cigalepixeld', 301)];
WALLETS[THEM] = theirs;
WALLETS[ME] = mine;

const loaded = (patch = {}) => ({
  ...inv.emptyInventoryState(), owner: THEM, ownerDraft: THEM, loadedFor: THEM, assets: theirs, ...patch,
});
const read = (templates, patch = {}) => ({ for: ME, wallet: THEM, templates: new Set(templates), state: 'done', error: '', ...patch });
const tplOf = (list) => list.map((a) => a.template?.template_id ?? '-');

console.log('\n=== 1. the comparison ===');
let st = loaded({ missingOnly: true });
say(inv.applyFilter(theirs, st).length === theirs.length, 'on, but your templates not read yet: everything shows');
st = loaded({ missingOnly: true, mine: read(['101', '201']) });
let kept = inv.applyFilter(theirs, st);
say(JSON.stringify(tplOf(kept)) === JSON.stringify(['102', '103', '202']), `once read: only the templates you do not hold (${tplOf(kept).join(', ')})`);
say(!kept.some((a) => !a.template), 'an NFT without a template is left out: there is nothing to compare');
st = loaded({ missingOnly: true, mine: read(['101', '201']), q: 'pearlhorizon' });
say(JSON.stringify(tplOf(inv.applyFilter(theirs, st))) === '["102","103"]', 'and the search narrows it further');
st = loaded({ missingOnly: true, mine: read(['101', '201']), exclude: { template: ['103'] } });
say(JSON.stringify(tplOf(inv.applyFilter(theirs, st))) === '["102","202"]', 'and so does hiding a value');
st = loaded({ missingOnly: true, mine: read(['101', '201']) });
const tplFacet = inv.facetsOf(theirs, st).find((f) => f.key === 'template');
say(tplFacet && !tplFacet.values.some((v) => v.value === '101' || v.value === '201'),
  'the template filter offers only what is left, so its counts are what a click gives');
st = loaded({ owner: ME, loadedFor: ME, missingOnly: true, mine: read(['101'], { wallet: ME }) });
say(!inv.comparing(st) && inv.applyFilter(theirs, st).length === theirs.length, 'on your own wallet it compares nothing and hides nothing');
st = loaded({ missingOnly: true, mine: read(['101', '201'], { wallet: 'other.wam' }) });
say(!inv.comparing(st), 'templates read for another wallet are not applied to this one');
const c = inv.missingCounts(theirs, new Set(['101', '201']));
say(c.templates === 3 && c.nfts === 3 && c.untemplated === 1, `what it finds is counted: ${c.templates} templates, ${c.nfts} NFTs, ${c.untemplated} without a template`);
st = loaded({ missingOnly: true });
say(inv.activeFilterCount(st) === 1, 'it counts as a filter');
inv.clearFilters(st);
say(!st.missingOnly, 'and Reset turns it off');

console.log('\n=== 2. reading your templates ===');
asked.length = 0;
let got = await inv.loadOwnedTemplates(ME, ['pearlhorizon', 'underpunks55']);
say(asked.length === 1 && /collection_whitelist=pearlhorizon%2Cunderpunks55/.test(asked[0]) && asked[0].startsWith(`/atomicassets/v1/accounts/${ME}`),
  'one request, about the collections on screen only');
say(got.has('101') && got.has('201') && !got.has('301'), 'and what comes back is your templates in those collections');
asked.length = 0;
got = await inv.loadOwnedTemplates(ME, ['pearlhorizon']);
say(asked.length === 0, 'a collection already asked about is not asked again');
await inv.loadOwnedTemplates(ME, ['pearlhorizon', 'cigalepixeld']);
say(asked.length === 1 && /collection_whitelist=cigalepixeld$/.test(asked[0]), 'a new one is asked about alone');
let threw = '';
try { await inv.loadOwnedTemplates('broken.wam', ['pearlhorizon']); } catch (e) { threw = e.message; }
say(/did not list/.test(threw), 'an answer with no list is an error, never "holds nothing"');
inv.forgetOwnedTemplates();
const meFull = inv.emptyInventoryState();
await inv.loadInventory(meFull, ME);
asked.length = 0;
got = await inv.loadOwnedTemplates(ME, ['pearlhorizon', 'underpunks55', 'anything']);
say(asked.length === 0 && got.has('301'), 'once the page has read your wallet in full, nothing is asked at all');
inv.forgetOwnedTemplates();

console.log('\n=== 3. picks ===');
st = loaded();
const [a1, a2, a3] = theirs;
inv.togglePick(st, a1.asset_id); inv.togglePick(st, a2.asset_id);
say(JSON.stringify(st.picked) === JSON.stringify([a1.asset_id, a2.asset_id]), 'a click picks, in the order picked');
inv.togglePick(st, a1.asset_id);
say(JSON.stringify(st.picked) === JSON.stringify([a2.asset_id]), 'a second click lets it go');
st.pickedOnly = true;
inv.togglePick(st, a2.asset_id);
say(!st.picked.length && !st.pickedOnly, 'letting the last one go leaves "only these" too');
inv.togglePickAll(st, [a1.asset_id, a2.asset_id, a3.asset_id]);
say(st.picked.length === 3, 'pick all takes every one');
inv.togglePickAll(st, [a1.asset_id, a2.asset_id, a3.asset_id]);
say(st.picked.length === 0, 'and pressed again with all of them picked, lets them all go');
const many = Array.from({ length: inv.MAX_PICKS + 40 }, (_, i) => String(1099600000000n + BigInt(i)));
inv.togglePickAll(st, many);
say(st.picked.length === inv.MAX_PICKS, `a selection stops at ${inv.MAX_PICKS}, the most one link can carry`);

console.log('\n=== 4. the link ===');
const ids = [a1.asset_id, '18446744073709551615', a3.asset_id];
const packed = inv.packIds(ids);
say(JSON.stringify(inv.unpackIds(packed)) === JSON.stringify(ids), 'asset ids survive the link, a 64-bit one included');
say(packed.length < ids.join(',').length * 0.75, `and take less room: ${packed.length} characters for ${ids.join(',').length}`);
say(JSON.stringify(inv.unpackIds(`${packed}.not!valid..${inv.packIds([a1.asset_id])}`)) === JSON.stringify(ids), 'a mangled part is skipped and a repeat kept once');
st = loaded({ missingOnly: true, picked: [a1.asset_id, a3.asset_id], pickedOnly: true });
let enc = inv.encodeInventoryView(st);
let back = inv.emptyInventoryState();
inv.decodeInventoryView(enc, back);
say(back.missingOnly && back.pickedOnly && JSON.stringify(back.picked) === JSON.stringify([a1.asset_id, a3.asset_id]),
  'the comparison, the picks and "only these" all come back from the link');
say(!/pick=|only=/.test(inv.encodeInventoryView(st, { picks: false })) && /missing=1/.test(inv.encodeInventoryView(st, { picks: false })),
  'a saved view keeps the comparison and leaves the picks out');
back = inv.emptyInventoryState();
inv.decodeInventoryView('only=1', back);
say(!back.pickedOnly, '"only these" with nothing picked is not an empty screen');
st = loaded({ q: 'underpunks55', include: { template: ['202'] }, missingOnly: true, mine: read(['101', '201']),
  picked: [a1.asset_id, a3.asset_id], pickedOnly: true });
kept = inv.applyFilter(theirs, st);
say(kept.length === 2 && kept.every((a) => st.picked.includes(a.asset_id)),
  'a selection shows its picks whatever the filters say, picks made under other filters included');
// Reading another wallet lets the selection go; refreshing the same one keeps it.
const sw = loaded({ picked: [a1.asset_id], pickedOnly: true });
await inv.loadInventory(sw, THEM, true);
say(sw.picked.length === 1 && sw.pickedOnly, 'refreshing the same wallet keeps the selection');
await inv.loadInventory(sw, ME);
say(!sw.picked.length && !sw.pickedOnly, 'reading another wallet lets it go');

console.log('\n=== 5. the screen ===');
// Nothing known about your wallet, so the screen has to ask. A forced
// read empties the page's NFT cache, your full read from section 2 too.
await inv.loadInventory(inv.emptyInventoryState(), THEM, true);
inv.forgetOwnedTemplates();
const { __setForm, renderLabPage, embedLab } = lab;
embedLab(() => {});
const unq = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const show = (patch, actor = ME) => { __setForm({ tool: 'inventory', actor, inv: loaded(patch) }); return unq(renderLabPage()); };
let html = show({});
const railAt = html.indexOf('inv-rail-body');
const switchAt = html.indexOf('inv-compare-toggle');
const firstFacet = html.indexOf('inv-facet-head');
say(switchAt > railAt && switchAt < firstFacet, 'the switch is at the top of the filters, above the first facet');
say(/Templates I don't own/.test(html) && /aria-pressed="false"/.test(html), 'and off until it is turned on');
html = show({}, '');
say(/inv-compare off/.test(html) && /data-lab="login"/.test(html) && /Connect your wallet/.test(html), 'with no wallet connected: what it needs, and a way to connect');
html = show({ owner: ME, loadedFor: ME, ownerDraft: ME });
say(!/inv-compare/.test(html), 'on your own wallet it is not offered');
asked.length = 0;
html = show({ missingOnly: true });
say(/Reading which of these templates zigm4\.gm holds/.test(html) && /Everything shows until they are in/.test(html),
  'turned on: it says it is reading, and that nothing is hidden meanwhile');
await new Promise((r) => setTimeout(r, 20));
say(asked.some((q) => q.startsWith(`/atomicassets/v1/accounts/${ME}?collection_whitelist=`)), 'and it asks the indexer about your wallet');
html = unq(renderLabPage());
say(/3 templates here that zigm4\.gm does not hold, on 3 NFTs\. 1 NFT without a template is left out\./.test(html),
  'once read, it says what it found');
say(/class="inv-on mine "[^>]*data-lab="inv-missing"[\s\S]*?templates I don't own<\/span>\s*<span class="inv-on-x"/.test(html),
  'and it shows as a filter that can be taken off');
say(/<strong>3<\/strong> of\s+7 NFTs/.test(html), 'the count is what is left: 3 of 7');
__setForm({ inv: loaded({ missingOnly: true, mine: read(['101', '102', '103', '201', '202']) }) });
html = unq(renderLabPage());
say(/zigm4\.gm already holds every template in this wallet/.test(html), 'when you hold them all, it says so instead of "loosen a filter"');

__setForm({ actor: '', inv: loaded({ missingOnly: true, mine: read(['101', '201']) }) });
html = unq(renderLabPage());
say(/<strong>7<\/strong> of\s+7 NFTs/.test(html) && !lab.__labState().inv.mine.for,
  'after a disconnect, the templates read for the wallet that left stop filtering');

html = show({ selecting: true });
say((html.match(/data-lab="inv-pick" /g) ?? []).length === theirs.length && !/data-lab="inv-open"/.test(html), 'while picking, a click on a card picks it rather than opening it');
say((html.match(/class="inv-check"/g) ?? []).length === theirs.length, 'every card shows the disc');
say(/class="inv-dock"/.test(html) && /Tap an NFT to pick it/.test(html) && /Pick all 7/.test(html), 'the dock is up, says what to do, and offers to pick all 7');
html = show({ picked: [a1.asset_id, a3.asset_id] });
say(/<b>2<\/b> picked/.test(html) && /data-lab="share-selection"/.test(html) && /Show only these/.test(html), 'with picks: their count, "Show only these" and the link to them');
say((html.match(/inv-card\s+picked/g) ?? []).length === 2 && /data-lab="inv-open"/.test(html), 'the picked cards stay marked after picking, and open as usual');
html = show({ picked: [a1.asset_id, a3.asset_id, '1099599999999'], pickedOnly: true, q: 'nothing matches this' });
say(/A selection from friend\.wam/.test(html) && /<b>2<\/b> NFTs picked/.test(html), 'a selection link opens on the picks, the search set aside');
say(/1 picked NFT is no longer in this wallet/.test(html), 'and says when a picked NFT has left the wallet');
say(!/inv-rail-body/.test(html) && !/id="inv-q"/.test(html), 'no search and no filters on that screen: it is the picks');
html = show({ selecting: true, picked: many.slice(0, inv.MAX_PICKS - 3) });
say(/Pick the first 3</.test(html), 'near the cap, "pick all" says how many it will really take');
html = show({ selecting: true, picked: many.slice(0, inv.MAX_PICKS) });
say(!/data-lab="inv-pick-all"/.test(html), 'at the cap, it is not offered');
html = show({ picked: many.slice(0, inv.MAX_PICKS) });
say(/Discord cuts a message at 2,000/.test(html) && /the most one link can carry/.test(html), 'a selection too long to paste in Discord says so before it is copied');
html = show({ picked: [a1.asset_id] });
say(!/Discord cuts/.test(html), 'a short one does not');

console.log(`\n=== ${fails.length ? `${fails.length} MISSING-TEMPLATE CHECK(S) FAILED` : 'ALL MISSING-TEMPLATE CHECKS PASS'} ===`);
process.exit(fails.length ? 1 : 0);
