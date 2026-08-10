/**
 * Does the guided creator (#/lab) build payloads the CHAIN accepts?
 *
 * The other verify scripts prove the builders reproduce real creations
 * byte for byte. This one covers the gap above them: #/lab constructs its
 * argument objects from structured form state rather than from parsed
 * text, so nothing so far has proven that construction is well formed.
 *
 *   PHASE A - serialisation. Build each fixture's action and run it
 *             through the LIVE contract ABI with the same WharfKit
 *             Action.from() the "Simulate" button uses. A payload the ABI
 *             refuses is one a wallet would refuse.
 *   PHASE B - the validator. Every fixture that is meant to be valid must
 *             pass problems(), and every fixture that is meant to be
 *             rejected must be rejected FOR THE STATED REASON. A validator
 *             that rejects everything would pass phase A trivially.
 *   PHASE C - the schema gate. Against a real collection read live from
 *             the chain, the attribute picker must block exactly the
 *             attributes an upgrade cannot really change, and no others.
 *
 * As with the other harnesses, this imports the REAL module. It does not
 * re-implement it: a previous harness here reimplemented the parsers, and
 * its correct copy passed while the shipped code was broken.
 */
import { Action, APIClient } from '@wharfkit/session';

let lab;
try {
  lab = await import('./.build/lab.mjs');
} catch {
  console.error('Missing scripts/.build/lab.mjs - run `npm run verify:lab`.');
  process.exit(1);
}
const { __setForm, __builtAction, __problems, __warnings, __attributeBlock } = lab;

const RPC = ['https://wax.greymass.com', 'https://api.waxsweden.org', 'https://wax.eosphere.io'];
const ATOMIC = ['https://wax.api.atomicassets.io', 'https://aa.wax.blacklusion.io'];

async function client() {
  for (const url of RPC) {
    try {
      const c = new APIClient({ url });
      await c.v1.chain.get_info();
      return c;
    } catch { /* next */ }
  }
  throw new Error('no WAX endpoint reachable');
}

async function atomic(path) {
  for (const base of ATOMIC) {
    try {
      const r = await fetch(base + path);
      if (!r.ok) continue;
      const b = await r.json();
      if (b.success === false) continue;
      return b.data ?? b;
    } catch { /* next */ }
  }
  throw new Error(`atomic fetch failed: ${path}`);
}

// ── fixtures ────────────────────────────────────────────────────────────
// A blank form, so each fixture states only what it is about.

const BLANK = {
  kind: 'blend',
  actor: 'testactor.wam',
  collection: 'testcoll1234',
  schemas: [],
  templates: [],
  name: 'Fixture',
  description: '',
  image: '',
  category: '',
  ingredients: [],
  outcomes: [],
  schemaName: '',
  requirements: [],
  mutations: [],
  mints: [],
  free: true,
  priceAmount: '1',
  priceToken: 'WAX',
  priceDecimals: '8',
  priceRecipient: '',
  authRequired: false,
  allowCreditCard: false,
  maxClaimable: '100',
  unlimited: false,
  startTime: '',
  endTime: '',
  maxUses: '',
  accountLimit: '',
  cooldown: '',
  securityId: '',
  hidden: true,
};

const SCHEMA_FIXTURE = {
  schema_name: 'gear',
  format: [
    { name: 'name', type: 'string' },
    { name: 'img', type: 'image' },
    { name: 'level', type: 'uint64' },
    { name: 'power', type: 'double' },
    { name: 'shiny', type: 'bool' },
    { name: 'tier', type: 'uint8' },
    { name: 'rarity', type: 'string' },
    { name: 'legacy', type: 'uint16' },  // not encodable, must be blocked
  ],
  pinned: new Map([['name', 3], ['img', 3]]),
  pinnedBy: new Map([
    [111, new Set(['name', 'img'])],
    [222, new Set(['name', 'img'])],
    [333, new Set(['name', 'img', 'rarity'])],
  ]),
  templateCount: 3,
};

const TEMPLATES_FIXTURE = [111, 222, 333].map((id) => ({
  template_id: id, name: `Gear ${id}`, schema_name: 'gear', image: undefined, issued: 5, max: 0,
}));

/** The kingsburynft shape: one template deliberately left upgradeable. */
const PARTIAL_SCHEMA = {
  ...SCHEMA_FIXTURE,
  pinned: new Map([['name', 2], ['img', 3]]),
  pinnedBy: new Map([
    [111, new Set(['img'])],
    [222, new Set(['name', 'img'])],
    [333, new Set(['name', 'img'])],
  ]),
};

const ing = (o) => ({ sendTo: '', ...o });

const FIXTURES = [
  // ── blends ──
  {
    label: 'blend / one template burned, one NFT out',
    form: {
      kind: 'blend', templates: TEMPLATES_FIXTURE,
      ingredients: [ing({ kind: 'template', template_id: 111, amount: 5 })],
      outcomes: [{ kind: 'nft', template_id: 222, weight: 1 }],
    },
    valid: true,
  },
  {
    label: 'blend / ingredient routed to a vault instead of burned',
    form: {
      kind: 'blend', templates: TEMPLATES_FIXTURE,
      ingredients: [ing({ kind: 'template', template_id: 111, amount: 1, sendTo: 'vault.wam' })],
      outcomes: [{ kind: 'nft', template_id: 222, weight: 1 }],
    },
    valid: true,
    expect: (a) => a.data.ingredients[0][1].effect[0] === 'TRANSFER_EFFECT'
      && a.data.ingredients[0][1].effect[1].to === 'vault.wam',
  },
  {
    label: 'blend / token cost, schema and attribute ingredients',
    form: {
      kind: 'blend', templates: TEMPLATES_FIXTURE, schemas: [SCHEMA_FIXTURE],
      ingredients: [
        ing({ kind: 'schema', schema_name: 'gear', amount: 2 }),
        ing({ kind: 'attribute', schema_name: 'gear', attribute_name: 'rarity', values: 'Rare | Epic', amount: 1 }),
        ing({ kind: 'collection', amount: 1 }),
        { kind: 'token', quantity: '10.00000000 WAX', to: 'payout.wam' },
      ],
      outcomes: [{ kind: 'nft', template_id: 222, weight: 1 }],
    },
    valid: true,
    expect: (a) => a.data.ingredients.length === 4
      && a.data.ingredients[1][1].attributes[0].allowed_values.length === 2,
  },
  {
    label: 'blend / four-way lottery with token, pool and blank branches',
    form: {
      kind: 'blend', templates: TEMPLATES_FIXTURE,
      ingredients: [ing({ kind: 'template', template_id: 111, amount: 1 })],
      outcomes: [
        { kind: 'nft', template_id: 222, weight: 50 },
        { kind: 'token', quantity: '1.00000000 WAX', contract: 'eosio.token', weight: 30 },
        { kind: 'pool', pool_name: 'vault', weight: 15 },
        { kind: 'nothing', weight: 5 },
      ],
    },
    valid: true,
    expect: (a) => {
      const r = a.data.rolls[0];
      return r.total_odds === 100 && r.outcomes.length === 4 && r.outcomes[3].results.length === 0;
    },
  },
  {
    label: 'blend / every limit and window set',
    form: {
      kind: 'blend', templates: TEMPLATES_FIXTURE,
      ingredients: [ing({ kind: 'template', template_id: 111, amount: 1 })],
      outcomes: [{ kind: 'nft', template_id: 222, weight: 1 }],
      startTime: '2027-01-01T00:00', endTime: '2027-06-01T00:00',
      maxUses: '500', accountLimit: '3', cooldown: '86400',
      securityId: '831', category: 'armour', hidden: false,
      name: 'Named', description: 'A description', image: 'QmPpctuEbqFtkosPeLQ4Zfep4TbMQGa3pfDZhdWWd2Z2M7',
    },
    valid: true,
    expect: (a) => a.data.security_id === '831' && a.data.account_limit_cooldown === 86400
      && JSON.parse(a.data.display_data).name === 'Named',
  },
  {
    label: 'blend / token cost with no receiver is REJECTED',
    form: {
      kind: 'blend', templates: TEMPLATES_FIXTURE,
      ingredients: [{ kind: 'token', quantity: '10.00000000 WAX', to: '' }],
      outcomes: [{ kind: 'nft', template_id: 222, weight: 1 }],
    },
    valid: false, because: /receiving account/i,
  },
  {
    label: 'blend / a malformed token amount is REJECTED',
    form: {
      kind: 'blend', templates: TEMPLATES_FIXTURE,
      ingredients: [{ kind: 'token', quantity: 'ten WAX', to: 'payout.wam' }],
      outcomes: [{ kind: 'nft', template_id: 222, weight: 1 }],
    },
    valid: false, because: /not a token amount/i,
  },
  {
    label: 'blend / an integer amount is ALLOWED (zero-precision tokens exist)',
    form: {
      kind: 'blend', templates: TEMPLATES_FIXTURE,
      ingredients: [{ kind: 'token', quantity: '1000000 MSOURCE', to: 'payout.wam' }],
      outcomes: [{ kind: 'nft', template_id: 222, weight: 1 }],
    },
    valid: true,
  },
  {
    label: 'blend / only blank outcomes is REJECTED',
    form: {
      kind: 'blend', templates: TEMPLATES_FIXTURE,
      ingredients: [ing({ kind: 'template', template_id: 111, amount: 1 })],
      outcomes: [{ kind: 'nothing', weight: 1 }],
    },
    valid: false, because: /never win/i,
  },
  {
    label: 'blend / end time before start time is REJECTED',
    form: {
      kind: 'blend', templates: TEMPLATES_FIXTURE,
      ingredients: [ing({ kind: 'template', template_id: 111, amount: 1 })],
      outcomes: [{ kind: 'nft', template_id: 222, weight: 1 }],
      startTime: '2027-06-01T00:00', endTime: '2027-01-01T00:00',
    },
    valid: false, because: /not after the start/i,
  },
  {
    label: 'blend / end time in the past is REJECTED even with no start',
    form: {
      kind: 'blend', templates: TEMPLATES_FIXTURE,
      ingredients: [ing({ kind: 'template', template_id: 111, amount: 1 })],
      outcomes: [{ kind: 'nft', template_id: 222, weight: 1 }],
      endTime: '2020-01-01T00:00',
    },
    valid: false, because: /in the past/i,
  },

  // ── upgrades ──
  {
    label: 'upgrade / set a string attribute',
    form: {
      kind: 'upgrade', schemas: [SCHEMA_FIXTURE], templates: TEMPLATES_FIXTURE, schemaName: 'gear',
      ingredients: [ing({ kind: 'template', template_id: 111, amount: 1 })],
      mutations: [{ attribute_name: 'rarity', op: 0, value: 'Legendary' }],
    },
    valid: true,
    expect: (a) => {
      const r = a.data.upgrade_specs[0].upgrade_results[0];
      return r.attribute_type === 'string' && r.value[1][0] === 'string' && r.value[1][1] === 'Legendary';
    },
  },
  {
    label: 'upgrade / add to a uint64, the type read from the schema',
    form: {
      kind: 'upgrade', schemas: [SCHEMA_FIXTURE], templates: TEMPLATES_FIXTURE, schemaName: 'gear',
      ingredients: [ing({ kind: 'template', template_id: 111, amount: 1 })],
      mutations: [{ attribute_name: 'level', op: 1, value: '5' }],
    },
    valid: true,
    expect: (a) => {
      const r = a.data.upgrade_specs[0].upgrade_results[0];
      return r.attribute_type === 'uint64' && r.op.type === 1
        && r.value[1][0] === 'uint64' && r.value[1][1] === 5;
    },
  },
  {
    label: 'upgrade / a double writes float64 as its wire type',
    form: {
      kind: 'upgrade', schemas: [SCHEMA_FIXTURE], templates: TEMPLATES_FIXTURE, schemaName: 'gear',
      ingredients: [ing({ kind: 'template', template_id: 111, amount: 1 })],
      mutations: [{ attribute_name: 'power', op: 0, value: '12.5' }],
    },
    valid: true,
    expect: (a) => {
      const r = a.data.upgrade_specs[0].upgrade_results[0];
      return r.attribute_type === 'double' && r.value[1][0] === 'float64' && r.value[1][1] === 12.5;
    },
  },
  {
    label: 'upgrade / a bool writes the NUMBER 1, not true',
    form: {
      kind: 'upgrade', schemas: [SCHEMA_FIXTURE], templates: TEMPLATES_FIXTURE, schemaName: 'gear',
      ingredients: [ing({ kind: 'template', template_id: 111, amount: 1 })],
      mutations: [{ attribute_name: 'shiny', op: 0, value: '1' }],
    },
    valid: true,
    expect: (a) => {
      const r = a.data.upgrade_specs[0].upgrade_results[0];
      return r.value[1][0] === 'uint8' && r.value[1][1] === 1 && typeof r.value[1][1] === 'number';
    },
  },
  {
    label: 'upgrade / requirements by template, by list, and by attribute',
    form: {
      kind: 'upgrade', schemas: [SCHEMA_FIXTURE], templates: TEMPLATES_FIXTURE, schemaName: 'gear',
      ingredients: [ing({ kind: 'template', template_id: 111, amount: 1 })],
      requirements: [
        { kind: 'templates', template_ids: [111, 222] },
        { kind: 'attribute', attribute_name: 'level', values: '1 | 2 | 3' },
      ],
      mutations: [{ attribute_name: 'level', op: 1, value: '1' }],
    },
    valid: true,
    expect: (a) => {
      const reqs = a.data.upgrade_specs[0].upgrade_requirements;
      const typed = reqs.find((r) => r[0] === 'TYPED_ATTRIBUTE_REQUIREMENT')[1].typed_attribute_definition;
      // uint64 allowed values travel as decimal STRINGS in a UINT64_VEC.
      return reqs[0][0] === 'TEMPLATES_REQUIREMENT'
        && typed.allowed_values[0] === 'UINT64_VEC'
        && typed.allowed_values[1].every((v) => typeof v === 'string');
    },
  },
  {
    label: 'upgrade / a uint8 requirement encodes UINT8_VEC as a hex string',
    form: {
      kind: 'upgrade', schemas: [SCHEMA_FIXTURE], templates: TEMPLATES_FIXTURE, schemaName: 'gear',
      ingredients: [ing({ kind: 'template', template_id: 111, amount: 1 })],
      requirements: [{ kind: 'attribute', attribute_name: 'tier', values: '0 | 25' }],
      mutations: [{ attribute_name: 'tier', op: 0, value: '3' }],
    },
    valid: true,
    expect: (a) => {
      const t = a.data.upgrade_specs[0].upgrade_requirements[0][1].typed_attribute_definition;
      return t.allowed_values[0] === 'UINT8_VEC' && t.allowed_values[1] === '0019';
    },
  },
  {
    label: 'upgrade / an attribute frozen on EVERY template is REJECTED',
    form: {
      kind: 'upgrade', schemas: [SCHEMA_FIXTURE], templates: TEMPLATES_FIXTURE, schemaName: 'gear',
      ingredients: [ing({ kind: 'template', template_id: 111, amount: 1 })],
      mutations: [{ attribute_name: 'name', op: 0, value: 'New name' }],
    },
    valid: false, because: /frozen in the immutable data of all/i,
  },
  {
    label: 'upgrade / an attribute frozen on SOME templates is allowed, with a warning',
    form: {
      kind: 'upgrade', schemas: [PARTIAL_SCHEMA], templates: TEMPLATES_FIXTURE, schemaName: 'gear',
      ingredients: [ing({ kind: 'template', template_id: 111, amount: 1 })],
      mutations: [{ attribute_name: 'name', op: 0, value: 'New name' }],
    },
    valid: true,
    warns: /frozen in the immutable data of 2 of the 3/i,
  },
  {
    label: 'upgrade / a pinned attribute opens up once scoped to a template that leaves it free',
    form: {
      kind: 'upgrade', schemas: [SCHEMA_FIXTURE], templates: TEMPLATES_FIXTURE, schemaName: 'gear',
      ingredients: [ing({ kind: 'template', template_id: 111, amount: 1 })],
      requirements: [{ kind: 'template', template_id: 111 }],
      mutations: [{ attribute_name: 'rarity', op: 0, value: 'Epic' }],
    },
    valid: true,  // template 111 does NOT pin rarity, only 333 does
  },
  {
    label: 'upgrade / an unsupported schema type is REJECTED',
    form: {
      kind: 'upgrade', schemas: [SCHEMA_FIXTURE], templates: TEMPLATES_FIXTURE, schemaName: 'gear',
      ingredients: [ing({ kind: 'template', template_id: 111, amount: 1 })],
      mutations: [{ attribute_name: 'legacy', op: 0, value: '7' }],
    },
    valid: false, because: /uint16 is not supported/i,
  },
  {
    label: 'upgrade / += on a string is REJECTED',
    form: {
      kind: 'upgrade', schemas: [SCHEMA_FIXTURE], templates: TEMPLATES_FIXTURE, schemaName: 'gear',
      ingredients: [ing({ kind: 'template', template_id: 111, amount: 1 })],
      mutations: [{ attribute_name: 'rarity', op: 1, value: 'Epic' }],
    },
    valid: false, because: /cannot be added to/i,
  },
  {
    label: 'upgrade / a non-numeric value on a uint64 is REJECTED',
    form: {
      kind: 'upgrade', schemas: [SCHEMA_FIXTURE], templates: TEMPLATES_FIXTURE, schemaName: 'gear',
      ingredients: [ing({ kind: 'template', template_id: 111, amount: 1 })],
      mutations: [{ attribute_name: 'level', op: 0, value: 'seven' }],
    },
    valid: false, because: /must be a number/i,
  },

  // ── drops ──
  {
    label: 'drop / free, one template',
    form: {
      kind: 'drop', templates: TEMPLATES_FIXTURE,
      mints: [{ template_id: 111, quantity: 1 }],
    },
    valid: true,
    expect: (a) => a.data.listing_price === '0 NULL' && a.data.settlement_symbol === '0,NULL'
      && a.data.assets_to_mint.length === 1,
  },
  {
    label: 'drop / paid in WAX, several templates, quantities flattened',
    form: {
      kind: 'drop', templates: TEMPLATES_FIXTURE,
      mints: [{ template_id: 111, quantity: 3 }, { template_id: 222, quantity: 2 }],
      free: false, priceAmount: '2.5', priceToken: 'WAX', priceDecimals: '8',
      priceRecipient: 'seller.wam',
    },
    valid: true,
    expect: (a) => a.data.listing_price === '2.50000000 WAX'
      && a.data.settlement_symbol === '8,WAX'
      && a.data.assets_to_mint.length === 5
      && a.data.price_recipient === 'seller.wam',
  },
  {
    label: 'drop / paid in TLM keeps four decimals',
    form: {
      kind: 'drop', templates: TEMPLATES_FIXTURE,
      mints: [{ template_id: 111, quantity: 1 }],
      free: false, priceAmount: '10', priceToken: 'TLM', priceDecimals: '4',
    },
    valid: true,
    expect: (a) => a.data.listing_price === '10.0000 TLM' && a.data.settlement_symbol === '4,TLM',
  },
  {
    label: 'drop / unlimited supply',
    form: {
      kind: 'drop', templates: TEMPLATES_FIXTURE,
      mints: [{ template_id: 111, quantity: 1 }], unlimited: true,
    },
    valid: true,
    expect: (a) => a.data.max_claimable === 0,
  },
  {
    label: 'drop / no template to mint is REJECTED',
    form: { kind: 'drop', templates: TEMPLATES_FIXTURE, mints: [] },
    valid: false, because: /at least one template/i,
  },
  {
    label: 'drop / a capped drop with no cap is REJECTED',
    form: {
      kind: 'drop', templates: TEMPLATES_FIXTURE,
      mints: [{ template_id: 111, quantity: 1 }], unlimited: false, maxClaimable: '0',
    },
    valid: false, because: /max supply/i,
  },
  {
    label: 'drop / impossible token decimals are REJECTED',
    form: {
      kind: 'drop', templates: TEMPLATES_FIXTURE,
      mints: [{ template_id: 111, quantity: 1 }],
      free: false, priceAmount: '1', priceToken: 'WAX', priceDecimals: '99',
    },
    valid: false, because: /decimals/i,
  },
];

// ── run ─────────────────────────────────────────────────────────────────

const load = (patch) => __setForm({ ...BLANK, ...patch });

async function main() {
  const c = await client();
  const abis = new Map();
  for (const code of ['blend.nefty', 'up.nefty', 'neftyblocksd']) {
    const res = await c.v1.chain.get_abi(code);
    if (!res.abi) throw new Error(`no ABI for ${code}`);
    abis.set(code, res.abi);
  }
  console.log(`ABIs loaded: ${[...abis.keys()].join(', ')}\n`);

  const fails = [];
  let serialised = 0, rejected = 0, shapeChecks = 0;

  console.log('=== PHASE A/B - build, serialise against the live ABI, validate ===');
  for (const fx of FIXTURES) {
    load(fx.form);
    const errs = __problems();
    // Every fixture omits the wallet, so ignore that one message.
    const real = errs.filter((e) => !/Connect a wallet|authorized account/i.test(e));

    if (!fx.valid) {
      if (real.length === 0) { fails.push(`${fx.label}: expected a rejection, got none`); continue; }
      if (fx.because && !real.some((e) => fx.because.test(e))) {
        fails.push(`${fx.label}: rejected, but for the wrong reason: ${real.join(' | ')}`);
        continue;
      }
      rejected++;
      console.log(`   ok  REJECTED  ${fx.label}`);
      continue;
    }

    if (real.length) { fails.push(`${fx.label}: unexpected rejection: ${real.join(' | ')}`); continue; }

    const built = __builtAction();
    try {
      Action.from(
        { account: built.account, name: built.name, authorization: built.authorization, data: built.data },
        abis.get(built.account),
      );
    } catch (e) {
      fails.push(`${fx.label}: the ABI refused the payload: ${e.message}`);
      continue;
    }
    if (fx.warns) {
      const ws = __warnings();
      if (!ws.some((w) => fx.warns.test(w))) {
        fails.push(`${fx.label}: expected a warning matching ${fx.warns}, got: ${ws.join(' | ')}`);
        continue;
      }
    }
    if (fx.expect) {
      shapeChecks++;
      if (!fx.expect(built)) { fails.push(`${fx.label}: payload shape check failed`); continue; }
    }
    serialised++;
    console.log(`   ok  ${built.account}::${built.name}  ${fx.label}`);
  }

  console.log(`\n   ${serialised} payload(s) serialised, ${shapeChecks} shape check(s), ${rejected} correct rejection(s)`);

  // ── PHASE C ──
  console.log('\n=== PHASE C - the schema gate, against real collections ===');
  const LIVE = [
    { collection: 'underpunks55', schema: 'up.armour' },
    { collection: 'crewtoonswax', schema: 'spaceships' },
    { collection: 'skekofficial', schema: 'rocks' },
    { collection: 'shadowsquads', schema: 'faction.lyc' },
    { collection: 'kingsburynft', schema: 'tv' },
  ];
  const ENCODABLE = new Set(['string', 'image', 'ipfs', 'uint64', 'double', 'bool', 'uint8']);

  for (const { collection, schema: schemaName } of LIVE) {
    const [schemas, templates] = await Promise.all([
      atomic(`/atomicassets/v1/schemas?collection_name=${collection}&limit=100`),
      atomic(`/atomicassets/v1/templates?collection_name=${collection}&schema_name=${schemaName}&limit=1000`),
    ]);
    const raw = schemas.find((s) => s.schema_name === schemaName);
    if (!raw) { fails.push(`${collection}/${schemaName}: schema not found`); continue; }

    const pinned = new Map();
    const pinnedBy = new Map();
    for (const t of templates) {
      const keys = Object.keys(t.immutable_data ?? {});
      pinnedBy.set(Number(t.template_id), new Set(keys));
      for (const k of keys) pinned.set(k, (pinned.get(k) ?? 0) + 1);
    }
    load({
      kind: 'upgrade',
      collection,
      schemaName,
      schemas: [{ schema_name: schemaName, format: raw.format, pinned, pinnedBy, templateCount: templates.length }],
      templates: templates.map((t) => ({
        template_id: Number(t.template_id), name: String(t.name ?? ''), schema_name: schemaName,
        issued: Number(t.issued_supply ?? 0), max: Number(t.max_supply ?? 0),
      })),
      requirements: [],
    });

    let mismatches = 0;
    for (const f of raw.format) {
      const blocked = Boolean(__attributeBlock(schemaName, f.name, true));
      // Blocked only when the attribute is unencodable, or frozen on EVERY
      // template it would apply to. Partial pinning is a warning.
      const shouldBlock = !ENCODABLE.has(f.type)
        || (templates.length > 0 && (pinned.get(f.name) ?? 0) === templates.length);
      if (blocked !== shouldBlock) {
        mismatches++;
        fails.push(`${collection}/${schemaName}.${f.name} (${f.type}): blocked=${blocked}, expected ${shouldBlock}`);
      }
    }
    const open = raw.format.filter((f) => !__attributeBlock(schemaName, f.name, true)).map((f) => f.name);
    console.log(
      `   ${mismatches ? 'FAIL' : 'ok  '} ${collection}/${schemaName}: ` +
      `${raw.format.length} attribute(s), ${templates.length} template(s), ` +
      `${open.length} rewritable${open.length ? ` (${open.slice(0, 6).join(', ')})` : ''}`,
    );

    // The attributes real upgrades on this collection actually target must
    // be among the ones we leave open, otherwise the gate is too strict.
    if (collection !== 'underpunks55') {
      const rows = await (await fetch(RPC[0] + '/v1/chain/get_table_rows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ json: true, code: 'up.nefty', scope: 'up.nefty', table: 'upgrades', limit: 300 }),
      })).json();
      const targeted = new Set();
      for (const r of rows.rows ?? []) {
        if (r.collection_name !== collection) continue;
        for (const spec of r.upgrade_specs ?? []) {
          if (spec.schema_name !== schemaName) continue;
          for (const res of spec.upgrade_results ?? []) targeted.add(res.attribute_name);
        }
      }
      for (const attr of targeted) {
        const why = __attributeBlock(schemaName, attr, true);
        if (why) fails.push(`${collection}/${schemaName}: real upgrades rewrite "${attr}" but the gate blocks it (${why})`);
      }
      if (targeted.size) {
        console.log(`        ${targeted.size} attribute(s) rewritten by real upgrades, all allowed: ${[...targeted].join(', ')}`);
      }
    }
  }

  console.log('');
  if (fails.length) {
    console.log(`=== ${fails.length} FAILURE(S) ===`);
    for (const f of fails) console.log('   ' + f);
    process.exit(1);
  }
  console.log('=== ALL LAB CHECKS PASS ===');
}

main().catch((e) => { console.error(e); process.exit(1); });
