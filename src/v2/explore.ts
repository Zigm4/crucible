/**
 * Explore a collection: everything it offers, on one page.
 * ─────────────────────────────────────────────────────────────
 * "Use a recipe" starts from what a person wants to do, then asks where.
 * This starts from where, the way someone who knows a collection thinks:
 * "what can I make, claim or open in underpunks55?". The classic page has
 * that question as its catalogue; this is the v2 shelf for it.
 *
 * It reads nothing of its own. The recipes come from the run tool's lister
 * (guidedRun.listRecipes, one call per action), so the shelf and step 4
 * list the same recipes; each is judged by the same checks (runChecks), so
 * a card's colour is the verdict step 4 will show; and the name, artwork,
 * cost and category come from the classic catalogue (catalog.shelfEntry),
 * which already knew how to shelve every contract's rows by the schema of
 * what they produce. A card opens step 4 of the run tool on that recipe.
 *
 * Routes: #/explore (pick a collection), #/explore/<collection>.
 */
import { listAssetsForOwner, type AtomicAsset } from '../atomic/assets';
import { getCurrentSession } from '../chain/session';
import { resolveCategories, shelfEntry, UNCATEGORISED, type CatalogEntry } from '../ui/catalog';
import { SUGGESTED_COLLECTIONS } from '../ui/collections';
import {
  actionOf, collectionsOwned, listRecipes, RECIPE_ACTIONS, SOURCE_INFO, type RecipeAction, type RecipeChoice,
} from '../ui/guidedRun';
import { renderMediaThumb } from '../ui/media';
import {
  emptyCheckContext, headline, loadCheckContext, verdictFor, type CheckContext, type RecipeVerdict,
} from '../ui/runChecks';

type Show = 'open' | 'ok' | 'near';

interface Shelf {
  collection: string;
  actor: string;
  /** Actions whose recipes are still being read. */
  reading: Set<RecipeAction>;
  choices: RecipeChoice[];
  entries: Map<string, CatalogEntry>;
  ctx: CheckContext;
  failed: string[];
}

let shelf: Shelf | undefined;
const filters = { show: 'open' as Show, kind: 'all' as RecipeAction | 'all', q: '', finished: false };
/** The collections the connected wallet holds, for the picker; read once per account. */
let mine: { actor: string; list: { name: string; count: number }[] } | undefined;

const esc = (s: string) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const keyOf = (c: RecipeChoice) => `${c.source}:${c.id}`;
const KIND_WORD: Record<RecipeAction, string> = { blend: 'Blend', upgrade: 'Upgrade', drop: 'Drop', unpack: 'Pack' };

/** Starts reading a collection's shelf, unless it is the one on screen for this wallet. */
export function openShelf(collection: string, repaint: () => void): void {
  const c = collection.trim().toLowerCase();
  const actor = String(getCurrentSession()?.actor ?? '');
  if (!c || (shelf?.collection === c && shelf.actor === actor)) return;
  const s: Shelf = {
    collection: c, actor, reading: new Set(RECIPE_ACTIONS.map((a) => a.key)), choices: [],
    entries: new Map(), ctx: emptyCheckContext(), failed: [],
  };
  s.ctx.actor = actor;
  s.ctx.collection = c;
  shelf = s;
  void (async () => {
    // The whole wallet, not only this collection: a gate or a proof can ask
    // for NFTs from elsewhere, and the checks judge it against this list.
    let owned: AtomicAsset[] = [];
    if (actor) {
      try { owned = await listAssetsForOwner({ owner: actor }); } catch { /* the checks say what is unknown */ }
      s.ctx.assets = owned;
      s.ctx.assetsKnown = true;
    }
    await Promise.all(RECIPE_ACTIONS.map(async ({ key }) => {
      try {
        const res = await listRecipes(key, c, actor, undefined, owned);
        if (shelf !== s) return;
        s.choices.push(...res.choices);
        const fresh: CatalogEntry[] = [];
        for (const ch of res.choices) {
          const e = shelfEntry(ch);
          if (e) { s.entries.set(keyOf(ch), e); fresh.push(e); }
        }
        // Categories and artwork come from the produced templates, read in
        // batches; the cards show as soon as the list is in.
        void resolveCategories(c, fresh).then(() => { if (shelf === s) repaint(); });
      } catch (e) {
        s.failed.push(`${KIND_WORD[key]}s: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        s.reading.delete(key);
        if (shelf === s) repaint();
      }
    }));
    if (shelf !== s) return;
    await loadCheckContext(s.ctx, s.choices.filter((ch) => ch.live), c, () => { if (shelf === s) repaint(); });
  })();
}

/** Reads the connected wallet's collections once, for the picker. */
function loadMine(repaint: () => void): void {
  const actor = String(getCurrentSession()?.actor ?? '');
  if (!actor || mine?.actor === actor) return;
  mine = { actor, list: [] };
  void listAssetsForOwner({ owner: actor })
    .then((assets) => { if (mine?.actor === actor) { mine.list = collectionsOwned(assets); repaint(); } })
    .catch(() => { /* the suggestions stay */ });
}

// ─── how it is shown ────────────────────────────────────────────────────

type GroupBy = 'category' | 'contract' | 'kind' | 'none';
type Size = 's' | 'm' | 'l';
type Layout = 'grid' | 'list';

/**
 * How the shelf is laid out. A per-viewer preference, so it is kept in this
 * browser and nowhere else; private windows and blocked storage simply get
 * the default each time.
 */
const VIEW_KEY = 'crucible-v2-explore-view';
const view: { group: GroupBy; size: Size; layout: Layout } = (() => {
  const fallback = { group: 'category' as GroupBy, size: 'm' as Size, layout: 'grid' as Layout };
  try {
    const saved = JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') as Partial<typeof fallback>;
    return {
      group: (['category', 'contract', 'kind', 'none'] as const).includes(saved.group as GroupBy) ? saved.group as GroupBy : fallback.group,
      size: (['s', 'm', 'l'] as const).includes(saved.size as Size) ? saved.size as Size : fallback.size,
      layout: saved.layout === 'list' ? 'list' : fallback.layout,
    };
  } catch { return fallback; }
})();
function saveView(): void {
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch { /* the choice lasts this visit */ }
}

/** The shelf a recipe sits on, under the chosen grouping. */
function groupOf(s: Shelf, c: RecipeChoice): string {
  if (view.group === 'none') return '';
  if (view.group === 'kind') return `${KIND_WORD[actionOf(c.source)]}s`;
  if (view.group === 'contract') return `${SOURCE_INFO[c.source].platform} · ${SOURCE_INFO[c.source].contract}`;
  return s.entries.get(keyOf(c))?.category || UNCATEGORISED;
}

// ─── markup ─────────────────────────────────────────────────────────────

export function renderExplore(collection: string, repaint: () => void): string {
  if (!collection) return renderPicker(repaint);
  openShelf(collection, repaint);
  const s = shelf!;
  const verdicts = new Map(s.choices.map((c) => [keyOf(c), verdictFor(c, s.ctx)]));
  const v = (c: RecipeChoice) => verdicts.get(keyOf(c))!;
  const visible = s.choices.filter((c) => shown(c, v(c), s.entries.get(keyOf(c))));
  const open = s.choices.filter((c) => !v(c).finished && c.live);
  const ok = open.filter((c) => v(c).tone === 'ok').length;
  const near = open.filter((c) => v(c).tone === 'warn').length;

  const groups = new Map<string, RecipeChoice[]>();
  for (const c of visible) {
    const g = groupOf(s, c);
    groups.set(g, [...(groups.get(g) ?? []), c]);
  }
  const rank = (x: RecipeVerdict) => (x.finished ? 5 : x.tone === 'ok' ? 0 : x.tone === 'warn' ? 1 : x.tone === 'pending' ? 2 : 3);
  const ordered = [...groups.entries()]
    .sort(([a], [b]) => (a === UNCATEGORISED ? 1 : 0) - (b === UNCATEGORISED ? 1 : 0) || a.localeCompare(b))
    .map(([g, list]) => [g, list.sort((x, y) => rank(v(x)) - rank(v(y)) || x.name.localeCompare(y.name))] as const);

  const still = [...s.reading].map((k) => KIND_WORD[k].toLowerCase() + 's');
  const chip = (attr: string, value: string, on: boolean, label: string) =>
    `<button class="v2-chip ${on ? 'on' : ''}" data-explore-${attr}="${esc(value)}">${esc(label)}</button>`;
  const seg = (attr: string, options: [string, string][], current: string) =>
    `<div class="v2-seg">${options.map(([value, label]) =>
      `<button class="${value === current ? 'on' : ''}" data-explore-${attr}="${value}">${esc(label)}</button>`).join('')}</div>`;

  return `
    <section class="v2-explore">
      <div class="v2-explore-head">
        <div>
          <p class="v2-eyebrow">Explore a collection</p>
          <h1>${esc(s.collection)}</h1>
          <p class="v2-lead">${s.reading.size && !s.choices.length
            // Counts of nothing read yet would read as an answer.
            ? 'Reading its recipes on every contract.'
            : `${open.length} open recipe${open.length === 1 ? '' : 's'}${s.reading.size ? ' so far' : ''}${s.actor
              ? ` · <strong class="v2-ok">${ok} you can run now</strong> · ${near} missing something`
              : ' · connect a wallet to see which you can run'}`}</p>
        </div>
        <a href="#/explore">Another collection</a>
      </div>
      ${renderStats(s, v)}
      ${still.length ? `<p class="lab-hint">Reading the ${esc(still.join(', '))}.</p>` : ''}
      ${s.ctx.loading ? '<p class="lab-hint">Checking limits, gates and balances.</p>' : ''}
      ${s.failed.map((f) => `<p class="v2-error">Could not read ${esc(f)}</p>`).join('')}
      <div class="v2-explore-filters">
        <div class="v2-chips">
          ${chip('show', 'open', filters.show === 'open', 'Everything open')}
          ${s.actor ? chip('show', 'ok', filters.show === 'ok', 'You can run it') : ''}
          ${s.actor ? chip('show', 'near', filters.show === 'near', 'Something missing') : ''}
        </div>
        <div class="v2-chips">
          ${chip('kind', 'all', filters.kind === 'all', 'All kinds')}
          ${RECIPE_ACTIONS.map((a) => chip('kind', a.key, filters.kind === a.key, `${KIND_WORD[a.key]}s`)).join('')}
        </div>
        <input class="v2-explore-search" data-explore-q placeholder="Search a name or a category"
               value="${esc(filters.q)}" />
        <label class="v2-explore-finished">
          <input type="checkbox" data-explore-finished ${filters.finished ? 'checked' : ''} />
          Show ended and sold out
        </label>
        <div class="v2-explore-view">
          <span>Group by</span>
          ${seg('group', [['category', 'What it makes'], ['contract', 'Contract'], ['kind', 'Kind'], ['none', 'Nothing']], view.group)}
          <span>Show as</span>
          ${seg('layout', [['grid', 'Grid'], ['list', 'List']], view.layout)}
          ${view.layout === 'grid' ? seg('size', [['s', 'S'], ['m', 'M'], ['l', 'L']], view.size) : ''}
        </div>
      </div>
      ${ordered.length ? ordered.map(([g, list]) => `
        <div class="v2-shelf">
          ${g ? `<h2>${esc(g === UNCATEGORISED ? 'Other' : g)} <span>${list.length}</span></h2>` : ''}
          <div class="${view.layout === 'list' ? 'v2-shelf-list' : `v2-shelf-grid size-${view.size}`}">
            ${list.map((c) => renderCard(s, c, v(c))).join('')}
          </div>
        </div>`).join('')
        : s.reading.size ? '' : '<p class="lab-hint">Nothing here matches. Try another filter.</p>'}
    </section>`;
}

/**
 * What the collection has, counted the way the classic catalogue does:
 * one tile per kind, each split by the contract that runs it, and how many
 * are open, still to come, or over. A tile filters the shelf to its kind.
 */
function renderStats(s: Shelf, v: (c: RecipeChoice) => RecipeVerdict): string {
  if (!s.choices.length) return '';
  const tiles = RECIPE_ACTIONS.map(({ key }) => {
    const mineKind = s.choices.filter((c) => actionOf(c.source) === key);
    const live = mineKind.filter((c) => c.live && !v(c).finished).length;
    const bySource = new Map<string, number>();
    for (const c of mineKind) bySource.set(SOURCE_INFO[c.source].contract, (bySource.get(SOURCE_INFO[c.source].contract) ?? 0) + 1);
    const split = [...bySource.entries()].map(([contract, n]) => `${n} on ${contract}`).join(' · ');
    return `
      <button class="v2-stat ${filters.kind === key ? 'on' : ''}" data-explore-kind="${filters.kind === key ? 'all' : key}"
              ${mineKind.length ? '' : 'disabled'}>
        <span class="v2-stat-n">${mineKind.length}</span>
        <span class="v2-stat-label">${KIND_WORD[key]}${mineKind.length === 1 ? '' : 's'}</span>
        <small>${mineKind.length ? `${live} open${split ? ` · ${esc(split)}` : ''}` : 'none'}</small>
      </button>`;
  }).join('');
  const finished = s.choices.filter((c) => v(c).finished).length;
  const upcoming = s.choices.filter((c) => !c.live && !v(c).finished).length;
  const open = s.choices.length - finished - upcoming;
  return `
    <div class="v2-stats">${tiles}</div>
    <p class="lab-hint v2-stats-line">${s.choices.length} recipe${s.choices.length === 1 ? '' : 's'} in all:
      ${open} open, ${upcoming} not open yet, ${finished} ended or sold out.</p>`;
}

function shown(c: RecipeChoice, v: RecipeVerdict, e: CatalogEntry | undefined): boolean {
  if (!filters.finished && (v.finished || !c.live)) return false;
  if (filters.kind !== 'all' && actionOf(c.source) !== filters.kind) return false;
  if (filters.show === 'ok' && v.tone !== 'ok') return false;
  if (filters.show === 'near' && v.tone !== 'warn') return false;
  const q = filters.q.trim().toLowerCase();
  if (q && !`${c.name} ${e?.category ?? ''} ${c.id}`.toLowerCase().includes(q)) return false;
  return true;
}

function renderCard(s: Shelf, c: RecipeChoice, v: RecipeVerdict): string {
  const e = s.entries.get(keyOf(c));
  // Where it runs, when that is not the NeftyBlocks contract one would assume.
  const where = c.source === 'waxdao' || c.source === 'blenderizer' ? ` · ${SOURCE_INFO[c.source].platform}` : '';
  const kind = KIND_WORD[actionOf(c.source)] + where;
  const verdict = headline(v);
  // The frame is always there, with the kind's initial behind the picture:
  // a picture no gateway serves is removed, and the card keeps its shape.
  const art = `
    <div class="v2-card-frame">
      <span aria-hidden="true">${esc(KIND_WORD[actionOf(c.source)][0])}</span>
      ${renderMediaThumb({ ref: [e?.image, e?.fallbackImage], alt: c.name, className: 'v2-card-art' })}
    </div>`;
  const body = `
    ${art}
    <div class="v2-card-body">
      <span class="v2-card-kind">${esc(kind)}${e?.random ? ' · random' : ''}</span>
      <strong>${esc(c.name)}</strong>
      <small>${esc(e?.cost ?? c.note)}</small>
      <span class="v2-card-verdict run-check-${v.tone}" title="${esc(verdict)}"><span>${esc(verdict)}</span></span>
    </div>`;
  // A recipe nothing can unlock right now is shown with its reason, and not
  // opened, as the run tool's list does.
  if (v.closed) return `<div class="v2-card run-tone-${v.tone}" aria-disabled="true">${body}</div>`;
  return `<a class="v2-card run-tone-${v.tone}" href="#/use/${esc(`${c.source}~${s.collection}~${c.id}`)}">${body}</a>`;
}

function renderPicker(repaint: () => void): string {
  loadMine(repaint);
  const own = (mine?.list ?? []).slice(0, 12);
  const pick = (name: string, extra = '') =>
    `<a class="v2-chip" href="#/explore/${esc(name)}">${esc(name)}${extra}</a>`;
  return `
    <section class="v2-explore">
      <div class="v2-explore-head">
        <div>
          <p class="v2-eyebrow">Explore a collection</p>
          <h1>Which collection?</h1>
          <p class="v2-lead">Every blend, upgrade, drop and pack it has, on every contract, shelved by
          what they make, each one marked with whether you can run it.</p>
        </div>
      </div>
      <form class="v2-explore-pick" data-explore-pick>
        <input name="collection" placeholder="Collection name, e.g. underpunks55" autocomplete="off" />
        <button class="lab-primary" type="submit">Explore</button>
      </form>
      ${own.length ? `<p class="lab-hint">Collections in your wallet</p>
        <div class="v2-chips">${own.map((c) => pick(c.name, ` <span>${c.count}</span>`)).join('')}</div>` : ''}
      <p class="lab-hint">Or one of these</p>
      <div class="v2-chips">${SUGGESTED_COLLECTIONS.map((c) => pick(c)).join('')}</div>
    </section>`;
}

/** Filters and the picker form. A filter repaints without reading anything again. */
export function attachExploreHandlers(root: HTMLElement, repaint: () => void, go: (hash: string) => void): void {
  root.querySelectorAll<HTMLElement>('[data-explore-show]').forEach((el) => el.addEventListener('click', () => {
    filters.show = el.dataset.exploreShow as Show;
    repaint();
  }));
  root.querySelectorAll<HTMLElement>('[data-explore-kind]').forEach((el) => el.addEventListener('click', () => {
    filters.kind = el.dataset.exploreKind as RecipeAction | 'all';
    repaint();
  }));
  const setView = (attr: 'group' | 'layout' | 'size') =>
    root.querySelectorAll<HTMLElement>(`[data-explore-${attr}]`).forEach((el) => el.addEventListener('click', () => {
      (view as Record<string, string>)[attr] = el.dataset[`explore${attr[0].toUpperCase()}${attr.slice(1)}`] ?? '';
      saveView();
      repaint();
    }));
  setView('group');
  setView('layout');
  setView('size');
  root.querySelector<HTMLInputElement>('[data-explore-q]')?.addEventListener('input', (ev) => {
    filters.q = (ev.target as HTMLInputElement).value;
    repaint();
  });
  root.querySelector<HTMLInputElement>('[data-explore-finished]')?.addEventListener('change', (ev) => {
    filters.finished = (ev.target as HTMLInputElement).checked;
    repaint();
  });
  root.querySelector<HTMLFormElement>('[data-explore-pick]')?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const v = String(new FormData(ev.target as HTMLFormElement).get('collection') ?? '').trim().toLowerCase();
    if (v) go(`#/explore/${v}`);
  });
}
