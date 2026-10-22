import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  controlBitAssignments,
  parseLength,
  validateLayout,
  type ButtonControl,
  type Control,
  type DpadControl,
  type LayoutDocument,
  type Length,
  type StickControl,
} from "../../../../sdk/src/index";

/**
 * Coin Run layout contract (GAME-PF-01; FR-8.1, FR-8.4, AR-5).
 *
 * Both layouts are data files validated by the same pure validator the host
 * and the controller run. The geometry checks resolve lengths exactly the way
 * the controller does: percent `x`/`y` against the viewport width/height and
 * percent `size`/`r` against the short side.
 */

const LAYOUT_FILES = ["../layouts/pf-dpad-v1.json", "../layouts/pf-stick-v1.json"] as const;

/**
 * Additive display hints: `symbol` on a button and `label` on a stick are
 * unknown to `LayoutDocument`, and `validateLayout` preserves unknown
 * properties (layout.schema.json sets `additionalProperties: true`).
 */
type ButtonWithSymbol = ButtonControl & { symbol?: string };
type StickWithLabel = StickControl & { label?: string };

/** Smallest landscape phone baseline: 320 CSS px on the short side. */
const MIN_LANDSCAPE_VIEWPORT = { width: 568, height: 320 } as const;
/** A common larger landscape phone. */
const LARGE_LANDSCAPE_VIEWPORT = { width: 640, height: 360 } as const;
const MIN_TOUCH_TARGET_PX = 44;

interface Viewport {
  readonly width: number;
  readonly height: number;
}

interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8")) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("layout fixture must be an object");
  }
  return value as Record<string, unknown>;
}

function validatedLayout(relativePath: string): LayoutDocument {
  const result = validateLayout(readJson(relativePath));
  expect(result.ok, result.ok ? "" : result.errors.join("\n")).toBe(true);
  if (!result.ok) {
    throw new Error(result.errors.join("\n"));
  }
  return result.layout;
}

function resolveLength(length: Length, reference: number): number {
  const parsed = parseLength(length);
  return parsed.kind === "percent" ? (reference * parsed.value) / 100 : parsed.value;
}

/** Resolves the rendered square for a button, d-pad or stick. */
function controlBox(control: Control, viewport: Viewport): Box {
  const shortSide = Math.min(viewport.width, viewport.height);
  let edge: number;

  switch (control.type) {
    case "button": {
      const radius = resolveLength(control.r, shortSide);
      edge = control.shape === "circle" ? radius * 2 : radius;
      break;
    }
    case "dpad":
    case "stick":
      edge = resolveLength(control.size, shortSide);
      break;
    default:
      throw new Error(`Coin Run layouts must not use ${control.type} controls`);
  }

  const centerX = resolveLength(control.x, viewport.width);
  const centerY = resolveLength(control.y, viewport.height);
  return {
    left: centerX - edge / 2,
    top: centerY - edge / 2,
    right: centerX + edge / 2,
    bottom: centerY + edge / 2,
    width: edge,
    height: edge,
  };
}

function dpadOf(layout: LayoutDocument): DpadControl {
  const dpad = layout.controls.find(
    (control): control is DpadControl => control.type === "dpad",
  );
  if (dpad === undefined) {
    throw new Error("layout has no d-pad");
  }
  return dpad;
}

function stickOf(layout: LayoutDocument): StickControl {
  const stick = layout.controls.find(
    (control): control is StickControl => control.type === "stick",
  );
  if (stick === undefined) {
    throw new Error("layout has no stick");
  }
  return stick;
}

function buttonOf(layout: LayoutDocument): ButtonControl {
  const button = layout.controls.find(
    (control): control is ButtonControl => control.type === "button",
  );
  if (button === undefined) {
    throw new Error("layout has no button");
  }
  return button;
}

describe("Coin Run layouts", () => {
  test("[FR-8.1] pf-dpad-v1 validates and binds d-pad movement plus jump", () => {
    const layout = validatedLayout("../layouts/pf-dpad-v1.json");
    expect(layout.id).toBe("pf-dpad-v1");
    expect(layout.orientation).toBe("landscape");
    expect(layout.controls).toHaveLength(2);

    const dpad = dpadOf(layout);
    expect(dpad.id).toBe("move");
    expect(dpad.bits).toEqual({ up: 8, down: 9, left: 10, right: 11 });

    const jump = buttonOf(layout);
    expect(jump.id).toBe("jump");
    expect(jump.bit).toBe(0);
    expect(jump.label).toBe("Jump");
  });

  test("[FR-8.1] pf-stick-v1 validates with a floating left stick plus jump", () => {
    const layout = validatedLayout("../layouts/pf-stick-v1.json");
    expect(layout.id).toBe("pf-stick-v1");
    expect(layout.orientation).toBe("landscape");
    expect(layout.controls).toHaveLength(2);

    const stick = stickOf(layout);
    expect(stick.id).toBe("move");
    expect(stick.axis).toBe("left");
    expect(stick.mode).toBe("floating");

    const jump = buttonOf(layout);
    expect(jump.id).toBe("jump");
    expect(jump.bit).toBe(0);
  });

  test("[FR-8.1] display hints survive validation: Jump glyph and Move label", () => {
    const dpadJump = buttonOf(validatedLayout("../layouts/pf-dpad-v1.json")) as ButtonWithSymbol;
    expect(dpadJump.label).toBe("Jump");
    expect(dpadJump.symbol).toBe("↑");

    const stickLayout = validatedLayout("../layouts/pf-stick-v1.json");
    const stick = stickOf(stickLayout) as StickWithLabel;
    expect(stick.label).toBe("Move");

    const stickJump = buttonOf(stickLayout) as ButtonWithSymbol;
    expect(stickJump.label).toBe("Jump");
    expect(stickJump.symbol).toBe("↑");
  });

  test("[FR-8.4] both layouts pass the shared validator with unique bits and channels", () => {
    for (const file of LAYOUT_FILES) {
      const layout = validatedLayout(file);
      for (const owners of controlBitAssignments(layout).values()) {
        expect(owners, file).toHaveLength(1);
      }
      const leftSticks = layout.controls.filter(
        (control) => control.type === "stick" && control.axis === "left",
      );
      expect(leftSticks.length, file).toBeLessThanOrEqual(1);
      expect(layout.sensors, file).toBeUndefined();
    }
  });

  test("[FR-8.4] the validator rejects a layout that binds the left stick channel twice", () => {
    const base = asRecord(readJson("../layouts/pf-stick-v1.json"));
    const controls = base["controls"];
    if (!Array.isArray(controls)) {
      throw new Error("fixture controls must be an array");
    }

    const duplicate = {
      ...base,
      controls: [
        ...controls,
        {
          type: "stick",
          id: "move-copy",
          x: "60%",
          y: "66%",
          size: "30%",
          axis: "left",
          mode: "fixed",
        },
      ],
    };

    const result = validateLayout(duplicate);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    const errors = result.errors.join("\n");
    expect(errors).toContain('channel "lx"/"ly" is already bound');
    expect(errors).toContain('control "move"');
  });

  test("[AR-5] every control meets the 44 px target on landscape phones", () => {
    for (const viewport of [MIN_LANDSCAPE_VIEWPORT, LARGE_LANDSCAPE_VIEWPORT]) {
      for (const file of LAYOUT_FILES) {
        const layout = validatedLayout(file);
        for (const control of layout.controls) {
          const box = controlBox(control, viewport);
          // A d-pad splits its square into four direction sectors, so each
          // sector must clear the touch-target floor on its own.
          const targetEdge = control.type === "dpad" ? box.width / 2 : box.width;

          expect(targetEdge, `${file} ${control.id} target`).toBeGreaterThanOrEqual(
            MIN_TOUCH_TARGET_PX,
          );
          expect(box.left, `${file} ${control.id} left`).toBeGreaterThanOrEqual(0);
          expect(box.top, `${file} ${control.id} top`).toBeGreaterThanOrEqual(0);
          expect(box.right, `${file} ${control.id} right`).toBeLessThanOrEqual(
            viewport.width,
          );
          expect(box.bottom, `${file} ${control.id} bottom`).toBeLessThanOrEqual(
            viewport.height,
          );
        }
      }
    }
  });
});
