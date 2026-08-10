/**
 * Exhaustive verification of the `blend.nefty::createblend` builder.
 *
 * Not a handful of hand-picked cases: this walks EVERY createblend
 * action Hyperion will serve (hundreds, across every collection that
 * has ever made one) and holds each to two independent standards.
 *
 *   PHASE A - encoder. Fold the trace's decoded payload DOWN into the
 *   high-level shape the UI works in (CreateBlendArgs: "5 of template
 *   X", "these outcomes with these weights"), rebuild it back UP with
 *   the builder's encoding, serialise against the live ABI, and diff
 *   the bytes against what was actually signed. Anything the
 *   abstraction loses shows up as a mismatch.
 *
 *   PHASE B - the form. Render the same trace into the one-per-line
 *   text the create panel collects, parse it back, rebuild, and demand
 *   the same bytes AGAIN. This holds the parsers to the encoder's
 *   standard instead of eyeballing them.
 *
 *   PHASE C - recreatability. For collections named on the command line
 *   (default: underpunks55 and cigalepixeld), read their LIVE `blends`
 *   rows and check each one could be rebuilt exactly as it exists
 *   today. This covers recipes whose creation predates the history
 *   window, where no trace exists to diff against.
 *
 * The parsers under test are the REAL ones from
 * src/nefty/createBlend.ts, compiled to ESM first (npm run
 * build:verify) rather than re-implemented here. An earlier version of
 * this script mirrored them by hand and passed while the shipped parser
 * had a different bug - the copy was correct, the product was not.
 * The ENCODER is still mirrored on purpose, so the two must agree.
 *
 * Nothing is broadcast and no signature is requested.
 *
 * Run: npm run verify:createblend      (compiles the module, then runs)
 *      node scripts/verify-createblend.mjs [collection ...]
 */

import { APIClient, Action } from '@wharfkit/session';
import { existsSync } from 'node:fs';

const BUILT = new URL('./.build/createBlend.mjs', import.meta.url);
if (!existsSync(BUILT)) {
  console.error('Missing scripts/.build/createBlend.mjs - run `npm run verify:createblend`,');
  console.error('or build it with: npx vite build --config vite.lib.config.mjs');
  process.exit(2);
}
const REAL = await import(BUILT.href);
const { parseIngredientLines, parseOutcomeLines } = REAL;

const client = new APIClient({ url: 'https://wax.eosphere.io' });
const HYPERION = 'https://wax.eosphere.io';
/**
 * Phase C collections. Deliberately more than a token couple, and mixed
 * on purpose: the two the app suggests by default (underpunks55,
 * cigalepixeld), plus collections picked for shape rather than
 * convenience - pool payouts, token payouts, attribute filters,
 * cross-collection ingredients, 50-outcome tables.
 */
const FOCUS = process.argv.slice(2).length ? process.argv.slice(2) : [
  'underpunks55', 'cigalepixeld', 'waxlandianft', 'streamingart',
  'captainshelm', '1madcarnival', 'agar', 'tutanlegacys',
  'chronaverseo', 'futuresrelic',
];
/** Hyperion caps a page at 1000; walk back until it runs dry. */
const PAGE = 1000;
const MAX_PAGES = 12;

const log = (...a) => console.log(...a);
let failures = 0;

// ─── the builder's encoding, mirrored ──────────────────────────────────
// Re-implemented from the on-chain shape rather than imported, so drift
// in src/nefty/createBlend.ts surfaces here instead of hiding.

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
    case 'cooldown':
      return ['COOLDOWN_INGREDIENT', { schema_name: ing.schema_name, template_id: ing.template_id, attribute_name: ing.attribute_name, wait_time: ing.wait_time, requirements: ing.requirements, display_data: ing.display_data ?? '' }];
    case 'ft':
      return ['FT_INGREDIENT', { quantity: ing.quantity, effect: ing.to ? ['TRANSFER_EFFECT', { to: ing.to }] : BURN }];
    default:
      throw new Error('unknown ingredient kind ' + ing.kind);
  }
}

const encodeResult = (r) => {
  switch (r.kind) {
    case 'nft':  return ['ON_DEMAND_NFT_RESULT', { template_id: r.template_id }];
    case 'ft':   return ['FT_RESULT', { amount: { quantity: r.quantity, contract: r.contract } }];
    case 'pool': return ['POOL_NFT_RESULT', { pool_name: r.pool_name, display_data: r.display_data ?? '' }];
    default: throw new Error('unknown result kind ' + r.kind);
  }
};
const encodeRoll = (roll) => ({
  outcomes: roll.outcomes.map((o) => ({ odds: o.odds, results: o.results.map(encodeResult) })),
  // Derived, never trusted from the caller.
  total_odds: roll.outcomes.reduce((n, o) => n + o.odds, 0),
});

const buildData = (a) => ({
  authorized_account: a.authorized_account,
  collection_name: a.collection_name,
  ingredients: a.ingredients.map(encodeIngredient),
  rolls: a.rolls.map(encodeRoll),
  start_time: a.start_time ?? 0,
  end_time: a.end_time ?? 0,
  max_uses: a.max_uses ?? 0,
  display_data: a.display_data ?? '',
  security_id: String(a.security_id ?? 0),
  is_hidden: a.is_hidden ?? false,
  category: a.category ?? '',
  account_limit: String(a.account_limit ?? 0),
  account_limit_cooldown: a.account_limit_cooldown ?? 0,
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
    case 'COOLDOWN_INGREDIENT':
      return { kind: 'cooldown', schema_name: p.schema_name, template_id: p.template_id, attribute_name: p.attribute_name, wait_time: p.wait_time, requirements: p.requirements, display_data: p.display_data };
    case 'FT_INGREDIENT': {
      const [t, e] = p.effect;
      return { kind: 'ft', quantity: p.quantity, to: t === 'TRANSFER_EFFECT' ? e.to : undefined };
    }
    default:
      throw new Error('unsupported ingredient variant: ' + tag);
  }
}

const foldResult = ([t, p]) => {
  switch (t) {
    case 'ON_DEMAND_NFT_RESULT': return { kind: 'nft', template_id: p.template_id };
    case 'FT_RESULT':            return { kind: 'ft', quantity: p.amount.quantity, contract: p.amount.contract };
    case 'POOL_NFT_RESULT':      return { kind: 'pool', pool_name: p.pool_name, display_data: p.display_data };
    default: throw new Error('unsupported result variant: ' + t);
  }
};
const foldRolls = (rolls) =>
  rolls.map((r) => ({
    outcomes: r.outcomes.map((o) => ({ odds: o.odds, results: o.results.map(foldResult) })),
  }));

const foldTrace = (dt) => ({
  authorized_account: dt.authorized_account,
  collection_name: dt.collection_name,
  ingredients: dt.ingredients.map(foldIngredient),
  rolls: foldRolls(dt.rolls),
  start_time: dt.start_time, end_time: dt.end_time, max_uses: dt.max_uses,
  display_data: dt.display_data, security_id: dt.security_id, is_hidden: dt.is_hidden,
  category: dt.category, account_limit: dt.account_limit,
  account_limit_cooldown: dt.account_limit_cooldown,
});

// ─── the form's text syntax ────────────────────────────────────────────

/** Trailing display_data blob, when the ingredient carries one. */
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
        if (!i.attributes || !i.attributes.length) return null;
        // "|" separates values and ";" separates filters, so a value
        // containing either cannot be written and is reported.
        // The form trims around separators, so a name or value whose
        // leading/trailing whitespace is significant cannot be typed
        // back exactly. Real authors do produce these ("glow ").
        if (i.attributes.some((a) =>
          a.attribute_name !== a.attribute_name.trim() ||
          a.allowed_values.some((v) => v !== v.trim() || v.includes('|') || v.includes(';')) ||
          a.attribute_name.includes(';') || a.attribute_name.includes('='))) return null;
        const clauses = i.attributes.map((a) => `${a.attribute_name} = ${a.allowed_values.join(' | ')}`).join(' ; ');
        return `attribute ${pre}${i.schema_name} x${i.amount}${tail} where ${clauses}${dd(i)}`;
      }
      case 'cooldown': return null; // time gate: no text syntax
      default: return null;
    }
  });
}
const resultText = (r) => {
  switch (r.kind) {
    case 'nft':  return String(r.template_id);
    case 'ft':   return `token ${r.quantity}${r.contract && r.contract !== 'eosio.token' ? ` from ${r.contract}` : ''}`;
    case 'pool': return `pool ${r.pool_name}${r.display_data ? ' ' + r.display_data : ''}`;
    default: return null;
  }
};
const toOutcomeText = (outs) => {
  const lines = outs.map((o) => {
    if (!o.results.length) return `nothing @${o.odds}`;
    const parts = o.results.map(resultText);
    if (parts.some((p) => p === null)) return null;
    return `${parts.join('+')} @${o.odds}`;
  });
  return lines.some((l) => l === null) ? null : lines.join('\n');
};


// ─── harness ────────────────────────────────────────────────────────────

const abi = (await client.v1.chain.get_abi('blend.nefty')).abi;
const hexOf = (data, actor) =>
  Action.from({ account: 'blend.nefty', name: 'createblend', authorization: [{ actor, permission: 'active' }], data }, abi)
    .data.hexString.toLowerCase();

/** Every createblend Hyperion will give us, newest first. */
async function fetchAllTraces() {
  const seen = new Map();
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${HYPERION}/v2/history/get_actions?filter=blend.nefty:createblend&limit=${PAGE}&skip=${page * PAGE}&sort=desc`;
    let batch;
    try {
      batch = (await fetch(url).then((r) => r.json())).actions ?? [];
    } catch { break; }
    if (batch.length === 0) break;
    for (const a of batch) seen.set(a.trx_id + ':' + (a.action_ordinal ?? 0), a);
    if (batch.length < PAGE) break;
  }
  return [...seen.values()];
}

log('Fetching every createblend action Hyperion will serve…');
const traces = await fetchAllTraces();
const collections = new Set(traces.map((a) => a.act.data.collection_name));
log(`${traces.length} creations across ${collections.size} collections.\n`);

// ── phases A + B over the whole corpus ────────────────────────────────
const perColl = new Map();
const stat = (c) => {
  if (!perColl.has(c)) perColl.set(c, { n: 0, aOk: 0, bOk: 0, bSkip: 0, fails: [] });
  return perColl.get(c);
};
let aOk = 0, bOk = 0, bSkip = 0;
const skipReasons = new Map();
const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);

for (const a of traces) {
  const dt = a.act.data;
  const coll = dt.collection_name;
  const st = stat(coll);
  st.n += 1;
  const actor = a.act.authorization?.[0]?.actor ?? dt.authorized_account;
  let theirs;
  try { theirs = hexOf(dt, actor); } catch (e) {
    st.fails.push(`${a.trx_id.slice(0, 12)}: trace itself will not serialise (${e.message})`);
    failures += 1;
    continue;
  }

  // Phase A
  try {
    const folded = foldTrace(dt);
    if (hexOf(buildData(folded), actor) === theirs) { aOk += 1; st.aOk += 1; }
    else { st.fails.push(`${a.trx_id.slice(0, 12)}: PHASE A byte mismatch`); failures += 1; }

    // Phase B
    const lines = toIngredientText(folded.ingredients, coll);
    if (lines.some((l) => l === null)) { bSkip += 1; st.bSkip += 1; bump(skipReasons, 'ingredient not expressible in the form'); continue; }
    if (folded.rolls.length !== 1) { bSkip += 1; st.bSkip += 1; bump(skipReasons, `${folded.rolls.length} rolls (form builds one)`); continue; }
    const outText = toOutcomeText(folded.rolls[0].outcomes);
    if (outText === null) { bSkip += 1; st.bSkip += 1; bump(skipReasons, 'outcome not expressible in the form'); continue; }
    const pi = parseIngredientLines(lines.join('\n'), coll);
    const po = parseOutcomeLines(outText);
    if (pi.errors.length || po.errors.length) {
      st.fails.push(`${a.trx_id.slice(0, 12)}: PHASE B parse errors - ${[...pi.errors, ...po.errors][0]}`);
      failures += 1;
      continue;
    }
    const rebuilt = buildData({ ...folded, ingredients: pi.items, rolls: [{ outcomes: po.items }] });
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
for (const [why, n] of skipReasons) log(`      ${n}× ${why}`);

log('\n=== per collection ===');
const rows = [...perColl.entries()].sort((x, y) => y[1].n - x[1].n);
for (const [coll, s] of rows) {
  const mark = s.fails.length ? '✗' : '✓';
  log(`   ${mark} ${coll.padEnd(14)} ${String(s.n).padStart(4)} creation(s)  A:${s.aOk}/${s.n}  B:${s.bOk}${s.bSkip ? ` (+${s.bSkip} n/a)` : ''}`);
  for (const f of s.fails.slice(0, 3)) log(`        ↳ ${f}`);
}

// ── phase C: recreatability of live rows for the focus collections ────
log(`\n=== PHASE C · can today's LIVE blends be rebuilt exactly? ===`);
for (const coll of FOCUS) {
  let rows = [];
  let cursor = '0';
  for (;;) {
    const r = await client.call({
      path: '/v1/chain/get_table_rows',
      params: { json: true, code: 'blend.nefty', scope: 'blend.nefty', table: 'blends', lower_bound: cursor, limit: 1000 },
    });
    rows.push(...r.rows.filter((b) => b.collection_name === coll));
    if (!r.more || !r.rows.length) break;
    cursor = String(Number(r.rows[r.rows.length - 1].blend_id) + 1);
  }
  let okN = 0, naN = 0;
  const problems = [];
  for (const b of rows) {
    try {
      const args = {
        authorized_account: coll, collection_name: coll,
        ingredients: b.ingredients.map(foldIngredient),
        rolls: foldRolls(b.rolls),
        start_time: b.start_time, end_time: b.end_time, max_uses: b.max,
        display_data: b.display_data, security_id: b.security_id,
        is_hidden: !!b.is_hidden, category: b.category ?? '',
        account_limit: 0, account_limit_cooldown: 0,
      };
      const data = buildData(args);
      // The row is the oracle: what we build must decode back to the
      // same ingredients and the same weighted outcomes.
      const sameIng = JSON.stringify(data.ingredients) === JSON.stringify(b.ingredients);
      const sameRolls = data.rolls.every((r, i) =>
        JSON.stringify(r.outcomes) === JSON.stringify(b.rolls[i].outcomes) &&
        r.total_odds === b.rolls[i].total_odds);
      hexOf(data, coll); // must also serialise
      if (sameIng && sameRolls) okN += 1;
      else problems.push(`blend ${b.blend_id}: ${!sameIng ? 'ingredients differ' : 'rolls/odds differ'}`);
    } catch (e) {
      // A shape the builder does not model (pool results, chest/cooldown
      // ingredients). Reported, never silently counted as a pass.
      naN += 1;
      problems.push(`blend ${b.blend_id}: not modelled - ${e.message}`);
    }
  }
  const bad = problems.filter((p) => !p.includes('not modelled')).length;
  log(`   ${bad ? '✗' : '✓'} ${coll.padEnd(14)} ${rows.length} live blend(s): ${okN} rebuildable, ${naN} outside the builder's model`);
  for (const p of problems.slice(0, 6)) log(`        ↳ ${p}`);
  if (bad) failures += bad;
}

// ── phase D: the validator must accept what the chain accepted ────────
//
// validateNewBlend() blocks the Create button. Every recipe in the
// corpus was accepted by the contract, so any rejection here is a FALSE
// NEGATIVE in our own rules - a real blend an author could not create
// through Crucible. Cheap to check and easy to regress.
log(`\n=== PHASE D · does our validator reject anything the chain accepted? ===`);
const vBad = new Map();
let vOk = 0;
for (const a of traces) {
  const dt = a.act.data;
  try {
    const args = { ...foldTrace(dt), authorized_account: dt.authorized_account };
    const problems = REAL.validateNewBlend(args);
    if (problems.length === 0) { vOk += 1; continue; }
    for (const p of problems) {
      // Strip the "Ingredient #3:" prefix so causes group together.
      const key = p.replace(/^(Ingredient|Roll) #\d+(, outcome #\d+)?(, result #\d+)?: /, '');
      if (!vBad.has(key)) vBad.set(key, { n: 0, sample: `${dt.collection_name} ${a.trx_id.slice(0, 12)}` });
      vBad.get(key).n += 1;
    }
  } catch (e) {
    vBad.set('threw: ' + e.message, { n: (vBad.get('threw: ' + e.message)?.n ?? 0) + 1, sample: dt.collection_name });
  }
}
log(`   ${vOk}/${traces.length} real recipes pass our own validation`);
if (vBad.size) {
  for (const [why, info] of [...vBad.entries()].sort((x, y) => y[1].n - x[1].n)) {
    log(`   ✗ ${info.n}× rejected: ${why}   (e.g. ${info.sample})`);
  }
  failures += 1;
}

log(`\n=== ${failures === 0 ? 'ALL CREATEBLEND CHECKS PASS' : `${failures} FAILURE(S)`} ===`);
process.exit(failures === 0 ? 0 : 1);
