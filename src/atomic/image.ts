/**
 * Where a template keeps its artwork.
 *
 * This is an AtomicAssets fact, not a rendering concern: the standard
 * does not name an image field, so authors put the reference under `img`,
 * `image`, or a numbered variant, and a reader has to try them in order.
 *
 * It lives here rather than next to the thumbnail renderer so that the
 * contract layers stay free of any dependency on the UI. Anyone lifting
 * `nefty/`, `waxdao/` or `blenderizer/` out of this project takes
 * `atomic/` with them and nothing else.
 */

/**
 * Field names seen carrying artwork across real collections, in order of
 * preference. `img` covers the vast majority; `img2` is common enough (54
 * of 400 underpunks55 templates) that ignoring it would silently blank a
 * whole class of items.
 */
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
