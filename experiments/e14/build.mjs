/**
 * Builds the browser copies of the E14 modules (D1-EXP-05).
 *
 * Browsers cannot load `.ts`, so `validate.js` and `page.js` are checked in
 * next to their sources. Run the type check first, then this script:
 *
 *   npx tsc -p experiments/e14/tsconfig.json
 *   node experiments/e14/build.mjs
 *
 * esbuild ships with the root Vite devDependency, so this adds no runtime
 * dependency. The transform keeps relative `./validate.js` specifiers, so the
 * page loads two small ES modules rather than one bundle.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const modules = ["validate", "page"];

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
  const banner = `/* Generated from ${moduleName}.ts by experiments/e14/build.mjs. Do not edit directly. */\n`;
  await writeFile(outputPath, banner + result.code, "utf8");
}

console.log("Wrote experiments/e14/validate.js and experiments/e14/page.js");
