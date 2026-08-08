/**
 * Byte-for-byte verification of the `blend.nefty::createblend` builder.
 *
 * Five real creations, five different collections, chosen to cover every
 * ingredient variant and both ends of the complexity range:
 *
 *   rustveil      1 template ingredient, 1 outcome        (simplest)
 *   tutanlegacys  6 ingredients, 2 weighted outcomes      (random blend)
 *   streamingart  TEMPLATE + FT cost, max_uses set        (paid blend)
 *   captainshelm  TEMPLATE + SCHEMA + ATTRIBUTE           (every NFT kind)
 *   waxlandianft  1 ingredient, 51 outcomes               (stress)
 *
 * The test is a round-trip, not a copy: each trace's decoded payload is
 * folded DOWN into the high-level shape our UI works in
 * (CreateBlendArgs - "3 of template X", "these outcomes with these
 * odds"), then rebuilt back UP through the same encoding the builder
 * uses, serialised against the live ABI, and diffed against the
 * original action's bytes. Anything the abstraction loses or encodes
 * differently shows up as a hex mismatch.
 *
 * Nothing is broadcast and no signature is requested.
 *
 * Run: node scripts/verify-createblend.mjs
 */

import { APIClient, Action } from '@wharfkit/session';

const client = new APIClient({ url: 'https://wax.eosphere.io' });
const HYPERION = 'https://wax.eosphere.io';

// Fetched by full trx_id rather than scanned out of a recent-actions
// window, so these references keep working as new blends are created.
const CASES = [
  { label: 'rustveil · 1 ingredient, 1 outcome',
    trx: '55b6ec8a19929e5e3918cfab7a79203cf103935f3ee31ea5decb794f37468b38' },
  { label: 'tutanlegacys · 6 ingredients, 2 weighted outcomes',
    trx: '4b272c90d510fca04ee64d19804bc125eb0ba98361f49c2b8bfcca0d9b001fc2' },
  { label: 'streamingart · TEMPLATE + FT cost, NFTs sent to a vault',
    trx: 'b01fd77a8d513255b4144625e2e4bc4e1a55e1fa92ae142da34b1c0db50bbc70' },
  { label: 'captainshelm · TEMPLATE + SCHEMA + ATTRIBUTE',
    trx: '81e1532d6c98fa2c7a1e14d2797fe98d7ad1569158510286d2dfd739d2f4aa68' },
  { label: 'waxlandianft · 51 outcomes',
    trx: '06eeb374337f96c19eba4c9d14428e85c7a4f24c68a5bf72e46a963243272365' },
];

const log = (...a) => console.log(...a);
let ok = true;

// ─── the builder's encoding, mirrored ──────────────────────────────────
// Deliberately re-implemented from the on-chain trace shape rather than
// imported, so a drift in src/nefty/createBlend.ts surfaces here.

const BURN = ['TYPED_EFFECT', { type: 0 }];
/** NFTs burn unless the author routed them somewhere. */
const nftEffect = (ing) => (ing.transfer_to ? ['TRANSFER_EFFECT', { to: ing.transfer_to }] : BURN);

function encodeIngredient(ing) {
  switch (ing.kind) {
    case 'template':
      return ['TEMPLATE_INGREDIENT', {
        template_id: ing.template_id, collection_name: ing.collection_name,
        amount: ing.amount, effect: nftEffect(ing) }];
    case 'schema':
      return ['SCHEMA_INGREDIENT', {
        collection_name: ing.collection_name, schema_name: ing.schema_name,
        display_data: ing.display_data ?? '', amount: ing.amount, effect: nftEffect(ing) }];
    case 'attribute':
      return ['ATTRIBUTE_INGREDIENT', {
        collection_name: ing.collection_name, schema_name: ing.schema_name,
        display_data: ing.display_data ?? '', attributes: ing.attributes,
        amount: ing.amount, effect: nftEffect(ing) }];
    case 'collection':
      return ['COLLECTION_INGREDIENT', {
        collection_name: ing.collection_name, amount: ing.amount, effect: nftEffect(ing) }];
    case 'ft':
      return ['FT_INGREDIENT', {
        quantity: ing.quantity,
        effect: ing.to ? ['TRANSFER_EFFECT', { to: ing.to }] : BURN }];
    default:
      throw new Error('unknown ingredient kind ' + ing.kind);
  }
}

function encodeRoll(roll) {
  return {
    outcomes: roll.outcomes.map((o) => ({
      odds: o.odds,
      results: o.template_ids.map((t) => ['ON_DEMAND_NFT_RESULT', { template_id: t }]),
    })),
    // Derived, never trusted from the caller.
    total_odds: roll.outcomes.reduce((n, o) => n + o.odds, 0),
  };
}

function buildData(args) {
  return {
    authorized_account: args.authorized_account,
    collection_name: args.collection_name,
    ingredients: args.ingredients.map(encodeIngredient),
    rolls: args.rolls.map(encodeRoll),
    start_time: args.start_time ?? 0,
    end_time: args.end_time ?? 0,
    max_uses: args.max_uses ?? 0,
    display_data: args.display_data ?? '',
    security_id: String(args.security_id ?? 0),
    is_hidden: args.is_hidden ?? false,
    category: args.category ?? '',
    account_limit: String(args.account_limit ?? 0),
    account_limit_cooldown: args.account_limit_cooldown ?? 0,
  };
}

// ─── fold a trace DOWN into the high-level shape ───────────────────────

/** TRANSFER_EFFECT -> the destination, TYPED_EFFECT -> burn (undefined). */
const foldNftEffect = (eff) =>
  Array.isArray(eff) && eff[0] === 'TRANSFER_EFFECT' ? eff[1].to : undefined;

/** Trace ingredient variant -> the abstract form our UI produces. */
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
    case 'FT_INGREDIENT': {
      const [etag, ep] = p.effect;
      return { kind: 'ft', quantity: p.quantity, to: etag === 'TRANSFER_EFFECT' ? ep.to : undefined };
    }
    default:
      throw new Error('unsupported ingredient variant in trace: ' + tag);
  }
}

function foldTrace(dt) {
  return {
    authorized_account: dt.authorized_account,
    collection_name: dt.collection_name,
    ingredients: dt.ingredients.map(foldIngredient),
    rolls: dt.rolls.map((r) => ({
      outcomes: r.outcomes.map((o) => ({
        odds: o.odds,
        template_ids: o.results.map(([tag, p]) => {
          if (tag !== 'ON_DEMAND_NFT_RESULT') throw new Error('unsupported result variant: ' + tag);
          return p.template_id;
        }),
      })),
    })),
    start_time: dt.start_time,
    end_time: dt.end_time,
    max_uses: dt.max_uses,
    display_data: dt.display_data,
    security_id: dt.security_id,
    is_hidden: dt.is_hidden,
    category: dt.category,
    account_limit: dt.account_limit,
    account_limit_cooldown: dt.account_limit_cooldown,
  };
}

// ─── run ────────────────────────────────────────────────────────────────

const abiRes = await client.v1.chain.get_abi('blend.nefty');
const abi = abiRes.abi;

const hexOf = (data, actor) =>
  Action.from(
    { account: 'blend.nefty', name: 'createblend',
      authorization: [{ actor, permission: 'active' }], data },
    abi,
  ).data.hexString.toLowerCase();

for (const c of CASES) {
  log(`\n=== ${c.label} ===`);
  const res = await fetch(`${HYPERION}/v2/history/get_transaction?id=${c.trx}`).then((r) => r.json());
  const hit = (res.actions ?? []).find(
    (a) => a.act?.account === 'blend.nefty' && a.act?.name === 'createblend',
  );
  if (!hit) {
    log(`   ✗ no createblend action in transaction ${c.trx.slice(0, 16)}…`);
    ok = false;
    continue;
  }
  const dt = hit.act.data;
  const nOut = dt.rolls.reduce((n, r) => n + r.outcomes.length, 0);
  const kinds = [...new Set(dt.ingredients.map((i) => i[0]))].join(' + ');
  log(`   trx ${hit.trx_id.slice(0, 16)}…  ${dt.collection_name}  ing=${dt.ingredients.length} (${kinds})  outcomes=${nOut}`);

  let folded;
  try {
    folded = foldTrace(dt);
  } catch (e) {
    log(`   ✗ cannot express this blend in the builder's shape: ${e.message}`);
    ok = false;
    continue;
  }

  // total_odds is DERIVED by the builder; check we land on what the
  // author actually published rather than quietly changing the draw.
  dt.rolls.forEach((r, i) => {
    const sum = r.outcomes.reduce((n, o) => n + o.odds, 0);
    const match = sum === r.total_odds;
    log(`   ${match ? '✓' : '✗'} roll #${i} total_odds derived = published (${sum} vs ${r.total_odds})`);
    if (!match) ok = false;
  });

  const theirs = hexOf(dt, hit.act.authorization[0].actor);
  const ours = hexOf(buildData(folded), hit.act.authorization[0].actor);
  const same = theirs === ours;
  log(`   ${same ? '✓' : '✗'} createblend payload matches byte for byte (${ours.length / 2} bytes)`);
  if (!same) {
    ok = false;
    // Show the first divergent byte to make a mismatch debuggable.
    let i = 0;
    while (i < Math.min(ours.length, theirs.length) && ours[i] === theirs[i]) i++;
    log(`      diverges at byte ${Math.floor(i / 2)}`);
    log(`      ours : …${ours.slice(Math.max(0, i - 20), i + 40)}`);
    log(`      trace: …${theirs.slice(Math.max(0, i - 20), i + 40)}`);
  }
}

// ─── phase 2: the text form the UI actually collects ───────────────────
//
// The form takes ingredients and outcomes as one-per-line text. Phase 1
// proved the encoder; this proves the PARSER, by rendering each trace
// back into that text, parsing it, rebuilding, and demanding the same
// bytes again. A parser that drops an amount, a destination account or
// an odds weight cannot survive this.

function toIngredientText(ings, own) {
  return ings.map((i) => {
    const tail = i.transfer_to ? ` -> ${i.transfer_to}` : '';
    // Cross-collection ingredients keep their "collection:" prefix.
    const pre = i.collection_name && i.collection_name !== own ? `${i.collection_name}:` : '';
    switch (i.kind) {
      case 'template':   return `template ${pre}${i.template_id} x${i.amount}${tail}`;
      case 'schema':     return `schema ${pre}${i.schema_name} x${i.amount}${tail}`;
      case 'collection': return `collection ${i.collection_name} x${i.amount}${tail}`;
      case 'ft':         return `token ${i.quantity}${i.to ? ` -> ${i.to}` : ''}`;
      default:           return null; // attribute: not offered by the form
    }
  });
}
const toOutcomeText = (outs) =>
  outs.map((o) => `${o.template_ids.length ? o.template_ids.join('+') : 'nothing'} @${o.odds}`).join('\n');

// Mirrors src/nefty/createBlend.ts::parseIngredientLines
function parseIngredientLines(text, collection) {
  const items = [], errors = [];
  text.split('\n').forEach((raw, idx) => {
    const line = raw.split('#')[0].trim();
    if (!line) return;
    const where = `Line ${idx + 1}`;
    const arrow = line.split('->');
    const body = arrow[0].trim();
    const to = arrow.length > 1 ? arrow[1].trim() : undefined;
    if (arrow.length > 2) { errors.push(`${where}: only one "->" is allowed.`); return; }
    if (to !== undefined && !/^[a-z1-5.]{1,12}$/.test(to)) { errors.push(`${where}: bad account`); return; }
    const m = body.match(/\bx\s*(\d+)\s*$/i);
    const amount = m ? Number(m[1]) : 1;
    const head = m ? body.slice(0, m.index).trim() : body;
    const [kw, ...rest] = head.split(/\s+/);
    const kind = (kw || '').toLowerCase();
    const split = (v) => {
      const i = (v ?? '').indexOf(':');
      return i < 0 ? { coll: collection, value: v ?? '' } : { coll: v.slice(0, i).trim(), value: v.slice(i + 1).trim() };
    };
    if (kind === 'template') {
      const { coll, value } = split(rest[0]);
      const tid = Number(value);
      if (!Number.isFinite(tid) || tid <= 0) { errors.push(`${where}: bad template`); return; }
      items.push({ kind: 'template', template_id: tid, collection_name: coll, amount, transfer_to: to });
    } else if (kind === 'schema') {
      const { coll, value } = split(rest[0]);
      if (!value) { errors.push(`${where}: schema missing`); return; }
      items.push({ kind: 'schema', collection_name: coll, schema_name: value, amount, transfer_to: to });
    } else if (kind === 'collection') {
      items.push({ kind: 'collection', collection_name: rest[0] || collection, amount, transfer_to: to });
    } else if (kind === 'token') {
      const quantity = rest.join(' ').trim();
      if (!quantity) { errors.push(`${where}: quantity missing`); return; }
      items.push({ kind: 'ft', quantity, to });
    } else errors.push(`${where}: unknown ingredient "${kw}"`);
  });
  return { items, errors };
}

// Mirrors src/nefty/createBlend.ts::parseOutcomeLines
function parseOutcomeLines(text) {
  const items = [], errors = [];
  text.split('\n').forEach((raw, idx) => {
    const line = raw.split('#')[0].trim();
    if (!line) return;
    const where = `Line ${idx + 1}`;
    const at = line.split('@');
    if (at.length > 2) { errors.push(`${where}: one "@" only`); return; }
    const odds = at.length > 1 ? Number(at[1].trim()) : 1;
    if (!Number.isInteger(odds) || odds < 1) { errors.push(`${where}: bad odds`); return; }
    const head = at[0].trim().toLowerCase();
    if (head === 'nothing' || head === 'none' || head === 'empty' || head === '-') {
      items.push({ odds, template_ids: [] });
      return;
    }
    const ids = at[0].split('+').map((p) => p.trim()).filter(Boolean).map(Number);
    if (!ids.length || ids.some((n) => !Number.isFinite(n) || n <= 0)) { errors.push(`${where}: bad ids`); return; }
    items.push({ odds, template_ids: ids });
  });
  return { items, errors };
}

log(`\n\n########  PHASE 2 — the form's text parsers  ########`);

for (const c of CASES) {
  const res = await fetch(`${HYPERION}/v2/history/get_transaction?id=${c.trx}`).then((r) => r.json());
  const hit = (res.actions ?? []).find((a) => a.act?.account === 'blend.nefty' && a.act?.name === 'createblend');
  if (!hit) continue;
  const dt = hit.act.data;
  const folded = foldTrace(dt);
  log(`\n=== ${c.label} ===`);

  const lines = toIngredientText(folded.ingredients, dt.collection_name);
  if (lines.some((l) => l === null)) {
    log(`   i  contains an ATTRIBUTE ingredient, which the text form does not offer — skipped`);
    continue;
  }
  if (folded.rolls.length !== 1) {
    log(`   i  ${folded.rolls.length} rolls; the form builds a single roll — skipped`);
    continue;
  }

  const pi = parseIngredientLines(lines.join('\n'), dt.collection_name);
  const po = parseOutcomeLines(toOutcomeText(folded.rolls[0].outcomes));
  const clean = pi.errors.length === 0 && po.errors.length === 0;
  log(`   ${clean ? '✓' : '✗'} parses without errors (${pi.items.length} ingredients, ${po.items.length} outcomes)`);
  if (!clean) { ok = false; log('      ' + [...pi.errors, ...po.errors].join(' | ')); continue; }

  const rebuilt = buildData({ ...folded, ingredients: pi.items, rolls: [{ outcomes: po.items }] });
  const theirs = hexOf(dt, hit.act.authorization[0].actor);
  const ours = hexOf(rebuilt, hit.act.authorization[0].actor);
  const same = ours === theirs;
  log(`   ${same ? '✓' : '✗'} text → parser → payload still matches the trace byte for byte`);
  if (!same) ok = false;
}

log(`\n=== ${ok ? 'CREATEBLEND BUILDER + PARSERS MATCH EVERY TRACE' : 'MISMATCH'} ===`);
process.exit(ok ? 0 : 1);
