/**
 * Control hit-testing for the controller touch engine (D2-CTRL-01).
 *
 * The control renderer resolves layout controls to `HitRect`s in viewport CSS
 * pixels — the same space as `Touch.clientX/clientY` — and hands them to
 * `TouchEngine.setControls` after every layout/resize. Hit-testing is pure and
 * allocation-free so `touchstart` stays inside the 2 ms scripting budget
 * (FR-8.3); the engine never reads layout during `touchmove`.
 *
 * AR-5: a control's hit area is never smaller than 44x44 CSS px. Boxes already
 * at least that size grow by the slop on every side; an undersized box is
 * expanded to the minimum first, so the slop only ever enlarges the target.
 * Rejecting undersized rendered boxes remains the renderer/validator's job
 * (`meetsTouchTargetMinimum` is the shared check).
 */

/** Slop around every control's hit area, in CSS pixels (SPEC §8.2). */
export const DEFAULT_SLOP_PX = 8;

/** Minimum touch target edge, in CSS pixels (AR-5). */
export const MIN_TOUCH_TARGET_PX = 44;

/** A control's cached rendered box, in viewport CSS pixels. */
export interface HitRect {
  /** Control id from the layout. */
  controlId: string;
  left: number;
  top: number;
  width: number;
  height: number;
  /** Draw/hit order; higher wins. Layouts default to 0. */
  z: number;
}

/**
 * True when a rendered control box meets the 44x44 CSS px minimum (AR-5).
 * The render/validation path uses this to reject layouts that would render
 * controls too small to tap reliably.
 */
export function meetsTouchTargetMinimum(rect: Pick<HitRect, "width" | "height">): boolean {
  return rect.width >= MIN_TOUCH_TARGET_PX && rect.height >= MIN_TOUCH_TARGET_PX;
}

/**
 * Returns the id of the control containing `(x, y)`, or null when no control
 * is hit.
 *
 * A point hits when it is inside the control's box expanded by `slopPx` on
 * every side. The box is first raised to at least 44x44 CSS px, centered
 * (AR-5). Overlaps resolve to the highest `z`; equal `z` resolves to the later
 * entry in `rects` (reverse DOM order, because later controls paint on top).
 */
export function hitTest(
  rects: readonly HitRect[],
  x: number,
  y: number,
  slopPx: number = DEFAULT_SLOP_PX,
): string | null {
  let hitId: string | null = null;
  let hitZ = Number.NEGATIVE_INFINITY;
  let hitIndex = -1;

  for (let index = 0; index < rects.length; index += 1) {
    const rect = rects[index];
    if (rect === undefined || !containsPoint(rect, x, y, slopPx)) {
      continue;
    }

    // `z` is optional in the layout; treat a missing/non-finite value as 0.
    const z = Number.isFinite(rect.z) ? rect.z : 0;
    if (z > hitZ || (z === hitZ && index > hitIndex)) {
      hitId = rect.controlId;
      hitZ = z;
      hitIndex = index;
    }
  }

  return hitId;
}

function containsPoint(rect: HitRect, x: number, y: number, slopPx: number): boolean {
  const halfWidth = Math.max(rect.width, MIN_TOUCH_TARGET_PX) / 2 + slopPx;
  const halfHeight = Math.max(rect.height, MIN_TOUCH_TARGET_PX) / 2 + slopPx;
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;

  return (
    x >= centerX - halfWidth &&
    x <= centerX + halfWidth &&
    y >= centerY - halfHeight &&
    y <= centerY + halfHeight
  );
}
