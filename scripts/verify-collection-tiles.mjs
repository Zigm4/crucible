/**
 * verify-collection-tiles.mjs: "which collection?" answered with tiles.
 *
 * The run tool's step 2 and Explore's picker listed collections as small
 * outlined badges with a number. They are now tiles with the collection's
 * picture and full name (collectionTiles.ts). This checks, with no DOM and
 * no network:
 *
 *   1. a tile: its face once known, its initial until then, the count of
 *      NFTs held, and a name with markup in it shown as text;
 *   2. what a tile is: a button the run tool already listens to, or a link;
 *   3. the run tool's step 2: the collections in the wallet first, with
 *      their counts, then the suggestions that are not already among them.
 *
 * Faces are seeded from NFTs, the way the page learns them, so nothing
 * here asks the indexer.
 */
const fails = [];
const say = (pass, msg) => { console.log(`   ${pass ? 'ok  ' : 'FAIL'} ${msg}`); if (!pass) fails.push(msg); };
let tiles, lab, guided;
try {
  tiles = await import('./.build/collectionTiles.mjs');
  lab = await import('./.build/lab.mjs');
  guided = await import('./.build/guidedRun.mjs');
} catch (e) {
  console.error('Missing scripts/.build - run `npm run verify:collection-tiles`.', e.message);
  process.exit(1);
}
const { learnFaces, renderTiles, tileGroup } = tiles;
const unq = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

const IMG = 'QmZXVMo47uR5NYutR3Mhqu5fW3LvKoyZZyob78hh5JSoke';
const nft = (c, name, img, id) => ({ asset_id: String(id), owner: 'zigm4.gm', collection: { collection_name: c, name, img } });
const pick = (name) => ({ lab: 'run-collection-pick', value: name });

console.log('\n=== 1. a tile ===');
let html = renderTiles([{ name: 'nofacehere1' }], { data: pick });
say(/class="ctile-initial">N</.test(html) && !/ctile-handle/.test(html) && !/data-media/.test(html),
  'before its face is known: the initial, the account name as the title, no picture');
learnFaces([nft('pearlhorizon', 'PEARL Horizon', IMG, 1), nft('underpunks55', 'The Underpunks RPG', '', 2)]);
html = unq(renderTiles([{ name: 'pearlhorizon', count: 12 }], { data: pick }));
say(/ctile-title">PEARL Horizon</.test(html) && /ctile-handle">pearlhorizon</.test(html), 'once known: its full name, with the account under it');
say((html.match(new RegExp(IMG, 'g')) ?? []).length >= 2, 'its picture, on the face and blurred behind the tile');
say(/<b>12<\/b><small>NFTs<\/small>/.test(html) && !/ctile-go/.test(html), 'a collection in the wallet says how many of its NFTs you hold');
html = renderTiles([{ name: 'underpunks55', count: 1 }], { data: pick });
say(/<small>NFT<\/small>/.test(html) && !/data-media/.test(html), 'one NFT is "NFT"; a collection without a picture keeps its initial');
html = renderTiles([{ name: 'cigalepixeld' }], { data: pick });
say(/ctile-go/.test(html) && !/ctile-count/.test(html), 'a suggestion has an arrow, not a count');
learnFaces([nft('evilcoll', '<img src=x onerror=alert(1)>', '', 3)]);
html = renderTiles([{ name: 'evilcoll' }], { data: pick });
say(!/<img src=x/.test(html) && /&lt;img/.test(html), 'a collection name with markup in it is shown as text, never run');
const a = renderTiles([{ name: 'pearlhorizon' }], { data: pick });
const b = renderTiles([{ name: 'pearlhorizon' }], { data: pick });
say(a.match(/--hue:(\d+)/)?.[1] === b.match(/--hue:(\d+)/)?.[1], 'the colour a name gives it is the same every time');

console.log('\n=== 2. what a tile is ===');
html = unq(renderTiles([{ name: 'pearlhorizon', on: true }], { data: pick }));
say(/<button type="button" class="ctile on"/.test(html) && /data-lab="run-collection-pick"/.test(html) && /data-value="pearlhorizon"/.test(html)
  && /aria-pressed="true"/.test(html), 'in the run tool: a button with the pick the tool already listens to, the chosen one pressed');
html = renderTiles([{ name: 'pearlhorizon' }], { href: (n) => `#/explore/${n}` });
say(/<a class="ctile" [^>]*href="#\/explore\/pearlhorizon"/.test(html), 'in Explore: a link to the collection');
say(/ctiles-head"><span>In your wallet<\/span><small>2 collections<\/small>/.test(tileGroup('In your wallet', '2 collections', '')), 'a group says what it holds');

console.log('\n=== 3. the run tool\'s step 2 ===');
const { __setForm, renderLabPage, embedLab } = lab;
embedLab(() => {});
const assets = [
  ...Array.from({ length: 5 }, (_, i) => nft('pearlhorizon', 'PEARL Horizon', IMG, 10 + i)),
  ...Array.from({ length: 2 }, (_, i) => nft('legionoftag1', 'Legion of Tag', '', 20 + i)),
  // Every suggestion's face is known, so the page has nothing to ask the indexer.
  nft('underpunks55', 'The Underpunks RPG', '', 30),
];
learnFaces([nft('cigalepixeld', 'Cigale Pixel', '', 40), nft('northshireup', 'Northshire', '', 41)]);
__setForm({ tool: 'run', run: { ...guided.emptyRunState(), action: 'drop', step: 2, assets } });
html = unq(renderLabPage());
const wallet = html.indexOf('In your wallet');
const others = html.indexOf('Or start with one of these');
say(wallet > 0 && others > wallet, 'the collections in your wallet come first, then the suggestions');
say(/In your wallet<\/span><small>3 collections<\/small>/.test(html), 'and the group counts them');
const yours = html.slice(wallet, others);
say(/PEARL Horizon[\s\S]*<b>5<\/b>[\s\S]*Legion of Tag[\s\S]*<b>2<\/b>/.test(yours), 'most held first, each with its count');
const rest = html.slice(others);
say(!/data-value="underpunks55"/.test(rest) && /data-value="cigalepixeld"/.test(rest) && /data-value="northshireup"/.test(rest),
  'a suggestion already in the wallet is not offered twice');
say(!/collection-chip|class="lab-tag" data-lab="run-collection-pick"/.test(html), 'and no outlined badge is left');
__setForm({ run: { ...guided.emptyRunState(), action: 'drop', step: 2, assets: [] } });
html = unq(renderLabPage());
say(!/In your wallet/.test(html) && /Start with one of these/.test(html) && /Connect a wallet and the collections you hold show here too/.test(html),
  'with no wallet: the suggestions alone, and how to get your own');

console.log(`\n=== ${fails.length ? `${fails.length} COLLECTION TILE CHECK(S) FAILED` : 'ALL COLLECTION TILE CHECKS PASS'} ===`);
process.exit(fails.length ? 1 : 0);
