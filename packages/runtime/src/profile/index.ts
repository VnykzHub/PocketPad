/**
 * Profile module barrel (D3-RT-07).
 *
 * Host integrations import from here; nothing in this folder is exported from
 * `src/index.ts` yet because D3-RT-07 does not own that file. The integration
 * owner re-exports the profile once the host is wired.
 */
export * from "./budgets.js";
export * from "./tvProfile.js";
export * from "./resolutionController.js";
export * from "./framePacing.js";
export * from "./contextLoss.js";
