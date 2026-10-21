import { describe, expect, test } from "vitest";
import {
  controlBitAssignments,
  layoutEventNames,
  parseLength,
  validateLayout,
  type LayoutDocument,
} from "../src/index";

/**
 * D5-SDK-01 full-layout coverage: every v1 control type with complete
 * fixtures, the D5 cross-control rules, event-name safety, per-slot
 * independence and the SDK-side rendering constraints (no DOM, immutable
 * data).
 */

type UnknownRecord = Record<string, unknown>;

function layoutWith(controls: unknown[], overrides: UnknownRecord = {}): UnknownRecord {
  return { id: "test-v1", orientation: "any", controls, ...overrides };
}

function button(id: string, bit: number, overrides: UnknownRecord = {}): UnknownRecord {
  return {
    type: "button",
    id,
    x: "10%",
    y: "10%",
    label: "B",
    shape: "circle",
    r: "10%",
    bit,
    ...overrides,
  };
}

function dpad(id: string, bits: UnknownRecord, overrides: UnknownRecord = {}): UnknownRecord {
  return { type: "dpad", id, x: "10%", y: "40%", size: "20%", bits, ...overrides };
}

function stick(
  id: string,
  axis: "left" | "right",
  overrides: UnknownRecord = {},
): UnknownRecord {
  return { type: "stick", id, x: "20%", y: "70%", size: "20%", axis, mode: "fixed", ...overrides };
}

function trigger(id: string, channel: "lt" | "rt", overrides: UnknownRecord = {}): UnknownRecord {
  return { type: "trigger", id, x: "80%", y: "10%", size: "10%", channel, ...overrides };
}

function slider(id: string, channel: "lt" | "rt", overrides: UnknownRecord = {}): UnknownRecord {
  return {
    type: "slider",
    id,
    x: "70%",
    y: "80%",
    w: "20%",
    h: "8%",
    channel,
    ...overrides,
  };
}

function touchpad(id: string, overrides: UnknownRecord = {}): UnknownRecord {
  return { type: "touchpad", id, x: "40%", y: "10%", w: "30%", h: "20%", ...overrides };
}

function gyro(id: string, overrides: UnknownRecord = {}): UnknownRecord {
  return { type: "gyro", id, x: "50%", y: "50%", ...overrides };
}

function choice(id: string, event: string, overrides: UnknownRecord = {}): UnknownRecord {
  return {
    type: "choice",
    id,
    x: "60%",
    y: "20%",
    w: "30%",
    h: "20%",
    event,
    options: [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ],
    ...overrides,
  };
}

function panel(id: string, overrides: UnknownRecord = {}): UnknownRecord {
  return { type: "panel", id, x: "30%", y: "10%", w: "40%", h: "30%", ...overrides };
}

function text(id: string, event: string, overrides: UnknownRecord = {}): UnknownRecord {
  return {
    type: "text",
    id,
    x: "10%",
    y: "80%",
    w: "50%",
    h: "8%",
    event,
    maxLen: 60,
    ...overrides,
  };
}

function canvas(id: string, event: string, overrides: UnknownRecord = {}): UnknownRecord {
  return {
    type: "canvas",
    id,
    x: "10%",
    y: "20%",
    w: "40%",
    h: "30%",
    event,
    ...overrides,
  };
}

/** One complete control of every v1 type. Ids, bits and channels are unique. */
function completeLayout(overrides: UnknownRecord = {}): UnknownRecord {
  return {
    schemaVersion: 1,
    id: "all-types-v1",
    orientation: "landscape",
    background: "#101014",
    controls: [
      button("jump", 0, { label: "Jump", shape: "rounded", r: "12%", haptic: [12, 0, 8], z: 2 }),
      dpad("dpad", { up: 1, down: 2, left: 3, right: 4 }, { z: 1 }),
      stick("move", "left", { mode: "floating", deadzone: 0.08 }),
      trigger("fire", "lt", { orientation: "vertical" }),
      touchpad("pad"),
      slider("throttle", "rt", { direction: "horizontal" }),
      gyro("tilt", { sensitivity: 1.4, smoothing: 0.15 }),
      choice("vote", "vote"),
      panel("secret"),
      text("answer", "answer", { maxLen: 200 }),
      canvas("draw", "stroke", { maxStrokePoints: 64 }),
    ],
    sensors: { gyro: "steer", sensitivity: 1.4, smoothing: 0.15 },
    ...overrides,
  };
}

function errorsFor(value: unknown): string[] {
  const result = validateLayout(value);
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.errors;
}

describe("validateLayout D5-SDK-01", () => {
  test("[FR-8.1] all eleven control types validate with complete fixtures", () => {
    const layout = completeLayout();
    const result = validateLayout(layout);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.layout.controls.map((control) => control.type)).toEqual([
      "button",
      "dpad",
      "stick",
      "trigger",
      "touchpad",
      "slider",
      "gyro",
      "choice",
      "panel",
      "text",
      "canvas",
    ]);
    expect(result.layout.id).toBe("all-types-v1");
  });

  test("[FR-8.1] event names may be shared by panel/text/canvas/choice controls", () => {
    const layout = layoutWith([
      text("answer-one", "answer"),
      text("answer-two", "answer"),
      choice("vote-a", "answer"),
      canvas("draw", "answer"),
      panel("secret"),
    ]);

    const result = validateLayout(layout);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(layoutEventNames(result.layout)).toEqual(["answer"]);
  });

  test("[FR-8.1] layoutEventNames lists distinct names in document order", () => {
    const result = validateLayout(
      layoutWith([
        text("one", "first"),
        choice("two", "second"),
        canvas("three", "first"),
        text("four", "third"),
      ]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(layoutEventNames(result.layout)).toEqual(["first", "second", "third"]);
  });

  test("[FR-8.2] per-slot layouts validate independently without shared state", () => {
    const slotOne = completeLayout({ id: "slot-1-v1" });
    const slotTwo = layoutWith(
      [button("jump", 0, { label: "Slot two jump" }), stick("move", "left")],
      { id: "slot-2-v1", orientation: "portrait" },
    );

    const first = validateLayout(slotOne);
    const second = validateLayout(slotTwo);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.layout.id).toBe("slot-1-v1");
      expect(second.layout.id).toBe("slot-2-v1");
      expect(first.layout.controls).toHaveLength(11);
      expect(second.layout.controls).toHaveLength(2);
      // The same control id is legal in different slots because a layout is
      // self-contained; validation carries no per-slot registry.
      expect(second.layout.controls[0]?.id).toBe("jump");
    }

    // A rejected layout for one slot must not affect the next validation.
    expect(validateLayout(layoutWith([button("bad", 16)])).ok).toBe(false);
    expect(validateLayout(slotOne).ok).toBe(true);
    expect(validateLayout(slotOne)).toEqual(first);
  });

  test("[FR-8.3] validation is DOM-free, purity-preserving and leaves data untouched", () => {
    const layout = completeLayout();
    const snapshot = JSON.stringify(layout);

    const throwOnDomAccess = (): never => {
      throw new Error("SDK validator must not access the DOM");
    };
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      get: throwOnDomAccess,
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      get: throwOnDomAccess,
    });

    try {
      const result = validateLayout(layout);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // The renderer receives the same plain object; the validator does not
        // build DOM or per-control render state.
        expect(result.layout).toBe(layout as unknown as LayoutDocument);
      }
      expect(JSON.stringify(layout)).toBe(snapshot);
    } finally {
      Reflect.deleteProperty(globalThis, "document");
      Reflect.deleteProperty(globalThis, "window");
    }
  });

  test("[FR-8.4] rejects every D5 limit violation in one pass", () => {
    const twentyFive = Array.from({ length: 25 }, (_, index) => button(`b${index}`, index % 16));
    const thirteenOptions = Array.from({ length: 13 }, (_, index) => ({
      value: `v${index}`,
      label: `V${index}`,
    }));
    const nineHapticSteps = [1, 2, 3, 4, 5, 6, 7, 8, 9];

    const cases: Array<[string, unknown, string]> = [
      [
        "more than 24 controls",
        layoutWith(twentyFive),
        "controls: must contain 1..24 entries (got 25)",
      ],
      [
        "more than 12 choice options",
        layoutWith([choice("vote", "vote", { options: thirteenOptions })]),
        "controls[0].options: must contain 1..12 options (got 13)",
      ],
      [
        "text maxLen over 200",
        layoutWith([text("answer", "answer", { maxLen: 201 })]),
        "controls[0].maxLen: must be an integer 1..200",
      ],
      [
        "more than 8 haptic steps",
        layoutWith([button("jump", 0, { haptic: nineHapticSteps })]),
        "controls[0].haptic: must contain at most 8 durations (got 9)",
      ],
      [
        "an event name over 64 characters",
        layoutWith([canvas("draw", "e".repeat(65))]),
        "controls[0].event: must be 1..64 characters (got 65)",
      ],
      [
        "an unknown control type",
        layoutWith([{ ...button("x", 0), type: "trackball" }]),
        'controls[0].type: unknown control type "trackball"',
      ],
      [
        "a duplicate control id",
        layoutWith([button("dup", 0), button("dup", 1)]),
        'controls[1].id: duplicate control id "dup"',
      ],
      [
        "a duplicate bit across a button and a dpad",
        layoutWith([button("jump", 0), dpad("dpad", { up: 0, down: 1, left: 2, right: 3 })]),
        'controls[1].bits.up: bit 0 is already assigned to control "jump"',
      ],
    ];

    for (const [label, value, expected] of cases) {
      expect(errorsFor(value), label).toContain(expected);
    }
  });

  test("[FR-7.7] touchpad always binds rx/ry and cannot coexist with a right stick", () => {
    expect(validateLayout(layoutWith([touchpad("pad")])).ok).toBe(true);
    expect(validateLayout(layoutWith([stick("move", "left"), touchpad("pad")])).ok).toBe(true);

    const rightStickConflict = errorsFor(
      layoutWith([stick("look", "right"), touchpad("pad")]),
    );
    expect(rightStickConflict).toContain(
      'controls[1] (touchpad): channel "rx"/"ry" is already bound by control "look"',
    );

    const touchpadConflict = errorsFor(layoutWith([touchpad("pad1"), touchpad("pad2")]));
    expect(touchpadConflict).toContain(
      'controls[1] (touchpad): channel "rx"/"ry" is already bound by control "pad1"',
    );

    expect(validateLayout(layoutWith([trigger("fire", "lt"), slider("throttle", "rt")])).ok).toBe(
      true,
    );
    expect(errorsFor(layoutWith([trigger("fire", "lt"), slider("throttle", "lt")]))).toContain(
      'controls[1].channel: channel "lt" is already bound by control "fire"',
    );
    expect(validateLayout(layoutWith([trigger("one", "rt")])).ok).toBe(true);
    expect(errorsFor(layoutWith([trigger("one", "rt"), trigger("two", "rt")]))).toContain(
      'controls[1].channel: channel "rt" is already bound by control "one"',
    );
  });

  test("[FR-8.10] a gyro control requires a non-gyro fallback in the same layout", () => {
    const expected =
      "controls[0].type: gyro control requires a non-gyro fallback control in the same layout";

    expect(errorsFor(layoutWith([gyro("tilt")]))).toContain(expected);
    expect(errorsFor(layoutWith([gyro("tilt"), panel("secret")]))).toContain(expected);
    expect(errorsFor(layoutWith([gyro("tilt"), gyro("tilt-two")]))).toEqual([
      expected,
      expected.replace("controls[0]", "controls[1]"),
    ]);

    expect(validateLayout(layoutWith([gyro("tilt"), button("jump", 0)])).ok).toBe(true);
    expect(validateLayout(layoutWith([gyro("tilt"), text("answer", "answer")])).ok).toBe(true);
    expect(
      validateLayout(layoutWith([gyro("tilt"), gyro("tilt-two"), dpad("pad", {
        up: 0,
        down: 1,
        left: 2,
        right: 3,
      })])).ok,
    ).toBe(true);
  });

  test("[SR-13] event names must match the wire-safe pattern", () => {
    const accepted = ["answer", "vote.round_1", "a-b", "A1", "a".repeat(64)];
    for (const name of accepted) {
      expect(validateLayout(layoutWith([text("answer", name)])).ok, name).toBe(true);
    }

    const rejected = ["1answer", "answer!", "a b", "a/b", "<script>", "answer:round1"];
    for (const name of rejected) {
      expect(errorsFor(layoutWith([text("answer", name)]))).toContain(
        "controls[0].event: must match ^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$",
      );
    }

    expect(errorsFor(layoutWith([text("answer", "a".repeat(65))]))).toContain(
      "controls[0].event: must be 1..64 characters (got 65)",
    );
  });

  test("[FR-8.4] validated layouts expose the metadata a debug grid needs", () => {
    const result = validateLayout(completeLayout());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    // Ids, types, geometry, bits and channels stay plain data; the debug
    // overlay can render them without a second parse or DOM cooperation.
    const ids = result.layout.controls.map((control) => control.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("jump");

    const jump = result.layout.controls.find((control) => control.type === "button");
    expect(jump?.type).toBe("button");
    if (jump?.type === "button") {
      expect(jump.bit).toBe(0);
    }
    expect(controlBitAssignments(result.layout).get(0)).toEqual(["jump"]);

    expect(
      result.layout.controls.find((control) => control.type === "trigger"),
    ).toMatchObject({ channel: "lt" });
    expect(
      result.layout.controls.find((control) => control.type === "touchpad"),
    ).toMatchObject({ w: "30%", h: "20%" });
  });

  test("[AR-5] the validator exposes pixel sizes for the controller's 44px check", () => {
    const result = validateLayout(
      layoutWith([
        button("small", 0, { r: "40px" }),
        button("target", 1, { r: "44px" }),
      ]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const [small, target] = result.layout.controls;
    expect(small?.type).toBe("button");
    expect(target?.type).toBe("button");
    if (small?.type === "button" && target?.type === "button") {
      expect(parseLength(small.r)).toEqual({ kind: "px", value: 40 });
      expect(parseLength(target.r)).toEqual({ kind: "px", value: 44 });
    }
  });
});
