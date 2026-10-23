/**
 * Bomb Defusal controller layouts (FR-8.1, FR-8.2, FR-8.4, AR-5, C3).
 *
 * Both files are data validated by the same pure `validateLayout` the host and
 * controller run. Geometry resolves lengths exactly as the controller does:
 * `x`/`y` percent against the viewport width/height, `r`/`size` percent
 * against the short side, and `w`/`h` percent against width/height.
 */
import { readFileSync } from "node:fs";
import { KIT_CHOICE_EVENT, KIT_TEXT_EVENT } from "@lanpad/game-kit";
import { describe, expect, test } from "vitest";
import {
  controlBitAssignments,
  parseLength,
  validateLayout,
  type ButtonControl,
  type ChoiceControl,
  type Control,
  type LayoutDocument,
  type Length,
  type PanelControl,
  type TextControl,
} from "@lanpad/sdk";
import { WIRE_COLORS } from "../src/bomb.js";
import { BOMB_CONFIG } from "../src/config.js";
import {
  BD_DEFUSER_LAYOUT_ID,
  BD_MANUAL_LAYOUT_ID,
} from "../src/game.js";

const DEFUSER_LAYOUT = "../layouts/bd-defuser-v1.json";
const MANUAL_LAYOUT = "../layouts/bd-manual-v1.json";
const LAYOUT_FILES = [DEFUSER_LAYOUT, MANUAL_LAYOUT] as const;

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
  return JSON.parse(
    readFileSync(new URL(relativePath, import.meta.url), "utf8"),
  ) as unknown;
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

function panelOf(layout: LayoutDocument): PanelControl {
  const matches = layout.controls.filter(
    (control): control is PanelControl => control.type === "panel",
  );
  expect(matches).toHaveLength(1);
  const panel = matches[0];
  if (panel === undefined) throw new Error("layout has no panel");
  return panel;
}

function choiceOf(layout: LayoutDocument): ChoiceControl {
  const matches = layout.controls.filter(
    (control): control is ChoiceControl => control.type === "choice",
  );
  expect(matches).toHaveLength(1);
  const choice = matches[0];
  if (choice === undefined) throw new Error("layout has no choice control");
  return choice;
}

function textOf(layout: LayoutDocument): TextControl {
  const matches = layout.controls.filter(
    (control): control is TextControl => control.type === "text",
  );
  expect(matches).toHaveLength(1);
  const text = matches[0];
  if (text === undefined) throw new Error("layout has no text control");
  return text;
}

function buttonWithId(layout: LayoutDocument, id: string): ButtonControl {
  const button = layout.controls.find(
    (control): control is ButtonControl =>
      control.type === "button" && control.id === id,
  );
  if (button === undefined) throw new Error(`layout has no button ${id}`);
  return button;
}

function resolveLength(length: Length, reference: number): number {
  const parsed = parseLength(length);
  return parsed.kind === "percent"
    ? (reference * parsed.value) / 100
    : parsed.value;
}

/** Resolves the touch rectangle for the four control types these layouts use. */
function controlBox(control: Control, viewport: Viewport): Box {
  const shortSide = Math.min(viewport.width, viewport.height);
  let width: number;
  let height: number;

  switch (control.type) {
    case "button": {
      const radius = resolveLength(control.r, shortSide);
      const edge = control.shape === "circle" ? radius * 2 : radius;
      width = edge;
      height = edge;
      break;
    }
    case "panel":
    case "choice":
    case "text": {
      width = resolveLength(control.w, viewport.width);
      height = resolveLength(control.h, viewport.height);
      break;
    }
    default:
      throw new Error(
        `Bomb Defusal layouts must not use ${control.type} controls`,
      );
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

describe("Bomb Defusal layouts", () => {
  test("[FR-8.1] bd-defuser-v1 ships the status, wire, button and keypad controls", () => {
    const layout = validatedLayout(DEFUSER_LAYOUT);
    expect(layout.id).toBe(BD_DEFUSER_LAYOUT_ID);
    expect(layout.orientation).toBe("any");
    expect(layout.controls).toHaveLength(4);

    expect(panelOf(layout).id).toBe("status");

    const choice = choiceOf(layout);
    expect(choice.id).toBe("cut-wire");
    expect(choice.event).toBe(KIT_CHOICE_EVENT);
    expect(choice.options).toHaveLength(6);
    expect(choice.options.map((option) => option.value)).toEqual([...WIRE_COLORS]);
    expect(new Set(choice.options.map((option) => option.value)).size).toBe(6);
    for (const option of choice.options) {
      expect(option.label.length).toBeGreaterThan(0);
    }

    const button = buttonWithId(layout, "hold-button");
    expect(button.bit).toBe(BOMB_CONFIG.buttonBit);
    expect(button.label).toBe("HOLD");
    expect(button.shape).toBe("circle");

    const text = textOf(layout);
    expect(text.id).toBe("keypad");
    expect(text.event).toBe(KIT_TEXT_EVENT);
    expect(text.maxLen).toBe(4);
  });

  test("[FR-8.1][C3] bd-manual-v1 is a private panel with PREV and NEXT", () => {
    const layout = validatedLayout(MANUAL_LAYOUT);
    expect(layout.id).toBe(BD_MANUAL_LAYOUT_ID);
    expect(layout.orientation).toBe("any");
    expect(layout.controls).toHaveLength(3);

    expect(panelOf(layout).id).toBe("manual");

    const prev = buttonWithId(layout, "prev-page");
    const next = buttonWithId(layout, "next-page");
    expect(prev.bit).toBe(BOMB_CONFIG.prevBit);
    expect(next.bit).toBe(BOMB_CONFIG.nextBit);
    expect(prev.label).toBe("PREV");
    expect(next.label).toBe("NEXT");

    // The reader's phone must not carry the defuser's action controls.
    expect(
      layout.controls.some(
        (control) => control.type === "choice" || control.type === "text",
      ),
    ).toBe(false);
  });

  test("[FR-8.4] both layouts validate with unique ids and button bits", () => {
    for (const file of LAYOUT_FILES) {
      const layout = validatedLayout(file);
      const ids = new Set(layout.controls.map((control) => control.id));
      expect(ids.size, file).toBe(layout.controls.length);
      for (const [bit, owners] of controlBitAssignments(layout)) {
        expect(owners, `${file} bit ${bit}`).toHaveLength(1);
      }
    }
  });

  test("[FR-8.4] the validator rejects a layout that reuses a button bit", () => {
    const base = asRecord(readJson(MANUAL_LAYOUT));
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
          id: "prev-copy",
          x: "50%",
          y: "50%",
          r: "8%",
          bit: BOMB_CONFIG.prevBit,
          label: "COPY",
          shape: "circle",
        },
      ],
    };

    const result = validateLayout(duplicate);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const errors = result.errors.join("\n");
    expect(errors).toContain("bit 0 is already assigned");
    expect(errors).toContain('"prev-page"');
  });

  test("[AR-5] every control clears 44 px and stays on screen on phones", () => {
    const viewports: readonly Viewport[] = [
      { width: 568, height: 320 },
      { width: 640, height: 360 },
      { width: 360, height: 640 },
    ];

    for (const viewport of viewports) {
      for (const file of LAYOUT_FILES) {
        const layout = validatedLayout(file);
        for (const control of layout.controls) {
          const box = controlBox(control, viewport);
          const label = `${file} ${control.id} at ${viewport.width}x${viewport.height}`;
          expect(box.width, `${label} width`).toBeGreaterThanOrEqual(44);
          expect(box.height, `${label} height`).toBeGreaterThanOrEqual(44);
          expect(box.left, `${label} left`).toBeGreaterThanOrEqual(0);
          expect(box.top, `${label} top`).toBeGreaterThanOrEqual(0);
          expect(box.right, `${label} right`).toBeLessThanOrEqual(viewport.width);
          expect(box.bottom, `${label} bottom`).toBeLessThanOrEqual(viewport.height);
        }
      }
    }
  });
});
