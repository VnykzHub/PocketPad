import { ESLint } from "eslint";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * D0-REPO-01 acceptance: the layer import restrictions are enforced by a
 * deliberately failing fixture, not by an inline eslint-disable.
 *
 * The real config is the repository root `eslint.config.js`. The fixture is a
 * fallback with the same boundary rules for isolated runs where that config is
 * absent; the real config wins whenever it exists.
 */
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const realConfig = fileURLToPath(new URL("../../../eslint.config.js", import.meta.url));
const fixtureConfig = fileURLToPath(
  new URL("./fixtures/eslint-boundary-config.mjs", import.meta.url),
);
const configFile = existsSync(realConfig) ? realConfig : fixtureConfig;

async function lintRuleIds(source: string, file: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: repositoryRoot, overrideConfigFile: configFile });
  const results = await eslint.lintText(source, {
    filePath: `${repositoryRoot}/${file}`,
  });
  return results.flatMap((result) => result.messages.map((message) => message.ruleId ?? ""));
}

describe("dependency boundaries (D0-REPO-01)", () => {
  test("[FR-10.2] runtime may not import controller", async () => {
    const ruleIds = await lintRuleIds(
      'import "@lanpad/controller";\n',
      "packages/runtime/src/boundary-probe.ts",
    );

    expect(ruleIds).toContain("no-restricted-imports");
  });

  test("[FR-10.1] protocol may not import another workspace package", async () => {
    const ruleIds = await lintRuleIds(
      'import "@lanpad/broker";\n',
      "packages/protocol/src/boundary-probe.ts",
    );

    expect(ruleIds).toContain("no-restricted-imports");
  });

  test("[FR-4.3] hard-coded websocket origins are rejected", async () => {
    const ruleIds = await lintRuleIds(
      'export const origin = "ws://192.168.1.20:8080/ws";\n',
      "packages/runtime/src/boundary-probe.ts",
    );

    expect(ruleIds).toContain("no-restricted-syntax");
  });
});
