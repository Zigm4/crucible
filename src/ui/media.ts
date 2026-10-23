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
 * And again in October 2026: ipfs.io, dweb.link, nftstorage.link and
 * w3s.link (which redirects to dweb.link) answer every request with a
 * 429 saying the gateway "is switching to a service worker gateway
 * only", and gateway.pinata.cloud hangs. Four of the six gateways this
 * list had were dead, and the two WAX ones only hold some collections'
 * files: shadowsquads artwork hung on both.
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
 * Raced, not tried in strict order (see loadHedged). `{cid}` is where the
 * hash goes. `ipfs.eosdac.io` comes first: run by a WAX block producer
 * that pins WAX NFT media, it answers in ~0.2s when it holds a file.
 *
 * AtomicHub's image service is second. It fetched every hash tried while
 * writing this, including the shadowsquads ones no gateway would serve,
 * in ~0.4s, and returns a 370px webp, which is what a thumbnail needs.
 * It is a third party like the others: it learns your IP and which NFT
 * you are looking at, and nothing else (no referrer is sent).
 *
 * `ipfs.alienworlds.io` stays as a backstop: slower (~2.4s), but another
 * operator holding the WAX files.
 *
 * Emptying this list disables artwork everywhere, with no other change.
 */
export const IPFS_GATEWAYS = [
  'https://ipfs.eosdac.io/ipfs/{cid}',
  'https://resizer.atomichub.io/images/v1/preview?ipfs={cid}&size=370',
  'https://ipfs.alienworlds.io/ipfs/{cid}',
];

/** Expands ONE reference into its candidate URLs. */
function candidatesForRef(ref: string | undefined): string[] {
  if (!ref) return [];
  const v = ref.trim();
  if (!v) return [];
  if (/^https?:\/\//i.test(v)) return [v];
  const hash = v.replace(/^ipfs:\/\//i, '').replace(/^\/?ipfs\//i, '').trim();
  // CIDv0 (Qm…) and CIDv1 (baf…) are the two forms in the wild. Anything
  // else is author junk we should not turn into a network request.
  if (!/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[A-Za-z2-7]{20,})$/.test(hash)) return [];
  return IPFS_GATEWAYS.map((g) => g.replace('{cid}', hash));
}

/**
 * Turns one or more artwork references into a flat candidate list.
 *
 * Passing several references is how a caller says "prefer the result
 * template's art, but the recipe carries its own picture too" - which
 * matters because authors do not fill both. On underpunks55, 11 of the
 * 102 blends have no image on their result template while the blend row
 * itself has one; without the second reference those render blank for
 * no good reason.
 *
 * References are expanded in order, so every gateway for the preferred
 * reference is tried before the fallback's. Duplicates are dropped.
 */
export function mediaCandidates(
  ref: string | undefined | (string | undefined)[],
): string[] {
  const refs = Array.isArray(ref) ? ref : [ref];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of refs) {
    for (const url of candidatesForRef(r)) {
      if (seen.has(url)) continue;
      seen.add(url);
      out.push(url);
    }
  }
  return out;
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
  /** One reference, or several in priority order. */
  ref: string | undefined | (string | undefined)[];
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
 * Racing strategy.
 *
 * The naive design - try gateway 1, wait for it to fail, try gateway 2 -
 * is what makes artwork look "mostly missing" even when the content is
 * perfectly available: a dead IPFS gateway usually does not fail, it
 * HANGS, so `onerror` never fires and each miss costs the full timeout.
 * Four gateways then means a 24-second worst case, far past the point
 * where anyone is still looking at the card.
 *
 * So we hedge instead. Gateway 1 starts immediately; if it has not
 * answered within HEDGE_MS, gateway 2 starts *alongside* it rather than
 * replacing it, and so on. The first response that decodes to a real
 * image wins and the rest are abandoned. A healthy gateway therefore
 * still costs exactly one request, while a stalled one costs a second
 * of delay instead of the whole budget.
 */
const HEDGE_MS = 1_200;
/** Total budget for one thumbnail before it gives up and removes itself. */
const OVERALL_TIMEOUT_MS = 12_000;
/**
 * Safety net for the lazy-load observer. If an IntersectionObserver
 * callback has not arrived by now - a hidden tab, an odd embedding, a
 * browser that throttles it - load anyway rather than showing an empty
 * frame forever. Long enough that normal scrolling still wins.
 */
const OBSERVER_FALLBACK_MS = 2_500;

/**
 * Memo of `candidate url -> it worked`, and of the winner picked for a
 * given candidate list. The app re-renders by replacing innerHTML, so
 * every render throws away in-flight image loads and would otherwise
 * restart the whole race from zero; on a page that re-renders a few
 * times while data streams in, a thumbnail could be perpetually
 * restarted and never finish. Remembering the winner makes the next
 * render paint instantly from cache instead.
 */
const resolved = new Map<string, string>();
/** Candidate lists already proven hopeless, so we stop retrying them. */
const hopeless = new Set<string>();

/**
 * Starts loading every thumbnail in `root` and wires the gateway
 * fallback. Called once per render, after the HTML is in the DOM.
 *
 * Loading is deferred until the thumbnail is near the viewport. That
 * matters on the catalogue, where a collection can put 130 rows on one
 * page: only what you actually scroll to costs a request. It is done
 * with an IntersectionObserver rather than `loading="lazy"` because the
 * per-candidate deadline has to start when the request does - with
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

    const key = candidates.join('|');

    // Already known good from an earlier render: paint now, no race.
    const known = resolved.get(key);
    if (known) {
      img.src = known;
      img.classList.add('is-loaded');
      return;
    }
    // Already known bad: do not spend the budget discovering it again.
    if (hopeless.has(key)) {
      img.closest('figure')?.remove();
      return;
    }

    let launched = false;
    const start = () => {
      if (launched) return;
      launched = true;
      loadHedged(candidates, {
        onWin: (url) => {
          resolved.set(key, url);
          // The winning URL is already in the HTTP cache, so pointing
          // the visible <img> at it paints immediately.
          img.src = url;
          img.classList.add('is-loaded');
        },
        onFail: () => {
          hopeless.add(key);
          img.closest('figure')?.remove();
        },
        onAttempt: (n) => { img.dataset.mediaI = String(n); },
      });
    };

    // Defer the first request until the thumbnail is worth fetching.
    // 400px of margin means it is already there by the time it scrolls
    // in, without loading the whole list up front.
    if (typeof IntersectionObserver === 'function') {
      const io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            io.disconnect();
            start();
          }
        },
        { rootMargin: '400px' },
      );
      io.observe(img);
      // ...but never let a silent observer strand the thumbnail.
      setTimeout(() => { io.disconnect(); start(); }, OBSERVER_FALLBACK_MS);
    } else {
      start();
    }
  });
}

/**
 * Races `candidates` with hedged starts and resolves with the first URL
 * that decodes to a non-empty image.
 *
 * Probes are detached `Image` objects, never the element on screen, so
 * a losing gateway can never paint over a winner. A gateway answering
 * with an HTML error page decodes to 0x0 and counts as a failure.
 *
 * Exported for scripts/verify-media.mjs, which races it against fake
 * gateways.
 */
export function loadHedged(
  candidates: string[],
  cb: { onWin: (url: string) => void; onFail: () => void; onAttempt?: (n: number) => void },
): void {
  let settled = false;
  // By candidate index, so each gateway is asked once and counted once.
  // A fast failure promoted the next gateway while the failed one's hedge
  // timer started it again, so gateways were asked twice, and each second
  // failure counted: "every candidate failed" arrived while a slow one was
  // still on its way, and the thumbnail gave up seconds early
  // (scripts/verify-media.mjs).
  const begun = new Set<number>();
  const failed = new Set<number>();
  const timers: ReturnType<typeof setTimeout>[] = [];

  const stop = () => {
    settled = true;
    for (const t of timers) clearTimeout(t);
  };

  const overall = setTimeout(() => {
    if (settled) return;
    stop();
    cb.onFail();
  }, OVERALL_TIMEOUT_MS);
  timers.push(overall);

  const nextIndex = () => candidates.findIndex((_, i) => !begun.has(i));

  const startOne = (i: number) => {
    if (settled || i < 0 || i >= candidates.length || begun.has(i)) return;
    begun.add(i);
    cb.onAttempt?.(i);

    const probe = new Image();
    probe.decoding = 'async';
    probe.referrerPolicy = 'no-referrer';
    // Hedge: bring the next gateway in if this one is still silent.
    const hedge = setTimeout(() => { if (!settled) startOne(nextIndex()); }, HEDGE_MS);
    timers.push(hedge);
    const fail = () => {
      if (settled || failed.has(i)) return;
      failed.add(i);
      // This one is done, so its hedge has nothing left to cover.
      clearTimeout(hedge);
      // Every candidate answered and none worked: stop early rather
      // than sitting out the remaining budget.
      if (failed.size >= candidates.length) {
        stop();
        cb.onFail();
        return;
      }
      // A fast failure should immediately promote the next candidate
      // instead of waiting for its hedge timer.
      startOne(nextIndex());
    };
    probe.onerror = fail;
    probe.onload = () => {
      if (settled) return;
      if (probe.naturalWidth === 0) { fail(); return; }
      stop();
      cb.onWin(candidates[i]);
    };
    probe.src = candidates[i];
  };

  startOne(0);
}
