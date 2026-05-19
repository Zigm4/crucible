/**
 * Verifies the pack-unbox action builders against two real traces of
 * zigm4.gm opening a pack:
 *
 *   tx1 (transfer with memo "unbox"):
 *     trx 41a2... (block ~395... reconstructed from history)
 *   tx2 (claimunboxed):
 *     trx 7af375f330c15c10cccc26d12667cd6461c28e2baee7ac71f043fb2644987067
 *
 * Reads the actual transactions back from the chain, encodes our
 * locally-built actions through WharfKit Action.from(.., abi), and
 * diffs the hex payload byte-for-byte.
 *
 * Run: node scripts/verify-packs.mjs
 */

import { APIClient, Action } from '@wharfkit/session';

const client = new APIClient({ url: 'https://wax.eosphere.io' });

// Reference traces (zigm4.gm, 2025-11-04 18:30 unbox of pack 1099968251815)
const TX1_ID = ''; // we'll find it from history
const TX2_ID = '7af375f330c15c10cccc26d12667cd6461c28e2baee7ac71f043fb2644987067';

const claimer = 'zigm4.gm';
const pack_asset_id = '1099968251815';
const origin_roll_ids = ['0', '1', '2', '3'];

const log = (...a) => console.log(...a);

// Find the tx1 (transfer) right before this claim
log('1. locating tx1 (transfer with memo=unbox)...');
const hist = await fetch(
  `https://wax.eosphere.io/v2/history/get_actions?account=${claimer}&act.account=atomicassets&act.name=transfer&before=2025-11-04T18:30:55.000Z&after=2025-11-04T18:30:30.000Z&limit=5`,
).then((r) => r.json());
const transfer = (hist.actions ?? []).find(
  (a) => a.act?.data?.to === 'atomicpacksx' && a.act?.data?.memo === 'unbox',
);
if (!transfer) {
  console.error('!! could not locate the tx1 transfer in history');
  process.exit(2);
}
const TX1_ID_FOUND = transfer.trx_id;
log(`   found: ${TX1_ID_FOUND}`);

// Build our actions
log('\n2. building tx1 (transfer)');
const tx1_data_ours = {
  from: claimer,
  to: 'atomicpacksx',
  asset_ids: [pack_asset_id],
  memo: 'unbox',
};

log('3. building tx2 (claimunboxed)');
const tx2_data_ours = {
  pack_asset_id,
  origin_roll_ids,
};

// Encode both through the live ABIs
log('\n4. encoding locally + diffing against chain trace');
const abis = new Map();
for (const acct of ['atomicassets', 'atomicpacksx']) {
  const r = await client.v1.chain.get_abi(acct);
  abis.set(acct, r.abi);
}

function encode(account, name, data) {
  const a = Action.from(
    { account, name, authorization: [{ actor: claimer, permission: 'active' }], data },
    abis.get(account),
  );
  return a.data.hexString;
}

const ours = {
  'atomicassets::transfer': encode('atomicassets', 'transfer', tx1_data_ours),
  'atomicpacksx::claimunboxed': encode('atomicpacksx', 'claimunboxed', tx2_data_ours),
};

// Pull the historical hex payloads
async function pullTrxData(trx_id) {
  const r = await fetch(`https://wax.eosphere.io/v2/history/get_transaction?id=${trx_id}`).then((x) => x.json());
  return r.actions ?? [];
}

const tx1_actions = await pullTrxData(TX1_ID_FOUND);
const tx2_actions = await pullTrxData(TX2_ID);

function findOriginal(actions, account, name) {
  return actions.find((a) => {
    if (a.act?.account !== account || a.act?.name !== name) return false;
    const auth = a.act?.authorization?.[0]?.actor;
    if (auth !== claimer) return false;
    return true;
  });
}

const theirs = {
  'atomicassets::transfer': findOriginal(tx1_actions, 'atomicassets', 'transfer'),
  'atomicpacksx::claimunboxed': findOriginal(tx2_actions, 'atomicpacksx', 'claimunboxed'),
};

let ok = true;
for (const key of Object.keys(ours)) {
  const ourHex = ours[key];
  const original = theirs[key];
  if (!original) {
    log(`   ?  ${key} -- not found in trace`);
    ok = false;
    continue;
  }
  const [account, name] = key.split('::');
  const theirHex = encode(account, name, original.act.data);
  const match = ourHex.toLowerCase() === theirHex.toLowerCase();
  log(`   ${match ? '✓' : '✗'} ${key}`);
  if (!match) {
    log(`      ours :  ${ourHex}`);
    log(`      trace:  ${theirHex}`);
    ok = false;
  }
}

log(`\n=== ${ok ? 'ALL PACK ACTIONS MATCH THE ORIGINAL TRACES' : 'MISMATCH'} ===`);
process.exit(ok ? 0 : 1);
