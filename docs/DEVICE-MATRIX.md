# Device matrix (D1-QA-01)

> Manual checklist per SPEC §12, reused by every later stage (D4 join/reconnect,
> D5 layouts, D6 sensors/haptics, P5 beta). One row per actual device, with
> stable IDs from `docs/DEVICES.md`. **Append results; never overwrite a past
> check.** A blank or `NOT TESTED` cell is not a pass.
>
> iOS is **deferred (amendment A5)** and is not scheduled. Every §12 row
> appears below even when the device is unavailable.
>
> Linked from the Gate checklist (`docs/todos/phase-1-dev/GATE-dev-exit.md`,
> Gate inputs and `GATE-QA-02`). Results live in `docs/RESULTS.md`.

## Legend

| Value | Meaning |
|---|---|
| `PASS` | The check met its stated criterion on this device; evidence is in `docs/RESULTS.md`. |
| `FAIL` | The check ran and missed the criterion; the decision is written before the next stage. |
| `RECORDED` | A number was captured but the row is not a pass/fail gate (e.g. E2 safe mode). |
| `PENDING` | The check is scheduled but has not been performed. |
| `NOT TESTED` | No run exists; do not read this as a pass. |
| `N/A` | The check does not apply to this device role. |
| `DEFERRED` | Intentionally out of v1 scope (iOS, A5). |

## Matrix

| Device ID | Platform | Role | Stage checked | E1 | E2 | E3 | Controller join | Gyro | Vibration | Join < 5 s | Reconnect | AP/client isolation | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `pc-win11-rtx3050` | Chrome desktop (Windows 11) | Host / TV fallback | D1 | **PASS** (desktop) | **RECORDED** (safe-mode cap; full run PENDING) | **PASS** (desktop) | N/A (host) | N/A | N/A | N/A (host) | N/A (host) | N/A (host) | D1 run 2026-10-21: WebGL2 yes, maxTex 16384, binary WS yes, E3 120.00 fps at 720p/1k. No TV measured. |
| `android-phone-d0qa02` | Chrome Android | Controller | D0 | NOT TESTED | NOT TESTED | NOT TESTED | **PASS** (D0-QA-02, press/release) | NOT TESTED (D6) | NOT TESTED (D6) | Observed instant, **not stopwatch-timed** | NOT TESTED (D4) | Phone→PC reachability works (D0-QA-02) | Exact Android/Chrome versions not recorded. D1 capability probe not run. |
| `android-tablet-d0qa02` | Chrome Android | Controller | D0 | NOT TESTED | NOT TESTED | NOT TESTED | **PASS** (D0-QA-02, press/release) | NOT TESTED (D6) | NOT TESTED (D6) | Observed instant, **not stopwatch-timed** | NOT TESTED (D4) | Phone→PC reachability works (D0-QA-02) | Exact Android/Chrome versions not recorded. D1 capability probe not run. |
| `android-tv-tbd` | Android TV (Chromium) | TV / host | — | NOT TESTED | NOT TESTED | NOT TESTED | N/A | N/A | N/A | N/A | NOT TESTED | NOT TESTED | **Device unavailable.** This is the row the D1 exit criterion requires. Do not create a real ID until a TV exists. |
| `tizen-tv-tbd` | Tizen | TV / host | — | NOT TESTED | NOT TESTED | NOT TESTED | N/A | N/A | N/A | N/A | NOT TESTED | NOT TESTED | **Device unavailable.** Chromium version varies by TV year. |
| `webos-tv-tbd` | webOS | TV / host | — | NOT TESTED | NOT TESTED | NOT TESTED | N/A | N/A | N/A | N/A | NOT TESTED | NOT TESTED | **Device unavailable.** Weak-GPU / dynamic-resolution row. |
| `safari-ios-17` | Safari iOS 17+ | Controller | — | DEFERRED (A5) | DEFERRED (A5) | DEFERRED (A5) | DEFERRED (A5) | DEFERRED (A5) | DEFERRED (A5) | DEFERRED (A5) | DEFERRED (A5) | DEFERRED (A5) | Out of v1 acceptance. Feature detection stays; see `docs/todos/README.md` §2.3. |
| `firefox-desktop-tbd` | Firefox desktop | Host / fallback | — | NOT TESTED | NOT TESTED | NOT TESTED | N/A | N/A | N/A | N/A | N/A | NOT TESTED | Browser availability/version on this PC was not recorded; binary WS not verified. |

## Stage check log

Append one line per performed check. This is the audit trail the Gate reads;
the matrix cells above are the current summary.

| Date | Stage | Device ID | Checks performed | Result | Recorded in |
|---|---|---|---|---|---|
| 2026-10-21 | D0 | `android-phone-d0qa02` | Join, Test press/release, disconnect behavior | PASS | `docs/RESULTS.md` §D0-QA-02 |
| 2026-10-21 | D0 | `android-tablet-d0qa02` | Join, Test press/release, disconnect behavior | PASS | `docs/RESULTS.md` §D0-QA-02 |
| 2026-10-21 | D1 | `pc-win11-rtx3050` | E1 all checks; E2 safe mode; E3 all scenes/resolutions | E1 PASS; E2 RECORDED (cap); E3 PASS | `docs/RESULTS.md` §D1 |
| — | D1 | — | E14 mixed content over an HTTPS tunnel | **PENDING** (no tunnel, 0 attempts) | `docs/RESULTS.md` §D1 |
| — | D1 | any real TV | E1, E2, E3 | **PENDING** (no TV available) | — |

## How later stages use this

- D4: fill `Controller join`, `Join < 5 s` and `Reconnect` for each real phone;
  append to the check log, do not create a second checklist.
- D5: add layout/panel evidence in the notes or the check log; keep columns stable.
- D6: follow `docs/SENSOR-TESTING.md` (secure-context tunnel, E7 steps) before
  filling `Gyro` and `Vibration` for Android devices; iOS stays deferred.
- P5: repeat the same rows on the production build and record the build SHA.
- Any `NOT TESTED` or `PENDING` cell stays explicit so the Gate cannot read it
  as a pass. The Gate's `GATE-QA-02` requires tested / not-tested / deferred to
  be marked, not inferred.
- AP/client isolation is the SPEC §19 caveat; toggle isolation at the router
  when the TV runs happen and record the result in the `AP/client isolation`
  column.
