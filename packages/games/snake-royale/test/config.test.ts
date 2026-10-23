import { describe, expect, test } from "vitest";
import {
  DIRECTION_DOWN,
  DIRECTION_LEFT,
  DIRECTION_RIGHT,
  DIRECTION_UP,
  SNAKE_DPAD_BITS,
  isDirection,
  oppositeDirection,
  readEdgeDirection,
} from "../src/config.js";

/**
 * D-pad edge mapping (GAME-SR-CTRL-02; FR-8.1).
 *
 * Layout bits 8..11 arrive as `GameControllerState.edges`, which carry press
 * edges only. The mapping and its fixed priority are pure functions so the
 * adapter never interprets bits itself.
 */

const UP = 1 << SNAKE_DPAD_BITS.up;
const DOWN = 1 << SNAKE_DPAD_BITS.down;
const LEFT = 1 << SNAKE_DPAD_BITS.left;
const RIGHT = 1 << SNAKE_DPAD_BITS.right;

describe("Snake Royale d-pad edges", () => {
  test("[GAME-SR-CTRL-02][FR-8.1] each layout bit maps to its direction", () => {
    expect(SNAKE_DPAD_BITS).toEqual({ up: 8, down: 9, left: 10, right: 11 });
    expect(readEdgeDirection(UP)).toBe(DIRECTION_UP);
    expect(readEdgeDirection(RIGHT)).toBe(DIRECTION_RIGHT);
    expect(readEdgeDirection(DOWN)).toBe(DIRECTION_DOWN);
    expect(readEdgeDirection(LEFT)).toBe(DIRECTION_LEFT);
  });

  test("[GAME-SR-CTRL-02] a held level without an edge press is not a turn", () => {
    expect(readEdgeDirection(0)).toBeNull();
    expect(readEdgeDirection(0xffff & ~(UP | DOWN | LEFT | RIGHT))).toBeNull();
  });

  test("[GAME-SR-CTRL-02] simultaneous edges resolve up, right, down, left", () => {
    expect(readEdgeDirection(UP | DOWN)).toBe(DIRECTION_UP);
    expect(readEdgeDirection(RIGHT | DOWN)).toBe(DIRECTION_RIGHT);
    expect(readEdgeDirection(LEFT | DOWN)).toBe(DIRECTION_DOWN);
    expect(readEdgeDirection(LEFT | UP | RIGHT | DOWN)).toBe(DIRECTION_UP);
  });

  test("[GAME-SR-CTRL-02] the reversal is two steps around the ring", () => {
    expect(oppositeDirection(DIRECTION_UP)).toBe(DIRECTION_DOWN);
    expect(oppositeDirection(DIRECTION_RIGHT)).toBe(DIRECTION_LEFT);
    expect(oppositeDirection(DIRECTION_DOWN)).toBe(DIRECTION_UP);
    expect(oppositeDirection(DIRECTION_LEFT)).toBe(DIRECTION_RIGHT);
    expect(isDirection(0)).toBe(true);
    expect(isDirection(3)).toBe(true);
    expect(isDirection(4)).toBe(false);
    expect(isDirection(-1)).toBe(false);
  });
});
