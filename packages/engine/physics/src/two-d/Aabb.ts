/**
 * Axis-aligned bounding box (D7-RT-01; C9).
 *
 * Representation: top-left origin with positive extents.
 *
 *   x = minimum x (left edge)
 *   y = minimum y (top edge in the y-down convention)
 *   w = width, so the right edge is `x + w`
 *   h = height, so the bottom edge is `y + h`
 *
 * This is the same shape as the platform level JSON (GAME-PF-02), so level
 * data can be used directly without a min/max conversion.
 */
export interface Aabb {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Walled simulation rectangle used by `integrate` (D7-RT-01).
 *
 * Bounds are inclusive walls: a circle of radius r is kept so that
 * `x - r >= minX`, `x + r <= maxX`, and likewise for y. Pass bounds beyond
 * the kill plane when a game needs bodies to fall out of the arena.
 */
export interface Arena {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}
