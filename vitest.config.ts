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
      nodeProject("packages/runtime"),
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
    ],
  },
});
