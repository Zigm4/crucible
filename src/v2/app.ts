/**
 * Crucible: the guided interface as the whole site (it was "v2", at /v2/).
 * ─────────────────────────────────────────────────────────────
 * The classic page grew one dense form per contract. The lab grew next to
 * it and asks the same things one question at a time. This page is that
 * lab with a front door: a home that starts from what a person wants to
 * do, and a menu in place of the lab's tool bar.
 *
 * It owns very little on purpose. Every tool is the lab's (ui/lab), and
 * every read and every transaction comes from the same modules the classic
 * page uses, so both show the same recipes and the same artwork and sign
 * the same actions. What lives here is routing, the home, and the way to
 * the classic page, kept for a while at /backup/.
 *
 * Routes, all in the hash so the page stays a static file:
 *   #/                        home
 *   #/use/<kind~coll~id>      run a recipe, on that recipe when one is named
 *   #/explore/<collection>    everything one collection offers (explore.ts);
 *                             the classic #/catalog/<collection> lands here
 *   #/nfts/<owner~view>       the inventory
 *   #/create                  make or change a recipe
 *   #/names/<name>            WAX name auctions
 *   #/lab/<tool>/<subject>    the classic page's address for the same tool,
 *                             accepted and rewritten to the forms above
 *   #/nefty/blend/43444       a classic link, opened in #/use: every address
 *                             the classic page understood lands on the
 *                             same thing here (classicRoute), since that
 *                             page lived at this very address until
 *                             2026-11-04 and its links are everywhere
 *   #/stake                   getting tokens out of stake.nefty (stake.ts); the
 *                             classic #/nefty/stake lands here
 *   #/guide/<section>         the user guide (guide.ts), on that section
 *   #/status/<account>        the contract monitor (status.ts), on that contract
 *
 * The Crucible Contracts preview is not part of v2: embedLab() removes it,
 * and a link to it lands on the home.
 */
import { getCurrentSession, login, restoreSession } from '../chain/session';
import { isWalletReturn, returnedSignature } from '../chain/walletReturn';
import { RECIPE_ACTIONS, type RecipeAction, type RecipeSource } from '../ui/guidedRun';
import {
  applyLabRoute, attachLabHandlers, embedLab, openCreatorFor, openLabTool,
  openRecipeEditor, openRunFor, renderLabPage, syncInventoryLock, V2_PATHS, type OpenableTool,
} from '../ui/lab';
import { attachMediaFallbacks } from '../ui/media';
import { showSigned } from '../ui/signedPopup';
import { captureRenderSnapshot, restoreRenderSnapshot } from '../ui/renderSnapshot';
import { attachExploreHandlers, renderExplore } from './explore';
import { attachStakeHandlers, renderStake } from './stake';
import { renderGuide, scrollGuide } from './guide';
import { attachStatusHandlers, renderStatus, scrollStatus } from './status';

type Route =
  | { page: 'home' }
  | { page: 'tool'; tool: OpenableTool; subject: string }
  | { page: 'explore'; collection: string }
  | { page: 'stake'; account: string }
  | { page: 'guide'; section: string }
  | { page: 'status'; account: string };

/** The menu, in the order a visitor meets the questions. */
const MENU: { tool: OpenableTool; label: string }[] = [
  { tool: 'run', label: 'Use a recipe' },
  { tool: 'inventory', label: 'My NFTs' },
  { tool: 'recipes', label: 'Create' },
  { tool: 'names', label: 'WAX names' },
];
const TOOLS = MENU.map((m) => m.tool);
/** Address of a tool on this page. */
const pathOf = (tool: OpenableTool) => `#/${V2_PATHS[tool]}`;
const TOOL_AT = new Map(TOOLS.map((t) => [V2_PATHS[t], t]));

/**
 * The classic page's tabs, every spelling its router accepted, and the
 * action each one is here.
 */
const CLASSIC_TABS: Record<string, RecipeAction | 'stake'> = {
  blend: 'blend', blends: 'blend',
  claim: 'drop', drop: 'drop', drops: 'drop',
  unpack: 'unpack', pack: 'unpack', packs: 'unpack',
  upgrade: 'upgrade', upgrades: 'upgrade',
  stake: 'stake', staking: 'stake',
};

/**
 * A classic address, read the way the classic router read it, as the
 * same thing here: #/<platform>/<tab>/<id>. The platform is nefty, waxdao
 * or blenderizer; WaxDAO and the Blenderizer only had blends, whatever the
 * tab said; an unknown tab was the blends tab. A recipe id opens that
 * recipe (the run tool takes `<source>~<collection>~<id>` and finds the
 * collection itself); without one, the action's first question.
 */
function classicRoute(parts: string[]): Route | undefined {
  const platform = parts[0].toLowerCase();
  if (platform !== 'nefty' && platform !== 'waxdao' && platform !== 'blenderizer') return undefined;
  const tab = platform === 'nefty' ? CLASSIC_TABS[(parts[1] ?? '').toLowerCase()] ?? 'blend' : 'blend';
  if (tab === 'stake') return { page: 'stake', account: '' };
  const id = (parts[2] ?? '').toLowerCase();
  const source: RecipeSource | undefined = platform === 'waxdao' ? 'waxdao'
    : platform === 'blenderizer' ? 'blenderizer'
      // A classic pack id named a design, not one of the two pack contracts.
      : tab === 'unpack' ? undefined : tab;
  return { page: 'tool', tool: 'run', subject: id && source ? `${source}~~${id}` : tab };
}

/** The rest of Crucible: the guide here, and what still lives on the classic page. */
const ELSEWHERE: { label: string; blurb: string; href: string; classic?: boolean }[] = [
  { label: 'User guide', blurb: 'How Crucible works, step by step, and what it never does', href: '#/guide' },
  { label: 'Contract monitor', blurb: 'Whether each contract still runs the code Crucible checked, and who could change it', href: '#/status' },
];

const CREATE: { kind: 'blend' | 'upgrade' | 'drop'; label: string; blurb: string }[] = [
  { kind: 'blend', label: 'Create a blend', blurb: 'Players burn NFTs, the collection mints a result' },
  { kind: 'upgrade', label: 'Create an upgrade', blurb: 'Players keep the NFT, an attribute is rewritten' },
  { kind: 'drop', label: 'Create a drop', blurb: 'Sell fresh mints, or give them away' },
];

let route: Route = { page: 'home' };
/** Which screen the last paint drew, so arriving somewhere new starts at the top. */
let paintedKey = '';
/**
 * The address of the screen before this one, so a confirmation can send
 * people back where they came from (an Explore page, say, before a drop).
 */
let cameFrom = '';
let connecting = false;
let connectError = '';

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return { page: 'home' };
  const head = parts[0].toLowerCase();
  // Subjects are lowercased like the classic router does, so the same
  // link reads the same on both pages.
  const own = TOOL_AT.get(head);
  if (own) return { page: 'tool', tool: own, subject: (parts[1] ?? '').toLowerCase() };
  // The classic catalogue's address is this page's explorer.
  if (head === 'explore' || head === 'catalog') return { page: 'explore', collection: (parts[1] ?? '').toLowerCase() };
  if (head === 'stake') return { page: 'stake', account: (parts[1] ?? '').toLowerCase() };
  if (head === 'guide') return { page: 'guide', section: (parts[1] ?? '').toLowerCase() };
  if (head === 'status') return { page: 'status', account: (parts[1] ?? '').toLowerCase() };
  if (head === 'lab') {
    const tool = (parts[1] ?? '').toLowerCase() as OpenableTool;
    if (!TOOLS.includes(tool)) return { page: 'home' };
    return { page: 'tool', tool, subject: (parts[2] ?? '').toLowerCase() };
  }
  return classicRoute(parts) ?? { page: 'home' };
}

/**
 * Puts the lab where the address says. A link that names something goes
 * through the lab's own deep-link reader; a bare tool, which is what the
 * menu links to, is opened the way its old tool-bar button opened it.
 */
function follow(hash: string): Route {
  const r = parseRoute(hash);
  // An address this page does not have (#/lab/crucible, a typo) shows the
  // home, so it should also say it.
  if (r.page === 'home' && hash && hash !== '#/' && hash !== '#') {
    try { history.replaceState(null, '', '#/'); } catch { /* keep the old address */ }
  }
  if (r.page === 'explore' && /^#\/?catalog/i.test(hash)) {
    try { history.replaceState(null, '', `#/explore${r.collection ? `/${r.collection}` : ''}`); } catch { /* keep the old address */ }
  }
  if (r.page === 'stake' && !/^#\/?stake/i.test(hash)) {
    try { history.replaceState(null, '', '#/stake'); } catch { /* keep the old address */ }
  }
  if (r.page !== 'tool') return r;
  // An address in another form (#/lab/..., a classic recipe link) becomes
  // this page's own first: the lab only keeps an address up to date when
  // it is already one of its own.
  const own = pathOf(r.tool);
  const head = hash.toLowerCase();
  if (head !== own && !head.startsWith(`${own}/`)) {
    try {
      history.replaceState(null, '', `${own}${r.subject ? `/${r.subject}` : ''}`);
    } catch { /* keep the old address */ }
  }
  if (r.subject) applyLabRoute(r.tool, r.subject);
  else openLabTool(r.tool);
  return r;
}

function go(hash: string) {
  if (location.hash === hash) {
    route = follow(hash);
    render();
  } else {
    location.hash = hash;
  }
}

// ─── markup ─────────────────────────────────────────────────────────────

function renderNav(): string {
  const at = route.page === 'tool' ? route.tool : route.page;
  const tool = (m: (typeof MENU)[number]) =>
    `<a href="${pathOf(m.tool)}" ${at === m.tool ? 'aria-current="page"' : ''}>${esc(m.label)}</a>`;
  return [
    `<a href="#/" ${at === 'home' ? 'aria-current="page"' : ''}>Home</a>`,
    tool(MENU[0]),
    `<a href="#/explore" ${at === 'explore' ? 'aria-current="page"' : ''}>Explore</a>`,
    ...MENU.slice(1).map(tool),
    `<a href="#/guide" ${at === 'guide' ? 'aria-current="page"' : ''}>Guide</a>`,
  ].join('');
}

function walletLine(): string {
  const session = getCurrentSession();
  if (session) {
    return `
      <div class="v2-wallet on">
        <span>Connected as <strong>${esc(String(session.actor))}</strong>. Every tool starts from this account.</span>
      </div>`;
  }
  return `
    <div class="v2-wallet">
      <span>Not connected. Looking around needs no wallet, signing does.</span>
      <button class="lab-primary" data-v2="connect" ${connecting ? 'disabled' : ''}>
        ${connecting ? 'Opening your wallet' : 'Connect wallet'}
      </button>
    </div>
    ${connectError ? `<p class="v2-error">${esc(connectError)}</p>` : ''}`;
}

/** Small line icons for the home groups, drawn in the current text colour. */
const ICONS = {
  use: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3"/><path d="M7.5 15h9"/>',
  wallet: '<rect x="3" y="6" width="18" height="14" rx="2.5"/><path d="M16 13h2M3 10h18M7 6V4.5h10V6"/>',
  create: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>',
  more: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
};

function group(icon: keyof typeof ICONS, title: string, blurb: string, cards: string, extra = '', after = ''): string {
  return `
    <section class="v2-group ${extra}">
      <div class="v2-group-head">
        <span class="v2-group-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
               stroke-linecap="round" stroke-linejoin="round">${ICONS[icon]}</svg>
        </span>
        <div>
          <h2>${title}</h2>
          <p>${blurb}</p>
        </div>
      </div>
      <div class="run-kinds v2-cards">${cards}</div>
      ${after}
    </section>`;
}

function renderHome(): string {
  const use = RECIPE_ACTIONS.map((a) => `
    <button class="run-kind" data-v2-run="${a.key}">
      <strong>${esc(a.label)}</strong>
      <small>${esc(a.blurb)}</small>
      <span class="lab-hint">${esc(a.where)}</span>
    </button>`).join('');
  const wallet = `
    <a class="run-kind" href="${pathOf('inventory')}">
      <strong>My NFTs</strong>
      <small>Everything you own, searchable, with what each NFT is good for</small>
    </a>
    <a class="run-kind" href="${pathOf('names')}">
      <strong>WAX names</strong>
      <small>Premium name auctions: bid, follow, claim</small>
    </a>
    <a class="run-kind" href="#/stake">
      <strong>Staking</strong>
      <small>Get back what stake.nefty and WaxDAO's farms, pools and DAOs still hold for you</small>
    </a>`;
  const create = CREATE.map((c) => `
    <button class="run-kind" data-v2-create="${c.kind}">
      <strong>${esc(c.label)}</strong>
      <small>${esc(c.blurb)}</small>
    </button>`).join('') + `
    <button class="run-kind" data-v2="edit">
      <strong>Change something you made</strong>
      <small>Pause, reschedule or edit a recipe that already exists</small>
    </button>`;
  const more = ELSEWHERE.map((e) => `
    <a class="run-kind" href="${esc(e.href)}">
      <strong>${esc(e.label)}${e.classic ? ' <span class="v2-tag">classic</span>' : ''}</strong>
      <small>${esc(e.blurb)}</small>
    </a>`).join('');

  return `
    <div class="v2-home">
      <div class="v2-hero">
        <p class="v2-eyebrow">Blends · upgrades · drops · packs on WAX</p>
        <h1>What do you want to do?</h1>
        <p class="v2-lead">Every NeftyBlocks, WaxDAO and Blenderizer recipe still running on WAX,
        one question at a time. You do not need to know which contract runs it: Crucible searches
        all of them. Your wallet signs, this page only builds the transaction.</p>
        ${walletLine()}
      </div>
      ${group('use', 'Use a recipe', 'Burn, upgrade, claim or open. Crucible finds the recipes and checks what you hold.', use, '',
    '<a class="v2-explore-link" href="#/explore">Or start from a collection: everything it offers, on one page →</a>')}
      ${group('wallet', 'Your wallet', 'What you own, and the WAX names you are bidding on.', wallet)}
      ${group('create', 'Create', 'For collection authors: make a recipe, or change one you already made.', create)}
      ${group('more', 'Also in Crucible', 'How it all works, and whether the contracts behind it changed.', more, 'v2-group-quiet')}
    </div>`;
}

// ─── rendering ──────────────────────────────────────────────────────────

function rootEl(): HTMLElement {
  return document.getElementById('root')!;
}

let scheduled = false;
/** Coalesces repaints to one per frame, the same way the classic shell does. */
function render() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(paint);
}

/** Which screen a route is: moving to another one starts at the top, and is where "back" goes. */
function screenOf(r: Route): string {
  return r.page === 'tool' ? `tool:${r.tool}`
    : r.page === 'explore' ? `explore:${r.collection}`
      : r.page === 'stake' ? `stake:${r.account}` : r.page;
}

/**
 * The screen a tab was on, kept for the tab's life (sessionStorage), so a
 * page Safari reloaded while the wallet was open comes back to it.
 */
const SCREEN_KEY = 'crucible:screen';
function rememberScreen(): void {
  try {
    if (location.hash.startsWith('#/') && sessionStorage.getItem(SCREEN_KEY) !== location.hash) {
      sessionStorage.setItem(SCREEN_KEY, location.hash);
    }
  } catch { /* a private window without storage only loses this */ }
}
function rememberedScreen(): string {
  try { return sessionStorage.getItem(SCREEN_KEY) ?? ''; } catch { return ''; }
}

const hashOf = (url: string) => { try { return new URL(url).hash; } catch { return ''; } };

function paint() {
  scheduled = false;
  const key = screenOf(route);
  const moved = key !== paintedKey;
  paintedKey = key;
  rememberScreen();
  const snap = captureRenderSnapshot();
  const root = rootEl();

  const nav = document.getElementById('v2-nav');
  if (nav) nav.innerHTML = renderNav();
  // The same screen on the old classic page, kept at /backup/: a tool's
  // address in its #/lab grammar, the others in its own.
  const classic = document.getElementById('v2-classic') as HTMLAnchorElement | null;
  if (classic) {
    classic.href = route.page === 'tool' ? `./backup/#/lab/${route.tool}${location.hash.slice(pathOf(route.tool).length)}`
      : route.page === 'explore' ? `./backup/#/catalog${route.collection ? `/${route.collection}` : ''}`
        : route.page === 'stake' ? './backup/#/nefty/stake'
          : route.page === 'status' ? './backup/#/status'
            : './backup/';
  }

  if (route.page === 'tool') {
    root.innerHTML = renderLabPage();
    attachLabHandlers(root, render);
  } else if (route.page === 'explore') {
    syncInventoryLock(false);
    // Without a wallet the shelf can say what exists but not what you can
    // run, so the way to connect sits above it.
    const connect = getCurrentSession() ? '' : `<div class="v2-explore">${walletLine()}</div>`;
    root.innerHTML = connect + renderExplore(route.collection, render);
    attachExploreHandlers(root, render, go);
    attachHomeHandlers(root);
  } else if (route.page === 'stake') {
    syncInventoryLock(false);
    root.innerHTML = renderStake(render, walletLine(), route.account);
    attachStakeHandlers(root, render, go);
    attachHomeHandlers(root);
  } else if (route.page === 'guide') {
    syncInventoryLock(false);
    root.innerHTML = renderGuide();
  } else if (route.page === 'status') {
    syncInventoryLock(false);
    root.innerHTML = renderStatus(render);
    attachStatusHandlers(root, render);
  } else {
    syncInventoryLock(false);
    root.innerHTML = renderHome();
    attachHomeHandlers(root);
  }
  // Artwork only starts loading once the markup is in the DOM.
  attachMediaFallbacks(root);
  if (moved) window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  else restoreRenderSnapshot(snap);
  // A guide or monitor address names a section: go there once, not on every repaint.
  const place = route.page === 'guide' ? `guide:${route.section}` : route.page === 'status' ? `status:${route.account}` : undefined;
  if (place && place !== placedAt) {
    if (route.page === 'guide') scrollGuide(route.section);
    if (route.page === 'status') scrollStatus(route.account);
  }
  placedAt = place;
}

/** The section last scrolled to, so a repaint (the monitor repaints as each contract lands) does not pull the reader back. */
let placedAt: string | undefined;

function attachHomeHandlers(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>('[data-v2-run]').forEach((el) => {
    el.addEventListener('click', () => {
      openRunFor(el.dataset.v2Run as RecipeAction);
      go(pathOf('run'));
    });
  });
  root.querySelectorAll<HTMLElement>('[data-v2-create]').forEach((el) => {
    el.addEventListener('click', () => {
      openCreatorFor(el.dataset.v2Create as 'blend' | 'upgrade' | 'drop');
      go(pathOf('recipes'));
    });
  });
  root.querySelector<HTMLElement>('[data-v2="edit"]')?.addEventListener('click', () => {
    openRecipeEditor();
    go(pathOf('recipes'));
  });
  root.querySelector<HTMLElement>('[data-v2="connect"]')?.addEventListener('click', async () => {
    connecting = true;
    connectError = '';
    render();
    try {
      await login();
    } catch (err) {
      connectError = err instanceof Error ? err.message : String(err);
    } finally {
      connecting = false;
      render();
    }
  });
}

export async function mount(): Promise<void> {
  embedLab(render, () => cameFrom);
  window.addEventListener('hashchange', (e) => {
    // A wallet coming back. The screen stays: what was signed is on it, and
    // the confirmation shows over it. The address goes back to the screen's
    // own once the wallet has seen its hash, which it checks in a
    // hashchange listener of its own, added after this one.
    if (isWalletReturn(location.hash)) {
      const back = hashOf(e.oldURL);
      setTimeout(() => {
        if (!isWalletReturn(location.hash)) return;
        try { history.replaceState(null, '', back.startsWith('#/') ? back : rememberedScreen() || '#/'); } catch { /* keep it */ }
      }, 0);
      return;
    }
    const before = screenOf(route);
    route = follow(location.hash);
    if (screenOf(route) !== before) cameFrom = hashOf(e.oldURL);
    render();
  });
  // The screen and the address are kept as people leave for the wallet.
  window.addEventListener('pagehide', rememberScreen);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') rememberScreen(); });
  // Loaded at a wallet's return address: Safari reloaded the page while the
  // wallet was open. The screen comes back, and what was signed is said.
  let start = location.hash;
  const lost = isWalletReturn(start) ? returnedSignature() : undefined;
  if (isWalletReturn(start)) {
    start = rememberedScreen() || '#/';
    try { history.replaceState(null, '', start); } catch { /* keep it */ }
  }
  // Paint first: nothing on the first screen waits for the wallet.
  route = follow(start);
  render();
  if (lost) {
    showSigned({
      tone: 'unknown',
      title: 'Not sent: the page was reloaded',
      lines: [
        'Your browser reloaded Crucible while your wallet was open. The wallet only signs; Crucible sends the transaction once the wallet hands it back, and the reload lost it.',
        'So what you signed there most likely never reached the chain. Look it up to be sure, then sign again from this screen if it is not there.',
      ],
      txs: [lost.transactionId],
      close: { label: 'Close' },
    });
  }
  try {
    await restoreSession();
  } catch { /* a page without a remembered wallet still works */ }
  render();
}
