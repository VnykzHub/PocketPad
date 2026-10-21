/**
 * @lanpad/runtime — host runtime contracts (D0-RT-01).
 *
 * D0 exports the host network client and the debug input table. The fixed
 * loop, renderer, loader and game interface arrive in D3; games never import
 * sockets from here (FR-7.17).
 */
export * from "./net/hostClient.js";
export * from "./debug/inputTable.js";
