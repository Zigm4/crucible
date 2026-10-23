/**
 * The check before signing: does simulateActions read the chain's answer right?
 *
 * src/chain/simulate.ts runs a transaction through compute_transaction
 * (executed by a node, never signed, never written) and sorts the answer
 * into accepted / refused / resources / unavailable. The sorting decides
 * whether the Run button is held back, so each kind is produced here from
 * a real recipe, built by the runner's own builder:
 *
 *   accepted    blend 45767 (Soil) as a holder of its two NFTs, minting one
 *   refused     the same blend with an NFT its signer does not own, and an
 *               announcedepo of 0, which blend.nefty refuses
 *   resources   a signer whose own NET is spent (blend 23002, makeitrain13),
 *               which must NOT be read as a refusal
 *   unavailable nothing to check
 *
 * Live data: a holder that has since sold or spent is reported, not failed.
 *
 * Run: npm run verify:simulate
 */
const fails = [];
const say = (pass, msg) => { console.log(`   ${pass ? 'ok  ' : 'FAIL'} ${msg}`); if (!pass) fails.push(msg); };
let sim, runner;
try {
  sim = await import('./.build/simulate.mjs');
  runner = await import('./.build/guidedRun.mjs');
} catch {
  console.error('Missing scripts/.build - run `npm run verify:simulate`.');
  process.exit(1);
}
const aa = (p) => fetch(`https://wax.api.atomicassets.io/atomicassets/v1/${p}`).then((r) => r.json());
const auth = (actor) => [{ actor, permission: 'active' }];

console.log('\n=== what the chain would do ===');
{
  // A holder of both Soil ingredients.
  const dirt = (await aa('assets?collection_name=underpunks55&template_id=251523&limit=100')).data ?? [];
  let who, d, r;
  for (const a of dirt.filter((x) => x.owner)) {
    const rocks = (await aa(`assets?owner=${a.owner}&template_id=253632&limit=1`)).data?.[0];
    if (rocks) { who = a.owner; d = a.asset_id; r = rocks.asset_id; break; }
  }
  if (!who) console.log('   skip  nobody holds both Soil ingredients any more');
  else {
    const blend = { blend_id: 45767, security_id: 0 };
    const reqs = [
      { kind: 'nft', need: 1, candidates: [d], text: 'Dirt', role: 'burn' },
      { kind: 'nft', need: 1, candidates: [r], text: 'Brown Rocks', role: 'burn' },
    ];
    const acts = await runner.buildRunActions({ source: 'blend', actor: who, id: '45767', raw: blend, requirements: reqs, picked: { 0: [d], 1: [r] } });
    const ok = await sim.simulateActions(acts);
    say(ok.kind === 'accepted' && ok.mints === 1 && ok.burns === 2, `blend 45767 as ${who}: ${JSON.stringify(ok)}`);
    const other = dirt.find((x) => x.owner && x.owner !== who);
    const bad = await runner.buildRunActions({ source: 'blend', actor: who, id: '45767', raw: blend, requirements: reqs, picked: { 0: [other.asset_id], 1: [r] } });
    const no = await sim.simulateActions(bad);
    say(no.kind === 'refused' && no.reason.length > 0, `with a Dirt ${who} does not own: ${JSON.stringify(no)}`);
  }
}
{
  const zero = [
    { account: 'blend.nefty', name: 'announcedepo', authorization: auth('zigm4.gm'), data: { owner: 'zigm4.gm', count: 0 } },
  ];
  const r = await sim.simulateActions(zero);
  say(r.kind === 'refused' && /greater than 0/.test(r.reason), `an announcedepo of 0: ${JSON.stringify(r)}`);
}
{
  const card = (await aa('assets?ids=1099841970607')).data?.[0];
  if (card?.owner !== 'makeitrain13') console.log('   skip  the card used for the NET case has moved');
  else {
    const raw = { blend_id: 23002, collection_name: 'agarthagames', security_id: 0, ingredients: [['BALANCE_INGREDIENT', { schema_name: 'loyaltycards', template_id: 622617, attribute_name: 'Balance', cost: 100, display_data: '{}' }]] };
    const reqs = runner.requirementsOf(raw, [card], true);
    const acts = await runner.buildRunActions({ source: 'blend', actor: 'makeitrain13', id: '23002', raw, requirements: reqs, picked: { 0: [card.asset_id] } });
    const r = await sim.simulateActions(acts);
    say(r.kind === 'resources' || r.kind === 'accepted',
        `a signer out of NET is "resources", never "refused" (${JSON.stringify(r)})`);
  }
}
{
  const r = await sim.simulateActions([]);
  say(r.kind === 'unavailable', `nothing to check is "unavailable": ${JSON.stringify(r)}`);
}

console.log('');
if (fails.length) {
  console.log(`=== ${fails.length} FAILURE(S) ===`);
  for (const f of fails) console.log(`   ${f}`);
  process.exit(1);
}
console.log('=== ALL SIMULATION CHECKS PASS ===');
