/**
 * @lanpad/sdk controller layout contract (D2-LAYOUT-01; FR-8.1, FR-8.4).
 *
 * A layout is data, never code: games ship JSON and the controller renders it
 * through a control registry. D2 declares the complete v0 union even though the
 * controller only renders `button`, `dpad` and `stick`; D5 adds renderers for
 * the remaining types without changing these fields.
 *
 * Coordinate model (frozen in D2, documented in layout.schema.json):
 * - `x`/`y` percentages are relative to the viewport width/height.
 * - `size`/`r` percentages are relative to `min(viewportWidth, viewportHeight)`.
 * - `w`/`h` percentages are relative to the viewport width/height.
 *
 * Validation lives in `layout-validate.ts` so the same pure function can run on
 * the host and on the controller. This module has no DOM or network dependency.
 */

/** A layout length: a CSS percentage of the reference dimension, or pixels. */
export type Length = `${number}%` | `${number}px`;

export interface BaseControl {
  /** Unique within the layout, 1..32 characters. */
  id: string;
  x: Length;
  y: Length;
  /** Draw and hit order; higher draws on top. Default 0. */
  z?: number;
}

export interface ButtonControl extends BaseControl {
  type: "button";
  label: string;
  shape: "circle" | "rounded" | "square";
  /** Radius for a circle, edge length otherwise. */
  r: Length;
  /** Protocol button bit, 0..15 (FR-7.2). */
  bit: number;
  /** Vibration pattern in milliseconds, at most 8 steps. */
  haptic?: number[];
}

export interface DpadControl extends BaseControl {
  type: "dpad";
  size: Length;
  bits: { up: number; down: number; left: number; right: number };
}

export interface StickControl extends BaseControl {
  type: "stick";
  size: Length;
  axis: "left" | "right";
  mode: "floating" | "fixed";
  /** Radial deadzone fraction, 0..0.5; default 0.08 (FR-7.4). */
  deadzone?: number;
}

export interface TriggerControl extends BaseControl {
  type: "trigger";
  size: Length;
  channel: "lt" | "rt";
  orientation?: "vertical" | "horizontal";
}

export interface TouchpadControl extends BaseControl {
  type: "touchpad";
  w: Length;
  h: Length;
  /** Touchpads always map onto rx/ry (FR-7.7). */
}

export interface SliderControl extends BaseControl {
  type: "slider";
  w: Length;
  h: Length;
  channel: "lt" | "rt";
  direction?: "horizontal" | "vertical";
}

export interface GyroControl extends BaseControl {
  type: "gyro";
  sensitivity?: number;
  /** Low-pass alpha, 0..1; default 0.15 (FR-8.5). */
  smoothing?: number;
}

export interface ChoiceControl extends BaseControl {
  type: "choice";
  w: Length;
  h: Length;
  event: string;
  options: Array<{ value: string; label: string }>;
}

export interface PanelControl extends BaseControl {
  type: "panel";
  w: Length;
  h: Length;
}

export interface TextControl extends BaseControl {
  type: "text";
  w: Length;
  h: Length;
  event: string;
  /** Maximum accepted characters, 1..200. */
  maxLen: number;
}

export interface CanvasControl extends BaseControl {
  type: "canvas";
  w: Length;
  h: Length;
  event: string;
  maxStrokePoints?: number;
}

export type Control =
  | ButtonControl
  | DpadControl
  | StickControl
  | TriggerControl
  | TouchpadControl
  | SliderControl
  | GyroControl
  | ChoiceControl
  | PanelControl
  | TextControl
  | CanvasControl;

export interface LayoutDocument {
  /**
   * Layout format version. Absent means 1. A new control type or a breaking
   * field change requires a version bump; unknown types are rejected.
   */
  schemaVersion?: 1;
  /** Stable layout id, 1..64 characters; convention is `<game>-v<n>`. */
  id: string;
  orientation: "portrait" | "landscape" | "any";
  /** `#rgb` or `#rrggbb`. */
  background?: string;
  /** 1..24 controls. */
  controls: Control[];
  sensors?: {
    gyro?: "steer" | "aim" | "tilt";
    sensitivity?: number;
    smoothing?: number;
  };
}

/** Parsed form of a layout length, in the shorthand unit the layout used. */
export interface ParsedLength {
  kind: "percent" | "px";
  value: number;
}

const LENGTH_PATTERN = /^(\d+(?:\.\d+)?)(%|px)$/;

/**
 * Parses an untrusted length string without throwing. Returns `null` when the
 * value is not a `<number>%` or `<number>px` string. Range limits (percent
 * 0..100, px 0..4096) are enforced by `validateLayout`, not here, so the
 * renderer can inspect a value before deciding what to do with it.
 */
export function tryParseLength(value: unknown): ParsedLength | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = LENGTH_PATTERN.exec(value);
  if (match === null) {
    return null;
  }
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) {
    return null;
  }
  return { kind: match[2] === "%" ? "percent" : "px", value: amount };
}

/**
 * Parses a layout length for the renderer. Throws on a malformed string;
 * layouts reaching the renderer have already passed `validateLayout`.
 */
export function parseLength(value: Length): ParsedLength {
  const parsed = tryParseLength(value);
  if (parsed === null) {
    throw new Error(
      `Invalid layout length ${JSON.stringify(value)}: expected "<number>%" or "<number>px".`,
    );
  }
  return parsed;
}

/**
 * Maps every assigned button/dpad bit to the ids of the controls that use it.
 * A bit assigned by two controls lists both ids, which is how the validator
 * reports duplicate bit assignments (FR-7.7 groundwork).
 */
export function controlBitAssignments(layout: LayoutDocument): Map<number, string[]> {
  const assignments = new Map<number, string[]>();

  const add = (bit: number, controlId: string): void => {
    const owners = assignments.get(bit);
    if (owners === undefined) {
      assignments.set(bit, [controlId]);
    } else if (!owners.includes(controlId)) {
      owners.push(controlId);
    }
  };

  for (const control of layout.controls) {
    if (control.type === "button") {
      add(control.bit, control.id);
    } else if (control.type === "dpad") {
      const { up, down, left, right } = control.bits;
      for (const bit of [up, down, left, right]) {
        add(bit, control.id);
      }
    }
  }

  return assignments;
}
