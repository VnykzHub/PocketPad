import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Local Vitest config for Draw and Guess.
 *
 * Root is pinned to this package so `npx vitest run --root
 * packages/games/draw-and-guess` runs only this game's tests regardless of
 * the caller's cwd. The root workspace config also discovers
 * `packages/games/*` as projects, so `npx vitest run` at the repo root runs
 * it too.
 */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
