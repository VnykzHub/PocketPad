import { readdirSync } from "node:fs";
import { defineConfig } from "vitest/config";

/**
 * Root Vitest config (D0-REPO-01).
 *
 * One project per workspace. Node is the default environment; jsdom is scoped
 * to the controller package for its future DOM tests. Game projects are
 * discovered from `packages/games/*` so adding a game folder needs no root
 * config edit (Wave 0).
 */
const nodeProject = (root: string) => ({
  root,
  test: {
    name: root,
    environment: "node" as const,
    passWithNoTests: true,
  },
});

const gameProjects = readdirSync("packages/games", { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => nodeProject(`packages/games/${entry.name}`));

export default defineConfig({
  test: {
    passWithNoTests: true,
    // Parallel agent worktrees and the browser can starve the machine; 4
    // workers keeps the full suite reliable. Assertions and timeouts are
    // unchanged.
    maxWorkers: 4,
    projects: [
      nodeProject("packages/protocol"),
      nodeProject("packages/broker"),
      nodeProject("packages/dev-server"),
      ...gameProjects,
      nodeProject("packages/runtime"),
      nodeProject("packages/game-kit"),
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
      nodeProject("tools/asset-curate"),
      nodeProject("tools/size-budget"),
      nodeProject("tools/trace-check"),
      nodeProject("tools/engine-test"),
    ],
  },
});
