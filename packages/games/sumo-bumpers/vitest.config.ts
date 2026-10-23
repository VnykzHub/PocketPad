import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Local Vitest config for the Sumo Bumpers package.
 *
 * Root is pinned to this package so `npx vitest run --root
 * packages/games/sumo-bumpers` runs only this game's tests regardless of the
 * caller's cwd. The root workspace config also lists this package as a
 * project, so `npx vitest run` at the repo root executes it too.
 */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
