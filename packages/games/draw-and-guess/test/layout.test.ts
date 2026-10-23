/**
 * Controller layout acceptance (FR-8.1, FR-8.4, AR-5, GAME-DG-CTRL-01/03/05).
 *
 * Layouts are data the host registers by id. These tests validate each file,
 * check the role split (canvas for the drawer, text for guessers, a rematch
 * choice for final results) and keep every control inside small portrait
 * viewports with 44 px touch targets.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  validateLayout,
  type CanvasControl,
  type ChoiceControl,
  type Control,
  type LayoutDocument,
  type PanelControl,
  type TextControl,
} from "@lanpad/sdk";

const PACKAGE_ROOT = new URL("../", import.meta.url);
const LAYOUT_FILES = [
  "layouts/dg-drawer-v1.json",
  "layouts/dg-guesser-v1.json",
  "layouts/dg-results-v1.json",
] as const;
const VIEWPORTS = [
  [320, 568],
  [360, 640],
  [390, 844],
] as const;

type SizedControl = PanelControl | CanvasControl | TextControl | ChoiceControl;

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(new URL(relativePath, PACKAGE_ROOT), "utf8"));
}

function loadLayout(relativePath: string): LayoutDocument {
  const result = validateLayout(readJson(relativePath));
  if (!result.ok) throw new Error(`${relativePath}: ${result.errors.join("; ")}`);
  return result.layout;
}

function isSizedControl(control: Control): control is SizedControl {
  return (
    control.type === "panel" ||
    control.type === "canvas" ||
    control.type === "text" ||
    control.type === "choice"
  );
}

function percent(value: number | string, axis: number): number {
  return typeof value === "number" ? value : (Number.parseFloat(value) / 100) * axis;
}

interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

/** Layout coordinates are viewport-percentage centres, w/h are extents. */
function boxFor(control: SizedControl, viewportWidth: number, viewportHeight: number): Box {
  const width = percent(control.w, viewportWidth);
  const height = percent(control.h, viewportHeight);
  const centerX = percent(control.x, viewportWidth);
  const centerY = percent(control.y, viewportHeight);
  return {
    left: centerX - width / 2,
    top: centerY - height / 2,
    right: centerX + width / 2,
    bottom: centerY + height / 2,
    width,
    height,
  };
}

function findCanvas(layout: LayoutDocument): CanvasControl | undefined {
  return layout.controls.find((control): control is CanvasControl => control.type === "canvas");
}

function findText(layout: LayoutDocument): TextControl | undefined {
  return layout.controls.find((control): control is TextControl => control.type === "text");
}

function findChoice(layout: LayoutDocument): ChoiceControl | undefined {
  return layout.controls.find((control): control is ChoiceControl => control.type === "choice");
}

function findPanel(layout: LayoutDocument): PanelControl | undefined {
  return layout.controls.find((control): control is PanelControl => control.type === "panel");
}

describe("Draw and Guess layouts", () => {
  test("[FR-8.1][GAME-DG-CTRL-01] the drawer gets a 70% canvas and a private word panel", () => {
    const layout = loadLayout("layouts/dg-drawer-v1.json");
    expect(layout.id).toBe("dg-drawer-v1");
    expect(layout.orientation).toBe("portrait");
    expect(layout.controls).toHaveLength(2);

    const canvas = findCanvas(layout);
    expect(canvas).toBeDefined();
    if (canvas === undefined) throw new Error("drawer layout has no canvas");
    expect(canvas.id).toBe("draw");
    expect(canvas.event).toBe("kit.canvas");
    expect(canvas.maxStrokePoints).toBe(512);

    const canvasBox = boxFor(canvas, 360, 640);
    expect(canvasBox.width).toBeCloseTo(345.6, 1);
    expect(canvasBox.height).toBeCloseTo(448, 1);
    expect(canvasBox.height / 640).toBeGreaterThanOrEqual(0.6);

    const panel = findPanel(layout);
    expect(panel).toBeDefined();
    if (panel === undefined) throw new Error("drawer layout has no word panel");
    expect(panel.id).toBe("word");
    expect("event" in panel).toBe(false);
    expect(boxFor(panel, 360, 640).bottom).toBeLessThan(canvasBox.top);
  });

  test("[FR-8.1][FR-8.4][AR-5][GAME-DG-CTRL-03] the guesser gets a 60-character text input", () => {
    const layout = loadLayout("layouts/dg-guesser-v1.json");
    expect(layout.id).toBe("dg-guesser-v1");
    expect(layout.controls).toHaveLength(2);
    expect(findCanvas(layout)).toBeUndefined();

    const text = findText(layout);
    expect(text).toBeDefined();
    if (text === undefined) throw new Error("guesser layout has no text control");
    expect(text.id).toBe("guess");
    expect(text.event).toBe("kit.text");
    expect(text.maxLen).toBe(60);

    const box = boxFor(text, 320, 568);
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);

    const panel = findPanel(layout);
    expect(panel).toBeDefined();
    if (panel === undefined) throw new Error("guesser layout has no status panel");
    expect(panel.id).toBe("status");
    expect(boxFor(panel, 320, 568).bottom).toBeLessThan(box.top);
  });

  test("[FR-8.2][AR-5][GAME-DG-CTRL-05] final results expose a remote-operable rematch choice", () => {
    const layout = loadLayout("layouts/dg-results-v1.json");
    expect(layout.id).toBe("dg-results-v1");
    expect(layout.controls).toHaveLength(2);

    const choice = findChoice(layout);
    expect(choice).toBeDefined();
    if (choice === undefined) throw new Error("results layout has no choice control");
    expect(choice.id).toBe("actions");
    expect(choice.event).toBe("kit.choice");
    expect(choice.options).toEqual([{ value: "rematch", label: "Play again" }]);

    const box = boxFor(choice, 320, 568);
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);

    const panel = findPanel(layout);
    expect(panel).toBeDefined();
    if (panel === undefined) throw new Error("results layout has no standings panel");
    expect(panel.id).toBe("standings");
    expect(boxFor(panel, 320, 568).bottom).toBeLessThan(box.top);
  });

  test("[FR-8.1][GAME-DG-CTRL-03] all controls stay inside small portrait viewports", () => {
    for (const relativePath of LAYOUT_FILES) {
      const layout = loadLayout(relativePath);
      expect(layout.controls.length).toBeLessThanOrEqual(24);
      const ids = new Set<string>();

      for (const control of layout.controls) {
        expect(isSizedControl(control)).toBe(true);
        if (!isSizedControl(control)) continue;
        expect(ids.has(control.id)).toBe(false);
        ids.add(control.id);
        if (
          typeof control.x !== "string" ||
          typeof control.y !== "string" ||
          typeof control.w !== "string" ||
          typeof control.h !== "string"
        ) {
          throw new Error(`${relativePath}:${control.id} must use percentage lengths`);
        }
        expect(control.x.endsWith("%")).toBe(true);
        expect(control.y.endsWith("%")).toBe(true);
        expect(control.w.endsWith("%")).toBe(true);
        expect(control.h.endsWith("%")).toBe(true);

        for (const [viewportWidth, viewportHeight] of VIEWPORTS) {
          const box = boxFor(control, viewportWidth, viewportHeight);
          expect(box.left).toBeGreaterThanOrEqual(-0.5);
          expect(box.top).toBeGreaterThanOrEqual(-0.5);
          expect(box.right).toBeLessThanOrEqual(viewportWidth + 0.5);
          expect(box.bottom).toBeLessThanOrEqual(viewportHeight + 0.5);
        }
      }
    }
  });
});
