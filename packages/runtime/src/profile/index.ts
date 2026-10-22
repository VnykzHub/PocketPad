/**
 * Profile module barrel (D3-RT-07).
 *
 * Host integrations import from here. `src/main.ts` wires it (D3-RT-04) and
 * `src/index.ts` re-exports it as part of the package API.
 */
export * from "./budgets.js";
export * from "./tvProfile.js";
export * from "./resolutionController.js";
export * from "./framePacing.js";
export * from "./contextLoss.js";
