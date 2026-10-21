/**
 * Button control renderer (D2-CTRL-02; FR-8.1, FR-8.3, FR-8.7, AR-5).
 *
 * One absolutely positioned element in the layout's shape. A touch sets the
 * layout's button bit in the `InputStore` and paints the pressed state before
 * the handler returns; no animation frame or network round-trip is involved
 * (FR-8.7). The pressed visual is `scale(0.92)` plus opacity, so the element's
 * layout box never changes (FR-8.3).
 */
import type { ButtonControl } from "@lanpad/sdk";
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
import type { TouchBinding } from "../touch/touchEngine.js";

const CIRCLE_RADIUS = "50%";
const ROUNDED_RADIUS = "16px";
const SQUARE_RADIUS = "4px";

const IDLE_TRANSFORM = "scale(1)";
const PRESSED_TRANSFORM = "scale(0.92)";
const IDLE_OPACITY = "1";
const PRESSED_OPACITY = "0.72";

export function createButtonControl(
  control: ButtonControl,
  ctx: ControlContext,
): ControlRenderer {
  const box = measureControl(control, ctx.surfaceSize);
  const element = document.createElement("div");
  applyControlElementStyle(element, control, box, ctx);
  element.classList.add("control", "control-button");
  element.setAttribute("role", "button");
  element.setAttribute("aria-label", control.label);
  element.setAttribute("aria-pressed", "false");

  switch (control.shape) {
    case "circle":
      element.style.borderRadius = CIRCLE_RADIUS;
      break;
    case "rounded":
      element.style.borderRadius = ROUNDED_RADIUS;
      break;
    case "square":
      element.style.borderRadius = SQUARE_RADIUS;
      break;
  }

  element.style.display = "flex";
  element.style.alignItems = "center";
  element.style.justifyContent = "center";
  element.style.background = "rgba(255, 255, 255, 0.16)";
  element.style.border = "1px solid rgba(255, 255, 255, 0.45)";
  element.style.color = "#f4f4f5";
  element.style.font = "600 16px/1 system-ui, sans-serif";
  element.style.overflow = "hidden";

  const label = createPart("span", "label");
  label.textContent = control.label;
  label.style.pointerEvents = "none";
  element.append(label);

  /** Touch identifiers currently holding the button; supports two thumbs. */
  const activeTouches = new Set<number>();
  let pressed = false;

  const applyVisual = (active: boolean): void => {
    if (active === pressed) {
      return;
    }
    pressed = active;
    setPressedClass(element, active);
    element.style.transform = active ? PRESSED_TRANSFORM : IDLE_TRANSFORM;
    element.style.opacity = active ? PRESSED_OPACITY : IDLE_OPACITY;
    element.setAttribute("aria-pressed", String(active));
    notifyDebugState(ctx, control.id, active);
  };

  const release = (binding: TouchBinding): void => {
    if (!activeTouches.delete(binding.identifier)) {
      return;
    }
    if (activeTouches.size === 0) {
      // Visual and store change in the same synchronous call (FR-8.7).
      applyVisual(false);
      ctx.input.setButton(control.bit, false);
    }
  };

  return {
    id: control.id,
    element,

    setPressed(active: boolean): void {
      applyVisual(active);
    },

    onTouchStart(binding: TouchBinding): void {
      if (activeTouches.has(binding.identifier)) {
        return;
      }
      const wasIdle = activeTouches.size === 0;
      activeTouches.add(binding.identifier);
      if (wasIdle) {
        applyVisual(true);
        ctx.input.setButton(control.bit, true);
      }
    },

    onTouchMove(): void {
      // A button has no drag behavior; the binding stays pressed until end.
    },

    onTouchEnd(binding: TouchBinding): void {
      release(binding);
    },

    onTouchCancel(binding: TouchBinding): void {
      release(binding);
    },

    getState(): Partial<InputState> {
      return { buttons: pressed ? 1 << control.bit : 0 };
    },

    dispose(): void {
      activeTouches.clear();
      if (pressed) {
        applyVisual(false);
        ctx.input.setButton(control.bit, false);
      }
      element.remove();
    },
  };
}
