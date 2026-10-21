/**
 * Gyro control renderer (D5-CTRL-01; FR-8.1, FR-8.3, FR-8.10, AR-5).
 *
 * D5 renders the layout's motion affordance but does not own sensors: D6-CTRL-03
 * adds `DeviceMotionEvent` permission, sampling and fallback behavior. Until
 * then the control is an honest, inert "Enable motion" prompt — it takes
 * pressed feedback so the layout feels alive, writes no `InputStore` state and
 * emits no event. A layout that includes a gyro control always includes a
 * non-gyro fallback (validator rule), so this placeholder never blocks play.
 *
 * D6 replaces the prompt's behavior in place; the element contract used by the
 * debug overlay (`data-control-type="gyro"`) stays the same.
 */
import type { GyroControl } from "@lanpad/sdk";
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

const IDLE_TRANSFORM = "scale(1)";
const PRESSED_TRANSFORM = "scale(0.96)";
const IDLE_OPACITY = "0.8";
const PRESSED_OPACITY = "1";

export function createGyroControl(control: GyroControl, ctx: ControlContext): ControlRenderer {
  const box = measureControl(control, ctx.surfaceSize);

  const element = document.createElement("div");
  applyControlElementStyle(element, control, box, ctx);
  element.classList.add("control", "control-gyro");
  element.setAttribute("role", "button");
  element.setAttribute("aria-label", "Enable motion");
  element.setAttribute("aria-disabled", "true");
  element.style.display = "flex";
  element.style.alignItems = "center";
  element.style.justifyContent = "center";
  element.style.borderRadius = "999px";
  element.style.background = "rgba(255, 255, 255, 0.10)";
  element.style.border = "1px dashed rgba(255, 255, 255, 0.55)";
  element.style.color = "#f4f4f5";
  element.style.font = "600 15px/1 system-ui, sans-serif";
  element.style.opacity = IDLE_OPACITY;

  const label = createPart("span", "label");
  label.textContent = "Enable motion";
  label.style.pointerEvents = "none";
  element.append(label);

  let pressed = false;
  let activeIdentifier: number | null = null;

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

  const release = (binding: TouchBinding): void => {
    if (binding.identifier !== activeIdentifier) {
      return;
    }
    activeIdentifier = null;
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
    },

    onTouchMove(): void {
      // No drag behavior; the prompt only shows pressed feedback.
    },

    onTouchEnd(binding: TouchBinding): void {
      release(binding);
    },

    onTouchCancel(binding: TouchBinding): void {
      release(binding);
    },

    getState(): Partial<InputState> {
      return {};
    },

    dispose(): void {
      activeIdentifier = null;
      applyVisual(false);
      element.remove();
    },
  };
}
