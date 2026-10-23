/**
 * ER-10-09 — blur, visibility and pointer-lock suspension.
 *
 * Losing focus or hiding the document releases held keyboard and pointer
 * input exactly once, records `lastBlurTick`, and never resurrects input on
 * refocus. Gamepads are untouched by focus changes, and leaving pointer lock
 * releases held buttons and discards accumulated motion. `focus-changed` is
 * emitted only when the stored focus state actually changes.
 */

import { describe, expect, test } from "vitest";
import { createInputRouter } from "../src/index.js";
import type {
  ActionState,
  InputAction,
  InputDeviceEvent,
  InputFrame,
} from "../src/index.js";
import {
  FakeTarget,
  elementTarget,
  makeSnapshot,
  slotAction,
} from "./support.js";

const FOCUS_ACTIONS: InputAction[] = [
  {
    name: "jump",
    kind: "button",
    bindings: [{ device: "keyboard", code: "Space" }],
  },
  {
    name: "click",
    kind: "button",
    bindings: [{ device: "pointer", button: 0 }],
  },
  {
    name: "motionx",
    kind: "axis",
    bindings: [{ device: "pointer", axis: "dx" }],
  },
];

function actionNamed(frame: InputFrame, name: string): ActionState {
  const state = frame.action(name);
  if (state === undefined) throw new Error(`unknown action ${name}`);
  return state;
}

function attachRouter() {
  const target = new FakeTarget();
  const router = createInputRouter({
    actions: FOCUS_ACTIONS,
    target: elementTarget(target),
  });
  router.attach();
  return { target, router };
}

describe("blur and refocus", () => {
  test("[ER-10-09] blur releases held keyboard keys exactly once", () => {
    const router = createInputRouter({ actions: FOCUS_ACTIONS });
    router.setKeyboardKey("Space", true);
    expect(actionNamed(router.poll(0), "jump").pressed).toBe(true);

    router.setFocused(false);
    const blurred = router.poll(1);
    expect(blurred.focus.focused).toBe(false);
    expect(blurred.focus.lastBlurTick).toBe(0);
    const released = actionNamed(blurred, "jump");
    expect(released.pressed).toBe(false);
    expect(released.releaseEdges).toBe(3);

    const again = router.poll(2);
    expect(actionNamed(again, "jump").releaseEdges).toBe(0);
    expect(actionNamed(again, "jump").edges).toBe(0);
  });

  test("[ER-10-09] refocus does not resurrect a released key", () => {
    const router = createInputRouter({ actions: FOCUS_ACTIONS });
    router.setKeyboardKey("Space", true);
    router.poll(0);
    router.setFocused(false);
    router.poll(1);

    router.setFocused(true);
    const refocused = router.poll(2);
    expect(refocused.focus.focused).toBe(true);
    expect(actionNamed(refocused, "jump").pressed).toBe(false);
    expect(actionNamed(refocused, "jump").releaseEdges).toBe(0);

    router.setKeyboardKey("Space", true);
    const pressed = actionNamed(router.poll(3), "jump");
    expect(pressed.pressed).toBe(true);
    expect(pressed.edges).toBe(3);
  });

  test("[ER-10-09] a hidden document releases keyboard and pointer input", () => {
    const { router, target } = attachRouter();
    router.setKeyboardKey("Space", true);
    target.dispatch("pointerdown", { button: 0, pointerId: 1 });

    const held = router.poll(0);
    expect(actionNamed(held, "jump").pressed).toBe(true);
    expect(actionNamed(held, "click").pressed).toBe(true);

    router.setVisible(false);
    const hidden = router.poll(1);
    expect(hidden.focus.visible).toBe(false);
    expect(hidden.focus.focused).toBe(true);
    expect(hidden.focus.lastBlurTick).toBe(0);
    for (const name of ["jump", "click"]) {
      const state = actionNamed(hidden, name);
      expect(state.pressed).toBe(false);
      expect(state.releaseEdges).toBe(3);
    }
    expect(actionNamed(router.poll(2), "click").releaseEdges).toBe(0);

    router.setVisible(true);
    const shown = router.poll(3);
    expect(shown.focus.visible).toBe(true);
    expect(actionNamed(shown, "jump").pressed).toBe(false);
  });

  test("[ER-10-09] gamepad input survives a blur", () => {
    const router = createInputRouter({
      slots: 2,
      fixed: { gamepads: { 0: 1 } },
    });
    router.setKeyboardKey("Space", true);
    router.setGamepadSnapshot(makeSnapshot(0, { buttons: [0], edges: 1 }));
    const held = router.poll(0);
    expect(slotAction(held, router.map, 0, "primary")?.pressed).toBe(true);
    expect(slotAction(held, router.map, 1, "primary")?.pressed).toBe(true);

    router.setFocused(false);
    const blurred = router.poll(1);
    expect(blurred.player(1)?.device).toBe("gamepad");
    const keyboard = slotAction(blurred, router.map, 0, "primary");
    expect(keyboard?.pressed).toBe(false);
    expect(keyboard?.releaseEdges).toBe(3);
    const pad = slotAction(blurred, router.map, 1, "primary");
    expect(pad?.pressed).toBe(true);
    expect(pad?.edges).toBe(0);
    expect(pad?.releaseEdges).toBe(0);
  });
});

describe("pointer lock and focus events", () => {
  test("[ER-10-09] leaving pointer lock releases held buttons and motion", () => {
    const { router, target } = attachRouter();
    target.dispatch("pointerdown", { button: 0, pointerId: 1 });
    target.dispatch("pointermove", { movementX: 30 });
    const held = router.poll(0);
    expect(actionNamed(held, "click").pressed).toBe(true);
    expect(actionNamed(held, "motionx").x).toBeCloseTo(0.3, 12);

    router.setPointerLocked(true);
    target.dispatch("pointermove", { movementX: 12 });
    const locked = router.poll(1);
    expect(locked.focus.pointerLocked).toBe(true);
    expect(actionNamed(locked, "click").pressed).toBe(true);
    expect(actionNamed(locked, "motionx").x).toBeCloseTo(0.12, 12);

    router.setPointerLocked(false);
    const unlocked = router.poll(2);
    expect(unlocked.focus.pointerLocked).toBe(false);
    expect(unlocked.pointer.locked).toBe(false);
    const released = actionNamed(unlocked, "click");
    expect(released.pressed).toBe(false);
    expect(released.releaseEdges).toBe(3);
    expect(unlocked.pointer.dx).toBe(0);
    expect(actionNamed(unlocked, "motionx").x).toBe(0);
  });

  test("[ER-10-09] focus-changed is emitted once per actual change", () => {
    const router = createInputRouter();
    const events: InputDeviceEvent[] = [];
    router.subscribe((event) => events.push(event));
    const focusEvents = () =>
      events.filter((event) => event.type === "focus-changed");

    router.setFocused(false);
    expect(focusEvents()).toEqual([{ type: "focus-changed", focused: false }]);
    router.setFocused(false);
    expect(focusEvents()).toHaveLength(1);

    router.setFocused(true);
    expect(focusEvents()).toHaveLength(2);
    expect(focusEvents()[1]).toEqual({ type: "focus-changed", focused: true });

    router.setVisible(false);
    router.setVisible(false);
    router.setVisible(true);
    const sequences = focusEvents().map((event) =>
      event.type === "focus-changed" ? event.focused : null,
    );
    expect(sequences).toEqual([false, true, true, true]);
  });
});
