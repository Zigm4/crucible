/**
 * Design preview (route `#/lab`) — unlisted on purpose.
 * ─────────────────────────────────────────────────────────────
 * What the NEXT version of blend/upgrade creation could look like.
 * Nothing here signs anything or touches the chain: it is a working
 * prototype of the interaction, not a second implementation.
 *
 * The problem it answers: the current form is a set of text boxes with
 * a syntax to learn. That is fine once you know it and hostile before
 * you do — you type template ids from memory, weights are abstract
 * numbers, and you only find out what you built when you read the
 * confirmation. Three changes fix most of that:
 *
 *   1. PICK, don't type. Templates come from the collection with their
 *      artwork and name, so an id is something you recognise rather
 *      than something you recall.
 *   2. Weights become a picture. A stacked bar shows the draw, so
 *      "@50 / @30 / @20" is a shape before it is arithmetic.
 *   3. One plain sentence, always visible, describing the recipe as a
 *      player would experience it. If that sentence is wrong, the
 *      recipe is wrong — no need to decode the payload.
 *
 * The steps are deliberate too: each one asks a single question, so
 * the irreversible ones (what gets burned, what the odds are) get their
 * own screen instead of competing for attention in one long form.
 *
 * Kept entirely self-contained — its own state, its own render, its own
 * mock data — so it can be deleted in one file, or promoted into the
 * real creator once the interaction is settled.
 */

// ─── mock data ──────────────────────────────────────────────────────────
// Stand-ins for what the real version reads from the collection.

interface LabTemplate {
  id: number;
  name: string;
  schema: string;
  /** Emoji stands in for artwork so the prototype needs no network. */
  art: string;
  owned?: number;
}

const LAB_TEMPLATES: LabTemplate[] = [
  { id: 316897, name: 'Leather Scraps', schema: 'up.resources', art: '🟫', owned: 240 },
  { id: 331963, name: 'Silk Cloth', schema: 'up.resources', art: '🧵', owned: 42 },
  { id: 353503, name: 'Silk Thread', schema: 'up.resources', art: '🪡', owned: 130 },
  { id: 317912, name: 'Mycelium Pauldrons', schema: 'up.armour', art: '🛡️', owned: 3 },
  { id: 317934, name: 'Mycelium Helmet', schema: 'up.armour', art: '⛑️', owned: 1 },
  { id: 336429, name: 'Mycelium Armour Set', schema: 'up.armour', art: '🥋', owned: 0 },
  { id: 893664, name: 'Volna-57 Geiger Counter', schema: 'up.tools', art: '📻', owned: 0 },
  { id: 784175, name: 'T5 Tech Crafting (pack)', schema: 'up.packs', art: '📦', owned: 71 },
];

const LAB_COLLECTIONS = ['underpunks55', 'cigalepixeld'];

/** Mutable attributes an upgrade could target, with their on-chain type. */
const LAB_ATTRIBUTES: { name: string; type: 'uint64' | 'string'; sample: string }[] = [
  { name: 'level', type: 'uint64', sample: '1' },
  { name: 'power', type: 'uint64', sample: '25' },
  { name: 'rarity', type: 'string', sample: 'Rare' },
];

// ─── state ──────────────────────────────────────────────────────────────

type LabKind = 'blend' | 'upgrade';

interface LabIngredient {
  templateId: number;
  amount: number;
  /** Burned unless the author routes it somewhere. */
  sendTo?: string;
}
interface LabOutcome {
  /** null = the blank branch ("player gets nothing"). */
  templateId: number | null;
  weight: number;
}

/**
 * An upgrade does not mint — it rewrites one attribute of the NFT the
 * player already owns. `add` is the `+=` the contract supports.
 */
interface LabMutation {
  attribute: string;
  op: 'set' | 'add';
  value: string;
  weight: number;
}

interface LabState {
  kind: LabKind;
  step: number;
  collection: string;
  name: string;
  ingredients: LabIngredient[];
  outcomes: LabOutcome[];
  /** Upgrade only: the attribute rewrites, and who is allowed to try. */
  mutations: LabMutation[];
  requireAttr: string;
  requireMax: string;
  /** Which picker is open, if any. */
  picking?: 'ingredient' | 'outcome';
  search: string;
  hidden: boolean;
  limitPerWallet: string;
}

const state: LabState = {
  kind: 'blend',
  step: 0,
  collection: 'underpunks55',
  name: '',
  ingredients: [{ templateId: 316897, amount: 10 }],
  outcomes: [{ templateId: 317934, weight: 1 }],
  mutations: [{ attribute: 'level', op: 'add', value: '1', weight: 1 }],
  requireAttr: 'level',
  requireMax: '9',
  search: '',
  hidden: true,
  limitPerWallet: '',
};

/** Step 3 asks a different question depending on what is being created. */
const steps = () => [
  'Collection',
  'What players give',
  state.kind === 'upgrade' ? 'What changes' : 'What they get',
  'Rules',
  'Review',
];
const STEP_COUNT = 5;

const tpl = (id: number) => LAB_TEMPLATES.find((t) => t.id === id);
const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * One decimal, trailing `.0` dropped. Every place that shows a chance uses
 * this — the bar tooltip, the row, the sentence and the review — because a
 * row reading 1.9% next to a sentence reading 2% reads as a bug.
 */
const pct = (weight: number, total: number) =>
  `${((weight / total) * 100).toFixed(1).replace(/\.0$/, '')}%`;

// ─── the sentence ───────────────────────────────────────────────────────

/**
 * The recipe as a player would describe it. This is the prototype's
 * central idea: if this sentence is wrong, the recipe is wrong, and you
 * can tell without understanding anything about the payload.
 */
function plainSentence(): string {
  const give = state.ingredients.length
    ? state.ingredients
        .map((i) => `${i.amount}× ${tpl(i.templateId)?.name ?? `template ${i.templateId}`}`)
        .join(' and ')
    : 'nothing yet';
  const burned = state.ingredients.filter((i) => !i.sendTo).length > 0;

  if (state.kind === 'upgrade') {
    const total = state.mutations.reduce((n, m) => n + m.weight, 0) || 1;
    const one = (m: LabMutation) =>
      m.op === 'add' ? `${m.attribute} goes up by ${m.value || '?'}` : `${m.attribute} becomes ${m.value || '?'}`;
    const effect = state.mutations.length === 0
      ? 'nothing changes yet'
      : state.mutations.length === 1
        ? one(state.mutations[0])
        : state.mutations.map((m) => `${pct(m.weight, total)} ${one(m)}`).join(', ');
    const gate = state.requireMax.trim()
      ? ` — only NFTs whose ${state.requireAttr} is ${state.requireMax} or less qualify`
      : '';
    return `A player spends ${give}${burned ? ' (destroyed)' : ''} and their NFT is rewritten: ${effect}${gate}.`;
  }

  const total = state.outcomes.reduce((n, o) => n + o.weight, 0) || 1;
  const get = state.outcomes.length === 0
    ? 'nothing yet'
    : state.outcomes.length === 1
      ? (state.outcomes[0].templateId === null
          ? 'nothing'
          : tpl(state.outcomes[0].templateId!)?.name ?? 'an NFT')
      : state.outcomes
          .map((o) => `${pct(o.weight, total)} ${o.templateId === null ? 'nothing' : tpl(o.templateId)?.name ?? 'an NFT'}`)
          .join(', ');

  return `A player gives ${give}${burned ? ' (destroyed)' : ''} and gets ${get}.`;
}

// ─── rendering ──────────────────────────────────────────────────────────

function stepRail(): string {
  return `
    <ol class="lab-rail">
      ${steps().map((label, i) => `
        <li class="lab-rail-step${i === state.step ? ' current' : ''}${i < state.step ? ' done' : ''}"
            data-lab="step" data-step="${i}">
          <span class="lab-rail-dot">${i < state.step ? '✓' : i + 1}</span>
          <span class="lab-rail-label">${esc(label)}</span>
        </li>`).join('')}
    </ol>`;
}

function templateCard(t: LabTemplate, action: string): string {
  return `
    <button class="lab-tpl" data-lab="${action}" data-id="${t.id}">
      <span class="lab-tpl-art">${t.art}</span>
      <span class="lab-tpl-body">
        <span class="lab-tpl-name">${esc(t.name)}</span>
        <span class="lab-tpl-meta">${esc(t.schema)} · #${t.id}${t.owned !== undefined ? ` · you hold ${t.owned}` : ''}</span>
      </span>
    </button>`;
}

function picker(action: 'ingredient' | 'outcome'): string {
  const q = state.search.trim().toLowerCase();
  const list = LAB_TEMPLATES.filter(
    (t) => !q || t.name.toLowerCase().includes(q) || String(t.id).includes(q) || t.schema.includes(q),
  );
  return `
    <div class="lab-picker">
      <input id="lab-search" type="text" placeholder="Search by name, schema or id…" value="${esc(state.search)}" autocomplete="off" />
      <div class="lab-tpl-grid">${list.map((t) => templateCard(t, `pick-${action}`)).join('')}</div>
      <button class="lab-ghost" data-lab="close-picker">Cancel</button>
    </div>`;
}

function stepCollection(): string {
  return `
    <h3 class="lab-q">Which collection, and what is this recipe called?</h3>
    <p class="lab-hint">Only collections this wallet can manage would be listed here.</p>
    <div class="lab-field">
      <label>Collection</label>
      <select id="lab-collection">
        ${LAB_COLLECTIONS.map((c) => `<option${c === state.collection ? ' selected' : ''}>${esc(c)}</option>`).join('')}
      </select>
    </div>
    <div class="lab-field">
      <label>Recipe name <span class="lab-note">what players see in the list — not the NFT's name</span></label>
      <input id="lab-name" type="text" value="${esc(state.name)}" placeholder="e.g. Forge a Mycelium Helmet" autocomplete="off" />
    </div>
    <div class="lab-field">
      <label>This is a…</label>
      <div class="lab-seg">
        <button class="${state.kind === 'blend' ? 'on' : ''}" data-lab="kind" data-kind="blend">Blend<small>burn NFTs → mint one</small></button>
        <button class="${state.kind === 'upgrade' ? 'on' : ''}" data-lab="kind" data-kind="upgrade">Upgrade<small>rewrite an NFT in place</small></button>
      </div>
    </div>`;
}

function stepGive(): string {
  if (state.picking === 'ingredient') return picker('ingredient');
  return `
    <h3 class="lab-q">What does a player give up?</h3>
    <p class="lab-hint">Pick the NFTs from your collection — no ids to remember.</p>
    <div class="lab-rows">
      ${state.ingredients.map((ing, idx) => {
        const t = tpl(ing.templateId);
        return `
        <div class="lab-row">
          <span class="lab-tpl-art">${t?.art ?? '❔'}</span>
          <span class="lab-row-main">
            <strong>${esc(t?.name ?? `template ${ing.templateId}`)}</strong>
            <span class="lab-tpl-meta">${esc(t?.schema ?? '')} · #${ing.templateId}</span>
          </span>
          <span class="lab-stepper">
            <button data-lab="ing-minus" data-idx="${idx}">−</button>
            <b>${ing.amount}</b>
            <button data-lab="ing-plus" data-idx="${idx}">+</button>
          </span>
          <span class="lab-seg small">
            <button class="${ing.sendTo ? '' : 'on danger'}" data-lab="ing-burn" data-idx="${idx}">Burn</button>
            <button class="${ing.sendTo ? 'on' : ''}" data-lab="ing-keep" data-idx="${idx}">Send to vault</button>
          </span>
          <button class="lab-x" data-lab="ing-del" data-idx="${idx}">✕</button>
        </div>`;
      }).join('')}
    </div>
    <button class="lab-add" data-lab="open-ingredient">+ Add something to give up</button>
    <div class="lab-callout danger">
      <strong>Burned means destroyed.</strong> ${state.ingredients.filter((i) => !i.sendTo).length} of
      ${state.ingredients.length} ingredient(s) would be permanently destroyed on every blend.
      “Send to vault” keeps them in an account you own instead.
    </div>`;
}

function stepGet(): string {
  if (state.picking === 'outcome') return picker('outcome');
  const total = state.outcomes.reduce((n, o) => n + o.weight, 0) || 1;
  const colours = ['#7c9cff', '#86c97f', '#f0a860', '#e8798f', '#c58cf5', '#5ec8d8'];
  return `
    <h3 class="lab-q">What do they get?</h3>
    <p class="lab-hint">One line is a certainty. Add more and it becomes a draw — the bar shows the real chances.</p>

    <div class="lab-bar">
      ${state.outcomes.map((o, i) => `
        <span class="lab-bar-seg" style="width:${(o.weight / total) * 100}%; background:${colours[i % colours.length]}"
              title="${esc(o.templateId === null ? 'nothing' : tpl(o.templateId)?.name ?? '')} — ${pct(o.weight, total)}"></span>`).join('')}
    </div>

    <div class="lab-rows">
      ${state.outcomes.map((o, idx) => {
        const t = o.templateId === null ? null : tpl(o.templateId);
        return `
        <div class="lab-row">
          <span class="lab-swatch" style="background:${colours[idx % colours.length]}"></span>
          <span class="lab-tpl-art">${o.templateId === null ? '🚫' : t?.art ?? '❔'}</span>
          <span class="lab-row-main">
            <strong>${o.templateId === null ? 'Nothing' : esc(t?.name ?? '')}</strong>
            <span class="lab-tpl-meta">${o.templateId === null ? 'the player gets nothing on this branch' : `${esc(t?.schema ?? '')} · #${o.templateId}`}</span>
          </span>
          <input class="lab-weight" type="range" min="1" max="100" value="${o.weight}" data-lab="odds" data-idx="${idx}" />
          <b class="lab-pct">${pct(o.weight, total)}</b>
          <button class="lab-x" data-lab="out-del" data-idx="${idx}">✕</button>
        </div>`;
      }).join('')}
    </div>
    <div class="lab-row-actions">
      <button class="lab-add" data-lab="open-outcome">+ Add a possible reward</button>
      <button class="lab-add" data-lab="out-nothing">+ Add a “nothing” branch</button>
    </div>
    ${state.outcomes.length > 1
      ? '<div class="lab-callout">This is a <strong>lottery</strong>: the contract picks one line per blend and the others do not happen. The player still pays the full cost.</div>'
      : '<div class="lab-callout ok">Single outcome — every player gets this, guaranteed.</div>'}`;
}

/**
 * Upgrades replace step 3 entirely: nothing is minted, so there is no
 * reward to pick — you choose which attribute is rewritten and how. The
 * odds machinery is the same, which is why the bar is reused.
 */
function stepMutate(): string {
  const total = state.mutations.reduce((n, m) => n + m.weight, 0) || 1;
  const colours = ['#7c9cff', '#86c97f', '#f0a860', '#e8798f', '#c58cf5', '#5ec8d8'];
  return `
    <h3 class="lab-q">What changes on the NFT?</h3>
    <p class="lab-hint">
      An upgrade mints nothing. The player keeps the same NFT and one of its
      attributes is rewritten in place — which is why it cannot be undone.
    </p>

    <div class="lab-field">
      <label>Who qualifies</label>
      <div class="lab-gate">
        <span>Only NFTs whose</span>
        <select data-lab="req-attr">
          ${LAB_ATTRIBUTES.filter((a) => a.type === 'uint64').map((a) =>
            `<option${a.name === state.requireAttr ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}
        </select>
        <span>is at most</span>
        <input type="number" min="0" id="lab-req-max" value="${esc(state.requireMax)}" placeholder="no limit" />
      </div>
      <p class="lab-note">Leave it empty to let every NFT in the collection qualify.</p>
    </div>

    ${state.mutations.length > 1 ? `
      <div class="lab-bar">
        ${state.mutations.map((m, i) => `
          <span class="lab-bar-seg" style="width:${(m.weight / total) * 100}%; background:${colours[i % colours.length]}"
                title="${esc(m.attribute)} — ${pct(m.weight, total)}"></span>`).join('')}
      </div>` : ''}

    <div class="lab-rows">
      ${state.mutations.map((m, idx) => {
        const attr = LAB_ATTRIBUTES.find((a) => a.name === m.attribute);
        return `
        <div class="lab-row">
          <span class="lab-swatch" style="background:${colours[idx % colours.length]}"></span>
          <select data-lab="mut-attr" data-idx="${idx}" class="lab-inline">
            ${LAB_ATTRIBUTES.map((a) => `<option${a.name === m.attribute ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}
          </select>
          <span class="lab-seg small">
            <button class="${m.op === 'set' ? 'on' : ''}" data-lab="mut-set" data-idx="${idx}">is set to</button>
            <button class="${m.op === 'add' ? 'on' : ''}" data-lab="mut-add" data-idx="${idx}"
                    ${attr?.type === 'string' ? 'disabled title="numbers only"' : ''}>goes up by</button>
          </span>
          <input class="lab-inline" type="text" data-lab="mut-value" data-idx="${idx}"
                 value="${esc(m.value)}" placeholder="${esc(attr?.sample ?? '1')}" />
          ${state.mutations.length > 1
            ? `<input class="lab-weight" type="range" min="1" max="100" value="${m.weight}" data-lab="mut-odds" data-idx="${idx}" />
               <b class="lab-pct">${pct(m.weight, total)}</b>`
            : ''}
          <button class="lab-x" data-lab="mut-del" data-idx="${idx}">✕</button>
        </div>`;
      }).join('')}
    </div>
    <button class="lab-add" data-lab="mut-ADD">+ Add another possible result</button>
    <div class="lab-callout ${state.mutations.length > 1 ? '' : 'ok'}">
      ${state.mutations.length > 1
        ? 'More than one result makes this a <strong>random</strong> upgrade: the contract picks one line and rewrites that attribute only.'
        : 'One result — every player who qualifies gets exactly this change.'}
    </div>`;
}

function stepRules(): string {
  return `
    <h3 class="lab-q">Any limits?</h3>
    <p class="lab-hint">All optional. Skip them and the recipe is open, unlimited and live immediately.</p>
    <div class="lab-field">
      <label>Max blends per wallet <span class="lab-note">empty = unlimited</span></label>
      <input id="lab-limit" type="number" min="0" value="${esc(state.limitPerWallet)}" placeholder="unlimited" />
    </div>
    <div class="lab-field">
      <label>Who can use it</label>
      <select><option>Everyone</option><option>Only “Forepunk” (whitelist #831)</option><option>Only “Dev tools” (whitelist #795)</option></select>
      <p class="lab-note">Your collection's whitelists, by name — no ids to look up.</p>
    </div>
    <label class="lab-check">
      <input type="checkbox" ${state.hidden ? 'checked' : ''} data-lab="hidden" />
      <span><strong>Create it hidden</strong> — it exists on chain but appears in no list, so you can test it before players find it. Recommended for a first recipe.</span>
    </label>`;
}

function stepReview(): string {
  const oTotal = state.outcomes.reduce((n, o) => n + o.weight, 0) || 1;
  const mTotal = state.mutations.reduce((n, m) => n + m.weight, 0) || 1;
  const resultRow = state.kind === 'upgrade'
    ? `<div><span>Rewrites</span><b>${state.mutations.map((m) =>
        `${pct(m.weight, mTotal)} ${esc(m.attribute)} ${m.op === 'add' ? '+=' : '='} ${esc(m.value || '?')}`).join(' · ')}</b></div>
       <div><span>Qualifies</span><b>${state.requireMax.trim()
         ? `${esc(state.requireAttr)} ≤ ${esc(state.requireMax)}`
         : 'every NFT in the collection'}</b></div>`
    : `<div><span>Draw</span><b>${state.outcomes.map((o) =>
        `${pct(o.weight, oTotal)} ${o.templateId === null ? 'nothing' : esc(tpl(o.templateId)?.name ?? '')}`).join(' · ')}</b></div>`;
  return `
    <h3 class="lab-q">Does this read the way you meant it?</h3>
    <div class="lab-sentence big">${esc(plainSentence())}</div>
    <div class="lab-review">
      <div><span>Collection</span><b>${esc(state.collection)}</b></div>
      <div><span>Name</span><b>${esc(state.name || '(unnamed)')}</b></div>
      <div><span>Cost</span><b>${state.ingredients.map((i) => `${i.amount}× ${esc(tpl(i.templateId)?.name ?? '')}`).join(', ') || '—'}</b></div>
      <div><span>Destroyed</span><b class="${state.ingredients.some((i) => !i.sendTo) ? 'warn' : ''}">${state.ingredients.filter((i) => !i.sendTo).length} of ${state.ingredients.length}</b></div>
      ${resultRow}
      <div><span>Visibility</span><b>${state.hidden ? 'hidden (safe to test)' : 'visible immediately'}</b></div>
    </div>
    <div class="lab-callout danger">
      In the real version this is where the beta confirmation appears, and the
      <strong>Simulate</strong> button shows the exact transaction before anything is signed.
    </div>
    <button class="lab-primary" disabled>Sign &amp; create — disabled in this preview</button>`;
}

export function renderLabPage(): string {
  const body = [
    stepCollection,
    stepGive,
    state.kind === 'upgrade' ? stepMutate : stepGet,
    stepRules,
    stepReview,
  ][state.step]();
  return `
    <a class="app-link" href="#/nefty" style="margin-bottom:14px">← Open the app</a>
    <section class="lab">
      <div class="lab-head">
        <span class="lab-badge">DESIGN PREVIEW</span>
        <h2>Creating a ${state.kind === 'blend' ? 'blend' : 'upgrade'} — what the next version could look like</h2>
      </div>
      <p class="lab-intro">
        A prototype of the interaction, not a working creator: nothing here reads or writes the
        chain, and the NFTs are stand-ins. The current form works, but it asks you to learn a
        syntax and to remember template ids. This asks one question per screen, lets you
        <strong>pick</strong> instead of type, turns the odds into a picture, and keeps one plain
        sentence in view the whole time — if that sentence is wrong, the recipe is wrong.
      </p>

      ${stepRail()}
      ${/* Review shows the sentence at full size inside the panel; a second
            copy directly above it would just read as a rendering bug. */
        state.step === STEP_COUNT - 1 ? '' : `<div class="lab-sentence">${esc(plainSentence())}</div>`}
      <div class="lab-panel">${body}</div>

      <div class="lab-nav">
        <button class="lab-ghost" data-lab="prev" ${state.step === 0 ? 'disabled' : ''}>← Back</button>
        <span class="lab-step-of">Step ${state.step + 1} of ${STEP_COUNT}</span>
        <button class="lab-primary" data-lab="next" ${state.step === STEP_COUNT - 1 ? 'disabled' : ''}>Continue →</button>
      </div>
    </section>`;
}

/** Wires the prototype. Pure local state; nothing leaves the page. */
export function attachLabHandlers(root: HTMLElement, rerender: () => void): void {
  const num = (el: HTMLElement, k: string) => Number(el.dataset[k]);

  root.querySelectorAll<HTMLElement>('[data-lab]').forEach((el) => {
    const kind = el.dataset.lab!;
    if (kind === 'odds' || kind === 'mut-odds') {
      el.addEventListener('input', () => {
        const w = Number((el as HTMLInputElement).value);
        if (kind === 'odds') state.outcomes[num(el, 'idx')].weight = w;
        else state.mutations[num(el, 'idx')].weight = w;
        rerender();
      });
      return;
    }
    // Free-text mutation value: keep focus, so no re-render on every key.
    // The sentence still catches up on the next interaction.
    if (kind === 'mut-value') {
      el.addEventListener('input', () => { state.mutations[num(el, 'idx')].value = (el as HTMLInputElement).value; });
      el.addEventListener('change', () => rerender());
      return;
    }
    if (kind === 'mut-attr') {
      el.addEventListener('change', () => {
        const m = state.mutations[num(el, 'idx')];
        m.attribute = (el as HTMLSelectElement).value;
        const type = LAB_ATTRIBUTES.find((a) => a.name === m.attribute)?.type;
        // `+=` is numbers-only, so a switch to a string attribute has to
        // fall back to "is set to" rather than leave an impossible pair.
        if (type === 'string') m.op = 'set';
        // Drop a value the new type cannot hold, so the placeholder can
        // show what this attribute actually expects.
        if (type === 'uint64' && !/^\d+$/.test(m.value)) m.value = '';
        if (type === 'string' && /^\d+$/.test(m.value)) m.value = '';
        rerender();
      });
      return;
    }
    if (kind === 'req-attr') {
      el.addEventListener('change', () => { state.requireAttr = (el as HTMLSelectElement).value; rerender(); });
      return;
    }
    if (kind === 'hidden') {
      el.addEventListener('change', () => { state.hidden = (el as HTMLInputElement).checked; rerender(); });
      return;
    }
    el.addEventListener('click', () => {
      const i = num(el, 'idx');
      switch (kind) {
        case 'step':  state.step = num(el, 'step'); break;
        case 'next':  state.step = Math.min(STEP_COUNT - 1, state.step + 1); break;
        case 'prev':  state.step = Math.max(0, state.step - 1); break;
        case 'kind':  state.kind = el.dataset.kind as LabKind; break;
        case 'open-ingredient': state.picking = 'ingredient'; state.search = ''; break;
        case 'open-outcome':    state.picking = 'outcome'; state.search = ''; break;
        case 'close-picker':    state.picking = undefined; break;
        case 'pick-ingredient':
          state.ingredients.push({ templateId: num(el, 'id'), amount: 1 });
          state.picking = undefined;
          break;
        case 'pick-outcome':
          state.outcomes.push({ templateId: num(el, 'id'), weight: 1 });
          state.picking = undefined;
          break;
        case 'out-nothing': state.outcomes.push({ templateId: null, weight: 1 }); break;
        case 'ing-plus':  state.ingredients[i].amount += 1; break;
        case 'ing-minus': state.ingredients[i].amount = Math.max(1, state.ingredients[i].amount - 1); break;
        case 'ing-burn':  state.ingredients[i].sendTo = undefined; break;
        case 'ing-keep':  state.ingredients[i].sendTo = 'vault.wam'; break;
        case 'ing-del':   state.ingredients.splice(i, 1); break;
        case 'out-del':   state.outcomes.splice(i, 1); break;
        case 'mut-set':   state.mutations[i].op = 'set'; break;
        case 'mut-add':   state.mutations[i].op = 'add'; break;
        case 'mut-del':   state.mutations.splice(i, 1); break;
        case 'mut-ADD':
          state.mutations.push({ attribute: state.requireAttr, op: 'add', value: '1', weight: 1 });
          break;
      }
      rerender();
    });
  });

  const search = root.querySelector<HTMLInputElement>('#lab-search');
  if (search) search.addEventListener('input', () => { state.search = search.value; rerender(); });
  const name = root.querySelector<HTMLInputElement>('#lab-name');
  if (name) name.addEventListener('input', () => { state.name = name.value; rerender(); });
  const coll = root.querySelector<HTMLSelectElement>('#lab-collection');
  if (coll) coll.addEventListener('change', () => { state.collection = coll.value; rerender(); });
  const limit = root.querySelector<HTMLInputElement>('#lab-limit');
  if (limit) limit.addEventListener('input', () => { state.limitPerWallet = limit.value; rerender(); });
  const reqMax = root.querySelector<HTMLInputElement>('#lab-req-max');
  if (reqMax) reqMax.addEventListener('input', () => { state.requireMax = reqMax.value; rerender(); });
}
