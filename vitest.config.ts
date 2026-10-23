import { defineConfig } from "vitest/config";

/**
 * Root Vitest config (D0-REPO-01).
 *
 * One project per workspace. Node is the default environment; jsdom is scoped
 * to the controller package for its future DOM tests. `passWithNoTests` keeps
 * the scaffold green until D0 work items add their first tagged tests.
 */
const nodeProject = (root: string) => ({
  root,
  test: {
    name: root,
    environment: "node" as const,
    passWithNoTests: true,
  },
});

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      nodeProject("packages/protocol"),
      nodeProject("packages/broker"),
      nodeProject("packages/dev-server"),
      nodeProject("packages/games/reaction-duel"),
      nodeProject("packages/games/platformer"),
      nodeProject("packages/games/engine-cube"),
      nodeProject("packages/runtime"),
      {
        root: "packages/engine/core",
        test: {
          name: "packages/engine/core",
          environment: "node" as const,
          passWithNoTests: true,
          // Property suites run 10,000 fast-check cases; the default 5 s is
          // exceeded when projects share the CPU. Assertions are unchanged.
          testTimeout: 30_000,
        },
      },
      nodeProject("packages/engine/renderer-webgpu"),
      nodeProject("packages/engine/renderer-webgl2"),
      nodeProject("packages/engine/assets"),
      nodeProject("packages/engine/input"),
      nodeProject("packages/engine/audio"),
      nodeProject("packages/engine/physics"),
      nodeProject("packages/engine/animation"),
      nodeProject("packages/engine/streaming"),
      {
        root: "packages/controller",
        test: {
          name: "packages/controller",
          environment: "jsdom" as const,
          passWithNoTests: true,
        },
      },
      nodeProject("experiments"),
      nodeProject("sdk"),
      nodeProject("tools/input-bot"),
      nodeProject("tools/size-budget"),
      nodeProject("tools/trace-check"),
      nodeProject("tools/engine-test"),
    ],
  },
});
