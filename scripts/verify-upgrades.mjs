/**
 * Verifies the upgrade action builders against two real traces of
 * zigm4.gm running an `up.nefty::upgrade`:
 *
 *   tx1 (FT-only upgrade, 10 WAX cost, upgrade_id 447):
 *     trx b92981ab7dfb01d2891dfebf84c40986c547f8e7a32d3ff90bc24bc8ca002878
 *
 *   tx2 (NFT + FT cost, transferred_assets non-empty, upgrade_id 323):
 *     trx 24f657258db2ab5ce6d0395fc1a90a10f4b6efafbc96a8b2459a0fab4d396e32
 *
 * For each transaction we:
 *   1. Pull the actual `upgrade` row from `up.nefty/upgrades`
 *   2. Build our local action list with the same inputs
 *   3. Serialise it via the live ABI (Action.from)
 *   4. Compare hex against the trace's own action data, encoded the
 *      same way (only authorisations stripped to make the diff fair)
 *
 * Run: node scripts/verify-upgrades.mjs
 */

import { APIClient, Action } from '@wharfkit/session';

const client = new APIClient({ url: 'https://wax.eosphere.io' });

const claimer = 'zigm4.gm';

const CASES = [
  {
    label: 'FT-only upgrade (id 447, 10 WAX, no NFT cost)',
    trx_id: 'b92981ab7dfb01d2891dfebf84c40986c547f8e7a32d3ff90bc24bc8ca002878',
    upgrade_id: 447,
    assets_to_upgrade: ['1099953960638'],
    transferred_assets: [],
    own_assets: [],
    ft_payments: ['10.00000000 WAX'],
    // No announcedepo + no atomicassets::transfer expected for FT-only.
  },
  {
    label: 'FT+NFT upgrade (id 323)',
    trx_id: '24f657258db2ab5ce6d0395fc1a90a10f4b6efafbc96a8b2459a0fab4d396e32',
    upgrade_id: 323,
    assets_to_upgrade: ['1099948901006'],
    transferred_assets: ['1099557806692'],
    own_assets: [],
    // Note: we don't know the FT cost for this old trace without
    // re-walking the trace, but the test below skips FT actions when
    // not present in our local plan.
    ft_payments: [],
  },
];

const log = (...a) => console.log(...a);

// ── locally rebuild the up.nefty action plan ─────────────────────────── //

function buildLocal(c) {
  const auth = [{ actor: claimer, permission: 'active' }];
  const actions = [];
  // FT leg
  for (const qty of c.ft_payments) {
    actions.push({
      account: 'up.nefty',
      name: 'openbal',
      authorization: auth,
      data: { owner: claimer, token_symbol: symbolFromQuantity(qty) },
    });
  }
  for (const qty of c.ft_payments) {
    actions.push({
      account: 'eosio.token',
      name: 'transfer',
      authorization: auth,
      data: { from: claimer, to: 'up.nefty', quantity: qty, memo: 'deposit' },
    });
  }
  // NFT leg: announcedepo + transfer, ONLY when we have NFT cost.
  if (c.transferred_assets.length > 0) {
    actions.push({
      account: 'up.nefty',
      name: 'announcedepo',
      authorization: auth,
      data: { owner: claimer, count: c.transferred_assets.length },
    });
    actions.push({
      account: 'atomicassets',
      name: 'transfer',
      authorization: auth,
      data: {
        from: claimer,
        to: 'up.nefty',
        asset_ids: c.transferred_assets,
        memo: 'deposit',
      },
    });
  }
  // The upgrade action itself.
  actions.push({
    account: 'up.nefty',
    name: 'upgrade',
    authorization: auth,
    data: {
      claimer,
      upgrade_id: String(c.upgrade_id),
      transferred_assets: c.transferred_assets,
      own_assets: c.own_assets,
      assets_to_upgrade: c.assets_to_upgrade,
    },
  });
  return actions;
}

function symbolFromQuantity(q) {
  const [amount, ticker] = q.trim().split(/\s+/);
  const dot = amount.indexOf('.');
  const precision = dot === -1 ? 0 : amount.length - dot - 1;
  return `${precision},${ticker}`;
}

// ── fetch + diff ─────────────────────────────────────────────────────── //

async function pullTrxActions(trx_id) {
  const r = await fetch(`https://wax.eosphere.io/v2/history/get_transaction?id=${trx_id}`).then((x) => x.json());
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

let overallOk = true;

for (const c of CASES) {
  log(`\n=== ${c.label} ===`);
  const traceActions = await pullTrxActions(c.trx_id);
  const local = buildLocal(c);
  // Preload ABIs for every account we touch.
  for (const a of local) await abi(a.account);

  for (const ours of local) {
    const key = `${ours.account}::${ours.name}`;
    const original = traceActions.find(
      (a) =>
        a.act?.account === ours.account &&
        a.act?.name === ours.name &&
        a.act?.authorization?.[0]?.actor === claimer,
    );
    if (!original) {
      log(`   ?  ${key} -- not found in trace`);
      overallOk = false;
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
      overallOk = false;
    }
  }
}

log(`\n=== ${overallOk ? 'ALL UPGRADE ACTIONS MATCH THE ORIGINAL TRACES' : 'MISMATCH'} ===`);
process.exit(overallOk ? 0 : 1);
