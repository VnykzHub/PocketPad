/**
 * Motion enable / permission UI state machine (D6-CTRL-01; FR-8.10, FR-8.11).
 *
 * The gyro control owns the DOM; this class owns the behavior. It never reads
 * `window`, `navigator` or timers at import time: the environment, permission
 * request, listener start/stop callbacks, scheduler and visibility target are
 * all injected. Tests drive the state machine with fakes.
 *
 * Contract:
 * - Nothing is requested or started until the player taps (no auto prompt).
 * - A denied, unsupported or insecure environment leaves the same element
 *   visible and disabled; every non-gyro control keeps working (FR-8.10).
 * - After `startListening()` succeeds, a 1 s no-data watchdog runs. The first
 *   motion event cancels it; if it fires, the UI explains the fallback.
 * - The page shell may stop delivery while hidden; on return the sensor is
 *   started again only if the player had already granted motion.
 */
import {
  requestMotionPermission,
  resolveMotionSupport,
  type MotionEnvironment,
  type MotionPermissionState,
  type MotionSupport,
} from "./motionPermission.js";

/** Time after a successful start before "no data" is shown. */
export const DEFAULT_NO_DATA_TIMEOUT_MS = 1000;

/** UI states; `support` explains why a state can never leave idle. */
export type MotionEnableState =
  | "idle"
  | "requesting"
  | "granted"
  | "denied"
  | "no-data"
  | "paused"
  | "insecure-context"
  | "unsupported";

/** Minimal timer surface (injected so tests use a fake clock). */
export interface MotionScheduler {
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

/** Minimal page-visibility surface; `document` satisfies it structurally. */
export interface MotionVisibilityTarget {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", callback: () => void): void;
  removeEventListener(type: "visibilitychange", callback: () => void): void;
}

/** Elements the gyro control already created and styles. */
export interface MotionEnableView {
  /** The tappable pill; gets `aria-disabled`, `data-motion-state` and `title`. */
  readonly root: HTMLElement;
  /** Visible one-line label. */
  readonly label: HTMLElement;
  /** Screen-reader live region for the longer explanation. */
  readonly status: HTMLElement;
}

export interface MotionEnableOptions {
  readonly environment: MotionEnvironment;
  /** Starts the sensor + 60 Hz binding. May be called again after pause. */
  readonly startListening: () => void;
  /** Stops the sensor and writes inactive zeros. Must be idempotent. */
  readonly stopListening: () => void;
  /** Re-opens the auto-zero window (FR-7.6). */
  readonly recalibrate: () => void;
  readonly requestPermission?:
    | ((environment: MotionEnvironment) => Promise<MotionPermissionState>)
    | undefined;
  readonly scheduler?: MotionScheduler | undefined;
  readonly visibility?: MotionVisibilityTarget | null | undefined;
  readonly noDataTimeoutMs?: number | undefined;
  readonly onStateChange?: ((state: MotionEnableState) => void) | undefined;
}

const DEFAULT_SCHEDULER: MotionScheduler = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms) as unknown as number,
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle);
  },
};

/** Human-readable explanation for each state (also used as the element title). */
export function motionStatusText(state: MotionEnableState): string {
  switch (state) {
    case "idle":
      return "Tap to enable motion. Touch controls work without it.";
    case "requesting":
      return "Waiting for motion permission.";
    case "granted":
      return "Motion is on. Tap to recalibrate.";
    case "denied":
      return "Motion permission was denied. Touch controls still work.";
    case "no-data":
      return "No motion data received. Touch controls still work.";
    case "paused":
      return "Motion is paused while the page is hidden.";
    case "insecure-context":
      return "Motion needs a secure HTTPS connection.";
    case "unsupported":
      return "Motion is not available on this device.";
  }
}

/** Label shown inside the pill. */
export function motionStateLabel(state: MotionEnableState): string {
  switch (state) {
    case "granted":
      return "Motion on";
    case "paused":
      return "Motion paused";
    default:
      return "Enable motion";
  }
}

/** True when tapping must not dispatch an action. */
export function isMotionStateDisabled(state: MotionEnableState): boolean {
  return (
    state === "requesting" ||
    state === "denied" ||
    state === "insecure-context" ||
    state === "unsupported"
  );
}

export class MotionEnable {
  private readonly view: MotionEnableView;
  private readonly options: MotionEnableOptions;
  private readonly scheduler: MotionScheduler;
  private readonly noDataTimeoutMs: number;
  private readonly visibility: MotionVisibilityTarget | null;
  private readonly initialSupport: MotionSupport;

  private currentState: MotionEnableState;
  private timerHandle: number | null = null;
  private listening = false;
  private disposed = false;

  constructor(view: MotionEnableView, options: MotionEnableOptions) {
    this.view = view;
    this.options = options;
    this.scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
    this.noDataTimeoutMs =
      options.noDataTimeoutMs !== undefined &&
      Number.isFinite(options.noDataTimeoutMs) &&
      options.noDataTimeoutMs > 0
        ? options.noDataTimeoutMs
        : DEFAULT_NO_DATA_TIMEOUT_MS;
    this.visibility = options.visibility ?? null;
    this.initialSupport = resolveMotionSupport(options.environment);

    switch (this.initialSupport) {
      case "insecure-context":
        this.currentState = "insecure-context";
        break;
      case "unsupported":
        this.currentState = "unsupported";
        break;
      default:
        this.currentState = "idle";
        break;
    }

    if (this.visibility !== null) {
      this.visibility.addEventListener("visibilitychange", this.handleVisibility);
    }

    this.applyState();
  }

  get state(): MotionEnableState {
    return this.currentState;
  }

  get support(): MotionSupport {
    return this.initialSupport;
  }

  /** True while the sensor listener has been started and not stopped. */
  get isListening(): boolean {
    return this.listening;
  }

  /**
   * One tap. Requests permission the first time, recalibrates once motion is
   * running, and does nothing in terminal fallback states.
   */
  async activate(): Promise<void> {
    if (this.disposed) {
      return;
    }

    switch (this.currentState) {
      case "idle":
        await this.requestAndStart();
        return;
      case "granted":
        this.options.recalibrate();
        return;
      case "no-data":
        // A second chance after the watchdog: restart and wait another second.
        this.options.recalibrate();
        this.startMotion();
        return;
      default:
        return;
    }
  }

  /**
   * Called for every non-null `devicemotion` event by the runtime. Cancels the
   * one-shot no-data watchdog and clears the fallback message.
   */
  notifyMotionData(): void {
    if (this.disposed) {
      return;
    }
    this.cancelNoDataTimer();
    if (this.currentState === "no-data") {
      this.setState("granted");
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.cancelNoDataTimer();
    this.stopListening();
    this.visibility?.removeEventListener("visibilitychange", this.handleVisibility);
  }

  private async requestAndStart(): Promise<void> {
    const request = this.options.requestPermission ?? requestMotionPermission;
    this.setState("requesting");

    let answer: MotionPermissionState;
    try {
      answer = await request(this.options.environment);
    } catch {
      answer = "denied";
    }

    if (this.disposed) {
      return;
    }
    if (answer !== "granted") {
      this.setState("denied");
      return;
    }

    try {
      this.options.startListening();
    } catch {
      this.setState("denied");
      return;
    }

    this.listening = true;
    this.setState("granted");
    this.armNoDataTimer();
  }

  /** Starts listeners that the player has already granted. */
  private startMotion(): void {
    if (this.disposed) {
      return;
    }
    try {
      this.options.startListening();
    } catch {
      this.setState("denied");
      return;
    }
    this.listening = true;
    this.setState("granted");
    this.armNoDataTimer();
  }

  private armNoDataTimer(): void {
    this.cancelNoDataTimer();
    this.timerHandle = this.scheduler.setTimeout(() => {
      this.timerHandle = null;
      if (!this.disposed && this.currentState === "granted") {
        this.setState("no-data");
      }
    }, this.noDataTimeoutMs);
  }

  private cancelNoDataTimer(): void {
    if (this.timerHandle === null) {
      return;
    }
    this.scheduler.clearTimeout(this.timerHandle);
    this.timerHandle = null;
  }

  private stopListening(): void {
    if (!this.listening) {
      return;
    }
    this.listening = false;
    try {
      this.options.stopListening();
    } catch {
      // Disposal and visibility transitions must never throw into the shell.
    }
  }

  private readonly handleVisibility = (): void => {
    if (this.disposed || this.visibility === null) {
      return;
    }

    if (this.visibility.hidden) {
      if (this.currentState === "granted" || this.currentState === "no-data") {
        this.cancelNoDataTimer();
        this.stopListening();
        this.setState("paused");
      }
      return;
    }

    if (this.currentState === "paused") {
      this.startMotion();
    }
  };

  private setState(next: MotionEnableState): void {
    if (this.currentState === next) {
      return;
    }
    this.currentState = next;
    this.applyState();
    this.options.onStateChange?.(next);
  }

  private applyState(): void {
    const state = this.currentState;
    const label = motionStateLabel(state);
    const message = motionStatusText(state);

    this.view.root.dataset["motionState"] = state;
    this.view.root.setAttribute("aria-disabled", isMotionStateDisabled(state) ? "true" : "false");
    this.view.root.setAttribute("aria-label", `${label}. ${message}`);
    this.view.root.title = message;
    this.view.label.textContent = label;
    this.view.status.textContent = message;
  }
}
