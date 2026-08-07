/**
 * NFT artwork: IPFS resolution + a thumbnail that cannot break the layout.
 * ─────────────────────────────────────────────────────────────
 * AtomicAssets stores artwork as a bare IPFS hash in the template's
 * `immutable_data` (`img`, sometimes `img2`/`img3`/`image2`). Rendering
 * it means picking an HTTP gateway, and that is the one place where
 * this app has to reach a host it does not otherwise talk to.
 *
 * Which is a problem, because the obvious gateways are dead. Checked
 * while writing this:
 *
 *   ipfs.atomichub.io     no DNS record at all
 *   atomichub-ipfs.com    no DNS record at all
 *   cloudflare-ipfs.com   no DNS record (Cloudflare sunset it)
 *   ipfs.neftyblocks.io   resolves, serves a domain-parking page
 *
 * The two ecosystems whose contracts this app drives have both let
 * their gateways lapse, which is the same decay that took their
 * websites. So there is no "correct" gateway to hardcode: the list
 * below is tried in order and the first one that actually decodes an
 * image wins. If every one fails, `attachMediaFallbacks` removes the
 * figure entirely and the surrounding card renders exactly as it did
 * before images existed. Artwork is decoration; it must never be able
 * to break a page whose job is building transactions.
 *
 * PRIVACY: this is the app's only third-party media request. The
 * gateway sees your IP and which NFT you are looking at. Requests go
 * out with `referrerpolicy="no-referrer"` so the page URL never
 * leaks, and emptying IPFS_GATEWAYS below disables artwork entirely
 * in one edit, the same way the Google Fonts link can be removed from
 * index.html.
 */

/**
 * Tried in order, first success wins. All four resolved and are run by
 * parties independent of NeftyBlocks/WaxDAO, so one operator going
 * dark degrades to the next instead of losing artwork everywhere.
 */
export const IPFS_GATEWAYS = [
  'https://ipfs.io/ipfs/',
  'https://dweb.link/ipfs/',
  'https://w3s.link/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
];

/** Field names seen carrying artwork across real collections, in order
 *  of preference. `img` covers the vast majority; `img2` is common
 *  enough (54 of 400 underpunks55 templates) that ignoring it would
 *  silently blank a whole class of items. */
const IMAGE_FIELDS = ['img', 'image', 'img2', 'image2', 'img3', 'image3'];

/**
 * Digs the artwork reference out of a template's `immutable_data`.
 * Returns whatever the author stored: usually a bare IPFS hash, but
 * occasionally a full URL.
 */
export function pickImageRef(
  immutable: Record<string, unknown> | undefined,
): string | undefined {
  if (!immutable) return undefined;
  for (const key of IMAGE_FIELDS) {
    const v = immutable[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * Turns an artwork reference into a list of candidate URLs.
 *
 * A full URL is used as-is (single candidate, no gateway involved). A
 * bare hash - or an `ipfs://` URI - is expanded across every gateway.
 * Returns [] for anything unusable so callers can skip rendering.
 */
export function mediaCandidates(ref: string | undefined): string[] {
  if (!ref) return [];
  const v = ref.trim();
  if (!v) return [];
  if (/^https?:\/\//i.test(v)) return [v];
  const hash = v.replace(/^ipfs:\/\//i, '').replace(/^\/?ipfs\//i, '').trim();
  // CIDv0 (Qm…) and CIDv1 (baf…) are the two forms in the wild. Anything
  // else is author junk we should not turn into a network request.
  if (!/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[A-Za-z2-7]{20,})$/.test(hash)) return [];
  return IPFS_GATEWAYS.map((g) => g + hash);
}

/**
 * A fixed-size thumbnail. The box is reserved before the image loads
 * (so nothing jumps) and `object-fit: contain` means a portrait, a
 * square and a wide banner all sit inside the same footprint without
 * being stretched.
 *
 * `data-media` carries the candidate list; `attachMediaFallbacks`
 * walks it. Rendering alone never starts a request - the src is set by
 * that pass - so a caller that forgets to attach simply shows nothing.
 */
export function renderMediaThumb(args: {
  ref: string | undefined;
  alt: string;
  /** Extra class for size variants, e.g. 'media-thumb-sm'. */
  className?: string;
}): string {
  const candidates = mediaCandidates(args.ref);
  if (candidates.length === 0) return '';
  const alt = args.alt.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
  const payload = candidates.join('|').replace(/"/g, '&quot;');
  return `
    <figure class="media-thumb ${args.className ?? ''}">
      <img data-media="${payload}" data-media-i="0" alt="${alt}"
           decoding="async" referrerpolicy="no-referrer" />
    </figure>`;
}

/**
 * How long to give one gateway before moving on. A dead gateway does
 * not necessarily fail fast: an unreachable IPFS node commonly leaves
 * the request hanging forever, and `onerror` never fires. Without this
 * deadline the first stalled gateway would pin an empty frame on the
 * page for the rest of the session, which is exactly the kind of
 * breakage artwork must never cause.
 */
const GATEWAY_TIMEOUT_MS = 6_000;

/**
 * Starts loading every thumbnail in `root` and wires the gateway
 * fallback. Called once per render, after the HTML is in the DOM.
 *
 * Loading is deferred until the thumbnail is near the viewport. That
 * matters on the catalogue, where a collection can put 130 rows on one
 * page: only what you actually scroll to costs a request. It is done
 * with an IntersectionObserver rather than `loading="lazy"` because the
 * per-candidate deadline has to start when the request does — with
 * native lazy-loading the timer would expire on off-screen images that
 * were never even attempted, and delete artwork that was fine.
 *
 * A candidate is abandoned on error OR on timeout; when the list is
 * spent the whole <figure> is removed, so the card collapses back to
 * its no-artwork layout instead of holding a blank box. Elements
 * already wired are skipped, so calling this repeatedly is safe.
 */
export function attachMediaFallbacks(root: HTMLElement): void {
  root.querySelectorAll<HTMLImageElement>('img[data-media]').forEach((img) => {
    if (img.dataset.mediaWired === '1') return;
    img.dataset.mediaWired = '1';
    const candidates = (img.dataset.media ?? '').split('|').filter(Boolean);
    if (candidates.length === 0) {
      img.closest('figure')?.remove();
      return;
    }

    let i = -1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const give_up = () => {
      settled = true;
      if (timer) clearTimeout(timer);
      // Cancel the in-flight request so a stalled gateway stops holding
      // a connection open after we have stopped caring about it.
      img.removeAttribute('src');
      img.closest('figure')?.remove();
    };

    const tryNext = () => {
      if (settled) return;
      if (timer) clearTimeout(timer);
      i += 1;
      if (i >= candidates.length) {
        give_up();
        return;
      }
      img.dataset.mediaI = String(i);
      timer = setTimeout(tryNext, GATEWAY_TIMEOUT_MS);
      img.src = candidates[i];
    };

    img.addEventListener('error', tryNext);
    img.addEventListener('load', () => {
      if (settled) return;
      // A gateway that answers with an HTML error page decodes to a
      // 0x0 image; treat that as a failure rather than showing a gap.
      if (img.naturalWidth === 0) {
        tryNext();
        return;
      }
      settled = true;
      if (timer) clearTimeout(timer);
      img.classList.add('is-loaded');
    });

    // Defer the first request until the thumbnail is worth fetching.
    // 400px of margin means it is already there by the time it scrolls
    // in, without loading the whole list up front.
    if (typeof IntersectionObserver === 'function') {
      const io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            io.disconnect();
            tryNext();
          }
        },
        { rootMargin: '400px' },
      );
      io.observe(img);
    } else {
      tryNext();
    }
  });
}
