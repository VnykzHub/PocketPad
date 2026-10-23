/**
 * Beat Tap layout contract (GAME-BT-DATA-02; FR-8.1, FR-8.4, AR-5).
 *
 * All five documents are data files validated by the same pure validator the
 * host and controller run. Geometry is resolved the way the controller does:
 * percent `x`/`y` against width/height, percent `r`/`size` against the short
 * side. The lane documents share bit 15 as the calibration button; the d-pad
 * uses the frozen arrow bits 8..11.
 */
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
} from "../../../../sdk/src/index";

const LAYOUT_FILES = [
  "../layouts/bt-lanes-v1.json",
  "../layouts/bt-duo-v1.json",
  "../layouts/bt-solo-v1.json",
  "../layouts/bt-dpad-v1.json",
  "../layouts/bt-calibrate-v1.json",
] as const;

const LANE_FILES = LAYOUT_FILES.slice(0, 4);

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

/** Resolves the rendered square for a button or d-pad. */
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
      edge = resolveLength(control.size, shortSide);
      break;
    default:
      throw new Error(`Beat Tap layouts must not use ${control.type} controls`);
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

/** Every protocol bit a layout binds, sorted ascending. */
function bitsOf(layout: LayoutDocument): number[] {
  const bits: number[] = [];
  for (const control of layout.controls) {
    if (control.type === "button") {
      bits.push(control.bit);
    } else if (control.type === "dpad") {
      bits.push(control.bits.up, control.bits.down, control.bits.left, control.bits.right);
    }
  }
  bits.sort((a, b) => a - b);
  return bits;
}

function buttonsOf(layout: LayoutDocument): ButtonControl[] {
  return layout.controls.filter(
    (control): control is ButtonControl => control.type === "button",
  );
}

describe("Beat Tap layouts", () => {
  test("[FR-8.1] all five shipped layouts validate and are landscape", () => {
    for (const file of LAYOUT_FILES) {
      const layout = validatedLayout(file);
      expect(layout.orientation, file).toBe("landscape");
      expect(layout.controls.length, file).toBeGreaterThan(0);
      expect(layout.controls.length, file).toBeLessThanOrEqual(24);
    }
  });

  test("[FR-8.1] the lane documents bind the documented bits", () => {
    expect(bitsOf(validatedLayout("../layouts/bt-lanes-v1.json"))).toEqual([0, 1, 2, 3, 15]);
    expect(bitsOf(validatedLayout("../layouts/bt-duo-v1.json"))).toEqual([0, 1, 15]);
    expect(bitsOf(validatedLayout("../layouts/bt-solo-v1.json"))).toEqual([0, 15]);
    expect(bitsOf(validatedLayout("../layouts/bt-dpad-v1.json"))).toEqual([8, 9, 10, 11, 15]);
    expect(bitsOf(validatedLayout("../layouts/bt-calibrate-v1.json"))).toEqual([0, 15]);
  });

  test("[FR-8.1] every lane layout offers the calibration button on bit 15", () => {
    for (const file of LANE_FILES) {
      const layout = validatedLayout(file);
      const calibrate = buttonsOf(layout).find((control) => control.bit === 15);
      expect(calibrate, file).toBeDefined();
      expect(calibrate?.label, file).toBe("CAL");
    }
  });

  test("[FR-8.1] the d-pad family maps up/down/left/right to bits 8..11", () => {
    const layout = validatedLayout("../layouts/bt-dpad-v1.json");
    const dpad = layout.controls.find(
      (control): control is DpadControl => control.type === "dpad",
    );
    expect(dpad).toBeDefined();
    expect(dpad?.bits).toEqual({ up: 8, down: 9, left: 10, right: 11 });
  });

  test("[FR-8.1] the calibration document is one tap button and one cancel", () => {
    const layout = validatedLayout("../layouts/bt-calibrate-v1.json");
    const buttons = buttonsOf(layout);
    expect(buttons).toHaveLength(2);
    expect(buttons.find((control) => control.bit === 0)?.label).toBe("TAP");
    expect(buttons.find((control) => control.bit === 15)?.label).toBe("Cancel");
  });

  test("[FR-8.4] all five pass the shared validator with unique bit owners", () => {
    for (const file of LAYOUT_FILES) {
      const layout = validatedLayout(file);
      for (const owners of controlBitAssignments(layout).values()) {
        expect(owners, file).toHaveLength(1);
      }
      expect(layout.sensors, file).toBeUndefined();
    }
  });

  test("[FR-8.4] the validator rejects two controls binding the same bit", () => {
    const base = asRecord(readJson("../layouts/bt-lanes-v1.json"));
    const controls = base["controls"];
    if (!Array.isArray(controls)) {
      throw new Error("fixture controls must be an array");
    }
    const duplicate = {
      ...base,
      controls: [
        ...controls,
        {
          type: "button",
          id: "lane-1-copy",
          x: "50%",
          y: "50%",
          label: "Copy",
          shape: "circle",
          r: "8%",
          bit: 0,
        },
      ],
    };
    const result = validateLayout(duplicate);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors.join("\n")).toContain("bit 0 is already assigned to control");
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
