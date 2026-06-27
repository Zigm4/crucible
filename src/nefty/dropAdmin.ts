/**
 * Collection-author admin actions for NeftyBlocks drops (`neftyblocksd`).
 *
 * Companion to createDrop.ts: once a drop exists, its author manages it with
 * these single actions. Every one carries an `authorized_account` the
 * contract checks against the collection's authorized_accounts - the UI only
 * surfaces them for an authorized wallet, but the chain is the real guard.
 *
 * Whitelist: a gated drop (auth_required=true, claimed via claimdropwl) reads
 * its allowed accounts from the `whitelists` table SCOPED BY drop_id, rows
 * `{account, account_limit}`. addtowl/erasefromwl edit that list. Creating a
 * gated drop does NOT populate it - the author must add accounts here, which
 * is exactly the step that was missing.
 *
 * Structs are verbatim from the live neftyblocksd ABI.
 */
import { getTableRows } from '../chain/rpc';
import type { BuiltAction } from './execute';

const DROPS = 'neftyblocksd';

function auth(actor: string) {
  return [{ actor, permission: 'active' }];
}

export function buildDropAddToWhitelist(
  authorized_account: string,
  drop_id: string | number,
  accounts_to_add: string[],
): BuiltAction {
  return {
    account: DROPS,
    name: 'addtowl',
    authorization: auth(authorized_account),
    data: { authorized_account, drop_id: String(drop_id), accounts_to_add },
  };
}

export function buildDropEraseFromWhitelist(
  authorized_account: string,
  drop_id: string | number,
  accounts_to_remove: string[],
): BuiltAction {
  return {
    account: DROPS,
    name: 'erasefromwl',
    authorization: auth(authorized_account),
    data: { authorized_account, drop_id: String(drop_id), accounts_to_remove },
  };
}

export function buildSetDropAuth(
  authorized_account: string,
  drop_id: string | number,
  auth_required: boolean,
): BuiltAction {
  return {
    account: DROPS,
    name: 'setdropauth',
    authorization: auth(authorized_account),
    data: { authorized_account, drop_id: String(drop_id), auth_required },
  };
}

export function buildSetDropHidden(
  authorized_account: string,
  drop_id: string | number,
  is_hidden: boolean,
): BuiltAction {
  return {
    account: DROPS,
    name: 'setdrophiddn',
    authorization: auth(authorized_account),
    data: { authorized_account, drop_id: String(drop_id), is_hidden },
  };
}

export function buildSetDropMax(
  authorized_account: string,
  drop_id: string | number,
  new_max_claimable: number,
): BuiltAction {
  return {
    account: DROPS,
    name: 'setdropmax',
    authorization: auth(authorized_account),
    data: { authorized_account, drop_id: String(drop_id), new_max_claimable },
  };
}

export function buildSetDropTimes(
  authorized_account: string,
  drop_id: string | number,
  start_time: number,
  end_time: number,
): BuiltAction {
  return {
    account: DROPS,
    name: 'setdroptimes',
    authorization: auth(authorized_account),
    data: { authorized_account, drop_id: String(drop_id), start_time, end_time },
  };
}

export function buildSetDropLimit(
  authorized_account: string,
  drop_id: string | number,
  account_limit: number,
  account_limit_cooldown: number,
): BuiltAction {
  return {
    account: DROPS,
    name: 'setdroplimit',
    authorization: auth(authorized_account),
    data: { authorized_account, drop_id: String(drop_id), account_limit, account_limit_cooldown },
  };
}

export function buildEraseDrop(authorized_account: string, drop_id: string | number): BuiltAction {
  return {
    account: DROPS,
    name: 'erasedrop',
    authorization: auth(authorized_account),
    data: { authorized_account, drop_id: String(drop_id) },
  };
}

/** Reads the accounts in a drop's whitelist (table `whitelists`, scope = drop_id). */
export async function readDropWhitelist(drop_id: string | number): Promise<string[]> {
  const rows = await getTableRows<{ account: string }>({
    code: DROPS,
    scope: String(drop_id),
    table: 'whitelists',
    limit: 1000,
  });
  return rows.map((r) => r.account);
}

export interface DropAdminRow {
  drop_id: string;
  collection_name: string;
  name: string;
  auth_required: boolean;
  is_hidden: boolean;
  max_claimable: number;
  current_claimed: number;
  account_limit: number;
  account_limit_cooldown: number;
  start_time: number;
  end_time: number;
  listing_price: string;
}

interface RawDropRow {
  drop_id: number | string;
  collection_name: string;
  display_data: string;
  auth_required: number | boolean;
  is_hidden: number | boolean;
  max_claimable: number;
  current_claimed: number;
  account_limit: number;
  account_limit_cooldown: number;
  start_time: number;
  end_time: number;
  listing_price: string;
}

/**
 * Reads a single drop row by id straight from the `drops` table. Returns
 * undefined if no row with that exact id exists. Works for ANY drop the id
 * is known for - including hidden / gated ones the discovery scan skips.
 */
export async function readDropById(drop_id: string | number): Promise<DropAdminRow | undefined> {
  const rows = await getTableRows<RawDropRow>({
    code: DROPS,
    scope: DROPS,
    table: 'drops',
    lower_bound: String(drop_id),
    limit: 1,
  });
  const r = rows[0];
  if (!r || String(r.drop_id) !== String(drop_id)) return undefined;
  let name = '';
  try {
    name = (JSON.parse(r.display_data || '{}') as { name?: string }).name ?? '';
  } catch {
    name = '';
  }
  return {
    drop_id: String(r.drop_id),
    collection_name: r.collection_name,
    name,
    auth_required: Boolean(r.auth_required),
    is_hidden: Boolean(r.is_hidden),
    max_claimable: Number(r.max_claimable),
    current_claimed: Number(r.current_claimed),
    account_limit: Number(r.account_limit),
    account_limit_cooldown: Number(r.account_limit_cooldown),
    start_time: Number(r.start_time),
    end_time: Number(r.end_time),
    listing_price: r.listing_price,
  };
}

/**
 * Digs the new drop_id out of a createdrop transaction's traces (the contract
 * emits an inline `lognewdrop` action carrying it). Returns undefined if the
 * shape isn't found, so callers can fall back to a table lookup.
 */
export function extractNewDropId(txResult: unknown): string | undefined {
  const traces =
    (txResult as { response?: { processed?: { action_traces?: unknown[] } } })?.response?.processed
      ?.action_traces ?? [];
  let found: string | undefined;
  const walk = (nodes: unknown[]) => {
    for (const n of nodes) {
      const t = n as { act?: { account?: string; name?: string; data?: { drop_id?: number | string } }; inline_traces?: unknown[] };
      if (t.act?.account === DROPS && t.act?.name === 'lognewdrop' && t.act.data?.drop_id !== undefined) {
        found = String(t.act.data.drop_id);
      }
      if (Array.isArray(t.inline_traces)) walk(t.inline_traces);
    }
  };
  walk(traces as unknown[]);
  return found;
}
