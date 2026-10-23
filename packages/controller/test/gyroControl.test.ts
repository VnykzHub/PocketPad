/**
 * D6-CTRL-03 gyro control tests: the D5 element contract is preserved while a
 * tap grants motion, the 60 Hz binding writes i16 gyro + flags into the shared
 * InputStore, fallbacks leave touch controls usable, and dispose clears state.
 */
import { describe, expect, it } from "vitest";
import type { GyroControl } from "@lanpad/sdk";
import { InputStore } from "../src/input/InputStore.js";
import type { ControlContext } from "../src/controls/control.js";
import {
  FLAG_MOTION_ACTIVE,
  FLAG_RECENTERED,
  createGyroControl,
  type GyroControlRuntime,
  type GyroScheduler,
} from "../src/controls/gyro.js";
import {
  MotionSource,
  type DeviceRotationRateEvent,
} from "../src/sensors/MotionSource.js";
import type {
  MotionScheduler,
  MotionVisibilityTarget,
} from "../src/sensors/MotionEnable.js";
import type { MotionEnvironment, MotionPermissionState } from "../src/sensors/motionPermission.js";
import type { RotationRate } from "../src/sensors/remap.js";
import type { TouchBinding } from "../src/touch/touchEngine.js";

const GYRO: GyroControl = {
  type: "gyro",
  id: "tilt",
  x: "10%",
  y: "20%",
};

const ZERO_RATE: RotationRate = { alpha: 0, beta: 0, gamma: 0 };

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

class FakeIntervalScheduler implements GyroScheduler {
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

interface HarnessOptions {
  control?: GyroControl | undefined;
  environment?: MotionEnvironment | undefined;
  requestPermission?:
    | ((environment: MotionEnvironment) => Promise<MotionPermissionState>)
    | undefined;
  visibility?: MotionVisibilityTarget | undefined;
}

function makeHarness(options: HarnessOptions = {}): {
  renderer: ReturnType<typeof createGyroControl>;
  input: InputStore;
  source: MotionSource;
  target: FakeTarget;
  interval: FakeIntervalScheduler;
  timers: FakeTimers;
  setNow: (value: number) => void;
  setAngle: (value: number) => void;
} {
  const target = new FakeTarget();
  const interval = new FakeIntervalScheduler();
  const timers = new FakeTimers();
  const input = new InputStore();
  let now = 0;
  let angle = 0;

  const source = new MotionSource({
    addEventListener: (type, callback) => target.addEventListener(type, callback),
    removeEventListener: (type, callback) => target.removeEventListener(type, callback),
    getScreenAngle: () => angle,
    now: () => now,
  });

  const ctx: ControlContext = {
    input,
    surfaceSize: { width: 800, height: 400 },
  };

  const runtime: GyroControlRuntime = {
    source,
    environment:
      options.environment ?? { isSecureContext: true, hasDeviceMotionEvent: true },
    requestPermission: options.requestPermission,
    sampleScheduler: interval,
    motionScheduler: timers,
    visibility: options.visibility,
  };

  const renderer = createGyroControl(options.control ?? GYRO, ctx, runtime);
  return {
    renderer,
    input,
    source,
    target,
    interval,
    timers,
    setNow: (value) => {
      now = value;
    },
    setAngle: (value) => {
      angle = value;
    },
  };
}

function binding(identifier = 1): TouchBinding {
  return {
    identifier,
    controlId: GYRO.id,
    startX: 80,
    startY: 80,
    lastX: 80,
    lastY: 80,
  };
}

function part(
  renderer: ReturnType<typeof createGyroControl>,
  name: string,
): HTMLElement {
  const element = renderer.element.querySelector<HTMLElement>(`[data-part="${name}"]`);
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

describe("[FR-8.10][FR-12.1] gyro control D5 contract", () => {
  it("[FR-8.10] keeps the prompt label, disabled state and pressed feedback", async () => {
    const { renderer, input, target, interval } = makeHarness({
      environment: { isSecureContext: false, hasDeviceMotionEvent: true },
    });

    expect(renderer.element.textContent).toContain("Enable motion");
    expect(renderer.element.getAttribute("aria-disabled")).toBe("true");
    expect(renderer.element.dataset["controlType"]).toBe("gyro");

    renderer.onTouchStart(binding());
    expect(renderer.element.classList.contains("is-pressed")).toBe(true);
    renderer.onTouchEnd(binding());
    expect(renderer.element.classList.contains("is-pressed")).toBe(false);
    // Press feedback is the shared class, never an inline transform/opacity.
    expect(renderer.element.style.transform).toBe("");
    expect(renderer.element.style.opacity).toBe("");

    await settle();
    expect(target.listeners.size).toBe(0);
    expect(interval.size).toBe(0);
    const snapshot = input.snapshot(0);
    expect(snapshot.gx).toBe(0);
    expect(snapshot.gy).toBe(0);
    expect(snapshot.gz).toBe(0);
    expect(snapshot.flags).toBe(0);
    expect(renderer.element.dataset["motionState"]).toBe("insecure-context");
  });
});

describe("[CP-13] gyro visual states", () => {
  it("[CP-13] shows the plan's fallback copy and unavailable card when motion is blocked", () => {
    const { renderer } = makeHarness({
      environment: { isSecureContext: false, hasDeviceMotionEvent: true },
    });

    expect(part(renderer, "reason").textContent).toBe("Motion needs HTTPS");
    expect(part(renderer, "reason").hidden).toBe(false);
    expect(part(renderer, "level").hidden).toBe(true);
    expect(part(renderer, "recenter").hidden).toBe(true);
    expect(renderer.element.classList.contains("control-gyro")).toBe(true);
    expect(renderer.element.classList.contains("is-unavailable")).toBe(true);
  });

  it("[CP-13] swaps the fallback copy for the level and recenter once granted", async () => {
    const { renderer, target, interval, setNow } = makeHarness({
      environment: {
        isSecureContext: true,
        hasDeviceMotionEvent: true,
        requestPermission: async () => "granted",
      },
      requestPermission: async () => "granted",
    });

    renderer.onTouchStart(binding());
    renderer.onTouchEnd(binding());
    await settle();

    expect(renderer.element.dataset["motionState"]).toBe("granted");
    expect(part(renderer, "reason").hidden).toBe(true);

    // The auto-zero window is visible and takes the place of the level and
    // recenter target until a post-window sample arrives (FR-7.6).
    expect(part(renderer, "calibration").hidden).toBe(false);
    expect(part(renderer, "calibration").textContent).toContain("Hold still");
    expect(part(renderer, "level").hidden).toBe(true);
    expect(part(renderer, "recenter").hidden).toBe(true);
    expect(renderer.element.classList.contains("is-calibrating")).toBe(true);

    target.emit(ZERO_RATE);
    setNow(600);
    target.emit(ZERO_RATE);
    interval.tick();

    expect(part(renderer, "calibration").hidden).toBe(true);
    expect(part(renderer, "level").hidden).toBe(false);
    const recenter = part(renderer, "recenter");
    expect(recenter.hidden).toBe(false);
    expect(recenter.textContent).toBe("Recenter");
    expect(renderer.element.classList.contains("is-calibrating")).toBe(false);
    expect(renderer.element.classList.contains("is-unavailable")).toBe(false);
    expect(renderer.element.classList.contains("is-disabled")).toBe(false);
    // The D5 label contract is preserved even though the level is the face.
    expect(part(renderer, "label").textContent).toBe("Motion on");
  });

  it("[CP-13] moves the level bubble with the sampled rate and recenters it", async () => {
    const h = makeHarness({ control: { ...GYRO, smoothing: 1 } });
    h.renderer.onTouchStart(binding());
    h.renderer.onTouchEnd(binding());
    await settle();

    expect(part(h.renderer, "calibration").hidden).toBe(false);
    h.target.emit(ZERO_RATE);
    h.setNow(600);
    h.target.emit(ZERO_RATE);
    h.setNow(700);
    h.target.emit({ alpha: 0, beta: 400, gamma: 0 });
    h.interval.tick();
    h.interval.tick();
    expect(part(h.renderer, "calibration").hidden).toBe(true);
    expect(part(h.renderer, "level").hidden).toBe(false);

    const bubble = part(h.renderer, "bubble");
    expect(bubble.style.transform).toContain("translate3d(9px, 0px, 0)");

    // A second tap recalibrates: the next sample carries the recenter flag and
    // the display returns to centre without changing the emitted mapping.
    h.renderer.onTouchStart(binding(2));
    h.renderer.onTouchEnd(binding(2));
    h.interval.tick();
    expect(bubble.style.transform).toContain("translate3d(0px, 0px, 0)");
    // Recenter re-opens the visible calibration step until the window closes.
    expect(part(h.renderer, "calibration").hidden).toBe(false);
    expect(h.renderer.element.classList.contains("is-calibrating")).toBe(true);
  });
});

describe("[FR-8.10][FR-12.1] gyro control permission flow", () => {
  it("[FR-12.1] starts motion after a tap and stays in idle before it", async () => {
    let requests = 0;
    const { renderer, source, target, interval, input } = makeHarness({
      environment: {
        isSecureContext: true,
        hasDeviceMotionEvent: true,
        requestPermission: async () => "granted",
      },
      requestPermission: async () => {
        requests += 1;
        return "granted";
      },
    });

    expect(requests).toBe(0);
    expect(renderer.element.dataset["motionState"]).toBe("idle");
    expect(renderer.element.getAttribute("aria-disabled")).toBe("false");

    renderer.onTouchStart(binding());
    renderer.onTouchEnd(binding());
    await settle();

    expect(requests).toBe(1);
    expect(renderer.element.dataset["motionState"]).toBe("granted");
    expect(part(renderer, "label").textContent).toBe("Motion on");
    expect(source.isStarted).toBe(true);
    expect(target.listeners.size).toBe(1);
    expect(interval.size).toBe(1);
    expect(input.snapshot(0).flags).toBe(0);
  });

  it("[FR-12.1] is keyboard-focusable and enables or recalibrates from the keyboard", async () => {
    let requests = 0;
    const h = makeHarness({
      environment: {
        isSecureContext: true,
        hasDeviceMotionEvent: true,
        requestPermission: async () => "granted",
      },
      requestPermission: async () => {
        requests += 1;
        return "granted";
      },
    });

    expect(h.renderer.element.tabIndex).toBe(0);

    const space = new KeyboardEvent("keydown", {
      key: " ",
      bubbles: true,
      cancelable: true,
    });
    h.renderer.element.dispatchEvent(space);
    await settle();
    expect(space.defaultPrevented).toBe(true);
    expect(requests).toBe(1);
    expect(h.target.listeners.size).toBe(1);
    expect(h.renderer.element.dataset["motionState"]).toBe("granted");

    // The second press recalibrates; it does not request permission again.
    h.renderer.element.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await settle();
    expect(requests).toBe(1);
  });

  it("[FR-8.10] leaves a usable fallback when permission is denied", async () => {
    const { renderer, source, target, interval, input } = makeHarness({
      environment: {
        isSecureContext: true,
        hasDeviceMotionEvent: true,
        requestPermission: async () => "granted",
      },
      requestPermission: async () => "denied",
    });

    renderer.onTouchStart(binding());
    renderer.onTouchEnd(binding());
    await settle();

    expect(renderer.element.dataset["motionState"]).toBe("denied");
    expect(renderer.element.getAttribute("aria-disabled")).toBe("true");
    expect(part(renderer, "label").textContent).toBe("Enable motion");
    expect(renderer.element.title).toContain("Touch controls still work");
    expect(source.isStarted).toBe(false);
    expect(target.listeners.size).toBe(0);
    expect(interval.size).toBe(0);
    expect(input.snapshot(0).flags).toBe(0);
  });
});

describe("[FR-7.5][FR-7.6][FR-8.5] gyro control sampling", () => {
  it("[FR-7.5][FR-7.6] writes calibrated gyro values and the active flag at 60 Hz", async () => {
    const h = makeHarness({ control: { ...GYRO, smoothing: 1 } });
    h.renderer.onTouchStart(binding());
    h.renderer.onTouchEnd(binding());
    await settle();

    h.target.emit(ZERO_RATE);
    h.interval.tick();
    let snapshot = h.input.snapshot(0);
    expect(snapshot.flags).toBe(FLAG_MOTION_ACTIVE);

    h.setNow(600);
    h.target.emit(ZERO_RATE); // closes the auto-zero window with zero bias
    h.target.emit({ alpha: 0, beta: 20, gamma: -3 });
    h.interval.tick();

    snapshot = h.input.snapshot(0);
    expect(snapshot.gy).toBe(200);
    expect(snapshot.gx).toBe(-30);
    expect(snapshot.gz).toBe(0);
    expect(snapshot.flags).toBe(FLAG_MOTION_ACTIVE);
  });

  it("[FR-8.5] uses the control's smoothing and sensitivity fields", async () => {
    const h = makeHarness({
      control: { ...GYRO, smoothing: 1, sensitivity: 2 },
    });
    h.renderer.onTouchStart(binding());
    h.renderer.onTouchEnd(binding());
    await settle();

    h.target.emit(ZERO_RATE);
    h.setNow(600);
    h.target.emit(ZERO_RATE);
    h.setNow(601);
    h.target.emit({ alpha: 0, beta: 20, gamma: 0 });
    h.interval.tick();

    expect(h.input.snapshot(0).gy).toBe(400);
  });

  it("[FR-7.6] marks one packet recentered on a second tap, then holds zero", async () => {
    const h = makeHarness({ control: { ...GYRO, smoothing: 1 } });
    h.renderer.onTouchStart(binding());
    h.renderer.onTouchEnd(binding());
    await settle();

    h.target.emit(ZERO_RATE);
    h.setNow(600);
    h.target.emit({ alpha: 0, beta: 20, gamma: 0 });
    h.interval.tick();
    expect(h.input.snapshot(0).gy).toBe(200);

    h.renderer.onTouchStart(binding());
    h.renderer.onTouchEnd(binding());
    h.interval.tick();

    let snapshot = h.input.snapshot(0);
    expect(snapshot.flags).toBe(FLAG_MOTION_ACTIVE | FLAG_RECENTERED);
    expect(snapshot.gy).toBe(0);

    h.interval.tick();
    snapshot = h.input.snapshot(0);
    expect(snapshot.flags).toBe(FLAG_MOTION_ACTIVE);
  });

  it("[FR-7.6] publishes an inactive zero sample for a null rotationRate", async () => {
    const h = makeHarness();
    h.renderer.onTouchStart(binding());
    h.renderer.onTouchEnd(binding());
    await settle();

    h.target.emit(ZERO_RATE);
    h.interval.tick();
    expect(h.input.snapshot(0).flags).toBe(FLAG_MOTION_ACTIVE);

    h.target.emit(null);
    h.interval.tick();
    const snapshot = h.input.snapshot(0);
    expect(snapshot.flags).toBe(0);
    expect(snapshot.gx).toBe(0);
    expect(snapshot.gy).toBe(0);
    expect(snapshot.gz).toBe(0);
  });

  it("reports no-data after the 1 s watchdog without a sensor event", async () => {
    const h = makeHarness();
    h.renderer.onTouchStart(binding());
    h.renderer.onTouchEnd(binding());
    await settle();

    h.timers.advance(1000);
    expect(h.renderer.element.dataset["motionState"]).toBe("no-data");
    expect(h.renderer.element.classList.contains("is-unavailable")).toBe(true);
    expect(part(h.renderer, "label").textContent).toBe("Enable motion");
  });
});

describe("gyro control disposal", () => {
  it("stops sampling, clears the wire fields and removes the element", async () => {
    const h = makeHarness();
    h.renderer.onTouchStart(binding());
    h.renderer.onTouchEnd(binding());
    await settle();

    h.target.emit({ alpha: 0, beta: 20, gamma: 0 });
    h.setNow(600);
    h.target.emit({ alpha: 0, beta: 20, gamma: 0 });
    h.interval.tick();
    expect(h.input.hasActiveInput()).toBe(true);

    h.renderer.dispose();

    expect(h.source.isStarted).toBe(false);
    expect(h.target.listeners.size).toBe(0);
    expect(h.interval.size).toBe(0);
    expect(h.timers.size).toBe(0);
    expect(h.renderer.element.isConnected).toBe(false);

    const snapshot = h.input.snapshot(0);
    expect(snapshot.gx).toBe(0);
    expect(snapshot.gy).toBe(0);
    expect(snapshot.gz).toBe(0);
    expect(snapshot.flags).toBe(0);
  });
});
