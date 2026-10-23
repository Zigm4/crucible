import { resolve } from 'node:path';

import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
    rolldownOptions: {
      // Multi-page: the app (index.html), the standalone themed user guide,
      // and the v2 preview, served under /v2/ next to the classic app.
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        guide: resolve(import.meta.dirname, 'guide.html'),
        v2: resolve(import.meta.dirname, 'v2/index.html'),
      },
    },
  },
});
