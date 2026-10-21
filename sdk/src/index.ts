/**
 * @lanpad/sdk — game boundary contracts (D0-SDK-01, D2-LAYOUT-01).
 *
 * Public surface: the game manifest type/validator, the controller layout
 * types/validator, and the server origin helpers. Runtime internals, sockets,
 * and brand assets never live here.
 */
export * from "./manifest.js";
export * from "./config.js";
export * from "./layout.js";
export * from "./layout-validate.js";
