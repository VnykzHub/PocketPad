/**
 * Sub-tick tap and same-frame feedback tests (D2-QA-01).
 *
 * These tests wire a real button renderer, the real `InputStore`, the real
 * `SendLoop` and an injected clock/timer pair — the same path the controller
 * runs on a phone, minus the socket. They prove:
 *
 * - a press and release that both happen between sends leave one packet with
 *   the press edge set and the level clear (FR-7.3);
 * - a 5 ms tap between two 60 Hz host polls emits its edges inside one host
 *   frame and ends at level zero (FR-7.3, G2);
 * - the pressed visual and the input bit change synchronously in the touch
 *   handler, with no animation frame or network round trip (FR-8.7);
 * - the press packet leaves in the same call as `touchstart`, so the send
 *   policy adds no waiting for the next cadence tick (G2).
 *
 * jsdom is enough for the DOM assertions because the renderer writes classes
 * and `transform`/`opacity` synchronously; real-device same-frame capture is
 * the manual half of D2-QA-01.
 */
import { describe, expect, it } from "vitest";
import type { ButtonControl } from "@lanpad/sdk";
import type { InputState } from "@lanpad/protocol";
import { createControl } from "../src/controls/registry.js";
import type { ControlRenderer } from "../src/controls/control.js";
import { InputStore } from "../src/input/InputStore.js";
import { SendLoop } from "../src/input/sendLoop.js";
import { ClockSync } from "../src/net/clockSync.js";
import type { TouchBinding } from "../src/touch/touchEngine.js";

const SURFACE = { width: 800, height: 400 } as const;

const JUMP: ButtonControl = {
  type: "button",
  id: "jump",
  label: "Jump",
  shape: "circle",
  x: "82%",
  y: "70%",
  r: "11%",
  bit: 0,
};

const JUMP_BIT = 1 << JUMP.bit;
const FRAME_MS = 1000 / 60;

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
  loop: SendLoop;
  sent: InputState[];
  sendTimes: number[];
}

function setup(): Harness {
  const timers = new FakeTimers();
  const store = new InputStore();
  const sent: InputState[] = [];
  const sendTimes: number[] = [];

  const loop = new SendLoop({
    store,
    clock: new ClockSync(),
    send: (state) => {
      sent.push({ ...state });
      sendTimes.push(timers.nowMs);
    },
    now: timers.now,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  store.onChange = () => {
    loop.notifyChange();
  };

  return { timers, store, loop, sent, sendTimes };
}

function buttonRenderer(store: InputStore): ControlRenderer {
  return createControl(JUMP, { input: store, surfaceSize: SURFACE });
}

function binding(): TouchBinding {
  return {
    identifier: 1,
    controlId: JUMP.id,
    startX: 656,
    startY: 280,
    lastX: 656,
    lastY: 280,
  };
}

describe("[FR-7.3] edges survive sub-tick taps", () => {
  it("[FR-7.3] a tap whose press and release fall between sends emits one packet with its edge and level zero", () => {
    const harness = setup();
    const button = buttonRenderer(harness.store);
    harness.loop.start();
    // D2-CTRL-04 sends one empty packet after `joined`, which opens the 4 ms
    // coalescing window the tap lands inside.
    harness.loop.notifyChange();
    expect(harness.sent).toHaveLength(1);

    harness.timers.advance(1);
    button.onTouchStart(binding()); // t = 1, coalesced to t = 4
    expect(harness.sent).toHaveLength(1);

    harness.timers.advance(2);
    button.onTouchEnd(binding()); // t = 3, still inside the same window
    expect(harness.store.snapshot(0).buttons).toBe(0);
    expect(harness.store.snapshot(0).edges).toBe(JUMP_BIT);

    harness.timers.advance(1); // t = 4: the single coalesced packet goes out
    expect(harness.sent).toHaveLength(2);
    expect(harness.sent[1]?.buttons).toBe(0);
    expect(harness.sent[1]?.edges).toBe(JUMP_BIT);
    expect(harness.sendTimes[1]).toBe(4);
    // Edges are cleared only after `send()` returned.
    expect(harness.store.snapshot(0).edges).toBe(0);

    harness.loop.stop();
  });

  it("[FR-7.3] a 5 ms tap between host polls keeps its edge and ends at level zero", () => {
    const harness = setup();
    const button = buttonRenderer(harness.store);
    harness.loop.start();
    harness.loop.notifyChange(); // t = 0, initial empty packet
    harness.timers.advance(10); // leave the 4 ms coalescing window

    button.onTouchStart(binding()); // t = 10, sent synchronously
    expect(harness.sent).toHaveLength(2);
    expect(harness.sent[1]?.buttons).toBe(JUMP_BIT);
    expect(harness.sent[1]?.edges).toBe(JUMP_BIT);

    harness.timers.advance(5);
    button.onTouchEnd(binding()); // t = 15, exactly 5 ms after the press
    expect(harness.sent).toHaveLength(3);
    expect(harness.sent[2]?.buttons).toBe(0);

    // The host ORs edges across packets, so the tap's edge survives even
    // though the level is already zero.
    const pressEdges = harness.sent.reduce(
      (edges, packet) => edges | packet.edges,
      0,
    );
    expect(pressEdges).toBe(JUMP_BIT);
    expect(harness.sent[harness.sent.length - 1]?.buttons).toBe(0);

    // Both packets fall inside one 60 Hz host frame (16.67 ms).
    expect(harness.sendTimes[1]).toBe(10);
    expect(harness.sendTimes[2]).toBe(15);
    expect((harness.sendTimes[2] ?? 0) - (harness.sendTimes[1] ?? 0)).toBeLessThan(
      FRAME_MS,
    );

    harness.loop.stop();
  });
});

describe("[FR-7.12] edges accumulate until a host poll", () => {
  it("[FR-7.12] two presses inside one send window travel as one packet with both edges", () => {
    const harness = setup();
    harness.loop.start();
    harness.loop.notifyChange(); // t = 0
    harness.timers.advance(1);

    harness.store.setButton(0, true);
    harness.store.setButton(5, true);
    harness.timers.advance(3); // t = 4

    expect(harness.sent).toHaveLength(2);
    expect(harness.sent[1]?.buttons).toBe((1 << 0) | (1 << 5));
    expect(harness.sent[1]?.edges).toBe((1 << 0) | (1 << 5));

    harness.loop.stop();
  });
});

describe("[FR-8.7] same-frame feedback", () => {
  it("[FR-8.7] pressed class, transform and input bit are applied before touchstart returns", () => {
    const harness = setup();
    const button = buttonRenderer(harness.store);
    harness.loop.start();
    harness.loop.notifyChange(); // t = 0
    harness.timers.advance(10);

    expect(button.element.classList.contains("is-pressed")).toBe(false);
    expect(harness.store.snapshot(0).buttons).toBe(0);

    button.onTouchStart(binding());

    // No await, timer advance or animation frame sits between the handler and
    // these assertions: this is the state visible during the touch event.
    expect(button.element.classList.contains("is-pressed")).toBe(true);
    expect(button.element.style.transform).toContain("scale(0.92)");
    expect(button.element.style.opacity).toBe("0.72");
    expect(button.element.getAttribute("aria-pressed")).toBe("true");
    expect(harness.store.snapshot(0).buttons).toBe(JUMP_BIT);
    // The feedback never waits for the network: the packet is already out.
    expect(harness.sent[1]?.buttons).toBe(JUMP_BIT);
    expect(harness.sent[1]?.edges).toBe(JUMP_BIT);

    button.onTouchEnd(binding());

    expect(button.element.classList.contains("is-pressed")).toBe(false);
    expect(button.element.style.transform).toContain("scale(1)");
    expect(button.element.getAttribute("aria-pressed")).toBe("false");
    expect(harness.store.snapshot(0).buttons).toBe(0);

    harness.loop.stop();
  });
});

describe("[G2] no send-tick delay", () => {
  it("[G2] the press packet leaves in the same call as touchstart", () => {
    const harness = setup();
    const button = buttonRenderer(harness.store);
    harness.loop.start();
    harness.loop.notifyChange(); // t = 0, opens the window
    harness.timers.advance(10); // now outside it

    button.onTouchStart(binding());

    expect(harness.sent).toHaveLength(2);
    // The packet timestamp equals the touch time, not the next 60 Hz cadence
    // tick or a network round trip.
    expect(harness.sendTimes[1]).toBe(10);

    harness.loop.stop();
  });
});
