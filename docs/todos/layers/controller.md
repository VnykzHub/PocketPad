# Layer: Controller

**Package:** `packages/controller`.
**Owns:** layout rendering, touch capture/hit-testing, input encoding/send policy, join/session/reconnect UX, sensors, haptics, connection pill, debug overlay.
**Must not own:** game rules, server/room logic, host rendering.
**Goal contribution:** G1 (join), G2 (same-frame input/send), G3 (60 KB budget), G5 (multi-touch/gyro/haptics/private screens), G7 (lean dependency/size discipline), G8 (layout/event contract consumed by the SDK).

## Invariants

1. DOM + `transform`/`opacity` only; no layout-triggering writes in touch handlers; ≤ 2 ms per event (FR-8.3).
2. Touch targets ≥ 44×44 CSS px; 10 simultaneous touches; pressed state same frame (AR-5, FR-8.6/8.7).
3. Controls emit state/events; the socket module is the only network owner.
4. Layouts are data; the control registry is the only place types are created.
5. No game-specific UI; games ship layouts.
6. Sensor data only travels in Input packets; no storage/analytics.
7. Haptics are optional, toggleable, coalesced at 20 Hz; no game requires them (AR-3, FR-8.11/8.12).
8. **iOS is not a v1 acceptance target (A5).** Keep feature detection (`DeviceMotionEvent.requestPermission`) harmless; no iOS testing is scheduled. Every gyro layout keeps a playable fallback.
9. Wake Lock is best-effort; never blocks input.

## Todo index

| ID | Title | Stage | File |
|---|---|---|---|
| D0-CTRL-01 | Controller shell/join/test button | D0 | `phase-1-dev/D0-foundations.md` |
| D2-CTRL-01 | Touch engine/hit-test/10 touches | D2 | `phase-1-dev/D2-controller-v0.md` |
| D2-CTRL-02 | Button/d-pad/stick + same-frame | D2 | `phase-1-dev/D2-controller-v0.md` |
| D2-CTRL-03 | InputStore/edges/send policy/clock | D2 | `phase-1-dev/D2-controller-v0.md` |
| D2-CTRL-04 | Client integration/connection pill | D2 | `phase-1-dev/D2-controller-v0.md` |
| D4-CTRL-01 | QR/manual join/session storage | D4 | `phase-1-dev/D4-pairing-sessions.md` |
| D4-CTRL-02 | Reconnect/heartbeat/suspend/wake lock | D4 | `phase-1-dev/D4-pairing-sessions.md` |
| D5-CTRL-01 | Remaining control types | D5 | `phase-1-dev/D5-layouts-events.md` |
| D5-CTRL-02 | Layout hot-swap | D5 | `phase-1-dev/D5-layouts-events.md` |
| D5-CTRL-03 | Text input/keyboard viewport | D5 | `phase-1-dev/D5-layouts-events.md` |
| D5-CTRL-04 | Canvas stroke batching | D5 | `phase-1-dev/D5-layouts-events.md` |
| D5-CTRL-05 | Event queue/rate/coalesce | D5 | `phase-1-dev/D5-layouts-events.md` |
| D6-CTRL-01 | Motion enable/secure context | D6 | `phase-1-dev/D6-sensors-haptics.md` |
| D6-CTRL-02 | rotationRate/remap/smoothing/calibration | D6 | `phase-1-dev/D6-sensors-haptics.md` |
| D6-CTRL-03 | Gyro binding/fallback | D6 | `phase-1-dev/D6-sensors-haptics.md` |
| D6-CTRL-04 | Haptics/coalesce/toggle/fallback | D6 | `phase-1-dev/D6-sensors-haptics.md` |

## Requirement coverage

| Requirement | Where |
|---|---|
| FR-5.1, 5.4–5.6 | D4-CTRL-01/02 |
| FR-7.1, 7.3–7.6 | D2-CTRL-03, D6-CTRL-02 |
| FR-8.1–8.12 | D2/D5/D6 controller items |
| AR-3, AR-5 | D6-CTRL-04, D2-CTRL-01/02 |
| NR-6.3 | D2-PERF-01 + size gate |
| A5 (iOS) | README §2.3, D6-CTRL-01, D6-DOC-01 |

## Verification

- Logic tests with fake touch lists/clocks; real-device manual checks for touch feel, 10 touches, keyboard, gyro, vibration.
- Controller gz ≤ 60 KB (target 40/50); script p95 ≤ 2 ms.
- E7/E8 on Android; E16 keyboard; E10 stroke bandwidth.
- Trace checker covers the requirements above.

## Change rules

- A new control type goes in the registry + SDK schema; no per-game DOM.
- Never block the UI on the network; pressed state is local and immediate.
- Never put a socket or game rule in a control.
- iOS code paths must remain feature-detected and non-blocking even though untested.
