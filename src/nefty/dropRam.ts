/**
 * The RAM a drop mints from.
 * ─────────────────────────────────────────────────────────────
 * neftyblocksd pays for every NFT a claim mints out of RAM the drop's
 * collection deposited with it (`rambalances`: bytes, per collection). With
 * none left, every claim is refused whoever claims ("The collection does
 * not have enough RAM to mint the assets"), and nothing on either page said
 * so before signing. Settled on 2026-10-24, by simulation on pearlhorizon's
 * drop #239019 and from the RAM real claims consumed:
 *
 *   - a minted NFT takes 135 to 151 bytes (286 for a claim minting two).
 *     A pool draw transfers an NFT that already exists and takes none.
 *   - anyone can deposit for a collection: a WAX transfer to neftyblocksd
 *     with the memo `deposit_collection_ram:<collection>`. The contract buys
 *     the RAM and credits its bytes. A collection's first deposit must buy
 *     at least 128 bytes, its own row ("Must increase the collection ram
 *     balance by at least 128 to pay for the table entry").
 *   - only the collection's authors take it back (`withdrawram`).
 *   - only claims of the collection's own drops spend it, each within its
 *     drop's supply, per-wallet limit and gate.
 */
import type { BuiltAction } from '../chain/action';
import { getTableRows } from '../chain/rpc';

/** What one minted NFT takes, at the top of what real claims used. */
export const BYTES_PER_MINT = 151;
/** A collection's first deposit pays for its own row. */
export const FIRST_DEPOSIT_BYTES = 128;

/** The collection's bytes on neftyblocksd; 0 with no row; undefined when unreadable. */
export async function readDropRam(collection: string): Promise<{ bytes: number; hasRow: boolean }> {
  const rows = await getTableRows<{ collection_name: string; byte_balance: number | string }>({
    code: 'neftyblocksd', scope: 'neftyblocksd', table: 'rambalances',
    lower_bound: collection, upper_bound: collection, limit: 1,
  });
  const row = rows.find((r) => String(r.collection_name) === collection);
  return { bytes: row ? Number(row.byte_balance) : 0, hasRow: Boolean(row) };
}

/** Bytes one claim needs: only what it mints, not what it draws from a pool. */
export function bytesPerClaim(assets: { use_pool?: boolean | number }[]): number {
  return assets.filter((a) => !Number(a.use_pool ?? 0)).length * BYTES_PER_MINT;
}

/** About how many bytes 1 WAX buys today, from the system RAM market. */
export async function bytesPerWax(): Promise<number> {
  const [m] = await getTableRows<{ base: { balance: string }; quote: { balance: string } }>({
    code: 'eosio', scope: 'eosio', table: 'rammarket', limit: 1,
  });
  const base = parseFloat(m?.base.balance ?? '0');
  const quote = parseFloat(m?.quote.balance ?? '0');
  // Bancor price, less the 0.5% the system takes on a purchase.
  return quote > 0 ? (base / quote) * 0.995 : 0;
}

/** "1.5" -> "1.50000000 WAX", or '' when it is not a positive amount with at most 8 decimals. */
export function waxAmount(text: string): string {
  const t = text.trim();
  if (!/^\d+(\.\d{1,8})?$/.test(t) || !(Number(t) > 0)) return '';
  const [i, f = ''] = t.split('.');
  return `${i}.${f.padEnd(8, '0')} WAX`;
}

/** A deposit for `collection`: the contract buys the RAM and credits it to the collection. */
export function buildRamDeposit(actor: string, collection: string, quantity: string): BuiltAction {
  return {
    account: 'eosio.token', name: 'transfer',
    authorization: [{ actor, permission: 'active' }],
    data: { from: actor, to: 'neftyblocksd', quantity, memo: `deposit_collection_ram:${collection}` },
  };
}
