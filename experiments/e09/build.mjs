/**
 * Builds the browser copies of the D4-EXP-01 probe modules.
 *
 * Browsers cannot load `.ts`, so `stats.js`, `probe.js` and `page.js` are
 * checked in next to their sources. Run the type check first, then this script:
 *
 *   npx tsc -p experiments/e09/tsconfig.json
 *   node experiments/e09/build.mjs
 *
 * esbuild ships with the root Vite devDependency. Relative specifiers such as
 * `../e01/probe.js` are kept, so each module stays a separate ES module.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const modules = ["stats", "probe", "page"];

for (const moduleName of modules) {
  const source = await readFile(join(here, `${moduleName}.ts`), "utf8");
  const result = await transform(source, {
    loader: "ts",
    format: "esm",
    target: "es2019",
    sourcefile: `${moduleName}.ts`,
    logLevel: "warning",
  });
  const banner = `/* Generated from ${moduleName}.ts by experiments/e09/build.mjs. Do not edit directly. */\n`;
  await writeFile(join(here, `${moduleName}.js`), banner + result.code, "utf8");
}

console.log("Wrote experiments/e09/stats.js, probe.js and page.js");
