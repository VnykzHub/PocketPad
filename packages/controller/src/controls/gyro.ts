/**
 * Gyro control renderer (D5-CTRL-01, D6-CTRL-02/03; FR-8.1, FR-8.5, FR-8.10,
 * FR-7.5, FR-7.6, AR-5).
 *
 * D5 rendered the layout's motion affordance as an inert "Enable motion"
 * prompt. D6 turns it into the real sensor entry point:
 *
 * - A tap requests motion permission only when the browser needs one
 *   (`DeviceMotionEvent.requestPermission`), then starts the sensor.
 * - `GyroSampleBinding` samples `MotionSource.latest` at 60 Hz and writes the
 *   encoded `gx/gy/gz` plus `flags` (bit 0 active, bit 1 recentered) into the
 *   shared `InputStore`; the existing SendLoop snapshots that store.
 * - Denied permission, an insecure context, an unsupported browser or a
 *   missing sensor stream leaves the pill visible and disabled while every
 *   other control keeps working (FR-8.10). The visible label stays "Enable
 *   motion" in every fallback state so the D5 element contract is unchanged.
 * - Tapping again after motion is on re-opens the auto-zero window and marks
 *   the next packet recentered (FR-7.6).
 *
 * Visual grammar (CP-13, DESIGN.md): `.control` + `.control-gyro`, the shared
 * `.is-pressed`, and `.is-disabled`/`.is-unavailable` for the fallback states.
 * styles.css owns the card, the level ring and the 44 px recenter target; this
 * file owns state copy and the bubble transform. The bubble is display-only:
 * it integrates the same wire rate the host integrates to `tilt`, clamped to
 * the host's +/-30 degrees, and never changes the emitted sample.
 *
 * Everything browser-specific is injected through `GyroControlRuntime`, so
 * tests can drive the full path with fake events and fake timers. The default
 * runtime resolves `window`, `screen`, `performance` and `document` lazily
 * when the control is constructed, never at import time.
 */
import type { GyroControl } from "@lanpad/sdk";
import type { InputState } from "@lanpad/protocol";
import {
  applyControlClasses,
  applyControlElementStyle,
  createPart,
  makeControlFocusable,
  measureControl,
  notifyDebugState,
  setDisabled,
  setPressedClass,
  setUnavailable,
  type ControlContext,
  type ControlRenderer,
} from "./control.js";
import type { TouchBinding } from "../touch/touchEngine.js";
import type { InputStore } from "../input/InputStore.js";
import {
  GYRO_WIRE_SCALE,
  MotionSource,
  type DeviceRotationRateEvent,
  type MotionSample,
} from "../sensors/MotionSource.js";
import {
  MotionEnable,
  isMotionStateDisabled,
  type MotionEnableState,
  type MotionScheduler as MotionEnableScheduler,
  type MotionVisibilityTarget,
} from "../sensors/MotionEnable.js";
import {
  readMotionEnvironment,
  requestMotionPermission,
  type MotionEnvironment,
  type MotionPermissionState,
} from "../sensors/motionPermission.js";

/** flags bit 0: motion data is flowing (FR-7.6). */
export const FLAG_MOTION_ACTIVE = 1;
/** flags bit 1: the next packet follows a recalibration (FR-7.6). */
export const FLAG_RECENTERED = 2;

/** Sensor sample cadence; the send loop also snapshots at 60 Hz. */
export const GYRO_SAMPLE_HZ = 60;
export const GYRO_SAMPLE_INTERVAL_MS = 1000 / GYRO_SAMPLE_HZ;

/** Host tilt clamp; the level bubble mirrors the same +/-30 degree range. */
const LEVEL_MAX_ANGLE_DEG = 30;
/** Bubble travel inside the 64x24 level ring (20 px bubble). */
const LEVEL_TRAVEL_X_PX = 20;
const LEVEL_TRAVEL_Y_PX = 2;

/** Visible one-line state copy (CP-13). The granted state shows the bubble. */
const MOTION_REASON_TEXT: Record<MotionEnableState, string> = {
  idle: "Tap to enable motion",
  requesting: "Allow motion…",
  granted: "",
  denied: "Motion blocked — use the buttons",
  "no-data": "No motion data",
  paused: "Motion paused",
  "insecure-context": "Motion needs HTTPS",
  unsupported: "No motion sensor",
};

/** Minimal interval scheduler (injected so tests need no real clock). */
export interface GyroScheduler {
  setInterval(callback: () => void, ms: number): number;
  clearInterval(handle: number): void;
}

const DEFAULT_GYRO_SCHEDULER: GyroScheduler = {
  setInterval: (callback, ms) => globalThis.setInterval(callback, ms) as unknown as number,
  clearInterval: (handle) => {
    globalThis.clearInterval(handle);
  },
};

function clampAngle(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value > LEVEL_MAX_ANGLE_DEG) {
    return LEVEL_MAX_ANGLE_DEG;
  }
  return value < -LEVEL_MAX_ANGLE_DEG ? -LEVEL_MAX_ANGLE_DEG : value;
}

/**
 * Copies the current motion sample into the InputStore at 60 Hz.
 *
 * The store, not the `devicemotion` callback, is the single writer of gyro
 * fields on the wire. `stop()` writes an inactive zero sample so the host
 * cannot keep steering with a stale rate. `onSample` is a display-only hook
 * (the level bubble); it never changes what is written.
 */
export class GyroSampleBinding {
  private readonly input: InputStore;
  private readonly source: MotionSource;
  private readonly scheduler: GyroScheduler;
  private handle: number | null = null;

  /**
   * Optional observer called after each sample is written, with the stable
   * sample object and whether this packet consumed a recalibration.
   */
  onSample: ((sample: MotionSample, recentered: boolean) => void) | null = null;

  constructor(input: InputStore, source: MotionSource, scheduler?: GyroScheduler) {
    this.input = input;
    this.source = source;
    this.scheduler = scheduler ?? DEFAULT_GYRO_SCHEDULER;
  }

  get isRunning(): boolean {
    return this.handle !== null;
  }

  /** Starts sampling; idempotent. An immediate tick publishes the first state. */
  start(): void {
    if (this.handle !== null) {
      return;
    }
    this.tick();
    this.handle = this.scheduler.setInterval(() => {
      this.tick();
    }, GYRO_SAMPLE_INTERVAL_MS);
  }

  /** Stops sampling and clears the wire fields. Idempotent. */
  stop(): void {
    if (this.handle !== null) {
      this.scheduler.clearInterval(this.handle);
      this.handle = null;
    }
    this.input.setGyro(0, 0, 0);
    this.input.setFlags(0);
  }

  /** One sampling step; public so tests can advance without timers. */
  tick(): void {
    const sample = this.source.latest;
    this.input.setGyro(sample.gx, sample.gy, sample.gz);

    let flags = 0;
    if (sample.active) {
      flags |= FLAG_MOTION_ACTIVE;
    }
    const recentered = this.source.consumeRecentered();
    if (recentered) {
      flags |= FLAG_RECENTERED;
    }
    this.input.setFlags(flags);
    this.onSample?.(sample, recentered);
  }
}

/** Browser dependencies for the gyro control; all optional except the source. */
export interface GyroControlRuntime {
  readonly source: MotionSource;
  readonly environment?: MotionEnvironment | undefined;
  readonly requestPermission?:
    | ((environment: MotionEnvironment) => Promise<MotionPermissionState>)
    | undefined;
  readonly sampleScheduler?: GyroScheduler | undefined;
  readonly motionScheduler?: MotionEnableScheduler | undefined;
  readonly visibility?: MotionVisibilityTarget | null | undefined;
  readonly noDataTimeoutMs?: number | undefined;
  readonly smoothing?: number | undefined;
  readonly sensitivity?: number | undefined;
}

export interface BrowserGyroRuntimeOptions {
  readonly smoothing?: number | undefined;
  readonly sensitivity?: number | undefined;
}

/** Lazy `screen.orientation.angle`, with the legacy `window.orientation` fallback. */
function readScreenAngle(): number {
  const scope = globalThis as {
    screen?: { orientation?: { angle?: number } };
    orientation?: number;
  };
  const angle = scope.screen?.orientation?.angle;
  if (typeof angle === "number" && Number.isFinite(angle)) {
    return angle;
  }
  const legacy = scope.orientation;
  return typeof legacy === "number" && Number.isFinite(legacy) ? legacy : 0;
}

function readMonotonicNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function addGlobalMotionListener(
  type: "devicemotion",
  callback: (event: DeviceRotationRateEvent) => void,
): void {
  const target = globalThis as unknown as {
    addEventListener?: (name: string, listener: EventListener) => void;
  };
  target.addEventListener?.(type, callback as unknown as EventListener);
}

function removeGlobalMotionListener(
  type: "devicemotion",
  callback: (event: DeviceRotationRateEvent) => void,
): void {
  const target = globalThis as unknown as {
    removeEventListener?: (name: string, listener: EventListener) => void;
  };
  target.removeEventListener?.(type, callback as unknown as EventListener);
}

/**
 * Page-visibility surface for the motion state machine (FR-8.8). Wrapped
 * rather than passed as `document` so the listener signatures stay explicit
 * and non-DOM tests can omit it entirely.
 */
function readDocumentVisibility(): MotionVisibilityTarget | undefined {
  if (typeof document === "undefined") {
    return undefined;
  }
  return {
    get hidden(): boolean {
      return document.hidden;
    },
    addEventListener: (type, callback) => {
      document.addEventListener(type, callback);
    },
    removeEventListener: (type, callback) => {
      document.removeEventListener(type, callback);
    },
  };
}

/**
 * Default browser runtime. Called once per rendered gyro control; the sensor
 * listener itself is only attached after the player grants motion.
 */
export function createBrowserGyroRuntime(
  options: BrowserGyroRuntimeOptions = {},
): GyroControlRuntime {
  const source = new MotionSource({
    addEventListener: addGlobalMotionListener,
    removeEventListener: removeGlobalMotionListener,
    getScreenAngle: readScreenAngle,
    now: readMonotonicNow,
  });

  const runtime: {
    source: MotionSource;
    environment: MotionEnvironment;
    requestPermission: (environment: MotionEnvironment) => Promise<MotionPermissionState>;
    visibility?: MotionVisibilityTarget;
    smoothing?: number;
    sensitivity?: number;
  } = {
    source,
    environment: readMotionEnvironment(),
    requestPermission: requestMotionPermission,
  };

  const visibility = readDocumentVisibility();
  if (visibility !== undefined) {
    runtime.visibility = visibility;
  }
  if (options.smoothing !== undefined) {
    runtime.smoothing = options.smoothing;
  }
  if (options.sensitivity !== undefined) {
    runtime.sensitivity = options.sensitivity;
  }

  return runtime;
}

/**
 * Third parameter is optional, so the function stays assignable to the
 * registry's two-argument `ControlFactory`; tests and the shell can inject a
 * runtime to exercise permission/sensor paths without browser APIs.
 */
export function createGyroControl(
  control: GyroControl,
  ctx: ControlContext,
  runtime?: GyroControlRuntime,
): ControlRenderer {
  const effectiveRuntime = runtime ?? createBrowserGyroRuntime();
  const smoothing = control.smoothing ?? effectiveRuntime.smoothing;
  const sensitivity = control.sensitivity ?? effectiveRuntime.sensitivity;

  const box = measureControl(control, ctx.surfaceSize);

  const element = document.createElement("div");
  applyControlElementStyle(element, control, box, ctx);
  applyControlClasses(element, "gyro");
  element.setAttribute("role", "button");

  // Granted face: level bubble + 44 px recenter target (CP-13).
  const level = createPart("div", "level");
  level.setAttribute("aria-hidden", "true");
  level.hidden = true;
  const bubble = createPart("div", "bubble");
  level.append(bubble);

  // Calibration face: the 500 ms auto-zero window is visible, not silent, so a
  // player holding a tilted phone knows to hold still (FR-7.6, CP-13).
  const calibration = createPart("span", "calibration");
  calibration.textContent = "Hold still — calibrating";
  calibration.setAttribute("aria-hidden", "true");
  calibration.hidden = true;

  // Fallback face: the state copy the plan defines for every non-granted state.
  const reason = createPart("span", "reason");
  reason.setAttribute("aria-hidden", "true");
  reason.hidden = true;

  const recenter = createPart("span", "recenter");
  recenter.textContent = "Recenter";
  recenter.setAttribute("aria-hidden", "true");
  recenter.hidden = true;

  // MotionEnable owns this element's text; the visible state copy above is the
  // sighted equivalent, so the label itself stays out of the layout.
  const label = createPart("span", "label");
  label.textContent = "Enable motion";
  label.hidden = true;

  // Screen-reader live region. Visually hidden so the 168x44 pill keeps its
  // D5 geometry; the same text is exposed through `title` for sighted users.
  const status = createPart("span", "motion-status");
  status.style.position = "absolute";
  status.style.width = "1px";
  status.style.height = "1px";
  status.style.overflow = "hidden";
  status.style.clipPath = "inset(50%)";
  status.style.whiteSpace = "nowrap";
  status.style.pointerEvents = "none";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  element.append(level, calibration, reason, recenter, label, status);

  const source = effectiveRuntime.source;
  const binding = new GyroSampleBinding(ctx.input, source, effectiveRuntime.sampleScheduler);

  // Display-only tilt integration, mirroring the host's fixed-step integrator.
  let angleX = 0;
  let angleY = 0;
  let bubbleX = 0;
  let bubbleY = 0;

  const applyBubble = (): void => {
    const x = Math.round((angleY / LEVEL_MAX_ANGLE_DEG) * LEVEL_TRAVEL_X_PX);
    const y = Math.round((-angleX / LEVEL_MAX_ANGLE_DEG) * LEVEL_TRAVEL_Y_PX);
    if (x === bubbleX && y === bubbleY) {
      return;
    }
    bubbleX = x;
    bubbleY = y;
    bubble.style.transform = `translate(-50%, -50%) translate3d(${x}px, ${y}px, 0)`;
  };

  const resetLevel = (): void => {
    angleX = 0;
    angleY = 0;
    applyBubble();
  };

  let granted = false;

  // The level and recenter target give way to the calibration copy for the
  // duration of the auto-zero window; the next post-window sample restores them.
  const updateCalibration = (): void => {
    const calibrating = granted && source.isCalibrating;
    element.classList.toggle("is-calibrating", calibrating);
    calibration.hidden = !calibrating;
    level.hidden = !granted || calibrating;
    recenter.hidden = !granted || calibrating;
  };

  binding.onSample = (sample, recentered): void => {
    updateCalibration();
    if (recentered) {
      resetLevel();
      return;
    }
    if (!sample.active) {
      return;
    }
    const dtSeconds = GYRO_SAMPLE_INTERVAL_MS / 1000;
    angleX = clampAngle(angleX + (sample.gx / GYRO_WIRE_SCALE) * dtSeconds);
    angleY = clampAngle(angleY + (sample.gy / GYRO_WIRE_SCALE) * dtSeconds);
    applyBubble();
  };

  const applyStateChrome = (state: MotionEnableState): void => {
    setUnavailable(
      element,
      state === "denied" ||
        state === "insecure-context" ||
        state === "unsupported" ||
        // styles.css groups the watchdog state with the dashed fallback card.
        state === "no-data",
    );
    setDisabled(element, state === "requesting");
    // MotionEnable is the single owner of aria-disabled; the visual helpers
    // above also touch it, so re-assert the state machine's value.
    element.setAttribute("aria-disabled", isMotionStateDisabled(state) ? "true" : "false");

    const reasonText = MOTION_REASON_TEXT[state];
    reason.textContent = reasonText;
    reason.hidden = reasonText.length === 0;
    granted = state === "granted";
    if (!granted) {
      resetLevel();
    }
    updateCalibration();
  };

  const motionEnable = new MotionEnable(
    { root: element, label, status },
    {
      environment: effectiveRuntime.environment ?? readMotionEnvironment(),
      startListening: () => {
        source.start({ smoothing, sensitivity });
        binding.start();
      },
      stopListening: () => {
        binding.stop();
        source.stop();
        resetLevel();
      },
      recalibrate: () => {
        source.recalibrate();
        resetLevel();
      },
      requestPermission: effectiveRuntime.requestPermission,
      scheduler: effectiveRuntime.motionScheduler,
      visibility: effectiveRuntime.visibility,
      noDataTimeoutMs: effectiveRuntime.noDataTimeoutMs,
      onStateChange: applyStateChrome,
    },
  );
  applyStateChrome(motionEnable.state);

  source.onEvent = (): void => {
    motionEnable.notifyMotionData();
  };

  // AR-5: the pill is a real button, so keyboard users can enable/recalibrate.
  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    void motionEnable.activate();
  };
  makeControlFocusable(element);
  element.addEventListener("keydown", handleKeyDown);

  let pressed = false;
  let activeIdentifier: number | null = null;

  const applyVisual = (active: boolean): void => {
    if (active === pressed) {
      return;
    }
    pressed = active;
    setPressedClass(element, active);
    notifyDebugState(ctx, control.id, active);
  };

  const release = (bindingEvent: TouchBinding): void => {
    if (bindingEvent.identifier !== activeIdentifier) {
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

    onTouchStart(touch: TouchBinding): void {
      if (activeIdentifier !== null) {
        return;
      }
      activeIdentifier = touch.identifier;
      applyVisual(true);
      // Request permission synchronously inside the gesture; `activate()`
      // handles the async answer and every fallback state without rejecting.
      void motionEnable.activate();
    },

    onTouchMove(): void {
      // No drag behavior; motion is sampled continuously.
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
      element.removeEventListener("keydown", handleKeyDown);
      motionEnable.dispose();
      source.onEvent = null;
      binding.onSample = null;
      applyVisual(false);
      element.remove();
    },
  };
}
