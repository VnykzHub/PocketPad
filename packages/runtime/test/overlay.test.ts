// @vitest-environment jsdom
/**
 * D3-RT-06: the `?debug=1` host overlay.
 *
 * The runtime test project is Node by default; this file opts into jsdom for
 * the fixed DOM node tree. The injected clock keeps every paint deterministic
 * and proves the module never reads `Date`/`performance.now` for throttling.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import type { FrameStats } from "../src/loop/types.js";
import overlaySource from "../src/debug/Overlay.ts?raw";
import {
  DebugOverlay,
  FRAME_SAMPLE_CAPACITY,
  FrameTimeRing,
  OVERLAY_UPDATE_INTERVAL_MS,
  isDebugEnabled,
  readJsHeapMB,
  type OverlaySnapshot,
  type OverlaySlotStats,
} from "../src/debug/Overlay.js";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

class FakeClock {
  nowMs = 0;

  readonly now = (): number => this.nowMs;

  advance(ms: number): void {
    this.nowMs += ms;
  }
}

function createOverlay(options: { enabled?: boolean } = {}): {
  mount: HTMLDivElement;
  clock: FakeClock;
  overlay: DebugOverlay;
} {
  const mount = document.createElement("div");
  document.body.append(mount);
  const clock = new FakeClock();
  const overlay = new DebugOverlay({
    mount,
    enabled: options.enabled ?? true,
    now: clock.now,
  });
  return { mount, clock, overlay };
}

function snapshotWith(
  overrides: Partial<OverlaySnapshot> = {},
): OverlaySnapshot {
  return {
    backend: "webgl2",
    drawCalls: 7,
    textureMemoryMB: 2.5,
    jsHeapMB: null,
    visibleInstances: null,
    resolution: null,
    entities: null,
    gyroSmoothing: null,
    slots: [],
    ...overrides,
  };
}

function field(mount: HTMLElement, name: string): string {
  return (
    mount.querySelector<HTMLElement>(`[data-field="${name}"]`)?.textContent ?? ""
  );
}

/** Feeds frames without touching the clock, like the loop's stats callback. */
function feedFrames(
  overlay: DebugOverlay,
  count: number,
  frameMs: number,
  simTicks: number,
): void {
  const stats: FrameStats = { frameMs, simTicks, alpha: 0 };
  for (let index = 0; index < count; index += 1) {
    overlay.recordFrame(stats);
  }
}

function slotStats(
  overrides: Partial<OverlaySlotStats> & { slot: number },
): OverlaySlotStats {
  return {
    lastInputAgeMs: -1,
    packetsPerSecond: 0,
    drops: 0,
    rttMs: null,
    jitterMs: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Ring buffer and percentile math
// ---------------------------------------------------------------------------

describe("frame-time window", () => {
  test("[FR-12.2] nearest-rank p50/p95 and mean over a fixed ring", () => {
    const ring = new FrameTimeRing(4);

    ring.compute();
    expect(ring.count).toBe(0);
    expect(ring.mean).toBe(0);
    expect(ring.p50).toBe(0);
    expect(ring.p95).toBe(0);

    // Five writes into four slots: the oldest value is overwritten.
    ring.record(10);
    ring.record(20);
    ring.record(30);
    ring.record(40);
    ring.record(50);
    ring.compute();

    expect(ring.count).toBe(4);
    expect(ring.capacity).toBe(4);
    expect(ring.mean).toBe(35);
    // Retained values are 20, 30, 40, 50.
    expect(ring.p50).toBe(30);
    expect(ring.p95).toBe(50);

    ring.reset();
    ring.compute();
    expect(ring.count).toBe(0);
    expect(ring.mean).toBe(0);
  });

  test("[FR-12.2] an empty or single-sample window never divides by zero", () => {
    const ring = new FrameTimeRing(FRAME_SAMPLE_CAPACITY);
    expect(ring.capacity).toBe(FRAME_SAMPLE_CAPACITY);

    ring.record(16.7);
    ring.compute();
    expect(ring.mean).toBeCloseTo(16.7, 10);
    expect(ring.p50).toBeCloseTo(16.7, 10);
    expect(ring.p95).toBeCloseTo(16.7, 10);
  });

  test("[FR-12.2] capacity is clamped and invalid frame times are ignored", () => {
    expect(new FrameTimeRing(0).capacity).toBe(1);
    expect(new FrameTimeRing(50_000).capacity).toBe(10_000);
    expect(new FrameTimeRing(Number.NaN).capacity).toBe(
      FRAME_SAMPLE_CAPACITY,
    );

    const ring = new FrameTimeRing(8);
    ring.record(Number.NaN);
    ring.record(-1);
    ring.record(Number.POSITIVE_INFINITY);
    ring.compute();
    expect(ring.count).toBe(0);
    expect(ring.mean).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Enable path and hidden behavior
// ---------------------------------------------------------------------------

describe("overlay enable path", () => {
  test("[FR-12.2] only ?debug=1 enables the overlay; hidden means no work", () => {
    expect(isDebugEnabled("?debug=1")).toBe(true);
    expect(isDebugEnabled("?x=2&debug=1")).toBe(true);
    expect(isDebugEnabled("?debug=0")).toBe(false);
    expect(isDebugEnabled("?debug=true")).toBe(false);
    expect(isDebugEnabled("?debug")).toBe(false);
    expect(isDebugEnabled("")).toBe(false);

    const { mount, clock, overlay } = createOverlay({ enabled: false });
    expect(overlay.enabled).toBe(false);
    expect(overlay.visible).toBe(false);
    expect(mount.hidden).toBe(true);
    expect(overlay.toggle()).toBe(false);
    expect(overlay.handleKey("d")).toBe(false);
    overlay.show();
    expect(overlay.visible).toBe(false);

    // No DOM changes and no samples while disabled, even under frame pressure.
    const before = mount.textContent;
    feedFrames(overlay, 500, 16.7, 1);
    overlay.update(snapshotWith({ drawCalls: 99 }));
    clock.advance(5000);
    overlay.update(snapshotWith({ drawCalls: 99 }));

    expect(overlay.sampleCount).toBe(0);
    expect(overlay.updateCount).toBe(0);
    expect(overlay.visible).toBe(false);
    expect(mount.textContent).toBe(before);
  });

  test("[FR-12.2] D toggles an enabled overlay and showing resets the window", () => {
    const { mount, clock, overlay } = createOverlay();

    feedFrames(overlay, 5, 16.7, 1);
    clock.advance(OVERLAY_UPDATE_INTERVAL_MS);
    overlay.update(snapshotWith({ drawCalls: 11 }));
    expect(overlay.updateCount).toBe(1);
    expect(overlay.sampleCount).toBe(5);
    expect(field(mount, "drawCalls")).toBe("11");

    expect(overlay.handleKey("d")).toBe(true);
    expect(overlay.visible).toBe(false);

    // Hidden: frame stats and updates are ignored entirely.
    const hiddenText = mount.textContent;
    feedFrames(overlay, 100, 16.7, 1);
    clock.advance(1000);
    overlay.update(snapshotWith({ drawCalls: 99 }));
    expect(overlay.sampleCount).toBe(5);
    expect(overlay.updateCount).toBe(1);
    expect(mount.textContent).toBe(hiddenText);

    // Showing clears stale values until the next 4 Hz paint.
    expect(overlay.handleKey("D")).toBe(true);
    expect(overlay.visible).toBe(true);
    expect(overlay.sampleCount).toBe(0);
    expect(field(mount, "drawCalls")).toBe("—");
    expect(field(mount, "frameSamples")).toBe("—");

    clock.advance(OVERLAY_UPDATE_INTERVAL_MS);
    overlay.update(snapshotWith({ drawCalls: 12 }));
    expect(overlay.updateCount).toBe(2);
    expect(field(mount, "drawCalls")).toBe("12");
  });
});

// ---------------------------------------------------------------------------
// Fields required by FR-12.2 / the D3 exit checklist
// ---------------------------------------------------------------------------

describe("overlay fields", () => {
  test("[FR-12.2] backend, FPS, frame mean/p50/p95, sim ticks/s, draw calls and texture MB", () => {
    const { mount, clock, overlay } = createOverlay();

    // 15 frames in 250 ms is 60 FPS; each frame ran one simulation tick.
    feedFrames(overlay, 15, 1000 / 60, 1);
    clock.advance(OVERLAY_UPDATE_INTERVAL_MS);
    overlay.update(
      snapshotWith({
        backend: "webgl2",
        drawCalls: 12,
        textureMemoryMB: 3.25,
        jsHeapMB: 64,
        visibleInstances: 9,
        resolution: { scale: 0.9, dpr: 1, width: 1728, height: 972 },
      }),
    );

    expect(overlay.updateCount).toBe(1);
    expect(field(mount, "backend")).toBe("webgl2");
    expect(field(mount, "fps")).toBe("60");
    expect(field(mount, "frameMean")).toBe("16.67 ms");
    expect(field(mount, "frameP50")).toBe("16.67 ms");
    expect(field(mount, "frameP95")).toBe("16.67 ms");
    expect(field(mount, "frameSamples")).toBe(`15/${FRAME_SAMPLE_CAPACITY}`);
    expect(field(mount, "simTicksPerSecond")).toBe("60");
    expect(field(mount, "drawCalls")).toBe("12");
    expect(field(mount, "textureMB")).toBe("3.25 MB");
    expect(field(mount, "jsHeapMB")).toBe("64.0 MB");
    expect(field(mount, "visibleInstances")).toBe("9");
    expect(field(mount, "canvasSize")).toBe("1728×972");
    expect(field(mount, "renderScale")).toBe("90%");
    expect(field(mount, "dpr")).toBe("1");
  });

  test("[FR-12.2] percentiles use the last 120 frames and window size is shown", () => {
    const { mount, clock, overlay } = createOverlay();

    // 119 fast frames then one slow frame: p95 lands in the fast band only
    // when the window is recorded correctly.
    feedFrames(overlay, FRAME_SAMPLE_CAPACITY - 1, 10, 1);
    feedFrames(overlay, 1, 100, 1);
    clock.advance(OVERLAY_UPDATE_INTERVAL_MS);
    overlay.update(snapshotWith());

    expect(overlay.sampleCount).toBe(FRAME_SAMPLE_CAPACITY);
    expect(field(mount, "frameSamples")).toBe(
      `${FRAME_SAMPLE_CAPACITY}/${FRAME_SAMPLE_CAPACITY}`,
    );
    expect(field(mount, "frameP50")).toBe("10.00 ms");
    // Nearest rank p95 over 120 samples is index 113, still a 10 ms frame.
    expect(field(mount, "frameP95")).toBe("10.00 ms");
    expect(field(mount, "frameMean")).toBe("10.75 ms");
  });

  test("[FR-12.2] per-slot rows show input age, packet rate and drops; RTT/jitter wait for D4", () => {
    const { mount, clock, overlay } = createOverlay();

    clock.advance(OVERLAY_UPDATE_INTERVAL_MS);
    overlay.update(
      snapshotWith({
        slots: [
          slotStats({ slot: 1, lastInputAgeMs: 12.4, packetsPerSecond: 60 }),
          slotStats({
            slot: 2,
            lastInputAgeMs: -1,
            packetsPerSecond: 0,
            drops: 3,
            rttMs: 18.2,
            jitterMs: 2.5,
          }),
        ],
      }),
    );

    expect(field(mount, "slot-1")).toBe(
      "age 12 ms · 60 pkt/s · rtt — · jitter — · 0 drops",
    );
    expect(field(mount, "slot-2")).toBe(
      "age — · 0 pkt/s · rtt 18.2 ms · jitter 2.5 ms · 3 drops",
    );
    // Slots without stats stay on the fixed placeholder row.
    expect(field(mount, "slot-8")).toBe("—");
  });

  test("[FR-12.2] unavailable fields render an em dash instead of stale numbers", () => {
    const { mount, clock, overlay } = createOverlay();

    clock.advance(OVERLAY_UPDATE_INTERVAL_MS);
    overlay.update(
      snapshotWith({
        backend: null,
        jsHeapMB: null,
        visibleInstances: null,
        resolution: null,
        entities: null,
        gyroSmoothing: null,
        slots: [],
      }),
    );

    expect(field(mount, "backend")).toBe("—");
    expect(field(mount, "visibleInstances")).toBe("—");
    expect(field(mount, "canvasSize")).toBe("—");
    expect(field(mount, "renderScale")).toBe("—");
    expect(field(mount, "dpr")).toBe("—");
    expect(field(mount, "entities")).toBe("—");
    expect(field(mount, "gyroSmoothing")).toBe("—");
    expect(field(mount, "frameMean")).toBe("—");
    expect(field(mount, "slot-1")).toBe("—");
  });

  test("[FR-8.5] the active layout's gyro smoothing alpha is visible for tuning", () => {
    const { mount, clock, overlay } = createOverlay();

    clock.advance(OVERLAY_UPDATE_INTERVAL_MS);
    overlay.update(snapshotWith({ gyroSmoothing: 0.15 }));
    expect(field(mount, "gyroSmoothing")).toBe("0.15");

    // A steering layout may lower the alpha to cut lag.
    clock.advance(OVERLAY_UPDATE_INTERVAL_MS);
    overlay.update(snapshotWith({ gyroSmoothing: 0.05 }));
    expect(field(mount, "gyroSmoothing")).toBe("0.05");

    clock.advance(OVERLAY_UPDATE_INTERVAL_MS);
    overlay.update(snapshotWith({ gyroSmoothing: null }));
    expect(field(mount, "gyroSmoothing")).toBe("—");
  });

  test("[FR-8.5][FR-7.6] per-slot gyro active and tilt angle are visible", () => {
    const { mount, clock, overlay } = createOverlay();

    clock.advance(OVERLAY_UPDATE_INTERVAL_MS);
    overlay.update(
      snapshotWith({
        slots: [
          slotStats({
            slot: 1,
            packetsPerSecond: 60,
            gyroActive: true,
            tilt: { angleX: 12.34, angleY: -4.56, available: true },
          }),
          slotStats({
            slot: 2,
            gyroActive: false,
            tilt: { angleX: 12.3, angleY: 4.5, available: false },
          }),
        ],
      }),
    );

    expect(field(mount, "slot-1")).toBe(
      "age — · 60 pkt/s · rtt — · jitter — · 0 drops · gyro on · tilt 12.3°/-4.6°",
    );
    expect(field(mount, "slot-2")).toBe(
      "age — · 0 pkt/s · rtt — · jitter — · 0 drops · gyro off · tilt —",
    );
    // Without the optional D6 fields the pre-D6 row is unchanged.
    expect(field(mount, "slot-3")).toBe("—");
  });

  test("[FR-8.11] the last haptic pulse is visible", () => {
    const { mount, clock, overlay } = createOverlay();

    clock.advance(OVERLAY_UPDATE_INTERVAL_MS);
    overlay.update(
      snapshotWith({ lastHaptic: { target: 0, ageMs: 40, steps: 2 } }),
    );
    expect(field(mount, "lastHaptic")).toBe("all · 40 ms ago · 2 steps");

    clock.advance(OVERLAY_UPDATE_INTERVAL_MS);
    overlay.update(
      snapshotWith({ lastHaptic: { target: 2, ageMs: null, steps: 1 } }),
    );
    expect(field(mount, "lastHaptic")).toBe("P2 · — · 1 step");

    clock.advance(OVERLAY_UPDATE_INTERVAL_MS);
    overlay.update(snapshotWith({ lastHaptic: null }));
    expect(field(mount, "lastHaptic")).toBe("—");
  });

  test("[PR-9.4] pooled entity counts are reported so pool churn is visible", () => {
    const { mount, clock, overlay } = createOverlay();
    const entities = { active: 12, pooled: 64, spawned: 130 };

    clock.advance(OVERLAY_UPDATE_INTERVAL_MS);
    overlay.update(snapshotWith({ entities }));
    expect(field(mount, "entities")).toBe("12 active · 64 pooled · 130 spawned");

    // Pooled stats objects are shared; the overlay only reads them.
    expect(entities).toEqual({ active: 12, pooled: 64, spawned: 130 });

    clock.advance(OVERLAY_UPDATE_INTERVAL_MS);
    overlay.update(
      snapshotWith({ entities: { active: 3, pooled: 64, spawned: null } }),
    );
    expect(field(mount, "entities")).toBe("3 active · 64 pooled");
  });

  test("[FR-12.2] JS heap is shown when performance.memory exists", () => {
    expect(readJsHeapMB({ memory: { usedJSHeapSize: 128 * 1024 * 1024 } })).toBe(
      128,
    );
    expect(readJsHeapMB({ memory: undefined })).toBeNull();
    expect(readJsHeapMB(undefined)).toBeNull();
    expect(readJsHeapMB({ memory: { usedJSHeapSize: Number.NaN } })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cost boundaries: 4 Hz DOM paints, fixed nodes, no hot-path work
// ---------------------------------------------------------------------------

describe("overlay cost boundaries", () => {
  test("[PR-9.8] DOM paints are throttled to 4 Hz and reuse fixed nodes", () => {
    const { mount, clock, overlay } = createOverlay();
    const nodeCount = mount.querySelectorAll("*").length;
    expect(nodeCount).toBeGreaterThan(0);

    feedFrames(overlay, 60, 4, 0);
    const createElement = vi.spyOn(document, "createElement");

    clock.advance(100);
    overlay.update(snapshotWith());
    expect(overlay.updateCount).toBe(0);

    clock.advance(150); // t = 250 ms
    overlay.update(snapshotWith());
    expect(overlay.updateCount).toBe(1);

    clock.advance(150); // t = 400 ms, inside the 250 ms window
    overlay.update(snapshotWith({ drawCalls: 99 }));
    expect(overlay.updateCount).toBe(1);
    expect(field(mount, "drawCalls")).toBe("7");

    clock.advance(100); // t = 500 ms
    overlay.update(snapshotWith({ drawCalls: 8 }));
    expect(overlay.updateCount).toBe(2);
    expect(field(mount, "drawCalls")).toBe("8");

    expect(createElement).not.toHaveBeenCalled();
    expect(mount.querySelectorAll("*").length).toBe(nodeCount);
    expect(OVERLAY_UPDATE_INTERVAL_MS).toBe(250);
  });

  test("[PR-9.3, PR-9.8] recordFrame only fills the fixed ring, never the DOM", () => {
    const { mount, overlay } = createOverlay();
    const nodeCount = mount.querySelectorAll("*").length;
    const createElement = vi.spyOn(document, "createElement");

    // The loop reuses one stats object; the overlay must not retain it.
    const stats: FrameStats = { frameMs: 16.7, simTicks: 1, alpha: 0.5 };
    for (let frame = 0; frame < 10_000; frame += 1) {
      overlay.recordFrame(stats);
    }

    expect(overlay.sampleCount).toBe(FRAME_SAMPLE_CAPACITY);
    expect(overlay.updateCount).toBe(0);
    expect(mount.querySelectorAll("*").length).toBe(nodeCount);
    expect(createElement).not.toHaveBeenCalled();

    // Invalid frames do not consume a ring slot.
    overlay.recordFrame({ frameMs: Number.NaN, simTicks: 0, alpha: 0 });
    overlay.recordFrame({ frameMs: -5, simTicks: 0, alpha: 0 });
    expect(overlay.sampleCount).toBe(FRAME_SAMPLE_CAPACITY);
  });

  test("[SR-9, PR-9.8] the overlay touches no storage and no innerHTML", () => {
    expect(overlaySource).not.toMatch(
      /sessionStorage|localStorage|hostToken|roomToken/,
    );
    expect(overlaySource).not.toContain("innerHTML");
    expect(overlaySource).not.toContain("style.");
    // The only URL input is the caller-supplied search string.
    expect(overlaySource).not.toMatch(/window\.location|document\.location/);
  });
});
