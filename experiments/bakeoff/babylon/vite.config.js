import { defineConfig } from 'vite';

// The bench runs behind cross-origin isolation (SPEC §13). Same headers as the
// PocketPad dev server so the contender is measured under the production posture.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export default defineConfig({
  // dist/index.html is served from the repo root, so every emitted URL is relative.
  base: './',
  server: {
    headers: isolationHeaders,
    fs: { allow: ['..'] },
  },
  preview: { headers: isolationHeaders },
  // Havok ships an Emscripten ESM bundle; let Vite leave it alone.
  optimizeDeps: { exclude: ['@babylonjs/havok'] },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 8192,
  },
});
