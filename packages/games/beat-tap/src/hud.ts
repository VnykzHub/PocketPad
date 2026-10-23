/**
 * Beat Tap HUD strings (GAME-BT-HOST-05; E11).
 *
 * Strings are the only allocation a per-frame HUD would otherwise create, so
 * every line is cached and rebuilt only when its inputs change. Results are
 * built once when the song ends, using game-kit's `resultsRows` for ranking and
 * player identity, and are never touched in `render`.
 */
import {
  resultsRows,
  playerLabel,
  type Scoreboard,
  type ResultsRow,
} from "@lanpad/game-kit";
import type { PlayerStats } from "./judge.js";
import { accuracyPercent } from "./judge.js";

/** Everything the results overlay draws. Built once per song. */
export interface BeatTapResults {
  readonly title: string;
  readonly winnerLine: string;
  readonly playerLines: readonly string[];
  readonly hintLine: string;
}

/**
 * Builds the results overlay content. The roster (not the scoreboard) decides
 * who appears, so a player who missed every note still gets a 0/0%/x0 row.
 * Allocation here is allowed: this runs once per song.
 */
export function buildResults(
  scoreboard: Scoreboard,
  statsBySlot: readonly PlayerStats[],
  roster: readonly number[],
  winnerSlot: number | null,
): BeatTapResults {
  const scores: { slot: number; score: number }[] = [];
  for (let index = 0; index < roster.length; index += 1) {
    const slot = roster[index];
    if (slot === undefined) {
      continue;
    }
    scores.push({ slot, score: scoreboard.get(slot) });
  }
  const rows: readonly ResultsRow[] = resultsRows(scores, winnerSlot);
  const playerLines: string[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row === undefined) {
      continue;
    }
    const stats = statsBySlot[row.slot - 1];
    const maxCombo = stats === undefined ? 0 : stats.maxCombo;
    const accuracy = stats === undefined ? 0 : Math.round(accuracyPercent(stats));
    playerLines.push(`${row.label}  ${row.score}  x${maxCombo}  ${accuracy}%`);
  }
  const winnerLine = winnerSlot === null ? "NO WINNER" : `${playerLabel(winnerSlot)} WINS`;
  return {
    title: "RESULTS",
    winnerLine,
    playerLines,
    hintLine: "Tap a lane to play again",
  };
}

/**
 * Per-slot string cache. `lineFor` returns the same string object until the
 * slot's score or combo changes, so the renderer can hold it for a frame.
 */
export class BeatTapHud {
  private readonly scoreValues = new Int32Array(8);
  private readonly comboValues = new Int32Array(8);
  private readonly scoreLines: string[] = ["", "", "", "", "", "", "", ""];
  private comboSlot = 0;
  private comboValue = 0;
  private comboText = "";
  private calibrationTaps = -1;
  private calibrationText = "";
  private offsetValue = Number.NaN;
  private offsetText = "";

  constructor() {
    this.reset();
  }

  /** Invalidates every cache; called on round start and dispose. */
  reset(): void {
    for (let index = 0; index < 8; index += 1) {
      this.scoreValues[index] = -1;
      this.comboValues[index] = -1;
      this.scoreLines[index] = "";
    }
    this.comboSlot = 0;
    this.comboValue = 0;
    this.comboText = "";
    this.calibrationTaps = -1;
    this.calibrationText = "";
    this.offsetValue = Number.NaN;
    this.offsetText = "";
  }

  /** "P1  1200  x12" rebuilt only on a score or combo change. */
  lineFor(slot: number, score: number, combo: number): string {
    const index = slot - 1;
    if (index < 0 || index >= 8) {
      return "";
    }
    if (this.scoreValues[index] === score && this.comboValues[index] === combo) {
      return this.scoreLines[index] ?? "";
    }
    this.scoreValues[index] = score;
    this.comboValues[index] = combo;
    const line = `${playerLabel(slot)}  ${score}  x${combo}`;
    this.scoreLines[index] = line;
    return line;
  }

  /** Large combo readout for the last scoring player; empty below two. */
  comboLine(slot: number, combo: number): string {
    if (combo < 2 || slot < 1) {
      this.comboSlot = slot;
      this.comboValue = combo;
      this.comboText = "";
      return this.comboText;
    }
    if (this.comboSlot === slot && this.comboValue === combo) {
      return this.comboText;
    }
    this.comboSlot = slot;
    this.comboValue = combo;
    this.comboText = `${playerLabel(slot)} COMBO x${combo}`;
    return this.comboText;
  }

  /** "TAP 3/8" during calibration; cached by tap count. */
  calibrationLine(taps: number, required: number): string {
    if (this.calibrationTaps === taps) {
      return this.calibrationText;
    }
    this.calibrationTaps = taps;
    this.calibrationText = `TAP ${taps}/${required}`;
    return this.calibrationText;
  }

  /** "CAL +60 ms" / "CAL 0 ms" for the lobby and calibration overlay. */
  offsetLine(offsetMs: number): string {
    if (this.offsetValue === offsetMs) {
      return this.offsetText;
    }
    this.offsetValue = offsetMs;
    const rounded = Math.round(offsetMs);
    this.offsetText =
      rounded === 0
        ? "CAL 0 ms"
        : rounded > 0
          ? `CAL +${rounded} ms`
          : `CAL ${rounded} ms`;
    return this.offsetText;
  }
}
