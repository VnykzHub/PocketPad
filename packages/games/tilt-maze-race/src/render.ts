/**
 * Tilt Maze Race flat 2D presentation (GAME-TM-HOST-03/04; GAME-TM-PERF-01;
 * FR-9.1, PR-9.3).
 *
 * `GameRenderer3D` does not declare a flat 2D surface, so the surface is
 * feature-detected from the calls the Canvas2D backend implements (`clear`,
 * `rect`, `circle`, `text`), exactly as Snake Royale and Coin Run do. A backend
 * without a 2D surface draws nothing; the simulation still runs.
 *
 * The frame is authored in a 1280x720 design space and scaled/letterboxed to
 * the surface's reported size. The maze is fitted whole into a fixed board
 * area, preserving its aspect ratio (GAME-TM-HOST-03). Balls interpolate
 * between the last two logic steps with `alpha`; the simulation is never
 * mutated for rendering.
 *
 * Draw calls stay well under the 120-call budget for eight players: one board,
 * a handful of walls and markers, one circle per ball, and the HUD. Strings are
 * constants or HUD-cache output, so the frame path allocates nothing.
 */
import { countdownLabel, playerColor, type MatchPhase } from "@lanpad/game-kit";
import type { GameRenderer3D } from "@lanpad/sdk";
import { DESIGN_HEIGHT, DESIGN_WIDTH, SLOT_COUNT, exitRadius } from "./config.js";
import type { TiltMazeHud } from "./hud.js";
import type { TiltMazeWorld } from "./world.js";

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
  readonly size?: RendererSize;
}

/** Returns the flat drawing surface when the active backend provides one. */
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

const BOARD_AREA_X = 40;
const BOARD_AREA_Y = 88;
const BOARD_AREA_W = 840;
const BOARD_AREA_H = 560;
const HUD_X = 920;
const HUD_TITLE_Y = 122;
const HUD_SUBTITLE_Y = 154;
const HUD_LINE_START = 202;
const HUD_LINE_STEP = 40;
const HUD_STATUS_Y = 560;
const HUD_INSTRUCTIONS_Y = 596;
const HUD_RECENTER_Y = 622;

const BACKGROUND = "#08080c";
const BOARD = "#12121a";
const BOARD_BORDER = "#2b2b3a";
const WALL = "#3a3a4d";
const START = "#55556a";
const EXIT_GLOW = "#ffd166";
const EXIT_CORE = "#fff3c4";
const TEXT = "#f4f4f8";
const MUTED = "#a0a0b0";
const ACCENT = "#ff9f45";
const OVERLAY = "#08080c";

const WAITING = "WAITING FOR PLAYERS";
const GET_READY = "GET READY";
const RESULTS = "RESULTS";
const TAP_REMATCH = "TAP TO PLAY AGAIN";
const RECENTER_HINT = "Recenter on the phone levels the tilt.";

/** Prebuilt ball labels so the frame path never formats a number. */
const BALL_LABELS = ["1", "2", "3", "4", "5", "6", "7", "8"];

/** Everything the draw function reads; owned and reused by the game. */
export interface TiltMazeRenderState {
  readonly world: TiltMazeWorld;
  readonly hud: TiltMazeHud;
  readonly phase: MatchPhase;
  readonly countdownRemainingMs: number;
  readonly matchWinner: number | null;
}

function clampAlpha(alpha: number): number {
  if (!Number.isFinite(alpha)) return 1;
  return alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
}

function drawResultRow(
  surface: Renderer2DLike,
  scale: number,
  offsetX: number,
  offsetY: number,
  x: number,
  y: number,
  slot: number,
  line: string,
  highlight: boolean,
): void {
  surface.rect(
    offsetX + x * scale,
    offsetY + (y - 10) * scale,
    10 * scale,
    10 * scale,
    playerColor(slot),
  );
  surface.text(
    line,
    offsetX + (x + 20) * scale,
    offsetY + y * scale,
    18 * scale,
    highlight ? ACCENT : TEXT,
  );
}

/**
 * Draws one frame. `alpha` is the host fixed-loop fraction of a 16.7 ms tick.
 */
export function drawTiltMazeRace(
  surface: Renderer2DLike,
  state: TiltMazeRenderState,
  alpha: number,
): void {
  const world = state.world;
  const hud = state.hud;
  const maze = world.maze;
  const ballRadius = world.config.ballRadius;
  const blend = clampAlpha(alpha);

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

  // Fit the whole maze into the board area, preserving aspect (HOST-03).
  const fit = Math.min(BOARD_AREA_W / maze.width, BOARD_AREA_H / maze.height);
  const boardW = maze.width * fit;
  const boardH = maze.height * fit;
  const boardX = BOARD_AREA_X + (BOARD_AREA_W - boardW) / 2;
  const boardY = BOARD_AREA_Y + (BOARD_AREA_H - boardH) / 2;
  const centerX = boardX + boardW / 2;
  const centerY = boardY + boardH / 2;

  surface.beginFrame(alpha);
  surface.clear(BACKGROUND);

  surface.rect(
    offsetX + boardX * scale,
    offsetY + boardY * scale,
    boardW * scale,
    boardH * scale,
    BOARD,
  );
  // 2 px design-space border; four rects keeps the call count predictable.
  surface.rect(
    offsetX + (boardX - 2) * scale,
    offsetY + (boardY - 2) * scale,
    (boardW + 4) * scale,
    2 * scale,
    BOARD_BORDER,
  );
  surface.rect(
    offsetX + (boardX - 2) * scale,
    offsetY + (boardY + boardH) * scale,
    (boardW + 4) * scale,
    2 * scale,
    BOARD_BORDER,
  );
  surface.rect(
    offsetX + (boardX - 2) * scale,
    offsetY + boardY * scale,
    2 * scale,
    boardH * scale,
    BOARD_BORDER,
  );
  surface.rect(
    offsetX + (boardX + boardW) * scale,
    offsetY + boardY * scale,
    2 * scale,
    boardH * scale,
    BOARD_BORDER,
  );

  for (let index = 0; index < maze.walls.length; index += 1) {
    const wall = maze.walls[index];
    if (wall === undefined) continue;
    surface.rect(
      offsetX + (boardX + wall.x * fit) * scale,
      offsetY + (boardY + wall.y * fit) * scale,
      wall.w * fit * scale,
      wall.h * fit * scale,
      WALL,
    );
  }

  const exitRadiusUnits = exitRadius(world.config);
  const exitX = boardX + maze.exit.x * fit;
  const exitY = boardY + maze.exit.y * fit;
  surface.circle(
    offsetX + exitX * scale,
    offsetY + exitY * scale,
    exitRadiusUnits * fit * scale,
    EXIT_GLOW,
  );
  surface.circle(
    offsetX + exitX * scale,
    offsetY + exitY * scale,
    ballRadius * 0.45 * fit * scale,
    EXIT_CORE,
  );

  // Start markers stay visible through the lobby and countdown.
  if (state.phase === "lobby" || state.phase === "countdown") {
    for (let index = 0; index < maze.start.length; index += 1) {
      const start = maze.start[index];
      if (start === undefined) continue;
      surface.circle(
        offsetX + (boardX + start.x * fit) * scale,
        offsetY + (boardY + start.y * fit) * scale,
        ballRadius * 0.6 * fit * scale,
        START,
      );
    }
  }

  // Balls: interpolated between the last two fixed steps.
  for (let slot = 1; slot <= SLOT_COUNT; slot += 1) {
    const ball = world.ball(slot);
    if (ball === undefined || !ball.active) continue;
    const x = boardX + (ball.prevX + (ball.x - ball.prevX) * blend) * fit;
    const y = boardY + (ball.prevY + (ball.y - ball.prevY) * blend) * fit;
    const radius = ballRadius * fit * scale;
    surface.circle(offsetX + x * scale, offsetY + y * scale, radius, playerColor(slot));
    const label = BALL_LABELS[slot - 1];
    if (radius >= 7 && label !== undefined) {
      surface.text(
        label,
        offsetX + x * scale,
        offsetY + (y + ballRadius * 0.35 * fit) * scale,
        12 * fit * scale,
        OVERLAY,
        "center",
      );
    }
  }

  // Right-hand HUD: title, subtitle, one line per slot, status and hints.
  surface.text(
    hud.title,
    offsetX + HUD_X * scale,
    offsetY + HUD_TITLE_Y * scale,
    34 * scale,
    TEXT,
  );
  surface.text(
    hud.subtitle,
    offsetX + HUD_X * scale,
    offsetY + HUD_SUBTITLE_Y * scale,
    18 * scale,
    MUTED,
  );
  for (let slot = 1; slot <= SLOT_COUNT; slot += 1) {
    const line = hud.lines[slot - 1];
    if (line === undefined || line === "") continue;
    const y = HUD_LINE_START + (slot - 1) * HUD_LINE_STEP;
    surface.rect(
      offsetX + HUD_X * scale,
      offsetY + (y - 12) * scale,
      10 * scale,
      10 * scale,
      playerColor(slot),
    );
    surface.text(
      line,
      offsetX + (HUD_X + 20) * scale,
      offsetY + y * scale,
      18 * scale,
      TEXT,
    );
  }
  surface.text(
    hud.status,
    offsetX + HUD_X * scale,
    offsetY + HUD_STATUS_Y * scale,
    22 * scale,
    ACCENT,
  );
  surface.text(
    hud.instructions,
    offsetX + HUD_X * scale,
    offsetY + HUD_INSTRUCTIONS_Y * scale,
    15 * scale,
    MUTED,
  );
  surface.text(
    RECENTER_HINT,
    offsetX + HUD_X * scale,
    offsetY + HUD_RECENTER_Y * scale,
    15 * scale,
    MUTED,
  );

  if (state.phase === "lobby") {
    surface.text(
      WAITING,
      offsetX + centerX * scale,
      offsetY + (centerY - 34) * scale,
      30 * scale,
      TEXT,
      "center",
    );
    surface.text(
      hud.status,
      offsetX + centerX * scale,
      offsetY + (centerY + 8) * scale,
      22 * scale,
      ACCENT,
      "center",
    );
  } else if (state.phase === "countdown") {
    surface.text(
      GET_READY,
      offsetX + centerX * scale,
      offsetY + (centerY - 100) * scale,
      26 * scale,
      MUTED,
      "center",
    );
    surface.text(
      countdownLabel(state.countdownRemainingMs),
      offsetX + centerX * scale,
      offsetY + (centerY + 40) * scale,
      120 * fit * scale,
      ACCENT,
      "center",
    );
    surface.text(
      hud.subtitle,
      offsetX + centerX * scale,
      offsetY + (centerY + 96) * scale,
      22 * scale,
      TEXT,
      "center",
    );
  } else if (state.phase === "results") {
    let rowCount = 0;
    for (let slot = 1; slot <= SLOT_COUNT; slot += 1) {
      const ball = world.ball(slot);
      if (ball !== undefined && ball.active) rowCount += 1;
    }
    const panelW = 560;
    const panelH = 110 + rowCount * 32 + 44;
    const panelX = centerX - panelW / 2;
    const panelY = centerY - panelH / 2;
    surface.rect(
      offsetX + panelX * scale,
      offsetY + panelY * scale,
      panelW * scale,
      panelH * scale,
      OVERLAY,
    );
    surface.text(
      RESULTS,
      offsetX + centerX * scale,
      offsetY + (panelY + 44) * scale,
      30 * scale,
      TEXT,
      "center",
    );
    surface.text(
      hud.status,
      offsetX + centerX * scale,
      offsetY + (panelY + 78) * scale,
      20 * scale,
      ACCENT,
      "center",
    );

    let row = 0;
    for (let index = 0; index < world.finishOrder.length; index += 1) {
      const slot = world.finishOrder[index];
      if (slot === undefined) continue;
      const line = hud.lines[slot - 1] ?? "";
      drawResultRow(
        surface,
        scale,
        offsetX,
        offsetY,
        panelX + 78,
        panelY + 118 + row * 32,
        slot,
        line,
        slot === state.matchWinner,
      );
      row += 1;
    }
    for (let slot = 1; slot <= SLOT_COUNT; slot += 1) {
      const ball = world.ball(slot);
      if (ball === undefined || !ball.active || ball.finished) continue;
      const line = hud.lines[slot - 1] ?? "";
      drawResultRow(
        surface,
        scale,
        offsetX,
        offsetY,
        panelX + 78,
        panelY + 118 + row * 32,
        slot,
        line,
        slot === state.matchWinner,
      );
      row += 1;
    }

    surface.text(
      TAP_REMATCH,
      offsetX + centerX * scale,
      offsetY + (panelY + panelH - 22) * scale,
      18 * scale,
      MUTED,
      "center",
    );
  }

  surface.endFrame();
}
