/**
 * Snake Royale flat 2D presentation (GAME-SR-HOST-04; FR-9.1, PR-9.3).
 *
 * `GameRenderer3D` does not declare the flat 2D surface, so this module
 * feature-detects the same calls the Canvas2D backend implements (`clear`,
 * `rect`, `circle`, `text`) exactly as Coin Run does. On a backend without a
 * 2D surface it draws nothing; the game logic still runs.
 *
 * The frame is authored in a 1280x720 design space and scaled/letterboxed to
 * the surface's reported size. Snake segments interpolate between the last two
 * logic steps with `SnakeWorld.renderBlend`, so 8 Hz movement looks smooth at
 * 60 fps without mutating simulation state.
 *
 * The draw loop uses plain `for` statements, the kit's constant colour helper
 * and strings cached by `HudCache`; it allocates nothing per frame.
 */
import {
  countdownLabel,
  playerColor,
  type MatchPhase,
  type ResultsRow,
} from "@lanpad/game-kit";
import type { GameRenderer3D } from "@lanpad/sdk";
import { HUD_TITLE, type HudCache } from "./hud.js";
import type { SnakeWorld } from "./world.js";

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

export const DESIGN_WIDTH = 1280;
export const DESIGN_HEIGHT = 720;

const BOARD_X = 48;
const BOARD_Y = 72;
const BOARD_SIZE = 576;
const BOARD_PAD = 8;
const HUD_X = 664;
const HUD_TOP = 108;
const HUD_LINE_STEP = 40;
const HUD_LINE_START = 188;

const BACKGROUND = "#101014";
const BOARD = "#181820";
const BOARD_BORDER = "#2b2b3a";
const WALL = "#343446";
const GRID = "#20202a";
const FOOD = "#ffd166";
const TEXT = "#f4f4f8";
const MUTED = "#a0a0b0";
const ACCENT = "#4fd1a1";
const OVERLAY = "#0c0c12";

const WAITING = "WAITING FOR PLAYERS";
const READY = "GET READY";
const RESULTS = "RESULTS";
const TAP_CONTINUE = "TAP TO CONTINUE";
const TAP_REMATCH = "TAP TO PLAY AGAIN";

/** Everything the draw function reads; owned and reused by the game. */
export interface SnakeRoyaleRenderState {
  readonly world: SnakeWorld;
  readonly hud: HudCache;
  readonly phase: MatchPhase;
  readonly countdownRemainingMs: number;
  readonly matchWinner: number | null;
  /** Ranked round lengths; `resultsRows` output, reused by the kit. */
  readonly results: readonly ResultsRow[];
}

/**
 * Draws one frame. `alpha` is the host fixed-loop fraction of a 16.7 ms tick.
 */
export function drawSnakeRoyale(
  surface: Renderer2DLike,
  state: SnakeRoyaleRenderState,
  alpha: number,
): void {
  const world = state.world;
  const hud = state.hud;
  const gridSize = world.gridSize;
  const cell = BOARD_SIZE / gridSize;
  const blend = world.renderBlend(alpha);

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

  // Board background and a 2 px border.
  surface.rect(
    offsetX + BOARD_X * scale,
    offsetY + BOARD_Y * scale,
    BOARD_SIZE * scale,
    BOARD_SIZE * scale,
    BOARD,
  );
  surface.rect(
    offsetX + (BOARD_X - 2) * scale,
    offsetY + (BOARD_Y - 2) * scale,
    (BOARD_SIZE + 4) * scale,
    2 * scale,
    BOARD_BORDER,
  );
  surface.rect(
    offsetX + (BOARD_X - 2) * scale,
    offsetY + (BOARD_Y + BOARD_SIZE) * scale,
    (BOARD_SIZE + 4) * scale,
    2 * scale,
    BOARD_BORDER,
  );
  surface.rect(
    offsetX + (BOARD_X - 2) * scale,
    offsetY + BOARD_Y * scale,
    2 * scale,
    BOARD_SIZE * scale,
    BOARD_BORDER,
  );
  surface.rect(
    offsetX + (BOARD_X + BOARD_SIZE) * scale,
    offsetY + BOARD_Y * scale,
    2 * scale,
    BOARD_SIZE * scale,
    BOARD_BORDER,
  );

  // Sparse grid every fourth cell keeps the draw count low.
  for (let line = 4; line < gridSize; line += 4) {
    surface.rect(
      offsetX + (BOARD_X + line * cell) * scale,
      offsetY + BOARD_Y * scale,
      scale,
      BOARD_SIZE * scale,
      GRID,
    );
    surface.rect(
      offsetX + BOARD_X * scale,
      offsetY + (BOARD_Y + line * cell) * scale,
      BOARD_SIZE * scale,
      scale,
      GRID,
    );
  }

  // Shrunk rings: four bands, drawn over the grid.
  const inset = world.wallInset;
  if (inset > 0) {
    const band = inset * cell;
    surface.rect(
      offsetX + BOARD_X * scale,
      offsetY + BOARD_Y * scale,
      BOARD_SIZE * scale,
      band * scale,
      WALL,
    );
    surface.rect(
      offsetX + BOARD_X * scale,
      offsetY + (BOARD_Y + BOARD_SIZE - band) * scale,
      BOARD_SIZE * scale,
      band * scale,
      WALL,
    );
    surface.rect(
      offsetX + BOARD_X * scale,
      offsetY + (BOARD_Y + band) * scale,
      band * scale,
      (BOARD_SIZE - 2 * band) * scale,
      WALL,
    );
    surface.rect(
      offsetX + (BOARD_X + BOARD_SIZE - band) * scale,
      offsetY + (BOARD_Y + band) * scale,
      band * scale,
      (BOARD_SIZE - 2 * band) * scale,
      WALL,
    );
  }

  // Food: warm dot with a dark centre.
  for (let index = 0; index < world.activeFoodCount; index += 1) {
    const x = BOARD_X + (world.foodX(index) + 0.5) * cell;
    const y = BOARD_Y + (world.foodY(index) + 0.5) * cell;
    surface.circle(offsetX + x * scale, offsetY + y * scale, cell * 0.32 * scale, FOOD);
    surface.circle(offsetX + x * scale, offsetY + y * scale, cell * 0.13 * scale, OVERLAY);
  }

  // Snakes: body cells lerp from the previous step; the head is a circle.
  for (let slot = 1; slot <= world.snakes.length; slot += 1) {
    const snake = world.snakes[slot - 1];
    if (snake === undefined || !snake.alive || snake.length === 0) continue;
    const color = playerColor(slot);
    const previousLength = snake.prevLength > 0 ? snake.prevLength : snake.length;
    for (let segment = 0; segment < snake.length; segment += 1) {
      const current = snake.cells[segment] ?? 0;
      const previousIndex = segment < previousLength ? segment : previousLength - 1;
      const previous =
        previousIndex >= 0 ? (snake.prevCells[previousIndex] ?? current) : current;
      const currentX = current % gridSize;
      const currentY = (current / gridSize) | 0;
      const previousX = previous % gridSize;
      const previousY = (previous / gridSize) | 0;
      const x = BOARD_X + (previousX + (currentX - previousX) * blend + 0.09) * cell;
      const y = BOARD_Y + (previousY + (currentY - previousY) * blend + 0.09) * cell;
      surface.rect(
        offsetX + x * scale,
        offsetY + y * scale,
        cell * 0.82 * scale,
        cell * 0.82 * scale,
        color,
      );
    }

    const headCell = snake.cells[0] ?? 0;
    const previousHead = snake.prevCells[0] ?? headCell;
    const headX = headCell % gridSize;
    const headY = (headCell / gridSize) | 0;
    const previousHeadX = previousHead % gridSize;
    const previousHeadY = (previousHead / gridSize) | 0;
    const headCenterX =
      BOARD_X + (previousHeadX + (headX - previousHeadX) * blend + 0.5) * cell;
    const headCenterY =
      BOARD_Y + (previousHeadY + (headY - previousHeadY) * blend + 0.5) * cell;
    surface.circle(
      offsetX + headCenterX * scale,
      offsetY + headCenterY * scale,
      cell * 0.52 * scale,
      color,
    );
    surface.circle(
      offsetX + headCenterX * scale,
      offsetY + headCenterY * scale,
      cell * 0.18 * scale,
      OVERLAY,
    );
  }

  // Right-hand HUD: title, phase subtitle, ordered participant lines, status.
  surface.text(
    HUD_TITLE,
    offsetX + HUD_X * scale,
    offsetY + HUD_TOP * scale,
    34 * scale,
    TEXT,
  );
  surface.text(
    hud.subtitle,
    offsetX + HUD_X * scale,
    offsetY + (HUD_TOP + 38) * scale,
    18 * scale,
    MUTED,
  );

  let row = 0;
  for (let slot = 1; slot <= world.snakes.length; slot += 1) {
    if (!world.participates(slot)) continue;
    const y = HUD_LINE_START + row * HUD_LINE_STEP;
    const line = hud.lines[slot - 1] ?? "";
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
    row += 1;
  }

  surface.text(
    hud.status,
    offsetX + HUD_X * scale,
    offsetY + (HUD_LINE_START + row * HUD_LINE_STEP + 34) * scale,
    22 * scale,
    ACCENT,
  );

  // Phase overlays sit on the board, never over the HUD column.
  if (state.phase === "lobby") {
    surface.rect(
      offsetX + BOARD_X * scale,
      offsetY + BOARD_Y * scale,
      BOARD_SIZE * scale,
      BOARD_SIZE * scale,
      OVERLAY,
    );
    surface.text(
      HUD_TITLE,
      offsetX + (BOARD_X + BOARD_SIZE / 2) * scale,
      offsetY + (BOARD_Y + BOARD_SIZE * 0.44) * scale,
      48 * scale,
      TEXT,
      "center",
    );
    surface.text(
      WAITING,
      offsetX + (BOARD_X + BOARD_SIZE / 2) * scale,
      offsetY + (BOARD_Y + BOARD_SIZE * 0.54) * scale,
      22 * scale,
      MUTED,
      "center",
    );
    surface.text(
      hud.status,
      offsetX + (BOARD_X + BOARD_SIZE / 2) * scale,
      offsetY + (BOARD_Y + BOARD_SIZE * 0.62) * scale,
      20 * scale,
      ACCENT,
      "center",
    );
  } else if (state.phase === "countdown") {
    surface.rect(
      offsetX + BOARD_X * scale,
      offsetY + BOARD_Y * scale,
      BOARD_SIZE * scale,
      BOARD_SIZE * scale,
      OVERLAY,
    );
    surface.text(
      READY,
      offsetX + (BOARD_X + BOARD_SIZE / 2) * scale,
      offsetY + (BOARD_Y + BOARD_SIZE * 0.3) * scale,
      24 * scale,
      MUTED,
      "center",
    );
    surface.text(
      countdownLabel(state.countdownRemainingMs),
      offsetX + (BOARD_X + BOARD_SIZE / 2) * scale,
      offsetY + (BOARD_Y + BOARD_SIZE * 0.62) * scale,
      160 * scale,
      ACCENT,
      "center",
    );
    surface.text(
      hud.subtitle,
      offsetX + (BOARD_X + BOARD_SIZE / 2) * scale,
      offsetY + (BOARD_Y + BOARD_SIZE * 0.78) * scale,
      22 * scale,
      TEXT,
      "center",
    );
  } else if (state.phase === "results") {
    surface.rect(
      offsetX + (BOARD_X - BOARD_PAD) * scale,
      offsetY + (BOARD_Y - BOARD_PAD) * scale,
      (BOARD_SIZE + BOARD_PAD * 2) * scale,
      (BOARD_SIZE + BOARD_PAD * 2) * scale,
      OVERLAY,
    );
    const centerX = BOARD_X + BOARD_SIZE / 2;
    surface.text(
      RESULTS,
      offsetX + centerX * scale,
      offsetY + (BOARD_Y + 72) * scale,
      34 * scale,
      TEXT,
      "center",
    );
    surface.text(
      hud.status,
      offsetX + centerX * scale,
      offsetY + (BOARD_Y + 118) * scale,
      24 * scale,
      ACCENT,
      "center",
    );

    for (let index = 0; index < state.results.length; index += 1) {
      const result = state.results[index];
      if (result === undefined) continue;
      const y = BOARD_Y + 190 + index * 36;
      const line = hud.lines[result.slot - 1] ?? "";
      surface.rect(
        offsetX + (BOARD_X + 120) * scale,
        offsetY + (y - 12) * scale,
        10 * scale,
        10 * scale,
        result.color,
      );
      surface.text(
        line,
        offsetX + (BOARD_X + 144) * scale,
        offsetY + y * scale,
        20 * scale,
        result.winner ? ACCENT : TEXT,
      );
    }

    surface.text(
      state.matchWinner === null ? TAP_CONTINUE : TAP_REMATCH,
      offsetX + centerX * scale,
      offsetY + (BOARD_Y + BOARD_SIZE - 64) * scale,
      18 * scale,
      MUTED,
      "center",
    );
  }

  surface.endFrame();
}
