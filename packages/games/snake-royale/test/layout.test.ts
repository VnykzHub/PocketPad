import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  controlBitAssignments,
  parseLength,
  validateLayout,
  type Control,
  type DpadControl,
  type LayoutDocument,
  type Length,
  type PanelControl,
} from "../../../../sdk/src/index";
import { SNAKE_DPAD_BITS } from "../src/config.js";

/**
 * Snake Royale layout contract (GAME-SR-CTRL-01; FR-8.1, FR-8.4, AR-5).
 *
 * `snake-dpad-v1` is data validated by the same pure validator the host and
 * controller run. Geometry is resolved exactly as the controller does: `x`/`y`
 * are centers as viewport percentages, `size` is a percentage of the short
 * side, and `w`/`h` are viewport percentages.
 */

const LAYOUT_FILE = "../layouts/snake-dpad-v1.json";
const MIN_LANDSCAPE_VIEWPORT = { width: 568, height: 320 } as const;
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

function validatedLayout(): LayoutDocument {
  const result = validateLayout(readJson(LAYOUT_FILE));
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

function controlBox(control: Control, viewport: Viewport): Box {
  const shortSide = Math.min(viewport.width, viewport.height);
  let width: number;
  let height: number;

  switch (control.type) {
    case "dpad": {
      const edge = resolveLength(control.size, shortSide);
      width = edge;
      height = edge;
      break;
    }
    case "panel": {
      width = resolveLength(control.w, viewport.width);
      height = resolveLength(control.h, viewport.height);
      break;
    }
    default:
      throw new Error(`Snake Royale layouts must not use ${control.type} controls`);
  }

  const centerX = resolveLength(control.x, viewport.width);
  const centerY = resolveLength(control.y, viewport.height);
  return {
    left: centerX - width / 2,
    top: centerY - height / 2,
    right: centerX + width / 2,
    bottom: centerY + height / 2,
    width,
    height,
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

function panelOf(layout: LayoutDocument): PanelControl {
  const panel = layout.controls.find(
    (control): control is PanelControl => control.type === "panel",
  );
  if (panel === undefined) {
    throw new Error("layout has no private panel");
  }
  return panel;
}

describe("Snake Royale layout", () => {
  test("[FR-8.1][FR-8.4] snake-dpad-v1 validates with a d-pad and a private panel", () => {
    const layout = validatedLayout();
    expect(layout.id).toBe("snake-dpad-v1");
    expect(layout.orientation).toBe("landscape");
    expect(layout.controls).toHaveLength(2);

    const dpad = dpadOf(layout);
    expect(dpad.id).toBe("move");
    expect(dpad.bits).toEqual(SNAKE_DPAD_BITS);
    expect(dpad.bits).toEqual({ up: 8, down: 9, left: 10, right: 11 });

    const panel = panelOf(layout);
    expect(panel.id).toBe("status");
    expect(panel.w).toBe("92%");
    expect(panel.h).toBe("24%");
  });

  test("[FR-8.4] the d-pad binds four unique bits and the layout needs no sensors", () => {
    const layout = validatedLayout();
    const assignments = controlBitAssignments(layout);
    expect(assignments.size).toBe(4);
    for (const owners of assignments.values()) {
      expect(owners).toHaveLength(1);
    }
    expect(layout.sensors).toBeUndefined();
  });

  test("[FR-8.4] the validator rejects a second d-pad binding the same bits", () => {
    const base = asRecord(readJson(LAYOUT_FILE));
    const controls = base["controls"];
    if (!Array.isArray(controls)) {
      throw new Error("fixture controls must be an array");
    }

    const duplicate = {
      ...base,
      controls: [
        ...controls,
        {
          type: "dpad",
          id: "move-copy",
          x: "80%",
          y: "66%",
          size: "20%",
          bits: { up: 8, down: 9, left: 10, right: 11 },
        },
      ],
    };

    const result = validateLayout(duplicate);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors.join("\n")).toContain("8");
  });

  test("[AR-5] every control meets the 44 px target on landscape phones", () => {
    const layout = validatedLayout();
    for (const viewport of [MIN_LANDSCAPE_VIEWPORT, LARGE_LANDSCAPE_VIEWPORT]) {
      for (const control of layout.controls) {
        const box = controlBox(control, viewport);
        // A d-pad splits its square into four direction sectors, so each
        // sector must clear the touch-target floor on its own.
        const targetEdge =
          control.type === "dpad" ? Math.min(box.width, box.height) / 2 : box.width;
        const targetHeight = control.type === "dpad" ? box.height / 2 : box.height;

        expect(targetEdge, `${control.id} width`).toBeGreaterThanOrEqual(
          MIN_TOUCH_TARGET_PX,
        );
        expect(targetHeight, `${control.id} height`).toBeGreaterThanOrEqual(
          MIN_TOUCH_TARGET_PX,
        );
        expect(box.left, `${control.id} left`).toBeGreaterThanOrEqual(0);
        expect(box.top, `${control.id} top`).toBeGreaterThanOrEqual(0);
        expect(box.right, `${control.id} right`).toBeLessThanOrEqual(viewport.width);
        expect(box.bottom, `${control.id} bottom`).toBeLessThanOrEqual(viewport.height);
      }
    }
  });

  test("[AR-5] the private panel and the d-pad never overlap", () => {
    const layout = validatedLayout();
    for (const viewport of [MIN_LANDSCAPE_VIEWPORT, LARGE_LANDSCAPE_VIEWPORT]) {
      const panel = controlBox(panelOf(layout), viewport);
      const dpad = controlBox(dpadOf(layout), viewport);
      const overlaps =
        panel.left < dpad.right &&
        dpad.left < panel.right &&
        panel.top < dpad.bottom &&
        dpad.top < panel.bottom;
      expect(overlaps).toBe(false);
    }
  });
});
