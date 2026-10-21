/**
 * Control registry (D2-CTRL-02, D5-CTRL-01; FR-8.1, FR-8.2).
 *
 * `createControl` is the single entry point from a validated layout entry to a
 * renderer. D2 registered `button`, `dpad` and `stick`; D5-CTRL-01 registers
 * the remaining eight v1 types here, so every control the validator accepts
 * renders from layout data. `registerControl` stays public for tests and later
 * layers (D6 can replace the gyro renderer without touching this file).
 *
 * Layout hot-swap (FR-8.2) is a caller concern: dispose the renderers from the
 * old layout and create them from the new one; no module state survives.
 */
import type { Control } from "@lanpad/sdk";
import { createButtonControl } from "./button.js";
import { createCanvasControl } from "./canvas.js";
import { createChoiceControl } from "./choice.js";
import type { ControlContext, ControlRenderer } from "./control.js";
import { createDpadControl } from "./dpad.js";
import { createGyroControl } from "./gyro.js";
import { createPanelControl } from "./panel.js";
import { createSliderControl } from "./slider.js";
import { createStickControl } from "./stick.js";
import { createTextControl } from "./text.js";
import { createTouchpadControl } from "./touchpad.js";
import { createTriggerControl } from "./trigger.js";

/** Builds one renderer for a validated control entry. */
export type ControlFactory<T extends Control = Control> = (
  control: T,
  ctx: ControlContext,
) => ControlRenderer;

const factories = new Map<Control["type"], ControlFactory>();

/** Registers or replaces the factory for one control type. */
export function registerControl<T extends Control>(
  type: T["type"],
  factory: ControlFactory<T>,
): void {
  factories.set(type, factory as ControlFactory);
}

/**
 * Creates the renderer for `control`.
 *
 * @throws Error when the type is not a v1 control type. Every v1 type has a
 *   renderer after D5-CTRL-01, so this only fires for hostile/corrupt input
 *   that bypassed `validateLayout`.
 */
export function createControl(control: Control, ctx: ControlContext): ControlRenderer {
  const factory = factories.get(control.type);
  if (factory !== undefined) {
    return factory(control, ctx);
  }

  const received = (control as { type?: unknown }).type;
  throw new Error(`Unknown control type ${JSON.stringify(received)}.`);
}

/** Convenience for building a whole layout; preserves layout order. */
export function createControls(
  controls: readonly Control[],
  ctx: ControlContext,
): ControlRenderer[] {
  return controls.map((control) => createControl(control, ctx));
}

registerControl("button", createButtonControl);
registerControl("dpad", createDpadControl);
registerControl("stick", createStickControl);
registerControl("trigger", createTriggerControl);
registerControl("touchpad", createTouchpadControl);
registerControl("slider", createSliderControl);
registerControl("gyro", createGyroControl);
registerControl("choice", createChoiceControl);
registerControl("panel", createPanelControl);
registerControl("text", createTextControl);
registerControl("canvas", createCanvasControl);
