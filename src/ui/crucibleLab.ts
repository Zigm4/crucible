/**
 * LAB tool: Crucible Contracts.
 *
 * The other two tools on this page drive somebody else's contracts. This one
 * drives ours, the recipe engine being built in ../crucible-contracts. It
 * exists for two reasons.
 *
 * The first is honest self-interest. A wire format is frozen the day clients
 * consume it, and the only way to find out whether ours is usable is to write
 * the client that uses it. Everything awkward here is a thing to fix while it
 * still costs ten minutes.
 *
 * The second is explanation. Nothing on this page can be signed yet: the
 * contract is not deployed. What it does instead is walk the whole path a
 * creator will take, show the exact actions that path produces, and say at each
 * turn what the engine does that the four incumbent contracts do not. That is
 * material for a conversation with a collection, not a launch announcement.
 */
import { listDropTokens, type DropToken } from '../nefty/dropTokens';

// ─── the shape of a recipe, as this engine sees it ──────────────────────────

type Disposition = 'keep' | 'burn' | 'send' | 'return' | 'lock';
type AwardKind = 'mint' | 'write';

interface CruIngredient {
  slot: number;
  match: 'template' | 'schema' | 'collection';
  templateId: string;
  schemaName: string;
  amount: string;
  disp: Disposition;
  to: string;
}

interface CruWrite {
  name: string;
  type: string;
  op: 'set' | 'add';
  source: 'literal' | 'range';
  value: string;
  min: string;
  max: string;
}

interface CruAward {
  kind: AwardKind;
  templateId: string;
  schemaName: string;
  amount: string;
  targetSlot: string;
  writes: CruWrite[];
}

interface CruOutcome {
  weight: string;
  awards: CruAward[];
}

interface CruState {
  step: number;
  collection: string;
  recipeName: string;
  ingredients: CruIngredient[];
  outcomes: CruOutcome[];
  gate: 'none' | 'allowlist' | 'holding';
  gateTemplateId: string;
  gateMin: string;
  maxUses: string;
  accountLimit: string;
  accountCooldown: string;
  assetCooldown: string;
  priced: boolean;
  priceAmount: string;
  priceToken: string;
  priceTo: string;
  ramCap: string;
  /** The token list is shared with the Recipes tool: one source, one truth. */
  tokens: DropToken[];
  tokensState: 'idle' | 'loading' | 'ready';
  /** Steps the person has actually left, so a fresh form is not a wall of red. */
  visited: boolean[];
}

/**
 * Where the engine will live.
 *
 * This was a placeholder while the name was still unreserved. The auction on
 * `crucible` is now running with our bid at the top of the whole chain, so the
 * name is printed rather than hidden: an author being asked to authorise an
 * account on their own collection deserves to read which one.
 *
 * Until that auction closes the name is not held, which the review step says
 * out loud rather than leaving the reader to assume otherwise.
 */
const CONTRACT = 'crucible';

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
const STEPS = ['Collection', 'What they bring', 'What they get', 'Who may run it', 'Review'];

const state: CruState = {
  step: 0,
  collection: '',
  recipeName: '',
  ingredients: [
    { slot: 0, match: 'template', templateId: '', schemaName: '', amount: '1', disp: 'keep', to: '' },
  ],
  outcomes: [
    { weight: '100', awards: [{ kind: 'write', templateId: '', schemaName: '', amount: '1', targetSlot: '0', writes: [
      { name: 'level', type: 'uint32', op: 'add', source: 'literal', value: '1', min: '1', max: '10' },
    ] }] },
  ],
  gate: 'none',
  gateTemplateId: '',
  gateMin: '1',
  maxUses: '',
  accountLimit: '',
  accountCooldown: '',
  assetCooldown: '',
  priced: false,
  priceAmount: '10.0',
  priceToken: 'WAX',
  priceTo: '',
  ramCap: '10000000',
  tokens: [],
  tokensState: 'idle',
  visited: [true, false, false, false, false],
};

let rerender: () => void = () => {};

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

const int = (v: string, fallback = 0) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

/** Does this recipe need a draw? More than one outcome, or any rolled value. */
const needsDraw = () =>
  state.outcomes.length > 1 ||
  state.outcomes.some((o) => o.awards.some((a) => a.writes.some((w) => w.source === 'range')));

/** Does it ever hold somebody else's property? Token costs do not count. */
const takesCustody = () => state.ingredients.some((i) => i.disp !== 'keep');

/** Can it settle in a single transfer? Deterministic, ungated, unpriced. */
const memoFastPath = () => !needsDraw() && state.gate === 'none' && !state.priced;

const totalWeight = () => state.outcomes.reduce((n, o) => n + int(o.weight, 0), 0) || 1;

// ─── tokens ─────────────────────────────────────────────────────────────────

/** Decimals for the chosen token, read from the registry rather than typed.
 *  `10 WAX` is not `10.00000000 WAX`, and typing eight decimals into a
 *  four-decimal token is a silent factor of 10,000 the chain accepts. */
const tokenPrecision = () =>
  state.tokens.find((t) => t.ticker === state.priceToken)?.precision ?? 8;

const tokenContract = () =>
  state.tokens.find((t) => t.ticker === state.priceToken)?.contract ?? 'eosio.token';

/** The amount rendered with exactly the decimals the token declares. */
function normalisedPrice(): string {
  const n = Number.parseFloat(state.priceAmount.replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return '';
  return n.toFixed(tokenPrecision());
}

async function loadTokens(): Promise<void> {
  if (state.tokensState !== 'idle') return;
  state.tokensState = 'loading';
  try {
    const list = await listDropTokens();
    state.tokens = list;
    if (list.length && !list.some((t) => t.ticker === state.priceToken)) {
      state.priceToken = list[0].ticker;
    }
  } catch {
    // A missing token list is not fatal: the field falls back to what is typed.
  } finally {
    state.tokensState = 'ready';
    rerender();
  }
}

// ─── validation, as you go and at every step ────────────────────────────────
//
// A wizard that lets you reach the end with an empty required field has only
// moved the failure later, to the point where a wallet refuses a transaction
// nobody can read. Each step reports its own problems, Continue is disabled
// while any remain, and the rail refuses to jump past a step that is not done.

const isName = (v: string) => /^[a-z1-5.]{1,12}$/.test(v);
const isPositiveInt = (v: string) => /^\d+$/.test(v.trim()) && Number.parseInt(v, 10) > 0;
const isOptionalInt = (v: string) => v.trim() === '' || /^\d+$/.test(v.trim());
const NUMERIC_TYPES = ['uint32', 'uint64', 'int32', 'double'];

function stepProblems(step: number): string[] {
  const p: string[] = [];

  if (step === 0) {
    if (!state.collection.trim()) p.push('Name the collection this recipe belongs to.');
    else if (!isName(state.collection.trim()))
      p.push('A collection name is 1 to 12 characters, using a to z, 1 to 5 and dots.');
    if (!state.recipeName.trim()) p.push('Give the recipe a name, so a player can tell it from the others.');
  }

  if (step === 1) {
    if (!state.ingredients.length) p.push('A recipe needs at least one ingredient.');
    state.ingredients.forEach((i, n) => {
      const where = `Ingredient ${n + 1}`;
      if (i.match === 'template' && !isPositiveInt(i.templateId))
        p.push(`${where}: give the template id it must match.`);
      if (i.match === 'schema' && !i.schemaName.trim())
        p.push(`${where}: name the schema it must belong to.`);
      if (!isPositiveInt(i.amount)) p.push(`${where}: how many are needed, at least one.`);
      if ((i.disp === 'send' || i.disp === 'lock') && !isName(i.to.trim()))
        p.push(`${where}: an account has to receive it, and it cannot be left blank.`);
    });
    const slots = state.ingredients.map((i) => i.slot);
    if (new Set(slots).size !== slots.length) p.push('Two ingredients share a slot number.');
    if (state.priced) {
      if (!normalisedPrice()) p.push('The price has to be a positive amount.');
      if (!state.priceToken.trim()) p.push('Choose the token the recipe charges in.');
      if (!isName(state.priceTo.trim())) p.push('A token cost has to be paid to an account.');
    }
  }

  if (step === 2) {
    if (!state.outcomes.length) p.push('A recipe needs at least one outcome.');
    state.outcomes.forEach((o, n) => {
      const where = `Outcome ${n + 1}`;
      if (!isPositiveInt(o.weight)) p.push(`${where}: the weight has to be at least 1.`);
      o.awards.forEach((a, m) => {
        const aw = `${where}, reward ${m + 1}`;
        if (a.kind === 'mint') {
          if (!isPositiveInt(a.templateId)) p.push(`${aw}: give the template id to mint.`);
          if (!a.schemaName.trim()) p.push(`${aw}: name the schema of the minted asset.`);
          if (!isPositiveInt(a.amount)) p.push(`${aw}: how many to mint, at least one.`);
        } else {
          const slot = Number.parseInt(a.targetSlot, 10);
          if (!state.ingredients.some((i) => i.slot === slot))
            p.push(`${aw}: slot ${a.targetSlot} is not an ingredient of this recipe.`);
          if (!a.writes.length) p.push(`${aw}: a rewrite that writes nothing does nothing.`);
        }
        a.writes.forEach((w, k) => {
          const wr = `${aw}, attribute ${k + 1}`;
          if (!w.name.trim()) p.push(`${wr}: name the attribute.`);
          if (w.source === 'literal' && !w.value.trim()) p.push(`${wr}: give the value to write.`);
          if (w.source === 'range') {
            const lo = Number(w.min), hi = Number(w.max);
            if (!Number.isFinite(lo) || !Number.isFinite(hi)) p.push(`${wr}: the range needs two numbers.`);
            else if (lo > hi) p.push(`${wr}: the minimum is above the maximum, so nothing could be drawn.`);
            if (!NUMERIC_TYPES.includes(w.type))
              p.push(`${wr}: only a numeric attribute can be rolled in a range.`);
          }
        });
      });
    });
  }

  if (step === 3) {
    if (state.gate === 'holding') {
      if (!isPositiveInt(state.gateTemplateId)) p.push('Give the template a player has to hold.');
      if (!isPositiveInt(state.gateMin)) p.push('How many they have to hold, at least one.');
    }
    const limits: [string, string][] = [
      ['Total uses', state.maxUses],
      ['Per account', state.accountLimit],
      ['Account cooldown', state.accountCooldown],
      ['Asset cooldown', state.assetCooldown],
    ];
    for (const [label, v] of limits) {
      if (!isOptionalInt(v)) p.push(`${label}: a whole number, or leave it empty for no limit.`);
    }
    if (!isPositiveInt(state.ramCap))
      p.push('A storage allowance is required: a collection with none is refused rather than served for free.');
  }

  return p;
}

/** The first step that is not complete. The rail cannot jump past it. */
function firstIncompleteStep(): number {
  for (let i = 0; i < STEPS.length - 1; i++) if (stepProblems(i).length) return i;
  return STEPS.length - 1;
}

/** Problems are only shown once the person has been on the step. A fresh form
 *  that opens as a wall of red teaches nothing except to ignore red. */
function problemList(step: number): string {
  if (!state.visited[step]) return '';
  const problems = stepProblems(step);
  if (!problems.length) return '';
  return `
    <div class="lab-caution">
      <strong>${problems.length === 1 ? 'One thing to fix' : `${problems.length} things to fix`}
        before this step is done.</strong>
      <ul class="lab-list">${problems.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    </div>`;
}

// ─── explanation blocks ─────────────────────────────────────────────────────

/**
 * A contrast, not a feature. Every one of these carries a measured number,
 * because "better" without a number is marketing, and the whole point of this
 * project is that it is not marketing.
 */
const contrast = (title: string, body: string) => `
  <div class="lab-callout">
    <strong>${esc(title)}</strong>
    <p>${body}</p>
  </div>`;

const intro = () => `
  <div class="lab-intro">
    <h3>One engine instead of four contracts</h3>
    <p>
      A collection that wants to burn cards into a better card, sell a pack, and
      let players level up an item currently uses <strong>three different
      contracts</strong>, written by two companies, with three vocabularies and
      three sets of quirks. Each one has to be authorised separately, and each
      authorisation is irreversible.
    </p>
    <p>
      Crucible is one engine. A blend, an upgrade, a repair and a paid re-roll
      are the same machinery with different settings, because they always were.
      Splitting them is what let the incumbents drift apart.
      On a working collection it is normal to find <strong>four of the nine
      authorisation slots taken by NeftyBlocks alone</strong>, for exactly this
      reason.
    </p>
    <div class="lab-note">
      <strong>Nothing here can be signed yet.</strong> The contract is written
      and tested, with 251 tests run against the AtomicAssets bytecode actually
      deployed on mainnet, but it is not on chain. This tool walks the whole
      path and shows the exact actions it produces, so the shape can be judged
      before anything is frozen.
    </div>
  </div>`;

// ─── step 0 · collection ────────────────────────────────────────────────────

function stepCollection(): string {
  return `
    ${intro()}
    ${problemList(0)}

    <div class="lab-field">
      <label for="cru-collection">Collection</label>
      <input id="cru-collection" type="text" value="${esc(state.collection)}"
             placeholder="e.g. pearlhorizon" autocomplete="off" />
      <p class="lab-hint">
        The engine can only touch a collection whose author has added
        <code>${CONTRACT}</code> to its authorised accounts. That is one action,
        signed by the author, and it can be revoked at any moment.
      </p>
    </div>

    <div class="lab-field">
      <label for="cru-name">A name for this recipe</label>
      <input id="cru-name" type="text" value="${esc(state.recipeName)}"
             placeholder="e.g. Sharpen a blade" autocomplete="off" />
      <p class="lab-hint">
        Free text, stored as-is. The contract never parses it: 202 of 10,000
        real recipes carry display data that is not valid JSON, and a contract
        that validated it would reject 2% of the working world.
      </p>
    </div>

    ${contrast(
      'You will never need an indexer to list these',
      `Listing one collection's recipes on the incumbent means walking ~33,000 rows
       in 16 parallel chunks, because everything lives in one global pile. In
       practice that forces every client through AtomicHub's indexer, which is the
       exact central dependency this project exists to escape. Here each collection
       has its own scope, so a plain chain read is enough.`,
    )}`;
}

// ─── step 1 · ingredients ───────────────────────────────────────────────────

const DISPOSITIONS: { v: Disposition; label: string; sub: string }[] = [
  { v: 'keep',   label: 'kept',     sub: 'never leaves the wallet' },
  { v: 'burn',   label: 'burned',   sub: 'destroyed' },
  { v: 'send',   label: 'sent',     sub: 'to an account you name' },
  { v: 'return', label: 'returned', sub: 'held, then given back' },
  { v: 'lock',   label: 'locked',   sub: 'held until a date' },
];

function ingredientRow(ing: CruIngredient, i: number): string {
  const custody = ing.disp !== 'keep';
  const needsWho = ing.disp === 'send' || ing.disp === 'lock';
  return `
    <div class="lab-row lab-row-wide${custody ? ' lab-row-warn' : ''}">
      <span class="lab-tag">slot ${ing.slot}</span>

      <select class="lab-inline" data-cru="ing-match" data-idx="${i}">
        <option value="template"${ing.match === 'template' ? ' selected' : ''}>a specific template</option>
        <option value="schema"${ing.match === 'schema' ? ' selected' : ''}>anything in a schema</option>
        <option value="collection"${ing.match === 'collection' ? ' selected' : ''}>anything in the collection</option>
      </select>

      ${ing.match === 'template'
        ? `<input class="lab-inline" type="text" inputmode="numeric" id="cru-ing-template-${i}" data-cru="ing-template" data-idx="${i}"
                  value="${esc(ing.templateId)}" placeholder="template id" autocomplete="off" />`
        : ing.match === 'schema'
          ? `<input class="lab-inline" type="text" id="cru-ing-schema-${i}" data-cru="ing-schema" data-idx="${i}"
                    value="${esc(ing.schemaName)}" placeholder="schema name" autocomplete="off" />`
          : ''}

      <span class="lab-mini-label">how many</span>
      <input class="lab-inline" type="text" inputmode="numeric" id="cru-ing-amount-${i}" data-cru="ing-amount" data-idx="${i}"
             value="${esc(ing.amount)}" autocomplete="off" />

      <span class="lab-mini-label">then</span>
      <select class="lab-inline" data-cru="ing-disp" data-idx="${i}">
        ${DISPOSITIONS.map((d) => `<option value="${d.v}"${ing.disp === d.v ? ' selected' : ''}>${d.label}, ${d.sub}</option>`).join('')}
      </select>

      ${needsWho
        ? `<span class="lab-mini-label">to</span>
           <input class="lab-inline" type="text" id="cru-ing-to-${i}" data-cru="ing-to" data-idx="${i}"
                  value="${esc(ing.to)}" placeholder="account" autocomplete="off" />`
        : ''}

      <button class="lab-x" data-cru="ing-del" data-idx="${i}" title="Remove">×</button>
    </div>`;
}

function priceBlock(): string {
  const check = `
    <label class="lab-check">
      <input type="checkbox" data-cru="priced"${state.priced ? ' checked' : ''} />
      This recipe also costs tokens
    </label>`;

  if (!state.priced) return check;

  const options = state.tokens.length
    ? state.tokens.map((t) =>
        `<option value="${esc(t.ticker)}"${t.ticker === state.priceToken ? ' selected' : ''}>${esc(t.ticker)} (${t.precision} dp)</option>`).join('')
    : `<option value="${esc(state.priceToken)}" selected>${esc(state.priceToken)}</option>`;

  return `
    ${check}
    <div class="lab-row lab-row-wide">
      <span class="lab-tag">Price</span>
      <input class="lab-inline" type="text" inputmode="decimal" id="cru-price-amount" data-cru="price-amount"
             value="${esc(state.priceAmount)}" placeholder="10.0" autocomplete="off" />
      <select class="lab-inline" id="cru-price-token" data-cru="price-token">${options}</select>
    </div>
    <div class="lab-row lab-row-wide">
      <span class="lab-tag">Paid to</span>
      <input class="lab-inline" type="text" id="cru-price-to" data-cru="price-to"
             value="${esc(state.priceTo)}" placeholder="account" autocomplete="off" />
    </div>
    <p class="lab-hint">
      ${state.tokensState === 'loading'
        ? 'Loading the token list.'
        : `Sent as <code>${esc(normalisedPrice() || '?')} ${esc(state.priceToken)}</code>
           from <code>${esc(tokenContract())}</code>, with the ${tokenPrecision()} decimals
           that token declares. The precision is read from the registry rather than
           from whoever fills this in, because typing eight decimals into a
           four-decimal token is a silent factor of 10,000 the chain accepts.`}
    </p>
    ${contrast(
      'The recipient is required, and nothing is skimmed',
      `Every one of 358 real payment traces routes to an account, so the field has
       no default and “burn the payment” is not expressible. And Crucible keeps
       nothing: WaxDAO takes a hardcoded <strong>2% before the split it
       declares</strong>, so a recipe promising 100% to one account pays it 9.80
       out of 10.00.`,
    )}`;
}

function stepIngredients(): string {
  return `
    ${problemList(1)}
    <div class="lab-rows">${state.ingredients.map(ingredientRow).join('')}</div>
    <button class="lab-add" data-cru="ing-add">+ another ingredient</button>

    ${contrast(
      'The default is “kept”, and that is the whole point',
      `On the incumbent, an ingredient with no explicit destination is
       <strong>destroyed</strong>: the zero value means “gone forever”. One missing
       field between consumed and lost. Here the zero value means kept, so a client
       that forgets the field, or encodes it wrong, leaves the player's asset exactly
       where it was.`,
    )}

    ${takesCustody()
      ? `<div class="lab-caution">
           <strong>This recipe would hold a player's asset.</strong>
           Anything other than “kept” means the contract takes the item before it
           knows what to give back. That is the state where property can get stuck:
           <code>blend.nefty</code> has <strong>19 crafts frozen</strong> right now,
           ingredients consumed and reward never decided, and its recovery action has
           been called <strong>four times</strong> in its entire life against a
           million successful crafts.
           <br><br>
           The first Crucible contract refuses these outright, on a flag it computes
           itself, so a recipe cannot claim to be safe. They arrive in a second
           contract, later, once the first has earned its trust.
         </div>`
      : `<div class="lab-ok">
           <strong>This recipe never holds anything.</strong> Every ingredient stays
           in the player's wallet from beginning to end. The worst possible bug is a
           function that does not work, never property that cannot move.
         </div>`}

    <div class="lab-field">${priceBlock()}</div>`;
}

// ─── step 2 · outcomes ──────────────────────────────────────────────────────

function writeRow(w: CruWrite, oi: number, ai: number, wi: number): string {
  const d = `data-o="${oi}" data-a="${ai}" data-w="${wi}"`;
  return `
    <div class="lab-row lab-row-wide">
      <input class="lab-inline" type="text" id="cru-w-name-${oi}-${ai}-${wi}" data-cru="w-name" ${d}
             value="${esc(w.name)}" placeholder="attribute" autocomplete="off" />
      <select class="lab-inline" data-cru="w-type" ${d}>
        ${['uint32', 'uint64', 'int32', 'string', 'double', 'bool'].map((t) =>
          `<option value="${t}"${w.type === t ? ' selected' : ''}>${t}</option>`).join('')}
      </select>
      <select class="lab-inline" data-cru="w-op" ${d}>
        <option value="set"${w.op === 'set' ? ' selected' : ''}>set to</option>
        <option value="add"${w.op === 'add' ? ' selected' : ''}>add</option>
      </select>
      <select class="lab-inline" data-cru="w-source" ${d}>
        <option value="literal"${w.source === 'literal' ? ' selected' : ''}>a fixed value</option>
        <option value="range"${w.source === 'range' ? ' selected' : ''}>a rolled value</option>
      </select>
      ${w.source === 'literal'
        ? `<input class="lab-inline" type="text" id="cru-w-value-${oi}-${ai}-${wi}" data-cru="w-value" ${d}
                  value="${esc(w.value)}" placeholder="value" autocomplete="off" />`
        : `<span class="lab-mini-label">from</span>
           <input class="lab-inline" type="text" inputmode="numeric" id="cru-w-min-${oi}-${ai}-${wi}" data-cru="w-min" ${d}
                  value="${esc(w.min)}" autocomplete="off" />
           <span class="lab-mini-label">to</span>
           <input class="lab-inline" type="text" inputmode="numeric" id="cru-w-max-${oi}-${ai}-${wi}" data-cru="w-max" ${d}
                  value="${esc(w.max)}" autocomplete="off" />`}
      <button class="lab-x" data-cru="w-del" ${d} title="Remove">×</button>
    </div>`;
}

function awardBlock(a: CruAward, oi: number, ai: number): string {
  const d = `data-o="${oi}" data-a="${ai}"`;
  return `
    <div class="lab-gate">
      <div class="lab-row lab-row-wide">
        <span class="lab-tag">reward ${ai + 1}</span>
        <select class="lab-inline" data-cru="a-kind" ${d}>
          <option value="write"${a.kind === 'write' ? ' selected' : ''}>rewrite what they brought</option>
          <option value="mint"${a.kind === 'mint' ? ' selected' : ''}>mint a new asset</option>
        </select>
        ${a.kind === 'mint'
          ? `<span class="lab-mini-label">template</span>
             <input class="lab-inline" type="text" inputmode="numeric" id="cru-a-template-${oi}-${ai}" data-cru="a-template" ${d}
                    value="${esc(a.templateId)}" autocomplete="off" />
             <span class="lab-mini-label">schema</span>
             <input class="lab-inline" type="text" id="cru-a-schema-${oi}-${ai}" data-cru="a-schema" ${d}
                    value="${esc(a.schemaName)}" autocomplete="off" />
             <span class="lab-mini-label">how many</span>
             <input class="lab-inline" type="text" inputmode="numeric" id="cru-a-amount-${oi}-${ai}" data-cru="a-amount" ${d}
                    value="${esc(a.amount)}" autocomplete="off" />`
          : `<span class="lab-mini-label">in</span>
             <select class="lab-inline" data-cru="a-slot" ${d}>
               ${state.ingredients.map((i) =>
                 `<option value="${i.slot}"${String(i.slot) === a.targetSlot ? ' selected' : ''}>slot ${i.slot}</option>`).join('')}
             </select>`}
        <button class="lab-x" data-cru="a-del" ${d} title="Remove">×</button>
      </div>
      <div class="lab-rows">${a.writes.map((w, wi) => writeRow(w, oi, ai, wi)).join('')}</div>
      <button class="lab-add" data-cru="w-add" ${d}>+ another attribute</button>
    </div>`;
}

function outcomeBlock(o: CruOutcome, oi: number): string {
  const share = Math.round((int(o.weight, 0) / totalWeight()) * 1000) / 10;
  return `
    <div class="lab-gate">
      <div class="lab-row lab-row-wide">
        <span class="lab-tag">outcome ${oi + 1}</span>
        <span class="lab-mini-label">weight</span>
        <input class="lab-inline" type="text" inputmode="numeric" id="cru-o-weight-${oi}" data-cru="o-weight" data-o="${oi}"
               value="${esc(o.weight)}" autocomplete="off" />
        <span class="lab-pct">${share}% of draws</span>
        <button class="lab-x" data-cru="o-del" data-o="${oi}" title="Remove">×</button>
      </div>
      ${o.awards.map((a, ai) => awardBlock(a, oi, ai)).join('')}
      <button class="lab-add" data-cru="a-add" data-o="${oi}">+ another reward in this outcome</button>
      ${o.awards.length === 0
        ? `<p class="lab-hint">No reward: this is the blank outcome, “you got unlucky”. It is a real shape: one live blend opens with a blank at 2000 in 10,000.</p>`
        : ''}
    </div>`;
}

function stepOutcomes(): string {
  return `
    ${problemList(2)}
    <div class="lab-rows">${state.outcomes.map(outcomeBlock).join('')}</div>
    <button class="lab-add" data-cru="o-add">+ another outcome</button>

    ${contrast(
      'You give weights. The total is the contract’s business.',
      `On the incumbent the total is <em>stored</em> and never recalculated, so a
       total that disagrees with the weights <strong>skews the draw silently instead
       of erroring</strong>, and <code>atomicpacks</code> caches the same number,
       which is exactly the invariant editable outcomes break. Here no caller can
       even express the total.`,
    )}

    ${needsDraw()
      ? contrast(
          'This recipe needs a draw, and the player can check it',
          `The result is decided by the WAX randomness oracle, and the receipt
           <strong>publishes the seed</strong>. How that seed becomes each number is
           written down, so anyone can recompute the outcome and verify it. Across
           every other contract surveyed, that splitting rule is unknown, because the
           analysis could read their interfaces and never their binaries, so nobody
           can check their draws at all.<br><br>
           The draw itself uses rejection sampling. Every open example on WAX takes a
           remainder instead, which is biased whenever the odds do not divide evenly:
           invisible at 10,000, a real house edge on “a value between 167 and 217”.`,
        )
      : contrast(
          'This recipe is certain, and it costs less to run',
          `Deterministic, ungated and unpriced recipes settle in a single transfer.
           The two-signature ceremony on the incumbent exists to carry randomness and
           gating, and it is charged to everyone regardless. <code>blenderizerx</code>
           carries 17,748 recipes against WaxDAO's 2,424 precisely because most of the
           market is the simple case.`,
        )}

    ${contrast(
      'And you can change these later',
      `Changing what a blend pays out is <strong>impossible</strong> on
       <code>blend.nefty</code> for anyone but NeftyBlocks: the action exists but
       takes no account to authorise against. <code>up.nefty</code> has no such action
       at all. <code>waxdaomarket</code> can edit the title and the picture and stops
       there. Deleting and recreating changes the id, which breaks every shared link.
       Here an outcome is one row, editable one at a time, which is what makes it work
       on a table of 1,512 outcomes, a size that has been measured live.`,
    )}`;
}

// ─── step 3 · who may run it ────────────────────────────────────────────────

function stepGate(): string {
  return `
    ${problemList(3)}

    <div class="lab-field">
      <label>Who may run this</label>
      <div class="lab-seg">
        <button class="${state.gate === 'none' ? 'on' : ''}" data-cru="gate-none">Anyone<small>565 of 600 recipes</small></button>
        <button class="${state.gate === 'allowlist' ? 'on' : ''}" data-cru="gate-allowlist">A named list<small>accounts you add</small></button>
        <button class="${state.gate === 'holding' ? 'on' : ''}" data-cru="gate-holding">Holders<small>own something first</small></button>
      </div>
      ${state.gate === 'holding'
        ? `<div class="lab-row lab-row-wide">
             <span class="lab-mini-label">must hold at least</span>
             <input class="lab-inline" type="text" inputmode="numeric" id="cru-gate-min" data-cru="gate-min"
                    value="${esc(state.gateMin)}" autocomplete="off" />
             <span class="lab-mini-label">of template</span>
             <input class="lab-inline" type="text" inputmode="numeric" id="cru-gate-template" data-cru="gate-template"
                    value="${esc(state.gateTemplateId)}" autocomplete="off" />
           </div>`
        : ''}
      ${state.gate !== 'none'
        ? contrast(
            'A player is told which requirement they face',
            `The incumbent stores a bare “there is a gate” flag, so its own front end
             tells a player <em>“you are not on the whitelist”</em> when they are in
             fact facing an ownership proof they could go and satisfy. Here the recipe
             row carries what kind of gate it is and how many accounts are on it, so
             one read gives the real answer.`,
          )
        : ''}
    </div>

    <div class="lab-field">
      <label>Limits</label>
      <div class="lab-pair">
        <label class="lab-mini">Total uses
          <input type="text" inputmode="numeric" id="cru-max-uses" data-cru="max-uses"
                 value="${esc(state.maxUses)}" placeholder="unlimited" autocomplete="off" />
        </label>
        <label class="lab-mini">Per account
          <input type="text" inputmode="numeric" id="cru-account-limit" data-cru="account-limit"
                 value="${esc(state.accountLimit)}" placeholder="unlimited" autocomplete="off" />
        </label>
        <label class="lab-mini">Account cooldown, seconds
          <input type="text" inputmode="numeric" id="cru-account-cooldown" data-cru="account-cooldown"
                 value="${esc(state.accountCooldown)}" placeholder="none" autocomplete="off" />
        </label>
        <label class="lab-mini">Asset cooldown, seconds
          <input type="text" inputmode="numeric" id="cru-asset-cooldown" data-cru="asset-cooldown"
                 value="${esc(state.assetCooldown)}" placeholder="none" autocomplete="off" />
        </label>
      </div>
      ${contrast(
        'The cooldown is on the item, not on the player',
        `The incumbent keys its cooldown on the account, so a player holding two
         identical swords is limited as though they held one. Here the second sword
         works while the first rests. Per-account limits also exist on every mechanic,
         where <code>up.nefty</code> has none at all, which is why its own editor
         hides the fields.`,
      )}
    </div>

    <div class="lab-field">
      <label for="cru-ramcap">Storage allowance, in bytes</label>
      <input id="cru-ramcap" type="text" inputmode="numeric" data-cru="ram-cap"
             value="${esc(state.ramCap)}" autocomplete="off" />
      ${contrast(
        'Someone has to pay for storage, and it is visible',
        `Every asset minted or rewritten becomes the contract's permanent storage
         cost, about $230 per million assets touched, and 635 MB sitting on
         <code>neftyblocksd</code> today. Both incumbents answer with an internal
         ledger of deposited bytes, which is a debt underwritten on somebody else's
         behalf. Crucible counts and caps instead: a collection with no allowance is
         refused rather than served for free, and what is left shows up in the recipe
         row before anyone signs.`,
      )}
    </div>`;
}

// ─── step 4 · review ────────────────────────────────────────────────────────

interface PreviewAction { account: string; name: string; auth: string; data: Record<string, unknown>; }

/** Which arm of the value variant a schema type must use. */
function wireArm(type: string): string {
  if (type === 'int32') return 'int64';
  if (type === 'uint32' || type === 'bool') return 'uint64';
  if (type === 'double') return 'dec';
  return 'string';   // string, and uint64 as a decimal string
}

function toWire(w: CruWrite) {
  return {
    type: w.type,
    name: w.name,
    op: w.op === 'set' ? 0 : 1,
    source: w.source === 'literal'
      ? ['v_lit', { value: [wireArm(w.type), w.value] }]
      : ['v_range', { min: { mantissa: w.min, exponent: 0 }, max: { mantissa: w.max, exponent: 0 } }],
  };
}

/** The exact actions this recipe becomes. Order matters and is shown. */
function buildActions(): PreviewAction[] {
  const col = state.collection.trim() || '<collection>';
  const author = '<your account>';
  const out: PreviewAction[] = [];

  if (state.gate !== 'none') {
    out.push({
      account: CONTRACT, name: 'newgate', auth: author,
      data: {
        authorized_account: author, collection_name: col, op: 0,
        use_allowlist: state.gate === 'allowlist',
        clauses: state.gate === 'holding'
          ? [{ match: ['m_template', { template_id: int(state.gateTemplateId) }], min_amount: int(state.gateMin, 1) }]
          : [],
        display_data: '',
      },
    });
  }

  out.push({
    account: CONTRACT, name: 'newroll', auth: author,
    data: { authorized_account: author, collection_name: col, owner_recipe_id: 1, draws: 1, policy: 0, display_data: '' },
  });

  state.outcomes.forEach((o, i) => {
    out.push({
      account: CONTRACT, name: 'addoutcome', auth: author,
      data: {
        authorized_account: author, collection_name: col, roll_id: 1,
        expected_rev: i + 1, weight: int(o.weight, 1),
        awards: o.awards.map((a) => a.kind === 'mint'
          ? ['a_mint', {
              collection_name: col, schema_name: a.schemaName, template_id: int(a.templateId),
              amount: int(a.amount, 1), immutable_data: [],
              mutable_data: a.writes.map(toWire), to: '',
            }]
          : ['a_write', { target_slot: int(a.targetSlot), mutable_data: a.writes.map(toWire) }]),
        display_data: '',
      },
    });
  });

  const ingredients: unknown[] = state.ingredients.map((i) => ({
    slot: i.slot,
    match: i.match === 'template'
      ? ['m_template', { template_id: int(i.templateId) }]
      : i.match === 'schema'
        ? ['m_schema', { collection_name: col, schema_name: i.schemaName }]
        : ['m_collection', { collection_name: col }],
    amount: int(i.amount, 1),
    disp: i.disp === 'keep' ? ['d_keep', {}]
        : i.disp === 'burn' ? ['d_burn', {}]
        : i.disp === 'return' ? ['d_return', {}]
        : i.disp === 'send' ? ['d_send', { to: i.to }]
        : ['d_lock', { to: i.to, unlock_time: 0 }],
    display_data: '',
  }));

  if (state.priced) {
    ingredients.push({
      slot: 250,
      match: ['m_token', {
        amount: { quantity: `${normalisedPrice()} ${state.priceToken}`, contract: tokenContract() },
      }],
      amount: 1,
      disp: ['d_send', { to: state.priceTo }],
      display_data: '',
    });
  }

  out.push({
    account: CONTRACT, name: 'newrecipe', auth: author,
    data: {
      authorized_account: author, collection_name: col, category: '',
      display_data: state.recipeName,
      start_time: 0, end_time: 0,
      max_uses: int(state.maxUses), account_limit: int(state.accountLimit),
      account_limit_cooldown: int(state.accountCooldown), asset_cooldown: int(state.assetCooldown),
      gate_id: state.gate === 'none' ? 0 : 1,
      ingredients,
      entry_roll_id: 1,
      max_awards_per_craft: 8,
      hidden: false,
    },
  });

  out.push({
    account: CONTRACT, name: 'setstatus', auth: author,
    data: {
      authorized_account: author, collection_name: col, recipe_id: 1, expected_rev: 1,
      new_status: 2, moved_to_contract: '', moved_to_recipe: 0,
    },
  });

  return out;
}

function stepReview(): string {
  const blocking = STEPS.slice(0, 4).flatMap((_, i) => stepProblems(i));
  if (blocking.length) {
    return `
      <div class="lab-caution">
        <strong>${blocking.length} thing(s) still to fix before this recipe exists.</strong>
        <ul class="lab-list">${blocking.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
        <p>Use the steps above. Nothing is previewed from a form that could not be signed.</p>
      </div>`;
  }

  const actions = buildActions();
  return `
    <div>
      <h3>${esc(state.recipeName)}</h3>
      <p class="lab-sub">
        ${plural(state.ingredients.length, 'ingredient')}, ${plural(state.outcomes.length, 'outcome')},
        ${state.gate === 'none' ? 'open to anyone' : 'gated'},
        ${state.priced ? `priced at ${esc(normalisedPrice())} ${esc(state.priceToken)}` : 'free'}.
      </p>

      <div class="lab-review">
        <div><span>Custody</span><b>${takesCustody() ? 'yes, needs the second contract' : 'never holds an asset'}</b></div>
        <div><span>Draw</span><b>${needsDraw() ? 'yes, settles when the oracle answers' : 'none, settles immediately'}</b></div>
        <div><span>Fast path</span><b>${memoFastPath() ? 'one transfer, memo carries the recipe' : 'not available for this shape'}</b></div>
        <div><span>Contract</span><b>${CONTRACT}</b></div>
      </div>

      <h4>What gets signed, in order</h4>
      <p class="lab-hint">
        Five or six actions, all authorised against the collection. Every one that
        changes something carries the revision it expects to change, so a stale editor
        cannot silently drop an ingredient from under a player mid-craft, which is
        exactly what the incumbent's replace-everything edit does today.
      </p>
      <div class="lab-rows">
        ${actions.map((a, n) => `
          <div class="lab-gate">
            <div class="lab-row lab-row-wide">
              <span class="lab-tag">${n + 1}</span>
              <strong>${esc(a.account)}::${esc(a.name)}</strong>
            </div>
            <pre class="lab-pre">${esc(JSON.stringify(a.data, null, 2))}</pre>
          </div>`).join('')}
      </div>

      <h4>Then a player runs it</h4>
      <pre class="lab-pre">${esc(JSON.stringify({
        account: CONTRACT, name: 'craft',
        data: {
          claimer: '<player>', collection_name: state.collection.trim(), recipe_id: 1,
          binds: state.ingredients.map((i) => ({ slot: i.slot, asset_ids: ['<asset id>'] })),
        },
      }, null, 2))}</pre>
      <p class="lab-hint">
        One action, always. The incumbent splits this into <code>fuse</code> and
        <code>nosecfuse</code>, chosen by <em>security</em> rather than by randomness,
        so unguessable that a real blend is rejected by both.
      </p>

      ${needsDraw()
        ? `<h4>And if the oracle never answers</h4>
           <p class="lab-hint">
             Two recovery actions, both <strong>permissionless</strong>: anyone at all
             can push them, including the player.
           </p>
           <div class="lab-review">
             <div><span>retryrand</span><b>asks the oracle again, one minute after the request</b></div>
             <div><span>sweepjobs</span><b>after a day, closes the job and marks the receipt as a recoverable failure</b></div>
           </div>
           ${contrast(
             'A recovery path nobody can reach is decoration',
             `<code>blend.nefty</code> ships the same kind of retry action. It has been
              called <strong>four times</strong> against 1,011,101 successful callbacks,
              because only its operator could push it. Its 19 stuck crafts are still
              there, the oldest 426,000 jobs behind the counter, and nobody can say
              whether those players lost anything. Silence is the failure.`,
           )}`
        : ''}

      <div class="lab-note">
        <strong>Nothing here can be broadcast.</strong> No contract is deployed at
        <code>${CONTRACT}</code> yet, and the name itself is still under auction:
        won means nothing until the chain closes it. Treat the account as intended,
        not as held. What this preview does show is the contract's real action
        shapes, produced by the same rules the engine enforces, so the format can be
        judged before it is frozen. Once a wire format has clients, it cannot be
        changed.
      </div>
    </div>`;
}

// ─── shell ──────────────────────────────────────────────────────────────────


// ─── the brief ──────────────────────────────────────────────────────────────
//
// Opening the tool straight onto a form assumes the reader already knows why
// the form exists. Most will not: the incumbents still work, and "another
// crafting contract" is not self-evidently worth anyone's authorisation slot.
// So the tool opens on the argument, in tabs, and the form waits behind it.

type BriefTab = { id: string; label: string; body: () => string };

const BRIEF: BriefTab[] = [
  {
    id: 'why',
    label: 'Why this exists',
    body: () => `
      <h3>The contracts still run. Nobody is behind them.</h3>
      <p>
        NeftyBlocks and WaxDAO built most of what WAX collections use to blend,
        upgrade and drop NFTs. Those contracts are still on chain and still
        serving millions of uses. What changed is that <strong>nobody has
        maintained them for about two years</strong>. No fixes, no answers, and
        no way to know what the code does, because most of it was never
        published.
      </p>
      <p>
        That is a strange place for a collection to be. The machinery holding
        your players' items works, right up until the day it does not, and there
        is no one to ask.
      </p>

      <h3>What Crucible changes</h3>
      <ul>
        <li>
          <strong>Open source, and reproducible.</strong> The source is
          published, and the build is checked so that what you read is what is
          deployed. You never have to take our word for what an action does.
        </li>
        <li>
          <strong>One engine instead of three.</strong> A blend, an upgrade, a
          repair and a paid re-roll are the same machinery with different
          settings. Today they are three contracts from two companies, with
          three vocabularies and three sets of quirks.
        </li>
        <li>
          <strong>Governed in the open.</strong> Who can change the contract, and
          how, is written down in public, with the weaknesses of the model stated
          rather than hidden.
        </li>
      </ul>
      <p>
        This is meant to be the union of what already exists, not a rival to it.
        Everything the incumbents do, one engine should do, and it should be
        readable.
      </p>`,
  },
  {
    id: 'contracts',
    label: 'Two contracts',
    body: () => `
      <h3>The split, and why it is the whole design</h3>
      <p>
        Crucible is <strong>two contracts, not one</strong>. What separates them
        is a single question: does the contract ever take your NFT?
      </p>
      <div class="brief-split">
        <div class="brief-card">
          <span class="tag now">Being built now</span>
          <h4>The one that never holds anything</h4>
          <p>
            It reads your assets, checks them against a recipe, and writes the
            result. Your items <strong>never leave your wallet</strong>. There is
            no deposit and no withdrawal, so there is no balance to drain and
            nothing to return if the contract stops. The worst possible bug is a
            feature that refuses to work.
          </p>
        </div>
        <div class="brief-card">
          <span class="tag later">Comes second</span>
          <h4>The one that does hold them</h4>
          <p>
            Some mechanics genuinely require custody: burning an ingredient,
            staking an item for a while, sending it to someone else. That work
            has to sit somewhere, and putting it in a separate contract means the
            risk is quarantined instead of spread across everything.
          </p>
        </div>
      </div>

      <h3>Why the custody-free one came first</h3>
      <ul>
        <li>
          <strong>It is the safer half.</strong> A contract holding nothing
          cannot lose anything. Shipping it first means the first thing on chain
          is the piece with the smallest blast radius.
        </li>
        <li>
          <strong>Most of the work is shared.</strong> Recipes, ingredient
          matching, conditions, weighted random draws, minting, attribute
          rewriting, limits and cooldowns are all in the first contract already.
          The second one does not redo any of it.
        </li>
        <li>
          <strong>They share one library.</strong> The formats, the type table,
          the error codes and the authorisation rules live in shared headers used
          by both. One definition, so the two contracts cannot quietly disagree
          about what a recipe means.
        </li>
        <li>
          <strong>The second is a smaller addition than it looks.</strong> On top
          of the shared base it mainly adds taking an asset in, giving it back,
          and the accounting that keeps those honest.
        </li>
      </ul>
      <p>
        As an author this matters practically: a recipe that only reads and
        rewrites is served by the contract that can never hold your items, and
        this tool tells you which side of the line your recipe falls on before
        you sign anything.
      </p>`,
  },
  {
    id: 'how',
    label: 'How it works',
    body: () => `
      <h3>Four moving parts</h3>
      <ul>
        <li>
          <strong>You authorise the contract.</strong> A collection author adds
          the contract to the collection's authorised accounts. One action, and
          it can be revoked at any moment.
        </li>
        <li>
          <strong>You write a recipe.</strong> What has to be brought, what comes
          out, who may run it, and what it costs. That is a row on chain, and
          this tool builds it.
        </li>
        <li>
          <strong>A player crafts.</strong> One action. The contract checks the
          ingredients, applies the conditions, and settles.
        </li>
        <li>
          <strong>Randomness, when a recipe needs it.</strong> A weighted draw
          waits for WAX's random oracle. The request is recorded, and the result
          is applied when the answer arrives.
        </li>
      </ul>

      <h3>What happens when something stalls</h3>
      <p>
        A draw that never gets an answer would otherwise strand the craft. So
        recovery is <strong>open to anyone</strong>, not just to us: one action
        asks the oracle again after a minute, and another closes a job that is
        still unanswered after a day and marks the receipt as a recoverable
        failure. Nobody has to wait on a maintainer who may not be there.
      </p>

      <h3>What this tool is</h3>
      <p>
        It walks the whole path and shows the exact actions it produces, so the
        shape can be judged before anything is frozen. <strong>Nothing here can
        be broadcast.</strong> The contract is written and tested, with 251 tests
        run against the AtomicAssets code actually deployed on mainnet, but it is
        not on chain yet.
      </p>`,
  },
  {
    id: 'covers',
    label: 'What it covers',
    body: () => `
      <h3>The mechanics, in one vocabulary</h3>
      <ul>
        <li><strong>Blends.</strong> Several assets in, something else out.</li>
        <li><strong>Upgrades.</strong> Rewrite an item's attributes in place, without it ever leaving the wallet.</li>
        <li><strong>Drops and packs.</strong> Mint on demand, with weighted odds.</li>
        <li><strong>Progression.</strong> Counters and levels that build up across crafts.</li>
        <li><strong>Paid recipes.</strong> A token cost alongside the ingredients.</li>
      </ul>

      <h3>How an ingredient can be matched</h3>
      <p>
        By exact asset, by template, by schema, by collection, or by an attribute
        it carries. One vocabulary covers what today needs three.
      </p>

      <h3>What a recipe may do with what it takes</h3>
      <p>
        Keep it, burn it, send it, lock it, or transfer it onward.
        <strong>Keep is the default</strong>, and that is deliberate: see the
        next tab.
      </p>

      <h3>Who may run it</h3>
      <p>
        Open to anyone, or gated on holding something, or restricted to a list.
        Plus total uses, a per-account limit, and cooldowns per account or per
        asset.
      </p>`,
  },
  {
    id: 'better',
    label: 'What we improved',
    body: () => `
      <h3>The default that cannot destroy anything</h3>
      <p>
        On the incumbent, an ingredient with no explicit destination is
        <strong>destroyed</strong>: the zero value means "gone forever". One
        missing field between consumed and lost. Here the zero value means
        <strong>kept</strong>, so a client that forgets the field, or encodes it
        wrong, leaves the player's asset exactly where it was.
      </p>

      <h3>Nothing is skimmed</h3>
      <p>
        WaxDAO takes a hardcoded <strong>2% before the split it declares</strong>,
        so a recipe promising 100% to one account actually pays it 9.80 out of
        10.00. Crucible takes nothing, and the recipient is a required field with
        no default.
      </p>

      <h3>Token decimals come from the chain, not from a form</h3>
      <p>
        The number of decimals is read from the token registry rather than from
        whoever fills the field in. Typing eight decimals into a four-decimal
        token is a silent factor of 10,000 that the chain accepts without
        complaint.
      </p>

      <h3>Storage cost is measured, capped, and shown</h3>
      <p>
        Every recipe declares a storage allowance up front. A collection with no
        allowance is refused rather than quietly served at our expense, and the
        cost is visible before you sign instead of arriving as a surprise.
      </p>

      <h3>Recovery does not depend on us</h3>
      <p>
        The actions that unstick a stalled draw can be called by anyone. A dead
        maintainer is exactly the situation this project exists because of, so
        the design assumes it.
      </p>

      <h3>Built for what comes next</h3>
      <p>
        AtomicAssets has a version 2 that is not deployed yet. Crucible is
        already tested against both, and carries a tripwire that notices if the
        code underneath it changes, rather than finding out through a broken
        craft.
      </p>`,
  },
];

let briefTab = 0;
let briefSeen = false;

/**
 * The explainer. Mounted on the body rather than inside the tool, so a repaint
 * of the form underneath cannot disturb it while it is being read.
 */
export function openBrief(): void {
  document.getElementById('cru-brief')?.remove();

  const wrap = document.createElement('div');
  wrap.id = 'cru-brief';
  wrap.className = 'modal-backdrop';

  const paint = () => {
    wrap.innerHTML = `
      <div class="brief" role="dialog" aria-modal="true" aria-labelledby="cru-brief-title">
        <div class="brief-head">
          <span class="lab-badge">PREVIEW</span>
          <h2 id="cru-brief-title">Crucible Contracts</h2>
        </div>
        <div class="brief-tabs" role="tablist">
          ${BRIEF.map((t, i) => `
            <button class="brief-tab" role="tab" data-brief-tab="${i}"
                    aria-selected="${i === briefTab}">${esc(t.label)}</button>`).join('')}
        </div>
        <div class="brief-body" role="tabpanel">${BRIEF[briefTab].body()}</div>
        <div class="brief-foot">
          <p class="lab-hint">
            ${briefTab < BRIEF.length - 1
              ? 'You can close this at any point and come back to it from the tool.'
              : 'That is the argument. The tool builds the recipe.'}
          </p>
          <button class="lab-primary" data-brief-close>Build a recipe</button>
        </div>
      </div>`;
  };

  const close = () => {
    wrap.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };

  wrap.addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    if (el === wrap || el.closest('[data-brief-close]')) { close(); return; }
    const tab = el.closest<HTMLElement>('[data-brief-tab]');
    if (tab) {
      briefTab = Number(tab.dataset.briefTab);
      paint();
      wrap.querySelector('.brief-body')?.scrollTo(0, 0);
    }
  });
  document.addEventListener('keydown', onKey);

  paint();
  document.body.appendChild(wrap);
  briefSeen = true;
}

/** Opens the brief the first time the tool is entered in this session. */
export function openBriefOnce(): void {
  if (!briefSeen) openBrief();
}

export function renderCrucibleTool(): string {
  const body = [stepCollection, stepIngredients, stepOutcomes, stepGate, stepReview][state.step]();
  const limit = firstIncompleteStep();

  const rail = STEPS.map((label, i) => {
    const done = i < state.step && stepProblems(i).length === 0;
    const cls = `lab-rail-step${i === state.step ? ' current' : ''}${done ? ' done' : ''}`;
    const reachable = i <= limit || i <= state.step;
    return `
      <li class="${cls}" data-cru="goto" data-step="${i}"${reachable ? '' : ' aria-disabled="true"'}>
        <span class="lab-rail-dot">${done ? '&check;' : i + 1}</span>
        <span class="lab-rail-label">${esc(label)}</span>
      </li>`;
  }).join('');

  const problems = stepProblems(state.step);
  const blocked = problems.length > 0;

  return `
    <div class="lab-topbar">
      <div class="lab-topbar-text">
        <div class="lab-head">
          <span class="lab-badge">PREVIEW</span>
          <h2>Crucible Contracts</h2>
        </div>
        <p class="lab-topbar-sub">
          One engine for blends, upgrades, drops and progression. Open source, and
          built so it never holds what a player owns.
        </p>
      </div>
      <button class="lab-ghost" data-cru="brief">Why this exists</button>
    </div>

    <ol class="lab-rail">${rail}</ol>
    <div class="lab-panel">${body}</div>

    <div class="lab-nav">
      <span class="lab-step-of">
        Step ${state.step + 1} of ${STEPS.length}${
          blocked
            ? ` &middot; ${problems.length === 1 ? 'one thing is' : `${problems.length} things are`} still missing`
            : ''}
      </span>
      <div class="lab-nav-actions">
        ${state.step > 0 ? `<button class="lab-ghost" data-cru="back">Back</button>` : ''}
        ${state.step < STEPS.length - 1
          ? `<button class="lab-primary" data-cru="next"${blocked ? ' disabled title="Fix what is listed above first"' : ''}>Continue</button>`
          : ''}
      </div>
    </div>`;
}

let wired = false;

export function attachCrucibleHandlers(root: HTMLElement, render: () => void): void {
  rerender = render;
  // Entering the tool opens the argument before the form. Once per session
  // only: re-reading it is a click away, and a modal that reappears on every
  // repaint would be unusable. The lab re-attaches on every paint whatever tool
  // is showing, so this has to check that it is actually ours before opening:
  // the reopen button exists only in this tool's header.
  if (root.querySelector('[data-cru="brief"]')) openBriefOnce();
  // The lab re-attaches on every paint. Listeners are delegated from the root,
  // so binding them twice would fire every handler twice.
  if (wired) return;
  wired = true;

  root.addEventListener('click', (ev) => {
    const el = (ev.target as HTMLElement)?.closest('[data-cru]') as HTMLElement | null;
    if (!el || el.tagName === 'INPUT' || el.tagName === 'SELECT') return;
    if (el.dataset.cru === 'brief') { openBrief(); return; }
    const o = Number(el.dataset.o), a = Number(el.dataset.a), w = Number(el.dataset.w);
    const i = Number(el.dataset.idx);

    switch (el.dataset.cru) {
      case 'next': {
        // Blocked by design: a wizard that lets you past an empty required
        // field has only moved the failure to the wallet.
        if (stepProblems(state.step).length) { state.visited[state.step] = true; break; }
        state.step = Math.min(STEPS.length - 1, state.step + 1);
        state.visited[state.step] = true;
        break;
      }
      case 'back': state.step = Math.max(0, state.step - 1); break;
      case 'goto': {
        const target = Number(el.dataset.step);
        // Going back is always allowed. Going forward stops at the first step
        // that is not finished, so the rail cannot skip a requirement.
        state.step = target <= state.step ? target : Math.min(target, firstIncompleteStep());
        state.visited[state.step] = true;
        break;
      }

      case 'ing-add':
        state.ingredients.push({
          slot: state.ingredients.length ? Math.max(...state.ingredients.map((x) => x.slot)) + 1 : 0,
          match: 'template', templateId: '', schemaName: '', amount: '1', disp: 'keep', to: '',
        });
        break;
      case 'ing-del':
        if (state.ingredients.length > 1) state.ingredients.splice(i, 1);
        break;

      case 'o-add': state.outcomes.push({ weight: '100', awards: [] }); break;
      case 'o-del': if (state.outcomes.length > 1) state.outcomes.splice(o, 1); break;
      case 'a-add':
        state.outcomes[o].awards.push({
          kind: 'write', templateId: '', schemaName: '', amount: '1',
          targetSlot: String(state.ingredients[0]?.slot ?? 0), writes: [],
        });
        break;
      case 'a-del': state.outcomes[o].awards.splice(a, 1); break;
      case 'w-add':
        state.outcomes[o].awards[a].writes.push({
          name: '', type: 'uint32', op: 'set', source: 'literal', value: '', min: '1', max: '10',
        });
        break;
      case 'w-del': state.outcomes[o].awards[a].writes.splice(w, 1); break;

      case 'gate-none': state.gate = 'none'; break;
      case 'gate-allowlist': state.gate = 'allowlist'; break;
      case 'gate-holding': state.gate = 'holding'; break;
      default: return;
    }
    rerender();
  });

  const read = (ev: Event, live: boolean) => {
    const el = (ev.target as HTMLElement)?.closest('[data-cru]') as HTMLInputElement | null;
    if (!el) return;
    const v = el.value;
    const o = Number(el.dataset.o), a = Number(el.dataset.a), w = Number(el.dataset.w);
    const i = Number(el.dataset.idx);

    switch (el.dataset.cru) {
      case 'ing-match':    state.ingredients[i].match = v as CruIngredient['match']; break;
      case 'ing-template': state.ingredients[i].templateId = v; break;
      case 'ing-schema':   state.ingredients[i].schemaName = v; break;
      case 'ing-amount':   state.ingredients[i].amount = v; break;
      case 'ing-disp':     state.ingredients[i].disp = v as Disposition; break;
      case 'ing-to':       state.ingredients[i].to = v; break;

      case 'o-weight':   state.outcomes[o].weight = v; break;
      case 'a-kind':     state.outcomes[o].awards[a].kind = v as AwardKind; break;
      case 'a-template': state.outcomes[o].awards[a].templateId = v; break;
      case 'a-schema':   state.outcomes[o].awards[a].schemaName = v; break;
      case 'a-amount':   state.outcomes[o].awards[a].amount = v; break;
      case 'a-slot':     state.outcomes[o].awards[a].targetSlot = v; break;

      case 'w-name':   state.outcomes[o].awards[a].writes[w].name = v; break;
      case 'w-type':   state.outcomes[o].awards[a].writes[w].type = v; break;
      case 'w-op':     state.outcomes[o].awards[a].writes[w].op = v as 'set' | 'add'; break;
      case 'w-source': state.outcomes[o].awards[a].writes[w].source = v as 'literal' | 'range'; break;
      case 'w-value':  state.outcomes[o].awards[a].writes[w].value = v; break;
      case 'w-min':    state.outcomes[o].awards[a].writes[w].min = v; break;
      case 'w-max':    state.outcomes[o].awards[a].writes[w].max = v; break;

      case 'priced':       state.priced = el.checked; if (el.checked) void loadTokens(); break;
      case 'price-amount': state.priceAmount = v; break;
      case 'price-token':  state.priceToken = v; break;
      case 'price-to':     state.priceTo = v; break;

      case 'gate-min':      state.gateMin = v; break;
      case 'gate-template': state.gateTemplateId = v; break;
      case 'max-uses':          state.maxUses = v; break;
      case 'account-limit':     state.accountLimit = v; break;
      case 'account-cooldown':  state.accountCooldown = v; break;
      case 'asset-cooldown':    state.assetCooldown = v; break;
      case 'ram-cap':           state.ramCap = v; break;
      default: return;
    }
    // Repaint on every keystroke. The app's render snapshot restores focus and
    // caret position for any field carrying an id, which every field here does,
    // so live validation costs nothing in usability.
    void live;
    rerender();
  };

  root.addEventListener('change', (ev) => read(ev, false));
  root.addEventListener('input', (ev) => {
    const el = ev.target as HTMLInputElement;
    if (el?.id === 'cru-collection') { state.collection = el.value; rerender(); return; }
    if (el?.id === 'cru-name') { state.recipeName = el.value; rerender(); return; }
    if (el?.id === 'cru-ramcap') { state.ramCap = el.value; rerender(); return; }
    read(ev, true);
  });
  // Leaving a field is when the person has finished thinking about it, so that
  // is when validation speaks up rather than nagging on every keystroke.
  root.addEventListener('blur', (ev) => {
    const el = ev.target as HTMLElement;
    if (!el?.closest?.('[data-cru]') && !['cru-collection', 'cru-name', 'cru-ramcap'].includes(el?.id)) return;
    state.visited[state.step] = true;
    rerender();
  }, true);
}
