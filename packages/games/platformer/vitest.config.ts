import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Local Vitest config for the Coin Run package.
 *
 * Root is pinned to this package so `npx vitest --config
 * packages/games/platformer/vitest.config.ts` runs only this game's tests
 * regardless of the caller's cwd. The root workspace config also lists this
 * package as a project, so `npx vitest run` at the repo root executes it too.
 */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
