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
 * Two rules follow from that dependency, both learned the hard way:
 *
 *   1. ASK MORE THAN ONE. Public Hyperion hosts are routinely truncated.
 *      wax.cryptolions.io answers this exact query for zigm4.gm with 3
 *      tokens where the other hosts return 17, and it does not say it is
 *      short. So we take the UNION of every host that answers, and one
 *      host missing a token can no longer hide it.
 *
 *   2. NEVER TRUST THE NUMBER. Hyperion returns `amount` as a JSON float,
 *      which quietly rounds an 8-decimal balance past 15 significant
 *      digits, and its state can lag the chain. So the indexer is used
 *      only to DISCOVER which contracts to look at; every figure shown is
 *      then read straight from that contract's own `accounts` table, as
 *      the exact string the chain stores.
 *
 * The result is a list that is correct where it matters and honest about
 * the rest: `partial` says an indexer did not answer, so the list may be
 * short.
 */
import { getTableRows } from '../chain/rpc';
import { loadConfig } from './tokens';

/** Hosts that serve `/v2/state/get_tokens`. All four verified on WAX. */
const TOKEN_INDEXERS = [
  'https://wax.eosphere.io',
  'https://api.waxsweden.org',
  'https://wax.eosusa.io',
  'https://wax.eosdac.io',
];

const INDEXER_TIMEOUT_MS = 9_000;

/** Read at most this many issuers. A spam-airdropped wallet has hundreds. */
const MAX_CONTRACTS = 150;

/** How many contract reads run at once. Enough to be quick, few enough
 *  that a wallet with 100 tokens does not open 100 sockets at once. */
const CONCURRENCY = 6;

export interface WalletToken {
  symbol: string;
  contract: string;
  /** Exactly as the chain stores it, e.g. "13368.20000000 UPMAX". */
  balance: string;
  /** Same figure, grouped and with trailing zeros trimmed, for reading. */
  display: string;
  /** For sorting and the is-it-empty test only. Never displayed. */
  amount: number;
  /** True when blend.nefty knows this token, so a recipe could ask for it. */
  usableInRecipes: boolean;
}

export interface WalletTokens {
  tokens: WalletToken[];
  /** How many indexers answered the discovery question. */
  sources: number;
  /** True when the list may be short: an indexer failed, or the cap hit. */
  partial: boolean;
  /** Issuers found but not read, because of the cap. */
  skipped: number;
}

/**
 * "13368.20000000 UPMAX" -> "13,368.2"
 *
 * Trimming trailing zeros off a decimal string loses nothing, and 8 of
 * them in a row is the difference between a list you can scan and a
 * column of noise. The exact string stays on the row for anyone who
 * wants it.
 */
export function displayBalance(balance: string): string {
  const [amount = '0'] = String(balance).trim().split(/\s+/);
  const [whole, frac = ''] = amount.split('.');
  const trimmed = frac.replace(/0+$/, '');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return trimmed ? `${grouped}.${trimmed}` : grouped;
}

/** Ask one indexer which contracts have ever given this wallet a balance. */
async function discoverFrom(host: string, owner: string): Promise<string[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), INDEXER_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${host}/v2/state/get_tokens?account=${encodeURIComponent(owner)}`,
      { signal: ctl.signal },
    );
    if (!res.ok) throw new Error(`${host} answered ${res.status}`);
    const body = (await res.json()) as { tokens?: { contract?: string }[] };
    return (body.tokens ?? []).map((t) => String(t.contract ?? '')).filter(Boolean);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every balance row this owner has on one issuer.
 *
 * Scope is the holder and the primary key is a symbol_code, not a name,
 * so we list the scope rather than trying to encode a ticker as a name
 * (which silently misses). One issuer can hold several of your balances;
 * all of them come back here, including any the indexers never mentioned.
 */
async function readIssuer(contract: string, owner: string): Promise<string[]> {
  try {
    const rows = await getTableRows<{ balance: string }>({
      code: contract,
      scope: owner,
      table: 'accounts',
      limit: 100,
    });
    return rows.map((r) => String(r.balance ?? '').trim()).filter(Boolean);
  } catch {
    return [];
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

export async function listWalletTokens(owner: string): Promise<WalletTokens> {
  if (!owner) return { tokens: [], sources: 0, partial: false, skipped: 0 };

  const found = await Promise.allSettled(
    TOKEN_INDEXERS.map((h) => discoverFrom(h, owner)),
  );
  const sources = found.filter((r) => r.status === 'fulfilled').length;

  // eosio.token is always worth reading: WAX is the token every wallet
  // has, and this way the list is never empty just because no indexer
  // answered.
  const contracts = new Set<string>(['eosio.token']);
  for (const r of found) {
    if (r.status === 'fulfilled') for (const c of r.value) contracts.add(c);
  }

  const all = [...contracts].sort();
  const take = all.slice(0, MAX_CONTRACTS);
  const skipped = all.length - take.length;

  const [balances, cfg] = await Promise.all([
    pooled(take, (c) => readIssuer(c, owner)),
    loadConfig().catch(() => undefined),
  ]);
  const registered = new Set(
    (cfg?.supported_tokens ?? []).map((t) => `${t.contract}/${t.sym.split(',')[1] ?? ''}`),
  );

  const tokens: WalletToken[] = [];
  take.forEach((contract, i) => {
    for (const balance of balances[i]) {
      const [amountText, symbol = ''] = balance.split(/\s+/);
      if (!symbol) continue;
      tokens.push({
        symbol,
        contract,
        balance,
        display: displayBalance(balance),
        amount: Number(amountText) || 0,
        usableInRecipes: registered.has(`${contract}/${symbol}`),
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
    partial: sources < TOKEN_INDEXERS.length || skipped > 0,
    skipped,
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
