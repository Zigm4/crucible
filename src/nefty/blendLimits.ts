/**
 * Per-account limits on blend.nefty blends.
 *
 * A blend can cap how often one account runs it. `blendlimits` (scope
 * blend.nefty, one row per limited blend) holds the limit and its cooldown;
 * `accstats` (scoped by blend id, one row per account) holds how often that
 * account ran it and when last. Nothing on the player side read either, so a
 * blend somebody had already used up looked as runnable as any other and the
 * chain refused it at signing.
 *
 * Same rule as drops, which store the same three numbers the same way: when a
 * cooldown is set and has passed since the last use, the counter starts over.
 */
import { getTableRows } from '../chain/rpc';

const CONTRACT = 'blend.nefty';

export interface BlendLimit {
  blend_id: string;
  /** Uses per account, 0 when there is no limit. */
  account_limit: number;
  /** Seconds after the last use before the counter resets, 0 for never. */
  account_limit_cooldown: number;
}

export interface BlendUse {
  counter: number;
  /** Unix seconds. */
  last_claim_time: number;
}

/**
 * The limits of these blends, for the ones that have one. The table only
 * holds limited blends, so one ranged read usually covers a whole
 * collection; it pages in case it does not.
 */
export async function readBlendLimits(ids: string[]): Promise<Map<string, BlendLimit>> {
  const out = new Map<string, BlendLimit>();
  const nums = ids.map(Number).filter((n) => Number.isFinite(n) && n >= 0);
  if (!nums.length) return out;
  const wanted = new Set(nums.map(String));
  let lower = Math.min(...nums);
  const upper = Math.max(...nums);
  for (let page = 0; page < 10; page += 1) {
    const rows = await getTableRows<{
      blend_id: number | string; account_limit: number | string; account_limit_cooldown: number | string;
    }>({ code: CONTRACT, scope: CONTRACT, table: 'blendlimits', lower_bound: lower, upper_bound: upper, limit: 1000 });
    for (const r of rows) {
      const id = String(r.blend_id);
      if (!wanted.has(id)) continue;
      out.set(id, {
        blend_id: id,
        account_limit: Number(r.account_limit) || 0,
        account_limit_cooldown: Number(r.account_limit_cooldown) || 0,
      });
    }
    if (rows.length < 1000) break;
    lower = Number(rows[rows.length - 1].blend_id) + 1;
  }
  return out;
}

/** How often `actor` ran this blend, or undefined when never. */
export async function readBlendUse(blendId: string, actor: string): Promise<BlendUse | undefined> {
  const rows = await getTableRows<{ claimer: string; counter: number | string; last_claim_time: number | string }>({
    code: CONTRACT,
    scope: blendId,
    table: 'accstats',
    lower_bound: actor,
    upper_bound: actor,
    key_type: 'name',
    limit: 1,
  });
  const r = rows.find((x) => x.claimer === actor);
  return r ? { counter: Number(r.counter) || 0, last_claim_time: Number(r.last_claim_time) || 0 } : undefined;
}

/**
 * Uses left for this account right now: Infinity without a limit, the
 * whole limit when never used or once the cooldown has passed.
 */
export function blendUsesLeft(
  limit: BlendLimit | undefined,
  use: BlendUse | undefined,
  nowSec: number = Math.floor(Date.now() / 1000),
): number {
  if (!limit || limit.account_limit <= 0) return Infinity;
  if (!use) return limit.account_limit;
  if (limit.account_limit_cooldown > 0 && nowSec > use.last_claim_time + limit.account_limit_cooldown) {
    return limit.account_limit;
  }
  return Math.max(0, limit.account_limit - use.counter);
}
