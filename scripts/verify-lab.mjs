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
 *   PHASE D - deep links. A shared #/lab/<tool>/<name> must open on that
 *             tool with that auction already resolved, and the workbench
 *             must write back a URL that reproduces what is on screen.
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
const { __setForm, __builtAction, __problems, __warnings, __attributeBlock,
        __where, __myBidsState, applyLabRoute } = lab;

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
  tokens: [],
  priceRecipient: '',
  authRequired: false,
  maxClaimable: '100',
  unlimited: false,
  startTime: '',
  endTime: '',
  maxUses: '',
  accountLimit: '',
  cooldown: '',
  securityId: '',
  hidden: true,
  contractAuthorized: true,
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

/** neftyblocksd's own token list, in the shape the form holds it. */
const TOKENS = [
  { ticker: 'WAX', precision: 8, contract: 'eosio.token', symbol: '8,WAX' },
  { ticker: 'TLM', precision: 4, contract: 'alien.worlds', symbol: '4,TLM' },
  { ticker: 'DUST', precision: 4, contract: 'niftywizards', symbol: '4,DUST' },
];

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
      && a.data.assets_to_mint.length === 1
      // The card path runs through neftybrespay, which stopped signing.
      && a.data.allow_credit_card_payments === false,
  },
  {
    label: 'drop / paid in WAX, several templates, quantities flattened',
    form: {
      kind: 'drop', templates: TEMPLATES_FIXTURE,
      mints: [{ template_id: 111, quantity: 3 }, { template_id: 222, quantity: 2 }],
      free: false, priceAmount: '2.5', priceToken: 'WAX', tokens: TOKENS,
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
      free: false, priceAmount: '10', priceToken: 'TLM', tokens: TOKENS,
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
    label: 'any / a collection that has not authorized the contract is REJECTED',
    form: {
      kind: 'blend', templates: TEMPLATES_FIXTURE, contractAuthorized: false,
      ingredients: [ing({ kind: 'template', template_id: 111, amount: 1 })],
      outcomes: [{ kind: 'nft', template_id: 222, weight: 1 }],
    },
    valid: false, because: /has not authorized/i,
  },
  {
    label: 'any / an unreadable collection does NOT block (undefined is not false)',
    form: {
      kind: 'blend', templates: TEMPLATES_FIXTURE, contractAuthorized: undefined,
      ingredients: [ing({ kind: 'template', template_id: 111, amount: 1 })],
      outcomes: [{ kind: 'nft', template_id: 222, weight: 1 }],
    },
    valid: true,
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
    label: 'drop / a token the contract does not accept is REJECTED',
    form: {
      kind: 'drop', templates: TEMPLATES_FIXTURE,
      mints: [{ template_id: 111, quantity: 1 }],
      free: false, priceAmount: '1', priceToken: 'NOPE', tokens: TOKENS,
    },
    valid: false, because: /neftyblocksd accepts/i,
  },
  {
    label: 'drop / precision comes from the token list, never from a form field',
    form: {
      kind: 'drop', templates: TEMPLATES_FIXTURE,
      mints: [{ template_id: 111, quantity: 1 }],
      free: false, priceAmount: '3', priceToken: 'DUST', tokens: TOKENS,
    },
    valid: true,
    expect: (a) => a.data.listing_price === '3.0000 DUST' && a.data.settlement_symbol === '4,DUST',
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

  // ── PHASE D ──
  //
  // A link is only shareable if the round trip closes: the URL opens the
  // page, and the page writes back the same URL. Test both directions
  // through the real module, with the browser globals it expects.
  console.log('\n=== PHASE D - deep links into the workbench ===');

  // Count the writes, not just the end state. The loop below arrives at
  // each URL the way a visitor does, with the address bar ALREADY holding
  // it, so writeLabHash's "already there" guard makes it a no-op and the
  // final hash matches whether or not the page ever writes back. Proving
  // the write direction needs a case that starts somewhere else, and needs
  // to watch the call rather than the result.
  const writes = [];
  globalThis.location = { hash: '#/lab' };
  globalThis.history = {
    replaceState(_s, _t, url) { globalThis.location.hash = url; writes.push(url); },
  };

  // Names that exercise each verdict shape the tool can reach.
  const routes = [
    ['recipes', '',      'recipes', '',       'none'],
    ['names',   '',      'names',   '',       'none'],
    ['crucible', '',     'crucible', '',      'none'],
    // Long-settled, famously taken: the account exists, so no auction.
    ['names',   'eosio', 'names',   'eosio',  'taken'],
    // A verdict is shareable even when the answer is "that is not a name",
    // and the input takes anything typed. A space has to survive the round
    // trip, or the recipient reads a verdict about the text "a%20b".
    ['names',   'a b',   'names',   'a b',    'not_biddable'],
  ];

  for (const [tool, subject, wantTool, wantSubject, wantKind] of routes) {
    // What the browser actually puts in the address bar, and therefore what
    // applyLabRoute receives: percent-encoded, never the raw text.
    const wire = subject ? encodeURIComponent(subject) : '';
    const url = `#/lab/${tool}${wire ? '/' + wire : ''}`;
    globalThis.location.hash = url;
    applyLabRoute(tool, wire);
    // A subject means a chain read, and applyLabRoute deliberately does
    // not await it: the page paints "reading" first. Give it a moment.
    if (subject) await new Promise((r) => setTimeout(r, 4000));
    const at = __where();

    if (at.tool !== wantTool) {
      fails.push(`route ${url}: opened tool "${at.tool}", expected "${wantTool}"`);
      continue;
    }
    if (at.nameStatusFor !== wantSubject) {
      fails.push(`route ${url}: looked up "${at.nameStatusFor}", expected "${wantSubject}"`);
      continue;
    }
    if (at.kind !== wantKind) {
      fails.push(`route ${url}: verdict "${at.kind}", expected "${wantKind}"`);
      continue;
    }
    // The written hash must reproduce the page. That is the whole point:
    // what the user copies has to bring the next person to the same view.
    const written = globalThis.location.hash;
    const expected = `#/lab/${wantTool}${wantSubject ? '/' + encodeURIComponent(wantSubject) : ''}`;
    if (written !== expected) {
      fails.push(`route ${url}: address bar reads "${written}", expected "${expected}"`);
      continue;
    }
    console.log(`   ok  ${url.padEnd(22)} -> ${wantTool}${wantSubject ? ` / ${wantSubject} (${wantKind})` : ''}`);
  }

  // Now the other direction, from a URL that does NOT already say where
  // the page is. Both cases below are real: a visitor can type a bare
  // #/lab, and can follow a shared names link then switch tool. If the
  // address bar does not follow, there is nothing to copy and the feature
  // does not exist. Asserting the end state alone would not catch that,
  // so assert that a write actually happened.
  // Each case sets up the page state it is about, so the expected URL is
  // stated rather than recomputed from the code under test.
  const writeBacks = [
    {
      what: 'a bare #/lab names the tool it opened',
      setup: { tool: 'names', nameStatusFor: '' },
      from: '#/lab', tool: '', subject: '',
      expect: '#/lab/names',
    },
    {
      what: 'a bare #/lab carries the auction still on screen',
      setup: { tool: 'names', nameStatusFor: 'eosio' },
      from: '#/lab', tool: '', subject: '',
      expect: '#/lab/names/eosio',
    },
    {
      what: 'switching tool follows, so the URL is never a stale auction',
      setup: { tool: 'names', nameStatusFor: 'eosio' },
      from: '#/lab/names/eosio', tool: 'recipes', subject: '',
      expect: '#/lab/recipes',
    },
    {
      what: 'a subject that needs encoding survives the write',
      setup: { tool: 'names', nameStatusFor: 'a b' },
      from: '#/lab', tool: '', subject: '',
      expect: '#/lab/names/a%20b',
    },
  ];
  for (const c of writeBacks) {
    __setForm(c.setup);
    globalThis.location.hash = c.from;
    writes.length = 0;
    applyLabRoute(c.tool, c.subject);
    if (!writes.length) {
      fails.push(`${c.what}: nothing was written back, so ${c.from} stays ${c.from} and there is no link to share`);
    } else if (globalThis.location.hash !== c.expect) {
      fails.push(`${c.what}: address bar reads "${globalThis.location.hash}", expected "${c.expect}"`);
    } else {
      console.log(`   ok  ${c.from.padEnd(22)} -> written back as ${globalThis.location.hash}`);
    }
  }

  // Leaving the lab MID-LOOKUP must not drag the address bar back. A name
  // takes two chain reads, and the visitor can click "Back to the app"
  // while they are outstanding. The read then resolves against a page that
  // is no longer on screen, and since replaceState fires no hashchange, a
  // write here would never be corrected: reloading would reopen the lab.
  __setForm({ tool: 'names', nameStatusFor: '', nameQuery: '', nameChecking: false });
  globalThis.location.hash = '#/lab/names';
  writes.length = 0;
  applyLabRoute('names', 'eosio');          // the chain read starts
  globalThis.location.hash = '#/nefty/blends';   // and the visitor leaves
  await new Promise((r) => setTimeout(r, 5000)); // the read lands anyway
  if (writes.length || globalThis.location.hash !== '#/nefty/blends') {
    fails.push(`left the lab mid-lookup: the address bar was rewritten to "${globalThis.location.hash}" behind another page (writes: ${JSON.stringify(writes)})`);
  } else {
    console.log('   ok  left mid-lookup      -> the lab does not write behind another page');
  }

  // A name merely TYPED into the box, never submitted, must not make a
  // link a no-op. Skipping the lookup there would leave the address bar
  // naming one auction while the card below still showed another, which is
  // the exact wrong-answer shape this page has already been burned by.
  __setForm({ tool: 'names', nameStatusFor: 'eosio', nameQuery: 'zeus', nameChecking: false });
  globalThis.location.hash = '#/lab/names/zeus';
  applyLabRoute('names', 'zeus');
  await new Promise((r) => setTimeout(r, 5000));
  if (__where().nameStatusFor !== 'zeus') {
    fails.push(`typed but not submitted: following #/lab/names/zeus left the card showing "${__where().nameStatusFor}"`);
  } else {
    console.log('   ok  typed, not submitted -> the link still wins, and the card follows it');
  }

  // Arriving by link must read what arriving by click reads. Without the
  // bid history the panel states "No bid found" as a fact and hides
  // refunds the contract owes, which is worse than saying nothing at all.
  __setForm({ tool: 'recipes', actor: 'zigm4.gm', myBidsState: 'idle' });
  applyLabRoute('names', '');
  await new Promise((r) => setTimeout(r, 5000));
  if (__myBidsState() === 'idle') {
    fails.push('deep link to #/lab/names never asked for the wallet bids, so the page claims "No bid found" and hides claimable refunds');
  } else {
    console.log(`   ok  #/lab/names          -> wallet bids requested (state: ${__myBidsState()})`);
  }

  // An unknown tool must not blank the page. It keeps whatever is open,
  // because a truncated or mistyped link is still a visitor.
  const before = __where().tool;
  globalThis.location.hash = '#/lab/nonsense';
  applyLabRoute('nonsense', '');
  if (__where().tool !== before) {
    fails.push(`route #/lab/nonsense: switched to "${__where().tool}", should have stayed on "${before}"`);
  } else {
    console.log(`   ok  #/lab/nonsense       -> stays on ${before}, and the URL is repaired to ${globalThis.location.hash}`);
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
