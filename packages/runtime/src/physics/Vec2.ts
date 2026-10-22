/**
 * 2D vector (D7-RT-01; C9).
 *
 * Plain mutable data, not a class: pooled bodies and game entities are updated
 * in place to satisfy PR-9.3. The type is axis-agnostic; games that use a
 * y-down world (Coin Run, Tilt Maze) document that themselves.
 */
export interface Vec2 {
  x: number;
  y: number;
}
