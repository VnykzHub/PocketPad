# 10 — Input

**Status:** authoritative for the engine input subsystem once implemented. This document specifies a target contract. The existing runtime input (`InputMapper`, `TiltIntegrator`, `SnapshotInputReader`) is the M0 baseline described in §5.13.
**Authority:** [`SPEC.md`](../../SPEC.md) FR-7.1..7.17 and §8 for phones and FR-9.11 for gesture unlock; [`00-architecture.md`](00-architecture.md) for package boundaries, the `InputAction` contract sketch, error taxonomy and the migration map; [`docs/ENGINE.md`](../ENGINE.md) for what exists today. Where this spec and `SPEC.md` disagree, `SPEC.md` wins until an amendment is recorded in [`docs/todos/README.md`](../todos/README.md).
**Package:** `@lanpad/engine-input` at `packages/engine/input` (00 §3.7, §6). The wave brief's `packages/input` is shorthand for the same package; if the workspace is ever moved, the internal layout is unchanged.

**Milestone boundary.** M0 ships the keyboard/mouse/gamepad layer, the phone adapter over the existing 26-byte input, action maps, deadzones, edge/level accumulation, deterministic player assignment, rebinding and a unified `InputFrame` that is allocation-free per tick. The phone wire, controller-side touch engine, layouts and `InputMapper` semantics are unchanged. Online relay input, prediction and reconciliation are **M1/M3** and owned by spec 14; they consume this spec, they do not change it. Haptics, layouts and the controller UI are out of scope.

---

## 1. Goal

Today the host accepts input from phones only. `InputMapper` decodes a 26-byte `Input`/27-byte `InputFwd` packet into a per-slot `ControllerState`; games read buttons, two sticks, triggers and gyro through `GameInputReader`. There is no keyboard, mouse or gamepad path, no action abstraction, and no rebinding. A game that wants "move forward" hard-codes a button bit or `ly`.

The player-visible outcome this spec targets:

- **A desktop or TV player can play every game without a phone.** WASD/mouse, arrows, a standard gamepad and a TV remote's arrow/Enter keys all drive the same actions, and existing phone-first games still work through a synthesized controller.
- **A game names intentions, not keys.** `move`, `look`, `primary`, `pause` resolve from any device; a game reads one `InputFrame` regardless of whether the player holds a phone, a keyboard or a pad.
- **Sub-tick taps are never lost.** A key pressed and released between two 60 Hz ticks still produces a press edge and a release edge in the next tick.
- **Players are assigned deterministically.** Phone slot N is always player N; keyboard and pads fill the remaining slots in a fixed order; a phone joining never steals another phone's slot.
- **Rebinding is a first-class operation.** A player can rebind any action, conflicts are resolved by policy, reserved keys are refused, and the overlay can persist without the engine writing files.
- **Input never costs a frame.** Polling allocates nothing, never mutates state during `simulate`, and resolves once per tick before the game updates.

The engineering outcome is a contract any input backend can satisfy: one `InputRouter`, one `InputFrame`, frozen `ControllerState` parity for existing games, and no browser event object or protocol type in a game-facing signature.

---

## 2. Non-goals

- **No changes to the phone wire or controller.** The 26-byte `Input`, 27-byte `InputFwd`, 8% controller deadzone, layout schema and touch semantics are frozen (SPEC §7). This spec consumes decoded samples.
- **No new protocol version.** No bytes are added, removed or reinterpreted; the engine never imports `@lanpad/protocol`.
- **No online input prediction, rollback or reconciliation.** Spec 14 owns that layer; this spec produces the local frame it will consume.
- **No gesture, swipe or handwriting recognition.** The controller's touch engine owns gestures; the host sees buttons and axes.
- **No haptics or rumble output.** Haptics are a controller/broker concern; rumble is not in M0.
- **No IME, text entry or on-screen keyboard.** Text fields are host UI (spec 13), not game input.
- **No accessibility remapping UI.** The rebinding API is here; the menu, screen-reader flow and focus rings belong to spec 13/17.
- **No keyboard-layout translation.** Bindings use physical `KeyboardEvent.code`; AZERTY/Dvorak players rebind. A layout-aware mode is out of scope for v1.
- **No non-standard gamepad mapping.** Only `mapping === "standard"` pads drive actions; others are detected and counted.
- **No mouse pointer as a 3D picking ray.** The pointer snapshot is 2D screen space; camera/ray construction belongs to gameplay or the camera rig.
- **No macros, chords, sequences or timing windows.** One binding is one source. Game code composes combos from `pressed`/`edges`.
- **No per-frame allocation.** This is a hard rule (00 §5.8), not an optimisation target.

---

## 3. Public interfaces

All types are backend-neutral. No `KeyboardEvent`, `PointerEvent`, `Gamepad`, `InputState` or protocol type appears in a game-facing signature. `KeyboardEvent.code` strings appear only as binding data.

Contract authority: `packages/engine/input/src/types.ts`. The `.d.ts` companion required by the programme README §7.1 is generated from that file. This spec **extends the 00 §3.4 sketch additively**: `released`/`releaseEdges`, pointer `dx`/`dy`, `pad: "self"`, per-binding `component`/`scale`, action `yUp`/`hysteresis`/`output`, and `InputFrame`. 00 §3.4 remains the frozen five-field minimum; the additions are proposed for the M0 freeze and must be mirrored in `00-architecture.md` by its owner (see §10 risk I1).

### 3.1 Devices and sources

```ts
export type InputDeviceKind = "phone" | "keyboard" | "pointer" | "gamepad";
export type InputActionKind = "button" | "axis" | "vector2";
export type PhoneAxisName = "lx" | "ly" | "rx" | "ry" | "lt" | "rt";
export type Component = "x" | "y";

export interface PhoneButtonSource {
  readonly device: "phone";
  readonly slot: number | "self";     // "self" = the resolving player's slot
  readonly channel: "button";
  readonly bit: number;               // 0..15, layout-defined channel bit
}

export interface PhoneAxisSource {
  readonly device: "phone";
  readonly slot: number | "self";
  readonly channel: "axis";
  readonly axis: PhoneAxisName;
  readonly component?: Component;     // default: lx/rx -> x, ly/ry -> y; lt/rt need one for vector2
  readonly scale?: number;            // default 1; finite, -4..4
}

export interface KeyboardSource {
  readonly device: "keyboard";
  readonly code: string;              // KeyboardEvent.code, e.g. "KeyW", "ArrowUp", "Space"
  readonly component?: Component;
  readonly scale?: number;
}

export interface PointerSource {
  readonly device: "pointer";
  readonly axis?: "x" | "y" | "dx" | "dy" | "wheel";
  readonly button?: 0 | 1 | 2;        // when set, sample the button instead of the axis
  readonly component?: Component;
  readonly scale?: number;
}

export interface GamepadSource {
  readonly device: "gamepad";
  readonly pad: number | "self";      // "self" = the resolving player's assigned pad
  readonly button?: number;           // standard mapping 0..16
  readonly axis?: number;             // standard mapping 0..3
  readonly component?: Component;
  readonly scale?: number;
}

export type InputBinding =
  | PhoneButtonSource
  | PhoneAxisSource
  | KeyboardSource
  | PointerSource
  | GamepadSource;
```

Validation is strict at map load: exactly one of `button`/`axis` on a gamepad source; exactly one of `button`/`axis` on a pointer source; `bit` 0..15; `pad` 0..3 or `"self"`; `slot` 0..7 or `"self"`; `scale` finite in -4..4; a `component` on a vector2 binding where the source is scalar (see §5.8). Any violation is `E_INPUT_FORMAT` with a JSON path.

### 3.2 Actions and state

```ts
export interface ActionOutput {
  readonly button?: number;            // 0..15 -> synthesized controller bit
  readonly stick?: "left" | "right";   // vector2 -> lx/ly or rx/ry
  readonly trigger?: "lt" | "rt";      // axis/button -> triggers
  readonly axis?: "lx" | "ly" | "rx" | "ry"; // axis -> one component
}

export interface InputAction {
  readonly name: string;               // ^[a-z][a-z0-9_.-]{0,47}$, unique, case-sensitive
  readonly kind: InputActionKind;
  readonly bindings: readonly InputBinding[]; // 1..15 (edge bit budget)
  readonly deadzone?: number;          // 0..0.9, default 0.15 for sticks/axes
  readonly threshold?: number;         // 0.01..1, default 0.5 for button/axis/vector press
  readonly hysteresis?: number;        // 0..0.5, default 0.1
  readonly yUp?: boolean;              // vector2 only, default false; see §5.8
  readonly output?: ActionOutput;
}

/** Pooled; valid until the next poll. Copy fields to retain. */
export interface ActionState {
  readonly pressed: boolean;
  readonly edges: number;              // bit 0 = action press; bit i+1 = binding i press
  readonly released: boolean;
  readonly releaseEdges: number;       // same bit layout
  readonly x: number;                  // vector2, -1..1; axis actions use x = value
  readonly y: number;                  // vector2, -1..1
  readonly value: number;              // button 0..1; axis |x|; vector magnitude 0..1
}

export interface InputMap {
  readonly actions: readonly InputAction[];
  readonly names: readonly string[];
  indexOf(name: string): number;       // -1 when unknown; no allocation
  /** Fills `out` from the router's current frame; returns `out`. Allocation-free. */
  poll(out: ActionState[]): ActionState[];
}
```

`edges`/`releaseEdges` are 16-bit masks: bit 0 is the action aggregate, bit `i+1` is binding `i`. `bindings.length <= 15`. A caller that needs more than 16 sources splits them across actions.

### 3.3 Raw snapshots

```ts
/** Structurally identical to the decoded phone packet; produced by the runtime adapter. */
export interface PhoneInputSample {
  readonly slot: number;
  readonly connected: boolean;
  readonly buttons: number;            // u16
  readonly edges: number;              // u16, OR-accumulated by the sender
  readonly lx: number;                 // -1..1, +right
  readonly ly: number;                 // -1..1, +down (screen convention)
  readonly rx: number;
  readonly ry: number;
  readonly gyro: { readonly x: number; readonly y: number; readonly z: number }; // dps
  readonly gyroActive: boolean;
  readonly gyroRecentered: boolean;
  readonly triggers: { readonly lt: number; readonly rt: number }; // 0..1
  readonly tick: number;               // u32, wrap-safe
}

export interface PointerSnapshot {
  readonly x: number;                  // CSS px in the target, +right
  readonly y: number;                  // CSS px, +down
  readonly dx: number;                 // motion accumulated since the previous poll, px
  readonly dy: number;
  readonly wheel: number;              // wheel delta accumulated since the previous poll
  readonly buttons: number;            // bit 0 left, bit 1 middle, bit 2 right
  readonly edges: number;              // press edges this tick
  readonly inside: boolean;
  readonly locked: boolean;            // pointer lock active
}

export interface GamepadSnapshot {
  readonly index: number;              // navigator.getGamepads() index
  readonly id: string;                 // diagnostic only
  readonly mapping: "standard" | "non-standard";
  readonly connected: boolean;
  readonly buttons: number;            // bitfield, standard buttons 0..16, bit = pressed
  readonly edges: number;              // press edges since the previous poll
  readonly releaseEdges: number;
  readonly triggerValues: { readonly lt: number; readonly rt: number }; // 0..1
  readonly axes: readonly number[];    // 4 standard axes, reused array
}

export interface FocusSnapshot {
  readonly focused: boolean;
  readonly visible: boolean;
  readonly pointerLocked: boolean;
  readonly lastBlurTick: number;       // -1 when the page has never blurred
}
```

### 3.4 The unified frame

```ts
/** Structurally identical to SDK GameControllerState; no SDK import. */
export interface ControllerView {
  slot: number;
  readonly connected: boolean;
  buttons: number;
  edges: number;
  lx: number;
  ly: number;
  rx: number;
  ry: number;
  gyro: { x: number; y: number; z: number };
  gyroActive: boolean;
  gyroRecentered: boolean;
  tilt?: { angleX: number; angleY: number; available: boolean };
  triggers: { lt: number; rt: number };
  tick: number;
}

export interface PlayerInput {
  readonly slot: number;
  readonly connected: boolean;
  readonly device: InputDeviceKind | "none";
  readonly actions: readonly ActionState[];
  /** Pooled. For a phone player this is the phone sample, identity-preserved. */
  readonly controller: ControllerView;
}

export interface InputFrame {
  readonly tick: number;
  readonly players: readonly PlayerInput[]; // always `slots` entries (default 8)
  /** The local player's actions: keyboard-assigned player, else player 0. */
  readonly actions: readonly ActionState[];
  readonly pointer: PointerSnapshot;
  readonly focus: FocusSnapshot;
  player(slot: number): PlayerInput | undefined;
  action(name: string): ActionState | undefined;
}
```

`InputFrame` is a single pooled object. `players` is a fixed array of pooled `PlayerInput`; `actions` is a fixed array of pooled `ActionState` per player. Nothing in the frame may be retained past the next `poll`; games copy what they need. `frame.player(slot)` returns the pooled entry, no allocation.

### 3.5 Router options and API

```ts
export interface FixedAssignment {
  readonly keyboard?: number;                          // 0..7
  readonly gamepads?: Readonly<Record<number, number>>; // pad index -> slot
}

export interface InputRouterOptions {
  readonly slots?: number;                 // 1..8, default 8
  readonly actions?: readonly InputAction[]; // default desktop map, §5.9
  readonly stickDeadzone?: number;          // 0..0.9, default 0.15
  readonly triggerDeadzone?: number;        // 0..0.9, default 0.05
  readonly pointerSensitivity?: number;     // default 1; scales dx/dy action values
  readonly fixed?: FixedAssignment;
  readonly conflictPolicy?: "replace" | "reject"; // default "replace"
  readonly bindings?: BindingOverlay;       // host-loaded user overrides
  readonly store?: BindingStore;            // persistence; optional
  readonly reservedKeys?: readonly string[]; // default list in §5.11
  readonly target?: HTMLElement | Window;   // event target; default window
  readonly preventContextMenu?: boolean;    // default false
  readonly clock?: () => number;            // performance.now test seam
  readonly createGamepads?: () => readonly (Gamepad | null)[]; // test seam
}

export interface InputRouter {
  readonly frame: InputFrame;
  readonly map: InputMap;
  readonly assignment: readonly AssignmentEntry[]; // sorted by slot; topology changes only
  readonly capturing: boolean;

  attach(target?: HTMLElement | Window): void;
  detach(): void;
  /** Exactly once per simulation tick, before game.simulate. Idempotent for one tick. */
  poll(tick: number): InputFrame;

  /** Runtime adapter, called when an InputFwd is decoded. */
  applyPhoneSample(slot: number, sample: PhoneInputSample, receivedAtMs: number): void;
  setPhoneConnected(slot: number, connected: boolean): void;
  setTilt(slot: number, tilt: ControllerView["tilt"]): void;

  beginCapture(
    action: string,
    bindingIndex: number,
    device: InputDeviceKind,
    timeoutMs?: number,
  ): Promise<RebindResult>;
  cancelCapture(): void;
  setBindings(overlay: BindingOverlay): void;
  saveBindings(): Promise<void>;

  subscribe(listener: (event: InputDeviceEvent) => void): () => void;
  reset(): void;
  dispose(): void;
}
```

`attach` installs listeners on the target for `keydown`, `keyup`, `pointerdown`, `pointerup`, `pointermove`, `pointercancel`, `wheel`, `contextmenu`, `blur`, `focus`, `visibilitychange`, `pointerlockchange`, `gamepadconnected` and `gamepaddisconnected`. `detach` removes exactly those listeners and clears held state by emitting releases. `dispose` implies `detach` and is idempotent.

### 3.6 Assignment and events

```ts
export interface AssignmentEntry {
  readonly slot: number;
  readonly device: InputDeviceKind;
  readonly deviceId: string;   // "keyboard" | "pointer" | "gamepad:0" | "phone:3"
}

export type InputDeviceEvent =
  | { readonly type: "press"; readonly device: InputDeviceKind; readonly slot: number; readonly code: string }
  | { readonly type: "release"; readonly device: InputDeviceKind; readonly slot: number; readonly code: string }
  | { readonly type: "gamepad-connected"; readonly index: number }
  | { readonly type: "gamepad-disconnected"; readonly index: number }
  | { readonly type: "focus-changed"; readonly focused: boolean }
  | { readonly type: "capture"; readonly result: RebindResult };
```

Device events allocate and are emitted only on real events (never per frame). They exist for menus and rebinding UI, not for gameplay.

### 3.7 Rebinding types

```ts
export type RebindFailure =
  | "cancelled" | "reserved" | "conflict" | "unsupported" | "timeout" | "busy";

export type RebindResult =
  | { readonly ok: true; readonly action: string; readonly binding: number; readonly device: InputDeviceKind; readonly code: string }
  | { readonly ok: false; readonly reason: RebindFailure; readonly conflict?: { readonly action: string; readonly binding: number } };

export interface BindingStore {
  /** Host shell supplies persistence; the engine never touches localStorage or files. */
  save(overlay: BindingOverlay): Promise<void>;
}
```

### 3.8 Reading input from a game

M0 games keep the frozen `GameInputReader` (`snapshot`, `update`, `poll`, `player`, `events`). The runtime adapter feeds it a synthesized `InputSnapshot` derived from `InputFrame` (§5.10), so existing games need no change. The unified frame is exposed additively by spec 18:

```ts
// Proposed additive SDK surface, owned by spec 18, not implemented by this spec.
export interface GameInputReader {
  /** Engine action/pointer/focus frame; valid until the next tick. */
  readonly frame?: InputFrame;
}
```

Until spec 18 lands, engine demos and experiments read `InputRouter.frame` directly. Spec 18 must decide whether `GameContext.input.frame` is optional (recommended) and whether `frame.actions` shadows `readAction`; this spec supplies the types, not the SDK change.

### 3.9 Additive error codes

```ts
"E_INPUT_FORMAT"    // input.map.json or input-bindings.json invalid
"E_INPUT_CONFLICT"  // fixed assignment or binding conflict that cannot be resolved
"E_INPUT_RESERVED"  // rebinding a reserved key
"E_INPUT_CAPTURE"   // capture is busy or the device cannot be captured
"E_INPUT_TICK"      // non-monotonic tick (dev only; production clamps)
"E_INPUT_DEVICE"    // gamepad/pointer API unavailable (counted, not fatal)
```

Map errors fail the game load with a path (`actions[3].bindings[1].axis`). Runtime device errors never throw into `simulate`; they are counted and surfaced in the debug overlay.

---

## 4. Data formats

### 4.1 `input.map.json` (optional, game root)

A game ships a map when it wants named actions. Without one, the built-in desktop map (§5.9) is used and existing phone games work untouched.

```json
{
  "formatVersion": 1,
  "actions": [
    {
      "name": "move",
      "kind": "vector2",
      "deadzone": 0.15,
      "yUp": true,
      "bindings": [
        { "device": "keyboard", "code": "KeyW", "component": "y", "scale": -1 },
        { "device": "keyboard", "code": "KeyS", "component": "y", "scale": 1 },
        { "device": "keyboard", "code": "KeyA", "component": "x", "scale": -1 },
        { "device": "keyboard", "code": "KeyD", "component": "x", "scale": 1 },
        { "device": "phone", "slot": "self", "channel": "axis", "axis": "lx" },
        { "device": "phone", "slot": "self", "channel": "axis", "axis": "ly" },
        { "device": "gamepad", "pad": "self", "axis": 0 },
        { "device": "gamepad", "pad": "self", "axis": 1 }
      ],
      "output": { "stick": "left" }
    },
    {
      "name": "primary",
      "kind": "button",
      "bindings": [
        { "device": "keyboard", "code": "Space" },
        { "device": "gamepad", "pad": "self", "button": 0 },
        { "device": "phone", "slot": "self", "channel": "button", "bit": 0 }
      ],
      "output": { "button": 0 }
    }
  ]
}
```

Limits: UTF-8 JSON ≤ 32 KB; `formatVersion` must be `1`; ≤ 64 actions; 1..15 bindings per action; action names unique and matching the pattern in §3.2; `kind` is one of the three values; `deadzone` 0..0.9; `threshold` 0.01..1; `hysteresis` 0..0.5; `output` has exactly one member and its type matches the action kind (§5.8). Unknown fields are ignored. Any violation is `E_INPUT_FORMAT` naming the JSON path; the game is not started with a half-loaded map.

### 4.2 `input-bindings.json` (optional, user/host overlay)

```json
{
  "formatVersion": 1,
  "updatedAt": "2026-10-22T12:00:00.000Z",
  "bindings": {
    "primary": [{ "device": "keyboard", "code": "KeyF" }],
    "move": null
  }
}
```

Semantics: each key replaces the **entire binding list** for that action from the base map; `null` removes the override and restores the map. Unknown action names are ignored with a counter (a game update may have removed an action). Limits: ≤ 16 KB; ≤ 64 entries; binding validation identical to §4.1. `updatedAt` is ISO-8601 UTC with milliseconds and is informational only; v1 never merges by timestamp. The engine never writes this file. The host shell loads it, passes it as `options.bindings`, and saves through `BindingStore`.

### 4.3 Trace fixtures (`input-trace-v1`)

Deterministic traces drive the keyboard/pointer/gamepad conformance suite. Events apply in array order **before** the poll of their `tick`; a `tick` event advances the router.

```json
{
  "formatVersion": 1,
  "seed": 12345,
  "events": [
    { "tick": 1, "type": "keydown", "code": "KeyW" },
    { "tick": 1, "type": "tick" },
    { "tick": 2, "type": "keyup", "code": "KeyW" },
    { "tick": 2, "type": "tick" },
    { "tick": 3, "type": "pointermove", "movementX": 12, "movementY": -3, "buttons": 0 },
    { "tick": 3, "type": "tick" },
    { "tick": 4, "type": "gamepad", "index": 0, "buttons": [1, 0, 0, 0], "axes": [0, 0, 0, 0] },
    { "tick": 4, "type": "tick" }
  ],
  "expect": [
    { "tick": 1, "action": "move", "y": -1, "value": 1 },
    { "tick": 2, "action": "move", "y": 0, "value": 0 }
  ]
}
```

Event types: `keydown`, `keyup`, `pointermove` (`movementX`, `movementY`, `buttons`), `pointerdown`/`pointerup` (`button`), `wheel` (`deltaY`), `gamepad` (full button array + 4 axes), `gamepad-connected`/`gamepad-disconnected`, `blur`, `focus`, `visibility` (`hidden` boolean), `tick`. `seed` is reserved for generated traces and must be deterministic; the runner must not use wall time. `expect` is a subset check on named action fields, so a trace stays readable as maps evolve.

### 4.4 Versioning

Both config files and the trace use `formatVersion: 1`. A reader refuses an unknown version with `E_INPUT_FORMAT`; it never guesses. Adding an optional field does not bump the version; changing an existing field's meaning does and needs a migration note (00 §4.1).

### 4.5 Privacy

Bindings contain only `KeyboardEvent.code`, button/axis indices and device kinds. They never contain a player name, room code, token or session id. Trace fixtures are synthetic; no real keystroke log is committed. `BindingStore` points at host-owned storage; the engine does not log the overlay.

---

## 5. Architecture

### 5.1 Modules

```
packages/engine/input/src/
  InputRouter.ts          facade: attach, poll, capture, assignment, dispose
  types.ts                public types from §3; contract authority
  InputFrame.ts           pooled frame builder (players, actions, pointer, focus)
  map/ActionMap.ts        compile and validate actions into source plans
  map/config.ts           input.map.json parsing
  map/overlay.ts          input-bindings.json parsing and merge
  map/defaultMap.ts       built-in desktop map (§5.9)
  resolve/Deadzone.ts     radial and scalar deadzone math (pure)
  resolve/ResolveAction.ts per-action resolution (pure over a source view)
  resolve/Merge.ts        button/axis/vector merge and edge computation (pure)
  devices/Keyboard.ts     keydown/keyup, pending edges, preventDefault policy
  devices/Pointer.ts      pointer, wheel, lock, motion accumulation
  devices/Gamepad.ts      standard-mapping poll, diff edges, hotplug
  devices/Focus.ts        blur/focus/visibility and release-on-blur
  devices/Assignment.ts   deterministic slot assignment (pure)
  devices/Rebind.ts       capture state machine, conflict policy
  phone/PhoneAdapter.ts   wraps InputMapper and feeds the router
  phone/InputMapper.ts    migrated verbatim from runtime (M0)
  phone/TiltIntegrator.ts migrated verbatim from runtime (M0)
  index.ts                package exports
```

DOM access is confined to `InputRouter`, `devices/Keyboard`, `devices/Pointer`, `devices/Gamepad`, `devices/Focus` and `devices/Rebind` (00 D11). `resolve/**`, `map/**`, `devices/Assignment.ts` and `phone/**` are pure and run in Node with no DOM. `engine-input` imports `engine-core` only; it never imports `@lanpad/protocol`, `@lanpad/sdk`, `@lanpad/runtime`, the controller, the broker or a game.

### 5.2 Pipeline and poll order

Browser event handlers and phone packets mutate **raw state only**. They never resolve actions, never touch the frame and never call a game. Resolution happens once per tick:

```
poll(tick):
  1. tick guard: same tick -> return the current frame unchanged;
     older tick -> E_INPUT_TICK in dev, ignored in production
  2. gamepads: poll only if a pad is known (see §5.6)
  3. focus: refresh from event-driven state
  4. assignment: recompute only when topology changed (phone join/leave, pad hotplug, fixed change)
  5. per slot: update ControllerView (phone sample copy, or synthesis for keyboard/pointer/gamepad)
  6. per player: resolve actions from raw state, compute edges vs previous levels, clear pending
  7. pointer: snapshot position/buttons/locked, then clear the dx/dy/wheel accumulators
  8. write the pooled InputFrame in place and return it
```

Rules:

- `poll` is called exactly once per simulation tick, **before** `game.simulate` (spec 01 §3.7). A second call with the same tick is idempotent: it returns the existing frame and does not re-emit edges. A decreasing tick is a dev error (`E_INPUT_TICK`) and is ignored in production.
- Events that occur after `poll` and before the next `poll` are next tick's input. Nothing mutates the frame while `simulate` runs on the main thread.
- `simulate` must not call `poll`, `setBindings`, `reset` or any capture method. Those are host/UI operations.
- `detach`/`dispose` clear held state and emit release edges once; no phantom presses after re-attach.
- `reset()` clears raw state, pending edges, capture, assignment (except phones) and the frame; it keeps the map and bindings. It is for returning to the start screen, not for per-tick use.

### 5.3 Phone bridge

The phone path is a **reference implementation**, not a new protocol. The wire is frozen (SPEC §7.2):

| Field | Wire type | Range / meaning | Engine mapping |
|---|---|---|---|
| `tick` | `u32` | sender tick, wraps | wrap-safe comparison (§5.3.1) |
| `buttons` | `u16` | level bitmask, layout-defined bits | bit set → 1, clear → 0 |
| `edges` | `u16` | press edges, OR-accumulated by the sender | OR-accumulated again until the host poll |
| `lx`, `ly` | `i16` | -32767..32767, `ly` +down | `v / 32767`, clamped to -1..1 |
| `rx`, `ry` | `i16` | same | same |
| `lt`, `rt` | `u8` | 0..255 | `v / 255` |
| `gyro.x/y/z` | `i16` | dps × 10 | `v / 10` |
| `flags` | `u8` | bit 0 motion active, bit 1 recentered | `gyroActive`, `gyroRecentered` |

The runtime adapter decodes the 26-byte `Input` or 27-byte `InputFwd` with the protocol codec (`decodeInputFwdInto`, allocation-free), strips the `slot` byte from `InputFwd`, and calls `router.applyPhoneSample(slot, sample, receivedAtMs)`. **`engine-input` never sees the bytes and never imports the protocol.**

#### 5.3.1 Level and edge rules (parity with `InputMapper`)

- Any packet marks the slot connected and refreshes `lastSeen`.
- `edges |= packet.edges` on every packet, regardless of tick order. Edges are never dropped because a packet arrived late.
- Level fields (`buttons`, sticks, triggers, gyro, flags) apply only when the packet is not older than the last applied tick:
  `diff = (packet.tick - lastTick) >>> 0; apply if diff < 0x80000000`. `diff === 0` applies (the newest sample wins). This is exactly the runtime `InputMapper` rule and is tested for parity (ER-10-03/04).
- At `poll`, the accumulated `edges` is published as the controller's `edges`, then cleared.
- `setPhoneConnected(slot, false)` zeroes that slot's levels and edges, sets `connected = false`, and emits no synthetic releases. A lost phone is a disconnect, not a button-up sequence. A reconnect starts from the next packet.
- The controller applies its 8% deadzone before sending (SPEC FR-7.4). The engine does **not** re-deadzone phone sticks unless an action sets a deadzone; the existing values are already rescaled. Documented because double deadzoning shrinks the usable range.
- Tilt is **not** integrated here in M0: the runtime owns a migrated `TiltIntegrator` and passes its pooled `TiltState` through `router.setTilt(slot, tilt)`. The router copies the three fields into `ControllerView.tilt`.
- Packet rate and age statistics stay in `PhoneAdapter`/`InputMapper` (`packetsPerSecond`, `drops`, `lastInputAgeMs`) for the debug overlay. They are not part of `InputFrame`.

#### 5.3.2 Simulation-time parity

`InputMapper.pollAll(hostTick)` remains the reference behaviour. `PhoneAdapter` wraps an `InputMapper` and converts its `InputSnapshot` into `PlayerInput.controller` for phone slots each poll. The engine router does not reimplement the phone math; it delegates. This is the migration seam that keeps ER-10-03 bit-for-bit.

### 5.4 Keyboard

- Bindings use `KeyboardEvent.code` (physical key). If `code` is empty (old TV browsers), the router normalizes `event.key` through a fixed table for arrows, Enter, Escape, Space, Tab, Backspace, digits and letters; the normalization is counted in `stats.keyFallbacks`.
- `keydown`: if `event.repeat`, ignore. Otherwise set `down[id] = 1` and `pendingPress[id] = 1`.
- `keyup`: set `down[id] = 0` and `pendingRelease[id] = 1`.
- A keydown and keyup between two polls leave both pending flags set. At poll, the action gets a press edge and a release edge while the level stays 0. This is the sub-tick tap guarantee (ER-10-02).
- Key ids are assigned from a compiled table of every code used by the active map plus reserved keys, capped at 256. A new code outside the table gets an id on first use (an event-time allocation, not per frame); beyond 256, unknown codes are counted and ignored. `Map<string, number>` lookups are not on the per-frame path because polling uses the compiled id arrays.
- `preventDefault` is applied only when `preventDefault: true` (default true for the game canvas attach) and only for codes bound to an action, excluding reserved browser keys. Default prevention list for bound game keys: `Space`, `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`. Tab is never prevented (focus navigation).
- The keyboard is global; only the keyboard-assigned player resolves keyboard sources (see §5.8.6). Other players see a zero keyboard contribution.
- Physical `code` means WASD is positional: on AZERTY the physical W key is `KeyZ`. Rebinding is the supported remedy; a layout-aware mode is explicitly out of scope.

### 5.5 Pointer

- The pointer belongs to the local player only. It is never assigned to a phone slot and never synthesized into another player's controller.
- `pointermove` accumulates `movementX`/`movementY` into `dx`/`dy`. When `movementX/Y` are unavailable (older browsers), the router computes the delta from the previous `clientX/clientY`; the first move after attach contributes zero. Position `x/y` comes from `offsetX/offsetY` relative to the target.
- `pointerdown`/`pointerup` set/clear the button bit and OR a pending press/release for that button. `pointercancel` clears all buttons and emits releases. With `capturePointer: true` (default), the router calls `setPointerCapture` on down and releases it on up so a drag outside the canvas is still observed.
- `wheel` accumulates `deltaY` normalized by `deltaMode`: pixels ×1, lines ×16, pages ×100. It is cleared at poll.
- Absolute position action values: `x = clamp((px / width) * 2 - 1, -1, 1)`, `y = clamp((py / height) * 2 - 1, -1, 1)`. They are for aim/cursor actions; games that need a ray build it from the camera.
- Motion action values: `clamp(accumulated * pointerSensitivity / 100, -1, 1)`. A 100 px flick is full deflection. Precision look should read `frame.pointer.dx/dy` directly; the normalized action value is for camera-rate-like use.
- `pointerlockchange` updates `locked`. On lock exit, held buttons are cleared and released, and motion stops accumulating until the pointer moves again. Escape exits lock in the browser and is never bindable.
- `contextmenu` is prevented only when `preventContextMenu: true` (default false). The host shell decides whether right-click is a game input or a browser menu.
- Host touch uses the same pointer path; a touch drag is a pointer drag. Multi-touch on the host is not mapped to multiple players (phones are the multiplayer path).

### 5.6 Gamepad

- Only `mapping === "standard"` pads drive actions. A non-standard pad is counted (`stats.nonStandardPads`) and shown in the debug overlay; it is never guessed.
- Standard layout used by bindings: buttons 0 A, 1 B, 2 X, 3 Y, 4 LB, 5 RB, 6 LT, 7 RT, 8 Back, 9 Start, 10 LS, 11 RS, 12 D-pad up, 13 down, 14 left, 15 right, 16 Home. Axes 0 LX (+right), 1 LY (+down), 2 RX (+right), 3 RY (+down). LT/RT analog values come from `buttons[6].value`/`buttons[7].value`; the button bit is set at `value >= 0.5`.
- Polling: `navigator.getGamepads()` returns a browser-owned array; the engine does not retain it. Poll every tick while at least one pad is known. While zero pads are known, scan once every 60 ticks (1 Hz) to catch pads that connected before the page loaded; `gamepadconnected`/`gamepaddisconnected` update the known set immediately.
- Copy `pressed` bits into a `Uint32`, trigger values into two floats, and axes 0..3 into a preallocated `Float32Array`. Never hold a `Gamepad` object across ticks.
- Edges: because there are no button events, edges are the diff between this poll's pressed bitfield and the previous poll's. A press and release entirely between two polls is **not recoverable** and is documented as a limitation (60 Hz polling makes it rare). Phone edges do not have this limitation because the controller batches them.
- Hotplug: a newly connected pad is assigned only after its first **meaningful** input (any button pressed or any stick magnitude > 0.5). Chrome exposes all-zero pads before a gesture; assigning on connection would create a phantom player. The first meaningful input is deterministic in a trace.
- Disconnect: the next poll clears the pad's buttons, emits release edges for anything held, and marks the assignment dirty. A disconnected pad keeps its slot reserved for 30 s? No: this is input, not sessions. The slot is released at once; a reconnected pad goes through assignment again. Reconnect within the same session is common, so the assignment is deterministic but not sticky.
- Gamepad API absence (some TV browsers) is not fatal: `E_INPUT_DEVICE` is counted once, the pad list is empty, and keyboard/phone paths continue.

### 5.7 Focus and page lifecycle

- `FocusSnapshot` is event-driven: `focus`/`blur` on the window, `visibilitychange` on the document, and `pointerlockchange`. `document.hasFocus()` is read only at attach and on those events, never per frame.
- On losing focus (blur, hidden tab, detach): every held key and pointer button is marked released **and cleared**. Pending press flags are discarded. This emits release edges exactly once, so a game cannot see a stuck key after the tab returns. Pointer motion and wheel accumulators are zeroed.
- Gamepad state is **not** cleared on blur: a pad keeps its physical state, and the game decides whether to pause via `frame.focus.focused`. A pad button held across a blur is still held, which matches player expectation.
- On regaining focus, nothing is resurrected: a key must be pressed again to be down. `lastBlurTick` records the last polled tick at the blur so a game can detect the transition.
- The host loop already pauses on hidden (spec 01 pause reasons); input still clears state so a resumed frame is clean.
- Pointer lock exit clears held mouse buttons with releases. Escape is consumed by the browser to exit lock and is never bindable.
- `detach()` performs the same clearing as a blur and removes listeners. `attach()` after `detach()` starts from all-up with no pending edges.

### 5.8 Deadzones, resolution and merging

Each action is compiled once into a plan. Resolution is pure over a source view and allocates nothing.

#### 5.8.1 Source values

| Source | Value before deadzone | Notes |
|---|---|---|
| phone button | `(buttons >>> bit) & 1` | 0 or 1 |
| phone stick `lx/ly`, `rx/ry` | pair `(x, y)` in -1..1 | `ly`/`ry` +down; pair deadzoned radially |
| phone trigger `lt/rt` | 0..1 | scalar deadzone |
| keyboard | 1 when down, else 0 | `scale` applies |
| pointer button | 1 when down, else 0 | edges from pending flags |
| pointer absolute `x/y` | `(p / size) * 2 - 1` clamped | aim/cursor only |
| pointer motion `dx/dy` | `clamp(accumulated * sensitivity / 100, -1, 1)` | precision look reads the snapshot |
| pointer wheel | `clamp(accumulated / 100, -1, 1)` | cleared at poll |
| gamepad button | `buttons[i].value` (0/1 or 0..1 for triggers) | analog triggers usable |
| gamepad stick axes | pair `(axis0, axis1)` or `(axis2, axis3)` | pair deadzoned radially |
| gamepad single axis | -1..1 | scalar deadzone |

#### 5.8.2 Deadzone

Radial deadzone `dz` over a pair:

```
m = hypot(x, y)
if m <= dz:        x' = 0, y' = 0
else:              s = (m - dz) / (1 - dz); x' = x / m * s; y' = y / m * s
```

Scalar deadzone: `|v| <= dz ? 0 : sign(v) * (|v| - dz) / (1 - dz)`.

`dz` is the action's `deadzone` when set; otherwise `stickDeadzone` (0.15) for stick pairs, `triggerDeadzone` (0.05) for triggers, and 0 for keys, pointer motion and pointer buttons. The full physical pair is used for the magnitude even when only one component is bound, so a diagonal stick does not gain magnitude from the unbound axis. The pair is deadzoned once per action per tick, then each binding reads its component.

Phone sticks already carry the controller's 8% deadzone; the engine adds the action deadzone only when the map sets one. A map that sets `deadzone: 0` trusts the phone's 8% and the pad's raw noise; that is a deliberate game choice.

#### 5.8.3 Merge

- **Button**: `value = max(source_i)` in 0..1. A key and a pad button pressed together still yield 1.
- **Axis**: `valueSigned = clamp(sum(scale_i * source_i), -1, 1)`. Stored in `x`; `value = |x|`.
- **Vector2**: `sx = sum(x contributions)`, `sy = sum(y contributions)`; `len = hypot(sx, sy)`. If `len > 1`, divide both by `len`. `value = min(1, len)`. If `yUp`, the stored `y = -sy`; `x = sx`. `value` is computed before the flip.

Contributions come from each binding's `component`; a scalar source bound to a vector action must declare one. Defaults: keyboard/pointer/gamepad scalar sources contribute to `x` when omitted; phone `lx`/`rx` default to `x`, `ly`/`ry` to `y`; phone `lt`/`rt` require an explicit component on a vector action.

#### 5.8.4 Press, release and edges

Let `t = threshold` (default 0.5) and `h = hysteresis` (default 0.1).

- A digital source is pressed when its value is 1. An analog source is engaged when `value >= t` and disengaged when `value <= t - h`; between the two it keeps its previous state. This prevents chatter on a stick held near the threshold.
- Button actions: `pressed` follows engagement of the merged value.
- Axis and vector2 actions: `pressed = value >= t`, `released` when `value <= t - h`; the direction is read from `x/y`, not from `pressed`.
- Per-binding edges: `press_i = pendingPress_i || (engagedNow_i && !engagedPrev_i)`; `release_i = pendingRelease_i || (!engagedNow_i && engagedPrev_i)`. Pending flags cover sub-tick taps for keyboard and pointer; phone edges are OR-accumulated; gamepad uses the poll diff.
- Aggregate `edges` bit 0 is set if any binding has a press edge; bit `i+1` mirrors binding `i`. `releaseEdges` is symmetric. After computing, clear all pending flags and store the new engaged levels.
- A key pressed and released between polls therefore yields `pressed=false`, `edges` bit 0 set, `released=true`, `releaseEdges` bit 0 set in the same poll. This is the contract ER-10-02 tests.
- `reset()` and blur clear pending flags and previous levels, so no edge is emitted twice.

#### 5.8.5 `yUp` and orientation

Raw device convention is **screen space**: +x right, +y down. This matches the 2D renderer (spec 02), the phone wire, pointer motion and gamepad axes. A 3D game sets `yUp: true` on movement vectors and binds W/up with `scale: -1`; pressing W then yields `y = +1` (world up). A 2D top-down or platformer that uses screen coordinates leaves `yUp` false. `yUp` applies only to `vector2` actions; setting it on a button/axis is `E_INPUT_FORMAT`.

**Synthesis never applies `yUp`.** A synthesized controller's `ly/ry` are always screen convention (+down), because that is what phone-first games already read. This is the single most important compatibility rule in this spec.

#### 5.8.6 Device scope per player

- **Phone sources** may target any slot. `"self"` is the resolving player's slot. A map can bind another slot's phone (shared local control), which is deliberate.
- **Keyboard and pointer sources** resolve only for the **local player** (the keyboard-assigned player, else player 0). For every other player they contribute 0. This prevents one keyboard from driving four players.
- **Gamepad sources** with `"self"` use the player's assigned pad; an explicit index targets that pad for any player. Shared-pad maps are allowed but discouraged.
- A player's action list is the same list for all players; device scope decides which bindings contribute.

### 5.9 Default map and virtual controller synthesis

When a game ships no `input.map.json`, the router uses `defaultDesktopMap()`. It exists so existing phone-first games and new demos work with keyboard/mouse/gamepad without game code.

| Action | Kind | Bindings | Output |
|---|---|---|---|
| `move` | vector2, `yUp: true`, dz 0.15 | `KeyW` y -1, `KeyS` y +1, `KeyA` x -1, `KeyD` x +1; `ArrowUp/Down/Left/Right`; phone `lx/ly` self; gamepad axes 0/1 self | `stick: "left"` |
| `look` | vector2, dz 0.15 | phone `rx/ry` self; gamepad axes 2/3 self (**no mouse**) | `stick: "right"` |
| `primary` | button | `Space`, `Enter`, gamepad 0 | `button: 0` |
| `secondary` | button | `ShiftLeft`, gamepad 1 | `button: 1` |
| `interact` | button | `KeyE`, gamepad 2 | `button: 2` |
| `pause` | button | `Escape`, `KeyP`, gamepad 9 | `button: 9` |
| `back` | button | `Backspace`, gamepad 8 | `button: 8` |

Notes:

- No phone **button** bindings in the default map. Button bits are layout-defined per game; guessing them would fire the wrong action. A game that wants phone buttons in its action map adds them with its layout's bit numbers.
- Mouse look is read from `frame.pointer.dx/dy` by the camera/game, not bound to `look`. Binding it would normalize pixels into an arbitrary -1..1 value and lose precision.
- The output button numbers 0/1/2/9/8 match the reference games' layout allocation. A game with a different layout ships its own map; the numbers are not protocol constants.

Synthesis rules (`ControllerView` for a non-phone player):

- `connected = assignment !== none` (and, for a gamepad, `pad.connected`). `device` is `"keyboard"`, `"gamepad"` or `"none"`.
- For each action with an `output`:
  - `button`: set bit when `pressed`; set the same bit in `edges` when `edges & 1`.
  - `stick`: add the action's **pre-`yUp`** `x/y` to the left or right stick. Multiple actions sum; clamp magnitude to 1. `ly/ry` stay +down.
  - `trigger`: `value` clamped 0..1 for axis/button actions; multiple actions take the max.
  - `axis`: set that component from the signed `x` of an axis action, or from `x/y` of a vector for the matching component.
- `gyro` is zero, `gyroActive=false`, `gyroRecentered=false`, `tilt` undefined, `tick = frame.tick`.
- A phone player's `ControllerView` is the phone sample copied field-for-field (plus `tilt` if set). Actions may still bind phone sources, but synthesis does not overwrite the phone's bits.
- One device per player in v1. A phone presence always wins a slot; keyboard and pads fill the rest.

Existing games therefore see a keyboard player as a controller with a connected flag, a left stick and button bits — no game change. ER-10-10 proves it against both reference games.

### 5.10 Player assignment

Slots are 0..7 (SPEC: 8 controllers). Phone slots are sacred; keyboard and gamepads fill the rest.

Algorithm (run only when the topology changes):

1. **Phones own their slots.** Every connected phone slot is marked owned. A phone's player slot is its room slot, always; it is never reassigned, because the layout, private panel and haptics are tied to that slot.
2. **Keep stable auto assignments.** Existing keyboard/pad assignments that do not conflict with an owned phone slot are kept. A device is never moved just because a lower slot became free.
3. **Displace on phone join.** If a phone connects to a slot held by an auto device, that device becomes unassigned; it is not given the phone's old slot automatically.
4. **Fixed assignments apply first.** `fixed.keyboard` and `fixed.gamepads[padIndex]` claim their slots when free and not phone-owned. A fixed conflict with a phone is ignored and counted (`E_INPUT_CONFLICT`); the phone wins. Two fixed devices claiming one slot resolve by order: keyboard, then pads by ascending index; the loser is counted and left unassigned.
5. **Fill unassigned devices.** The keyboard takes the lowest free slot; then pads in ascending `navigator` index take the lowest free slots. A pad is only eligible after its first meaningful input (§5.6), so an all-zero pad cannot claim a player.
6. **No free slot.** Extra auto devices stay unassigned (`device: "none"`, `connected: false`) rather than sharing a slot. One device per player in v1.

Topology changes: phone connect/disconnect, gamepad first meaningful input, gamepad disconnect, `fixed` option change, `reset`. A phone packet that only updates levels does not recompute assignment. Sorting 8 entries on a topology change is allowed; it must not happen per poll.

`frame.players` always has `slots` entries (default 8). An unassigned slot has `connected: false`, `device: "none"`, zeroed actions and a zeroed controller. Existing games already iterate `players` and check `connected`, so this shape is compatible (ER-10-10).

Disconnect rules: a phone disconnect frees its slot but does not migrate auto devices (stability over convenience); the next topology change may fill it. A gamepad disconnect releases its slot at once and emits releases for held buttons. Reconnect goes through assignment again.

### 5.11 Rebinding

Reserved keys (default, overridable): `Escape`, `F5`, `F11`, `F12`, `Tab`. `Escape` always cancels a capture and is never bindable. `Tab` stays available for focus navigation. A game may add reserved codes but may not remove `Escape` from the cancel role.

Flow:

1. `beginCapture(action, bindingIndex, device, timeoutMs)` validates the action and index, refuses a second concurrent capture (`busy`), and refuses phone capture (`unsupported` — phone bindings are layout-defined and hot-swapped by the game, SPEC FR-7.14).
2. While capturing, the captured device's events are consumed by the capture and do **not** drive actions. Other devices continue normally. This prevents the game from reacting to the new key.
3. Keyboard: the next `keydown` with `repeat === false`. A reserved code fails with `reserved`; `Escape` fails with `cancelled`.
4. Gamepad: the next button press (standard index) or axis magnitude > 0.6. A button becomes a `button` binding; an axis becomes an `axis` binding with `component` defaulted from the axis (0→x, 1→y, 2→x, 3→y) and `scale` `+1` or `-1` from the direction. The first pad that produces input is captured.
5. Pointer: the next `pointerdown` (button 0..2) or `wheel`. Motion alone never captures (too noisy). Pointer capture is allowed even though the pointer belongs to the local player.
6. Success builds the new binding, preserving the old binding's `component` and `scale` when the device kind is unchanged. The effective binding list is copied, the entry replaced, and the overlay updated for that action.
7. Conflict detection compares the captured source against the same device kind across all actions. `conflictPolicy: "replace"` removes the conflicting binding from the other action; if that would leave the other action with zero bindings, the rebind is refused with `conflict` (a critical action cannot be silently unbound). `"reject"` refuses with `conflict`. In both cases the map is unchanged.
8. Timeout (default 10 s), `cancelCapture()`, blur or `detach` end the capture with `timeout`/`cancelled`; no change is applied.
9. `setBindings(overlay)` recompiles atomically. An invalid overlay fails with `E_INPUT_FORMAT` and keeps the previous bindings.
10. `saveBindings()` calls `store.save(overlay)`; a rejected promise or missing store is counted and ignored. The engine never touches `localStorage`, files or the network.

Capture is a UI operation. The host shell must pause input-driven gameplay or show a modal while capturing; the engine does not pause the loop. Rebinding applies from the next `poll`; it never mutates the current frame.

### 5.12 Hot path, allocation and determinism

`poll` allocates nothing. Everything it touches is preallocated at construction: the frame, player entries, action states, controller views, pointer/focus snapshots, compiled plans, source-value scratch arrays, typed arrays for key and button state, and the assignment scratch list. No `map`/`filter`/`forEach`, no closures created per poll, no string concatenation, no `JSON.parse` in the frame path.

Two documented exceptions, both bounded and outside engine churn:

- `navigator.getGamepads()` returns a fresh browser-owned array per call. The engine copies what it needs and drops the reference. It is called only while a pad is known (or at 1 Hz when none is known), never when gamepads are absent and never per action.
- A previously unseen key code allocates a map entry on its first `keydown`, not per frame; the id table is capped at 256.

Determinism: a trace plus a map produces the same `InputFrame` sequence on every run. Ordering comes from trace order and tick numbers, never from wall-clock timestamps. `clock()` is used only for phone rate statistics. Rebinding and assignment are deterministic functions of topology and overlay. The spec-19 determinism harness may hash `frame.actions` per tick.

### 5.13 Migration (M0)

The M0 move preserves behaviour and freezes nothing new for phone games:

| Today | M0 location | Rule |
|---|---|---|
| `packages/runtime/src/input/InputMapper.ts` | `packages/engine/input/src/phone/InputMapper.ts` | Move verbatim; keep `apply`, `pollAll`, `reset`, `getSlot`, `getStats`, constants and semantics |
| `packages/runtime/src/input/TiltIntegrator.ts` | `packages/engine/input/src/phone/TiltIntegrator.ts` | Move verbatim |
| `packages/runtime/src/input/types.ts` | `packages/engine/input/src/types.ts` | `ControllerState`, `InputSnapshot`, `InputMapperOptions`, `SlotStats`; structurally identical to the SDK |
| `packages/runtime/src/game/InputReader.ts` | unchanged, runtime | `SnapshotInputReader` and `GameEventQueue` are host glue; fed from `InputFrame` |
| `packages/runtime/src/main.ts` / `GameHost` | integration-owned | Construct one router; attach on game start, detach on return to the launcher; call `poll(tick)` before `simulate`; pass decoded phone samples |

The runtime keeps deprecated re-exports of `InputMapper` and `TiltIntegrator` for one wave, then deletes them at M1 (00 §5.13). `engine-input` must not import runtime, protocol or SDK; the runtime adapter is the only place where protocol bytes and the engine frame meet.

Migration is one writer: the integration agent owns the runtime files; the engine package owner writes only `packages/engine/input/**`. No two agents touch `main.ts`, `GameHost` or the runtime input files in the same wave.

### 5.14 Known behaviour differences from the phone-only mapper

These are deliberate and tested:

- `ControllerState.connected` for a keyboard/pad player is true while assigned, even if no key is held. Existing games show a player as present before the first input; that is intended for local multiplayer.
- `edges` for a synthesized controller combines action edges; a keyboard press emits a controller edge on the mapped bit. Phone players keep phone edges unchanged.
- `tilt` is absent for keyboard/pad players. Games that require tilt must feature-detect it.
- Gamepad edges are poll-diffed, so a sub-tick pad tap can be missed; phone and keyboard taps cannot. Documented in §5.6.
- A phone reconnect starts from the next packet; no synthetic button-up is emitted on loss. Games that cache held buttons must treat `connected === false` as "all up".

---

## 6. File ownership

This spec owns `docs/engine/10-input.md` and the implementation paths below. The canonical package path is `packages/engine/input` (00 §6); the brief's `packages/input` is shorthand. Root `package.json`, `tsconfig.json`, the root Vitest project entry and the runtime adapter are integration-owned and edited serially at the wave boundary.

| Path | Milestone | Contents |
|---|---|---|
| `packages/engine/input/src/types.ts` | M0 | Public types from §3; contract authority |
| `packages/engine/input/src/index.ts` | M0 | Exports; DOM-free surface except the documented entries |
| `packages/engine/input/src/InputRouter.ts` | M0 | Facade, attach/detach, poll, capture, dispose |
| `packages/engine/input/src/InputFrame.ts` | M0 | Pooled frame and controller views |
| `packages/engine/input/src/map/**` | M0 | Compile, validate, default map, overlay |
| `packages/engine/input/src/resolve/**` | M0 | Deadzone, resolution, merge (pure, Node-testable) |
| `packages/engine/input/src/devices/Keyboard.ts`, `Pointer.ts`, `Gamepad.ts`, `Focus.ts` | M0 | Browser device capture |
| `packages/engine/input/src/devices/Assignment.ts` | M0 | Deterministic slots (pure) |
| `packages/engine/input/src/devices/Rebind.ts` | M0 | Capture state machine and conflict policy |
| `packages/engine/input/src/phone/InputMapper.ts`, `TiltIntegrator.ts`, `PhoneAdapter.ts` | M0 | Migrated phone path plus the adapter |
| `packages/engine/input/test/**` | M0 | Unit, property, golden trace, integration |
| `packages/engine/input/test/fixtures/**` | M0 | `input-trace-v1` traces, maps, overlays, expected frames |
| `experiments/e-m0-input/**` | M0 | Browser probe and allocation benchmark (co-owned with spec 19) |
| `packages/runtime/src/input/*` | M0 migration | Deprecated re-exports; integration agent owns the edit |
| `packages/runtime/src/main.ts`, `game/GameHost.ts` | M0 integration | Router construction, poll placement, phone adapter; integration agent |
| `packages/runtime/src/game/InputReader.ts` | M0 integration | Feed `SnapshotInputReader` from the frame; runtime-owned |

Not owned here: `sdk/src/game-api.ts` (spec 18), `sdk/src/manifest.ts` (map file declaration may be added by spec 06/18), the controller touch engine, the broker/protocol, the start screen, camera rigs that consume pointer motion.

---

## 7. Acceptance

Each row has an `ER-10-NN` ID. A row is PASS only with a build, device, browser version, date and numbers recorded in `docs/RESULTS.md`; otherwise it is PENDING with the named run. Baseline hardware: Desktop Chrome 155 on Windows 11 (`pc-win11-rtx3050`, GPU adapter recorded). Phone rows use the real dev server + broker + WebSocket on `127.0.0.1:0`.

| ID | Criterion | Fixture / method | Hardware | Evidence |
|---|---|---|---|---|
| ER-10-01 | Keyboard trace `kb-move-v1` (W held 3 ticks, released, A+D together, Space tap) produces the exact expected `move` x/y/value and `primary` edges for every tick | `test/keyboard.trace.test.ts` running `fixtures/kb-move-v1.json`; expectations are subset fields | CI Node 20 | PENDING — M0 |
| ER-10-02 | A keydown and keyup between two polls emit exactly one press edge and one release edge on the next poll, level false; the same tap across three ticks is not duplicated; 10,000 random press/release traces preserve the multiset of taps | `test/edges.property.test.ts` (`fast-check`) | CI Node 20 | PENDING — M0 |
| ER-10-03 | Phone bridge integration: a real dev server, broker and WebSocket carry a scripted 26-byte sequence from the input bot; over 1,200 packets the router's phone `ControllerView` equals `InputMapper.pollAll` field-for-field, including `edges`, `tick`, sticks and triggers | `packages/engine/input/test/phoneBridge.integration.test.ts`; extend `tools/input-bot` with a scripted mode; bind `127.0.0.1:0`, wait on messages | CI integration | PENDING — M0 |
| ER-10-04 | Phone tick semantics: an older packet changes no level but still ORs its edges; an equal tick applies; a packet crossing the `u32` wrap is treated as newer; a burst of 10 packets between polls yields the OR of all edges and the newest level | `fixtures/phone-ticks.json` + `test/phoneTicks.test.ts` | CI Node 20 | PENDING — M0 |
| ER-10-05 | Deadzone math: radial `(0.1, 0)` at 0.15 → `(0,0)`; `(1,0)` → `(1,0)`; magnitude is continuous at the boundary, monotonic non-decreasing, bounded by 1, and never NaN for 10,000 random inputs; `deadzone: 0` is exact | `test/deadzone.property.test.ts` | CI Node 20 | PENDING — M0 |
| ER-10-06 | Gamepad trace: standard pad presses A, moves the left stick, releases A and disconnects; synthesized controller bits/edges/sticks match the trace; a non-standard pad produces no actions and increments the counter | `fixtures/pad-standard-v1.json` + `test/gamepad.test.ts` with an injected `createGamepads` | CI Node 20 | PENDING — M0 |
| ER-10-07 | Assignment: a phone on slot 0 + keyboard + two pads yield slots {phone:0, keyboard:1, pads:2,3}; a phone joining slot 1 moves the keyboard to the lowest free slot without touching the pads; a phone disconnect does not migrate anyone; eight phones leave all auto devices unassigned; fixed assignments are honoured unless a phone conflicts | `test/assignment.property.test.ts` over generated topologies | CI Node 20 | PENDING — M0 |
| ER-10-08 | Rebinding: capture KeyF for `primary` replaces Space; a code bound to another action follows the conflict policy; Escape cancels; F5 is reserved; timeout ends capture; the overlay round-trips through a fake `BindingStore`; a rejected save changes nothing | `test/rebind.test.ts` | CI Node 20 | PENDING — M0 |
| ER-10-09 | Focus: blur with W and the left mouse button held emits releases exactly once and clears levels; refocus does not resurrect them; pointer-lock exit clears buttons; a pad held across blur remains held | Browser page `experiments/e-m0-input/?case=focus`, driven by synthetic events | Desktop Chrome 155, Windows 11 | PENDING — M0 |
| ER-10-10 | Default desktop map: without game changes, the platformer moves/jumps from the keyboard and from a standard pad, and reaction-duel fires from Space/Enter and pad A; synthesized controller bits match the games' expected layout bits | `experiments/e-m0-input/?case=games` loading both reference builds + `packages/runtime/test/inputParity.test.ts` | Desktop Chrome 155, Windows 11 | PENDING — M0 |
| ER-10-11 | No engine allocation in `poll`: heap growth ≤ 128 KiB over 600 frames after 120 warm-up frames with four pads connected; `poll` p95 ≤ 0.2 ms and p99 ≤ 0.5 ms for 8 players × 32 actions × 15 bindings | `experiments/e-m0-input/?bench=1` using `performance.memory` and `performance.now()` around `poll` | Desktop Chrome 155, Windows 11 | PENDING — M0 |
| ER-10-12 | `poll` is idempotent per tick: calling it twice with the same tick returns the same frame object and emits no extra edges; a decreasing tick is `E_INPUT_TICK` in dev and ignored in production | `test/pollOnce.test.ts` | CI Node 20 | PENDING — M0 |
| ER-10-13 | Map validation: for each limit (size, action count, binding count, name pattern, kind, deadzone, threshold, hysteresis, output type, device fields) a bad map yields `E_INPUT_FORMAT` with the JSON path and leaves the previous map loaded; 10,000 generated maps never throw | `test/mapValidation.property.test.ts` | CI Node 20 | PENDING — M0 |
| ER-10-14 | Local input latency: keyboard event to `simulate` visibility is p95 ≤ 25 ms and p99 ≤ 33 ms over 1,000 presses, measured by the latency harness with the frame loop running | `tools/latency-harness` + `experiments/e-m0-input/?case=latency` | Desktop Chrome 155, Windows 11 | PENDING — M0 |
| ER-10-15 | Pointer: three sub-tick moves accumulate to the exact dx/dy sum; wheel deltas accumulate and clear; buttons emit one edge per press; pointer lock freezes x/y but keeps dx/dy; leaving the canvas does not clear a held button until pointerup/cancel | `fixtures/pointer-v1.json` + `test/pointer.test.ts` | CI Node 20 + Desktop Chrome 155 | PENDING — M0 |
| ER-10-16 | TV/remote: a remote that emits Arrow keys, Enter and Escape drives `move`, `primary` and `pause` on the default map; no gamepad or pointer is required; the result is recorded on the named TV browsers | `experiments/e-m0-input/?case=tv` | **PENDING device:** 2020-era Android TV Chromium and a Tizen/webOS set from SPEC §12 | PENDING — no TV hardware |

Budget context: frame p95 14 ms / hard 20 ms, host + game ≤ 5 MB gz, controller ≤ 60 KB gz (unchanged by this host-side spec). ER-10-11's 0.2 ms poll budget is 1.4% of a 14 ms frame and is a ceiling, not a measured value.

---

## 8. Test plan

| Layer | Scope | Location |
|---|---|---|
| Unit | deadzone math, merge and hysteresis, map compile/validation, overlay merge, assignment algorithm, rebind state machine, phone tick comparison, poll idempotence | `packages/engine/input/test/*.test.ts` |
| Property (`fast-check`) | generated press/release traces preserve tap counts; deadzone output is monotonic, continuous, bounded and NaN-free; assignment is deterministic and phone-safe; 10,000 generated maps never throw; rebinding sequences never corrupt the overlay | `test/*.property.test.ts` |
| Golden traces | `input-trace-v1` fixtures for keyboard, pointer, standard pad, phone ticks and focus loss; expected action fields per tick | `test/fixtures/*.json` + `test/*.trace.test.ts` |
| Integration | real dev server + broker + WebSocket phone packets vs `InputMapper` parity; runtime adapter feeding `SnapshotInputReader`; both reference games driven by keyboard and pad | `packages/engine/input/test/phoneBridge.integration.test.ts`, `packages/runtime/test/inputParity.test.ts` |
| Browser integration | real `KeyboardEvent`/`PointerEvent`/`Gamepad` behaviour, pointer lock, visibility, TV remote keys | `experiments/e-m0-input/` driven by Playwright/CDP |
| Benchmark | `poll` p50/p95/p99, heap growth over 600 frames, four pads connected | `experiments/e-m0-input/?bench=1` |
| Manual | named gamepad models, TV remote, AZERTY keyboard, Bluetooth pad reconnect | `docs/RESULTS.md` rows ER-10-10/16 |

Rules:

- CI runs the pure modules in Node and injects a minimal event-target fake for the browser modules; it does not add jsdom/happy-dom as a dependency. Real browser events are covered by the experiment page.
- No fixed sleeps. Traces advance ticks explicitly; integration tests wait on messages, never on timers (00 §5.10).
- Every test title carries its `ER-10-NN` tag, resolvable in `docs/todos/TRACEABILITY.md` once the engine programme is registered.
- A failing input test is never skipped to land a wave. A browser-only criterion is a page plus a recorded result, never a deleted test.
- The phone parity test is the migration gate: if it is not bit-for-bit, the engine router must delegate more to `InputMapper`, not change `InputMapper`.
- Benchmarks record browser, adapter and power state; a laptop on battery is not the named baseline.

---

## 9. Dependencies

| Dependency | Why | State |
|---|---|---|
| Spec 00 | Package boundary, `InputAction` sketch, migration map, error taxonomy, DOM allowance, no-allocation rule | written; §3.4 needs the additive reconciliation in §10 I1 |
| Spec 01 | Fixed tick, tick order, where `poll(tick)` is called, pause reasons | written |
| Spec 02 | Renderer/math conventions that fix screen y-down vs world y-up | written |
| Protocol (existing) | 26/27-byte codecs used **by the runtime adapter only** for the phone bridge | frozen, `PROTOCOL_VERSION = 1` |
| Runtime (existing) | `InputMapper`/`TiltIntegrator` sources for the M0 move; `GameHost` poll placement; `SnapshotInputReader` | frozen, integration agent edits |
| SDK (existing) | Frozen `GameInputReader`/`GameControllerState`; the optional `frame` is spec 18 work | frozen; spec 18 written |
| Spec 13 | UI focus, menus, pointer-lock ownership, rebinding screens | written; M0 router does not depend on it |
| Spec 14 | Online input, prediction/reconciliation; consumes `InputFrame` | written |
| Spec 16 | Debug overlay for assignment/pad/phone stats | written |
| Spec 18 | Additive `GameInputReader.frame` and any manifest field for `input.map.json` | written; M0 uses synthesized controllers |
| Spec 19 | Trace runner, determinism harness, latency harness | written; M0 uses repo Vitest + `tools/latency-harness` |

Package rule: `engine-input` imports `engine-core` only. DOM access is confined to the modules named in §5.1; `resolve/**`, `map/**`, `devices/Assignment.ts` and `phone/**` are DOM-free and run in Node. The package has no third-party runtime dependency.

---

## 10. Risks

| ID | Risk | Likelihood | Impact | Mitigation / fallback |
|---|---|---|---|---|
| I1 | 00 §3.4's frozen `InputAction` sketch lacks `released`/`releaseEdges`, `yUp`, `hysteresis`, `output`, pointer `dx/dy` and per-binding `component`/`scale`; implementing this spec without an additive amendment creates two contracts | High | Integration drift, two type sources | Treat 00 §3.4 as the five-field minimum; land the additive fields in the M0 contract freeze and update 00 in the same change; no rename or semantic change to the existing fields |
| I2 | The SDK does not expose `InputFrame` until spec 18 lands | High | Games cannot read actions in M0 | M0 games keep the frozen `GameInputReader` and synthesized controllers (ER-10-10); `frame` is an optional additive member; engine demos read it directly |
| I3 | Phone `ly/ry` are +down while world Y is +up, so a map author flips the wrong axis | High | Inverted movement in one game mode | Raw devices are documented screen-space; `yUp` flips only the action vector; synthesis uses the pre-`yUp` value; ER-10-01/03/10 assert both conventions |
| I4 | Double deadzone: the controller applies 8%, then an action applies 15% | Medium | Reduced stick range, controls feel dead | Documented in §5.3.1/§5.8.2; action deadzone defaults are explicit; a map can set 0; property test ER-10-05 |
| I5 | Gamepad taps between 60 Hz polls are lost | Medium | Occasional missed input in menus/fighting games | Documented limitation; 60 Hz polling; games needing sub-tick pad input would need a browser event source that does not exist; phone/keyboard are unaffected |
| I6 | `navigator.getGamepads()` allocates and some browsers report stale or all-zero pads | High | Small GC pressure, phantom players, flaky tests | Copy immediately, drop the object, poll only when a pad is known; assign on first meaningful input; inject `createGamepads` in tests; ER-10-06/11 |
| I7 | Non-standard pads (flight sticks, older TV pads) do not map | Medium | A device does not work | Explicitly out of scope; counted and shown in the debug overlay; a per-pad mapping table is an additive future feature |
| I8 | Focus loss leaves keys or mouse buttons stuck | High without care | Player runs into a wall after alt-tab | Release-on-blur with exactly-once edges, clear pending presses, refocus does not resurrect; ER-10-09 |
| I9 | Rebinding conflicts silently break another action | Medium | A game becomes unplayable | Conflict policy refuses a rebind that would empty another action; reserved keys; overlay validation; ER-10-08/13 |
| I10 | Physical `KeyboardEvent.code` is wrong for AZERTY/Dvorak players | Medium | WASD is not where the player expects | `code` is the product decision for layout independence; rebinding is the remedy; a layout-aware mode is an additive future feature; I10 is documented in the game-facing docs |
| I11 | TV remotes emit unusual key codes or no gamepad API | Medium | A TV player cannot start a game | Arrow/Enter/Escape normalization table, keyboard path works without Gamepad API; ER-10-16 stays PENDING until measured on the named TVs |
| I12 | Moving `InputMapper`/`TiltIntegrator` changes phone behaviour | Medium | Phone regression on the signature feature | Move verbatim, keep the old tests, bit-for-bit parity over 1,200 real packets (ER-10-03), deprecated re-export for one wave |
| I13 | Two agents edit `main.ts`/`GameHost`/runtime input in one wave | Medium | Merge loss, non-green tree | Engine package owner writes only engine files; integration agent owns runtime wiring (00 §6, one writer per file) |
| I14 | A per-tick allocation slips into `poll` (frame, closure, string, array) | Medium | GC spikes at 60 Hz | Preallocated frame and plans, no closures, allocation benchmark ER-10-11, code review against 00 §5.8 |
| I15 | Phone ownership and fixed assignments fight, causing slot churn | Low | A player's controls move mid-game | Phones always win; stable auto assignments; fixed conflicts counted and ignored; assignment recomputed only on topology changes; ER-10-07 |
| I16 | `engine-input` grows the host bundle past the 5 MB gz budget | Low | Gate failure | The package is small (no third-party deps); size gate measures it; if needed, the default map and validators are tree-shaken and only the used device modules are imported |
| I17 | Pointer lock/Escape handling conflicts with menus or the browser | Medium | Focus traps, stuck buttons | Escape reserved and never bindable; lock exit clears buttons; `preventContextMenu` off by default; host shell owns menus (spec 13) |

**Fallback if this spec cannot land in M0:** the runtime keeps using `InputMapper` for phones and the games remain phone-only. Keyboard/mouse/gamepad input is additive and can be disabled per session without touching the phone path; no game becomes unplayable because the desktop layer is late. The inverse is not acceptable: the phone path may never regress to make desktop input work.

**What this spec does not prove:** it does not measure TV input latency, real gamepad compatibility or AZERTY ergonomics. Those stay PENDING until run on the named devices, per the programme's no-invented-measurements rule.

