/**
 * D6-CTRL-01 enable-state tests: nothing starts on load, permission is only
 * requested from a tap, all fallback states stay visible/disabled, the 1 s
 * no-data watchdog works, and visibility/dispose transitions are clean.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_NO_DATA_TIMEOUT_MS,
  MotionEnable,
  isMotionStateDisabled,
  motionStateLabel,
  motionStatusText,
  type MotionEnableOptions,
  type MotionScheduler,
  type MotionVisibilityTarget,
} from "../src/sensors/MotionEnable.js";
import type {
  MotionEnvironment,
  MotionPermissionState,
} from "../src/sensors/motionPermission.js";

class FakeScheduler implements MotionScheduler {
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

  get listenerCount(): number {
    return this.listeners.size;
  }

  setHidden(value: boolean): void {
    this.hidden = value;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

const SUPPORTED_ENVIRONMENT: MotionEnvironment = {
  isSecureContext: true,
  hasDeviceMotionEvent: true,
};

interface HarnessOptions {
  environment?: MotionEnvironment | undefined;
  requestPermission?:
    | ((environment: MotionEnvironment) => Promise<MotionPermissionState>)
    | undefined;
  visibility?: FakeVisibility | undefined;
  noDataTimeoutMs?: number | undefined;
  failStart?: boolean | undefined;
}

function makeEnable(options: HarnessOptions = {}): {
  enable: MotionEnable;
  scheduler: FakeScheduler;
  calls: { start: number; stop: number; recalibrate: number };
} {
  const root = document.createElement("div");
  const label = document.createElement("span");
  const status = document.createElement("span");
  root.append(label, status);

  const scheduler = new FakeScheduler();
  const calls = { start: 0, stop: 0, recalibrate: 0 };
  const motionOptions: MotionEnableOptions = {
    environment: options.environment ?? SUPPORTED_ENVIRONMENT,
    startListening: () => {
      calls.start += 1;
      if (options.failStart === true) {
        throw new Error("sensor unavailable");
      }
    },
    stopListening: () => {
      calls.stop += 1;
    },
    recalibrate: () => {
      calls.recalibrate += 1;
    },
    requestPermission: options.requestPermission,
    scheduler,
    visibility: options.visibility,
    noDataTimeoutMs: options.noDataTimeoutMs,
  };

  const enable = new MotionEnable({ root, label, status }, motionOptions);
  return { enable, scheduler, calls };
}

describe("MotionEnable constants and labels", () => {
  it("uses a 1 s no-data timeout and stable fallback labels", () => {
    expect(DEFAULT_NO_DATA_TIMEOUT_MS).toBe(1000);
    expect(motionStateLabel("granted")).toBe("Motion on");
    expect(motionStateLabel("paused")).toBe("Motion paused");
    expect(motionStateLabel("idle")).toBe("Enable motion");
    expect(motionStateLabel("denied")).toBe("Enable motion");
    expect(motionStateLabel("no-data")).toBe("Enable motion");
    expect(motionStateLabel("insecure-context")).toBe("Enable motion");
    expect(motionStatusText("insecure-context")).toContain("HTTPS");
    expect(isMotionStateDisabled("denied")).toBe(true);
    expect(isMotionStateDisabled("granted")).toBe(false);
    expect(isMotionStateDisabled("no-data")).toBe(false);
  });
});

describe("[FR-12.1][FR-8.10][E7] MotionEnable fallback states", () => {
  it("[FR-12.1][E7] explains an insecure context without starting or requesting anything", async () => {
    const { enable, scheduler, calls } = makeEnable({
      environment: { isSecureContext: false, hasDeviceMotionEvent: true },
    });

    expect(enable.state).toBe("insecure-context");
    expect(enable.support).toBe("insecure-context");
    expect(enable.isListening).toBe(false);

    await enable.activate();
    expect(calls.start).toBe(0);
    expect(scheduler.size).toBe(0);
    expect(enable.state).toBe("insecure-context");
  });

  it("[FR-12.1] explains an unsupported browser without starting", async () => {
    const { enable, calls } = makeEnable({
      environment: { isSecureContext: true, hasDeviceMotionEvent: false },
    });

    expect(enable.state).toBe("unsupported");
    await enable.activate();
    expect(calls.start).toBe(0);
    expect(enable.state).toBe("unsupported");
  });

  it("[FR-12.1] does not request permission when constructed (no auto prompt)", () => {
    let requests = 0;
    const { enable } = makeEnable({
      requestPermission: async () => {
        requests += 1;
        return "granted";
      },
    });

    expect(enable.state).toBe("idle");
    expect(requests).toBe(0);
  });

  it("[FR-8.10] stays in a denied state when the player declines", async () => {
    let requests = 0;
    const { enable, scheduler, calls } = makeEnable({
      requestPermission: async () => {
        requests += 1;
        return "denied";
      },
    });

    await enable.activate();
    expect(requests).toBe(1);
    expect(enable.state).toBe("denied");
    expect(calls.start).toBe(0);
    expect(scheduler.size).toBe(0);
    expect(isMotionStateDisabled("denied")).toBe(true);
  });

  it("[FR-8.10] treats a thrown permission request or a failed start as denial", async () => {
    const thrown = makeEnable({
      requestPermission: async () => {
        throw new Error("prompt failed");
      },
    });
    await thrown.enable.activate();
    expect(thrown.enable.state).toBe("denied");

    const failed = makeEnable({ failStart: true });
    await failed.enable.activate();
    expect(failed.enable.state).toBe("denied");
    expect(failed.enable.isListening).toBe(false);
    expect(failed.scheduler.size).toBe(0);
  });
});

describe("[FR-12.1] MotionEnable granted flow", () => {
  it("[FR-12.1] requests once, starts listening and arms the no-data watchdog", async () => {
    const environments: MotionEnvironment[] = [];
    const { enable, scheduler, calls } = makeEnable({
      environment: {
        isSecureContext: true,
        hasDeviceMotionEvent: true,
        requestPermission: async () => "granted",
      },
      requestPermission: async (environment) => {
        environments.push(environment);
        return "granted";
      },
    });

    await enable.activate();

    expect(environments).toHaveLength(1);
    expect(calls.start).toBe(1);
    expect(enable.isListening).toBe(true);
    expect(enable.state).toBe("granted");
    expect(scheduler.size).toBe(1);
  });

  it("grants without a prompt when the environment is supported", async () => {
    const { enable, calls } = makeEnable();
    await enable.activate();
    expect(enable.state).toBe("granted");
    expect(calls.start).toBe(1);
  });

  it("cancels the watchdog on the first motion event", async () => {
    const { enable, scheduler } = makeEnable();
    await enable.activate();
    expect(scheduler.size).toBe(1);

    enable.notifyMotionData();
    expect(scheduler.size).toBe(0);
    expect(enable.state).toBe("granted");
  });

  it("shows no-data after 1 s and allows a retry tap", async () => {
    const { enable, scheduler, calls } = makeEnable();
    await enable.activate();

    scheduler.advance(999);
    expect(enable.state).toBe("granted");
    scheduler.advance(1);
    expect(enable.state).toBe("no-data");
    expect(motionStateLabel(enable.state)).toBe("Enable motion");
    expect(motionStatusText(enable.state)).toContain("No motion data");

    await enable.activate();
    expect(calls.start).toBe(2);
    expect(calls.recalibrate).toBe(1);
    expect(enable.state).toBe("granted");
    expect(scheduler.size).toBe(1);
  });

  it("recalibrates when tapped after motion is already on", async () => {
    const { enable, calls } = makeEnable();
    await enable.activate();
    enable.notifyMotionData();

    await enable.activate();
    expect(calls.recalibrate).toBe(1);
    expect(enable.state).toBe("granted");
  });

  it("notifies state changes in order", async () => {
    const root = document.createElement("div");
    const label = document.createElement("span");
    const status = document.createElement("span");
    root.append(label, status);
    const states: string[] = [];

    const enable = new MotionEnable(
      { root, label, status },
      {
        environment: {
          isSecureContext: true,
          hasDeviceMotionEvent: true,
          requestPermission: async () => "granted",
        },
        startListening: () => undefined,
        stopListening: () => undefined,
        recalibrate: () => undefined,
        requestPermission: async () => "granted",
        scheduler: new FakeScheduler(),
        onStateChange: (state) => {
          states.push(state);
        },
      },
    );

    await enable.activate();
    expect(states).toEqual(["requesting", "granted"]);
  });
});

describe("MotionEnable visibility and disposal", () => {
  it("pauses while hidden and resumes only a granted sensor", async () => {
    const visibility = new FakeVisibility();
    const { enable, scheduler, calls } = makeEnable({ visibility });
    await enable.activate();
    expect(visibility.listenerCount).toBe(1);

    visibility.setHidden(true);
    expect(enable.state).toBe("paused");
    expect(calls.stop).toBe(1);
    expect(enable.isListening).toBe(false);
    expect(scheduler.size).toBe(0);

    visibility.setHidden(false);
    expect(enable.state).toBe("granted");
    expect(calls.start).toBe(2);
    expect(enable.isListening).toBe(true);
    expect(scheduler.size).toBe(1);
  });

  it("does not pause an idle or terminal control", () => {
    const visibility = new FakeVisibility();
    const { enable, calls } = makeEnable({
      environment: { isSecureContext: true, hasDeviceMotionEvent: false },
      visibility,
    });

    visibility.setHidden(true);
    expect(enable.state).toBe("unsupported");
    expect(calls.stop).toBe(0);
  });

  it("disposes listeners, timers and the sensor", async () => {
    const visibility = new FakeVisibility();
    const { enable, scheduler, calls } = makeEnable({ visibility });
    await enable.activate();

    enable.dispose();
    expect(calls.stop).toBe(1);
    expect(scheduler.size).toBe(0);
    expect(visibility.listenerCount).toBe(0);
    expect(enable.isListening).toBe(false);

    await enable.activate();
    enable.notifyMotionData();
    expect(calls.start).toBe(1);
  });
});
