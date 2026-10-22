/**
 * D6-CTRL-04 haptic player tests: frame decoding, duration validation, 20 Hz
 * coalescing, longest-pattern merge, immediate play after 50 ms, toggle-off
 * suppression and visual/audio fallback. No navigator or real timer is used.
 */
import { describe, expect, it } from "vitest";
import { encodeHaptic } from "@lanpad/protocol";
import {
  HAPTIC_COALESCE_MS,
  HapticPlayer,
  MAX_HAPTIC_DURATION_MS,
  createDomVisualPulse,
  sanitizeHapticDurations,
  totalOnDuration,
  type HapticScheduler,
  type VibrateFn,
} from "../src/haptics/HapticPlayer.js";

class FakeScheduler implements HapticScheduler {
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
  vibrate?: VibrateFn | null | undefined;
  enabled?: boolean | undefined;
}

function makeHarness(options: HarnessOptions = {}): {
  player: HapticPlayer;
  scheduler: FakeScheduler;
  vibrations: Array<number | number[]>;
  pulses: number[];
  clicks: () => number;
} {
  const scheduler = new FakeScheduler();
  const vibrations: Array<number | number[]> = [];
  const pulses: number[] = [];
  let clicks = 0;

  const vibrate: VibrateFn =
    options.vibrate === undefined
      ? (pattern) => {
          vibrations.push(Array.isArray(pattern) ? [...pattern] : pattern);
          return true;
        }
      : (options.vibrate ?? (() => false));

  const player = new HapticPlayer({
    scheduler,
    now: () => scheduler.now,
    vibrate,
    visualPulse: (durationMs) => {
      pulses.push(durationMs);
    },
    audioClick: () => {
      clicks += 1;
    },
    enabled: options.enabled,
  });

  return {
    player,
    scheduler,
    vibrations,
    pulses,
    clicks: () => clicks,
  };
}

describe("haptic duration validation", () => {
  it("accepts 1..8 finite durations and clamps to u16", () => {
    expect(HAPTIC_COALESCE_MS).toBe(50);
    expect(MAX_HAPTIC_DURATION_MS).toBe(0xffff);
    expect(sanitizeHapticDurations([1, 2, 3])).toEqual([1, 2, 3]);
    expect(sanitizeHapticDurations([1.6, 0, 70_000])).toEqual([
      2,
      0,
      MAX_HAPTIC_DURATION_MS,
    ]);
    expect(sanitizeHapticDurations(new Array(8).fill(10))).toHaveLength(8);
  });

  it("rejects empty, oversized, non-array and non-finite patterns", () => {
    expect(sanitizeHapticDurations([])).toBeNull();
    expect(sanitizeHapticDurations(new Array(9).fill(10))).toBeNull();
    expect(sanitizeHapticDurations("nope")).toBeNull();
    expect(sanitizeHapticDurations([1, Number.NaN])).toBeNull();
    expect(sanitizeHapticDurations([1, Number.POSITIVE_INFINITY])).toBeNull();
  });

  it("sums only the motor-on steps", () => {
    expect(totalOnDuration([10, 5, 20])).toBe(30);
    expect(totalOnDuration([10])).toBe(10);
  });
});

describe("HapticPlayer playback", () => {
  it("decodes a Haptic frame and vibrates the pattern", () => {
    const h = makeHarness();
    expect(h.player.handleFrame(encodeHaptic([50, 20]))).toBe("played");
    expect(h.vibrations).toEqual([[50, 20]]);
    expect(h.player.playedCount).toBe(1);
  });

  it("rejects malformed frames without throwing or vibrating", () => {
    const h = makeHarness();
    expect(h.player.handleFrame(new Uint8Array([0x84, 2, 5, 0]))).toBe("rejected");
    expect(h.player.rejectedCount).toBe(1);
    expect(h.vibrations).toHaveLength(0);
  });

  it("rejects duration lists outside 1..8", () => {
    const h = makeHarness();
    expect(h.player.handleDurations([])).toBe("rejected");
    expect(h.player.handleDurations(new Array(9).fill(10))).toBe("rejected");
    expect(h.player.rejectedCount).toBe(2);
    expect(h.vibrations).toHaveLength(0);
  });

  it("[FR-8.11] plays immediately when the previous pulse is at least 50 ms old", () => {
    const h = makeHarness();
    h.player.handleDurations([10]);
    h.scheduler.now = HAPTIC_COALESCE_MS;
    expect(h.player.handleDurations([30])).toBe("played");
    expect(h.vibrations).toEqual([[10], [30]]);
  });
});

describe("[FR-8.11][E8] HapticPlayer 20 Hz coalescing", () => {
  it("[FR-8.11][E8] merges patterns inside the window and flushes after 50 ms", () => {
    const h = makeHarness();
    h.player.handleDurations([10]);
    expect(h.vibrations).toHaveLength(1);

    h.scheduler.now = 10;
    expect(h.player.handleDurations([20])).toBe("coalesced");
    expect(h.player.pendingPattern).toEqual([20]);

    h.scheduler.now = 20;
    expect(h.player.handleDurations([5])).toBe("coalesced");
    expect(h.player.pendingPattern).toEqual([20]);

    h.scheduler.advance(40);
    expect(h.vibrations).toHaveLength(2);
    expect(h.vibrations[1]).toEqual([20]);
    expect(h.player.pendingPattern).toBeNull();
    expect(h.player.playedCount).toBe(2);
    expect(h.player.coalescedCount).toBe(2);
  });

  it("[FR-8.11] keeps the pending pattern with the longest total duration", () => {
    const h = makeHarness();
    h.player.handleDurations([10]);

    h.scheduler.now = 10;
    h.player.handleDurations([5]);
    h.scheduler.now = 11;
    h.player.handleDurations([40, 10]);
    expect(h.player.pendingPattern).toEqual([40, 10]);

    h.scheduler.advance(39);
    expect(h.vibrations[1]).toEqual([40, 10]);
  });

  it("[FR-8.11] prefers the newest pattern on a total-duration tie", () => {
    const h = makeHarness();
    h.player.handleDurations([10]);

    h.scheduler.now = 10;
    h.player.handleDurations([10]);
    h.scheduler.now = 11;
    h.player.handleDurations([2, 8]);
    expect(h.player.pendingPattern).toEqual([2, 8]);
  });

  it("[FR-8.11] drops a queued pattern when a new immediate pulse starts", () => {
    const h = makeHarness();
    h.player.handleDurations([10]);

    h.scheduler.now = 49;
    expect(h.player.handleDurations([10])).toBe("coalesced");
    expect(h.scheduler.size).toBe(1);

    h.scheduler.now = 50;
    expect(h.player.handleDurations([30])).toBe("played");
    expect(h.player.pendingPattern).toBeNull();
    expect(h.scheduler.size).toBe(0);

    h.scheduler.advance(100);
    expect(h.vibrations).toEqual([[10], [30]]);
  });
});

describe("[FR-8.12][AR-3] HapticPlayer toggle and fallback", () => {
  it("[FR-8.12][AR-3] stops vibration and suppresses patterns while disabled", () => {
    const h = makeHarness();
    h.player.handleDurations([10]);

    h.scheduler.now = 10;
    h.player.handleDurations([20]);
    expect(h.scheduler.size).toBe(1);

    h.player.setEnabled(false);
    expect(h.vibrations).toEqual([[10], 0]);
    expect(h.player.pendingPattern).toBeNull();
    expect(h.scheduler.size).toBe(0);

    expect(h.player.handleDurations([30])).toBe("suppressed");
    expect(h.player.suppressedCount).toBe(1);
    expect(h.vibrations).toHaveLength(2);

    h.player.setEnabled(true);
    h.scheduler.now = 100;
    expect(h.player.handleDurations([40])).toBe("played");
    expect(h.player.toggle()).toBe(false);
    expect(h.player.isEnabled).toBe(false);
  });

  it("falls back to a visual pulse and click when vibration is absent", () => {
    const h = makeHarness({ vibrate: null });
    expect(h.player.handleDurations([50, 20, 10])).toBe("played");
    expect(h.pulses).toEqual([60]);
    expect(h.clicks()).toBe(1);
    expect(h.player.playedCount).toBe(0);
    expect(h.player.fallbackCount).toBe(1);
  });

  it("falls back when vibrate returns false or throws", () => {
    const rejected = makeHarness({ vibrate: () => false });
    rejected.player.handleDurations([10]);
    expect(rejected.player.fallbackCount).toBe(1);
    expect(rejected.pulses).toEqual([10]);

    const thrown = makeHarness({
      vibrate: () => {
        throw new Error("motor unavailable");
      },
    });
    thrown.player.handleDurations([10]);
    expect(thrown.player.fallbackCount).toBe(1);
    expect(thrown.pulses).toEqual([10]);
  });

  it("disposes by cancelling vibration and ignoring later frames", () => {
    const h = makeHarness();
    h.player.handleDurations([10]);
    h.player.dispose();
    expect(h.vibrations).toEqual([[10], 0]);

    expect(h.player.handleFrame(encodeHaptic([20]))).toBe("ignored");
    expect(h.vibrations).toHaveLength(2);
  });

  it("creates the DOM visual fallback lazily", () => {
    const pulse = createDomVisualPulse(document);
    expect(document.querySelector('[data-part="haptic-pulse"]')).toBeNull();

    pulse(120);
    const overlay = document.querySelector<HTMLElement>('[data-part="haptic-pulse"]');
    expect(overlay).not.toBeNull();
    expect(overlay?.getAttribute("aria-hidden")).toBe("true");
    expect(overlay?.style.opacity).toBe("0.35");
  });
});
