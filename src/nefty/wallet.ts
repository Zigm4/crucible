/**
 * Every fungible token a wallet holds.
 *
 * The inventory could always tell you what NFTs you own, and the runner
 * could tell you a recipe wants 32 UPMAX, but nothing on the page could
 * answer "what tokens do I actually have". That is the other half of a
 * wallet, and on WAX it is where blend costs, upgrade fees and staking
 * rewards all land.
 *
 * There is no table you can read to get it. A token balance lives in
 * `<issuer>/accounts` scoped to the holder, so finding them all means
 * knowing every contract that ever sent you something. Only a history
 * indexer knows that, which is why this is the one screen in Crucible
 * that depends on Hyperion.
 *
 * Three rules follow from that dependency, all of them learned by being
 * wrong first:
 *
 *   1. ASK MORE THAN ONE. Public Hyperion hosts are routinely truncated.
 *      wax.cryptolions.io answers this exact query for zigm4.gm with 3
 *      tokens where the other hosts return 17, and it does not say it is
 *      short. So we take the UNION of every host that answers.
 *
 *   2. ASK FOR ALL OF IT. `/v2/state/get_tokens` defaults to 50 rows and
 *      says nothing about the rest: no total, no `more`, no `limit` in
 *      the response. fees.nefty returns 50 by default and 185 when paged.
 *      The first version of this file shipped without paging and would
 *      have shown a heavy wallet less than a third of its tokens under a
 *      footer claiming the list was confirmed. So: page until a short
 *      page comes back, and say so when the page cap is reached anyway.
 *
 *   3. NEVER TRUST THE NUMBER. Hyperion returns `amount` as a JSON float,
 *      which quietly rounds an 8-decimal balance past 15 significant
 *      digits, and its state can lag the chain. So the indexer is used
 *      only to DISCOVER which contracts to look at; every figure shown is
 *      then read straight from that contract's own `accounts` table, as
 *      the exact string the chain stores.
 *
 * And one rule about failure: a read that fails is not a balance of zero
 * and not an absence. `unread` counts the issuers that could not be read,
 * so the screen can say the list is short instead of quietly presenting
 * it as complete.
 */
import { getTableRows } from '../chain/rpc';

/** Hosts that serve `/v2/state/get_tokens`. All four verified on WAX. */
const TOKEN_INDEXERS = [
  'https://wax.eosphere.io',
  'https://api.waxsweden.org',
  'https://wax.eosusa.io',
  'https://wax.eosdac.io',
];

const INDEXER_TIMEOUT_MS = 9_000;

/**
 * How long to keep waiting for the remaining indexers once two have
 * answered in full.
 *
 * A healthy host answers this query in 0.1 to 0.6 seconds; a dead one
 * burns the whole 9 second deadline, and waiting for it made "show me my
 * tokens" a ten second wait whenever any single public host was down
 * (api.waxsweden.org was, while this was being written). Six times the
 * slowest healthy host is long enough to collect a straggler and short
 * enough that one dead host costs a moment rather than the answer.
 */
const DISCOVERY_GRACE_MS = 3_500;

/** Rows per `get_tokens` request. 100 is the largest any host honours. */
const INDEXER_PAGE = 100;

/** Pages per host, so a broken `skip` cannot spin forever. 500 tokens. */
const MAX_PAGES = 5;

/** Read at most this many issuers. A spam-airdropped wallet has hundreds. */
const MAX_CONTRACTS = 200;

/** How many contract reads run at once. Enough to be quick, few enough
 *  that a wallet with 200 tokens does not open 200 sockets at once. */
const CONCURRENCY = 6;

/**
 * Rows per `accounts` read. One issuer holding more than this many of
 * your balances is vanishingly rare, but it happens: tradestudios holds
 * 101 symbols for one account and tokenizednft holds 114. The first
 * version asked for 100 and would have cut both without a word.
 */
const ISSUER_ROWS = 1000;

/**
 * Contracts whose `supported_tokens` decides whether a NeftyBlocks recipe
 * is allowed to ask for a token. Three separate registries with two
 * different field names, which is why the badge was wrong before: a token
 * registered only with neftyblocksd was being called "not a recipe token".
 */
const REGISTRIES: { code: string; symKey: string; contractKey: string }[] = [
  { code: 'blend.nefty', symKey: 'sym', contractKey: 'contract' },
  { code: 'up.nefty', symKey: 'sym', contractKey: 'contract' },
  { code: 'neftyblocksd', symKey: 'token_symbol', contractKey: 'token_contract' },
];

export interface WalletToken {
  symbol: string;
  contract: string;
  /** Exactly as the chain stores it, e.g. "13368.20000000 UPMAX". */
  balance: string;
  /** Same figure, grouped and with trailing zeros trimmed, for reading. */
  display: string;
  /** For sorting and the is-it-empty test only. Never displayed. */
  amount: number;
  /** True when a NeftyBlocks contract registers this token. Never a
   *  claim that nothing accepts it: a WaxDAO blend can name any token. */
  usableInRecipes: boolean;
}

export interface WalletTokens {
  tokens: WalletToken[];
  /** How many indexers answered the discovery question. */
  sources: number;
  /** Of those, how many hit the page cap and may still be short. */
  cappedSources: number;
  /** Issuers found but not read, because of MAX_CONTRACTS. */
  skipped: number;
  /** Issuers whose own read failed. Their balances are missing entirely. */
  unread: number;
  /** Issuers that returned a full page, so their own list may be cut. */
  truncated: number;
  /** False when no registry could be read, so no badge can be trusted. */
  registryKnown: boolean;
  /** True when the list may be short, for any of the reasons above. */
  partial: boolean;
}

/**
 * "13368.20000000 UPMAX" -> "13,368.2"
 *
 * Trimming trailing zeros off a decimal string loses nothing, and 8 of
 * them in a row is the difference between a list you can scan and a
 * column of noise. The exact string stays on the row for anyone who
 * wants it. Nothing here rounds: every digit that is not a trailing zero
 * survives, however many there are.
 */
export function displayBalance(balance: string): string {
  const [amount = '0'] = String(balance).trim().split(/\s+/);
  const neg = amount.startsWith('-');
  const bare = neg ? amount.slice(1) : amount;
  const [whole = '0', frac = ''] = bare.split('.');
  const trimmed = frac.replace(/0+$/, '');
  const grouped = (whole || '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${trimmed ? `${grouped}.${trimmed}` : grouped}`;
}

/**
 * Every contract one indexer says has given this wallet a balance.
 *
 * Paged, because the endpoint's silent default of 50 is the difference
 * between a wallet's tokens and a third of them. A page shorter than the
 * one asked for is the end; hitting MAX_PAGES is reported so the caller
 * can say the answer may still be short rather than assuming it is not.
 */
async function discoverFrom(
  host: string, owner: string,
): Promise<{ contracts: string[]; capped: boolean }> {
  const contracts: string[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), INDEXER_TIMEOUT_MS);
    let rows: { contract?: string }[];
    try {
      const url = `${host}/v2/state/get_tokens?account=${encodeURIComponent(owner)}`
        + `&limit=${INDEXER_PAGE}&skip=${page * INDEXER_PAGE}`;
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error(`${host} answered ${res.status}`);
      const body = (await res.json()) as { tokens?: { contract?: string }[] };
      rows = body.tokens ?? [];
    } finally {
      clearTimeout(timer);
    }
    for (const t of rows) {
      const c = String(t.contract ?? '');
      if (c) contracts.push(c);
    }
    // A host that ignores `skip` would return the same first page forever.
    // A short page is the honest end of the list either way.
    if (rows.length < INDEXER_PAGE) return { contracts, capped: false };
  }
  return { contracts, capped: true };
}

/**
 * Asks every indexer at once and stops waiting for the stuck ones.
 *
 * The union still needs as many hosts as it can get, so nothing is
 * cancelled early on principle: the wait only ends once two hosts have
 * answered in full and the grace period has passed. Hosts that have not
 * answered by then are counted as not having answered, which is what the
 * screen says.
 */
async function discoverAll(
  owner: string,
): Promise<({ contracts: string[]; capped: boolean } | undefined)[]> {
  const answers: ({ contracts: string[]; capped: boolean } | undefined)[] =
    new Array(TOKEN_INDEXERS.length).fill(undefined);
  let ok = 0;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let releaseGrace = () => {};
  const grace = new Promise<void>((resolve) => { releaseGrace = resolve; });

  const tasks = TOKEN_INDEXERS.map((h, i) => discoverFrom(h, owner).then(
    (v) => {
      answers[i] = v;
      ok += 1;
      if (ok === 2 && !graceTimer) {
        graceTimer = setTimeout(releaseGrace, DISCOVERY_GRACE_MS);
      }
    },
    () => { /* a host that refuses is one source fewer, and it is counted */ },
  ));

  await Promise.race([Promise.all(tasks), grace]);
  if (graceTimer) clearTimeout(graceTimer);
  // Copied before the late arrivals can write into it, so what is
  // counted and what is used are the same list.
  return answers.slice();
}

/**
 * Every balance row this owner has on one issuer.
 *
 * Scope is the holder and the primary key is a symbol_code, not a name,
 * so we list the scope rather than trying to encode a ticker as a name
 * (which silently misses). One issuer can hold several of your balances;
 * all of them come back here, including any the indexers never mentioned.
 *
 * A failure is reported, not swallowed. Returning [] for a contract that
 * timed out would drop a real balance out of the list while the screen
 * went on saying every contract had been read.
 */
async function readIssuer(
  contract: string, owner: string,
): Promise<{ balances: string[]; failed: boolean; truncated: boolean }> {
  try {
    const rows = await getTableRows<{ balance: string }>({
      code: contract,
      scope: owner,
      table: 'accounts',
      limit: ISSUER_ROWS,
    });
    return {
      balances: rows.map((r) => String(r.balance ?? '').trim()).filter(Boolean),
      failed: false,
      truncated: rows.length >= ISSUER_ROWS,
    };
  } catch (err) {
    // A contract with no `accounts` table at all is not a failed read: it
    // is a contract that cannot hold a balance for you in the first
    // place. Two of the 156 issuers the indexers name for fees.nefty are
    // exactly this, and counting them as failures made the sheet warn
    // about two contracts that had nothing to give.
    const message = err instanceof Error ? err.message : String(err);
    if (/contract table query exception/i.test(message)) {
      return { balances: [], failed: false, truncated: false };
    }
    return { balances: [], failed: true, truncated: false };
  }
}

/** Runs `job` over `items`, at most `CONCURRENCY` at a time. */
async function pooled<T, R>(items: T[], job: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    for (;;) {
      const i = next; next += 1;
      if (i >= items.length) return;
      out[i] = await job(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Every `contract/TICKER` a NeftyBlocks contract is willing to be paid in.
 *
 * Read from all three registries at once. An empty set means none of them
 * answered, which the caller reports as "unknown" rather than as "no".
 */
async function loadRegistry(): Promise<Set<string>> {
  const reads = await Promise.allSettled(REGISTRIES.map(async (r) => {
    const rows = await getTableRows<Record<string, unknown>>({
      code: r.code, scope: r.code, table: 'config', limit: 1,
    });
    const list = (rows[0]?.supported_tokens ?? []) as Record<string, string>[];
    return list.map((t) => {
      const sym = String(t[r.symKey] ?? '');
      return `${String(t[r.contractKey] ?? '')}/${sym.split(',')[1] ?? sym}`;
    });
  }));
  const out = new Set<string>();
  for (const res of reads) {
    if (res.status === 'fulfilled') for (const k of res.value) out.add(k);
  }
  return out;
}

export async function listWalletTokens(owner: string): Promise<WalletTokens> {
  if (!owner) {
    return {
      tokens: [], sources: 0, cappedSources: 0, skipped: 0, unread: 0,
      truncated: 0, registryKnown: false, partial: false,
    };
  }

  const found = await discoverAll(owner);
  const answered = found.filter(Boolean) as { contracts: string[]; capped: boolean }[];
  const sources = answered.length;
  const cappedSources = answered.filter((a) => a.capped).length;

  const contracts = new Set<string>();
  for (const a of answered) for (const c of a.contracts) contracts.add(c);

  // eosio.token is read whatever else happens, and is never the one the
  // cap drops. Seeding it into the set and then slicing an alphabetically
  // sorted list would have let a wallet with 200 issuers named before
  // "eosio.token" lose its WAX row, which is the one row nobody would
  // believe was missing by accident.
  contracts.delete('eosio.token');
  const rest = [...contracts].sort();
  const take = ['eosio.token', ...rest.slice(0, MAX_CONTRACTS - 1)];
  const skipped = Math.max(0, rest.length - (MAX_CONTRACTS - 1));

  const [reads, registry] = await Promise.all([
    pooled(take, (c) => readIssuer(c, owner)),
    loadRegistry(),
  ]);
  const registryKnown = registry.size > 0;

  const tokens: WalletToken[] = [];
  let unread = 0;
  let truncated = 0;
  take.forEach((contract, i) => {
    const read = reads[i];
    if (read.failed) { unread += 1; return; }
    if (read.truncated) truncated += 1;
    for (const balance of read.balances) {
      const [amountText, symbol = ''] = balance.split(/\s+/);
      if (!symbol) continue;
      tokens.push({
        symbol,
        contract,
        balance,
        display: displayBalance(balance),
        amount: Number(amountText) || 0,
        usableInRecipes: registry.has(`${contract}/${symbol}`),
      });
    }
  });

  // The order somebody reads it in: what they can spend on a recipe
  // first, then everything else alphabetically, and empty balances last
  // because an empty balance is a row about nothing.
  tokens.sort((a, b) =>
    Number(b.amount > 0) - Number(a.amount > 0)
    || Number(b.usableInRecipes) - Number(a.usableInRecipes)
    || a.symbol.localeCompare(b.symbol)
    || a.contract.localeCompare(b.contract));

  return {
    tokens,
    sources,
    cappedSources,
    skipped,
    unread,
    truncated,
    registryKnown,
    partial: sources < TOKEN_INDEXERS.length || cappedSources > 0
      || skipped > 0 || unread > 0 || truncated > 0,
  };
}

/**
 * Narrows the list for the search box in the dialog.
 *
 * Matches the ticker AND the issuer, because on WAX a ticker is not
 * unique: two contracts can both issue "GOLD", and the issuer is the only
 * thing that tells them apart. Anyone who knows which one they mean knows
 * it by the contract name.
 */
export function filterWalletTokens(
  tokens: WalletToken[], q: string, showEmpty: boolean,
): WalletToken[] {
  const needle = q.trim().toLowerCase();
  return tokens.filter((t) => {
    if (!showEmpty && t.amount === 0) return false;
    if (!needle) return true;
    return t.symbol.toLowerCase().includes(needle)
      || t.contract.toLowerCase().includes(needle);
  });
}

/** How many rows the "show empty" toggle would add. */
export function emptyCount(tokens: WalletToken[]): number {
  return tokens.filter((t) => t.amount === 0).length;
}

/**
 * What the sheet says about how complete the list is.
 *
 * Built here rather than in the template because the first version said
 * "Not every indexer answered" whenever `partial` was true, including
 * when every indexer had answered and the real cause was the issuer cap.
 * Each cause names itself, or the sentence is left out.
 */
export function completenessNote(t: WalletTokens): string {
  if (t.sources === 0) {
    return 'No history indexer answered. This is only what eosio.token holds for you, and every other token is missing from the list.';
  }
  const gaps: string[] = [];
  const quiet = TOKEN_INDEXERS.length - t.sources;
  if (quiet > 0) {
    gaps.push(`${quiet} indexer${quiet === 1 ? '' : 's'} did not answer, so a token only ${quiet === 1 ? 'it' : 'they'} knew about is not here`);
  }
  if (t.cappedSources > 0) gaps.push('an indexer had more pages than were read');
  if (t.skipped > 0) {
    gaps.push(`${t.skipped} issuer${t.skipped === 1 ? '' : 's'} past the read limit ${t.skipped === 1 ? 'was' : 'were'} skipped`);
  }
  if (t.unread > 0) {
    gaps.push(`${t.unread} contract${t.unread === 1 ? '' : 's'} refused to be read`);
  }
  if (t.truncated > 0) {
    gaps.push(`${t.truncated} contract${t.truncated === 1 ? '' : 's'} held more balances than were read`);
  }
  if (!gaps.length) return '';
  return `${gaps.join('; ')}.`;
}

/** How the sheet describes what it just did. Never a claim beyond it. */
export function provenanceNote(t: WalletTokens): string {
  return `Read from ${t.sources} of ${TOKEN_INDEXERS.length} history indexers,`
    + ` then from each contract's own table.`;
}

export const INDEXER_COUNT = TOKEN_INDEXERS.length;
