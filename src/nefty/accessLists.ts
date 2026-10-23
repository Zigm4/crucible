/**
 * Account lists: which accounts may run a recipe, read and written on chain.
 * ─────────────────────────────────────────────────────────────
 * Two contracts keep such lists, and they do not behave alike. Every rule
 * below was settled through compute_transaction, executed and never signed
 * (scripts/verify-access-lists.mjs):
 *
 *   secure.nefty   a collection's whitelists, shared by its blends and
 *                  upgrades. `addwhitelist` makes one, `addtowl`,
 *                  `erasefromwl` and `clearwl` change it.
 *                  - at most 500 accounts per action
 *                  - an account already on the list is refused, and so
 *                    is an account that does not exist
 *                  - the author pays the RAM, about 120 bytes an account
 *
 *   neftyblocksd   a drop's own list, scoped by drop id. `addtowl` and
 *                  `erasefromwl`, nothing to clear it at once.
 *                  - no size limit, and an account already on it is ignored
 *                  - an account that does not exist is refused
 *                  - the drop must have auth_required set first, or the
 *                    contract answers "Drop is not secure"
 *                  - the author pays about 124 bytes an account
 *                  - `addtowlwlim` adds with a claim limit per account, and
 *                    rewrites the limit of an account already on it. The
 *                    lower of it and the drop's own per-wallet limit applies,
 *                    0 meaning none: it can only lower the drop's limit
 *                    (claims simulated on 2026-10-24)
 *
 * Both accept removing an account that is not on the list.
 *
 * A new whitelist's id, and a new drop's id, is the value its contract's
 * counter holds before the creating action runs. That is what lets a
 * recipe and its list go in one transaction: if anyone else creates one in
 * between, the list action names an id that is not this collection's, the
 * contract refuses it, and the whole transaction falls back unapplied.
 */
import type { BuiltAction } from '../chain/action';
import { getTableRows, WAX_RPC_ENDPOINTS, withFailover } from '../chain/rpc';
import { buildAddToWhitelist, buildEraseFromWhitelist } from './admin';
import { buildDropAddToWhitelist, buildDropEraseFromWhitelist } from './dropAdmin';

/** secure.nefty refuses more than this in one action, and the same limit is kept for drops. */
export const ACCOUNTS_PER_ACTION = 500;
/**
 * How many accounts one transaction carries. 1,500 is three actions, about
 * 30ms of CPU and 180 KB of RAM in the simulations: well inside a
 * transaction's limits, and few enough signatures for a list of thousands.
 */
export const ACCOUNTS_PER_TRANSACTION = 1_500;
/** RAM an account takes on a list, rounded up from both contracts. */
export const RAM_BYTES_PER_ACCOUNT = 125;

// ─── reading what is typed ──────────────────────────────────────────────

/** A WAX account name: up to 12 of a-z, 1-5 and dots, not ending with a dot. */
export function isAccountName(s: string): boolean {
  return /^[a-z1-5.]{1,12}$/.test(s) && !s.endsWith('.');
}

export interface ParsedAccounts {
  /** Valid names, each once, in the order they were first typed. */
  accounts: string[];
  /** What was typed that cannot be an account name, as typed. */
  invalid: string[];
  /** How many names were typed more than once, counted once each time over. */
  repeated: number;
}

/**
 * Reads a pasted list. Accounts may be separated by anything that cannot be
 * in a name: lines, commas, spaces, semicolons. Case is folded and a leading
 * @ is dropped, because lists copied from Discord or a spreadsheet carry both.
 */
export function parseAccountList(text: string): ParsedAccounts {
  const seen = new Set<string>();
  const accounts: string[] = [];
  const invalid: string[] = [];
  let repeated = 0;
  for (const raw of text.split(/[\s,;]+/)) {
    const typed = raw.trim();
    if (!typed) continue;
    const name = typed.replace(/^@/, '').toLowerCase();
    if (!isAccountName(name)) { invalid.push(typed); continue; }
    if (seen.has(name)) { repeated++; continue; }
    seen.add(name);
    accounts.push(name);
  }
  return { accounts, invalid, repeated };
}

// ─── which accounts exist ───────────────────────────────────────────────

const exists = new Map<string, boolean>();

/**
 * Whether one account exists, from get_code_hash: the lightest call that
 * names an account. A node that does not know the account answers
 * account_query_exception, which is an answer; only a node that does not
 * answer at all passes the question to the next one.
 */
async function accountExists(name: string): Promise<boolean> {
  const known = exists.get(name);
  if (known !== undefined) return known;
  let last: unknown;
  for (const url of WAX_RPC_ENDPOINTS) {
    try {
      const res = await fetch(`${url}/v1/chain/get_code_hash`, {
        method: 'POST',
        body: JSON.stringify({ account_name: name }),
        signal: AbortSignal.timeout(8_000),
      });
      if (res.ok) { exists.set(name, true); return true; }
      const body = (await res.json().catch(() => ({}))) as { error?: { name?: string } };
      if (body.error?.name === 'account_query_exception') { exists.set(name, false); return false; }
      last = new Error(`HTTP ${res.status} from ${url}`);
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/**
 * The accounts in `accounts` that do not exist on chain. Both contracts
 * refuse the whole action for one of them, so they are found before signing
 * rather than one refusal at a time.
 */
export async function findMissingAccounts(
  accounts: string[],
  onProgress?: (checked: number) => void,
): Promise<string[]> {
  const missing: string[] = [];
  let checked = 0;
  for (let i = 0; i < accounts.length; i += 12) {
    const slice = accounts.slice(i, i + 12);
    const found = await Promise.all(slice.map(accountExists));
    slice.forEach((a, j) => { if (!found[j]) missing.push(a); });
    checked += slice.length;
    onProgress?.(checked);
  }
  return missing;
}

// ─── reading a list ─────────────────────────────────────────────────────

/**
 * Every row of a scope, page after page. One read stops at what a node
 * returns at once (1,000 rows at most), and reading only that is how the
 * classic Manage panel showed a long list cut short.
 */
async function readAllAccounts(code: string, scope: string): Promise<string[]> {
  return (await readAllRows(code, scope)).map((r) => r.account);
}

async function readAllRows(code: string, scope: string): Promise<{ account: string; limit: number }[]> {
  const out: { account: string; limit: number }[] = [];
  let lower = '';
  for (let page = 0; page < 200; page++) {
    const res = await withFailover(async (client) => (await client.call({
      path: '/v1/chain/get_table_rows',
      params: { json: true, code, scope, table: 'whitelists', limit: 1000, ...(lower ? { lower_bound: lower } : {}) },
    })) as { rows?: { account: string; account_limit?: number }[]; more?: boolean; next_key?: string });
    for (const r of res.rows ?? []) out.push({ account: String(r.account), limit: Number(r.account_limit ?? 0) });
    if (!res.more || !res.next_key) break;
    lower = String(res.next_key);
  }
  return out;
}

/** Everyone on a secure.nefty whitelist. */
export function readCollectionListMembers(security_id: string | number): Promise<string[]> {
  return readAllAccounts('secure.nefty', String(security_id));
}

/** Everyone on a drop's own list. */
export function readDropListMembers(drop_id: string | number): Promise<string[]> {
  return readAllAccounts('neftyblocksd', String(drop_id));
}

/** The same, with each account's own claim limit (0 for none). */
export function readDropListEntries(drop_id: string | number): Promise<{ account: string; limit: number }[]> {
  return readAllRows('neftyblocksd', String(drop_id));
}

async function counter(code: string, name: string): Promise<string> {
  const rows = await getTableRows<{ counter_name: string; counter_value: number | string }>({
    code, scope: code, table: 'counters', limit: 20,
  });
  const row = rows.find((r) => r.counter_name === name);
  if (!row) throw new Error(`${code} has no ${name} counter`);
  return String(row.counter_value);
}

/** The id the next `addwhitelist` will give its list. */
export const nextCollectionListId = () => counter('secure.nefty', 'security');
/** The id the next `createdrop` will give its drop. */
export const nextDropId = () => counter('neftyblocksd', 'drop');

// ─── changing a list ────────────────────────────────────────────────────

/** What a paste means against the list as it stands. */
export interface ListChange {
  /** Not on the list yet: these get added. */
  add: string[];
  /** Already on it: nothing to do, and secure.nefty would refuse them. */
  already: string[];
  /** On the list and asked to go. */
  remove: string[];
}

export function planListChange(members: string[], toAdd: string[], toRemove: string[]): ListChange {
  const on = new Set(members);
  const leaving = new Set(toRemove.filter((a) => on.has(a)));
  return {
    add: toAdd.filter((a) => !on.has(a) && !leaving.has(a)),
    already: toAdd.filter((a) => on.has(a) && !leaving.has(a)),
    remove: [...leaving],
  };
}

export function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export function addToCollectionList(actor: string, collection: string, security_id: string | number, accounts: string[]): BuiltAction[] {
  return chunk(accounts, ACCOUNTS_PER_ACTION).map((c) => buildAddToWhitelist(actor, collection, security_id, c));
}

export function removeFromCollectionList(actor: string, collection: string, security_id: string | number, accounts: string[]): BuiltAction[] {
  return chunk(accounts, ACCOUNTS_PER_ACTION).map((c) => buildEraseFromWhitelist(actor, collection, security_id, c));
}

/** With `limit` above 0, each account gets that claim limit (addtowlwlim); without, none. */
export function addToDropList(actor: string, drop_id: string | number, accounts: string[], limit = 0): BuiltAction[] {
  if (limit > 0) {
    return chunk(accounts, ACCOUNTS_PER_ACTION).map((c) => ({
      account: 'neftyblocksd', name: 'addtowlwlim', authorization: [{ actor, permission: 'active' }],
      data: { authorized_account: actor, drop_id: String(drop_id), accounts_to_add: c.map((account) => ({ account, limit })) },
    }));
  }
  return chunk(accounts, ACCOUNTS_PER_ACTION).map((c) => buildDropAddToWhitelist(actor, drop_id, c));
}

export function removeFromDropList(actor: string, drop_id: string | number, accounts: string[]): BuiltAction[] {
  return chunk(accounts, ACCOUNTS_PER_ACTION).map((c) => buildDropEraseFromWhitelist(actor, drop_id, c));
}

/** How many accounts an action carries, 0 for one that is not about a list. */
function accountsIn(a: BuiltAction): number {
  const list = a.data.accounts_to_add ?? a.data.accounts_to_remove;
  // addtowlwlim carries {account, limit} pairs: still one account each.
  return Array.isArray(list) ? list.length : 0;
}

/**
 * Splits actions, in order, into transactions of at most
 * ACCOUNTS_PER_TRANSACTION accounts. Order is kept, so whatever must come
 * first (the list or drop being created) lands in the first transaction.
 */
export function packTransactions(actions: BuiltAction[]): BuiltAction[][] {
  const out: BuiltAction[][] = [];
  let cur: BuiltAction[] = [];
  let load = 0;
  for (const a of actions) {
    const n = accountsIn(a);
    if (cur.length && n && load + n > ACCOUNTS_PER_TRANSACTION) { out.push(cur); cur = []; load = 0; }
    cur.push(a);
    load += n;
  }
  if (cur.length) out.push(cur);
  return out;
}
