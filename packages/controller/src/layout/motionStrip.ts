/**
 * Sensors-only motion status strip (D6-CTRL-03; FR-8.5, FR-8.10, AR-3, AR-5, E7).
 *
 * A layout may declare `sensors.gyro` without rendering a visible `gyro`
 * control ("steer"/"aim"/"tilt" layouts). D6-CTRL-03 requires a small visible
 * status strip plus an enable button in that case; without it the sensor is
 * unreachable and the player has no idea motion exists.
 *
 * The strip reuses the gyro control's behaviour (`MotionEnable` +
 * `MotionSource` + `GyroSampleBinding`):
 *
 * - It is registered with the touch engine as one pseudo-control, so a tap
 *   follows the same synchronous path as every other control (permission is
 *   requested inside the gesture).
 * - The cached hit rect is inset by `DEFAULT_SLOP_PX` so the engine's global
 *   slop expands it back to exactly the visible bounds: touches 1 px outside
 *   the strip still belong to the fallback controls underneath.
 * - The DOM itself has `pointer-events: none`; the engine owns hit-testing, so
 *   native pointer handling can never intercept anything outside the strip.
 * - Insecure-context, unsupported, denied, requesting, no-data and paused
 *   states all stay visible with the touch fallback untouched (FR-8.10,
 *   AR-3).
 * - Disposal (layout swap, surface rebuild) and `visibilitychange` stop the
 *   sensor; visibility return restarts it only when the player had enabled it
 *   (MotionEnable owns that state machine).
 */
import type { InputState } from "@lanpad/protocol";
import {
  createPart,
  type ControlContext,
  type ControlRenderer,
  type SurfaceSize,
} from "../controls/control.js";
import {
  GyroSampleBinding,
  createBrowserGyroRuntime,
  type GyroControlRuntime,
} from "../controls/gyro.js";
import { readMotionEnvironment } from "../sensors/motionPermission.js";
import {
  MotionEnable,
  isMotionStateDisabled,
  type MotionEnableState,
} from "../sensors/MotionEnable.js";
import { DEFAULT_SLOP_PX, MIN_TOUCH_TARGET_PX, type HitRect } from "../touch/hitTest.js";
import type { TouchBinding } from "../touch/touchEngine.js";

/** Synthetic renderer id; `ControllerLayoutView` makes it unique per layout. */
export const MOTION_STRIP_ID = "__motion-strip";

/** Compact strip built for a phone held in either orientation. */
export const MOTION_STRIP_WIDTH_PX = 300;
export const MOTION_STRIP_HEIGHT_PX = 60;
/** Gap from the top edge; the strip never spans the surface. */
export const MOTION_STRIP_TOP_PX = 8;
/** AR-5: the action button is a 44 px-tall target. */
export const MOTION_STRIP_ACTION_HEIGHT_PX = MIN_TOUCH_TARGET_PX;
export const MOTION_STRIP_ACTION_WIDTH_PX = 112;
/** The strip stays above default controls inside its own bounds only. */
export const MOTION_STRIP_Z = 10;

/** Rendered strip box in surface CSS pixels. */
export interface MotionStripBounds {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Top-center placement, shrunk to fit surfaces narrower than the strip. */
export function motionStripBounds(surface: SurfaceSize): MotionStripBounds {
  const width = Math.max(0, Math.min(MOTION_STRIP_WIDTH_PX, surface.width - 16));
  return {
    left: Math.max(0, (surface.width - width) / 2),
    top: MOTION_STRIP_TOP_PX,
    width,
    height: MOTION_STRIP_HEIGHT_PX,
  };
}

/**
 * Touch-engine rect for the strip.
 *
 * `hitTest` expands every rect by `DEFAULT_SLOP_PX`; inverting that expansion
 * here makes the strip's effective target exactly its visual bounds, so it
 * cannot steal a touch that landed on a fallback control just outside the
 * strip (D6-CTRL-03 "must not intercept touches outside its bounds").
 */
export function motionStripHitRect(
  surface: SurfaceSize,
  controlId: string = MOTION_STRIP_ID,
): HitRect {
  const bounds = motionStripBounds(surface);
  return {
    controlId,
    left: bounds.left + DEFAULT_SLOP_PX,
    top: bounds.top + DEFAULT_SLOP_PX,
    width: Math.max(0, bounds.width - DEFAULT_SLOP_PX * 2),
    height: Math.max(0, bounds.height - DEFAULT_SLOP_PX * 2),
    z: MOTION_STRIP_Z,
  };
}

export interface MotionStripOptions {
  /** Unique renderer id; the layout view supplies one when ids collide. */
  readonly id?: string | undefined;
  /** Injected browser runtime; defaults to the real sensor/environment. */
  readonly runtime?: GyroControlRuntime | undefined;
  /** `layout.sensors.smoothing`, applied through `MotionSource.start`. */
  readonly smoothing?: number | undefined;
  /** `layout.sensors.sensitivity`, applied through `MotionSource.start`. */
  readonly sensitivity?: number | undefined;
}

/** Label on the strip's action control for a state (D6-CTRL-03). */
export function motionStripActionLabel(state: MotionEnableState): string {
  if (state === "granted") {
    return "Recalibrate";
  }
  if (state === "paused") {
    return "Motion paused";
  }
  return "Enable motion";
}

/** Whether the strip's action control can be activated in `state`. */
export function isMotionStripActionDisabled(state: MotionEnableState): boolean {
  return state === "paused" || isMotionStateDisabled(state);
}

/**
 * Builds the motion status strip renderer.
 *
 * The renderer follows the `ControlRenderer` contract so the layout view can
 * mount it beside the layout's controls and route touches to it by id.
 */
export function createMotionStatusStrip(
  ctx: ControlContext,
  options: MotionStripOptions = {},
): ControlRenderer {
  const id = options.id ?? MOTION_STRIP_ID;
  const bounds = motionStripBounds(ctx.surfaceSize);
  const smoothing = options.smoothing;
  const sensitivity = options.sensitivity;

  const element = document.createElement("div");
  element.classList.add("motion-strip");
  element.dataset["motionStrip"] = "";
  element.dataset["controlId"] = id;
  element.dataset["controlType"] = "motion-strip";
  element.style.position = "absolute";
  element.style.left = `${bounds.left}px`;
  element.style.top = `${bounds.top}px`;
  element.style.width = `${bounds.width}px`;
  element.style.height = `${bounds.height}px`;
  element.style.zIndex = String(MOTION_STRIP_Z);
  element.style.boxSizing = "border-box";
  element.style.display = "flex";
  element.style.alignItems = "center";
  element.style.gap = "8px";
  element.style.padding = "8px";
  element.style.borderRadius = "14px";
  element.style.background = "rgba(24, 24, 27, 0.9)";
  element.style.border = "1px solid rgba(255, 255, 255, 0.28)";
  element.style.color = "#f4f4f5";
  element.style.font = "500 12px/15px system-ui, sans-serif";
  element.style.overflow = "hidden";
  element.style.touchAction = "none";
  element.style.userSelect = "none";
  element.style.setProperty("-webkit-user-select", "none");
  element.style.setProperty("-webkit-touch-callout", "none");
  // The TouchEngine owns the strip's hit area; the DOM must never become a
  // native pointer target (D6-CTRL-03: no touch stealing outside the bounds).
  element.style.pointerEvents = "none";
  element.setAttribute("role", "group");
  element.setAttribute("aria-label", "Motion");

  // Visible full-sentence status (the gyro pill keeps its own copy hidden).
  const status = createPart("span", "motion-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.style.flex = "1 1 auto";
  status.style.minWidth = "0";
  // Three lines of the longest fallback sentence fit the 44 px content box.
  status.style.font = "500 12px/14px system-ui, sans-serif";
  status.style.pointerEvents = "none";

  const action = createPart("span", "motion-action");
  action.setAttribute("role", "button");
  action.tabIndex = 0;
  action.style.flex = "0 0 auto";
  action.style.width = `${MOTION_STRIP_ACTION_WIDTH_PX}px`;
  action.style.height = `${String(MOTION_STRIP_ACTION_HEIGHT_PX)}px`;
  action.style.display = "flex";
  action.style.alignItems = "center";
  action.style.justifyContent = "center";
  action.style.borderRadius = "999px";
  action.style.background = "rgba(255, 255, 255, 0.16)";
  action.style.font = "600 13px/1 system-ui, sans-serif";
  action.style.pointerEvents = "none";

  element.append(status, action);

  const runtime = options.runtime ?? createBrowserGyroRuntime({ smoothing, sensitivity });
  const source = runtime.source;
  const binding = new GyroSampleBinding(ctx.input, source, runtime.sampleScheduler);

  const syncAction = (state: MotionEnableState): void => {
    action.textContent = motionStripActionLabel(state);
    action.setAttribute(
      "aria-disabled",
      isMotionStripActionDisabled(state) ? "true" : "false",
    );
  };

  const motionEnable = new MotionEnable(
    { root: element, label: action, status },
    {
      environment: runtime.environment ?? readMotionEnvironment(),
      startListening: () => {
        source.start({ smoothing, sensitivity });
        binding.start();
      },
      stopListening: () => {
        binding.stop();
        source.stop();
      },
      recalibrate: () => {
        source.recalibrate();
      },
      requestPermission: runtime.requestPermission,
      scheduler: runtime.motionScheduler,
      visibility: runtime.visibility,
      noDataTimeoutMs: runtime.noDataTimeoutMs,
      onStateChange: syncAction,
    },
  );
  syncAction(motionEnable.state);

  source.onEvent = (): void => {
    motionEnable.notifyMotionData();
  };

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    void motionEnable.activate();
  };
  action.addEventListener("keydown", handleKeyDown);

  let activeIdentifier: number | null = null;

  const setPressed = (active: boolean): void => {
    element.dataset["pressed"] = active ? "true" : "false";
    action.style.background = active
      ? "rgba(255, 255, 255, 0.32)"
      : "rgba(255, 255, 255, 0.16)";
  };

  const release = (touch: TouchBinding): void => {
    if (touch.identifier !== activeIdentifier) {
      return;
    }
    activeIdentifier = null;
    setPressed(false);
  };

  return {
    id,
    element,

    setPressed,

    onTouchStart(touch: TouchBinding): void {
      if (activeIdentifier !== null) {
        return;
      }
      activeIdentifier = touch.identifier;
      setPressed(true);
      // Called synchronously inside the touchstart gesture so iOS accepts the
      // permission request; MotionEnable handles every fallback state itself.
      void motionEnable.activate();
    },

    onTouchMove(): void {
      // No drag behaviour; the strip is a single action target.
    },

    onTouchEnd(touch: TouchBinding): void {
      release(touch);
    },

    onTouchCancel(touch: TouchBinding): void {
      release(touch);
    },

    getState(): Partial<InputState> {
      // Levels are written straight into InputStore by the 60 Hz binding.
      return {};
    },

    dispose(): void {
      activeIdentifier = null;
      action.removeEventListener("keydown", handleKeyDown);
      motionEnable.dispose();
      source.onEvent = null;
      setPressed(false);
      element.remove();
    },
  };
}
