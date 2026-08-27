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
        upgradeGate: 'src/nefty/upgradeGate.ts',
        blend: 'src/nefty/blend.ts',
        inventory: 'src/ui/inventory.ts',
        prefs: 'src/ui/prefs.ts',
        bridge: 'src/ui/bridge.ts',
        wallet: 'src/nefty/wallet.ts',
        tokens: 'src/nefty/tokens.ts',
        discover: 'src/nefty/discover.ts',
        guidedRun: 'src/ui/guidedRun.ts',
        lab: 'src/ui/lab.ts',
        collections: 'src/atomic/collections.ts',
        names: 'src/wax/names.ts',
        staking: 'src/nefty/staking.ts',
        stakingView: 'src/ui/stakingView.ts',
      },
      formats: ['es'],
    },
    outDir: 'scripts/.build',
    emptyOutDir: true,
    minify: false,
    rollupOptions: { external: ['@wharfkit/session'], output: { entryFileNames: '[name].mjs' } },
  },
});
