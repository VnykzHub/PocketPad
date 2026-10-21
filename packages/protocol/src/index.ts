/**
 * @lanpad/protocol — the zero-dependency wire contract (D0-PROTO-01..03).
 *
 * Public surface: constants, JSON message types, binary codecs and JSON
 * framing. Nothing here opens a socket, knows about rooms, or interprets game
 * payloads.
 */
export * from "./constants.js";
export * from "./binary.js";
export * from "./json.js";
export type * from "./messages.js";
