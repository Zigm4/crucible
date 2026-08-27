/**
 * The two lab tools added for testing: the inventory, and the guided
 * recipe runner.
 *
 * Neither signs anything, so the bar is different from the contract
 * suites: nothing here can cost somebody tokens. What it CAN do is tell
 * somebody something false. "You have 0, 4 short" on a recipe they can
 * afford, a filter that quietly drops rows it should keep, or a stored
 * preference that turns out to carry a wallet name. Those are what this
 * checks.
 *
 *   PHASE A - filtering and faceting, against a real wallet's NFTs.
 *   PHASE B - progressive refinement: the property the whole tool rests
 *             on, that narrowing the search narrows the facets with it.
 *   PHASE C - the URL round trip, since a shared link has to reproduce
 *             the sender's screen exactly.
 *   PHASE D - sorting, including the two cases a naive sort gets wrong:
 *             64 bit ids and numeric-looking attributes.
 *   PHASE E - the storage boundary. The one that matters: prefs must
 *             accept choices and refuse everything else.
 *   PHASE F - the runner's requirement matcher, against a live blend.
 *
 * As everywhere in this repo, this imports the SHIPPED modules rather
 * than reimplementing them.
 */
let inv, prefs, run, blendMod;
try {
  inv = await import('./.build/inventory.mjs');
  prefs = await import('./.build/prefs.mjs');
  run = await import('./.build/guidedRun.mjs');
  blendMod = await import('./.build/blend.mjs').catch(() => null);
} catch (e) {
  console.error('Missing scripts/.build - run `npm run build:verify`.', e.message);
  process.exit(1);
}

const fails = [];
const say = (pass, msg) => { console.log(`   ${pass ? 'ok  ' : 'FAIL'} ${msg}`); if (!pass) fails.push(msg); };

/** A real wallet, so the shapes are the ones the tool will actually meet. */
const OWNER = 'underpunks55';

async function atomic(path) {
  const r = await fetch(`https://wax.api.atomicassets.io${path}`);
  const d = await r.json();
  return d.data;
}

function freshState(patch = {}) {
  return { ...inv.emptyInventoryState(), ...patch };
}

/** One table read, for the handful of facts this suite checks directly. */
async function rpcTableRows(params) {
  const r = await fetch('https://wax.greymass.com/v1/chain/get_table_rows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ json: true, limit: 100, ...params }),
  });
  if (!r.ok) throw new Error(`get_table_rows ${r.status}`);
  return (await r.json()).rows ?? [];
}

async function main() {
  console.log('=== PHASE A - filtering and faceting on a real inventory ===');
  const assets = await atomic(`/atomicassets/v1/assets?owner=${OWNER}&limit=1000`);
  say(Array.isArray(assets) && assets.length > 200,
      `${assets.length} real NFTs pulled for ${OWNER}`);

  const all = freshState();
  say(inv.applyFilter(assets, all).length === assets.length,
      'an empty filter keeps everything');

  // Free text has to reach past the name, or the search is the same one
  // people already complained about.
  const bySchema = assets[0]?.schema?.schema_name ?? '';
  const hitSchema = inv.applyFilter(assets, freshState({ q: bySchema }));
  say(hitSchema.length > 0 && hitSchema.every((a) => JSON.stringify(a).toLowerCase().includes(bySchema.toLowerCase())),
      `free text reaches the schema field: "${bySchema}" matches ${hitSchema.length}`);

  const anId = assets[0].asset_id;
  say(inv.applyFilter(assets, freshState({ q: anId })).some((a) => a.asset_id === anId),
      'free text finds an asset by its id');

  // Every word must narrow. A search that ORs its words gets wider as you
  // type, which is the opposite of what typing more means.
  const two = `${bySchema} ${assets[0]?.collection?.collection_name ?? ''}`;
  say(inv.applyFilter(assets, freshState({ q: two })).length <= hitSchema.length,
      'adding a word never widens the result');

  const facets = inv.facetsOf(assets, all);
  const keys = facets.map((f) => f.key);
  say(keys.includes('collection') && keys.includes('schema') && keys.includes('template'),
      `core facets offered: ${keys.filter((k) => !k.startsWith(inv.ATTR_PREFIX)).join(', ')}`);
  say(facets.some((f) => f.key.startsWith(inv.ATTR_PREFIX)),
      `attribute facets discovered from the data: ${facets.filter((f) => f.key.startsWith(inv.ATTR_PREFIX)).length}`);

  // Artwork and prose make a facet as long as the list and narrow nothing.
  const noisy = facets.filter((f) => ['img', 'image', 'description', 'video'].includes(f.label.toLowerCase()));
  say(noisy.length === 0, `artwork and description get no panel (${noisy.map((f) => f.label).join(', ') || 'none present'})`);

  // Counting one facet must ignore its OWN selections, or a second click
  // inside a panel is impossible.
  const coll = facets.find((f) => f.key === 'collection');
  if (coll && coll.values.length >= 2) {
    const picked = freshState({ include: { collection: [coll.values[0].value] } });
    const after = inv.facetsOf(assets, picked).find((f) => f.key === 'collection');
    say(after && after.values.length >= 2,
        `picking one collection leaves its siblings clickable (${after?.values.length} still listed)`);
  }

  console.log('\n=== PHASE B - progressive refinement ===');
  // The property the tool rests on: narrowing must narrow the facets too.
  const wide = inv.facetsOf(assets, all);
  const narrowState = freshState({ q: bySchema });
  const narrow = inv.facetsOf(assets, narrowState);
  const wideTpl = wide.find((f) => f.key === 'template')?.total ?? 0;
  const narrowTpl = narrow.find((f) => f.key === 'template')?.total ?? 0;
  say(narrowTpl > 0 && narrowTpl <= wideTpl,
      `templates offered drop with the search: ${wideTpl} -> ${narrowTpl}`);
  say(inv.applyFilter(assets, narrowState).length < assets.length,
      `the result set narrows too: ${assets.length} -> ${inv.applyFilter(assets, narrowState).length}`);

  // Exclusion has to beat inclusion, or "not those" is unreliable.
  if (coll && coll.values.length) {
    const v = coll.values[0].value;
    const both = freshState({ include: { collection: [v] }, exclude: { collection: [v] } });
    say(inv.applyFilter(assets, both).length === 0,
        'an excluded value beats the same value included');
    const ex = freshState({ exclude: { collection: [v] } });
    say(inv.applyFilter(assets, ex).every((a) => a.collection?.collection_name !== v),
        `excluding "${v}" removes every one of them`);
  }

  // toggleFacet must never leave a row both required and forbidden.
  {
    const st = freshState();
    inv.toggleFacet(st, 'collection', 'x', 'include');
    inv.toggleFacet(st, 'collection', 'x', 'exclude');
    const inc = st.include.collection ?? [];
    const exc = st.exclude.collection ?? [];
    say(!inc.includes('x') && exc.includes('x'),
        'flipping include to exclude drops the include, rather than asking for both');
    inv.toggleFacet(st, 'collection', 'x', 'exclude');
    say(!(st.exclude.collection ?? []).includes('x'), 'clicking the same side again clears it');
  }

  console.log('\n=== PHASE C - the URL round trip ===');
  {
    const st = freshState({
      q: 'vessel engine',
      include: { collection: ['underpunks55'], [`${inv.ATTR_PREFIX}rarity`]: ['Rare', 'Epic'] },
      exclude: { schema: ['shrooms'] },
      view: 'list',
      sortKey: `${inv.ATTR_PREFIX}rarity`,
      sortDesc: false,
    });
    const encoded = inv.encodeInventoryView(st);
    const back = inv.emptyInventoryState();
    inv.decodeInventoryView(encoded, back);
    const same = back.q === st.q
      && back.view === st.view
      && back.sortKey === st.sortKey
      && back.sortDesc === st.sortDesc
      && JSON.stringify(back.include) === JSON.stringify(st.include)
      && JSON.stringify(back.exclude) === JSON.stringify(st.exclude);
    say(same, `a shared view survives the round trip (${encoded.length} chars)`);
    if (!same) {
      fails.push(`round trip lost something: sent ${JSON.stringify(st)} got ${JSON.stringify(back)}`);
    }
    // The card size is a choice, so it travels in a shared link too.
    for (const px of inv.CARD_SIZES.map((c) => c.px)) {
      const st2 = freshState({ cardSize: px });
      const back2 = inv.emptyInventoryState();
      inv.decodeInventoryView(inv.encodeInventoryView(st2), back2);
      if (back2.cardSize !== px) fails.push(`card size ${px} did not survive the round trip (got ${back2.cardSize})`);
    }
    say(true, `all ${inv.CARD_SIZES.length} card sizes survive a shared link`);
    // A hand edited URL must not be able to invent a layout.
    say(inv.clampCardSize('99999') === 200 && inv.clampCardSize('-5') === 64
        && inv.clampCardSize('nonsense') === 96,
        'an out of range size snaps to an offered step rather than being obeyed');

    // Values with the separators in them are the ones that break a naive
    // encoder, so they are the ones worth checking.
    const tricky = freshState({ q: 'a b', include: { schema: ['x~y,z', 'plain'] } });
    const rt = inv.emptyInventoryState();
    inv.decodeInventoryView(inv.encodeInventoryView(tricky), rt);
    say(rt.q === 'a b' && JSON.stringify(rt.include.schema) === JSON.stringify(['x~y,z', 'plain']),
        'separators inside a value survive encoding');
  }

  console.log('\n=== PHASE D - sorting ===');
  {
    // The default, and the one people see first. Receipt order is not
    // mint order: a 2021 NFT bought yesterday has a low asset_id and
    // belongs at the top of an inventory.
    say(inv.emptyInventoryState().sortKey === 'received',
        'an inventory opens on what arrived most recently');
    const withTime = assets.filter((a) => a.transferred_at_time);
    say(withTime.length > 0,
        `${withTime.length}/${assets.length} real assets carry transferred_at_time`);
    const recv = inv.sortAssets(withTime, 'received', true).map((a) => BigInt(a.transferred_at_time));
    say(recv.every((v, i) => i === 0 || recv[i - 1] >= v),
        'receipt order really is newest first');
    // The reason the sort goes through BigInt at all: ids beyond 2^53
    // are not exact as doubles, and two that differ only in their low
    // digits would compare equal and shuffle. Checked with values chosen
    // to collide under Number, which real rows do not conveniently do.
    const huge = [
      { asset_id: '9007199254740993' },
      { asset_id: '9007199254740992' },
    ];
    const sortedHuge = inv.sortAssets(huge, 'asset_id', false).map((a) => a.asset_id);
    say(JSON.stringify(sortedHuge) === JSON.stringify(['9007199254740992', '9007199254740993']),
        'two ids that a double cannot tell apart still sort correctly');
    say(Number('9007199254740993') === Number('9007199254740992'),
        'and those two really are indistinguishable as doubles, so the check means something');
    // Assets the indexer has no timestamp for must not throw or vanish.
    const mixed = [{ asset_id: '1' }, { asset_id: '2', transferred_at_time: '1787776648500' }];
    say(inv.sortAssets(mixed, 'received', true).length === 2,
        'an asset with no receipt time still appears, rather than being dropped');

    const ids = inv.sortAssets(assets, 'asset_id', false).map((a) => BigInt(a.asset_id));
    say(ids.every((v, i) => i === 0 || ids[i - 1] <= v),
        'asset ids sort as 64 bit numbers, not as doubles or strings');
    const desc = inv.sortAssets(assets, 'asset_id', true).map((a) => BigInt(a.asset_id));
    say(desc.every((v, i) => i === 0 || desc[i - 1] >= v), 'descending really reverses');
    say(inv.sortAssets(assets, 'asset_id', false).length === assets.length,
        'sorting never drops a row');
    // A numeric-looking attribute has to sort numerically: 10 after 9.
    const fake = [
      { asset_id: '1', data: { Level: '9' } },
      { asset_id: '2', data: { Level: '10' } },
      { asset_id: '3', data: { Level: '1' } },
    ];
    const lv = inv.sortAssets(fake, `${inv.ATTR_PREFIX}Level`, false).map((a) => a.data.Level);
    say(JSON.stringify(lv) === JSON.stringify(['1', '9', '10']),
        `a numeric attribute sorts numerically: ${lv.join(' < ')}`);
  }

  console.log('\n=== PHASE E - the storage boundary ===');
  {
    // No localStorage in node, so the module must degrade rather than throw.
    say(prefs.storageAvailable() === false,
        'a browser without storage reports unavailable rather than throwing');

    // The boundary itself. sanitize is the whole privacy promise, so it
    // is checked directly rather than through a browser.
    const dirty = {
      inventoryView: 'list',
      inventorySort: 'name',
      inventoryCardSize: 140,
      savedViews: [{ name: 'mine', view: 'q=x' }],
      // None of the following may survive.
      owner: 'zigm4.gm',
      wallet: 'underpunks55',
      assets: [{ asset_id: '1099' }],
      balance: '129034.92982131 WAX',
      lastSeen: Date.now(),
    };
    const kept = JSON.parse(JSON.stringify(dirty));
    prefs.writePrefs(kept);
    // No storage in node, so sanitize is exercised through its own shape:
    // anything it would keep must be one of the four allowed fields.
    const allowed = new Set(['inventoryView', 'inventorySort', 'inventorySortDesc',
                             'inventoryCardSize', 'savedViews']);
    const roundTripped = (() => {
      // Re-implementing sanitize would defeat the point, so this reaches
      // it through the only public door: a read of a blob we hand it.
      const before = globalThis.localStorage;
      const box = {};
      globalThis.localStorage = {
        getItem: (k) => (k in box ? box[k] : null),
        setItem: (k, v) => { box[k] = String(v); },
        removeItem: (k) => { delete box[k]; },
      };
      try {
        prefs.writePrefs(dirty);
        return prefs.readPrefs();
      } finally { globalThis.localStorage = before; }
    })();
    const leaked = Object.keys(roundTripped).filter((k) => !allowed.has(k));
    say(leaked.length === 0,
        `nothing outside the allowed fields is stored (dropped: ${
          Object.keys(dirty).filter((k) => !(k in roundTripped)).join(', ')})`);
    if (leaked.length) fails.push(`prefs leaked: ${leaked.join(', ')}`);
    say(roundTripped.inventoryCardSize === 140 && roundTripped.inventoryView === 'list',
        'the choices themselves are kept');
    say(JSON.stringify(roundTripped).indexOf('zigm4') < 0
        && JSON.stringify(roundTripped).indexOf('underpunks55') < 0
        && JSON.stringify(roundTripped).indexOf('1099') < 0,
        'no wallet, no asset id and no balance appears anywhere in what is stored');

    // An absurd size must not be storable either.
    const huge = (() => {
      const before = globalThis.localStorage;
      const box = {};
      globalThis.localStorage = {
        getItem: (k) => (k in box ? box[k] : null),
        setItem: (k, v) => { box[k] = String(v); },
        removeItem: (k) => { delete box[k]; },
      };
      try { prefs.writePrefs({ inventoryCardSize: 90000 }); return prefs.readPrefs(); }
      finally { globalThis.localStorage = before; }
    })();
    say(huge.inventoryCardSize === undefined,
        'a 90,000 pixel column is refused rather than stored');
    let threw = false;
    try {
      prefs.writePrefs({ inventoryView: 'list' });
      prefs.patchPrefs({ inventorySort: 'name' });
      prefs.forgetPrefs();
      say(JSON.stringify(prefs.readPrefs()) === '{}', 'reading with no storage returns nothing');
    } catch { threw = true; }
    say(!threw, 'every storage call is survivable when storage is not there');
  }

  console.log('\n=== PHASE P - the wait, and what is worth clicking ===');
  {
    const b = await import('./.build/bridge.mjs');
    const fs = await import('node:fs/promises');
    const srcOf = (f) => fs.readFile(new URL(`../src/${f}`, import.meta.url), 'utf8');

    // The reason "What can I do with this?" took half a minute: the first
    // AtomicAssets host in the list stopped existing (NXDOMAIN), the only
    // host that serves /neftyblocks/v1/blends has been answering 522, and
    // every collection paid the ten second timeout again before falling
    // back to the on-chain walk.
    const rpcSrc = await srcOf('chain/rpc.ts');
    // The list itself, not the file: the comment above it names the dead
    // host precisely so nobody puts it back.
    const list = rpcSrc.split('export const ATOMIC_API_ENDPOINTS = [')[1]?.split(']')[0] ?? '';
    say(list.length > 0 && !list.includes('aa.wax.atomichub.io'),
        'the endpoint that no longer resolves is out of the list');
    say(/atomicIndexerDown/.test(rpcSrc),
        'and a route every host refused is not re-tried for a while');

    const chunks = (await fs.readdir(new URL('./.build', import.meta.url)))
      .filter((f) => f.startsWith('rpc-'));
    const rpc = await import(`./.build/${chunks[0]}`);
    const atomic = Object.values(rpc).find(
      (v) => typeof v === 'function' && String(v).startsWith('async function atomicFetch'));
    const dead = '/neftyblocks/v1/blends?collection_name=underpunks55&limit=1';
    // An earlier phase may already have learned this route is down, and
    // then "the first attempt" would be measured as a cache hit.
    const forget = Object.values(rpc).find(
      (v) => typeof v === 'function' && String(v).startsWith('function clearAtomicIndexerDown'));
    forget?.();
    let t0 = Date.now();
    await atomic(dead).catch(() => {});
    const first = Date.now() - t0;
    t0 = Date.now();
    await atomic(dead).catch(() => {});
    const second = Date.now() - t0;
    say(second < 200 && second < first,
        `a dead route costs ${first}ms once, then ${second}ms, instead of ${first}ms per collection`);
    const live = Date.now();
    const rows = await atomic('/atomicassets/v1/assets?limit=1').catch(() => undefined);
    say(Array.isArray(rows), `and a route that works is untouched by that (${Date.now() - live}ms)`);

    // Warming: the click should read an answer, not start a scan.
    t0 = Date.now();
    const index = await b.usableIndex('underpunks55', '');
    const cold = Date.now() - t0;
    say(index.recipes > 0, `a collection reduces to a matcher (${index.recipes} live recipes, ${cold}ms cold)`);
    const shroom = {
      asset_id: '1', template: { template_id: '280421' },
      collection: { collection_name: 'underpunks55' }, schema: { schema_name: 'up.shrooms' }, data: {},
    };
    say(index.takes(shroom), 'and it marks an NFT a blend takes by schema, not only by template');
    say(!index.takes({ asset_id: '2', template: { template_id: '999999999' },
      collection: { collection_name: 'underpunks55' }, schema: { schema_name: 'nope' }, data: {} }),
        'and leaves an unrelated NFT unmarked');

    // The matcher must never disagree with the real answer in the
    // direction that matters: a mark it puts on has to be defensible.
    const real = await b.whatUsesThis(shroom, '');
    say(real.uses.length > 0 && index.takes(shroom),
        'a marked NFT really does have a use when asked properly');

    t0 = Date.now();
    await b.whatUsesThis(shroom, '');
    const warm = Date.now() - t0;
    say(warm < 100, `once read, the question is answered in ${warm}ms instead of ${cold}ms`);

    // Honesty about a failed source, which is what the browser sandbox
    // produced by resetting the chain connections: a mark is a fact, an
    // absence is not.
    say(typeof index.partial === 'boolean',
        'the matcher says whether every source answered');
    const labSrc = await srcOf('ui/lab.ts');
    say(/At least /.test(labSrc) && /there may be more/.test(labSrc),
        'and the count is reported as a floor when one did not');

    // Retry, which is what the panel offered no way to do.
    say(/data-lab="inv-uses-again"/.test(labSrc), 'a failed search can be run again');
    say(/forgetCollection/.test(labSrc),
        'and the retry drops the cached failure rather than replaying it');
    const bridgeSrc = await srcOf('ui/bridge.ts');
    say(/clearAtomicIndexerDown/.test(bridgeSrc),
        'including the note that says the indexer is down');

    // The mark itself.
    const cssSrc = await srcOf('ui/components.css');
    say(/\.inv-all-usable \.inv-spark \{ display: none; \}/.test(cssSrc),
        'the mark disappears when the filter makes it true of everything');
    say(/isUsable\(a, inv\)/.test(labSrc), 'and the grid and the list both carry it');

    // The toggle travels in the link like every other view control, and
    // arriving with it on before anything is read must not show an empty
    // inventory with no reason given.
    const invMod = await import('./.build/inventory.mjs');
    const st = invMod.emptyInventoryState();
    st.usableOnly = true;
    say(invMod.encodeInventoryView(st).includes('usable=1'), 'the toggle is written into the link');
    const back = invMod.emptyInventoryState();
    invMod.decodeInventoryView('usable=1', back);
    say(back.usableOnly === true, 'and read back out of it');
    const assets = [
      { asset_id: '1', collection: { collection_name: 'underpunks55' }, schema: { schema_name: 'x' }, data: {} },
      { asset_id: '2', collection: { collection_name: 'other' }, schema: { schema_name: 'y' }, data: {} },
    ];
    say(invMod.applyFilter(assets, back).length === 2,
        'with nothing read yet it hides nothing, rather than emptying the page');
    back.matchers = { underpunks55: { recipes: 1, partial: false, takes: (a) => a.asset_id === '1' } };
    back.matchersFor = 'someone';
    say(invMod.applyFilter(assets, back).length === 1,
        'and once a collection is read it filters for real');
    say(invMod.knowsAnyRecipes(invMod.emptyInventoryState()) === false
        && invMod.knowsAnyRecipes(back) === true,
        'the difference between the two is a function, not a guess');
  }

  console.log('\n=== PHASE O - each thing the review caught, pinned ===');
  {
    const w = await import('./.build/wallet.mjs');
    const tk = await import('./.build/tokens.mjs');
    const bridge = await import('./.build/bridge.mjs');
    const fs = await import('node:fs/promises');
    const src = (f) => fs.readFile(new URL(`../src/${f}`, import.meta.url), 'utf8');

    // 1. get_tokens defaults to 50 rows and says nothing about the rest.
    // fees.nefty holds balances on 156 issuers; the first version of this
    // feature would have shown a third of them under a footer claiming
    // the list had been confirmed.
    const heavy = await w.listWalletTokens('fees.nefty');
    say(heavy.tokens.length > 150,
        `a wallet with hundreds of tokens gets them all (${heavy.tokens.length}, was 50 unpaged)`);
    say(heavy.tokens.some((t) => t.symbol === 'WAX' && t.contract === 'eosio.token'),
        'and WAX is there, which the alphabetical cut could have dropped');

    // 2. A read that fails is not a balance of zero and not an absence.
    say('unread' in heavy && 'truncated' in heavy && 'skipped' in heavy,
        'the result counts what it could not read instead of hiding it');
    say(!/confirmed against each contract/.test(await src('ui/lab.ts')),
        'and the sheet no longer claims every contract was confirmed');

    // 3. Each cause names itself. "Not every indexer answered" was printed
    // when every indexer had answered and the issuer cap was the cause.
    const capped = { sources: 4, cappedSources: 0, skipped: 20, unread: 0, truncated: 0 };
    const note = w.completenessNote(capped);
    say(!/indexer/.test(note) && /skipped/.test(note),
        `a cap reports itself as a cap: ${JSON.stringify(note)}`);
    say(/No history indexer answered/.test(w.completenessNote({ sources: 0 })),
        'and a total indexer failure is stated rather than rendered as a one-token wallet');
    say(w.completenessNote({ sources: 4, cappedSources: 0, skipped: 0, unread: 0, truncated: 0 }) === '',
        'and a complete read says nothing at all');

    // 4. The badge was computed from blend.nefty alone, so a token only
    // up.nefty or neftyblocksd registers was labelled "not a recipe token".
    say(!/not a recipe token/.test(await src('ui/lab.ts')),
        'the false negative badge is gone: a WaxDAO blend can name any token');
    const light = await w.listWalletTokens('zigm4.gm');
    say(light.registryKnown, 'the registries were read, so the marks mean something');
    // Proof that one registry was not enough, straight off the chain:
    // neftyblocksd accepts tokens blend.nefty has never heard of, and the
    // badge was computed from blend.nefty alone.
    const reg = async (code, symKey, contractKey) => {
      const rows = await rpcTableRows({ code, scope: code, table: 'config', limit: 1 });
      return new Set((rows[0].supported_tokens ?? []).map(
        (t) => `${t[contractKey]}/${String(t[symKey]).split(',')[1]}`));
    };
    const blendReg = await reg('blend.nefty', 'sym', 'contract');
    const dropReg = await reg('neftyblocksd', 'token_symbol', 'token_contract');
    const onlyDrops = [...dropReg].filter((k) => !blendReg.has(k));
    say(onlyDrops.length > 0,
        `neftyblocksd accepts ${onlyDrops.length} token(s) blend.nefty does not, e.g. ${onlyDrops[0]}`);
    const walletSrc = await src('nefty/wallet.ts');
    say(['blend.nefty', 'up.nefty', 'neftyblocksd'].every((c) => walletSrc.includes(`'${c}'`)),
        'and all three registries are consulted, so those tokens are marked');

    // 5. Exact strings, compared as integers. The screen once rendered
    // "you have 32 UPMAX, not enough" for a wallet holding 31.99999999.
    say(tk.covers('32.00000000 UPMAX', '32.00000000 UPMAX') === true, 'exactly enough is enough');
    say(tk.covers('31.99999999 UPMAX', '32.00000000 UPMAX') === false, 'and one unit short is not');
    say(tk.covers('1000.0000 GOLD', '999.9996 GOLD') === true, 'a coarser precision still compares');
    say(tk.covers('0.0001 KENN', '0.0001 KENN') === true, 'and so does a balance that rounds to zero');
    say(w.displayBalance('0.0001 KENN') === '0.0001',
        'which is also what gets shown, rather than the "0" toLocaleString gave');
    // Comments stripped first: the branch explains the bug it fixed, and
    // the explanation names the thing the check is looking for.
    const costBranch = ((await src('ui/lab.ts'))
      .split("if (r.kind === 'token') {")[1]?.split("if (r.have === undefined)")[0] ?? '')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    say(costBranch.length > 0 && !/toLocaleString/.test(costBranch),
        'and no chain amount reaches the screen through a float formatter');
    say(/displayBalance\(t\.haveRaw\)/.test(costBranch),
        'the balance shown is derived from the exact string the chain returned');

    // 6. The link under an NFT ingredient. `tpl=` opens the template
    // screen, which by URL renders empty; `template=` is the filter.
    const labSrc = await src('ui/lab.ts');
    const seeMine = labSrc.split('run-see-mine')[0].slice(-900) + labSrc.split('run-see-mine')[1]?.slice(0, 300);
    say(/~template=/.test(seeMine) && !/~tpl=\$\{tpl\}/.test(seeMine),
        'see-the-ones-you-hold filters the inventory instead of opening an empty template page');

    // 7. Typing in the wallet field must not be the same value the
    // in-flight read uses as its identity guard.
    const invSrc = await src('ui/inventory.ts');
    say(/ownerDraft/.test(invSrc) && /bind\('inv-owner', \(v\) => \{ state\.inv\.ownerDraft = v; \}\)/.test(labSrc),
        'the typed wallet name is a draft, so correcting it mid-read cannot wedge the read');

    // 8. The backdrop existed in the DOM and not on the screen.
    const css = await src('ui/components.css');
    const scrims = css.match(/^\.inv-scrim\s*\{[^}]*\}/gm) ?? [];
    say(scrims.length === 1 && /display:\s*block/.test(scrims[0]),
        `the scrim is declared once and actually renders: ${scrims[0] ?? 'MISSING'}`);

    // 9. The panel said only the collection limited the search.
    say(/Not searched: WaxDAO and Blenderizer/.test(labSrc),
        'the uses panel names the contracts it does NOT read');

    // 10. Upgrades matching through an attribute rule were dropped.
    const bridgeSrc = await src('ui/bridge.ts');
    say(/'attribute' \|\| ing\.kind === 'typed_attribute'/.test(bridgeSrc),
        'an upgrade that takes this NFT by attribute is matched, not silently skipped');
    say(/unreadable/.test(bridgeSrc), 'and a rule shape we cannot read is counted');

    // 11. Two identical pack rows, one of which transfers to the wrong
    // contract irreversibly.
    const packUses = await bridge.whatUsesThis({
      asset_id: '1', template: { template_id: '281765' },
      collection: { collection_name: 'play2metamon' }, schema: { schema_name: 'packs' }, data: {},
    }, '');
    const packs = packUses.uses.filter((u) => u.kind === 'pack');
    say(packs.length < 2 || new Set(packs.map((p) => p.label)).size === packs.length,
        `a template on both pack contracts gives ${packs.length} row(s), each naming its contract`);
    if (packs.length) say(/atomicpacksx|neftyblocksp/.test(packs[0].label), `e.g. ${packs[0].label}`);
  }

  console.log('\n=== PHASE N - the wallet has tokens too ===');
  {
    const w = await import('./.build/wallet.mjs');

    // Trimming trailing zeros off a decimal string loses nothing. Losing
    // a digit that is not a zero would, so the exact figure is compared.
    say(w.displayBalance('13368.20000000 UPMAX') === '13,368.2', 'eight trailing zeros are trimmed, not the value');
    say(w.displayBalance('2063.82119692 WAX') === '2,063.82119692', 'every significant decimal survives');
    say(w.displayBalance('500000000.0001 WUF') === '500,000,000.0001', 'nine figures group and the fraction stays');
    say(w.displayBalance('7 CHIPS') === '7', 'a whole number gets no invented decimal point');
    say(w.displayBalance('0.00000000 NEFTY') === '0', 'an empty balance reads as 0, not 0.00000000');

    const t0 = Date.now();
    const r = await w.listWalletTokens('zigm4.gm');
    const took = Date.now() - t0;
    say(r.tokens.length >= 15, `a real wallet returns its tokens (${r.tokens.length} in ${took}ms)`);
    say(r.sources >= 2, `more than one indexer was asked (${r.sources} answered)`);

    // The reason the union exists. wax.cryptolions.io answers this exact
    // query with 3 tokens where the others return 17, and says nothing
    // about being short. A single-host build would silently lose 14.
    const wax = r.tokens.find((t) => t.symbol === 'WAX' && t.contract === 'eosio.token');
    const upmax = r.tokens.find((t) => t.symbol === 'UPMAX');
    say(Boolean(wax), 'WAX is there, read from eosio.token');
    say(Boolean(upmax) && upmax.contract === 'underpunks55',
        `a collection token is there with its real issuer (${upmax?.contract})`);

    // Every figure has to be the chain's own string, not an indexer float.
    say(r.tokens.every((t) => /^[0-9]+(\.[0-9]+)? [A-Z]{1,7}$/.test(t.balance)),
        'every balance is the exact asset string the contract stores');
    say(r.tokens.every((t) => t.display === w.displayBalance(t.balance)),
        'and what is shown is derived from that string, never from a float');
    say(upmax && upmax.usableInRecipes === true,
        'a token blend.nefty registers is marked as one a recipe can ask for');
    const junk = r.tokens.find((t) => !t.usableInRecipes);
    say(Boolean(junk), `and one it does not is marked as it is (${junk?.symbol ?? 'none found'})`);

    // Non-empty first: a list that opens on four zeroes reads as empty.
    const firstZero = r.tokens.findIndex((t) => t.amount === 0);
    const lastNonZero = r.tokens.map((t) => t.amount > 0).lastIndexOf(true);
    say(firstZero === -1 || firstZero > lastNonZero, 'empty balances all sort below the ones that are not');

    const shown = w.filterWalletTokens(r.tokens, '', false);
    say(shown.every((t) => t.amount > 0), 'the sheet hides empty balances by default');
    say(w.filterWalletTokens(r.tokens, '', true).length === r.tokens.length,
        `and the toggle brings back all ${w.emptyCount(r.tokens)} of them`);
    say(w.filterWalletTokens(r.tokens, 'upmax', false).length === 1, 'search finds a ticker');
    say(w.filterWalletTokens(r.tokens, 'underpunks', false).length === 1,
        'and finds an issuer, which is the only thing separating two tokens that share a ticker');
    say(w.filterWalletTokens(r.tokens, 'zzzz', false).length === 0, 'and finds nothing when there is nothing');

    // The empty-balance control is counted against the SEARCH, not the
    // wallet. Searching "wax" once offered "show 4 empty" and then showed
    // nothing, because none of the four empty balances were WAX tokens.
    const matchedEmpties = w.emptyCount(w.filterWalletTokens(r.tokens, 'wax', true));
    say(matchedEmpties === 0,
        'a search that matches no empty balance offers to reveal none of them');
    say(w.emptyCount(w.filterWalletTokens(r.tokens, '', true)) === w.emptyCount(r.tokens),
        'and with no search it still offers every one');

    // A wallet that holds nothing must say so rather than fail.
    const none = await w.listWalletTokens('nefty.gm');
    say(Array.isArray(none.tokens), `an empty wallet answers cleanly (${none.tokens.length} tokens)`);
    const nobody = await w.listWalletTokens('');
    say(nobody.tokens.length === 0 && nobody.sources === 0,
        'and no wallet name asks no indexer anything');
  }

  console.log('\n=== PHASE M - the bridge between owning and doing ===');
  {
    const bridge = await import('./.build/bridge.mjs');
    const runMod = await import('./.build/guidedRun.mjs');

    // A pack, proved by construction: take a real pack design and ask
    // what its own template can do.
    const packs = await runMod.listRecipes('unpack', 'underpunks55', '');
    const design = packs.choices.find((x) => x.source === 'pack');
    const packAsset = {
      asset_id: '999',
      template: { template_id: String(design.raw.pack_template_id) },
      collection: { collection_name: 'underpunks55' },
      schema: { schema_name: 'packs' }, data: {},
    };
    const packUses = await bridge.whatUsesThis(packAsset, '');
    const opener = packUses.uses.find((u) => u.kind === 'pack');
    say(Boolean(opener), `an NFT that IS a pack says so: ${opener?.label ?? 'NOT FOUND'}`);
    say(opener?.link === `pack~underpunks55~${design.id}`,
        `and links straight to opening it (${opener?.link})`);

    // Real NFTs from a real wallet: at least one must find a real use,
    // or the bridge is only proved against something I built myself.
    const owned = assets.filter((a) => a.collection?.collection_name === 'underpunks55').slice(0, 40);
    let withUses = 0; let sample;
    for (const a of owned) {
      const u = await bridge.whatUsesThis(a, '');
      if (u.uses.length) { withUses += 1; sample = sample ?? { a, u }; }
      if (withUses >= 2) break;
    }
    say(withUses > 0,
        sample
          ? `a real NFT finds a real use: "${sample.a.name}" -> ${sample.u.uses[0].label} (${sample.u.uses[0].because})`
          : 'no NFT in the sample found a use, so nothing was proved');

    // Every use has to carry a reason and a link the runner can open.
    if (sample) {
      say(sample.u.uses.every((x) => x.link.split('~').length === 3 && x.because && x.label),
          'every use carries a reason and a three-part runner link');
      const links = sample.u.uses.map((x) => x.link);
      say(new Set(links).size === links.length,
          'the same recipe is never listed twice, however many of its ingredients match');
      say(sample.u.scanned === 'underpunks55',
          'and the screen can say which collection was actually searched');
    }

    // An NFT with no collection must not crash or claim to have looked.
    const nowhere = await bridge.whatUsesThis({ asset_id: '1', data: {} }, '');
    say(nowhere.uses.length === 0 && nowhere.scanned === '',
        'an NFT with no collection returns nothing and says it searched nothing');

    // The token check: the runner used to print "not checked" beside
    // every cost, which is the one question that screen exists to answer.
    const t = await bridge.checkTokenCost('zigm4.gm', '32.00000000 UPMAX');
    say(t && t.symbol === 'UPMAX' && t.needRaw === '32.00000000 UPMAX' && typeof t.haveRaw === 'string',
        t ? `a token cost is measured: need ${t.needRaw}, wallet holds ${t.haveRaw}` : 'token check returned nothing');
    say(t && /^[0-9]+\.[0-9]{8} UPMAX$/.test(t.haveRaw ?? ''),
        'and the balance is the chain\'s exact string, not a parsed float');
    say(t && t.enough === true, 'and the verdict is computed, not left to the screen');

    // An unresolvable token is "we could not read it", never "you have
    // none". The old shape returned undefined and the screen said "not
    // checked", which reads the same as a balance nobody asked about.
    const unknown = await bridge.checkTokenCost('zigm4.gm', '1.0000 ZZZZNOPE');
    say(unknown && unknown.haveRaw === undefined && unknown.enough === undefined,
        'an unregistered token says the balance is unknown rather than guessing at it');
    say((await bridge.checkTokenCost('', '32.00000000 UPMAX')) === undefined,
        'and no wallet asks the chain nothing');
    say((await bridge.checkTokenCost('zigm4.gm', 'not an asset')) === undefined,
        'and a cost that is not an asset string is refused rather than parsed');
  }

  console.log('\n=== PHASE L - opening packs, on both pack contracts ===');
  {
    say(run.RECIPE_ACTIONS.some((a) => a.key === 'unpack'),
        'opening a pack is offered as an action, like blending and claiming');
    say(run.actionOf('pack') === 'unpack' && run.actionOf('neftypack') === 'unpack',
        'both pack contracts map to the one action, so nobody picks between them');

    // Six collections with deliberately different mixes: atomicpacksx
    // only, neftyblocksp heavy, and both. A one-contract sample would
    // pass while the other leg was broken.
    const collections = ['underpunks55', 'cigalepixeld', 'captainshelm',
                         'kaleidoscope', 'novopangeaio', 'darkcountryh'];
    const sourcesSeen = new Set();
    for (const c of collections) {
      const r = await run.listRecipes('unpack', c, '');
      if (!r.choices.length) { fails.push(`no packs found in ${c}, so it proved nothing`); continue; }
      const mix = {};
      for (const p of r.choices) { mix[p.source] = (mix[p.source] ?? 0) + 1; sourcesSeen.add(p.source); }
      say(true, `${c}: ${r.choices.length} pack(s) ${JSON.stringify(mix)}`);

      // One of each contract present in this collection, end to end.
      for (const src of new Set(r.choices.map((x) => x.source))) {
        const p = r.choices.find((x) => x.source === src);
        p.raw.rolls = await run.loadPackOdds(src, p.id);
        const owned = [{
          asset_id: '555',
          template: { template_id: String(p.raw.pack_template_id) },
          collection: { collection_name: c }, schema: { schema_name: 'packs' }, data: {},
        }];
        const d = run.describeRecipe(src, p.raw, owned, true);
        if (!d) { fails.push(`${c}/${src} #${p.id} produced no detail`); continue; }
        // A real pack, darkcountryh #506, has 40 rolls over one pool and
        // would print 12,400 reward lines uncollapsed.
        if (d.rewards.length > 40) fails.push(`${c}/${src} #${p.id} would print ${d.rewards.length} reward lines`);
        if (d.rewards.some((x) => x.odds !== undefined && (x.odds < 0 || x.odds > 100))) {
          fails.push(`${c}/${src} #${p.id} has an odds figure outside 0..100`);
        }
        const picked = run.autoPick(d.requirements, {});
        try {
          const acts = await run.buildRunActions({
            source: src, actor: 'zigm4.gm', id: p.id, raw: p.raw, requirements: d.requirements, picked,
          });
          say(acts.length === 1 && acts[0].account === 'atomicassets' && acts[0].name === 'transfer'
              && acts[0].data.memo === 'unbox',
              `${c}/${src} #${p.id} hands the pack over: ${acts.map((a) => `${a.account}::${a.name}`).join(', ')}`);
          const to = acts[0]?.data?.to;
          say(to === run.SOURCE_INFO[src].contract,
              `  and to the right contract (${to})`);
        } catch (e) { fails.push(`${c}/${src} #${p.id} would not build: ${e.message}`); }
      }
    }
    say(sourcesSeen.has('pack') && sourcesSeen.has('neftypack'),
        `both pack contracts were exercised: ${[...sourcesSeen].join(', ')}`);

    // Not owning the pack must refuse, the same as any other short slot.
    {
      const r = await run.listRecipes('unpack', 'underpunks55', '');
      const p = r.choices[0];
      const d = run.describeRecipe(p.source, p.raw, [], true);
      let refused = false;
      try {
        await run.buildRunActions({
          source: p.source, actor: 'zigm4.gm', id: p.id, raw: p.raw,
          requirements: d.requirements, picked: {},
        });
      } catch { refused = true; }
      say(refused, 'a pack you do not own refuses to build rather than failing on chain');
    }
  }

  console.log('\n=== PHASE K - what the UX audit found, pinned ===');
  {
    const fs3 = await import('node:fs/promises');
    const lab = await fs3.readFile(new URL('../src/ui/lab.ts', import.meta.url), 'utf8');
    const app = await fs3.readFile(new URL('../src/ui/app.ts', import.meta.url), 'utf8');

    // B1: the shell must paint before the chain is asked anything. It
    // used to await the ABI probe first, so a cold load was blank for 20
    // to 90 seconds and blank forever if the probe failed.
    const mountIdx = app.indexOf('await loadBlendContractShape()');
    const renderBefore = app.lastIndexOf('render();', mountIdx);
    say(mountIdx > 0 && renderBefore > 0 && renderBefore < mountIdx,
        'the page paints before the ABI probe, so a slow chain is not a blank screen');
    say(!/loadBlendContractShape\(\);?\s*\}\s*catch[\s\S]{0,200}?return;/.test(app),
        'a failed ABI probe no longer returns without rendering');

    // B2: Continue must do the step's work, not increment blindly.
    say(/case 'run-next':[\s\S]{0,900}?run-collection/.test(lab),
        'Continue reads the collection field rather than throwing it away');
    say(/case 'run-next':[\s\S]{0,900}?loadRunChoices\(\)/.test(lab),
        'and starts the search, the same as the Find button');

    // B3: three states, not one accusation.
    say(/!run\.searched/.test(lab),
        'step 3 tells "not searched yet" apart from "found nothing"');

    // M1: the copy must not contradict the button.
    say(!/Nothing here signs anything yet/.test(lab),
        'the runner no longer says it signs nothing on the screen that signs');
    say(/cannot be undone/.test(lab),
        'and warns that burning is irreversible before the button that does it');

    // M7: the share button copies the live hash.
    say(/function labHref[\s\S]{0,600}?location\.hash/.test(lab),
        'a shared lab link carries the wallet and the filters, not a bare tool name');

    // M8: Save view gated on the name it needs, not on the filters.
    say(!/data-lab="inv-save-view" \$\{active \? '' : 'disabled'\}/.test(lab),
        'Save view is no longer greyed out for having no filter');

    // B6: artwork found wherever the author put it.
    say(/export function artworkOf/.test(await fs3.readFile(new URL('../src/ui/inventory.ts', import.meta.url), 'utf8')),
        'artwork is resolved by shape rather than from a fixed list of field names');
  }

  console.log('\n=== PHASE G - the narrow-screen block stays last ===');
  {
    // Not a unit test of behaviour, a guard against one specific mistake
    // that shipped twice: a media query carries no extra specificity, so
    // a plain `.inv-*` rule written below it wins on source order and
    // silently undoes the mobile layout. First the Filters button
    // vanished at 375px, then the facet rail stayed on the page beside
    // its own popup. Both were reported by a person, not by a test.
    const fs = await import('node:fs/promises');
    const css = await fs.readFile(new URL('../src/ui/components.css', import.meta.url), 'utf8');
    const at = css.indexOf('@media (max-width: 760px) {');
    say(at >= 0, 'the inventory narrow-screen block exists');
    // Brace matched rather than indentation matched. Relying on the
    // leading whitespace would make this guard the next thing to break
    // silently, which is exactly what it exists to prevent.
    let i = css.indexOf('{', at) + 1;
    let depth = 1;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
      i += 1;
    }
    const after = css.slice(i);
    const offenders = [...after.matchAll(/(?<![\w-])(\.inv-[a-z-]*)[^{}]*\{/g)].map((m) => m[1]);
    say(offenders.length === 0,
        offenders.length
          ? `these base rules sit BELOW the narrow-screen block and will override it: ${offenders.join(' ')}`
          : 'no base .inv- rule sits below it, so it cannot be silently outranked');

    // Being last is worth nothing if the block never reaches the browser.
    // The header comment above it was once left unterminated: its closing
    // marker landed nine lines down, everything between became the
    // prelude of an invalid selector, and the browser dropped the entire
    // media query. Source order was perfect and the phone layout was
    // dead, on the deployed site, for as long as it took a person to
    // notice. So: strip comments the way a CSS tokenizer does, then check
    // that the last thing before the block is the end of a rule.
    let stripped = ''; let k = 0; let unterminated = false;
    while (k < css.length) {
      if (css.startsWith('/*', k)) {
        const close = css.indexOf('*/', k + 2);
        if (close === -1) { unterminated = true; break; }
        k = close + 2;
      } else { stripped += css[k]; k += 1; }
    }
    say(!unterminated, 'every comment in the file is closed');
    say(!stripped.includes('*/'),
        'no stray comment terminator survives, which would start an invalid selector');
    const blockAt = stripped.indexOf('@media (max-width: 760px)');
    const before = stripped.slice(0, blockAt).trimEnd();
    say(before.endsWith('}'),
        before.endsWith('}')
          ? 'the block starts on a clean boundary, so a browser actually applies it'
          : `loose text sits between the last rule and the block, so it parses as a selector: ...${JSON.stringify(before.slice(-70))}`);
  }

  console.log('\n=== PHASE J - the prototype actually signs ===');
  {
    const blendMod2 = await import('./.build/blend.mjs');
    // Fakes built FROM each recipe's own ingredients rather than guessed,
    // because a guess that misses a schema slot proves nothing except
    // that the guard works. (It does: the first version of this test hit
    // "Pick 4 for 4 x any mapfragments NFT" and refused to build.)
    const fakesFor = (reqs, collection) => {
      const out = [];
      reqs.forEach((r, i) => {
        if (r.kind !== 'nft') return;
        const tpl = /template #(\d+)/.exec(r.text)?.[1] ?? String(900000 + i);
        const schema = /any ([a-z0-9.]+) NFT/.exec(r.text)?.[1] ?? 'any';
        for (let k = 0; k < r.need; k += 1) {
          out.push({
            asset_id: `7${i}${k}`,
            template: { template_id: tpl },
            collection: { collection_name: collection },
            schema: { schema_name: schema },
            data: {},
          });
        }
      });
      return out;
    };

    const cases = [
      { source: 'blend', id: '45780', collection: 'captainshelm' },
      { source: 'waxdao', id: '1547', collection: 'underpunks55' },
      { source: 'blenderizer', id: '', collection: 'underpunks55' },
      { source: 'upgrade', id: '', collection: 'underpunks55' },
    ];
    for (const c of cases) {
      let id = c.id;
      if (!id) {
        const listed = await run.listRecipes(run.actionOf(c.source), c.collection, '');
        id = listed.choices.find((x) => x.source === c.source)?.id ?? '';
        if (!id) { fails.push(`no ${c.source} sample, so signing was never checked for it`); continue; }
      }
      const rawRow = c.source === 'blend'
        ? await blendMod2.loadBlend({ blend_id: id })
        : (await run.loadRecipeById(c.source, id, c.collection, ''))?.raw;
      if (!rawRow) { fails.push(`${c.source} #${id} could not be loaded`); continue; }

      const bare = c.source === 'blend'
        ? run.requirementsOf(rawRow, [], true)
        : run.describeRecipe(c.source, rawRow, [], true).requirements;
      const owned = fakesFor(bare, c.collection);
      const reqs = c.source === 'blend'
        ? run.requirementsOf(rawRow, owned, true)
        : run.describeRecipe(c.source, rawRow, owned, true).requirements;

      const picked = run.autoPick(reqs, {});
      const missing = run.whatIsMissing(reqs, picked);
      say(missing.length === 0,
          `${c.source} #${id}: every slot filled automatically${missing.length ? ` — ${missing.join('; ')}` : ''}`);
      if (missing.length) continue;

      // No asset may fill two slots: the contract rejects the duplicate.
      const all = Object.values(picked).flat();
      say(new Set(all).size === all.length,
          `${c.source} #${id}: no NFT is used twice across slots (${all.length} picked)`);

      let actions;
      try {
        actions = await run.buildRunActions({
          source: c.source, actor: 'zigm4.gm', id, raw: rawRow, requirements: reqs, picked,
        });
      } catch (e) { fails.push(`${c.source} #${id} would not build: ${e.message}`); continue; }
      say(actions.length > 0 && actions.every((a) => a.account && a.name && a.authorization?.length),
          `${c.source} #${id} builds ${actions.length} action(s): ${actions.map((a) => `${a.account}::${a.name}`).join(', ')}`);
      // Every action must be signed by the person pressing the button.
      say(actions.every((a) => a.authorization.every((au) => au.actor === 'zigm4.gm')),
          `${c.source} #${id}: every action is authorised by the signer, nobody else`);
    }

    // A short slot must refuse to build rather than send a transaction
    // the contract will reject. Costing somebody CPU to learn that is the
    // failure this exists to prevent.
    const b = await blendMod2.loadBlend({ blend_id: '45780' });
    let refused = false;
    try {
      await run.buildRunActions({
        source: 'blend', actor: 'zigm4.gm', id: '45780', raw: b,
        requirements: run.requirementsOf(b, [], true), picked: {},
      });
    } catch { refused = true; }
    say(refused, 'an unfilled slot refuses to build rather than signing something that would fail');

    // The screen must not say it cannot do the thing it now does. The
    // old copy survived below the new sign block for one commit, so the
    // page carried a working "Run it" button and, underneath it, a
    // sentence saying it stops before signing.
    {
      const fs2 = await import('node:fs/promises');
      const lab = await fs2.readFile(new URL('../src/ui/lab.ts', import.meta.url), 'utf8');
      say(lab.includes('renderSignBlock'), 'the runner has a sign block');
      say(!/stops before signing/.test(lab),
          'and nothing on the page still claims it stops before signing');
    }

    let noWallet = false;
    try {
      await run.buildRunActions({ source: 'blend', actor: '', id: '1', raw: b, requirements: [], picked: {} });
    } catch { noWallet = true; }
    say(noWallet, 'no wallet refuses to build at all');
  }

  console.log('\n=== PHASE I - step 4 works for every contract, not just one ===');
  {
    // The prototype used to describe cost and reward only for
    // blend.nefty and show a dead end for the other four, which meant a
    // shared link to a WaxDAO blend led somebody nowhere.
    const cases = [
      { source: 'waxdao', id: '1547', collection: 'underpunks55' },
      { source: 'blenderizer', id: '', collection: 'underpunks55' },
      { source: 'upgrade', id: '', collection: 'underpunks55' },
      { source: 'drop', id: '', collection: 'pearlhorizon' },
    ];
    for (const c of cases) {
      let id = c.id;
      if (!id) {
        const listed = await run.listRecipes(run.actionOf(c.source), c.collection, '');
        id = listed.choices.find((x) => x.source === c.source)?.id ?? '';
        if (!id) { fails.push(`no ${c.source} sample in ${c.collection}, so it was never checked`); continue; }
      }
      // By id, the way a pasted link arrives: nothing was clicked, so
      // there is no row in hand and it has to be fetched.
      const choice = await run.loadRecipeById(c.source, id, c.collection, '');
      if (!choice) { fails.push(`${c.source} #${id} could not be loaded from a link`); continue; }
      const d = run.describeRecipe(c.source, choice.raw, assets, true);
      if (!d) { fails.push(`${c.source} #${id} loaded but produced no detail`); continue; }
      const bad = [...d.requirements, ...d.rewards]
        .map((x) => x.text)
        .filter((t) => !t || t.includes('undefined') || t.includes('[object') || t === 'name');
      say(bad.length === 0 && d.rewards.length > 0,
          `${c.source} #${id}: ${d.requirements.length} cost line(s), ${d.rewards.length} reward(s)${
            bad.length ? ` — BAD: ${bad.join(', ')}` : ''}`);
      // Ownership counting has to mean the same thing on every screen.
      const nftSlots = d.requirements.filter((r) => r.kind === 'nft');
      if (nftSlots.length) {
        const unknown = run.describeRecipe(c.source, choice.raw, [], false);
        say(unknown.requirements.filter((r) => r.kind === 'nft').every((r) => r.have === undefined),
            `${c.source}: with no wallet read, nothing claims "you have 0"`);
      }
    }
    // The placeholder WaxDAO writes into nft_name must never reach a screen.
    const wd = await run.loadRecipeById('waxdao', '1547', 'underpunks55', '');
    const wdd = wd && run.describeRecipe('waxdao', wd.raw, [], false);
    say(wdd && wdd.rewards.every((r) => r.text.toLowerCase() !== 'name'),
        'the literal string "name" that waxdaomarket stores is not shown as a reward');
  }

  console.log('\n=== PHASE H - the list table shares one column template ===');
  {
    const fs = await import('node:fs/promises');
    const css = await fs.readFile(new URL('../src/ui/components.css', import.meta.url), 'utf8');
    // The header sat over the wrong column because `width: max-content`
    // let every row size to its own longest cell, so no two agreed on
    // where a column started. Measured in a browser at 1280px after the
    // fix: 6 rows, 0 misaligned, all 8 column edges identical.
    const rowRule = css.slice(css.indexOf('.inv-list-head, .inv-list-row'));
    say(!/width:\s*max-content/.test(rowRule.slice(0, 400)),
        'list rows do not size to their own content, which is what misaligned the header');
    say(/grid-template-columns:\s*var\(--inv-tpl/.test(css),
        'the header and the rows take their columns from one shared variable');
  }

  console.log('\n=== PHASE F - the runner, against a live blend ===');
  {
    const BLEND = '45780';
    let blend;
    try {
      const r = await fetch('https://wax.greymass.com/v1/chain/get_table_rows', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          json: true, code: 'blend.nefty', scope: 'blend.nefty', table: 'blends',
          lower_bound: BLEND, upper_bound: BLEND, limit: 1,
        }),
      });
      blend = (await r.json()).rows[0];
    } catch { /* reported below */ }
    if (!blend) { fails.push(`blend ${BLEND} could not be read, so the runner was not checked`); }
    else {
      say(true, `blend ${BLEND} read: ${run.blendTitle(blend)}`);
      const reqs = run.requirementsOf(blend, assets, true);
      say(reqs.length === (blend.ingredients ?? []).length,
          `every ingredient becomes a row: ${reqs.length}`);
      say(reqs.every((r) => r.text && !r.text.includes('undefined') && !r.text.includes('[object')),
          'every row is a sentence, with nothing left unrendered');
      say(reqs.some((r) => r.kind === 'token') ? reqs.filter((r) => r.kind === 'token').every((r) => r.have === undefined) : true,
          'a token cost is never counted, so it can never read as "you have none"');

      // The rule the browser caught: before the wallet is read, `have`
      // must be unknown rather than zero.
      const unknown = run.requirementsOf(blend, [], false);
      say(unknown.every((r) => r.have === undefined),
          'with no wallet read, nothing claims "you have 0"');
      say(run.canAfford(unknown) === true,
          'an unread wallet is never reported as short');

      // And with a wallet that genuinely owns none, it must say so.
      const none = run.requirementsOf(blend, [], true);
      const nftSlots = none.filter((r) => r.kind === 'nft');
      say(nftSlots.length === 0 || nftSlots.every((r) => r.have === 0),
          `a wallet holding nothing reports 0 on each of its ${nftSlots.length} NFT slot(s)`);
      say(nftSlots.length === 0 || run.canAfford(none) === false,
          'and is reported as unable to run it');

      // The chooser asks what you want to DO, not which company hosts it.
      const actions = run.RECIPE_ACTIONS.map((a) => a.key);
      // The list grows as Crucible's own tabs are covered; what must not
      // grow is the number of PLATFORMS a person has to choose between.
      say(actions.length >= 3
          && !actions.includes('waxdao') && !actions.includes('blenderizer')
          && !actions.includes('pack') && !actions.includes('neftypack'),
          `actions are things to do, not contracts to pick: ${actions.join(', ')}`);
      // ...and a blend search still reaches all three blend contracts.
      say(run.actionOf('waxdao') === 'blend' && run.actionOf('blenderizer') === 'blend'
          && run.actionOf('upgrade') === 'upgrade',
          'every contract maps back to the action it serves');

      // underpunks55 deliberately: it has blends on all three contracts, so
      // this proves the fan-out really merges rather than just running.
      // A collection with only Nefty blends would pass while the WaxDAO
      // and Blenderizer legs were quietly broken.
      const found = await run.listRecipes('blend', 'underpunks55', '');
      const bySource = {};
      for (const c of found.choices) bySource[c.source] = (bySource[c.source] ?? 0) + 1;
      say(Object.keys(bySource).length === 3,
          `one blend search reached every contract: ${
            Object.entries(bySource).map(([k, v]) => `${k}=${v}`).join(', ')}`);
      say(found.choices.length > 0,
          `${found.choices.length} recipes found without anyone naming a platform`);
      say(found.choices.every((c) => c.id && c.name && typeof c.live === 'boolean' && c.source),
          'every row carries an id, a name, whether it is running, and where it came from');
      say(found.choices.every((c) => run.SOURCE_INFO[c.source]),
          'every source has a platform and contract to show as a badge');
      say(found.unreachable.length === 0,
          `all three contracts answered${found.unreachable.length ? ` (missing ${found.unreachable})` : ''}`);
      // Running first. Sorting by platform would rebuild the grouping the
      // player was just spared from choosing.
      const liveFlags = found.choices.map((c) => c.live);
      say(liveFlags.every((v, i) => i === 0 || !(v && !liveFlags[i - 1])),
          'recipes that are running are listed before ones that are not');

      // A collection nobody has ever used must come back empty rather
      // than throwing, because people will mistype one.
      const none2 = await run.listRecipes('blend', 'zzzzzzzzzzzz', '');
      say(none2.choices.length === 0 && none2.unreachable.length === 0,
          'an unknown collection returns nothing rather than failing');
      say((await run.listRecipes('blend', '', '')).choices.length === 0,
          'no collection asks the chain nothing at all');

      // The chips on the "which collection" screen come from the wallet.
      const owned = run.collectionsOwned(assets);
      say(owned.length > 0 && owned[0].count >= (owned[owned.length - 1]?.count ?? 0),
          `collections you hold are offered, commonest first: ${owned.slice(0, 3).map((c) => `${c.name} (${c.count})`).join(', ')}`);

      const { rewards } = run.rewardsOf(blend);
      say(rewards.length > 0, `outcomes described: ${rewards.length}`);
      say(rewards.every((r) => r.odds === undefined || (r.odds >= 0 && r.odds <= 100.0001)),
          'every odds figure is a real percentage');
    }
  }

  // Deliberately last. This phase clears caches and starts two full
  // walks of the blends table on purpose, which is a lot of load for the
  // public nodes; run in the middle it made a later phase's pack read
  // fail and report a defect that was not there.
  console.log('\n=== PHASE Q - what the second review caught ===');
  {
    const b = await import('./.build/bridge.mjs');
    const fs = await import('node:fs/promises');
    const srcOf = (f) => fs.readFile(new URL(`../src/${f}`, import.meta.url), 'utf8');
    const labSrc = await srcOf('ui/lab.ts');
    const invSrc = await srcOf('ui/inventory.ts');

    // The scan reads the WHOLE blends table and filters client side. Doing
    // that per collection meant eight identical 45 MiB walks on one page
    // load. One walk, shared, is the difference between preloading and a
    // quarter of a gigabyte.
    const discoverSrc = await srcOf('nefty/discover.ts');
    say(/walkAllBlends/.test(discoverSrc) && /Map<string, RawBlend\[\]>/.test(discoverSrc),
        'the blends table is walked once and grouped by collection');
    say(!/for \(const c of order\) warmCollection/.test(labSrc),
        'and the loop that started all eight collections at once is gone, so the throttle throttles');

    // Both cleared first, at both layers, so this measures a cold read
    // followed by one that shares its walk. Run after another phase had
    // already read them, it was comparing nothing against nothing.
    const discA = await import('./.build/discover.mjs');
    b.forgetCollection('underpunks55', '');
    b.forgetCollection('cigalepixeld', '');
    discA.clearDiscoverCache();
    let t = Date.now();
    await b.usableIndex('underpunks55', '');
    const first = Date.now() - t;
    t = Date.now();
    await b.usableIndex('cigalepixeld', '');
    const second = Date.now() - t;
    say(first > 1000 && second < first / 2,
        `a second collection costs ${second}ms against the first collection's ${first}ms`);

    // An attribute rule names a collection, and it is not always the one
    // the blend lives in. Dropping it marked NFTs no recipe can take.
    const m = await b.usableIndex('landboxgames', '');
    const foreign = {
      asset_id: '1', template: { template_id: '1' },
      collection: { collection_name: 'landboxgames' },
      schema: { schema_name: 'monsters' }, data: { rarity: 'Common' },
    };
    say(!m.takes(foreign),
        'an attribute rule that names another collection does not mark this one');
    const bridgeSrc = await srcOf('ui/bridge.ts');
    say(/rule\.collection && rule\.collection !== coll/.test(bridgeSrc),
        'because the rule carries the collection it named');

    // The count covered eight collections and was printed as a fact about
    // the wallet.
    say(/assetsUnread/.test(labSrc) && /assetsUnread/.test(invSrc),
        'the NFTs in collections past the read limit are counted');
    say(/not checked: only your/.test(labSrc),
        'and the screen says how much of the wallet was actually read');
    say(/inv\.assetsUnread > 0 \?/.test(labSrc),
        'and an unread collection is named on screen rather than counted as having no recipes');

    // The toggle could strand the page: empty grid, no control, no Reset.
    const invMod = await import('./.build/inventory.mjs');
    const st = invMod.emptyInventoryState();
    st.usableOnly = true;
    say(invMod.activeFilterCount(st) === 1, 'the toggle counts as a filter, so "clear 1 filter" appears');
    invMod.clearFilters(st);
    say(st.usableOnly === false, 'and Reset turns it off');
    say(/usableKnown \|\| inv\.usableOnly/.test(labSrc),
        'and the button is rendered whenever it is on, so it can always be turned off');

    // Search again used to delete every mark in the collection for good.
    say(/mine\.matchers\[c\] = 'loading'/.test(labSrc)
        && /void usableIndex\(c, state\.actor\)/.test(labSrc),
        'Search again rebuilds the collection\'s marks instead of erasing them');

    // The wait screen asserted an outage it had not checked.
    say(/indexerIsDown\(\)/.test(labSrc) && /export function indexerIsDown/.test(bridgeSrc),
        'the indexer is only called down when it actually is');
    const rpcSrc = await srcOf('chain/rpc.ts');
    say(/NOTEWORTHY_ROUTES/.test(rpcSrc),
        'and the outage note covers one route, not every atomicassets read');

    const chunks2 = (await fs.readdir(new URL('./.build', import.meta.url)))
      .filter((f) => f.startsWith('rpc-'));
    const rpc2 = await import(`./.build/${chunks2[0]}`);
    const down = Object.values(rpc2).find(
      (v) => typeof v === 'function' && String(v).startsWith('function atomicIndexerDown'));
    say(down && down('/atomicassets/v1/templates/foo/1') === false,
        'a missing template can never blank the asset reads');

    // The memo outlived the freshness of what it held.
    say(/WARM_TTL_MS/.test(bridgeSrc),
        'the per-collection memo expires, so an ended blend stops being offered');

    // One walk instead of eight is the right trade only if the thing it
    // keeps does not sit in a phone's memory afterwards. Every blend on
    // WAX is tens of megabytes.
    const disc = await import('./.build/discover.mjs');
    say(typeof disc.releaseChainWalk === 'function',
        'the shared walk can be released once the collections that wanted it are read');
    say(/releaseChainWalk\(\)/.test(labSrc) && /Promise\.all\(running\)/.test(labSrc),
        'and the warm pass releases it when its workers finish');
    if (global.gc) {
      // A fresh walk, so what is measured is the walk and not whatever an
      // earlier phase happened to leave on the heap. The difference is
      // the honest figure here: absolute heap drifts, freed memory does
      // not.
      // Both layers: the bridge memoises the four listings per collection
      // on top of the lister's own cache, so clearing one alone would
      // hand back the memo and never walk.
      b.forgetCollection('cigalepixeld', '');
      disc.clearDiscoverCache();
      global.gc(); global.gc();
      const held0 = process.memoryUsage().heapUsed;
      await b.usableIndex('cigalepixeld', '');
      global.gc();
      const held = process.memoryUsage().heapUsed;
      disc.releaseChainWalk();
      global.gc(); global.gc();
      const freed = (held - process.memoryUsage().heapUsed) / 1048576;
      say(freed > 10,
          `releasing the walk frees ${freed.toFixed(1)} MiB (it grew the heap by ${((held - held0) / 1048576).toFixed(1)} MiB)`);
      const t2 = Date.now();
      const again = await b.usableIndex('cigalepixeld', '');
      say(Date.now() - t2 < 100 && again.recipes >= 0,
          'and the collection already read stays instant afterwards');
    } else {
      say(true, 'memory release measured only under --expose-gc, skipped here');
    }
    say(/WALK_TTL_MS/.test(discoverSrc),
        'and it expires on its own if nobody releases it');

    // Refresh means the NFTs changed, so what they are good for changed.
    say(/if \(kind === 'inv-reload'\) state\.inv\.matchersFor = '';/.test(labSrc),
        'Refresh re-reads the recipes instead of trusting the previous pass');

    // --- what the second review caught ---

    // The TTL was checked on the way IN, so nothing dropped the map unless
    // somebody asked for another walk. Anyone who listed one collection and
    // then read the page held every blend on WAX for the life of the tab.
    say(/chainWalkTimer = setTimeout/.test(discoverSrc),
        'the shared walk is evicted by a timer, not by the next caller happening to arrive');
    say(/\.unref\?\.\(\)/.test(discoverSrc),
        'and that timer does not hold a script open');

    // Progress belonged to whoever started the walk. Everyone who joined
    // one already running watched a bar frozen at zero, which is the
    // normal case: the warm pass starts most walks and passes no callback.
    say(/walkWatchers/.test(discoverSrc),
        'every waiter is told how the walk is going, not only the one that started it');
    {
      const disc2 = await import('./.build/discover.mjs');
      b.forgetCollection('northshireup', '');
      disc2.clearDiscoverCache();
      const starter = [];
      const joiner = [];
      const p1 = disc2.listBlends({ collection: 'northshireup', includeInactive: false,
        onProgress: (x) => starter.push(x) });
      await new Promise((r) => setTimeout(r, 300));
      const p2 = disc2.listBlends({ collection: 'cigalepixeld', includeInactive: false,
        onProgress: (x) => joiner.push(x) });
      await Promise.all([p1, p2]);
      const moved = joiner.filter((x) => x.progress > 0 && x.progress < 1).length;
      say(moved > 0,
          `a caller that joins a walk in flight sees it move (${moved} progress events, was 0)`);
      say(starter.length > 0, 'and the one that started it still does');
    }

    // A saved view is a set of filters, not a different wallet.
    say(/const matchers = state\.inv\.matchers;/.test(labSrc)
        && /state\.inv\.matchers = matchers;/.test(labSrc),
        'loading a saved view keeps the marks it did not ask to lose');
    const viewCase = labSrc.split("case 'inv-load-view'")[1]?.split('case ')[0] ?? '';
    say(/warmInventoryRecipes\(\)/.test(viewCase),
        'and starts the read if there was none, so a view saved with the toggle on is not stranded');

    // A worker left over from a previous wallet wrote "loading" into the
    // state that replaced it and then abandoned it, so two collections
    // said "Reading the recipes of 2 more collections" for the rest of
    // the session. Seen on the live site, not in a test.
    say(/const mine = inv;/.test(labSrc) && /state\.inv !== mine \|\| mine\.matchersFor !== owner/.test(labSrc),
        'the warm pass writes only into the inventory it started for');
    say(!/state\.inv\.matchers\[collection\] = 'loading'/.test(labSrc),
        'and never into whichever inventory happens to be current when it wakes up');
    const settleOnce = (labSrc.match(/mine\.matchers\[collection\] = result;/g) ?? []).length;
    say(settleOnce === 1,
        'a started collection is always settled: one write, after one guard, on both paths');
    const retryCase = labSrc.split("case 'inv-uses-again'")[1]?.split('case ')[0] ?? '';
    say(/state\.inv !== mine/.test(retryCase),
        'and the retry rebuild follows the same rule');

    // The count can only ever be a floor: one collection each, NeftyBlocks
    // only, and a blend can live elsewhere and still take your NFT.
    say(/At least \$\{usableCount/.test(labSrc) && !/usableFloor \? 'At least '/.test(labSrc),
        'the usable count is always stated as a floor, never as a total');
    say(/of the \$\{inv\.assets\.length/.test(labSrc),
        'and it says what it is a count OF, so a filter cannot make it read as impossible');
    say(/own collection are searched, so this is a floor/.test(labSrc),
        'and the screen says why');
  }

  // The gate, after every phase. It used to sit above the last one, so a
  // failure there was collected and then never checked: the suite printed
  // FAIL and exited 0.
  console.log('');
  if (fails.length) {
    console.log(`=== ${fails.length} FAILURE(S) ===`);
    for (const f of fails) console.log('   ' + f);
    process.exit(1);
  }
  console.log('=== ALL LAB TOOL CHECKS PASS ===');
}
main().catch((e) => { console.error(e); process.exit(1); });
