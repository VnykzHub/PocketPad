import { describe, expect, it } from "vitest";
import {
  DEFAULT_SLOP_PX,
  MIN_TOUCH_TARGET_PX,
  hitTest,
  meetsTouchTargetMinimum,
  type HitRect,
} from "../src/touch/hitTest.js";

function rect(
  controlId: string,
  left: number,
  top: number,
  width = 60,
  height = 60,
  z = 0,
): HitRect {
  return { controlId, left, top, width, height, z };
}

describe("[AR-5] hit areas are at least 44x44 CSS pixels", () => {
  it("[AR-5] exposes the 44 px minimum and the 8 px default slop", () => {
    expect(MIN_TOUCH_TARGET_PX).toBe(44);
    expect(DEFAULT_SLOP_PX).toBe(8);
  });

  it("[AR-5] expands an undersized rendered box to a centered 44x44 hit area", () => {
    const tiny = rect("tiny", 100, 100, 20, 20);
    // Center is (110, 110); the minimum gives a half-extent of 22 px.
    expect(hitTest([tiny], 110, 110, 0)).toBe("tiny");
    expect(hitTest([tiny], 132, 110, 0)).toBe("tiny");
    expect(hitTest([tiny], 133, 110, 0)).toBeNull();
    expect(hitTest([tiny], 110, 132, 0)).toBe("tiny");
    expect(hitTest([tiny], 110, 133, 0)).toBeNull();
  });

  it("[AR-5] meetsTouchTargetMinimum rejects rendered boxes below 44x44", () => {
    expect(meetsTouchTargetMinimum({ width: 44, height: 44 })).toBe(true);
    expect(meetsTouchTargetMinimum({ width: 43, height: 44 })).toBe(false);
    expect(meetsTouchTargetMinimum({ width: 44, height: 43 })).toBe(false);
  });

  it("[AR-5] a 44x44 control is hittable across its full minimum area", () => {
    const target = rect("jump", 0, 0, 44, 44);
    expect(hitTest([target], 0, 0, 0)).toBe("jump");
    expect(hitTest([target], 44, 44, 0)).toBe("jump");
  });
});

describe("[FR-8.6] hit-testing uses an 8 px slop around cached rects", () => {
  it("[FR-8.6] a touch 8 px outside a control hits and 9 px does not", () => {
    const target = rect("jump", 0, 0, 60, 60);
    expect(hitTest([target], -8, 30)).toBe("jump");
    expect(hitTest([target], -9, 30)).toBeNull();
    expect(hitTest([target], 68, 30)).toBe("jump");
    expect(hitTest([target], 69, 30)).toBeNull();
    expect(hitTest([target], 30, -8)).toBe("jump");
    expect(hitTest([target], 30, 68)).toBe("jump");
    expect(hitTest([target], 30, 69)).toBeNull();
  });

  it("[FR-8.6] accepts an explicit slop override", () => {
    const target = rect("jump", 0, 0, 60, 60);
    expect(hitTest([target], -12, 30, 12)).toBe("jump");
    expect(hitTest([target], -13, 30, 12)).toBeNull();
  });
});

describe("[FR-8.6] overlap resolution", () => {
  it("[FR-8.6] the highest z wins regardless of array order", () => {
    const front = rect("front", 0, 0, 100, 100, 2);
    const back = rect("back", 0, 0, 100, 100, 1);
    expect(hitTest([front, back], 50, 50)).toBe("front");
    expect(hitTest([back, front], 50, 50)).toBe("front");
  });

  it("[FR-8.6] equal z falls back to reverse DOM order", () => {
    const first = rect("first", 0, 0, 100, 100, 0);
    const second = rect("second", 0, 0, 100, 100, 0);
    expect(hitTest([first, second], 50, 50)).toBe("second");
    expect(hitTest([second, first], 50, 50)).toBe("first");
  });

  it("[FR-8.6] a higher-z control only wins where it actually covers the point", () => {
    const near = rect("near", 0, 0, 60, 60, 5);
    const far = rect("far", 1000, 1000, 60, 60, 0);
    expect(hitTest([near, far], 30, 30)).toBe("near");
    expect(hitTest([near, far], 1030, 1030)).toBe("far");
  });

  it("[FR-8.6] returns null when no control contains the point", () => {
    expect(hitTest([], 10, 10)).toBeNull();
    expect(hitTest([rect("jump", 0, 0)], 500, 500)).toBeNull();
  });
});
