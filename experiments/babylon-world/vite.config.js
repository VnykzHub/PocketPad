import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(root, "../..");

// Same isolation posture as the PocketPad dev server (SPEC §13).
const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};

export default defineConfig({
  root,
  base: "./",
  publicDir: false,
  assetsInclude: ["**/*.glb"],
  server: {
    headers: isolationHeaders,
    // The page imports the runtime adapter and the tracked bake-off GLB.
    fs: { allow: [repoRoot] },
  },
  preview: { headers: isolationHeaders },
  build: {
    target: "es2022",
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 8192,
  },
});
