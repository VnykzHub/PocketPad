/**
 * User-generated content helpers (D5-SDK-01, D5-SEC-01; SR-13).
 *
 * Pure, dependency-free and DOM-free: the host, the controller and tests run
 * the same functions. Nothing here stores, logs or transmits content.
 *
 * Rendering contract for every caller:
 * - text returned by `sanitizeText` (and every panel string) is assigned with
 *   `textContent`, never `innerHTML`/`outerHTML`;
 * - an image source is used only after `isAllowedImageSrc` accepts it and is
 *   assigned through `img.src`, never interpolated into markup.
 *
 * The allowed image sources are deliberately narrow: bundled same-origin asset
 * paths (ASCII only) or base64 PNG/JPEG/WebP data URIs under 2048 characters.
 * There is no path for SVG, HTML, `blob:` or remote images.
 */

/** Longest accepted image source, including the `data:` prefix. */
const MAX_IMAGE_SRC_CHARS = 2_048;

/** `data:image/(png|jpeg|webp);base64,` with a structurally valid payload. */
const DATA_IMAGE_SRC_PATTERN =
  /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/i;

/**
 * Characters allowed in a same-origin relative path: RFC 3986 unreserved
 * characters, sub-delims and the path/query/fragment delimiters. Quotes,
 * angle brackets, backslashes, spaces and non-ASCII are rejected so the value
 * is safe even if a future caller builds an attribute string.
 */
const RELATIVE_IMAGE_SRC_PATTERN = /^[A-Za-z0-9._~!$&()*+,;=:@%/?#-]+$/;

/** A leading `scheme:` identifies an absolute URL; only relative paths pass. */
const LEADING_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** C0 controls except tab/LF/CR, DEL, and C1 controls. */
function isForbiddenTextControl(codePoint: number): boolean {
  return (
    (codePoint >= 0x00 && codePoint <= 0x08) ||
    codePoint === 0x0b ||
    codePoint === 0x0c ||
    (codePoint >= 0x0e && codePoint <= 0x1f) ||
    (codePoint >= 0x7f && codePoint <= 0x9f)
  );
}

/** Whitespace, controls and backslashes are never valid in an allowed src. */
const UNSAFE_URL_CHAR_PATTERN = /[\u0000- \u007F-\u009F\\]/;

/** Wire event-name pattern (D5-SEC-01; SR-13). */
const EVENT_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/;

/** CSS hex colour: `#rgb` or `#rrggbb` (D5-SEC-01). */
const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Player display names are plain text, at most 24 characters (SR-13). */
export const MAX_PLAYER_NAME_CHARS = 24;

/**
 * Returns `input` as plain text with C0/C1 control characters removed (tab,
 * line feed and carriage return are kept) and truncates to at most `maxLen`
 * Unicode code points. Non-string input, or a non-positive/non-finite
 * `maxLen`, yields `""`. The function never trims, normalizes or escapes;
 * rendering must still use `textContent`.
 */
export function sanitizeText(input: unknown, maxLen: number): string {
  if (typeof input !== "string") {
    return "";
  }

  const limit = Number.isFinite(maxLen) ? Math.max(0, Math.floor(maxLen)) : 0;
  if (limit === 0) {
    return "";
  }

  // Single pass: strip controls and stop once `limit` code points are kept, so
  // a hostile oversized string cannot force a full array allocation.
  let plain = "";
  let kept = 0;
  for (const character of input) {
    if (kept >= limit) {
      break;
    }
    if (isForbiddenTextControl(character.codePointAt(0) ?? 0)) {
      continue;
    }
    plain += character;
    kept += 1;
  }
  return plain;
}

/**
 * True when `src` may be assigned to an image source: a same-origin relative
 * path, or a base64 PNG/JPEG/WebP data URI no longer than 2048 characters.
 * `http(s):`, `javascript:`, `blob:`, protocol-relative (`//`), SVG/HTML data
 * URIs and malformed base64 are rejected.
 */
export function isAllowedImageSrc(src: unknown): src is string {
  if (typeof src !== "string" || src.length === 0 || src.length > MAX_IMAGE_SRC_CHARS) {
    return false;
  }

  if (src.slice(0, 5).toLowerCase() === "data:") {
    const match = DATA_IMAGE_SRC_PATTERN.exec(src);
    if (match === null) {
      return false;
    }
    const payload = match[1] ?? "";
    return payload.length > 0 && payload.length % 4 === 0;
  }

  if (src.startsWith("//")) {
    return false;
  }
  if (UNSAFE_URL_CHAR_PATTERN.test(src)) {
    return false;
  }
  if (LEADING_SCHEME_PATTERN.test(src)) {
    return false;
  }

  return RELATIVE_IMAGE_SRC_PATTERN.test(src);
}

/**
 * True when `name` matches the wire event-name pattern
 * `^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$` (1..64 characters). Shared by the layout
 * validator and the event queue so both ends enforce the same rule.
 */
export function isValidEventName(name: unknown): boolean {
  return typeof name === "string" && EVENT_NAME_PATTERN.test(name);
}

/**
 * True when `value` is a CSS hex colour (`#rgb` or `#rrggbb`). Named colours,
 * `rgb()`, `var()`, `url()`, `expression()` and any string carrying extra CSS
 * syntax are rejected, so a validated colour is safe to assign to `style`.
 */
export function isAllowedColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR_PATTERN.test(value);
}

/**
 * Sanitizes a player display name: C0/C1 controls stripped, at most
 * `MAX_PLAYER_NAME_CHARS` (24) code points, surrounding whitespace trimmed.
 * Render the result with `textContent` only; nothing here stores it.
 */
export function sanitizePlayerName(input: unknown): string {
  return sanitizeText(input, MAX_PLAYER_NAME_CHARS).trim();
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value > 1 ? 1 : value;
}

/**
 * Clamps a stroke point into the normalized 0..1 canvas space. Non-finite
 * coordinates become 0 and `t` is clamped to a non-negative finite timestamp
 * (milliseconds). Returns a new object; the input is never mutated.
 */
export function normalizeStrokePoint(
  x: number,
  y: number,
  t: number,
): { x: number; y: number; t: number } {
  return {
    x: clampUnit(x),
    y: clampUnit(y),
    t: Number.isFinite(t) && t > 0 ? t : 0,
  };
}
