/**
 * Pure helpers for the Babylon renderer adapter (B1, ER-21-01).
 *
 * These mirror the frozen `Renderer3D` semantics in `render/engine3DRenderer`:
 * invalid cube colours become white, invalid sizes are dropped by the caller,
 * and the backing store is rounded per CSS pixel. Keeping them free of Babylon
 * imports lets Node tests exercise the adapter's decisions without a GPU.
 */

export type Rgb = readonly [number, number, number];

function hexDigit(code: number): number {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 70) return code - 55;
  if (code >= 97 && code <= 102) return code - 87;
  return -1;
}

/**
 * Parses `#rgb` / `#rrggbb` into normalized channels; anything else is white,
 * matching the legacy engine adapter. Cold path only: called once per colour.
 */
export function parseHexColor(color: string): Rgb {
  if (
    color.length === 7 &&
    color.charCodeAt(0) === 35 &&
    hexDigit(color.charCodeAt(1)) >= 0 &&
    hexDigit(color.charCodeAt(2)) >= 0 &&
    hexDigit(color.charCodeAt(3)) >= 0 &&
    hexDigit(color.charCodeAt(4)) >= 0 &&
    hexDigit(color.charCodeAt(5)) >= 0 &&
    hexDigit(color.charCodeAt(6)) >= 0
  ) {
    return [
      (hexDigit(color.charCodeAt(1)) * 16 + hexDigit(color.charCodeAt(2))) / 255,
      (hexDigit(color.charCodeAt(3)) * 16 + hexDigit(color.charCodeAt(4))) / 255,
      (hexDigit(color.charCodeAt(5)) * 16 + hexDigit(color.charCodeAt(6))) / 255,
    ];
  }
  if (
    color.length === 4 &&
    color.charCodeAt(0) === 35 &&
    hexDigit(color.charCodeAt(1)) >= 0 &&
    hexDigit(color.charCodeAt(2)) >= 0 &&
    hexDigit(color.charCodeAt(3)) >= 0
  ) {
    const r = hexDigit(color.charCodeAt(1));
    const g = hexDigit(color.charCodeAt(2));
    const b = hexDigit(color.charCodeAt(3));
    return [(r * 17) / 255, (g * 17) / 255, (b * 17) / 255];
  }
  return [1, 1, 1];
}

/** A positive finite CSS size, or 1 when the stage reports nothing usable. */
function positiveOrOne(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/**
 * Backing-store size for a CSS box and device-pixel ratio. The stage already
 * multiplies DPR by its dynamic resolution scale before calling `resize`.
 */
export function computeBackingSize(
  cssWidth: number,
  cssHeight: number,
  dpr: number,
): { readonly width: number; readonly height: number } {
  const safeDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return {
    width: Math.max(1, Math.round(positiveOrOne(cssWidth) * safeDpr)),
    height: Math.max(1, Math.round(positiveOrOne(cssHeight) * safeDpr)),
  };
}

/** True when a cube position can be drawn; non-finite vectors are skipped. */
export function isFinitePosition(position: {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}): boolean {
  return (
    Number.isFinite(position.x) &&
    Number.isFinite(position.y) &&
    Number.isFinite(position.z)
  );
}
