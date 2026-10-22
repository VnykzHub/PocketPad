/**
 * Builds the browser copies of the E5 modules (D3-EXP-01).
 *
 * Browsers cannot load `.ts`, so `latency.js` and `page.js` are checked in
 * next to their sources. Type-check first, then run this script:
 *
 *   npx tsc -p experiments/e05/tsconfig.json
 *   node experiments/e05/build.mjs
 *
 * esbuild ships with the root Vite devDependency, so this adds no dependency.
 * Output is ES2019 ES modules with relative import specifiers kept.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const modules = ["latency", "page"];

for (const moduleName of modules) {
  const source = await readFile(join(here, `${moduleName}.ts`), "utf8");
  const result = await transform(source, {
    loader: "ts",
    format: "esm",
    target: "es2019",
    sourcefile: `${moduleName}.ts`,
    logLevel: "warning",
  });
  const banner = `/* Generated from ${moduleName}.ts by experiments/e05/build.mjs. Do not edit directly. */\n`;
  await writeFile(join(here, `${moduleName}.js`), banner + result.code, "utf8");
}

console.log("Wrote experiments/e05/latency.js and experiments/e05/page.js");
