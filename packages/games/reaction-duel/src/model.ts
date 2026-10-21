/**
 * Reaction Duel rules model (GAME-RD-HOST-01/02/04; SPEC §17.2, A12).
 *
 * Pure gameplay state machine. It reads no sockets, protocol frames, DOM or
 * ambient time: callers inject a `clock` (the host's synced server-time
 * estimate, the same domain as `ReactionInput.tick`) and supply input records
 * on every update.
 *
 * Phase flow:
 *
 *   lobby -> countdown -> waiting -> signal -> roundResult -> countdown | matchResult
 *
 * `roundResult` is also entered on a replay (false start, miss, no-tap or
 * tie); a replay keeps the same round number and scores nothing.
 *
 * Fairness: the round is decided by `adjudicateRound`, which compares the
 * synced `tick` carried with each edge, not the order records arrive in.
 */

import {
  adjudicateRound,
  type ReactionInput,
  type RoundDecision,
} from "./adjudication.js";

export type {
  AdjudicationOptions,
  ReactionInput,
  ReplayReason,
  RoundDecision,
  SlotPress,
  SlotPressOutcome,
} from "./adjudication.js";

/** Phases of one match. `matchResult` is terminal until `rematch()`. */
export type ReactionPhase =
  | "lobby"
  | "countdown"
  | "waiting"
  | "signal"
  | "roundResult"
  | "matchResult";

/** Button bits exercised by the four-button Minimal (A12). */
export const TARGET_BITS = [0, 1, 2, 3] as const;

export interface ReactionDuelConfig {
  /** Minimum connected players needed to start. */
  minPlayers: number;
  /** Maximum connected players (platform cap is 8). */
  maxPlayers: number;
  /** Pre-round countdown length. */
  countdownMs: number;
  /** How long a round result stays on screen before the next round. */
  roundResultMs: number;
  /** Decisive rounds needed to win the match; 3 means best of 5. */
  roundsToWin: number;
  /** Minimum random wait before the signal. */
  minDelayMs: number;
  /** Maximum random wait before the signal. */
  maxDelayMs: number;
  /** No matching press inside this window is a draw/replay. */
  noTapTimeoutMs: number;
  /** Gaps below this many milliseconds between the two earliest valid presses replay. */
  tieThresholdMs: number;
}

/** Defaults mirror `config.json`; the adapter may parse that file instead. */
export const DEFAULT_REACTION_DUEL_CONFIG: ReactionDuelConfig = {
  minPlayers: 2,
  maxPlayers: 8,
  countdownMs: 3000,
  roundResultMs: 2500,
  roundsToWin: 3,
  minDelayMs: 2000,
  maxDelayMs: 6000,
  noTapTimeoutMs: 3000,
  tieThresholdMs: 1,
};

/** Read-only view of one slot's match state. */
export interface ReactionPlayer {
  readonly slot: number;
  readonly score: number;
  readonly connected: boolean;
}

interface PlayerRecord {
  slot: number;
  score: number;
  connected: boolean;
}

/** The decided round, kept for the result screen and debug only. */
export interface RoundSummary {
  /** Round the decision belongs to; a replay keeps the number. */
  roundNumber: number;
  targetBit: number;
  /** Synced stamp at which the signal became visible. */
  signalAt: number;
  decision: RoundDecision;
}

export interface ReactionDuelOptions {
  /** Seed for the delay and target RNG. Same seed + same inputs = same match. */
  seed: number;
  /**
   * Injected time source in synced server-clock milliseconds (A3). The host
   * wires its synced clock; tests wire a fake. The model never calls Date.now.
   */
  clock: () => number;
  /** Partial override of the rule defaults. */
  config?: Partial<ReactionDuelConfig>;
}

const PLATFORM_MAX_PLAYERS = 8;

/**
 * Small deterministic PRNG (mulberry32). Returns floats in [0, 1).
 * Chosen because it is 5 lines, seedable and stable across engines.
 */
export function createSeededRng(seed: number): () => number {
  if (!Number.isFinite(seed)) {
    throw new RangeError("seed must be a finite number.");
  }
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic Reaction Duel match. One instance owns one match; call
 * `rematch()` for a reset. All rule data is in `ReactionDuelConfig`.
 */
export class ReactionDuelModel {
  private readonly config: ReactionDuelConfig;
  private readonly clockFn: () => number;
  private readonly random: () => number;
  private readonly playerRecords: PlayerRecord[] = [];
  /** Every edge record collected in the current round, including pre-signal. */
  private readonly roundInputs: ReactionInput[] = [];
  /** Slots connected when the current round began; reconnects wait a round. */
  private readonly roundSlots = new Set<number>();

  private phaseValue: ReactionPhase = "lobby";
  private roundNumberValue = 1;
  private phaseEndsAtValue: number | null = null;
  private waitDelayMsValue: number | null = null;
  private targetBitValue: number | null = null;
  private signalAtValue: number | null = null;
  private matchWinnerSlotValue: number | null = null;
  private lastRoundValue: RoundSummary | null = null;

  constructor(options: ReactionDuelOptions) {
    this.config = mergeConfig(options.config);
    this.clockFn = options.clock;
    this.random = createSeededRng(options.seed);
  }

  get phase(): ReactionPhase {
    return this.phaseValue;
  }

  /** Number of the current round; replays keep the same number. */
  get roundNumber(): number {
    return this.roundNumberValue;
  }

  /** End of the current phase in clock milliseconds, or null for lobby/matchResult. */
  get phaseEndsAt(): number | null {
    return this.phaseEndsAtValue;
  }

  /** Random wait chosen for the current/last round, or null before one started. */
  get waitDelayMs(): number | null {
    return this.waitDelayMsValue;
  }

  /** Target button bit while a round is live, otherwise the last target. */
  get targetBit(): number | null {
    return this.targetBitValue;
  }

  /** Synced stamp of the current/last signal, or null before one fired. */
  get signalAt(): number | null {
    return this.signalAtValue;
  }

  /** Slot that reached `roundsToWin`, or null while the match is live. */
  get matchWinnerSlot(): number | null {
    return this.matchWinnerSlotValue;
  }

  /** Decision of the most recently finished round, or null. */
  get lastRound(): RoundSummary | null {
    return this.lastRoundValue;
  }

  /** Number of connected slots. */
  get playerCount(): number {
    let count = 0;
    for (const player of this.playerRecords) {
      if (player.connected) {
        count += 1;
      }
    }
    return count;
  }

  /** Read-only player records in slot insertion order. */
  getPlayers(): readonly ReactionPlayer[] {
    return this.playerRecords;
  }

  getPlayer(slot: number): ReactionPlayer | undefined {
    return this.findPlayer(slot);
  }

  /**
   * Adds a slot or reconnects a previously removed slot (score preserved).
   *
   * New slots may only join in the lobby; a reconnect may happen at any time
   * and takes effect from the next input poll. The match roster is frozen once
   * `startMatch` succeeds, so a mid-match reconnect never adds a new opponent.
   */
  addPlayer(slot: number): boolean {
    if (!isValidSlot(slot)) {
      return false;
    }
    const existing = this.findPlayer(slot);
    if (existing !== undefined) {
      if (existing.connected) {
        return false;
      }
      existing.connected = true;
      return true;
    }
    if (this.phaseValue !== "lobby") {
      return false;
    }
    if (this.playerCount >= this.config.maxPlayers) {
      return false;
    }
    this.playerRecords.push({ slot, score: 0, connected: true });
    return true;
  }

  /** Marks a slot disconnected; its score and slot number are kept. */
  removePlayer(slot: number): boolean {
    const player = this.findPlayer(slot);
    if (player === undefined || !player.connected) {
      return false;
    }
    player.connected = false;
    return true;
  }

  /**
   * Starts a match from the lobby. Fails unless the connected player count is
   * inside the configured range. Scores always start at zero.
   */
  startMatch(): boolean {
    if (this.phaseValue !== "lobby") {
      return false;
    }
    const count = this.playerCount;
    if (count < this.config.minPlayers || count > this.config.maxPlayers) {
      return false;
    }

    for (const player of this.playerRecords) {
      player.score = 0;
    }
    this.roundNumberValue = 1;
    this.matchWinnerSlotValue = null;
    this.lastRoundValue = null;
    this.waitDelayMsValue = null;
    this.beginCountdown(this.readClock());
    return true;
  }

  /**
   * Advances the state machine and applies the input records observed since
   * the previous update. Inputs are ignored outside `waiting`/`signal`.
   */
  update(inputs: readonly ReactionInput[] = []): void {
    const now = this.readClock();
    this.advance(now);

    if (this.phaseValue === "waiting" || this.phaseValue === "signal") {
      this.collectInputs(inputs);
    }

    if (this.phaseValue === "signal") {
      const endsAt = this.phaseEndsAtValue;
      this.resolveRound(now, endsAt !== null && now >= endsAt);
    }
  }

  /**
   * Resets scores and starts a fresh match from the results screen.
   * Returns false when the match is not over or too few players remain.
   */
  rematch(): boolean {
    if (this.phaseValue !== "matchResult") {
      return false;
    }
    if (this.playerCount < this.config.minPlayers) {
      return false;
    }

    for (const player of this.playerRecords) {
      player.score = 0;
    }
    this.roundNumberValue = 1;
    this.matchWinnerSlotValue = null;
    this.lastRoundValue = null;
    this.waitDelayMsValue = null;
    this.beginCountdown(this.readClock());
    return true;
  }

  private readClock(): number {
    const now = this.clockFn();
    if (!Number.isFinite(now)) {
      throw new RangeError("clock() must return a finite number of milliseconds.");
    }
    return now;
  }

  private findPlayer(slot: number): PlayerRecord | undefined {
    for (const player of this.playerRecords) {
      if (player.slot === slot) {
        return player;
      }
    }
    return undefined;
  }

  private findConnected(slot: number): PlayerRecord | undefined {
    const player = this.findPlayer(slot);
    return player !== undefined && player.connected ? player : undefined;
  }

  private beginCountdown(now: number): void {
    this.resetRound();
    this.phaseValue = "countdown";
    this.phaseEndsAtValue = now + this.config.countdownMs;
  }

  private beginWaiting(now: number): void {
    this.resetRound();
    for (const player of this.playerRecords) {
      if (player.connected) {
        this.roundSlots.add(player.slot);
      }
    }
    const delay = this.randomInt(this.config.minDelayMs, this.config.maxDelayMs);
    this.waitDelayMsValue = delay;
    this.phaseValue = "waiting";
    this.phaseEndsAtValue = now + delay;
  }

  private beginSignal(now: number): void {
    const index = this.randomInt(0, TARGET_BITS.length - 1);
    const target = TARGET_BITS[index];
    if (target === undefined) {
      throw new Error("TARGET_BITS is empty.");
    }
    this.targetBitValue = target;
    this.signalAtValue = now;
    this.phaseValue = "signal";
    this.phaseEndsAtValue = now + this.config.noTapTimeoutMs;
  }

  private resetRound(): void {
    this.roundInputs.length = 0;
    this.roundSlots.clear();
    this.targetBitValue = null;
    this.signalAtValue = null;
  }

  /**
   * Catches up through elapsed phase boundaries, using the scheduled boundary
   * as the transition time so a late host poll cannot stretch the countdown or
   * the random wait. It stops at `signal`; `update` collects inputs first and
   * then resolves the signal (including an elapsed timeout), so edges stamped
   * inside the window are never lost to a stall.
   */
  private advance(now: number): void {
    while (
      this.phaseEndsAtValue !== null &&
      now >= this.phaseEndsAtValue
    ) {
      const boundary = this.phaseEndsAtValue;
      switch (this.phaseValue) {
        case "countdown":
          this.beginWaiting(boundary);
          break;
        case "waiting":
          this.beginSignal(boundary);
          return;
        case "roundResult":
          if (this.matchWinnerSlotValue !== null) {
            this.phaseValue = "matchResult";
            this.phaseEndsAtValue = null;
            return;
          }
          this.beginCountdown(boundary);
          break;
        default:
          return;
      }
    }
  }

  private collectInputs(inputs: readonly ReactionInput[]): void {
    for (const input of inputs) {
      if (!Number.isFinite(input.tick)) {
        continue;
      }
      const edges = input.edges & 0xffff;
      if (edges === 0) {
        continue;
      }
      if (!this.roundSlots.has(input.slot)) {
        continue;
      }
      if (this.findConnected(input.slot) === undefined) {
        continue;
      }
      this.roundInputs.push({
        slot: input.slot,
        buttons: input.buttons & 0xffff,
        edges,
        tick: input.tick,
      });
    }
  }

  /**
   * Adjudicates the round. A winner (or a tie replay) finishes immediately;
   * `no-tap`/`all-invalid` only finish once the timeout has elapsed, because a
   * later valid press can still win.
   */
  private resolveRound(now: number, timedOut: boolean): void {
    const targetBit = this.targetBitValue;
    const signalAt = this.signalAtValue;
    if (targetBit === null || signalAt === null) {
      return;
    }

    const decision = adjudicateRound(this.roundInputs, {
      targetBit,
      signalTick: signalAt,
      timeoutMs: this.config.noTapTimeoutMs,
      tieThresholdMs: this.config.tieThresholdMs,
    });

    if (decision.kind === "winner") {
      this.finishRound(decision, now);
      return;
    }
    if (decision.reason === "tie" || timedOut) {
      this.finishRound(decision, now);
    }
  }

  private finishRound(decision: RoundDecision, now: number): void {
    const playedRound = this.roundNumberValue;

    if (decision.kind === "winner") {
      const winner = this.findPlayer(decision.slot);
      if (winner !== undefined) {
        winner.score += 1;
        if (winner.score >= this.config.roundsToWin) {
          this.matchWinnerSlotValue = winner.slot;
        }
      }
    }

    const targetBit = this.targetBitValue;
    const signalAt = this.signalAtValue;
    if (targetBit === null || signalAt === null) {
      throw new Error("Cannot finish a round that never reached its signal.");
    }

    this.lastRoundValue = {
      roundNumber: playedRound,
      targetBit,
      signalAt,
      decision,
    };

    if (decision.kind === "winner" && this.matchWinnerSlotValue === null) {
      this.roundNumberValue = playedRound + 1;
    }

    this.phaseValue = "roundResult";
    this.phaseEndsAtValue = now + this.config.roundResultMs;
  }

  private randomInt(min: number, max: number): number {
    const value = min + Math.floor(this.random() * (max - min + 1));
    return value > max ? max : value;
  }
}

function isValidSlot(slot: number): boolean {
  return Number.isInteger(slot) && slot >= 1 && slot <= PLATFORM_MAX_PLAYERS;
}

function mergeConfig(overrides: Partial<ReactionDuelConfig> | undefined): ReactionDuelConfig {
  const config: ReactionDuelConfig = {
    ...DEFAULT_REACTION_DUEL_CONFIG,
    ...overrides,
  };
  validateConfig(config);
  return config;
}

function validateConfig(config: ReactionDuelConfig): void {
  const integerFields: Array<[keyof ReactionDuelConfig, number]> = [
    ["minPlayers", config.minPlayers],
    ["maxPlayers", config.maxPlayers],
    ["countdownMs", config.countdownMs],
    ["roundResultMs", config.roundResultMs],
    ["roundsToWin", config.roundsToWin],
    ["minDelayMs", config.minDelayMs],
    ["maxDelayMs", config.maxDelayMs],
    ["noTapTimeoutMs", config.noTapTimeoutMs],
    ["tieThresholdMs", config.tieThresholdMs],
  ];
  for (const [name, value] of integerFields) {
    if (!Number.isInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative integer.`);
    }
  }
  if (config.minPlayers < 1 || config.maxPlayers > PLATFORM_MAX_PLAYERS) {
    throw new RangeError(
      `Player counts must be within 1..${PLATFORM_MAX_PLAYERS}.`,
    );
  }
  if (config.minPlayers > config.maxPlayers) {
    throw new RangeError("minPlayers must not exceed maxPlayers.");
  }
  if (config.roundsToWin < 1) {
    throw new RangeError("roundsToWin must be at least 1.");
  }
  if (config.minDelayMs > config.maxDelayMs) {
    throw new RangeError("minDelayMs must not exceed maxDelayMs.");
  }
}
