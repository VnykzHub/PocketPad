/**
 * Action-map compilation (10 §5.8).
 *
 * Compilation turns validated actions into fixed-size descriptors so the
 * per-tick resolver performs no string work, no map lookups and no
 * allocation. Recompile after every overlay/rebind change.
 */

import type {
  ActionOutput,
  InputAction,
  InputActionKind,
  InputBinding,
  InputDeviceKind,
} from "../contracts/input.js";
import {
  DEFAULT_ACTION_HYSTERESIS,
  DEFAULT_ACTION_THRESHOLD,
  INPUT_GAMEPAD_AXIS_COUNT,
  INPUT_KEY_ID_LIMIT,
} from "../version.js";

/** Pointer axis codes used by the resolver: x, y, dx, dy, wheel. */
export type PointerAxisCode = 0 | 1 | 2 | 3 | 4;

/** Phone axis codes: lx, ly, rx, ry, lt, rt. */
export type PhoneAxisCode = 0 | 1 | 2 | 3 | 4 | 5;

export interface CompiledPair {
  readonly device: "phone" | "gamepad";
  /** Phone slot or pad index; -1 means the resolving player's own device. */
  readonly index: number;
  /** 0 = left stick, 1 = right stick. */
  readonly pair: 0 | 1;
}

export interface CompiledBinding {
  readonly device: InputDeviceKind;
  /** Digital sources engage at level >= 1 and ignore hysteresis. */
  readonly digital: boolean;
  readonly scale: number;
  /** vector2 contribution component; null for scalar actions. */
  readonly contribution: "x" | "y" | null;
  /** Pair index, or -1 for a scalar source. */
  readonly pair: number;
  /** Which pair value this binding reads; null for scalar sources. */
  readonly pairComponent: "x" | "y" | null;

  /** Phone slot, -1 = the resolving player's phone. */
  readonly phoneSlot: number;
  /** Button bit, -1 for an axis source. */
  readonly phoneBit: number;
  /** Phone axis code, -1 for a button source. */
  readonly phoneAxis: PhoneAxisCode | -1;
  readonly phoneTrigger: boolean;

  readonly keyId: number;
  readonly keyCode: string;

  /** Pointer axis code, -1 for a button source. */
  readonly pointerAxis: PointerAxisCode | -1;
  readonly pointerButton: number;

  /** Pad index, -1 = the resolving player's assigned pad. */
  readonly padIndex: number;
  readonly padButton: number;
  readonly padAxis: number;
}

export interface CompiledAction {
  readonly source: InputAction;
  readonly name: string;
  readonly kind: InputActionKind;
  readonly threshold: number;
  readonly hysteresis: number;
  readonly yUp: boolean;
  /** Explicit action deadzone; undefined lets the source choose its default. */
  readonly deadzone: number | undefined;
  readonly output: ActionOutput | undefined;
  readonly bindings: readonly CompiledBinding[];
  readonly pairs: readonly CompiledPair[];
  /** Reused pair-value scratch, one per pair; never read by callers. */
  readonly pairX: Float64Array;
  readonly pairY: Float64Array;
}

export interface CompiledMap {
  readonly actions: readonly InputAction[];
  readonly plans: readonly CompiledAction[];
  readonly names: readonly string[];
  readonly index: ReadonlyMap<string, number>;
}

export interface CompileOptions {
  /** Supplies compiled key ids from the router's 256-entry table. */
  readonly keyId?: (code: string) => number;
}

const PHONE_AXIS_CODE: Readonly<Record<string, PhoneAxisCode>> = {
  lx: 0,
  ly: 1,
  rx: 2,
  ry: 3,
  lt: 4,
  rt: 5,
};

const POINTER_AXIS_CODE: Readonly<Record<string, PointerAxisCode>> = {
  x: 0,
  y: 1,
  dx: 2,
  dy: 3,
  wheel: 4,
};

function phonePairIndex(axis: PhoneAxisCode): 0 | 1 {
  return axis === 0 || axis === 1 ? 0 : 1;
}

function phonePairComponent(axis: PhoneAxisCode): "x" | "y" {
  return axis === 0 || axis === 2 ? "x" : "y";
}

function padPairIndex(axis: number): 0 | 1 {
  return axis < 2 ? 0 : 1;
}

function padPairComponent(axis: number): "x" | "y" {
  return axis % 2 === 0 ? "x" : "y";
}

function emptyBinding(device: InputDeviceKind): CompiledBinding {
  return {
    device,
    digital: false,
    scale: 1,
    contribution: null,
    pair: -1,
    pairComponent: null,
    phoneSlot: -1,
    phoneBit: -1,
    phoneAxis: -1,
    phoneTrigger: false,
    keyId: -1,
    keyCode: "",
    pointerAxis: -1,
    pointerButton: -1,
    padIndex: -1,
    padButton: -1,
    padAxis: -1,
  };
}

function findOrAddPair(
  pairs: CompiledPair[],
  pairKeys: Map<string, number>,
  device: "phone" | "gamepad",
  index: number,
  pair: 0 | 1,
): number {
  const key = `${device}:${index}:${pair}`;
  const existing = pairKeys.get(key);
  if (existing !== undefined) return existing;
  const next = pairs.length;
  pairs.push({ device, index, pair });
  pairKeys.set(key, next);
  return next;
}

function compileBinding(
  binding: InputBinding,
  pairs: CompiledPair[],
  pairKeys: Map<string, number>,
  actionKind: InputActionKind,
  keyIdOf: ((code: string) => number) | undefined,
): CompiledBinding {
  const base = emptyBinding(binding.device);
  const scale =
    binding.device === "phone" && binding.channel === "button"
      ? 1
      : binding.scale ?? 1;

  switch (binding.device) {
    case "phone": {
      const phoneSlot = binding.slot === "self" ? -1 : binding.slot;
      if (binding.channel === "button") {
        return {
          ...base,
          digital: true,
          scale,
          // Phone buttons carry no component field; validation rejects them on
          // vector2 actions, so scalar contribution is the only reachable case.
          phoneSlot,
          phoneBit: binding.bit,
        };
      }
      const axis = PHONE_AXIS_CODE[binding.axis] ?? 0;
      const trigger = binding.axis === "lt" || binding.axis === "rt";
      const pairComponent = trigger ? null : phonePairComponent(axis);
      const contribution =
        actionKind === "vector2"
          ? (binding.component ?? pairComponent ?? "x")
          : null;
      return {
        ...base,
        digital: false,
        scale,
        contribution,
        pair: trigger
          ? -1
          : findOrAddPair(pairs, pairKeys, "phone", phoneSlot, phonePairIndex(axis)),
        pairComponent,
        phoneSlot,
        phoneAxis: axis,
        phoneTrigger: trigger,
      };
    }

    case "keyboard": {
      const keyId = keyIdOf !== undefined ? keyIdOf(binding.code) : -1;
      return {
        ...base,
        digital: true,
        scale,
        contribution: actionKind === "vector2" ? (binding.component ?? "x") : null,
        keyId:
          Number.isInteger(keyId) && keyId >= 0 && keyId < INPUT_KEY_ID_LIMIT
            ? keyId
            : -1,
        keyCode: binding.code,
      };
    }

    case "pointer": {
      if (binding.button !== undefined) {
        return {
          ...base,
          digital: true,
          scale,
          contribution: actionKind === "vector2" ? (binding.component ?? "x") : null,
          pointerButton: binding.button,
        };
      }
      const axis = binding.axis !== undefined ? POINTER_AXIS_CODE[binding.axis] : 0;
      return {
        ...base,
        digital: false,
        scale,
        contribution: actionKind === "vector2" ? (binding.component ?? "x") : null,
        pointerAxis: axis ?? 0,
      };
    }

    case "gamepad": {
      const padIndex = binding.pad === "self" ? -1 : binding.pad;
      if (binding.button !== undefined) {
        const analogTrigger = binding.button === 6 || binding.button === 7;
        return {
          ...base,
          digital: !analogTrigger,
          scale,
          contribution: actionKind === "vector2" ? (binding.component ?? "x") : null,
          padIndex,
          padButton: binding.button,
        };
      }
      const axis = binding.axis ?? 0;
      const pairComponent = padPairComponent(axis);
      return {
        ...base,
        digital: false,
        scale,
        contribution:
          actionKind === "vector2"
            ? (binding.component ?? pairComponent)
            : null,
        pair: findOrAddPair(pairs, pairKeys, "gamepad", padIndex, padPairIndex(axis)),
        pairComponent,
        padIndex,
        padAxis: axis,
      };
    }

    default:
      return base;
  }
}

function compileAction(
  action: InputAction,
  keyIdOf: ((code: string) => number) | undefined,
): CompiledAction {
  const pairs: CompiledPair[] = [];
  const pairKeys = new Map<string, number>();
  const bindings: CompiledBinding[] = [];
  for (const binding of action.bindings) {
    bindings.push(compileBinding(binding, pairs, pairKeys, action.kind, keyIdOf));
  }
  return {
    source: action,
    name: action.name,
    kind: action.kind,
    threshold: action.threshold ?? DEFAULT_ACTION_THRESHOLD,
    hysteresis: action.hysteresis ?? DEFAULT_ACTION_HYSTERESIS,
    yUp: action.yUp ?? false,
    deadzone: action.deadzone,
    output: action.output,
    bindings,
    pairs,
    pairX: new Float64Array(pairs.length),
    pairY: new Float64Array(pairs.length),
  };
}

/** Compiles validated actions. Allocation happens here, never in `poll`. */
export function compileActionMap(
  actions: readonly InputAction[],
  options: CompileOptions = {},
): CompiledMap {
  const plans: CompiledAction[] = [];
  const names: string[] = [];
  const index = new Map<string, number>();
  for (let i = 0; i < actions.length; i += 1) {
    const action = actions[i];
    if (action === undefined) continue;
    plans.push(compileAction(action, options.keyId));
    names.push(action.name);
    index.set(action.name, i);
  }
  return { actions, plans, names, index };
}

/** Number of standard gamepad axes; re-exported for tests without magic numbers. */
export const COMPILED_GAMEPAD_AXIS_COUNT = INPUT_GAMEPAD_AXIS_COUNT;
