/**
 * Touchpad control renderer (D5-CTRL-01; CP-12; FR-8.1, FR-8.3, FR-8.7,
 * FR-7.7, AR-5).
 *
 * Maps the absolute touch position to `rx`/`ry` i16 values in
 * [-32767, 32767]: the box center is (0, 0), the right edge is +32767 on x and
 * the bottom edge +32767 on y (screen coordinates, matching the stick). A
 * radial dead zone covers 2% of the half-extent, so a resting thumb on the
 * middle reports exactly zero (FR-7.7). One finger owns the pad; a second is
 * ignored until the first lifts. The control writes axes only — it never sets
 * a button bit or emits an event.
 *
 * `InputStore` applies the D2 stick curve (8% radial deadzone + rescale) at
 * snapshot time. The touchpad's contract is an absolute position with a 2%
 * snap, so it pre-inverts that curve: feeding `0.08 + s * 0.92` along the
 * touch direction makes the store encode exactly `s * 32767`. That keeps the
 * pad linear without adding a second, pad-specific path through the store.
 *
 * Visual contract (CP-12): the element carries `.control` +
 * `.control-touchpad` and `.is-pressed`; `styles.css` owns the pad surface,
 * both crosshair axes, the trail and the pressed knob colour. The renderer
 * owns geometry only — two crosshair lines, an 18% knob, a 1px trail from the
 * centre to the knob and the `Look` label.
 */
import type { TouchpadControl } from "@lanpad/sdk";
import type { InputState } from "@lanpad/protocol";
import { DEFAULT_STICK_DEADZONE, MAX_AXIS_VALUE } from "../input/InputStore.js";
import {
  applyControlClasses,
  applyControlElementStyle,
  createPart,
  measureControl,
  notifyDebugState,
  setPressed,
  type ControlContext,
  type ControlRenderer,
} from "./control.js";
import type { TouchBinding } from "../touch/touchEngine.js";

/** Radial fraction of the half-extent that snaps to dead center. */
const CENTER_SNAP_RATIO = 0.02;
const CENTER_TRANSFORM = "translate(-50%, -50%)";
const KNOB_RETURN_TRANSITION = "transform 120ms ease-out";
const KNOB_SCALE = "18%";

interface EncodedAxis {
  x: number;
  y: number;
}

/**
 * Encodes one normalized pad position exactly as the store will encode it.
 * The store clamps the vector magnitude to 1, so a corner (|v| ≈ 1.414) is
 * radial rather than per-axis; `getState` mirrors that.
 */
export function encodeTouchpadAxis(x: number, y: number): EncodedAxis {
  const magnitude = Math.hypot(x, y);
  if (magnitude <= CENTER_SNAP_RATIO) {
    return { x: 0, y: 0 };
  }
  const scale = Math.min(1, magnitude);
  return {
    x: Math.round((x / magnitude) * scale * MAX_AXIS_VALUE),
    y: Math.round((y / magnitude) * scale * MAX_AXIS_VALUE),
  };
}

/** Feeds the store so its stick curve encodes the requested absolute value. */
function feedMagnitude(magnitude: number): number {
  const scale = Math.min(1, magnitude);
  return DEFAULT_STICK_DEADZONE + scale * (1 - DEFAULT_STICK_DEADZONE);
}

export function createTouchpadControl(
  control: TouchpadControl,
  ctx: ControlContext,
): ControlRenderer {
  const box = measureControl(control, ctx.surfaceSize);

  const element = document.createElement("div");
  applyControlElementStyle(element, control, box, ctx);
  applyControlClasses(element, "touchpad");
  element.setAttribute("role", "application");
  element.setAttribute("aria-label", "touchpad");

  const crosshairX = createPart("div", "crosshair-x");
  element.append(crosshairX);

  const crosshairY = createPart("div", "crosshair-y");
  element.append(crosshairY);

  const radiusX = box.width / 2;
  const radiusY = box.height / 2;
  const maxTrailLength = Math.hypot(radiusX, radiusY);

  const trail = createPart("div", "trail");
  trail.style.width = `${maxTrailLength}px`;
  trail.hidden = true;
  element.append(trail);

  const knob = createPart("div", "knob");
  knob.style.width = KNOB_SCALE;
  knob.style.height = KNOB_SCALE;
  knob.style.transform = CENTER_TRANSFORM;
  element.append(knob);

  const label = createPart("span", "label");
  label.textContent = "Look";
  element.append(label);

  let activeIdentifier: number | null = null;
  let axisX = 0;
  let axisY = 0;
  let pressed = false;

  const applyVisual = (active: boolean): void => {
    if (active === pressed) {
      return;
    }
    pressed = active;
    setPressed(element, active);
    trail.hidden = !active;
    notifyDebugState(ctx, control.id, active);
  };

  const applyPoint = (clientX: number, clientY: number): void => {
    const withinX = Math.min(box.left + box.width, Math.max(box.left, clientX));
    const withinY = Math.min(box.top + box.height, Math.max(box.top, clientY));
    const x = ((withinX - box.left) / box.width) * 2 - 1;
    const y = ((withinY - box.top) / box.height) * 2 - 1;

    const encoded = encodeTouchpadAxis(x, y);
    if (encoded.x === axisX && encoded.y === axisY) {
      return;
    }
    axisX = encoded.x;
    axisY = encoded.y;

    const magnitude = Math.hypot(x, y);
    if (magnitude <= CENTER_SNAP_RATIO) {
      ctx.input.setAxis("rx", 0);
      ctx.input.setAxis("ry", 0);
    } else {
      const feed = feedMagnitude(magnitude) / magnitude;
      ctx.input.setAxis("rx", x * feed);
      ctx.input.setAxis("ry", y * feed);
    }

    const knobX = x * radiusX;
    const knobY = y * radiusY;
    knob.style.transition = "none";
    knob.style.transform = `${CENTER_TRANSFORM} translate3d(${knobX.toFixed(2)}px, ${knobY.toFixed(2)}px, 0)`;

    const trailLength = Math.hypot(knobX, knobY);
    const trailAngle = Math.atan2(knobY, knobX);
    trail.style.transform =
      `translate(0, -50%) rotate(${trailAngle.toFixed(4)}rad) ` +
      `scaleX(${(trailLength / maxTrailLength).toFixed(4)})`;
  };

  const release = (binding: TouchBinding): void => {
    if (binding.identifier !== activeIdentifier) {
      return;
    }
    activeIdentifier = null;
    axisX = 0;
    axisY = 0;
    ctx.input.setAxis("rx", 0);
    ctx.input.setAxis("ry", 0);
    applyVisual(false);
    knob.style.transition = KNOB_RETURN_TRANSITION;
    knob.style.transform = CENTER_TRANSFORM;
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
      applyPoint(binding.startX, binding.startY);
    },

    onTouchMove(binding: TouchBinding): void {
      if (binding.identifier !== activeIdentifier) {
        return;
      }
      applyPoint(binding.lastX, binding.lastY);
    },

    onTouchEnd(binding: TouchBinding): void {
      release(binding);
    },

    onTouchCancel(binding: TouchBinding): void {
      release(binding);
    },

    getState(): Partial<InputState> {
      return { rx: axisX, ry: axisY };
    },

    dispose(): void {
      activeIdentifier = null;
      axisX = 0;
      axisY = 0;
      ctx.input.setAxis("rx", 0);
      ctx.input.setAxis("ry", 0);
      applyVisual(false);
      trail.hidden = true;
      element.remove();
    },
  };
}
