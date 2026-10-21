/**
 * @lanpad/broker — room/session core and WebSocket adapter (D0-SRV-02/03).
 *
 * `RoomRegistry` owns room lifecycle, credentials, slots and fan-out; it is
 * transport-agnostic. `attachWebSocketServer` is the `ws` transport used by
 * the dev server and, in Phase 2, by the relay (amendment A1).
 *
 * D4 adds the auth primitives (tokens, PINs, the SR-5 join limiter),
 * `HostRecovery` (FR-7.16) and the stats collector/ticker (FR-7.14) to the
 * public surface so the dev server can inject the limiter and tests can drive
 * host recovery directly.
 */
export * from "./peer.js";
export * from "./room.js";
export * from "./registry.js";
export * from "./ws-server.js";
export * from "./auth/tokens.js";
export * from "./auth/rateLimit.js";
export * from "./room/host.js";
export * from "./room/stats.js";
