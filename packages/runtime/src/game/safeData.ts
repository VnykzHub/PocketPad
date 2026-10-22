/**
 * Game-side event hardening (D5-SEC-01; SR-13, SR-7, FR-7.9).
 *
 * The broker forwards `event.data` opaquely (FR-7.9) and `EventRouter` checks
 * the envelope (slot, safe name, 4 KiB frame). What is left when a game reads
 * an event is still untrusted: a payload can nest deeply, carry non-finite
 * numbers or contain markup in a text field. These helpers are the runtime's
 * second line of defense:
 *
 * - `isSafeEventName` enforces the shared wire-name pattern;
 * - `isSafeEventPayload` bounds nesting and rejects non-JSON values before a
 *   handler walks the payload;
 * - `readEventText` / `readEventValue` return sanitized plain text that must be
 *   rendered with `textContent` (or drawn as canvas text), never as HTML;
 * - `readEventColor` returns only a validated `#rgb`/`#rrggbb` colour, so a
 *   stroke payload can never inject CSS.
 *
 * Nothing here stores, logs or transmits an event or its content.
 */
import {
  isAllowedColor,
  isValidEventName,
  sanitizeText,
  type JsonValue,
} from "@lanpad/sdk";

/** Default maximum characters returned by a text reader. */
export const MAX_EVENT_TEXT_CHARS = 1_000;

/** Deepest payload nesting accepted by `isSafeEventPayload`. */
export const MAX_EVENT_PAYLOAD_DEPTH = 8;

/** Colour used when a payload colour is missing or invalid. */
export const FALLBACK_EVENT_COLOR = "#ffffff";

function isSafePayloadValue(value: unknown, depth: number): boolean {
  if (depth > MAX_EVENT_PAYLOAD_DEPTH) {
    return false;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every((item: unknown) => isSafePayloadValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record).every((key) => isSafePayloadValue(record[key], depth + 1));
  }
  // undefined, function, symbol and bigint cannot travel as JSON.
  return false;
}

/** True when `name` matches the shared wire event-name pattern. */
export function isSafeEventName(name: unknown): name is string {
  return isValidEventName(name);
}

/**
 * True when `data` is JSON-shaped: primitives (finite numbers only), arrays
 * and plain objects nested at most `MAX_EVENT_PAYLOAD_DEPTH` deep. Cycles fail
 * on the depth limit rather than recursing forever.
 */
export function isSafeEventPayload(data: JsonValue): boolean {
  return isSafePayloadValue(data, 0);
}

/** The payload as a plain object, or `null` for non-object payloads. */
export function readEventRecord(data: JsonValue): Readonly<Record<string, JsonValue>> | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return null;
  }
  return data;
}

/**
 * Sanitized string field from an object payload (`""` when absent or not a
 * string). The result is inert text: render it with `textContent`, never HTML.
 */
export function readEventText(
  data: JsonValue,
  field: string,
  maxLen: number = MAX_EVENT_TEXT_CHARS,
): string {
  const record = readEventRecord(data);
  if (record === null) {
    return "";
  }
  return sanitizeText(record[field], maxLen);
}

/**
 * The D5 contract-6 `{value: string}` field as sanitized text (text and choice
 * controls). `""` for a missing or malformed payload.
 */
export function readEventValue(
  data: JsonValue,
  maxLen: number = MAX_EVENT_TEXT_CHARS,
): string {
  return readEventText(data, "value", maxLen);
}

/**
 * Validated hex colour field (stroke ink). Returns `fallback` when the field is
 * absent or not `#rgb`/`#rrggbb`; never returns arbitrary CSS.
 */
export function readEventColor(
  data: JsonValue,
  field: string,
  fallback: string = FALLBACK_EVENT_COLOR,
): string {
  const record = readEventRecord(data);
  const value = record === null ? undefined : record[field];
  if (isAllowedColor(value)) {
    return value;
  }
  return isAllowedColor(fallback) ? fallback : FALLBACK_EVENT_COLOR;
}
