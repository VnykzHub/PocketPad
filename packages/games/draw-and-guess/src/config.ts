/**
 * Draw and Guess tuning (GAME-DG-DATA-02).
 *
 * Every number and layout id the round needs lives here. The values mirror
 * the game plan (`docs/todos/games/draw-and-guess.md`):
 *
 * - 3 rounds per match, then a winner from the accumulated score.
 * - 20 accepted, distinct guesses per round before the round ends unresolved.
 * - A drawer disconnect pauses the round for 20 s, then the round is skipped.
 * - The drawer canvas is 70% of the phone viewport (dg-drawer-v1.json).
 */
export const DG_CONFIG = {
  /** Fixed rounds in one match. */
  rounds: 3,
  /** Distinct accepted guesses per round before the round ends unresolved. */
  maxGuessesPerRound: 20,
  /** Drawer disconnect grace before the round is skipped (GAME-DG-HOST-06). */
  reconnectPauseMs: 20_000,
  /** Lead-in before each round; also the drawer-reveal window. */
  countdownMs: 3_000,
  /** How long an intermediate results screen holds before the next round. */
  resultsHoldMs: 4_000,
  /** Matches `text.maxLen` in dg-guesser-v1.json. */
  guessMaxLen: 60,
  /** Ink width clamp applied after the kit's own payload validation. */
  minInkWidth: 1,
  maxInkWidth: 24,
  /** Per-stroke point cap; mirrors `canvas.maxStrokePoints`. */
  maxPointsPerStroke: 512,
  maxStrokesPerRound: 1024,
  maxPointsPerRound: 16_384,
  maxPlayers: 8,
  /** Points for the first correct guesser and for the drawer of a solved round. */
  guesserScore: 1,
  drawerScore: 1,
} as const;

/** Layout ids registered from `game.manifest.json` by the host. */
export const DG_DRAWER_LAYOUT_ID = "dg-drawer-v1";
export const DG_GUESSER_LAYOUT_ID = "dg-guesser-v1";
export const DG_RESULTS_LAYOUT_ID = "dg-results-v1";

/** Default seed when a host offers no entropy; keeps tests reproducible. */
export const DG_DEFAULT_SEED = 1;
