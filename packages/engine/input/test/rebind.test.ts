/**
 * ER-10-08 — rebinding capture, conflicts and persistence.
 *
 * Capture is device-scoped and asynchronous: the completing event is consumed
 * and the new binding applies from the next poll. Escape always cancels;
 * reserved codes refuse; a capture that is already pending is busy. Under the
 * replace policy a stolen binding is removed from the other action unless
 * that would leave it empty. Stores are host-owned and failures are counted.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  bindingCode,
  buildGamepadAxisBinding,
  buildKeyboardBinding,
  buildPointerButtonBinding,
  buildPointerWheelBinding,
  createInputRouter,
} from "../src/index.js";
import type {
  ActionState,
  BindingOverlay,
  InputAction,
  InputBinding,
  InputDeviceEvent,
  InputFrame,
} from "../src/index.js";
import { makeSnapshot } from "./support.js";

afterEach(() => {
  vi.useRealTimers();
});

function stateOf(frame: InputFrame, name: string): ActionState {
  const state = frame.action(name);
  if (state === undefined) throw new Error(`unknown action ${name}`);
  return state;
}

function firstBinding(
  router: ReturnType<typeof createInputRouter>,
  action: string,
): InputBinding | undefined {
  return router.map.actions[router.map.indexOf(action)]?.bindings[0];
}

describe("keyboard capture", () => {
  test("[ER-10-08] a captured key replaces the binding and applies next poll", async () => {
    const router = createInputRouter();
    const pending = router.beginCapture("primary", 0, "keyboard");
    router.setKeyboardKey("KeyF", true);

    const result = await pending;
    expect(result).toEqual({
      ok: true,
      action: "primary",
      binding: 0,
      device: "keyboard",
      code: "KeyF",
    });
    expect(firstBinding(router, "primary")).toEqual({
      device: "keyboard",
      code: "KeyF",
    });

    // The completing keydown was consumed, not applied as a press.
    expect(stateOf(router.poll(0), "primary").pressed).toBe(false);
    router.setKeyboardKey("KeyF", true);
    const pressed = stateOf(router.poll(1), "primary");
    expect(pressed.pressed).toBe(true);
    expect(pressed.edges).toBe(3);
  });

  test("[ER-10-08] Escape cancels and reserved codes refuse without changing the map", async () => {
    const router = createInputRouter();

    const f5 = router.beginCapture("primary", 0, "keyboard");
    router.setKeyboardKey("F5", true);
    expect(await f5).toEqual({ ok: false, reason: "reserved" });
    expect(firstBinding(router, "primary")).toEqual({
      device: "keyboard",
      code: "Space",
    });

    const tab = router.beginCapture("primary", 0, "keyboard");
    router.setKeyboardKey("Tab", true);
    expect(await tab).toEqual({ ok: false, reason: "reserved" });

    const escape = router.beginCapture("primary", 0, "keyboard");
    router.setKeyboardKey("Escape", true);
    expect(await escape).toEqual({ ok: false, reason: "cancelled" });

    const manual = router.beginCapture("primary", 0, "keyboard");
    router.cancelCapture();
    expect(await manual).toEqual({ ok: false, reason: "cancelled" });
    expect(router.capturing).toBe(false);
  });

  test("[ER-10-08] capture completion is emitted once as a device event", async () => {
    const router = createInputRouter();
    const events: InputDeviceEvent[] = [];
    router.subscribe((event) => events.push(event));

    const pending = router.beginCapture("primary", 0, "keyboard");
    router.setKeyboardKey("KeyF", true);
    const result = await pending;
    const captures = events.filter((event) => event.type === "capture");
    expect(captures).toHaveLength(1);
    expect(captures[0]).toEqual({ type: "capture", result });
  });

  test("[ER-10-08] starting a capture releases keys held before it", async () => {
    const router = createInputRouter();
    router.setKeyboardKey("KeyW", true);
    expect(stateOf(router.poll(0), "move").pressed).toBe(true);

    const pending = router.beginCapture("primary", 0, "keyboard");
    expect(stateOf(router.poll(1), "move").pressed).toBe(false);
    router.cancelCapture();
    expect(await pending).toEqual({ ok: false, reason: "cancelled" });
    expect(stateOf(router.poll(2), "move").pressed).toBe(false);

    router.setKeyboardKey("KeyW", true);
    expect(stateOf(router.poll(3), "move").pressed).toBe(true);
  });
});

describe("capture lifecycle", () => {
  test("[ER-10-08] invalid requests are unsupported and a second capture is busy", async () => {
    const router = createInputRouter();
    expect(await router.beginCapture("nope", 0, "keyboard")).toEqual({
      ok: false,
      reason: "unsupported",
    });
    expect(await router.beginCapture("primary", 99, "keyboard")).toEqual({
      ok: false,
      reason: "unsupported",
    });
    expect(await router.beginCapture("primary", 0, "keyboard", -1)).toEqual({
      ok: false,
      reason: "unsupported",
    });
    expect(await router.beginCapture("primary", 0, "phone")).toEqual({
      ok: false,
      reason: "unsupported",
    });

    const first = router.beginCapture("primary", 0, "keyboard");
    expect(await router.beginCapture("secondary", 0, "keyboard")).toEqual({
      ok: false,
      reason: "busy",
    });
    router.cancelCapture();
    expect(await first).toEqual({ ok: false, reason: "cancelled" });
  });

  test("[ER-10-08] a capture times out, is counted and stops capturing", async () => {
    vi.useFakeTimers();
    const router = createInputRouter();
    const pending = router.beginCapture("primary", 0, "keyboard", 500);
    vi.advanceTimersByTime(500);
    expect(await pending).toEqual({ ok: false, reason: "timeout" });
    expect(router.stats.captureTimeouts).toBe(1);
    expect(router.capturing).toBe(false);
  });

  test("[ER-10-08] a captured gamepad axis resolves after the poll that saw it", async () => {
    const router = createInputRouter({
      slots: 1,
      fixed: { gamepads: { 0: 0 } },
    });
    const pending = router.beginCapture("primary", 0, "gamepad");
    router.setGamepadSnapshot(makeSnapshot(0, { axes: [0, 0.7, 0, 0] }));
    expect(router.capturing).toBe(true);

    router.poll(0);
    expect(router.capturing).toBe(false);
    expect(await pending).toEqual({
      ok: true,
      action: "primary",
      binding: 0,
      device: "gamepad",
      code: "GamepadAxis1",
    });
    expect(firstBinding(router, "primary")).toEqual({
      device: "gamepad",
      pad: "self",
      axis: 1,
      scale: 1,
    });
  });
});

describe("binding conflicts", () => {
  test("[ER-10-08] replace steals a shared key from another action", async () => {
    const router = createInputRouter();
    const pending = router.beginCapture("primary", 0, "keyboard");
    router.setKeyboardKey("KeyE", true);

    expect(await pending).toEqual({
      ok: true,
      action: "primary",
      binding: 0,
      device: "keyboard",
      code: "KeyE",
    });
    expect(router.stats.conflicts).toBe(1);
    expect(
      router.map.actions[router.map.indexOf("interact")]?.bindings,
    ).toEqual([{ device: "gamepad", pad: "self", button: 2 }]);

    router.setKeyboardKey("KeyE", true);
    const frame = router.poll(0);
    expect(stateOf(frame, "primary").pressed).toBe(true);
    expect(stateOf(frame, "interact").pressed).toBe(false);
  });

  test("[ER-10-08] reject leaves both actions untouched", async () => {
    const router = createInputRouter({ conflictPolicy: "reject" });
    const pending = router.beginCapture("primary", 0, "keyboard");
    router.setKeyboardKey("KeyE", true);

    expect(await pending).toEqual({
      ok: false,
      reason: "conflict",
      conflict: { action: "interact", binding: 0 },
    });
    expect(router.stats.conflicts).toBe(0);
    expect(firstBinding(router, "primary")).toEqual({
      device: "keyboard",
      code: "Space",
    });
    expect(
      router.map.actions[router.map.indexOf("interact")]?.bindings,
    ).toEqual([
      { device: "keyboard", code: "KeyE" },
      { device: "gamepad", pad: "self", button: 2 },
    ]);
  });

  test("[ER-10-08] replace refuses to empty an action with a single binding", async () => {
    const actions: InputAction[] = [
      {
        name: "jump",
        kind: "button",
        bindings: [{ device: "keyboard", code: "Space" }],
      },
      {
        name: "dash",
        kind: "button",
        bindings: [{ device: "keyboard", code: "ShiftLeft" }],
      },
    ];
    const router = createInputRouter({ actions });
    const pending = router.beginCapture("jump", 0, "keyboard");
    router.setKeyboardKey("ShiftLeft", true);

    expect(await pending).toEqual({
      ok: false,
      reason: "conflict",
      conflict: { action: "dash", binding: 0 },
    });
    expect(firstBinding(router, "jump")).toEqual({
      device: "keyboard",
      code: "Space",
    });
  });
});

describe("binding persistence", () => {
  test("[ER-10-08] saved overlays reload into an equivalent router", async () => {
    const saved: BindingOverlay[] = [];
    const router = createInputRouter({
      store: {
        save: async (overlay) => {
          saved.push(overlay);
        },
      },
    });
    const pending = router.beginCapture("primary", 0, "keyboard");
    router.setKeyboardKey("KeyF", true);
    await pending;
    await router.saveBindings();

    const overlay = saved[0];
    if (overlay === undefined) throw new Error("overlay was not saved");
    expect(overlay["primary"]?.[0]).toEqual({
      device: "keyboard",
      code: "KeyF",
    });

    const reloaded = createInputRouter({ bindings: overlay });
    expect(firstBinding(reloaded, "primary")).toEqual({
      device: "keyboard",
      code: "KeyF",
    });
  });

  test("[ER-10-08] a failing store is counted, never thrown or rolled back", async () => {
    const router = createInputRouter({
      store: {
        save: async () => {
          throw new Error("disk full");
        },
      },
    });
    const pending = router.beginCapture("primary", 0, "keyboard");
    router.setKeyboardKey("KeyF", true);
    await pending;
    await expect(router.saveBindings()).resolves.toBeUndefined();
    expect(router.stats.storeErrors).toBe(1);
    expect(firstBinding(router, "primary")).toEqual({
      device: "keyboard",
      code: "KeyF",
    });

    // No store: saving is a no-op.
    await expect(createInputRouter().saveBindings()).resolves.toBeUndefined();
  });
});

describe("binding helpers", () => {
  test("[ER-10-08] device builders preserve same-device component and scale", () => {
    const oldKeyboard: InputBinding = {
      device: "keyboard",
      code: "KeyW",
      component: "y",
      scale: -1,
    };
    expect(buildKeyboardBinding("KeyQ", oldKeyboard, "vector2")).toEqual({
      device: "keyboard",
      code: "KeyQ",
      component: "y",
      scale: -1,
    });
    const oldPad: InputBinding = {
      device: "gamepad",
      pad: 0,
      button: 0,
      component: "x",
      scale: 2,
    };
    expect(buildKeyboardBinding("KeyQ", oldPad, "vector2")).toEqual({
      device: "keyboard",
      code: "KeyQ",
      component: "x",
    });

    const oldPointer: InputBinding = {
      device: "pointer",
      button: 0,
      scale: 2,
    };
    expect(buildPointerButtonBinding(2, oldPointer, "axis")).toEqual({
      device: "pointer",
      button: 2,
      scale: 2,
    });
    expect(buildPointerWheelBinding(oldPointer, "vector2")).toEqual({
      device: "pointer",
      axis: "wheel",
      component: "x",
      scale: 2,
    });
  });

  test("[ER-10-08] gamepad axis builder derives parity and sign, keeping old component", () => {
    expect(buildGamepadAxisBinding(3, -0.8, undefined, "vector2")).toEqual({
      device: "gamepad",
      pad: "self",
      axis: 3,
      component: "y",
      scale: -1,
    });
    expect(buildGamepadAxisBinding(2, 0.4, undefined, "vector2")).toEqual({
      device: "gamepad",
      pad: "self",
      axis: 2,
      component: "x",
      scale: 1,
    });
    const oldAxis: InputBinding = {
      device: "gamepad",
      pad: 1,
      axis: 0,
      component: "x",
    };
    expect(buildGamepadAxisBinding(1, -0.8, oldAxis, "vector2")).toEqual({
      device: "gamepad",
      pad: 1,
      axis: 1,
      component: "x",
      scale: -1,
    });
    expect(buildGamepadAxisBinding(1, 0.7, undefined, "button")).toEqual({
      device: "gamepad",
      pad: "self",
      axis: 1,
      scale: 1,
    });
  });

  test("[ER-10-08] diagnostic binding codes are stable", () => {
    expect(bindingCode({ device: "keyboard", code: "KeyQ" })).toBe("KeyQ");
    expect(bindingCode({ device: "pointer", button: 2 })).toBe("PointerButton2");
    expect(bindingCode({ device: "pointer", axis: "wheel" })).toBe(
      "PointerAxiswheel",
    );
    expect(
      bindingCode({ device: "gamepad", pad: "self", button: 5 }),
    ).toBe("GamepadButton5");
    expect(
      bindingCode({ device: "gamepad", pad: "self", axis: 1 }),
    ).toBe("GamepadAxis1");
    expect(
      bindingCode({ device: "phone", slot: 0, channel: "button", bit: 1 }),
    ).toBe("");
  });
});
