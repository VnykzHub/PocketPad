/**
 * Controller performance tests (D2-PERF-01; FR-8.3, NR-6.3, PR-11.1).
 *
 * Three properties are asserted here:
 *
 * - `[FR-8.3]` a synchronous touch dispatch stays inside the 2 ms scripting
 *   budget, and the overlay's fixed ring yields correct nearest-rank p50/p95.
 *   The measurement runs the real button/stick renderers against jsdom, so it
 *   is a harness-level guard; the device p50/p95 is recorded manually per the
 *   D2-PERF-01 steps.
 * - `[NR-6.3]` the controller gz hard cap is 60 KB and the built entry bundle
 *   fits it. `npm run check` runs tests before the build, so a clean checkout
 *   may have no `dist/`; the same measurement runs in the size gate after the
 *   build. When `dist/` exists the test reports the raw/gzip numbers.
 * - `[PR-11.1]` the tap-to-send path is synchronous and timeable, which is what
 *   the latency harness and the input-bot regression use as their start edge.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { ButtonControl, StickControl } from "@lanpad/sdk";
import { INPUT_FRAME_BYTES, decodeInput, encodeInput } from "@lanpad/protocol";
import { createControl } from "../src/controls/registry.js";
import { InputStore } from "../src/input/InputStore.js";
import { SendLoop } from "../src/input/sendLoop.js";
import { ClockSync } from "../src/net/clockSync.js";
import {
  DebugOverlay,
  SCRIPT_SAMPLE_CAPACITY,
  type DebugOverlayStats,
} from "../src/debug/overlay.js";
import type { TouchBinding } from "../src/touch/touchEngine.js";

const SURFACE = { width: 800, height: 400 } as const;
/** FR-8.3: at most 2 ms of scripting per touch event. */
const SCRIPT_BUDGET_MS = 2;
const SAMPLE_CYCLES = 200;

const BUTTON: ButtonControl = {
  type: "button",
  id: "jump",
  label: "Jump",
  shape: "circle",
  x: "82%",
  y: "70%",
  r: "11%",
  bit: 0,
};

const STICK: StickControl = {
  type: "stick",
  id: "move",
  x: "20%",
  y: "70%",
  size: "24%",
  axis: "left",
  mode: "fixed",
};

const BUTTON_BIT = 1 << BUTTON.bit;

function binding(
  identifier: number,
  controlId: string,
  x: number,
  y: number,
  startX = x,
  startY = y,
): TouchBinding {
  return { identifier, controlId, startX, startY, lastX: x, lastY: y };
}

function createOverlay(options: { enabled?: boolean; capacity?: number } = {}): DebugOverlay {
  const mount = document.createElement("aside");
  document.body.append(mount);
  return new DebugOverlay({
    mount,
    enabled: options.enabled ?? true,
    ...(options.capacity === undefined ? {} : { capacity: options.capacity }),
  });
}

function statsSnapshot(overrides: Partial<DebugOverlayStats> = {}): DebugOverlayStats {
  return {
    packetsSent: 0,
    lastSendAgeMs: Number.POSITIVE_INFINITY,
    rttMs: Number.POSITIVE_INFINITY,
    offsetMs: 0,
    scriptMs: 0,
    activeTouches: 0,
    droppedTouches: 0,
    layoutId: null,
    ...overrides,
  };
}

/** Nearest-rank p95 for the harness report, matching the overlay's definition. */
function p95(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

interface ControllerBudgetTiers {
  dev?: number;
  prod?: number;
  hard?: number;
}

/** Repository root derived from this test file, without Vite asset-URL rewriting. */
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TEST_DIR, "..", "..", "..");

function readControllerBudget(): ControllerBudgetTiers {
  const path = join(REPO_ROOT, "tools", "size-budget", "budgets.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    targets?: Record<string, ControllerBudgetTiers>;
  };
  const tiers = parsed.targets?.["controller"];
  if (tiers === undefined) {
    throw new Error("budgets.json is missing targets.controller");
  }
  return tiers;
}

/**
 * Measures the JavaScript entry referenced by the built controller page.
 * Measuring the entry (rather than every stale hashed asset in `dist/assets`)
 * matches what a phone downloads: Vite never cleans old hashes because
 * `emptyOutDir` is false to preserve the tsc output.
 */
function measureBuiltController(): { file: string; rawBytes: number; gzipBytes: number } | null {
  const distDir = join(TEST_DIR, "..", "dist");
  const htmlPath = join(distDir, "index.html");
  if (!existsSync(htmlPath)) {
    return null;
  }
  const html = readFileSync(htmlPath, "utf8");
  const match = /<script[^>]+src="([^"]+\.js)"/.exec(html);
  if (match === null) {
    return null;
  }
  const src = match[1] ?? "";
  // Vite base is `/c/`; `/c/assets/index-*.js` maps to `dist/assets/*.js`.
  const relative = src.replace(/^\/c\//, "").replace(/^\//, "");
  const filePath = join(distDir, relative);
  if (!existsSync(filePath)) {
    return null;
  }
  const bytes = readFileSync(filePath);
  return {
    file: relative,
    rawBytes: bytes.byteLength,
    gzipBytes: gzipSync(bytes).byteLength,
  };
}

describe("[FR-8.3] controller scripting budget and overlay math", () => {
  it("[FR-8.3] touch dispatch p95 stays under the 2 ms scripting budget", () => {
    const store = new InputStore();
    const button = createControl(BUTTON, { input: store, surfaceSize: SURFACE });
    const stick = createControl(STICK, { input: store, surfaceSize: SURFACE });

    const time = (dispatch: () => void): number => {
      const startedAt = performance.now();
      dispatch();
      return performance.now() - startedAt;
    };

    // Warm up the JIT and the jsdom style/class paths so the sampled numbers
    // describe the steady-state handler, not first-use compilation.
    for (let index = 0; index < 40; index += 1) {
      button.onTouchStart(binding(index + 1, BUTTON.id, 656, 280));
      button.onTouchEnd(binding(index + 1, BUTTON.id, 656, 280));
      stick.onTouchStart(binding(index + 100, STICK.id, 160, 280));
      stick.onTouchMove(binding(index + 100, STICK.id, 200, 300, 160, 280));
      stick.onTouchEnd(binding(index + 100, STICK.id, 200, 300, 160, 280));
    }

    const samples: number[] = [];
    for (let index = 0; index < SAMPLE_CYCLES; index += 1) {
      const identifier = index + 1000;
      samples.push(time(() => button.onTouchStart(binding(identifier, BUTTON.id, 656, 280))));
      // Same-frame property: the store and the pressed visual are already
      // updated when the handler returns, with no rAF or network involved.
      expect(store.snapshot(0).buttons).toBe(BUTTON_BIT);
      expect(button.element.classList.contains("is-pressed")).toBe(true);
      samples.push(time(() => button.onTouchEnd(binding(identifier, BUTTON.id, 656, 280))));
      samples.push(time(() => stick.onTouchStart(binding(identifier, STICK.id, 160, 280))));
      samples.push(
        time(() => stick.onTouchMove(binding(identifier, STICK.id, 200, 300, 160, 280))),
      );
      samples.push(time(() => stick.onTouchEnd(binding(identifier, STICK.id, 200, 300, 160, 280))));
    }

    const measuredP95 = p95(samples);
    console.info(
      `[perf] controller touch dispatch p95 ${measuredP95.toFixed(3)} ms over ${samples.length} samples (budget ${SCRIPT_BUDGET_MS} ms)`,
    );
    expect(measuredP95).toBeLessThan(SCRIPT_BUDGET_MS);

    button.dispose();
    stick.dispose();
  });

  it("[FR-8.3] touch handlers never write layout-triggering CSS properties", () => {
    const store = new InputStore();
    const button = createControl(BUTTON, { input: store, surfaceSize: SURFACE });
    const stick = createControl(STICK, { input: store, surfaceSize: SURFACE });

    // Placement is written once when controls are constructed; a touch may only
    // animate transform/opacity from then on (FR-8.3), so those two properties
    // are deliberately absent from the audited set.
    const LAYOUT_PROPERTIES = [
      "width",
      "height",
      "top",
      "left",
      "right",
      "bottom",
      "inset",
      "margin",
      "padding",
    ] as const;
    const snapshot = (root: HTMLElement): string[] =>
      [root, ...root.querySelectorAll<HTMLElement>("*")].flatMap((node) =>
        LAYOUT_PROPERTIES.map((property) => node.style.getPropertyValue(property)),
      );
    const before = [...snapshot(button.element), ...snapshot(stick.element)];

    button.onTouchStart(binding(1, BUTTON.id, 656, 280));
    button.onTouchEnd(binding(1, BUTTON.id, 656, 280));
    stick.onTouchStart(binding(2, STICK.id, 160, 280));
    stick.onTouchMove(binding(2, STICK.id, 200, 300, 160, 280));
    stick.onTouchEnd(binding(2, STICK.id, 200, 300, 160, 280));

    expect([...snapshot(button.element), ...snapshot(stick.element)]).toEqual(before);

    button.dispose();
    stick.dispose();
  });

  it("[FR-8.3] overlay p50/p95 match a known sample set and the ring is bounded", () => {
    const overlay = createOverlay({ capacity: SCRIPT_SAMPLE_CAPACITY });

    for (let value = 1; value <= 100; value += 1) {
      overlay.recordScriptTime(value);
    }
    // Nearest rank over 1..100: p50 = 50, p95 = 95.
    expect(overlay.percentiles()).toEqual({ samples: 100, p50: 50, p95: 95 });

    // Wrapping keeps the newest `capacity` samples and still reports the
    // nearest-rank values over them (30, 40, 50, 60 -> p50 40, p95 60).
    overlay.resetSamples();
    const wrapped = createOverlay({ capacity: 4 });
    for (const value of [10, 20, 30, 40, 50, 60]) {
      wrapped.recordScriptTime(value);
    }
    expect(wrapped.sampleCount).toBe(4);
    expect(wrapped.percentiles()).toEqual({ samples: 4, p50: 40, p95: 60 });

    // Recording more samples than the ring holds never grows it.
    for (let value = 0; value < 500; value += 1) {
      wrapped.recordScriptTime(value % 3);
    }
    expect(wrapped.sampleCount).toBe(4);

    overlay.dispose();
    wrapped.dispose();
  });

  it("[FR-8.3] overlay is disabled by default and only the debug flag enables it", () => {
    const disabled = createOverlay({ enabled: false });
    expect(disabled.enabled).toBe(false);
    expect(disabled.visible).toBe(false);
    expect(disabled.toggle()).toBe(false);
    expect(disabled.visible).toBe(false);

    const enabled = createOverlay({ enabled: true });
    expect(enabled.enabled).toBe(true);
    expect(enabled.visible).toBe(true);

    // End-to-end timing: capture before the surface handlers, bubble after
    // them. `stats.scriptMs` is then ignored, so samples come from real events
    // and include hit-test time.
    enabled.observeTouchTiming(window);
    enabled.update(
      statsSnapshot({
        packetsSent: 30,
        lastSendAgeMs: 12,
        rttMs: 18.4,
        offsetMs: -4.2,
        scriptMs: 0.4,
        activeTouches: 2,
        droppedTouches: 1,
        layoutId: "platformer-v1",
      }),
    );
    expect(enabled.sampleCount).toBe(0);

    const surface = document.createElement("div");
    document.body.append(surface);
    for (const type of ["touchstart", "touchmove", "touchend"]) {
      surface.dispatchEvent(new Event(type, { bubbles: true }));
    }
    expect(enabled.sampleCount).toBe(3);
    // The visible HUD renders the fields the plan requires: send rate, script
    // time, touches, RTT/offset and layout id.
    expect(enabled.root.textContent).toContain("Packets/s");
    expect(enabled.root.textContent).toContain("18.4 ms");
    expect(enabled.root.textContent).toContain("2 (1 dropped)");
    expect(enabled.root.textContent).toContain("-4.2 ms");
    expect(enabled.root.textContent).toContain("platformer-v1");
    expect(enabled.toggle()).toBe(false);
    expect(enabled.visible).toBe(false);
    expect(enabled.toggle()).toBe(true);
    expect(enabled.visible).toBe(true);

    disabled.dispose();
    enabled.dispose();
  });
});

describe("[NR-6.3] controller gzip budget", () => {
  it("[NR-6.3] [G3] built controller JS fits the 60 KB gz hard cap", () => {
    const tiers = readControllerBudget();
    expect(tiers.hard).toBe(61440);
    expect(tiers.dev).toBe(40960);
    expect(tiers.prod).toBe(51200);

    const measured = measureBuiltController();
    if (measured === null) {
      // Tests run before the build in `npm run check`; the size gate performs
      // the same measurement after the build. Budget invariants above still
      // guard against a silently raised cap.
      return;
    }

    console.info(
      `[size] controller ${measured.file}: ${measured.rawBytes} raw, ${measured.gzipBytes} gz ` +
        `(dev ${tiers.dev}, prod ${tiers.prod}, hard ${tiers.hard})`,
    );
    expect(measured.gzipBytes).toBeLessThanOrEqual(tiers.hard ?? 0);
  });
});

describe("[PR-11.1] tap-to-send instrumentation", () => {
  it("[PR-11.1] tap-to-encode-and-send is synchronous and inside the scripting budget", () => {
    const store = new InputStore();
    const button = createControl(BUTTON, { input: store, surfaceSize: SURFACE });
    const frames: Uint8Array[] = [];
    const sentAt: number[] = [];
    let nowMs = 0;

    const loop = new SendLoop({
      store,
      clock: new ClockSync(),
      send: (state) => {
        sentAt.push(nowMs);
        frames.push(encodeInput(state));
      },
      now: () => nowMs,
      // The tap path is immediate; no cadence timer is needed for this test.
      setTimer: () => 0,
      clearTimer: () => {},
    });
    store.onChange = () => {
      loop.notifyChange();
    };

    loop.start();
    loop.notifyChange(); // initial packet at t = 0
    nowMs = 10;

    const startedAt = performance.now();
    button.onTouchStart(binding(1, BUTTON.id, 656, 280));
    const tapToFrameMs = performance.now() - startedAt;

    // Both the input state and the wire frame exist before the handler returns;
    // the latency harness can timestamp this call as the tap edge.
    expect(store.snapshot(0).buttons).toBe(BUTTON_BIT);
    expect(sentAt[1]).toBe(10);
    expect(frames[1]?.byteLength).toBe(INPUT_FRAME_BYTES);
    const decoded = decodeInput(frames[1] ?? new Uint8Array(0));
    expect(decoded.buttons).toBe(BUTTON_BIT);
    expect(decoded.edges).toBe(BUTTON_BIT);

    // A single sample is dominated by scheduler preemption when the suite runs
    // under load. Measure a batch and assert the median, which still fails on a
    // real regression but ignores one-off preemption spikes.
    const samples: number[] = [tapToFrameMs];
    const tapBinding = binding(1, BUTTON.id, 656, 280);
    for (let index = 0; index < 30; index += 1) {
      button.onTouchEnd(tapBinding);
      nowMs += 10;
      const sampleStart = performance.now();
      button.onTouchStart(tapBinding);
      samples.push(performance.now() - sampleStart);
    }
    samples.sort((a, b) => a - b);
    const medianMs = samples[Math.floor(samples.length / 2)] ?? tapToFrameMs;
    const p95Ms =
      samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)] ?? tapToFrameMs;
    expect(medianMs).toBeLessThan(SCRIPT_BUDGET_MS);

    console.info(
      `[perf] tap-to-encode-and-send median ${medianMs.toFixed(3)} ms, p95 ${p95Ms.toFixed(3)} ms ` +
        `(${samples.length} samples, budget ${SCRIPT_BUDGET_MS} ms)`,
    );

    loop.stop();
    button.dispose();
  });
});
