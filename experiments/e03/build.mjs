/**
 * Builds the browser copies of the E3 modules (D1-EXP-04).
 *
 * Browsers cannot load `.ts`, so `stats.js` and `bench.js` are checked in next
 * to their sources. Tests import the `.ts` sources; a test also compares the
 * generated `stats.js` with the source so a stale artifact cannot ship.
 *
 *   npx tsc -p experiments/e03/tsconfig.json
 *   node experiments/e03/build.mjs
 *
 * esbuild already ships with the root Vite devDependency, so this adds no
 * runtime dependency. Output is ES2019 ES modules with import specifiers kept.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const modules = ["stats", "bench"];

for (const moduleName of modules) {
  const sourcePath = join(here, `${moduleName}.ts`);
  const outputPath = join(here, `${moduleName}.js`);
  const source = await readFile(sourcePath, "utf8");
  const result = await transform(source, {
    loader: "ts",
    format: "esm",
    target: "es2019",
    sourcefile: `${moduleName}.ts`,
    logLevel: "warning",
  });
  const banner = `/* Generated from ${moduleName}.ts by experiments/e03/build.mjs. Do not edit directly. */\n`;
  await writeFile(outputPath, banner + result.code, "utf8");
}

console.log("Wrote experiments/e03/stats.js and experiments/e03/bench.js");
