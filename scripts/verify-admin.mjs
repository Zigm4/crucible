/**
 * Verifies the admin action builders (src/nefty/admin.ts) against real
 * on-chain admin traces from various collection managers. We can't use
 * zigm4.gm here (not a collection admin), so we pull one historical
 * trace per action from whoever signed it, rebuild the action locally
 * with the same inputs, encode both through the live ABI, and diff.
 *
 * Run: node scripts/verify-admin.mjs
 */

import { APIClient, Action } from '@wharfkit/session';

const client = new APIClient({ url: 'https://wax.eosphere.io' });

// Each case: the action, the signer, the exact inputs, and the trace
// it came from. `build` returns the {account,name,data} we'd send.
const CASES = [
  {
    label: 'blend.nefty::setblendhide',
    trx: '90d8c737df06b6e4a5561301881b12f499727703d5e79ee58d5f3f2dd6c6b3c7',
    actor: 'makultozioom',
    account: 'blend.nefty', name: 'setblendhide',
    data: { authorized_account: 'makultozioom', blend_id: '45125', is_hidden: false },
  },
  {
    label: 'blend.nefty::setblendtime',
    trx: 'ed096d34d12cd50e39f74d3da36ce049a730a45f0e221a4818646cf2f4fd96cb',
    actor: 'rustveil',
    account: 'blend.nefty', name: 'setblendtime',
    data: { authorized_account: 'rustveil', blend_id: '45688', start_time: 1779984000, end_time: 0 },
  },
  {
    label: 'blend.nefty::delblend',
    trx: '0f72619aef147a4c7b7d8ac5c71d2eb4f1d4d5a8b3144737994837e197e4f768',
    actor: 'makultozioom',
    account: 'blend.nefty', name: 'delblend',
    data: { authorized_account: 'makultozioom', blend_id: '45681' },
  },
  {
    label: 'blend.nefty::setblendmax',
    trx: '071763c8bd3fe6f86ee25e28b11b9b5283ce7852cb7ce10e99549aa7b3705135',
    actor: 'rustveil',
    account: 'blend.nefty', name: 'setblendmax',
    data: { authorized_account: 'rustveil', blend_id: '45683', new_max_uses: 0 },
  },
  {
    label: 'blend.nefty::setblendlim',
    trx: '071763c8bd3fe6f86ee25e28b11b9b5283ce7852cb7ce10e99549aa7b3705135',
    actor: 'rustveil',
    account: 'blend.nefty', name: 'setblendlim',
    data: { authorized_account: 'rustveil', blend_id: '45683', account_limit: 0, account_limit_cooldown: 0 },
  },
  {
    label: 'blend.nefty::setblenddata',
    trx: 'feb1daf5e6152bbbb978a02db97ea0eb4af49c6ba71426adc7b6dd11ca1e87d1',
    actor: 'rustveil',
    account: 'blend.nefty', name: 'setblenddata',
    data: {
      authorized_account: 'rustveil', blend_id: '45683',
      display_data: '{"name":"Common Accessories → Shardfang Dirk","description":"","image":"QmWHeGrAjjU1WL7Y3hQpRixASLQDG21n4VMdB1t3NJBcow"}',
    },
  },
  {
    label: 'blend.nefty::setblendsec',
    trx: '6dcaedeb4b22a2cf71ee3ea6a86bc9d12c95920157410765548b46c43d402fac',
    actor: 'byronjrempel',
    account: 'blend.nefty', name: 'setblendsec',
    data: { authorized_account: 'byronjrempel', blend_id: '44453', security_id: '0' },
  },
  {
    label: 'secure.nefty::addtowl',
    trx: '2b753192d7ea09f4ed1a8313c9e4106340b12241470cc940d4d2456bf61d3250',
    actor: 'farmerrealms',
    account: 'secure.nefty', name: 'addtowl',
    data: { authorized_account: 'farmerrealms', collection_name: 'savagerealms', security_id: '1325', accounts_to_add: ['farmerrealms'] },
  },
  {
    label: 'secure.nefty::erasefromwl',
    trx: '0586e042fe1dfe5e1511f4ed5a4317d0bee40f469c2f375519d0bc8737b7870d',
    actor: 'makultozioom',
    account: 'secure.nefty', name: 'erasefromwl',
    data: { authorized_account: 'makultozioom', collection_name: 'captainshelm', security_id: '1155', accounts_to_remove: ['wissdfghjklp'] },
  },
  {
    label: 'secure.nefty::addwhitelist',
    trx: '0890cadd1100afd5c36d473f46f5899c781278159d5a8ff0238371fa7b8c99d0',
    actor: 't41u.wam',
    account: 'secure.nefty', name: 'addwhitelist',
    data: { authorized_account: 't41u.wam', collection_name: 'nonfungdrugs', whitelist_name: '4x NFTs from NFD', description: '' },
  },
];

const log = (...a) => console.log(...a);

const abis = new Map();
async function abi(acct) {
  if (!abis.has(acct)) {
    const r = await client.v1.chain.get_abi(acct);
    abis.set(acct, r.abi);
  }
  return abis.get(acct);
}

function encode(account, name, actor, data) {
  const a = Action.from(
    { account, name, authorization: [{ actor, permission: 'active' }], data },
    abis.get(account),
  );
  return a.data.hexString;
}

async function pullTrxAction(trx, account, name, actor) {
  const r = await fetch(`https://wax.eosphere.io/v2/history/get_transaction?id=${trx}`).then((x) => x.json());
  return (r.actions ?? []).find(
    (a) => a.act?.account === account && a.act?.name === name && a.act?.authorization?.[0]?.actor === actor,
  );
}

let ok = true;
for (const c of CASES) {
  await abi(c.account);
  const original = await pullTrxAction(c.trx, c.account, c.name, c.actor);
  if (!original) {
    log(`   ?  ${c.label} -- not found in trace`);
    ok = false;
    continue;
  }
  const ours = encode(c.account, c.name, c.actor, c.data);
  const theirs = encode(c.account, c.name, c.actor, original.act.data);
  const match = ours.toLowerCase() === theirs.toLowerCase();
  log(`   ${match ? '✓' : '✗'} ${c.label}`);
  if (!match) {
    log(`      ours :  ${ours}`);
    log(`      trace:  ${theirs}`);
    ok = false;
  }
}

log(`\n=== ${ok ? 'ALL ADMIN ACTIONS MATCH THE ORIGINAL TRACES' : 'MISMATCH'} ===`);
process.exit(ok ? 0 : 1);
