import { defineConfig } from 'vite';

// Compiles the author-side builders to ESM so the verify scripts can
// exercise the REAL parsers, validators and argument builders instead of
// hand-written copies. Output is gitignored; `npm run build:verify`
// regenerates it.
export default defineConfig({
  // The verify build has no page to serve, so it must not drag public/
  // into scripts/.build/ as a second stale copy of anything in there.
  publicDir: false,
  build: {
    lib: {
      entry: {
        createBlend: 'src/nefty/createBlend.ts',
        createUpgrade: 'src/nefty/createUpgrade.ts',
        lab: 'src/ui/lab.ts',
        collections: 'src/atomic/collections.ts',
      },
      formats: ['es'],
    },
    outDir: 'scripts/.build',
    emptyOutDir: true,
    minify: false,
    rollupOptions: { external: ['@wharfkit/session'], output: { entryFileNames: '[name].mjs' } },
  },
});
