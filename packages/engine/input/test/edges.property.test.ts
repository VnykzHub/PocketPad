/**
 * ER-10-02 — edge accumulation and clearing.
 *
 * A tap that begins and ends between two polls still delivers one press and
 * one release edge on the next poll. Edge masks are 16-bit: bit 0 is the
 * action aggregate and bit `i + 1` is binding `i`. Edges clear exactly once,
 * in the poll that consumed them. A held key emits a single press edge.
 */

import * as fc from "fast-check";
import { describe, expect, test } from "vitest";
import { KeyboardState, createInputRouter } from "../src/index.js";
import type { ActionState, InputFrame } from "../src/index.js";

function stateOf(frame: InputFrame, name: string): ActionState {
  const state = frame.action(name);
  if (state === undefined) throw new Error(`unknown action ${name}`);
  return state;
}

const KEY_CODES = ["KeyA", "KeyB", "KeyC", "KeyD"] as const;

describe("edge accumulation", () => {
  test("[ER-10-02] a sub-tick tap emits one press and one release edge", () => {
    const router = createInputRouter();
    router.setKeyboardKey("Space", true);
    router.setKeyboardKey("Space", false);

    const frame = router.poll(0);
    const primary = stateOf(frame, "primary");
    expect(primary.pressed).toBe(false);
    expect(primary.value).toBe(0);
    expect(primary.edges).toBe(3);
    expect(primary.releaseEdges).toBe(3);

    const next = router.poll(1);
    expect(stateOf(next, "primary").edges).toBe(0);
    expect(stateOf(next, "primary").releaseEdges).toBe(0);
  });

  test("[ER-10-02] a tap held across three ticks is not duplicated", () => {
    const router = createInputRouter();
    router.setKeyboardKey("Space", true);

    const first = stateOf(router.poll(0), "primary");
    expect(first.pressed).toBe(true);
    expect(first.edges).toBe(3);
    const second = stateOf(router.poll(1), "primary");
    expect(second.pressed).toBe(true);
    expect(second.edges).toBe(0);
    const third = stateOf(router.poll(2), "primary");
    expect(third.pressed).toBe(true);
    expect(third.edges).toBe(0);

    router.setKeyboardKey("Space", false);
    const released = stateOf(router.poll(3), "primary");
    expect(released.pressed).toBe(false);
    expect(released.edges).toBe(0);
    expect(released.releaseEdges).toBe(3);

    const idle = stateOf(router.poll(4), "primary");
    expect(idle.edges).toBe(0);
    expect(idle.releaseEdges).toBe(0);
  });

  test("[ER-10-02] bindings pressed in one tick OR their edge bits", () => {
    const router = createInputRouter();
    router.setKeyboardKey("Space", true);
    router.setKeyboardKey("Enter", true);

    const pressed = stateOf(router.poll(0), "primary");
    expect(pressed.pressed).toBe(true);
    expect(pressed.edges).toBe(7);
    expect(stateOf(router.poll(1), "primary").edges).toBe(0);

    router.setKeyboardKey("Space", false);
    router.setKeyboardKey("Enter", false);
    const released = stateOf(router.poll(2), "primary");
    expect(released.pressed).toBe(false);
    expect(released.edges).toBe(0);
    expect(released.releaseEdges).toBe(7);
  });

  test("[ER-10-02] auto-repeat keydowns never produce an edge", () => {
    const router = createInputRouter();
    router.setKeyboardKey("Space", true, true);
    const ignored = stateOf(router.poll(0), "primary");
    expect(ignored.pressed).toBe(false);
    expect(ignored.edges).toBe(0);

    router.setKeyboardKey("Space", true);
    const pressed = stateOf(router.poll(1), "primary");
    expect(pressed.pressed).toBe(true);
    expect(pressed.edges).toBe(3);
  });

  test("[ER-10-02] a stray keyup emits no edge", () => {
    const router = createInputRouter();
    router.setKeyboardKey("Space", false);
    const frame = stateOf(router.poll(0), "primary");
    expect(frame.released).toBe(true);
    expect(frame.edges).toBe(0);
    expect(frame.releaseEdges).toBe(0);
  });

  test(
    "[ER-10-02] 10,000 random press/release traces preserve the multiset of taps",
    () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.array(fc.tuple(fc.integer({ min: 0, max: 3 }), fc.boolean()), {
              maxLength: 4,
            }),
            { minLength: 1, maxLength: 40 },
          ),
          (ticks) => {
            const keyboard = new KeyboardState();
            const held = [false, false, false, false];
            let modelPresses = 0;
            let modelReleases = 0;
            let observedPresses = 0;
            let observedReleases = 0;

            for (const rawEvents of ticks) {
              // At most one event per key per tick: a key can only make one
              // level transition between two polls.
              const seen = new Set<number>();
              const expectedPress = [false, false, false, false];
              const expectedRelease = [false, false, false, false];

              for (const event of rawEvents) {
                const index = event[0];
                const wantsDown = event[1];
                if (seen.has(index)) continue;
                seen.add(index);
                const code = KEY_CODES[index] ?? "KeyA";
                const wasHeld = held[index] === true;
                if (wantsDown && !wasHeld) {
                  held[index] = true;
                  expectedPress[index] = true;
                  modelPresses += 1;
                  expect(keyboard.keyDown(code)).toBe(true);
                } else if (!wantsDown && wasHeld) {
                  held[index] = false;
                  expectedRelease[index] = true;
                  modelReleases += 1;
                  expect(keyboard.keyUp(code)).toBe(true);
                } else if (wantsDown) {
                  // Hardware auto-repeat while held: ignored by the device.
                  expect(keyboard.keyDown(code, true)).toBe(false);
                } else {
                  // A keyup for a key that is not held: ignored.
                  expect(keyboard.keyUp(code)).toBe(false);
                }
              }

              for (let index = 0; index < 4; index += 1) {
                const id = keyboard.idOf(KEY_CODES[index] ?? "KeyA");
                expect(keyboard.isPressPending(id)).toBe(expectedPress[index]);
                expect(keyboard.isReleasePending(id)).toBe(expectedRelease[index]);
                if (keyboard.isPressPending(id)) observedPresses += 1;
                if (keyboard.isReleasePending(id)) observedReleases += 1;
              }
              keyboard.clearPending();
            }

            expect(observedPresses).toBe(modelPresses);
            expect(observedReleases).toBe(modelReleases);
            for (let index = 0; index < 4; index += 1) {
              expect(held[index]).toBe(
                keyboard.isDown(keyboard.idOf(KEY_CODES[index] ?? "KeyA")),
              );
            }
          },
        ),
        { numRuns: 10_000 },
      );
    },
    30_000,
  );
});
