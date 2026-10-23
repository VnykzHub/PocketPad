// @req ER-21-08 — Babylon is sealed inside the adapter; the host clock is not Babylon's.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
/** Split so this test file does not match its own scan. */
const BABYLON_IMPORT = new RegExp(
  `(?:from\\s*|import\\s*\\(\\s*|require\\s*\\(\\s*)["']@babylon` +
    `js/`,
);
const ADAPTER_PREFIX = "packages/runtime/src/babylon/";

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      files.push(path);
    }
  }
  return files;
}

function relativePath(file: string): string {
  return relative(repoRoot, file).replaceAll("\\", "/");
}

describe("Babylon boundary", () => {
  test("[ER-21-08] Babylon imports stay inside the adapter package", () => {
    const offenders: string[] = [];
    for (const root of ["packages", "sdk"]) {
      for (const file of sourceFiles(join(repoRoot, root))) {
        const path = relativePath(file);
        if (path.startsWith(ADAPTER_PREFIX)) continue;
        if (readFileSync(file, "utf8").match(BABYLON_IMPORT)) {
          offenders.push(path);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("[ER-21-08] the runtime never starts a Babylon render loop", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(repoRoot, "packages/runtime/src"))) {
      if (/\.runRenderLoop\s*\(/.test(readFileSync(file, "utf8"))) {
        offenders.push(relativePath(file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
