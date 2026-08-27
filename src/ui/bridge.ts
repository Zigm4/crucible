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
import { listBlends } from '../nefty/discover';
import { listUpgrades } from '../nefty/upgrades';
import { listPackDesigns } from '../nefty/packs';
import { listNeftyPackDesigns } from '../nefty/neftyPacks';
import { resolveTokenContract, readTokenBalance, symbolFromQuantity } from '../nefty/tokens';
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
  /** True while the answer is still incomplete. */
  partial: boolean;
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
export async function whatUsesThis(a: AtomicAsset, actor = ''): Promise<Uses> {
  const collection = a.collection?.collection_name ?? '';
  if (!collection) return { uses: [], scanned: '', partial: false };
  const tpl = String(a.template?.template_id ?? '');

  const [blends, upgrades, packs, neftyPacks] = await Promise.allSettled([
    listBlends({ collection, includeInactive: false, actor }),
    listUpgrades({ collection, includeInactive: false }),
    listPackDesigns(collection),
    listNeftyPackDesigns(collection),
  ]);
  const partial = [blends, upgrades, packs, neftyPacks].some((r) => r.status === 'rejected');
  const uses: Use[] = [];

  // A pack first: "this can be opened" is the most actionable thing an
  // NFT can be, and it is the one people most often do not realise.
  for (const [res, source] of [[packs, 'pack'], [neftyPacks, 'neftypack']] as const) {
    if (res.status !== 'fulfilled') continue;
    for (const d of res.value) {
      if (String(d.pack_template_id) !== tpl) continue;
      const locked = Boolean(d.unlock_time) && d.unlock_time * 1000 > Date.now();
      uses.push({
        kind: 'pack',
        link: `${source}~${collection}~${d.pack_id}`,
        label: `Open it: ${d.name || `pack #${d.pack_id}`}`,
        because: locked
          ? `this NFT is that pack, but it does not open until ${new Date(d.unlock_time * 1000).toLocaleDateString()}`
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
      const asCost = (u.ingredients ?? []).some((ing) => {
        if (ing.kind === 'template') return String(ing.template_id) === tpl;
        if (ing.kind === 'schema') {
          return a.collection?.collection_name === ing.collection_name
            && a.schema?.schema_name === ing.schema_name;
        }
        if (ing.kind === 'collection') return a.collection?.collection_name === ing.collection_name;
        return false;
      });
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
  return { uses: unique, scanned: collection, partial };
}

/**
 * Whether a wallet holds enough of a token cost.
 *
 * The runner used to print "not checked" beside every token, which is
 * honest and useless: the whole question on that screen is whether you
 * can afford this. It stays undefined when the token is not in
 * blend.nefty's registry, because then we genuinely cannot resolve which
 * contract issues it and a guess could tell somebody they cannot afford
 * something they can.
 */
export async function checkTokenCost(
  owner: string, quantity: string,
): Promise<{ have: number; need: number; symbol: string } | undefined> {
  if (!owner || !quantity) return undefined;
  try {
    const contract = await resolveTokenContract(quantity);
    const sym = symbolFromQuantity(quantity);          // e.g. "8,UPMAX"
    const code = sym.split(',')[1] ?? sym;
    const have = await readTokenBalance({ owner, contract, symbolCode: code });
    const need = Number(String(quantity).trim().split(/\s+/)[0]) || 0;
    return { have, need, symbol: code };
  } catch {
    return undefined;
  }
}
