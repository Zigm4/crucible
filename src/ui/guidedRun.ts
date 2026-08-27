/**
 * Running a recipe, asked as questions instead of shown as a form.
 *
 * The creator side of this lab already works this way: one question per
 * screen, a rail that says where you are, and a review that reads back
 * what you built before anything is signed. The consumer side does not.
 * Executing a blend today means reading a dense card and pressing a
 * button, and the two things a person actually wants to know, what this
 * takes from me and what I get, are mixed in with everything else.
 *
 * So the same four questions, in the order people ask them:
 *
 *   1. What is this?          the recipe, and whether it is a sure thing
 *   2. What does it cost me?  every ingredient, checked against what you own
 *   3. What do I get?         outcomes, with the odds drawn rather than listed
 *   4. Ready?                 both halves side by side, then sign
 *
 * The value is in step 2. An ingredient is a tagged variant with a
 * template id or a schema name in it, which tells a person nothing. Here
 * each one becomes a sentence, and each sentence carries a live count of
 * how many matching NFTs the wallet holds. A recipe you cannot afford
 * says so on the screen where you would have found out, not after you
 * signed.
 */
import type { BlendRow, IngredientVariant } from '../nefty/blend';
import { isDeterministic, deterministicResults, poolDraws, oddsAreCertain } from '../nefty/blend';
import { listAssetsForOwner, type AtomicAsset } from '../atomic/assets';
import { listBlends } from '../nefty/discover';
import { listUpgrades } from '../nefty/upgrades';
import { listDrops } from '../nefty/drops';
import { listWaxdaoBlends } from '../waxdao/blends';
import { listBlenderizerBlends } from '../blenderizer/blends';

export type RunStep = 1 | 2 | 3 | 4;

/**
 * The five things a player can actually run on WAX through these
 * contracts. Named the way somebody would describe them out loud, not
 * the way the contracts are organised, because the first screen has to
 * be answerable by somebody who does not know what a contract is.
 */
export const RECIPE_KINDS = [
  { key: 'blend', platform: 'NeftyBlocks', label: 'Blend NFTs',
    blurb: 'Burn some NFTs, get a new one', contract: 'blend.nefty' },
  { key: 'upgrade', platform: 'NeftyBlocks', label: 'Upgrade an NFT',
    blurb: 'Keep the NFT, change what it says', contract: 'up.nefty' },
  { key: 'drop', platform: 'NeftyBlocks', label: 'Claim a drop',
    blurb: 'Buy or claim a fresh mint', contract: 'neftyblocksd' },
  { key: 'waxdao', platform: 'WaxDAO', label: 'Blend on WaxDAO',
    blurb: 'The same idea, a different contract', contract: 'waxdaomarket' },
  { key: 'blenderizer', platform: 'Blenderizer', label: 'Blenderizer',
    blurb: 'Swap NFTs inside one collection', contract: 'blenderizerx' },
] as const;

export type RecipeKind = typeof RECIPE_KINDS[number]['key'];

/** One row in the picker, whatever platform it came from. */
export interface RecipeChoice {
  id: string;
  name: string;
  /** A second line: what it produces, or why it cannot be run. */
  note: string;
  /** False when the contract says it is over, sold out or not started. */
  live: boolean;
}

/**
 * Every recipe of one kind in one collection, in one shape.
 *
 * Each platform's lister returns something different, which is right for
 * the platform and wrong for a picker. This is the only place that knows
 * about all five, so adding a sixth means one function rather than a new
 * branch on every screen.
 */
export async function listRecipes(
  kind: RecipeKind, collection: string, actor: string,
): Promise<RecipeChoice[]> {
  const c = collection.trim().toLowerCase();
  if (!c) return [];
  if (kind === 'blend') {
    const { blends } = await listBlends({ collection: c, includeInactive: false, actor });
    return blends.map((b) => ({
      id: String(b.blend_id),
      name: b.name || `Blend #${b.blend_id}`,
      note: b.is_random ? 'random result' : 'always the same result',
      live: b.status === 'active',
    }));
  }
  if (kind === 'upgrade') {
    const { upgrades } = await listUpgrades({ collection: c, includeInactive: false });
    return upgrades.map((u) => ({
      id: String(u.upgrade_id),
      name: u.name || `Upgrade #${u.upgrade_id}`,
      note: 'rewrites an NFT you keep',
      live: u.status === 'active',
    }));
  }
  if (kind === 'drop') {
    const { drops } = await listDrops({ collection: c, includeInactive: false });
    return drops.map((d) => ({
      id: String(d.drop_id),
      name: d.name || `Drop #${d.drop_id}`,
      // listing_price is the raw asset string, and "0.00000000 WAX"
      // is how the contract says free. Saying so is friendlier than
      // printing eight zeroes at somebody.
      note: /[1-9]/.test(String(d.listing_price).split(' ')[0].replace('.', ''))
        ? String(d.listing_price) : 'free',
      live: d.status === 'active',
    }));
  }
  if (kind === 'waxdao') {
    const { blends } = await listWaxdaoBlends({ collection: c, includeInactive: false });
    return blends.map((b) => ({
      id: String(b.blend_id),
      name: b.title || `Blend #${b.blend_id}`,
      note: b.blends_remaining > 0 ? `${b.blends_remaining} left` : 'no limit stated',
      live: b.status === 'active',
    }));
  }
  const { blends } = await listBlenderizerBlends({ collection: c });
  return blends.map((b) => ({
    id: String(b.blend_id),
    name: b.name || `Blenderizer #${b.blend_id}`,
    note: 'swaps NFTs inside the collection',
    live: true,
  }));
}

/** One ingredient, turned into something a person can act on. */
export interface Requirement {
  /** A sentence, not a variant name. */
  text: string;
  /** How many the recipe wants. */
  need: number;
  /**
   * How many the wallet holds. Undefined when we cannot tell rather than
   * zero: a token cost we did not check must not read as "you have none".
   */
  have?: number;
  /** Asset ids that satisfy this slot, for the picker in step 2. */
  candidates: string[];
  kind: 'nft' | 'token' | 'other';
}

export interface RunState {
  /** What kind of recipe, chosen on the first screen. */
  kind: RecipeKind | '';
  collection: string;
  /** The recipes of that kind in that collection. */
  choices: RecipeChoice[];
  listing: boolean;
  listError: string;
  /** The one they picked. */
  blendId: string;
  loading: boolean;
  error: string;
  blend?: BlendRow;
  step: RunStep;
  owner: string;
  assets: AtomicAsset[];
  assetsFor: string;
  /** Asset ids the person chose, per requirement index. */
  picked: Record<number, string[]>;
}

export function emptyRunState(): RunState {
  return {
    kind: '', collection: '', choices: [], listing: false, listError: '',
    blendId: '', loading: false, error: '', step: 1,
    owner: '', assets: [], assetsFor: '', picked: {},
  };
}

/**
 * The collections a wallet actually holds NFTs in.
 *
 * Offered as chips on the "which collection" screen, because typing an
 * exact twelve character collection name from memory is the step where
 * people give up. Derived from the inventory we already loaded for the
 * cost check, so it costs no extra request.
 */
export function collectionsOwned(assets: AtomicAsset[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const a of assets) {
    const c = a.collection?.collection_name;
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((x, y) => y.count - x.count || x.name.localeCompare(y.name));
}

/** The name an author gave a recipe, or a fallback that is still useful. */
export function blendTitle(b: BlendRow): string {
  try {
    const d = JSON.parse(b.display_data || '{}') as { name?: string };
    if (d.name) return d.name;
  } catch { /* display_data is author-supplied and often not JSON */ }
  return `Blend #${b.blend_id}`;
}

export function blendImage(b: BlendRow): string | undefined {
  try {
    const d = JSON.parse(b.display_data || '{}') as { image?: string; img?: string };
    return d.image || d.img;
  } catch { return undefined; }
}

/** Whatever an author put in a display_data blob, safely. */
function displayName(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  try {
    const d = JSON.parse(raw) as { name?: string };
    return d.name || fallback;
  } catch { return fallback; }
}

/**
 * Does one asset satisfy one ingredient?
 *
 * Kept beside the sentence that describes the ingredient so the two can
 * never drift: a slot that says "any NFT from the collection" and counts
 * something narrower is worse than no count at all.
 */
function matches(a: AtomicAsset, ing: IngredientVariant): boolean {
  const [kind, p] = ing;
  switch (kind) {
    case 'TEMPLATE_INGREDIENT':
      return String(a.template?.template_id ?? '') === String(p.template_id);
    case 'SCHEMA_INGREDIENT':
      return a.collection?.collection_name === p.collection_name
        && a.schema?.schema_name === p.schema_name;
    case 'COLLECTION_INGREDIENT':
      return a.collection?.collection_name === p.collection_name;
    case 'ATTRIBUTE_INGREDIENT': {
      if (a.collection?.collection_name !== p.collection_name) return false;
      if (a.schema?.schema_name !== p.schema_name) return false;
      // Every named attribute has to be one of its allowed values. The
      // contract requires all of them, so requiring any would offer NFTs
      // the fuse would then reject.
      return (p.attributes ?? []).every((att) => {
        const v = (a.data ?? {})[att.attribute_name];
        return (att.allowed_values ?? []).map(String).includes(String(v));
      });
    }
    default:
      return false;
  }
}

/**
 * Every ingredient as a sentence, with what the wallet can cover.
 *
 * `known` is not decoration. Before the wallet's NFTs are read, "you have
 * 0" is a lie that reads as "you cannot do this", and the first version of
 * this screen printed it under a line admitting no wallet was connected.
 * When we have not looked, `have` stays undefined and the screen says so.
 */
export function requirementsOf(
  b: BlendRow, assets: AtomicAsset[], known = true,
): Requirement[] {
  return (b.ingredients ?? []).map((ing) => {
    const [kind, p] = ing;
    if (kind === 'FT_INGREDIENT') {
      // Deliberately unchecked. A token balance lives on whichever
      // contract issues it, and guessing wrong here would tell someone
      // they cannot afford something they can.
      return { text: `Pay ${p.quantity}`, need: 1, candidates: [], kind: 'token' as const };
    }
    if (kind === 'CHEST_INGREDIENT' || kind === 'BALANCE_INGREDIENT') {
      return {
        text: `Spend ${p.cost} from an NFT's ${p.attribute_name} balance`,
        need: 1, candidates: [], kind: 'other' as const,
      };
    }
    if (kind === 'COOLDOWN_INGREDIENT') {
      return { text: 'Wait out this recipe’s cooldown', need: 1, candidates: [], kind: 'other' as const };
    }

    const candidates = assets.filter((a) => matches(a, ing)).map((a) => a.asset_id);
    const amount = Number((p as { amount?: number }).amount ?? 1) || 1;
    let text: string;
    if (kind === 'TEMPLATE_INGREDIENT') {
      text = `${amount} x template #${p.template_id}`;
    } else if (kind === 'SCHEMA_INGREDIENT') {
      text = `${amount} x any ${displayName(p.display_data, p.schema_name)} NFT`;
    } else if (kind === 'COLLECTION_INGREDIENT') {
      text = `${amount} x any NFT from ${p.collection_name}`;
    } else {
      const conds = (p.attributes ?? [])
        .map((att) => `${att.attribute_name} is ${(att.allowed_values ?? []).join(' or ')}`)
        .join(', ');
      text = `${amount} x ${p.schema_name} where ${conds || 'anything'}`;
    }
    return {
      text, need: amount, candidates,
      have: known ? candidates.length : undefined,
      kind: 'nft' as const,
    };
  });
}

/** True when every NFT slot can be covered by what the wallet holds. */
export function canAfford(reqs: Requirement[]): boolean {
  return reqs.every((r) => r.have === undefined || r.have >= r.need);
}

/** What the recipe hands back, in the same plain terms. */
export interface Reward {
  text: string;
  /** Percent, or undefined when the recipe only ever produces this. */
  odds?: number;
}

export function rewardsOf(b: BlendRow): { sure: boolean; rewards: Reward[] } {
  const det = isDeterministic(b);
  if (det.ok) {
    return {
      sure: true,
      rewards: deterministicResults(b).map((r) => ({ text: `Template #${r.template_id}` })),
    };
  }
  const rewards: Reward[] = [];
  for (const roll of b.rolls ?? []) {
    const total = Number(roll.total_odds) || 0;
    for (const o of roll.outcomes ?? []) {
      const pct = total > 0 ? (Number(o.odds) / total) * 100 : 0;
      const names = (o.results ?? []).map((r) => {
        const [k, payload] = r;
        if (k === 'ON_DEMAND_NFT_RESULT') return `template #${payload.template_id}`;
        if (k === 'FT_RESULT') return payload.quantity;
        return displayName(payload.display_data, `pool ${payload.pool_name}`);
      });
      rewards.push({ text: names.join(' + ') || 'nothing', odds: pct });
    }
  }
  // Pool draws carry their own display data, which is the only place a
  // pool's artwork and name exist, so they are worth naming separately
  // when the odds list would otherwise read as bare pool ids.
  if (!rewards.length) {
    for (const d of poolDraws(b)) {
      rewards.push({ text: displayName(d.display_data, `pool ${d.pool_name}`) });
    }
  }
  return { sure: oddsAreCertain(b), rewards };
}

/** Reads the wallet once, for the ownership counts in step 2. */
export async function loadRunAssets(st: RunState, owner: string): Promise<void> {
  if (!owner || st.assetsFor === owner) return;
  st.assets = [];
  st.assetsFor = '';
  try {
    const assets = await listAssetsForOwner({ owner });
    if (st.owner !== owner) return;
    st.assets = assets;
    st.assetsFor = owner;
  } catch { /* the counts simply stay unknown */ }
}

/** Which steps a person may jump to: never past one that is not answered. */
export function furthestStep(st: RunState): RunStep {
  if (!st.blend) return 1;
  return 4;
}
