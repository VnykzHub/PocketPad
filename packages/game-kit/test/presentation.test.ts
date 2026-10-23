import { describe, expect, it } from "vitest";
import { countdownLabel, createScoreboard, resultsRows } from "../src/index.js";

describe("countdown label (ER-24-01)", () => {
  it("maps remaining milliseconds to the three steps and GO", () => {
    expect(countdownLabel(3000)).toBe("3");
    expect(countdownLabel(2999)).toBe("3");
    expect(countdownLabel(2001)).toBe("3");
    expect(countdownLabel(2000)).toBe("2");
    expect(countdownLabel(1001)).toBe("2");
    expect(countdownLabel(1000)).toBe("1");
    expect(countdownLabel(1)).toBe("1");
    expect(countdownLabel(0)).toBe("GO");
    expect(countdownLabel(-10)).toBe("GO");
  });

  it("clamps long and non-finite values", () => {
    expect(countdownLabel(10_000)).toBe("3");
    expect(countdownLabel(Number.NaN)).toBe("GO");
    expect(countdownLabel(Number.POSITIVE_INFINITY)).toBe("GO");
  });
});

describe("results rows (ER-24-02)", () => {
  it("sorts by score descending then slot ascending", () => {
    const scores = new Map<number, number>([
      [2, 1],
      [1, 3],
      [3, 3],
    ]);
    expect(resultsRows(scores).map((row) => row.slot)).toEqual([1, 3, 2]);
    expect(resultsRows(scores).map((row) => row.score)).toEqual([3, 3, 1]);
  });

  it("is independent of insertion order", () => {
    const first = resultsRows(
      new Map<number, number>([
        [2, 5],
        [1, 5],
      ]),
    );
    const firstOrder = first.map((row) => row.slot);
    const second = resultsRows(
      new Map<number, number>([
        [1, 5],
        [2, 5],
      ]),
    );
    expect(second.map((row) => row.slot)).toEqual(firstOrder);
  });

  it("marks only the requested winner", () => {
    const rows = resultsRows(
      new Map<number, number>([
        [1, 2],
        [2, 2],
      ]),
      2,
    );
    expect(rows.map((row) => [row.slot, row.winner])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(resultsRows(new Map([[1, 2]]), 3)[0]?.winner).toBe(false);
    expect(resultsRows(new Map([[1, 2]]), null)[0]?.winner).toBe(false);
  });

  it("skips invalid slots and non-finite scores", () => {
    const rows = resultsRows(
      new Map<number, number>([
        [0, 5],
        [9, 5],
        [1, Number.NaN],
        [2, 3],
      ]),
    );
    expect(rows.map((row) => row.slot)).toEqual([2]);
  });

  it("pairs label, colour and shape on every row", () => {
    const rows = resultsRows(
      new Map<number, number>([
        [2, 1],
        [1, 0],
      ]),
    );
    expect(rows[0]).toMatchObject({
      slot: 2,
      label: "P2",
      color: "#ff9f45",
      shape: "triangle",
    });
    expect(rows[1]).toMatchObject({ slot: 1, label: "P1", color: "#4cb3f0" });
  });

  it("accepts scoreboard entries", () => {
    const board = createScoreboard();
    board.set(1, 4);
    board.set(3, 7);
    const first = resultsRows(board.ranked);
    expect(first.map((row) => row.slot)).toEqual([3, 1]);
    const second = resultsRows(board.ranked);
    expect(second).toBe(first);
  });

  it("reuses the array and its row objects", () => {
    const scores = new Map<number, number>([[1, 1]]);
    const first = resultsRows(scores);
    const second = resultsRows(scores);
    expect(second).toBe(first);
    expect(second[0]).toBe(first[0]);
  });
});
