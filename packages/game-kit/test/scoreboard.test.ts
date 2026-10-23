import { describe, expect, it } from "vitest";
import { createScoreboard } from "../src/index.js";

describe("scoreboard [ER-24-02]", () => {
  it("starts every slot at zero", () => {
    const board = createScoreboard();
    expect(board.get(1)).toBe(0);
    expect(board.get(8)).toBe(0);
    expect(board.ranked).toHaveLength(0);
  });

  it("sets, adds and reads scores", () => {
    const board = createScoreboard();
    board.set(2, 10);
    board.add(2, 5);
    expect(board.get(2)).toBe(15);
    board.add(2, -20);
    expect(board.get(2)).toBe(0);
    board.set(2, -3);
    expect(board.get(2)).toBe(0);
  });

  it("ranks by score descending then slot ascending", () => {
    const board = createScoreboard();
    board.set(3, 4);
    board.set(1, 7);
    board.set(2, 7);
    board.set(8, 1);
    expect(board.ranked.map((entry) => entry.slot)).toEqual([1, 2, 3, 8]);
    expect(board.ranked.map((entry) => entry.score)).toEqual([7, 7, 4, 1]);
  });

  it("is independent of insertion order", () => {
    const first = createScoreboard();
    first.set(2, 5);
    first.set(1, 5);
    const second = createScoreboard();
    second.set(1, 5);
    second.set(2, 5);
    expect(first.ranked).toEqual(second.ranked);
  });

  it("reuses the ranked array", () => {
    const board = createScoreboard();
    board.set(1, 1);
    const ranked = board.ranked;
    board.set(2, 2);
    expect(board.ranked).toBe(ranked);
    expect(board.ranked.map((entry) => entry.slot)).toEqual([2, 1]);
  });

  it("rejects invalid slots and non-finite scores", () => {
    const board = createScoreboard();
    expect(() => board.set(0, 1)).toThrow(RangeError);
    expect(() => board.set(9, 1)).toThrow(RangeError);
    expect(() => board.get(1.5)).toThrow(RangeError);
    expect(() => board.add(1, Number.NaN)).toThrow(RangeError);
    expect(() => board.set(1, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("resets to empty", () => {
    const board = createScoreboard();
    board.set(1, 3);
    board.reset();
    expect(board.ranked).toHaveLength(0);
    expect(board.get(1)).toBe(0);
  });
});
