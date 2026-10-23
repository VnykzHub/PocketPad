/**
 * ER-10-15 — pointer semantics.
 *
 * Motion and wheel deltas accumulate between polls and clear once consumed.
 * Buttons produce one edge per press; leaving the target keeps a held button
 * until pointerup/blur. Pointer lock freezes the absolute position but keeps
 * accumulated motion. Pointer capture is requested on down and released on
 * up, and a captured down is consumed rather than applied.
 */

import { describe, expect, test } from "vitest";
import { createInputRouter } from "../src/index.js";
import type { ActionState, InputAction, InputFrame } from "../src/index.js";
import { FakeTarget, elementTarget, pointerSnapshot } from "./support.js";

const POINTER_ACTIONS: InputAction[] = [
  { name: "click", kind: "button", bindings: [{ device: "pointer", button: 0 }] },
  { name: "motionx", kind: "axis", bindings: [{ device: "pointer", axis: "dx" }] },
  { name: "motiony", kind: "axis", bindings: [{ device: "pointer", axis: "dy" }] },
  { name: "wheel", kind: "axis", bindings: [{ device: "pointer", axis: "wheel" }] },
  { name: "absx", kind: "axis", bindings: [{ device: "pointer", axis: "x" }] },
  { name: "absy", kind: "axis", bindings: [{ device: "pointer", axis: "y" }] },
];

function stateOf(frame: InputFrame, name: string): ActionState {
  const state = frame.action(name);
  if (state === undefined) throw new Error(`unknown action ${name}`);
  return state;
}

interface RouterOptions {
  readonly capturePointer?: boolean;
  readonly preventContextMenu?: boolean;
}

function makePointerRouter(options: RouterOptions = {}) {
  const target = new FakeTarget();
  const router = createInputRouter({
    actions: POINTER_ACTIONS,
    target: elementTarget(target),
    ...(options.capturePointer !== undefined
      ? { capturePointer: options.capturePointer }
      : {}),
    ...(options.preventContextMenu !== undefined
      ? { preventContextMenu: options.preventContextMenu }
      : {}),
  });
  router.attach();
  return { target, router };
}

describe("pointer accumulation", () => {
  test("[ER-10-15] three sub-tick moves accumulate to the exact dx/dy sum", () => {
    const { target, router } = makePointerRouter();
    target.dispatch("pointermove", { movementX: 10, movementY: 4 });
    target.dispatch("pointermove", { movementX: 30, movementY: -6 });
    target.dispatch("pointermove", { movementX: 20, movementY: 2 });

    const frame = router.poll(0);
    expect(frame.pointer.dx).toBe(60);
    expect(frame.pointer.dy).toBe(0);
    expect(stateOf(frame, "motionx").x).toBeCloseTo(0.6, 12);
    expect(stateOf(frame, "motionx").pressed).toBe(true);
    expect(stateOf(frame, "motiony").x).toBeCloseTo(0, 12);

    const next = router.poll(1);
    expect(next.pointer.dx).toBe(0);
    expect(stateOf(next, "motionx").x).toBe(0);
    expect(stateOf(next, "motionx").edges).toBe(0);
  });

  test("[ER-10-15] wheel deltas accumulate, normalize by mode and clear", () => {
    const { target, router } = makePointerRouter();
    target.dispatch("wheel", { deltaY: 20, deltaMode: 0 });
    target.dispatch("wheel", { deltaY: 2, deltaMode: 1 });
    const pixel = router.poll(0);
    expect(pixel.pointer.wheel).toBe(52);
    expect(stateOf(pixel, "wheel").x).toBeCloseTo(0.52, 12);

    expect(stateOf(router.poll(1), "wheel").x).toBe(0);

    target.dispatch("wheel", { deltaY: 1, deltaMode: 2 });
    const page = router.poll(2);
    expect(page.pointer.wheel).toBe(100);
    expect(stateOf(page, "wheel").x).toBeCloseTo(1, 12);
  });

  test("[ER-10-15] absolute axes normalize against the element bounds", () => {
    const { target, router } = makePointerRouter();
    target.dispatch("pointermove", { clientX: 600, clientY: 150 });

    const frame = router.poll(0);
    expect(stateOf(frame, "absx").x).toBeCloseTo(0.5, 12);
    expect(stateOf(frame, "absy").x).toBeCloseTo(-0.5, 12);
    expect(frame.pointer.x).toBe(600);
    expect(frame.pointer.y).toBe(150);
  });
});

describe("pointer buttons", () => {
  test("[ER-10-15] a press emits one edge and a release one release edge", () => {
    const { target, router } = makePointerRouter();
    target.dispatch("pointerdown", { button: 0, pointerId: 3 });
    target.dispatch("pointerdown", { button: 0, pointerId: 3 });

    const pressed = stateOf(router.poll(0), "click");
    expect(pressed.pressed).toBe(true);
    expect(pressed.value).toBe(1);
    expect(pressed.edges).toBe(3);

    target.dispatch("pointerdown", { button: 2, pointerId: 3 });
    const both = router.poll(1);
    expect(both.pointer.buttons).toBe(5);
    expect(stateOf(both, "click").edges).toBe(0);
    expect(stateOf(both, "click").pressed).toBe(true);

    target.dispatch("pointerup", { button: 0, pointerId: 3 });
    const released = stateOf(router.poll(2), "click");
    expect(released.pressed).toBe(false);
    expect(released.releaseEdges).toBe(3);
  });

  test("[ER-10-15] leaving the target keeps a held button until pointerup", () => {
    const { target, router } = makePointerRouter();
    target.dispatch("pointerdown", { button: 0, pointerId: 3 });
    target.dispatch("pointerleave");

    const held = router.poll(0);
    expect(held.pointer.inside).toBe(false);
    expect(stateOf(held, "click").pressed).toBe(true);

    target.dispatch("pointerup", { button: 0, pointerId: 3 });
    const released = stateOf(router.poll(1), "click");
    expect(released.pressed).toBe(false);
    expect(released.releaseEdges).toBe(3);
  });

  test("[ER-10-15] blur releases held buttons exactly once", () => {
    const { target, router } = makePointerRouter();
    target.dispatch("pointerdown", { button: 0, pointerId: 3 });
    expect(stateOf(router.poll(0), "click").pressed).toBe(true);

    router.setFocused(false);
    const released = stateOf(router.poll(1), "click");
    expect(released.pressed).toBe(false);
    expect(released.releaseEdges).toBe(3);

    const again = stateOf(router.poll(2), "click");
    expect(again.releaseEdges).toBe(0);
    expect(again.edges).toBe(0);
  });

  test("[ER-10-15] pointer lock freezes x/y but keeps accumulated motion", () => {
    const { target, router } = makePointerRouter();
    target.dispatch("pointermove", { clientX: 400, clientY: 300 });
    const base = router.poll(0);
    expect(stateOf(base, "absx").x).toBeCloseTo(0, 12);
    expect(stateOf(base, "absy").x).toBeCloseTo(0, 12);

    router.setPointerLocked(true);
    target.dispatch("pointermove", {
      movementX: 25,
      movementY: 10,
      clientX: 700,
      clientY: 500,
    });
    const locked = router.poll(1);
    expect(locked.pointer.locked).toBe(true);
    expect(locked.focus.pointerLocked).toBe(true);
    expect(locked.pointer.x).toBe(400);
    expect(locked.pointer.y).toBe(300);
    expect(stateOf(locked, "absx").x).toBeCloseTo(0, 12);
    expect(stateOf(locked, "motionx").x).toBeCloseTo(0.25, 12);
    expect(stateOf(locked, "motiony").x).toBeCloseTo(0.1, 12);

    router.setPointerLocked(false);
    const unlocked = router.poll(2);
    expect(unlocked.pointer.locked).toBe(false);
    expect(unlocked.pointer.dx).toBe(0);
    expect(stateOf(unlocked, "motionx").x).toBe(0);
  });
});

describe("pointer capture and defaults", () => {
  test("[ER-10-15] pointer capture is requested on down and released on up", () => {
    const { target, router } = makePointerRouter();
    target.dispatch("pointerdown", { button: 0, pointerId: 7 });
    expect(target.captured).toEqual([7]);
    target.dispatch("pointerup", { button: 0, pointerId: 7 });
    expect(target.released).toEqual([7]);
    router.poll(0);
  });

  test("[ER-10-15] capturePointer false disables the structural calls", () => {
    const { target } = makePointerRouter({ capturePointer: false });
    target.dispatch("pointerdown", { button: 0, pointerId: 7 });
    target.dispatch("pointerup", { button: 0, pointerId: 7 });
    expect(target.captured).toEqual([]);
    expect(target.released).toEqual([]);
  });

  test("[ER-10-15] a captured down is consumed and applies from the next poll", async () => {
    const { target, router } = makePointerRouter();
    const pending = router.beginCapture("click", 0, "pointer");
    target.dispatch("pointerdown", { button: 1, pointerId: 9 });
    const result = await pending;
    expect(result).toEqual({
      ok: true,
      action: "click",
      binding: 0,
      device: "pointer",
      code: "PointerButton1",
    });
    expect(router.map.actions[0]?.bindings[0]).toEqual({
      device: "pointer",
      button: 1,
    });
    expect(stateOf(router.poll(0), "click").pressed).toBe(false);

    router.setPointerSnapshot(pointerSnapshot({ buttons: 0b010, edges: 0b010 }));
    const applied = stateOf(router.poll(1), "click");
    expect(applied.pressed).toBe(true);
    expect(applied.edges).toBe(3);
  });

  test("[ER-10-15] bound keys prevent default scrolling, reserved keys do not", () => {
    const target = new FakeTarget();
    const router = createInputRouter({ target: elementTarget(target) });
    router.attach();

    expect(target.dispatch("keydown", { code: "Space" }).defaultPrevented).toBe(true);
    expect(target.dispatch("keydown", { code: "ArrowUp" }).defaultPrevented).toBe(true);
    expect(target.dispatch("keydown", { code: "KeyW" }).defaultPrevented).toBe(false);
    // Escape is reserved for the platform, so the page keeps its default.
    expect(target.dispatch("keydown", { code: "Escape" }).defaultPrevented).toBe(false);
    expect(target.dispatch("keydown", { code: "Tab" }).defaultPrevented).toBe(false);
  });

  test("[ER-10-15] contextmenu is prevented only when configured", () => {
    const off = makePointerRouter();
    expect(off.target.dispatch("contextmenu").defaultPrevented).toBe(false);

    const on = makePointerRouter({ preventContextMenu: true });
    expect(on.target.dispatch("contextmenu").defaultPrevented).toBe(true);
  });
});
