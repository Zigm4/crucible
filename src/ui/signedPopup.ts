/**
 * The confirmation after a signature, the same on every screen.
 * ─────────────────────────────────────────────────────────────
 * Signing used to leave one green line by the button ("Signed. view it on
 * waxblock"). It was easy to miss at the bottom of a long page, and nobody
 * saw it when the wallet's return sent the page somewhere else. This says it
 * once, in the middle of the screen: what was signed, the transaction, and
 * where to go next.
 *
 * Like the confirm dialog (lab.ts confirmCreate), it lives on document.body,
 * outside the page the app repaints, so a repaint cannot pull it out from
 * under the reader. A notice can have a live part, such as a draw that lands
 * after the signature. refreshSigned() redraws it, and the lab calls that on
 * every repaint.
 *
 * Closing goes somewhere: each notice says where (`close.go`). The Escape
 * key and a click beside the box close it the same way the button does.
 *
 * It looks like a receipt with a wax seal on it: the seal across the top
 * edge (a check, or a question mark when Crucible cannot tell), what
 * happened, then a perforated stub with the transaction, to copy or open on
 * waxblock, and the ways out. The styles are in components.css, "the
 * confirmation after a signature".
 */

export interface SignedNotice {
  /** Which flow it belongs to, so a later step can tell its own notice is still open. */
  id?: string;
  /** What happened, in a few words: "Drop claimed". */
  title: string;
  /** Plain sentences under the title, escaped here. */
  lines?: string[];
  /** Markup the caller has already escaped, such as the creator's review rows. */
  html?: string;
  /** What did not go through, in amber. */
  warn?: string;
  /** The transactions, one waxblock link each. */
  txs: string[];
  /** Redrawn on every repaint while open: a draw, a second signature. Markup. */
  live?: () => string;
  /** Wires the buttons inside the live part after each redraw. */
  bindLive?: (el: HTMLElement) => void;
  /** The main button. It closes the notice, then `go` runs. */
  close: { label: string | (() => string); go?: () => void };
  /** A second way out: another place (`href`), or staying where you are (`go`). Hidden while `hidden()` says so. */
  other?: { label: string; go?: () => void; href?: string; hidden?: () => boolean };
  /**
   * 'ok' for a signature that went through. 'unknown' when Crucible cannot
   * say, such as after the page was reloaded while the wallet was open.
   */
  tone?: 'ok' | 'unknown';
}

const ID = 'signed-popup';
let open: SignedNotice | undefined;
let detachKeys: (() => void) | undefined;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const labelOf = (l: string | (() => string)) => (typeof l === 'function' ? l() : l);

/**
 * The seal at the top of the box: a wax seal, since WAX is the chain and a
 * seal is what closes a signed letter. Poured wax never spreads into a true
 * circle, so its edge is a few slow waves around one. Drawn once, here.
 */
const WAX_EDGE = (() => {
  const pts: string[] = [];
  const steps = 180;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const r = 40.6 + 1.3 * Math.sin(5 * a + 0.4) + 0.8 * Math.sin(9 * a + 1.7) + 0.45 * Math.sin(16 * a + 0.9);
    pts.push(`${(44 + r * Math.cos(a)).toFixed(2)},${(44 + r * Math.sin(a)).toFixed(2)}`);
  }
  return `M${pts.join('L')}Z`;
})();

function seal(unknown: boolean): string {
  const words = unknown ? 'NOT CONFIRMED · LOOK IT UP · ' : 'SIGNED ON WAX · CRUCIBLE · ';
  // A check, or a question mark with its dot. pathLength lets the CSS draw either in.
  const glyph = unknown
    ? '<path class="seal-glyph" pathLength="1" d="M39.4 39.2a4.9 4.9 0 1 1 7.3 4.2c-1.7 1-2.7 2-2.7 4v1"/><path class="seal-glyph seal-dot" pathLength="1" d="M44 54.4v.1"/>'
    : '<path class="seal-glyph" pathLength="1" d="M36 44.4l5.6 5.6L52.4 39"/>';
  return `<svg viewBox="0 0 88 88" focusable="false">
      <defs>
        <radialGradient id="seal-wax" cx="34%" cy="28%" r="78%">
          <stop offset="0" class="seal-shine"/><stop offset="0.55" class="seal-body-stop"/><stop offset="1" class="seal-shade"/>
        </radialGradient>
        <path id="seal-ring" d="M44 44m-27.6 0a27.6 27.6 0 1 1 55.2 0a27.6 27.6 0 1 1-55.2 0"/>
      </defs>
      <path class="seal-edge" fill="url(#seal-wax)" d="${WAX_EDGE}"/>
      <circle class="seal-press" cx="44" cy="44" r="33.6"/>
      <circle class="seal-rim-lo" cx="44.5" cy="44.7" r="33.6"/>
      <circle class="seal-rim-hi" cx="43.6" cy="43.4" r="33.6"/>
      <circle class="seal-line" cx="44" cy="44" r="21.6"/>
      <g class="seal-words"><text><textPath href="#seal-ring" textLength="171" lengthAdjust="spacing">${words}</textPath></text></g>
      ${glyph}
    </svg>`;
}

/**
 * The stub under the perforation: one row per transaction. The id is 64 hex
 * characters, so the row shows its ends and copies the whole of it.
 */
function txRows(txs: string[], tone: SignedNotice['tone']): string {
  const ids = txs.filter(Boolean);
  if (!ids.length) return '';
  const many = ids.length > 1;
  const link = tone === 'unknown' ? 'Look it up on waxblock' : 'View on waxblock';
  return ids.map((id, i) => `
      <div class="seal-tx">
        <div class="seal-tx-meta">
          <span class="seal-tx-label">${many ? `Transaction ${i + 1} of ${ids.length}` : 'Transaction'}</span>
          <code class="seal-tx-id" title="${esc(id)}">${esc(id.slice(0, 10))}…${esc(id.slice(-6))}</code>
        </div>
        <div class="seal-tx-tools">
          <button type="button" class="seal-copy" data-copy="${esc(id)}">Copy</button>
          <a class="seal-tx-link" target="_blank" rel="noreferrer"
            href="https://waxblock.io/transaction/${esc(id)}">${link} <span aria-hidden="true">↗</span></a>
        </div>
      </div>`).join('');
}

/** The inside of the box. Pure, so the verify scripts can read it without a DOM. */
export function signedMarkup(n: SignedNotice, live = n.live?.() ?? ''): string {
  const unknown = n.tone === 'unknown';
  const hidden = n.other?.hidden?.() ? 'hidden' : '';
  const other = n.other
    ? n.other.href
      ? `<a class="seal-btn seal-btn-alt" id="signed-other" href="${esc(n.other.href)}" ${hidden}>${esc(n.other.label)}</a>`
      : `<button type="button" class="seal-btn seal-btn-alt" id="signed-other" ${hidden}>${esc(n.other.label)}</button>`
    : '';
  return `
    <div class="seal-card ${unknown ? 'unknown' : ''}" role="dialog" aria-modal="true" aria-labelledby="signed-title">
      <div class="seal-mark" aria-hidden="true">${seal(unknown)}</div>
      <div class="seal-body">
        <p class="seal-kicker">${unknown ? 'Not confirmed' : 'Signed and sent'}</p>
        <h3 id="signed-title" class="seal-title">${esc(n.title)}</h3>
        ${(n.lines ?? []).filter(Boolean).map((l) => `<p class="signed-line">${esc(l)}</p>`).join('')}
        ${n.html ?? ''}
        ${n.warn ? `<p class="seal-warn">${esc(n.warn)}</p>` : ''}
        <div class="signed-live">${live}</div>
      </div>
      <div class="seal-stub">
        ${txRows(n.txs, n.tone)}
        <div class="seal-actions">
          ${other}
          <button type="button" class="seal-btn seal-btn-main" id="signed-close">${esc(labelOf(n.close.label))}</button>
        </div>
      </div>
    </div>`;
}

/** Closes the notice. `how` says which way out was taken: the main button (and Escape), or the other one. */
export function closeSigned(how: 'close' | 'other' = 'close'): void {
  const n = open;
  if (!n) return;
  open = undefined;
  detachKeys?.();
  detachKeys = undefined;
  if (typeof document !== 'undefined') leave(document.getElementById(ID));
  const go = how === 'other' ? n.other?.go : n.close.go;
  go?.();
}

/**
 * Takes the box away with a short fade. It loses its id first, so a notice
 * shown right after (a second signature) is not mistaken for this one.
 */
function leave(el: HTMLElement | null): void {
  if (!el) return;
  el.removeAttribute('id');
  const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (still) { el.remove(); return; }
  el.classList.add('leaving');
  setTimeout(() => el.remove(), 200);
}

/** Copies a transaction id, or selects it where the browser will not let a page copy. */
function copyId(btn: HTMLElement): void {
  const id = btn.dataset.copy ?? '';
  const said = (word: string) => {
    btn.textContent = word;
    setTimeout(() => { btn.textContent = 'Copy'; }, 1600);
  };
  const select = () => {
    const code = btn.closest('.seal-tx')?.querySelector('.seal-tx-id');
    if (!code) return;
    code.textContent = id;
    getSelection()?.selectAllChildren(code);
    said('Selected');
  };
  if (!navigator.clipboard) { select(); return; }
  navigator.clipboard.writeText(id).then(() => said('Copied'), select);
}

function wire(wrap: HTMLElement, n: SignedNotice): void {
  wrap.querySelectorAll<HTMLElement>('.seal-copy').forEach((b) => b.addEventListener('click', () => copyId(b)));
  wrap.querySelector('#signed-close')?.addEventListener('click', () => closeSigned('close'));
  const other = wrap.querySelector<HTMLElement>('#signed-other');
  // A link closes on its way out; the browser follows the href on its own.
  other?.addEventListener('click', () => closeSigned('other'));
  const live = wrap.querySelector<HTMLElement>('.signed-live');
  if (live && n.bindLive) n.bindLive(live);
}

/** Puts a notice on screen, replacing any other one. */
export function showSigned(n: SignedNotice): void {
  if (open) { detachKeys?.(); detachKeys = undefined; }
  open = n;
  if (typeof document === 'undefined') return;
  document.getElementById(ID)?.remove();
  const wrap = document.createElement('div');
  wrap.id = ID;
  wrap.className = 'modal-backdrop signed-backdrop';
  const live = n.live?.() ?? '';
  wrap.innerHTML = signedMarkup(n, live);
  wrap.querySelector<HTMLElement>('.signed-live')!.dataset.drawn = live;
  document.body.appendChild(wrap);
  wire(wrap, n);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) closeSigned('close'); });
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeSigned('close'); };
  document.addEventListener('keydown', onKey);
  detachKeys = () => document.removeEventListener('keydown', onKey);
  wrap.querySelector<HTMLElement>('#signed-close')?.focus();
}

/**
 * Redraws the live part and the main button's label, if a notice is open.
 * Called on every repaint, so it does nothing when nothing in it changed.
 */
export function refreshSigned(): void {
  const n = open;
  if (!n || typeof document === 'undefined') return;
  const wrap = document.getElementById(ID);
  if (!wrap) return;
  const close = wrap.querySelector<HTMLElement>('#signed-close');
  const label = labelOf(n.close.label);
  if (close && close.textContent !== label) close.textContent = label;
  const other = wrap.querySelector<HTMLElement>('#signed-other');
  if (other) other.hidden = Boolean(n.other?.hidden?.());
  if (!n.live) return;
  const live = wrap.querySelector<HTMLElement>('.signed-live');
  const html = n.live();
  if (!live || live.dataset.drawn === html) return;
  live.dataset.drawn = html;
  live.innerHTML = html;
  n.bindLive?.(live);
}

/** The notice on screen, if any. For the verify scripts and for the lab's own checks. */
export function signedNotice(): SignedNotice | undefined {
  return open;
}
