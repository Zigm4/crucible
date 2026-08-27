/**
 * The only thing this page ever writes to your browser.
 *
 * Crucible's promise has always been a clean boot: no backend, no
 * database, nothing tracking you. Remembering that somebody prefers the
 * list view does not break that promise, but doing it carelessly would,
 * so the boundary is drawn in code rather than in good intentions.
 *
 * What may be stored: choices a person made about how to LOOK at things.
 * A view mode. A sort order. A saved set of filters they named.
 *
 * What may never be stored, and is why `sanitize` exists rather than a
 * bare JSON.stringify: a wallet name, an asset id, a balance, a template,
 * a collection, anything read from the chain, anything that would say who
 * you are or what you own. If this file ever grows a field that carries
 * one of those, the reviewer should refuse it. A saved view holds a
 * search string the person typed, and that is the closest it comes.
 *
 * Nothing here is required. Every read and write is wrapped, because
 * localStorage throws outright in some private-browsing modes, and a page
 * that cannot remember a preference must still work perfectly.
 */

const KEY = 'crucible.prefs.v1';

/** A named set of filters, saved by the person who built it. */
export interface SavedView {
  name: string;
  /** The encoded view string the inventory already puts in the URL. */
  view: string;
}

export interface Prefs {
  /** 'grid' or 'list'. Not typed tighter here: this file must not care. */
  inventoryView?: string;
  inventorySort?: string;
  inventorySortDesc?: boolean;
  savedViews?: SavedView[];
}

/** True when the browser will actually let us keep anything. */
export function storageAvailable(): boolean {
  try {
    const probe = '__crucible_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * Strips anything that is not a known preference.
 *
 * Runs on write AND on read. On write it is the boundary described above.
 * On read it means a stored blob from an older or tampered build cannot
 * put unexpected shapes into application state.
 */
function sanitize(raw: unknown): Prefs {
  const out: Prefs = {};
  if (!raw || typeof raw !== 'object') return out;
  const p = raw as Record<string, unknown>;

  if (p.inventoryView === 'grid' || p.inventoryView === 'list') {
    out.inventoryView = p.inventoryView;
  }
  if (typeof p.inventorySort === 'string' && p.inventorySort.length <= 64) {
    out.inventorySort = p.inventorySort;
  }
  if (typeof p.inventorySortDesc === 'boolean') {
    out.inventorySortDesc = p.inventorySortDesc;
  }
  if (Array.isArray(p.savedViews)) {
    out.savedViews = p.savedViews
      .filter((v): v is SavedView =>
        Boolean(v) && typeof v === 'object'
        && typeof (v as SavedView).name === 'string'
        && typeof (v as SavedView).view === 'string')
      // Capped so a bug in the caller cannot fill somebody's storage
      // quota, and trimmed so one enormous view cannot either.
      .slice(0, 24)
      .map((v) => ({ name: v.name.slice(0, 48), view: v.view.slice(0, 2000) }));
  }
  return out;
}

export function readPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    return sanitize(JSON.parse(raw));
  } catch {
    return {};
  }
}

export function writePrefs(next: Prefs): void {
  try {
    const clean = sanitize(next);
    // An empty object is worth removing rather than storing: "forget me"
    // should leave nothing behind at all.
    if (!Object.keys(clean).length) { localStorage.removeItem(KEY); return; }
    localStorage.setItem(KEY, JSON.stringify(clean));
  } catch { /* a browser that refuses is not an error worth showing */ }
}

/** Merges one field without disturbing the others. */
export function patchPrefs(patch: Prefs): void {
  writePrefs({ ...readPrefs(), ...patch });
}

/** Removes everything this page has ever stored. */
export function forgetPrefs(): void {
  try { localStorage.removeItem(KEY); } catch { /* nothing to do */ }
}
