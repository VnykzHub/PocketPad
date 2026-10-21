import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Local Vitest config for the Reaction Duel content scaffold.
 *
 * Root is pinned to this package so `npx vitest --config
 * packages/games/reaction-duel/vitest.config.ts` runs only this game's tests
 * regardless of the caller's cwd. The root workspace config is intentionally
 * not edited; registry wiring belongs to D7-SDK-01.
 */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
