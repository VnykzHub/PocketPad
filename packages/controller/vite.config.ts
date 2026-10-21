/**
 * Controller page build (D0-CTRL-01).
 *
 * The controller is mounted at `/c/` by the dev server, so `base` must be
 * `/c/` or the built HTML would reference `/assets/...`, which the host page
 * owns. `tsc -b` runs first and emits the package API into `dist/`; Vite then
 * adds the page (`index.html` + hashed `assets/`) to the same directory.
 * `emptyOutDir` must stay false or Vite would delete the tsc output, whose
 * `dist/index.js` is the package entry later stages import. This mirrors
 * `packages/runtime/vite.config.ts`.
 */
import { defineConfig } from "vite";

export default defineConfig({
  base: "/c/",
  build: {
    outDir: "dist",
    emptyOutDir: false,
  },
});
