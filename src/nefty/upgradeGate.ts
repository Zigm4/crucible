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
 * The rule, settled through compute_transaction (scripts/verify-upgrade-fee.mjs):
 *
 *   if (config.fixed_fee.amount > 0  AND NOT early.access)
 *     need 2 ingredients or more      "At least one ingredient besides the
 *                                      fixed fee must be specified"
 *     and one of them the fee itself:  "Fixed fee is required"
 *       a token ingredient of the fee's symbol, at least the fee's amount,
 *       sent to config.fee_recipient
 *   else
 *     need 1 or more
 *
 * `early.access` is granted only by `level.3`, which costs 45,000 NEFTY
 * staked against that collection. `setfixedfee` has been called exactly once
 * ever, on 2024-01-31, setting 0.01 WAX to fees.nefty, so the first branch is
 * live today. Measured on pearlhorizon, which has never staked: half the fee
 * is refused, 0.01 NEFTY is refused, 0.01 WAX to anyone but fees.nefty is
 * refused; the fee twice is accepted, since the second line counts as the
 * other ingredient. On underpunks55, at level.3, one line of anything is
 * accepted, with or without the fee.
 *
 * The contract never adds the fee itself. The 0.01 WAX line on 255 recipes
 * was put there by the NeftyBlocks website when it built the transaction.
 * That website is gone, so the creator offers the line instead, and says
 * why, before the chain refuses a recipe without it. An earlier reading of
 * the WASM concluded the contract only counted ingredients, and this module
 * told authors any second line would do: the chain refuses exactly that.
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
  /** Who the fee line has to pay, from the same config. */
  feeRecipient: string;
  /** Whether a new upgrade from this collection must carry the fee line. */
  feeRequired: boolean;
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

/** `up.nefty`'s fixed fee, which arms the whole rule, and who it is paid to. */
export async function readFeeConfig(contract = 'up.nefty'): Promise<{ fixedFee: string; feeRecipient: string }> {
  const rows = await getTableRows<{ fixed_fee: { quantity: string; contract: string }; fee_recipient: string }>({
    code: contract, scope: contract, table: 'config', limit: 1,
  });
  return {
    fixedFee: rows[0]?.fixed_fee ? String(rows[0].fixed_fee.quantity) : '',
    feeRecipient: String(rows[0]?.fee_recipient ?? ''),
  };
}

/** `up.nefty`'s fixed fee alone. */
export async function readFixedFee(contract = 'up.nefty'): Promise<string> {
  return (await readFeeConfig(contract)).fixedFee;
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
    level: '', earlyAccess: false, fixedFee: '', feeRecipient: '', feeRequired: false, minIngredients: 1, known: false,
  };
  if (!collection) return blank;
  try {
    const [level, { fixedFee, feeRecipient }] = await Promise.all([
      readCollectionLevel(collection),
      readFeeConfig(contract),
    ]);
    const earlyAccess = await levelGrants(level, UPGRADE_FEATURE);
    const feeRequired = isPositiveAsset(fixedFee) && !earlyAccess;
    return {
      level,
      earlyAccess,
      fixedFee,
      feeRecipient,
      feeRequired,
      minIngredients: feeRequired ? 2 : 1,
      known: true,
    };
  } catch {
    return blank;
  }
}

/** An ingredient as far as the fee rule cares: a token amount and who receives it, or neither. */
export interface GateIngredient {
  quantity?: string;
  to?: string;
}

/** An asset string as an integer count of its smallest unit, and its symbol. */
function units(asset: string): { amount: bigint; decimals: number; symbol: string } | undefined {
  const m = /^(\d+)(?:\.(\d+))?\s+([A-Z]{1,7})$/.exec(String(asset).trim());
  if (!m) return undefined;
  const decimals = (m[2] ?? '').length;
  return { amount: BigInt(`${m[1]}${m[2] ?? ''}`), decimals, symbol: m[3] };
}

/** Whether `line` pays the fee: its symbol and precision, at least its amount, to its recipient. */
export function isFeeLine(gate: UpgradeGate, line: GateIngredient): boolean {
  const fee = units(gate.fixedFee);
  const paid = line.quantity ? units(line.quantity) : undefined;
  if (!fee || !paid || !gate.feeRecipient) return false;
  return paid.symbol === fee.symbol && paid.decimals === fee.decimals
    && paid.amount >= fee.amount && String(line.to ?? '').trim() === gate.feeRecipient;
}

/** The line to add when the fee is missing: exactly the fee, to its recipient. */
export function feeLine(gate: UpgradeGate): { quantity: string; to: string } {
  return { quantity: gate.fixedFee, to: gate.feeRecipient };
}

/**
 * The sentence to show an author, or '' when there is nothing to say.
 *
 * Written to be actionable rather than alarming: the fix is the fee line,
 * which the creator adds in one click, and one ingredient of the upgrade's
 * own. Silent when the gate could not be read, and when no fee is due.
 */
export function upgradeGateProblem(gate: UpgradeGate, ingredients: GateIngredient[]): string {
  if (!gate.known || !gate.feeRequired) return '';
  const where = gate.level && gate.level !== 'level.zero'
    ? `is ${gate.level}`
    : gate.level === 'level.zero'
      ? 'is level.zero'
      : 'has never staked NEFTY';
  if (!ingredients.some((i) => isFeeLine(gate, i))) {
    return `up.nefty will refuse this: the collection ${where}, and below level.3 `
      + `(45,000 NEFTY staked against it) a new upgrade has to carry NeftyBlocks' fixed fee `
      + `as one of its ingredients: ${gate.fixedFee} sent to ${gate.feeRecipient}, paid by the player `
      + `on every upgrade. Without it the chain answers "Fixed fee is required".`;
  }
  if (ingredients.length < gate.minIngredients) {
    return `The fee line is there, but it does not count as the upgrade's own cost: up.nefty wants `
      + `at least one more ingredient besides it. Without one the chain answers "At least one `
      + `ingredient besides the fixed fee must be specified".`;
  }
  return '';
}
