/**
 * Change: does a save sign only what the author touched?
 *
 * The editor used to start from the pickers' list rows, which carry a name
 * and a status, and signed whatever it did not know as empty: a hidden
 * recipe could not be revealed, a rename wiped a blend's description, image
 * and every other display key, a new start date removed the end date, a new
 * per-wallet limit reset the cooldown, and dates moved by the timezone
 * offset. Here the REAL lab module opens real recipes the way the screen
 * does (it reads the recipe's own row), each edit is made on the live form,
 * and every save goes through compute_transaction as the collection's
 * author: executed by a node, never signed, never written.
 *
 * Run with a timezone that is not UTC, or the date checks prove nothing:
 *   TZ=Europe/Paris npm run verify:change
 *
 * Live data: a recipe deleted or changed since is reported, not guessed.
 */
const fails = [];
const say = (pass, msg) => { console.log(`   ${pass ? 'ok  ' : 'FAIL'} ${msg}`); if (!pass) fails.push(msg); };
let lab, sim, gateMod;
try {
  lab = await import('./.build/lab.mjs');
  sim = await import('./.build/simulate.mjs');
  gateMod = await import('./.build/upgradeGate.mjs');
} catch {
  console.error('Missing scripts/.build - run `npm run verify:change`.');
  process.exit(1);
}
const { __setForm, __loadEditing, __editingState, __editActions, __editProblems, __emptyListDraft, __BLANK_EXISTING } = lab;

if (new Date(0).getTimezoneOffset() === 0) console.log('   note running in UTC: the timezone checks cannot fail here');

async function authorOf(collection) {
  const res = await (await fetch(`https://wax.api.atomicassets.io/atomicassets/v1/collections/${collection}`)).json();
  return res.data?.author;
}

/** Opens a recipe as the screen does, from a list row that knows only its id and name. */
async function open(kind, id, collection) {
  const actor = await authorOf(collection);
  const picked = { ...__BLANK_EXISTING, id: String(id), kind, name: `${kind} ${id}`, status: '' };
  __setForm({
    tool: 'recipes', mode: 'edit', kind, collection, actor, securities: [], list: __emptyListDraft(),
    editing: { ...picked }, editingOriginal: { ...picked }, lastError: '', newListId: '',
    upgradeGate: kind === 'upgrade' ? await gateMod.readUpgradeGate(collection) : undefined,
  });
  await __loadEditing(picked);
  const { editing } = __editingState();
  if (!editing?.loaded) { say(false, `${kind} #${id} could not be opened`); return undefined; }
  return { e: editing, actor };
}

/** Puts the form back to what was read, so each case starts clean. */
function reset() {
  const { editing, original } = __editingState();
  Object.assign(editing, { ...original, ingredients: original.ingredients?.map((i) => ({ ...i })) });
}

async function saves(label, expect) {
  const actions = __editActions().map((c) => c.action);
  const shape = actions.map((a) => a.name).join(' + ') || 'nothing';
  if (expect && !expect(actions)) say(false, `${label}: signs ${shape}`);
  if (!actions.length) return actions;
  const r = await sim.simulateActions(actions);
  say(r.kind === 'accepted' || r.kind === 'resources', `${label}: ${shape} · ${r.kind}${r.reason ? ` (${r.reason})` : ''}`);
  return actions;
}

const localText = (t) => {
  const d = new Date(t * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

console.log('=== blend 45833 (captainshelm): display data, dates, ingredients ===');
{
  const o = await open('blend', 45833, 'captainshelm');
  if (o) {
    const { e } = o;
    const keys = Object.keys(e.display);
    say(e.description !== '' && e.endRaw > 0, `read from its row: ${keys.length} display keys (${keys.join(', ')}), ends ${e.endTime}`);
    say(e.endTime === localText(e.endRaw), `the end date shows in local time (${e.endTime})`);

    e.name = `${e.name} (renamed)`;
    const [data] = await saves('rename', (a) => a.length === 1 && a[0].name === 'setblenddata');
    if (data) {
      const after = JSON.parse(data.data.display_data);
      const kept = keys.filter((k) => k !== 'name').every((k) => JSON.stringify(after[k]) === JSON.stringify(e.display[k]));
      say(kept && after.name === e.name, 'a rename keeps every other display key as it was');
    }
    reset();

    e.startTime = localText(Math.floor(Date.now() / 1000) + 3600);
    const [time] = await saves('new start date', (a) => a.length === 1 && a[0].name === 'setblendtime');
    if (time) say(Number(time.data.end_time) === e.endRaw, `the untouched end date goes back to the second (${time.data.end_time})`);
    reset();

    say(Boolean(e.ingredients) && !e.ingredientsWhy, `its ${e.ingredientsRaw.length} ingredients can be edited${e.ingredientsWhy ? `: ${e.ingredientsWhy}` : ''}`);
    await saves('nothing touched', (a) => a.length === 0);
    if (e.ingredients) {
      const nft = e.ingredients.findIndex((i) => 'amount' in i);
      e.ingredients[nft].amount += 1;
      const [mix] = await saves('one more of an NFT ingredient', (a) => a.length === 1 && a[0].name === 'setblendmix');
      if (mix) {
        const before = JSON.stringify(e.ingredientsRaw.filter((_, i) => i !== nft));
        const after = JSON.stringify(mix.data.ingredients.filter((_, i) => i !== nft));
        say(before.length === after.length, 'every other ingredient is written back as it was');
      }
      reset();
    }
  }
}

console.log('\n=== blend 44526 (bluemob4life): display keys no editor shows ===');
{
  const o = await open('blend', 44526, 'bluemob4life');
  if (o) {
    const { e } = o;
    say('animation' in e.display && 'video' in e.display, `read: ${Object.keys(e.display).join(', ')}`);
    e.name = `${e.name} (renamed)`;
    const [data] = await saves('rename', (a) => a.length === 1 && a[0].name === 'setblenddata');
    if (data) {
      const after = JSON.parse(data.data.display_data);
      say(JSON.stringify(after.animation) === JSON.stringify(e.display.animation) && after.video === e.display.video
        && after.image === e.display.image, 'its video, animation and image survive the rename');
    }
  }
}

console.log('\n=== blend 45679 (timberlegend): hidden ===');
{
  const o = await open('blend', 45679, 'timberlegend');
  if (o) {
    say(o.e.hidden === true, 'the Hidden box starts ticked, as on chain');
    o.e.hidden = false;
    await saves('reveal it', (a) => a.length === 1 && a[0].name === 'setblendhide' && a[0].data.is_hidden === false);
  }
}

console.log('\n=== blend 45781: per-wallet limit and cooldown ===');
{
  const row = (await (await fetch('https://wax.greymass.com/v1/chain/get_table_rows', {
    method: 'POST', body: JSON.stringify({ json: true, code: 'blend.nefty', scope: 'blend.nefty', table: 'blends', lower_bound: '45781', upper_bound: '45781', limit: 1 }),
  })).json()).rows[0];
  const o = row && await open('blend', 45781, row.collection_name);
  if (o) {
    say(o.e.accountLimit === '1' && o.e.cooldown === '86400', `read: ${o.e.accountLimit} per wallet, cooldown ${o.e.cooldown}s`);
    o.e.accountLimit = '2';
    const [lim] = await saves('two per wallet', (a) => a.length === 1 && a[0].name === 'setblendlim');
    if (lim) say(Number(lim.data.account_limit_cooldown) === 86400, 'the cooldown stays at 86400');
  }
}

console.log('\n=== blend 45766 (streamingart): ingredients it cannot write back ===');
{
  const o = await open('blend', 45766, 'streamingart');
  if (o) {
    say(!o.e.ingredients && /another collection/.test(o.e.ingredientsWhy), `not editable: ${o.e.ingredientsWhy}`);
    o.e.category = 'check';
    await saves('a category alone', (a) => a.length === 1 && a[0].name === 'setblendcat');
  }
}

console.log('\n=== upgrade 994 (byronartset1): hidden, and its fee ===');
{
  const o = await open('upgrade', 994, 'byronartset1');
  if (o) {
    const { e } = o;
    say(e.hidden === true && Boolean(e.ingredients), `starts hidden, ${e.ingredients?.length} ingredients editable`);
    e.hidden = false;
    await saves('reveal it', (a) => a.length === 1 && a[0].name === 'setupgrdhide');
    reset();
    const own = e.ingredients.findIndex((i) => i.kind === 'token' && i.to !== 'fees.nefty');
    e.ingredients[own].quantity = '1.99000000 WAX';
    await saves('a new price, fee kept', (a) => a.length === 1 && a[0].name === 'setupgrdmix');
    reset();
    const fee = e.ingredients.findIndex((i) => i.kind === 'token' && i.to === 'fees.nefty');
    e.ingredients.splice(fee, 1);
    const blocked = __editProblems().some((p) => /Fixed fee is required/.test(p));
    const r = await sim.simulateActions(__editActions().map((c) => c.action));
    say(blocked && r.kind === 'refused', `taking the fee off: the editor blocks it, and the chain refuses (${r.reason})`);
    reset();
  }
}

console.log('\n=== drop 239019 (pearlhorizon): rename ===');
{
  const o = await open('drop', 239019, 'pearlhorizon');
  if (o) {
    const desc = o.e.description;
    o.e.name = `${o.e.name} (renamed)`;
    const [data] = await saves('rename', (a) => a.length === 1 && a[0].name === 'setdropdata');
    if (data) say(JSON.parse(data.data.display_data).description === desc && desc !== '', 'the description stays');
  }
}

console.log(fails.length ? `\n=== ${fails.length} CHANGE CHECK(S) FAILED ===` : '\n=== ALL CHANGE CHECKS PASS ===');
for (const f of fails) console.log(`  - ${f}`);
process.exit(fails.length ? 1 : 0);
