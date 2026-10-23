/**
 * Crucible v2 (preview): entry point.
 *
 * Same contract as the classic entry: hand off to the shell, and if it
 * throws on the way up, say so on the page instead of leaving it blank.
 */
import { mount } from './app';

mount().catch((err) => {
  console.error('Bootstrap failed', err);
  const root = document.getElementById('root');
  if (root) {
    root.innerHTML = `<div class="lab-panel"><h2>Startup error</h2><pre>${String(err)}</pre></div>`;
  }
});
