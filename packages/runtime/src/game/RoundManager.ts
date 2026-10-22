/**
 * Optional round shell (D7-SDK-01).
 *
 * `RoundManager` is a convenience for games with the common
 * lobby -> countdown -> playing -> results -> next-round flow. The platform
 * does not impose scoring or phases: games that resolve rounds themselves can
 * ignore this class entirely.
 *
 * It owns no clock and no timers. Callers pass `nowMs` (the host's synced
 * server time or any monotonic milliseconds) to `beginRound`/`nextRound`, so
 * tests use a fake clock and the host can pause without the countdown
 * drifting.
 *
 * Player-count gating: `startWhenReady` accepts only 1..8 unique slots and
 * only when the count is inside `[minPlayers, maxPlayers]`. Below minimum
 * returns false and leaves the manager in the lobby, so the host can poll it
 * every tick.
 */

/** Coarse match phase (D7-SDK-01 frozen union). */
export type RoundPhase = "lobby" | "countdown" | "playing" | "results";

/** One decided round. `winnerSlot: null` is a draw/replay and scores nothing. */
export interface RoundResult {
  /** Winning slot in the roster, or null for a draw/replay. */
  readonly winnerSlot: number | null;
}

export interface RoundManagerOptions {
  readonly minPlayers: number;
  readonly maxPlayers: number;
  /** Countdown length used by `nextRound`; defaults to 3000 ms. */
  readonly countdownMs?: number;
  /** Decisive rounds needed to win; defaults to 3 (best of 5). */
  readonly roundsToWin?: number;
}

const MIN_SLOTS = 1;
const MAX_SLOTS = 8;
const DEFAULT_COUNTDOWN_MS = 3000;
const DEFAULT_ROUNDS_TO_WIN = 3;

/** Thrown when a method is called in a phase that cannot accept it. */
export class RoundTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoundTransitionError";
  }
}

function requireIntegerInRange(
  name: string,
  value: number,
  min: number,
  max: number,
): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer in ${min}..${max}.`);
  }
}

function requireFiniteTime(name: string, nowMs: number): void {
  if (!Number.isFinite(nowMs)) {
    throw new RangeError(`${name} must be a finite number of milliseconds.`);
  }
}

export class RoundManager {
  readonly minPlayers: number;
  readonly maxPlayers: number;
  readonly countdownMs: number;
  readonly roundsToWin: number;

  private phaseValue: RoundPhase = "lobby";
  private roster: number[] = [];
  private readonly scores = new Map<number, number>();
  private winnerSlotValue: number | null = null;
  private roundNumberValue = 0;
  private roundStartedAtValue: number | null = null;
  private countdownEndsAtValue: number | null = null;

  constructor(options: RoundManagerOptions) {
    requireIntegerInRange("minPlayers", options.minPlayers, MIN_SLOTS, MAX_SLOTS);
    requireIntegerInRange("maxPlayers", options.maxPlayers, MIN_SLOTS, MAX_SLOTS);
    if (options.minPlayers > options.maxPlayers) {
      throw new RangeError("minPlayers must not exceed maxPlayers.");
    }
    const countdownMs = options.countdownMs ?? DEFAULT_COUNTDOWN_MS;
    if (!Number.isInteger(countdownMs) || countdownMs < 0) {
      throw new RangeError("countdownMs must be a non-negative integer.");
    }
    const roundsToWin = options.roundsToWin ?? DEFAULT_ROUNDS_TO_WIN;
    if (!Number.isInteger(roundsToWin) || roundsToWin < 1) {
      throw new RangeError("roundsToWin must be an integer >= 1.");
    }
    this.minPlayers = options.minPlayers;
    this.maxPlayers = options.maxPlayers;
    this.countdownMs = countdownMs;
    this.roundsToWin = roundsToWin;
  }

  get phase(): RoundPhase {
    return this.phaseValue;
  }

  /** Round being played or about to be played; 0 before the first beginRound. */
  get roundNumber(): number {
    return this.roundNumberValue;
  }

  /** Slots frozen for this match, ascending. */
  get slots(): ReadonlyArray<number> {
    return this.roster;
  }

  /** Slot that reached `roundsToWin`, or null while the match is live. */
  get matchWinnerSlot(): number | null {
    return this.winnerSlotValue;
  }

  /** `nowMs` passed to `beginRound`, or null between rounds. */
  get roundStartedAt(): number | null {
    return this.roundStartedAtValue;
  }

  /** End of the countdown set by `nextRound`, or null before it is called. */
  get countdownEndsAt(): number | null {
    return this.countdownEndsAtValue;
  }

  /** One slot's wins, 0 for a slot outside the roster. */
  getScore(slot: number): number {
    return this.scores.get(slot) ?? 0;
  }

  /**
   * Starts a match when the connected slots satisfy the player-count gate.
   * Returns false (and stays in the lobby) below `minPlayers`, above
   * `maxPlayers`, or for an invalid/duplicate slot list.
   */
  startWhenReady(connectedSlots: ReadonlyArray<number>): boolean {
    if (this.phaseValue !== "lobby") {
      return false;
    }
    const roster = normalizeSlots(connectedSlots);
    if (roster === null) {
      return false;
    }
    if (roster.length < this.minPlayers || roster.length > this.maxPlayers) {
      return false;
    }
    this.roster = roster;
    this.scores.clear();
    for (const slot of roster) {
      this.scores.set(slot, 0);
    }
    this.winnerSlotValue = null;
    this.roundNumberValue = 0;
    this.roundStartedAtValue = null;
    this.countdownEndsAtValue = null;
    this.phaseValue = "countdown";
    return true;
  }

  /** Countdown -> playing. The caller decides when the countdown has elapsed. */
  beginRound(nowMs: number): void {
    requireFiniteTime("nowMs", nowMs);
    if (this.phaseValue !== "countdown") {
      throw new RoundTransitionError(
        `beginRound() requires the countdown phase (current: ${this.phaseValue}).`,
      );
    }
    this.roundNumberValue += 1;
    this.roundStartedAtValue = nowMs;
    this.countdownEndsAtValue = null;
    this.phaseValue = "playing";
  }

  /**
   * Playing -> results. A winner must be in the frozen roster; a null winner
   * (draw/replay) records the result without scoring. Reaching `roundsToWin`
   * ends the match and makes `nextRound` return false.
   */
  endRound(result: RoundResult): void {
    if (this.phaseValue !== "playing") {
      throw new RoundTransitionError(
        `endRound() requires the playing phase (current: ${this.phaseValue}).`,
      );
    }
    const winner = result.winnerSlot;
    if (winner !== null) {
      if (!this.roster.includes(winner)) {
        throw new RangeError(`Winner slot ${winner} is not in the match roster.`);
      }
      const score = this.getScore(winner) + 1;
      this.scores.set(winner, score);
      if (score >= this.roundsToWin) {
        this.winnerSlotValue = winner;
      }
    }
    this.roundStartedAtValue = null;
    this.phaseValue = "results";
  }

  /**
   * Results -> countdown for the next round. Returns false when the match is
   * decided (someone reached `roundsToWin`) or when not in results; call
   * `reset()` for a rematch.
   */
  nextRound(nowMs: number): boolean {
    requireFiniteTime("nowMs", nowMs);
    if (this.phaseValue !== "results" || this.winnerSlotValue !== null) {
      return false;
    }
    this.countdownEndsAtValue = nowMs + this.countdownMs;
    this.phaseValue = "countdown";
    return true;
  }

  /** Back to the lobby with no roster, scores or winner. Safe to call anytime. */
  reset(): void {
    this.phaseValue = "lobby";
    this.roster = [];
    this.scores.clear();
    this.winnerSlotValue = null;
    this.roundNumberValue = 0;
    this.roundStartedAtValue = null;
    this.countdownEndsAtValue = null;
  }
}

/** Deduped, ascending 1..8 slot list, or null when any entry is invalid. */
function normalizeSlots(connectedSlots: ReadonlyArray<number>): number[] | null {
  const seen = new Set<number>();
  const slots: number[] = [];
  for (const slot of connectedSlots) {
    if (!Number.isInteger(slot) || slot < MIN_SLOTS || slot > MAX_SLOTS) {
      return null;
    }
    if (seen.has(slot)) {
      return null;
    }
    seen.add(slot);
    slots.push(slot);
  }
  slots.sort((a, b) => a - b);
  return slots;
}
