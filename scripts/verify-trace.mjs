/**
 * Read-only verification against two real traces:
 *   - blend 43444 (NFT-only)        → trx ef67da1e…
 *   - blend 43802 (token + NFT)     → trx df21bb22…
 *
 * For each blend we:
 *   1. fetch the blend row from blend.nefty
 *   2. build the action list we'd send
 *   3. serialise it locally via WharfKit Action.from(.., abi)
 *   4. diff every hex payload against the original trace
 *
 * Run: node scripts/verify-trace.mjs
 */

import { APIClient, Action } from '@wharfkit/session';

const client = new APIClient({ url: 'https://wax.eosphere.io' });

const CASES = [
  {
    label: 'NFT-only blend 43444 (trx ef67da1e…)',
    claimer: 'zigm4.gm',
    blend_id: 43444,
    asset_ids: [
      '1099966023984',
      '1099952332636',
      '1099951871519',
      '1099948238226',
    ],
    ft_payments: [],
    expected: {
      'blend.nefty::announcedepo':
        '00000092012299fb04000000',
      'atomicassets::transfer':
        '00000092012299fb007c5e6a8234553c043089151b000100005c9f441a000100001f963d1a000100009225061a00010000076465706f736974',
      'blend.nefty::nosecfuse':
        '00000092012299fbb4a9000000000000043089151b000100005c9f441a000100001f963d1a000100009225061a0001000000',
    },
  },
  {
    label: 'Token blend 43802 (trx df21bb22…)',
    claimer: 'zigm4.gm',
    blend_id: 43802,
    asset_ids: [
      '1099953040935',
      '1099953040910',
      '1099927311660',
      '1099953040899',
      '1099927313079',
      '1099927311635',
    ],
    ft_payments: ['105.00000000 UPMAX'],
    expected: {
      'blend.nefty::openbal': '00000092012299fb0855504d41580000',
      'underpunks55::transfer':
        '00000092012299fb007c5e6a8234553c0049d971020000000855504d41580000076465706f736974',
      'blend.nefty::announcedepo': '00000092012299fb06000000',
      'atomicassets::transfer':
        '00000092012299fb007c5e6a8234553c06276e4f1a000100000e6e4f1a000100002cd5c61800010000036e4f1a00010000b7dac6180001000013d5c61800010000076465706f736974',
      'blend.nefty::nosecfuse':
        '00000092012299fb1aab00000000000006276e4f1a000100000e6e4f1a000100002cd5c61800010000036e4f1a00010000b7dac6180001000013d5c6180001000000',
    },
  },
];

async function getBlend(blend_id) {
  const res = await client.call({
    path: '/v1/chain/get_table_rows',
    params: {
      json: true,
      code: 'blend.nefty',
      scope: 'blend.nefty',
      table: 'blends',
      lower_bound: String(blend_id),
      upper_bound: String(blend_id),
      limit: 1,
    },
  });
  return res.rows[0];
}

async function getConfig() {
  const res = await client.call({
    path: '/v1/chain/get_table_rows',
    params: {
      json: true,
      code: 'blend.nefty',
      scope: 'blend.nefty',
      table: 'config',
      limit: 1,
    },
  });
  return res.rows[0];
}

function symbolFromQuantity(q) {
  const [amount, ticker] = q.trim().split(/\s+/);
  const dot = amount.indexOf('.');
  const precision = dot === -1 ? 0 : amount.length - dot - 1;
  return `${precision},${ticker}`;
}

function resolveTokenContract(cfg, qty) {
  const sym = symbolFromQuantity(qty);
  const found = cfg.supported_tokens.find((t) => t.sym === sym);
  if (!found) throw new Error(`Token ${sym} not in supported_tokens`);
  return found.contract;
}

function buildActions(cfg, c) {
  const auth = [{ actor: c.claimer, permission: 'active' }];
  const actions = [];

  for (const qty of c.ft_payments) {
    actions.push({
      account: 'blend.nefty',
      name: 'openbal',
      authorization: auth,
      data: { owner: c.claimer, token_symbol: symbolFromQuantity(qty) },
    });
  }
  for (const qty of c.ft_payments) {
    actions.push({
      account: resolveTokenContract(cfg, qty),
      name: 'transfer',
      authorization: auth,
      data: { from: c.claimer, to: 'blend.nefty', quantity: qty, memo: 'deposit' },
    });
  }
  actions.push({
    account: 'blend.nefty',
    name: 'announcedepo',
    authorization: auth,
    data: { owner: c.claimer, count: c.asset_ids.length },
  });
  if (c.asset_ids.length > 0) {
    actions.push({
      account: 'atomicassets',
      name: 'transfer',
      authorization: auth,
      data: { from: c.claimer, to: 'blend.nefty', asset_ids: c.asset_ids, memo: 'deposit' },
    });
  }
  actions.push({
    account: 'blend.nefty',
    name: 'nosecfuse',
    authorization: auth,
    data: {
      claimer: c.claimer,
      blend_id: String(c.blend_id),
      transferred_assets: c.asset_ids,
      own_assets: [],
    },
  });
  return actions;
}

const log = (...a) => console.log(...a);
let overallOk = true;

const cfg = await getConfig();

for (const c of CASES) {
  log(`\n=== ${c.label} ===`);
  const blend = await getBlend(c.blend_id);
  if (!blend) {
    log('!! blend not found');
    overallOk = false;
    continue;
  }
  log(`   collection: ${blend.collection_name}  ingredients: ${blend.ingredients.length}  rolls: ${blend.rolls.length}  security_id: ${blend.security_id}`);

  const actions = buildActions(cfg, c);
  const abis = new Map();
  for (const code of new Set(actions.map((a) => a.account))) {
    const r = await client.v1.chain.get_abi(code);
    abis.set(code, r.abi);
  }
  let allMatch = true;
  for (const a of actions) {
    const action = Action.from(
      { account: a.account, name: a.name, authorization: a.authorization, data: a.data },
      abis.get(a.account),
    );
    const hex = action.data.hexString;
    const key = `${a.account}::${a.name}`;
    const expected = c.expected[key];
    if (!expected) {
      log(`   ?  ${key} — no reference hex in trace, skipping diff`);
      continue;
    }
    const match = hex.toLowerCase() === expected.toLowerCase();
    log(`   ${match ? '✓' : '✗'} ${key}`);
    if (!match) {
      log(`      ours :  ${hex}`);
      log(`      trace:  ${expected}`);
      allMatch = false;
    }
  }
  if (!allMatch) overallOk = false;
}

log(`\n=== ${overallOk ? 'ALL TRACES MATCH' : 'MISMATCH'} ===`);
process.exit(overallOk ? 0 : 1);
