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
      say(actions.length === 3 && !actions.includes('waxdao') && !actions.includes('blenderizer'),
          `three actions offered, no platform to choose: ${actions.join(', ')}`);
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

  console.log('');
  if (fails.length) {
    console.log(`=== ${fails.length} FAILURE(S) ===`);
    for (const f of fails) console.log('   ' + f);
    process.exit(1);
  }
  console.log('=== ALL LAB TOOL CHECKS PASS ===');
}
main().catch((e) => { console.error(e); process.exit(1); });
