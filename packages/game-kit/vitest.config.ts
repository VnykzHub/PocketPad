import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Local Vitest config for `@lanpad/game-kit`.
 *
 * Root is pinned to this package so the scoped command
 * `npx vitest run --root packages/game-kit` runs only these tests. The root
 * workspace config must also list this package as a project for `npm test`.
 */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
