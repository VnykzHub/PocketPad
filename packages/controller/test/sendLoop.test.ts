import { describe, expect, it } from "vitest";
import type { InputState } from "@lanpad/protocol";
import { InputStore } from "../src/input/InputStore.js";
import {
  ACTIVE_SEND_INTERVAL_MS,
  IDLE_SEND_INTERVAL_MS,
  MIN_SEND_INTERVAL_MS,
  SendLoop,
} from "../src/input/sendLoop.js";
import { ClockSync } from "../src/net/clockSync.js";

/** Deterministic timer queue over a single monotonic millisecond clock. */
class FakeTimers {
  nowMs = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  readonly now = (): number => this.nowMs;

  readonly setTimer = (fn: () => void, ms: number): number => {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.nowMs + Math.max(0, ms), fn });
    return id;
  };

  readonly clearTimer = (id: number): void => {
    this.timers.delete(id);
  };

  get pending(): number {
    return this.timers.size;
  }

  advance(ms: number): void {
    const target = this.nowMs + Math.max(0, ms);
    for (;;) {
      let dueId = -1;
      let dueAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < dueAt) {
          dueId = id;
          dueAt = timer.at;
        }
      }
      if (dueId === -1) {
        break;
      }
      const due = this.timers.get(dueId);
      this.timers.delete(dueId);
      if (due === undefined) {
        continue;
      }
      this.nowMs = Math.max(this.nowMs, due.at);
      due.fn();
    }
    this.nowMs = target;
  }
}

interface Harness {
  timers: FakeTimers;
  store: InputStore;
  clock: ClockSync;
  loop: SendLoop;
  sent: InputState[];
  sendTimes: number[];
  refs: InputState[];
  storeEdgesDuringSend: number[];
}

function setup(
  options: {
    clock?: ClockSync;
  } = {},
): Harness {
  const timers = new FakeTimers();
  const store = new InputStore();
  const clock = options.clock ?? new ClockSync();
  const sent: InputState[] = [];
  const sendTimes: number[] = [];
  const refs: InputState[] = [];
  const storeEdgesDuringSend: number[] = [];

  const loop = new SendLoop({
    store,
    clock,
    send: (state) => {
      storeEdgesDuringSend.push(store.snapshot(0).edges);
      refs.push(state);
      sent.push({ ...state });
      sendTimes.push(timers.nowMs);
    },
    now: timers.now,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  return {
    timers,
    store,
    clock,
    loop,
    sent,
    sendTimes,
    refs,
    storeEdgesDuringSend,
  };
}

describe("[FR-7.1] idle keepalive is 10 Hz", () => {
  it("[FR-7.1] start arms the cadence without sending a duplicate packet", () => {
    const { loop, timers, sent } = setup();
    loop.start();
    expect(sent).toHaveLength(0);
    expect(timers.pending).toBe(1);
    loop.stop();
  });

  it("[FR-7.1] idle sends occur once per 100 ms and never faster", () => {
    const { loop, timers, sent, sendTimes } = setup();
    loop.start();

    timers.advance(IDLE_SEND_INTERVAL_MS - 1);
    expect(sent).toHaveLength(0);

    timers.advance(1);
    expect(sent).toHaveLength(1);
    expect(sendTimes[0]).toBe(100);

    timers.advance(999);
    // Steady state: exactly ten packets in one second (100..1000 ms).
    expect(sent).toHaveLength(10);
    for (let index = 1; index < sendTimes.length; index += 1) {
      expect(sendTimes[index] - sendTimes[index - 1]).toBeCloseTo(
        IDLE_SEND_INTERVAL_MS,
        6,
      );
    }

    loop.stop();
  });
});

describe("[FR-7.1] active input sends at 60 Hz", () => {
  it("[FR-7.1] a held button raises the cadence to one packet per 16.67 ms", () => {
    const { loop, store, timers, sent, sendTimes } = setup();
    loop.start();
    store.setButton(0, true);
    loop.notifyChange();

    expect(sent).toHaveLength(1);
    expect(sendTimes[0]).toBe(0);

    timers.advance(1_000);
    // One immediate packet plus a 60 Hz cadence; a one-second window holds
    // 59-61 packets depending on where the window boundary falls.
    expect(sent.length).toBeGreaterThanOrEqual(59);
    expect(sent.length).toBeLessThanOrEqual(62);

    for (let index = 2; index < sendTimes.length; index += 1) {
      const delta = sendTimes[index] - sendTimes[index - 1];
      expect(delta).toBeCloseTo(ACTIVE_SEND_INTERVAL_MS, 6);
    }

    loop.stop();
  });
});

describe("[FR-7.1] changes send immediately and coalesce within 4 ms", () => {
  it("[FR-7.1] a change outside the window sends before returning", () => {
    const { loop, store, timers, sent } = setup();
    loop.start();
    store.onChange = () => {
      loop.notifyChange();
    };

    store.setButton(0, true);
    expect(sent).toHaveLength(1);
    expect(sent[0].buttons).toBe(1);
    expect(sent[0].edges).toBe(1);

    timers.advance(10);
    store.setButton(0, false);
    expect(sent).toHaveLength(2);
    expect(sent[1].buttons).toBe(0);
    expect(sent[1].edges).toBe(0);

    loop.stop();
  });

  it("[FR-7.1] bursts inside 4 ms produce one packet with every edge", () => {
    const { loop, store, timers, sent } = setup();
    loop.start();
    store.setButton(0, true);
    loop.notifyChange();
    expect(sent).toHaveLength(1);

    timers.advance(1);
    store.setButton(7, true);
    loop.notifyChange();
    store.setButton(7, false);
    loop.notifyChange();
    expect(sent).toHaveLength(1);

    timers.advance(MIN_SEND_INTERVAL_MS - 1);
    expect(sent).toHaveLength(2);
    expect(sent[1].buttons).toBe(1);
    // Only the button pressed inside the window contributes a new edge.
    expect(sent[1].edges).toBe(1 << 7);
    expect(store.snapshot(0).edges).toBe(0);

    loop.stop();
  });

  it("[FR-7.1] after the window a new change sends immediately again", () => {
    const { loop, store, timers, sent } = setup();
    loop.start();
    store.setButton(0, true);
    loop.notifyChange();
    timers.advance(MIN_SEND_INTERVAL_MS);
    store.setButton(1, true);
    loop.notifyChange();
    expect(sent).toHaveLength(2);
    expect(sent[1].edges).toBe(1 << 1);
    loop.stop();
  });
});

describe("[FR-7.3] edges survive a sub-tick tap", () => {
  it("[FR-7.3] press and release inside the coalescing window leave level 0 and edge set", () => {
    const { loop, store, timers, sent } = setup();
    loop.start();
    store.setButton(0, true);
    loop.notifyChange(); // initial packet at t=0
    expect(sent).toHaveLength(1);

    timers.advance(1);
    store.setButton(0, false); // release the held button inside the window
    store.setButton(5, true);
    loop.notifyChange(); // coalesced to t=4
    store.setButton(5, false);
    loop.notifyChange(); // still coalesced

    timers.advance(MIN_SEND_INTERVAL_MS - 1);
    expect(sent).toHaveLength(2);
    expect(sent[1].buttons).toBe(0);
    expect(sent[1].edges).toBe(1 << 5);

    loop.stop();
  });

  it("[FR-7.3] edges are cleared only after send returns", () => {
    const { loop, store, sent, storeEdgesDuringSend } = setup();
    loop.start();
    store.setButton(2, true);
    loop.notifyChange();

    expect(sent).toHaveLength(1);
    expect(sent[0].edges).toBe(1 << 2);
    // The store still held the edge while send() was running.
    expect(storeEdgesDuringSend).toEqual([1 << 2]);
    // ...and cleared it only afterwards.
    expect(store.snapshot(0).edges).toBe(0);

    loop.stop();
  });

  it("[FR-7.3] a failed send holds edges and the level for the retry", () => {
    let failNext = true;
    const timers = new FakeTimers();
    const store = new InputStore();
    const sent: InputState[] = [];
    let attempts = 0;

    const loop = new SendLoop({
      store,
      clock: new ClockSync(),
      now: timers.now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      send: (state) => {
        attempts += 1;
        if (failNext) {
          failNext = false;
          throw new Error("socket not open");
        }
        sent.push({ ...state });
      },
    });

    loop.start();
    store.setButton(4, true);
    loop.notifyChange();

    expect(attempts).toBe(1);
    expect(sent).toHaveLength(0);
    expect(store.snapshot(0).buttons).toBe(1 << 4);
    expect(store.snapshot(0).edges).toBe(1 << 4);

    timers.advance(ACTIVE_SEND_INTERVAL_MS + 1);
    expect(attempts).toBe(2);
    expect(sent).toHaveLength(1);
    expect(sent[0].buttons).toBe(1 << 4);
    expect(sent[0].edges).toBe(1 << 4);

    loop.stop();
  });
});

describe("[A3] tick is a u32 server-time estimate", () => {
  it("[A3] tick is 0 before the first clock sample", () => {
    const { loop, store, sent } = setup();
    loop.start();
    store.setButton(0, true);
    loop.notifyChange();
    expect(sent[0].tick).toBe(0);
    loop.stop();
  });

  it("[A3] tick follows the synced clock and advances between packets", () => {
    const clock = new ClockSync();
    // 20 ms RTT, symmetric 10 ms legs, server clock 1000 ms ahead.
    clock.onPong(100, 1110, 120);
    expect(clock.offsetMs).toBe(1000);

    const { loop, store, timers, sent } = setup({ clock });
    timers.nowMs = 500;
    loop.start();
    store.setButton(0, true);
    loop.notifyChange();
    expect(sent[0].tick).toBe(1500);

    timers.advance(ACTIVE_SEND_INTERVAL_MS);
    expect(sent[1].tick).toBe(Math.trunc(1000 + 500 + ACTIVE_SEND_INTERVAL_MS));
    expect(sent[1].tick).toBeGreaterThan(sent[0].tick);

    loop.stop();
  });

  it("[A3] tick wraps to u32", () => {
    const clock = new ClockSync();
    clock.onPong(4_294_967_000, 4_294_968_010, 4_294_967_020);
    expect(clock.offsetMs).toBe(1000);

    const { loop, store, timers, sent } = setup({ clock });
    timers.nowMs = 4_294_967_000;
    loop.start();
    store.setButton(0, true);
    loop.notifyChange();
    expect(sent[0].tick).toBe(704); // (2^32 + 704) truncated to u32
    loop.stop();
  });
});

describe("[PR-9.3] SendLoop reuses one InputState object", () => {
  it("[PR-9.3] every send receives the same packet instance", () => {
    const { loop, store, timers, refs } = setup();
    loop.start();
    store.setButton(0, true);
    loop.notifyChange();
    timers.advance(500);

    expect(refs.length).toBeGreaterThan(3);
    for (const ref of refs) {
      expect(ref).toBe(refs[0]);
    }

    loop.stop();
  });
});

describe("[FR-7.1] lifecycle", () => {
  it("[FR-7.1] stop cancels every timer and restart resumes the cadence", () => {
    const { loop, store, timers, sent } = setup();
    loop.start();
    timers.advance(50);
    store.setButton(0, true);
    loop.notifyChange();
    const beforeStop = sent.length;

    loop.stop();
    expect(timers.pending).toBe(0);
    timers.advance(1_000);
    expect(sent).toHaveLength(beforeStop);

    loop.start();
    timers.advance(100);
    expect(sent.length).toBeGreaterThan(beforeStop);

    loop.stop();
  });

  it("[FR-7.1] notifyChange before start is ignored", () => {
    const { loop, store, sent } = setup();
    store.setButton(0, true);
    loop.notifyChange();
    expect(sent).toHaveLength(0);
  });

  it("[FR-7.1] a hidden document pauses sends and becoming visible resumes", () => {
    let visibility: "visible" | "hidden" = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });

    const { loop, timers, sent } = setup();
    try {
      loop.start();
      timers.advance(150);
      const beforeHide = sent.length;
      expect(beforeHide).toBe(1);

      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      expect(loop.isPaused).toBe(true);
      timers.advance(1_000);
      expect(sent).toHaveLength(beforeHide);

      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      expect(loop.isPaused).toBe(false);
      // Resuming sends a fresh packet immediately, then the idle cadence.
      expect(sent).toHaveLength(beforeHide + 1);
      timers.advance(IDLE_SEND_INTERVAL_MS);
      expect(sent).toHaveLength(beforeHide + 2);
    } finally {
      loop.stop();
      delete (document as { visibilityState?: unknown }).visibilityState;
    }
  });
});
