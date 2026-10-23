import { defineConfig } from "vite";

/** Isolation headers the runner serves in production; dev/preview match them. */
const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};

export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    assetsInlineLimit: 0,
    sourcemap: false,
    chunkSizeWarningLimit: 6000,
  },
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
});
