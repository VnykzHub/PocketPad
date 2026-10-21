/**
 * Host page build (D0-RT-01).
 *
 * `tsc -b` runs first and emits the package API into `dist/`; Vite then adds
 * the host page (`index.html` + hashed `assets/`) to the same directory.
 * `emptyOutDir` must stay false or Vite would delete the tsc output, whose
 * `dist/index.js` is the package entry D3 imports.
 */
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
  },
});
