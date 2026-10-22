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
 * Everything browser-specific is injected through `GyroControlRuntime`, so
 * tests can drive the full path with fake events and fake timers. The default
 * runtime resolves `window`, `screen`, `performance` and `document` lazily
 * when the control is constructed, never at import time.
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
import type { InputStore } from "../input/InputStore.js";
import { MotionSource, type DeviceRotationRateEvent } from "../sensors/MotionSource.js";
import {
  MotionEnable,
  type MotionScheduler as MotionEnableScheduler,
  type MotionVisibilityTarget,
} from "../sensors/MotionEnable.js";
import {
  readMotionEnvironment,
  requestMotionPermission,
  type MotionEnvironment,
  type MotionPermissionState,
} from "../sensors/motionPermission.js";

const IDLE_TRANSFORM = "scale(1)";
const PRESSED_TRANSFORM = "scale(0.96)";
const IDLE_OPACITY = "0.8";
const PRESSED_OPACITY = "1";

/** flags bit 0: motion data is flowing (FR-7.6). */
export const FLAG_MOTION_ACTIVE = 1;
/** flags bit 1: the next packet follows a recalibration (FR-7.6). */
export const FLAG_RECENTERED = 2;

/** Sensor sample cadence; the send loop also snapshots at 60 Hz. */
export const GYRO_SAMPLE_HZ = 60;
export const GYRO_SAMPLE_INTERVAL_MS = 1000 / GYRO_SAMPLE_HZ;

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

/**
 * Copies the current motion sample into the InputStore at 60 Hz.
 *
 * The store, not the `devicemotion` callback, is the single writer of gyro
 * fields on the wire. `stop()` writes an inactive zero sample so the host
 * cannot keep steering with a stale rate.
 */
export class GyroSampleBinding {
  private readonly input: InputStore;
  private readonly source: MotionSource;
  private readonly scheduler: GyroScheduler;
  private handle: number | null = null;

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
    if (this.source.consumeRecentered()) {
      flags |= FLAG_RECENTERED;
    }
    this.input.setFlags(flags);
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

  element.append(label, status);

  const source = effectiveRuntime.source;
  const binding = new GyroSampleBinding(ctx.input, source, effectiveRuntime.sampleScheduler);
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
      },
      recalibrate: () => {
        source.recalibrate();
      },
      requestPermission: effectiveRuntime.requestPermission,
      scheduler: effectiveRuntime.motionScheduler,
      visibility: effectiveRuntime.visibility,
      noDataTimeoutMs: effectiveRuntime.noDataTimeoutMs,
    },
  );

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
  element.tabIndex = 0;
  element.addEventListener("keydown", handleKeyDown);

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
      applyVisual(false);
      element.remove();
    },
  };
}
