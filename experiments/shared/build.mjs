/**
 * Builds the browser copies of the shared probe modules (D1-EXP-01).
 *
 * Browsers cannot load `.ts`, so `report.js` and `probe.js` are checked in next
 * to their sources. Run the type check first, then this script:
 *
 *   npx tsc -p experiments/shared/tsconfig.json
 *   node experiments/shared/build.mjs
 *
 * esbuild is already installed as part of the root Vite devDependency, so this
 * adds no runtime dependency. The output keeps the `./report.js` specifier, so
 * the two files stay separate ES modules rather than one bundle.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const modules = ["report", "probe"];

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
  const banner = `/* Generated from ${moduleName}.ts by experiments/shared/build.mjs. Do not edit directly. */\n`;
  await writeFile(outputPath, banner + result.code, "utf8");
}

console.log("Wrote experiments/shared/report.js and experiments/shared/probe.js");
