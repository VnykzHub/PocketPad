/**
 * Standalone Vitest config for the animation package.
 *
 * The root `vitest.config.ts` only lists projects the integration agent has
 * registered; until then the package runs with this config:
 *   npx vitest run --root packages/engine/animation --config test/vitest.config.ts
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
  },
});
