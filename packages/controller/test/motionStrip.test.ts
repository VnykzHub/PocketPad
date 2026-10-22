/**
 * D6-CTRL-03 sensors-only motion strip tests.
 *
 * These cover the finding that a layout declaring `sensors.gyro` without a
 * visible `gyro` control previously captured no motion and showed no enable
 * UI. The strip must be visible, bounded, and must never take touches that
 * belong to the layout's fallback controls.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { LayoutDocument, Length } from "@lanpad/sdk";
import {
  FLAG_MOTION_ACTIVE,
  FLAG_RECENTERED,
  type GyroControlRuntime,
} from "../src/controls/gyro.js";
import type { ControlRenderer } from "../src/controls/control.js";
import { InputStore } from "../src/input/InputStore.js";
import {
  MOTION_STRIP_ACTION_HEIGHT_PX,
  MOTION_STRIP_HEIGHT_PX,
  MOTION_STRIP_WIDTH_PX,
  createMotionStatusStrip,
  motionStripBounds,
  motionStripHitRect,
} from "../src/layout/motionStrip.js";
import { ControllerLayoutView } from "../src/net/controllerClient.js";
import {
  MotionSource,
  type DeviceRotationRateEvent,
} from "../src/sensors/MotionSource.js";
import type {
  MotionScheduler,
  MotionVisibilityTarget,
} from "../src/sensors/MotionEnable.js";
import type {
  MotionEnvironment,
  MotionPermissionState,
} from "../src/sensors/motionPermission.js";
import type { RotationRate } from "../src/sensors/remap.js";
import { DEFAULT_SLOP_PX } from "../src/touch/hitTest.js";

const SURFACE = { width: 800, height: 400 } as const;
const SUPPORTED_ENVIRONMENT: MotionEnvironment = {
  isSecureContext: true,
  hasDeviceMotionEvent: true,
};

class FakeTarget {
  readonly listeners = new Set<(event: DeviceRotationRateEvent) => void>();

  addEventListener(
    _type: "devicemotion",
    callback: (event: DeviceRotationRateEvent) => void,
  ): void {
    this.listeners.add(callback);
  }

  removeEventListener(
    _type: "devicemotion",
    callback: (event: DeviceRotationRateEvent) => void,
  ): void {
    this.listeners.delete(callback);
  }

  emit(rotationRate: RotationRate | null): void {
    for (const listener of [...this.listeners]) {
      listener({ rotationRate });
    }
  }
}

class FakeIntervalScheduler {
  private nextId = 1;
  private readonly callbacks = new Map<number, () => void>();

  setInterval(callback: () => void): number {
    const id = this.nextId;
    this.nextId += 1;
    this.callbacks.set(id, callback);
    return id;
  }

  clearInterval(handle: number): void {
    this.callbacks.delete(handle);
  }

  get size(): number {
    return this.callbacks.size;
  }

  tick(): void {
    for (const callback of [...this.callbacks.values()]) {
      callback();
    }
  }
}

class FakeTimers implements MotionScheduler {
  now = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, ms: number): number {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.set(id, { at: this.now + ms, callback });
    return id;
  }

  clearTimeout(handle: number): void {
    this.tasks.delete(handle);
  }

  get size(): number {
    return this.tasks.size;
  }

  advance(ms: number): void {
    this.now += ms;
    for (const [id, task] of [...this.tasks]) {
      if (task.at <= this.now) {
        this.tasks.delete(id);
        task.callback();
      }
    }
  }
}

class FakeVisibility implements MotionVisibilityTarget {
  hidden = false;
  private readonly listeners = new Set<() => void>();

  addEventListener(_type: "visibilitychange", callback: () => void): void {
    this.listeners.add(callback);
  }

  removeEventListener(_type: "visibilitychange", callback: () => void): void {
    this.listeners.delete(callback);
  }

  setHidden(value: boolean): void {
    this.hidden = value;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

interface HarnessOptions {
  environment?: MotionEnvironment;
  requestPermission?: (environment: MotionEnvironment) => Promise<MotionPermissionState>;
  visibility?: FakeVisibility;
}

interface Harness {
  view: ControllerLayoutView;
  surface: HTMLDivElement;
  input: InputStore;
  target: FakeTarget;
  interval: FakeIntervalScheduler;
  timers: FakeTimers;
  visibility: FakeVisibility;
  requestCount: () => number;
  setNow: (value: number) => void;
}

let activeViews: ControllerLayoutView[] = [];
let activeSurfaces: HTMLElement[] = [];

afterEach(() => {
  for (const view of activeViews) {
    view.clear();
  }
  for (const surface of activeSurfaces) {
    surface.remove();
  }
  activeViews = [];
  activeSurfaces = [];
});

function makeHarness(options: HarnessOptions = {}): Harness {
  const target = new FakeTarget();
  const interval = new FakeIntervalScheduler();
  const timers = new FakeTimers();
  const visibility = options.visibility ?? new FakeVisibility();
  const input = new InputStore();
  let now = 0;
  let requests = 0;

  const source = new MotionSource({
    addEventListener: (type, callback) => target.addEventListener(type, callback),
    removeEventListener: (type, callback) => target.removeEventListener(type, callback),
    getScreenAngle: () => 0,
    now: () => now,
  });

  const request = options.requestPermission ?? (async () => "granted" as const);
  const runtime: GyroControlRuntime = {
    source,
    environment: options.environment ?? SUPPORTED_ENVIRONMENT,
    requestPermission: async (environment) => {
      requests += 1;
      return request(environment);
    },
    sampleScheduler: interval,
    motionScheduler: timers,
    visibility,
  };

  const surface = document.createElement("div");
  document.body.append(surface);
  const view = new ControllerLayoutView(surface, input, {
    surfaceSize: SURFACE,
    motionRuntime: runtime,
  });
  activeViews.push(view);
  activeSurfaces.push(surface);

  return {
    view,
    surface,
    input,
    target,
    interval,
    timers,
    visibility,
    requestCount: () => requests,
    setNow: (value) => {
      now = value;
    },
  };
}

/** Fallback button bit used by every layout below. */
const FALLBACK_BIT = 3;

function fallbackControl(y: Length = "360px"): LayoutDocument["controls"][number] {
  return {
    type: "button",
    id: "fallback",
    label: "Fire",
    shape: "rounded",
    x: "50%",
    y,
    r: "60px",
    bit: FALLBACK_BIT,
  };
}

function sensorsLayout(id = "sensors-only-v1", y: Length = "360px"): LayoutDocument {
  return {
    id,
    orientation: "any",
    sensors: { gyro: "tilt", smoothing: 0.4, sensitivity: 2 },
    controls: [fallbackControl(y)],
  };
}

function plainLayout(id: string): LayoutDocument {
  return { id, orientation: "any", controls: [fallbackControl()] };
}

interface FakeTouch {
  identifier: number;
  clientX: number;
  clientY: number;
}

function touch(identifier: number, clientX: number, clientY: number): FakeTouch {
  return { identifier, clientX, clientY };
}

/** jsdom has no TouchEvent; the engine only reads `changedTouches`. */
function dispatchTouch(
  target: HTMLElement,
  type: "touchstart" | "touchend" | "touchcancel",
  points: readonly FakeTouch[],
): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "changedTouches", { value: points });
  Object.defineProperty(event, "touches", { value: points });
  target.dispatchEvent(event);
}

function stripOf(surface: HTMLElement): HTMLElement {
  const element = surface.querySelector<HTMLElement>("[data-motion-strip]");
  if (element === null) {
    throw new Error("missing motion strip");
  }
  return element;
}

function part(root: HTMLElement, name: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(`[data-part="${name}"]`);
  if (element === null) {
    throw new Error(`missing part ${name}`);
  }
  return element;
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function stripCenter(): FakeTouch {
  const bounds = motionStripBounds(SURFACE);
  return touch(
    1,
    bounds.left + bounds.width / 2,
    bounds.top + bounds.height / 2,
  );
}

/** Taps the strip and lets the async permission path settle. */
async function activateStrip(harness: Harness): Promise<void> {
  const point = stripCenter();
  dispatchTouch(harness.surface, "touchstart", [point]);
  dispatchTouch(harness.surface, "touchend", [point]);
  await settle();
}

function pressFallback(harness: Harness): void {
  dispatchTouch(harness.surface, "touchstart", [touch(9, 400, 360)]);
}

function isFallbackPressed(harness: Harness): boolean {
  return (harness.input.snapshot(0).buttons & (1 << FALLBACK_BIT)) !== 0;
}

describe("sensors-only motion strip", () => {
  it("[FR-8.10] [AR-5] mounts a visible strip with a 44 px action for sensors-only layouts", () => {
    const harness = makeHarness();
    harness.view.setLayout(sensorsLayout());

    const strip = stripOf(harness.surface);
    expect(strip.parentElement).toBe(harness.surface);
    expect(strip.dataset["motionState"]).toBe("idle");

    const status = part(strip, "motion-status");
    expect(status.textContent).toContain("Tap to enable motion");
    // Visible, unlike the gyro control's screen-reader-only live region.
    expect(status.style.clipPath).toBe("");
    expect(status.style.width).not.toBe("1px");
    expect(status.getAttribute("role")).toBe("status");

    const action = part(strip, "motion-action");
    expect(action.textContent).toBe("Enable motion");
    expect(action.getAttribute("role")).toBe("button");
    expect(Number.parseFloat(action.style.height)).toBeGreaterThanOrEqual(
      MOTION_STRIP_ACTION_HEIGHT_PX,
    );
    expect(MOTION_STRIP_ACTION_HEIGHT_PX).toBeGreaterThanOrEqual(44);

    // Compact and bounded: never a surface-covering overlay.
    expect(MOTION_STRIP_WIDTH_PX).toBeLessThan(SURFACE.width);
    expect(MOTION_STRIP_HEIGHT_PX).toBeLessThan(SURFACE.height);
    expect(strip.style.pointerEvents).toBe("none");
  });

  it("[FR-8.10] [AR-3] [E7] an insecure context explains itself and keeps the fallback playable", () => {
    const harness = makeHarness({
      environment: { isSecureContext: false, hasDeviceMotionEvent: true },
    });
    harness.view.setLayout(sensorsLayout());

    const strip = stripOf(harness.surface);
    expect(strip.dataset["motionState"]).toBe("insecure-context");
    expect(part(strip, "motion-status").textContent).toContain("HTTPS");
    expect(part(strip, "motion-action").getAttribute("aria-disabled")).toBe("true");

    expect(harness.target.listeners.size).toBe(0);
    expect(harness.interval.size).toBe(0);
    expect(harness.requestCount()).toBe(0);

    pressFallback(harness);
    expect(isFallbackPressed(harness)).toBe(true);
  });

  it("[FR-8.10] [AR-3] an unsupported device explains itself and keeps the fallback playable", () => {
    const harness = makeHarness({
      environment: { isSecureContext: true, hasDeviceMotionEvent: false },
    });
    harness.view.setLayout(sensorsLayout());

    const strip = stripOf(harness.surface);
    expect(strip.dataset["motionState"]).toBe("unsupported");
    expect(part(strip, "motion-status").textContent).toContain("not available");
    expect(part(strip, "motion-action").getAttribute("aria-disabled")).toBe("true");
    expect(harness.target.listeners.size).toBe(0);

    pressFallback(harness);
    expect(isFallbackPressed(harness)).toBe(true);
  });

  it("[FR-8.10] [AR-3] a denied permission renders the message and keeps the fallback playable", async () => {
    const harness = makeHarness({
      requestPermission: async () => "denied",
    });
    harness.view.setLayout(sensorsLayout());

    await activateStrip(harness);

    const strip = stripOf(harness.surface);
    expect(strip.dataset["motionState"]).toBe("denied");
    expect(part(strip, "motion-status").textContent).toContain("denied");
    expect(part(strip, "motion-action").getAttribute("aria-disabled")).toBe("true");
    expect(harness.requestCount()).toBe(1);
    expect(harness.target.listeners.size).toBe(0);
    expect(harness.interval.size).toBe(0);

    pressFallback(harness);
    expect(isFallbackPressed(harness)).toBe(true);
  });

  it("[FR-8.10] [AR-3] shows the requesting state while the permission prompt is open", async () => {
    let resolveRequest: ((state: MotionPermissionState) => void) | undefined;
    const harness = makeHarness({
      requestPermission: () =>
        new Promise<MotionPermissionState>((resolve) => {
          resolveRequest = resolve;
        }),
    });
    harness.view.setLayout(sensorsLayout());

    const point = stripCenter();
    dispatchTouch(harness.surface, "touchstart", [point]);
    dispatchTouch(harness.surface, "touchend", [point]);

    const strip = stripOf(harness.surface);
    expect(strip.dataset["motionState"]).toBe("requesting");
    expect(part(strip, "motion-status").textContent).toContain("Waiting for motion permission");
    expect(part(strip, "motion-action").getAttribute("aria-disabled")).toBe("true");

    pressFallback(harness);
    expect(isFallbackPressed(harness)).toBe(true);

    resolveRequest?.("granted");
    await settle();
    expect(strip.dataset["motionState"]).toBe("granted");
    expect(part(strip, "motion-action").textContent).toBe("Recalibrate");
  });

  it("[FR-8.10] [E7] [AR-3] a missing sensor stream shows no-data and keeps the fallback playable", async () => {
    const harness = makeHarness();
    harness.view.setLayout(sensorsLayout());

    await activateStrip(harness);
    const strip = stripOf(harness.surface);
    expect(strip.dataset["motionState"]).toBe("granted");
    expect(part(strip, "motion-action").textContent).toBe("Recalibrate");

    harness.timers.advance(1000);

    expect(strip.dataset["motionState"]).toBe("no-data");
    expect(part(strip, "motion-status").textContent).toContain("No motion data");
    expect(part(strip, "motion-action").textContent).toBe("Enable motion");

    pressFallback(harness);
    expect(isFallbackPressed(harness)).toBe(true);
  });
});

describe("sensors-only motion strip bounds", () => {
  it("[FR-8.10] [AR-5] does not steal a touch that lands just outside the strip", () => {
    const harness = makeHarness({
      requestPermission: async () => "granted",
    });
    // The fallback button's centre is 1 px below the strip's bottom edge.
    harness.view.setLayout(sensorsLayout("sensors-adjacent-v1", "69px"));

    const bounds = motionStripBounds(SURFACE);
    const bottomEdge = bounds.top + bounds.height;
    dispatchTouch(harness.surface, "touchstart", [touch(4, 400, bottomEdge + 1)]);

    expect(isFallbackPressed(harness)).toBe(true);
    expect(harness.requestCount()).toBe(0);
    expect(stripOf(harness.surface).dataset["motionState"]).toBe("idle");
  });

  it("[AR-5] the hit rect expands to the strip's visual bounds only", () => {
    const bounds = motionStripBounds(SURFACE);
    const rect = motionStripHitRect(SURFACE);

    expect(rect.controlId).toBe("__motion-strip");
    expect(rect.width).toBeLessThan(bounds.width);
    expect(rect.height).toBeLessThan(bounds.height);
    // Reverse the engine's 8 px slop: the effective target is exactly the box.
    expect(rect.left - DEFAULT_SLOP_PX).toBe(bounds.left);
    expect(rect.top - DEFAULT_SLOP_PX).toBe(bounds.top);
    expect(rect.width + DEFAULT_SLOP_PX * 2).toBe(bounds.width);
    expect(rect.height + DEFAULT_SLOP_PX * 2).toBe(bounds.height);
  });
});

describe("sensors-only motion strip sensor lifecycle", () => {
  it("[FR-8.5] [FR-8.10] drives MotionSource into the InputStore with layout sensitivity", async () => {
    const harness = makeHarness();
    harness.view.setLayout(sensorsLayout());
    await activateStrip(harness);

    harness.setNow(600);
    harness.target.emit({ alpha: 0, beta: 20, gamma: 0 });
    harness.interval.tick();

    const snapshot = harness.input.snapshot(0);
    expect(snapshot.flags & FLAG_MOTION_ACTIVE).toBe(FLAG_MOTION_ACTIVE);
    // Layout smoothing 0.4 on a cold filter: 20 dps -> 8 dps; sensitivity 2
    // and wire scale 10: 8 x 2 x 10 = 160. Both sensor defaults reached start().
    expect(snapshot.gy).toBe(160);

    // The action becomes the recalibrate control while motion is on.
    await activateStrip(harness);
    harness.interval.tick();
    expect(harness.input.snapshot(0).flags & FLAG_RECENTERED).toBe(FLAG_RECENTERED);
  });

  it("[FR-8.10] pauses on visibility hidden and resumes on visible", async () => {
    const visibility = new FakeVisibility();
    const harness = makeHarness({ visibility });
    harness.view.setLayout(sensorsLayout());
    await activateStrip(harness);

    expect(harness.target.listeners.size).toBe(1);
    expect(harness.interval.size).toBe(1);

    visibility.setHidden(true);
    const strip = stripOf(harness.surface);
    expect(strip.dataset["motionState"]).toBe("paused");
    expect(part(strip, "motion-action").textContent).toBe("Motion paused");
    expect(part(strip, "motion-action").getAttribute("aria-disabled")).toBe("true");
    expect(harness.target.listeners.size).toBe(0);
    expect(harness.interval.size).toBe(0);

    visibility.setHidden(false);
    expect(strip.dataset["motionState"]).toBe("granted");
    expect(part(strip, "motion-action").textContent).toBe("Recalibrate");
    expect(harness.target.listeners.size).toBe(1);
    expect(harness.interval.size).toBe(1);
  });

  it("[FR-8.10] stops the sensor when the layout swaps away", async () => {
    const harness = makeHarness();
    harness.view.setLayout(sensorsLayout("sensors-a-v1"));
    await activateStrip(harness);
    expect(harness.target.listeners.size).toBe(1);

    harness.view.setLayout(plainLayout("plain-b-v1"));

    expect(harness.surface.querySelector("[data-motion-strip]")).toBeNull();
    expect(harness.target.listeners.size).toBe(0);
    expect(harness.interval.size).toBe(0);
    expect(harness.timers.size).toBe(0);
    expect(harness.input.snapshot(0).flags).toBe(0);
  });
});

describe("sensors-only motion strip deduplication", () => {
  it("[FR-8.5] [FR-8.10] a layout with a visible gyro control does not also mount the strip", () => {
    const harness = makeHarness();
    harness.view.setLayout({
      id: "gyro-control-v1",
      orientation: "any",
      sensors: { gyro: "steer" },
      controls: [
        fallbackControl(),
        { type: "gyro", id: "steer", x: "50%", y: "20%" },
      ],
    });

    expect(harness.surface.querySelector("[data-motion-strip]")).toBeNull();
    expect(harness.surface.querySelector('[data-control-type="gyro"]')).not.toBeNull();
  });

  it("[FR-8.10] keeps the strip renderer id unique when a layout uses the synthetic id", () => {
    const harness = makeHarness();
    harness.view.setLayout({
      ...sensorsLayout("sensors-id-collision-v1"),
      controls: [{ ...fallbackControl(), id: "__motion-strip" }],
    });

    const strip = stripOf(harness.surface);
    expect(strip.dataset["controlId"]).not.toBe("__motion-strip");
    expect(harness.surface.querySelector('[data-control-id="__motion-strip"]')).not.toBeNull();
  });
});

// Keeps the direct-renderer imports honest: the strip is also usable without
// ControllerLayoutView (unit callers/tests get a plain ControlRenderer).
describe("motion strip renderer contract", () => {
  it("[AR-5] returns a disposable ControlRenderer", () => {
    const input = new InputStore();
    const source = new MotionSource({
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      getScreenAngle: () => 0,
      now: () => 0,
    });
    const runtime: GyroControlRuntime = {
      source,
      environment: { isSecureContext: false, hasDeviceMotionEvent: true },
    };
    const renderer: ControlRenderer = createMotionStatusStrip(
      { input, surfaceSize: SURFACE },
      { runtime },
    );

    expect(renderer.id).toBe("__motion-strip");
    expect(renderer.element.dataset["motionState"]).toBe("insecure-context");
    expect(renderer.getState()).toEqual({});
    renderer.dispose();
    expect(renderer.element.isConnected).toBe(false);
  });
});
