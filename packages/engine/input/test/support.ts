/**
 * Shared Node-side helpers for the input suites. Synthetic values only.
 *
 * The router is DOM-free by design; these helpers model the small browser
 * seams it uses (an event target, gamepad readouts, decoded phone samples) so
 * the real code paths run in Node. Allocation is fine in tests.
 */

import type {
  ActionState,
  GamepadReadout,
  GamepadSnapshot,
  InputFrame,
  InputMap,
  InputTarget,
  PhoneInputSample,
  PointerSnapshot,
} from "../src/index.js";

export type Listener = (event: unknown) => void;

/** Minimal event target implementing the structural listener seam. */
export class FakeTarget {
  readonly listeners = new Map<string, Set<Listener>>();
  readonly captured: number[] = [];
  readonly released: number[] = [];
  clientWidth = 800;
  clientHeight = 600;

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set<Listener>();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type);
    if (set !== undefined) set.delete(listener);
  }

  setPointerCapture(pointerId: number): void {
    this.captured.push(pointerId);
  }

  releasePointerCapture(pointerId: number): void {
    this.released.push(pointerId);
  }

  /** Dispatches to installed listeners and records `preventDefault` calls. */
  dispatch(
    type: string,
    event: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const record: Record<string, unknown> = {
      type,
      defaultPrevented: false,
      ...event,
    };
    record.preventDefault = () => {
      record.defaultPrevented = true;
    };
    for (const listener of this.listeners.get(type) ?? []) listener(record);
    return record;
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

export function elementTarget(target: FakeTarget): InputTarget {
  return { kind: "element", native: target };
}

export interface ReadoutOptions {
  readonly buttons?: readonly number[];
  readonly axes?: readonly number[];
  readonly mapping?: "standard" | "non-standard";
  readonly connected?: boolean;
  readonly id?: string;
  readonly lt?: number;
  readonly rt?: number;
}

/** Builds a 17-button, 4-axis browser-like readout. */
export function makeReadout(
  index: number,
  options: ReadoutOptions = {},
): GamepadReadout {
  const pressed = new Set(options.buttons ?? []);
  const axes = [0, 0, 0, 0];
  for (let axis = 0; axis < axes.length; axis += 1) {
    axes[axis] = options.axes?.[axis] ?? 0;
  }
  const buttons: { pressed: boolean; value: number }[] = [];
  for (let button = 0; button < 17; button += 1) {
    const isDown = pressed.has(button);
    let value = isDown ? 1 : 0;
    if (button === 6 && options.lt !== undefined) value = options.lt;
    if (button === 7 && options.rt !== undefined) value = options.rt;
    buttons.push({ pressed: isDown, value });
  }
  return {
    index,
    id: options.id ?? `pad-${index}`,
    mapping: options.mapping ?? "standard",
    connected: options.connected !== false,
    buttons,
    axes,
  };
}

export interface SnapshotOptions extends ReadoutOptions {
  readonly edges?: number;
  readonly releaseEdges?: number;
}

/** Runtime-decoded snapshot with a derived button mask. */
export function makeSnapshot(
  index: number,
  options: SnapshotOptions = {},
): GamepadSnapshot {
  const readout = makeReadout(index, options);
  let mask = 0;
  for (let button = 0; button < readout.buttons.length; button += 1) {
    if (readout.buttons[button]?.pressed === true) mask |= 1 << button;
  }
  return {
    index,
    id: readout.id,
    mapping: readout.mapping,
    connected: readout.connected,
    buttons: mask,
    edges: options.edges ?? 0,
    releaseEdges: options.releaseEdges ?? 0,
    triggerValues: { lt: options.lt ?? 0, rt: options.rt ?? 0 },
    axes: readout.axes,
  };
}

/** Decoded phone sample matching the frozen contract shape. */
export function phoneSample(
  overrides: Partial<PhoneInputSample> = {},
): PhoneInputSample {
  return {
    slot: overrides.slot ?? 0,
    connected: overrides.connected !== false,
    buttons: overrides.buttons ?? 0,
    edges: overrides.edges ?? 0,
    lx: overrides.lx ?? 0,
    ly: overrides.ly ?? 0,
    rx: overrides.rx ?? 0,
    ry: overrides.ry ?? 0,
    gyro: overrides.gyro ?? { x: 0, y: 0, z: 0 },
    gyroActive: overrides.gyroActive === true,
    gyroRecentered: overrides.gyroRecentered === true,
    triggers: overrides.triggers ?? { lt: 0, rt: 0 },
    tick: overrides.tick ?? 0,
  };
}

export function pointerSnapshot(
  overrides: Partial<PointerSnapshot> = {},
): PointerSnapshot {
  return {
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    dx: overrides.dx ?? 0,
    dy: overrides.dy ?? 0,
    wheel: overrides.wheel ?? 0,
    buttons: overrides.buttons ?? 0,
    edges: overrides.edges ?? 0,
    inside: overrides.inside === true,
    locked: overrides.locked === true,
  };
}

/** One slot's action state by name; frame top-level actions are local-only. */
export function slotAction(
  frame: InputFrame,
  map: InputMap,
  slot: number,
  name: string,
): ActionState | undefined {
  const index = map.indexOf(name);
  if (index < 0) return undefined;
  const player = frame.player(slot);
  return player?.actions[index];
}
