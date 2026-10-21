# Results Template (D1)

> **Every value in this file is a synthetic placeholder.** No row here is a
> measurement. Do not copy a row into `docs/RESULTS.md` until a person has run
> the probe on that device and replaced the device ID, date, OS, browser,
> conditions and every number with the observed values.
>
> Rules: one row per run, append-only (never overwrite a past measurement), and
> every row names a device that exists in `docs/DEVICES.md`. Record the exact
> browser version from the probe page, not from the TV model. See
> `docs/todos/phase-1-dev/D1-device-probes.md`, SPEC §20 and SPEC §12.

## Row format

All D1 experiments use the same nine columns:

| Experiment | Date | Device | OS | Browser | Conditions | Measurement | Verdict | Notes |
|---|---|---|---|---|---|---|---|---|
| E1 | 2026-10-21 | tv-synthetic-2020 | Android TV 10 (synthetic) | Chromium 92 (synthetic) | 1080p, Game Mode off | WebGL2 yes; maxTex 8192; extensions ASTC, ETC2; Web Audio running; binary WS pass, RTT 4 ms; WebRTC yes; rAF 60 Hz; Wake Lock yes; deviceMemory 2 GB; hardwareConcurrency 4; screen 1920x1080 DPR 1 | PASS | Synthetic placeholder. E1 passes only when WebGL2 **and** binary WebSocket are present. |

## E2 - memory ceiling

Report the last stable step, never the crash point. Budgets are set at 70% of
the stable limit (PR-11.2).

A **safe-mode** run stops each phase at 512 MB by design. That 512 MB is the
enforced cap, **not** a stability ceiling: mark the row
`RECORDED (safe-mode cap)`, never `PASS`, and do not apply the 70% rule to it.
Keep the full run `PENDING` with the exact command and URL until it is
performed on the target device.

| Experiment | Date | Device | OS | Browser | Conditions | Measurement | Verdict | Notes |
|---|---|---|---|---|---|---|---|---|
| E2 | 2026-10-21 | tv-synthetic-2020 | Android TV 10 (synthetic) | Chromium 92 (synthetic) | 1080p, Game Mode off, safe mode off | stable JS 300 MB; stable texture 128 MB; total 428 MB; failure allocation throw; baseline frame 8.3 ms | RECORDED | Synthetic placeholder. 70% budget: JS 210 MB, texture 89 MB. |
| E2 | 2026-10-21 | tv-synthetic-2020 | Android TV 10 (synthetic) | Chromium 92 (synthetic) | 1080p, Game Mode on, safe mode off | stable JS 300 MB; stable texture 128 MB; total 428 MB; failure allocation throw; baseline frame 7.9 ms | RECORDED | Synthetic placeholder; Game Mode changes pacing, not the ceiling. |

## E3 - render benchmark

One row per scene/resolution combination. The 720p 1k-instance row decides the
`>= 30 fps` pass criterion; the other rows record the envelope. Include p50 and
p95 frame time, FPS, draw calls and the GPU-memory estimate.

| Experiment | Date | Device | OS | Browser | Conditions | Measurement | Verdict | Notes |
|---|---|---|---|---|---|---|---|---|
| E3 | 2026-10-21 | tv-synthetic-2020 | Android TV 10 (synthetic) | Chromium 92 (synthetic) | 1280x720, Game Mode off, scene 1: 1,000 instanced quads | p50 4.2 ms; p95 6.1 ms; 238 fps; 1 draw call; GPU mem est. 12 MB | PASS | Synthetic placeholder; criterion is >= 30 fps at 720p with 1k+ instances. |
| E3 | 2026-10-21 | tv-synthetic-2020 | Android TV 10 (synthetic) | Chromium 92 (synthetic) | 1280x720, Game Mode off, scene 3: 10,000 instanced quads | p50 7.8 ms; p95 11.4 ms; 128 fps; 1 draw call; GPU mem est. 26 MB | RECORDED | Synthetic placeholder. |
| E3 | 2026-10-21 | tv-synthetic-2020 | Android TV 10 (synthetic) | Chromium 92 (synthetic) | 1280x720, Game Mode off, scene 4: 1,000,000-triangle static mesh | p50 8.9 ms; p95 13.2 ms; 112 fps; 1 draw call; GPU mem est. 34 MB | RECORDED | Synthetic placeholder. |
| E3 | 2026-10-21 | tv-synthetic-2020 | Android TV 10 (synthetic) | Chromium 92 (synthetic) | 1920x1080, Game Mode off, scene 1: 1,000 instanced quads | p50 6.4 ms; p95 9.1 ms; 156 fps; 1 draw call; GPU mem est. 20 MB | RECORDED | Synthetic placeholder. |
| E3 | 2026-10-21 | tv-synthetic-2020 | Android TV 10 (synthetic) | Chromium 92 (synthetic) | 1280x720, Game Mode on, scene 1: 1,000 instanced quads | p50 4.0 ms; p95 5.8 ms; 250 fps; 1 draw call; GPU mem est. 12 MB | RECORDED | Synthetic placeholder; record Game Mode on/off separately. |

Repeat for scene 2 (5,000 quads) and scene 5 (2048x2048 atlas) at both
resolutions; omit a scene only when the browser cannot run it, and record why.

## E14 - mixed content and private-network reachability

One row per browser. Run from the HTTPS tunnel URL and record each attempt
separately. `192.0.2.10` is a documentation address, not a real host.

If no tunnel was installed or no attempt button was pressed, the row is
`PENDING` with the exact tunnel command and page URL. An HTTP-page load or a
secure-context readout is not an E14 result and must never be marked
`CONFIRMED`.

| Experiment | Date | Device | OS | Browser | Conditions | Measurement | Verdict | Notes |
|---|---|---|---|---|---|---|---|---|
| E14 | 2026-10-21 | desktop-synthetic | Windows 11 (synthetic) | Chrome 120 (synthetic) | HTTPS tunnel page -> LAN `ws://192.0.2.10:8080/ws` | mixed-content block; console error "Mixed Content"; `ws://localhost:8080/ws` control allowed | CONFIRMED | Synthetic placeholder; record the exact console error. |
| E14 | 2026-10-21 | desktop-synthetic | Windows 11 (synthetic) | Chrome 120 (synthetic) | HTTPS tunnel page -> `fetch("http://192.0.2.10:8080/healthz")` | blocked by mixed content / private-network rules | CONFIRMED | Synthetic placeholder. |
| E14 | 2026-10-21 | phone-synthetic | Android 14 (synthetic) | Chrome 120 (synthetic) | HTTPS tunnel page -> LAN `ws://192.0.2.10:8080/ws` | blocked; localhost control allowed | CONFIRMED | Synthetic placeholder; iOS is out of v1 scope (A5). |

## Copy shapes

Use these empty shapes for a new run; fill every cell.

```md
| E1 | YYYY-MM-DD | device-id | OS + version | browser + version | resolution, Game Mode on/off | WebGL2 yes/no; maxTex; extensions; Web Audio state; binary WS pass/fail + RTT; WebRTC; rAF Hz; Wake Lock; deviceMemory; hardwareConcurrency; screen/DPR | PASS/FAIL | notes |
| E2 | YYYY-MM-DD | device-id | OS + version | browser + version | resolution, Game Mode on/off, safe mode on/off | stable JS MB; stable texture MB; total MB; failure mode; baseline frame ms | RECORDED | notes |
| E3 | YYYY-MM-DD | device-id | OS + version | browser + version | resolution, Game Mode on/off, scene and instance count | p50 ms; p95 ms; fps; draw calls; GPU mem est. MB | PASS/RECORDED | notes |
| E14 | YYYY-MM-DD | device-id | OS + version | browser + version | HTTPS tunnel URL; target URL and attempt | blocked/allowed per attempt; console error | CONFIRMED | notes |
```

## Verdicts

- `PASS` - the experiment's pass criterion in SPEC §20 was met.
- `FAIL` - the criterion was not met; write the fallback decision in
  `docs/RESULTS.md` or `docs/BUDGETS.md` before the next stage.
- `RECORDED` - a number was captured but the row is not a pass/fail gate
  (E2 and the non-criterion E3 scenes).
- `CONFIRMED` - the E14 expectation was observed.
- `PENDING` - not run yet. Never leave a row at `PENDING` in `docs/RESULTS.md`
  after that device's run.
