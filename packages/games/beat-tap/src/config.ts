/**
 * Beat Tap configuration (GAME-BT-DATA-02; E11).
 *
 * All game tuning lives here as data, never as literals in the loop. The
 * timing windows are the plan's frozen values: a press within ±40 ms is
 * perfect, within ±90 ms is good, and within ±140 ms is a graded miss (the
 * note is consumed and the combo breaks). Presses outside the miss window do
 * not touch a note.
 *
 * Lane ownership is derived from the roster size, not from slot numbers, so a
 * two-player couch always splits lanes 0-1 / 2-3 and a four-player match gives
 * one lane per player. The plan's Minimal tier names two players with two
 * lanes each; this module generalises the same rule to the 1-4 player range the
 * Wave 1b brief asks for.
 *
 * Three players use partition 0-1 / 2 / 3. The `duo` document gives the first
 * rank two buttons; the two solo ranks use only its first button, so the second
 * button is inert for them. That is deliberately simpler than assigning a
 * different layout document per rank, and it keeps every lane playable.
 */

/** Lanes in every chart (GAME-BT-DATA-02). */
export const LANE_COUNT = 4;

/** Maximum players the game accepts; slots above this watch (Minimal tier). */
export const MAX_PLAYERS = 4;

/** Shipped layout document ids. */
export const LANES_LAYOUT_ID = "bt-lanes-v1";
export const DUO_LAYOUT_ID = "bt-duo-v1";
export const SOLO_LAYOUT_ID = "bt-solo-v1";
export const DPAD_LAYOUT_ID = "bt-dpad-v1";
export const CALIBRATE_LAYOUT_ID = "bt-calibrate-v1";

/** The calibrate button's protocol bit in every lane layout. */
export const CALIBRATE_BIT = 15;

/** D-pad lane order: up, down, left, right map to lane slots 0..3. */
export const DPAD_LANE_BITS: readonly number[] = [8, 9, 10, 11];

/** Per-host calibration key; no account and no server storage (GAME-BT-HOST-04). */
export const CALIBRATION_STORAGE_KEY = "pocketpad.beat-tap.calibration.v1";

/** True when a value is a finite number. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Timing and scoring constants (GAME-BT-DATA-02, GAME-BT-HOST-03). */
export const BEAT_TAP_CONFIG = {
  perfectMs: 40,
  goodMs: 90,
  missMs: 140,
  /** Default stored offset when the host has never calibrated. */
  calibrationOffsetMs: 0,
  /** Countdown before a song, in milliseconds. */
  countdownMs: 3000,
  /** How long a note takes to travel from the top to the hit line. */
  approachMs: 1600,
  /** Points per grade; a graded miss scores nothing. */
  scorePerfect: 300,
  scoreGood: 100,
  scoreMiss: 0,
  /** Tap-to-beat metronome: 120 BPM, one second of lead-in. */
  calibrationBeatMs: 500,
  calibrationWarmupMs: 1000,
  calibrationTaps: 8,
  /** Offsets beyond half a beat are device problems, not calibration. */
  calibrationMaxOffsetMs: 200,
  /** How long a calibration result stays on the host HUD. */
  calibrationMessageMs: 3000,
  /** A judged grade stays on screen this long. */
  judgmentMessageMs: 400,
  /** Bound on the server-clock transit correction applied to a press. */
  maxTransitMs: 250,
} as const;

/** The window object the pure judge consumes. */
export interface JudgeWindows {
  readonly perfectMs: number;
  readonly goodMs: number;
  readonly missMs: number;
}

/** Frozen judging windows, shared by the judge and the song runtime. */
export const JUDGE_WINDOWS: JudgeWindows = {
  perfectMs: BEAT_TAP_CONFIG.perfectMs,
  goodMs: BEAT_TAP_CONFIG.goodMs,
  missMs: BEAT_TAP_CONFIG.missMs,
};

/** Lane layout families. `dpad` is a four-direction alternative to buttons. */
export type LaneLayoutKind = "lanes" | "duo" | "solo" | "dpad";

/** The single-player layout family a host may select (buttons by default). */
export type SinglePlayerLayout = "lanes" | "dpad";

const PARTITION_1: readonly (readonly number[])[] = [[0, 1, 2, 3]];
const PARTITION_2: readonly (readonly number[])[] = [
  [0, 1],
  [2, 3],
];
const PARTITION_3: readonly (readonly number[])[] = [[0, 1], [2], [3]];
const PARTITION_4: readonly (readonly number[])[] = [[0], [1], [2], [3]];

/**
 * Returns the lane partition for a roster size, 1..4. The arrays are
 * constants, so callers may hold them across ticks without allocating.
 */
export function lanePartition(playerCount: number): readonly (readonly number[])[] {
  switch (playerCount) {
    case 1:
      return PARTITION_1;
    case 2:
      return PARTITION_2;
    case 3:
      return PARTITION_3;
    case 4:
    default:
      return PARTITION_4;
  }
}

/** The layout document that gives one player the lanes of `kind`. */
export function layoutIdForKind(kind: LaneLayoutKind): string {
  switch (kind) {
    case "duo":
      return DUO_LAYOUT_ID;
    case "solo":
      return SOLO_LAYOUT_ID;
    case "dpad":
      return DPAD_LAYOUT_ID;
    case "lanes":
    default:
      return LANES_LAYOUT_ID;
  }
}

/** The layout family used for a playable roster of `playerCount` players. */
export function laneKindForCount(
  playerCount: number,
  singlePlayerLayout: SinglePlayerLayout,
): LaneLayoutKind {
  if (playerCount <= 1) {
    return singlePlayerLayout === "dpad" ? "dpad" : "lanes";
  }
  // Two- and three-player rosters both need a two-lane button document for the
  // player who owns lanes 0-1 (see the partition note above).
  return playerCount <= 3 ? "duo" : "solo";
}

/** Layout id for a playable roster size. */
export function layoutIdForCount(
  playerCount: number,
  singlePlayerLayout: SinglePlayerLayout,
): string {
  return layoutIdForKind(laneKindForCount(playerCount, singlePlayerLayout));
}

/** Maps a shipped layout id back to its family; null for unknown documents. */
export function layoutKindForId(layoutId: string): LaneLayoutKind | null {
  switch (layoutId) {
    case LANES_LAYOUT_ID:
      return "lanes";
    case DUO_LAYOUT_ID:
      return "duo";
    case SOLO_LAYOUT_ID:
      return "solo";
    case DPAD_LAYOUT_ID:
      return "dpad";
    default:
      return null;
  }
}

/** Number of lanes a layout family exposes on one controller. */
export function laneSlotsForKind(kind: LaneLayoutKind): number {
  switch (kind) {
    case "duo":
      return 2;
    case "solo":
      return 1;
    case "dpad":
    case "lanes":
    default:
      return 4;
  }
}

/**
 * Protocol bit for lane slot `index` (0-based) in a layout family, or -1 when
 * the family has no such lane. Button families bind bit 0..n-1; the d-pad
 * binds up/down/left/right.
 */
export function laneBitForIndex(kind: LaneLayoutKind, index: number): number {
  if (!Number.isInteger(index) || index < 0) {
    return -1;
  }
  if (kind === "dpad") {
    return DPAD_LANE_BITS[index] ?? -1;
  }
  return index < laneSlotsForKind(kind) ? index : -1;
}
