/**
 * Canvas control renderer (D5-CTRL-01; FR-8.1, FR-8.3, FR-7.8, SR-13, AR-5).
 *
 * One stroke at a time. Points are normalized to 0..1 and sampled at most
 * every 16 ms or every 8 px of finger travel; each sample is drawn locally
 * before the handler returns, so the drawer sees ink immediately, then batched
 * into `move` events (~50 ms / 16 points). `start` carries the first point and
 * `end` carries the final flushes; the payload is the frozen D5 stroke shape
 * `{points, color, width, phase}` (D5 contract 5).
 *
 * `color`/`width` are additive layout fields (defaults `#ffffff` and 6 px,
 * capped at 1..32 px). They are read defensively because the D2 `CanvasControl`
 * type does not declare them yet; the JSON schema keeps `additionalProperties`
 * open, and D5-CTRL-04 promotes them into the typed surface.
 *
 * Rendering uses a real `<canvas>` 2D context. When no context is available
 * (jsdom without the `canvas` package, or a hostile environment) pointer and
 * event bookkeeping still works — only local ink is skipped.
 */
import { normalizeStrokePoint, type CanvasControl } from "@lanpad/sdk";
import type { InputState } from "@lanpad/protocol";
import {
  applyControlElementStyle,
  createPart,
  measureControl,
  notifyDebugState,
  setPressedClass,
  type ControlContext,
  type ControlRenderer,
} from "./control.js";
import { emitControlEvent, type StrokePoint } from "./eventSink.js";
import type { TouchBinding } from "../touch/touchEngine.js";

/** Default ink color when the layout omits the additive `color` field. */
export const DEFAULT_STROKE_COLOR = "#ffffff";
/** Default ink width in CSS pixels. */
export const DEFAULT_STROKE_WIDTH = 6;

const MAX_STROKE_WIDTH = 32;
const MIN_STROKE_WIDTH = 1;
const SAMPLE_INTERVAL_MS = 16;
const SAMPLE_DISTANCE_PX = 8;
const MOVE_FLUSH_MS = 50;
const MOVE_BATCH_POINTS = 16;
const HARD_MAX_POINTS = 4_096;
const COLOR_PATTERN = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;

/** Additive fields D5-CTRL-01 reads before the schema types them. */
type CanvasInkControl = CanvasControl & { color?: unknown; width?: unknown };

/** Resolves and validates the additive ink fields. */
export function resolveCanvasInk(control: CanvasControl): { color: string; width: number } {
  const raw = control as CanvasInkControl;
  const color =
    typeof raw.color === "string" && COLOR_PATTERN.test(raw.color)
      ? raw.color
      : DEFAULT_STROKE_COLOR;
  const rawWidth = raw.width;
  const width =
    typeof rawWidth === "number" && Number.isFinite(rawWidth)
      ? Math.min(MAX_STROKE_WIDTH, Math.max(MIN_STROKE_WIDTH, rawWidth))
      : DEFAULT_STROKE_WIDTH;
  return { color, width };
}

function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

export function createCanvasControl(
  control: CanvasControl,
  ctx: ControlContext,
): ControlRenderer {
  const box = measureControl(control, ctx.surfaceSize);
  const ink = resolveCanvasInk(control);
  const maxPoints =
    typeof control.maxStrokePoints === "number" &&
    Number.isInteger(control.maxStrokePoints) &&
    control.maxStrokePoints > 0
      ? Math.min(HARD_MAX_POINTS, control.maxStrokePoints)
      : HARD_MAX_POINTS;

  const element = document.createElement("div");
  applyControlElementStyle(element, control, box, ctx);
  element.classList.add("control", "control-canvas");
  element.setAttribute("role", "application");
  element.setAttribute("aria-label", "drawing canvas");
  element.style.overflow = "hidden";
  element.style.borderRadius = "12px";
  element.style.background = "rgba(0, 0, 0, 0.25)";
  element.style.border = "1px solid rgba(255, 255, 255, 0.30)";
  element.dataset["strokeColor"] = ink.color;
  element.dataset["strokeWidth"] = String(ink.width);

  const canvas = createPart("canvas", "canvas");
  const ratio =
    typeof window !== "undefined" &&
    Number.isFinite(window.devicePixelRatio) &&
    window.devicePixelRatio > 0
      ? Math.min(2, window.devicePixelRatio)
      : 1;
  canvas.width = Math.max(1, Math.round(box.width * ratio));
  canvas.height = Math.max(1, Math.round(box.height * ratio));
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.pointerEvents = "none";
  element.append(canvas);

  let context: CanvasRenderingContext2D | null = null;
  try {
    context = canvas.getContext("2d");
  } catch {
    // A throwing context is treated exactly like a missing one.
    context = null;
  }
  if (context !== null) {
    context.scale(ratio, ratio);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = ink.color;
    context.fillStyle = ink.color;
    context.lineWidth = ink.width;
  }

  let activeIdentifier: number | null = null;
  let pressed = false;
  let pointCount = 0;
  let pending: StrokePoint[] = [];
  let lastPoint: StrokePoint | null = null;
  let lastRawX = 0;
  let lastRawY = 0;
  let lastSampleAt = 0;
  let lastMoveFlushAt = 0;

  const drawDot = (point: StrokePoint): void => {
    if (context === null) {
      return;
    }
    context.fillStyle = ink.color;
    context.beginPath();
    context.arc(
      point.x * box.width,
      point.y * box.height,
      Math.max(1, ink.width / 2),
      0,
      Math.PI * 2,
    );
    context.fill();
  };

  const drawSegment = (from: StrokePoint, to: StrokePoint): void => {
    if (context === null) {
      return;
    }
    context.strokeStyle = ink.color;
    context.lineWidth = ink.width;
    context.beginPath();
    context.moveTo(from.x * box.width, from.y * box.height);
    context.lineTo(to.x * box.width, to.y * box.height);
    context.stroke();
  };

  const applyVisual = (active: boolean): void => {
    if (active === pressed) {
      return;
    }
    pressed = active;
    setPressedClass(element, active);
    element.style.opacity = active ? "0.96" : "1";
    notifyDebugState(ctx, control.id, active);
  };

  const pointAt = (x: number, y: number, stamp: number): StrokePoint =>
    normalizeStrokePoint((x - box.left) / box.width, (y - box.top) / box.height, stamp);

  const flushMove = (stamp: number): void => {
    lastMoveFlushAt = stamp;
    if (pending.length === 0) {
      return;
    }
    const batch = pending;
    pending = [];
    emitControlEvent(
      ctx.events,
      control.event,
      { points: batch, color: ink.color, width: ink.width, phase: "move" },
      "low",
    );
  };

  const resetStroke = (): void => {
    activeIdentifier = null;
    pointCount = 0;
    pending = [];
    lastPoint = null;
    lastRawX = 0;
    lastRawY = 0;
    lastSampleAt = 0;
    lastMoveFlushAt = 0;
  };

  return {
    id: control.id,
    element,

    setPressed(active: boolean): void {
      applyVisual(active);
    },

    onTouchStart(binding: TouchBinding): void {
      // One stroke at a time; additional fingers are ignored until it ends.
      if (activeIdentifier !== null) {
        return;
      }
      const stamp = nowMs();
      const point = pointAt(binding.startX, binding.startY, stamp);
      activeIdentifier = binding.identifier;
      pointCount = 1;
      pending = [];
      lastPoint = point;
      lastRawX = binding.startX;
      lastRawY = binding.startY;
      lastSampleAt = stamp;
      lastMoveFlushAt = stamp;

      applyVisual(true);
      drawDot(point);
      emitControlEvent(
        ctx.events,
        control.event,
        { points: [point], color: ink.color, width: ink.width, phase: "start" },
        "low",
      );
    },

    onTouchMove(binding: TouchBinding): void {
      if (binding.identifier !== activeIdentifier) {
        return;
      }
      const stamp = nowMs();
      const rawDistance = Math.hypot(binding.lastX - lastRawX, binding.lastY - lastRawY);
      // Sample when 16 ms has passed OR the finger moved 8 px, whichever first.
      if (stamp - lastSampleAt < SAMPLE_INTERVAL_MS && rawDistance < SAMPLE_DISTANCE_PX) {
        return;
      }
      if (pointCount >= maxPoints) {
        return;
      }

      const point = pointAt(binding.lastX, binding.lastY, stamp);
      if (lastPoint !== null) {
        drawSegment(lastPoint, point);
      }
      pending.push(point);
      pointCount += 1;
      lastPoint = point;
      lastRawX = binding.lastX;
      lastRawY = binding.lastY;
      lastSampleAt = stamp;

      if (stamp - lastMoveFlushAt >= MOVE_FLUSH_MS || pending.length >= MOVE_BATCH_POINTS) {
        flushMove(stamp);
      }
    },

    onTouchEnd(binding: TouchBinding): void {
      if (binding.identifier !== activeIdentifier) {
        return;
      }
      const stamp = nowMs();
      // Capture the release position if it moved since the last sample, so the
      // end of a fast flick is not lost.
      if (lastPoint !== null && pointCount < maxPoints) {
        const rawDistance = Math.hypot(binding.lastX - lastRawX, binding.lastY - lastRawY);
        if (rawDistance >= 1) {
          const point = pointAt(binding.lastX, binding.lastY, stamp);
          drawSegment(lastPoint, point);
          pending.push(point);
          pointCount += 1;
        }
      }
      const finalPoints = pending;
      pending = [];
      emitControlEvent(
        ctx.events,
        control.event,
        { points: finalPoints, color: ink.color, width: ink.width, phase: "end" },
        "low",
      );
      resetStroke();
      applyVisual(false);
    },

    onTouchCancel(binding: TouchBinding): void {
      if (binding.identifier !== activeIdentifier) {
        return;
      }
      const finalPoints = pending;
      pending = [];
      emitControlEvent(
        ctx.events,
        control.event,
        { points: finalPoints, color: ink.color, width: ink.width, phase: "end" },
        "low",
      );
      resetStroke();
      applyVisual(false);
    },

    getState(): Partial<InputState> {
      return {};
    },

    dispose(): void {
      resetStroke();
      applyVisual(false);
      element.remove();
    },
  };
}
