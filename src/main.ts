/**
 * Crucible: application entry point.
 *
 * Hands off to `ui/app::mount()`, which sets up the SessionKit, restores
 * any cached wallet session, renders the initial UI, and wires the global
 * outside-click handler used by the custom dropdown pickers.
 *
 * Errors bubbling out of mount() are surfaced as a fail-safe message in
 * place of the rendered app, so the page never just dies silently.
 */
import { mount } from './ui/app';

mount().catch((err) => {
  console.error('Bootstrap failed', err);
  const root = document.getElementById('root');
  if (root) {
    root.innerHTML = `<div class="card"><h2>Startup error</h2><pre>${String(err)}</pre></div>`;
  }
});
