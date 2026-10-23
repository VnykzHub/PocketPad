/**
 * Sumo Bumpers HUD strings (GAME-SB-HOST-03).
 *
 * Text is the most expensive draw call at TV distance, so every string the
 * game can show is built once in the constructor and returned by lookup.
 * `simulate` and `render` never format, concat or allocate: they index these
 * tables with clamped integers. Player labels come from `@lanpad/game-kit`
 * (constant `"P1"`..`"P8"` strings), and countdown labels are the kit's
 * constant `"3" | "2" | "1" | "GO"`.
 */
import {
  countdownLabel,
  playerLabel,
  type CountdownLabel,
} from "@lanpad/game-kit";

/** Highest round number with a prebuilt label; matches survive draws. */
const MAX_ROUND_LINE = 99;

/** Static copy reused by the renderer and private panels. */
export const SUMO_TITLE = "SUMO BUMPERS";
export const SUMO_HINT = "Stick to move · Dash to shove";
export const SUMO_RESULTS_HINT = "Dash to continue";
export const SUMO_AUTO_HINT = "Next round starts automatically";
export const SUMO_ELIMINATED_PANEL = "Eliminated — spectating";

/** Precomputed strings for one match. */
export class SumoHud {
  readonly title = SUMO_TITLE;
  readonly hint = SUMO_HINT;
  readonly resultsHint = SUMO_RESULTS_HINT;
  readonly autoHint = SUMO_AUTO_HINT;
  readonly eliminatedText = SUMO_ELIMINATED_PANEL;

  private readonly maxPlayers: number;
  private readonly minPlayers: number;
  private readonly roundLines: string[] = [];
  private readonly aliveLines: string[] = [];
  private readonly floorLines: string[] = [];
  private readonly waitingLines: string[] = [];
  private readonly matchWinnerLines: string[] = [];
  private readonly roundWinnerLines: string[] = [];
  private readonly labels: string[] = [];
  /** Indexed by `[slot - 1][wins]`; wins never exceed `roundsToWin`. */
  private readonly scoreLines: string[][] = [];
  /** Private-panel body per slot and win count. */
  private readonly panelLines: string[][] = [];

  constructor(minPlayers: number, maxPlayers: number, roundsToWin: number) {
    this.minPlayers = Math.max(1, Math.min(8, minPlayers));
    this.maxPlayers = Math.max(this.minPlayers, Math.min(8, maxPlayers));
    const winTarget = Math.max(1, roundsToWin);

    for (let round = 1; round <= MAX_ROUND_LINE; round += 1) {
      this.roundLines.push(`ROUND ${round}`);
    }
    for (let count = 0; count <= this.maxPlayers; count += 1) {
      this.aliveLines.push(`ALIVE ${count}`);
      this.waitingLines.push(
        count >= this.minPlayers
          ? "Get ready"
          : `Waiting for players (${count}/${this.minPlayers})`,
      );
    }
    for (let percent = 0; percent <= 100; percent += 1) {
      this.floorLines.push(`FLOOR ${percent}%`);
    }
    for (let slot = 1; slot <= this.maxPlayers; slot += 1) {
      const label = playerLabel(slot);
      this.labels.push(label);
      this.matchWinnerLines.push(`${label} WINS THE MATCH`);
      this.roundWinnerLines.push(`${label} TAKES THE ROUND`);
      const scores: string[] = [];
      const panels: string[] = [];
      for (let wins = 0; wins <= winTarget; wins += 1) {
        scores.push(`${label}  ${wins}`);
        panels.push(`${label}: ${wins}/${winTarget} rounds`);
      }
      this.scoreLines.push(scores);
      this.panelLines.push(panels);
    }
  }

  /** `"P1"`..`"P8"`; a constant string from the kit. */
  label(slot: number): string {
    const index = slot - 1;
    return this.labels[index] ?? "P?";
  }

  /** `"ROUND 3"`; round 0 and negatives show round 1. */
  roundLine(round: number): string {
    const index = Math.max(1, Math.min(MAX_ROUND_LINE, round | 0)) - 1;
    return this.roundLines[index] ?? this.roundLines[0] ?? "ROUND";
  }

  /** `"ALIVE 4"`; counts clamp to 0..maxPlayers. */
  aliveLine(count: number): string {
    const index = Math.max(0, Math.min(this.maxPlayers, count | 0));
    return this.aliveLines[index] ?? this.aliveLines[0] ?? "ALIVE";
  }

  /** `"FLOOR 76%"`; percentages clamp to 0..100. */
  floorLine(percent: number): string {
    const index = Math.max(0, Math.min(100, percent | 0));
    return this.floorLines[index] ?? this.floorLines[0] ?? "FLOOR";
  }

  /** Lobby line: waiting count below the minimum, `"Get ready"` at or above. */
  waitingLine(count: number): string {
    const index = Math.max(0, Math.min(this.maxPlayers, count | 0));
    return this.waitingLines[index] ?? this.waitingLines[0] ?? "GET READY";
  }

  /** `"P1  2"`; wins clamp to the precomputed range. */
  scoreLine(slot: number, wins: number): string {
    const slotIndex = Math.max(1, Math.min(this.maxPlayers, slot | 0)) - 1;
    const row = this.scoreLines[slotIndex];
    if (row === undefined) return "P?  0";
    const index = Math.max(0, Math.min(row.length - 1, wins | 0));
    return row[index] ?? row[0] ?? "P?  0";
  }

  /** Private-panel body for a round result. */
  panelLine(slot: number, wins: number): string {
    const slotIndex = Math.max(1, Math.min(this.maxPlayers, slot | 0)) - 1;
    const row = this.panelLines[slotIndex];
    if (row === undefined) return "Round over";
    const index = Math.max(0, Math.min(row.length - 1, wins | 0));
    return row[index] ?? row[0] ?? "Round over";
  }

  /** `"P3 WINS THE MATCH"`. */
  matchWinnerLine(slot: number): string {
    const index = Math.max(1, Math.min(this.maxPlayers, slot | 0)) - 1;
    return this.matchWinnerLines[index] ?? "MATCH OVER";
  }

  /** `"P3 TAKES THE ROUND"`. */
  roundWinnerLine(slot: number): string {
    const index = Math.max(1, Math.min(this.maxPlayers, slot | 0)) - 1;
    return this.roundWinnerLines[index] ?? "ROUND OVER";
  }

  /** `"3"`, `"2"`, `"1"` or `"GO"`; constant strings from the kit. */
  countdown(remainingMs: number): CountdownLabel {
    return countdownLabel(remainingMs);
  }
}
