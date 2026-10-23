/**
 * Scheduling helpers (spec 09 §5.7).
 *
 * Every start is stated in `AudioContext` time, never `setTimeout` (C8).
 * One-shots start 5 ms ahead so a "start in the past" click cannot happen;
 * an explicit `at` is clamped into `[now + 5 ms, now + 10 s]`.
 */

import {
  AUDIO_MAX_SCHEDULE_AHEAD_SECONDS,
  AUDIO_START_LEAD_SECONDS,
} from "./version.js";

/** Clamp an explicit or default start time into the documented window. */
export function oneShotStartTime(now: number, at?: number): number {
  const earliest = now + AUDIO_START_LEAD_SECONDS;
  if (at === undefined || !Number.isFinite(at)) return earliest;
  const latest = now + AUDIO_MAX_SCHEDULE_AHEAD_SECONDS;
  if (at < earliest) return earliest;
  if (at > latest) return latest;
  return at;
}

/** Clamp a fade length in milliseconds to `[0, maxMs]`. */
export function clampMs(
  value: number | undefined,
  defaultMs: number,
  maxMs: number,
): number {
  const resolved = value === undefined || !Number.isFinite(value) ? defaultMs : value;
  if (resolved < 0) return 0;
  if (resolved > maxMs) return maxMs;
  return resolved;
}

/** 0..1, non-finite → fallback. */
export function clamp01(value: number | undefined, fallback = 1): number {
  const resolved = value === undefined || !Number.isFinite(value) ? fallback : value;
  if (resolved < 0) return 0;
  if (resolved > 1) return 1;
  return resolved;
}

/** Integer voice count in `[1, 32]`; bad input clamps instead of throwing. */
export function clampVoiceCount(
  value: number | undefined,
  fallback: number,
): number {
  const resolved = value === undefined || !Number.isFinite(value) ? fallback : value;
  const floored = Math.floor(resolved);
  if (floored < 1) return 1;
  if (floored > 32) return 32;
  return floored;
}

export function clampByteBudget(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  const resolved = value === undefined || !Number.isFinite(value) ? fallback : value;
  const floored = Math.floor(resolved);
  if (floored < 0) return 0;
  if (floored > max) return max;
  return floored;
}
