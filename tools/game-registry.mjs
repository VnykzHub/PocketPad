#!/usr/bin/env node
/**
 * Typecheck every game folder without a hand-maintained list (Wave 0).
 *
 * A game is discoverable when it has `packages/games/<slug>/tsconfig.json`.
 * Adding or removing a game needs no root-script edit; this runner and the
 * root Vitest config both discover folders at run time.
 */
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const gamesDir = path.join(repoRoot, "packages", "games");
const tsc = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");

const entries = await readdir(gamesDir, { withFileTypes: true });
const games = entries
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) =>
    existsSync(path.join(gamesDir, name, "tsconfig.json")),
  )
  .sort();

if (games.length === 0) {
  console.error("typecheck:games: no game tsconfig.json files found");
  process.exit(1);
}

const failed = [];
for (const slug of games) {
  const tsconfig = path.join(gamesDir, slug, "tsconfig.json");
  const result = spawnSync(process.execPath, [tsc, "-p", tsconfig, "--noEmit"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) failed.push(slug);
}

if (failed.length > 0) {
  console.error(`typecheck:games: failed for ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`typecheck:games: ${games.length} games typecheck clean`);
