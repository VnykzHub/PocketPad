/**
 * Copies the declaration-only contract modules into `dist`.
 *
 * `tsc` type-checks `.d.ts` inputs but does not emit them, so the emitted
 * `dist/index.d.ts` would otherwise re-export `./contracts/*.js` that do not
 * exist. Run after `tsc -b`; see the package `build` script.
 */
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(packageRoot, "src", "contracts");
const destination = join(packageRoot, "dist", "contracts");

mkdirSync(destination, { recursive: true });
cpSync(source, destination, {
  recursive: true,
  filter: (path) => path === source || path.endsWith(".d.ts"),
});
