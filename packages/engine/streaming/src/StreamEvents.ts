/**
 * Streaming error codes, the `StreamingError` class and the event registry
 * (spec 12 §5.1, `src/StreamEvents.ts`).
 *
 * Code ownership: the concrete strings live in `@lanpad/engine-core`'s frozen
 * `EngineErrorCode` union (00 §5.9, extended additively by spec 12). This
 * module narrows that union to the four streaming prefixes; it declares no
 * code strings of its own. `E_STREAM_FETCH`, `E_STREAM_DECOMPRESS` (12 §9),
 * `E_STREAM_BUDGET`, `E_STREAM_SIM_BUDGET`, `E_STREAM_PIN_BUDGET` (12 §5.7),
 * `E_CELL_HASH`, `E_CELL_SECTION`, `E_CELL_KIND`, `E_CELL_SIZE`,
 * `E_CELL_APPLY` (12 §4.2, §5.5) and `E_STATE_WORLD`/`E_STATE_BOUNDS`/
 * `E_STATE_ORDER` (12 §3.4) are named by the spec; the remaining members
 * cover the named rejections required by ER-12-01.
 */

import type { EngineErrorCode } from "@lanpad/engine-core";
import type { StreamEvent } from "./contracts/world.js";

/**
 * Streaming error codes, derived from the canonical core taxonomy. A new
 * `E_WORLD_*`, `E_CELL_*`, `E_STREAM_*` or `E_STATE_*` code is introduced in
 * `@lanpad/engine-core` first, never here.
 */
export type StreamingErrorCode = Extract<
  EngineErrorCode,
  | `E_WORLD_${string}`
  | `E_CELL_${string}`
  | `E_STREAM_${string}`
  | `E_STATE_${string}`
>;

const RECOVERABLE: ReadonlySet<StreamingErrorCode> = new Set<StreamingErrorCode>([
  "E_STREAM_FETCH",
  "E_STREAM_ABORT",
  "E_STREAM_BUDGET",
  "E_STREAM_SIM_BUDGET",
  "E_STREAM_PIN_BUDGET",
]);

export class StreamingError extends Error {
  readonly code: StreamingErrorCode;
  readonly layer = "streaming" as const;
  readonly recoverable: boolean;

  constructor(code: StreamingErrorCode, message: string, recoverable?: boolean) {
    super(message);
    this.name = "StreamingError";
    this.code = code;
    this.recoverable = recoverable ?? RECOVERABLE.has(code);
  }
}

export function streamingError(
  code: StreamingErrorCode,
  message: string,
  recoverable?: boolean,
): StreamingError {
  return new StreamingError(code, message, recoverable);
}

export function isStreamingError(value: unknown): value is StreamingError {
  return value instanceof StreamingError;
}

/**
 * Returns the streaming code for any thrown value. Unknown values map to
 * `E_STREAM_STATE` so callers always have a stable string; the original
 * message is preserved when present.
 */
export function errorCodeOf(error: unknown): StreamingErrorCode {
  if (isStreamingError(error)) return error.code;
  return "E_STREAM_STATE";
}

export function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export type StreamEventListener = (event: StreamEvent) => void;

/**
 * Event registry keyed by `StreamEvent["type"]` (12 §5.1).
 *
 * Listeners are invoked synchronously in registration order. A listener that
 * unsubscribes itself during dispatch does not receive the current event
 * again; listeners added during dispatch are not called for it.
 */
export class StreamEventBus {
  private readonly byType = new Map<string, Set<StreamEventListener>>();

  on(type: StreamEvent["type"], listener: StreamEventListener): () => void {
    let set = this.byType.get(type);
    if (set === undefined) {
      set = new Set<StreamEventListener>();
      this.byType.set(type, set);
    }
    set.add(listener);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const current = this.byType.get(type);
      if (current === undefined) return;
      current.delete(listener);
      if (current.size === 0) this.byType.delete(type);
    };
  }

  emit(event: StreamEvent): void {
    const set = this.byType.get(event.type);
    if (set === undefined) return;
    for (const listener of set) {
      listener(event);
    }
  }

  listenerCount(type: StreamEvent["type"]): number {
    return this.byType.get(type)?.size ?? 0;
  }

  clear(): void {
    this.byType.clear();
  }
}
