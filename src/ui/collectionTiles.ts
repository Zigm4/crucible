/**
 * Collections as tiles, wherever a screen asks "which collection?".
 * ─────────────────────────────────────────────────────────────
 * Each collection was a word in a small outlined badge, with a number
 * beside it: twenty-four of them looked like a tag cloud, and nothing in
 * them said which was which. A collection has a face: its picture and its
 * full name, both on AtomicAssets. A tile shows them, with the account
 * name under it and, for the ones in your wallet, how many of its NFTs
 * you hold.
 *
 * The face comes from the NFTs already read (each one carries its
 * collection's name and picture) or, for the suggestions, from one call
 * to the AtomicAssets collections list. Until it lands, or if it never
 * does, the tile shows the collection's initial on a colour drawn from its
 * name, the same colour every time.
 *
 * Used by the run tool's step 2 (lab.ts) and by Explore's picker
 * (v2/explore.ts). The styles are in components.css, "collection tiles".
 */
import { atomicFetch } from '../chain/rpc';
import type { AtomicAsset } from '../atomic/assets';
import { renderMediaThumb } from './media';

interface Face { title: string; img: string }

const faces = new Map<string, Face>();
/** Asked once per page load: a collection the indexer does not know is not asked again on every repaint. */
const asked = new Set<string>();

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Keeps the name and picture each NFT already carries for its collection. */
export function learnFaces(assets: readonly AtomicAsset[]): void {
  for (const a of assets) {
    const c = a.collection;
    if (c?.collection_name && !faces.has(c.collection_name)) {
      faces.set(c.collection_name, { title: c.name ?? '', img: c.img ?? '' });
    }
  }
}

/** Reads the faces still missing, in one call, then repaints. Safe to call on every render. */
export function askFaces(names: readonly string[], repaint: () => void): void {
  const missing = [...new Set(names)].filter((n) => n && !faces.has(n) && !asked.has(n));
  if (!missing.length) return;
  missing.forEach((n) => asked.add(n));
  const qs = new URLSearchParams({ collection_whitelist: missing.join(','), limit: String(missing.length) });
  atomicFetch<{ collection_name: string; name?: string; img?: string }[]>(`/atomicassets/v1/collections?${qs}`)
    .then((rows) => {
      for (const r of rows ?? []) faces.set(r.collection_name, { title: r.name ?? '', img: r.img ?? '' });
      repaint();
    })
    // The tiles keep their initial; nothing else depends on this.
    .catch(() => {});
}

/** A hue from the name, so a collection without a picture keeps one colour. */
function hueOf(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

export interface Tile {
  name: string;
  /** NFTs of it in the wallet. Left out for a suggestion. */
  count?: number;
  /** The collection already chosen. */
  on?: boolean;
}

/**
 * The tiles. `as` says what a tile is: a link (`href`) or a button carrying
 * `data-*` attributes the screen already listens to.
 */
export function renderTiles(
  tiles: readonly Tile[],
  as: { href: (name: string) => string } | { data: (name: string) => Record<string, string> },
): string {
  return `<div class="ctiles">${tiles.map((t) => {
    const face = faces.get(t.name);
    const title = face?.title && face.title.toLowerCase() !== t.name ? face.title : t.name;
    const handle = title !== t.name ? `<span class="ctile-handle">${esc(t.name)}</span>` : '';
    const art = face?.img ? renderMediaThumb({ ref: face.img, alt: '', className: 'ctile-img' }) : '';
    // The same picture again, blurred, behind the whole tile.
    const wash = face?.img ? renderMediaThumb({ ref: face.img, alt: '', className: 'ctile-wash' }) : '';
    const end = t.count !== undefined
      ? `<span class="ctile-count"><b>${t.count.toLocaleString('en-US')}</b><small>${t.count === 1 ? 'NFT' : 'NFTs'}</small></span>`
      : '<span class="ctile-go" aria-hidden="true">→</span>';
    const inner = `
      ${wash}
      <span class="ctile-art" aria-hidden="true"><span class="ctile-initial">${esc((title[0] ?? '?').toUpperCase())}</span>${art}</span>
      <span class="ctile-text"><span class="ctile-title">${esc(title)}</span>${handle}</span>
      ${end}`;
    const cls = `ctile${t.on ? ' on' : ''}`;
    const style = `style="--hue:${hueOf(t.name)}"`;
    if ('href' in as) return `<a class="${cls}" ${style} href="${esc(as.href(t.name))}">${inner}</a>`;
    const data = Object.entries(as.data(t.name)).map(([k, v]) => `data-${k}="${esc(v)}"`).join(' ');
    return `<button type="button" class="${cls}" ${style} ${data} ${t.on ? 'aria-pressed="true"' : ''}>${inner}</button>`;
  }).join('')}</div>`;
}

/** A titled group of tiles, or nothing when there are none. */
export function tileGroup(head: string, note: string, body: string): string {
  return `
    <div class="ctiles-group">
      <p class="ctiles-head"><span>${esc(head)}</span>${note ? `<small>${esc(note)}</small>` : ''}</p>
      ${body}
    </div>`;
}
