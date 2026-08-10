import { defineConfig } from 'vite';

// Compiles the author-side builders to ESM so the verify scripts can
// exercise the REAL parsers, validators and argument builders instead of
// hand-written copies. Output is gitignored; `npm run build:verify`
// regenerates it.
export default defineConfig({
  build: {
    lib: {
      entry: {
        createBlend: 'src/nefty/createBlend.ts',
        createUpgrade: 'src/nefty/createUpgrade.ts',
        lab: 'src/ui/lab.ts',
      },
      formats: ['es'],
    },
    outDir: 'scripts/.build',
    emptyOutDir: true,
    minify: false,
    rollupOptions: { external: ['@wharfkit/session'], output: { entryFileNames: '[name].mjs' } },
  },
});
