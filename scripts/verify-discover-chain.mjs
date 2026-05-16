/**
 * End-to-end test of the on-chain discovery fallback.
 *
 * Mirrors src/nefty/discover.ts::fetchFromChain — finds the head of the
 * blends table, chunks [0, head] into parallel ranges, paginates each
 * range, filters by collection_name === underpunks55. Asserts that the
 * two known blends from our reference traces (#43444, #43802) appear in
 * the result.
 *
 * Run: node scripts/verify-discover-chain.mjs
 */

import { APIClient } from '@wharfkit/session';

const RPC = 'https://wax.eosphere.io';
const UNDERPUNKS = 'underpunks55';
const CHUNK_SIZE = 5000n;
const ROWS_PER_CALL = 1000;
const MAX_CHUNKS = 16;

const client = new APIClient({ url: RPC });

async function call(path, params) {
  return client.call({ path, params });
}

async function getHead() {
  const res = await call('/v1/chain/get_table_rows', {
    json: true,
    code: 'blend.nefty',
    scope: 'blend.nefty',
    table: 'blends',
    limit: 1,
    reverse: true,
  });
  return res.rows[0] ? BigInt(String(res.rows[0].blend_id)) + 1n : 60000n;
}

async function scanRange(from, to) {
  const out = [];
  let cursor = from;
  while (cursor < to) {
    const res = await call('/v1/chain/get_table_rows', {
      json: true,
      code: 'blend.nefty',
      scope: 'blend.nefty',
      table: 'blends',
      lower_bound: String(cursor),
      upper_bound: String(to),
      limit: ROWS_PER_CALL,
    });
    if (res.rows.length === 0) break;
    out.push(...res.rows);
    const last = BigInt(String(res.rows[res.rows.length - 1].blend_id));
    if (last + 1n <= cursor) break;
    cursor = last + 1n;
    if (res.rows.length < ROWS_PER_CALL) break;
  }
  return out;
}

const t0 = Date.now();
console.log(`1. head probe…`);
const head = await getHead();
console.log(`   max blend_id ≈ ${head - 1n} (head=${head})`);

const ranges = [];
for (let from = 0n; from < head && ranges.length < MAX_CHUNKS; from += CHUNK_SIZE) {
  ranges.push({ from, to: from + CHUNK_SIZE });
}
console.log(`2. scanning ${ranges.length} ranges in parallel…`);

let done = 0;
const allRows = [];
await Promise.all(
  ranges.map(async (r) => {
    const rows = await scanRange(r.from, r.to);
    allRows.push(...rows);
    done++;
    process.stdout.write(`\r   ${done}/${ranges.length} ranges done   `);
  }),
);
console.log();

const matches = allRows.filter((r) => r.collection_name === UNDERPUNKS);
console.log(`3. ${allRows.length} total rows scanned, ${matches.length} match collection=${UNDERPUNKS}`);
console.log(`   total time: ${((Date.now() - t0) / 1000).toFixed(2)}s`);

const has43444 = matches.find((b) => String(b.blend_id) === '43444');
const has43802 = matches.find((b) => String(b.blend_id) === '43802');

console.log(`\n4. cross-check known blends from our reference traces:`);
console.log(`   blend 43444 found: ${has43444 ? '✓' : '✗'}` + (has43444 ? ` (use_count=${has43444.use_count}/${has43444.max})` : ''));
console.log(`   blend 43802 found: ${has43802 ? '✓' : '✗'}` + (has43802 ? ` (use_count=${has43802.use_count}/${has43802.max})` : ''));

if (matches.length > 0) {
  console.log(`\n5. preview of first 5 matched blends:`);
  for (const b of matches.slice(0, 5)) {
    let name = `Blend #${b.blend_id}`;
    try {
      const dd = b.display_data ? JSON.parse(b.display_data) : {};
      if (dd?.name) name = dd.name;
    } catch {}
    console.log(`   - [${b.blend_id}] ${name}  used ${b.use_count}/${b.max}  hidden=${!!b.is_hidden}`);
  }
}

process.exit(has43444 && has43802 ? 0 : 1);
