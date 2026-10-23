/**
 * Pause ownership acceptance tests (01 §7, ER-01-04).
 *
 * 01 §3.2 and the frozen contract define six `PauseReason` values. The
 * ER-01-04 row says "seven"; that is a spec typo, so this suite covers every
 * reason the type system actually permits.
 */
import { expect, test } from "vitest";
import type { PauseReason } from "../../src/contracts/time.js";
import { ManualScheduler } from "../../src/platform/index.js";
import {
  EngineLoop,
  PAUSE_REASON_BITS,
  PAUSE_REASON_COUNT,
  PAUSE_REASON_ORDER,
  PauseReasons,
} from "../../src/time/index.js";

const ALL_REASONS_MASK = 0b111111;

interface PauseHarness {
  readonly loop: EngineLoop;
  readonly pauseEvents: Array<{ paused: boolean; reasons: number }>;
}

function createPauseHarness(): PauseHarness {
  const scheduler = new ManualScheduler();
  const pauseEvents: Array<{ paused: boolean; reasons: number }> = [];
  const loop = new EngineLoop({
    now: () => scheduler.nowMs,
    raf: (callback) => scheduler.request(callback),
    cancel: (id) => scheduler.cancel(id),
    onTick: () => {
      /* no simulation needed */
    },
    onRender: () => {
      /* render calls are covered by loop.test.ts */
    },
    onPauseChange: (paused, reasons) => {
      pauseEvents.push({ paused, reasons });
    },
  });
  loop.start();
  return { loop, pauseEvents };
}

test("[ER-01-04] six interleaved holds keep the loop paused until the last release", () => {
  expect(PAUSE_REASON_COUNT).toBe(6);
  expect(PAUSE_REASON_ORDER).toHaveLength(6);

  const reasons = new PauseReasons();
  const tokens = new Map<PauseReason, () => void>();
  for (const reason of PAUSE_REASON_ORDER) {
    tokens.set(reason, reasons.hold(reason));
  }

  expect(reasons.paused).toBe(true);
  expect(reasons.mask).toBe(ALL_REASONS_MASK);

  const releaseOrder: readonly PauseReason[] = [
    "menu",
    "visibility",
    "network",
    "manual",
    "hostPause",
    "contextLoss",
  ];
  for (let index = 0; index < releaseOrder.length; index += 1) {
    const reason = releaseOrder[index];
    if (reason === undefined) {
      throw new Error("release order is shorter than the reason list");
    }
    const token = tokens.get(reason);
    if (token === undefined) {
      throw new Error(`no hold token for ${reason}`);
    }
    token();
    expect(reasons.count(reason)).toBe(0);

    // A second call on the same token must not release anything else.
    token();

    const last = index === releaseOrder.length - 1;
    expect(reasons.paused).toBe(!last);
    if (last) {
      expect(reasons.mask).toBe(0);
    }
  }
});

test("[ER-01-04] holding one reason twice needs two releases", () => {
  const reasons = new PauseReasons();
  const first = reasons.hold("visibility");
  const second = reasons.hold("visibility");

  expect(reasons.count("visibility")).toBe(2);
  first();
  expect(reasons.paused).toBe(true);
  expect(reasons.mask).toBe(PAUSE_REASON_BITS.visibility);
  second();
  expect(reasons.paused).toBe(false);
  expect(reasons.mask).toBe(0);
});

test("[ER-01-04] onPauseChange fires exactly twice per aggregate transition", () => {
  const harness = createPauseHarness();

  try {
    const releaseMenu = harness.loop.holdPause("menu");
    const releaseVisibility = harness.loop.holdPause("visibility");

    expect(harness.pauseEvents).toHaveLength(1);
    // The transition fires on the first hold, before visibility is added.
    expect(harness.pauseEvents[0]).toEqual({
      paused: true,
      reasons: PAUSE_REASON_BITS.menu,
    });
    expect(harness.loop.pausedBy).toBe(
      PAUSE_REASON_BITS.menu | PAUSE_REASON_BITS.visibility,
    );

    releaseMenu();
    expect(harness.pauseEvents).toHaveLength(1);
    releaseMenu();
    expect(harness.pauseEvents).toHaveLength(1);

    releaseVisibility();
    expect(harness.pauseEvents).toHaveLength(2);
    expect(harness.pauseEvents[1]).toEqual({ paused: false, reasons: 0 });

    // manual pause()/resume() do not add transitions while menu is held
    const releaseMenuAgain = harness.loop.holdPause("menu");
    harness.loop.pause();
    harness.loop.resume();
    expect(harness.pauseEvents).toHaveLength(3);

    releaseMenuAgain();
    expect(harness.pauseEvents).toHaveLength(4);
    expect(harness.pauseEvents[3]).toEqual({ paused: false, reasons: 0 });
    expect(harness.loop.paused).toBe(false);
  } finally {
    harness.loop.dispose();
  }
});
