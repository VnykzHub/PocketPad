/**
 * Generates `public/assets-manifest.json` from the shared bake-off assets.
 *
 * The engine asset library validates declared byte lengths against the
 * response body, so the manifest is built from the real files at build time.
 * Entry URLs stay relative to `baseUrl` (`../` from the page, i.e. the
 * `experiments/bakeoff/` folder the runner serves).
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const assetsRoot = resolve(packageRoot, "..", "assets");
const publicRoot = join(packageRoot, "public");

/**
 * [id, kind, relative path from experiments/bakeoff/]
 *
 * `car.glb` (five meshes) and `ped.glb` (a skin, no UVs, two primitives) are
 * outside what the engine's M0 glTF decoder accepts, so they are fetched and
 * parsed by `src/glb.js` instead of being declared here. Declaring them would
 * make `loadInitial` fail before the page could render.
 */
const ENTRIES = [
  ["ground", "mesh", "assets/ground.glb"],
  ["building", "mesh", "assets/building.glb"],
  ["facade", "texture", "assets/facade.png"],
];

const entries = [];
let totalBytes = 0;
const missing = [];

for (const [id, kind, url] of ENTRIES) {
  const path = resolve(assetsRoot, url.slice("assets/".length));
  if (!existsSync(path)) {
    missing.push(url);
    continue;
  }
  const bytes = statSync(path).size;
  totalBytes += bytes;
  entries.push({ id, kind, url, bytes, initial: true });
}

mkdirSync(publicRoot, { recursive: true });
const manifest = {
  formatVersion: 1,
  id: "bakeoff",
  budget: { initialBytes: Math.max(1, totalBytes), totalBytes: Math.max(1, totalBytes) },
  assets: entries,
};
writeFileSync(join(publicRoot, "assets-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(
  `[assets-manifest] ${entries.length} asset(s), ${totalBytes} bytes total` +
    (missing.length > 0 ? `; missing: ${missing.join(", ")}` : ""),
);
