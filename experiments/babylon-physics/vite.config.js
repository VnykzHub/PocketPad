import { defineConfig } from "vite";

// The spike runs behind cross-origin isolation, matching the PocketPad dev
// server posture (SPEC §13), so the measured boot/resource numbers include the
// same headers the engine will ship under.
const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};

export default defineConfig({
  // dist/index.html is served from an arbitrary port, so emitted URLs are relative.
  base: "./",
  server: {
    headers: isolationHeaders,
    // Allow the workspace packages linked from the repo root.
    fs: { allow: ["../.."] },
  },
  preview: { headers: isolationHeaders },
  // Havok ships an Emscripten ESM bundle; let Vite leave it alone.
  optimizeDeps: { exclude: ["@babylonjs/havok"] },
  build: {
    target: "es2022",
    // Keep the Havok WASM as its own file so the transferred bytes are visible.
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 8192,
  },
});
