# D6 — Sensors and Haptics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Steps use checkbox syntax.
>
> **Goal:** Add motion control and vibration: a permission/secure-context flow, `rotationRate` capture with axis remapping, smoothing and auto-zero, a gyro layout binding with a required fallback, and a rate-limited haptic path. Record E7/E8 on Android; iOS is deferred (A5).
>
> **Architecture:** The controller reads `devicemotion.rotationRate`, remaps it to screen-relative axes, filters and encodes it into the existing Input gyro fields. The host optionally integrates rates into a tilt angle for maze-style games. Haptics travel host→broker (`HapticCmd`)→controller (`Haptic`), coalesced at 20 Hz and rendered via `navigator.vibrate` or a visual/audio fallback.
>
> **Tech stack:** DeviceMotion API, `screen.orientation`, one-pole low-pass, Web Vibration API, Web Audio click fallback, HTTPS tunnel for dev sensor tests.
>
> **Spec:** `SPEC.md` §4.4, §7.1, §8.2–§8.4, §12, §14 D6, §20 E7/E8; FR-7.5, FR-7.6, FR-8.5, FR-8.10–8.12; AR-3; A5.
>
> **Program position:** Phase 1, after D5. D7's Tilt Maze Race consumes this; Sword Swing Duel stays gated on the swing feasibility result.

## Global constraints

- Motion APIs require a secure context on Chrome Android (HTTPS or localhost); a LAN HTTP page may not deliver `devicemotion` (E7 verifies).
- iOS is **out of v1 acceptance** (A5). Keep `DeviceMotionEvent.requestPermission` feature-detected and harmless; do not schedule iOS testing.
- Gyro values are i16 degrees/second × 10 (range ±3276 dps); flags bit 0 = motion active, bit 1 = recentered (FR-7.5/7.6).
- Every gyro layout must include a non-gyro fallback; the validator already enforces it (FR-8.10).
- Haptics are optional: no game may require them to be playable; global toggle (AR-3); rate limit 20 Hz per slot (FR-8.11).
- No sensor data is stored or sent anywhere except the Input packets; no analytics (SR-7).
- Haptic patterns: 1–8 durations, each 0–65535 ms, alternating vibrate/pause.

---

## Stage goal and exit criteria (amended by A5)

**Original §14 D6 exit:** gyro on Android + iOS, Android vibration, swing feasibility known.
**Amended exit:** gyro on Android Chrome, Android vibration, swing feasibility known. iOS is deferred and not a gate.

Concretely:

- [ ] "Enable motion" appears on a gyro layout; denying/unavailable gracefully falls back to buttons.
- [ ] Android Chrome delivers stable, remappable rates over HTTPS (tunnel) and the controller encodes them at 60 Hz.
- [ ] Tilt Maze's control scheme is proven feasible on a phone (host-integrated angle).
- [ ] Haptic patterns play distinctly on Android at 20 Hz; the global toggle and visual fallback work.
- [ ] E7 (Android leg) and E8 recorded; swing feasibility note recorded.
- [ ] No game requires haptics or gyro.

**Layer coverage**

| Layer | Work items |
|---|---|
| Controller | D6-CTRL-01..04 |
| Server | D6-SRV-01 |
| Host runtime | D6-RT-01 |
| Experiments/docs | D6-EXP-01, D6-DOC-01 |
| QA | D6-QA-01 |

**Goals advanced:** G5 (gyro, haptics, graceful degradation), G2 (60 Hz sensor encoding), G7 (device-verified API behavior).

---

## Contracts frozen in D6

1. **Motion sample**: `{gx, gy, gz}` i16 dps×10, screen-relative after remap; zero when motion is inactive.
2. **Flags**: bit 0 motion active, bit 1 recentered this packet; reserved bits stay 0.
3. **Layout binding**: `gyro` control or `sensors.gyro`; `smoothing` default 0.15; `sensitivity` default 1.0.
4. **Calibration**: first 500 ms auto-zero; a visible Recalibrate button sets the current rate bias to zero and sets flag bit 1 for one packet.
5. **Host tilt state**: `TiltState { angleX, angleY, biasX, biasY }` integrated from rates at 60 Hz; recenter resets to 0; clamp ±30°.
6. **Haptics**: host `ctx.haptics.pulse(slot|"all", durationsMs)` → `HapticCmd` → broker → `Haptic`; controller coalesces at 20 Hz; `navigator.vibrate` or visual pulse.
7. **Toggle**: `localStorage["lanpad.haptics"] = "on"|"off"`, default on; toggling off stops vibration immediately and suppresses future patterns.
8. **Fallback rule**: if `devicemotion` is unavailable/denied or the secure context is missing, motion is inactive and the layout's non-gyro controls remain fully usable.

---

## Work items

### D6-CTRL-01 — Motion enable flow, secure context and permission feature detection

| Field | Value |
|---|---|
| Layer | Controller |
| Spec | §4.4, §8.3; FR-8.10, FR-12.1; E7 |
| Depends on | D5-CTRL-01 (gyro control placeholder) |
| Unblocks | D6-CTRL-02, D6-CTRL-03 |
| Deliverables | `packages/controller/src/sensors/motionPermission.ts`, `src/sensors/MotionEnable.ts`, `test/motionPermission.test.ts` |

**Behavior**

- On a layout with a gyro control, show an "Enable motion" button (not an automatic prompt).
- Feature detect:
  - `window.isSecureContext === true`; if false, show "Motion needs HTTPS" and keep the fallback controls; offer the tunnel/flag instructions in the debug panel (D6-DOC-01).
  - `typeof DeviceMotionEvent !== "undefined"`; if false, disable the gyro control and keep the fallback.
  - `typeof (DeviceMotionEvent as any).requestPermission === "function"`; call it **only if it exists** (iOS path; A5 says don't test, but code stays safe). On Android Chrome it does not exist; proceed to listen directly.
- On tap:
  - If `requestPermission` exists, await it; `granted` → start listening; `denied` → show denied state + fallback.
  - Else start listening immediately.
- If no `devicemotion` event arrives within 1 s, show "No motion data" and fall back.
- The enable button is ≥ 44 px, keyboard-focusable, and does not block other controls.
- Do not auto-enable on reload without a gesture; show the button again if permission is not persisted.
- Never request permission on page load.

**Steps**

- [ ] Implement `motionPermission` with injected environment flags for tests (secure, API present, requestPermission present).
- [ ] Implement `MotionEnable` UI states: idle, requesting, granted, denied, no-data, insecure-context, unsupported.
- [ ] Start the sensor only after a successful gesture; stop on layout swap without gyro.
- [ ] Add tests for every environment combination; no `requestPermission` call when absent.
- [ ] Add a manual Android test over HTTPS (tunnel) and over LAN HTTP; record the difference.
- [ ] Ensure the fallback controls are enabled in every failure state.

**Acceptance**

- [ ] No permission prompt/call happens on page load.
- [ ] Android Chrome (no `requestPermission`) starts on tap.
- [ ] A denied permission leaves a playable fallback and a clear message.
- [ ] Insecure context shows the HTTPS requirement and keeps the fallback.
- [ ] No device data within 1 s falls back cleanly.

**Tests (tagged)**

- `[FR-12.1] motion permission is feature-detected, not UA-sniffed`
- `[FR-8.10] denied/unavailable motion keeps the non-gyro fallback`
- `[E7] secure-context requirement is detected and explained`
- `[A5] iOS permission code path is harmless and untested`
- `[AR-5] motion enable button meets 44px`

**Anti-rework**

- The permission state machine is reused by any future sensor; do not inline it in the gyro control.
- `sessionStorage` is only for the UI choice; never persist sensor streams.

**Risks**

- Some Android browsers deliver `devicemotion` without a prompt only on HTTPS; the LAN HTTP test may show no data even though the API exists. That is E7's key finding.
- Chrome flags (`unsafely-treat-insecure-origin-as-secure`) can mask the HTTPS requirement; record when the flag is used.

---

### D6-CTRL-02 — rotationRate capture, axis remap, smoothing, auto-zero and encoding

| Field | Value |
|---|---|
| Layer | Controller |
| Spec | §8.3; FR-7.5, FR-7.6, FR-8.5; E7 |
| Depends on | D6-CTRL-01, D2-CTRL-03 |
| Unblocks | D6-CTRL-03, D6-RT-01, Tilt Maze |
| Deliverables | `packages/controller/src/sensors/MotionSource.ts`, `src/sensors/remap.ts`, `src/sensors/lowPass.ts`, `src/sensors/calibration.ts`, `test/motionSource.test.ts` |

**Freeze this interface**

```ts
export interface MotionSample {
  gx: number; gy: number; gz: number; // i16 dps x10
  active: boolean;
  recentered: boolean;
}

export class MotionSource {
  constructor(deps: {
    addEventListener: (type: "devicemotion", cb: (e: DeviceMotionEvent) => void) => void;
    removeEventListener: (type: "devicemotion", cb: (e: DeviceMotionEvent) => void) => void;
    getScreenAngle: () => number;
    now: () => number;
  });
  start(opts: { smoothing: number; sensitivity: number }): void;
  stop(): void;
  recalibrate(): void;
  readonly latest: MotionSample;
}
```

**Pipeline**

1. Read `event.rotationRate` → `{alpha, beta, gamma}` in degrees/second (spec ASSUMED; E7 verifies units/signs).
2. If null, emit an inactive sample; do not throw.
3. Remap by `screen.orientation.angle`:
   ```ts
   const a = (angle * Math.PI) / 180;
   const rawX = Math.cos(a) * gamma + Math.sin(a) * beta;
   const rawY = -Math.sin(a) * gamma + Math.cos(a) * beta;
   const rawZ = alpha;
   ```
   The goal: in landscape, tilting the phone's top edge away from the player produces a positive forward rate. E7 validates signs; if a platform differs, adjust the mapping table, not the games.
4. Apply a one-pole low-pass per axis: `y = alpha * x + (1 - alpha) * y`, `alpha` from layout `sensors.smoothing` or gyro control `smoothing` (default 0.15, clamp 0.02–1).
5. Auto-zero: for the first 500 ms after start/recalibrate, accumulate the mean rate per axis as bias; subtract bias thereafter. `recalibrate()` resets bias and sets `recentered` for one packet.
6. Multiply by `sensitivity` (clamp 0.5–3) and by 10 (dps×10); clamp to i16.
7. Emit at 60 Hz by sampling `latest` in the controller's send loop (do not send from the devicemotion callback; it can fire faster).
8. When stopped/inactive: `gx=gy=gz=0`, `active=false`.

**Steps**

- [ ] Implement `remap` with tests for screen angles 0/90/180/270 and known raw vectors.
- [ ] Implement `lowPass` with a step-response test and parameter clamp.
- [ ] Implement bias estimation with a 500 ms window and recalibration.
- [ ] Implement `MotionSource` with injected event targets and clock; test null `rotationRate`, missing events, and stop.
- [ ] Wire the 60 Hz sample into `InputStore.setGyro` and flags.
- [ ] Add a visible "Recalibrate" button when motion is active; test that it resets angle/offset.
- [ ] Record raw vs remapped vs filtered values in the debug overlay.
- [ ] Run E7's logging page on Android; adjust the mapping/sign table if needed and record the final mapping.

**Acceptance**

- [ ] A still phone reports ~0 dps after auto-zero; drift is reduced by recalibration.
- [ ] Rotating around each axis produces the expected dominant axis in landscape/portrait.
- [ ] Values are within i16 after sensitivity.
- [ ] Recalibrate sets flag bit 1 for exactly one packet.
- [ ] No devicemotion listener remains after stop/layout swap.
- [ ] 60 Hz emission is independent of sensor event frequency.

**Tests (tagged)**

- `[FR-7.5] gyro values are encoded as dps x10 i16`
- `[FR-7.6] motion active and recentered flags are set correctly`
- `[FR-8.5] smoothing is configurable per layout with default 0.15`
- `[E7] axis remap handles screen orientation angles 0/90/180/270`
- `[E7] rotationRate null values and drift are handled`
- `[FR-8.10] stopping motion emits zeros and keeps controls usable`

**Anti-rework**

- The remap table is the single platform-specific mapping; games consume screen-relative rates, never raw beta/gamma.
- `MotionSource` is independent of the layout renderer; the gyro control reads it.
- Do not integrate angles in the controller; the host owns game-specific interpretation (D6-RT-01).

**Risks**

- Chrome Android may report `rotationRate` in a different sign convention than iOS; E7 records per-platform signs and the remap table handles them.
- Auto-zero during movement can bake in a false bias; show the calibration state and allow recalibration.
- Low-pass adds lag; allow smoothing down to 0.02 for steering.

---

### D6-CTRL-03 — Gyro control binding and non-gyro fallback

| Field | Value |
|---|---|
| Layer | Controller |
| Spec | §8.1–§8.3; FR-8.5, FR-8.10; FR-7.5/7.6 |
| Depends on | D6-CTRL-02, D5-CTRL-01, D5-SDK-01 |
| Unblocks | Tilt Maze Race, Steering Wheel Racer, Sword Swing Duel |
| Deliverables | `packages/controller/src/controls/gyro.ts` (completed), `test/gyroControl.test.ts` |

**Behavior**

- A `gyro` control (or `sensors.gyro`) shows:
  - Motion state (off/on/denied/insecure),
  - An "Enable motion" button when off,
  - A "Recalibrate" button when on,
  - Sensitivity/smoothing values from the layout (read-only; games configure them).
- When active, the control contributes `gx/gy/gz` via `InputStore.setGyro` and sets the motion-active flag.
- When inactive, it contributes zeros and does not block the layout. The fallback controls (stick/dpad/buttons) are normal controls declared in the same layout.
- The validator requires at least one non-gyro directional/button control in a layout with a gyro control (D5-SDK-01); the renderer also warns if missing.
- No full-screen overlay that hides the fallback.
- The layout may use `sensors.gyro: "steer"|"aim"|"tilt"` without a visible gyro control; in that case show a small motion status strip and the enable button, not a large control. The strip must not intercept touches outside its bounds.

**Steps**

- [ ] Complete the gyro renderer using `MotionSource`; wire to the input store and flags.
- [ ] Add enable/recalibrate buttons with accessible labels and 44 px targets.
- [ ] Render the motion status strip for `sensors.gyro` layouts.
- [ ] Stop the source on layout swap/visibility hidden.
- [ ] Add tests: inactive contributes zeros; active contributes samples; flag bit 0; recenter bit.
- [ ] Add a manual test: Tilt Maze layout with a stick fallback; disable motion and play with the stick.
- [ ] Record the fallback behavior in `docs/RESULTS.md`.

**Acceptance**

- [ ] Gyro active → Input gyro fields update at 60 Hz with flags.
- [ ] Motion denied/insecure → zeros and the fallback remains fully playable.
- [ ] Recalibrate resets the bias/angle and flags one packet.
- [ ] No layout with gyro can be validated without a fallback.
- [ ] The status strip does not steal touches.

**Tests (tagged)**

- `[FR-8.5] gyro control uses layout sensitivity/smoothing`
- `[FR-8.10] every gyro layout has a playable non-gyro fallback`
- `[FR-7.6] motion active flag matches the sensor state`
- `[AR-3] motion UI is not required for gameplay`
- `[AR-5] enable/recalibrate controls meet 44px`

**Anti-rework**

- The gyro control is the only place motion UI lives; games declare it in layouts.
- Fallback controls are ordinary controls; do not add a separate "fallback mode" screen.

**Risks**

- A game could declare a token fallback that is unusable; the validator only checks presence. Game acceptance tests must play the fallback path.
- `sensors.gyro` without a visible control can confuse players; the status strip must be obvious.

---

### D6-CTRL-04 — Haptics: receive, coalesce, vibrate/visual fallback, global toggle

| Field | Value |
|---|---|
| Layer | Controller |
| Spec | §8.4; FR-8.11, FR-8.12; AR-3; E8 |
| Depends on | D0-PROTO-02, D5-CTRL-01 |
| Unblocks | Sumo Bumpers full, Sword Swing Duel, any haptic game |
| Deliverables | `packages/controller/src/haptics/HapticPlayer.ts`, `src/haptics/toggle.ts`, `test/hapticPlayer.test.ts` |

**Behavior**

- On binary `Haptic` (0x84): `n` durations (1–8), alternating vibrate/pause starting with vibrate.
- Coalesce at 20 Hz per slot:
  - If a pattern arrives while another is playing, keep the stronger/longer remaining pattern or merge; do not call `navigator.vibrate` more than 20 times/s.
  - A new pattern cancels the previous one (the platform does that anyway); the player tracks the active end time.
- `navigator.vibrate` feature-detect:
  - Android Chrome/Firefox → vibrate; a `false` return is non-fatal.
  - Unsupported (iOS Safari, desktop) → visual pulse on the phone border (opacity/transform, 120 ms) and optional short Web Audio click if the audio context is unlocked.
- Global toggle:
  - `localStorage["lanpad.haptics"]` default `"on"`.
  - Toggling off calls `navigator.vibrate(0)`, suppresses future patterns, and shows the toggle state.
  - The toggle must be reachable from the controller UI (settings sheet or debug overlay); per-game layouts do not need to declare it (AR-3).
- Rate limit 20 Hz; log a drop counter when coalescing.
- Haptics never gate input or game logic; a game must remain playable with the toggle off.
- Patterns are not stored; no analytics.

**Steps**

- [ ] Implement `HapticPlayer` with an injectable vibrate function and clock; test coalescing and 20 Hz.
- [ ] Implement the visual pulse fallback and optional audio click.
- [ ] Implement the toggle with localStorage and a UI entry point (long-press/triple-tap or settings).
- [ ] Add tests: pattern decode, max 8, coalescing, toggle off, unsupported vibrate.
- [ ] Run E8 on at least two Android phones; record pattern feel and rate.
- [ ] Add a manual test: turn haptics off mid-game; no vibration and gameplay unaffected.

**Acceptance**

- [ ] Patterns vibrate/pause in the specified order.
- [ ] At 20 Hz, calls are coalesced and do not stutter into one long buzz.
- [ ] Unsupported platforms show a visual pulse instead, with no error.
- [ ] The toggle persists and stops current vibration.
- [ ] No game depends on haptics for input.

**Tests (tagged)**

- `[FR-8.11] haptics are rate-limited to 20 Hz and coalesced`
- `[FR-8.12] global haptics toggle suppresses patterns`
- `[AR-3] haptics are optional and toggleable`
- `[E8] patterns remain distinct at 20 Hz`
- `[SR-7] haptic patterns are not stored`

**Anti-rework**

- `HapticPlayer` is the only vibration path; games call the host API, never `navigator.vibrate`.
- The visual fallback is shared with any future feedback channel.

**Risks**

- `navigator.vibrate` calls cancel each other; coalescing must replace, not queue, to avoid a single long buzz.
- Vibration strength is not controllable via the API; patterns are the only design lever.

---

### D6-SRV-01 — Haptic command routing and rate limits

| Field | Value |
|---|---|
| Layer | Server (broker) |
| Spec | §7.1, §7.8; FR-8.11; A1 |
| Depends on | D0-PROTO-02, D4-SRV-02 |
| Unblocks | D6-CTRL-04, D7 games, Sumo/Sword haptics |
| Deliverables | `packages/broker/src/room/haptics.ts`, `test/hapticRouting.test.ts` |

**Behavior**

- Host sends binary `HapticCmd` (0xA2): `slot` (1–8, or 0 = all), `n` (1–8), durations.
- Broker validates:
  - Host role only.
  - Slot exists/active (or 0 = all connected controllers).
  - `n` 1–8, durations 0–65535.
  - Per-slot rate limit 20 Hz; excess commands are coalesced/dropped with a counter.
- Broker forwards `Haptic` (0x84) to the target controller(s), with the same durations.
- The broker never stores patterns; no logs of pattern content.
- If a controller is reserved (no peer), drop and count.
- Host-side API in D6-RT-01 sends these frames.

**Steps**

- [ ] Implement `routeHaptic(host, slot, durations)` with a 20 Hz token bucket per slot.
- [ ] Implement `slot 0 = all` fan-out (only to connected peers).
- [ ] Validate binary frame length/values via protocol decode (already in D0).
- [ ] Add tests: valid route, invalid slot, over-rate, reserved slot, all-slot fan-out.
- [ ] Add a debug counter exposed in stats (haptic drops).
- [ ] Ensure no pattern content is logged.

**Acceptance**

- [ ] A host haptic for slot 2 reaches only slot 2.
- [ ] Slot 0 reaches all connected controllers.
- [ ] More than 20 commands/s per slot are coalesced/dropped.
- [ ] Reserved/absent slots are skipped without error.
- [ ] No haptic body is stored or logged.

**Tests (tagged)**

- `[FR-8.11] broker enforces 20 Hz per slot`
- `[FR-7.9] broker never interprets haptic content beyond routing`
- `[SR-12] haptic patterns are never persisted`
- `[FR-8.12] haptics toggle is controller-side and unaffected by routing`

**Anti-rework**

- Haptic routing is the only binary host→controller command path; reuse the rate-limit utility from D5.
- Slot 0 fan-out is useful for global effects; keep the semantic stable.

**Risks**

- Binary `HapticCmd` slot 0 is an extension of the spec's "slot" field; document it in the protocol comment (all = 0).
- Rate limiting on both host and controller prevents bursty multiple sends; double limiting is intentional.

---

### D6-RT-01 — Gyro state in ControllerState, host tilt integration and haptic API

| Field | Value |
|---|---|
| Layer | Host runtime |
| Spec | §7.1, §8.3; FR-7.5, FR-8.5, FR-8.11; D6 contract 5 |
| Depends on | D2-RT-01, D6-SRV-01, D3-SDK-01 |
| Unblocks | Tilt Maze Race, Steering Wheel Racer |
| Deliverables | `packages/runtime/src/input/TiltIntegrator.ts`, `src/game/HapticApi.ts`, `test/tiltIntegrator.test.ts`, `test/hapticApi.test.ts` |

**Behavior**

- `InputMapper` already stores `gyro` per slot. Extend `ControllerState` with `gyroActive` and `gyroRecentered` booleans derived from flags (additive, no socket).
- `TiltIntegrator` per slot:
  - `angleX += gx / 10 * dt` (degrees), `angleY += gy / 10 * dt`; clamp ±30°.
  - Apply a small drift correction toward 0 when the rate is near zero (e.g., 0.5°/s).
  - On `gyroRecentered`, reset angles to 0.
  - On motion inactive, decay angles toward 0 and mark unavailable.
  - Expose `{angleX, angleY, available}` for games; Tilt Maze uses it as acceleration/tilt.
- `HapticApi.pulse(slot|"all", durations)`:
  - Validate 1–8 durations, u16.
  - Encode `HapticCmd` (slot 0 for all) and send via `HostClient`.
  - Rate-limit at 20 Hz per slot on the host too (coalesce), so a game cannot flood the socket.
  - No-op if the global controller toggle is off? The host does not know the controller toggle; the controller suppresses. The host may still send; bandwidth is tiny.
- Debug overlay: show gyro active, angle, last haptic.

**Steps**

- [ ] Add `gyroActive`/`gyroRecentered` to `ControllerState` (additive) and map flags in `InputMapper`.
- [ ] Implement `TiltIntegrator` with fixed-step tests: constant rate → expected angle; clamp; recenter; inactive decay.
- [ ] Implement `HapticApi` with validation and a 20 Hz host-side limiter.
- [ ] Wire `ctx.haptics` and `ctx.input` into `GameContext`.
- [ ] Add tests for haptic frame encoding (slot/all, n≤8) and rate limiting.
- [ ] Add a demo page showing tilt angles from a phone; record it.
- [ ] Document that the controller never integrates angles; the host does per game.

**Acceptance**

- [ ] Constant 100 dps for 0.1 s yields ~10° before clamping.
- [ ] Recenter resets angle to 0 on the next tick.
- [ ] Inactive motion decays to 0 and reports unavailable.
- [ ] Haptic pulses encode correctly and are limited to 20 Hz.
- [ ] Games receive angles, not raw sensor objects.

**Tests (tagged)**

- `[FR-7.5] host consumes dps x10 gyro values`
- `[FR-7.6] motion/recenter flags reach ControllerState`
- `[FR-8.5] smoothing and sensitivity affect the integrated angle`
- `[FR-8.11] host haptic API rate-limits to 20 Hz`
- `[FR-7.17] games receive tilt angles and a haptic API, not sockets`

**Anti-rework**

- Tilt integration is host-side and game-agnostic; Tilt Maze and Steering Racer can share it.
- Haptic API is the only host vibration path; games never see `HapticCmd`.
- Adding booleans to `ControllerState` is additive; do not change existing fields.

**Risks**

- Integration drift accumulates; recenter and decay are required, not optional.
- A 30° clamp may be too small for some games; make it a per-game config with a sane default.

---

### D6-EXP-01 — E7 Android gyro, E8 vibration and swing feasibility

| Field | Value |
|---|---|
| Layer | Experiments/docs |
| Spec | §20 E7/E8; §14 D6 (amended); A5 |
| Depends on | D6-CTRL-02, D6-CTRL-04, D6-DOC-01 |
| Unblocks | Tilt Maze Race, Sword Swing Duel decision, Gate |
| Deliverables | `experiments/e07/index.html`, `experiments/e08/index.html`, `experiments/e07-swing/index.html`, `docs/RESULTS.md` rows |

**E7 — rotationRate reality (Android only)**

- Log raw `rotationRate` values, units, signs and axis mapping for portrait/landscape on Chrome Android.
- Test secure context: HTTPS tunnel vs LAN HTTP; permission behavior (Android should need no `requestPermission`; verify).
- Measure drift over 60 s stationary and after recalibration.
- Pass: stable, remappable rates on Android. If not: document the fallback and restrict gyro games.
- iOS leg explicitly `deferred — A5`.

**E8 — vibration feel**

- Test patterns at 10/20 Hz on at least two Android phones: 10 ms, 20 ms, [10,30], [20,40], long patterns.
- Record whether 20 Hz is distinct or stutters; if it stutters, lower the rate and simplify.
- Pass: distinct, non-stuttering patterns at 20 Hz.

**Swing feasibility (auxiliary, no E number)**

- Log `rotationRate` magnitude while performing left/right/overhead swings with a phone.
- Classify by peak magnitude and axis; measure false positives/negatives over 30 swings.
- Record a yes/no for Sword Swing Duel's minimal; if unreliable, require buttons for all moves or defer the game.

**Steps**

- [ ] Build E7 with a live table and CSV copy; run on Android over HTTPS and HTTP.
- [ ] Build E8 with a pattern player and a feel checklist; run on two phones.
- [ ] Build the swing logger; run 30 swings per direction; record classification accuracy.
- [ ] Record all rows with device/browser/date; mark iOS deferred.
- [ ] Update `docs/BUDGETS.md` if sensor rates affect latency expectations.
- [ ] Make a written go/no-go for gyro games based on E7.

**Acceptance**

- [ ] E7 Android result recorded; secure-context behavior confirmed.
- [ ] E8 result recorded; rate adjusted if needed.
- [ ] Swing feasibility note written with accuracy numbers.
- [ ] iOS explicitly marked deferred, not failed.
- [ ] If E7 fails, gyro games are restricted and the fallback path is the primary.

**Tests (tagged)**

- `[E7] rotationRate units and axis mapping are recorded on Android`
- `[E7] gyro requires a secure context on Android Chrome`
- `[E8] vibration patterns are distinct at 20 Hz`
- `[FR-8.10] gyro games retain a playable fallback`
- `[A5] iOS E7/E8 legs are deferred`
- `[C6] gyro capability is proven before Tilt Maze`

**Anti-rework**

- E7's final remap/sign table is copied into D6-CTRL-02's mapping; keep one source.
- E8's rate decision updates FR-8.11's implementation and the haptic player.
- Swing feasibility gates Sword Swing Duel; do not schedule it before a positive result.

**Risks**

- Phone model differences in sensor fusion; test at least two Android devices if available.
- HTTPS tunnels add latency but are only for sensor tests; do not measure E5 over a tunnel.

---

### D6-DOC-01 — Secure-context test procedure and iOS deferral note

| Field | Value |
|---|---|
| Layer | Docs/experiments |
| Spec | §4.4, §20 E7; A5 |
| Depends on | D0-SRV-01 |
| Unblocks | D6-EXP-01, future sensor work |
| Deliverables | `docs/SENSOR-TESTING.md` |

**Contents**

- Why gyro needs HTTPS (secure context) and which dev workarounds exist:
  1. `cloudflared tunnel --url http://localhost:8080` (no account) or `ngrok http 8080`; use the HTTPS URL on the phone. Latency is higher; use only for sensor tests.
  2. Android Chrome `chrome://flags/#unsafely-treat-insecure-origin-as-secure` with the LAN URL; restart; record that the flag was used.
  3. `mkcert` + install the root CA on the phone (fiddly; optional).
- Step-by-step: start dev server, start tunnel, open `/c/CODE` on the phone, enable motion, verify data in `/x/e07`.
- The tunnel URL is HTTPS and therefore a different origin than the LAN dev server; the dev server's WS origin allowlist must include it for the tunnel test, or serve the controller page through the tunnel and connect WSS to the tunnel origin. Document the exact setup used.
- Security: do not leave a tunnel running; no tokens in logs; tunnel only on a trusted network.
- iOS note: deferred per A5; the code path exists (`requestPermission`), but no acceptance test is scheduled. If iOS is added later, run E7/E8 iOS legs and add the device to the matrix.

**Steps**

- [ ] Write the procedure with exact commands and expected outputs.
- [ ] Verify the tunnel setup works for the dev server's origin allowlist; document any config needed.
- [ ] Add a troubleshooting table: no data, permission denied, insecure context, wrong axis.
- [ ] Add the iOS deferral note and what would be required to enable it.
- [ ] Link the doc from D6-EXP-01 and `docs/DEVICE-MATRIX.md`.

**Acceptance**

- [ ] Another person can run the sensor test from the doc.
- [ ] The doc states the security caveats of tunnels and flags.
- [ ] iOS is explicitly deferred, with the future work listed.

**Tests (tagged)**

- `[E7] sensor testing procedure uses a secure context`
- `[SR-3] tunnel usage is documented as dev-only and temporary`
- `[A5] iOS sensor testing is explicitly deferred`

**Anti-rework**

- The procedure is reused for any future sensor work (absolute orientation, magnetometer).
- Keep the tunnel out of production code; no config flag for it.

**Risks**

- Tunnel providers change commands/limits; record versions and alternatives.
- Chrome flags can invalidate the test's realism; always record whether a flag was used.

---

### D6-QA-01 — Android device matrix, fallback and haptics acceptance

| Field | Value |
|---|---|
| Layer | QA |
| Spec | §12, §16; §14 D6; FR-8.10–8.12; AR-3 |
| Depends on | D6-CTRL-01..04, D6-SRV-01, D6-RT-01, D6-EXP-01 |
| Unblocks | D7 entry (Tilt Maze) |
| Deliverables | `docs/RESULTS.md` D6 row; `docs/DEVICE-MATRIX.md` updates |

**Scenarios**

- [ ] Gyro enabled over HTTPS: tilt values change, 60 Hz, flags set.
- [ ] Gyro denied: fallback controls play Tilt Maze's demo; no dead end.
- [ ] Insecure LAN HTTP: explained, fallback playable.
- [ ] No motion data after enable: 1 s timeout, fallback, message.
- [ ] Recalibrate while moving: angle resets without a jump in the opposite direction.
- [ ] Layout swap from gyro to buttons: sensor listener stops.
- [ ] Background/foreground: sensor stops on hidden, resumes on visible with the permission state recorded.
- [ ] Haptics on: patterns distinct; toggle off: no vibration, visual fallback.
- [ ] Haptics unsupported (desktop): visual pulse, no error.
- [ ] No game requires haptics: play with the toggle off.

**Steps**

- [ ] Run each scenario on at least one Android phone; record device/browser/OS.
- [ ] Update `docs/DEVICE-MATRIX.md` gyro/vibration columns.
- [ ] Record the E8 pattern table and E7 mapping in `docs/RESULTS.md`.
- [ ] File any deviations as work items.
- [ ] Confirm the fallback path is the primary path for a gyro-less player.

**Acceptance**

- [ ] All scenarios pass or have accepted deviations.
- [ ] Fallback gameplay is fully usable.
- [ ] Haptics toggle works and persists.
- [ ] Sensor listener cleanup verified (no leaks).
- [ ] Results recorded.

**Tests (tagged)**

- `[FR-8.10] gyro fallback is playable when motion is denied`
- `[FR-8.11] haptic rate and coalescing work on real devices`
- `[FR-8.12] haptic toggle persists across reloads`
- `[AR-3] no gameplay depends on haptics`
- `[A5] iOS is not part of the acceptance matrix`

**Anti-rework**

- This matrix is reused by P5 beta and every later gyro game.
- Fallback playability is a game acceptance criterion, not a platform checkbox.

**Risks**

- OEM sensor behavior varies; record the model and OS build.
- Android browsers may stop sensors when the screen locks; D4 suspend/resume handles it, but test the transition.

---

## Stage exit checklist

- [ ] D6-CTRL-01..04, D6-SRV-01, D6-RT-01, D6-EXP-01, D6-DOC-01, D6-QA-01 complete.
- [ ] Android gyro works over HTTPS with stable, remapped rates.
- [ ] Denied/unavailable motion leaves a playable fallback.
- [ ] Haptics work at 20 Hz with a global toggle and visual fallback.
- [ ] E7 (Android), E8 and swing feasibility recorded; iOS deferred (A5).
- [ ] No game requires gyro or haptics.
- [ ] `docs/RESULTS.md` D6 row complete.

## Handoff to D7

- Tilt Maze Race uses `TiltIntegrator` and the gyro control; its acceptance includes the no-gyro fallback.
- Sumo Bumpers may use haptics in its full version; the minimal version does not.
- Sword Swing Duel is scheduled only if the swing feasibility note is positive; otherwise it stays ambitious/deferred.
- No D7 game may add its own sensor permission or vibration code.

## Explicitly not in D6

- iOS acceptance testing (A5).
- Proof games (D7).
- Production HTTPS/relay (P1/P2); tunnels are dev-only.
- Absolute orientation (`deviceorientation`) beyond the rate-based design.
