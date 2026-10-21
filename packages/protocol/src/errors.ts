/**
 * Protocol errors shared by the binary codecs (D0-PROTO-02) and JSON framing
 * (D0-PROTO-03).
 *
 * The `code` field is stable API. Server adapters map it to WebSocket close
 * codes: `tooLarge` -> 1009 (SR-6); the remaining codes are routed per message
 * direction (1002 for binary, 1008 for JSON control messages).
 */
export type ProtocolErrorCode = "tooLarge" | "badType" | "badLength" | "badValue";

export class ProtocolError extends Error {
  constructor(
    readonly code: ProtocolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}
