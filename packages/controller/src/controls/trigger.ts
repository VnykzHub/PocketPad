/**
 * Trigger control renderer (D5-CTRL-01; FR-8.1, FR-8.3, FR-8.7, FR-7.7, AR-5).
 *
 * A vertical (default) or horizontal bar bound to `lt` or `rt`. The value is
 * the touch's absolute position along the bar: vertical bars read 0 at the
 * bottom and 1 at the top, horizontal bars 0 at the left and 1 at the right.
 * That is the same convention the stick uses (screen coordinates, y down), so
 * a layout author can reason about every analog control the same way.
 *
 * The fill is one child element whose `transform: scaleY/scaleX` is updated
 * inside the touch handler — the visual and the `InputStore` value change in
 * the same synchronous call (FR-8.3, FR-8.7). The control's own box never
 * moves after construction. One finger owns the trigger; a second is ignored
 * until the first ends.
 */
import type { TriggerControl } from "@lanpad/sdk";
import type { InputState } from "@lanpad/protocol";
import { MAX_TRIGGER_VALUE } from "../input/InputStore.js";
import {
  applyControlElementStyle,
  createPart,
  measureControl,
  notifyDebugState,
  setPressedClass,
  type ControlContext,
  type ControlRenderer,
} from "./control.js";
import type { TouchBinding } from "../touch/touchEngine.js";

const IDLE_TRANSFORM = "scale(1)";
const PRESSED_TRANSFORM = "scale(0.98)";
const IDLE_OPACITY = "1";
const PRESSED_OPACITY = "0.9";

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  return value > 1 ? 1 : value;
}

export function createTriggerControl(
  control: TriggerControl,
  ctx: ControlContext,
): ControlRenderer {
  const box = measureControl(control, ctx.surfaceSize);
  const orientation = control.orientation ?? "vertical";

  const element = document.createElement("div");
  applyControlElementStyle(element, control, box, ctx);
  element.classList.add("control", "control-trigger");
  element.setAttribute("role", "slider");
  element.setAttribute("aria-label", `trigger ${control.channel}`);
  element.setAttribute("aria-orientation", orientation);
  element.setAttribute("aria-valuemin", "0");
  element.setAttribute("aria-valuemax", String(MAX_TRIGGER_VALUE));
  element.setAttribute("aria-valuenow", "0");
  element.style.overflow = "hidden";
  element.style.borderRadius = "10px";
  element.style.background = "rgba(255, 255, 255, 0.08)";
  element.style.border = "1px solid rgba(255, 255, 255, 0.35)";

  const fill = createPart("div", "fill");
  fill.style.position = "absolute";
  fill.style.left = "0";
  fill.style.top = "0";
  fill.style.width = "100%";
  fill.style.height = "100%";
  fill.style.background = "rgba(255, 255, 255, 0.42)";
  fill.style.pointerEvents = "none";
  if (orientation === "vertical") {
    fill.style.transformOrigin = "bottom";
    fill.style.transform = "scaleY(0)";
  } else {
    fill.style.transformOrigin = "left";
    fill.style.transform = "scaleX(0)";
  }
  element.append(fill);

  let activeIdentifier: number | null = null;
  let value = 0;
  let pressed = false;

  const applyVisual = (active: boolean): void => {
    if (active === pressed) {
      return;
    }
    pressed = active;
    setPressedClass(element, active);
    element.style.transform = active ? PRESSED_TRANSFORM : IDLE_TRANSFORM;
    element.style.opacity = active ? PRESSED_OPACITY : IDLE_OPACITY;
    notifyDebugState(ctx, control.id, active);
  };

  const applyValue = (next: number): void => {
    const clamped = clamp01(next);
    if (clamped === value) {
      return;
    }
    value = clamped;
    fill.style.transform =
      orientation === "vertical" ? `scaleY(${clamped})` : `scaleX(${clamped})`;
    element.setAttribute("aria-valuenow", String(Math.round(clamped * MAX_TRIGGER_VALUE)));
    // Store and fill change in the same call (FR-8.7).
    ctx.input.setTrigger(control.channel, clamped);
  };

  const valueAt = (x: number, y: number): number => {
    const withinX = Math.min(box.left + box.width, Math.max(box.left, x));
    const withinY = Math.min(box.top + box.height, Math.max(box.top, y));
    if (orientation === "vertical") {
      return (box.top + box.height - withinY) / box.height;
    }
    return (withinX - box.left) / box.width;
  };

  const release = (binding: TouchBinding): void => {
    if (binding.identifier !== activeIdentifier) {
      return;
    }
    activeIdentifier = null;
    applyValue(0);
    applyVisual(false);
  };

  return {
    id: control.id,
    element,

    setPressed(active: boolean): void {
      applyVisual(active);
    },

    onTouchStart(binding: TouchBinding): void {
      // One finger owns the trigger; a second touch is ignored until it ends.
      if (activeIdentifier !== null) {
        return;
      }
      activeIdentifier = binding.identifier;
      applyVisual(true);
      applyValue(valueAt(binding.startX, binding.startY));
    },

    onTouchMove(binding: TouchBinding): void {
      if (binding.identifier !== activeIdentifier) {
        return;
      }
      applyValue(valueAt(binding.lastX, binding.lastY));
    },

    onTouchEnd(binding: TouchBinding): void {
      release(binding);
    },

    onTouchCancel(binding: TouchBinding): void {
      release(binding);
    },

    getState(): Partial<InputState> {
      const encoded = Math.round(value * MAX_TRIGGER_VALUE);
      return control.channel === "lt" ? { lt: encoded } : { rt: encoded };
    },

    dispose(): void {
      activeIdentifier = null;
      applyValue(0);
      applyVisual(false);
      element.remove();
    },
  };
}
