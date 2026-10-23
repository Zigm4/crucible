/**
 * How a recipe's verdict is drawn, on every page that shows one.
 *
 * The guided run tool and the classic panels judge a recipe with the same
 * checks (runChecks), so they draw it the same way too: one panel listing
 * every criterion with its colour, and AtomicHub links under whatever the
 * wallet is short of. Markup only; the styles live with the run tool's.
 */
import { explorerUrl, marketUrl, type MarketRef } from '../atomic/atomichub';
import type { RecipeVerdict } from './runChecks';

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Where to find an NFT the wallet does not hold. Plain links in a new tab
 * with no referrer, so AtomicHub learns nothing until somebody clicks, and
 * not even then which page they came from.
 */
export function hubLinks(ref: MarketRef, what?: string): string {
  const a = (href: string, label: string) =>
    `<a href="${esc(href)}" target="_blank" rel="noreferrer noopener">${esc(label)}</a>`;
  return `<span class="run-hub">${what ? `${esc(what)} on AtomicHub:` : 'On AtomicHub:'}
    ${a(explorerUrl(ref), 'what it is, who holds it')} · ${a(marketUrl(ref), 'for sale')}</span>`;
}

const hubName = (m: MarketRef) =>
  m.template_id !== undefined ? `Template #${m.template_id}` : m.schema ? `Any ${m.schema}` : `Any NFT from ${m.collection}`;

/** The panel: a title that answers "can I run it?", then every criterion. */
export function renderVerdictPanel(v: RecipeVerdict): string {
  const title = v.tone === 'ok' ? 'You can run this'
    : v.tone === 'block' ? 'You cannot run this right now'
      : v.tone === 'warn' ? 'Not yet: something is missing'
        : 'Can you run it? Still checking';
  return `
    <div class="run-verdict-panel run-tone-${v.tone}">
      <h4>${esc(title)}</h4>
      <ul class="run-check-list">
        ${v.checks.map((k) => `<li class="run-li run-li-${k.tone}"><span>${esc(k.text)}
          ${(k.market ?? []).map((m) => hubLinks(m, k.market!.length > 1 ? hubName(m) : undefined)).join('')}</span></li>`).join('')}
      </ul>
    </div>`;
}
