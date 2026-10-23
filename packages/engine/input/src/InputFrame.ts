/**
 * Pooled frame objects (10 §3.4).
 *
 * `InputFrameImpl`, its players, action states, controller views, pointer and
 * focus snapshots are allocated once by the router. `poll` overwrites them;
 * callers that need to retain values must copy fields.
 */

import type {
  ActionState,
  ControllerView,
  FocusSnapshot,
  InputAction,
  InputDeviceKind,
  InputFrame,
  InputMap,
  PlayerInput,
  PointerSnapshot,
} from "./contracts/input.js";

export type MutableActionState = {
  -readonly [K in keyof ActionState]: ActionState[K];
};

export type MutableControllerView = {
  -readonly [K in keyof ControllerView]: ControllerView[K];
};

export type MutablePointerSnapshot = {
  -readonly [K in keyof PointerSnapshot]: PointerSnapshot[K];
};

export type MutableFocusSnapshot = {
  -readonly [K in keyof FocusSnapshot]: FocusSnapshot[K];
};

const EMPTY_ACTIONS: readonly ActionState[] = [];

export function createActionState(): MutableActionState {
  return {
    pressed: false,
    edges: 0,
    released: true,
    releaseEdges: 0,
    x: 0,
    y: 0,
    value: 0,
  };
}

export function zeroActionState(state: MutableActionState): void {
  state.pressed = false;
  state.edges = 0;
  state.released = true;
  state.releaseEdges = 0;
  state.x = 0;
  state.y = 0;
  state.value = 0;
}

export function createControllerView(slot: number): MutableControllerView {
  return {
    slot,
    connected: false,
    buttons: 0,
    edges: 0,
    lx: 0,
    ly: 0,
    rx: 0,
    ry: 0,
    gyro: { x: 0, y: 0, z: 0 },
    gyroActive: false,
    gyroRecentered: false,
    triggers: { lt: 0, rt: 0 },
    tick: 0,
  };
}

/** Zeroes every field except `slot`; removes tilt. */
export function zeroControllerView(view: MutableControllerView): void {
  view.connected = false;
  view.buttons = 0;
  view.edges = 0;
  view.lx = 0;
  view.ly = 0;
  view.rx = 0;
  view.ry = 0;
  view.gyro.x = 0;
  view.gyro.y = 0;
  view.gyro.z = 0;
  view.gyroActive = false;
  view.gyroRecentered = false;
  view.triggers.lt = 0;
  view.triggers.rt = 0;
  view.tick = 0;
  delete view.tilt;
}

export function createPointerSnapshot(): MutablePointerSnapshot {
  return {
    x: 0,
    y: 0,
    dx: 0,
    dy: 0,
    wheel: 0,
    buttons: 0,
    edges: 0,
    inside: false,
    locked: false,
  };
}

export function createFocusSnapshot(): MutableFocusSnapshot {
  return {
    focused: true,
    visible: true,
    pointerLocked: false,
    lastBlurTick: -1,
  };
}

/** One player's pooled input: action states plus its controller snapshot. */
export class PlayerInputImpl implements PlayerInput {
  readonly slot: number;
  connected = false;
  device: InputDeviceKind | "none" = "none";
  readonly actions: MutableActionState[];
  controller: MutableControllerView;

  constructor(slot: number, actionCount: number) {
    this.slot = slot;
    this.actions = [];
    for (let i = 0; i < actionCount; i += 1) {
      this.actions.push(createActionState());
    }
    this.controller = createControllerView(slot);
  }

  zeroActions(): void {
    for (const action of this.actions) zeroActionState(action);
  }
}

/** Pooled frame plus named lookup (the `ActionReader` half of `InputFrame`). */
export class InputFrameImpl implements InputFrame {
  tick = 0;
  players: PlayerInputImpl[];
  actions: readonly ActionState[] = EMPTY_ACTIONS;
  pointer: MutablePointerSnapshot = createPointerSnapshot();
  focus: MutableFocusSnapshot = createFocusSnapshot();
  private lookup = new Map<string, number>();
  private localSlot = 0;

  constructor(slotCount: number, actionCount: number) {
    this.players = [];
    for (let slot = 0; slot < slotCount; slot += 1) {
      this.players.push(new PlayerInputImpl(slot, actionCount));
    }
  }

  /** Rebuilds the name table after a map compile; never called per tick. */
  setActionNames(names: readonly string[]): void {
    this.lookup = new Map<string, number>();
    for (let i = 0; i < names.length; i += 1) {
      const name = names[i];
      if (name !== undefined) this.lookup.set(name, i);
    }
    this.setLocalSlot(this.localSlot);
  }

  /** Points `actions`/`action()` at the local player's pooled arrays. */
  setLocalSlot(slot: number): void {
    this.localSlot = slot;
    const player = this.players[slot];
    this.actions = player !== undefined ? player.actions : EMPTY_ACTIONS;
  }

  player(slot: number): PlayerInput | undefined {
    return this.players[slot];
  }

  action(name: string): ActionState | undefined {
    const index = this.lookup.get(name);
    if (index === undefined) return undefined;
    return this.actions[index];
  }
}

/**
 * `InputMap` view over a router frame. `poll(out)` copies the local player's
 * pooled states into the caller's array without allocating.
 */
export class InputMapView implements InputMap {
  actions: readonly InputAction[] = [];
  names: readonly string[] = [];
  private lookup = new Map<string, number>();
  private readonly source: () => readonly ActionState[];

  constructor(source: () => readonly ActionState[]) {
    this.source = source;
  }

  setActions(actions: readonly InputAction[], names: readonly string[]): void {
    this.actions = actions;
    this.names = names;
    this.lookup = new Map<string, number>();
    for (let i = 0; i < names.length; i += 1) {
      const name = names[i];
      if (name !== undefined) this.lookup.set(name, i);
    }
  }

  indexOf(name: string): number {
    const index = this.lookup.get(name);
    return index === undefined ? -1 : index;
  }

  poll(out: ActionState[]): ActionState[] {
    const source = this.source();
    const count = out.length < source.length ? out.length : source.length;
    for (let i = 0; i < count; i += 1) {
      const from = source[i];
      const to = out[i];
      if (from === undefined || to === undefined) continue;
      copyActionState(from, to);
    }
    return out;
  }
}

/** Copies fields; `to` is a caller-owned array element, never pooled by us. */
export function copyActionState(from: ActionState, to: ActionState): void {
  const mutable = to as MutableActionState;
  mutable.pressed = from.pressed;
  mutable.edges = from.edges;
  mutable.released = from.released;
  mutable.releaseEdges = from.releaseEdges;
  mutable.x = from.x;
  mutable.y = from.y;
  mutable.value = from.value;
}
