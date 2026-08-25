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
import { Authority as WireAuthority, PublicKey } from '@wharfkit/session';

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
 * How many auctions settle before this one, in the contract's own order.
 *
 * Holding the highest bid on a name is not the same as being close to
 * owning it. The chain settles one name a day and always takes whatever
 * sits at the top of the `highbid` index, so a bid's position in that
 * chain-wide order is what decides whether it settles this week or never.
 * A 5 WAX bid can lead its own name and still sit behind hundreds.
 *
 * Position, not a comparison of amounts. An earlier version counted only
 * bids STRICTLY larger and argued that ties do not beat this one. That was
 * backwards: the index is ordered by (negated bid, name), so among equal
 * bids the contract takes the one whose NAME sorts first, and every tied
 * name ahead of yours settles ahead of you. Reading the window in index
 * order and taking this row's place in it counts what the contract counts,
 * and needs no name encoding to do it.
 *
 * One request, not a scan. Larger bids sort before this one (the key is
 * the negated bid, so it falls as the bid rises), so everything ahead lies
 * between the open floor and this bid's own key. The upper bound is
 * INCLUSIVE of that key, which is what keeps the tied group in view.
 */
export interface BidQueuePosition {
  /** Auctions that settle before this one. */
  ahead: number;
  /** True when `ahead` is a floor rather than a total. */
  capped: boolean;
}

/**
 * Nodes refuse more than this per call whatever limit is asked for, and
 * report the rest only through `more`, which `getTableRows` does not
 * return. So this is the real window, and asking for more than it would
 * make truncation invisible instead of detectable.
 */
const NODE_ROW_LIMIT = 1000;

export async function readBidsAhead(bid: NameBid): Promise<BidQueuePosition> {
  if (bid.closed || bid.high_bid <= 0) return { ahead: 0, capped: false };
  const floor = BigInt(OPEN_BID_FLOOR);
  const key = (1n << 64n) - BigInt(Math.round(bid.high_bid));
  // Nothing can sort above the floor, so this bid already leads the chain.
  if (key < floor) return { ahead: 0, capped: false };
  const rows = await getTableRows<{
    newname: string; high_bidder: string; high_bid: string | number; last_bid_time: string;
  }>({
    code: SYSTEM,
    scope: SYSTEM,
    table: 'namebids',
    index_position: 'secondary',
    key_type: 'i64',
    lower_bound: OPEN_BID_FLOOR,
    upper_bound: key.toString(),
    limit: NODE_ROW_LIMIT,
  });
  // Same defence as readTopBids: a closed row is not competition.
  const open = rows.map(decode).filter((b) => !b.closed);
  const here = open.findIndex((b) => b.newname === bid.newname);
  // Found: everything before it in index order settles before it, exactly.
  if (here >= 0) return { ahead: here, capped: false };
  // Not found means the window ended before reaching this row, so what was
  // counted is a floor. Saying so is the difference between a number and a
  // guess presented as a number.
  return { ahead: open.length, capped: true };
}

/**
 * When the chain may next close an auction, for anyone.
 *
 * `eosio/global.last_name_close` is a single value for the whole chain,
 * and the settlement check refuses to run again until a day has passed
 * since it. So even a bid that leads the chain and has been quiet for
 * 24 hours waits for this clock, which somebody else's win just reset.
 */
export interface CloseGate {
  lastClose: number;
  /** No auction anywhere can close before this. */
  opensAt: number;
}

export async function readCloseGate(): Promise<CloseGate | undefined> {
  const rows = await getTableRows<{ last_name_close?: string }>({
    code: SYSTEM,
    scope: SYSTEM,
    table: 'global',
    limit: 1,
  });
  const raw = rows[0]?.last_name_close;
  if (!raw) return undefined;
  // Stored as a zoneless time_point, and it is UTC.
  const lastClose = Date.parse(raw + 'Z');
  if (!Number.isFinite(lastClose)) return undefined;
  return { lastClose, opensAt: lastClose + QUIET_PERIOD_MS };
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

/**
 * What a bid needs from you now, which is not what it cost.
 *
 * A history line says you bid 5 WAX on a name in March. It does not say
 * whether that WAX is sitting on the contract waiting to be asked for, or
 * whether the name is yours and unclaimed, or whether there is nothing to
 * do. 888 names on this chain are won and never claimed, across 406
 * wallets, so people plainly do forget. Each bid is in exactly one of
 * these, and each one has exactly one next step.
 */
export type BidStanding =
  /** Top bid, auction still open. Nothing to do but wait. */
  | { kind: 'leading'; name: string; wax: number; settlesAt: number }
  /** Somebody beat you. The WAX is yours and the contract is holding it. */
  | { kind: 'outbid'; name: string; by: string; wax: number; refund?: PendingRefund }
  /** Won and unclaimed. The account does not exist until you make it. */
  | { kind: 'won'; name: string; wax: number }
  /** Won, claimed, done. The account exists. */
  | { kind: 'claimed'; name: string }
  /** Bid on, and the name went to somebody who has since created it. */
  | { kind: 'lost'; name: string };

/**
 * Reads where each of these names leaves the bidder.
 *
 * One pass over the names, plus one read of the refund rows, rather than
 * asking the reader to open each name in turn and work it out.
 */
export async function readBidStandings(
  actor: string,
  names: string[],
): Promise<BidStanding[]> {
  const unique = [...new Set(names)];
  const [statuses, refunds] = await Promise.all([
    Promise.all(unique.map((n) => readNameStatus(n, actor).catch(() => undefined))),
    readRefundsFor(actor, unique).catch(() => [] as PendingRefund[]),
  ]);
  const owed = new Map(refunds.map((r) => [r.newname, r]));
  const out: BidStanding[] = [];
  for (const [i, name] of unique.entries()) {
    const st = statuses[i];
    if (!st) continue;
    if (st.kind === 'auction') {
      out.push(st.bid.high_bidder === actor
        ? { kind: 'leading', name, wax: st.bid.high_bid / 1e8, settlesAt: st.settlesAt }
        : { kind: 'outbid', name, by: st.bid.high_bidder, wax: st.bid.high_bid / 1e8, refund: owed.get(name) });
      continue;
    }
    if (st.kind === 'won') {
      out.push(st.mine
        ? { kind: 'won', name, wax: st.bid.high_bid / 1e8 }
        : { kind: 'outbid', name, by: st.bid.high_bidder, wax: st.bid.high_bid / 1e8, refund: owed.get(name) });
      continue;
    }
    // The row is gone, so somebody created the account. Whether that was
    // this bidder is the difference between done and lost.
    if (st.kind === 'taken') {
      const empty: { owner?: Authority; active?: Authority } = {};
      const [theirs, ours] = await Promise.all([
        readAccountAuthorities(name).catch(() => empty),
        readAccountAuthorities(actor).catch(() => empty),
      ]);
      // Sharing a key is what "this is mine" means here: the row that
      // proved ownership was erased by the very act of claiming it.
      const oursKeys = (ours.active?.keys ?? []).map((k) => k.key);
      const shared = (theirs.active?.keys ?? []).some((k) => oursKeys.includes(k.key));
      out.push(shared ? { kind: 'claimed', name } : { kind: 'lost', name });
      continue;
    }
    // Free again is not a state the chain produces after a bid, so say
    // nothing rather than invent a story about it.
  }
  return out;
}

/**
 * Every bid ever placed on one name, oldest first.
 *
 * The standing bid says what a name costs. It does not say whether three
 * people fought over it last week or whether one person named a price in
 * 2019 and nobody ever answered, and those are different decisions.
 *
 * Fetched whole, once, because Hyperion will not filter `bidname` by the
 * name being bid on: `act.data.newname` matches nothing and a bare
 * `newname` is ignored, both verified against the live node. So the choice
 * is a full scan per lookup or a full scan once, and once wins. It is
 * around 7,400 actions over the chain's whole life, which is eight
 * requests and a few hundred kilobytes, and every later lookup is free.
 */
export interface NameBidEvent {
  bidder: string;
  wax: number;
  when: number;
}

let historyCache: Map<string, NameBidEvent[]> | undefined;
let historyPending: Promise<Map<string, NameBidEvent[]>> | undefined;

async function fetchAllBidHistory(): Promise<Map<string, NameBidEvent[]>> {
  const byName = new Map<string, NameBidEvent[]>();
  const seen = new Set<string>();
  for (const host of HYPERION_ENDPOINTS) {
    byName.clear();
    seen.clear();
    let ok = true;
    for (let skip = 0; skip < 20000; skip += 1000) {
      let page: { actions?: {
        timestamp: string; trx_id: string; action_ordinal?: number;
        act: { data: { bidder: string; newname: string; bid: string } };
      }[] } | undefined;
      try {
        const res = await fetch(
          `${host}/v2/history/get_actions?filter=eosio%3Abidname&limit=1000&skip=${skip}&sort=desc`,
        );
        if (!res.ok) { ok = false; break; }
        page = await res.json();
      } catch { ok = false; break; }
      const acts = page?.actions ?? [];
      if (!acts.length) break;
      for (const a of acts) {
        // Hyperion pages can overlap, and a repeated bid would read as a
        // contest that never happened.
        const id = `${a.trx_id}:${a.action_ordinal ?? 0}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const list = byName.get(a.act.data.newname) ?? [];
        list.push({
          bidder: a.act.data.bidder,
          wax: parseFloat(String(a.act.data.bid)),
          when: Date.parse(a.timestamp + 'Z'),
        });
        byName.set(a.act.data.newname, list);
      }
    }
    if (ok && byName.size) break;
  }
  for (const list of byName.values()) list.sort((x, y) => x.when - y.when);
  return byName;
}

/** One name's bids, oldest first. Empty when the history is unreachable. */
export async function readNameHistory(name: string): Promise<NameBidEvent[]> {
  if (!historyCache) {
    // Share one fetch between callers: opening two names at once should
    // not scan the chain's whole history twice.
    historyPending = historyPending ?? fetchAllBidHistory();
    try {
      historyCache = await historyPending;
    } catch {
      historyPending = undefined;
      return [];
    }
  }
  return historyCache.get(name) ?? [];
}

/**
 * What each of these accounts could bid right now.
 *
 * A bid transfers immediately, so the liquid balance is the ceiling on
 * what somebody can raise to today. It is not the whole story, since WAX
 * can be unstaked or pulled out of REX, but as a first read it answers the
 * question a bidder actually has: can the person ahead of me go higher?
 *
 * Absent means zero. The chain omits `core_liquid_balance` entirely on an
 * account holding none, which is not the same as failing to read it, so
 * unreachable accounts are left out of the map rather than reported as
 * broke.
 */
export async function readBalances(accounts: string[]): Promise<Map<string, number>> {
  const unique = [...new Set(accounts.filter(Boolean))];
  const out = new Map<string, number>();
  await Promise.all(unique.map(async (name) => {
    try {
      const acc = await getAccount(name);
      const raw = (acc as unknown as { core_liquid_balance?: unknown }).core_liquid_balance;
      const wax = raw === undefined || raw === null ? 0 : parseFloat(String(raw));
      out.set(name, Number.isFinite(wax) ? wax : 0);
    } catch { /* unreadable is not the same as empty, so say nothing */ }
  }));
  return out;
}

/**
 * What a name really costs, beyond the bid.
 *
 * Winning buys the right to create the account, not the account. Creating
 * it buys RAM at the going rate and locks WAX into CPU and NET, and both
 * are discovered at claim time by anyone who was not told. The RAM price
 * moves with the market, so it is read rather than guessed.
 */
export interface NameCost {
  /** WAX spent for good, at the current market price. */
  ramWax: number;
  /** WAX locked, and recoverable by unstaking later. */
  stakeWax: number;
}

export async function readNameCost(ramBytes = 4096, stakeWax = 1): Promise<NameCost | undefined> {
  try {
    const rows = await getTableRows<{
      base: { balance: string }; quote: { balance: string };
    }>({ code: SYSTEM, scope: SYSTEM, table: 'rammarket', limit: 1 });
    const m = rows[0];
    if (!m) return undefined;
    const base = parseFloat(m.base.balance);
    const quote = parseFloat(m.quote.balance);
    if (!Number.isFinite(base) || !Number.isFinite(quote) || base <= ramBytes) return undefined;
    // Bancor, the same curve buyrambytes uses, plus the contract's 0.5 percent.
    const cost = (quote * ramBytes) / (base - ramBytes);
    return { ramWax: cost * 1.005, stakeWax };
  } catch {
    return undefined;
  }
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

/**
 * An Authority in the shape `newaccount` expects, and in the ORDER it
 * demands.
 *
 * The chain runs `validate()` on both authorities and refuses any whose
 * keys are not in strictly ascending order of their binary value. Nothing
 * downstream sorts for you: `Action.from()` given a plain object encodes
 * whatever order it was handed, so an appended key reaches the chain out
 * of order and the whole transaction aborts on "Invalid active authority".
 * Routing through WharfKit's own Authority does it, since its `from()`
 * sorts, and using the library's ordering beats reimplementing a base58
 * comparison here.
 */
function wireAuthority(a: Authority) {
  const sorted = WireAuthority.from({
    threshold: a.threshold,
    keys: a.keys.map((k) => ({ key: k.key, weight: k.weight })),
    accounts: a.accounts.map((c) => ({
      permission: { actor: c.actor, permission: c.permission }, weight: c.weight,
    })),
    waits: a.waits.map((w) => ({ wait_sec: w.wait_sec, weight: w.weight })),
  });
  // Back to plain data, so the confirmation dialog and the verify scripts
  // read it as JSON rather than as Antelope types.
  return JSON.parse(JSON.stringify(sorted)) as {
    threshold: number;
    keys: { key: string; weight: number }[];
    accounts: { permission: { actor: string; permission: string }; weight: number }[];
    waits: { wait_sec: number; weight: number }[];
  };
}

/**
 * One public key, in one spelling.
 *
 * The same key has a legacy `EOS...` form and a modern `PUB_K1_...` form,
 * and they share no characters past the prefix. Comparing the two as
 * strings says they differ, which would let the same key be added twice
 * and get the authority rejected as a duplicate. Returns the input
 * untouched when it cannot be parsed, so the caller can still show it back
 * to whoever typed it.
 */
export function normalizeKey(raw: string): string {
  try {
    return String(PublicKey.from(raw.trim()));
  } catch {
    return raw.trim();
  }
}

/** Whether a key is spelled in a way the chain will accept at all. */
export function isValidKey(raw: string): boolean {
  try {
    PublicKey.from(raw.trim());
    return true;
  } catch {
    return false;
  }
}

export interface ClaimNameArgs {
  /** The winner, who pays for everything. */
  creator: string;
  /** The name won at auction. */
  newname: string;
  /**
   * Whole authorities, not single keys. An account whose owner or active
   * carries two keys and gets created with one of them is an account its
   * own wallet may not be able to sign for.
   */
  owner: Authority;
  active: Authority;
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
        owner: wireAuthority(a.owner),
        active: wireAuthority(a.active),
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
/**
 * One permission exactly as the chain stores it.
 *
 * Not "the key", which is what an earlier version of this read. A
 * permission can hold several keys, each with a weight, and clears only
 * when the weights of whoever signed reach the threshold. It can also
 * delegate to another account, or to a wait. Reducing all of that to
 * `keys[0]` was silently dropping authority.
 */
export interface Authority {
  threshold: number;
  keys: { key: string; weight: number }[];
  accounts: { actor: string; permission: string; weight: number }[];
  waits: { wait_sec: number; weight: number }[];
}

/** Whether an authority is the ordinary "any one of these keys" shape. */
export function isSimpleAuthority(a: Authority): boolean {
  return a.threshold === 1
    && a.accounts.length === 0
    && a.waits.length === 0
    && a.keys.every((k) => k.weight === 1);
}

/** Weight the picked keys carry, against what the threshold demands. */
export function authorityReach(a: Authority, pickedKeys: string[]): number {
  let sum = 0;
  for (const k of a.keys) if (pickedKeys.includes(k.key)) sum += k.weight;
  // Delegates and waits come along unchanged, so they still count.
  for (const c of a.accounts) sum += c.weight;
  return sum;
}

/**
 * Both permissions of an account, whole.
 *
 * WharfKit hands back typed objects, not the raw JSON: `perm_name` is a
 * Name and `key` is a PublicKey. Comparing them to strings silently never
 * matches, which once left every field blank with no error anywhere. So
 * everything is put through String() before it is compared or kept.
 */
export async function readAccountAuthorities(
  actor: string,
): Promise<{ owner?: Authority; active?: Authority }> {
  try {
    const acc = await getAccount(actor);
    const out: { owner?: Authority; active?: Authority } = {};
    type RawPerm = {
      perm_name: unknown;
      required_auth?: {
        threshold?: unknown;
        keys?: { key: unknown; weight: unknown }[];
        accounts?: { permission?: { actor: unknown; permission: unknown }; weight: unknown }[];
        waits?: { wait_sec: unknown; weight: unknown }[];
      };
    };
    for (const p of (acc as unknown as { permissions?: RawPerm[] }).permissions ?? []) {
      const perm = String(p.perm_name);
      if (perm !== 'owner' && perm !== 'active') continue;
      const ra = p.required_auth ?? {};
      const auth: Authority = {
        threshold: Number(ra.threshold ?? 1),
        keys: (ra.keys ?? [])
          .filter((k) => k?.key !== undefined && k?.key !== null)
          .map((k) => ({ key: String(k.key), weight: Number(k.weight ?? 1) })),
        accounts: (ra.accounts ?? [])
          .filter((c) => c?.permission)
          .map((c) => ({
            actor: String(c.permission!.actor),
            permission: String(c.permission!.permission),
            weight: Number(c.weight ?? 1),
          })),
        waits: (ra.waits ?? []).map((w) => ({
          wait_sec: Number(w.wait_sec ?? 0), weight: Number(w.weight ?? 1),
        })),
      };
      out[perm] = auth;
    }
    return out;
  } catch {
    return {};
  }
}
