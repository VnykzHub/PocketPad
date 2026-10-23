/**
 * Host-side ink store (GAME-DG-HOST-03, GAME-DG-DATA-02).
 *
 * The kit's `onCanvas` helper already validates the wire payload (1..512
 * points, finite 0..1 coordinates, hex colors, start/move/end). This store is
 * the game-owned second line of defense after that validation:
 *
 * - Every point is passed through the SDK's `normalizeStrokePoint`, which
 *   clamps x/y into 0..1 and t to >= 0.
 * - Width is clamped to the configured ink range.
 * - Invalid colors are rejected; a stroke never reaches the renderer with a
 *   non-hex color.
 * - Per-stroke, per-round-stroke and per-round-point caps bound both memory
 *   and draw work, so a hostile or buggy phone cannot grow host state
 *   without limit during a round.
 * - Points are grouped into strokes on `start`/`end`; a missing `start`
 *   opens a stroke on the first `move` so a dropped packet cannot erase the
 *   rest of the drawing.
 *
 * The store is reset between rounds and owns no host references. It is safe
 * to unit test without a `GameContext`.
 */
import { isAllowedColor, normalizeStrokePoint, type JsonValue } from "@lanpad/sdk";
import { DG_CONFIG } from "./config.js";

export interface StrokePoint {
  readonly x: number;
  readonly y: number;
}

export interface InkStroke {
  readonly points: StrokePoint[];
  readonly color: string;
  readonly width: number;
}

export interface StrokeStoreLimits {
  readonly maxPointsPerStroke?: number;
  readonly maxStrokes?: number;
  readonly maxPoints?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampWidth(width: number): number {
  return Math.max(DG_CONFIG.minInkWidth, Math.min(DG_CONFIG.maxInkWidth, width));
}

export class StrokeStore {
  private readonly strokes: InkStroke[] = [];
  private readonly maxPointsPerStroke: number;
  private readonly maxStrokes: number;
  private readonly maxPoints: number;
  private openStroke: InkStroke | null = null;
  private pointTotal = 0;
  private droppedPoints = 0;

  constructor(limits: StrokeStoreLimits = {}) {
    this.maxPointsPerStroke = limits.maxPointsPerStroke ?? DG_CONFIG.maxPointsPerStroke;
    this.maxStrokes = limits.maxStrokes ?? DG_CONFIG.maxStrokesPerRound;
    this.maxPoints = limits.maxPoints ?? DG_CONFIG.maxPointsPerRound;
  }

  /** Completed and in-progress strokes, in draw order. */
  get all(): readonly InkStroke[] {
    return this.strokes;
  }

  get count(): number {
    return this.strokes.length;
  }

  get pointCount(): number {
    return this.pointTotal;
  }

  /** Points rejected by a cap or validation, for debug counters and tests. */
  get dropped(): number {
    return this.droppedPoints;
  }

  /**
   * Ingests one validated `kit.canvas` payload. Returns true when at least
   * one point was accepted.
   */
  add(data: JsonValue): boolean {
    if (!isRecord(data)) return false;
    const phase = data["phase"];
    if (phase !== "start" && phase !== "move" && phase !== "end") return false;
    const rawPoints = data["points"];
    if (!Array.isArray(rawPoints) || rawPoints.length === 0) return false;
    const color = data["color"];
    if (typeof color !== "string" || !isAllowedColor(color)) return false;
    const rawWidth = data["width"];
    if (typeof rawWidth !== "number" || !Number.isFinite(rawWidth)) return false;
    const width = clampWidth(rawWidth);

    if (phase === "start") this.openStroke = null;
    let stroke = this.openStroke;
    let accepted = 0;

    for (let index = 0; index < rawPoints.length; index += 1) {
      const rawPoint = rawPoints[index];
      if (!isRecord(rawPoint)) {
        this.droppedPoints += 1;
        continue;
      }
      const x = rawPoint["x"];
      const y = rawPoint["y"];
      const t = rawPoint["t"];
      if (
        typeof x !== "number" ||
        typeof y !== "number" ||
        typeof t !== "number" ||
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        !Number.isFinite(t)
      ) {
        this.droppedPoints += 1;
        continue;
      }

      if (stroke === null) {
        if (this.strokes.length >= this.maxStrokes) {
          this.droppedPoints += 1;
          continue;
        }
        stroke = { points: [], color, width };
        this.strokes.push(stroke);
        this.openStroke = stroke;
      }

      if (stroke.points.length >= this.maxPointsPerStroke || this.pointTotal >= this.maxPoints) {
        this.droppedPoints += 1;
        continue;
      }

      const normalized = normalizeStrokePoint(x, y, t);
      stroke.points.push({ x: normalized.x, y: normalized.y });
      this.pointTotal += 1;
      accepted += 1;
    }

    if (phase === "end") this.openStroke = null;
    return accepted > 0;
  }

  /** Clears the board for a new round. Keeps the caps and drop counter. */
  reset(): void {
    this.strokes.length = 0;
    this.openStroke = null;
    this.pointTotal = 0;
    this.droppedPoints = 0;
  }
}
