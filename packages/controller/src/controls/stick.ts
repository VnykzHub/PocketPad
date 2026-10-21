/**
 * Stick control renderer (D2-CTRL-02; FR-8.1, FR-8.3, FR-8.7, FR-7.4, AR-5).
 *
 * Fixed mode: the base stays centered at the layout position and only the knob
 * follows the finger. Floating mode: the base appears at the touch point and
 * the knob follows from there. The touch delta is clamped to the base radius,
 * normalized, and written to the bound `InputStore` axis in [-1, 1]; the store
 * applies the wire-level 8% radial deadzone and i16 encoding at snapshot time
 * (FR-7.4).
 *
 * The renderer additionally zeroes deflection inside the layout's own deadzone
 * (`deadzone`, default 8%) so a custom layout deadzone is honored without
 * rescaling twice. `getState()` reports the same i16 contribution the store
 * will encode for the default deadzone.
 *
 * All knob/base movement happens synchronously in the touch handler through
 * `transform`; only the return-to-center animates, and it does so after state
 * has already gone to zero (FR-8.3, FR-8.7).
 */
import type { StickControl } from "@lanpad/sdk";
import type { InputState } from "@lanpad/protocol";
import { DEFAULT_STICK_DEADZONE, MAX_AXIS_VALUE } from "../input/InputStore.js";
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

const KNOB_SCALE = "42%";
const IDLE_KNOB_OPACITY = "0.85";
const PRESSED_KNOB_OPACITY = "1";
const CENTER_TRANSFORM = "translate(-50%, -50%)";
const KNOB_RETURN_TRANSITION = "transform 120ms ease-out";
const BASE_FADE_TRANSITION = "opacity 150ms ease-out";

function resolveDeadzone(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_STICK_DEADZONE;
  }
  return Math.min(0.5, Math.max(0, value));
}

export function createStickControl(control: StickControl, ctx: ControlContext): ControlRenderer {
  const box = measureControl(control, ctx.surfaceSize);
  const element = document.createElement("div");
  applyControlElementStyle(element, control, box, ctx);
  element.classList.add("control", "control-stick");
  element.setAttribute("role", "application");
  element.setAttribute("aria-label", `${control.axis} stick ${control.id}`);

  const base = createPart("div", "base");
  base.style.position = "absolute";
  base.style.left = "50%";
  base.style.top = "50%";
  base.style.width = "100%";
  base.style.height = "100%";
  base.style.borderRadius = "50%";
  base.style.background = "rgba(255, 255, 255, 0.10)";
  base.style.border = "1px solid rgba(255, 255, 255, 0.30)";
  base.style.transform = CENTER_TRANSFORM;
  base.style.opacity = control.mode === "floating" ? "0" : "1";
  element.append(base);

  const knob = createPart("div", "knob");
  knob.style.position = "absolute";
  knob.style.left = "50%";
  knob.style.top = "50%";
  knob.style.width = KNOB_SCALE;
  knob.style.height = KNOB_SCALE;
  knob.style.borderRadius = "50%";
  knob.style.background = "rgba(255, 255, 255, 0.35)";
  knob.style.border = "1px solid rgba(255, 255, 255, 0.55)";
  knob.style.transform = CENTER_TRANSFORM;
  knob.style.opacity = IDLE_KNOB_OPACITY;
  knob.style.pointerEvents = "none";
  element.append(knob);

  const radius = box.width / 2;
  const deadzone = resolveDeadzone(control.deadzone);
  const axisX = control.axis === "left" ? "lx" : "rx";
  const axisY = control.axis === "left" ? "ly" : "ry";

  let activeIdentifier: number | null = null;
  let originX = box.centerX;
  let originY = box.centerY;
  let axisValueX = 0;
  let axisValueY = 0;
  let pressed = false;

  const applyVisual = (active: boolean): void => {
    if (active === pressed) {
      return;
    }
    pressed = active;
    setPressedClass(element, active);
    knob.style.opacity = active ? PRESSED_KNOB_OPACITY : IDLE_KNOB_OPACITY;
    notifyDebugState(ctx, control.id, active);
  };

  const setAxis = (x: number, y: number): void => {
    if (x === axisValueX && y === axisValueY) {
      return;
    }
    axisValueX = x;
    axisValueY = y;
    ctx.input.setAxis(axisX, x);
    ctx.input.setAxis(axisY, y);
  };

  const setKnobOffset = (dx: number, dy: number): void => {
    knob.style.transform = `${CENTER_TRANSFORM} translate3d(${dx}px, ${dy}px, 0)`;
  };

  const release = (binding: TouchBinding): void => {
    if (binding.identifier !== activeIdentifier) {
      return;
    }
    activeIdentifier = null;
    // State returns to zero immediately; only the visual return animates.
    setAxis(0, 0);
    applyVisual(false);

    knob.style.transition = KNOB_RETURN_TRANSITION;
    setKnobOffset(0, 0);

    if (control.mode === "floating") {
      base.style.transition = BASE_FADE_TRANSITION;
      base.style.opacity = "0";
    }
  };

  return {
    id: control.id,
    element,

    setPressed(active: boolean): void {
      applyVisual(active);
    },

    onTouchStart(binding: TouchBinding): void {
      // One finger owns a stick; a second touch is ignored until the first ends.
      if (activeIdentifier !== null) {
        return;
      }
      activeIdentifier = binding.identifier;
      originX = control.mode === "floating" ? binding.startX : box.centerX;
      originY = control.mode === "floating" ? binding.startY : box.centerY;

      knob.style.transition = "none";
      if (control.mode === "floating") {
        base.style.transition = "none";
        base.style.opacity = "1";
        base.style.transform = `${CENTER_TRANSFORM} translate3d(${originX - box.centerX}px, ${originY - box.centerY}px, 0)`;
      }

      applyVisual(true);
      setKnobOffset(0, 0);
      setAxis(0, 0);
    },

    onTouchMove(binding: TouchBinding): void {
      if (binding.identifier !== activeIdentifier) {
        return;
      }

      const rawDx = binding.lastX - originX;
      const rawDy = binding.lastY - originY;
      const rawDistance = Math.hypot(rawDx, rawDy);

      let dx = rawDx;
      let dy = rawDy;
      if (rawDistance > radius && rawDistance > 0) {
        const clamp = radius / rawDistance;
        dx = rawDx * clamp;
        dy = rawDy * clamp;
      }
      setKnobOffset(dx, dy);

      const nx = dx / radius;
      const ny = dy / radius;
      if (Math.hypot(nx, ny) <= deadzone) {
        setAxis(0, 0);
      } else {
        setAxis(nx, ny);
      }
    },

    onTouchEnd(binding: TouchBinding): void {
      release(binding);
    },

    onTouchCancel(binding: TouchBinding): void {
      release(binding);
    },

    getState(): Partial<InputState> {
      const magnitude = Math.hypot(axisValueX, axisValueY);
      if (magnitude <= deadzone) {
        return axisX === "lx" ? { lx: 0, ly: 0 } : { rx: 0, ry: 0 };
      }

      const scaled = (Math.min(1, magnitude) - deadzone) / (1 - deadzone);
      const unitX = axisValueX / magnitude;
      const unitY = axisValueY / magnitude;
      const outX = Math.round(unitX * scaled * MAX_AXIS_VALUE);
      const outY = Math.round(unitY * scaled * MAX_AXIS_VALUE);
      return axisX === "lx" ? { lx: outX, ly: outY } : { rx: outX, ry: outY };
    },

    dispose(): void {
      activeIdentifier = null;
      setAxis(0, 0);
      applyVisual(false);
      base.style.opacity = control.mode === "floating" ? "0" : "1";
      base.style.transform = CENTER_TRANSFORM;
      knob.style.transition = "none";
      setKnobOffset(0, 0);
      element.remove();
    },
  };
}
