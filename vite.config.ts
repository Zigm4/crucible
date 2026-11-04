import { resolve } from 'node:path';

import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
    rolldownOptions: {
      // Multi-page: the site (index.html, the guided interface that was
      // v2), the old classic page kept for a while at /backup/, and two
      // pages that only forward old links: /v2/ and guide.html.
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        backup: resolve(import.meta.dirname, 'backup/index.html'),
        guide: resolve(import.meta.dirname, 'guide.html'),
        v2: resolve(import.meta.dirname, 'v2/index.html'),
      },
    },
  },
});
