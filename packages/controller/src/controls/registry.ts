/**
 * Control registry (D2-CTRL-02; FR-8.1, FR-8.2).
 *
 * `createControl` is the single entry point from a validated layout entry to a
 * renderer. D2 registers `button`, `dpad` and `stick`; the remaining v1 types
 * are valid layout data but have no renderer yet, so they fail with an explicit
 * "not implemented" error instead of a generic unknown-type error. D5-CTRL-01
 * adds those factories through `registerControl` without changing this file's
 * contract.
 *
 * Layout hot-swap (FR-8.2) is a caller concern: dispose the renderers from the
 * old layout and create them from the new one; no module state survives.
 */
import type { Control } from "@lanpad/sdk";
import { createButtonControl } from "./button.js";
import type { ControlContext, ControlRenderer } from "./control.js";
import { createDpadControl } from "./dpad.js";
import { createStickControl } from "./stick.js";

/** Builds one renderer for a validated control entry. */
export type ControlFactory<T extends Control = Control> = (
  control: T,
  ctx: ControlContext,
) => ControlRenderer;

/** v1 types that are structurally valid but have no D2 renderer. */
const UNIMPLEMENTED_TYPES = new Set<Control["type"]>([
  "trigger",
  "touchpad",
  "slider",
  "gyro",
  "choice",
  "panel",
  "text",
  "canvas",
]);

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
 * @throws Error when the type has no renderer yet (valid D5 type) or is not a
 *   v1 control type at all.
 */
export function createControl(control: Control, ctx: ControlContext): ControlRenderer {
  const factory = factories.get(control.type);
  if (factory !== undefined) {
    return factory(control, ctx);
  }

  if (UNIMPLEMENTED_TYPES.has(control.type)) {
    throw new Error(
      `Control type "${control.type}" is not implemented in D2; D5-CTRL-01 adds its renderer.`,
    );
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
