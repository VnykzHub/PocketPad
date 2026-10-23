/**
 * Shared haptic patterns for common game events (FR-8.11).
 *
 * Patterns are alternating vibrate/pause durations in milliseconds, 1..8
 * steps, each a u16 (the frozen haptic frame contract). Games and the console
 * shell use these instead of inventing per-game numbers, so feedback stays
 * consistent across titles and every pattern fits one frame.
 *
 * This module is pure and holds no device state. Pass the returned array to
 * `HapticPlayer.play()` (or let a shared host helper encode it).
 */

/** Turn-ready tick, for example each second of a countdown. */
export const HAPTIC_TICK_PATTERN = [12] as const;
/** Confirmation of a menu selection or a correct choice. */
export const HAPTIC_SELECT_PATTERN = [18] as const;
/** A landed hit, bump or shot. */
export const HAPTIC_HIT_PATTERN = [30] as const;
/** Three descending countdown beats (short-short-long). */
export const HAPTIC_COUNTDOWN_PATTERN = [30, 110, 30, 110, 70] as const;
/** A goal, round win or mission success. */
export const HAPTIC_GOAL_PATTERN = [45, 45, 90] as const;
/** A miss, rejection or failed action. */
export const HAPTIC_ERROR_PATTERN = [120, 60, 120] as const;

export const HAPTIC_EVENT_NAMES = [
  "tick",
  "select",
  "hit",
  "countdown",
  "goal",
  "error",
] as const;

export type HapticEventName = (typeof HAPTIC_EVENT_NAMES)[number];

export const HAPTIC_PATTERNS: Readonly<Record<HapticEventName, readonly number[]>> =
  Object.freeze({
    tick: HAPTIC_TICK_PATTERN,
    select: HAPTIC_SELECT_PATTERN,
    hit: HAPTIC_HIT_PATTERN,
    countdown: HAPTIC_COUNTDOWN_PATTERN,
    goal: HAPTIC_GOAL_PATTERN,
    error: HAPTIC_ERROR_PATTERN,
  });

const EVENT_NAMES: ReadonlySet<string> = new Set(HAPTIC_EVENT_NAMES);

export function isHapticEventName(value: string): value is HapticEventName {
  return EVENT_NAMES.has(value);
}

/**
 * Returns a fresh copy of the pattern for `event`, or null for an unknown
 * event. A copy keeps callers from mutating the shared constant.
 */
export function hapticPatternFor(event: string): number[] | null {
  if (!isHapticEventName(event)) {
    return null;
  }
  return [...HAPTIC_PATTERNS[event]];
}
