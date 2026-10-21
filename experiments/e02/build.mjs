/**
 * Builds the browser copies of the E2 probe modules (D1-EXP-03).
 *
 * Browsers cannot load `.ts`, so `stop-conditions.js` and `probe.js` are
 * checked in next to their sources. Run the type check first, then this script:
 *
 *   npx tsc -p experiments/e02/tsconfig.json
 *   node experiments/e02/build.mjs
 *
 * esbuild ships with the root Vite devDependency, so this adds no runtime
 * dependency. The output keeps the `./stop-conditions.js` and
 * `../shared/report.js` specifiers, so the page loads separate ES2019 modules
 * rather than one bundle.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const modules = ["stop-conditions", "probe"];

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
  const banner = `/* Generated from ${moduleName}.ts by experiments/e02/build.mjs. Do not edit directly. */\n`;
  await writeFile(outputPath, banner + result.code, "utf8");
}

console.log("Wrote experiments/e02/stop-conditions.js and experiments/e02/probe.js");
