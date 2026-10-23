import { describe, expect, it } from "vitest";
import { playerColor, playerLabel, playerShape } from "../src/index.js";

/** DESIGN.md `--player-1` .. `--player-8`. */
const DESIGN_HUES = [
  "#4cb3f0",
  "#ff9f45",
  "#c58cff",
  "#4fd1a1",
  "#ff7aa8",
  "#f2d05c",
  "#8fb8ff",
  "#ff6b6b",
] as const;

describe("player identity (ER-24-03)", () => {
  it("maps every slot to the DESIGN hue", () => {
    for (let slot = 1; slot <= 8; slot += 1) {
      expect(playerColor(slot)).toBe(DESIGN_HUES[slot - 1]);
    }
  });

  it("uses unique colours and unique labels", () => {
    const colors = DESIGN_HUES;
    const labels = DESIGN_HUES.map((_, index) => playerLabel(index + 1));
    expect(new Set(colors).size).toBe(8);
    expect(new Set(labels).size).toBe(8);
  });

  it("labels slots P1 through P8", () => {
    expect(playerLabel(1)).toBe("P1");
    expect(playerLabel(8)).toBe("P8");
  });

  it("cycles shapes every four slots", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(playerShape)).toEqual([
      "circle",
      "triangle",
      "square",
      "diamond",
      "circle",
      "triangle",
      "square",
      "diamond",
    ]);
  });

  it("pairs colour with label and shape", () => {
    for (let slot = 1; slot <= 8; slot += 1) {
      expect(playerColor(slot)).toMatch(/^#[0-9a-f]{6}$/);
      expect(playerLabel(slot).length).toBeGreaterThan(0);
      expect(playerShape(slot).length).toBeGreaterThan(0);
    }
  });

  it("rejects slots outside 1..8", () => {
    expect(() => playerColor(0)).toThrow(RangeError);
    expect(() => playerColor(9)).toThrow(RangeError);
    expect(() => playerLabel(1.5)).toThrow(RangeError);
    expect(() => playerShape(Number.NaN)).toThrow(RangeError);
  });
});
