/**
 * Test-only flat-config fixture for dependencyBoundary.test.ts.
 *
 * The real config is the repository root `eslint.config.js`. This fixture is a
 * fallback that keeps the boundary assertions runnable when that config is
 * absent (for example, an isolated copy of the package). The test prefers the
 * real config whenever it exists; this file is not a lint config for the
 * project.
 */
export default [
  {
    files: ["packages/runtime/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [{ group: ["@lanpad/controller"], message: "runtime must not import controller" }],
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
          patterns: [{ group: ["@lanpad/*"], message: "protocol must remain dependency-free" }],
        },
      ],
    },
  },
  {
    files: ["packages/runtime/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value=/^wss?:\\/\\//]",
          message: "no hard-coded websocket origins",
        },
      ],
    },
  },
];
