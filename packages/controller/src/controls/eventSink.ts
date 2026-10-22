/**
 * Control → event queue boundary (D5-CTRL-01; FR-7.8, FR-8.1).
 *
 * Controls never own a socket and never serialize a frame. They hand a
 * validated `{name, data}` pair to an injected sink, which in production is the
 * D5-CTRL-05 `EventQueue` (30/s sustained, burst 60, 4 KB frame cap). The
 * interface is deliberately smaller than the queue: the queue owns rate
 * limiting, coalescing, buffering and the slot stamp, so a control cannot
 * bypass any of them.
 *
 * `priority` is a hint. Text and choice submissions pass `"high"` because the
 * queue must never silently drop them; stroke batches pass `"low"` because
 * losing an intermediate batch is preferable to dropping the stroke's start or
 * end (D5-CTRL-04/05).
 *
 * There is no HTML in any payload by construction: every data object is plain
 * JSON (`JsonValue`), and the renderer assigns text with `textContent`.
 */
import type { JsonValue } from "@lanpad/protocol";
import { isValidEventName } from "@lanpad/sdk";

/**
 * Relative importance used by the queue when it must coalesce or drop.
 * `"high"` = never silently dropped, `"normal"` = default, `"low"` = coalescible.
 */
export type ControlEventPriority = "high" | "normal" | "low";

/** The only surface a control has for sending an event. */
export interface ControlEventSink {
  /**
   * Queues one event. The implementation validates the slot, the 4 KB frame
   * size and the rate limit; controls pass only SDK-validated shapes.
   */
  enqueue(name: string, data: JsonValue, priority?: ControlEventPriority): void;
}

/** `choice` tap payload (D5 contract 6). */
export type ChoiceEventData = { value: string };

/** `text` submit payload; already trimmed and truncated to `maxLen` (D5 contract 6). */
export type TextEventData = { value: string };

/** One normalized stroke point; `x`/`y` in 0..1, `t` in milliseconds. */
export type StrokePoint = { x: number; y: number; t: number };

/** Batched stroke payload (D5 contract 5). */
export type StrokeEventData = {
  points: StrokePoint[];
  color: string;
  width: number;
  phase: "start" | "move" | "end";
  /** Total points sampled for the stroke; present on `end` only (additive). */
  count?: number;
};

/**
 * Emits one control event. Returns false — without calling the sink — when no
 * sink is wired or the layout's event name is not a wire-safe identifier
 * (SR-13 defense in depth; the layout validator already rejects bad names).
 * Controls use the return value only to decide whether to clear local state.
 */
export function emitControlEvent(
  sink: ControlEventSink | undefined,
  name: string,
  data: JsonValue,
  priority: ControlEventPriority = "normal",
): boolean {
  if (sink === undefined || !isValidEventName(name)) {
    return false;
  }
  sink.enqueue(name, data, priority);
  return true;
}
