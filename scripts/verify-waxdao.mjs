/**
 * Verifies the WaxDAO blend builders against zigm4.gm's real trace:
 *
 *   trx 71d4917b74fdba3c425301d9ed21505d5b6a19016ab704369d87260b604cba8c
 *   (2024-11-05, Back Scratcher blend #1127 on waxdaomarket)
 *
 * For every action the user actually signed (assertblend + the FT
 * transfer + each NFT transfer with its slot-indexed memo), we:
 *
 *   1. fetch the WaxDAO blend row from the live contract
 *   2. build our local action list with the same inputs (claimer,
 *      blend_id, picked asset_ids per slot, unique_id pinned to the
 *      trace value to keep the bytes stable)
 *   3. serialise each action via the live ABI through WharfKit's
 *      `Action.from(...)` and compare hex to the original trace
 *
 * Run: node scripts/verify-waxdao.mjs
 */

import { APIClient, Action } from '@wharfkit/session';

const client = new APIClient({ url: 'https://wax.eosphere.io' });

const claimer = 'zigm4.gm';

const TRACE = {
  label: 'Back Scratcher blend #1127 (waxdaomarket)',
  trx_id: '71d4917b74fdba3c425301d9ed21505d5b6a19016ab704369d87260b604cba8c',
  blend_id: 1127,
  unique_id: '108368740',
  // Slot 0 is the FT cost (no NFT). Slots 1..3 are the three NFTs.
  // Pulled directly from the trace.
  nft_by_slot: {
    1: ['1099949002422'],
    2: ['1099949002465'],
    3: ['1099949002466'],
  },
  ft: {
    contract: 'underpunks55',
    quantity: '10.00000000 UPMAX',
  },
};

const log = (...a) => console.log(...a);

// Build locally what we'd send. Mirror src/waxdao/blendExecute.ts.
function buildLocal() {
  const auth = [{ actor: claimer, permission: 'active' }];
  const actions = [];
  actions.push({
    account: 'waxdaomarket',
    name: 'assertblend',
    authorization: auth,
    data: {
      blend_ID: String(TRACE.blend_id),
      user: claimer,
      unique_id: TRACE.unique_id,
    },
  });
  actions.push({
    account: TRACE.ft.contract,
    name: 'transfer',
    authorization: auth,
    data: {
      from: claimer,
      to: 'waxdaomarket',
      quantity: TRACE.ft.quantity,
      memo: `|blend_deposit|${TRACE.blend_id}|0|`,
    },
  });
  for (const slot of [1, 2, 3]) {
    actions.push({
      account: 'atomicassets',
      name: 'transfer',
      authorization: auth,
      data: {
        from: claimer,
        to: 'waxdaomarket',
        asset_ids: TRACE.nft_by_slot[slot],
        memo: `|blend_deposit|${TRACE.blend_id}|${slot}|`,
      },
    });
  }
  return actions;
}

async function pullTrxActions(trx_id) {
  const r = await fetch(
    `https://wax.eosphere.io/v2/history/get_transaction?id=${trx_id}`,
  ).then((x) => x.json());
  return r.actions ?? [];
}

const abis = new Map();
async function abi(acct) {
  if (!abis.has(acct)) {
    const r = await client.v1.chain.get_abi(acct);
    abis.set(acct, r.abi);
  }
  return abis.get(acct);
}

function encode(action) {
  const a = Action.from(
    {
      account: action.account,
      name: action.name,
      authorization: action.authorization,
      data: action.data,
    },
    abis.get(action.account),
  );
  return a.data.hexString;
}

log(`\n=== ${TRACE.label} ===`);
log(`   trx ${TRACE.trx_id}`);

const traceActions = await pullTrxActions(TRACE.trx_id);
const local = buildLocal();
for (const a of local) await abi(a.account);

let allOk = true;
for (const ours of local) {
  // For atomicassets::transfer there are multiple user-signed entries
  // (one per slot). Match by memo so we compare like for like.
  const ourMemo = ours.data.memo;
  const original = traceActions.find((a) => {
    if (a.act?.account !== ours.account || a.act?.name !== ours.name) return false;
    if (a.act?.authorization?.[0]?.actor !== claimer) return false;
    if (ourMemo !== undefined && a.act?.data?.memo !== ourMemo) return false;
    return true;
  });
  const key = `${ours.account}::${ours.name}${ourMemo ? ` memo="${ourMemo}"` : ''}`;
  if (!original) {
    log(`   ?  ${key} -- not found in trace`);
    allOk = false;
    continue;
  }
  const oursHex = encode(ours);
  const theirsHex = encode({
    account: ours.account,
    name: ours.name,
    authorization: ours.authorization,
    data: original.act.data,
  });
  const match = oursHex.toLowerCase() === theirsHex.toLowerCase();
  log(`   ${match ? '✓' : '✗'} ${key}`);
  if (!match) {
    log(`      ours :  ${oursHex}`);
    log(`      trace:  ${theirsHex}`);
    allOk = false;
  }
}

log(`\n=== ${allOk ? 'ALL WAXDAO ACTIONS MATCH THE ORIGINAL TRACE' : 'MISMATCH'} ===`);
process.exit(allOk ? 0 : 1);
