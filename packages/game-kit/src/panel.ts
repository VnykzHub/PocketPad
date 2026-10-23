/**
 * Panel, choice and text helpers (spec 24 §2.6; ER-24-06).
 *
 * The helpers own the controller layout swap so a game never hand-writes the
 * same choice/text document. Event names are fixed by the kit
 * (`kit.choice`, `kit.text`, `kit.canvas`) and exported, because the helper
 * signatures take no event-name argument.
 *
 * Nothing here throws into the game loop: malformed arguments are ignored,
 * malformed events are dropped, and host calls are best-effort.
 */
import {
  sanitizeText,
  type GameContext,
  type JsonValue,
  type LayoutDocument,
} from "@lanpad/sdk";
import { isSlot } from "./slots.js";

/** Event names used by kit-generated layouts. */
export const KIT_CHOICE_EVENT = "kit.choice";
export const KIT_TEXT_EVENT = "kit.text";
export const KIT_CANVAS_EVENT = "kit.canvas";

/** Layout ids of the kit-generated documents. */
const CHOICE_LAYOUT_ID = "kit-choice";
const TEXT_LAYOUT_ID = "kit-text";
const PANEL_CONTROL_ID = "kit-panel";
const CHOICE_CONTROL_ID = "kit-choice-input";
const TEXT_CONTROL_ID = "kit-text-input";
const MAX_OPTIONS = 12;
const MAX_LABEL_CHARS = 120;
const MAX_PROMPT_CHARS = 800;

export interface ChoiceOption {
  readonly id: string;
  readonly label: string;
}

export interface TextPrompt {
  readonly prompt: string;
  readonly maxLength: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Runs a host call that may be an unavailable stub; never rethrows. */
function safely(call: () => void): void {
  try {
    call();
  } catch {
    // Panel/layout support is optional on older hosts (game-api availability).
  }
}

function promptContent(prompt: string | undefined): JsonValue | null {
  if (prompt === undefined) {
    return null;
  }
  const text = sanitizeText(prompt, MAX_PROMPT_CHARS);
  return text.length === 0 ? null : { kind: "text", text };
}

function applyPrompt(ctx: GameContext, slot: number, prompt: string | undefined): void {
  const content = promptContent(prompt);
  safely(() => {
    if (content === null) {
      ctx.panels.clear(slot);
    } else {
      ctx.panels.set(slot, content);
    }
  });
}

/**
 * Hot-swaps one slot's layout to a choice control and shows the optional
 * prompt in its private panel. Invalid slots or option lists are ignored.
 */
export function showChoice(
  ctx: GameContext,
  slot: number,
  options: readonly ChoiceOption[],
  prompt?: string,
): void {
  if (!isSlot(slot) || !Array.isArray(options)) {
    return;
  }
  if (options.length < 1 || options.length > MAX_OPTIONS) {
    return;
  }
  const rendered: Array<{ value: string; label: string }> = [];
  const seen = new Set<string>();
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === undefined || typeof option.id !== "string" || option.id.length === 0) {
      return;
    }
    if (seen.has(option.id)) {
      return;
    }
    seen.add(option.id);
    const label = sanitizeText(option.label, MAX_LABEL_CHARS);
    rendered.push({ value: option.id, label: label.length > 0 ? label : option.id });
  }

  const layout: LayoutDocument = {
    id: CHOICE_LAYOUT_ID,
    orientation: "any",
    controls: [
      { type: "panel", id: PANEL_CONTROL_ID, x: "4%", y: "4%", w: "92%", h: "26%" },
      {
        type: "choice",
        id: CHOICE_CONTROL_ID,
        x: "4%",
        y: "34%",
        w: "92%",
        h: "62%",
        event: KIT_CHOICE_EVENT,
        options: rendered,
      },
    ],
  };
  safely(() => ctx.layouts.set(slot, layout));
  applyPrompt(ctx, slot, prompt);
}

/** Hot-swaps one slot's layout to a text input and shows the prompt. */
export function showText(ctx: GameContext, slot: number, prompt: TextPrompt): void {
  if (!isSlot(slot) || !isRecord(prompt)) {
    return;
  }
  const maxLength = prompt.maxLength;
  if (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > 200) {
    return;
  }
  const layout: LayoutDocument = {
    id: TEXT_LAYOUT_ID,
    orientation: "any",
    controls: [
      { type: "panel", id: PANEL_CONTROL_ID, x: "4%", y: "4%", w: "92%", h: "30%" },
      {
        type: "text",
        id: TEXT_CONTROL_ID,
        x: "4%",
        y: "40%",
        w: "92%",
        h: "50%",
        event: KIT_TEXT_EVENT,
        maxLen: maxLength,
      },
    ],
  };
  safely(() => ctx.layouts.set(slot, layout));
  applyPrompt(ctx, slot, prompt.prompt);
}

/** Clears one slot's private panel; invalid slots are ignored. */
export function clearPanel(ctx: GameContext, slot: number): void {
  if (!isSlot(slot)) {
    return;
  }
  safely(() => ctx.panels.clear(slot));
}

/** Subscribes to kit choice taps; malformed payloads are dropped. */
export function onChoice(
  ctx: GameContext,
  handler: (slot: number, optionId: string) => void,
): () => void {
  return subscribe(ctx, KIT_CHOICE_EVENT, (slot, data) => {
    if (isRecord(data) && typeof data["value"] === "string") {
      handler(slot, data["value"]);
    }
  });
}

/** Subscribes to kit text submissions; malformed payloads are dropped. */
export function onText(
  ctx: GameContext,
  handler: (slot: number, text: string) => void,
): () => void {
  return subscribe(ctx, KIT_TEXT_EVENT, (slot, data) => {
    if (isRecord(data) && typeof data["value"] === "string") {
      handler(slot, data["value"]);
    }
  });
}

const STROKE_PHASES: readonly string[] = ["start", "move", "end"];
const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
/** Controller hard cap per batch (D5 contract 5); larger payloads are hostile. */
const MAX_STROKE_POINTS = 512;

/**
 * Subscribes to kit canvas strokes; only a fully valid stroke reaches the
 * handler. The payload is passed through unchanged (no copy).
 */
export function onCanvas(
  ctx: GameContext,
  handler: (slot: number, data: JsonValue) => void,
): () => void {
  return subscribe(ctx, KIT_CANVAS_EVENT, (slot, data) => {
    if (isStrokeData(data)) {
      handler(slot, data);
    }
  });
}

function subscribe(
  ctx: GameContext,
  name: string,
  deliver: (slot: number, data: JsonValue) => void,
): () => void {
  try {
    return ctx.events.on(name, (event) => {
      if (!isSlot(event.slot)) {
        return;
      }
      deliver(event.slot, event.data);
    });
  } catch {
    return () => {};
  }
}

function isStrokeData(value: JsonValue): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const points = value["points"];
  if (!Array.isArray(points) || points.length < 1 || points.length > MAX_STROKE_POINTS) {
    return false;
  }
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (!isRecord(point)) {
      return false;
    }
    const x = point["x"];
    const y = point["y"];
    const t = point["t"];
    if (
      typeof x !== "number" ||
      !Number.isFinite(x) ||
      x < 0 ||
      x > 1 ||
      typeof y !== "number" ||
      !Number.isFinite(y) ||
      y < 0 ||
      y > 1 ||
      typeof t !== "number" ||
      !Number.isFinite(t) ||
      t < 0
    ) {
      return false;
    }
  }
  const color = value["color"];
  const width = value["width"];
  const phase = value["phase"];
  if (typeof color !== "string" || !HEX_COLOR_PATTERN.test(color)) {
    return false;
  }
  if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) {
    return false;
  }
  if (typeof phase !== "string" || !STROKE_PHASES.includes(phase)) {
    return false;
  }
  const count = value["count"];
  return (
    count === undefined ||
    (typeof count === "number" && Number.isInteger(count) && count >= 0)
  );
}
