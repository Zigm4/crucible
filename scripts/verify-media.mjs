/**
 * Artwork: does a thumbnail try each gateway once, and wait for a slow one?
 *
 * IPFS gateways fail in three ways: they answer an error fast, they hang
 * and never answer, or they answer late. loadHedged (src/ui/media.ts) is
 * raced here against fake gateways that do exactly that, by replacing the
 * browser's Image with one whose URLs behave as each scenario says, and
 * counting how many times each URL is asked for.
 *
 *   - each gateway is asked once, however the others fail;
 *   - a gateway answering late, after the others failed or hung, still
 *     wins inside the 12 second budget;
 *   - when every gateway fails fast, it gives up at once, and when they
 *     all hang, at the budget and not before.
 *
 * Then the candidate list: an IPFS hash must become one URL per gateway,
 * with the hash where each gateway wants it. With --live, every gateway
 * is asked for two real files, a WAX-pinned one (underpunks55) and one
 * only AtomicHub's image service had (shadowsquads), and the list must
 * serve both.
 *
 * Run: npm run verify:media   (takes about 25 seconds: real timers)
 */
const fails = [];
const say = (pass, msg) => { console.log(`   ${pass ? 'ok  ' : 'FAIL'} ${msg}`); if (!pass) fails.push(msg); };

const asked = new Map();
let behaviour = {};
globalThis.Image = class {
  naturalWidth = 0;
  set src(url) {
    asked.set(url, (asked.get(url) ?? 0) + 1);
    const b = behaviour[url] ?? {};
    if (b.fail !== undefined) setTimeout(() => this.onerror?.(), b.fail);
    else if (b.load !== undefined) setTimeout(() => { this.naturalWidth = 512; this.onload?.(); }, b.load);
    // neither: the gateway hangs, nothing ever fires
  }
};

let media;
try { media = await import('./.build/media.mjs'); } catch {
  console.error('Missing scripts/.build/media.mjs - run `npm run verify:media`.');
  process.exit(1);
}

const urls = ['g0', 'g1', 'g2', 'g3', 'g4', 'g5'];
const race = (scenario) => new Promise((resolve) => {
  asked.clear();
  behaviour = scenario;
  const t0 = Date.now();
  media.loadHedged(urls, {
    onWin: (url) => resolve({ win: url, ms: Date.now() - t0 }),
    onFail: () => resolve({ fail: true, ms: Date.now() - t0 }),
  });
});
const once = () => [...asked.values()].every((n) => n === 1);
const tally = () => JSON.stringify(Object.fromEntries(asked));

console.log('\n=== the artwork race ===');
{
  const r = await race({ g0: { fail: 50 }, g1: { fail: 50 }, g2: { fail: 50 }, g3: { fail: 50 }, g4: { fail: 50 }, g5: { load: 300 } });
  say(r.win === 'g5', `five fast failures, then a gateway that answers: it wins (${r.win ?? 'gave up'} at ${r.ms}ms)`);
  say(once(), `and every gateway was asked exactly once: ${tally()}`);
}
{
  const r = await race({ g1: { fail: 50 }, g2: { fail: 50 }, g3: { fail: 50 }, g4: { fail: 50 }, g5: { load: 6000 } });
  say(r.win === 'g5', `the first gateway hangs, four fail fast, the last answers after 6s: it still wins (${r.win ?? `gave up at ${r.ms}ms`})`);
  say(once(), `and nobody was asked twice: ${tally()}`);
}
{
  const r = await race(Object.fromEntries(urls.map((u) => [u, { fail: 30 }])));
  say(r.fail && r.ms < 1000, `every gateway fails fast: it gives up at once (${r.ms}ms)`);
  say(once(), `each asked once: ${tally()}`);
}
{
  const r = await race({});
  say(r.fail && r.ms >= 11_900, `every gateway hangs: it gives up at the 12s budget, not before (${r.ms}ms)`);
  say(once() && asked.size === urls.length, `having asked each of them once: ${tally()}`);
}

console.log('\n=== the candidate list ===');
const PINNED = 'QmQKiKbGp226966yS95KBuVrDbqgmhHDVKK7zRLoBishCe';   // underpunks55
const UNPINNED = 'QmfYisHMpVuqwQrcj13TKXZftDhbSqVSA9Mv5uqgMiV8cQ'; // shadowsquads
{
  const c = media.mediaCandidates(PINNED);
  say(c.length === media.IPFS_GATEWAYS.length && c.every((u) => u.includes(PINNED) && !u.includes('{cid}')),
      `one URL per gateway, the hash in place: ${c.map((u) => new URL(u).host).join(', ')}`);
  say(c.some((u) => u === `https://resizer.atomichub.io/images/v1/preview?ipfs=${PINNED}&size=370`),
      'AtomicHub\'s image service takes the hash as a parameter, not a path');
  say(media.mediaCandidates('ipfs://' + PINNED)[0] === c[0] && media.mediaCandidates('not a hash').length === 0,
      'an ipfs:// prefix is read, and author junk makes no request at all');
}
if (process.argv.includes('--live')) {
  for (const [label, cid] of [['WAX-pinned', PINNED], ['shadowsquads', UNPINNED]]) {
    const results = await Promise.all(media.mediaCandidates(cid).map(async (u) => {
      const t0 = Date.now();
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(12_000) });
        const type = r.headers.get('content-type') ?? '';
        return { host: new URL(u).host, ok: r.ok && type.startsWith('image/'), what: `${r.status} ${type}`, ms: Date.now() - t0 };
      } catch { return { host: new URL(u).host, ok: false, what: 'no answer', ms: Date.now() - t0 }; }
    }));
    say(results.some((r) => r.ok), `${label} file: ${results.map((r) => `${r.host} ${r.ok ? 'image' : r.what} ${r.ms}ms`).join(' · ')}`);
  }
}

console.log('');
if (fails.length) {
  console.log(`=== ${fails.length} FAILURE(S) ===`);
  for (const f of fails) console.log(`   ${f}`);
  process.exit(1);
}
console.log('=== ALL MEDIA CHECKS PASS ===');
