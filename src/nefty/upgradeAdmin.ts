/**
 * Collection-author actions on an existing `up.nefty` upgrade.
 *
 * This family exists in the ABI and had no builder in this project, which
 * meant an upgrade could be created through Crucible and then never
 * changed again. Blends and drops both had their equivalent; upgrades were
 * the gap.
 *
 * Every action carries an `authorized_account` the contract re-checks
 * against the collection's `authorized_accounts`, so these builders are a
 * convenience: the chain is the real guard.
 *
 * `setupgrdmix` replaces the WHOLE ingredient list, exactly like
 * `setblendmix`. There is no add or remove, so anything not sent stops
 * being required. What an author CANNOT change is the upgrade's results,
 * the attribute rewrites themselves: the ABI has no action for them, so
 * changing what an upgrade does means deleting it and creating a new one.
 */
import type { BuiltAction } from '../chain/action';

const UPGRADE = 'up.nefty';

const auth = (actor: string) => [{ actor, permission: 'active' }];

/** Hide or reveal. Hidden upgrades exist on chain but appear in no list. */
export function buildSetUpgradeHide(
  authorized_account: string,
  upgrade_id: string | number,
  is_hidden: boolean,
): BuiltAction {
  return {
    account: UPGRADE,
    name: 'setupgrdhide',
    authorization: auth(authorized_account),
    data: { authorized_account, upgrade_id: String(upgrade_id), is_hidden },
  };
}

/** Unix SECONDS. 0 for start means "now", 0 for end means "never". */
export function buildSetUpgradeTime(
  authorized_account: string,
  upgrade_id: string | number,
  start_time: number,
  end_time: number,
): BuiltAction {
  return {
    account: UPGRADE,
    name: 'setupgrdtime',
    authorization: auth(authorized_account),
    data: { authorized_account, upgrade_id: String(upgrade_id), start_time, end_time },
  };
}

/** 0 = unlimited. */
export function buildSetUpgradeMax(
  authorized_account: string,
  upgrade_id: string | number,
  new_max_uses: number,
): BuiltAction {
  return {
    account: UPGRADE,
    name: 'setupgrdmax',
    authorization: auth(authorized_account),
    data: { authorized_account, upgrade_id: String(upgrade_id), new_max_uses },
  };
}

/** The JSON blob: {"name":..., "description":..., "image":...}. */
export function buildSetUpgradeData(
  authorized_account: string,
  upgrade_id: string | number,
  display_data: string,
): BuiltAction {
  return {
    account: UPGRADE,
    name: 'setupgrddata',
    authorization: auth(authorized_account),
    data: { authorized_account, upgrade_id: String(upgrade_id), display_data },
  };
}

/** Free-text grouping tag. Cosmetic, changes nothing on chain. */
export function buildSetUpgradeCat(
  authorized_account: string,
  upgrade_id: string | number,
  category: string,
): BuiltAction {
  return {
    account: UPGRADE,
    name: 'setupgrdcat',
    authorization: auth(authorized_account),
    data: { authorized_account, upgrade_id: String(upgrade_id), category },
  };
}

/** `secure.nefty` whitelist id. 0 = open to everyone. */
export function buildSetUpgradeSec(
  authorized_account: string,
  upgrade_id: string | number,
  security_id: string | number,
): BuiltAction {
  return {
    account: UPGRADE,
    name: 'setupgrdsec',
    authorization: auth(authorized_account),
    data: { authorized_account, upgrade_id: String(upgrade_id), security_id: String(security_id) },
  };
}

/**
 * REPLACES the whole ingredient list. `ingredients` must already be
 * encoded as ABI variants (see createBlend's `encodeIngredient`, which
 * up.nefty shares).
 */
export function buildSetUpgradeMix(
  authorized_account: string,
  upgrade_id: string | number,
  ingredients: unknown[],
): BuiltAction {
  return {
    account: UPGRADE,
    name: 'setupgrdmix',
    authorization: auth(authorized_account),
    data: { authorized_account, upgrade_id: String(upgrade_id), ingredients },
  };
}

/** Permanent. The upgrade stops existing. */
export function buildDelUpgrade(
  authorized_account: string,
  upgrade_id: string | number,
): BuiltAction {
  return {
    account: UPGRADE,
    name: 'delupgrade',
    authorization: auth(authorized_account),
    data: { authorized_account, upgrade_id: String(upgrade_id) },
  };
}
