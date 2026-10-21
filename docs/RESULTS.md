# Results

> Measurements and acceptance runs. One row per run, recorded by hand. A row is
> **PENDING** until a person actually performs it. Field definitions and the
> no-secrets rule live in `docs/TESTING.md`.

## D0 — Foundations (2026-10-21)

Environment: Windows 11 Home Single Language (10.0.26300), Node v22.14.0,
npm 10.9.2. This section records automated runs only; no phone or TV was
involved.

### Automated gates

> Rows for typecheck, lint, test, trace and check were refreshed during the
> 2026-10-21 review-fix run. The remaining rows record the earlier D0
> implementation run.

| Command | Result | Evidence |
|---|---|---|
| `npm run typecheck` | PASS | `tsc -b` clean across all project references (review-fix run) |
| `npm run lint` | PASS | `eslint .` clean; 63 TypeScript files linted with the root `eslint.config.js` |
| `npm run test` | PASS | 22 test files, 232 tests. The dependency-boundary test lints against the real root `eslint.config.js` |
| `npm run build` | PASS | every workspace built; controller emits `/c/assets/index-*.js` and `/c/assets/index-*.css` with no inline style |
| `npm run size` | PASS | both targets `ok` (table below) |
| `npm run trace` | PASS | stage D0: 20/137 required IDs, 0 missing, 94 deferred, 0 unknown, 26 test files; generated report in `docs/TRACE-REPORT.md` |
| `npm run check` | PASS | typecheck, lint, 232 tests, build, size and stage-D0 trace all pass |

Entrypoint smoke (2026-10-21): `node packages/dev-server/dist/main.js` printed
the LAN banner and terminal QR; `GET /healthz` returned 200 with `rooms: 0` on
`127.0.0.1:8080`. The process was stopped after the check.

### D0-QA-02 automated two-client echo

- File: `packages/dev-server/test/e2e.test.ts` (the plan allows this location
  or `test/e2e/d0-echo.test.ts`).
- Command: `npm test -- --project packages/dev-server e2e`
- Result: **PASS**, 10/10 consecutive runs.
- What it proves: boots the real dev server, broker and WebSocket adapter on
  `127.0.0.1:0`; creates a room with `POST /api/rooms`; authenticates the host
  with `hostJoin`; joins two controllers that receive slots 1 and 2; a 40 ms
  A-button tap reaches the host as `InputFwd` for both slots with the press
  edge intact and the release with edges 0; slots 3–8 fill; the ninth
  controller receives `{ "t": "joinError", "reason": "roomFull" }`.
- Scope note: the harness proves forwarding within one event-loop turn. It is
  not a latency measurement; E5 owns latency (G2's p95 targets).

### D0 review fixes (2026-10-21)

Scope: controller assets/CSP, experiment placeholders, trace report and tracker.

| Command | Result | Evidence |
|---|---|---|
| `npm run build --workspace @lanpad/controller` | PASS | Vite base `/c/`, emptyOutDir false, emitted JS + CSS; no inline `<style>`; tsc output preserved |
| `npm test --workspace @lanpad/controller` | PASS | 17 tests; dev-server asset test 3 tests |
| `npm run build --workspace @lanpad/trace-check` | PASS | `tsc -b` and the test typecheck are clean |
| `npm test -- --project tools/trace-check` | PASS | 16 tests, 1 file (3 report-mode tests added) |
| `node tools/trace-check/dist/cli.js --stage D0 --report docs/TRACE-REPORT.md` | PASS (exit 0) | 20/137 required IDs, 0 missing, 94 deferred, 0 unknown; report lists each ID with status and test file paths |
| `npm ci && npm test` | PASS | clean install, 22 test files, 232 tests |
| `npm run typecheck`, `npm run build`, `npm run size`, `npm run trace` | PASS | all succeed after the clean install |
| `npm run lint` | PASS | `eslint .` clean; root `eslint.config.js` enforces the layer boundaries |

Controller fix details:

- `packages/controller/vite.config.ts` uses `base: "/c/"` and `emptyOutDir: false`.
- Inline CSS moved to `packages/controller/src/styles.css`, imported by `main.ts`.
- `packages/dev-server/test/controller-assets.test.ts` builds the controller,
  fetches `/c/ABCD`, extracts the script/stylesheet URLs and asserts each is
  served with 200 and the right content type.
- The built HTML has no `<style>` and links `/c/assets/index-*.css`.

Experiment placeholders:

- `experiments/index.html` and `experiments/e01/index.html` are self-contained:
  no scripts, no external assets and no network calls.
- Verified against the default dev-server static roots on an ephemeral loopback
  port: `GET /x/e01`, `/x/e01/`, `/x/` and `/x/index.html` each returned
  **200** with `Cache-Control: no-store` (not 404).

D0 automated gates are green and the manual D0-QA-02 run passed on 2026-10-21
(Android phone + Android tablet in Chrome). The dependency-boundary test
prefers the real root `eslint.config.js`; the test-only fixture remains only as
a fallback when that config is absent.

### Sizes (dev tier)

| Target | Files | Raw bytes | Gzip bytes | Budget (gz) | Status |
|---|---:|---:|---:|---:|---|
| controller | 1 | 14167 | 5067 | 40960 | ok |
| host | 1 | 15563 | 5680 | 3145728 | ok |

The controller is 5067 gz bytes, below both the 40 KB dev target and the
61440-byte (60 KB) hard cap. The host is 5680 gz bytes against its 3 MB dev
target.

### Manual acceptance — D0-QA-02

| Date | Stage / work item | Device | OS / browser | Method | Result | Verdict |
|---|---|---|---|---|---|---|
| 2026-10-21 | D0-QA-02 | Host: this Windows 11 PC; controllers: Android phone + Android tablet | Android + Chrome (controllers; exact versions not recorded); host browser not recorded | Served the dev server on the LAN, opened the host URL on this PC, joined both controllers with the room code + PIN in Chrome, pressed Test on each | P1 and P2 joined instantly; press and release registered on the host table; disconnects only when the screen turned off or the page was manually reloaded; server log shows room create, host join, P1/P2 joins, all asset routes 200, no token/PIN | **PASS** |

> Run performed on 2026-10-21 with real devices. Exact Chrome version strings
> and the host browser name were not captured; everything else in the row is
> as observed. The server does not log `InputFwd` frames (SR-9); input
> forwarding was confirmed by the host table and the automated e2e test.

### Notes and gaps

- D0-QA-02 functional acceptance is complete. The exact Chrome version strings
  and the host browser name are not recorded (see the row above).
- `npm ci && npm run check` on a clean clone and a green CI run on the default
  branch were not verified in this run; no install and no git commit were
  performed.
- Trace enforcement is stage-scoped: `npm run trace` passes `--stage D0`, so
  the 94 IDs owned by later stages are reported as deferred. Running
  `node tools/trace-check/dist/cli.js` without `--stage` currently exits 1 with
  those same 94 IDs missing (43 tagged of 137); that is the expected D0 state,
  and the Gate audit requires them to be tagged by later stages.
- The manual run's server log is ordered but has no timestamps. It records room
  lifecycle only; per-frame `InputFwd` logging is intentionally absent (SR-9).
- The root `eslint.config.js` enforces the D0 layer rules. The rejected
  `tooling/lint/` bypass is gone (the directory is empty). The test-only
  fixture remains only as a fallback if the root config is absent.
- No secrets, tokens, PINs, session values or live room codes were recorded in
  this file or emitted by the automated runs.

---

## D1 — Device probes (2026-10-21)

> **Scope actually measured:** desktop Chrome 155 on this Windows 11 PC only.
> **No TV was available**, so no Android TV/Chromium, Tizen or webOS row exists,
> and no Firefox or iOS row was run. These rows are real measurements, but they
> do **not** satisfy the D1 exit criterion "findings recorded for your actual
> TV(s)". The device ID `pc-win11-rtx3050` is defined in `docs/DEVICES.md`; the
> reusable checklist is `docs/DEVICE-MATRIX.md`; derived numbers live in
> `docs/BUDGETS.md`.

### Environment

| Field | Observed value |
|---|---|
| Device | `pc-win11-rtx3050` — this PC used as host screen, not a TV |
| OS | Microsoft Windows 11 Home Single Language 10.0.26300, 64-bit |
| Browser | Google Chrome 155.0.8059.85 |
| User agent | `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36` (recorded only) |
| GPU | `ANGLE (NVIDIA, NVIDIA GeForce RTX 3050 Ti Laptop GPU (0x000025A0) Direct3D11 vs_5_0 ps_5_0, D3D11)`, vendor `Google Inc. (NVIDIA)` |
| Screen | 2560x1440, available 2560x1440, color depth 24, DPR 1; inner viewport 2560x1305 during E1 |
| Hints | `navigator.hardwareConcurrency` 16; `navigator.deviceMemory` 16 GB |
| Node / npm | v22.14.0 / 10.9.2 |
| Conditions | Desktop; no TV Game Mode; E3 tab visible and focused (`rafThrottleSuspected: false`) |

### Commands run

```sh
npm run build -w @lanpad/dev-server      # exit 0
node packages/dev-server/dist/main.js    # printed http://192.168.29.98:8080/ and http://localhost:8080/
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/x/ http://127.0.0.1:8080/x/e01/ http://127.0.0.1:8080/x/e02/ http://127.0.0.1:8080/x/e03/ http://127.0.0.1:8080/x/e14/
```

`/x/`, `/x/e01/`, `/x/e02/`, `/x/e03/` and `/x/e14/` each returned **200**;
`/healthz` returned **200** with `{ok:true,rooms:0}`. The server was stopped
after the run and port 8080 was confirmed free.

Pages were opened at `http://localhost:8080/...`, not `http://127.0.0.1:8080/...`,
because the dev server's WebSocket `Origin` allowlist (SR-11) accepts
`localhost` and the LAN origins but rejects `127.0.0.1`; using `127.0.0.1`
would have produced a false E1 binary-WebSocket failure.

Raw JSON was read from each page's JSON block (`#json`) and transcribed below.
No measurement was uploaded (SR-7).

### E1 — TV browser capabilities

Run: open `http://localhost:8080/x/e01/`, press `#run`, wait for `Finished:`.
Result: **14/14 checks pass**.

| Experiment | Date | Device | OS | Browser | Conditions | Measurement | Verdict | Notes |
|---|---|---|---|---|---|---|---|---|
| E1 | 2026-10-21 | pc-win11-rtx3050 | Windows 11 10.0.26300 (64-bit) | Chrome 155.0.8059.85 | `http://localhost:8080/x/e01/`, desktop, 2560x1440 DPR 1, tab visible | WebGL2 **yes** (alpha, antialias, depth, premultipliedAlpha true; stencil, preserveDrawingBuffer, desynchronized, xrCompatible false; powerPreference `default`; failIfMajorPerformanceCaveat false); maxTex **16384**; compressed extensions `EXT_texture_compression_bptc`, `EXT_texture_compression_rgtc`, `WEBGL_compressed_texture_s3tc`, `WEBGL_compressed_texture_s3tc_srgb` (ASTC/ETC/ETC1 no); Web Audio **running**, 48000 Hz, baseLatency 10 ms; binary WS **pass** on the existing `/ws` room flow, 26-byte `Input` -> 27-byte `InputFwd`, fields matched, slot 1, RTT **1.4 ms**; WebRTC present yes; rAF 120 frames mean **8.8 ms = 114.2 Hz** (min 8.0, max 16.6); Wake Lock yes; deviceMemory 16 GB; hardwareConcurrency 16; screen 2560x1440 DPR 1; UA recorded only | **PASS** | Meets the E1 criterion (WebGL2 **and** binary WebSocket) on desktop Chrome. No TV was measured, so TV-only viability (G6) is not established. |

### E2 — memory ceiling

**Safe mode only.** `#safe-mode` was checked, so each phase stopped at the
enforced 512 MB cap. This is **not** a memory ceiling: no allocation throw and
no slow step occurred (every step ended `ok` or `safe-limit`). The 70% rule is not applicable to this
row; `docs/BUDGETS.md` therefore marks the memory budgets provisional and
pending.

Run: open `http://localhost:8080/x/e02/`, keep `#safe-mode` checked, press
`#run`, wait for `Finished. Stable JS`.

| Experiment | Date | Device | OS | Browser | Conditions | Measurement | Verdict | Notes |
|---|---|---|---|---|---|---|---|---|
| E2 | 2026-10-21 | pc-win11-rtx3050 | Windows 11 10.0.26300 (64-bit) | Chrome 155.0.8059.85 | `http://localhost:8080/x/e02/`, Safe mode checked (512 MB per phase), 48 steps | JS phase stopped at the **512 MB** safe limit; texture phase stopped at the **512 MB** safe limit; estimated total **1024 MB**; failure mode `js-heap safe-limit; texture safe-limit`; no allocation throw and `slow: false` on all 48 steps; baseline frame p50 **8.40 ms** / p95 **16.20 ms** (60 frames) | **RECORDED (safe-mode cap)** | 512 MB is the enforced cap, not a measured limit. The page's 358 MB "suggested budgets" are 70% of that cap, not of a stable ceiling. The page instructs closing the tab after copying to release the memory. |
| E2 | 2026-10-21 | pc-win11-rtx3050 | Windows 11 10.0.26300 (64-bit) | Chrome 155.0.8059.85 | Full run (Safe mode unchecked) — **not run** | Not measured | **PENDING** | Exact steps: `node packages/dev-server/dist/main.js`; open `http://localhost:8080/x/e02/` (LAN `http://192.168.29.98:8080/x/e02/`); close other tabs; uncheck `#safe-mode`; press `#run`; wait for `Finished. Stable JS`; copy `#json`; close the tab. Repeat on a real TV with Game Mode on and off. |

### E3 — render benchmark

Pass criterion: **>= 30 fps at 1280x720 with 1,000 instanced quads**. The page
reported **120.00 fps**, so the criterion **PASSes on this desktop**. Frame
times are wall-clock rAF capped by the display at about 120 Hz (8.3-8.5 ms
p50/p95), so the GPU timer values are the discriminating numbers. 1,171 frames
were measured per scene/resolution after a 2 s warm-up and 30 discarded frames;
every run recorded 1 draw call per frame, 0 long frames, `contextLost: false`
and GPU timer available.

Run: open `http://localhost:8080/x/e03/`, press `#run`, wait for `Finished.`.

| Experiment | Date | Device | OS | Browser | Conditions | Measurement | Verdict | Notes |
|---|---|---|---|---|---|---|---|---|
| E3 | 2026-10-21 | pc-win11-rtx3050 | Windows 11 10.0.26300 (64-bit) | Chrome 155.0.8059.85 | 1280x720, `quads-1k` (1,000 instanced quads) | p50 **8.30 ms**; p95 **8.50 ms**; **120.00 fps** (119.997); 1 draw call; 2,000 triangles; GPU p50 **0.253 ms** / p95 **0.305 ms**; GPU mem est. **28.39 MB** | **PASS** | Criterion row. Desktop result, not TV. |
| E3 | 2026-10-21 | pc-win11-rtx3050 | Windows 11 10.0.26300 (64-bit) | Chrome 155.0.8059.85 | 1920x1080, `quads-1k` | p50 8.30 ms; p95 8.50 ms; 120.00 fps; 1 draw call; GPU p50 0.692 / p95 0.744 ms; GPU mem est. 37.18 MB | RECORDED | Desktop result, not TV. |
| E3 | 2026-10-21 | pc-win11-rtx3050 | Windows 11 10.0.26300 (64-bit) | Chrome 155.0.8059.85 | 1280x720, `quads-5k` | p50 8.30 ms; p95 8.50 ms; 120.00 fps; 1 draw call; GPU p50 0.396 / p95 0.440 ms; GPU mem est. 28.48 MB | RECORDED | Desktop result, not TV. |
| E3 | 2026-10-21 | pc-win11-rtx3050 | Windows 11 10.0.26300 (64-bit) | Chrome 155.0.8059.85 | 1920x1080, `quads-5k` | p50 8.30 ms; p95 8.50 ms; 120.00 fps; 1 draw call; GPU p50 0.344 / p95 1.035 ms; GPU mem est. 37.27 MB | RECORDED | Desktop result, not TV. |
| E3 | 2026-10-21 | pc-win11-rtx3050 | Windows 11 10.0.26300 (64-bit) | Chrome 155.0.8059.85 | 1280x720, `quads-10k` | p50 8.30 ms; p95 8.50 ms; 120.00 fps; 1 draw call; GPU p50 0.349 / p95 0.458 ms; GPU mem est. 28.59 MB | RECORDED | Desktop result, not TV. |
| E3 | 2026-10-21 | pc-win11-rtx3050 | Windows 11 10.0.26300 (64-bit) | Chrome 155.0.8059.85 | 1920x1080, `quads-10k` | p50 8.30 ms; p95 8.40 ms; 120.00 fps; 1 draw call; GPU p50 0.254 / p95 1.023 ms; GPU mem est. 37.38 MB | RECORDED | Desktop result, not TV. |
| E3 | 2026-10-21 | pc-win11-rtx3050 | Windows 11 10.0.26300 (64-bit) | Chrome 155.0.8059.85 | 1280x720, `mesh-1m` (1,000,000-triangle static mesh) | p50 8.30 ms; p95 8.40 ms; 120.00 fps; 1 draw call; 1,000,000 triangles; GPU p50 0.794 / p95 2.051 ms; GPU mem est. 29.95 MB | RECORDED | Desktop result, not TV. |
| E3 | 2026-10-21 | pc-win11-rtx3050 | Windows 11 10.0.26300 (64-bit) | Chrome 155.0.8059.85 | 1920x1080, `mesh-1m` | p50 8.30 ms; p95 8.50 ms; 120.00 fps; 1 draw call; 1,000,000 triangles; GPU p50 1.602 / p95 5.348 ms; GPU mem est. 38.74 MB | RECORDED | Desktop result, not TV. |
| E3 | 2026-10-21 | pc-win11-rtx3050 | Windows 11 10.0.26300 (64-bit) | Chrome 155.0.8059.85 | 1280x720, `atlas-2048` (2048x2048 atlas stress) | p50 8.30 ms; p95 8.50 ms; 120.00 fps; 1 draw call; GPU p50 0.347 / p95 0.449 ms; GPU mem est. 28.59 MB | RECORDED | Desktop result, not TV. |
| E3 | 2026-10-21 | pc-win11-rtx3050 | Windows 11 10.0.26300 (64-bit) | Chrome 155.0.8059.85 | 1920x1080, `atlas-2048` | p50 8.30 ms; p95 8.50 ms; 120.00 fps; 1 draw call; GPU p50 0.436 / p95 1.017 ms; GPU mem est. 37.38 MB | RECORDED | Desktop result, not TV. |

### E14 — mixed content and private-network reachability

**Not run.** No tunnel was installed and no attempt button was pressed, so
mixed-content blocking was not observed. The page itself loaded at
`http://localhost:8080/x/e14/` and reported protocol `http:`, secure context
yes, and mixed-content test applicable **no**. The **Copy JSON** button stayed
disabled and the JSON block read `Not run.`

| Experiment | Date | Device | OS | Browser | Conditions | Measurement | Verdict | Notes |
|---|---|---|---|---|---|---|---|---|
| E14 | 2026-10-21 | pc-win11-rtx3050 | Windows 11 10.0.26300 (64-bit) | Chrome 155.0.8059.85 | `http://localhost:8080/x/e14/` (plain HTTP, not a tunnel); 0 attempts | Not run; status `Not run.`; no blocked/allowed result | **PENDING** | Exact steps: (1) `node packages/dev-server/dist/main.js`; (2) `cloudflared tunnel --url http://localhost:8080` or `ngrok http 8080`; record provider/version; (3) open `https://<tunnel-host>/x/e14/`; (4) enter `ws://192.168.29.98:8080/ws`; (5) press `Test ws:// LAN WebSocket`, `Test http:// LAN /healthz`, `Test ws://localhost control`; (6) Copy JSON and record each attempt. |
| E14 | 2026-10-21 | android-phone-d0qa02 | Android (version not recorded) | Chrome (version not recorded) | Same tunnel URL on Android Chrome; 0 attempts | Not run | **PENDING** | Required by D1-EXP-05 after the desktop row. The phone exists (D0-QA-02) but its exact OS/browser versions were not recorded. |

E14 has **not** confirmed or contradicted the spec's LAN-direct removal
(decision log 0.2 -> 0.3); it is simply unmeasured.

### D1 TV target decision (written)

- **WebGL2: yes** on the only measured device (desktop Chrome 155). Per the D1
  stop rule, **D3 may proceed with the WebGL2 target**.
- **Binary WebSocket: yes** on the same device, using the dev server's `/ws`
  room flow (26-byte `Input` -> 27-byte `InputFwd`).
- **Canvas2D fallback: not required by this run.** Keep the friendly failure
  screen (FR-9.3) for browsers that cannot create a WebGL2 context.
- **Resolution:** 720p and 1080p both ran at the ~120 fps desktop rAF cap for
  all five scenes. Highest resolution actually tested: 1080p. Planning floor:
  **720p**. The TV-safe maximum remains **unmeasured**.
- **PC + HDMI fallback:** no TV is available; PC + HDMI remains the plan
  default (todos README §11 Q2). This PC is available as the host, but HDMI
  output to a TV was not exercised in D1.
- **D1 exit status: open.** The measured device is not a TV, so the exit
  criterion "findings recorded for your actual TV(s)" is not met. The D3
  renderer target can proceed; the TV rows and E14 must still be recorded.

### Notes and gaps

- **No TV**: SPEC §12 rows Android TV (Chromium), Tizen and webOS were not
  tested. Do not treat these desktop numbers as TV performance.
- **E2:** safe mode only. The 512 MB values are the enforced cap; the JS and
  texture ceilings are **PENDING** a full run on a real TV (PR-11.2).
- **E14:** pending; no tunnel installed, no attempt pressed, no blocked/allowed
  observation exists.
- **E3:** desktop rAF is capped near 120 Hz, so wall-clock p50/p95 cluster at
  8.3-8.5 ms for every scene. The GPU timer values are the more discriminating
  numbers. The run was executed with the Chrome window restored to the
  foreground (metadata reported `visibilityState: visible`, `hasFocus: true`).
- A pre-existing unresponsive E3 tab at `localhost:8080/x/e03/` was closed
  before benchmarking to avoid GPU contention. Chrome console logging was not
  enabled at page load, so no console-message transcript was captured; every
  probe check nevertheless reported pass.
- **Build caveat (resolved):** during the measurement window the all-workspace
  build failed in `tools/input-bot` from a concurrent D4 edit (TS2300/TS2341).
  After D4 settled, `npm run check` passed; the final gate is recorded below.
- No source files were edited by the measurement run; only build output and the
  dev-server process were touched. No analytics, uploads, cookies or PII were
  used (SR-7).

---

## D2 — Controller v0 (2026-10-21)

Automated implementation result: **PASS**; manual device acceptance **PENDING**.

- Full integration gate: 59 test files, 661 tests; typecheck/lint/build green.
- D2 modules: layout schema/validator (20 tests), touch engine/hit-testing
  (29), InputStore/SendLoop/ClockSync, buttons/d-pad/stick, host InputMapper
  and golden traces, controller integration, perf overlay.
- Controller performance observed in the test harness: touch dispatch p95
  **0.441 ms** (2 ms budget), tap-to-encode-and-send **0.662 ms**.
- Controller bundle: **52,317 bytes raw, 16,605 gz** (dev budget 40,960; hard
  cap 61,440).
- Manual checks PENDING: 240 fps same-frame camera, real-phone 10-touch,
  two-finger/no-scroll, Android p50/p95. No device numbers are claimed.
- D2 exit is **NOT** complete: the manual checks and device evidence remain
  open. Layout delivery still waits for D5 `setLayout`; D2 accepts
  `joined.layout` or the first matching `setLayout`.

## D4 — Session foundation (2026-10-21)

Module-level result: **PASS**; end-to-end wiring **PENDING**.

- Protocol A9 `hostStatus` and A10 `badVersion`: 53/53 protocol tests.
- Broker tokens/PIN/constant-time/rate limiter and sessions/reservations/
  rejoin/expiry/host recovery/stats modules: broker 89/89 in the review run.
- Controller join/session and reconnect/suspend/Wake Lock modules: 33 join
  tests plus the controller suite; full gate 661 tests.
- RoomPanel QR/code/PIN and input-bot session/jitter/loss/churn logic are
  implemented and unit-tested.
- NOT functional end-to-end: `ws-server.ts`/`registry.ts` are not wired to
  host recovery, stats, suspend/event or detach; controller main is not wired
  to join/reconnect; RoomPanel is not mounted; input-bot CLI flags are not
  wired; join limiting currently applies only to PIN-bearing attempts; A11
  `pinRequired` is not in the error union.
- D4 QA (8-client 10-minute stability, reconnect matrix, G1 timing) is
  PENDING. D4 is **NOT** complete.
