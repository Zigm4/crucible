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
import { buildBlendActions } from '../nefty/execute';
import { buildUpgradeActions } from '../nefty/upgradeExecute';
import { buildClaimActions } from '../nefty/dropExecute';
import { buildWaxdaoBlendActions } from '../waxdao/blendExecute';
import { buildBlenderizerBlendActions } from '../blenderizer/blendExecute';
import type { BuiltAction } from '../chain/action';
import { listBlends } from '../nefty/discover';
import { listUpgrades, loadUpgradeById } from '../nefty/upgrades';
import { listDrops } from '../nefty/drops';
import { listWaxdaoBlends, loadWaxdaoBlendById } from '../waxdao/blends';
import { listBlenderizerBlends, loadBlenderizerBlendById } from '../blenderizer/blends';

export type RunStep = 1 | 2 | 3 | 4;

/**
 * The three things a player wants to do.
 *
 * Not five. The first version made people choose "blend on NeftyBlocks"
 * or "blend on WaxDAO" or "Blenderizer", which asks them to know which
 * company hosts a recipe before they can look for it. That is an
 * implementation detail: the intent is "blend", and finding out where it
 * lives is our job, not theirs. So one action fans out across every
 * contract that can serve it, and the answer says which one it came
 * from.
 */
export const RECIPE_ACTIONS = [
  { key: 'blend', label: 'Blend NFTs',
    blurb: 'Burn some NFTs, get something new',
    where: 'NeftyBlocks, WaxDAO and the Blenderizer, searched together' },
  { key: 'upgrade', label: 'Upgrade an NFT',
    blurb: 'Keep the NFT, change what it says',
    where: 'NeftyBlocks only' },
  { key: 'drop', label: 'Claim a drop',
    blurb: 'Buy or claim a fresh mint',
    where: 'NeftyBlocks only' },
] as const;

export type RecipeAction = typeof RECIPE_ACTIONS[number]['key'];

/** Which contract a row actually came from. Step 4 needs this, people do not. */
export type RecipeSource = 'blend' | 'waxdao' | 'blenderizer' | 'upgrade' | 'drop';

export const SOURCE_INFO: Record<RecipeSource, { platform: string; contract: string }> = {
  blend: { platform: 'NeftyBlocks', contract: 'blend.nefty' },
  waxdao: { platform: 'WaxDAO', contract: 'waxdaomarket' },
  blenderizer: { platform: 'Blenderizer', contract: 'blenderizerx' },
  upgrade: { platform: 'NeftyBlocks', contract: 'up.nefty' },
  drop: { platform: 'NeftyBlocks', contract: 'neftyblocksd' },
};

/** Every contract that can serve one action. */
const SOURCES_FOR: Record<RecipeAction, RecipeSource[]> = {
  blend: ['blend', 'waxdao', 'blenderizer'],
  upgrade: ['upgrade'],
  drop: ['drop'],
};

/** The action a source belongs to, for a deep link that names only the source. */
export function actionOf(source: RecipeSource): RecipeAction {
  return (Object.keys(SOURCES_FOR) as RecipeAction[])
    .find((a) => SOURCES_FOR[a].includes(source)) ?? 'blend';
}

/** One row in the picker, whatever platform it came from. */
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
  /** Asset ids that satisfy this slot, for the picker in step 4. */
  candidates: string[];
  kind: 'nft' | 'token' | 'other';
  /**
   * What the contract does with what you put here. Not decoration: an
   * upgrade's target NFT comes back to you and its cost NFTs do not, and
   * a screen that called both "burned" would be lying about the one
   * thing a player most wants to be sure of.
   */
  role: 'burn' | 'keep' | 'upgrade' | 'pay' | 'unknown';
  /**
   * The contract's own index for this slot, where it has one. WaxDAO and
   * the Blenderizer both take a map keyed by it, so a picked asset has to
   * find its way back to the right slot rather than to a position in our
   * own list.
   */
  slot?: number;
}

export interface RecipeChoice {
  id: string;
  name: string;
  /** A second line: what it produces, or why it cannot be run. */
  note: string;
  /** False when the contract says it is over, sold out or not started. */
  live: boolean;
  /** Which contract served it. Shown as a badge, never asked for. */
  source: RecipeSource;
  /**
   * The row the lister returned, kept as-is.
   *
   * Step 4 needs the full recipe, and there is no loadDropById to fetch
   * one back. Holding what we already read is not only simpler, it is
   * safer: the detail screen can never disagree with the row that was
   * clicked, which a second fetch could.
   */
  raw: unknown;
}

/**
 * Every recipe one action can reach, in one collection, in one shape.
 *
 * Each contract's lister returns something different, which is right for
 * the contract and wrong for a picker. This is the only place that knows
 * about all five, so adding a sixth is one entry here rather than a new
 * branch on every screen.
 *
 * A blend fans out across three contracts at once. They are independent
 * reads, so one being slow or down does not cost the others: a lister
 * that throws contributes nothing and the rest still answer. Reporting
 * "no blends here" because WaxDAO timed out would be worse than showing
 * the Nefty ones.
 */
async function listOneSource(
  source: RecipeSource, c: string, actor: string,
): Promise<RecipeChoice[]> {
  if (source === 'blend') {
    const { blends } = await listBlends({ collection: c, includeInactive: false, actor });
    return blends.map((b) => ({
      source, raw: b, id: String(b.blend_id),
      name: b.name || `Blend #${b.blend_id}`,
      note: b.is_random ? 'random result' : 'always the same result',
      live: b.status === 'active',
    }));
  }
  if (source === 'waxdao') {
    const { blends } = await listWaxdaoBlends({ collection: c, includeInactive: false });
    return blends.map((b) => ({
      source, raw: b, id: String(b.blend_id),
      name: b.title || `Blend #${b.blend_id}`,
      note: b.blends_remaining > 0 ? `${b.blends_remaining} left` : 'no limit stated',
      live: b.status === 'active',
    }));
  }
  if (source === 'blenderizer') {
    const { blends } = await listBlenderizerBlends({ collection: c });
    return blends.map((b) => ({
      source, raw: b, id: String(b.blend_id),
      name: b.name || `Blenderizer #${b.blend_id}`,
      note: 'swaps NFTs inside the collection',
      live: true,
    }));
  }
  if (source === 'upgrade') {
    const { upgrades } = await listUpgrades({ collection: c, includeInactive: false });
    return upgrades.map((u) => ({
      source, raw: u, id: String(u.upgrade_id),
      name: u.name || `Upgrade #${u.upgrade_id}`,
      note: 'rewrites an NFT you keep',
      live: u.status === 'active',
    }));
  }
  const { drops } = await listDrops({ collection: c, includeInactive: false });
  return drops.map((d) => ({
    source, raw: d, id: String(d.drop_id),
    name: d.name || `Drop #${d.drop_id}`,
    // listing_price is the raw asset string, and "0.00000000 WAX" is how
    // the contract says free. Saying so beats printing eight zeroes.
    note: /[1-9]/.test(String(d.listing_price).split(' ')[0].replace('.', ''))
      ? String(d.listing_price) : 'free',
    live: d.status === 'active',
  }));
}

export interface RecipeResults {
  choices: RecipeChoice[];
  /** Contracts that failed, so the screen can say what it could not read. */
  unreachable: RecipeSource[];
}

export async function listRecipes(
  action: RecipeAction, collection: string, actor: string,
): Promise<RecipeResults> {
  const c = collection.trim().toLowerCase();
  if (!c) return { choices: [], unreachable: [] };
  const sources = SOURCES_FOR[action] ?? [];
  const settled = await Promise.allSettled(
    sources.map((src) => listOneSource(src, c, actor)),
  );
  const choices: RecipeChoice[] = [];
  const unreachable: RecipeSource[] = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') choices.push(...r.value);
    else unreachable.push(sources[i]);
  });
  // Running first, then by name. Which contract it came from is a badge,
  // not a sort key: sorting by platform would rebuild the grouping the
  // player was just spared from choosing.
  choices.sort((x, y) =>
    Number(y.live) - Number(x.live) || x.name.localeCompare(y.name));
  return { choices, unreachable };
}

export interface RunState {
  /** What the person said they wanted to do, on the first screen. */
  action: RecipeAction | '';
  /** Which contract the recipe they picked actually lives on. */
  source: RecipeSource | '';
  collection: string;
  /** The recipes that action can reach in that collection. */
  choices: RecipeChoice[];
  /** Contracts that would not answer, so the screen can say so. */
  unreachable: RecipeSource[];
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
  /** The row they clicked on step 3, kept so step 4 needs no second read. */
  pickedRecipe?: RecipeChoice;
  /** Which slot's candidate list is open, if any. */
  openSlot?: number;
  /** Set while a wallet dialog is open, so nothing double-signs. */
  signing: boolean;
  /** The transaction id, once one exists. */
  lastTrxId: string;
}

export function emptyRunState(): RunState {
  return {
    action: '', source: '', collection: '', choices: [], listing: false, listError: '',
    unreachable: [],
    blendId: '', loading: false, error: '', step: 1,
    owner: '', assets: [], assetsFor: '', picked: {}, signing: false, lastTrxId: '',
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
      return { text: `Pay ${p.quantity}`, need: 1, candidates: [], kind: 'token' as const, role: 'pay' as const };
    }
    if (kind === 'CHEST_INGREDIENT' || kind === 'BALANCE_INGREDIENT') {
      return {
        text: `Spend ${p.cost} from an NFT's ${p.attribute_name} balance`,
        need: 1, candidates: [], kind: 'other' as const, role: 'unknown' as const,
      };
    }
    if (kind === 'COOLDOWN_INGREDIENT') {
      return { text: 'Wait out this recipe’s cooldown', need: 1, candidates: [], kind: 'other' as const, role: 'unknown' as const };
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
      // blend.nefty burns or transfers every NFT ingredient. Which of the
      // two is in the ingredient's `effect`, which the row does not
      // decode, so the honest word is the one that is always true: it
      // leaves your wallet.
      role: 'burn' as const,
      slot: undefined,
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

/**
 * Cost and reward for the four contracts that are not blend.nefty.
 *
 * Same two questions, same two shapes, read from the row the picker
 * already had. Written per contract rather than generically because the
 * four say genuinely different things: a Blenderizer recipe always burns
 * templates and always mints one, a drop charges a price and mints, an
 * upgrade keeps your NFT and rewrites a field. Pretending they are one
 * thing would produce a sentence that fits none of them.
 *
 * Ownership counting reuses the same rule as blends where the ingredient
 * is an NFT, so "you have 3" means the same thing on every screen.
 */
export interface RecipeDetail {
  requirements: Requirement[];
  rewards: Reward[];
  /** False when the result is drawn rather than fixed. */
  sure: boolean;
  /** One line of context above the two lists, or ''. */
  note: string;
}

const countOwned = (assets: AtomicAsset[], pred: (a: AtomicAsset) => boolean) =>
  assets.filter(pred).length;

/** Everything the four non-blend.nefty sources say, in the shared shape. */
export function describeRecipe(
  source: RecipeSource, raw: unknown, assets: AtomicAsset[], known: boolean,
): RecipeDetail | undefined {
  const have = (n: number) => (known ? n : undefined);

  if (source === 'waxdao') {
    const b = raw as {
      ingredients?: WaxdaoLike[]; results?: { nft_name?: string; template_id?: number; result_type?: string }[];
      blends_remaining?: number;
      nftSlots?: { slot: number }[];
    };
    // waxdaomarket takes a map keyed by ITS slot index, not by position
    // in our list, so each NFT requirement carries the slot the contract
    // gave it. nftSlots is pre-computed by the lister for exactly this.
    const slots = (b.nftSlots ?? []).map((x) => x.slot);
    let nftSeen = -1;
    const requirements: Requirement[] = (b.ingredients ?? []).map((ing) => {
      if (ing.kind === 'fungible') {
        return { text: `Pay ${ing.quantity}`, need: 1, candidates: [], kind: 'token' as const, role: 'pay' as const };
      }
      nftSeen += 1;
      const slot = slots[nftSeen];
      const amount = Number(ing.amount ?? 1) || 1;
      const fate = ing.burn === false ? 'kept' : 'burned';
      const role = ing.burn === false ? ('keep' as const) : ('burn' as const);
      if (ing.kind === 'nft_template') {
        const n = countOwned(assets, (a) => String(a.template?.template_id ?? '') === String(ing.template_id));
        const cands = assets.filter((a) => String(a.template?.template_id ?? '') === String(ing.template_id))
          .map((a) => a.asset_id);
        return { text: `${amount} x template #${ing.template_id} (${fate})`, need: amount, have: have(n),
                 candidates: cands, kind: 'nft' as const, role, slot };
      }
      if (ing.kind === 'nft_schema') {
        const n = countOwned(assets, (a) => a.collection?.collection_name === ing.collection_name
          && a.schema?.schema_name === ing.schema_name);
        const cands = assets.filter((a) => a.collection?.collection_name === ing.collection_name
          && a.schema?.schema_name === ing.schema_name).map((a) => a.asset_id);
        return { text: `${amount} x any ${ing.schema_name} NFT (${fate})`, need: amount, have: have(n),
                 candidates: cands, kind: 'nft' as const, role, slot };
      }
      if (ing.kind === 'nft_collection') {
        const n = countOwned(assets, (a) => a.collection?.collection_name === ing.collection_name);
        const cands = assets.filter((a) => a.collection?.collection_name === ing.collection_name)
          .map((a) => a.asset_id);
        return { text: `${amount} x any NFT from ${ing.collection_name} (${fate})`, need: amount, have: have(n),
                 candidates: cands, kind: 'nft' as const, role, slot };
      }
      if (ing.kind === 'nft_attribute') {
        // The attribute conditions are not decoded by the lister, so the
        // count would be wrong. Left unchecked rather than guessed.
        // The lister does not decode the attribute conditions, so we
        // cannot say which NFTs qualify. Offering a guess here would
        // build a transaction the contract rejects.
        return { text: `${amount} x ${ing.schema_name} matching this recipe's attribute rule`,
                 need: amount, candidates: [], kind: 'other' as const, role: 'unknown' as const, slot };
      }
      return { text: 'An ingredient this page cannot read yet', need: 1, candidates: [], kind: 'other' as const, role: 'unknown' as const };
    });
    // nft_name is not trustworthy. Blend 1547 on underpunks55 carries the
    // literal string "name" there, which is the contract's placeholder,
    // not a title. Anything that looks like the field's own label is
    // dropped in favour of the template id, which is always real.
    const rewards: Reward[] = (b.results ?? []).map((r) => {
      const n = String(r.nft_name ?? '').trim();
      const real = n && !['name', 'nft_name', 'null', 'undefined'].includes(n.toLowerCase());
      const amount = Number((r as { amount?: number }).amount ?? 1) || 1;
      const what = real ? n : r.template_id ? `template #${r.template_id}` : (r.result_type || 'a reward');
      return { text: amount > 1 ? `${amount} x ${what}` : what };
    });
    return { requirements, rewards, sure: true, note: '' };
  }

  if (source === 'blenderizer') {
    const b = raw as {
      slots?: { index: number; template_id: number; amount: number }[];
      name?: string; target?: number; target_issued?: number; target_max?: number;
    };
    const requirements: Requirement[] = (b.slots ?? []).map((sl) => {
      const cands = assets.filter((a) => String(a.template?.template_id ?? '') === String(sl.template_id))
        .map((a) => a.asset_id);
      const amount = Number(sl.amount ?? 1) || 1;
      return { text: `${amount} x template #${sl.template_id} (burned)`, need: amount,
               have: have(cands.length), candidates: cands, kind: 'nft' as const,
               role: 'burn' as const, slot: sl.index };
    });
    const left = Number(b.target_max ?? 0) > 0
      ? `${Number(b.target_max) - Number(b.target_issued ?? 0)} left of ${b.target_max}`
      : 'no cap';
    return {
      requirements,
      rewards: [{ text: b.name || `template #${b.target}` }],
      sure: true,
      note: `The Blenderizer always mints the same template. ${left}.`,
    };
  }

  if (source === 'upgrade') {
    const u = raw as {
      ingredients?: UpgradeLike[];
      specs?: { schema_name: string; results?: { attribute_name: string; immediate_value?: string | number; is_random?: boolean }[] }[];
      is_random?: boolean;
      acceptedTemplateIds?: number[];
    };
    // The NFT being upgraded is NOT an ingredient. up.nefty takes it in a
    // field of its own and hands it back changed, so it needs a slot on
    // this screen that the contract's ingredient list never mentions.
    // Without it there is nothing to pick and nothing to sign.
    const accepted = (u.acceptedTemplateIds ?? []).map(String);
    const targets = accepted.length
      ? assets.filter((a) => accepted.includes(String(a.template?.template_id ?? '')))
      : [];
    const targetReq: Requirement = {
      text: accepted.length === 1
        ? `The NFT to upgrade: template #${accepted[0]}`
        : `The NFT to upgrade: any of ${accepted.length} accepted template(s)`,
      need: 1,
      have: known ? targets.length : undefined,
      candidates: targets.map((a) => a.asset_id),
      kind: 'nft',
      role: 'upgrade',
    };
    const requirements: Requirement[] = [targetReq, ...(u.ingredients ?? []).map((ing) => {
      if (ing.kind === 'ft') {
        return { text: `Pay ${ing.quantity}`, need: 1, candidates: [], kind: 'token' as const, role: 'pay' as const };
      }
      const amount = Number(ing.amount ?? 1) || 1;
      if (ing.kind === 'template') {
        const n = countOwned(assets, (a) => String(a.template?.template_id ?? '') === String(ing.template_id));
        const cands = assets.filter((a) => String(a.template?.template_id ?? '') === String(ing.template_id))
          .map((a) => a.asset_id);
        return { text: `${amount} x template #${ing.template_id}`, need: amount, have: have(n),
                 candidates: cands, kind: 'nft' as const, role: 'burn' as const };
      }
      if (ing.kind === 'schema') {
        const n = countOwned(assets, (a) => a.collection?.collection_name === ing.collection_name
          && a.schema?.schema_name === ing.schema_name);
        const cands = assets.filter((a) => a.collection?.collection_name === ing.collection_name
          && a.schema?.schema_name === ing.schema_name).map((a) => a.asset_id);
        return { text: `${amount} x any ${ing.schema_name} NFT`, need: amount, have: have(n),
                 candidates: cands, kind: 'nft' as const, role: 'burn' as const };
      }
      if (ing.kind === 'collection') {
        const n = countOwned(assets, (a) => a.collection?.collection_name === ing.collection_name);
        const cands = assets.filter((a) => a.collection?.collection_name === ing.collection_name)
          .map((a) => a.asset_id);
        return { text: `${amount} x any NFT from ${ing.collection_name}`, need: amount, have: have(n),
                 candidates: cands, kind: 'nft' as const, role: 'burn' as const };
      }
      if (ing.kind === 'balance') {
        return { text: `Spend ${ing.cost} from an NFT's ${ing.attribute_name} balance`,
                 need: 1, candidates: [], kind: 'other' as const, role: 'unknown' as const };
      }
      return { text: `${amount} x ${ing.schema_name ?? 'an'} NFT matching this recipe's attribute rule`,
               need: amount, candidates: [], kind: 'other' as const, role: 'unknown' as const };
    })];
    // An attribute value can be an IPFS hash, which is a correct answer
    // and a useless one to read. Long opaque values are shortened rather
    // than printed whole; the attribute name is the part that matters.
    const short = (v: string | number) => {
      const t = String(v);
      return t.length > 28 ? `${t.slice(0, 10)}…${t.slice(-6)}` : t;
    };
    const rewards: Reward[] = (u.specs ?? []).flatMap((sp) =>
      (sp.results ?? []).map((r) => ({
        text: r.is_random || r.immediate_value === undefined
          ? `${sp.schema_name}: ${r.attribute_name} changes to something drawn at random`
          : `${sp.schema_name}: ${r.attribute_name} becomes ${short(r.immediate_value)}`,
      })));
    return {
      requirements, rewards, sure: !u.is_random,
      note: 'You keep the NFT. An upgrade rewrites what it says, it does not burn it.',
    };
  }

  if (source === 'drop') {
    const d = raw as {
      listing_price?: string; is_free?: boolean;
      assets_to_mint?: { template_id: number }[];
      max_claimable?: number; current_claimed?: number; account_remaining?: number;
    };
    const paid = !d.is_free
      && /[1-9]/.test(String(d.listing_price ?? '').split(' ')[0].replace('.', ''));
    const requirements: Requirement[] = paid
      ? [{ text: `Pay ${d.listing_price}`, need: 1, candidates: [], kind: 'token' as const, role: 'pay' as const }]
      : [];
    const rewards: Reward[] = (d.assets_to_mint ?? []).map((m) => ({ text: `template #${m.template_id}` }));
    const cap = Number(d.max_claimable ?? 0) > 0
      ? `${Number(d.max_claimable) - Number(d.current_claimed ?? 0)} of ${d.max_claimable} left`
      : 'no overall cap';
    return {
      requirements, rewards, sure: true,
      note: paid
        ? `A drop mints straight to you. ${cap}.`
        : `Free. A drop mints straight to you. ${cap}.`,
    };
  }
  return undefined;
}

/** Structural shapes, kept local so this file does not import five types. */
type WaxdaoLike = {
  kind: string; quantity?: string; amount?: number; burn?: boolean;
  template_id?: number; schema_name?: string; collection_name?: string;
};
type UpgradeLike = {
  kind: string; quantity?: string; amount?: number; template_id?: number;
  schema_name?: string; collection_name?: string; attribute_name?: string; cost?: number;
};

/**
 * One recipe row, fetched by id.
 *
 * Only needed when somebody arrives by a shared link: clicking through
 * the picker already has the row in hand. Without this, a pasted
 * #/lab/run/waxdao~coll~1547 reached step 4 with nothing to describe and
 * showed a dead end, which is exactly what a shared link must not do.
 *
 * Drops have no loader of their own, so the collection is listed and the
 * id picked out of it. That needs the collection, which the link carries.
 */
export async function loadRecipeById(
  source: RecipeSource, id: string, collection: string, actor: string,
): Promise<RecipeChoice | undefined> {
  const info = SOURCE_INFO[source];
  const wrap = (name: string, raw: unknown, live: boolean, note = ''): RecipeChoice =>
    ({ source, raw, id, name, note, live });
  try {
    if (source === 'waxdao') {
      const b = await loadWaxdaoBlendById(id);
      return b ? wrap(b.title || `Blend #${id}`, b, b.status === 'active') : undefined;
    }
    if (source === 'blenderizer') {
      const b = await loadBlenderizerBlendById(id);
      return b ? wrap(b.name || `Blenderizer #${id}`, b, true) : undefined;
    }
    if (source === 'upgrade') {
      const u = await loadUpgradeById(id);
      return u ? wrap(u.name || `Upgrade #${id}`, u, u.status === 'active') : undefined;
    }
    if (source === 'drop') {
      if (!collection) return undefined;
      const { choices } = await listRecipes('drop', collection, actor);
      return choices.find((c) => c.id === id);
    }
  } catch { /* a link to something unreadable says so on screen */ }
  void info;
  return undefined;
}

/**
 * The transaction, for whichever contract the recipe lives on.
 *
 * Every builder here is the one the main app already signs with, and
 * each is covered by its own byte-for-byte replay suite. Nothing new is
 * constructed: this only routes the player's picks into the right shape
 * for the right contract, which is the whole reason the picks carry a
 * `slot` and a `role` rather than just an order.
 *
 * Throws with a sentence rather than returning an empty list. A caller
 * that signed nothing would look like success.
 */
export async function buildRunActions(args: {
  source: RecipeSource;
  actor: string;
  id: string;
  raw: unknown;
  requirements: Requirement[];
  /** Asset ids the person picked, keyed by requirement index. */
  picked: Record<number, string[]>;
}): Promise<BuiltAction[]> {
  const { source, actor, id, raw, requirements, picked } = args;
  if (!actor) throw new Error('Connect a wallet first.');

  const chosen = (i: number) => picked[i] ?? [];
  const tokens = requirements.filter((r) => r.kind === 'token')
    .map((r) => r.text.replace(/^Pay\s+/, '').trim());

  // Every NFT slot has to be full. The contracts reject a short list, and
  // finding that out from a failed transaction costs CPU and confidence.
  requirements.forEach((r, i) => {
    if (r.kind !== 'nft') return;
    if (chosen(i).length !== r.need) {
      throw new Error(`Pick ${r.need} for "${r.text}" (you picked ${chosen(i).length}).`);
    }
  });

  if (source === 'blend') {
    const b = raw as { security_id?: string | number };
    const secure = Number(b?.security_id ?? 0) !== 0;
    return buildBlendActions({
      claimer: actor,
      blend_id: id,
      // Flat, in ingredient order: that is the order blend.nefty reads.
      asset_ids: requirements.flatMap((r, i) => (r.kind === 'nft' ? chosen(i) : [])),
      ft_payments: tokens,
      secure,
      // The plain no-op gate. A secure blend whose whitelist the wallet
      // is not on fails on chain, which is the contract's answer to give,
      // not ours to guess at.
      security_check: { kind: 'whitelist', account_name: actor },
    });
  }

  if (source === 'waxdao') {
    const selection = new Map<number, string | string[]>();
    requirements.forEach((r, i) => {
      if (r.kind !== 'nft' || r.slot === undefined) return;
      const ids = chosen(i);
      selection.set(r.slot, ids.length === 1 ? ids[0] : ids);
    });
    return buildWaxdaoBlendActions({
      claimer: actor,
      blend: raw as Parameters<typeof buildWaxdaoBlendActions>[0]['blend'],
      nftSelection: selection,
    });
  }

  if (source === 'blenderizer') {
    const selection = new Map<number, string[]>();
    requirements.forEach((r, i) => {
      if (r.kind !== 'nft' || r.slot === undefined) return;
      selection.set(r.slot, chosen(i));
    });
    return buildBlenderizerBlendActions({
      claimer: actor,
      blend: raw as Parameters<typeof buildBlenderizerBlendActions>[0]['blend'],
      selection,
    });
  }

  if (source === 'upgrade') {
    // The two roles go to two different fields. Mixing them would burn
    // the NFT somebody meant to keep.
    const target = requirements.flatMap((r, i) => (r.role === 'upgrade' ? chosen(i) : []));
    const cost = requirements.flatMap((r, i) =>
      (r.kind === 'nft' && r.role !== 'upgrade' ? chosen(i) : []));
    if (!target.length) throw new Error('Pick the NFT you want to upgrade.');
    return buildUpgradeActions({
      claimer: actor,
      upgrade_id: id,
      assets_to_upgrade: target,
      transferred_assets: cost,
      ft_payments: tokens,
    });
  }

  return buildClaimActions({
    claimer: actor,
    drop: raw as Parameters<typeof buildClaimActions>[0]['drop'],
    amount: 1,
    proof_asset_ids: requirements.flatMap((r, i) => (r.role === 'unknown' ? chosen(i) : [])),
  });
}

/**
 * Fills every NFT slot with the first matching NFTs the wallet holds.
 *
 * Somebody who owns exactly what a recipe asks for should be able to
 * press one button, and most people do not care which of their four
 * identical commons gets burned. Anyone who does can change it; this
 * only ever picks where nothing was picked, so it never overrides a
 * choice somebody made.
 */
export function autoPick(
  reqs: Requirement[], picked: Record<number, string[]>,
): Record<number, string[]> {
  const next = { ...picked };
  // Across slots, never the same asset twice: one NFT cannot fill two
  // ingredients, and the contract would reject the duplicate.
  const taken = new Set(Object.values(next).flat());
  reqs.forEach((r, i) => {
    if (r.kind !== 'nft' || next[i]?.length) return;
    const free = r.candidates.filter((id) => !taken.has(id)).slice(0, r.need);
    if (free.length) {
      next[i] = free;
      free.forEach((id) => taken.add(id));
    }
  });
  return next;
}

/** Everything a slot still needs before this can be signed. */
export function whatIsMissing(reqs: Requirement[], picked: Record<number, string[]>): string[] {
  const out: string[] = [];
  reqs.forEach((r, i) => {
    if (r.kind === 'nft' && (picked[i]?.length ?? 0) !== r.need) {
      out.push(`${r.text}: ${picked[i]?.length ?? 0} of ${r.need} picked`);
    }
    if (r.kind === 'other') out.push(`${r.text}: this page cannot pick this one for you`);
  });
  return out;
}

/** Which steps a person may jump to: never past one that is not answered. */
export function furthestStep(st: RunState): RunStep {
  if (!st.blend) return 1;
  return 4;
}
