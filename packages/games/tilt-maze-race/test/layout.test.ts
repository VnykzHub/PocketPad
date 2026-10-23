import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  parseLength,
  validateLayout,
  type Control,
  type GyroControl,
  type LayoutDocument,
  type Length,
  type PanelControl,
  type StickControl,
} from "../../../../sdk/src/index";

/**
 * Tilt Maze Race layout contract (GAME-TM-CTRL-01/02/03; FR-8.1, FR-8.4,
 * FR-8.5, FR-8.10, AR-5).
 *
 * Both layouts are data validated by the same pure validator the host and
 * controller run. Geometry is resolved as the controller does: `x`/`y` are
 * centers as viewport percentages, a stick's `size` is a percentage of the
 * short side, panels use viewport percentages, and the gyro prompt is a fixed
 * 168x44 px pill.
 */

const TILT_LAYOUT_FILE = "../layouts/tm-tilt-v1.json";
const STICK_LAYOUT_FILE = "../layouts/tm-stick-v1.json";
const MIN_LANDSCAPE_VIEWPORT = { width: 568, height: 320 } as const;
const MIN_PORTRAIT_VIEWPORT = { width: 320, height: 568 } as const;
const MIN_TOUCH_TARGET_PX = 44;
const GYRO_WIDTH_PX = 168;
const GYRO_HEIGHT_PX = 44;

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

function controlBox(control: Control, viewport: Viewport): Box {
  const shortSide = Math.min(viewport.width, viewport.height);
  let width: number;
  let height: number;

  switch (control.type) {
    case "gyro": {
      width = GYRO_WIDTH_PX;
      height = GYRO_HEIGHT_PX;
      break;
    }
    case "stick": {
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
      throw new Error(`Tilt Maze Race layouts must not use ${control.type} controls`);
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

function controlOf<T extends Control["type"]>(
  layout: LayoutDocument,
  type: T,
): Extract<Control, { type: T }> {
  const control = layout.controls.find(
    (candidate): candidate is Extract<Control, { type: T }> => candidate.type === type,
  );
  if (control === undefined) {
    throw new Error(`layout has no ${type} control`);
  }
  return control;
}

function overlap(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

describe("Tilt Maze Race layouts", () => {
  test("[FR-8.1][FR-8.4][FR-8.5] tm-tilt-v1 validates with gyro, stick and status panel", () => {
    const layout = validatedLayout(TILT_LAYOUT_FILE);
    expect(layout.id).toBe("tm-tilt-v1");
    expect(layout.orientation).toBe("any");
    expect(layout.controls).toHaveLength(3);

    const gyro: GyroControl = controlOf(layout, "gyro");
    expect(gyro.id).toBe("tilt");
    const stick: StickControl = controlOf(layout, "stick");
    expect(stick.id).toBe("move");
    expect(stick.axis).toBe("left");
    expect(stick.deadzone).toBe(0.08);
    const panel: PanelControl = controlOf(layout, "panel");
    expect(panel.id).toBe("status");

    expect(layout.sensors).toEqual({ gyro: "tilt", sensitivity: 1.2, smoothing: 0.12 });
  });

  test("[FR-8.10] the gyro layout carries a stick fallback; the stick layout needs none", () => {
    const tilt = validatedLayout(TILT_LAYOUT_FILE);
    expect(tilt.controls.some((control) => control.type === "stick")).toBe(true);

    const stickOnly = validatedLayout(STICK_LAYOUT_FILE);
    expect(stickOnly.id).toBe("tm-stick-v1");
    expect(stickOnly.orientation).toBe("any");
    expect(stickOnly.controls).toHaveLength(2);
    expect(stickOnly.controls.some((control) => control.type === "gyro")).toBe(false);
    expect(stickOnly.sensors).toBeUndefined();
  });

  test("[FR-8.10] the validator rejects a gyro layout with no non-gyro fallback", () => {
    const base = asRecord(readJson(TILT_LAYOUT_FILE));
    const controls = base["controls"];
    if (!Array.isArray(controls)) {
      throw new Error("fixture controls must be an array");
    }
    const withoutStick = {
      ...base,
      controls: controls.filter(
        (control) =>
          typeof control !== "object" ||
          control === null ||
          (control as Record<string, unknown>)["type"] !== "stick",
      ),
    };

    const result = validateLayout(withoutStick);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors.join("\n")).toContain("non-gyro fallback");
  });

  test("[AR-5] every control meets the 44 px target on landscape and portrait phones", () => {
    for (const relativePath of [TILT_LAYOUT_FILE, STICK_LAYOUT_FILE]) {
      const layout = validatedLayout(relativePath);
      for (const viewport of [MIN_LANDSCAPE_VIEWPORT, MIN_PORTRAIT_VIEWPORT]) {
        for (const control of layout.controls) {
          const box = controlBox(control, viewport);
          expect(box.width, `${layout.id}/${control.id} width`).toBeGreaterThanOrEqual(
            MIN_TOUCH_TARGET_PX,
          );
          expect(box.height, `${layout.id}/${control.id} height`).toBeGreaterThanOrEqual(
            MIN_TOUCH_TARGET_PX,
          );
          expect(box.left, `${layout.id}/${control.id} left`).toBeGreaterThanOrEqual(0);
          expect(box.top, `${layout.id}/${control.id} top`).toBeGreaterThanOrEqual(0);
          expect(box.right, `${layout.id}/${control.id} right`).toBeLessThanOrEqual(
            viewport.width,
          );
          expect(box.bottom, `${layout.id}/${control.id} bottom`).toBeLessThanOrEqual(
            viewport.height,
          );
        }
      }
    }
  });

  test("[AR-5] controls never overlap in either layout", () => {
    for (const relativePath of [TILT_LAYOUT_FILE, STICK_LAYOUT_FILE]) {
      const layout = validatedLayout(relativePath);
      for (const viewport of [MIN_LANDSCAPE_VIEWPORT, MIN_PORTRAIT_VIEWPORT]) {
        for (let left = 0; left < layout.controls.length; left += 1) {
          for (let right = left + 1; right < layout.controls.length; right += 1) {
            const a = layout.controls[left];
            const b = layout.controls[right];
            if (a === undefined || b === undefined) continue;
            expect(
              overlap(controlBox(a, viewport), controlBox(b, viewport)),
              `${layout.id}: ${a.id} overlaps ${b.id}`,
            ).toBe(false);
          }
        }
      }
    }
  });
});
