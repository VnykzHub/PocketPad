import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Local Vitest config for the Beat Tap package.
 *
 * Root is pinned to this package so `npx vitest run --root
 * packages/games/beat-tap` runs only this game's tests regardless of the
 * caller's cwd. The root workspace config must also list this package as a
 * project before repo-wide `npm test` includes it (integration step; this
 * stream owns only `packages/games/beat-tap/**`).
 */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
