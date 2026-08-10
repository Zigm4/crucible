/**
 * NeftyBlocks: the public surface, grouped by what a player does.
 *
 * Five contracts live behind this folder. Nothing here touches the DOM, so
 * every export below runs unchanged in Node. That is not incidental: the
 * verify scripts in `scripts/` import these same functions, feed them the
 * decoded payload of real historical transactions, and compare the result
 * byte for byte against what was actually signed.
 *
 * You do not have to import through this file. Reaching straight into
 * `nefty/upgrades` is equally fine and pulls in less. This exists so that
 * the shape of the folder is readable without opening 25 files.
 *
 * What each mechanic needs, at minimum:
 *
 *   BLEND    blend.nefty     read blend.ts, sign with execute.ts. Random
 *                            blends add rngExecute + rngWait, because the
 *                            oracle decides between two signatures.
 *   CLAIM    neftyblocksd    drops.ts to read and resolve eligibility,
 *                            dropExecute.ts to sign.
 *   UNPACK   atomicpacksx    packs.ts + packExecute.ts + packWait.ts.
 *            neftyblocksp    neftyPacks.ts + neftyPack*.ts. Two separate
 *                            contracts with the same two-signature shape.
 *   UPGRADE  up.nefty        upgrades.ts + upgradeExecute.ts.
 *
 * Author-side actions (creating and editing) are grouped at the bottom.
 * See INTEGRATING.md for how the pieces fit together.
 */

// ─── shared ─────────────────────────────────────────────────────────────
export type { BuiltAction } from '../chain/action';
export { loadBlendContractShape } from './abi';
export { loadTemplate, clearTemplateCache, type TemplateInfo } from './template';
export { checkWhitelist, type WhitelistStatus } from './whitelist';
export { loadPool, clearPoolCache, type PoolInfo } from './pools';

// ─── BLEND · blend.nefty ────────────────────────────────────────────────
export {
  loadBlend,
  isDeterministic,
  deterministicResults,
  poolDraws,
  oddsAreCertain,
  parsePoolDisplayData,
  type BlendRow,
} from './blend';
export { listBlends, clearDiscoverCache, type DiscoveredBlend } from './discover';
export { buildBlendActions, executeBlend, type PlanArgs } from './execute';

/** Random blends: sign, wait for the ORNG oracle, then claim. */
export {
  buildFuseActions,
  buildClaimAction,
  executeFuse,
  executeClaim as executeRngClaim,
  type RngPlanArgs,
  type SecurityCheck,
} from './rngExecute';
export { waitForClaim, waitForClaimConsumed, readKnownClaimIds, type ClaimResult } from './rngWait';

// ─── CLAIM · neftyblocksd ───────────────────────────────────────────────
export {
  listDrops,
  remainingClaims,
  clearDropsCache,
  type DiscoveredDrop,
  type DropStatus,
  type DropAuth,
} from './drops';
export { buildClaimActions, executeClaim, type ClaimArgs } from './dropExecute';

// ─── UNPACK · atomicpacksx and neftyblocksp ─────────────────────────────
export {
  listPackDesigns,
  pickOwnedPacks,
  loadPackRolls,
  clearPacksCache,
  type OwnedPack,
  type PackDesign,
} from './packs';
export { buildUnboxAnnounce, buildUnboxClaim, executeUnboxAnnounce } from './packExecute';
export { waitForUnboxAssets } from './packWait';
export { listNeftyPackDesigns, clearNeftyPacksCache } from './neftyPacks';
export {
  buildNeftyUnboxAnnounce,
  buildNeftyUnboxClaim,
  executeNeftyUnboxAnnounce,
} from './neftyPackExecute';
export { waitForNeftyClaim } from './neftyPackWait';

// ─── UPGRADE · up.nefty ─────────────────────────────────────────────────
export {
  listUpgrades,
  loadUpgradeById,
  clearUpgradesCache,
  type DiscoveredUpgrade,
  type UpgradeStatus,
} from './upgrades';
export { buildUpgradeActions, executeUpgrade, type UpgradePlanArgs } from './upgradeExecute';

// ─── author side ────────────────────────────────────────────────────────
export * from './createBlend';
export * from './createUpgrade';
export * from './createDrop';
export * from './admin';
export * from './dropAdmin';
