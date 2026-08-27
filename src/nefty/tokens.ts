/**
 * Token registry + balance utilities.
 *
 * `blend.nefty/config` carries a list of `extended_symbol` entries that
 * map a `precision,TICKER` symbol to the contract that issues that token.
 * 159 tokens are registered at the time of writing, including WAX (on
 * eosio.token), NEFTY, GUILD, UPMAX, ...
 *
 * Exposes:
 *   - resolveTokenContract(quantity)  - "105.00000000 UPMAX" -> "underpunks55"
 *   - readTokenBalance({ owner, contract, symbolCode })
 *   - hasOpenBalance({ owner, symbol }) - used to decide whether to inject
 *     an `openbal` action before paying with a never-deposited token
 *   - tickerFromQuantity / symbolFromQuantity / parseAssetAmount helpers
 */
import { getTableRows } from '../chain/rpc';

export interface ExtendedSymbol {
  sym: string; // "8,UPMAX"
  contract: string; // "underpunks55"
}

export interface BlendConfig {
  supported_tokens: ExtendedSymbol[];
  fee: number;
  fee_recipient: string;
  supported_result_tokens?: ExtendedSymbol[];
  allow_all_tokens?: boolean;
}

let cachedConfig: BlendConfig | undefined;

export async function loadConfig(): Promise<BlendConfig> {
  if (cachedConfig) return cachedConfig;
  const rows = await getTableRows<BlendConfig>({
    code: 'blend.nefty',
    scope: 'blend.nefty',
    table: 'config',
    limit: 1,
  });
  if (rows.length === 0) throw new Error('Could not read blend.nefty config');
  cachedConfig = rows[0];
  return cachedConfig;
}

/**
 * `quantity` is an Antelope asset string like "105.00000000 UPMAX".
 * Extract the symbol with precision ("8,UPMAX") as used by openbal.
 */
export function symbolFromQuantity(quantity: string): string {
  const parts = quantity.trim().split(/\s+/);
  if (parts.length !== 2) throw new Error(`Invalid asset string: "${quantity}"`);
  const [amount, ticker] = parts;
  const dot = amount.indexOf('.');
  const precision = dot === -1 ? 0 : amount.length - dot - 1;
  return `${precision},${ticker}`;
}

export function tickerFromQuantity(quantity: string): string {
  return quantity.trim().split(/\s+/)[1] ?? '';
}

export async function resolveTokenContract(quantity: string): Promise<string> {
  const cfg = await loadConfig();
  const wantSym = symbolFromQuantity(quantity);
  const found = cfg.supported_tokens.find((t) => t.sym === wantSym);
  if (!found) {
    throw new Error(
      `Token ${wantSym} is not in blend.nefty's supported_tokens registry. Blend creator likely used an unregistered token, manual fallback required.`,
    );
  }
  return found.contract;
}

interface ExtBalanceRow {
  owner: string;
  quantities: { quantity: string; contract: string }[];
}

/**
 * Checks if `owner` has already called openbal for `symbol` ("8,UPMAX")
 * on `contract`. If yes: calling openbal again would fail (RAM already
 * allocated). We use this to conditionally inject openbal only when
 * needed.
 *
 * Default contract is `blend.nefty` for backward compatibility, but the
 * same `extbalances` table layout is used by `up.nefty` and every other
 * NeftyBlocks contract that lets users pre-deposit a token symbol.
 */
export async function hasOpenBalance(args: {
  owner: string;
  symbol: string;
  contract?: string;
}): Promise<boolean> {
  const contract = args.contract ?? 'blend.nefty';
  const rows = await getTableRows<ExtBalanceRow>({
    code: contract,
    scope: contract,
    table: 'extbalances',
    lower_bound: args.owner,
    upper_bound: args.owner,
    key_type: 'name',
    limit: 1,
  });
  if (rows.length === 0) return false;
  const ticker = args.symbol.split(',')[1];
  return rows[0].quantities.some((q) => q.quantity.endsWith(` ${ticker}`));
}

/**
 * Reads the user's balance of `symbolCode` on its issuing contract via the
 * standard eosio.token `accounts` table. Scope = owner; the primary key is a
 * `symbol_code` (NOT a `name`), so encoding "UPMAX" as a name silently misses.
 * We sidestep the encoding entirely: list all balance rows for this scope
 * (always tiny, one row per token the account ever held) and pick the match.
 * Returns the amount as a number in human units (e.g. 13378.2).
 */
export async function readTokenBalance(args: {
  owner: string;
  contract: string;
  symbolCode: string; // e.g. "UPMAX"
}): Promise<number> {
  try {
    const rows = await getTableRows<{ balance: string }>({
      code: args.contract,
      scope: args.owner,
      table: 'accounts',
      limit: 100,
    });
    const suffix = ` ${args.symbolCode}`;
    const row = rows.find((r) => r.balance.trim().endsWith(suffix));
    if (!row) return 0;
    return Number(row.balance.trim().split(/\s+/)[0]) || 0;
  } catch {
    return 0;
  }
}

/**
 * The exact balance string, or a clear answer about why there is none.
 *
 * `readTokenBalance` above returns 0 both for "you hold none" and for
 * "the read failed", which is how the run screen came to tell somebody
 * holding 500 UPMAX that they had 0 and could not afford a 10 UPMAX
 * blend. Three outcomes, so a caller can tell them apart:
 *
 *   string    - the exact asset string the contract stores
 *   null      - the contract answered and there is no row: a true zero
 *   undefined - the read failed and nothing is known
 */
export async function readTokenBalanceRaw(args: {
  owner: string;
  contract: string;
  symbolCode: string;
}): Promise<string | null | undefined> {
  try {
    const rows = await getTableRows<{ balance: string }>({
      code: args.contract,
      scope: args.owner,
      table: 'accounts',
      limit: 1000,
    });
    const suffix = ` ${args.symbolCode}`;
    const row = rows.find((r) => String(r.balance ?? '').trim().endsWith(suffix));
    return row ? String(row.balance).trim() : null;
  } catch (err) {
    // A contract with no `accounts` table cannot hold a balance for you,
    // which is a true zero rather than a failure.
    const message = err instanceof Error ? err.message : String(err);
    if (/contract table query exception/i.test(message)) return null;
    return undefined;
  }
}

/**
 * An asset string as an integer count of its smallest unit.
 *
 * Comparing "31.99999999 UPMAX" against "32.00000000 UPMAX" as floats is
 * the kind of thing that decides whether somebody is told they can afford
 * a blend, so it is done on integers. Returns undefined for anything that
 * is not an asset string rather than guessing a number out of it.
 */
export function minorUnits(quantity: string): { units: bigint; precision: number } | undefined {
  const parts = String(quantity).trim().split(/\s+/);
  if (parts.length !== 2) return undefined;
  const [amount] = parts;
  if (!/^-?[0-9]+(\.[0-9]+)?$/.test(amount)) return undefined;
  const neg = amount.startsWith('-');
  const bare = neg ? amount.slice(1) : amount;
  const [whole, frac = ''] = bare.split('.');
  const units = BigInt(whole + frac) * (neg ? -1n : 1n);
  return { units, precision: frac.length };
}

/** True when `have` covers `need`, compared as integers at one scale. */
export function covers(have: string, need: string): boolean | undefined {
  const h = minorUnits(have);
  const n = minorUnits(need);
  if (!h || !n) return undefined;
  const scale = Math.max(h.precision, n.precision);
  const lift = (v: { units: bigint; precision: number }) =>
    v.units * 10n ** BigInt(scale - v.precision);
  return lift(h) >= lift(n);
}

export function parseAssetAmount(quantity: string): number {
  return Number(quantity.trim().split(/\s+/)[0]) || 0;
}
