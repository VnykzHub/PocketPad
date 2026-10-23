/**
 * Bomb Defusal tuning (GAME-BD-DATA-01).
 *
 * Every number the round needs lives here. Rule tables and the seeded
 * generator are in `bomb.ts`; nothing in this file is random.
 */
export const BOMB_CONFIG = {
  /** Five minutes for three modules (plan risk note: playtest tuning). */
  timerMs: 300_000,
  strikesAllowed: 3,
  moduleCount: 3,
  moduleTypes: ["wires", "button", "keypad"] as const,
  /** The panel contract's own ceiling; the shipped manual uses four pages. */
  manualPagesMax: 8,
  countdownMs: 3_000,
  /** Defuser disconnect grace before the round is lost (GAME-BD-HOST-06). */
  defuserGraceMs: 20_000,
  maxPlayers: 8,
  /** Held-button release tolerance around the manual's target duration. */
  buttonHoldToleranceMs: 300,
  /** A blue button is a tap; anything under this counts as a tap. */
  tapMaxMs: 500,
  /** Held-button bit on the defuser layout (`big-button`). */
  buttonBit: 1,
  /** Manual paging bits on the reader layout. */
  prevBit: 0,
  nextBit: 1,
  /** Results ignore button edges for this long so a held button cannot skip. */
  resultsLockoutMs: 1_000,
  /** The wire list always includes the even and odd parity colours. */
  wiresMin: 4,
  wiresMax: 6,
} as const;

export type BombModuleType = (typeof BOMB_CONFIG.moduleTypes)[number];

/** Why a round ended; drives the TV result copy. */
export type RoundCause = "defused" | "strikes" | "timeout" | "defuser-lost";
