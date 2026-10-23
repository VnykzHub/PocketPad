/**
 * ER-10-12 — poll-once tick rules.
 *
 * `poll(tick)` runs exactly once per simulation tick: repeating the same tick
 * returns the same pooled frame without consuming edges, and an older tick is
 * an `E_INPUT_TICK` in strict mode (ignored in production mode). Negative or
 * fractional ticks always fail. The tick-order fixture pins poll to step 2
 * and forbids host operations from running inside simulate.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { InputTickError, createInputRouter } from "../src/index.js";
import type { ActionState, InputFrame } from "../src/index.js";
import { phoneSample } from "./support.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function stateOf(frame: InputFrame, name: string): ActionState {
  const state = frame.action(name);
  if (state === undefined) throw new Error(`unknown action ${name}`);
  return state;
}

function tickError(call: () => void): InputTickError {
  try {
    call();
  } catch (error) {
    if (error instanceof InputTickError) return error;
    throw error;
  }
  throw new Error("expected InputTickError");
}

describe("poll identity", () => {
  test("[ER-10-12] polling the same tick returns the frame without consuming edges", () => {
    const router = createInputRouter();
    router.setKeyboardKey("Space", true);

    const first = router.poll(0);
    const second = router.poll(0);
    expect(second).toBe(first);
    expect(stateOf(second, "primary").edges).toBe(3);

    const next = router.poll(1);
    expect(stateOf(next, "primary").edges).toBe(0);
    expect(stateOf(next, "primary").pressed).toBe(true);
  });

  test("[ER-10-12] strict mode rejects an older tick and keeps the last frame", () => {
    const router = createInputRouter();
    const fifth = router.poll(5);
    const error = tickError(() => router.poll(4));
    expect(error.code).toBe("E_INPUT_TICK");
    expect(error.layer).toBe("input");
    expect(router.poll(5)).toBe(fifth);

    router.setKeyboardKey("Space", true);
    expect(tickError(() => router.poll(3)).code).toBe("E_INPUT_TICK");
    expect(stateOf(router.poll(6), "primary").pressed).toBe(true);
  });

  test("[ER-10-12] non-strict mode ignores older ticks", () => {
    const router = createInputRouter({ strictTicks: false });
    const fifth = router.poll(5);
    router.setKeyboardKey("Space", true);

    const stale = router.poll(4);
    expect(stale).toBe(fifth);
    expect(stateOf(stale, "primary").pressed).toBe(false);

    expect(stateOf(router.poll(6), "primary").pressed).toBe(true);
  });

  test("[ER-10-12] negative and fractional ticks always fail", () => {
    const router = createInputRouter({ strictTicks: false });
    expect(tickError(() => router.poll(-1)).code).toBe("E_INPUT_TICK");
    expect(tickError(() => router.poll(1.5)).code).toBe("E_INPUT_TICK");
    expect(tickError(() => router.poll(Number.NaN)).code).toBe("E_INPUT_TICK");
    expect(stateOf(router.poll(0), "primary").pressed).toBe(false);
  });
});

describe("blur tick and tilt", () => {
  test("[ER-10-12] lastBlurTick records the last polled tick at suspension", () => {
    const router = createInputRouter();
    router.poll(0);
    router.poll(1);
    router.setFocused(false);

    const blurred = router.poll(2);
    expect(blurred.focus.focused).toBe(false);
    expect(blurred.focus.lastBlurTick).toBe(1);

    router.setFocused(true);
    router.setVisible(false);
    const hidden = router.poll(3);
    expect(hidden.focus.visible).toBe(false);
    expect(hidden.focus.lastBlurTick).toBe(2);
  });

  test("[ER-10-12] tilt set before the poll survives across polls", () => {
    const router = createInputRouter({ slots: 2 });
    router.applyPhoneSample(0, phoneSample({ slot: 0, connected: true }), 0);
    router.setTilt(0, { angleX: 10, angleY: -5, available: true });

    const first = router.poll(0);
    expect(first.player(0)?.device).toBe("phone");
    expect(first.player(0)?.controller.tilt).toEqual({
      angleX: 10,
      angleY: -5,
      available: true,
    });

    const second = router.poll(1);
    expect(second.player(0)?.controller.tilt).toEqual({
      angleX: 10,
      angleY: -5,
      available: true,
    });
  });
});

interface TickOrderFixture {
  readonly formatVersion: number;
  readonly synthetic: boolean;
  readonly inputOps: readonly {
    readonly step: number | string;
    readonly op: string;
    readonly count?: number;
  }[];
  readonly idempotentSameTick: boolean;
  readonly decreasingTick: { readonly dev: string; readonly production: string };
  readonly forbidden: readonly {
    readonly step: number | string;
    readonly op: string;
    readonly reason: string;
  }[];
}

describe("tick order fixture", () => {
  const fixture = JSON.parse(
    readFileSync(join(FIXTURES, "tick-order.json"), "utf8"),
  ) as TickOrderFixture;

  test("[ER-10-12] poll runs once at step 2 and same-tick polling is idempotent", () => {
    expect(fixture.formatVersion).toBe(1);
    expect(fixture.synthetic).toBe(true);
    expect(fixture.idempotentSameTick).toBe(true);
    expect(fixture.decreasingTick.dev).toBe("E_INPUT_TICK");
    expect(fixture.decreasingTick.production).toBe("ignored");

    const pollOps = fixture.inputOps.filter((op) => op.op === "poll");
    expect(pollOps).toHaveLength(1);
    expect(pollOps[0]?.step).toBe(2);
    expect(pollOps[0]?.count).toBe(1);
    expect(
      fixture.inputOps.find((op) => op.op === "read-frame")?.step,
    ).toBe(5);
  });

  test("[ER-10-12] host operations are forbidden inside simulate", () => {
    for (const op of [
      "poll",
      "setBindings",
      "reset",
      "beginCapture",
      "saveBindings",
    ]) {
      expect(
        fixture.forbidden.some(
          (entry) => entry.step === 5 && entry.op === op,
        ),
      ).toBe(true);
    }
    expect(
      fixture.forbidden.some(
        (entry) => entry.step === "render" && entry.op === "poll",
      ),
    ).toBe(true);
  });
});
