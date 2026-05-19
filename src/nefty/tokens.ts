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
 * Checks if `owner` has already called openbal for `symbol` ("8,UPMAX").
 * If yes: calling openbal again would fail (RAM already allocated). We use
 * this to conditionally inject openbal only when needed.
 */
export async function hasOpenBalance(args: {
  owner: string;
  symbol: string;
}): Promise<boolean> {
  const rows = await getTableRows<ExtBalanceRow>({
    code: 'blend.nefty',
    scope: 'blend.nefty',
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

export function parseAssetAmount(quantity: string): number {
  return Number(quantity.trim().split(/\s+/)[0]) || 0;
}
