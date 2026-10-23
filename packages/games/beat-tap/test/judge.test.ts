/**
 * Beat Tap judging and scoring (GAME-BT-HOST-03; G2, E11).
 *
 * The timing windows are frozen product values; these tests pin every
 * inclusive boundary and the combo/accuracy rules before the adapter tests use
 * them end to end.
 */
import { describe, expect, test } from "vitest";
import { BEAT_TAP_CONFIG, JUDGE_WINDOWS } from "../src/config.js";
import {
  accuracyPercent,
  applyJudgment,
  createPlayerStats,
  judgedNotes,
  judgeDelta,
  pointsFor,
} from "../src/judge.js";

describe("Beat Tap timing windows", () => {
  test("[G2] the perfect window is inclusive at ±40 ms", () => {
    for (const delta of [-40, -39.5, -1, 0, 1, 39.5, 40]) {
      expect(judgeDelta(delta, JUDGE_WINDOWS), String(delta)).toBe("perfect");
    }
    expect(judgeDelta(40.001, JUDGE_WINDOWS)).toBe("good");
    expect(judgeDelta(-40.001, JUDGE_WINDOWS)).toBe("good");
  });

  test("[G2] the good window is inclusive at ±90 ms", () => {
    for (const delta of [-90, -89.5, 41, 50, 89.5, 90]) {
      expect(judgeDelta(delta, JUDGE_WINDOWS), String(delta)).toBe("good");
    }
    expect(judgeDelta(90.001, JUDGE_WINDOWS)).toBe("miss");
    expect(judgeDelta(-90.001, JUDGE_WINDOWS)).toBe("miss");
  });

  test("[G2] the graded-miss window is inclusive at ±140 ms and then ignored", () => {
    for (const delta of [-140, -100, 91, 140]) {
      expect(judgeDelta(delta, JUDGE_WINDOWS), String(delta)).toBe("miss");
    }
    expect(judgeDelta(140.001, JUDGE_WINDOWS)).toBeNull();
    expect(judgeDelta(-140.001, JUDGE_WINDOWS)).toBeNull();
    expect(judgeDelta(Number.NaN, JUDGE_WINDOWS)).toBeNull();
  });
});

describe("Beat Tap combo and score", () => {
  test("[G2] perfect and good extend the combo; a miss breaks it without erasing the max", () => {
    const stats = createPlayerStats();
    expect(applyJudgment(stats, "perfect")).toBe(300);
    expect(applyJudgment(stats, "good")).toBe(100);
    expect(stats.combo).toBe(2);
    expect(stats.maxCombo).toBe(2);

    expect(applyJudgment(stats, "miss")).toBe(0);
    expect(stats.combo).toBe(0);
    expect(stats.maxCombo).toBe(2);
    expect(stats).toMatchObject({ perfect: 1, good: 1, miss: 1 });
    expect(judgedNotes(stats)).toBe(3);
    expect(accuracyPercent(stats)).toBe(50);
  });

  test("[G2] points are 300 / 100 / 0", () => {
    expect(pointsFor("perfect")).toBe(BEAT_TAP_CONFIG.scorePerfect);
    expect(pointsFor("good")).toBe(BEAT_TAP_CONFIG.scoreGood);
    expect(pointsFor("miss")).toBe(BEAT_TAP_CONFIG.scoreMiss);
    expect(pointsFor("miss")).toBe(0);
  });

  test("[G2] accuracy weights a good as half a perfect and never returns NaN", () => {
    const empty = createPlayerStats();
    expect(accuracyPercent(empty)).toBe(0);
    expect(judgedNotes(empty)).toBe(0);

    const stats = createPlayerStats();
    applyJudgment(stats, "good");
    expect(accuracyPercent(stats)).toBe(50);

    applyJudgment(stats, "perfect");
    applyJudgment(stats, "miss");
    expect(accuracyPercent(stats)).toBe(50);
  });
});
