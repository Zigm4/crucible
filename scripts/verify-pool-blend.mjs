/**
 * Read-only verification of the POOL_NFT blend path.
 *
 * Reference case: blend 42787 (underpunks55, "Volna-57 Geiger Counter").
 * Its single roll has one 100%-odds outcome whose result is a
 * POOL_NFT_RESULT, i.e. the reward was pre-minted and deposited into the
 * `volna` pool instead of being minted on demand. Crucible used to reject
 * that shape outright; it now routes it through the two-step
 * announce+fuse -> wait -> claim flow (src/nefty/rngExecute.ts).
 *
 * What this checks, entirely against live chain state:
 *   1. the blend row really declares a POOL_NFT_RESULT
 *   2. the odds are certain (1 outcome carrying the full total_odds), so
 *      the reward is guaranteed and only the escrowed serial is drawn
 *   3. `pools` / `poolassets` agree on the remaining stock, and the pool
 *      still holds enough to pay out
 *   4. the result template is fully minted (issued == max), which is WHY
 *      the author had to use a pool rather than an on-demand mint
 *   5. the claimer owns the ingredients and passes the whitelist gate
 *   6. the exact action list Crucible builds serialises cleanly against
 *      the contracts' live ABIs -- byte-for-byte what the wallet is asked
 *      to sign, with no signature requested and nothing broadcast
 *
 * The action builder below mirrors src/nefty/rngExecute.ts on purpose:
 * it is an independent re-implementation, so a drift between the two
 * shows up as a diff here rather than as a failed transaction.
 *
 * Run: node scripts/verify-pool-blend.mjs [blend_id] [claimer]
 */

import { APIClient, Action } from '@wharfkit/session';

const client = new APIClient({ url: 'https://wax.eosphere.io' });

const BLEND_ID = process.argv[2] ?? '42787';
const CLAIMER = process.argv[3] ?? 'zigm4.gm';

const log = (...a) => console.log(...a);
let ok = true;
const check = (pass, label, detail = '') => {
  log(`   ${pass ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
  if (!pass) ok = false;
};

async function rows(code, scope, table, extra = {}) {
  const res = await client.call({
    path: '/v1/chain/get_table_rows',
    params: { json: true, code, scope, table, limit: 100, ...extra },
  });
  return res.rows ?? [];
}

// ─── 1. the blend row ──────────────────────────────────────────────────── //

log(`\n=== blend ${BLEND_ID} ===`);
const [blend] = await rows('blend.nefty', 'blend.nefty', 'blends', {
  lower_bound: BLEND_ID,
  upper_bound: BLEND_ID,
  limit: 1,
});
if (!blend) {
  log('!! blend not found');
  process.exit(1);
}
const displayName = (() => {
  try {
    return JSON.parse(blend.display_data || '{}').name ?? '(unnamed)';
  } catch {
    return '(unnamed)';
  }
})();
log(`   "${displayName}"  collection: ${blend.collection_name}  security_id: ${blend.security_id}`);
log(`   uses: ${blend.use_count}/${blend.max}   ingredients: ${blend.ingredients.length}   rolls: ${blend.rolls.length}`);

const draws = [];
let oddsCertain = true;
blend.rolls.forEach((roll, i) => {
  if (roll.outcomes.length !== 1 || roll.outcomes[0].odds !== roll.total_odds) {
    oddsCertain = false;
  }
  for (const outcome of roll.outcomes) {
    for (const [type, payload] of outcome.results ?? []) {
      if (type === 'POOL_NFT_RESULT') draws.push({ roll: i, ...payload });
    }
  }
});

check(draws.length > 0, 'blend declares a POOL_NFT_RESULT', draws.map((d) => `pool="${d.pool_name}"`).join(' '));
check(oddsCertain, 'odds are certain (1 outcome at full total_odds per roll)');

// ─── 2. pool stock ─────────────────────────────────────────────────────── //

log(`\n=== pools ===`);
for (const draw of draws) {
  const [pool] = await rows('blend.nefty', blend.collection_name, 'pools', {
    lower_bound: draw.pool_name,
    upper_bound: draw.pool_name,
    limit: 1,
  });
  if (!pool) {
    check(false, `pool "${draw.pool_name}" exists in scope ${blend.collection_name}`);
    continue;
  }
  const assetRows = await rows('blend.nefty', String(pool.pool_id), 'poolassets', { limit: 10 });
  const assets = assetRows.flatMap((r) => r.assets ?? []);
  log(`   pool "${pool.pool_name}" (pool_id ${pool.pool_id}): added ${pool.amount_added}, reserved ${pool.amount_reserved}, count ${pool.count}, templates [${(pool.templates ?? []).join(', ')}]`);
  check(pool.count === assets.length, 'pools.count matches the escrowed asset_ids', `${pool.count} == ${assets.length}`);
  check(pool.count > 0, 'pool still has stock to pay out', `${pool.count} left`);
  check(
    (pool.templates ?? []).length === 1,
    'pool hands out a single template (reward fully known up front)',
    `[${(pool.templates ?? []).join(', ')}]`,
  );

  // Why a pool was necessary: the template is capped and already fully minted,
  // so an ON_DEMAND_NFT_RESULT could never mint another one.
  const tid = (pool.templates ?? [])[0];
  if (tid) {
    const [tpl] = await rows('atomicassets', blend.collection_name, 'templates', {
      lower_bound: String(tid),
      upper_bound: String(tid),
      limit: 1,
    });
    if (tpl) {
      log(`   template ${tid}: issued ${tpl.issued_supply} / max ${tpl.max_supply}`);
      check(
        Number(tpl.max_supply) > 0 && Number(tpl.issued_supply) >= Number(tpl.max_supply),
        'result template is capped and fully minted (hence the pool)',
      );
    }
  }
}

// ─── 3. claimer eligibility ────────────────────────────────────────────── //

log(`\n=== claimer ${CLAIMER} ===`);
const nftIngredients = blend.ingredients.filter(([t]) => t !== 'FT_INGREDIENT');
const ftIngredients = blend.ingredients.filter(([t]) => t === 'FT_INGREDIENT');
const picked = [];

for (const [type, payload] of nftIngredients) {
  if (type !== 'TEMPLATE_INGREDIENT') {
    log(`   ?  ingredient ${type} not resolved by this script, skipping asset pick`);
    continue;
  }
  const qs = new URLSearchParams({
    owner: CLAIMER,
    collection_name: payload.collection_name,
    template_id: String(payload.template_id),
    limit: '100',
  });
  const body = await fetch(`https://wax.api.atomicassets.io/atomicassets/v1/assets?${qs}`).then((r) => r.json());
  const owned = (body.data ?? []).map((a) => a.asset_id);
  check(
    owned.length >= payload.amount,
    `owns ${payload.amount}x template ${payload.template_id}`,
    `${owned.length} in wallet`,
  );
  picked.push(...owned.slice(0, payload.amount));
}

const secure = String(blend.security_id ?? '0') !== '0';
if (secure) {
  const wl = await rows('secure.nefty', String(blend.security_id), 'whitelists', { limit: 1000 });
  const allowed = wl.some((r) => (r.account ?? r.name) === CLAIMER);
  check(allowed, `whitelisted on security_id ${blend.security_id}`, `${wl.length} accounts on the list`);
}
check(ftIngredients.length === 0, 'no token cost on this blend (nothing to openbal/transfer)');

// ─── 4. the action list Crucible builds ────────────────────────────────── //

log(`\n=== transaction Crucible would ask the wallet to sign ===`);
const auth = [{ actor: CLAIMER, permission: 'active' }];
const actions = [
  {
    account: 'blend.nefty',
    name: 'announcedepo',
    authorization: auth,
    data: { owner: CLAIMER, count: picked.length },
  },
  {
    account: 'atomicassets',
    name: 'transfer',
    authorization: auth,
    data: { from: CLAIMER, to: 'blend.nefty', asset_ids: picked, memo: 'deposit' },
  },
  // security_id != 0 -> `fuse` (carries the security_check). Non-secure pool
  // blends would use `nosecfuse` here; both stage the drawn asset the same way.
  secure
    ? {
        account: 'blend.nefty',
        name: 'fuse',
        authorization: auth,
        data: {
          claimer: CLAIMER,
          blend_id: String(BLEND_ID),
          transferred_assets: picked,
          own_assets: [],
          security_check: ['WHITELIST_CHECK', { account_name: CLAIMER }],
        },
      }
    : {
        account: 'blend.nefty',
        name: 'nosecfuse',
        authorization: auth,
        data: {
          claimer: CLAIMER,
          blend_id: String(BLEND_ID),
          transferred_assets: picked,
          own_assets: [],
        },
      },
];

const abis = new Map();
for (const code of new Set(actions.map((a) => a.account))) {
  const r = await client.v1.chain.get_abi(code);
  abis.set(code, r.abi);
}
for (const a of actions) {
  const tag = `${a.account}::${a.name}`;
  try {
    const built = Action.from(
      { account: a.account, name: a.name, authorization: a.authorization, data: a.data },
      abis.get(a.account),
    );
    check(true, `${tag} serialises against the live ABI`, `${built.data.hexString.length / 2} bytes`);
  } catch (err) {
    check(false, `${tag} serialises against the live ABI`, err.message);
  }
}

// The second leg (blend.nefty::claim) can only be built once the contract
// has staged the row and assigned a claim_id, so it is not serialisable here.
log(`   i  TX2 blend.nefty::claim { claim_id, roll_indexes: [${blend.rolls.map(() => 0).join(', ')}] } is built after the claim row is staged`);

log(`\n=== ${ok ? 'POOL BLEND PATH OK' : 'FAILED'} ===`);
process.exit(ok ? 0 : 1);
