/**
 * @lanpad/broker — room/session core and WebSocket adapter (D0-SRV-02/03).
 *
 * `RoomRegistry` owns room lifecycle, credentials, slots and fan-out; it is
 * transport-agnostic. `attachWebSocketServer` is the `ws` transport used by
 * the dev server and, in Phase 2, by the relay (amendment A1).
 */
export * from "./peer.js";
export * from "./room.js";
export * from "./registry.js";
export * from "./ws-server.js";
