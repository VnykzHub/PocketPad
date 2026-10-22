/**
 * Slider control renderer (D5-CTRL-01; FR-8.1, FR-8.3, FR-8.7, FR-7.7, AR-5).
 *
 * A rectangular track bound to `lt` or `rt`. Like the trigger, the value is
 * the absolute touch position along the travel axis (horizontal default: left
 * 0 → right 1; vertical: bottom 0 → top 1). The fill's `transform` changes in
 * the same synchronous call as the `InputStore` trigger value (FR-8.7), and
 * the control box itself never moves (FR-8.3). The validator guarantees a
 * slider and a trigger never share a channel (FR-7.7).
 *
 * Visual grammar (CP-11, DESIGN.md): the renderer emits `.control` +
 * `.control-slider` and the shared `.is-pressed` state; styles.css owns every
 * colour, radius and type size. This file owns only construction geometry and
 * the per-value transforms of the fill and the 32 px thumb. The channel label
 * (`LT`/`RT`) doubles as the value readout while the slider is held, because
 * styles.css defines no separate value part for this control.
 */
import type { SliderControl } from "@lanpad/sdk";
import type { InputState } from "@lanpad/protocol";
import { MAX_TRIGGER_VALUE } from "../input/InputStore.js";
import {
  applyControlClasses,
  applyControlElementStyle,
  createPart,
  measureControl,
  notifyDebugState,
  setPressedClass,
  type ControlContext,
  type ControlRenderer,
} from "./control.js";
import type { TouchBinding } from "../touch/touchEngine.js";

/** CP-11 thumb diameter in CSS px; styles.css paints it, the renderer moves it. */
export const SLIDER_THUMB_SIZE_PX = 32;

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
  const horizontal = direction === "horizontal";
  const channelLabel = control.channel.toUpperCase();
  const thumbTravel = Math.max(
    0,
    horizontal ? box.width - SLIDER_THUMB_SIZE_PX : box.height - SLIDER_THUMB_SIZE_PX,
  );

  const element = document.createElement("div");
  applyControlElementStyle(element, control, box, ctx);
  applyControlClasses(element, "slider");
  element.setAttribute("role", "slider");
  element.setAttribute("aria-label", `slider ${control.channel}`);
  element.setAttribute("aria-orientation", direction);
  element.setAttribute("aria-valuemin", "0");
  element.setAttribute("aria-valuemax", String(MAX_TRIGGER_VALUE));
  element.setAttribute("aria-valuenow", "0");
  element.setAttribute("aria-valuetext", "0%");

  // The fill is the coloured travelled portion; transform only (FR-8.3).
  const fill = createPart("div", "fill");

  const thumb = createPart("div", "thumb");

  const label = createPart("span", "label");
  label.textContent = channelLabel;

  element.append(fill, thumb, label);

  let activeIdentifier: number | null = null;
  let value = 0;
  let shownPercent = 0;
  let pressed = false;

  const syncLabel = (): void => {
    label.textContent = pressed ? `${channelLabel} ${shownPercent}%` : channelLabel;
  };

  const applyVisual = (active: boolean): void => {
    if (active === pressed) {
      return;
    }
    pressed = active;
    setPressedClass(element, active);
    syncLabel();
    notifyDebugState(ctx, control.id, active);
  };

  const applyValue = (next: number): void => {
    const clamped = clamp01(next);
    if (clamped === value) {
      return;
    }
    value = clamped;
    if (horizontal) {
      fill.style.transform = `scaleX(${clamped})`;
      thumb.style.transform = `translate3d(${clamped * thumbTravel}px, -50%, 0)`;
    } else {
      fill.style.transform = `scaleY(${clamped})`;
      thumb.style.transform = `translate3d(-50%, ${(1 - clamped) * thumbTravel}px, 0)`;
    }
    element.setAttribute("aria-valuenow", String(Math.round(clamped * MAX_TRIGGER_VALUE)));
    const percent = Math.round(clamped * 100);
    if (percent !== shownPercent) {
      shownPercent = percent;
      element.setAttribute("aria-valuetext", `${percent}%`);
      syncLabel();
    }
    ctx.input.setTrigger(control.channel, clamped);
  };

  const valueAt = (x: number, y: number): number => {
    const withinX = Math.min(box.left + box.width, Math.max(box.left, x));
    const withinY = Math.min(box.top + box.height, Math.max(box.top, y));
    if (horizontal) {
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
