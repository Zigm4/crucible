/**
 * Collection-author / manager admin actions for blend.nefty and
 * secure.nefty.
 *
 * Unlike every other module in Crucible, these actions are NOT for the
 * general public: every one carries an `authorized_account` field and
 * the contract verifies that account sits in the collection's
 * `authorized_accounts` list (atomicassets `collections` table). A
 * normal user who somehow triggered one would just get the
 * transaction rejected on-chain. The UI hides these controls unless
 * the connected wallet is detected as authorized (see
 * atomic/collections.ts), but the chain is the real guard.
 *
 * Two tiers are covered:
 *
 *   Tier 1 (destructive / state toggles, tiny payloads):
 *     setblendhide  hide / unhide a blend
 *     setblendtime  set start / end window (end=now disables it)
 *     delblend      delete a blend outright
 *     addtowl       add accounts to an existing whitelist
 *     erasefromwl   remove accounts from a whitelist
 *     clearwl       wipe a whitelist
 *
 *   Tier 2 (parameter edits + whitelist creation):
 *     setblendmax   change max total uses
 *     setblendlim   change per-account limit + cooldown
 *     setblenddata  change display_data (name/image json)
 *     setblendcat   change category
 *     setblendsec   attach / detach a security (whitelist) id
 *     addwhitelist  create a brand-new whitelist (returns a new id)
 *
 * Everything here is a flat struct, so the builders are thin and the
 * byte-for-byte verifier (scripts/verify-admin.mjs) checks them
 * against real on-chain admin traces.
 */

import type { Session } from '@wharfkit/session';

import { getTableRows } from '../chain/rpc';
import type { BuiltAction } from './execute';

const BLEND = 'blend.nefty';
const SECURE = 'secure.nefty';

function auth(actor: string) {
  return [{ actor, permission: 'active' }];
}

// ── blend.nefty: Tier 1 ─────────────────────────────────────────────── //

export function buildSetBlendHide(authorized_account: string, blend_id: string | number, is_hidden: boolean): BuiltAction {
  return {
    account: BLEND,
    name: 'setblendhide',
    authorization: auth(authorized_account),
    data: { authorized_account, blend_id: String(blend_id), is_hidden },
  };
}

export function buildSetBlendTime(
  authorized_account: string,
  blend_id: string | number,
  start_time: number,
  end_time: number,
): BuiltAction {
  return {
    account: BLEND,
    name: 'setblendtime',
    authorization: auth(authorized_account),
    data: {
      authorized_account,
      blend_id: String(blend_id),
      start_time: Math.floor(start_time),
      end_time: Math.floor(end_time),
    },
  };
}

export function buildDelBlend(authorized_account: string, blend_id: string | number): BuiltAction {
  return {
    account: BLEND,
    name: 'delblend',
    authorization: auth(authorized_account),
    data: { authorized_account, blend_id: String(blend_id) },
  };
}

// ── blend.nefty: Tier 2 ─────────────────────────────────────────────── //

export function buildSetBlendMax(authorized_account: string, blend_id: string | number, new_max_uses: number): BuiltAction {
  return {
    account: BLEND,
    name: 'setblendmax',
    authorization: auth(authorized_account),
    data: { authorized_account, blend_id: String(blend_id), new_max_uses: Math.floor(new_max_uses) },
  };
}

export function buildSetBlendLim(
  authorized_account: string,
  blend_id: string | number,
  account_limit: number,
  account_limit_cooldown: number,
): BuiltAction {
  return {
    account: BLEND,
    name: 'setblendlim',
    authorization: auth(authorized_account),
    data: {
      authorized_account,
      blend_id: String(blend_id),
      account_limit: Math.floor(account_limit),
      account_limit_cooldown: Math.floor(account_limit_cooldown),
    },
  };
}

export function buildSetBlendData(authorized_account: string, blend_id: string | number, display_data: string): BuiltAction {
  return {
    account: BLEND,
    name: 'setblenddata',
    authorization: auth(authorized_account),
    data: { authorized_account, blend_id: String(blend_id), display_data },
  };
}

/**
 * Replaces a blend's ingredient list (`setblendmix`).
 *
 * The one author action that changes what a live recipe CONSUMES.
 * Unlike `setrolls` - which is Nefty-internal, has no
 * `authorized_account` and has been called 5 times ever - this is a
 * normal author action with 6,356 real uses.
 *
 * It is a full REPLACEMENT, not a patch: whatever is passed becomes the
 * complete list, so the caller must start from the current ingredients.
 */
export function buildSetBlendMix(
  authorized_account: string,
  blend_id: string | number,
  ingredients: unknown[],
): BuiltAction {
  return {
    account: 'blend.nefty',
    name: 'setblendmix',
    authorization: [{ actor: authorized_account, permission: 'active' }],
    data: { authorized_account, blend_id: String(blend_id), ingredients },
  };
}

export function buildSetBlendCat(authorized_account: string, blend_id: string | number, category: string): BuiltAction {
  return {
    account: BLEND,
    name: 'setblendcat',
    authorization: auth(authorized_account),
    data: { authorized_account, blend_id: String(blend_id), category },
  };
}

export function buildSetBlendSec(authorized_account: string, blend_id: string | number, security_id: string | number): BuiltAction {
  return {
    account: BLEND,
    name: 'setblendsec',
    authorization: auth(authorized_account),
    data: { authorized_account, blend_id: String(blend_id), security_id: String(security_id) },
  };
}

// ── secure.nefty: whitelist ops ─────────────────────────────────────── //

export function buildAddToWhitelist(
  authorized_account: string,
  collection_name: string,
  security_id: string | number,
  accounts_to_add: string[],
): BuiltAction {
  return {
    account: SECURE,
    name: 'addtowl',
    authorization: auth(authorized_account),
    data: { authorized_account, collection_name, security_id: String(security_id), accounts_to_add },
  };
}

export function buildEraseFromWhitelist(
  authorized_account: string,
  collection_name: string,
  security_id: string | number,
  accounts_to_remove: string[],
): BuiltAction {
  return {
    account: SECURE,
    name: 'erasefromwl',
    authorization: auth(authorized_account),
    data: { authorized_account, collection_name, security_id: String(security_id), accounts_to_remove },
  };
}

export function buildClearWhitelist(
  authorized_account: string,
  collection_name: string,
  security_id: string | number,
): BuiltAction {
  return {
    account: SECURE,
    name: 'clearwl',
    authorization: auth(authorized_account),
    data: { authorized_account, collection_name, security_id: String(security_id) },
  };
}

export function buildAddWhitelist(
  authorized_account: string,
  collection_name: string,
  whitelist_name: string,
  description: string,
): BuiltAction {
  return {
    account: SECURE,
    name: 'addwhitelist',
    authorization: auth(authorized_account),
    data: { authorized_account, collection_name, whitelist_name, description },
  };
}

// ── reads ───────────────────────────────────────────────────────────── //

/**
 * Reads every account currently in a secure.nefty whitelist
 * (table `whitelists`, scope = security_id). Used to show the member
 * list in the Manage panel and to compute add/remove diffs.
 */
export async function readWhitelistMembers(security_id: string | number): Promise<string[]> {
  const rows = await getTableRows<{ account: string }>({
    code: SECURE,
    scope: String(security_id),
    table: 'whitelists',
    limit: 1000,
  });
  return rows.map((r) => r.account);
}

export interface SecurityRow {
  id: string;
  name: string;
  description: string;
  type: number;
}

/**
 * Reads the security definitions for a collection. secure.nefty scopes
 * `security` by collection_name, primary key = security id. Used to
 * list the collection's existing whitelists in the "attach security"
 * dropdown and after creating a new one.
 */
export async function readCollectionSecurities(collection_name: string): Promise<SecurityRow[]> {
  const rows = await getTableRows<{ id: number | string; name: string; description: string; type: number }>({
    code: SECURE,
    scope: collection_name,
    table: 'security',
    limit: 200,
  });
  return rows.map((r) => ({
    id: String(r.id),
    name: r.name,
    description: r.description,
    type: Number(r.type),
  }));
}

// ── sign-and-broadcast convenience ──────────────────────────────────── //

/**
 * Signs and broadcasts a single pre-built admin action. Admin ops are
 * one action each (no openbal / transfer legs), so this thin wrapper
 * covers every case.
 */
export async function executeAdminAction(session: Session, action: BuiltAction) {
  return session.transact({ actions: [action] });
}
