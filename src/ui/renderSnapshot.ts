/**
 * Keeping the page still across a full re-render.
 *
 * Every page here rebuilds its markup with innerHTML. Captures the window
 * scroll position and the currently-focused input (with its cursor offset
 * and selection range) so we can restore them after re-rendering. Without
 * this, every state change would yank the page back to the top and steal
 * focus mid-typing, which is the visual "the whole page is refreshing"
 * effect we want to avoid.
 */
export interface RenderSnapshot {
  scrollY: number;
  activeId: string | null;
  selStart: number | null;
  selEnd: number | null;
}

export function captureRenderSnapshot(): RenderSnapshot {
  const el = document.activeElement as HTMLInputElement | null;
  const tag = el?.tagName;
  const isInput = tag === 'INPUT' || tag === 'TEXTAREA';
  return {
    scrollY: window.scrollY,
    activeId: el?.id ?? null,
    selStart: isInput ? el!.selectionStart : null,
    selEnd: isInput ? el!.selectionEnd : null,
  };
}

export function restoreRenderSnapshot(snap: RenderSnapshot) {
  // Restore scroll first, doing it after focus would cause the browser
  // to jump back to the focused element.
  window.scrollTo({ top: snap.scrollY, behavior: 'instant' as ScrollBehavior });
  if (snap.activeId) {
    const el = document.getElementById(snap.activeId) as HTMLInputElement | null;
    if (el) {
      el.focus({ preventScroll: true });
      if (snap.selStart !== null && snap.selEnd !== null && typeof el.setSelectionRange === 'function') {
        try { el.setSelectionRange(snap.selStart, snap.selEnd); } catch { /* noop */ }
      }
    }
  }
}
