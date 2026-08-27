/**
 * The link between "what I own" and "what I can do with it".
 *
 * The two lab tools were islands. The inventory answered "what is this",
 * the runner answered "what does this recipe need", and joining the two
 * meant reading a template id off one screen and typing it into another.
 * That is the single thing that made them feel like two demos rather
 * than one tool.
 *
 * This asks the question the other way round: given ONE NFT, what on
 * chain will take it? Three answers, because there are three shapes:
 *
 *   - it IS a pack, so it can be opened
 *   - a blend burns it
 *   - an upgrade takes it, either as the NFT being upgraded or as cost
 *
 * Every answer carries a deep link into the runner, so the join is a
 * click rather than a retyped number.
 *
 * Deliberately scoped to the asset's OWN collection. A recipe in another
 * collection can still name your template, but scanning every collection
 * on WAX to find out is not a page load, it is a crawl. The collection an
 * NFT belongs to is where its recipes almost always live, and the screen
 * says that is what it looked at rather than implying it looked further.
 */
import type { AtomicAsset } from '../atomic/assets';
import { listBlends, clearDiscoverCache } from '../nefty/discover';
import { listUpgrades, clearUpgradesCache } from '../nefty/upgrades';
import { clearAtomicIndexerDown, atomicIndexerDown } from '../chain/rpc';
import { listPackDesigns } from '../nefty/packs';
import { listNeftyPackDesigns } from '../nefty/neftyPacks';
import {
  resolveTokenContract, readTokenBalanceRaw, symbolFromQuantity, covers,
} from '../nefty/tokens';
import type { IngredientVariant } from '../nefty/blend';

/** One thing this NFT can be fed to, and where to go to do it. */
export interface Use {
  /** The runner subject: `<source>~<collection>~<id>`. */
  link: string;
  label: string;
  /** Why this NFT qualifies, in a few words. */
  because: string;
  kind: 'pack' | 'blend' | 'upgrade';
  /** False when the recipe is not currently running. */
  live: boolean;
}

export interface Uses {
  uses: Use[];
  /** Collections actually read, so the screen can say what it looked at. */
  scanned: string;
  /** True when a contract did not answer, so the list may be short. */
  partial: boolean;
  /** Recipes whose ingredient shape this could not evaluate. */
  unreadable: number;
}

/** Does one blend ingredient accept this asset? Same rule the runner uses. */
function ingredientTakes(a: AtomicAsset, ing: IngredientVariant): boolean {
  const [kind, p] = ing;
  if (kind === 'TEMPLATE_INGREDIENT') {
    return String(a.template?.template_id ?? '') === String(p.template_id);
  }
  if (kind === 'SCHEMA_INGREDIENT') {
    return a.collection?.collection_name === p.collection_name
      && a.schema?.schema_name === p.schema_name;
  }
  if (kind === 'COLLECTION_INGREDIENT') {
    return a.collection?.collection_name === p.collection_name;
  }
  if (kind === 'ATTRIBUTE_INGREDIENT') {
    if (a.collection?.collection_name !== p.collection_name) return false;
    if (a.schema?.schema_name !== p.schema_name) return false;
    return (p.attributes ?? []).every((att) => {
      const v = (a.data ?? {})[att.attribute_name];
      return (att.allowed_values ?? []).map(String).includes(String(v));
    });
  }
  return false;
}

/** A short reason, so a match is never just an assertion. */
function reasonFor(a: AtomicAsset, ing: IngredientVariant): string {
  const [kind, p] = ing;
  if (kind === 'TEMPLATE_INGREDIENT') return `it takes template #${p.template_id}`;
  if (kind === 'SCHEMA_INGREDIENT') return `it takes any ${p.schema_name} NFT`;
  if (kind === 'COLLECTION_INGREDIENT') return `it takes any NFT from ${p.collection_name}`;
  if (kind === 'ATTRIBUTE_INGREDIENT') {
    const names = (p.attributes ?? []).map((x) => x.attribute_name).join(' and ');
    return `it matches on ${names || 'an attribute'}`;
  }
  void a;
  return 'it matches this recipe';
}

/**
 * Everything in this NFT's collection that would take it.
 *
 * Four reads, run together and allowed to fail independently: a
 * contract being down should cost its own answers and not the others.
 * The screen says which ones did not answer rather than presenting a
 * short list as a complete one.
 */
/**
 * The four listings for one collection, kept for as long as the page is
 * open.
 *
 * Each lister has a cache of its own, so this is not about avoiding
 * repeat reads. It is about being able to START the reads before anybody
 * asks: the first look at a collection costs about thirty seconds while
 * the NeftyBlocks indexer is down and blends have to be walked on chain,
 * and thirty seconds after a click is a broken feature where thirty
 * seconds before one is invisible.
 */
const warmed = new Map<string, { at: number; sources: Promise<Sources> }>();

/**
 * Same five minutes the listers themselves use. Without it this memo
 * outlived their freshness: a blend that ended at noon was still being
 * offered at one o'clock, with a link into the runner.
 */
const WARM_TTL_MS = 5 * 60_000;

interface Sources {
  blends: PromiseSettledResult<Awaited<ReturnType<typeof listBlends>>>;
  upgrades: PromiseSettledResult<Awaited<ReturnType<typeof listUpgrades>>>;
  packs: PromiseSettledResult<Awaited<ReturnType<typeof listPackDesigns>>>;
  neftyPacks: PromiseSettledResult<Awaited<ReturnType<typeof listNeftyPackDesigns>>>;
}

function readSources(collection: string, actor: string): Promise<Sources> {
  const key = `${collection}::${actor}`;
  const hit = warmed.get(key);
  if (hit && Date.now() - hit.at < WARM_TTL_MS) return hit.sources;
  const p = (async (): Promise<Sources> => {
    const [blends, upgrades, packs, neftyPacks] = await Promise.allSettled([
      listBlends({ collection, includeInactive: false, actor }),
      listUpgrades({ collection, includeInactive: false }),
      listPackDesigns(collection),
      listNeftyPackDesigns(collection),
    ]);
    return { blends, upgrades, packs, neftyPacks };
  })();
  warmed.set(key, { at: Date.now(), sources: p });
  // A reading that failed everywhere should not be the answer for the
  // next five minutes either.
  void p.then((r) => {
    const allFailed = Object.values(r).every((x) => x.status === 'rejected');
    if (allFailed) warmed.delete(key);
  }, () => warmed.delete(key));
  return p;
}

/**
 * Starts reading a collection's recipes without waiting for the answer.
 *
 * Called for the collections a wallet actually holds as soon as its
 * inventory is on screen, so that clicking an NFT reads a result rather
 * than starting a scan.
 */
export function warmCollection(collection: string, actor = ''): void {
  if (!collection) return;
  void readSources(collection, actor).catch(() => {});
}

/** True when this collection's recipes are already in hand. */
export function isWarm(collection: string, actor = ''): boolean {
  return settled.has(`${collection}::${actor}`);
}

const settled = new Set<string>();

/** Throws away what was read, so a retry is a real retry. */
/**
 * Whether the blends indexer is currently known to be unreachable.
 *
 * The wait screen asserted it as a fact whenever a collection had not
 * been read yet, which is a different thing entirely and was false every
 * time the indexer was healthy.
 */
export function indexerIsDown(): boolean {
  return atomicIndexerDown('/neftyblocks/v1/blends');
}

export function forgetCollection(collection: string, actor = ''): void {
  warmed.delete(`${collection}::${actor}`);
  settled.delete(`${collection}::${actor}`);
  // This collection only. Emptying the shared caches would make a retry
  // on one NFT cost every other collection the page had already read.
  clearDiscoverCache(collection);
  clearUpgradesCache(collection);
  // The exception, and it has to be global: the note only records that a
  // route was unreachable, and the whole point of pressing Search again
  // is to find out whether it still is.
  clearAtomicIndexerDown();
}

/**
 * A cheap "would any recipe here take this NFT" test for a whole
 * collection.
 *
 * `whatUsesThis` answers the same question properly, for one NFT, and
 * costs a walk of every recipe. Marking a grid of two hundred cards that
 * way is two hundred walks. This reads the collection once and reduces it
 * to a few sets, so each card costs a lookup.
 *
 * Deliberately looser than `whatUsesThis`: it answers "worth looking at",
 * and the detail panel is where the actual answer lives. It never says
 * yes where `whatUsesThis` would say no, because both are built from the
 * same ingredient lists.
 */
export interface Matcher {
  takes(a: AtomicAsset): boolean;
  /** How many live recipes were read, so the screen can say. */
  recipes: number;
  /**
   * True when one of the four reads failed.
   *
   * It matters which way this cuts. A mark is still a fact: the recipe
   * that puts it there was really read. An absence is not, because the
   * source that would have justified it may be the one that did not
   * answer. So the count is reported as a floor and the filter says it
   * may be hiding something.
   */
  partial: boolean;
}

export async function usableIndex(collection: string, actor = ''): Promise<Matcher> {
  const { blends, upgrades, packs, neftyPacks } = await readSources(collection, actor);
  settled.add(`${collection}::${actor}`);
  const templates = new Set<string>();
  const schemas = new Set<string>();
  const collections = new Set<string>();
  const attributeRules: {
    collection?: string; schema?: string;
    attributes: { attribute_name: string; allowed_values?: unknown[] }[];
  }[] = [];
  let recipes = 0;

  if (blends.status === 'fulfilled') {
    for (const b of blends.value.blends) {
      if (b.status !== 'active') continue;
      recipes += 1;
      for (const [kind, p] of b.ingredients ?? []) {
        if (kind === 'TEMPLATE_INGREDIENT') templates.add(String(p.template_id));
        else if (kind === 'SCHEMA_INGREDIENT') schemas.add(`${p.collection_name}/${p.schema_name}`);
        else if (kind === 'COLLECTION_INGREDIENT') collections.add(String(p.collection_name));
        else if (kind === 'ATTRIBUTE_INGREDIENT') {
          // The collection the rule names, not the collection the blend
          // lives in. A blend can sit in one collection and take an NFT
          // from another, and dropping this marked every NFT that merely
          // shared a schema name and an attribute value: blend.nefty
          // 27601 lives in landboxgames and takes a monsterfight NFT.
          attributeRules.push({
            collection: p.collection_name,
            schema: p.schema_name,
            attributes: p.attributes ?? [],
          });
        }
      }
    }
  }
  if (upgrades.status === 'fulfilled') {
    for (const u of upgrades.value.upgrades) {
      if (u.status !== 'active') continue;
      recipes += 1;
      for (const t of u.acceptedTemplateIds ?? []) templates.add(String(t));
      for (const ing of u.ingredients ?? []) {
        if (ing.kind === 'template') templates.add(String(ing.template_id));
        else if (ing.kind === 'schema') schemas.add(`${ing.collection_name}/${ing.schema_name}`);
        else if (ing.kind === 'collection') collections.add(String(ing.collection_name));
      }
    }
  }
  for (const res of [packs, neftyPacks]) {
    if (res.status !== 'fulfilled') continue;
    for (const d of res.value) {
      // A pack that does not open until next month is not something you
      // can do today, and the mark means "you can do something with this
      // now". The detail panel still lists it, with the date.
      if (d.unlock_time && d.unlock_time * 1000 > Date.now()) continue;
      recipes += 1;
      templates.add(String(d.pack_template_id));
    }
  }

  return {
    recipes,
    partial: [blends, upgrades, packs, neftyPacks].some((r) => r.status === 'rejected'),
    takes(a: AtomicAsset): boolean {
      const tpl = String(a.template?.template_id ?? '');
      if (tpl && templates.has(tpl)) return true;
      const coll = a.collection?.collection_name ?? '';
      if (coll && collections.has(coll)) return true;
      const schema = a.schema?.schema_name ?? '';
      if (coll && schema && schemas.has(`${coll}/${schema}`)) return true;
      for (const rule of attributeRules) {
        if (rule.collection && rule.collection !== coll) continue;
        if (rule.schema && rule.schema !== schema) continue;
        if (!rule.attributes.length) continue;
        const ok = rule.attributes.every((att) => (att.allowed_values ?? [])
          .map(String).includes(String((a.data ?? {})[att.attribute_name])));
        if (ok) return true;
      }
      return false;
    },
  };
}

export async function whatUsesThis(a: AtomicAsset, actor = ''): Promise<Uses> {
  const collection = a.collection?.collection_name ?? '';
  if (!collection) return { uses: [], scanned: '', partial: false, unreadable: 0 };
  let unreadable = 0;
  const tpl = String(a.template?.template_id ?? '');

  const { blends, upgrades, packs, neftyPacks } = await readSources(collection, actor);
  settled.add(`${collection}::${actor}`);
  const partial = [blends, upgrades, packs, neftyPacks].some((r) => r.status === 'rejected');
  const uses: Use[] = [];

  // A pack first: "this can be opened" is the most actionable thing an
  // NFT can be, and it is the one people most often do not realise.
  for (const [res, source] of [[packs, 'pack'], [neftyPacks, 'neftypack']] as const) {
    if (res.status !== 'fulfilled') continue;
    for (const d of res.value) {
      if (String(d.pack_template_id) !== tpl) continue;
      const locked = Boolean(d.unlock_time) && d.unlock_time * 1000 > Date.now();
      // The contract is part of the label, not decoration. The same pack
      // template is registered on BOTH contracts for some collections
      // (play2metamon 281765 is one), and two rows reading exactly "Open
      // it: Regular pack" gave no way to tell which one to press, while
      // opening on the wrong contract transfers the NFT irreversibly.
      const where = source === 'pack' ? 'atomicpacksx' : 'neftyblocksp';
      uses.push({
        kind: 'pack',
        link: `${source}~${collection}~${d.pack_id}`,
        label: `Open it: ${d.name || `pack #${d.pack_id}`} (${where})`,
        because: locked
          ? `this NFT is that pack, but it does not open until ${new Date(d.unlock_time * 1000).toLocaleString()}`
          : 'this NFT is that pack',
        live: !locked,
      });
    }
  }

  if (blends.status === 'fulfilled') {
    for (const b of blends.value.blends) {
      const hit = (b.ingredients ?? []).find((ing) => ingredientTakes(a, ing));
      if (!hit) continue;
      uses.push({
        kind: 'blend',
        link: `blend~${collection}~${b.blend_id}`,
        label: b.name || `Blend #${b.blend_id}`,
        because: reasonFor(a, hit),
        live: b.status === 'active',
      });
    }
  }

  if (upgrades.status === 'fulfilled') {
    for (const u of upgrades.value.upgrades) {
      // An upgrade can want this NFT in two different roles, and which
      // one decides whether you keep it. Worth saying which.
      const isTarget = (u.acceptedTemplateIds ?? []).map(String).includes(tpl);
      // An upgrade can want this NFT through an attribute rule as well as
      // by template, schema or collection. Returning false for those
      // dropped real upgrades while the panel went on saying the whole
      // collection had been searched, so they are matched here and the
      // ones whose shape we cannot evaluate are counted instead of
      // quietly discarded.
      let unsure = false;
      const asCost = (u.ingredients ?? []).some((ing) => {
        if (ing.kind === 'template') return String(ing.template_id) === tpl;
        if (ing.kind === 'schema') {
          return a.collection?.collection_name === ing.collection_name
            && a.schema?.schema_name === ing.schema_name;
        }
        if (ing.kind === 'collection') return a.collection?.collection_name === ing.collection_name;
        if (ing.kind === 'attribute' || ing.kind === 'typed_attribute') {
          const spec = ing as unknown as {
            collection_name?: string; schema_name?: string;
            attributes?: { attribute_name: string; allowed_values?: unknown[] }[];
          };
          if (spec.collection_name && a.collection?.collection_name !== spec.collection_name) return false;
          if (spec.schema_name && a.schema?.schema_name !== spec.schema_name) return false;
          const rules = spec.attributes ?? [];
          if (!rules.length) { unsure = true; return false; }
          return rules.every((att) => {
            const v = (a.data ?? {})[att.attribute_name];
            const allowed = (att.allowed_values ?? []).map(String);
            if (!allowed.length) { unsure = true; return false; }
            return allowed.includes(String(v));
          });
        }
        if (ing.kind === 'ft') return false;      // a token cost, not this NFT
        unsure = true;                            // a shape we do not read
        return false;
      });
      if (unsure) unreadable += 1;
      if (!isTarget && !asCost) continue;
      uses.push({
        kind: 'upgrade',
        link: `upgrade~${collection}~${u.upgrade_id}`,
        label: u.name || `Upgrade #${u.upgrade_id}`,
        because: isTarget
          ? 'this is the NFT it upgrades, and you keep it'
          : 'it takes this as part of the cost',
        live: u.status === 'active',
      });
    }
  }

  // One row per recipe. An upgrade that wants this NFT through two of
  // its ingredients matched twice and printed itself twice, which reads
  // as two different things you could do.
  const seen = new Set<string>();
  const unique = uses.filter((u) => (seen.has(u.link) ? false : (seen.add(u.link), true)));

  // Running first, then packs, then everything else: the order somebody
  // would try them in.
  const rank = (u: Use) => (u.live ? 0 : 10) + (u.kind === 'pack' ? 0 : 1);
  unique.sort((x, y) => rank(x) - rank(y) || x.label.localeCompare(y.label));
  return { uses: unique, scanned: collection, partial, unreadable };
}

/**
 * Whether a wallet holds enough of a token cost.
 *
 * The run screen used to print "not checked" beside every token, which is
 * honest and useless: the whole question on that screen is whether you
 * can afford this. Getting the answer right needed three fixes over the
 * first version, each of which had produced a sentence that was false:
 *
 *   - the issuer is taken from the recipe when the recipe knows it.
 *     Resolving every cost through blend.nefty's registry meant a WaxDAO
 *     blend priced in a token that registry has never heard of was
 *     measured against the wrong contract, or not at all.
 *   - a failed read is not a balance. readTokenBalance returned 0 for
 *     both, so an RPC hiccup told somebody holding 500 UPMAX that they
 *     had none.
 *   - the comparison is on integers. 31.99999999 against 32.00000000 as
 *     floats, printed through toLocaleString, rendered as "you have 32,
 *     not enough".
 */
export interface TokenCost {
  /** The exact balance string, or undefined when the read failed. */
  haveRaw?: string;
  /** The exact cost string, as the recipe states it. */
  needRaw: string;
  symbol: string;
  /** Undefined when the balance could not be read. */
  enough?: boolean;
}

export async function checkTokenCost(
  owner: string, quantity: string, contract?: string,
): Promise<TokenCost | undefined> {
  if (!owner || !quantity) return undefined;
  let sym: string;
  let code: string;
  try {
    sym = symbolFromQuantity(quantity);          // e.g. "8,UPMAX"
    code = sym.split(',')[1] ?? sym;
  } catch {
    return undefined;                            // not an asset string
  }
  let issuer = contract;
  if (!issuer) {
    try {
      issuer = await resolveTokenContract(quantity);
    } catch {
      // Not in any registry we can read and the recipe did not say. We
      // genuinely cannot tell which contract issues it, and guessing
      // could tell somebody they cannot afford something they can.
      return { needRaw: quantity, symbol: code };
    }
  }
  const raw = await readTokenBalanceRaw({ owner, contract: issuer, symbolCode: code });
  if (raw === undefined) return { needRaw: quantity, symbol: code };
  // No row on the contract is a true zero, expressed at the cost's own
  // precision so the two are comparable and the screen can show it.
  const haveRaw = raw ?? `${(0).toFixed(Number(sym.split(',')[0]) || 0)} ${code}`;
  return { haveRaw, needRaw: quantity, symbol: code, enough: covers(haveRaw, quantity) };
}
