/**
 * Trigger control renderer (D5-CTRL-01; CP-10; FR-8.1, FR-8.3, FR-8.7,
 * FR-7.7, AR-5).
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
 *
 * Visual contract (CP-10): the element carries `.control` +
 * `.control-trigger` and `.is-pressed`; `styles.css` owns the track, fill,
 * border and press expression. The renderer adds the `LT`/`RT` label and a
 * value readout that tracks the thumb for 600 ms after a pull starts. The
 * track clips its children, so the readout is kept just inside the top edge
 * instead of floating outside the bar.
 */
import type { TriggerControl } from "@lanpad/sdk";
import type { InputState } from "@lanpad/protocol";
import { MAX_TRIGGER_VALUE } from "../input/InputStore.js";
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

const READOUT_VISIBLE_MS = 600;
const READOUT_GAP_PX = 8;
/** Clamp so `translate(-100%)` keeps the readout inside the clipped track. */
const READOUT_MIN_BOTTOM_PX = 18;

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
  applyControlClasses(element, "trigger");
  element.setAttribute("role", "slider");
  element.setAttribute("aria-label", `trigger ${control.channel}`);
  element.setAttribute("aria-orientation", orientation);
  element.setAttribute("aria-valuemin", "0");
  element.setAttribute("aria-valuemax", String(MAX_TRIGGER_VALUE));
  element.setAttribute("aria-valuenow", "0");

  const fill = createPart("div", "fill");
  fill.style.transform = orientation === "vertical" ? "scaleY(0)" : "scaleX(0)";
  element.append(fill);

  const label = createPart("span", "label");
  label.textContent = control.channel === "lt" ? "LT" : "RT";
  element.append(label);

  const readout = createPart("span", "value");
  readout.hidden = true;
  element.append(readout);

  let activeIdentifier: number | null = null;
  let value = 0;
  let pressed = false;
  let readoutPercent = -1;
  let readoutShownForGesture = false;
  let readoutTimer: ReturnType<typeof setTimeout> | null = null;

  const updateReadout = (next: number): void => {
    if (readout.hidden) {
      return;
    }
    const percent = Math.round(next * 100);
    if (percent !== readoutPercent) {
      readoutPercent = percent;
      readout.textContent = `${percent}%`;
    }

    if (orientation === "vertical") {
      const thumbY = (1 - next) * box.height;
      const bottom = Math.max(READOUT_MIN_BOTTOM_PX, thumbY - READOUT_GAP_PX);
      readout.style.transform =
        `translate(-50%, -100%) translate3d(0, ${bottom.toFixed(2)}px, 0)`;
    } else {
      const thumbX = next * box.width;
      const offsetX = thumbX - box.width / 2;
      readout.style.transform =
        `translate(-50%, -100%) translate3d(${offsetX.toFixed(2)}px, ` +
        `${READOUT_MIN_BOTTOM_PX}px, 0)`;
    }
  };

  const hideReadout = (): void => {
    if (readoutTimer !== null) {
      clearTimeout(readoutTimer);
      readoutTimer = null;
    }
    readout.hidden = true;
    readoutPercent = -1;
  };

  const showReadout = (): void => {
    hideReadout();
    readout.hidden = false;
    readoutPercent = -1;
    updateReadout(value);
    readoutTimer = setTimeout(() => {
      readout.hidden = true;
      readoutTimer = null;
    }, READOUT_VISIBLE_MS);
  };

  const applyVisual = (active: boolean): void => {
    if (active === pressed) {
      return;
    }
    pressed = active;
    setPressed(element, active);
    if (!active) {
      hideReadout();
      readoutShownForGesture = false;
    }
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

    if (pressed && clamped > 0 && !readoutShownForGesture) {
      readoutShownForGesture = true;
      showReadout();
    } else {
      updateReadout(clamped);
    }
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
      readoutShownForGesture = false;
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
      hideReadout();
      element.remove();
    },
  };
}
