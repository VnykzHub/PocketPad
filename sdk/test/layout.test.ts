import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  controlBitAssignments,
  parseLength,
  validateLayout,
  type LayoutDocument,
  type Length,
} from "../src/index";

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

function dpad(id: string, bits: UnknownRecord): UnknownRecord {
  return { type: "dpad", id, x: "10%", y: "40%", size: "20%", bits };
}

function stick(id: string, axis: "left" | "right"): UnknownRecord {
  return { type: "stick", id, x: "20%", y: "70%", size: "20%", axis, mode: "fixed" };
}

function trigger(id: string, channel: "lt" | "rt"): UnknownRecord {
  return { type: "trigger", id, x: "80%", y: "10%", size: "10%", channel };
}

function slider(id: string, channel: "lt" | "rt"): UnknownRecord {
  return { type: "slider", id, x: "70%", y: "80%", w: "20%", h: "8%", channel };
}

function touchpad(id: string): UnknownRecord {
  return { type: "touchpad", id, x: "40%", y: "10%", w: "30%", h: "20%" };
}

/** One valid control of every v1 type. Ids, bits and channels are distinct. */
const validControls: Record<string, UnknownRecord> = {
  button: { ...button("button", 0), label: "Jump" },
  dpad: dpad("dpad", { up: 1, down: 2, left: 3, right: 4 }),
  stick: stick("stick", "left"),
  trigger: trigger("trigger", "lt"),
  touchpad: touchpad("touchpad"),
  slider: slider("slider", "rt"),
  gyro: { type: "gyro", id: "gyro", x: "50%", y: "50%" },
  choice: {
    type: "choice",
    id: "choice",
    x: "60%",
    y: "20%",
    w: "30%",
    h: "20%",
    event: "vote",
    options: [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ],
  },
  panel: { type: "panel", id: "panel", x: "30%", y: "10%", w: "40%", h: "30%" },
  text: {
    type: "text",
    id: "text",
    x: "10%",
    y: "80%",
    w: "50%",
    h: "8%",
    event: "answer",
    maxLen: 60,
  },
  canvas: {
    type: "canvas",
    id: "canvas",
    x: "10%",
    y: "20%",
    w: "40%",
    h: "30%",
    event: "stroke",
  },
};

const CONTROL_TYPES = Object.keys(validControls);

function validLayout(overrides: UnknownRecord = {}): UnknownRecord {
  return {
    id: "platformer-v1",
    orientation: "landscape",
    background: "#101014",
    controls: [button("jump", 0), stick("move", "left"), dpad("dpad", { up: 1, down: 2, left: 3, right: 4 })],
    ...overrides,
  };
}

/**
 * The SPEC §8.1 example. The spec's `text` control omits x/y/w/h; BaseControl
 * freezes x/y as required and TextControl freezes w/h, so those four fields are
 * filled in here. Everything else is copied from the spec verbatim.
 */
function specExampleLayout(): UnknownRecord {
  return {
    id: "platformer-v1",
    orientation: "landscape",
    background: "#101014",
    controls: [
      {
        type: "button",
        id: "jump",
        label: "Jump",
        shape: "circle",
        x: "82%",
        y: "70%",
        r: "11%",
        bit: 0,
        haptic: [12],
      },
      {
        type: "stick",
        id: "move",
        x: "14%",
        y: "72%",
        size: "24%",
        axis: "left",
        mode: "floating",
      },
      { type: "panel", id: "secret", x: "30%", y: "10%", w: "40%", h: "30%" },
      {
        type: "text",
        id: "answer",
        event: "answer",
        maxLen: 60,
        x: "30%",
        y: "82%",
        w: "40%",
        h: "8%",
      },
    ],
    sensors: { gyro: "steer", sensitivity: 1.4, smoothing: 0.15 },
  };
}

function errorsFor(value: unknown): string[] {
  const result = validateLayout(value);
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.errors;
}

type SchemaNode = Record<string, unknown>;

function readSchema(): SchemaNode {
  const text = readFileSync(new URL("../schema/layout.schema.json", import.meta.url), "utf8");
  return JSON.parse(text) as SchemaNode;
}

function asNode(value: unknown, label: string): SchemaNode {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}: expected a schema object`);
  }
  return value as SchemaNode;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label}: expected a schema array`);
  }
  return value;
}

function schemaPart(parent: SchemaNode, key: string, label: string): SchemaNode {
  return asNode(parent[key], label);
}

describe("validateLayout (D2-LAYOUT-01)", () => {
  test("[FR-8.1] accepts the SPEC §8.1 example layout (text geometry filled in)", () => {
    expect(validateLayout(specExampleLayout())).toEqual({
      ok: true,
      layout: specExampleLayout(),
    });
  });

  test("[FR-8.1] layout supports every v1 control type structurally", () => {
    const controls = CONTROL_TYPES.map((type) => validControls[type]);
    const result = validateLayout(layoutWith(controls));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.layout.controls.map((control) => control.type)).toEqual(CONTROL_TYPES);
    }
  });

  test("[FR-8.1] accepts a minimal layout with no optional fields", () => {
    expect(validateLayout({ id: "min-v1", orientation: "portrait", controls: [button("a", 0)] }).ok).toBe(
      true,
    );
  });

  test("[FR-8.1] accepts an explicit schemaVersion of 1", () => {
    expect(validateLayout(validLayout({ schemaVersion: 1 })).ok).toBe(true);
  });

  test("[FR-8.1] preserves additive unknown properties", () => {
    const result = validateLayout(validLayout({ futureField: { enabled: true } }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.layout as unknown as UnknownRecord).futureField).toEqual({ enabled: true });
    }
  });

  test("[FR-8.1] controlBitAssignments maps each bit to its control ids", () => {
    const result = validateLayout(validLayout());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const assignments = controlBitAssignments(result.layout);
    expect(assignments.get(0)).toEqual(["jump"]);
    expect(assignments.get(1)).toEqual(["dpad"]);
    expect(assignments.get(4)).toEqual(["dpad"]);
    expect(assignments.size).toBe(5);
  });

  test("[FR-8.4] controlBitAssignments reports every owner of a duplicated bit", () => {
    const layout: LayoutDocument = {
      id: "dupe-v1",
      orientation: "any",
      controls: [
        {
          type: "button",
          id: "a",
          x: "0%",
          y: "0%",
          label: "A",
          shape: "circle",
          r: "10%",
          bit: 0,
        },
        {
          type: "button",
          id: "b",
          x: "20%",
          y: "0%",
          label: "B",
          shape: "circle",
          r: "10%",
          bit: 0,
        },
      ],
    };

    expect(controlBitAssignments(layout).get(0)).toEqual(["a", "b"]);
  });

  test("[FR-7.7] distinct channel bindings are accepted", () => {
    const layout = layoutWith([
      stick("left", "left"),
      stick("right", "right"),
      trigger("lt", "lt"),
      slider("rt", "rt"),
    ]);
    expect(validateLayout(layout).ok).toBe(true);
  });

  test("[FR-7.7] duplicate channel bindings are rejected", () => {
    const cases: Array<[string, UnknownRecord, string]> = [
      [
        "two left sticks",
        layoutWith([stick("a", "left"), stick("b", "left")]),
        'controls[1].axis: channel "lx"/"ly" is already bound by control "a"',
      ],
      [
        "touchpad plus a right stick",
        layoutWith([stick("look", "right"), touchpad("pad")]),
        'controls[1] (touchpad): channel "rx"/"ry" is already bound by control "look"',
      ],
      [
        "touchpad plus a second touchpad",
        layoutWith([touchpad("pad1"), touchpad("pad2")]),
        'controls[1] (touchpad): channel "rx"/"ry" is already bound by control "pad1"',
      ],
      [
        "trigger plus a slider on lt",
        layoutWith([trigger("trigger", "lt"), slider("slider", "lt")]),
        'controls[1].channel: channel "lt" is already bound by control "trigger"',
      ],
      [
        "two triggers on rt",
        layoutWith([trigger("one", "rt"), trigger("two", "rt")]),
        'controls[1].channel: channel "rt" is already bound by control "one"',
      ],
    ];

    for (const [label, layout, expected] of cases) {
      const errors = errorsFor(layout);
      expect(errors, label).toContain(expected);
    }
  });

  test("[FR-8.4] rejects a schemaVersion other than 1", () => {
    expect(errorsFor(validLayout({ schemaVersion: 2 }))).toEqual([
      "schemaVersion: must be 1 when present",
    ]);
  });

  test("[FR-8.4] reports every missing top-level field in one pass", () => {
    const errors = errorsFor({});
    expect(errors).toContain("id: required");
    expect(errors).toContain("orientation: required");
    expect(errors).toContain("controls: required");
  });

  test("[FR-8.4] rejects invalid layouts with field-specific errors", () => {
    const duplicateOptions = [
      { value: "a", label: "A" },
      { value: "a", label: "B" },
    ];
    const thirteenOptions = Array.from({ length: 13 }, (_, index) => ({
      value: `v${index}`,
      label: `V${index}`,
    }));

    const cases: Array<[string, unknown, string]> = [
      ["a non-object", null, "layout: must be an object"],
      ["an array", [], "layout: must be an object"],
      ["a non-array controls field", validLayout({ controls: "nope" }), "controls: must be an array"],
      ["an empty controls array", layoutWith([]), "controls: must contain 1..24 entries (got 0)"],
      [
        "more than 24 controls",
        layoutWith(Array.from({ length: 25 }, (_, index) => button(`b${index}`, index % 16))),
        "controls: must contain 1..24 entries (got 25)",
      ],
      ["a non-object control", layoutWith([42]), "controls[0]: must be an object"],
      ["an unknown control type", layoutWith([{ ...button("x", 0), type: "joystick" }]), 'controls[0].type: unknown control type "joystick"'],
      ["a missing control type", layoutWith([{ ...button("x", 0), type: undefined }]), "controls[0].type: required"],
      ["a duplicate control id", layoutWith([button("dup", 0), button("dup", 1)]), 'controls[1].id: duplicate control id "dup"'],
      ["a control id over 32 characters", layoutWith([button("x".repeat(33), 0)]), "controls[0].id: must be 1..32 characters (got 33)"],
      ["a bad orientation", validLayout({ orientation: "diagonal" }), "orientation: must be one of"],
      ["a bad background", validLayout({ background: "#12345" }), "background: must be a #rgb or #rrggbb colour"],
      ["malformed length syntax", layoutWith([button("x", 0, { x: "82" })]), 'controls[0].x: must be a percentage ("10%") or pixels ("12px")'],
      ["a percent over 100", layoutWith([button("x", 0, { x: "101%" })]), "controls[0].x: percent must be 0..100 (got 101)"],
      ["pixels over 4096", layoutWith([button("x", 0, { r: "4097px" })]), "controls[0].r: pixels must be 0..4096 (got 4097)"],
      ["a non-finite z", layoutWith([button("x", 0, { z: Number.NaN })]), "controls[0].z: must be a finite number"],
      ["a missing label", layoutWith([{ ...button("x", 0), label: undefined }]), "controls[0].label: required"],
      ["a bad shape", layoutWith([button("x", 0, { shape: "hexagon" })]), "controls[0].shape: must be one of"],
      ["a button bit over 15", layoutWith([button("x", 16)]), "controls[0].bit: must be an integer 0..15"],
      ["a negative button bit", layoutWith([button("x", -1)]), "controls[0].bit: must be an integer 0..15"],
      ["more than 8 haptic steps", layoutWith([button("x", 0, { haptic: [1, 2, 3, 4, 5, 6, 7, 8, 9] })]), "controls[0].haptic: must contain at most 8 durations (got 9)"],
      ["a haptic step over 65535", layoutWith([button("x", 0, { haptic: [65536] })]), "controls[0].haptic[0]: must be an integer 0..65535"],
      ["duplicate dpad direction bits", layoutWith([dpad("pad", { up: 1, down: 1, left: 2, right: 3 })]), "controls[0].bits: up/down/left/right bits must be distinct"],
      ["a dpad bit over 15", layoutWith([dpad("pad", { up: 16, down: 1, left: 2, right: 3 })]), "controls[0].bits.up: must be an integer 0..15"],
      ["a bit shared by a button and a dpad", layoutWith([button("btn", 0), dpad("pad", { up: 0, down: 1, left: 2, right: 3 })]), 'controls[1].bits.up: bit 0 is already assigned to control "btn"'],
      ["a stick deadzone over 0.5", layoutWith([{ ...validControls.stick, deadzone: 0.6 }]), "controls[0].deadzone: must be a number 0..0.5"],
      ["a stick deadzone below 0", layoutWith([{ ...validControls.stick, deadzone: -0.1 }]), "controls[0].deadzone: must be a number 0..0.5"],
      ["a bad trigger channel", layoutWith([{ ...validControls.trigger, channel: "middle" }]), "controls[0].channel: must be one of"],
      ["a bad stick axis", layoutWith([{ ...validControls.stick, axis: "forward" }]), "controls[0].axis: must be one of"],
      ["no choice options", layoutWith([{ ...validControls.choice, options: [] }]), "controls[0].options: must contain 1..12 options (got 0)"],
      ["more than 12 choice options", layoutWith([{ ...validControls.choice, options: thirteenOptions }]), "controls[0].options: must contain 1..12 options (got 13)"],
      ["duplicate choice option values", layoutWith([{ ...validControls.choice, options: duplicateOptions }]), 'controls[0].options[1].value: duplicate option value "a"'],
      ["a non-object choice option", layoutWith([{ ...validControls.choice, options: [7] }]), "controls[0].options[0]: must be an object"],
      ["text maxLen below 1", layoutWith([{ ...validControls.text, maxLen: 0 }]), "controls[0].maxLen: must be an integer 1..200"],
      ["text maxLen over 200", layoutWith([{ ...validControls.text, maxLen: 201 }]), "controls[0].maxLen: must be an integer 1..200"],
      ["a missing text maxLen", layoutWith([{ ...validControls.text, maxLen: undefined }]), "controls[0].maxLen: required"],
      ["an empty event name", layoutWith([{ ...validControls.text, event: "" }]), "controls[0].event: must be 1..64 characters (got 0)"],
      ["an event name over 64 characters", layoutWith([{ ...validControls.canvas, event: "e".repeat(65) }]), "controls[0].event: must be 1..64 characters (got 65)"],
      ["a canvas maxStrokePoints below 1", layoutWith([{ ...validControls.canvas, maxStrokePoints: 0 }]), "controls[0].maxStrokePoints: must be a positive integer"],
      ["a bad sensors.gyro mode", validLayout({ sensors: { gyro: "spin" } }), "sensors.gyro: must be one of"],
      ["sensors.smoothing over 1", validLayout({ sensors: { smoothing: 1.5 } }), "sensors.smoothing: must be a number 0..1"],
      ["sensors.sensitivity at zero", validLayout({ sensors: { sensitivity: 0 } }), "sensors.sensitivity: must be a positive number"],
    ];

    for (const [label, layout, expected] of cases) {
      expect(
        errorsFor(layout).some((error) => error.includes(expected)),
        `${label}: expected an error containing ${JSON.stringify(expected)}`,
      ).toBe(true);
    }
  });

  test("[FR-8.4] reports every error in one pass", () => {
    const errors = errorsFor({
      id: "",
      orientation: "diagonal",
      background: "#12",
      controls: [button("x", 16, { label: 7, shape: "hexagon" }), stick("move", "left")],
    });

    expect(errors.length).toBeGreaterThanOrEqual(6);
    for (const prefix of [
      "id:",
      "orientation:",
      "background:",
      "controls[0].label:",
      "controls[0].shape:",
      "controls[0].bit:",
    ]) {
      expect(errors.some((error) => error.startsWith(prefix))).toBe(true);
    }
  });

  test("[FR-8.4] accepts a 16384-byte layout and rejects 16385 bytes", () => {
    const atLimit = layoutOfByteSize(16_384);
    expect(validateLayout(atLimit).ok).toBe(true);

    const overLimit = layoutOfByteSize(16_385);
    expect(validateLayout(overLimit)).toEqual({
      ok: false,
      errors: ["layout: serialized size 16385 bytes exceeds the 16384-byte limit"],
    });
  });

  test("[FR-8.4] rejects a layout that cannot be serialized", () => {
    const layout = validLayout();
    layout.extra = 1n;
    expect(validateLayout(layout)).toEqual({
      ok: false,
      errors: ["layout: must be JSON-serializable"],
    });
  });

  test("[FR-8.4] JSON schema mirrors the validator contract", () => {
    const schema = readSchema();
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");

    const properties = schemaPart(schema, "properties", "properties");
    expect(new Set(asArray(schema.required, "required"))).toEqual(
      new Set(["id", "orientation", "controls"]),
    );
    expect(asArray(schemaPart(properties, "orientation", "orientation").enum, "orientation.enum")).toEqual([
      "portrait",
      "landscape",
      "any",
    ]);
    expect(schemaPart(properties, "controls", "controls")).toMatchObject({
      type: "array",
      minItems: 1,
      maxItems: 24,
    });
    expect(schemaPart(properties, "id", "id").maxLength).toBe(64);
    expect(schemaPart(properties, "background", "background").pattern).toBe(
      "^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$",
    );

    const oneOf = asArray(
      schemaPart(schemaPart(properties, "controls", "controls"), "items", "controls.items").oneOf,
      "controls.items.oneOf",
    );
    expect(
      oneOf.map((entry) => asNode(entry, "oneOf entry").$ref),
    ).toEqual(CONTROL_TYPES.map((type) => `#/$defs/${type}`));

    const defs = schemaPart(schema, "$defs", "$defs");
    for (const type of CONTROL_TYPES) {
      expect(asNode(defs[type], type).required).toBeDefined();
    }

    expect(schemaPart(defs, "length", "length").pattern).toBe(
      "^(?:\\d+(?:\\.\\d+)?)(?:%|px)$",
    );
    expect(schemaPart(defs, "controlId", "controlId")).toMatchObject({ maxLength: 32 });
    expect(schemaPart(defs, "eventName", "eventName")).toMatchObject({
      minLength: 1,
      maxLength: 64,
    });
    expect(schemaPart(defs, "bit", "bit")).toMatchObject({
      type: "integer",
      minimum: 0,
      maximum: 15,
    });

    const buttonProperties = schemaPart(
      schemaPart(defs, "button", "button"),
      "properties",
      "button.properties",
    );
    expect(schemaPart(buttonProperties, "haptic", "button.haptic")).toMatchObject({
      maxItems: 8,
    });
    expect(schemaPart(schemaPart(defs, "text", "text"), "properties", "text.properties")).toMatchObject({
      maxLen: { type: "integer", minimum: 1, maximum: 200 },
    });
    expect(
      schemaPart(schemaPart(defs, "choice", "choice"), "properties", "choice.properties"),
    ).toMatchObject({ options: { minItems: 1, maxItems: 12 } });

    const requiredByType: Record<string, string[]> = {
      button: ["type", "id", "x", "y", "label", "shape", "r", "bit"],
      dpad: ["type", "id", "x", "y", "size", "bits"],
      stick: ["type", "id", "x", "y", "size", "axis", "mode"],
      trigger: ["type", "id", "x", "y", "size", "channel"],
      touchpad: ["type", "id", "x", "y", "w", "h"],
      slider: ["type", "id", "x", "y", "w", "h", "channel"],
      gyro: ["type", "id", "x", "y"],
      choice: ["type", "id", "x", "y", "w", "h", "event", "options"],
      panel: ["type", "id", "x", "y", "w", "h"],
      text: ["type", "id", "x", "y", "w", "h", "event", "maxLen"],
      canvas: ["type", "id", "x", "y", "w", "h", "event"],
    };

    for (const type of CONTROL_TYPES) {
      const def = asNode(defs[type], type);
      expect(new Set(asArray(def.required, `${type}.required`)), type).toEqual(
        new Set(requiredByType[type]),
      );

      // Every schema-required field is also rejected by the validator.
      for (const field of requiredByType[type] ?? []) {
        const control = { ...validControls[type] };
        delete control[field];
        expect(validateLayout(layoutWith([control])).ok, `${type}.${field}`).toBe(false);
      }
    }
  });

  test("[FR-8.4] schema length and background patterns agree with the validator", () => {
    const schema = readSchema();
    const defs = schemaPart(schema, "$defs", "$defs");
    const lengthPattern = String(schemaPart(defs, "length", "length").pattern);
    const lengthRegex = new RegExp(lengthPattern);

    for (const sample of ["0%", "100%", "12.5%", "0px", "4096px"]) {
      expect(lengthRegex.test(sample), sample).toBe(true);
      expect(validateLayout(layoutWith([button("x", 0, { x: sample })])).ok, sample).toBe(true);
    }
    for (const sample of ["-1%", "10", "1e3px", " 5%"]) {
      expect(lengthRegex.test(sample), sample).toBe(false);
      expect(validateLayout(layoutWith([button("x", 0, { x: sample })])).ok, sample).toBe(false);
    }

    // Syntax only: the schema pattern accepts "101%" and the validator rejects
    // the range, which the schema description and $comment both document.
    expect(lengthRegex.test("101%")).toBe(true);
    expect(validateLayout(layoutWith([button("x", 0, { x: "101%" })])).ok).toBe(false);

    const backgroundRegex = new RegExp(String(schemaPart(schemaPart(schema, "properties", "properties"), "background", "background").pattern));
    for (const sample of ["#abc", "#A1B2C3"]) {
      expect(backgroundRegex.test(sample), sample).toBe(true);
      expect(validateLayout(validLayout({ background: sample })).ok, sample).toBe(true);
    }
    for (const sample of ["#abcd", "#12345", "abc"]) {
      expect(backgroundRegex.test(sample), sample).toBe(false);
      expect(validateLayout(validLayout({ background: sample })).ok, sample).toBe(false);
    }
    expect(lengthPattern).toBe("^(?:\\d+(?:\\.\\d+)?)(?:%|px)$");
  });

  test("[FR-8.4] JSON schema agrees with the validator on structural fixtures", () => {
    const schema = readSchema();
    const fixtures: unknown[] = [
      specExampleLayout(),
      layoutWith(CONTROL_TYPES.map((type) => validControls[type])),
      { id: "min-v1", orientation: "portrait", controls: [button("a", 0)] },
      null,
      [],
      layoutWith([42]),
      layoutWith([{ ...button("x", 0), type: "joystick" }]),
      layoutWith([{ ...button("x", 0), type: undefined }]),
      layoutWith([{ ...button("x", 0), label: undefined }]),
      validLayout({ orientation: "diagonal" }),
      validLayout({ background: "#12345" }),
      layoutWith([button("x", 0, { x: "82" })]),
      layoutWith([button("x", 0, { shape: "hexagon" })]),
      layoutWith([button("x", 16)]),
      layoutWith([button("x", 0, { haptic: [1, 2, 3, 4, 5, 6, 7, 8, 9] })]),
      layoutWith([button("x", 0, { haptic: [65536] })]),
      layoutWith([{ ...validControls.stick, deadzone: 0.6 }]),
      layoutWith([{ ...validControls.trigger, channel: "middle" }]),
      layoutWith([{ ...validControls.choice, options: [] }]),
      layoutWith([
        {
          ...validControls.choice,
          options: Array.from({ length: 13 }, (_, index) => ({
            value: `v${index}`,
            label: `V${index}`,
          })),
        },
      ]),
      layoutWith([{ ...validControls.text, maxLen: 201 }]),
      layoutWith([{ ...validControls.text, maxLen: undefined }]),
      layoutWith([{ ...validControls.text, event: "" }]),
      layoutWith([{ ...validControls.canvas, event: "e".repeat(65) }]),
      layoutWith([{ ...validControls.canvas, maxStrokePoints: 0 }]),
      validLayout({ sensors: { gyro: "spin" } }),
      validLayout({ sensors: { smoothing: 1.5 } }),
      validLayout({ sensors: { sensitivity: 0 } }),
    ];

    // Cross-field rules (unique ids/bits/channels, length ranges, byte size)
    // are deliberately validator-only and are covered by the tests above.
    for (const fixture of fixtures) {
      expect(
        schemaAccepts(schema, fixture),
        `schema disagreement for ${JSON.stringify(fixture)?.slice(0, 120)}`,
      ).toBe(validateLayout(fixture).ok);
    }
  });

  test("[FR-8.3] layout coordinates are literal data and survive a JSON round-trip", () => {
    const original = specExampleLayout();
    const roundTripped = JSON.parse(JSON.stringify(original)) as UnknownRecord;

    const first = validateLayout(original);
    const second = validateLayout(roundTripped);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.layout).toEqual(first.layout);
    }

    const controls = roundTripped.controls as UnknownRecord[];
    expect(controls[0]?.x).toBe("82%");
    expect(controls[0]?.y).toBe("70%");
    expect(controls[1]?.size).toBe("24%");
    expect(typeof controls[0]?.x).toBe("string");
  });

  test("[AR-5] validator exposes sizes so the renderer can enforce 44px targets", () => {
    expect(parseLength("44px")).toEqual({ kind: "px", value: 44 });
    expect(parseLength("11%")).toEqual({ kind: "percent", value: 11 });
    expect(parseLength("0px")).toEqual({ kind: "px", value: 0 });
    expect(parseLength("100%")).toEqual({ kind: "percent", value: 100 });
    expect(() => parseLength("44" as unknown as Length)).toThrow(/Invalid layout length/);

    // The validator is viewport-agnostic: a 40px button is structurally valid
    // and its size is exposed so the controller can expand it to 44px.
    const result = validateLayout(layoutWith([button("small", 0, { r: "40px" })]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const [control] = result.layout.controls;
      expect(control?.type).toBe("button");
      if (control?.type === "button") {
        expect(parseLength(control.r)).toEqual({ kind: "px", value: 40 });
      }
    }
  });
});

/**
 * Builds a valid layout whose JSON serialization is exactly `bytes` UTF-8
 * bytes. The button label is the free-form field used for padding.
 */
function layoutOfByteSize(bytes: number): UnknownRecord {
  const layout = validLayout();
  const controls = layout.controls as UnknownRecord[];
  const target = controls[0];
  if (target === undefined) {
    throw new Error("validLayout must have a first control");
  }

  target.label = "";
  const base = Buffer.byteLength(JSON.stringify(layout), "utf8");
  if (bytes <= base) {
    throw new Error(`requested size ${bytes} is not larger than the ${base}-byte base layout`);
  }
  target.label = "x".repeat(bytes - base);
  expect(Buffer.byteLength(JSON.stringify(layout), "utf8")).toBe(bytes);
  return layout;
}

/**
 * Minimal JSON Schema evaluator for the keywords layout.schema.json uses:
 * `$ref`, `oneOf`, `type`, `required`, `properties`, `items`, `enum`, `const`,
 * `pattern`, `minLength`/`maxLength`, `minItems`/`maxItems`, `minimum`,
 * `maximum` and `exclusiveMinimum`. It exists only so the fixture test can
 * prove the schema and the hand-written validator agree without adding a
 * runtime dependency.
 */
function schemaAccepts(root: SchemaNode, value: unknown): boolean {
  return acceptsSchemaNode(root, value, root);
}

function acceptsSchemaNode(
  node: SchemaNode,
  value: unknown,
  root: SchemaNode,
): boolean {
  if (typeof node.$ref === "string") {
    return acceptsSchemaNode(resolveSchemaRef(root, node.$ref), value, root);
  }

  if (node.const !== undefined && value !== node.const) {
    return false;
  }
  if (Array.isArray(node.enum) && !node.enum.includes(value)) {
    return false;
  }
  if (Array.isArray(node.oneOf)) {
    const matches = node.oneOf.filter((entry) =>
      acceptsSchemaNode(asNode(entry, "oneOf entry"), value, root),
    );
    if (matches.length !== 1) {
      return false;
    }
  }

  switch (node.type) {
    case undefined:
      break;
    case "object": {
      if (!isPlainRecord(value)) {
        return false;
      }
      const required = node.required === undefined ? [] : asArray(node.required, "required");
      for (const field of required) {
        if (typeof field === "string" && !(field in value)) {
          return false;
        }
      }
      const properties = node.properties;
      if (isPlainRecord(properties)) {
        for (const [field, child] of Object.entries(properties)) {
          if (field in value && !acceptsSchemaNode(asNode(child, field), value[field], root)) {
            return false;
          }
        }
      }
      break;
    }
    case "array": {
      if (!Array.isArray(value)) {
        return false;
      }
      if (typeof node.minItems === "number" && value.length < node.minItems) {
        return false;
      }
      if (typeof node.maxItems === "number" && value.length > node.maxItems) {
        return false;
      }
      if (node.items !== undefined) {
        const itemNode = asNode(node.items, "items");
        if (!value.every((entry) => acceptsSchemaNode(itemNode, entry, root))) {
          return false;
        }
      }
      break;
    }
    case "string": {
      if (typeof value !== "string") {
        return false;
      }
      const length = Array.from(value).length;
      if (typeof node.minLength === "number" && length < node.minLength) {
        return false;
      }
      if (typeof node.maxLength === "number" && length > node.maxLength) {
        return false;
      }
      if (typeof node.pattern === "string" && !new RegExp(node.pattern).test(value)) {
        return false;
      }
      break;
    }
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return false;
      }
      if (node.type === "integer" && !Number.isInteger(value)) {
        return false;
      }
      if (typeof node.minimum === "number" && value < node.minimum) {
        return false;
      }
      if (typeof node.maximum === "number" && value > node.maximum) {
        return false;
      }
      if (typeof node.exclusiveMinimum === "number" && value <= node.exclusiveMinimum) {
        return false;
      }
      break;
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        return false;
      }
      break;
    }
    default:
      throw new Error(`unsupported schema type ${String(node.type)}`);
  }

  return true;
}

function resolveSchemaRef(root: SchemaNode, ref: string): SchemaNode {
  const prefix = "#/$defs/";
  if (!ref.startsWith(prefix)) {
    throw new Error(`unsupported $ref ${ref}`);
  }
  const defs = asNode(root.$defs, "$defs");
  return asNode(defs[ref.slice(prefix.length)], ref);
}

function isPlainRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
