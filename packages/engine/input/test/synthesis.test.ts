/**
 * ER-10-10 — controller-view synthesis for keyboard/pad players.
 *
 * Non-phone players get a synthesized ControllerView from action outputs:
 * sticks, buttons, axes and triggers. A press edge sets the button bit for one
 * poll only. A phone player keeps the identity of its pooled phone view, and
 * synthesized views never carry a `tilt` property.
 */

import { describe, expect, test } from "vitest";
import { createInputRouter } from "../src/index.js";
import type { ActionState, InputAction, InputFrame } from "../src/index.js";
import { FakeTarget, elementTarget, phoneSample } from "./support.js";

const HALF_SQRT_TWO = Math.SQRT1_2;

const OUTPUT_ACTIONS: InputAction[] = [
  {
    name: "steer",
    kind: "axis",
    output: { axis: "rx" },
    bindings: [{ device: "pointer", axis: "dx" }],
  },
  {
    name: "throttle",
    kind: "axis",
    deadzone: 0,
    output: { trigger: "rt" },
    bindings: [{ device: "pointer", axis: "dx", scale: 0.8 }],
  },
];

function actionNamed(frame: InputFrame, name: string): ActionState {
  const state = frame.action(name);
  if (state === undefined) throw new Error(`unknown action ${name}`);
  return state;
}

describe("default map synthesis", () => {
  test("[ER-10-10] W+D synthesizes the left stick and normalizes move", () => {
    const router = createInputRouter();
    router.setKeyboardKey("KeyW", true);
    router.setKeyboardKey("KeyD", true);

    const frame = router.poll(0);
    const move = actionNamed(frame, "move");
    expect(move.pressed).toBe(true);
    expect(move.x).toBeCloseTo(HALF_SQRT_TWO, 12);
    expect(move.y).toBeCloseTo(HALF_SQRT_TWO, 12);

    const controller = frame.player(0)?.controller;
    expect(controller?.connected).toBe(true);
    expect(controller?.lx).toBeCloseTo(HALF_SQRT_TWO, 12);
    expect(controller?.ly).toBeCloseTo(-HALF_SQRT_TWO, 12);
    expect(controller?.rx).toBe(0);
    expect(controller?.ry).toBe(0);
  });

  test("[ER-10-10] a button output sets its bit for exactly one press edge", () => {
    const router = createInputRouter();
    router.setKeyboardKey("Space", true);

    const pressed = router.poll(0);
    expect(actionNamed(pressed, "primary").edges).toBe(3);
    const down = pressed.player(0)?.controller;
    expect(down?.buttons).toBe(0b1);
    expect(down?.edges).toBe(0b1);

    const held = router.poll(1).player(0)?.controller;
    expect(held?.buttons).toBe(0b1);
    expect(held?.edges).toBe(0);

    router.setKeyboardKey("Space", false);
    const released = router.poll(2).player(0)?.controller;
    expect(released?.buttons).toBe(0);
    expect(released?.edges).toBe(0);
  });

  test("[ER-10-10] default outputs map to bits 0, 1, 2, 9 and 8", () => {
    const router = createInputRouter();
    for (const code of [
      "Space",
      "ShiftLeft",
      "KeyE",
      "KeyP",
      "Backspace",
    ]) {
      router.setKeyboardKey(code, true);
    }

    const expected =
      (1 << 0) | (1 << 1) | (1 << 2) | (1 << 9) | (1 << 8);
    const pressed = router.poll(0).player(0)?.controller;
    expect(pressed?.buttons).toBe(expected);
    expect(pressed?.edges).toBe(expected);

    const held = router.poll(1).player(0)?.controller;
    expect(held?.buttons).toBe(expected);
    expect(held?.edges).toBe(0);
  });
});

describe("output kinds and view identity", () => {
  test("[ER-10-10] axis and trigger outputs copy analog action values", () => {
    const target = new FakeTarget();
    const router = createInputRouter({
      actions: OUTPUT_ACTIONS,
      target: elementTarget(target),
    });
    router.attach();
    target.dispatch("pointermove", { movementX: 25 });

    const frame = router.poll(0);
    expect(actionNamed(frame, "steer").x).toBeCloseTo(0.25, 12);
    const controller = frame.player(0)?.controller;
    expect(controller?.rx).toBeCloseTo(0.25, 12);
    expect(controller?.triggers.rt).toBeCloseTo(0.2, 12);
    expect(controller?.triggers.lt).toBe(0);
  });

  test("[ER-10-10] a phone keeps its view identity and synthesized views have no tilt", () => {
    const router = createInputRouter({ slots: 2 });
    router.applyPhoneSample(
      0,
      phoneSample({ slot: 0, tick: 1, lx: 0.5 }),
      0,
    );
    router.setTilt(0, { angleX: 7, angleY: -2, available: true });
    router.setKeyboardKey("Space", true);

    const first = router.poll(0);
    const phone = first.player(0)?.controller;
    expect(first.player(0)?.device).toBe("phone");
    expect(phone?.lx).toBe(0.5);
    expect(phone?.tilt).toEqual({ angleX: 7, angleY: -2, available: true });

    const synthesized = first.player(1)?.controller;
    expect(first.player(1)?.device).toBe("keyboard");
    expect(synthesized?.connected).toBe(true);
    expect(synthesized?.buttons).toBe(0b1);
    expect(synthesized).not.toHaveProperty("tilt");

    router.applyPhoneSample(
      0,
      phoneSample({ slot: 0, tick: 2, lx: -0.25 }),
      1,
    );
    const second = router.poll(1);
    expect(second.player(0)?.controller).toBe(phone);
    expect(second.player(0)?.controller.lx).toBe(-0.25);
  });
});
