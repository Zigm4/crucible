import { defineConfig } from 'vite';
export default defineConfig({
  build: {
    lib: { entry: 'src/nefty/createBlend.ts', formats: ['es'], fileName: () => 'createBlend.mjs' },
    outDir: 'scripts/.build', emptyOutDir: true, minify: false,
    rollupOptions: { external: ['@wharfkit/session'] },
  },
});
