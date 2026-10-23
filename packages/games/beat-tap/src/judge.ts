/**
 * Beat Tap judging and scoring (GAME-BT-HOST-03; E11).
 *
 * Pure, allocation-free per press. The delta passed here is already corrected
 * for the host's calibration offset and the controller's transit time, so this
 * module only classifies and applies the result.
 *
 * Combo rules: perfect and good extend the combo; a miss resets it. Accuracy is
 * weighted so a good is half a perfect:
 *   (perfect + 0.5 * good) / (perfect + good + miss) * 100
 */
import { BEAT_TAP_CONFIG, type JudgeWindows } from "./config.js";

export type Judgment = "perfect" | "good" | "miss";

/** Press grades as protocol-free constants; also used for debug counters. */
export const JUDGMENT_PERFECT = "perfect" as const;
export const JUDGMENT_GOOD = "good" as const;
export const JUDGMENT_MISS = "miss" as const;

/** Mutable per-player results for one song. */
export interface PlayerStats {
  perfect: number;
  good: number;
  miss: number;
  maxCombo: number;
  /** Current combo, reset by a miss. */
  combo: number;
}

/** Fresh zeroed counters; combos are per song (never per match). */
export function createPlayerStats(): PlayerStats {
  return { perfect: 0, good: 0, miss: 0, maxCombo: 0, combo: 0 };
}

/** Zeroes counters in place so a round can reuse its arrays. */
export function resetPlayerStats(stats: PlayerStats): void {
  stats.perfect = 0;
  stats.good = 0;
  stats.miss = 0;
  stats.maxCombo = 0;
  stats.combo = 0;
}

/**
 * Classifies a timing delta in milliseconds. Returns null when the press is
 * outside every window, meaning it must not consume or break a note. The
 * boundaries are inclusive, so exactly ±40 is perfect and exactly ±90 is good.
 */
export function judgeDelta(deltaMs: number, windows: JudgeWindows): Judgment | null {
  if (!Number.isFinite(deltaMs)) {
    return null;
  }
  const magnitude = Math.abs(deltaMs);
  if (magnitude <= windows.perfectMs) {
    return JUDGMENT_PERFECT;
  }
  if (magnitude <= windows.goodMs) {
    return JUDGMENT_GOOD;
  }
  if (magnitude <= windows.missMs) {
    return JUDGMENT_MISS;
  }
  return null;
}

/** Points a grade awards. */
export function pointsFor(judgment: Judgment): number {
  switch (judgment) {
    case "perfect":
      return BEAT_TAP_CONFIG.scorePerfect;
    case "good":
      return BEAT_TAP_CONFIG.scoreGood;
    case "miss":
    default:
      return BEAT_TAP_CONFIG.scoreMiss;
  }
}

/**
 * Applies one grade to a player's counters and returns the points earned. The
 * caller adds the points to the game-kit scoreboard; this module never knows
 * about slots.
 */
export function applyJudgment(stats: PlayerStats, judgment: Judgment): number {
  switch (judgment) {
    case "perfect":
      stats.perfect += 1;
      stats.combo += 1;
      break;
    case "good":
      stats.good += 1;
      stats.combo += 1;
      break;
    case "miss":
    default:
      stats.miss += 1;
      stats.combo = 0;
      break;
  }
  if (stats.combo > stats.maxCombo) {
    stats.maxCombo = stats.combo;
  }
  return pointsFor(judgment);
}

/** Judged notes for one player. */
export function judgedNotes(stats: PlayerStats): number {
  return stats.perfect + stats.good + stats.miss;
}

/**
 * Accuracy percentage, 0..100. An unplayed player (no judged notes) scores 0,
 * never NaN.
 */
export function accuracyPercent(stats: PlayerStats): number {
  const total = judgedNotes(stats);
  if (total === 0) {
    return 0;
  }
  return ((stats.perfect + stats.good * 0.5) / total) * 100;
}
