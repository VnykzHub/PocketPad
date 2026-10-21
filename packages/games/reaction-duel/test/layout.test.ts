import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  parseLength,
  validateLayout,
  type ButtonControl,
  type LayoutDocument,
  type Length,
} from "../../../../sdk/src/index";

/** Display hint carried by the layout; the SDK preserves unknown fields. */
type ButtonWithSymbol = ButtonControl & { symbol?: string };

/**
 * Smallest controller viewport this scaffold supports. The SPEC does not set a
 * minimum, so the layout is verified against a 320x568 CSS px phone baseline.
 */
const MIN_VIEWPORT = { width: 320, height: 568 } as const;
const MIN_TOUCH_TARGET_PX = 44;

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8"));
}

function validatedLayout(): LayoutDocument {
  const result = validateLayout(readJson("../layouts/rd-four-button-v1.json"));
  expect(result.ok, result.ok ? "" : result.errors.join("\n")).toBe(true);
  if (!result.ok) {
    throw new Error(result.errors.join("\n"));
  }
  return result.layout;
}

function buttonsOf(layout: LayoutDocument): ButtonWithSymbol[] {
  const buttons: ButtonWithSymbol[] = [];
  for (const control of layout.controls) {
    if (control.type === "button") {
      buttons.push(control);
    }
  }
  return buttons;
}

function resolveLength(length: Length, reference: number): number {
  const parsed = parseLength(length);
  return parsed.kind === "percent" ? (reference * parsed.value) / 100 : parsed.value;
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function buttonBox(
  button: ButtonControl,
  viewport: { width: number; height: number },
): Box {
  const sizePx = resolveLength(button.r, Math.min(viewport.width, viewport.height));
  const edge = button.shape === "circle" ? sizePx * 2 : sizePx;
  const centerX = resolveLength(button.x, viewport.width);
  const centerY = resolveLength(button.y, viewport.height);
  return {
    left: centerX - edge / 2,
    top: centerY - edge / 2,
    right: centerX + edge / 2,
    bottom: centerY + edge / 2,
  };
}

describe("rd-four-button-v1", () => {
  test("[FR-8.1] shipped layout validates and uses only v1 button controls", () => {
    const result = validateLayout(readJson("../layouts/rd-four-button-v1.json"));
    expect(result.ok, result.ok ? "" : result.errors.join("\n")).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.layout.controls).toHaveLength(4);
    for (const control of result.layout.controls) {
      expect(control.type).toBe("button");
    }
  });

  test("[A12] four distinct A/B/X/Y buttons occupy protocol bits 0-3", () => {
    const buttons = buttonsOf(validatedLayout());
    expect(buttons).toHaveLength(4);
    expect(buttons.map((button) => button.bit).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    expect(buttons.map((button) => button.label).sort()).toEqual(["A", "B", "X", "Y"]);
    expect(new Set(buttons.map((button) => button.id)).size).toBe(4);

    const symbols = buttons.map((button) => button.symbol);
    for (const symbol of symbols) {
      expect(typeof symbol).toBe("string");
      expect(symbol?.length ?? 0).toBeGreaterThan(0);
    }
    expect(new Set(symbols).size).toBe(4);
  });

  test("[A12] buttons form a 2x2 grid", () => {
    const buttons = buttonsOf(validatedLayout());
    const columns = new Set(buttons.map((button) => button.x));
    const rows = new Set(buttons.map((button) => button.y));
    expect(columns.size).toBe(2);
    expect(rows.size).toBe(2);
    const cells = new Set(buttons.map((button) => `${button.x}|${button.y}`));
    expect(cells.size).toBe(4);
  });

  test("[A12] config selects fourButton mode and the documented timing", () => {
    const config = readJson("../config.json") as Record<string, unknown>;
    expect(config).toEqual({
      mode: "fourButton",
      buttons: ["A", "B", "X", "Y"],
      roundsToWin: 3,
      minDelayMs: 2000,
      maxDelayMs: 6000,
      noTapTimeoutMs: 3000,
      tieThresholdMs: 1,
    });
  });

  test("[FR-8.3] every button resolves to at least 44 px at the smallest viewport", () => {
    for (const button of buttonsOf(validatedLayout())) {
      const box = buttonBox(button, MIN_VIEWPORT);
      expect(box.right - box.left).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      expect(box.bottom - box.top).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(MIN_VIEWPORT.width);
      expect(box.bottom).toBeLessThanOrEqual(MIN_VIEWPORT.height);
    }
  });

  test("[G5] all four buttons are independently tappable with no gyro needed", () => {
    const layout = validatedLayout();
    expect(layout.sensors).toBeUndefined();
    expect(layout.controls.every((control) => control.type === "button")).toBe(true);

    const manifest = readJson("../game.manifest.json") as Record<string, unknown>;
    expect(manifest.needsGyro).toBe(false);

    const boxes = buttonsOf(layout).map((button) => buttonBox(button, MIN_VIEWPORT));
    for (let first = 0; first < boxes.length; first += 1) {
      for (let second = first + 1; second < boxes.length; second += 1) {
        const a = boxes[first] as Box;
        const b = boxes[second] as Box;
        const overlapX = a.left < b.right && b.left < a.right;
        const overlapY = a.top < b.bottom && b.top < a.bottom;
        expect(overlapX && overlapY).toBe(false);
      }
    }
  });
});
