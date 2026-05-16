import { mount } from './ui/app';

mount().catch((err) => {
  console.error('Bootstrap failed', err);
  const root = document.getElementById('root');
  if (root) {
    root.innerHTML = `<div class="card"><h2>Erreur au démarrage</h2><pre>${String(err)}</pre></div>`;
  }
});
