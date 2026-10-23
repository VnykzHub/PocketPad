/**
 * ER-10-06 — gamepad semantics.
 *
 * Idle pads are scanned once per second; a present pad is refreshed every
 * poll. A pad becomes assignable only after meaningful input, unless it is
 * pinned with `fixed.gamepads`. Standard mapping only: non-standard pads stay
 * diagnostic. Triggers 6/7 are analog. A disconnect releases held buttons
 * once; invalid snapshot indexes are counted, not applied.
 */

import { describe, expect, test } from "vitest";
import { createInputRouter } from "../src/index.js";
import type {
  GamepadReadout,
  InputAction,
  InputDeviceEvent,
  InputFrame,
} from "../src/index.js";
import {
  makeReadout,
  makeSnapshot,
  slotAction,
} from "./support.js";

describe("gamepad scanning", () => {
  test("[ER-10-06] idle pads scan at tick 0 then every 60 ticks, present pads every poll", () => {
    let calls = 0;
    let readouts: (GamepadReadout | null)[] = [];
    const events: InputDeviceEvent[] = [];
    const router = createInputRouter({
      createGamepads: () => {
        calls += 1;
        return readouts;
      },
    });
    router.subscribe((event) => events.push(event));

    router.poll(0);
    expect(calls).toBe(1);
    router.poll(1);
    router.poll(59);
    expect(calls).toBe(1);
    router.poll(60);
    expect(calls).toBe(2);
    router.poll(61);
    expect(calls).toBe(2);

    readouts = [makeReadout(0)];
    router.poll(120);
    expect(calls).toBe(3);
    expect(
      events.some(
        (event) => event.type === "gamepad-connected" && event.index === 0,
      ),
    ).toBe(true);
    router.poll(121);
    expect(calls).toBe(4);
    router.poll(122);
    expect(calls).toBe(5);
  });
});

describe("gamepad meaningfulness", () => {
  test("[ER-10-06] an axis above 0.5 makes a pad assignable, 0.4 does not", () => {
    const router = createInputRouter();
    router.setGamepadSnapshot(makeSnapshot(0, { axes: [0.4, 0, 0, 0] }));
    const below = router.poll(0);
    expect(below.player(1)?.device).toBe("none");

    router.setGamepadSnapshot(makeSnapshot(0, { axes: [0.6, 0, 0, 0] }));
    const above = router.poll(1);
    expect(above.player(1)?.device).toBe("gamepad");
    const move = slotAction(above, router.map, 1, "move");
    expect(move?.x).toBeCloseTo(0.45 / 0.85, 12);
    expect(move?.pressed).toBe(true);
  });

  test("[ER-10-06] a button press marks the pad meaningful and keeps its edge bits", () => {
    const router = createInputRouter();
    router.setGamepadSnapshot(
      makeSnapshot(0, { buttons: [0], edges: 0b1 }),
    );
    const pressed = router.poll(0);
    expect(pressed.player(1)?.device).toBe("gamepad");
    const primary = slotAction(pressed, router.map, 1, "primary");
    expect(primary?.pressed).toBe(true);
    // Binding index 2 -> bit 3 (8), plus the aggregate bit (1).
    expect(primary?.edges).toBe(9);

    router.setGamepadSnapshot(makeSnapshot(0, { buttons: [0] }));
    expect(slotAction(router.poll(1), router.map, 1, "primary")?.edges).toBe(0);

    router.setGamepadSnapshot(makeSnapshot(0, { releaseEdges: 0b1 }));
    const released = slotAction(router.poll(2), router.map, 1, "primary");
    expect(released?.pressed).toBe(false);
    expect(released?.releaseEdges).toBe(9);
  });
});

describe("fixed pads and analog inputs", () => {
  test("[ER-10-06] a fixed pad owns its slot and emits one edge per press", () => {
    const router = createInputRouter({
      slots: 2,
      fixed: { gamepads: { 0: 0 } },
    });
    router.setGamepadSnapshot(makeSnapshot(0, { buttons: [0], edges: 0b1 }));
    const pressedFrame = router.poll(0);
    expect(pressedFrame.player(0)?.device).toBe("gamepad");
    expect(pressedFrame.player(1)?.device).toBe("keyboard");
    const pressed = slotAction(pressedFrame, router.map, 0, "primary");
    expect(pressed?.pressed).toBe(true);
    expect(pressed?.edges).toBe(9);

    router.setGamepadSnapshot(makeSnapshot(0, { buttons: [0] }));
    const held = slotAction(router.poll(1), router.map, 0, "primary");
    expect(held?.pressed).toBe(true);
    expect(held?.edges).toBe(0);

    router.setGamepadSnapshot(makeSnapshot(0, { releaseEdges: 0b1 }));
    const released = slotAction(router.poll(2), router.map, 0, "primary");
    expect(released?.pressed).toBe(false);
    expect(released?.releaseEdges).toBe(9);
  });

  test("[ER-10-06] trigger buttons 6/7 are analog through the trigger deadzone", () => {
    const actions: InputAction[] = [
      {
        name: "throttle",
        kind: "button",
        bindings: [{ device: "gamepad", pad: "self", button: 7 }],
      },
    ];
    const router = createInputRouter({
      slots: 1,
      actions,
      fixed: { gamepads: { 0: 0 } },
    });
    router.setGamepadSnapshot(makeSnapshot(0, { buttons: [7], rt: 0.8 }));
    const throttle = slotAction(router.poll(0), router.map, 0, "throttle");
    expect(throttle?.value).toBeCloseTo(0.75 / 0.95, 12);
    expect(throttle?.pressed).toBe(true);

    router.setGamepadSnapshot(makeSnapshot(0, { rt: 0.02 }));
    const idle = slotAction(router.poll(1), router.map, 0, "throttle");
    expect(idle?.value).toBe(0);
    expect(idle?.pressed).toBe(false);
  });
});

describe("gamepad diagnostics", () => {
  test("[ER-10-06] disconnecting a held fixed pad synthesizes one release", () => {
    const events: InputDeviceEvent[] = [];
    const router = createInputRouter({
      slots: 2,
      fixed: { gamepads: { 0: 0 } },
    });
    router.subscribe((event) => events.push(event));
    router.setGamepadSnapshot(makeSnapshot(0, { buttons: [0], edges: 0b1 }));
    expect(
      slotAction(router.poll(0), router.map, 0, "primary")?.pressed,
    ).toBe(true);

    router.setGamepadDisconnected(0);
    const disconnected = router.poll(1);
    expect(disconnected.player(0)?.device).toBe("none");
    const released = slotAction(disconnected, router.map, 0, "primary");
    expect(released?.pressed).toBe(false);
    expect(released?.value).toBe(0);
    expect(released?.releaseEdges).toBe(1);

    const later = slotAction(router.poll(2), router.map, 0, "primary");
    expect(later?.releaseEdges).toBe(0);
    expect(
      events.filter(
        (event) => event.type === "gamepad-disconnected" && event.index === 0,
      ),
    ).toHaveLength(1);
  });

  test("[ER-10-06] invalid indexes and non-standard mappings are counted, not assigned", () => {
    const router = createInputRouter();
    router.setGamepadSnapshot(makeSnapshot(9, { buttons: [0] }));
    router.setGamepadSnapshot(
      makeSnapshot(0, { mapping: "non-standard", buttons: [0] }),
    );

    const frame: InputFrame = router.poll(0);
    expect(router.stats.invalidGamepadSnapshots).toBe(1);
    expect(router.stats.nonStandardPads).toBe(1);
    expect(frame.player(1)?.device).toBe("none");
  });

  test("[ER-10-06] a captured pad press is consumed and applies from the next poll", async () => {
    const router = createInputRouter({
      slots: 1,
      fixed: { gamepads: { 0: 0 } },
    });
    const pending = router.beginCapture("primary", 0, "gamepad");
    router.setGamepadSnapshot(makeSnapshot(0, { buttons: [5], edges: 1 << 5 }));

    const consumed = router.poll(0);
    expect(slotAction(consumed, router.map, 0, "primary")?.pressed).toBe(false);
    const result = await pending;
    expect(result).toEqual({
      ok: true,
      action: "primary",
      binding: 0,
      device: "gamepad",
      code: "GamepadButton5",
    });
    const primaryIndex = router.map.indexOf("primary");
    expect(router.map.actions[primaryIndex]?.bindings[0]).toEqual({
      device: "gamepad",
      pad: "self",
      button: 5,
    });

    router.setGamepadSnapshot(makeSnapshot(0, { buttons: [5] }));
    const applied = slotAction(router.poll(1), router.map, 0, "primary");
    expect(applied?.pressed).toBe(true);
    // The rebind replaced binding 0: its first engagement is bit 1, plus the
    // aggregate bit.
    expect(applied?.edges).toBe(3);
  });
});
