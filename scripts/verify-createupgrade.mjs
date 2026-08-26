/**
 * Exhaustive verification of the `up.nefty::createupgrde` builder.
 *
 * Same standard as verify-createblend.mjs: every createupgrde action
 * Hyperion will serve, held to four independent checks.
 *
 *   PHASE A - encoder. Fold each trace DOWN into the shape the UI works
 *   in, rebuild it back UP, serialise against the live ABI, diff the
 *   bytes against what was actually signed.
 *
 *   PHASE B - the form. Render the same trace into the one-per-line
 *   text the create panel collects, parse it back with the REAL
 *   parsers, rebuild, and demand the same bytes again.
 *
 *   PHASE C - recreatability. Read LIVE `upgrades` rows for a spread of
 *   collections and check each could be rebuilt exactly as it exists.
 *
 *   PHASE D - validation. Every recipe here was accepted by the
 *   contract, so anything validateNewUpgrade() rejects is a false
 *   negative: a real upgrade an author could not create through
 *   Crucible.
 *
 * The parsers and validator under test are the REAL ones, compiled to
 * ESM by `npm run build:verify`. The ENCODER is mirrored below on
 * purpose so the two implementations must agree.
 *
 * Nothing is broadcast and no signature is requested.
 *
 * Run: npm run verify:createupgrade
 */

import { APIClient, Action } from '@wharfkit/session';
import { existsSync } from 'node:fs';

const BUILT = new URL('./.build/createUpgrade.mjs', import.meta.url);
if (!existsSync(BUILT)) {
  console.error('Missing scripts/.build/createUpgrade.mjs - run `npm run verify:createupgrade`.');
  process.exit(2);
}
const REAL = await import(BUILT.href);

const client = new APIClient({ url: 'https://wax.eosphere.io' });
const HYPERION = 'https://wax.eosphere.io';
const FOCUS = process.argv.slice(2).length ? process.argv.slice(2) : [
  'underpunks55', 'cigalepixeld', 'agarwoodwtwo', 'trashtestnft', 'novopangeaio',
];
const PAGE = 1000;
const MAX_PAGES = 6;

const log = (...a) => console.log(...a);
let failures = 0;

// ─── the builder's encoding, mirrored ──────────────────────────────────

const BURN = ['TYPED_EFFECT', { type: 0 }];
const nftEffect = (i) => (i.transfer_to ? ['TRANSFER_EFFECT', { to: i.transfer_to }] : BURN);

function encodeIngredient(ing) {
  switch (ing.kind) {
    case 'template':
      return ['TEMPLATE_INGREDIENT', { template_id: ing.template_id, collection_name: ing.collection_name, amount: ing.amount, effect: nftEffect(ing) }];
    case 'schema':
      return ['SCHEMA_INGREDIENT', { collection_name: ing.collection_name, schema_name: ing.schema_name, display_data: ing.display_data ?? '', amount: ing.amount, effect: nftEffect(ing) }];
    case 'attribute':
      return ['ATTRIBUTE_INGREDIENT', { collection_name: ing.collection_name, schema_name: ing.schema_name, display_data: ing.display_data ?? '', attributes: ing.attributes, amount: ing.amount, effect: nftEffect(ing) }];
    case 'collection':
      return ['COLLECTION_INGREDIENT', { collection_name: ing.collection_name, amount: ing.amount, effect: nftEffect(ing) }];
    case 'ft':
      return ['FT_INGREDIENT', { quantity: ing.quantity, effect: ing.to ? ['TRANSFER_EFFECT', { to: ing.to }] : BURN }];
    case 'typed_attribute':
      return ['TYPED_ATTRIBUTE_INGREDIENT', { collection_name: ing.collection_name, schema_name: ing.schema_name, display_data: ing.display_data ?? '', attributes: ing.attributes, amount: ing.amount, effect: nftEffect(ing) }];
    default:
      throw new Error('unsupported ingredient kind ' + ing.kind);
  }
}

const wireTypeFor = (t) =>
  t === 'uint64' ? 'uint64' : t === 'double' ? 'float64' : (t === 'bool' || t === 'uint8') ? 'uint8' : 'string';
const vecTypeFor = (t) =>
  t === 'uint64' ? 'UINT64_VEC' : t === 'double' ? 'DOUBLE_VEC' : (t === 'bool' || t === 'uint8') ? 'UINT8_VEC' : 'STRING_VEC';
/** Each vector type has its own wire shape; see createUpgrade.ts. */
const encodeAllowedValues = (t, vs) => {
  const tag = vecTypeFor(t);
  if (tag === 'UINT8_VEC') return [tag, vs.map((v) => (Number(v) & 0xff).toString(16).padStart(2, '0')).join('')];
  if (tag === 'UINT64_VEC') return [tag, vs.map(String)];
  if (tag === 'DOUBLE_VEC') return [tag, vs.map(Number)];
  return [tag, vs.map(String)];
};
const decodeAllowedValues = (t, enc) => {
  if (vecTypeFor(t) !== 'UINT8_VEC') return Array.isArray(enc) ? enc : [];
  const hex = String(enc ?? ''); const out = [];
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
};

const encodeRequirement = (r) => {
  switch (r.kind) {
    case 'template':  return ['TEMPLATE_REQUIREMENT', { template_id: r.template_id }];
    case 'templates': return ['TEMPLATES_REQUIREMENT', { template_ids: r.template_ids }];
    case 'attribute': return ['TYPED_ATTRIBUTE_REQUIREMENT', {
      typed_attribute_definition: {
        attribute_name: r.attribute_name, attribute_type: r.attribute_type,
        allowed_values: encodeAllowedValues(r.attribute_type, r.allowed_values),
        comparator: r.comparator ?? 0,
      } }];
    default: throw new Error('unsupported requirement kind ' + r.kind);
  }
};

const encodeResult = (r) => ({
  attribute_name: r.attribute_name,
  attribute_type: r.attribute_type,
  op: { type: r.op },
  value: ['IMMEDIATE_VALUE', [wireTypeFor(r.attribute_type), r.value]],
});

const encodeSpec = (s) => ({
  schema_name: s.schema_name,
  upgrade_requirements: s.requirements.map(encodeRequirement),
  upgrade_results: s.results.map(encodeResult),
  display_data: s.display_data ?? '',
});

const buildData = (a) => ({
  authorized_account: a.authorized_account,
  collection_name: a.collection_name,
  ingredients: a.ingredients.map(encodeIngredient),
  upgrade_specs: a.specs.map(encodeSpec),
  start_time: a.start_time ?? 0,
  end_time: a.end_time ?? 0,
  max_uses: a.max_uses ?? 0,
  display_data: a.display_data ?? '',
  security_id: String(a.security_id ?? 0),
  is_hidden: a.is_hidden ?? false,
  category: a.category ?? '',
});

// ─── folding a trace down ──────────────────────────────────────────────

const foldNftEffect = (e) => (Array.isArray(e) && e[0] === 'TRANSFER_EFFECT' ? e[1].to : undefined);

function foldIngredient([tag, p]) {
  switch (tag) {
    case 'TEMPLATE_INGREDIENT':
      return { kind: 'template', template_id: p.template_id, collection_name: p.collection_name, amount: p.amount, transfer_to: foldNftEffect(p.effect) };
    case 'SCHEMA_INGREDIENT':
      return { kind: 'schema', collection_name: p.collection_name, schema_name: p.schema_name, amount: p.amount, display_data: p.display_data, transfer_to: foldNftEffect(p.effect) };
    case 'ATTRIBUTE_INGREDIENT':
      return { kind: 'attribute', collection_name: p.collection_name, schema_name: p.schema_name, amount: p.amount, display_data: p.display_data, attributes: p.attributes, transfer_to: foldNftEffect(p.effect) };
    case 'COLLECTION_INGREDIENT':
      return { kind: 'collection', collection_name: p.collection_name, amount: p.amount, transfer_to: foldNftEffect(p.effect) };
    case 'TYPED_ATTRIBUTE_INGREDIENT':
      return { kind: 'typed_attribute', collection_name: p.collection_name, schema_name: p.schema_name, amount: p.amount, display_data: p.display_data, attributes: p.attributes, transfer_to: foldNftEffect(p.effect) };
    case 'FT_INGREDIENT': {
      const [t, e] = p.effect;
      return { kind: 'ft', quantity: p.quantity, to: t === 'TRANSFER_EFFECT' ? e.to : undefined };
    }
    default:
      throw new Error('unsupported ingredient variant: ' + tag);
  }
}

function foldRequirement([tag, p]) {
  switch (tag) {
    case 'TEMPLATE_REQUIREMENT':  return { kind: 'template', template_id: p.template_id };
    case 'TEMPLATES_REQUIREMENT': return { kind: 'templates', template_ids: p.template_ids };
    case 'TYPED_ATTRIBUTE_REQUIREMENT': {
      const d = p.typed_attribute_definition;
      const [vecTag, values] = d.allowed_values;
      // The tag must be the one the attribute's type implies, or our
      // derivation is wrong and we would re-encode it differently.
      if (vecTag !== vecTypeFor(d.attribute_type)) {
        throw new Error(`vec tag ${vecTag} does not match type ${d.attribute_type}`);
      }
      return { kind: 'attribute', attribute_name: d.attribute_name, attribute_type: d.attribute_type, allowed_values: decodeAllowedValues(d.attribute_type, values), comparator: d.comparator };
    }
    default: throw new Error('unsupported requirement variant: ' + tag);
  }
}

function foldResult(r) {
  const [tag, inner] = r.value;
  if (tag !== 'IMMEDIATE_VALUE') throw new Error('non-immediate value: ' + tag);
  const [, v] = inner;
  return { attribute_name: r.attribute_name, attribute_type: r.attribute_type, op: r.op.type, value: v };
}

const foldSpec = (s) => ({
  schema_name: s.schema_name,
  requirements: s.upgrade_requirements.map(foldRequirement),
  results: s.upgrade_results.map(foldResult),
  display_data: s.display_data,
});

const foldTrace = (dt) => ({
  authorized_account: dt.authorized_account,
  collection_name: dt.collection_name,
  ingredients: dt.ingredients.map(foldIngredient),
  specs: dt.upgrade_specs.map(foldSpec),
  start_time: dt.start_time, end_time: dt.end_time, max_uses: dt.max_uses,
  display_data: dt.display_data, security_id: dt.security_id,
  is_hidden: dt.is_hidden, category: dt.category,
});

// ─── the form's text syntax ────────────────────────────────────────────

const dd = (i) => (i.display_data ? ` ${i.display_data}` : '');

function toIngredientText(ings, own) {
  return ings.map((i) => {
    const tail = i.transfer_to ? ` -> ${i.transfer_to}` : '';
    const pre = i.collection_name && i.collection_name !== own ? `${i.collection_name}:` : '';
    switch (i.kind) {
      case 'template':   return `template ${pre}${i.template_id} x${i.amount}${tail}`;
      case 'schema':     return `schema ${pre}${i.schema_name} x${i.amount}${tail}${dd(i)}`;
      case 'collection': return `collection ${i.collection_name} x${i.amount}${tail}`;
      case 'ft':         return `token ${i.quantity}${i.to ? ` -> ${i.to}` : ''}`;
      case 'attribute': {
        if (!i.attributes?.length) return null;
        if (i.attributes.some((a) =>
          a.attribute_name !== a.attribute_name.trim() ||
          a.allowed_values.some((v) => v !== v.trim() || v.includes('|') || v.includes(';')) ||
          a.attribute_name.includes(';') || a.attribute_name.includes('='))) return null;
        const clauses = i.attributes.map((a) => `${a.attribute_name} = ${a.allowed_values.join(' | ')}`).join(' ; ');
        return `attribute ${pre}${i.schema_name} x${i.amount}${tail} where ${clauses}${dd(i)}`;
      }
      // typed-attribute costs have no text syntax
      default: return null;
    }
  });
}

function toRequirementText(reqs) {
  const lines = reqs.map((r) => {
    if (r.kind === 'template') return `template ${r.template_id}`;
    if (r.kind === 'templates') return `templates ${r.template_ids.join(' + ')}`;
    // The form writes comparator 0 and STRING_VEC values only.
    if ((r.comparator ?? 0) !== 0) return null;
    if (r.allowed_values.some((v) => String(v).includes('|') || String(v) !== String(v).trim())) return null;
    if (r.attribute_name !== r.attribute_name.trim() || r.attribute_name.includes('=')) return null;
    const type = r.attribute_type === 'string' ? '' : `${r.attribute_type} `;
    return `attribute ${type}${r.attribute_name} = ${r.allowed_values.join(' | ')}`;
  });
  return lines.some((l) => l === null) ? null : lines.join('\n');
}

function toResultText(results) {
  const lines = results.map((r) => {
    const type = r.attribute_type === 'string' ? '' : `${r.attribute_type} `;
    const opSym = r.op === 1 ? '+=' : '=';
    let v = r.value;
    if (r.attribute_type === 'bool') v = v ? 'true' : 'false';
    // A value containing a newline, or a name containing "=", cannot be
    // written on one line.
    if (String(v).includes('\n') || r.attribute_name.includes('=') || r.attribute_name !== r.attribute_name.trim()) return null;
    if (String(v).trim() !== String(v)) return null;
    return `${type}${r.attribute_name} ${opSym} ${v}`;
  });
  return lines.some((l) => l === null) ? null : lines.join('\n');
}

// ─── harness ────────────────────────────────────────────────────────────

const abi = (await client.v1.chain.get_abi('up.nefty')).abi;
const hexOf = (data, actor) =>
  Action.from({ account: 'up.nefty', name: 'createupgrde', authorization: [{ actor, permission: 'active' }], data }, abi)
    .data.hexString.toLowerCase();

async function fetchAll() {
  const seen = new Map();
  for (let page = 0; page < MAX_PAGES; page++) {
    let batch;
    try {
      batch = (await fetch(`${HYPERION}/v2/history/get_actions?filter=up.nefty:createupgrde&limit=${PAGE}&skip=${page * PAGE}&sort=desc`).then((r) => r.json())).actions ?? [];
    } catch { break; }
    if (!batch.length) break;
    for (const a of batch) seen.set(a.trx_id + ':' + (a.action_ordinal ?? 0), a);
    if (batch.length < PAGE) break;
  }
  return [...seen.values()];
}

log('Fetching every createupgrde action Hyperion will serve…');
const traces = await fetchAll();
log(`${traces.length} creations across ${new Set(traces.map((a) => a.act.data.collection_name)).size} collections.\n`);

const perColl = new Map();
const stat = (c) => {
  if (!perColl.has(c)) perColl.set(c, { n: 0, aOk: 0, bOk: 0, bSkip: 0, fails: [] });
  return perColl.get(c);
};
let aOk = 0, bOk = 0, bSkip = 0;
const skips = new Map();
const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);

for (const a of traces) {
  const dt = a.act.data;
  const coll = dt.collection_name;
  const st = stat(coll);
  st.n += 1;
  const actor = a.act.authorization?.[0]?.actor ?? dt.authorized_account;
  let theirs;
  try { theirs = hexOf(dt, actor); } catch (e) {
    st.fails.push(`${a.trx_id.slice(0, 12)}: trace will not serialise (${e.message})`);
    failures += 1;
    continue;
  }
  try {
    const folded = foldTrace(dt);
    if (hexOf(buildData(folded), actor) === theirs) { aOk += 1; st.aOk += 1; }
    else { st.fails.push(`${a.trx_id.slice(0, 12)}: PHASE A byte mismatch`); failures += 1; }

    if (folded.specs.length !== 1) { bSkip += 1; st.bSkip += 1; bump(skips, `${folded.specs.length} specs (form builds one)`); continue; }
    const ingLines = toIngredientText(folded.ingredients, coll);
    if (ingLines.some((l) => l === null)) { bSkip += 1; st.bSkip += 1; bump(skips, 'ingredient not expressible'); continue; }
    const reqText = toRequirementText(folded.specs[0].requirements);
    if (reqText === null) { bSkip += 1; st.bSkip += 1; bump(skips, 'requirement not expressible'); continue; }
    const resText = toResultText(folded.specs[0].results);
    if (resText === null) { bSkip += 1; st.bSkip += 1; bump(skips, 'attribute rewrite not expressible'); continue; }

    const pi = REAL.parseIngredientLines(ingLines.join('\n'), coll);
    const pr = REAL.parseRequirementLines(reqText);
    const px = REAL.parseUpgradeResultLines(resText);
    const errs = [...pi.errors, ...pr.errors, ...px.errors];
    if (errs.length) {
      st.fails.push(`${a.trx_id.slice(0, 12)}: PHASE B parse errors - ${errs[0]}`);
      failures += 1;
      continue;
    }
    const rebuilt = buildData({
      ...folded,
      ingredients: pi.items,
      specs: [{ ...folded.specs[0], requirements: pr.items, results: px.items }],
    });
    if (hexOf(rebuilt, actor) === theirs) { bOk += 1; st.bOk += 1; }
    else { st.fails.push(`${a.trx_id.slice(0, 12)}: PHASE B byte mismatch after text round-trip`); failures += 1; }
  } catch (e) {
    st.fails.push(`${a.trx_id.slice(0, 12)}: ${e.message}`);
    failures += 1;
  }
}

log('=== PHASE A · encoder, byte-for-byte vs every trace ===');
log(`   ${aOk}/${traces.length} rebuilt to identical bytes`);
log('\n=== PHASE B · the form\'s text syntax, round-tripped ===');
log(`   ${bOk} matched, ${bSkip} not expressible by the form`);
for (const [why, n] of skips) log(`      ${n}× ${why}`);

log('\n=== per collection ===');
for (const [coll, s] of [...perColl.entries()].sort((x, y) => y[1].n - x[1].n).slice(0, 25)) {
  log(`   ${s.fails.length ? '✗' : '✓'} ${coll.padEnd(14)} ${String(s.n).padStart(4)}  A:${s.aOk}/${s.n}  B:${s.bOk}${s.bSkip ? ` (+${s.bSkip} n/a)` : ''}`);
  for (const f of s.fails.slice(0, 3)) log(`        ↳ ${f}`);
}

// ── phase C ───────────────────────────────────────────────────────────
log(`\n=== PHASE C · can today's LIVE upgrades be rebuilt exactly? ===`);
for (const coll of FOCUS) {
  const rows = [];
  let cursor = '0';
  for (;;) {
    const r = await client.call({
      path: '/v1/chain/get_table_rows',
      params: { json: true, code: 'up.nefty', scope: 'up.nefty', table: 'upgrades', lower_bound: cursor, limit: 1000 },
    });
    rows.push(...r.rows.filter((u) => u.collection_name === coll));
    if (!r.more || !r.rows.length) break;
    cursor = String(Number(r.rows[r.rows.length - 1].upgrade_id) + 1);
  }
  let okN = 0, naN = 0;
  const problems = [];
  for (const u of rows) {
    try {
      const data = buildData({
        authorized_account: coll, collection_name: coll,
        ingredients: u.ingredients.map(foldIngredient),
        specs: u.upgrade_specs.map(foldSpec),
        start_time: u.start_time, end_time: u.end_time, max_uses: u.max ?? 0,
        display_data: u.display_data, security_id: u.security_id,
        is_hidden: !!u.is_hidden, category: u.category ?? '',
      });
      // A table row and an action payload spell the same value
      // differently: uint64 vectors come back as numbers from the table
      // and go out as strings in an action. Compare semantically.
      const norm = (v) => JSON.parse(JSON.stringify(v), (_k, x) =>
        (typeof x === 'number' ? String(x) : x));
      const same = JSON.stringify(norm(data.ingredients)) === JSON.stringify(norm(u.ingredients))
        && JSON.stringify(norm(data.upgrade_specs)) === JSON.stringify(norm(u.upgrade_specs));
      hexOf(data, coll);
      if (same) okN += 1;
      else problems.push(`upgrade ${u.upgrade_id}: rebuilt shape differs`);
    } catch (e) {
      naN += 1;
      problems.push(`upgrade ${u.upgrade_id}: not modelled - ${e.message}`);
    }
  }
  const bad = problems.filter((p) => !p.includes('not modelled')).length;
  log(`   ${bad ? '✗' : '✓'} ${coll.padEnd(14)} ${rows.length} live upgrade(s): ${okN} rebuildable, ${naN} outside the model`);
  for (const p of problems.slice(0, 5)) log(`        ↳ ${p}`);
  if (bad) failures += bad;
}

// ── phase D ───────────────────────────────────────────────────────────
log(`\n=== PHASE D · does our validator reject anything the chain accepted? ===`);
const vBad = new Map();
let vOk = 0;
for (const a of traces) {
  const dt = a.act.data;
  try {
    const problems = REAL.validateNewUpgrade({ ...foldTrace(dt), authorized_account: dt.authorized_account });
    if (!problems.length) { vOk += 1; continue; }
    for (const p of problems) {
      const key = p.replace(/^Spec #\d+(, (change|requirement) #\d+)?: /, '');
      if (!vBad.has(key)) vBad.set(key, { n: 0, sample: `${dt.collection_name} ${a.trx_id.slice(0, 12)}` });
      vBad.get(key).n += 1;
    }
  } catch (e) {
    const k = 'threw: ' + e.message;
    vBad.set(k, { n: (vBad.get(k)?.n ?? 0) + 1, sample: dt.collection_name });
  }
}
log(`   ${vOk}/${traces.length} real upgrades pass our own validation`);
if (vBad.size) {
  for (const [why, info] of [...vBad.entries()].sort((x, y) => y[1].n - x[1].n)) {
    log(`   ✗ ${info.n}× rejected: ${why}   (e.g. ${info.sample})`);
  }
  failures += 1;
}

// ─── the staking gate: how many ingredients up.nefty will accept ─────────
//
// The only place a collection's NEFTY stake still changes what the chain
// allows. Everything here is derived from live tables independently of the
// module, then compared against it.
log('\n=== the up.nefty staking gate ===');
{
  const gateMod = await import('./.build/upgradeGate.mjs');
  const rpc = async (ep, body) => {
    const r = await fetch(`https://wax.greymass.com/v1/chain/${ep}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return r.json();
  };

  // Derived here, from the raw tables, with no help from the module.
  const cfg = (await rpc('get_table_rows',
    { json: true, code: 'up.nefty', scope: 'up.nefty', table: 'config', limit: 1 })).rows[0];
  const fee = String(cfg?.fixed_fee?.quantity ?? '');
  const feeArmed = /[1-9]/.test(fee.split(' ')[0].replace('.', ''));
  log(`   up.nefty fixed_fee = "${fee}" -> the rule is ${feeArmed ? 'ARMED' : 'inert'}`);

  const tiers = (await rpc('get_table_rows',
    { json: true, code: 'stake.nefty', scope: 'collections', table: 'stakinglevel', limit: 20 })).rows;
  const grants = new Set(tiers
    .filter((t) => (t.enabled_features ?? []).some((f) => f.feature === 'early.access' && f.feature_value?.[1] === 1))
    .map((t) => String(t.stakingname)));
  log(`   tiers granting early.access: ${[...grants].join(', ') || '(none)'}`);
  if (grants.size === 0) { log('   ✗ no tier grants early.access, so the module can never say 1'); failures += 1; }

  // Real collections spanning every case: a level.3 one, a level.zero one,
  // and one that has never staked at all.
  const coll = [];
  let lb = '';
  for (let page = 0; page < 3 && coll.length < 2000; page++) {
    const r = await rpc('get_table_rows', {
      json: true, code: 'stake.nefty', scope: 'stake.nefty', table: 'collstaking',
      limit: 1000, key_type: 'name', lower_bound: lb,
    });
    coll.push(...(lb ? r.rows.slice(1) : r.rows));
    if (!r.more || !r.rows.length) break;
    lb = String(r.rows[r.rows.length - 1].collection_name);
  }
  const pick = (lvl) => coll.find((c) => String(c.stakinglevel) === lvl)?.collection_name;
  const cases = [
    ['level.3', pick('level.3')],
    ['level.zero', pick('level.zero')],
    ['(never staked)', 'zzzzzzzzzzzz'],
  ].filter(([, c]) => c);

  for (const [label, name] of cases) {
    const gate = await gateMod.readUpgradeGate(String(name));
    const expectedLevel = String(coll.find((c) => c.collection_name === name)?.stakinglevel ?? '');
    const expectedEarly = grants.has(expectedLevel);
    const expectedMin = feeArmed && !expectedEarly ? 2 : 1;
    const ok = gate.known && gate.level === expectedLevel
      && gate.earlyAccess === expectedEarly && gate.minIngredients === expectedMin;
    log(`   ${ok ? 'ok  ' : '✗   '} ${label} ${name}: level="${gate.level}" early=${gate.earlyAccess} min=${gate.minIngredients} (expected "${expectedLevel}" / ${expectedEarly} / ${expectedMin})`);
    if (!ok) failures += 1;

    // The sentence has to appear exactly when the recipe would be rejected,
    // and never otherwise. A false warning on a good recipe is its own bug.
    const tooFew = gateMod.upgradeGateProblem(gate, gate.minIngredients - 1);
    const enough = gateMod.upgradeGateProblem(gate, gate.minIngredients);
    if (gate.minIngredients > 1 && !tooFew) { log(`   ✗ ${name}: a 1-ingredient recipe would abort and we say nothing`); failures += 1; }
    if (enough) { log(`   ✗ ${name}: warned about a recipe the chain accepts`); failures += 1; }
  }

  // A failed read must stay silent rather than invent a warning.
  const dead = await gateMod.readUpgradeGate('collection..x', 'no.such.acct');
  if (dead.known || gateMod.upgradeGateProblem(dead, 1)) {
    log('   ✗ an unreadable collection produced a warning instead of silence'); failures += 1;
  } else {
    log('   ok   an unreadable collection stays silent rather than guessing');
  }

  // And the empirical half: Lama's own collections are the reason this
  // exists. underpunks55 and shadowsquads sit at level.3 and 37 of their 38
  // upgrades carry a single ingredient, which is legal only at that tier.
  const lamaLvl = await gateMod.readCollectionLevel('underpunks55');
  const lamaGate = await gateMod.readUpgradeGate('underpunks55');
  log(`   underpunks55 is ${lamaLvl}, so up.nefty accepts ${lamaGate.minIngredients} ingredient(s) from it today`);
  if (lamaGate.known && lamaGate.minIngredients !== (grants.has(lamaLvl) ? 1 : 2)) {
    log('   ✗ the gate disagrees with the tier table for underpunks55'); failures += 1;
  }
}

log(`\n=== ${failures === 0 ? 'ALL CREATEUPGRADE CHECKS PASS' : `${failures} FAILURE(S)`} ===`);
process.exit(failures === 0 ? 0 : 1);
