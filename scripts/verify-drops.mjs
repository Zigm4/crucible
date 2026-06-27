/**
 * Verify the drop action builder against two real traces from zigm4.gm:
 *   - drop 237418, paid 50 WAX (claimdrop, public)
 *   - drop 237297, paid 10000 GUILD (claimwproof, NFT-ownership proof)
 *
 * For each case we:
 *   1. fetch the drop row from neftyblocksd
 *   2. build the action list our code would generate
 *   3. serialise it locally via WharfKit Action.from(.., abi)
 *   4. diff every hex payload against the original trace
 *
 * Run: node scripts/verify-drops.mjs
 */

import { APIClient, Action } from '@wharfkit/session';

const client = new APIClient({ url: 'https://wax.eosphere.io' });

const CASES = [
  {
    label: 'Drop 237418 - claimdrop (paid 50 WAX)',
    claimer: 'zigm4.gm',
    drop_id: 237418,
    amount: 1,
    listing_price: '50.00000000 WAX',
    settlement_symbol: '8,WAX',
    token_contract: 'eosio.token',
    is_free: false,
    auth_kind: 'public',
    expected: {
      'neftyblocksd::assertprice':
        '8a9e0300000000000080f0fa02000000000857415800000000085741580000000000000008',
      'eosio.token::transfer':
        '00000092012299fb0080cf4b4d80955a8080f0fa0200000000085741580000000007006465706f736974',
      'neftyblocksd::claimdrop':
        '00000092012299fb8a9e03000000000001000000000000000000004e6566747942 6c6f636b73024652085741580000000000000000',
    },
  },
  {
    label: 'Drop 237297 - claimwproof (paid 10000 GUILD, NFT proof)',
    claimer: 'zigm4.gm',
    drop_id: 237297,
    amount: 1,
    listing_price: '10000.000000 GUILD',
    settlement_symbol: '6,GUILD',
    token_contract: 'foundry.tag',
    is_free: false,
    auth_kind: 'proof',
    proof_asset_ids: ['1099968476551', '1099968476561', '1099968476565', '1099968476572'],
    expected: {
      'neftyblocksd::assertprice':
        '319e030000000000801d2c040000000006475549 4c4400000647554944000000000000000000',
      'foundry.tag::transfer':
        '00000092012299fb0080cf4b4d80955a80801d2c04000000000647554944000000076465706f736974',
      'neftyblocksd::claimwproof':
        '00000092012299fb319e030000000000010000000000000000000000004e656674794 26c6f636b73 04 [asset ids] 02 4652 06 47 55 49 4c 44 00 00 06 ...',
    },
  },
];

// Use the ABI to serialise → no need for hand-typed expected hex.
// Instead we'll compare against re-decoded original traces.

async function getDrop(drop_id) {
  const res = await client.call({
    path: '/v1/chain/get_table_rows',
    params: {
      json: true,
      code: 'neftyblocksd',
      scope: 'neftyblocksd',
      table: 'drops',
      lower_bound: String(drop_id),
      upper_bound: String(drop_id),
      limit: 1,
    },
  });
  return res.rows[0];
}

async function getTraceActions(trx_id) {
  const res = await fetch(`https://wax.eosphere.io/v2/history/get_transaction?id=${trx_id}`);
  const j = await res.json();
  const out = new Map();
  for (const a of j.actions ?? []) {
    const code = a.act?.account;
    const name = a.act?.name;
    const data = a.act?.data;
    const sig = a.act?.authorization?.[0]?.actor;
    if (sig !== 'zigm4.gm') continue;
    const key = `${code}::${name}`;
    if (!out.has(key)) {
      // Re-encode the original action through the ABI to get the canonical hex.
      out.set(key, { data });
    }
  }
  return out;
}

async function abiOf(account) {
  const r = await client.v1.chain.get_abi(account);
  return r.abi;
}

function encode(account, name, data, abi) {
  const action = Action.from(
    { account, name, authorization: [{ actor: 'zigm4.gm', permission: 'active' }], data },
    abi,
  );
  return action.data.hexString;
}

const TRACES = {
  237418: 'e743ce1fef7b22b5afe70c57e6750daa4a68b57453bfd8e1d026da628aa7caaa',
  237297: 'e904f9b4b18c7e254d3eef392fa6f19a58b171668c735e86cbbf293ffe1cb302',
};

const log = (...a) => console.log(...a);
let overallOk = true;

for (const c of CASES) {
  log(`\n=== ${c.label} ===`);
  const drop = await getDrop(c.drop_id);
  if (!drop) { log('!! drop not found'); overallOk = false; continue; }
  log(`   listing_price: ${drop.listing_price}  settlement: ${drop.settlement_symbol}  auth_required: ${drop.auth_required}`);

  // Build the action list manually (mirrors src/nefty/dropExecute.ts)
  const auth = [{ actor: c.claimer, permission: 'active' }];
  const actions = [];
  if (!c.is_free) {
    actions.push({
      account: 'neftyblocksd',
      name: 'assertprice',
      authorization: auth,
      data: { drop_id: String(c.drop_id), listing_price: c.listing_price, settlement_symbol: c.settlement_symbol },
    });
    actions.push({
      account: c.token_contract,
      name: 'transfer',
      authorization: auth,
      data: { from: c.claimer, to: 'neftyblocksd', quantity: c.listing_price, memo: 'deposit' },
    });
  }
  const common = {
    claimer: c.claimer,
    drop_id: String(c.drop_id),
    amount: c.amount,
    intended_delphi_median: '0',
    referrer: 'NeftyBlocks',
    country: 'FR',
    currency: c.settlement_symbol,
    referrer_account: '',
  };
  if (c.auth_kind === 'public') {
    actions.push({ account: 'neftyblocksd', name: 'claimdrop', authorization: auth, data: common });
  } else if (c.auth_kind === 'proof') {
    actions.push({
      account: 'neftyblocksd',
      name: 'claimwproof',
      authorization: auth,
      data: {
        claimer: c.claimer,
        drop_id: String(c.drop_id),
        amount: c.amount,
        intended_delphi_median: '0',
        referrer: 'NeftyBlocks',
        asset_ids: c.proof_asset_ids,
        country: 'FR',
        currency: c.settlement_symbol,
        referrer_account: '',
      },
    });
  }

  // Fetch original trace + compare per-action
  const traceMap = await getTraceActions(TRACES[c.drop_id]);
  const abis = new Map();
  for (const code of new Set(actions.map((a) => a.account))) {
    abis.set(code, await abiOf(code));
  }

  let allMatch = true;
  for (const a of actions) {
    const ours = encode(a.account, a.name, a.data, abis.get(a.account));
    const key = `${a.account}::${a.name}`;
    const original = traceMap.get(key);
    if (!original) { log(`   ?  ${key} - no original action found in trace`); allMatch = false; continue; }
    const theirs = encode(a.account, a.name, original.data, abis.get(a.account));
    const match = ours.toLowerCase() === theirs.toLowerCase();
    log(`   ${match ? '✓' : '✗'} ${key}`);
    if (!match) {
      log(`      ours    : ${ours}`);
      log(`      original: ${theirs}`);
      allMatch = false;
    }
  }
  if (!allMatch) overallOk = false;
}

log(`\n=== ${overallOk ? 'ALL DROP TRACES MATCH' : 'MISMATCH'} ===`);
process.exit(overallOk ? 0 : 1);
