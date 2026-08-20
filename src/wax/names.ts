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
 *   high_bid < 0   the auction is CLOSED. `high_bidder` won it and may now
 *                  claim it, and the absolute value is the winning bid.
 *                  The account does NOT exist yet: the row survives until
 *                  the winner calls `newaccount`, which erases it. `13`
 *                  was won in 2022 and is still sitting there unclaimed.
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
  /**
   * The auction closed and this bidder may now create the account. The
   * name does NOT exist yet: the row survives until someone calls
   * `newaccount`, which is what erases it. Names sit here for years.
   */
  | { kind: 'won'; bid: NameBid; mine: boolean }
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
export async function readNameStatus(raw: string, forActor = ''): Promise<NameAvailability> {
  const check = biddableName(raw);
  if (!check.ok) return { kind: 'not_biddable', why: check.why };
  const name = check.name;

  const [bid, account] = await Promise.all([
    readNameBid(name).catch(() => undefined),
    getAccount(name).then((a) => a, () => undefined),
  ]);

  if (bid?.closed && !account) return { kind: 'won', bid, mine: bid.high_bidder === forActor };
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
 * Can this account outbid the standing bid?
 *
 * The system contract refuses a bid from whoever already holds the top
 * one: `check(high_bidder != bidder, "account is already highest bidder")`.
 * Confirmed against 496 consecutive bid pairs on chain, of which exactly
 * zero repeat the same bidder. Raising your own bid is not a thing, so
 * offering the button is offering a transaction that will fail.
 */
export function canOutbid(bid: NameBid | undefined, actor: string): boolean {
  if (!bid || bid.closed) return true;
  return bid.high_bidder !== actor;
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

export interface PendingRefund {
  newname: string;
  amount: string;
  wax: number;
}

/**
 * Refunds this account can claim, one name at a time.
 *
 * The scope is the NAME being bid on and the primary key is the BIDDER,
 * which is the reverse of the obvious reading. Scoping by the bidder, as
 * this module first did, returns an empty list for everyone, forever: the
 * refund panel could never have shown a real row. Meanwhile `rekt` alone
 * holds two unclaimed refunds today.
 *
 * There is no index from an account to the names it is owed on, so the
 * caller supplies the names, normally from that account's bid history.
 */
export async function readRefundsFor(
  bidder: string,
  names: string[],
): Promise<PendingRefund[]> {
  const unique = [...new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean))];
  const found = await Promise.all(unique.map(async (newname) => {
    try {
      const rows = await getTableRows<{ bidder: string; amount: string }>({
        code: SYSTEM, scope: newname, table: 'bidrefunds', limit: 50,
      });
      const mine = rows.find((r) => r.bidder === bidder);
      if (!mine) return undefined;
      return { newname, amount: mine.amount, wax: Number(String(mine.amount).split(' ')[0]) };
    } catch {
      return undefined;
    }
  }));
  return found.filter((r): r is PendingRefund => Boolean(r));
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

// ─── claiming a name you won ────────────────────────────────────────────

/**
 * Winning is not receiving. The auction closing only flips `high_bid`
 * negative; the account still has to be created, by the winner, with
 * `eosio::newaccount`. That call is what erases the bid row.
 *
 * Nobody does it for you and nothing expires, which is why names sit won
 * and unclaimed for years: `13` since 2022, `133` since 2020.
 *
 * A real claim is three actions in one transaction, taken from
 * `croplandgame` claiming `croplands` on 2026-08-19:
 *
 *   eosio::newaccount    the account and its two permissions
 *   eosio::buyrambytes   it owns no RAM, so the winner pays for its rows
 *   eosio::delegatebw    a little CPU and NET so it can act at all
 *
 * All three are needed. `newaccount` alone leaves an account that cannot
 * hold anything or sign anything.
 */

/** An EOSIO permission: one key, weight 1, threshold 1. The common shape. */
function singleKeyAuthority(key: string) {
  return { threshold: 1, keys: [{ key, weight: 1 }], accounts: [], waits: [] };
}

export interface ClaimNameArgs {
  /** The winner, who pays for everything. */
  creator: string;
  /** The name won at auction. */
  newname: string;
  ownerKey: string;
  activeKey: string;
  /** Rows cost RAM. 4096 is comfortable for an account that will hold NFTs. */
  ramBytes?: number;
  /** Staked, not spent: it can be unstaked later. */
  stakeNetWax?: number;
  stakeCpuWax?: number;
}

/**
 * The three actions, in the order the chain needs them: the account must
 * exist before anyone can buy RAM for it or stake to it.
 */
export function buildClaimName(a: ClaimNameArgs): BuiltAction[] {
  const auth = [{ actor: a.creator, permission: 'active' }];
  const ram = a.ramBytes ?? 4096;
  const net = a.stakeNetWax ?? 0.1;
  const cpu = a.stakeCpuWax ?? 0.9;
  return [
    {
      account: SYSTEM,
      name: 'newaccount',
      authorization: auth,
      data: {
        creator: a.creator,
        name: a.newname,
        owner: singleKeyAuthority(a.ownerKey),
        active: singleKeyAuthority(a.activeKey),
      },
    },
    {
      account: SYSTEM,
      name: 'buyrambytes',
      authorization: auth,
      data: { payer: a.creator, receiver: a.newname, bytes: ram },
    },
    {
      account: SYSTEM,
      name: 'delegatebw',
      authorization: auth,
      data: {
        from: a.creator,
        receiver: a.newname,
        stake_net_quantity: formatWax(net),
        stake_cpu_quantity: formatWax(cpu),
        transfer: false,
      },
    },
  ];
}

/**
 * The public keys already on an account, to offer as the default for a
 * name it just won. Most people want the new name to answer to the same
 * keys as the wallet that won it, and typing a key by hand is the step
 * where a name gets locked away forever.
 */
export async function readAccountKeys(
  actor: string,
): Promise<{ owner?: string; active?: string }> {
  try {
    const acc = await getAccount(actor);
    const out: { owner?: string; active?: string } = {};
    // WharfKit hands back typed objects, not the raw JSON: `perm_name` is a
    // Name and `key` is a PublicKey. Comparing them to strings silently
    // never matches, which left both fields blank with no error anywhere.
    for (const p of (acc as unknown as {
      permissions?: { perm_name: unknown; required_auth?: { keys?: { key: unknown }[] } }[];
    }).permissions ?? []) {
      const raw = p.required_auth?.keys?.[0]?.key;
      if (raw === undefined || raw === null) continue;
      const key = String(raw);
      const perm = String(p.perm_name);
      if (perm === 'owner') out.owner = key;
      if (perm === 'active') out.active = key;
    }
    return out;
  } catch {
    return {};
  }
}
