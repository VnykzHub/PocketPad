/**
 * Transport-agnostic peer and logging contracts (D0-SRV-02).
 *
 * The broker never imports `ws`. `packages/dev-server` and `packages/relay`
 * adapt their transport to this interface (amendment A1), so room semantics
 * stay in one place across both environments.
 */
export interface Peer {
  /** Queues a text (JSON) or binary frame. Must not throw for a closed peer. */
  send(data: string | Uint8Array): void;
  /** Starts the WebSocket closing handshake with the given application code. */
  close(code: number, reason: string): void;
  /** Peer address used by the D4 rate limiter (SR-5). */
  readonly remoteAddress: string;
  /**
   * Bytes queued on the transport, when it exposes them. `routeInput` drops
   * level-only input above `maxBufferedBytes` so a slow host cannot grow an
   * unbounded queue (D0-SRV-03).
   */
  readonly bufferedAmount?: number;
}

/**
 * Structured logger (SR-9). Tokens, PINs and message bodies must never be
 * passed as fields; event names and non-secret counters only.
 */
export interface Logger {
  info(event: string, fields: Record<string, string | number>): void;
  /** Optional debug channel, used for backpressure drops and socket errors. */
  debug?(event: string, fields: Record<string, string | number>): void;
}
