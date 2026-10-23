/**
 * TV-side renderer for Draw and Guess (GAME-DG-HOST-03, GAME-DG-PERF-01).
 *
 * Mirrors the platformer's contract: the host's renderer is feature-detected
 * for the flat Canvas2D methods and rendered in CSS pixels. If the backend is
 * 3D-only (Babylon, WebGPU) the game draws nothing rather than reaching for
 * a DOM canvas; the phone side still works.
 *
 * Privacy: the secret word is drawn only when `revealWord` is true, which the
 * adapter sets only after the round ends. During countdown and play the TV
 * shows the round, the drawer and the ink, never the word (SR-13).
 *
 * Allocation: the projection pool is preallocated once. A stroke's points are
 * copied into the pool, the view array's length is adjusted (references only)
 * and handed to `polyline`/`circle` synchronously; no per-frame objects or
 * arrays are created.
 */
import { countdownLabel, playerLabel } from "@lanpad/game-kit";
import type { MatchPhase } from "@lanpad/game-kit";
import type { GameRenderer3D } from "@lanpad/sdk";
import type { StrokeStore } from "./strokes.js";

export interface Renderer2DLike {
  readonly size?: { readonly width: number; readonly height: number };
  beginFrame(alpha: number): void;
  endFrame(): void;
  clear(color: string): void;
  rect(x: number, y: number, w: number, h: number, color: string): void;
  circle(x: number, y: number, radius: number, color: string): void;
  text(
    text: string,
    x: number,
    y: number,
    size: number,
    color: string,
    align?: "left" | "center" | "right",
  ): void;
  polyline?(
    points: ReadonlyArray<{ readonly x: number; readonly y: number }>,
    width: number,
    color: string,
  ): void;
}

export interface DrawGuessRenderState {
  readonly strokes: StrokeStore;
  phase: MatchPhase;
  roundNumber: number;
  rounds: number;
  drawerSlot: number;
  countdownRemainingMs: number;
  /** Cached one-line footer; built by the adapter when state changes. */
  status: string;
  /** Round line, e.g. "Round 2 of 3 — P3 draws". */
  turnLine: string;
  /** Secret word; drawn only when `revealWord` is true. */
  word: string;
  revealWord: boolean;
  /** Cached ranked score lines for the results screen. */
  scoreLines: readonly string[];
  /** Headline over the results score list. */
  resultsHeadline: string;
}

const BACKGROUND = "#101014";
const BOARD = "#17171d";
const BOARD_BORDER = "#2b2b36";
const TEXT = "#f5f5f7";
const MUTED = "#9a9aa8";
const ACCENT = "#4cb3f0";

const FALLBACK_WIDTH = 1280;
const FALLBACK_HEIGHT = 720;
const BOARD_MARGIN = 24;
const BOARD_TOP = 72;
const BOARD_FOOTER = 48;
const PROJECTION_CAPACITY = 512;

interface ProjectedPoint {
  x: number;
  y: number;
}

/** Preallocated point objects, mutated in place for every stroke. */
const projectionPool: ProjectedPoint[] = [];
for (let index = 0; index < PROJECTION_CAPACITY; index += 1) {
  projectionPool.push({ x: 0, y: 0 });
}
/** View handed to the renderer; only project references, never point data. */
const projectionView: ProjectedPoint[] = [];

/**
 * Returns the flat 2D surface when the host renderer exposes it, else null.
 * The check is duck-typed so a test renderer and the real host both work.
 */
export function resolveRenderer2D(
  renderer: GameRenderer3D | null | undefined,
): Renderer2DLike | null {
  if (renderer === null || renderer === undefined) return null;
  const candidate = renderer as unknown as Partial<Renderer2DLike>;
  if (
    typeof candidate.beginFrame !== "function" ||
    typeof candidate.endFrame !== "function" ||
    typeof candidate.clear !== "function" ||
    typeof candidate.rect !== "function" ||
    typeof candidate.circle !== "function" ||
    typeof candidate.text !== "function"
  ) {
    return null;
  }
  return candidate as Renderer2DLike;
}

function safeText(
  surface: Renderer2DLike,
  value: string,
  x: number,
  y: number,
  size: number,
  color: string,
  align?: "left" | "center" | "right",
): void {
  if (value.length === 0) return;
  if (align === undefined) surface.text(value, x, y, size, color);
  else surface.text(value, x, y, size, color, align);
}

function drawStroke(
  surface: Renderer2DLike,
  points: readonly { readonly x: number; readonly y: number }[],
  width: number,
  color: string,
): void {
  if (points.length === 0) return;
  if (surface.polyline !== undefined) {
    surface.polyline(points, width, color);
    return;
  }
  // Fallback surface without polylines: draw a dot per point. Bounded by the
  // store's caps, so this stays a small finite loop.
  const radius = Math.max(1, width / 2);
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (point !== undefined) surface.circle(point.x, point.y, radius, color);
  }
}

/**
 * Draws one frame. `alpha` is the fixed-loop interpolation factor; this game
 * has no interpolated motion, so it only reaches `beginFrame`.
 */
export function drawDrawAndGuess(
  surface: Renderer2DLike,
  state: DrawGuessRenderState,
  alpha: number,
): void {
  surface.beginFrame(alpha);
  surface.clear(BACKGROUND);

  const width = surface.size?.width ?? FALLBACK_WIDTH;
  const height = surface.size?.height ?? FALLBACK_HEIGHT;
  const boardX = BOARD_MARGIN;
  const boardY = BOARD_TOP;
  const boardW = Math.max(1, width - BOARD_MARGIN * 2);
  const boardH = Math.max(1, height - BOARD_TOP - BOARD_FOOTER);

  safeText(surface, "DRAW AND GUESS", boardX, 30, 22, TEXT);
  safeText(surface, state.turnLine, boardX, 54, 16, MUTED);

  surface.rect(boardX, boardY, boardW, boardH, BOARD);
  // Hairline border drawn as four thin rects; the surface has no stroke API.
  surface.rect(boardX, boardY, boardW, 2, BOARD_BORDER);
  surface.rect(boardX, boardY + boardH - 2, boardW, 2, BOARD_BORDER);
  surface.rect(boardX, boardY, 2, boardH, BOARD_BORDER);
  surface.rect(boardX + boardW - 2, boardY, 2, boardH, BOARD_BORDER);

  const centerX = boardX + boardW / 2;
  const centerY = boardY + boardH / 2;

  if (state.phase === "lobby") {
    safeText(surface, "Waiting for players", centerX, centerY, 30, MUTED, "center");
  } else if (state.phase === "countdown") {
    safeText(
      surface,
      countdownLabel(state.countdownRemainingMs),
      centerX,
      centerY + 24,
      96,
      TEXT,
      "center",
    );
    safeText(
      surface,
      state.drawerSlot > 0 ? `${playerLabel(state.drawerSlot)} draws` : "",
      centerX,
      centerY + 72,
      22,
      MUTED,
      "center",
    );
  } else if (state.phase === "playing") {
    const pad = 8;
    const innerW = Math.max(1, boardW - pad * 2);
    const innerH = Math.max(1, boardH - pad * 2);
    const inkScale = Math.max(1, Math.min(6, innerW / 360));
    const strokes = state.strokes.all;
    for (let strokeIndex = 0; strokeIndex < strokes.length; strokeIndex += 1) {
      const stroke = strokes[strokeIndex];
      if (stroke === undefined) continue;
      const count = Math.min(stroke.points.length, PROJECTION_CAPACITY);
      projectionView.length = count;
      for (let pointIndex = 0; pointIndex < count; pointIndex += 1) {
        const source = stroke.points[pointIndex];
        const target = projectionPool[pointIndex];
        if (source === undefined || target === undefined) continue;
        target.x = boardX + pad + source.x * innerW;
        target.y = boardY + pad + source.y * innerH;
        projectionView[pointIndex] = target;
      }
      drawStroke(surface, projectionView, Math.max(1, stroke.width * inkScale), stroke.color);
    }
    if (strokes.length === 0) {
      safeText(surface, "Waiting for the first stroke...", centerX, centerY, 22, MUTED, "center");
    }
  } else {
    // Results: the word and the standings are public now.
    safeText(surface, state.resultsHeadline, centerX, boardY + 56, 20, ACCENT, "center");
    if (state.revealWord && state.word.length > 0) {
      safeText(surface, state.word, centerX, boardY + 112, 44, TEXT, "center");
    }
    const lineHeight = 28;
    const top = boardY + 168;
    for (let index = 0; index < state.scoreLines.length; index += 1) {
      const line = state.scoreLines[index];
      if (line !== undefined) {
        safeText(surface, line, centerX, top + index * lineHeight, 22, TEXT, "center");
      }
    }
    // Reset the view so a following frame cannot hand stale references to a
    // renderer that retains the array.
    projectionView.length = 0;
  }

  safeText(surface, state.status, boardX, height - 22, 16, MUTED);
  surface.endFrame();
}
