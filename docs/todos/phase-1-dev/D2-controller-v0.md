# D2 — Controller v0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Steps use checkbox syntax.
>
> **Goal:** Build the first real controller: layout-driven buttons, a d-pad and a stick with 10-touch support, immediate pressed feedback, correct edge latching, and a host input mapper that never loses a sub-tick tap.
>
> **Architecture:** The SDK defines the layout document; the controller renders controls into DOM elements and turns touches into an `InputState`; the host runtime's `InputMapper` applies latest-wins level state and OR-accumulated edges per slot. The wire format and send policy are frozen here for every later game.
>
> **Tech stack:** Vanilla TypeScript, DOM + `transform`/`opacity`, touch events, WebSocket binary frames, Vitest + jsdom for logic tests.
>
> **Spec:** `SPEC.md` §7.3, §7.5, §8.1, §8.2, §8.5, §14 D2; FR-7.1, FR-7.3, FR-7.4, FR-7.11, FR-7.12, FR-7.17; FR-8.1, FR-8.3, FR-8.6, FR-8.7; AR-5; NR-6.3.
>
> **Program position:** Phase 1, after D1. D2's `ControllerState` and mapper semantics are consumed by D3's loop, every game, and the SDK; do not rename them later.

## Global constraints

- Controller JS hard cap 60 KB gz (target 40 dev / 50 prod); the size gate runs in CI (NR-6.3).
- Touch targets ≥ 44 × 44 CSS px (AR-5).
- `touch-action: none`, `user-select: none`, `-webkit-touch-callout: none` on the play surface.
- Pressed state must be visible in the same frame as the touch; no network round-trip for feedback (FR-8.7).
- Level state is latest-wins; edges OR-accumulate until the host polls (FR-7.11/7.12).
- Client deadzone 8%; host deadzone configurable (FR-7.4).
- No sensors, haptics, panels, text, canvas or layout hot-swap in D2.
- Every test title carries a requirement ID (TR-1).

---

## Stage goal and exit criteria

**Exit criteria (§14 D2):**

> Same-frame pressed state. Edges survive sub-tick taps.

Concretely:

- [ ] A layout with a button, a d-pad and a stick renders and is playable with 10 simultaneous touches.
- [ ] A press shows visually before the next paint; the input packet is sent immediately on change.
- [ ] A press+release that begins and ends between two host ticks still reaches the host as an edge.
- [ ] The host mapper's golden traces pass, including two packets in one tick and a stale-tick packet.
- [ ] Controller gz size is measured and under the 60 KB hard cap.
- [ ] The controller debug overlay shows packet rate, last send age, and scripting time.

**Layer coverage**

| Layer | Work items |
|---|---|
| SDK | D2-LAYOUT-01 |
| Controller | D2-CTRL-01, D2-CTRL-02, D2-CTRL-03, D2-CTRL-04 |
| Host runtime | D2-RT-01 |
| QA | D2-QA-01 |
| Tools/perf | D2-PERF-01 |

**Goals advanced:** G2 (immediate send, latest-state mapper), G3 (controller size), G4 (multi-controller independence), G5 (multi-touch, sticks, buttons).

---

## Contracts frozen in D2

1. `LayoutDocument` v0: the full discriminated union types are declared, but only `button`, `dpad`, `stick` are rendered. D5 adds the remaining renderers without changing these fields.
2. Coordinate model: `x`/`y` are percentages of viewport width/height or px; `size`/`r` percentages are relative to `min(viewportWidth, viewportHeight)`.
3. `ControllerState` (host): `{ slot, buttons, edges, lx, ly, rx, ry, gyro, triggers, tick }`.
4. Mapper policy: level fields latest-wins by packet tick; edges OR always; `pollAll()` returns accumulated edges and clears them.
5. Send policy: immediate on change, 60 Hz while any input is non-zero, 10 Hz idle keepalive.
6. Clock sync: controller Ping every 5 s; offset = minimum-RTT sample over a 30 s window; `tick` = server-time estimate at send (A3).
7. Deadzone: radial 8% on sticks, applied before encoding; host can add its own deadzone.
8. Control IDs and bit assignments are unique; the validator rejects duplicates (FR-7.7 groundwork).

---

## Work items

### D2-LAYOUT-01 — Layout schema v0 and validator foundation

| Field | Value |
|---|---|
| Layer | SDK |
| Spec | §8.1, §8.4; FR-8.1, FR-8.3, FR-8.4; FR-7.7; AR-5 |
| Depends on | D0-SDK-01 |
| Unblocks | D2-CTRL-02, D5-SDK-01, D5-CTRL-01 |
| Deliverables | `sdk/src/layout.ts`, `sdk/src/layout-validate.ts`, `sdk/schema/layout.schema.json`, `sdk/test/layout.test.ts` |

**Freeze this interface**

```ts
export type Length = `${number}%` | `${number}px`;

export interface BaseControl {
  id: string;              // unique, 1..32 chars
  x: Length;
  y: Length;
  z?: number;              // draw/hit order, default 0
}

export interface ButtonControl extends BaseControl {
  type: "button";
  label: string;
  shape: "circle" | "rounded" | "square";
  r: Length;               // radius/size
  bit: number;             // 0..15
  haptic?: number[];       // durations ms, max 8
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
  deadzone?: number;       // 0..0.5, default 0.08
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
  // always maps to rx/ry (FR-7.7)
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
  sensitivity?: number;    // default 1
  smoothing?: number;      // 0..1, default 0.15
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
  maxLen: number;          // 1..200
}

export interface CanvasControl extends BaseControl {
  type: "canvas";
  w: Length;
  h: Length;
  event: string;
  maxStrokePoints?: number;
}

export type Control =
  | ButtonControl | DpadControl | StickControl | TriggerControl
  | TouchpadControl | SliderControl | GyroControl | ChoiceControl
  | PanelControl | TextControl | CanvasControl;

export interface LayoutDocument {
  id: string;                       // 1..64 chars, versioned by convention e.g. "duel-v1"
  orientation: "portrait" | "landscape" | "any";
  background?: string;              // #rgb/#rrggbb
  controls: Control[];              // 1..24
  sensors?: { gyro?: "steer" | "aim" | "tilt"; sensitivity?: number; smoothing?: number };
}

export function validateLayout(value: unknown): { ok: true; layout: LayoutDocument } | { ok: false; errors: string[] };
export function controlBitAssignments(layout: LayoutDocument): Map<number, string[]>; // bit -> control ids
```

**Validation rules (v0)**

- JSON size ≤ 16 KB (UTF-8).
- `controls.length` 1..24; unique `id`; unique non-overlapping bit assignments for button/dpad.
- A control may bind at most one channel: stick left/right, touchpad right, slider/trigger lt/rt. Two controls binding the same channel is an error (FR-7.7).
- `x`/`y`/`size`/`r`/`w`/`h` parse as `%` or `px`; percent 0..100; px 0..4096.
- Button `bit` 0..15; dpad bits 0..15 and all four distinct; haptic array length ≤ 8, each 0..65535.
- `orientation` in the enum; `background` matches `^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$`.
- `choice.options` 1..12 with unique values; `text.maxLen` 1..200; event names 1..64 chars.
- Unknown `type` is an error (forward compatibility requires a schema version bump).
- Validator returns all errors, not the first.

**Steps**

- [ ] Declare all control interfaces now, even though only three have renderers in D2.
- [ ] Write the JSON Schema mirroring the interface; keep one fixture suite for both.
- [ ] Implement `validateLayout` with a base validator plus a per-type branch.
- [ ] Implement `controlBitAssignments` and channel conflict detection.
- [ ] Add fixtures for every error case above plus a valid three-control layout.
- [ ] Add a test that `validateLayout` accepts the spec's example layout (panel/text included) structurally, even though D2 cannot render those controls yet.
- [ ] Export `parseLength(value): {kind:"percent"|"px"; value:number}` for the renderer.

**Acceptance**

- [ ] The spec's §8.1 example validates (all controls structurally valid).
- [ ] Duplicate ids, duplicate bits, duplicate channels, oversized layouts and unknown types fail with field-specific errors.
- [ ] A 16,384-byte layout passes; 16,385 fails.
- [ ] The schema and the hand-written validator agree on all fixtures.

**Tests (tagged)**

- `[FR-8.1] layout supports all v1 control types structurally`
- `[FR-7.7] duplicate channel bindings are rejected`
- `[FR-8.4] layout validator rejects invalid and oversized layouts`
- `[AR-5] validator exposes sizes so the renderer can enforce 44px targets`
- `[FR-8.3] layout coordinates are data, not code`

**Anti-rework**

- The full union is declared now so D5 does not redefine types. D5 adds renderers/validator refinements, not breaking field changes.
- `x`/`y` percentages are relative to the respective viewport dimension; `size`/`r` percentages are relative to `min(w,h)`. Write this in the schema description; changing it later would move every control.
- Do not add game-specific controls. New types require a schema version bump.

**Risks**

- Percent sizing on orientation change can cause overlap; D2-CTRL-01 caches rects and D5 tests hot-swap/orientation.
- `exactOptionalPropertyTypes` makes optional fields explicit; use `field?: T` consistently.

---

### D2-CTRL-01 — Touch capture engine: identifiers, hit-testing, 10 touches

| Field | Value |
|---|---|
| Layer | Controller |
| Spec | §8.2; FR-8.6, FR-8.7; AR-5; FR-8.3 |
| Depends on | D2-LAYOUT-01, D0-CTRL-01 |
| Unblocks | D2-CTRL-02, D5-CTRL-01..04 |
| Deliverables | `packages/controller/src/touch/hitTest.ts`, `src/touch/touchEngine.ts`, `test/hitTest.test.ts`, `test/touchEngine.test.ts` |

**Freeze this interface**

```ts
export interface HitRect { controlId: string; left: number; top: number; width: number; height: number; z: number; }

export interface TouchBinding {
  identifier: number;
  controlId: string;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
}

export class TouchEngine {
  constructor(surface: HTMLElement, opts: { slopPx?: number; maxTouches?: number });
  setControls(rects: HitRect[]): void;      // called after layout/resize
  onTouch: (ev: { type: "start" | "move" | "end" | "cancel"; binding: TouchBinding; controlId: string }) => void;
  dispose(): void;
}
```

**Behavior**

- Listen to `touchstart`, `touchmove`, `touchend`, `touchcancel` on the play surface with `{ passive: false }`; call `preventDefault()` for all handled touches.
- Track every `Touch.identifier` in a `Map<number, TouchBinding>`; ignore new touches beyond 10 and log a debug counter.
- Hit-testing: iterate controls in descending `z`, then reverse DOM order; a hit is inside the rect expanded by 8 px slop. The first match wins.
- Cache rects: recompute in `setControls` from the layout element positions; never read layout in `touchmove`.
- On `touchstart`: bind identifier → control, emit `start` synchronously.
- On `touchmove`: update binding last coords and emit `move` (control may implement drag).
- On `touchend`/`touchcancel`: emit `end`/`cancel`, remove binding.
- On `blur`, `visibilitychange` hidden, orientation change: cancel all active touches and emit `cancel` for each.
- Reject hits on controls whose rendered box is < 44 × 44 CSS px in the validator/render path (AR-5); hit area uses the larger of the box and 44 px.
- No `pointer*` events in this layer; D0's pointer test button is replaced.

**Steps**

- [ ] Implement `hitTest(rects, x, y, slopPx)` with z/order tie-breaking and tests for edges/slop.
- [ ] Implement `TouchEngine` with a `Map` keyed by identifier; expose active bindings for the debug overlay.
- [ ] Add `touch-action: none` and user-select CSS to the play surface; ensure `preventDefault` happens before scrolling.
- [ ] Recompute rects on `resize` and `orientationchange` via a `ResizeObserver` on the surface; debounce with rAF.
- [ ] Add tests using a fake touch list/event object (no browser needed): 10 simultaneous touches, 11th ignored, end frees a slot, cancel releases, hit slop, z-order.
- [ ] Add a manual check: two fingers on two buttons simultaneously; both pressed; neither scrolls the page.

**Acceptance**

- [ ] 10 simultaneous touches each bind to the correct control.
- [ ] The 11th touch is ignored without throwing.
- [ ] A touch 8 px outside a control still hits; 9 px does not.
- [ ] `touchend` and `touchcancel` always remove the binding; no stuck pressed state after blur/visibility change.
- [ ] Scrolling does not occur while touching the play surface.

**Tests (tagged)**

- `[FR-8.6] ten simultaneous touches are tracked by identifier`
- `[AR-5] hit areas are at least 44x44 CSS pixels`
- `[FR-8.3] hit-test rects are cached and not read during touchmove`
- `[FR-8.7] touchstart updates control state synchronously`

**Anti-rework**

- Touch identity is the foundation for canvas strokes (D5) and floating sticks; do not replace it with pointer events later.
- `HitRect` and `TouchBinding` are used by D5's canvas/panel; keep them generic.
- The engine emits semantic events; it does not know which control type is which.

**Risks**

- iOS Safari touch event quirks are out of scope (A5), but the code must not crash; avoid iOS-only APIs.
- `touchcancel` can fire without `touchend`; always release all bindings on visibility hidden.

---

### D2-CTRL-02 — Button, d-pad and stick controls; same-frame feedback

| Field | Value |
|---|---|
| Layer | Controller |
| Spec | §8.1, §8.2; FR-8.1, FR-8.3, FR-8.7; AR-5 |
| Depends on | D2-LAYOUT-01, D2-CTRL-01, D2-CTRL-03 |
| Unblocks | D5-CTRL-01, D7 games (C1) |
| Deliverables | `packages/controller/src/controls/registry.ts`, `button.ts`, `dpad.ts`, `stick.ts`, `src/controls/control.ts`, `test/controls.test.ts` |

**Freeze this interface**

```ts
export interface ControlRenderer {
  readonly id: string;
  readonly element: HTMLElement;
  setPressed(active: boolean): void;        // synchronous, transform/opacity only
  onTouchStart(binding: TouchBinding): void;
  onTouchMove(binding: TouchBinding): void;
  onTouchEnd(binding: TouchBinding): void;
  onTouchCancel(binding: TouchBinding): void;
  getState(): Partial<InputState>;          // buttons/edges/axes contribution
  dispose(): void;
}

export function createControl(control: Control, ctx: ControlContext): ControlRenderer;
```

**Behavior**

- Button: absolutely positioned circle/rounded/square; pressed state = `transform: scale(0.92)` + opacity; no layout properties change.
- D-pad: four hit zones; pressing one sets its bit; diagonals set two bits (nearest two zones). Visual highlight per zone.
- Stick:
  - Fixed: base circle centered at layout position; knob follows the touch delta clamped to radius.
  - Floating: base appears at touch start and is centered there; knob follows.
  - Delta normalized by radius; apply radial deadzone (default 8%); output i16 `[-32767, 32767]` on the bound axis.
  - On release, knob returns to center with a CSS transition; state goes to 0 immediately.
- All controls: pressed state is applied in the touch handler before returning (same frame). No `requestAnimationFrame` deferral for visual state.
- Rendering uses `transform: translate3d()` for position and `scale` for pressed; opacity for dimming. No width/height/top/left changes in handlers.
- Build DOM once per layout; `setControls`/re-render only on layout change (D5).
- Each control reports its state contribution; the input store merges them.

**Steps**

- [ ] Implement a `ControlContext` with `input: InputStore`, `surfaceSize`, `debug` hooks.
- [ ] Implement the button renderer and its same-frame pressed test (state + class before handler returns).
- [ ] Implement the d-pad with four zones and diagonal detection; test bit combinations.
- [ ] Implement the stick with fixed/floating modes, deadzone, clamping, and return-to-center.
- [ ] Implement a registry keyed by `type`, with a clear error for a valid-but-unimplemented type (panel/text/etc. until D5).
- [ ] Add a debug `?layout=debug` outline for control bounds (grid overlay is D5; D2 can draw boxes).
- [ ] Add tests for state contributions and pressed classes using fake elements; add a manual 10-touch check.

**Acceptance**

- [ ] A button press changes its visual state and the input store before the event handler returns.
- [ ] A d-pad diagonal sets exactly two direction bits.
- [ ] A stick at full deflection reports ±32767; at 7% reports 0; at 20% reports a scaled value outside the deadzone.
- [ ] Floating stick base appears exactly at touch start; fixed stick does not move.
- [ ] No control changes `top/left/width/height` in a touch handler.

**Tests (tagged)**

- `[FR-8.7] button pressed class is applied synchronously on touchstart`
- `[FR-8.1] button, dpad and stick render from layout data`
- `[FR-7.4] stick deadzone is 8% by default and clamps to i16`
- `[FR-8.3] control feedback uses transform and opacity only`
- `[AR-5] rendered control boxes meet the 44px minimum`

**Anti-rework**

- `ControlRenderer` is the extension point for all remaining controls; do not add game-specific branches.
- Stick output is axis-only (`lx/ly` or `rx/ry`); D5's touchpad reuses the same normalization but binds to `rx/ry`.
- Pressed visuals must not depend on network state; the connection pill reacts separately.

**Risks**

- CSS transitions on the knob can lag the finger; keep the knob transform immediate and transition only the return-to-center.
- D-pad diagonals can jitter at zone edges; use z-ordered hit zones and a small hysteresis (2 px).

---

### D2-CTRL-03 — Input state, edges, send policy and clock sync

| Field | Value |
|---|---|
| Layer | Controller |
| Spec | §7.1, §7.3, §7.4, §7.10; FR-7.1, FR-7.3, FR-7.4, FR-7.10; A3 |
| Depends on | D0-PROTO-02, D2-CTRL-01 |
| Unblocks | D2-CTRL-04, D2-RT-01, D4-EXP-01, all games |
| Deliverables | `packages/controller/src/input/InputStore.ts`, `src/input/sendLoop.ts`, `src/net/clockSync.ts`, `test/inputStore.test.ts`, `test/sendLoop.test.ts`, `test/clockSync.test.ts` |

**Freeze this interface**

```ts
export class InputStore {
  setButton(bit: number, down: boolean): void;   // sets/clears level; sets edge on down
  setAxis(axis: "lx" | "ly" | "rx" | "ry", value: number): void;
  setTrigger(channel: "lt" | "rt", value: number): void;
  setGyro(x: number, y: number, z: number): void; // zero in D2
  setFlags(flags: number): void;
  snapshot(nowMs: number): InputState;            // includes edges; does not clear
  clearEdges(): void;
  hasActiveInput(): boolean;
}

export class ClockSync {
  onPong(clientTimeMs: number, serverTimeMs: number, receivedAtMs: number): void;
  serverNow(clientNowMs: number): number;        // best estimate
  readonly offsetMs: number;
  readonly rttMs: number;
  readonly samples: number;
}

export class SendLoop {
  constructor(deps: { store: InputStore; clock: ClockSync; send: (s: InputState) => void; now: () => number; setTimer: (fn: () => void, ms: number) => number; clearTimer: (id: number) => void });
  notifyChange(): void;   // immediate send, coalesced within 4 ms
  start(): void;
  stop(): void;
}
```

**Behavior**

- Level: `buttons` bitfield; press sets bit, release clears it.
- Edges: a press sets the corresponding edge bit until the next packet is sent; a release never sets an edge. A press+release between sends leaves level 0 and edge 1 in the next packet.
- Axes: i16; sticks apply 8% radial deadzone before encoding; triggers u8 0..255.
- Send rules (FR-7.1):
  - Any change → send immediately, but no more than once per 4 ms (coalesce bursts).
  - While any input is non-zero → send every 16.67 ms.
  - Idle → send every 100 ms keepalive.
  - Always send the edge bit in the packet that carries it; clear edges only after `send()` returns.
- Tick: `clock.serverNow(performance.now())` truncated to u32; if no clock samples yet, use 0 (host sees an early tick; D4 refines).
- Clock sync: Ping every 5 s with `clientTimeMs`; on Pong compute RTT = received - clientTime, offset = serverTime - (clientTime + RTT/2); keep samples for 30 s; use the minimum-RTT sample as the current offset. Discard samples with RTT > 2× the minimum.
- `visibilitychange` hidden: stop the loop (D4 sends suspend); visible: restart.
- No gyro/haptics in D2; fields are zero.

**Steps**

- [ ] Implement `InputStore` with a 16-bit buttons field and a 16-bit edges field; test every bit.
- [ ] Implement the sub-tick tap case: `setButton(A,true)` then `setButton(A,false)` before `snapshot`; snapshot has `buttons=0, edges=1`.
- [ ] Implement `ClockSync` with a 30 s sample window and min-RTT selection; test with synthetic Pongs (including asymmetric delay).
- [ ] Implement `SendLoop` with an injectable clock/timers; test immediate-on-change, 60 Hz active, 10 Hz idle, and 4 ms coalescing.
- [ ] Wire `notifyChange` from control state changes; ensure the edge is never cleared before `send` returns.
- [ ] Add a debug counter for packets sent, edge packets, and time since last send.
- [ ] Add a test that two rapid presses of different buttons both appear as edges (possibly in one packet) and levels are correct.

**Acceptance**

- [ ] A 5 ms tap produces a packet with its edge bit and level 0 if the release beat the send.
- [ ] Two presses within one send interval produce both edge bits and the correct final levels.
- [ ] Idle traffic is ≤ 10 packets/s; active traffic is ≤ 60 packets/s plus change-triggered coalesced packets.
- [ ] Clock offset uses the minimum-RTT sample and converges with a synthetic 20 ms symmetric delay.
- [ ] `snapshot` never mutates level state.

**Tests (tagged)**

- `[FR-7.1] immediate send on change, 60 Hz active, 10 Hz idle`
- `[FR-7.3] sub-tick tap keeps its edge and clears its level`
- `[FR-7.4] deadzone and i16 clamping`
- `[FR-7.10] clock offset uses the minimum-RTT sample`
- `[A3] tick is a u32 server-time estimate`
- `[PR-9.3] SendLoop reuses a single InputState object per send`

**Anti-rework**

- The send policy is the contract every game relies on; do not move it into individual controls.
- `ClockSync` is shared with the controller debug overlay and D4's E9 experiment.
- Edges are cleared only after send; if the socket is not open, hold them (D4 reconnect behavior) rather than silently dropping.

**Risks**

- `setInterval` drift on phones; use a self-correcting timer based on `performance.now()` deltas, not a naive interval.
- Background tabs throttle timers; D4's suspend/resume handles this, but D2 tests must not assume 60 Hz in a hidden tab.
- u32 tick wraps every 49.7 days; compare with wrap-safe arithmetic in the host mapper.

---

### D2-CTRL-04 — Controller client integration and connection state

| Field | Value |
|---|---|
| Layer | Controller |
| Spec | §7.4, §8.5; FR-7.1, FR-7.15 groundwork |
| Depends on | D2-CTRL-03, D0-CTRL-01 |
| Unblocks | D4-CTRL-02, D3-QA-01 |
| Deliverables | `packages/controller/src/net/controllerClient.ts` (extended), `src/main.ts` (wired), `test/controllerClient.test.ts` |

**Behavior**

- Reuse D0's `controllerClient`; add binary send (`sendInput`), Ping/Pong handling, and `onState` for connection pill.
- On `joined`: start `SendLoop` and `ClockSync`; on `joinError`/`kick`/close: stop the loop, keep the connection pill state.
- Send an initial empty Input immediately after join so the host sees the slot alive.
- Connection pill states in D2: Connecting / Connected (P{n}) / Disconnected. Reconnecting/Waiting for TV are D4.
- No reconnect logic in D2 (D4).
- Handle `Pong` by feeding `ClockSync`; send `Ping` every 5 s from the client.

**Steps**

- [ ] Extend `controllerClient` with `sendBinary`, `sendPing`, and typed message handling.
- [ ] Wire `InputStore` → `SendLoop` → `controllerClient.sendInput`.
- [ ] Wire `Pong` → `ClockSync.onPong`.
- [ ] Update the connection pill from client state; make it readable at arm's length.
- [ ] Add tests with a fake socket: join → loop starts; close → loop stops; Pong updates offset.
- [ ] Add a debug overlay behind triple-tap top-left (D2 subset): RTT, packets/s, last send age, script ms.

**Acceptance**

- [ ] After join, the host receives an initial packet and then follows the send policy.
- [ ] The pill never shows Connected before `joined`.
- [ ] Closing the socket stops all timers (no leaked intervals).
- [ ] Triple-tap top-left toggles the debug overlay without affecting input.

**Tests (tagged)**

- `[FR-7.1] controller starts sending only after joined`
- `[FR-7.10] pong samples update the controller clock`
- `[FR-8.5] connection pill reflects real socket state`
- `[G1] join-to-first-input time is instrumented`

**Anti-rework**

- The socket remains the only network owner; controls never send.
- Debug overlay fields are extended in D4 (jitter/drops) and D6 (motion), not replaced.
- The client exposes state, not DOM; D4's reconnect UX reuses it.

**Risks**

- Timer leaks on rapid join/leave; test with fake timers and assert zero active timers after close.
- `joined` may arrive before the host is ready; the host buffers inputs itself (D3).

---

### D2-RT-01 — Host input mapper: latest-wins level, accumulated edges

| Field | Value |
|---|---|
| Layer | Host runtime |
| Spec | §7.3, §7.5; FR-7.11, FR-7.12, FR-7.17; FR-7.4; §16 golden traces |
| Depends on | D0-PROTO-02, D2-CTRL-03 |
| Unblocks | D3-RT-01, D3-RT-04, D7 games, SDK trace tests |
| Deliverables | `packages/runtime/src/input/InputMapper.ts`, `src/input/types.ts`, `test/inputMapper.test.ts`, `test/fixtures/traces/*.json` |

**Freeze this interface**

```ts
export interface ControllerState {
  slot: number;
  buttons: number;
  edges: number;
  lx: number; ly: number; rx: number; ry: number;
  gyro: { x: number; y: number; z: number };
  triggers: { lt: number; rt: number };
  tick: number;
}

export interface InputSnapshot {
  tick: number;                          // host sim tick count
  players: ReadonlyArray<ControllerState>; // slots 1..8, fixed order
}

export class InputMapper {
  constructor(opts: { deadzone?: number; slots?: number });
  apply(slot: number, packet: InputState, receivedAtMs: number): void;
  pollAll(hostTick: number): InputSnapshot;
  getSlot(slot: number): ControllerState | undefined;
  getStats(slot: number): { lastInputAgeMs: number; packetsPerSecond: number; drops: number };
  reset(slot?: number): void;
}
```

**Behavior**

- `apply`:
  - Validate slot 1..8; ignore others and count a drop.
  - Compare `packet.tick` with the slot's current tick using wrap-safe `(a - b) >>> 0 < 2^31`; if the packet is newer or equal, update level fields (`buttons`, axes, triggers, gyro, flags/tick). If older, do **not** update level fields.
  - Always `edges |= packet.edges` (a press from an older packet must not be lost).
  - Update `lastReceivedAt`, packet counters; detect gaps? WebSocket is ordered, so a "drop" means a packet the server dropped under backpressure; count it when the host receives a packet whose tick jumps more than 3 send intervals? Keep a simple `packetsPerSecond` and `drops` counter passed from the server stats later (D4); D2 counts ignored/out-of-range packets.
- `pollAll`:
  - For each slot, copy level fields and accumulated `edges` into the pooled `ControllerState`.
  - Clear `edges` after copying.
  - Return a stable snapshot object; do not allocate per poll.
- Deadzone: optional host deadzone applied to axes at poll time (default 0, because the controller already applies 8%; configurable per game/D3).
- `reset` clears level and edges for a slot (player left).
- Tests use golden traces: a JSON array of `{atMs, slot, tick, buttons, edges, lx, ly, rx, ry, gyro, lt, rt}` and expected poll results at given host ticks.

**Steps**

- [ ] Implement `InputMapper` with a fixed array of 8 slot records and a reusable snapshot.
- [ ] Implement wrap-safe tick comparison; test near 0 and near 2^32.
- [ ] Implement edges OR before the tick check; test a stale packet carrying an edge.
- [ ] Implement `pollAll` clearing edges exactly once; test two polls in a row (second has edges 0).
- [ ] Add golden traces:
  - two packets in one tick with edges A and B → poll edges A|B;
  - press+release packet with level 0, edge A → poll edge A, level 0;
  - stale packet with level A after newer packet level 0 → level stays 0, edge still accumulates;
  - 8 slots independent.
- [ ] Add a no-allocation test: `pollAll` returns the same snapshot/player objects across calls.
- [ ] Add stats: last input age, packets per second (sliding 1 s), drop count.

**Acceptance**

- [ ] Edges never disappear without a poll.
- [ ] Level fields always reflect the newest tick seen, not the last arrived packet (wrap-safe).
- [ ] Two packets in one tick preserve both presses.
- [ ] `pollAll` is allocation-free after construction (assert object identity).
- [ ] 8 slots never cross-contaminate.

**Tests (tagged)**

- `[FR-7.11] latest level state wins over an older packet`
- `[FR-7.12] edges OR-accumulate and clear on poll`
- `[FR-7.3] a sub-tick tap survives as an edge with level zero`
- `[FR-7.4] host deadzone is configurable`
- `[FR-7.17] games receive ControllerState, never packets or sockets`
- `[PR-9.3] pollAll performs no per-frame allocation`

**Anti-rework**

- `ControllerState` is the game-facing type for every stage; do not add socket or packet fields.
- The mapper owns the only edge accumulator; games must not re-derive edges.
- `InputSnapshot.players` stays a fixed slot order so games can index it cheaply.

**Risks**

- A reconnect can deliver a packet with a reset clock tick; D4 must resync before the mapper sees it, or the mapper may ignore level updates. Document the D4 dependency.
- If a game polls twice per frame, the second poll sees no edges; that is correct but games must poll once per tick.

---

### D2-QA-01 — Golden traces, sub-tick tap and same-frame checks

| Field | Value |
|---|---|
| Layer | QA |
| Spec | §16 ("Input mapper: golden trace tests..."), §14 D2 exit |
| Depends on | D2-CTRL-02, D2-CTRL-03, D2-RT-01 |
| Unblocks | D3 entry, D7 game trace tests |
| Deliverables | `packages/runtime/test/fixtures/traces/*.json`, `packages/controller/test/subTick.test.ts`, `docs/RESULTS.md` D2 row |

**Trace format**

```json
{
  "name": "sub-tick-tap",
  "hostTickHz": 60,
  "packets": [
    { "atMs": 10, "slot": 1, "tick": 100000, "buttons": 0, "edges": 1, "lx": 0, "ly": 0, "rx": 0, "ry": 0, "gx": 0, "gy": 0, "gz": 0, "lt": 0, "rt": 0, "flags": 0 }
  ],
  "polls": [
    { "hostTick": 1, "expect": { "buttons": 0, "edges": 1 } },
    { "hostTick": 2, "expect": { "buttons": 0, "edges": 0 } }
  ]
}
```

**Steps**

- [ ] Add at least five traces: sub-tick tap, two presses in one tick, press+hold, stale packet, 8-slot independence.
- [ ] Write a trace runner that feeds packets and compares poll output field-by-field; use it for every game's recorded traces later.
- [ ] Add a controller-level test: press and release within 5 ms; assert the emitted packet has edge set and level 0.
- [ ] Add a manual same-frame check: use a 240 fps phone camera (or high-speed screen recording) on a button press; record whether the visual state changes before the network can respond. Record the method and result in `docs/RESULTS.md`.
- [ ] Add a 10-touch manual check and record it.
- [ ] Record D2 controller gz size and script time in `docs/RESULTS.md`.

**Acceptance**

- [ ] All traces pass.
- [ ] The sub-tick tap reaches the mapper as an edge on the next poll.
- [ ] The manual same-frame check shows no visible network-dependent delay.
- [ ] 10 simultaneous touches work on a real phone.

**Tests (tagged)**

- `[FR-7.3] golden trace: sub-tick tap produces an edge at the next poll`
- `[FR-7.12] golden trace: two packets in one tick preserve both edges`
- `[FR-7.11] golden trace: stale level packet is ignored but its edge is kept`
- `[FR-8.7] pressed feedback is synchronous with the touch`
- `[FR-8.6] ten-touch manual check passes`

**Anti-rework**

- The trace runner becomes the game SDK's test harness (FR-7.17); keep it generic and documented.
- Recorded traces are data, so games can replay them without a phone.

**Risks**

- Camera-based same-frame verification is subjective; pair it with a synchronous DOM assertion and D3's E5 harness.
- jsdom does not implement real touch behavior; logic tests use fake touch lists, while the real check is manual.

---

### D2-PERF-01 — Controller size, 2 ms scripting budget, debug overlay

| Field | Value |
|---|---|
| Layer | Tools/perf + Controller |
| Spec | §8.1, §8.5; FR-8.3, NR-6.3; §11 |
| Depends on | D2-CTRL-02..04, D0-TOOL-02 |
| Unblocks | D5 perf, D7 per-game budgets, GATE-PERF-01 |
| Deliverables | `packages/controller/src/debug/overlay.ts`, `test/perf.test.ts`, size report |

**Behavior**

- Overlay (triple-tap top-left) shows: packets/s, last send age, RTT, offset, script time p50/p95 (measured around touch handlers), active touches, layout id.
- Measure scripting with `performance.now()` around the touch event handler; keep a 120-sample ring; display p50/p95.
- Enforce the 2 ms target per event; if p95 > 2 ms on a mid-range phone, simplify the handler (no layout reads, fewer DOM writes).
- Size gate: controller gz ≤ 60 KB hard; report dev/prod target status.
- Audit CSS/DOM: no width/height/top/left writes in handlers; use `transform`/`opacity`; batch reads before writes.
- Add a debug counter for dropped touches (>10).

**Steps**

- [ ] Implement the overlay with a ring buffer and p50/p95 calculation; no dependency.
- [ ] Instrument `touchstart/move/end` handlers; include layout hit-test time.
- [ ] Run on desktop and one Android phone; record p50/p95 in `docs/RESULTS.md`.
- [ ] Build the controller and run the size gate; record gz bytes.
- [ ] If over target, identify the largest modules and remove/trim (no gzip tricks, no code golf that hurts clarity).
- [ ] Add a test that the overlay math is correct for a known sample set.

**Acceptance**

- [ ] Controller gz ≤ 60 KB hard; target status recorded (40 dev / 50 prod).
- [ ] Script p95 ≤ 2 ms on the test Android phone; if not, the team records why and what was simplified.
- [ ] Overlay does not allocate per frame beyond a fixed ring.
- [ ] No layout-triggering CSS property is written in a touch handler (code review + grep test).

**Tests (tagged)**

- `[FR-8.3] controller scripting stays under 2 ms per event`
- `[NR-6.3] controller bundle is under 60 KB gz`
- `[G3] controller size target is reported per build`
- `[FR-8.5] debug overlay shows packet rate and RTT`

**Anti-rework**

- The overlay is the controller-side debugging tool for all later stages; extend fields, do not replace it.
- Size measurements feed the Gate; keep the build output path stable.

**Risks**

- `performance.now()` precision may be reduced by cross-origin isolation settings; use it for relative measurements, not absolute guarantees.
- The overlay itself must not blow the size budget; keep it dev-only behind a flag and tree-shake in prod if needed.

---

## Stage exit checklist

- [ ] D2-LAYOUT-01, D2-CTRL-01..04, D2-RT-01, D2-QA-01, D2-PERF-01 complete.
- [ ] A layout renders button + dpad + stick and is playable on a phone.
- [ ] Same-frame pressed state verified (DOM assertion + manual camera check).
- [ ] Sub-tick tap edge verified end to end.
- [ ] Golden traces pass, including stale-packet and multi-packet-per-tick cases.
- [ ] 10 simultaneous touches verified.
- [ ] Controller gz ≤ 60 KB; script p95 ≤ 2 ms recorded.
- [ ] `docs/RESULTS.md` D2 row complete.
- [ ] `TRACEABILITY.md` IDs used in D2 tests exist and are tagged.

## Handoff to D3

- D3 consumes `InputMapper.pollAll()` and `ControllerState` exactly as frozen here.
- D3's host net client feeds `InputMapper.apply()`; it must not reinterpret edges.
- D3's loop calls `pollAll(hostTick)` once per simulation tick; do not poll twice.
- D4 adds sessions/reconnect around the existing client; do not change the send policy.

## Explicitly not in D2

- Layout hot-swap, panels, text, choice, canvas, triggers, sliders, touchpads (D5).
- Gyro and haptics (D6).
- Reconnect, suspend/resume, heartbeat UX (D4).
- Game loop, renderer, audio (D3) and games (D7).
- iOS-specific behavior or testing (A5).
