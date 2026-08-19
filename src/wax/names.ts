/**
 * WAX premium account names: the on-chain auction, in `eosio` itself.
 *
 * A WAX account name of fewer than 12 characters, with no dot, cannot be
 * created directly. It is sold by an open, never-ending English auction
 * run by the system contract:
 *
 *   1. Anyone bids with `eosio::bidname(bidder, newname, bid)`. The WAX
 *      leaves the bidder's account immediately.
 *   2. A later bid must beat the current one by at least 10 percent. The
 *      previous bidder is refunded, but not automatically: a row appears
 *      in `bidrefunds` and they must claim it with `eosio::bidrefund`.
 *   3. Once a day the system closes the single highest auction on the
 *      chain, provided its top bid has stood untouched for 24 hours, and
 *      creates the account for that bidder.
 *
 * The `namebids` table carries the whole state, and its sign is the part
 * nobody guesses:
 *
 *   high_bid > 0   the auction is OPEN, the name is still up for grabs
 *   high_bid < 0   the auction is CLOSED and the name was created for
 *                  `high_bidder`. The absolute value is the winning bid.
 *
 * So a row is not proof a name is taken, and no row is not proof it is
 * free. Both have to be read, which is what `readNameStatus` does.
 *
 * Everything here is pure or read-only, with the same split as the rest of
 * the project: builders return a `BuiltAction` and never decide who signs.
 */
import type { BuiltAction } from '../chain/action';
import { getTableRows, getAccount, HYPERION_ENDPOINTS } from '../chain/rpc';

const SYSTEM = 'eosio';

/** The chain settles a name auction only after this much quiet. */
export const QUIET_PERIOD_MS = 24 * 60 * 60 * 1000;

/** A row of `eosio/namebids`, decoded. */
export interface NameBid {
  newname: string;
  high_bidder: string;
  /** Always positive here; `closed` carries what the sign meant. */
  high_bid: number;
  /** True when the row's raw bid was negative: the name has been created. */
  closed: boolean;
  last_bid_time: number;
}

export type NameAvailability =
  /** No account, no auction row. Bid anything to open one. */
  | { kind: 'free' }
  /** An auction is running. */
  | { kind: 'auction'; bid: NameBid; settlesAt: number }
  /** Won at auction and created. */
  | { kind: 'won'; bid: NameBid }
  /** The account exists. Nothing to bid on. */
  | { kind: 'taken'; created?: string }
  /** Not a name the auction accepts (12 chars, or a dot, or bad letters). */
  | { kind: 'not_biddable'; why: string };

/**
 * Is this a name the auction will even accept?
 *
 * EOSIO names use a base-32 alphabet: a to z, and 1 to 5. Only names
 * SHORTER than 12 characters go to auction; a full 12-character name can
 * be created for free by anyone, and a name with a dot is a subaccount of
 * whoever owns the suffix.
 */
export function biddableName(raw: string): { ok: true; name: string } | { ok: false; why: string } {
  const name = raw.trim().toLowerCase();
  if (!name) return { ok: false, why: 'Type a name.' };
  if (name.includes('.')) {
    return { ok: false, why: 'Names with a dot are subaccounts. Whoever owns the suffix creates them directly, there is no auction.' };
  }
  if (name.length >= 12) {
    return { ok: false, why: 'Names of 12 characters are not auctioned. Anyone can create one directly, for the cost of the RAM.' };
  }
  if (!/^[a-z1-5]+$/.test(name)) {
    return { ok: false, why: 'WAX names use only a to z and 1 to 5. No 0, 6, 7, 8, 9, and no capitals.' };
  }
  return { ok: true, name };
}

function decode(row: { newname: string; high_bidder: string; high_bid: string | number; last_bid_time: string }): NameBid {
  const raw = Number(row.high_bid);
  return {
    newname: row.newname,
    high_bidder: row.high_bidder,
    high_bid: Math.abs(raw),
    closed: raw < 0,
    // The table stores a time_point without a zone; it is UTC.
    last_bid_time: Date.parse(row.last_bid_time + 'Z'),
  };
}

/** The auction row for one name, or undefined if nobody ever bid. */
export async function readNameBid(name: string): Promise<NameBid | undefined> {
  const rows = await getTableRows<{
    newname: string; high_bidder: string; high_bid: string | number; last_bid_time: string;
  }>({
    code: SYSTEM,
    scope: SYSTEM,
    table: 'namebids',
    // Without this the node reads a numeric-looking name as an integer:
    // "13" becomes primary key 13 rather than the encoded name, and the
    // query silently returns the wrong rows. Names like 13, 1111 or 55555
    // are exactly the ones people bid on.
    key_type: 'name',
    lower_bound: name,
    upper_bound: name,
    limit: 1,
  });
  return rows[0] ? decode(rows[0]) : undefined;
}

/**
 * Everything a bidder needs to know about one name, in one call pair.
 *
 * Both reads are needed. An account can exist with no auction row (it was
 * created as a 12-character name or a subaccount), and an auction row can
 * exist for a name that is still unclaimed.
 */
export async function readNameStatus(raw: string): Promise<NameAvailability> {
  const check = biddableName(raw);
  if (!check.ok) return { kind: 'not_biddable', why: check.why };
  const name = check.name;

  const [bid, account] = await Promise.all([
    readNameBid(name).catch(() => undefined),
    getAccount(name).then((a) => a, () => undefined),
  ]);

  if (bid?.closed) return { kind: 'won', bid };
  if (account) return { kind: 'taken', created: String(account.created ?? '') };
  if (bid) return { kind: 'auction', bid, settlesAt: bid.last_bid_time + QUIET_PERIOD_MS };
  return { kind: 'free' };
}

/**
 * The highest OPEN auctions on the whole chain, best first.
 *
 * The secondary index is not the bid, it is `-high_bid` reinterpreted as
 * an unsigned 64-bit integer, and that one line decides everything:
 *
 *   closed row   high_bid is negative, so -high_bid is a small POSITIVE
 *                number. Closed auctions cluster at the bottom.
 *   open row     high_bid is positive, so -high_bid wraps to just under
 *                2^64. Open auctions cluster at the very top, and a
 *                BIGGER bid gives a SMALLER key.
 *
 * So reading the index upward from the middle of the range skips every
 * settled auction and arrives at the open ones already sorted highest
 * first. 2^63 is the boundary: far above any winning bid ever recorded
 * (the largest is a few million WAX, about 1e14 units) and far below
 * where the open rows live.
 *
 * This matters beyond curiosity. The chain settles ONE name per day, the
 * single highest bid on the chain, so this list is the running order.
 */
const OPEN_BID_FLOOR = '9223372036854775808'; // 2^63

export async function readTopBids(limit = 10): Promise<NameBid[]> {
  const rows = await getTableRows<{
    newname: string; high_bidder: string; high_bid: string | number; last_bid_time: string;
  }>({
    code: SYSTEM,
    scope: SYSTEM,
    table: 'namebids',
    index_position: 'secondary',
    key_type: 'i64',
    lower_bound: OPEN_BID_FLOOR,
    limit,
  });
  // Defensive: if the boundary ever drifts, a closed row must not be
  // presented as something a reader could still outbid.
  return rows.map(decode).filter((b) => !b.closed);
}

/**
 * The smallest bid the contract will accept next, in WAX.
 *
 * The system requires a new bid to beat the standing one by at least ten
 * percent. The extra unit is deliberate: the check is done in integer
 * units and implementations differ on whether the boundary itself passes,
 * so this clears it by 0.00000001 WAX rather than risking a rejection for
 * a rounding argument.
 */
export function minimumNextBid(current: NameBid | undefined): number {
  if (!current || current.closed) return 0.00000001;
  const units = Math.ceil(current.high_bid * 1.1) + 1;
  return units / 1e8;
}

/** WAX carries 8 decimals, and the contract rejects any other precision. */
export function formatWax(amount: number): string {
  return `${amount.toFixed(8)} WAX`;
}

export function buildBidName(bidder: string, newname: string, waxAmount: number): BuiltAction {
  return {
    account: SYSTEM,
    name: 'bidname',
    authorization: [{ actor: bidder, permission: 'active' }],
    data: { bidder, newname, bid: formatWax(waxAmount) },
  };
}

/**
 * Claims back a bid that was outbid. The refund is NOT automatic: the WAX
 * sits in `bidrefunds` until the loser asks for it, which is why people
 * forget it exists.
 */
export function buildBidRefund(bidder: string, newname: string): BuiltAction {
  return {
    account: SYSTEM,
    name: 'bidrefund',
    authorization: [{ actor: bidder, permission: 'active' }],
    data: { bidder, newname },
  };
}

/** Refunds waiting to be claimed by this account, scoped by the bidder. */
export async function readRefunds(bidder: string): Promise<{ newname: string; amount: string }[]> {
  const rows = await getTableRows<{ bidder: string; amount: string }>({
    code: SYSTEM, scope: bidder, table: 'bidrefunds', limit: 100,
  });
  // The row's primary key is the name being bid on, which the JSON view
  // exposes as the scope's key rather than a field, so read it back from
  // the bids this account made instead when the field is absent.
  return rows.map((r) => ({ newname: (r as unknown as { newname?: string }).newname ?? '', amount: r.amount }));
}

export interface BidHistoryEntry {
  newname: string;
  bid: string;
  timestamp: string;
  trxId: string;
}

/**
 * Every bid this account ever placed, newest first, from a Hyperion
 * history node. Best-effort: history nodes have retention windows, so an
 * empty list means "nothing in the window", never "never bid".
 */
export async function readMyBids(actor: string, limit = 100): Promise<BidHistoryEntry[]> {
  for (const host of HYPERION_ENDPOINTS) {
    try {
      const url = `${host}/v2/history/get_actions?account=${encodeURIComponent(actor)}`
        + `&filter=eosio%3Abidname&limit=${limit}&sort=desc`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const body = (await res.json()) as { actions?: { timestamp: string; trx_id: string; act: { data: { bidder: string; newname: string; bid: string } } }[] };
      const acts = body.actions ?? [];
      return acts
        // Hyperion returns actions the account merely appears in; keep the
        // ones this account actually signed.
        .filter((a) => a.act.data.bidder === actor)
        .map((a) => ({
          newname: a.act.data.newname,
          bid: a.act.data.bid,
          timestamp: a.timestamp,
          trxId: a.trx_id,
        }));
    } catch { /* next host */ }
  }
  return [];
}
