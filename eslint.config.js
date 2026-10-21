import tseslint from "typescript-eslint";

/**
 * Layer dependency rules for the lanpad monorepo (D0-REPO-01).
 *
 * The architecture is enforced here, not by convention:
 * - runtime never imports controller (FR-10.2)
 * - controller never imports runtime or broker
 * - games never import server or controller code
 * - protocol imports no other workspace package (FR-10.1)
 * - WebSocket origins are derived from config, never hard-coded (FR-4.3)
 *
 * `packages/games/**` and `packages/relay/**` do not exist yet; the rules are
 * in place before those packages land so later stages cannot erode the
 * boundary.
 */
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "docs/**",
      "experiments/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["packages/runtime/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@lanpad/controller"],
              message: "runtime must not import controller (FR-10.2)",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/controller/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@lanpad/runtime", "@lanpad/broker"],
              message: "controller must not import runtime or broker",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/games/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@lanpad/broker",
                "@lanpad/dev-server",
                "@lanpad/relay",
                "@lanpad/controller",
              ],
              message: "games must not import server or controller code",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/protocol/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@lanpad/*"],
              message: "protocol must remain dependency-free (FR-10.1)",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.ts"],
    ignores: ["**/config.ts", "**/*.test.ts", "tools/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value=/^wss?:\\/\\//]",
          message:
            "no hard-coded websocket origins; derive them from config (FR-4.3)",
        },
      ],
    },
  },
);
