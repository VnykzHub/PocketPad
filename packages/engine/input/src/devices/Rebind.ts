/**
 * Rebinding helpers (10 §5.11).
 *
 * Capture translation, conflict lookup and atomic list replacement. The
 * router owns the capture state machine and promise; this module owns the
 * pure rules so they are directly testable.
 */

import type {
  Component,
  InputAction,
  InputActionKind,
  InputBinding,
  InputDeviceKind,
} from "../contracts/input.js";

export interface BindingConflict {
  readonly actionIndex: number;
  readonly bindingIndex: number;
}

export interface BindingChange {
  readonly index: number;
  readonly bindings: readonly InputBinding[];
}

export type RebindApplyResult =
  | {
      readonly ok: true;
      readonly actions: readonly InputAction[];
      readonly changed: readonly BindingChange[];
    }
  | {
      readonly ok: false;
      readonly conflict: { readonly action: string; readonly binding: number };
    };

function sameGamepadPad(a: InputBinding, b: InputBinding): boolean {
  if (a.device !== "gamepad" || b.device !== "gamepad") return false;
  return a.pad === b.pad;
}

/** True when two bindings claim the same physical source. */
export function sameSource(a: InputBinding, b: InputBinding): boolean {
  if (a.device !== b.device) return false;
  switch (a.device) {
    case "keyboard":
      return b.device === "keyboard" && a.code === b.code;
    case "pointer":
      if (b.device !== "pointer") return false;
      if (a.button !== undefined && b.button !== undefined) return a.button === b.button;
      if (a.axis !== undefined && b.axis !== undefined) return a.axis === b.axis;
      return false;
    case "gamepad":
      if (b.device !== "gamepad" || !sameGamepadPad(a, b)) return false;
      if (a.button !== undefined && b.button !== undefined) return a.button === b.button;
      if (a.axis !== undefined && b.axis !== undefined) return a.axis === b.axis;
      return false;
    case "phone":
      return false;
  }
}

/**
 * First binding outside the target action that claims the same source.
 * Conflict checks are scoped to one device kind; equal sources on different
 * devices are not a conflict.
 */
export function findBindingConflict(
  actions: readonly InputAction[],
  targetActionIndex: number,
  candidate: InputBinding,
): BindingConflict | undefined {
  for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
    if (actionIndex === targetActionIndex) continue;
    const action = actions[actionIndex];
    if (action === undefined) continue;
    for (let bindingIndex = 0; bindingIndex < action.bindings.length; bindingIndex += 1) {
      const binding = action.bindings[bindingIndex];
      if (binding !== undefined && sameSource(binding, candidate)) {
        return { actionIndex, bindingIndex };
      }
    }
  }
  return undefined;
}

function oldComponent(
  old: InputBinding | undefined,
  device: InputDeviceKind,
): Component | undefined {
  if (old === undefined || old.device !== device) return undefined;
  if (old.device === "phone" && old.channel === "button") return undefined;
  return old.component;
}

function oldScale(
  old: InputBinding | undefined,
  device: InputDeviceKind,
): number | undefined {
  if (old === undefined || old.device !== device) return undefined;
  if (old.device === "phone" && old.channel === "button") return undefined;
  return old.scale;
}

function componentFor(
  component: Component | undefined,
  kind: InputActionKind,
): Component | undefined {
  if (component !== undefined) return component;
  return kind === "vector2" ? "x" : undefined;
}

function withComponentScale(
  component: Component | undefined,
  scale: number | undefined,
): { component?: Component; scale?: number } {
  return {
    ...(component !== undefined ? { component } : {}),
    ...(scale !== undefined ? { scale } : {}),
  };
}

export function buildKeyboardBinding(
  code: string,
  old: InputBinding | undefined,
  kind: InputActionKind,
): InputBinding {
  return {
    device: "keyboard",
    code,
    ...withComponentScale(componentFor(oldComponent(old, "keyboard"), kind), oldScale(old, "keyboard")),
  };
}

export function buildPointerButtonBinding(
  button: number,
  old: InputBinding | undefined,
  kind: InputActionKind,
): InputBinding {
  return {
    device: "pointer",
    button: button as 0 | 1 | 2,
    ...withComponentScale(componentFor(oldComponent(old, "pointer"), kind), oldScale(old, "pointer")),
  };
}

export function buildPointerWheelBinding(
  old: InputBinding | undefined,
  kind: InputActionKind,
): InputBinding {
  return {
    device: "pointer",
    axis: "wheel",
    ...withComponentScale(componentFor(oldComponent(old, "pointer"), kind), oldScale(old, "pointer")),
  };
}

export function buildGamepadButtonBinding(
  button: number,
  old: InputBinding | undefined,
  kind: InputActionKind,
): InputBinding {
  return {
    device: "gamepad",
    pad: old !== undefined && old.device === "gamepad" ? old.pad : "self",
    button,
    ...withComponentScale(componentFor(oldComponent(old, "gamepad"), kind), oldScale(old, "gamepad")),
  };
}

/** A captured gamepad axis defaults its vector component from its index. */
function gamepadAxisComponent(axis: number): Component {
  return axis % 2 === 1 ? "y" : "x";
}

export function buildGamepadAxisBinding(
  axis: number,
  value: number,
  old: InputBinding | undefined,
  kind: InputActionKind,
): InputBinding {
  const oldGamepad = old !== undefined && old.device === "gamepad" ? old : undefined;
  const component =
    oldGamepad !== undefined && oldGamepad.component !== undefined
      ? oldGamepad.component
      : kind === "vector2"
        ? gamepadAxisComponent(axis)
        : undefined;
  return {
    device: "gamepad",
    pad: oldGamepad !== undefined ? oldGamepad.pad : "self",
    axis,
    ...(component !== undefined ? { component } : {}),
    scale: value < 0 ? -1 : 1,
  };
}

/** Stable diagnostic code carried by `RebindResult.code`. */
export function bindingCode(binding: InputBinding): string {
  switch (binding.device) {
    case "keyboard":
      return binding.code;
    case "pointer":
      return binding.button !== undefined
        ? `PointerButton${binding.button}`
        : `PointerAxis${binding.axis ?? ""}`;
    case "gamepad":
      return binding.button !== undefined
        ? `GamepadButton${binding.button}`
        : `GamepadAxis${binding.axis ?? ""}`;
    case "phone":
      return "";
  }
}

/**
 * Returns a new effective action list with the captured binding applied.
 * Under `replace`, the conflicting binding is removed from the other action;
 * if that would empty the other action the result is a `conflict` refusal.
 */
export function rebindInActions(
  actions: readonly InputAction[],
  actionIndex: number,
  bindingIndex: number,
  candidate: InputBinding,
  policy: "replace" | "reject",
): RebindApplyResult {
  const target = actions[actionIndex];
  if (target === undefined || bindingIndex < 0 || bindingIndex >= target.bindings.length) {
    return {
      ok: false,
      conflict: {
        action: target !== undefined ? target.name : "",
        binding: bindingIndex,
      },
    };
  }

  const targetList = Array.from(target.bindings);
  targetList[bindingIndex] = candidate;
  const next = Array.from(actions);
  next[actionIndex] = { ...target, bindings: targetList };
  const changes = new Map<number, readonly InputBinding[]>();
  changes.set(actionIndex, targetList);

  const conflict = findBindingConflict(actions, actionIndex, candidate);
  if (conflict !== undefined) {
    const other = actions[conflict.actionIndex];
    if (other === undefined) {
      return { ok: false, conflict: { action: "", binding: conflict.bindingIndex } };
    }
    if (policy === "reject" || other.bindings.length <= 1) {
      return {
        ok: false,
        conflict: { action: other.name, binding: conflict.bindingIndex },
      };
    }
    const otherList = Array.from(other.bindings);
    otherList.splice(conflict.bindingIndex, 1);
    next[conflict.actionIndex] = { ...other, bindings: otherList };
    changes.set(conflict.actionIndex, otherList);
  }

  const changed: BindingChange[] = [];
  for (const [index, bindings] of changes) changed.push({ index, bindings });
  return { ok: true, actions: next, changed };
}
