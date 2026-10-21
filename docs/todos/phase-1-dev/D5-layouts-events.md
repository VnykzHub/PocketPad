# D5 — Layouts and Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Steps use checkbox syntax.
>
> **Goal:** Complete the controller platform: every v1 control type, hot-swappable layouts, private panels, text entry, choice lists, freehand drawing, and a rate-limited opaque event channel between phones and the host.
>
> **Architecture:** Layouts are JSON data validated by `@lanpad/sdk` on both ends and rendered by a controller control registry. The host sends `setLayout`/`panel` through the broker; phones send `event` and `layoutAck`; the broker routes by slot and never inspects bodies. Games consume layouts, panels and events through `GameContext`, never sockets.
>
> **Tech stack:** DOM + `transform`/`opacity`, canvas 2D for strokes, `visualViewport` for keyboard handling, JSON schema validation, per-slot token buckets.
>
> **Spec:** `SPEC.md` §7.2, §7.7, §8.1–§8.4, §8.9, §13, §14 D5, §16, §20 E10/E16; FR-7.7–7.9, FR-8.1–8.4, FR-8.9, SR-13.
>
> **Program position:** Phase 1, after D4. Every proof game in D7 depends on D5; do not start game content before panel/event round-trips pass.

## Global constraints

- Layout JSON ≤ 16 KB; ≤ 24 controls; unique ids, bits and channels (D2 rules).
- Layout hot-swap with no page reload; per slot or all.
- `panel`/`event` bodies are opaque to the broker; 4 KB max JSON frame; events 30/s sustained, burst 60 per slot.
- All UGC rendered with `textContent`/canvas; never `innerHTML` (SR-13/XSS).
- Panels are private: only the addressed slot receives them; the host never receives panel echoes.
- Canvas strokes batch; target < 20 KB/s per drawer and < 100 ms visible delay (E10).
- Text controls must survive the on-screen keyboard resizing the viewport (E16).
- No sensors/haptics in D5 (D6); gyro control is validated/rendered as an enable prompt placeholder only.

---

## Stage goal and exit criteria

**Exit criteria (§14 D5):**

> Private panels and text/draw round-trip. Stroke test (E10) passes.

Concretely:

- [ ] All 11 control types render from layout JSON.
- [ ] A layout can be swapped for one slot or all slots without reconnecting.
- [ ] A secret word reaches only the addressed phone's panel; other phones see nothing.
- [ ] A typed answer and a drawn stroke reach the host as events with the correct slot.
- [ ] Event rate/size limits hold under a flood.
- [ ] E10 (< 20 KB/s per drawer, < 100 ms delay) and E16 (keyboard layout usable) recorded.
- [ ] XSS tests pass: a malicious panel/text/event cannot execute script or inject HTML.

**Layer coverage**

| Layer | Work items |
|---|---|
| SDK | D5-SDK-01 |
| Protocol | D5-PROTO-01 |
| Server | D5-SRV-01 |
| Controller | D5-CTRL-01..05 |
| Host runtime | D5-RT-01 |
| Security | D5-SEC-01 |
| Experiments/docs | D5-EXP-01 |
| QA | D5-QA-01 |

**Goals advanced:** G5 (private screens, text, drawing), G4 (per-slot routing), G8 (layout/event SDK).

---

## Contracts frozen in D5

1. **Layout** = the D2 `LayoutDocument`; all control types are now renderable. `id` identifies the layout for acks.
2. **setLayout**: host→server→controller `{t:"setLayout", slot: number | "all", layout: JsonValue}`. Controller validates, rebuilds, sends `{t:"layoutAck", layoutId}`. Host tracks acks per slot.
3. **panel**: host→server→controller `{t:"panel", slot, content}`; content is `PanelContent` (SDK-validated), private to that slot.
4. **event**: controller→server→host `{t:"event", slot, name, data}`; the server validates the slot matches the authenticated peer, applies the rate limit, and forwards unchanged.
5. **Stroke event** shape: `{points: [{x:number,y:number,t:number}], color: string, width: number, phase: "start"|"move"|"end"}` in normalized 0..1 coordinates; batched.
6. **Text/choice event**: `{value: string}`; text is truncated to the control's `maxLen`.
7. **Host APIs**: `ctx.layouts.set(slot|"all", layout)`, `ctx.panels.set(slot, content)`, `ctx.panels.clear(slot)`, `ctx.events.on(name, handler)`.
8. **Reconnect recovery**: on `playerResumed`, the host re-sends the current layout and panel for that slot.

---

## Work items

### D5-SDK-01 — Full layout schema, validator and debug grid

| Field | Value |
|---|---|
| Layer | SDK |
| Spec | §8.1, §8.4; FR-8.1–8.4, FR-7.7; AR-5 |
| Depends on | D2-LAYOUT-01 |
| Unblocks | D5-CTRL-01..04, D7 games |
| Deliverables | `sdk/src/layout-validate.ts` (completed), `sdk/src/panel.ts`, `sdk/src/ugc.ts`, `sdk/test/layout-full.test.ts`, `sdk/test/panel.test.ts`, `sdk/test/ugc.test.ts` |

**Complete the validator**

- All 11 types with the fields frozen in D2.
- Cross-control rules:
  - Unique `id`; unique bit assignments (button + each dpad direction); unique axis/channel bindings.
  - `touchpad` always binds `rx/ry`; only one touchpad allowed; cannot coexist with a right stick.
  - `trigger`/`slider` bind `lt`/`rt`; only one control per channel.
  - A `gyro` control requires a non-gyro fallback control in the same layout (FR-8.10 groundwork; D6 enforces).
  - `panel`/`text`/`canvas`/`choice` `event` names may be shared (e.g., multiple answer inputs); each ≤ 64 chars; expose the layout-wide list.
- Size/limits: 16 KB; 24 controls; 12 options; 200 maxLen; 8 haptic steps; 64 event-name chars.
- `parseLength` and computed pixel sizes: the validator cannot know the viewport; the controller checks rendered size ≥ 44 px (AR-5).

**Panel content schema**

```ts
export type PanelContent =
  | { kind: "text"; title?: string; text: string }
  | { kind: "blocks"; blocks: PanelBlock[] }
  | { kind: "image"; src: string; alt?: string; fit?: "contain" | "cover" };

export type PanelBlock =
  | { type: "heading"; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] }
  | { type: "image"; src: string; alt?: string };

export function validatePanelContent(value: unknown): { ok: true; content: PanelContent } | { ok: false; errors: string[] };
```

Limits: 4 KB serialized; title ≤ 80 chars; text ≤ 1000; blocks ≤ 20; list items ≤ 12, each ≤ 120; image `src` must be a same-origin relative path or a `data:image/(png|jpeg|webp);base64,...` under 2048 chars; reject `http(s):`, `javascript:`, and protocol-relative URLs; `alt` ≤ 120.

**UGC helpers**

```ts
export function sanitizeText(input: unknown, maxLen: number): string; // strips control chars, enforces length, returns plain text
export function isAllowedImageSrc(src: string): boolean;
export function normalizeStrokePoint(x: number, y: number, t: number): { x: number; y: number; t: number };
```

**Debug grid**

- `?layout=debug` on the controller draws a 10% grid, control bounds, ids, bits/channels, active touches, and script ms. It must not alter hit-testing or input.
- The grid is a DOM/SVG overlay with `pointer-events:none`.

**Steps**

- [ ] Complete the per-type validator and cross-control rules; return all errors.
- [ ] Implement `validatePanelContent` with all limits and URL checks.
- [ ] Implement `sanitizeText`, `isAllowedImageSrc`, `normalizeStrokePoint` with tests.
- [ ] Implement the debug grid overlay behind `?layout=debug`; test that it is non-interactive.
- [ ] Add fixtures for every control type, duplicate channels, gyro without fallback, oversized panels, hostile image URLs.
- [ ] Ensure the JSON Schema and validator agree on all fixtures.
- [ ] Export all of the above from `@lanpad/sdk`.

**Acceptance**

- [ ] Every v1 control type validates with a complete fixture.
- [ ] Duplicate axis/channel/bits and a touchpad + right stick are rejected.
- [ ] A panel with `src: "javascript:alert(1)"` or `https://evil` is rejected.
- [ ] `sanitizeText` strips control characters and truncates at the limit.
- [ ] The debug grid cannot intercept touches.

**Tests (tagged)**

- `[FR-8.1] all eleven control types validate`
- `[FR-8.4] validator supports debug grid metadata`
- `[FR-7.7] duplicate channels and touchpad/right-stick conflicts are rejected`
- `[FR-8.10] a gyro control without a fallback is rejected`
- `[SR-13] panel content rejects hostile image URLs`
- `[AR-5] validator/controller both enforce 44px targets`

**Anti-rework**

- The panel schema is the only private-display format; Draw/Guess, Spy, Bluff and Bomb Defusal all use it.
- UGC helpers live in the SDK so games and controllers sanitize the same way.
- Do not add HTML panel content; blocks/images cover the use cases.

**Risks**

- A 4 KB JSON frame includes the envelope; the panel payload gets ~3.6 KB, not 4 KB. Validate against the serialized panel size with margin.
- A same-origin image path can still be attacker-chosen if the host serves user uploads; v1 serves only bundled game assets, so relative paths are safe. Document.

---

### D5-PROTO-01 — Layout, panel, event and ack messages

| Field | Value |
|---|---|
| Layer | Protocol |
| Spec | §7.2, §7.8; FR-7.8, FR-7.9, FR-8.2; SR-6 |
| Depends on | D0-PROTO-01/03, D4-PROTO-01 |
| Unblocks | D5-SRV-01, D5-CTRL-01/05, D5-RT-01 |
| Deliverables | `packages/protocol/src/messages.ts` (extended), `src/json.ts` (validators), `test/layoutMessages.test.ts` |

**Additions**

```ts
// C -> S
| { t: "layoutAck"; layoutId: string }

// C -> S -> H
| { t: "event"; slot: number; name: string; data: JsonValue }

// H -> S -> C (already declared in D0)
| { t: "setLayout"; slot: number | "all"; layout: JsonValue }
| { t: "panel"; slot: number; content: JsonValue }
```

D0 declared `setLayout`, `panel`, and `event`; D5 adds `layoutAck` (spec §7.2) and completes validation.

**Validation**

- `layoutAck.layoutId` 1..64 chars; must match the last layout sent to that slot (server/host enforces; protocol only shapes it).
- `event.name` 1..64 chars; `event.slot` 1..8; `data` any `JsonValue`; serialized frame ≤ 4 KB (frame cap).
- `setLayout.slot` 1..8 or `"all"`; `layout` object with `id` string (full validation is SDK-side; the server does not interpret).
- `panel.slot` 1..8; `content` any `JsonValue`; `content:null` means clear.
- Role routing: only hosts send `setLayout`/`panel`; only controllers send `layoutAck`/`event`; the server validates `event.slot` against the authenticated slot and rejects mismatches.

**Steps**

- [ ] Add `layoutAck` to the client→server union and validator.
- [ ] Tighten `event` validation (name length, slot, data shape).
- [ ] Allow `layoutAck` to carry an optional `slot` filled by the server when forwarding to the host.
- [ ] Add tests for each message, wrong role, mismatched slot, oversized data.
- [ ] Ensure the server can validate size without parsing `layout`/`content` internals (FR-7.9).
- [ ] Update the controller/host switches to handle `layoutAck` and `event`.

**Acceptance**

- [ ] `layoutAck` round-trips and is forwarded to the host with the slot.
- [ ] An `event` with a mismatched slot is rejected.
- [ ] A 4.1 KB event frame is rejected at the frame layer.
- [ ] `setLayout`/`panel` bodies pass through untouched.

**Tests (tagged)**

- `[FR-7.9] server never interprets panel/layout bodies`
- `[FR-7.8] event name and size limits are enforced`
- `[FR-8.2] layoutAck carries the layout id`
- `[SR-6] oversized event frames are rejected`

**Anti-rework**

- `layoutAck` is the only layout confirmation; games wait for acks before starting a layout-dependent phase.
- Keep `data` opaque; games validate their own event schemas.

**Risks**

- The server must not trust `event.slot`; the WS adapter sets/validates it from the peer's slot. Document in the adapter.

---

### D5-SRV-01 — Opaque routing, per-slot rate limits and panel privacy

| Field | Value |
|---|---|
| Layer | Server (broker) |
| Spec | §7.2, §7.8, §7.9; FR-7.8, FR-7.9, FR-8.2; SR-6, SR-13 |
| Depends on | D4-SRV-02, D5-PROTO-01 |
| Unblocks | D5-RT-01, D7 games |
| Deliverables | `packages/broker/src/room/events.ts`, `src/room/layout.ts`, `test/eventRouting.test.ts`, `test/panelPrivacy.test.ts` |

**Behavior**

- `setLayout` from host:
  - `slot: "all"` → send to every connected controller; record `currentLayout` per slot; reset ack state.
  - `slot: n` → send only to slot n; record.
  - Server does not validate the layout body; it only checks size and that `layout.id` is a string.
  - On `playerResumed`/rejoin, the server re-sends the last layout for that slot automatically.
- `panel` from host:
  - Send only to the addressed slot; never to the host, never to other controllers.
  - Record the last panel per slot for rejoin; `content: null` clears.
  - On `playerResumed`, re-send the last panel for that slot.
- `event` from controller:
  - Check the slot matches the authenticated peer; if not, drop and count.
  - Token bucket per slot: 30/s sustained, burst 60; on excess, drop and increment `drops`; do not close the socket unless P3's abuse threshold is exceeded.
  - Forward `{t:"event", slot, name, data}` to the host unchanged.
- `layoutAck` from controller:
  - Forward to host with `slot` filled from the authenticated peer and `layoutId` unchanged.
- Panel privacy test: a panel for slot 2 is never sent to slot 1 or the host.
- Event rate test: 61 events in a burst pass up to 60; the rest drop; sustained 30/s.
- No storage of panel/event bodies except the last panel per slot in memory for rejoin; cleared on expiry/leave.

**Steps**

- [ ] Implement layout state per room/slot and re-send on rejoin.
- [ ] Implement panel state per slot and re-send on rejoin; `content:null` clears.
- [ ] Implement the event token bucket per slot with injected clock.
- [ ] Validate event slot against the peer; drop mismatches with a counter.
- [ ] Forward `layoutAck` to the host with the slot filled.
- [ ] Add tests for panel privacy, layout all/single, rejoin re-send, event flood, slot spoofing.
- [ ] Ensure logs contain event names but never bodies.

**Acceptance**

- [ ] A panel for slot 2 reaches only slot 2.
- [ ] `setLayout all` reaches all connected slots; `slot:3` reaches only 3.
- [ ] A controller that rejoins receives its last layout and panel without a host resend.
- [ ] 61 rapid events yield 60 forwarded and 1 drop; sustained rate ≈30/s.
- [ ] An event claiming another slot is dropped.
- [ ] No event/panel body is persisted or logged.

**Tests (tagged)**

- `[FR-7.9] broker forwards event/panel bodies without interpretation`
- `[FR-7.8] per-slot event rate limit is 30/s with burst 60`
- `[FR-8.2] layout state is re-sent on rejoin`
- `[SR-13] panel content is private to the addressed slot`
- `[SR-12] event and panel bodies are never persisted`
- `[FR-7.8] event slot spoofing is rejected`

**Anti-rework**

- Panel/layout state per slot is the minimal server state needed for rejoin; it is not game state (FR-7.9).
- Rate limiting is generic and reused for haptics in D6.
- `content:null` is the clear path; do not add a separate `clearPanel` message.

**Risks**

- Holding the last panel in memory for 8 slots is trivial; ensure it is cleared on room expiry/leave.
- The server re-sending layout on rejoin may race with the host's own resend; make it idempotent (same layout id).

---

### D5-CTRL-01 — Control registry: trigger, touchpad, slider, gyro, choice, panel, text, canvas

| Field | Value |
|---|---|
| Layer | Controller |
| Spec | §8.1; FR-8.1, FR-7.7; AR-5 |
| Depends on | D2-CTRL-02, D5-SDK-01 |
| Unblocks | D5-CTRL-02..04, D7 games |
| Deliverables | `packages/controller/src/controls/trigger.ts`, `touchpad.ts`, `slider.ts`, `gyro.ts`, `choice.ts`, `panel.ts`, `text.ts`, `canvas.ts`, `test/controlRegistry.test.ts` |

**Behavior**

- **Trigger**: vertical/horizontal bar; value 0..255 on the bound channel; visual fill uses `transform: scaleY/X`; same-frame.
- **Touchpad**: maps absolute touch position to `rx/ry` i16 (`-32767..32767`), center = 0; one touch; 2% center snap. Emits axes only (FR-7.7).
- **Slider**: maps drag 0..255 on `lt`/`rt`; no conflict with trigger (validator).
- **Gyro**: renders an "Enable motion" button (D6 implements sensors); until enabled, shows a neutral state. Must not block the layout. D5 only renders/validates; D6 wires data.
- **Choice**: a list of buttons; tap sends `event {name, data:{value}}`; selected state is local; max 12 options; scrollable.
- **Panel**: a private display area; renders `PanelContent` safely; empty state shows a neutral placeholder; updates in place; text scrolls; images `contain`/`cover`.
- **Text**: an `<input>`/`<textarea>`; focus opens the keyboard; submit sends `event {name, data:{value}}`; `maxLen` enforced; does not send per keystroke; a send button ≥ 44 px.
- **Canvas**: captures one stroke at a time; sends batched points as events; renders the stroke locally immediately; optional `color`/`width` fields added to the schema (defaults `#ffffff`, 6 px). Additive to D2's `CanvasControl`.
- All controls use the D2 `ControlRenderer` interface and register by type.

**Steps**

- [ ] Implement each renderer with same-frame feedback and `transform`/`opacity`.
- [ ] Enforce 44 px rendered size for interactive controls; show a debug warning if smaller.
- [ ] Wire trigger/slider/touchpad into `InputStore` channels.
- [ ] Render `PanelContent` with `textContent`, `isAllowedImageSrc`, and scroll containers.
- [ ] Implement text submit and choice events via the D5-CTRL-05 event queue.
- [ ] Implement canvas stroke capture with local rendering and batching.
- [ ] Add tests for state contributions and event payloads for each control.
- [ ] Add optional canvas `color`/`width` fields to the SDK schema and validator (additive).

**Acceptance**

- [ ] Every control type renders from a fixture layout.
- [ ] Touchpad maps center to 0 and edges to ±32767; slider maps 0..255.
- [ ] Panel renders text/blocks/image without HTML injection.
- [ ] Text sends one event on submit, not per keypress.
- [ ] Canvas shows ink immediately and batches points.
- [ ] All interactive controls meet 44 px.

**Tests (tagged)**

- `[FR-8.1] all control types render from layout data`
- `[FR-7.7] touchpad maps to rx/ry and slider to lt/rt`
- `[AR-5] interactive controls are at least 44px`
- `[FR-8.3] control updates use transform/opacity only`
- `[SR-13] panel text is rendered as text, never HTML`

**Anti-rework**

- The control registry is the only place control types are created; games ship layouts, never phone UI code.
- Panel rendering is reused by Draw/Guess, Spy, Bluff and Bomb Defusal.
- Canvas batching is the only stroke path; do not add per-point events.

**Risks**

- `input` elements can zoom on focus on Android if font-size < 16 px; set ≥ 16 px and avoid disabling zoom globally (accessibility).
- Panel images from data URIs can be large; enforce the 2 KB data cap.

---

### D5-CTRL-02 — Layout hot-swap per slot/all with no reload

| Field | Value |
|---|---|
| Layer | Controller |
| Spec | §8.1, §8.2; FR-8.2, FR-8.3; D5 contract 2 |
| Depends on | D5-CTRL-01, D4-CTRL-01 |
| Unblocks | D7 games, Bomb Defusal per-slot layouts |
| Deliverables | `packages/controller/src/layout/LayoutHost.ts`, `src/layout/swap.ts`, `test/hotSwap.test.ts` |

**Behavior**

- On `setLayout`:
  1. Validate with `validateLayout`; on failure, keep the current layout and do not ack (log/debug counter).
  2. Cancel all active touches (release pressed state).
  3. Dispose old controls; build new DOM in a fragment; mount in one operation.
  4. Reset input contributions from controls (buttons/axes to neutral); keep connection/session.
  5. Send `layoutAck {layoutId}`.
- `slot:"all"` arrives as a per-slot message from the server; each controller handles its own.
- Preserve panel content by control id across a swap; the controller keeps the last `PanelContent` and re-renders it into any new panel control with the same id.
- Hot-swap must not scroll or reload; re-cache hit rects.
- If the layout has a different orientation, show a rotate prompt (basic in D5; full UX D6/P6).
- Send `layoutAck` within 100 ms of receiving; record swap time in the debug overlay.

**Steps**

- [ ] Implement `LayoutHost` that owns the current layout, controls and rect cache.
- [ ] Implement swap: cancel touches, dispose, build, mount, reset input, ack.
- [ ] Preserve panel state by control id; test a panel survives a swap.
- [ ] Ignore a layout with the same id (idempotent).
- [ ] Add tests with fake DOM: swap disposes old controls, emits ack, resets state.
- [ ] Add a manual test: swap between a stick layout and a button layout while connected; no reload.
- [ ] Record swap time in `docs/RESULTS.md`.

**Acceptance**

- [ ] Layout swaps with no page reload and no reconnect.
- [ ] The new layout is interactive immediately; old controls are removed.
- [ ] Touches held during a swap are released, not stuck.
- [ ] Panel content survives if the new layout has a panel with the same id.
- [ ] Invalid layouts are rejected without breaking the current layout.
- [ ] Ack is sent for successful swaps only.

**Tests (tagged)**

- `[FR-8.2] layout hot-swap works per slot without reload`
- `[FR-8.2] layoutAck is sent with the new layout id`
- `[FR-8.3] swap rebuilds DOM once, not per control`
- `[FR-7.12] held touches are released on swap`
- `[FR-8.1] panel state survives a swap by control id`

**Anti-rework**

- `LayoutHost` is the only owner of control instances; D6 gyro/haptics register into it.
- Per-slot layouts (Bomb Defusal) work because each controller receives its own swap.
- Idempotent same-id swaps prevent ack storms.

**Risks**

- Rapid swaps can thrash the DOM; coalesce layouts received in the same tick and apply the latest.
- Rebuilding controls may lose focus on a text input; preserve focus/value by control id if the same control persists.

---

### D5-CTRL-03 — Text input and on-screen keyboard handling

| Field | Value |
|---|---|
| Layer | Controller |
| Spec | §8.2, §8.9; FR-8.9; §20 E16 |
| Depends on | D5-CTRL-01, D5-CTRL-02 |
| Unblocks | Draw and Guess, Bluff Quiz, Spy, Bomb Defusal |
| Deliverables | `packages/controller/src/controls/textInput.ts`, `src/layout/viewport.ts`, `test/textInput.test.ts` |

**Behavior**

- Use a real `<input type="text">` or `<textarea>` with `font-size: 16px` minimum, `enterkeyhint="send"`, `autocapitalize="sentences"`, `autocorrect` off for game answers.
- On focus, scroll the control into view using `visualViewport` and `scrollIntoView({block:"center"})`; listen to `visualViewport.resize` and recompute layout/hit rects.
- Do not rely on `window.innerHeight` alone; use `visualViewport.height` and `offsetTop` to size the play surface.
- Keep the text control and submit button visible; allow scrolling the control area if necessary.
- Submit on Enter or the send button; trim; enforce `maxLen`; send one `event`; clear the input only after send.
- On blur caused by submit, keep focus if the layout says `keepFocus` (additive optional field) else blur.
- Paste is allowed but truncated; no HTML.
- On orientation change while focused, reflow without losing text.

**Steps**

- [ ] Implement the text control with a send button and Enter handling.
- [ ] Implement `viewport.ts`: `visibleHeight`, `keyboardOpen`, resize subscription via `visualViewport` with `innerHeight` fallback.
- [ ] Recompute control rects and layout scale on viewport change; test with simulated heights.
- [ ] Add tests for maxLen, trim, one-event-per-submit, and value preservation across a reflow.
- [ ] Run E16 on Android Chrome: keyboard open, type, submit, layout usable.
- [ ] Record the keyboard behavior and any workaround in `docs/RESULTS.md`.

**Acceptance**

- [ ] Opening the keyboard does not hide the text control or send button.
- [ ] The layout remains usable (no controls off-screen) or scrolls to them.
- [ ] Enter/send sends exactly one event with the current value.
- [ ] Text survives an orientation change.
- [ ] `maxLen` is enforced before send.

**Tests (tagged)**

- `[FR-8.9] keyboard resize keeps the text control usable`
- `[FR-7.8] text submits one event, not per keystroke`
- `[SR-13] text is sent as plain text and truncated to maxLen`
- `[E16] keyboard handling passes on Android Chrome`

**Anti-rework**

- `viewport.ts` is shared by canvas and panel scrolling; keyboard handling is not text-control-specific.
- Games never build text UI; they declare `text` controls.

**Risks**

- Android keyboards can overlay rather than resize; `visualViewport` handles most cases. Record OEM differences.
- `scrollIntoView` can scroll the page unexpectedly; constrain to the play surface.

---

### D5-CTRL-04 — Canvas stroke capture and batching

| Field | Value |
|---|---|
| Layer | Controller |
| Spec | §7.2, §8.1; FR-7.8, FR-8.1; §20 E10 |
| Depends on | D5-CTRL-01, D2-CTRL-01 |
| Unblocks | Draw and Guess, Heist Planner diagrams |
| Deliverables | `packages/controller/src/controls/canvas.ts`, `src/controls/strokeBatcher.ts`, `test/strokeBatcher.test.ts` |

**Behavior**

- One active stroke at a time; the first touch on the canvas binds; additional touches are ignored until end.
- Capture points at most every 16 ms or every 8 px of movement, whichever comes first; store `{x,y,t}` normalized 0..1.
- Render the stroke locally immediately on a `<canvas>` with `requestAnimationFrame` (coalesced), so the drawer sees ink without network delay.
- Batch into events:
  - `phase:"start"` with the first point;
  - `phase:"move"` with up to 16 points every ~50 ms;
  - `phase:"end"` with the final points and total count.
- On `touchend/cancel`, flush remaining points and send `end`.
- Respect the event queue's 30/s; batch size adapts so bytes/s stays under 20 KB/s (E10).
- If the queue is full, coalesce points (drop intermediate points) rather than dropping the stroke.
- Color/width: optional layout fields (`color` default `#ffffff`, `width` default 6); added to schema in D5-CTRL-01.
- No storage; the stroke is only sent.

**Steps**

- [ ] Implement `StrokeBatcher` with configurable max points/interval and a byte estimate; test batching at 60/120 Hz input.
- [ ] Implement the canvas control with local rendering and touch binding.
- [ ] Flush on end/cancel; send `end` even if no move points.
- [ ] Add tests for point normalization, max points per event, coalescing under pressure, and byte rate.
- [ ] Run E10: draw fast for 30 s; measure bytes/s and TV delay; record.
- [ ] Tune batch size/interval to stay under 20 KB/s and under 100 ms.

**Acceptance**

- [ ] A stroke produces `start` → `move`* → `end` events in order.
- [ ] Local ink appears before the first network packet.
- [ ] Bytes/s per drawer < 20 KB/s at normal drawing speed.
- [ ] TV delay < 100 ms on LAN.
- [ ] A canceled touch still ends the stroke.

**Tests (tagged)**

- `[FR-7.8] strokes are batched, not one event per point`
- `[FR-8.1] canvas control captures freehand strokes`
- `[E10] stroke bandwidth is under 20 KB/s per drawer`
- `[E10] stroke visible delay is under 100 ms`
- `[SR-13] strokes are not stored`

**Anti-rework**

- The batcher is reused by any future drawing control; keep it independent of the game.
- Event shapes are documented in the SDK so Draw/Guess can parse them.

**Risks**

- High-frequency touch devices can produce hundreds of points/s; the 8 px threshold and 16 ms sampling cap the rate.
- Local canvas rendering can be costly on low-end phones; render at CSS size, not DPR 2, for the stroke layer.

---

### D5-CTRL-05 — Event send queue, rate limiting and coalescing

| Field | Value |
|---|---|
| Layer | Controller |
| Spec | §7.2, §7.8; FR-7.8; SR-6 |
| Depends on | D5-PROTO-01, D5-CTRL-01 |
| Unblocks | All event-driven games |
| Deliverables | `packages/controller/src/events/EventQueue.ts`, `test/eventQueue.test.ts` |

**Behavior**

- Queue events with `{name, data}`; the client attaches its slot from the joined state.
- Rate limit: 30/s sustained, burst 60; token bucket; when empty, coalesce compatible events (strokes) or drop the oldest low-priority event; never silently drop a `text`/`choice` submission—show a local "busy" state and retry once.
- Size limit: 4 KB serialized per event; if over, drop and show a debug counter (strokes batch to fit).
- Send over the existing WebSocket as JSON; no separate channel.
- On disconnect, buffer up to 50 events for 5 s; on reconnect, flush in order; drop older events with a counter.
- Expose `pending`, `dropped`, `lastSendAge` to the debug overlay.
- No event storage.

**Steps**

- [ ] Implement the token bucket and queue with injected clock/timers.
- [ ] Implement priority: text/choice > stroke > ephemeral events.
- [ ] Implement serialization and size check with `TextEncoder`.
- [ ] Implement reconnect buffering/flush.
- [ ] Add tests for 30/s, burst 60, overflow, size, ordering, and reconnect flush.
- [ ] Wire control events into the queue; ensure text submits once.

**Acceptance**

- [ ] Sustained 30/s passes; burst 61 → 60 pass, 1 coalesced/dropped with a counter.
- [ ] Text/choice events are not silently dropped.
- [ ] Ordering is preserved per slot.
- [ ] A 4.1 KB event is rejected before send.
- [ ] Reconnect flushes buffered events in order.

**Tests (tagged)**

- `[FR-7.8] event queue enforces 30/s with burst 60`
- `[FR-7.8] stroke events coalesce instead of flooding`
- `[FR-7.9] events are opaque to the client transport layer`
- `[SR-6] oversized events are dropped before send`
- `[FR-7.15] buffered events flush after reconnect`

**Anti-rework**

- One event path for every control; do not send events directly from control code.
- Priority classes let drawing remain smooth while answers are reliable.

**Risks**

- A malicious third-party game could flood its own queue; the server also rate-limits (defense in depth).
- Holding events across a long disconnect may replay stale input; cap the buffer at 5 s.

---

### D5-RT-01 — Host layout manager, panel API and event dispatch

| Field | Value |
|---|---|
| Layer | Host runtime |
| Spec | §7.2, §8.1, §8.2; FR-8.2, FR-7.9, FR-7.17; D5 contracts 2, 3, 7, 8 |
| Depends on | D5-PROTO-01, D5-SRV-01, D3-RT-04, D4-HOST-02 |
| Unblocks | D7 proof games |
| Deliverables | `packages/runtime/src/game/LayoutApi.ts`, `src/game/PanelApi.ts`, `src/game/EventRouter.ts`, `test/layoutApi.test.ts`, `test/panelApi.test.ts`, `test/eventRouter.test.ts` |

**Behavior**

- `LayoutApi.set(slot|"all", layout)`:
  - Validate with SDK; throw a clear developer error on invalid layout.
  - Send `setLayout`; track pending ack per slot with the layout id.
  - `waitForAcks(slot|"all", timeoutMs=2000)` for games that need all phones ready; reject on timeout with per-slot status.
  - On `playerResumed`, re-send the current layout and panel for that slot.
- `PanelApi.set(slot, content)`:
  - Validate with SDK (4 KB); send `panel`; store last content per slot for reconnect resend.
  - `clear(slot)` sends `{content:null}`.
- `EventRouter`:
  - Receives `event` from `HostClient`; validates slot/name/size; queues in a fixed ring (capacity 256).
  - `ctx.events.on(name, handler)` registers handlers; dispatch at the start of the next `simulate` so games see events in the tick they arrived.
  - Unknown names go to a catch-all or are dropped with a counter.
  - Event data is `JsonValue`; games validate their own shape; no `innerHTML`.
- On `playerLeft`, clear panel/layout state for that slot.
- Debug counters: acks pending, layout swaps, events received/dropped, panel bytes.

**Steps**

- [ ] Implement `LayoutApi` with ack tracking and timeout.
- [ ] Implement `PanelApi` with validation and last-content storage.
- [ ] Implement `EventRouter` with a fixed ring and per-name handlers.
- [ ] Wire `playerResumed` to resend layout/panel.
- [ ] Add tests: ack success/timeout, panel resend, event ordering, ring overflow, unknown event.
- [ ] Add a dummy two-phone test page that swaps layouts and shows a panel; record it.

**Acceptance**

- [ ] A game can set a layout for one slot or all and wait for acks.
- [ ] A panel sent to slot 2 is not visible to slot 1.
- [ ] On reconnect, the slot receives its layout and panel automatically.
- [ ] Events arrive in order and are dispatched once.
- [ ] No socket is exposed to the game.

**Tests (tagged)**

- `[FR-8.2] host can hot-swap layouts per slot or all`
- `[FR-7.9] panel API keeps bodies opaque`
- `[FR-7.17] games receive events through the context, never sockets`
- `[FR-7.12] event dispatch drains once per tick`
- `[FR-5.4] reconnected slots receive their layout and panel`

**Anti-rework**

- These APIs are the game-facing surface for all interaction; P4 freezes them.
- Ack tracking is per slot so Bomb Defusal can wait for the defuser's layout.
- Panel state storage is minimal and cleared on leave.

**Risks**

- A phone that never acks can block a phase; `waitForAcks` must time out and let the game degrade.
- Layout objects can be large (16 KB); keep one per slot, not per send, and compare by id.

---

### D5-SEC-01 — UGC sanitization and XSS defenses

| Field | Value |
|---|---|
| Layer | Security (controller + host + SDK) |
| Spec | §13; SR-13, SR-7; §19 UGC caveat |
| Depends on | D5-SDK-01, D5-CTRL-01, D5-RT-01 |
| Unblocks | Draw and Guess, Bluff Quiz, Spy, Bomb Defusal; P3 content filter |
| Deliverables | `sdk/src/ugc.ts` (completed), `packages/controller/src/render/safeRender.ts`, `packages/runtime/src/game/safeData.ts`, `test/xss.test.ts` |

**Rules**

- Never assign user/game content to `innerHTML`, `outerHTML`, `insertAdjacentHTML`, or `document.write`.
- Text: `textContent` only; strip C0/C1 control chars; enforce max length.
- Panel blocks: build DOM nodes explicitly; no HTML strings.
- Images: only same-origin relative paths or `data:image/(png|jpeg|webp);base64,` under 2048 chars; reject `javascript:`, `http(s):`, `//`, and `blob:` (v1).
- Colors: validate `#rgb`/`#rrggbb`; never pass arbitrary CSS strings to `style`.
- Event `name`: `^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$`.
- Player names: plain text, ≤ 24 chars.
- No `eval`, `new Function`, dynamic `<script>`, or `srcdoc`.
- CSP is the second layer (P2), not the only defense.

**Steps**

- [ ] Audit every render path for `innerHTML`; replace with `textContent`/explicit nodes.
- [ ] Implement `safeRender` helpers and use them in panel/text/choice.
- [ ] Add tests with payloads: `<img src=x onerror=alert(1)>`, `"><script>`, `javascript:` URL, `data:text/html`, oversized text, control chars, CSS expression.
- [ ] Add a lint rule or grep test banning `innerHTML` in controller/runtime.
- [ ] Add a test that a hostile panel is rejected before render.
- [ ] Document the UGC policy in `sdk/README.md` (nothing stored, room-only display).

**Acceptance**

- [ ] All payload tests render as inert text or are rejected; no script runs.
- [ ] No `innerHTML` in controller/runtime source (grep test).
- [ ] Hostile image URLs are rejected.
- [ ] Text/event sizes are enforced before render.
- [ ] Nothing is written to storage or a server log.

**Tests (tagged)**

- `[SR-13] UGC is rendered as text and never stored`
- `[SR-13] hostile panel text cannot execute script`
- `[SR-13] javascript/data URLs are rejected for panel images`
- `[SR-7] no UGC is persisted or sent to analytics`
- `[SR-13] event names are validated against a safe pattern`

**Anti-rework**

- Safe render helpers are shared by all games and the controller; do not re-implement per game.
- The content-filter hook (P3) operates on this same sanitized text path.

**Risks**

- A future rich-text panel could reintroduce HTML; any such change requires a new schema + security review.
- Third-party games render the host scene, not host HTML in v1; if that changes, this policy must extend to host DOM.

---

### D5-EXP-01 — E10 stroke streaming and E16 keyboard handling

| Field | Value |
|---|---|
| Layer | Experiments/docs |
| Spec | §20 E10/E16; §14 D5 |
| Depends on | D5-CTRL-03, D5-CTRL-04, D5-SRV-01 |
| Unblocks | Draw and Guess, Bluff Quiz; Gate |
| Deliverables | `experiments/e10/index.html`, `experiments/e16/index.html`, `docs/RESULTS.md` rows |

**E10 — stroke streaming**

- Draw fast on the canvas control for 30 s; measure bytes/s per drawer (client event log) and visible delay on the TV (240 fps camera or timestamped host paint).
- Pass: < 20 KB/s per drawer, delay < 100 ms.
- If it fails: increase batching, quantize points to 1/2048, drop intermediate points.

**E16 — keyboard handling**

- Open the text control on Android Chrome; type 60 chars; submit; rotate; repeat with the keyboard open.
- Pass: layout stays usable; the text control and send button remain visible; no lost text.
- Record OEM/browser differences; iOS is deferred (A5).

**Steps**

- [ ] Build E10 with a visible byte counter and a host echo of stroke points.
- [ ] Run E10 at slow/medium/fast drawing; record bytes/s and delay.
- [ ] Build E16 with a text control at several viewport heights; record screenshots.
- [ ] Run on at least one Android phone; record device/browser/version.
- [ ] Tune batching/quantization if over budget; re-run.
- [ ] Record both rows in `docs/RESULTS.md`.

**Acceptance**

- [ ] E10 numbers recorded and under the pass thresholds, or a remediation plan is written.
- [ ] E16 passes on the test Android phone; layout remains usable.
- [ ] Results include method, device, browser, date.

**Tests (tagged)**

- `[E10] stroke bytes/s stays under 20 KB/s per drawer`
- `[E10] stroke delay on TV stays under 100 ms`
- `[E16] text layout remains usable with the keyboard open`
- `[FR-8.9] keyboard resize handling is verified on a real device`

**Anti-rework**

- E10's batching parameters become the defaults for the canvas control; record them in the SDK.
- E16's viewport approach is shared by all text/panel scrolling.

**Risks**

- Camera-based delay measurement is imprecise; pair with host paint timestamps.
- Android keyboards vary; record at least one Samsung/Pixel-class device.

---

### D5-QA-01 — Panel/text/draw round-trip, rate limits and XSS suite

| Field | Value |
|---|---|
| Layer | QA |
| Spec | §14 D5 exit; §16; SR-6, SR-13 |
| Depends on | D5-SRV-01, D5-CTRL-01..05, D5-RT-01, D5-SEC-01 |
| Unblocks | D6 entry, D7 games |
| Deliverables | `test/e2e/d5-roundtrip.test.ts`, `docs/RESULTS.md` D5 row |

**Scenarios**

- [ ] Panel: host sends a secret word to slot 2; slot 2 displays it; slot 1 and the host receive nothing.
- [ ] Text: slot 1 submits "hello"; host event router receives `{name, value:"hello"}` with slot 1.
- [ ] Canvas: slot 1 draws a stroke; host receives start/move/end in order; TV renders the same shape.
- [ ] Choice: slot 3 picks option B; host receives the value.
- [ ] Hot swap: switch slot 1 to a new layout while slot 2 keeps the old one; both remain connected.
- [ ] Reconnect: drop slot 2, rejoin; it receives its last layout + panel without host intervention.
- [ ] Rate limit: 100 events in 1 s; at most 60 forwarded; no crash.
- [ ] XSS suite: hostile panel/text/image/event payloads are inert.
- [ ] Size: 5 KB panel rejected; 4 KB event rejected.

**Steps**

- [ ] Automate the panel/text/draw/choice round-trips with a host-client test harness and two fake controllers.
- [ ] Run the hot-swap and reconnect scenarios on real devices.
- [ ] Run the rate-limit flood with the input-bot or a fake controller.
- [ ] Run the XSS suite from D5-SEC-01.
- [ ] Record results and screenshots in `docs/RESULTS.md`.
- [ ] Fix failures; add regressions.

**Acceptance**

- [ ] All round-trips pass.
- [ ] Panel privacy holds.
- [ ] Rate limit holds.
- [ ] XSS suite passes.
- [ ] Reconnect restores layout/panel.
- [ ] Results recorded with device/browser.

**Tests (tagged)**

- `[C3] private panel round-trips to one slot`
- `[C4] text and choice events round-trip`
- `[C5] canvas strokes round-trip in order`
- `[FR-7.8] event flood is rate-limited`
- `[SR-13] hostile UGC is inert`
- `[FR-8.2] hot-swap per slot does not affect other slots`

**Anti-rework**

- This suite is the platform acceptance for every UI-heavy game; keep it runnable without a phone via fake controllers.
- Reuse the trace harness from D2 for event sequences.

**Risks**

- Fake controllers can miss DOM-specific bugs; run the same scenarios on at least one real phone.
- Panel privacy bugs are security bugs; do not accept "works most of the time."

---

## Stage exit checklist

- [ ] D5-SDK-01, D5-PROTO-01, D5-SRV-01, D5-CTRL-01..05, D5-RT-01, D5-SEC-01, D5-EXP-01, D5-QA-01 complete.
- [ ] All 11 control types render and validate.
- [ ] Hot-swap per slot/all works without reload.
- [ ] Panels are private; text/choice/canvas events round-trip.
- [ ] Event rate/size limits and XSS suite pass.
- [ ] E10 and E16 recorded and passing or remediated.
- [ ] Reconnect restores layout/panel.
- [ ] `docs/RESULTS.md` D5 row complete.

## Handoff to D6

- D6 adds gyro data to the existing `gyro` control and haptic playback to the existing control renderers.
- The layout validator already enforces a non-gyro fallback; D6 wires the sensor and the "Enable motion" flow.
- Panels can display calibration instructions; do not add a second private-display path.

## Explicitly not in D5

- Sensors and haptics (D6).
- Proof games (D7).
- Content filter/pack editor (P3/P6).
- Visual layout editor (post-v1).
- iOS keyboard testing (A5).
