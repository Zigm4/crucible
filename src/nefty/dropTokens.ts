/**
 * Which tokens a drop may be priced in.
 *
 * `neftyblocksd/config` carries its OWN `supported_tokens` list, and it is
 * not the same list as `blend.nefty`'s: 162 entries against 159, with
 * different members. Pricing a drop in a token the drop contract does not
 * know is rejected on chain, so this is the list that matters here.
 *
 * Each entry pairs a contract with a `precision,TICKER` symbol, which is
 * why an author never has to type the number of decimals: it is already in
 * the symbol. Typing 8 for a 4-decimal token is a silent factor of 10,000
 * that the contract accepts without complaint.
 */
import { getTableRows } from '../chain/rpc';

const DROPS = 'neftyblocksd';

export interface DropToken {
  /** e.g. "DUST" */
  ticker: string;
  /** e.g. 4 */
  precision: number;
  /** e.g. "niftywizards" */
  contract: string;
  /** The raw `precision,TICKER` form the contract stores. */
  symbol: string;
}

interface ConfigRow {
  supported_tokens?: { token_contract: string; token_symbol: string }[];
}

let cache: { at: number; data: DropToken[] } | null = null;
const TTL_MS = 10 * 60_000;

/**
 * The tokens `neftyblocksd` accepts, newest config read cached for ten
 * minutes. Returns [] rather than throwing: a drop can always be free, so
 * an unreachable node should not block the whole form.
 */
export async function listDropTokens(): Promise<DropToken[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  try {
    const rows = await getTableRows<ConfigRow>({
      code: DROPS,
      scope: DROPS,
      table: 'config',
      limit: 1,
    });
    const raw = rows[0]?.supported_tokens ?? [];
    const data = raw
      .map((t) => {
        const [prec, ticker] = String(t.token_symbol).split(',');
        return {
          ticker: (ticker ?? '').trim(),
          precision: Number(prec),
          contract: t.token_contract,
          symbol: t.token_symbol,
        };
      })
      .filter((t) => t.ticker && Number.isFinite(t.precision));
    // WAX first, then alphabetical: the common case should not need a search.
    data.sort((a, b) =>
      a.ticker === 'WAX' ? -1 : b.ticker === 'WAX' ? 1 : a.ticker.localeCompare(b.ticker),
    );
    cache = { at: Date.now(), data };
    return data;
  } catch {
    return [];
  }
}

export function clearDropTokensCache() {
  cache = null;
}
