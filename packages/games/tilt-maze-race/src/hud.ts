/**
 * Host HUD and phone-panel text for Tilt Maze Race (GAME-TM-HOST-04,
 * GAME-TM-CTRL-01/04; GAME-TM-PERF-01).
 *
 * The HUD is rebuilt only when an input that can change the text changes
 * (phase, round, roster, finish count, winners, countdown second). Text is then
 * stable strings the renderer and panel publisher can reuse, so a frame with no
 * state change allocates nothing (PR-9.3).
 *
 * Phone panels: a connected player who is not on the race roster sees
 * "SPECTATING"; a finished ball says "FINISHED!" and its input no longer moves
 * anything (the world freezes it).
 */
import { countdownLabel, type MatchPhase } from "@lanpad/game-kit";
import { SLOT_COUNT } from "./config.js";
import type { TiltMazeWorld } from "./world.js";

export const HUD_TITLE = "TILT MAZE RACE";
export const HUD_INSTRUCTIONS = "Tilt or push the stick. Reach the exit first.";

const PANEL_GET_READY = "GET READY";
const PANEL_RACING = "RACING - TILT OR STICK";
const PANEL_FINISHED = "FINISHED!";
const PANEL_SPECTATE = "SPECTATING";
const PANEL_ROUND_WIN = "YOU WIN THE RACE!";
const PANEL_MATCH_WIN = "YOU WIN THE MATCH!";
const PANEL_ROUND_OVER = "RACE OVER";

const PLACEMENTS = ["", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th"];

const SIGNATURE_ROUND_SHIFT = 2;
const SIGNATURE_MASK_SHIFT = 6;
const SIGNATURE_FINISH_SHIFT = 14;
const SIGNATURE_MATCH_SHIFT = 17;
const SIGNATURE_ROUND_WINNER_SHIFT = 20;
const SIGNATURE_SECOND_SHIFT = 23;

export interface TiltMazeHud {
  readonly title: string;
  readonly instructions: string;
  /** Line per slot index (`slot - 1`), blank when the slot is not shown. */
  readonly lines: string[];
  /** Panel text per slot index (`slot - 1`); reused array. */
  readonly panelTexts: string[];
  subtitle: string;
  status: string;
  update(
    world: TiltMazeWorld,
    phase: MatchPhase,
    displayRound: number,
    countdownRemainingMs: number,
    connectedMask: number,
    matchWinnerSlot: number | null,
    roundWinnerSlot: number | null,
  ): void;
}

function phaseCode(phase: MatchPhase): number {
  if (phase === "lobby") return 0;
  if (phase === "countdown") return 1;
  if (phase === "playing") return 2;
  return 3;
}

function connectedCount(mask: number): number {
  let count = 0;
  let bits = mask;
  while (bits !== 0) {
    count += bits & 1;
    bits >>= 1;
  }
  return count;
}

function secondsLabel(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(2)}s`;
}

class HudState implements TiltMazeHud {
  readonly title = HUD_TITLE;
  readonly instructions = HUD_INSTRUCTIONS;
  readonly lines: string[] = [];
  readonly panelTexts: string[] = [];
  subtitle = "ROLL YOUR BALL TO THE EXIT";
  status = `0/${SLOT_COUNT} READY`;
  private signature = -1;

  constructor() {
    for (let index = 0; index < SLOT_COUNT; index += 1) {
      this.lines.push("");
      this.panelTexts.push("");
    }
  }

  update(
    world: TiltMazeWorld,
    phase: MatchPhase,
    displayRound: number,
    countdownRemainingMs: number,
    connectedMask: number,
    matchWinnerSlot: number | null,
    roundWinnerSlot: number | null,
  ): void {
    const code = phaseCode(phase);
    const finishCount = world.finishOrder.length;
    const countdownSecond =
      phase === "countdown" && Number.isFinite(countdownRemainingMs)
        ? Math.ceil(countdownRemainingMs / 1000)
        : 0;
    const signature =
      code |
      (displayRound << SIGNATURE_ROUND_SHIFT) |
      (connectedMask << SIGNATURE_MASK_SHIFT) |
      (finishCount << SIGNATURE_FINISH_SHIFT) |
      ((matchWinnerSlot ?? 0) << SIGNATURE_MATCH_SHIFT) |
      ((roundWinnerSlot ?? 0) << SIGNATURE_ROUND_WINNER_SHIFT) |
      (countdownSecond << SIGNATURE_SECOND_SHIFT);
    if (signature === this.signature) return;
    this.signature = signature;

    const racing = phase === "playing" || phase === "results";
    for (let slot = 1; slot <= SLOT_COUNT; slot += 1) {
      const connected = (connectedMask & (1 << slot)) !== 0;
      const ball = world.ball(slot);
      const active = racing && ball !== undefined && ball.active;
      const panelIndex = slot - 1;

      let line = "";
      if (racing && ball !== undefined && ball.active) {
        if (ball.finished && ball.finishRank > 0) {
          const placement = PLACEMENTS[ball.finishRank] ?? `${ball.finishRank}th`;
          line = `P${slot}  ${placement} - ${secondsLabel(ball.finishMs)}`;
        } else {
          line = `P${slot}  RACING`;
        }
      } else if (!racing && connected) {
        line = `P${slot}  READY`;
      } else if (racing && connected) {
        line = `P${slot}  WATCHING`;
      }
      this.lines[panelIndex] = line;

      let panel = "";
      if (connected) {
        if (phase === "lobby" || phase === "countdown") {
          panel = PANEL_GET_READY;
        } else if (phase === "playing") {
          panel = active ? (ball?.finished === true ? PANEL_FINISHED : PANEL_RACING) : PANEL_SPECTATE;
        } else if (matchWinnerSlot === slot) {
          panel = PANEL_MATCH_WIN;
        } else if (roundWinnerSlot === slot) {
          panel = PANEL_ROUND_WIN;
        } else if (active) {
          panel = ball?.finished === true ? PANEL_FINISHED : PANEL_ROUND_OVER;
        } else {
          panel = PANEL_SPECTATE;
        }
      }
      this.panelTexts[panelIndex] = panel;
    }
    this.lines.length = SLOT_COUNT;
    this.panelTexts.length = SLOT_COUNT;

    if (phase === "lobby") {
      this.subtitle = "ROLL YOUR BALL TO THE EXIT";
      this.status = `${connectedCount(connectedMask)}/${SLOT_COUNT} READY`;
    } else if (phase === "countdown") {
      this.subtitle = `ROUND ${displayRound}`;
      this.status = `GET READY - ${countdownLabel(countdownRemainingMs)}`;
    } else if (phase === "playing") {
      this.subtitle = `ROUND ${displayRound}`;
      this.status = "RACE TO THE EXIT";
    } else {
      this.subtitle = `ROUND ${displayRound} RESULTS`;
      if (matchWinnerSlot !== null) {
        this.status = `P${matchWinnerSlot} WINS THE MATCH`;
      } else if (roundWinnerSlot !== null) {
        this.status = `P${roundWinnerSlot} WINS THE RACE`;
      } else {
        this.status = "RACE OVER";
      }
    }
  }
}

/** Creates the HUD cache; one per game instance. */
export function createHud(): TiltMazeHud {
  return new HudState();
}
