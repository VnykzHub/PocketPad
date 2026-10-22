/**
 * Stroke batcher tests (D5-CTRL-04; FR-7.8, FR-8.1, E10, SR-13).
 *
 * The batcher is pure: a fake clock and fake timers drive it, and emitted
 * payloads are recorded. Byte figures use the same JSON estimate the batcher
 * uses, which is what the event queue serializes as `data`.
 */
import { describe, expect, it } from "vitest";
import {
  STROKE_MAX_BYTES_PER_SECOND,
  StrokeBatcher,
  coalesceStrokeData,
  decimatePoints,
  estimateStrokeBytes,
  type StrokeBatcherOptions,
  type StrokeBox,
  type StrokeTimers,
} from "../src/controls/strokeBatcher.js";
import type { StrokeEventData, StrokePoint } from "../src/controls/eventSink.js";

const BOX: StrokeBox = { left: 100, top: 50, width: 400, height: 200 };

interface Harness {
  batcher: StrokeBatcher;
  emitted: StrokeEventData[];
  sentAt: { at: number; bytes: number }[];
  clock: { now: number };
  fireTimers: () => void;
}

function harness(overrides: Partial<StrokeBatcherOptions> = {}): Harness {
  const clock = { now: 1_000 };
  const emitted: StrokeEventData[] = [];
  const sentAt: { at: number; bytes: number }[] = [];
  const scheduled = new Map<number, () => void>();
  let nextHandle = 1;
  const timers: StrokeTimers = {
    set: (callback) => {
      const handle = nextHandle++;
      scheduled.set(handle, callback);
      return handle;
    },
    clear: (handle) => {
      scheduled.delete(handle as number);
    },
  };
  const batcher = new StrokeBatcher({
    color: "#00ff00",
    width: 4,
    now: () => clock.now,
    emit: (data) => {
      emitted.push(data);
      sentAt.push({ at: clock.now, bytes: estimateStrokeBytes(data) });
    },
    timers,
    ...overrides,
  });
  const fireTimers = (): void => {
    const callbacks = [...scheduled.values()];
    scheduled.clear();
    for (const callback of callbacks) {
      callback();
    }
  };
  return { batcher, emitted, sentAt, clock, fireTimers };
}

/** Feeds a circular scribble at `hz` for `durationMs`, `radius` px. */
function scribble(h: Harness, hz: number, durationMs: number, radius = 80): void {
  const step = 1_000 / hz;
  h.batcher.begin(300, 150, BOX);
  for (let elapsed = step; elapsed <= durationMs; elapsed += step) {
    h.clock.now += step;
    const angle = elapsed / 40;
    h.batcher.move(300 + Math.cos(angle) * radius, 150 + Math.sin(angle) * (radius / 2));
  }
  h.batcher.end();
}

function totalPoints(events: StrokeEventData[]): number {
  return events.reduce((sum, event) => sum + event.points.length, 0);
}

describe("[FR-8.1] stroke points are normalized", () => {
  it("[FR-8.1] points are 0..1 against the canvas box, rounded, with relative t", () => {
    const h = harness();
    const first = h.batcher.begin(100, 50, BOX);
    expect(first).toEqual({ x: 0, y: 0, t: 0 });

    h.clock.now += 20;
    const inside = h.batcher.move(100 + 400 / 3, 150);
    expect(inside).toEqual({ x: 0.3333, y: 0.5, t: 20 });

    h.clock.now += 20;
    const outside = h.batcher.move(900, -40);
    expect(outside).toEqual({ x: 1, y: 0, t: 40 });
  });

  it("[FR-8.1] color and width are echoed on every phase", () => {
    const h = harness();
    h.batcher.begin(200, 100, BOX);
    h.clock.now += 60;
    h.batcher.move(260, 120);
    h.batcher.end();
    expect(h.emitted.map((event) => [event.phase, event.color, event.width])).toEqual([
      ["start", "#00ff00", 4],
      ["move", "#00ff00", 4],
      ["end", "#00ff00", 4],
    ]);
  });
});

describe("[FR-7.8] strokes are batched, not one event per point", () => {
  it("[FR-7.8] a stroke emits start, move*, end in order", () => {
    const h = harness();
    scribble(h, 60, 500);
    const phases = h.emitted.map((event) => event.phase);
    expect(phases[0]).toBe("start");
    expect(phases[phases.length - 1]).toBe("end");
    expect(phases.slice(1, -1).every((phase) => phase === "move")).toBe(true);
    expect(h.emitted[0]?.points).toHaveLength(1);
  });

  it("[FR-7.8] 120 Hz input produces far fewer events than points", () => {
    const h = harness();
    scribble(h, 120, 1_000);
    const points = totalPoints(h.emitted);
    expect(points).toBeGreaterThan(50);
    // ~50 ms batches => ~20 move events per second, plus start/end.
    expect(h.emitted.length).toBeLessThanOrEqual(24);
    expect(h.emitted.length).toBeLessThan(points / 2);
  });

  it("[FR-7.8] sampling keeps at most one point per 16 ms unless the finger moved 8 px", () => {
    const h = harness();
    h.batcher.begin(300, 150, BOX);
    h.clock.now += 5;
    expect(h.batcher.move(303, 150)).toBeNull();
    h.clock.now += 5;
    expect(h.batcher.move(310, 150)).not.toBeNull();
    h.clock.now += 16;
    expect(h.batcher.move(311, 150)).not.toBeNull();
  });

  it("[FR-7.8] a move batch never exceeds 16 points", () => {
    const h = harness();
    h.batcher.begin(100, 50, BOX);
    for (let index = 1; index <= 200; index += 1) {
      h.clock.now += 1;
      h.batcher.move(100 + ((index * 9) % 400), 50 + (index % 200));
    }
    h.batcher.end();
    const moves = h.emitted.filter((event) => event.phase === "move");
    expect(moves.length).toBeGreaterThan(0);
    expect(moves.every((event) => event.points.length <= 16)).toBe(true);
  });

  it("[FR-7.8] the idle timer flushes points when the finger stops", () => {
    const h = harness();
    h.batcher.begin(300, 150, BOX);
    h.clock.now += 20;
    h.batcher.move(320, 150);
    expect(h.emitted).toHaveLength(1);
    h.clock.now += 50;
    h.fireTimers();
    expect(h.emitted).toHaveLength(2);
    expect(h.emitted[1]?.phase).toBe("move");
    expect(h.batcher.pendingCount).toBe(0);
  });

  it("[FR-7.8] end carries remaining points and the total count; cancel still ends", () => {
    const h = harness();
    h.batcher.begin(300, 150, BOX);
    h.clock.now += 20;
    h.batcher.move(320, 150);
    h.batcher.end(340, 150);
    const end = h.emitted[h.emitted.length - 1];
    expect(end?.phase).toBe("end");
    expect(end?.points).toHaveLength(2);
    expect(end?.count).toBe(3);

    const cancelled = harness();
    cancelled.batcher.begin(300, 150, BOX);
    cancelled.batcher.cancel();
    expect(cancelled.emitted.map((event) => event.phase)).toEqual(["start", "end"]);
    expect(cancelled.emitted[1]?.points).toEqual([]);
    expect(cancelled.batcher.active).toBe(false);
  });

  it("[FR-7.8] only one stroke is active at a time", () => {
    const h = harness();
    expect(h.batcher.begin(300, 150, BOX)).not.toBeNull();
    expect(h.batcher.begin(310, 160, BOX)).toBeNull();
    expect(h.emitted).toHaveLength(1);
  });

  it("[FR-7.8] maxStrokePoints caps the stroke", () => {
    const h = harness({ maxStrokePoints: 5 });
    h.batcher.begin(100, 50, BOX);
    for (let index = 1; index <= 40; index += 1) {
      h.clock.now += 20;
      h.batcher.move(100 + index * 9, 60);
    }
    h.batcher.end(499, 249);
    expect(totalPoints(h.emitted)).toBe(5);
    expect(h.emitted[h.emitted.length - 1]?.count).toBe(5);
  });
});

describe("[E10] stroke bandwidth", () => {
  it("[E10] stroke bandwidth is under 20 KB/s per drawer over 30 s of fast drawing", () => {
    const h = harness();
    const start = h.clock.now;
    // Back-to-back strokes, 120 Hz, large fast circles.
    while (h.clock.now - start < 30_000) {
      scribble(h, 120, 2_000, 150);
      h.clock.now += 10;
    }

    const elapsedSeconds = (h.clock.now - start) / 1_000;
    const totalBytes = h.sentAt.reduce((sum, entry) => sum + entry.bytes, 0);
    expect(totalBytes / elapsedSeconds).toBeLessThan(STROKE_MAX_BYTES_PER_SECOND);

    // Worst one-second window, start/end included.
    let worst = 0;
    for (const entry of h.sentAt) {
      const windowBytes = h.sentAt
        .filter((other) => other.at >= entry.at && other.at < entry.at + 1_000)
        .reduce((sum, other) => sum + other.bytes, 0);
      worst = Math.max(worst, windowBytes);
    }
    expect(worst).toBeLessThan(STROKE_MAX_BYTES_PER_SECOND);
    expect(h.batcher.stats().bytes).toBe(totalBytes);
  });

  it("[E10] stroke visible delay is under 100 ms: batches leave at least every ~50 ms", () => {
    const h = harness();
    h.batcher.begin(300, 150, BOX);
    let lastFlushAt = h.clock.now;
    let worstWait = 0;
    for (let index = 1; index <= 240; index += 1) {
      h.clock.now += 1_000 / 120;
      const before = h.emitted.length;
      h.batcher.move(300 + Math.cos(index / 10) * 100, 150 + Math.sin(index / 10) * 50);
      if (h.emitted.length > before) {
        worstWait = Math.max(worstWait, h.clock.now - lastFlushAt);
        lastFlushAt = h.clock.now;
      }
    }
    expect(worstWait).toBeLessThan(100);
  });

  it("[E10] the bandwidth cap defers moves and decimates instead of dropping the stroke", () => {
    const h = harness({ maxBytesPerSecond: 1_500, maxPendingPoints: 32 });
    scribble(h, 120, 3_000, 150);
    const stats = h.batcher.stats();
    expect(stats.deferredFlushes).toBeGreaterThan(0);
    expect(stats.coalescedPoints).toBeGreaterThan(0);
    const phases = h.emitted.map((event) => event.phase);
    expect(phases[0]).toBe("start");
    expect(phases[phases.length - 1]).toBe("end");
    // `end` stays inside one bounded batch.
    expect(h.emitted[h.emitted.length - 1]?.points.length).toBeLessThanOrEqual(32);
  });

  it("[E10] pending points stay bounded under sustained pressure", () => {
    const h = harness({ maxBytesPerSecond: 0, maxPendingPoints: 20 });
    h.batcher.begin(100, 50, BOX);
    let peak = 0;
    for (let index = 1; index <= 500; index += 1) {
      h.clock.now += 20;
      h.batcher.move(100 + (index % 400), 50 + (index % 200));
      peak = Math.max(peak, h.batcher.pendingCount);
    }
    expect(peak).toBeLessThanOrEqual(20);
    expect(h.emitted.map((event) => event.phase)).toEqual(["start"]);
  });
});

describe("[FR-7.8] stroke coalescing helpers", () => {
  const point = (x: number): StrokePoint => ({ x, y: 0, t: x });

  it("[FR-7.8] decimation keeps the first and last point", () => {
    const points = Array.from({ length: 101 }, (_, index) => point(index));
    const removed = decimatePoints(points, 10);
    expect(points.length).toBeLessThanOrEqual(10);
    expect(points[0]?.x).toBe(0);
    expect(points[points.length - 1]?.x).toBe(100);
    expect(removed).toBe(101 - points.length);
  });

  it("[FR-7.8] queued move batches merge; start/end and different ink never merge", () => {
    const move = (x: number): StrokeEventData => ({
      points: [point(x)],
      color: "#fff",
      width: 6,
      phase: "move",
    });
    expect(coalesceStrokeData(move(1), move(2))).toEqual({
      points: [point(1), point(2)],
      color: "#fff",
      width: 6,
      phase: "move",
    });
    expect(coalesceStrokeData({ ...move(1), phase: "start" }, move(2))).toBeNull();
    expect(coalesceStrokeData(move(1), { ...move(2), phase: "end" })).toBeNull();
    expect(coalesceStrokeData(move(1), { ...move(2), color: "#000" })).toBeNull();
    expect(coalesceStrokeData({ value: "x" }, move(2))).toBeNull();
  });
});

describe("[SR-13] strokes are not stored", () => {
  it("[SR-13] the batcher keeps no points after end or reset", () => {
    const h = harness();
    h.batcher.begin(300, 150, BOX);
    h.clock.now += 20;
    h.batcher.move(330, 150);
    h.batcher.end();
    expect(h.batcher.pendingCount).toBe(0);
    expect(h.batcher.active).toBe(false);

    h.batcher.begin(300, 150, BOX);
    h.clock.now += 20;
    h.batcher.move(330, 150);
    const emittedBefore = h.emitted.length;
    h.batcher.reset();
    expect(h.batcher.pendingCount).toBe(0);
    expect(h.emitted).toHaveLength(emittedBefore);
  });
});
