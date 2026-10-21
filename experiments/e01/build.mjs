/**
 * Builds the browser copies of the E1 probe modules (D1-EXP-02).
 *
 * Browsers cannot load `.ts`, so `probe.js` and `page.js` are checked in next
 * to their sources. Run the type check first, then this script:
 *
 *   npx tsc -p experiments/e01/tsconfig.json
 *   node experiments/e01/build.mjs
 *
 * esbuild is already installed as part of the root Vite devDependency, so this
 * adds no runtime dependency. The output keeps relative specifiers such as
 * `../shared/probe.js`, so the shared modules stay separate ES modules.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const modules = ["probe", "page"];

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
  const banner = `/* Generated from ${moduleName}.ts by experiments/e01/build.mjs. Do not edit directly. */\n`;
  await writeFile(outputPath, banner + result.code, "utf8");
}

console.log("Wrote experiments/e01/probe.js and experiments/e01/page.js");
