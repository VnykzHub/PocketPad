/**
 * ER-10-04 — phone packet ordering and loss.
 *
 * Phone tick comparison is wrap-safe: levels apply when the packet is not
 * older than the last applied one (equal applies), while press edges OR across
 * every packet so a press is never lost to reordering. A lost phone zeroes its
 * slot without synthesizing button-up edges. The controller's 8% deadzone is
 * never re-applied by the engine, and malformed samples only count.
 */

import { describe, expect, test } from "vitest";
import { createInputRouter } from "../src/index.js";
import type { InputAction } from "../src/index.js";
import { phoneSample, slotAction } from "./support.js";

const PHONE_ACTIONS: InputAction[] = [
  {
    name: "fire",
    kind: "button",
    bindings: [{ device: "phone", slot: "self", channel: "button", bit: 0 }],
  },
  {
    name: "stick",
    kind: "vector2",
    deadzone: 0,
    bindings: [
      {
        device: "phone",
        slot: "self",
        channel: "axis",
        axis: "lx",
        component: "x",
      },
      {
        device: "phone",
        slot: "self",
        channel: "axis",
        axis: "ly",
        component: "y",
      },
    ],
  },
  {
    name: "throttle",
    kind: "axis",
    deadzone: 0,
    bindings: [{ device: "phone", slot: "self", channel: "axis", axis: "rt" }],
  },
];

describe("phone packet ordering", () => {
  test("[ER-10-04] a stale packet keeps levels but still ORs its press edges", () => {
    const router = createInputRouter({ slots: 2, actions: PHONE_ACTIONS });
    router.applyPhoneSample(
      0,
      phoneSample({ slot: 0, tick: 10, buttons: 1, lx: 0.5 }),
      0,
    );
    const first = router.poll(0);
    expect(slotAction(first, router.map, 0, "fire")?.pressed).toBe(true);
    expect(slotAction(first, router.map, 0, "stick")?.x).toBe(0.5);

    // Older tick: levels are rejected, but the edge bit survives.
    router.applyPhoneSample(
      0,
      phoneSample({ slot: 0, tick: 9, buttons: 0, edges: 1, lx: -0.7 }),
      1,
    );
    const stale = router.poll(1);
    expect(slotAction(stale, router.map, 0, "stick")?.x).toBe(0.5);
    expect(stale.player(0)?.controller.lx).toBe(0.5);
    expect(stale.player(0)?.controller.tick).toBe(10);
    expect(stale.player(0)?.controller.buttons).toBe(1);
    const fire = slotAction(stale, router.map, 0, "fire");
    expect(fire?.pressed).toBe(true);
    // Binding 0 -> bit 2, plus the aggregate bit.
    expect(fire?.edges).toBe(3);
  });

  test("[ER-10-04] a packet with the same tick still applies its levels", () => {
    const router = createInputRouter({ slots: 2, actions: PHONE_ACTIONS });
    router.applyPhoneSample(
      0,
      phoneSample({ slot: 0, tick: 10, buttons: 1, lx: 0.5 }),
      0,
    );
    router.poll(0);

    router.applyPhoneSample(
      0,
      phoneSample({ slot: 0, tick: 10, buttons: 1, lx: 0.4 }),
      1,
    );
    const equal = router.poll(1);
    expect(slotAction(equal, router.map, 0, "stick")?.x).toBe(0.4);
    expect(equal.player(0)?.controller.lx).toBe(0.4);
    expect(equal.player(0)?.controller.tick).toBe(10);
  });

  test("[ER-10-04] u32 tick wrap is treated as newer", () => {
    const router = createInputRouter({ slots: 1, actions: PHONE_ACTIONS });
    router.applyPhoneSample(
      0,
      phoneSample({ slot: 0, tick: 0xffffffff, lx: 0.2 }),
      0,
    );
    expect(slotAction(router.poll(0), router.map, 0, "stick")?.x).toBe(0.2);

    // (1 - 0xffffffff) >>> 0 === 2: newer across the wrap.
    router.applyPhoneSample(
      0,
      phoneSample({ slot: 0, tick: 1, lx: 0.8 }),
      1,
    );
    const wrapped = router.poll(1);
    expect(slotAction(wrapped, router.map, 0, "stick")?.x).toBeCloseTo(0.8, 12);
    expect(wrapped.player(0)?.controller.tick).toBe(1);
  });

  test("[ER-10-04] a ten-packet burst ORs every edge and keeps the newest levels", () => {
    const router = createInputRouter({ slots: 1, actions: PHONE_ACTIONS });
    for (let index = 0; index < 10; index += 1) {
      router.applyPhoneSample(
        0,
        phoneSample({
          slot: 0,
          tick: 20 + index,
          buttons: 1,
          edges: 1 << (index % 4),
          lx: (index + 1) / 10,
        }),
        index,
      );
    }

    const burst = router.poll(0);
    const controller = burst.player(0)?.controller;
    expect(controller?.edges).toBe(0b1111);
    expect(controller?.tick).toBe(29);
    expect(controller?.buttons).toBe(1);
    expect(controller?.lx).toBeCloseTo(1, 12);
    expect(slotAction(burst, router.map, 0, "stick")?.x).toBeCloseTo(1, 12);

    // The OR mask was published once; the next poll starts empty.
    expect(router.poll(1).player(0)?.controller.edges).toBe(0);
  });
});

describe("phone loss and diagnostics", () => {
  test("[ER-10-04] a lost phone zeroes its slot without synthesizing a release", () => {
    const router = createInputRouter({ slots: 2, actions: PHONE_ACTIONS });
    router.applyPhoneSample(
      0,
      phoneSample({ slot: 0, tick: 1, buttons: 1, edges: 1, lx: 0.5 }),
      0,
    );
    expect(router.poll(0).player(0)?.device).toBe("phone");

    router.setPhoneConnected(0, false);
    const lost = router.poll(1);
    expect(lost.player(0)?.device).toBe("none");
    const fire = slotAction(lost, router.map, 0, "fire");
    expect(fire?.pressed).toBe(false);
    // §5.14: a lost phone synthesizes no button-up.
    expect(fire?.releaseEdges).toBe(0);
    const stick = slotAction(lost, router.map, 0, "stick");
    expect(stick?.x).toBe(0);
    expect(stick?.value).toBe(0);
    expect(lost.player(0)?.controller.buttons).toBe(0);
    expect(lost.player(0)?.controller.tick).toBe(0);
  });

  test("[ER-10-04] the controller deadzone is not re-applied to phone axes", () => {
    const router = createInputRouter({ slots: 1, actions: PHONE_ACTIONS });
    router.applyPhoneSample(
      0,
      phoneSample({ slot: 0, tick: 1, lx: 0.08 }),
      0,
    );

    const frame = router.poll(0);
    // The phone applies its own 8% deadzone; with a 0 action deadzone the
    // router must pass this through untouched.
    expect(frame.player(0)?.controller.lx).toBe(0.08);
    expect(slotAction(frame, router.map, 0, "stick")?.x).toBe(0.08);
  });

  test("[ER-10-04] tilt keeps its pooled identity across polls", () => {
    const router = createInputRouter({ slots: 1 });
    router.applyPhoneSample(0, phoneSample({ slot: 0, tick: 1 }), 0);
    router.setTilt(0, { angleX: 10, angleY: -5, available: true });

    const firstFrame = router.poll(0);
    const first = firstFrame.player(0)?.controller.tilt;
    expect(first).toEqual({ angleX: 10, angleY: -5, available: true });

    router.setTilt(0, { angleX: 3, angleY: 4, available: false });
    const second = router.poll(1).player(0)?.controller.tilt;
    expect(second).toBe(first);
    expect(second).toEqual({ angleX: 3, angleY: 4, available: false });
  });

  test("[ER-10-04] malformed samples are counted and never connect a phone", () => {
    const router = createInputRouter({ slots: 2, actions: PHONE_ACTIONS });
    router.applyPhoneSample(0, phoneSample({ slot: 0, tick: 1.5 }), 0);
    router.applyPhoneSample(5, phoneSample({ slot: 5, tick: 1 }), 0);

    const frame = router.poll(0);
    expect(router.stats.invalidPhoneSamples).toBe(2);
    expect(frame.player(1)?.device).toBe("none");
    expect(router.assignment.some((entry) => entry.device === "phone")).toBe(
      false,
    );
  });
});
