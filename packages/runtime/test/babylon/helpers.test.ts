// @req ER-21-01 — the Babylon adapter's pure helpers mirror Renderer3D semantics.
import { describe, expect, test } from "vitest";
import {
  computeBackingSize,
  isFinitePosition,
  parseHexColor,
} from "../../src/babylon/helpers.js";

describe("Babylon adapter helpers", () => {
  test("[ER-21-01] parses #rrggbb into normalized channels", () => {
    const [r, g, b] = parseHexColor("#6ee7ff");
    expect(r).toBeCloseTo(110 / 255, 10);
    expect(g).toBeCloseTo(231 / 255, 10);
    expect(b).toBeCloseTo(255 / 255, 10);
  });

  test("[ER-21-01] parses #rgb by repeating each digit", () => {
    expect(parseHexColor("#f80")).toEqual([255 / 255, 136 / 255, 0]);
  });

  test("[ER-21-01] invalid colours become white", () => {
    for (const invalid of ["red", "#gggggg", "#12345", "", "0xffffff"]) {
      expect(parseHexColor(invalid)).toEqual([1, 1, 1]);
    }
  });

  test("[ER-21-01] rounds the backing store per CSS pixel and DPR", () => {
    expect(computeBackingSize(100.4, 50.6, 2)).toEqual({
      width: 201,
      height: 101,
    });
    expect(computeBackingSize(1280, 720, 1)).toEqual({
      width: 1280,
      height: 720,
    });
  });

  test("[ER-21-01] unusable sizes fall back to one pixel", () => {
    expect(computeBackingSize(0, Number.NaN, 0)).toEqual({
      width: 1,
      height: 1,
    });
    expect(computeBackingSize(-10, Number.POSITIVE_INFINITY, -2)).toEqual({
      width: 1,
      height: 1,
    });
  });

  test("[ER-21-01] non-finite cube positions are rejected", () => {
    expect(isFinitePosition({ x: 0, y: 1, z: -2 })).toBe(true);
    expect(isFinitePosition({ x: Number.NaN, y: 1, z: 0 })).toBe(false);
    expect(
      isFinitePosition({ x: 0, y: Number.POSITIVE_INFINITY, z: 0 }),
    ).toBe(false);
  });
});
