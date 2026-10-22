/**
 * Canvas control renderer (D5-CTRL-01; FR-8.1, FR-8.3, FR-7.8, SR-13, AR-5).
 *
 * One stroke at a time. Sampling, normalization, batching, the 20 KB/s cap
 * and pressure coalescing live in `StrokeBatcher` (D5-CTRL-04); this renderer
 * binds the first touch and draws each accepted sample locally before the
 * handler returns, so the drawer sees ink before any batch leaves (E10). The
 * payload is the frozen D5 stroke shape `{points, color, width, phase}`
 * (D5 contract 5); `end` also carries the total `count`.
 *
 * `color`/`width` are additive layout fields (defaults `#ffffff` and 6 px,
 * capped at 1..32 px). They are read defensively because the D2 `CanvasControl`
 * type does not declare them yet; the JSON schema keeps `additionalProperties`
 * open; promoting them into the SDK types is still an open D5 item.
 *
 * Rendering uses a real `<canvas>` 2D context. When no context is available
 * (jsdom without the `canvas` package, or a hostile environment) pointer and
 * event bookkeeping still works — only local ink is skipped.
 */
import { isAllowedColor, type CanvasControl } from "@lanpad/sdk";
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
import { StrokeBatcher } from "./strokeBatcher.js";
import type { TouchBinding } from "../touch/touchEngine.js";

/** Default ink color when the layout omits the additive `color` field. */
export const DEFAULT_STROKE_COLOR = "#ffffff";
/** Default ink width in CSS pixels. */
export const DEFAULT_STROKE_WIDTH = 6;

const MAX_STROKE_WIDTH = 32;
const MIN_STROKE_WIDTH = 1;
const HARD_MAX_POINTS = 4_096;

/** Additive fields D5-CTRL-01 reads before the schema types them. */
type CanvasInkControl = CanvasControl & { color?: unknown; width?: unknown };

/** Resolves and validates the additive ink fields. */
export function resolveCanvasInk(control: CanvasControl): { color: string; width: number } {
  const raw = control as CanvasInkControl;
  // Shared SR-13 allowlist (#rgb / #rrggbb); one validator for every ink path.
  const color = isAllowedColor(raw.color) ? raw.color : DEFAULT_STROKE_COLOR;
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
  let lastPoint: StrokePoint | null = null;

  // The batcher is the only stroke path (D5-CTRL-04): it samples, normalizes,
  // batches and caps bandwidth; this renderer only binds touches and draws.
  const batcher = new StrokeBatcher({
    color: ink.color,
    width: ink.width,
    now: nowMs,
    maxStrokePoints: maxPoints,
    timers: {
      set: (callback, delayMs) => setTimeout(callback, delayMs),
      clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    emit: (data) => {
      emitControlEvent(ctx.events, control.event, data, "low");
    },
  });

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

  /** Draws the segment to a freshly sampled point before any batch leaves. */
  const drawTo = (point: StrokePoint | null): void => {
    if (point === null) {
      return;
    }
    if (lastPoint !== null) {
      drawSegment(lastPoint, point);
    }
    lastPoint = point;
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

  const finishStroke = (): void => {
    activeIdentifier = null;
    lastPoint = null;
    applyVisual(false);
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
      activeIdentifier = binding.identifier;
      applyVisual(true);
      const point = batcher.begin(binding.startX, binding.startY, box);
      if (point !== null) {
        drawDot(point);
        lastPoint = point;
      }
    },

    onTouchMove(binding: TouchBinding): void {
      if (binding.identifier !== activeIdentifier) {
        return;
      }
      drawTo(batcher.move(binding.lastX, binding.lastY));
    },

    onTouchEnd(binding: TouchBinding): void {
      if (binding.identifier !== activeIdentifier) {
        return;
      }
      // The release position is captured so a fast flick's tail is not lost.
      drawTo(batcher.end(binding.lastX, binding.lastY));
      finishStroke();
    },

    onTouchCancel(binding: TouchBinding): void {
      if (binding.identifier !== activeIdentifier) {
        return;
      }
      batcher.cancel();
      finishStroke();
    },

    getState(): Partial<InputState> {
      return {};
    },

    dispose(): void {
      batcher.reset();
      finishStroke();
      element.remove();
    },
  };
}
