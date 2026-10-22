/**
 * DOM rendering helpers for untrusted content (D5-SEC-01; SR-13, SR-7, FR-7.9).
 *
 * Every controller path that displays host/game/player content goes through
 * these helpers:
 * - text is stripped of C0/C1 controls, truncated and assigned to
 *   `textContent` — there is no HTML-string path anywhere in the controller;
 * - an image is created only after `isAllowedImageSrc` accepts the source, and
 *   the source is assigned through `img.src`, never interpolated into markup;
 * - a colour reaches `style` only after `isAllowedColor` accepts `#rgb` or
 *   `#rrggbb`, so a CSS-injection string can never become a style value.
 *
 * The helpers write only into the DOM nodes passed to them. They never store,
 * log or transmit content (SR-7, SR-13).
 */
import { isAllowedColor, isAllowedImageSrc, sanitizeText } from "@lanpad/sdk";

/** Longest text a renderer will display from one untrusted field. */
export const MAX_RENDER_TEXT_CHARS = 1_000;

/** Longest image alt text; matches the SDK panel contract. */
export const MAX_ALT_TEXT_CHARS = 120;

/** Last-resort colour when both the requested and fallback colours are invalid. */
export const FALLBACK_COLOR = "#ffffff";

/** Properties `applySafeColor` may set; all are plain colour values. */
export type SafeColorProperty = "color" | "backgroundColor" | "borderColor";

/**
 * Sanitizes `value` and assigns it as `element.textContent`. Returns the text
 * that was rendered. Hostile markup is inert text, never markup.
 */
export function setSafeText(
  element: HTMLElement,
  value: unknown,
  maxLen: number = MAX_RENDER_TEXT_CHARS,
): string {
  const text = sanitizeText(value, maxLen);
  element.textContent = text;
  return text;
}

/**
 * Validates `src` and, when allowed, appends an `<img>` to `parent`. Rejected
 * sources append nothing and return `null`. `alt` is sanitized; `fit` is
 * restricted to the SDK's two enum values, so it cannot carry CSS.
 */
export function appendSafeImage(
  parent: HTMLElement,
  src: unknown,
  alt?: unknown,
  fit?: unknown,
): HTMLImageElement | null {
  if (!isAllowedImageSrc(src)) {
    return null;
  }

  const image = document.createElement("img");
  // `src` is a validated same-origin path or base64 PNG/JPEG/WebP data URI.
  image.src = src;
  image.alt = sanitizeText(alt, MAX_ALT_TEXT_CHARS);
  image.draggable = false;
  image.style.display = "block";
  image.style.maxWidth = "100%";
  if (fit === "contain" || fit === "cover") {
    image.style.width = "100%";
    image.style.height = "100%";
    image.style.objectFit = fit;
  }
  parent.append(image);
  return image;
}

/**
 * Returns `value` when it is a valid hex colour, else `fallback` when that is
 * valid, else `FALLBACK_COLOR`. Every returned string is safe for `style`.
 */
export function safeColor(value: unknown, fallback: string = FALLBACK_COLOR): string {
  if (isAllowedColor(value)) {
    return value;
  }
  return isAllowedColor(fallback) ? fallback : FALLBACK_COLOR;
}

/** Assigns a validated colour to one style property and returns it. */
export function applySafeColor(
  element: HTMLElement,
  property: SafeColorProperty,
  value: unknown,
  fallback: string = FALLBACK_COLOR,
): string {
  const color = safeColor(value, fallback);
  element.style[property] = color;
  return color;
}
