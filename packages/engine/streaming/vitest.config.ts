/**
 * Package-local Vitest config for scoped runs.
 *
 * The repo-root `vitest.config.ts` lists projects explicitly and does not yet
 * register `packages/engine/streaming`; registering it is the integration
 * agent's change (root file is outside this package's ownership). Until then:
 *
 *     npx vitest run --config packages/engine/streaming/vitest.config.ts
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Without an explicit root Vitest resolves `include` from process.cwd().
  root: dirname(fileURLToPath(import.meta.url)),
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    passWithNoTests: false,
    // Property suites use 1,000-10,000 fast-check cases.
    testTimeout: 30_000,
  },
});
