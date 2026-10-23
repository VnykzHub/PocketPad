/**
 * Match lifecycle (spec 24 §2.1; ER-24-01).
 *
 * Restates the host `RoundManager` flow in SDK-only code:
 * lobby -> countdown -> playing -> results -> countdown (or lobby when the
 * match is decided). No clock is owned here: the caller passes `nowMs` on
 * every tick, so tests use a fake clock and the host can pause without drift.
 *
 * `update` is the roster feed. It records the connected slots the host reports
 * and advances an elapsed countdown. `start` reads that latest feed, so a game
 * calls `update` every fixed tick and `start` when it wants a match to begin.
 * `update` allocates nothing and never mutates the caller's array.
 */
import {
  DEFAULT_COUNTDOWN_MS,
  DEFAULT_ROUNDS_TO_WIN,
  MAX_SLOT,
  MIN_SLOT,
  isSlot,
  requireFinite,
} from "./slots.js";

export type MatchPhase = "lobby" | "countdown" | "playing" | "results";

export interface MatchOptions {
  readonly minPlayers: number;
  readonly maxPlayers: number;
  /** Countdown length in milliseconds; default 3000. */
  readonly countdownMs?: number;
  /** Decisive rounds needed to win; default 3 (best of 5). */
  readonly roundsToWin?: number;
}

export interface Match {
  readonly phase: MatchPhase;
  /** Round being played or about to be played; 0 before the first round. */
  readonly round: number;
  /** Milliseconds left in the countdown, 0 outside the countdown phase. */
  readonly countdownRemainingMs: number;
  /** Round wins per slot; contains every roster slot after `start`. */
  readonly scores: ReadonlyMap<number, number>;
  /** Slot that reached `roundsToWin`, or null while the match is live. */
  readonly winnerSlot: number | null;
  /** Call once per fixed tick with the connected slots and host time. */
  update(nowMs: number, connectedSlots: readonly number[]): void;
  /** Starts when the roster from the latest `update` is valid; false while still in lobby. */
  start(nowMs: number): boolean;
  /** Ends the current playing round; null is a draw. */
  finishRound(winnerSlot: number | null): void;
  /** Moves from results to the next countdown or lobby. */
  nextRound(nowMs: number): void;
  reset(): void;
}

/** Thrown when a method is called in a phase that cannot accept it. */
export class MatchTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatchTransitionError";
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

class MatchState implements Match {
  readonly minPlayers: number;
  readonly maxPlayers: number;
  readonly countdownMs: number;
  readonly roundsToWin: number;

  private phaseValue: MatchPhase = "lobby";
  private roundValue = 0;
  private readonly scoreMap = new Map<number, number>();
  private winnerValue: number | null = null;
  private roster: number[] = [];
  private countdownRemaining = 0;
  private countdownEndsAt: number | null = null;
  /** Latest roster feed, copied into preallocated storage (no per-tick alloc). */
  private readonly feedSlots = new Int32Array(MAX_SLOT);
  private feedCount = 0;
  private feedValid = false;

  constructor(options: MatchOptions) {
    requireIntegerInRange("minPlayers", options.minPlayers, MIN_SLOT, MAX_SLOT);
    requireIntegerInRange("maxPlayers", options.maxPlayers, MIN_SLOT, MAX_SLOT);
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

  get phase(): MatchPhase {
    return this.phaseValue;
  }

  get round(): number {
    return this.roundValue;
  }

  get countdownRemainingMs(): number {
    return this.countdownRemaining;
  }

  get scores(): ReadonlyMap<number, number> {
    return this.scoreMap;
  }

  get winnerSlot(): number | null {
    return this.winnerValue;
  }

  update(nowMs: number, connectedSlots: readonly number[]): void {
    requireFinite(nowMs, "nowMs");

    // Validate uniqueness and range with a bitmask; copy into fixed storage so
    // a caller reusing its buffer cannot change the feed behind our back.
    let mask = 0;
    let valid = true;
    let count = 0;
    for (let index = 0; index < connectedSlots.length; index += 1) {
      const slot = connectedSlots[index];
      if (!isSlot(slot)) {
        valid = false;
        break;
      }
      const bit = 1 << (slot - MIN_SLOT);
      if ((mask & bit) !== 0) {
        valid = false;
        break;
      }
      mask |= bit;
      this.feedSlots[count] = slot;
      count += 1;
    }
    this.feedCount = valid ? count : 0;
    this.feedValid = valid;

    if (this.phaseValue !== "countdown") {
      return;
    }
    if (!valid || !this.rosterIsConnected(connectedSlots)) {
      // The roster shrank before the round began; return to the lobby.
      this.resetInternal();
      return;
    }
    const endsAt = this.countdownEndsAt;
    if (endsAt === null) {
      return;
    }
    if (nowMs >= endsAt) {
      this.phaseValue = "playing";
      this.roundValue += 1;
      this.countdownRemaining = 0;
      this.countdownEndsAt = null;
    } else {
      this.countdownRemaining = endsAt - nowMs;
    }
  }

  start(nowMs: number): boolean {
    requireFinite(nowMs, "nowMs");
    if (this.phaseValue !== "lobby") {
      throw new MatchTransitionError(
        `start() requires the lobby phase (current: ${this.phaseValue}).`,
      );
    }
    if (!this.feedValid) {
      return false;
    }
    const count = this.feedCount;
    if (count < this.minPlayers || count > this.maxPlayers) {
      return false;
    }

    const roster = new Array<number>(count);
    for (let index = 0; index < count; index += 1) {
      roster[index] = this.feedSlots[index] ?? 0;
    }
    roster.sort((a, b) => a - b);

    this.roster = roster;
    this.scoreMap.clear();
    for (let index = 0; index < roster.length; index += 1) {
      const slot = roster[index];
      if (slot !== undefined) {
        this.scoreMap.set(slot, 0);
      }
    }
    this.winnerValue = null;
    this.roundValue = 0;
    this.countdownRemaining = this.countdownMs;
    this.countdownEndsAt = nowMs + this.countdownMs;
    this.phaseValue = "countdown";
    return true;
  }

  finishRound(winnerSlot: number | null): void {
    if (this.phaseValue !== "playing") {
      throw new MatchTransitionError(
        `finishRound() requires the playing phase (current: ${this.phaseValue}).`,
      );
    }
    if (winnerSlot !== null) {
      if (!isSlot(winnerSlot) || !this.roster.includes(winnerSlot)) {
        throw new RangeError(`Winner slot ${winnerSlot} is not in the match roster.`);
      }
      const score = (this.scoreMap.get(winnerSlot) ?? 0) + 1;
      this.scoreMap.set(winnerSlot, score);
      if (score >= this.roundsToWin) {
        this.winnerValue = winnerSlot;
      }
    }
    this.countdownRemaining = 0;
    this.countdownEndsAt = null;
    this.phaseValue = "results";
  }

  nextRound(nowMs: number): void {
    requireFinite(nowMs, "nowMs");
    if (this.phaseValue !== "results") {
      throw new MatchTransitionError(
        `nextRound() requires the results phase (current: ${this.phaseValue}).`,
      );
    }
    if (this.winnerValue !== null) {
      // The match is decided: return to the lobby for a rematch.
      this.resetInternal();
      return;
    }
    this.countdownRemaining = this.countdownMs;
    this.countdownEndsAt = nowMs + this.countdownMs;
    this.phaseValue = "countdown";
  }

  reset(): void {
    this.resetInternal();
  }

  private resetInternal(): void {
    this.phaseValue = "lobby";
    this.roundValue = 0;
    this.scoreMap.clear();
    this.winnerValue = null;
    this.roster = [];
    this.countdownRemaining = 0;
    this.countdownEndsAt = null;
  }

  /** True when every frozen roster slot is present in `connected`; no allocation. */
  private rosterIsConnected(connected: readonly number[]): boolean {
    for (let index = 0; index < this.roster.length; index += 1) {
      const slot = this.roster[index];
      let found = false;
      for (let other = 0; other < connected.length; other += 1) {
        if (connected[other] === slot) {
          found = true;
          break;
        }
      }
      if (!found) {
        return false;
      }
    }
    return true;
  }
}

/** Creates a match state machine; validates the options eagerly. */
export function createMatch(options: MatchOptions): Match {
  return new MatchState(options);
}
