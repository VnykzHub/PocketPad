/**
 * Beat Tap 2D presentation (GAME-BT-HOST-05; FR-9.4, PR-9.1, PR-9.3, PR-9.5).
 *
 * The game never touches a canvas. `GameRenderer3D` does not declare the flat
 * 2D surface, so this module feature-detects the same calls the Canvas2D
 * backend implements (`beginFrame`, `endFrame`, `clear`, `rect`, `circle`,
 * `text`) and draws nothing on a backend without a 2D surface.
 *
 * Four vertical lanes, notes falling to a hit line, one accent per player. The
 * whole frame is 1280x720 design space letterboxed onto the surface's reported
 * CSS size. Draw loops are plain `for`, cull by note delta, and reuse every
 * object and string the game hands in; nothing here allocates per frame.
 */
import type { GameRenderer3D } from "@lanpad/sdk";
import { playerColor } from "@lanpad/game-kit";
import type { ChartNote } from "./chart.js";
import type { BeatTapResults } from "./hud.js";

/** CSS size a backend may report; absent on test doubles (HP-04). */
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
  /** Actual CSS size; the game scales and letterboxes its design space to it. */
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

/** Design-space size; the runtime letterboxes this onto the real surface. */
export const DESIGN_WIDTH = 1280;
export const DESIGN_HEIGHT = 720;

/** Phase rendered by the overlay (includes the game-local pause state). */
export type BeatTapPhase =
  | "lobby"
  | "calibrating"
  | "countdown"
  | "playing"
  | "paused"
  | "results";

/** Calibration overlay data, filled by the game each frame. */
export interface CalibrationView {
  readonly taps: number;
  readonly required: number;
  /** Metronome phase 0..1; ignored when `reducedMotion` is set. */
  readonly pulse: number;
  readonly offsetLine: string;
  /** Cached "TAP n/8" line; never rebuilt in render. */
  readonly line: string;
}

/** Everything `drawBeatTap` reads; owned and reused by the game. */
export interface BeatTapRenderState {
  readonly phase: BeatTapPhase;
  readonly chartTitle: string;
  readonly songTimeMs: number;
  readonly durationMs: number;
  readonly beatMs: number;
  readonly approachMs: number;
  readonly missMs: number;
  /** Slot owning each lane, 0 when unowned. */
  readonly laneOwner: readonly number[];
  /** Roster slots in rank order. */
  readonly roster: readonly number[];
  readonly notes: readonly ChartNote[];
  /** 1 = judged; parallel to `notes`. */
  readonly judged: Uint8Array;
  /** Cached score lines parallel to `roster`. */
  readonly scoreLines: readonly string[];
  readonly comboLine: string;
  readonly countdownLabel: string;
  readonly judgmentLine: string;
  readonly calibration: CalibrationView | null;
  readonly results: BeatTapResults | null;
  readonly messageLine: string;
  readonly offsetLine: string;
  readonly reducedMotion: boolean;
}

/* True-black stage with one accent per lane; the notes are the bright thing. */
const BACKGROUND = "#000000";
const LANE_BG = "#0d0d12";
const LANE_RULE = "#1b1b22";
const HIT_LINE = "#ffffff";
const NOTE_EDGE = "#08080c";
const FOREGROUND = "#ffffff";
const MUTED = "#b4b4b4";
const ACCENT = "#c6f24e";
const FREE_LANE = "#3a3a44";

const HUD_X = 28;
const HUD_TOP = 42;
const LANE_WIDTH = 150;
const LANE_GAP = 16;
const LANE_COUNT = 4;
const BOARD_WIDTH = LANE_COUNT * LANE_WIDTH + (LANE_COUNT - 1) * LANE_GAP;
const BOARD_LEFT = (DESIGN_WIDTH - BOARD_WIDTH) / 2;
const LANE_TOP = 96;
const HIT_LINE_Y = 600;
const NOTE_HEIGHT = 22;

function laneX(index: number): number {
  return BOARD_LEFT + index * (LANE_WIDTH + LANE_GAP);
}

function laneColor(slot: number): string {
  return slot > 0 ? playerColor(slot) : FREE_LANE;
}

/**
 * Draws one frame. Draw order: lane board, live notes, hit line and beat pulse,
 * HUD, then the phase overlay. `alpha` is forwarded to `beginFrame`; the
 * simulation is fixed-step, so no interpolation state is kept in Minimal.
 */
export function drawBeatTap(
  surface: Renderer2DLike,
  state: BeatTapRenderState,
  alpha: number,
): void {
  const surfaceSize = surface.size;
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  if (surfaceSize !== undefined) {
    const surfaceWidth = surfaceSize.width;
    const surfaceHeight = surfaceSize.height;
    if (
      Number.isFinite(surfaceWidth) &&
      surfaceWidth > 0 &&
      Number.isFinite(surfaceHeight) &&
      surfaceHeight > 0
    ) {
      const fitX = surfaceWidth / DESIGN_WIDTH;
      const fitY = surfaceHeight / DESIGN_HEIGHT;
      scale = fitX < fitY ? fitX : fitY;
      offsetX = (surfaceWidth - DESIGN_WIDTH * scale) / 2;
      offsetY = (surfaceHeight - DESIGN_HEIGHT * scale) / 2;
    }
  }

  surface.beginFrame(alpha);
  surface.clear(BACKGROUND);

  const playing = state.phase === "playing" || state.phase === "paused";
  drawBoard(surface, state, scale, offsetX, offsetY, playing);
  drawHud(surface, state, scale, offsetX, offsetY, playing);
  drawOverlay(surface, state, scale, offsetX, offsetY);
  surface.endFrame();
}

function drawBoard(
  surface: Renderer2DLike,
  state: BeatTapRenderState,
  scale: number,
  offsetX: number,
  offsetY: number,
  playing: boolean,
): void {
  for (let lane = 0; lane < LANE_COUNT; lane += 1) {
    const x = offsetX + laneX(lane) * scale;
    const width = LANE_WIDTH * scale;
    surface.rect(x, offsetY + LANE_TOP * scale, width, (HIT_LINE_Y - LANE_TOP) * scale, LANE_BG);
    const owner = state.laneOwner[lane] ?? 0;
    surface.rect(x, offsetY + LANE_TOP * scale, width, 5 * scale, laneColor(owner));
  }

  // Lane rules sit between the columns, outside the note travel.
  for (let lane = 1; lane < LANE_COUNT; lane += 1) {
    const x = offsetX + (laneX(lane) - LANE_GAP / 2 - 1) * scale;
    surface.rect(x, offsetY + LANE_TOP * scale, 2 * scale, (HIT_LINE_Y - LANE_TOP) * scale, LANE_RULE);
  }

  if (playing) {
    drawNotes(surface, state, scale, offsetX, offsetY);
  }

  surface.rect(
    offsetX + BOARD_LEFT * scale,
    offsetY + HIT_LINE_Y * scale,
    BOARD_WIDTH * scale,
    Math.max(2, 4 * scale),
    HIT_LINE,
  );

  // Beat pulse: height collapses toward the hit line on each beat. The
  // reduced-motion path keeps a fixed bar so the stage stays calm.
  let pulse = 0;
  if (state.beatMs > 0) {
    const phase = ((state.songTimeMs % state.beatMs) + state.beatMs) % state.beatMs;
    pulse = 1 - phase / state.beatMs;
  }
  const pulseHeight = state.reducedMotion ? 2 : 2 + pulse * 10;
  surface.rect(
    offsetX + BOARD_LEFT * scale,
    offsetY + (HIT_LINE_Y - pulseHeight) * scale,
    BOARD_WIDTH * scale,
    pulseHeight * scale,
    ACCENT,
  );
}

function drawNotes(
  surface: Renderer2DLike,
  state: BeatTapRenderState,
  scale: number,
  offsetX: number,
  offsetY: number,
): void {
  const travel = HIT_LINE_Y - LANE_TOP;
  const notes = state.notes;
  for (let index = 0; index < notes.length; index += 1) {
    const note = notes[index];
    if (note === undefined) continue;
    if (index < state.judged.length && state.judged[index] === 1) continue;
    const deltaMs = note.timeMs - state.songTimeMs;
    if (deltaMs > state.approachMs || deltaMs < -state.missMs) continue;
    const lane = note.lane;
    if (lane < 0 || lane >= LANE_COUNT) continue;
    const y = HIT_LINE_Y - (deltaMs / state.approachMs) * travel;
    const owner = state.laneOwner[lane] ?? 0;
    const x = offsetX + (laneX(lane) + 10) * scale;
    const width = (LANE_WIDTH - 20) * scale;
    surface.rect(x, offsetY + (y - NOTE_HEIGHT / 2) * scale, width, NOTE_HEIGHT * scale, NOTE_EDGE);
    surface.rect(
      x + 2 * scale,
      offsetY + (y - NOTE_HEIGHT / 2 + 2) * scale,
      width - 4 * scale,
      (NOTE_HEIGHT - 4) * scale,
      laneColor(owner),
    );
  }
}

function drawHud(
  surface: Renderer2DLike,
  state: BeatTapRenderState,
  scale: number,
  offsetX: number,
  offsetY: number,
  playing: boolean,
): void {
  surface.text(
    state.chartTitle,
    offsetX + (DESIGN_WIDTH / 2) * scale,
    offsetY + HUD_TOP * scale,
    30 * scale,
    FOREGROUND,
    "center",
  );
  surface.text(
    state.offsetLine,
    offsetX + (DESIGN_WIDTH - HUD_X) * scale,
    offsetY + HUD_TOP * scale,
    22 * scale,
    MUTED,
    "right",
  );

  if (!playing) {
    return;
  }

  const roster = state.roster;
  for (let rank = 0; rank < roster.length; rank += 1) {
    const line = state.scoreLines[rank];
    if (line === undefined || line.length === 0) continue;
    surface.text(
      line,
      offsetX + HUD_X * scale,
      offsetY + (HUD_TOP + 34 + rank * 30) * scale,
      24 * scale,
      MUTED,
      "left",
    );
  }

  if (state.comboLine.length > 0) {
    surface.text(
      state.comboLine,
      offsetX + (DESIGN_WIDTH / 2) * scale,
      offsetY + (HUD_TOP + 58) * scale,
      30 * scale,
      ACCENT,
      "center",
    );
  }

  if (state.judgmentLine.length > 0) {
    surface.text(
      state.judgmentLine,
      offsetX + (DESIGN_WIDTH / 2) * scale,
      offsetY + (HIT_LINE_Y - 64) * scale,
      34 * scale,
      ACCENT,
      "center",
    );
  }
}

function drawOverlay(
  surface: Renderer2DLike,
  state: BeatTapRenderState,
  scale: number,
  offsetX: number,
  offsetY: number,
): void {
  const center = offsetX + (DESIGN_WIDTH / 2) * scale;
  switch (state.phase) {
    case "lobby":
      surface.text("BEAT TAP", center, offsetY + 260 * scale, 64 * scale, FOREGROUND, "center");
      surface.text(
        "Waiting for players",
        center,
        offsetY + 334 * scale,
        34 * scale,
        MUTED,
        "center",
      );
      surface.text(
        "Tap CAL on your phone to calibrate",
        center,
        offsetY + 392 * scale,
        26 * scale,
        MUTED,
        "center",
      );
      surface.text(
        "The song starts automatically",
        center,
        offsetY + 436 * scale,
        24 * scale,
        MUTED,
        "center",
      );
      if (state.messageLine.length > 0) {
        surface.text(
          state.messageLine,
          center,
          offsetY + 520 * scale,
          26 * scale,
          ACCENT,
          "center",
        );
      }
      break;
    case "calibrating": {
      const calibration = state.calibration;
      if (calibration === null) break;
      surface.text(
        "CALIBRATE",
        center,
        offsetY + 220 * scale,
        54 * scale,
        FOREGROUND,
        "center",
      );
      surface.text(
        "Tap on every beat",
        center,
        offsetY + 282 * scale,
        32 * scale,
        MUTED,
        "center",
      );
      const radius =
        state.reducedMotion || calibration.pulse <= 0
          ? 34
          : 26 + (1 - calibration.pulse) * 34;
      surface.circle(center, offsetY + 430 * scale, radius * scale, ACCENT);
      surface.text(
        calibration.line,
        center,
        offsetY + 526 * scale,
        32 * scale,
        FOREGROUND,
        "center",
      );
      surface.text(
        calibration.offsetLine,
        center,
        offsetY + 572 * scale,
        26 * scale,
        MUTED,
        "center",
      );
      break;
    }
    case "countdown":
      surface.text(
        "Get ready",
        center,
        offsetY + 280 * scale,
        40 * scale,
        MUTED,
        "center",
      );
      surface.text(
        state.countdownLabel,
        center,
        offsetY + 430 * scale,
        140 * scale,
        ACCENT,
        "center",
      );
      break;
    case "paused":
      surface.text("PAUSED", center, offsetY + 330 * scale, 72 * scale, FOREGROUND, "center");
      surface.text(
        "Waiting for a player to reconnect",
        center,
        offsetY + 410 * scale,
        30 * scale,
        MUTED,
        "center",
      );
      break;
    case "results": {
      const results = state.results;
      if (results === null) break;
      surface.text(
        results.title,
        center,
        offsetY + 150 * scale,
        56 * scale,
        FOREGROUND,
        "center",
      );
      surface.text(
        results.winnerLine,
        center,
        offsetY + 224 * scale,
        40 * scale,
        ACCENT,
        "center",
      );
      let row = 0;
      for (let index = 0; index < results.playerLines.length; index += 1) {
        const line = results.playerLines[index];
        if (line === undefined) continue;
        surface.text(
          line,
          center,
          offsetY + (300 + row * 34) * scale,
          28 * scale,
          FOREGROUND,
          "center",
        );
        row += 1;
      }
      surface.text(
        results.hintLine,
        center,
        offsetY + (DESIGN_HEIGHT - 120) * scale,
        30 * scale,
        ACCENT,
        "center",
      );
      if (state.messageLine.length > 0) {
        surface.text(
          state.messageLine,
          center,
          offsetY + (DESIGN_HEIGHT - 74) * scale,
          24 * scale,
          MUTED,
          "center",
        );
      }
      break;
    }
    case "playing":
    default:
      break;
  }
}
