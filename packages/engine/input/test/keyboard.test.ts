/**
 * ER-10-01 / ER-10-02 — keyboard device semantics.
 *
 * Physical `code` strings register once into a 256-id table. A key level is
 * digital (exactly 0 or 1 after the deadzone), auto-repeat cannot press, a
 * stray keyup is ignored, and `releaseAll` (blur/detach) releases each held
 * key exactly once while dropping pending presses.
 */

import { describe, expect, test } from "vitest";
import {
  INPUT_KEY_ID_LIMIT,
  KeyboardState,
  createInputRouter,
} from "../src/index.js";
import type { ActionState, InputFrame } from "../src/index.js";

function stateOf(frame: InputFrame, name: string): ActionState {
  const state = frame.action(name);
  if (state === undefined) throw new Error(`unknown action ${name}`);
  return state;
}

describe("keyboard state", () => {
  test("[ER-10-01] a code keeps one stable id", () => {
    const keyboard = new KeyboardState();
    const first = keyboard.register("KeyW");
    const second = keyboard.register("KeyW");
    expect(first).toBe(second);
    expect(keyboard.idOf("KeyW")).toBe(first);
    expect(keyboard.idOf("KeyQ")).toBe(-1);
  });

  test("[ER-10-01] a held key drives a digital level", () => {
    const router = createInputRouter();
    router.setKeyboardKey("KeyW", true);
    const move = stateOf(router.poll(0), "move");
    expect(move.value).toBe(1);
    expect(move.y).toBe(1);
    expect(move.x).toBe(0);
    expect(move.pressed).toBe(true);
  });

  test("[ER-10-02] auto-repeat neither presses nor registers", () => {
    const keyboard = new KeyboardState();
    expect(keyboard.keyDown("KeyW", true)).toBe(false);
    expect(keyboard.idOf("KeyW")).toBe(-1);
    expect(keyboard.isPressPending(keyboard.idOf("KeyW"))).toBe(false);

    expect(keyboard.keyDown("KeyW", false)).toBe(true);
    expect(keyboard.keyDown("KeyW", true)).toBe(false);
    expect(keyboard.isPressPending(keyboard.idOf("KeyW"))).toBe(true);
  });

  test("[ER-10-02] a keyup without a keydown is ignored", () => {
    const keyboard = new KeyboardState();
    expect(keyboard.keyUp("KeyW")).toBe(false);
    expect(keyboard.idOf("KeyW")).toBe(-1);
    expect(keyboard.isReleasePending(-1)).toBe(false);
  });

  test("[ER-10-02] releaseAll releases held keys exactly once", () => {
    const keyboard = new KeyboardState();
    const a = keyboard.register("KeyA");
    const b = keyboard.register("KeyB");
    const c = keyboard.register("KeyC");
    keyboard.keyDown("KeyA");
    keyboard.keyDown("KeyB");
    keyboard.keyDown("KeyC");
    keyboard.keyUp("KeyC");

    keyboard.releaseAll();
    expect(keyboard.isDown(a)).toBe(false);
    expect(keyboard.isDown(b)).toBe(false);
    expect(keyboard.isReleasePending(a)).toBe(true);
    expect(keyboard.isReleasePending(b)).toBe(true);
    // The pending press of A and B is discarded, not converted.
    expect(keyboard.isPressPending(a)).toBe(false);
    expect(keyboard.isPressPending(b)).toBe(false);
    // C was tapped before the blur; its release edge already exists.
    expect(keyboard.isReleasePending(c)).toBe(true);

    keyboard.clearPending();
    keyboard.releaseAll();
    expect(keyboard.isReleasePending(a)).toBe(false);
    expect(keyboard.isReleasePending(b)).toBe(false);
  });

  test("[ER-10-02] the id table refuses codes past the 256-id cap", () => {
    const keyboard = new KeyboardState();
    for (let index = 0; index < INPUT_KEY_ID_LIMIT; index += 1) {
      expect(keyboard.register(`Key${index}`)).toBe(index);
    }
    expect(keyboard.register("KeyOverflow")).toBe(-1);
    expect(keyboard.unknownCodes).toBe(1);
    expect(keyboard.idOf("KeyOverflow")).toBe(-1);
    expect(keyboard.keyDown("KeyOverflow")).toBe(false);
    expect(keyboard.keyDown("Key0")).toBe(true);
    expect(keyboard.idOf("Key0")).toBe(0);
  });
});

describe("keyboard through the router", () => {
  test("[ER-10-02] a tap is consumed by exactly one poll", () => {
    const router = createInputRouter();
    router.setKeyboardKey("Space", true);
    router.setKeyboardKey("Space", false);

    const first = stateOf(router.poll(0), "primary");
    expect(first.edges).toBe(3);
    expect(first.releaseEdges).toBe(3);
    expect(first.pressed).toBe(false);
    const second = stateOf(router.poll(1), "primary");
    expect(second.edges).toBe(0);
    expect(second.releaseEdges).toBe(0);
  });

  test("[ER-10-02] reset drops held keys without a release edge", () => {
    const router = createInputRouter();
    router.setKeyboardKey("Space", true);
    expect(stateOf(router.poll(0), "primary").pressed).toBe(true);

    router.reset();
    const after = stateOf(router.poll(1), "primary");
    expect(after.pressed).toBe(false);
    expect(after.value).toBe(0);
    expect(after.edges).toBe(0);
    expect(after.releaseEdges).toBe(0);
  });
});
