/**
 * Snake Royale frozen configuration (GAME-SR-DATA-01).
 *
 * These numbers are the play contract from `docs/todos/games/snake-royale.md`:
 * a 32x32 grid stepped at 8 Hz, four-cell snakes, three food cells and a
 * shrink every 15 s. The render layer interpolates between the 125 ms steps
 * (GAME-SR-HOST-04; FR-9.1).
 */

export const SNAKE_ROYALE_CONFIG = {
  gridSize: 32,
  stepHz: 8,
  initialLength: 4,
  shrinkEveryMs: 15000,
  foodCount: 3,
  respawnGraceMs: 5000,
  countdownMs: 3000,
  maxPlayers: 8,
} as const;

/** Milliseconds of simulated time between two logic steps. */
export const STEP_INTERVAL_MS = 1000 / SNAKE_ROYALE_CONFIG.stepHz;

/** Host fixed-step length; `Game.render` receives the fraction of this tick. */
export const HOST_TICK_MS = 1000 / 60;

/** Direction order is clockwise from up; `(direction + 2) & 3` is the reverse. */
export const DIRECTION_UP = 0;
export const DIRECTION_RIGHT = 1;
export const DIRECTION_DOWN = 2;
export const DIRECTION_LEFT = 3;

export type Direction = 0 | 1 | 2 | 3;
export type Turn = Direction | -1;

export const DIRECTION_DX: readonly number[] = [0, 1, 0, -1];
export const DIRECTION_DY: readonly number[] = [-1, 0, 1, 0];

/** Layout `snake-dpad-v1` binds these bits (GAME-SR-CTRL-01). */
export const SNAKE_DPAD_BITS = {
  up: 8,
  down: 9,
  left: 10,
  right: 11,
} as const;

export const SNAKE_DPAD_LAYOUT_ID = "snake-dpad-v1";

/** Every press edge asks for a rematch during results. */
export const ACTION_EDGE_MASK = 0xffff;

export function oppositeDirection(direction: Direction): Direction {
  return ((direction + 2) & 3) as Direction;
}

export function isDirection(value: number): value is Direction {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

/**
 * Maps this tick's press edges to one direction, or null when the d-pad saw
 * no press. Priority is fixed (up, right, down, left) so two simultaneous
 * taps on different sectors resolve deterministically. Levels are ignored:
 * direction changes are edge-triggered (GAME-SR-CTRL-02).
 */
export function readEdgeDirection(edges: number): Direction | null {
  if ((edges & (1 << SNAKE_DPAD_BITS.up)) !== 0) return DIRECTION_UP;
  if ((edges & (1 << SNAKE_DPAD_BITS.right)) !== 0) return DIRECTION_RIGHT;
  if ((edges & (1 << SNAKE_DPAD_BITS.down)) !== 0) return DIRECTION_DOWN;
  if ((edges & (1 << SNAKE_DPAD_BITS.left)) !== 0) return DIRECTION_LEFT;
  return null;
}
