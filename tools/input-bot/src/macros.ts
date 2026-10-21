/**
 * Macro compilation for the input bot (D0-TOOL-01).
 *
 * Macros are a JSON array of timed actions so D4 and D7 can reuse the same
 * files for regression scenarios. Validation is strict and field-level: a bad
 * macro names the exact path that failed.
 */
import { BUTTON_BITS } from "@lanpad/protocol";

export type MacroButton = keyof typeof BUTTON_BITS;

export interface PressAction {
  atMs: number;
  type: "press";
  buttons: MacroButton[];
}

export interface ReleaseAction {
  atMs: number;
  type: "release";
  buttons: MacroButton[];
}

export interface AxisAction {
  atMs: number;
  type: "axis";
  lx?: number;
  ly?: number;
  rx?: number;
  ry?: number;
}

export type MacroAction = PressAction | ReleaseAction | AxisAction;

const AXIS_FIELDS = ["lx", "ly", "rx", "ry"] as const;

const KNOWN_BUTTONS = new Set<string>(Object.keys(BUTTON_BITS));

/** Thrown when a macro document fails validation; `path` points at the field. */
export class MacroError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "MacroError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampI16(value: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(value)));
}

function requireAtMs(record: Record<string, unknown>, path: string): number {
  const atMs = record["atMs"];
  if (typeof atMs !== "number" || !Number.isFinite(atMs)) {
    throw new MacroError(`${path}.atMs`, "must be a finite number of milliseconds");
  }
  if (atMs < 0) {
    throw new MacroError(`${path}.atMs`, `must be >= 0 (got ${atMs})`);
  }
  return atMs;
}

function parseButtons(record: Record<string, unknown>, path: string): MacroButton[] {
  const raw = record["buttons"];
  const field = `${path}.buttons`;
  if (!Array.isArray(raw)) {
    throw new MacroError(field, "must be an array of button names");
  }
  if (raw.length === 0) {
    throw new MacroError(field, "must name at least one button");
  }
  const buttons: MacroButton[] = [];
  raw.forEach((value, index) => {
    if (typeof value !== "string" || !KNOWN_BUTTONS.has(value)) {
      throw new MacroError(
        `${field}[${index}]`,
        `unknown button ${JSON.stringify(value)}; expected one of ${[...KNOWN_BUTTONS].join(", ")}`,
      );
    }
    const button = value as MacroButton;
    if (!buttons.includes(button)) buttons.push(button);
  });
  return buttons;
}

function parseAxis(record: Record<string, unknown>, path: string): AxisAction {
  const action: AxisAction = { atMs: requireAtMs(record, path), type: "axis" };
  let axes = 0;
  for (const field of AXIS_FIELDS) {
    const value = record[field];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new MacroError(`${path}.${field}`, "must be a finite i16 number");
    }
    action[field] = clampI16(value);
    axes += 1;
  }
  if (axes === 0) {
    throw new MacroError(path, `axis action needs at least one of ${AXIS_FIELDS.join(", ")}`);
  }
  return action;
}

function rejectUnknownFields(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new MacroError(`${path}.${key}`, "unknown field");
    }
  }
}

const PRESS_FIELDS = new Set(["atMs", "type", "buttons"]);
const AXIS_FIELDS_SET = new Set<string>(["atMs", "type", ...AXIS_FIELDS]);

/** Validates and normalises a parsed JSON macro document. Actions are sorted by time. */
export function parseMacros(value: unknown, source = "macro"): MacroAction[] {
  if (!Array.isArray(value)) {
    throw new MacroError(source, "must be a JSON array of actions");
  }

  const actions: MacroAction[] = value.map((item, index) => {
    const path = `${source}[${index}]`;
    if (!isRecord(item)) {
      throw new MacroError(path, "must be an object");
    }
    const type = item["type"];
    if (type === "press" || type === "release") {
      rejectUnknownFields(item, PRESS_FIELDS, path);
      return { atMs: requireAtMs(item, path), type, buttons: parseButtons(item, path) };
    }
    if (type === "axis") {
      rejectUnknownFields(item, AXIS_FIELDS_SET, path);
      return parseAxis(item, path);
    }
    throw new MacroError(
      `${path}.type`,
      `unknown type ${JSON.stringify(type)}; expected "press", "release" or "axis"`,
    );
  });

  // Stable sort: equal timestamps keep document order, which is how two
  // actions in the same tick compose (press then release, for example).
  return actions
    .map((action, index) => ({ action, index }))
    .sort((a, b) => a.action.atMs - b.action.atMs || a.index - b.index)
    .map(({ action }) => action);
}

/** Clamps a raw axis value into the wire i16 range. Exposed for tests. */
export function toI16(value: number): number {
  return clampI16(value);
}
