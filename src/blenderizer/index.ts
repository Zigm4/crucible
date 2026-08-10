/**
 * The Blenderizer: `blenderizerx`, by 3DkRender.
 *
 * Two files, no dependency on `nefty/`. The simplest of the three
 * platforms by a wide margin: a recipe is executed by ONE action, an
 * `atomicassets::transfer` whose memo is the target template id. There is
 * no announce, no claim, no oracle.
 *
 * Two things have no equivalent elsewhere. Recipes are keyed by their
 * TARGET template rather than by a recipe id, so that id is what a
 * shareable link carries. And the contract mints from RAM the collection
 * author pre-paid, so a collection with an empty `rambalance` fails every
 * recipe until it is topped up: read it with `readBlenderizerRam` before
 * offering to sign.
 */
export {
  listBlenderizerBlends,
  loadBlenderizerBlendById,
  readBlenderizerRam,
  BLENDERIZER_CONTRACT,
  LARGE_MIXTURE_WARN,
  type DiscoveredBlenderizerBlend,
  type BlenderizerStatus,
} from './blends';
export {
  buildBlenderizerBlendActions,
  executeBlenderizerBlend,
  flattenBlenderizerSelection,
  type BlenderizerPlanArgs,
} from './blendExecute';
export type { BuiltAction } from '../chain/action';
