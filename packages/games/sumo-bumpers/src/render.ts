/**
 * Sumo Bumpers presentation (GAME-SB-HOST-03; GAME-SB-DATA-02).
 *
 * The game never touches a canvas. `GameRenderer3D` does not declare the flat
 * 2D surface, so this module feature-detects the same calls the Canvas2D
 * backend implements (`clear`, `rect`, `circle`, `text`) exactly like Coin
 * Run, and draws nothing when the active backend has no 2D surface.
 *
 * Everything is normalized to the smaller surface dimension: the arena centre
 * maps to the surface centre and `unit = min(width, height)`. A 1200x720
 * surface and a 720x1200 surface therefore show the same arena — only the
 * letterbox differs. A surface that reports no size (a hand-built fake or a
 * 3D-only backend) draws in a 720x720 design square. Coordinates and text
 * sizes are derived from `unit`; there are no pixel constants.
 *
 * `drawSumo` loops with plain `for` statements and reads a render state the
 * game refills in place, so a frame allocates nothing after warm-up.
 */
import type { GameRenderer3D } from "@lanpad/sdk";
import { playerColor } from "@lanpad/game-kit";
import type { SumoHud } from "./hud.js";

/** CSS size a backend may report; absent on test doubles. */
export interface RendererSize {
  readonly width: number;
  readonly height: number;
}

/** The flat 2D calls a Canvas2D backend exposes. */
export interface Renderer2DLike {
  beginFrame(alpha: number): void;
  endFrame(): void;
  clear(color: string): void;
  rect(x: number, y: number, w: number, h: number, color: string): void;
  circle(x: number, y: number, r: number, color: string): void;
  text(
    text: string,
    x: number,
    y: number,
    size: number,
    color: string,
    align?: "left" | "center" | "right",
  ): void;
  /** Actual CSS size; the game scales its normalized arena to it. */
  readonly size?: RendererSize;
}

/**
 * Returns the flat drawing surface when the active backend provides one.
 * `Canvas2DRenderer` implements it; `WebGL2Renderer` does not yet.
 */
export function resolveRenderer2D(renderer: GameRenderer3D): Renderer2DLike | null {
  const candidate = renderer as unknown as Partial<Renderer2DLike>;
  if (
    typeof candidate.beginFrame === "function" &&
    typeof candidate.endFrame === "function" &&
    typeof candidate.clear === "function" &&
    typeof candidate.rect === "function" &&
    typeof candidate.circle === "function" &&
    typeof candidate.text === "function"
  ) {
    return candidate as Renderer2DLike;
  }
  return null;
}

/** Round-flow phase rendered by the overlay (mirrors the match phases). */
export type SumoPhase = "lobby" | "countdown" | "playing" | "results";

/** One bumper as the renderer sees it; reused by the game per slot. */
export interface SumoBumperView {
  slot: number;
  x: number;
  y: number;
  radius: number;
  /** False means the slot has no bumper this frame. */
  active: boolean;
  connected: boolean;
  dashing: boolean;
}

/** One results row; built once when a round ends, then read per frame. */
export interface SumoResultsRowView {
  slot: number;
  wins: number;
  label: string;
  color: string;
  winner: boolean;
}

/** Everything `drawSumo` reads; owned and reused by the game. */
export interface SumoRenderState {
  phase: SumoPhase;
  /** Round to label; 0 in the lobby. */
  round: number;
  /** Current floor radius, normalized to the short surface side. */
  arenaRadius: number;
  /** Starting floor radius, for the shrink indicator. */
  arenaStartR: number;
  readonly maxPlayers: number;
  /** Bumpers still in play (including a disconnected body in its grace). */
  activeCount: number;
  /** One bit per connected slot (bit N = slot N). */
  connectedMask: number;
  /** Milliseconds left in the countdown; 0 outside it. */
  countdownMs: number;
  readonly hud: SumoHud;
  /** Fixed length `maxPlayers`, indexed slot - 1. */
  readonly bumpers: SumoBumperView[];
  /** Round wins indexed slot - 1. */
  readonly wins: number[];
  readonly resultsRows: SumoResultsRowView[];
  resultsCount: number;
  roundWinnerSlot: number | null;
  matchWinnerSlot: number | null;
}

/** Fallback design side when a backend reports no surface size. */
const DESIGN_SIZE = 720;

// DESIGN.md true-black tokens: the floor glow is the brightest element, so
// the arena reads on a TV in a bright room.
const BACKGROUND = "#000000"; // --ground
const FLOOR = "#161616"; // --rule
const ARENA_RIM = "#2a2a2a"; // --raised
const WARN_RIM = "#ff6b6b"; // game accent
const CENTER_MARK = "#444444"; // --control
const FOREGROUND = "#ffffff"; // --text
const MUTED = "#b4b4b4"; // --muted
const ACCENT = "#ff6b6b"; // game accent
const ON_PLAYER = "#000000"; // --ground
const DRAW_TITLE = "DRAW";

/** Draws one frame. `alpha` is forwarded to `beginFrame`; the sim is fixed-step. */
export function drawSumo(
  surface: Renderer2DLike,
  state: SumoRenderState,
  alpha: number,
): void {
  const surfaceSize = surface.size;
  let width = DESIGN_SIZE;
  let height = DESIGN_SIZE;
  if (surfaceSize !== undefined) {
    const candidateWidth = surfaceSize.width;
    const candidateHeight = surfaceSize.height;
    if (
      Number.isFinite(candidateWidth) &&
      candidateWidth > 0 &&
      Number.isFinite(candidateHeight) &&
      candidateHeight > 0
    ) {
      width = candidateWidth;
      height = candidateHeight;
    }
  }
  const unit = Math.min(width, height);
  const centerX = width / 2;
  const centerY = height / 2;

  surface.beginFrame(alpha);
  surface.clear(BACKGROUND);

  // Floor: a filled rim circle under a filled floor circle. Shrinking is
  // monotonic, so the floor never grows back mid-round.
  const arenaPixels = Math.max(0, state.arenaRadius * unit);
  const rimPixels = Math.max(2, unit * 0.008);
  const shrinking = state.arenaRadius <= state.arenaStartR * 0.55;
  surface.circle(centerX, centerY, arenaPixels, shrinking ? WARN_RIM : ARENA_RIM);
  const floorPixels = arenaPixels - rimPixels;
  if (floorPixels > 0) {
    surface.circle(centerX, centerY, floorPixels, FLOOR);
  }
  surface.circle(centerX, centerY, unit * 0.018, CENTER_MARK);

  const bumpers = state.bumpers;
  for (let index = 0; index < bumpers.length; index += 1) {
    const bumper = bumpers[index];
    if (bumper === undefined || !bumper.active) continue;
    const x = centerX + bumper.x * unit;
    const y = centerY + bumper.y * unit;
    const radius = bumper.radius * unit;
    if (bumper.dashing) {
      surface.circle(x, y, radius + unit * 0.01, ACCENT);
    }
    surface.circle(x, y, radius, bumper.connected ? playerColor(bumper.slot) : MUTED);
    surface.text(
      state.hud.label(bumper.slot),
      x,
      y,
      Math.min(unit * 0.032, radius * 1.1),
      ON_PLAYER,
      "center",
    );
  }

  drawHud(surface, state, unit, centerX, centerY);
  drawOverlay(surface, state, unit, centerX, centerY);

  surface.endFrame();
}

/** Round, floor, alive count and the win table; drawn in every phase. */
function drawHud(
  surface: Renderer2DLike,
  state: SumoRenderState,
  unit: number,
  centerX: number,
  centerY: number,
): void {
  const margin = unit * 0.035;
  const left = centerX - unit / 2 + margin;
  const right = centerX + unit / 2 - margin;
  const top = centerY - unit / 2 + margin + unit * 0.035;
  const hudSize = unit * 0.032;
  const hud = state.hud;

  surface.text(hud.roundLine(state.round), left, top, hudSize, FOREGROUND, "left");
  const floorPercent = Math.round((state.arenaRadius / state.arenaStartR) * 100);
  surface.text(hud.floorLine(floorPercent), right, top, hudSize, MUTED, "right");
  surface.text(
    hud.aliveLine(state.activeCount),
    left,
    top + unit * 0.045,
    hudSize,
    state.activeCount <= 2 ? ACCENT : MUTED,
    "left",
  );

  // Win table: connected slots, plus any slot that already scored this match.
  let row = 0;
  for (let slot = 1; slot <= state.maxPlayers; slot += 1) {
    const wins = state.wins[slot - 1] ?? 0;
    const connected = (state.connectedMask & (1 << slot)) !== 0;
    if (!connected && wins === 0) continue;
    surface.text(
      hud.scoreLine(slot, wins),
      left,
      top + unit * (0.1 + row * 0.04),
      unit * 0.028,
      wins > 0 ? FOREGROUND : MUTED,
      "left",
    );
    row += 1;
  }
}

/** Lobby, countdown and results overlays. */
function drawOverlay(
  surface: Renderer2DLike,
  state: SumoRenderState,
  unit: number,
  centerX: number,
  centerY: number,
): void {
  const hud = state.hud;
  switch (state.phase) {
    case "lobby": {
      surface.text(
        hud.title,
        centerX,
        centerY - unit * 0.2,
        unit * 0.075,
        FOREGROUND,
        "center",
      );
      surface.text(
        hud.waitingLine(countBits(state.connectedMask)),
        centerX,
        centerY,
        unit * 0.045,
        MUTED,
        "center",
      );
      surface.text(
        hud.hint,
        centerX,
        centerY + unit * 0.12,
        unit * 0.03,
        MUTED,
        "center",
      );
      break;
    }
    case "countdown": {
      surface.text(
        hud.roundLine(state.round),
        centerX,
        centerY - unit * 0.2,
        unit * 0.05,
        FOREGROUND,
        "center",
      );
      surface.text(
        hud.countdown(state.countdownMs),
        centerX,
        centerY + unit * 0.08,
        unit * 0.22,
        ACCENT,
        "center",
      );
      surface.text(
        hud.hint,
        centerX,
        centerY + unit * 0.32,
        unit * 0.03,
        MUTED,
        "center",
      );
      break;
    }
    case "results": {
      const matchWinner = state.matchWinnerSlot;
      const roundWinner = state.roundWinnerSlot;
      const title =
        matchWinner !== null
          ? hud.matchWinnerLine(matchWinner)
          : roundWinner !== null
            ? hud.roundWinnerLine(roundWinner)
            : DRAW_TITLE;
      surface.text(
        title,
        centerX,
        centerY - unit * 0.3,
        unit * 0.06,
        FOREGROUND,
        "center",
      );

      const rows = state.resultsRows;
      for (let index = 0; index < state.resultsCount; index += 1) {
        const result = rows[index];
        if (result === undefined) continue;
        const y = centerY - unit * (0.14 - index * 0.065);
        surface.circle(
          centerX - unit * 0.19,
          y,
          unit * 0.014,
          result.color,
        );
        surface.text(
          hud.scoreLine(result.slot, result.wins),
          centerX,
          y,
          unit * 0.04,
          result.winner ? ACCENT : FOREGROUND,
          "center",
        );
      }

      surface.text(
        hud.resultsHint,
        centerX,
        centerY + unit * 0.33,
        unit * 0.03,
        ACCENT,
        "center",
      );
      surface.text(
        hud.autoHint,
        centerX,
        centerY + unit * 0.38,
        unit * 0.025,
        MUTED,
        "center",
      );
      break;
    }
    case "playing":
    default:
      surface.text(
        hud.hint,
        centerX,
        centerY + unit * 0.46,
        unit * 0.025,
        MUTED,
        "center",
      );
      break;
  }
}

/** Popcount for the connected mask; at most 8 bits. */
function countBits(mask: number): number {
  let value = mask >>> 0;
  let count = 0;
  while (value !== 0) {
    value &= value - 1;
    count += 1;
  }
  return count;
}
