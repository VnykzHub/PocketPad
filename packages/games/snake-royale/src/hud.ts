/**
 * Snake Royale HUD and phone-panel text cache (GAME-SR-HOST-04, GAME-SR-CTRL-03).
 *
 * Every visible string is cached: the update method compares an integer key
 * and rebuilds a string only when the underlying state changes, so a steady
 * tick allocates nothing (PR-9.3). Strings are rebuilt on length changes,
 * phase changes and winner changes, which are rare by construction.
 */
import { countdownLabel, playerLabel, type MatchPhase } from "@lanpad/game-kit";
import type { SnakeWorld } from "./world.js";

export const HUD_TITLE = "SNAKE ROYALE";

const SLOT_COUNT = 8;

const PANEL_SPECTATE = 1;
const PANEL_READY = 2;
const PANEL_ALIVE = 3;
const PANEL_OUT = 4;
const PANEL_MATCH_WIN = 5;
const PANEL_MATCH_OVER = 6;
const PANEL_ROUND_WIN = 7;
const PANEL_DRAW = 8;
const PANEL_ROUND_OVER = 9;

const DRAW_LABEL = "DRAW";
const ARROWS: readonly string[] = ["↑", "→", "↓", "←"];

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  const whole = Math.trunc(value);
  return whole < min ? min : whole > max ? max : whole;
}

/**
 * Cached HUD state. The arrays are owned by this object and reused; renderers
 * must not mutate them. `lines` and `panelTexts` are indexed by slot - 1.
 */
export class HudCache {
  readonly lines: string[] = ["", "", "", "", "", "", "", ""];
  readonly panelTexts: string[] = ["", "", "", "", "", "", "", ""];
  subtitle = "";
  status = "";

  private readonly maxPlayers: number;
  private readonly labels: readonly string[];
  private readonly liveLabels: readonly string[];
  private readonly lobbyLabels: readonly string[];
  private readonly shrinkLabels: readonly string[];
  private readonly matchWinLabels: readonly string[];
  private readonly roundWinLabels: readonly string[];
  private readonly lineKeys = new Int32Array(SLOT_COUNT).fill(-1);
  private readonly panelKeys = new Int32Array(SLOT_COUNT).fill(-1);
  private subtitleKey = -1;
  private statusKey = -1;

  constructor(maxPlayers: number) {
    this.maxPlayers = clampInt(maxPlayers, 1, SLOT_COUNT);

    const labels: string[] = [];
    const liveLabels: string[] = [];
    const matchWinLabels: string[] = [""];
    const roundWinLabels: string[] = [""];
    for (let slot = 1; slot <= SLOT_COUNT; slot += 1) {
      labels.push(playerLabel(slot));
      matchWinLabels.push(`${playerLabel(slot)} WINS THE MATCH`);
      roundWinLabels.push(`${playerLabel(slot)} WINS THE ROUND`);
    }
    for (let alive = 0; alive <= SLOT_COUNT; alive += 1) {
      liveLabels.push(`${alive} ALIVE`);
    }
    this.labels = labels;
    this.liveLabels = liveLabels;
    this.matchWinLabels = matchWinLabels;
    this.roundWinLabels = roundWinLabels;

    const lobbyLabels: string[] = [];
    for (let count = 0; count <= this.maxPlayers; count += 1) {
      lobbyLabels.push(`${count}/${this.maxPlayers} READY`);
    }
    this.lobbyLabels = lobbyLabels;

    const shrinkLabels: string[] = ["SHRINK NOW"];
    for (let seconds = 1; seconds <= 15; seconds += 1) {
      shrinkLabels.push(`SHRINK IN ${seconds}s`);
    }
    shrinkLabels.push("FINAL ARENA");
    this.shrinkLabels = shrinkLabels;
  }

  /**
   * Refreshes every cached string for one simulation tick. `roundWinner` is
   * the slot that ended the round (null for a draw) and is only meaningful in
   * the results phase; `matchWinner` is set once a slot reaches the round
   * target. Called from `simulate`, never from `render`.
   */
  update(
    world: SnakeWorld,
    phase: MatchPhase,
    round: number,
    countdownRemainingMs: number,
    connectedCount: number,
    matchWinner: number | null,
    roundWinner: number | null,
  ): void {
    this.updateLines(world, phase);
    this.updateSubtitle(phase, round, matchWinner);
    this.updateStatus(
      world,
      phase,
      countdownRemainingMs,
      connectedCount,
      matchWinner,
      roundWinner,
    );
    this.updatePanels(world, phase, matchWinner, roundWinner);
  }

  private updateLines(world: SnakeWorld, phase: MatchPhase): void {
    const resultsMode = phase === "results" ? 1 : 0;
    for (let index = 0; index < SLOT_COUNT; index += 1) {
      const snake = world.snakes[index];
      if (snake === undefined || !snake.participating) {
        if (this.lineKeys[index] !== -1) {
          this.lineKeys[index] = -1;
          this.lines[index] = "";
        }
        continue;
      }
      const key = resultsMode * 8192 + (snake.alive ? 1 : 0) * 4096 + snake.length;
      if (this.lineKeys[index] === key) continue;
      this.lineKeys[index] = key;
      const label = this.labels[index] ?? "";
      this.lines[index] =
        resultsMode === 1 || snake.alive
          ? `${label}  LEN ${snake.length}`
          : `${label}  OUT`;
    }
  }

  private updateSubtitle(
    phase: MatchPhase,
    round: number,
    matchWinner: number | null,
  ): void {
    const phaseCode =
      phase === "lobby" ? 0 : phase === "countdown" ? 1 : phase === "playing" ? 2 : 3;
    const key =
      phaseCode * 4096 + clampInt(round, 0, 255) * 16 + (matchWinner ?? 0);
    if (key === this.subtitleKey) return;
    this.subtitleKey = key;

    if (phase === "lobby") {
      this.subtitle = "WAITING FOR PLAYERS";
    } else if (phase === "results") {
      this.subtitle =
        matchWinner === null ? `ROUND ${round} COMPLETE` : "MATCH COMPLETE";
    } else {
      this.subtitle = `ROUND ${round}`;
    }
  }

  private updateStatus(
    world: SnakeWorld,
    phase: MatchPhase,
    countdownRemainingMs: number,
    connectedCount: number,
    matchWinner: number | null,
    roundWinner: number | null,
  ): void {
    if (phase === "lobby") {
      const key = clampInt(connectedCount, 0, this.maxPlayers);
      if (key === this.statusKey) return;
      this.statusKey = key;
      this.status = this.lobbyLabels[key] ?? "";
      return;
    }

    if (phase === "countdown") {
      const label = countdownLabel(countdownRemainingMs);
      const key = 100 + label.charCodeAt(0);
      if (key === this.statusKey) return;
      this.statusKey = key;
      this.status = label;
      return;
    }

    if (phase === "playing") {
      const alive = clampInt(world.aliveCount, 0, SLOT_COUNT);
      const bucket =
        world.wallInset >= world.maxInset
          ? 16
          : clampInt(Math.ceil(world.shrinkRemainingMs / 1000), 0, 15);
      const key = 200 + alive * 32 + bucket;
      if (key === this.statusKey) return;
      this.statusKey = key;
      this.status = `${this.liveLabels[alive] ?? ""} · ${
        this.shrinkLabels[bucket] ?? ""
      }`;
      return;
    }

    const decided = matchWinner === null ? 0 : 1;
    const winner = clampInt(matchWinner ?? roundWinner ?? 0, 0, SLOT_COUNT);
    const key = 600 + decided * 16 + winner;
    if (key === this.statusKey) return;
    this.statusKey = key;
    if (matchWinner !== null) {
      this.status = this.matchWinLabels[matchWinner] ?? DRAW_LABEL;
    } else if (roundWinner !== null) {
      this.status = this.roundWinLabels[roundWinner] ?? DRAW_LABEL;
    } else {
      this.status = DRAW_LABEL;
    }
  }

  private updatePanels(
    world: SnakeWorld,
    phase: MatchPhase,
    matchWinner: number | null,
    roundWinner: number | null,
  ): void {
    for (let index = 0; index < SLOT_COUNT; index += 1) {
      const snake = world.snakes[index];
      let code: number;
      let length = 0;
      let direction = 0;

      if (snake === undefined || !snake.participating) {
        code = PANEL_SPECTATE;
      } else if (phase === "lobby" || phase === "countdown") {
        code = PANEL_READY;
      } else if (phase === "playing") {
        if (snake.alive) {
          code = PANEL_ALIVE;
          length = snake.length;
          direction = clampInt(snake.direction, 0, 3);
        } else {
          code = PANEL_OUT;
          length = snake.length;
        }
      } else if (matchWinner !== null) {
        code = matchWinner === snake.slot ? PANEL_MATCH_WIN : PANEL_MATCH_OVER;
      } else if (roundWinner === null) {
        code = PANEL_DRAW;
      } else {
        code = roundWinner === snake.slot ? PANEL_ROUND_WIN : PANEL_ROUND_OVER;
      }

      const key = code * 16384 + length * 4 + direction;
      if (this.panelKeys[index] === key) continue;
      this.panelKeys[index] = key;
      this.panelTexts[index] = this.panelText(code, length, direction);
    }
  }

  private panelText(code: number, length: number, direction: number): string {
    switch (code) {
      case PANEL_SPECTATE:
        return "SPECTATING";
      case PANEL_READY:
        return "GET READY";
      case PANEL_ALIVE:
        return `ALIVE · LEN ${length} · ${ARROWS[direction] ?? ""}`;
      case PANEL_OUT:
        return `ELIMINATED · LEN ${length}`;
      case PANEL_MATCH_WIN:
        return "YOU WIN THE MATCH";
      case PANEL_MATCH_OVER:
        return "MATCH OVER";
      case PANEL_ROUND_WIN:
        return "YOU WIN THE ROUND";
      case PANEL_DRAW:
        return DRAW_LABEL;
      default:
        return "ROUND OVER";
    }
  }
}
