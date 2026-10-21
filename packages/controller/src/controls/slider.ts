/**
 * Slider control renderer (D5-CTRL-01; FR-8.1, FR-8.3, FR-8.7, FR-7.7, AR-5).
 *
 * A rectangular track bound to `lt` or `rt`. Like the trigger, the value is
 * the absolute touch position along the travel axis (horizontal default: left
 * 0 → right 1; vertical: bottom 0 → top 1). The fill's `transform` changes in
 * the same synchronous call as the `InputStore` trigger value (FR-8.7), and
 * the control box itself never moves (FR-8.3). The validator guarantees a
 * slider and a trigger never share a channel (FR-7.7).
 */
import type { SliderControl } from "@lanpad/sdk";
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

export function createSliderControl(
  control: SliderControl,
  ctx: ControlContext,
): ControlRenderer {
  const box = measureControl(control, ctx.surfaceSize);
  const direction = control.direction ?? "horizontal";

  const element = document.createElement("div");
  applyControlElementStyle(element, control, box, ctx);
  element.classList.add("control", "control-slider");
  element.setAttribute("role", "slider");
  element.setAttribute("aria-label", `slider ${control.channel}`);
  element.setAttribute("aria-orientation", direction);
  element.setAttribute("aria-valuemin", "0");
  element.setAttribute("aria-valuemax", String(MAX_TRIGGER_VALUE));
  element.setAttribute("aria-valuenow", "0");
  element.style.overflow = "hidden";
  element.style.borderRadius = "999px";
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
  if (direction === "horizontal") {
    fill.style.transformOrigin = "left";
    fill.style.transform = "scaleX(0)";
  } else {
    fill.style.transformOrigin = "bottom";
    fill.style.transform = "scaleY(0)";
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
    element.style.opacity = active ? PRESSED_OPACITY : IDLE_OPACITY;
    notifyDebugState(ctx, control.id, active);
  };

  const applyValue = (next: number): void => {
    const clamped = clamp01(next);
    if (clamped === value) {
      return;
    }
    value = clamped;
    fill.style.transform = direction === "horizontal" ? `scaleX(${clamped})` : `scaleY(${clamped})`;
    element.setAttribute("aria-valuenow", String(Math.round(clamped * MAX_TRIGGER_VALUE)));
    ctx.input.setTrigger(control.channel, clamped);
  };

  const valueAt = (x: number, y: number): number => {
    const withinX = Math.min(box.left + box.width, Math.max(box.left, x));
    const withinY = Math.min(box.top + box.height, Math.max(box.top, y));
    if (direction === "horizontal") {
      return (withinX - box.left) / box.width;
    }
    return (box.top + box.height - withinY) / box.height;
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
