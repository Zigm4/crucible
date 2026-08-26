/**
 * How many ingredients `up.nefty` will accept on a new upgrade.
 *
 * This is the one place in the whole NeftyBlocks suite where a collection's
 * NEFTY stake still changes what the chain lets you do. Everything else the
 * old tier page advertised is either read by no contract at all
 * (`pro.blender` appears zero times in blend.nefty's binary) or switched off
 * for every collection by an admin list on `neftyblocksa` that contains the
 * entry `all`. `up.nefty` has no such list: the strings `neftyblocksa`,
 * `all` and `features` appear zero times in its code.
 *
 * The rule, read out of the deployed WASM:
 *
 *   if (config.fixed_fee.amount > 0  AND NOT early.access)  need > 1 ingredient
 *   else                                                    need >= 1
 *
 * `early.access` is granted only by `level.3`, which costs 45,000 NEFTY
 * staked against that collection. `setfixedfee` has been called exactly once
 * ever, on 2024-01-31, setting 0.01 WAX, so the first branch is live today.
 *
 * What this does NOT do, and the reason this module exists: the contract
 * never adds a fee, and never checks that any ingredient IS the fee. It
 * counts, and nothing more. The 0.01 WAX line on 255 recipes was put there
 * by the NeftyBlocks website when it built the transaction. That website is
 * gone and we do not add it either, so an author who drops below level.3
 * would send exactly what they sent last year and get back
 * `assertion failure with message: At least one ingredient besides the fixed
 * fee must be specified`. Telling them beforehand is the whole point.
 *
 * Only `createupgrde` and `setupgrdmix` reach this gate. Running an upgrade
 * (`upgrade`, `upgradesec`) and changing its cap (`setupgrdmax`) do not, so
 * upgrades that already exist keep working whatever the stake does.
 */
import { getTableRows } from '../chain/rpc';

export const STAKING_CONTRACT = 'stake.nefty';

/** The feature name `up.nefty` tests. Only `level.3` sets it true. */
export const UPGRADE_FEATURE = 'early.access';

export interface UpgradeGate {
  /** `level.zero`, `level.1`..`level.3`, or '' when the collection has no row. */
  level: string;
  /** Whether the level grants the feature `up.nefty` looks for. */
  earlyAccess: boolean;
  /** `up.nefty`'s configured fixed fee, verbatim. Empty when unreadable. */
  fixedFee: string;
  /** 1 or 2. What the contract will accept. */
  minIngredients: number;
  /**
   * False when a chain read failed. The caller must not turn a failed read
   * into a warning: saying "this will be rejected" to someone whose recipe
   * is fine is worse than saying nothing.
   */
  known: boolean;
}

/** The tier a collection currently sits at, or '' when it has never staked. */
export async function readCollectionLevel(collection: string): Promise<string> {
  if (!collection) return '';
  const rows = await getTableRows<{ collection_name: string; stakinglevel: string }>({
    code: STAKING_CONTRACT, scope: STAKING_CONTRACT, table: 'collstaking',
    lower_bound: collection, upper_bound: collection, key_type: 'name', limit: 1,
  });
  const hit = rows.find((r) => String(r.collection_name) === collection);
  return hit ? String(hit.stakinglevel) : '';
}

/**
 * Whether a tier grants one named feature.
 *
 * Read from the chain rather than hardcoded, because these rows are writable:
 * `upsertstklvl` set them 12 times between 2021 and 2022 and could set them
 * again. A hardcoded "level.3 only" would silently go stale.
 */
export async function levelGrants(level: string, feature: string): Promise<boolean> {
  // level.zero is the contract's own name for "staked, but under the first
  // threshold". It has no row in stakinglevel, so there is nothing to read.
  if (!level || level === 'level.zero') return false;
  const rows = await getTableRows<{
    stakingname: string;
    enabled_features: { feature: string; feature_value: [string, unknown] }[];
  }>({ code: STAKING_CONTRACT, scope: 'collections', table: 'stakinglevel', limit: 20 });
  const row = rows.find((r) => String(r.stakingname) === level);
  if (!row) return false;
  const f = (row.enabled_features ?? []).find((x) => String(x.feature) === feature);
  if (!f) return false;
  // feature_value is a variant pair, e.g. ["bool", 1] or ["float64", "2.0"].
  const [, value] = f.feature_value ?? [];
  return value === 1 || value === true || value === '1';
}

/** `up.nefty`'s fixed fee, which is what arms the whole rule. */
export async function readFixedFee(contract = 'up.nefty'): Promise<string> {
  const rows = await getTableRows<{ fixed_fee: { quantity: string; contract: string } }>({
    code: contract, scope: contract, table: 'config', limit: 1,
  });
  return rows[0]?.fixed_fee ? String(rows[0].fixed_fee.quantity) : '';
}

/** True when an asset string carries a non-zero amount, without float maths. */
export function isPositiveAsset(asset: string): boolean {
  const amount = String(asset).split(' ')[0] ?? '';
  if (!amount) return false;
  return /[1-9]/.test(amount.replace('.', ''));
}

/**
 * What `up.nefty` will accept from this collection right now.
 *
 * Every read is allowed to fail. A collection with no staking row is a
 * perfectly normal answer (389 collections that own blends have never had
 * one), so '' is data, not an error. A failed request is different, and sets
 * `known` false so the caller stays quiet.
 */
export async function readUpgradeGate(
  collection: string,
  contract = 'up.nefty',
): Promise<UpgradeGate> {
  const blank: UpgradeGate = {
    level: '', earlyAccess: false, fixedFee: '', minIngredients: 1, known: false,
  };
  if (!collection) return blank;
  try {
    const [level, fixedFee] = await Promise.all([
      readCollectionLevel(collection),
      readFixedFee(contract),
    ]);
    const earlyAccess = await levelGrants(level, UPGRADE_FEATURE);
    return {
      level,
      earlyAccess,
      fixedFee,
      minIngredients: isPositiveAsset(fixedFee) && !earlyAccess ? 2 : 1,
      known: true,
    };
  } catch {
    return blank;
  }
}

/**
 * The sentence to show an author, or '' when there is nothing to say.
 *
 * Written to be actionable rather than alarming: the fix is one more
 * ingredient of any kind, and it does not have to be a fee to anyone. The
 * contract counts ingredients and never inspects them.
 */
export function upgradeGateProblem(gate: UpgradeGate, ingredientCount: number): string {
  if (!gate.known || ingredientCount >= gate.minIngredients) return '';
  const where = gate.level && gate.level !== 'level.zero'
    ? `is ${gate.level}`
    : gate.level === 'level.zero'
      ? 'is level.zero'
      : 'has never staked NEFTY';
  return `up.nefty will reject this: the collection ${where}, and only level.3 `
    + `(45,000 NEFTY staked against it) may create an upgrade with a single ingredient. `
    + `Add one more ingredient of any kind. It does not have to be a fee: the contract `
    + `counts ingredients, it never checks what they are, so a token amount routed back `
    + `to yourself satisfies it. Without it the transaction aborts with "At least one `
    + `ingredient besides the fixed fee must be specified".`;
}
