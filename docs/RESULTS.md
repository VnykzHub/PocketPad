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

> **Post-integration note (2026-10-22, Wave 3):** the D5 layout path is now
> implemented end-to-end in code — the broker routes `setLayout`, the
> controller applies it with in-place hot-swap, and the host sends it through
> `LayoutApi`. Layout delivery therefore no longer waits on D5. No browser or
> phone run was recorded for this note, so the manual D2 checks above and the
> D2 exit remain PENDING.

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

> **Post-integration note (2026-10-22, Wave 3):** the wiring gaps listed above
> are addressed in the working tree. `ws-server.ts`/`registry.ts` now use host
> recovery, stats, detach/suspend, hostPause/hostResume and the SR-5 join
> limiter; controller `main.ts` drives join/reconnect through
> `ControllerClient`, which owns suspend/Wake Lock; `RoomPanel` is mounted in
> the runtime host; input-bot CLI flags are wired. Join limiting now checks
> every token/PIN attempt before any credential comparison, not only
> PIN-bearing attempts. A11 is enforced in behaviour: a token-only join to a
> room with `requirePinForQr` is rejected with `badPin`; the dedicated
> `pinRequired` member is still not in `JoinErrorReason` (deferred to P3). No
> browser, phone or 8-bot run was recorded for this note, so D4 QA and the D4
> exit remain PENDING.

---

## D3 — Runtime experiments (2026-10-22)

Environment for every row below unless the row says otherwise:
`pc-win11-rtx3050`, Windows 11 Home Single Language 10.0.26300, Chrome
155.0.0.0 (persistent Chrome driven by the Chrome MCP), 1920x1080 at DPR 1,
dev server `http://localhost:8080` on loopback. This is a desktop browser; no
phone or TV was attached. Per `docs/TESTING.md`, a loopback browser run is a
software baseline, not a phone or TV substitute.

### E5 — input-to-canvas

Method: open `http://localhost:8080/x/e05/`, press Run, read the Copy JSON
block. The run is a same-tab controller socket -> `/ws` -> host socket with one
`performance.now()` clock; 100 taps at 120 ms. Run timestamp
`2026-10-21T19:07:55.994Z` (2026-10-22 local).

| Experiment | Date | Device | OS | Browser | Conditions | Measurement | Verdict | Notes |
|---|---|---|---|---|---|---|---|---|
| E5 | 2026-10-22 | pc-win11-rtx3050 | Windows 11 Home Single Language 10.0.26300 | Chrome 155.0.0.0 | Desktop, loopback, 100 taps @ 120 ms, software legs only | samples 100/100, missed 0; inputToCanvas p50 8.6 ms, p95 9.1 ms (min 5.9, max 109.6); tapToEncode p50 0.1 / p95 0.3; packetToHost p50 0.8 / p95 1.2 (max 1.7); receiveToPaint p50 7.7 / p95 8.3 | PASS (desktop software baseline) | p95 is below the 25 ms budget; the 109.6 ms maximum is one paint outlier. Phone touch pipeline, Wi-Fi, TV display and camera legs are not included. |
| E5 | 2026-10-22 | phone + tv | PENDING | PENDING | LAN, 5 GHz, phone -> TV, 1000 taps, camera-measured | not run | PENDING | No phone or TV attached. The desktop row does not replace this run. |
| E5 (latency-harness live) | 2026-10-22 | pc-win11-rtx3050 | Windows 11 Home Single Language 10.0.26300 | Node v22.14.0 (no browser) | `node tools/latency-harness/dist/cli.js live --server http://localhost:8123 --taps 100 --interval 120 --out %TEMP%/lanpad-vt/e5-live-100.json`; input-bot socket -> broker -> host socket, one process clock | 100/100 paired; tapToEncode p50 10.107 / p95 28.159 (min 0.439, max 31.296); packetToHost p50 0.467 / p95 0.69 (max 1.08); inputAge p50 10.585 / p95 28.695; harness gate `pass: false` at 25 ms | FAIL (harness gate) | Analyze mode confirms `inputAge p95 >= 25 ms: FAIL`. The bot sends on a 60 Hz tick, so tapToEncode includes 0..16.7 ms of quantization; the broker leg itself was 0.69 ms p95. Treat this as a bot/harness artifact, not a measured phone pipeline; re-run with a phone or a non-tick-limited sender. |

### E6 — TV display lag

| Experiment | Date | Device | OS | Browser | Conditions | Measurement | Verdict | Notes |
|---|---|---|---|---|---|---|---|---|
| E6 | 2026-10-22 | tv | PENDING | PENDING | Game Mode on and off, 240 fps camera or photodiode | not run | PENDING | `experiments/e06/` has `flash.ts` and `page.ts` but no `index.html` or build, so the flash page is not runnable; display lag also needs a TV and camera. Not measured and not inferred from E5. |

### E11 — audio latency

| Experiment | Date | Device | OS | Browser | Conditions | Measurement | Verdict | Notes |
|---|---|---|---|---|---|---|---|---|
| E11 | 2026-10-22 | tv | PENDING | PENDING | Start-screen gesture, wired and Bluetooth if available | not run | PENDING | No `experiments/e11/` page exists and no TV is attached. Audio output latency cannot be measured from a desktop loopback run. |

### E12 — renderer decision

> **Superseded (2026-10-22):** the browser-engine decision replaces this with a
> custom **WebGPU-first** renderer and a **WebGL2 fallback**. See
> [`docs/ADR-0002-webgpu-engine.md`](ADR-0002-webgpu-engine.md). The measured
> rows below remain the E12 record; no number was changed.

Decision: **custom WebGL2 renderer (`WebGL2Renderer`) with a
`Canvas2DRenderer` fallback**, both behind the frozen `Renderer`,
`Renderer2D` and `Renderer3D` interfaces. No Three.js dependency:
`packages/runtime/package.json` declares only `@lanpad/protocol` and
`@lanpad/sdk`. This is a **desktop-provisional** decision; the TV half of the
size/frame/memory comparison is PENDING.

| Experiment | Date | Device | OS | Browser | Conditions | Measurement | Verdict | Notes |
|---|---|---|---|---|---|---|---|---|
| E12 | 2026-10-22 | pc-win11-rtx3050 | Windows 11 Home Single Language 10.0.26300 | Chrome 155.0.0.0 | Built `packages/runtime/dist`; gzip via `zlib.gzipSync` | Page-load HTML+CSS+JS 128,073 raw / 42,353 gz; all `.js/.css/.html/.json` in dist 332,079 raw / 105,746 gz (37 files); hard cap 5,242,880 gz | RECORDED | Page-load gzip is about 0.8% of the hard cap. All-text dist over-counts because the tsc module tree is not all loaded by the page. |
| E12 | 2026-10-22 | tv | PENDING | PENDING | Same cube scene, one texture, 1080p; frame p95 and memory on TV | not run | PENDING | No TV. A desktop host run reported backend `webgl2`, but FPS 0, frame p50/p95 "-", draw calls 0 because the cube demo never loaded: `/demo/cube-demo/game.manifest.json` returns HTTP 404. No frame-time or memory number is claimed. |

Why custom: the implemented backend adds no runtime package, the Canvas2D
fallback is already implemented and tested, and the measured page-load gzip is
far under the 5 MB cap. If the TV run later shows the custom backend missing
the frame budget, a Three.js backend can replace it behind `Renderer3D` without
touching game code; the ADR (`docs/ADR-0001-renderer.md`) is still to be
written by its owner.

> **Post-integration note (2026-10-22, Wave 4):** `docs/ADR-0001-renderer.md`
> now records the E12 decision as desktop-provisional. The wave's full gate
> measured the host runtime dev bundle at **55,754 B gz** (dev target
> 3,145,728; hard 5,242,880) and the controller at **37,911 B gz** (dev target
> 40,960; hard 61,440). These are size-gate totals, not renderer-only numbers,
> and they add no frame-time or memory evidence. The two E12 rows above are
> unchanged: the desktop overlay run is still invalid because it was not
> re-run after the `/demo/*` 404 fix, and the TV comparison remains **PENDING**.
> No Three.js dependency exists in the tree.

### D3-QA-01 — Cube on TV acceptance

| Check | Date | Device | OS | Browser | Conditions | Measurement | Verdict | Notes |
|---|---|---|---|---|---|---|---|---|
| D3-QA-01 (desktop overlay only) | 2026-10-22 | pc-win11-rtx3050 | Windows 11 Home Single Language 10.0.26300 | Chrome 155.0.0.0 | `http://localhost:8080/?debug=1` | backend webgl2; FPS 0; frame p50/p95 "-"; sim ticks 0; draw calls 0; texture 0.00 MB; JS heap 3.4 MB; canvas 300x150; render scale 100%; DPR 1 | RECORDED | Overlay fields render, but the cube never started because the game manifest returns 404. This is not a TV acceptance run. |
| D3-QA-01 | 2026-10-22 | tv + phone | PENDING | PENDING | Actual TV, phone join, stick/A, `?debug=1`, 100-tap E5, screenshot | not run | PENDING | Blocked by no TV or phone and by the manifest 404 above. Cube-on-TV, console-clean, frame p95 <= 14 ms and dynamic-resolution checks are all unmeasured. |

> **Post-integration note (2026-10-22, Wave 3):** the
> `/demo/cube-demo/game.manifest.json` 404 recorded above is addressed in the
> tree — the dev server now routes `/demo/*` from the built host, and
> `packages/runtime/dist/demo/cube-demo/game.manifest.json` exists after
> `npm run build`. No browser re-run was performed for this note, so the E12
> and D3-QA-01 verdicts above are unchanged. Re-run the overlay and the TV
> acceptance before claiming either result.

## D4 — Session experiments (2026-10-22)

The module-level D4 section above still stands. These rows record the
`D4-EXP-01` experiment runs. Environment is the same desktop as D3 unless the
row says otherwise.

### E4 — LAN network quality

| Experiment | Date | Device | OS | Browser | Conditions | Measurement | Verdict | Notes |
|---|---|---|---|---|---|---|---|---|
| E4 | 2026-10-22 | pc-win11-rtx3050 | Windows 11 Home Single Language 10.0.26300 | Chrome 155.0.0.0 | Loopback, 1 socket, 200 pings @ 20 ms | sent 200, received 200, lost 0 (0%); RTT p50 0.8 ms, p95 1.2 ms, max 1.5, mean 0.857; jitter 0.15 ms | RECORDED | This is not the E4 criterion: loopback is not 5 GHz Wi-Fi. |
| E4 | 2026-10-22 | phone + tv | PENDING | PENDING | 5 GHz, idle and busy, 1000 pings per band, 2.4 GHz comparison | not run | PENDING | Needs a phone and TV on the LAN. |

### E9 — clock fairness

| Experiment | Date | Device | OS | Browser | Conditions | Measurement | Verdict | Notes |
|---|---|---|---|---|---|---|---|---|
| E9 | 2026-10-22 | pc-win11-rtx3050 | Windows 11 Home Single Language 10.0.26300 | Chrome 155.0.0.0 | Same-machine ground truth on, 2 sockets, 20 rounds x 16 pings @ 20 ms | pairError p50 0.212 ms, p95 0.751, max 0.775; absErrorVsTruth p95 0.504; worst error bound 0.3 ms; passes true | PASS (same-machine estimator) | Same OS clock. Validates the minimum-RTT estimator against truth, not Wi-Fi path asymmetry between two phones. |
| E9 | 2026-10-22 | phone pair | PENDING | PENDING | Two phones tapping together; synced timestamps vs arrival order | not run | PENDING | Needs two phones. If it fails, Reaction Duel uses arrival order plus a documented tie rule. |

### E15 — phone lifecycle

| Experiment | Date | Device | OS | Browser | Conditions | Measurement | Verdict | Notes |
|---|---|---|---|---|---|---|---|---|
| E15 | 2026-10-22 | phone | PENDING | PENDING | Lock screen, app switch, browser kill; rejoin inside the 30 s reservation | not run | PENDING | The in-page recorder refuses to report until a real hide/show occurs ("recorder armed; no hide/show yet"). No lifecycle event was performed, so no recovery time is claimed. |

### G1 — scan-to-playable

| Experiment | Date | Device | OS | Browser | Conditions | Measurement | Verdict | Notes |
|---|---|---|---|---|---|---|---|---|
| G1 (in-page instrumentation) | 2026-10-22 | pc-win11-rtx3050 | Windows 11 Home Single Language 10.0.26300 | Chrome 155.0.0.0 | Self-hosted room, same-machine page run | pageLoadToJoined 32,447.2 ms (human wait 32,390.7); runToJoined 31.3 ms; joinRoundTrip 1.4 ms; machine 56.5 ms; slot 1 | RECORDED | The 32.4 s is human reading time. This excludes the QR scan and the first rendered input, so it is not a G1 trial. |
| G1 | 2026-10-22 | phone + tv | PENDING | PENDING | 10 trials, stopwatch from QR scan to visible movement | not run | PENDING | Needs a phone and TV. Pass is median < 5 s, hard fail 10 s. |

D4 QA (8-client 10-minute stability, reconnect matrix) remains PENDING as
recorded in the D4 section above.

## D5 — Layouts and events (2026-10-22)

Environment is the same desktop as D3 unless the row says otherwise. Both
experiments need a real phone; neither has a runnable page in `experiments/`.

### E10 — stroke streaming

| Experiment | Date | Device | OS | Browser | Conditions | Measurement | Verdict | Notes |
|---|---|---|---|---|---|---|---|---|
| E10 | 2026-10-22 | phone + tv | PENDING | PENDING | Draw fast for 30 s; bytes/s per drawer and visible TV delay | not run | PENDING | `experiments/e10/` does not exist. `packages/controller/src/controls/strokeBatcher.ts` and its unit tests exist, but a unit test is not a device measurement; no bytes/s or TV delay is claimed. |
| E10 | 2026-10-22 | phone + tv | PENDING | PENDING | Slow and medium drawing; compare batching settings | not run | PENDING | Same blocker. |

### E16 — keyboard handling

| Experiment | Date | Device | OS | Browser | Conditions | Measurement | Verdict | Notes |
|---|---|---|---|---|---|---|---|---|
| E16 | 2026-10-22 | android phone | PENDING | PENDING | Text control, 60 chars, submit, rotate with keyboard open | not run | PENDING | `experiments/e16/` does not exist and no Android phone was attached. iOS is deferred per A5. |

## D6 — Sensors and haptics (2026-10-22)

Sensor and haptic modules exist under `packages/controller/src/sensors/` and
`packages/controller/src/haptics/`, but no experiment pages exist and no
Android device was attached. Every row is PENDING; no sensor or vibration
number is claimed.

| Experiment | Date | Device | OS | Browser | Conditions | Measurement | Verdict | Notes |
|---|---|---|---|---|---|---|---|---|
| E7 | 2026-10-22 | android phone | PENDING | PENDING | `rotationRate` units/signs/axes, portrait and landscape; HTTP vs HTTPS secure context; 60 s drift | not run | PENDING | `experiments/e07/` and `docs/SENSOR-TESTING.md` do not exist. iOS leg is deferred per A5, not failed. |
| E8 | 2026-10-22 | android phone (two if available) | PENDING | PENDING | 10/20 Hz patterns: 10 ms, 20 ms, [10,30], [20,40], long patterns | not run | PENDING | `experiments/e08/` does not exist. Whether 20 Hz is distinct or stutters is unmeasured. |
| Swing feasibility | 2026-10-22 | android phone | PENDING | PENDING | 30 swings per direction; peak magnitude and axis; false positives/negatives | not run | PENDING | `experiments/e07-swing/` does not exist. No go/no-go for Sword Swing Duel is issued from desktop code. |

## Coin Run — platformer slice (2026-10-22)

The Coin Run code is in the working tree (`packages/games/platformer/`,
`GAME-PF-01`..`05` code-complete; `GAME-PF-06` pending). **No device, browser
or LAN run exists, so every row below is PENDING and no measurement is
claimed.** A unit test asserts a full fake-renderer frame stays at or below
120 draw calls; that is a code contract, not a device frame measurement.

| Experiment | Date | Device | OS | Browser | Conditions | Measurement | Verdict | Notes |
|---|---|---|---|---|---|---|---|---|
| GAME-PF-06 run A | 2026-10-22 | tv + 1 phone | PENDING | PENDING | d-pad; move, jump, coins, fall/respawn, goal, results | not run | PENDING | No TV or phone run. Verifies a single player can finish the level and see results. |
| GAME-PF-06 run B (priority) | 2026-10-22 | tv + 2 phones | PENDING | PENDING | d-pad + stick; shared score, simultaneous pickups, camera, rematch | not run | PENDING | The 2-player flow is unit-tested; no phone run exists. Also re-checks that a fresh join shows the platformer layout after the connected-flag fix. |
| GAME-PF-06 run C | 2026-10-22 | tv + 4 phones | PENDING | PENDING | mixed layouts; four bodies independent, labels readable, no stuck slot | not run | PENDING | Four-player is code-supported but untested on hardware. |
| Coin Run budgets | 2026-10-22 | tv + phone | PENDING | PENDING | Initial/total gzip bytes, max draw calls, frame p50/p95, input-to-canvas p95, join-to-first-input | not run | PENDING | No size-gate, frame-time or latency measurement exists for this game. |
| Coin Run 10-minute run | 2026-10-22 | tv + phone | PENDING | PENDING | Continuous play, memory samples, rematch twice | not run | PENDING | No leak, crash or stuck-slot evidence. Not an E17 soak. |
| Coin Run replay | 2026-10-22 | desktop | PENDING | PENDING | 60 s, 2-player recorded trace through `Game.simulate` | not run | PENDING | `test/replay.test.ts` does not exist. Determinism is tested only for short fixed input sequences. |

---

## UI wave (Wave 7) — automated size gate (2026-10-22)

> Scope: `npm run size` run by the independent verifier on the working tree.
> No browser, phone or TV was attached; this is a build-size measurement only.
> It updates the current-tree totals from the wave-5 note and changes no device
> row. All TV/Android/LAN rows above stay **PENDING**.

| Target | Env | Files | Raw bytes | Gzip bytes | Budget (gz) | Status |
|---|---:|---:|---:|---:|---:|---|
| controller | dev | 1 | 140948 | 40723 | 40960 | ok |
| host | dev | 6 | 236606 | 74424 | 3145728 | ok |

Controller: 237 gzip bytes (0.58%) of dev headroom remain (99.42% used); prod
target 51,200 B; hard cap 61,440 B. Host: 2.37% of the dev target used; prod
target 3,670,016 B; hard cap 5,242,880 B. No production-env run was performed.

Delta from the wave-5 gate: controller 37,911 -> 40,723 gz (+2,812 B, +7.4%);
host 55,754 -> 74,424 gz (+18,670 B, +33.5%). These are size-gate totals; no
per-game frame, memory or latency number is claimed. See
`docs/todos/CHECKPOINT-2026-10-22-ui.md` §3.2.

---

## Engine M0 — scene5000 acceptance (2026-10-23)

> **Historical evidence.** The hashes and pixel counts in this section predate
> the RV-76 sRGB output correction and are kept as history. Current goldens are
> in "Engine M0 — sRGB output correction and golden re-record (RV-76)" below.

> Real headless-Chrome runs of the engine's WebGPU and WebGL2 backends on the
> 5,000-instance scene. Measured, not estimated. The machine matches the named
> desktop OS/Chrome baseline; the exact GPU model is reported only as
> `nvidia ampere` (WebGPU) / `WebKit WebGL` (WebGL2). Headless rAF was not
> 60 Hz-vsynced, so the intervals below are frame pacing, not a 60 Hz-vsync
> claim, and no GPU timestamp was available (`gpuFrameMs = null`).

Environment: Windows 11 Home Single Language 10.0.26300, Chrome
155.0.8059.85 headless (CDP), DPR 1, CSS/backing 1920×1080. Common engine
build identity: SHA-256 `bed149c46487770bb4e977a05f57f6444ad0e50d5ce07b2c8d662f6776de9d4f`
over 135 built engine JS files (959,937 bytes).

Command:
`node experiments/e-m0-engine/run.mjs --scene scene5000 --instances 5000 --size 1920x1080 --bench 1 --backend <webgpu|webgl2>`

| Backend | p50 ms | p95 ms | max ms | draw calls | triangles | instances | textureBytes | gpuErrors | Budget | Golden |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| WebGPU | 9.2 | 10.1 | 10.2 | 1 | 60,000 | 5,000 | 8,295,680 | 0 | target-met (14/20) | `83a995ef` |
| WebGL2 | 9.3 | 10.2 | 10.7 | 1 | 60,000 | 5,000 | 256 | 0 | target-met (14/20) | `fc205f5d` |

- 600 measured frames after 120 warm-up; capture at frame 60 after 30 warm-up.
- Cross-backend diff: **4 / 2,073,600 pixels = 0.000193%** differ by more than
  8/255 in any channel; max channel delta 37; allowance 2%.
- Cube control: both backends hash `32312240`; 0 differing pixels.
- Screenshots: `experiments/e-m0-engine/artifacts/scene5000-5000-1920x1080/`.

**Caveats recorded with the numbers:** (1) WebGPU `textureBytes` includes the
1080p `depth24plus` swapchain depth attachment (8,294,400 B), so it exceeds
Appendix A.2's old "≤ 1 MiB" expected-stat line (now treated as a semantic and
spec fix, not a renderer defect); the 128 MiB hard budget passes. (2) Headless
rAF ran at roughly 108 Hz, so this is not 60 Hz-vsync evidence. (3) No GPU
timing, device-loss, resize or TV/Android run. (4) ER-04-09/ER-05-04 specify a
tick-300 golden; this run captures frame 60, so those rows remain PENDING even
though the observed diff is far inside tolerance.

### Re-run after the WebGL2 `copy-dst` fix (2026-10-23)

Same scene, machine, Chrome and method as above, on engine build
SHA-256 `2657192f89089d384063407045b91997a9f282f8ec00ecaa2f10d82fcb0be50c`
(the build that accepts `copy-dst` as a WebGL2 upload no-op). The runner's
texture ceiling was corrected from the stale 1 MiB to **12 MiB including the
depth attachment**, matching 04 Appendix A.2.

| Backend | p50 ms | p95 ms | max ms | textureBytes | Within 12 MiB | Goldens | GPU errors |
|---|---:|---:|---:|---:|---|---|---:|
| WebGPU | 9.5 | 10.3 | 10.9 | 8,295,680 | yes | `83a995ef` matched | 0 |
| WebGL2 | 9.6 | 10.2 | 10.8 | 256 | yes | `fc205f5d` matched | 0 |

- 600 measured frame intervals after 120 warm-up; nearest-rank percentiles.
- Cross-backend diff remains **4 / 2,073,600 pixels (0.000193%)**, max delta 37.
- Acceptance flags: `specConformant`, `goldenPass`, `crossBackendParityPass`,
  `benchmarkTargetMet`, `benchmarkHardMet`, `textureBytesWithinSpecExpected`,
  `gpuErrorsZero` are true on both backends.
- Still frame pacing from headless rAF, not 60 Hz vsync; `gpuFrameMs = null`.

### M0 browser edge cases (2026-10-23)

Real headless Chrome 155.0.8059.85 on Windows 11, same engine build as the
re-run above. Artifacts under `experiments/e-m0-engine/artifacts/<case>/`.
These cases ran on the pre-RV-76 build; the `32312240` hashes here are
historical and are superseded by the sRGB section below.

| Case | Backend | Result | Exact evidence |
|---|---|---|---|
| Resize (10 CSS changes in one task) | WebGL2 | **PASS** | every `device.size` matched CSS; final 640×360 CSS @ DPR 2 → 1280×720 backing; 0 GPU errors; content present |
| Resize (10 CSS changes in one task) | WebGPU | **PASS** | `device.size` matched CSS on every call; backing stayed 1280×720 during the synchronous calls and followed DPR by the next frame; 0 GPU errors |
| WebGL2 context loss | WebGL2 | **PASS** | real lost/restored events; epoch 0→1; pre- and post-loss hash both `32312240`; recovery to content **29.2 ms / 3 frames**; 0 uncaught errors; 0 GPU errors |
| Forced WebGPU device loss | WebGPU | **PASS** | dev-only hook destroys the real `GPUDevice`; real `device.lost` reason `destroyed`; states `running → lost → running → failed`; pre/post hash both `32312240`; recovery **63.6 ms / 1 frame**; 3 handles valid and reused; second loss terminal with one refused `restore()` (`E_DEVICE_LOST`) and no retry loop |
| 5 MiB asset load | assets | **PASS (load), 8 ms bound not provable** | same-origin 5,242,880-byte WOFF2; transfer 5,243,180 B; decoded exact; 77.4 ms load; 0 long-task entries (the API only reports tasks > 50 ms, so it cannot prove an 8 ms bound) |

**Recorded gaps:** the resize case cannot count `context.configure()` calls
because the built contract exposes no swapchain counter, so ER-04-06's
"at most one configure" half stays PENDING. The WebGPU loss page loads no
assets and runs no game loop, so "no asset refetch" and "no game restart" are
recorded `null`, not true; the page also never calls `resize()` outside the
resize case, so `device.size` reads 0×0 pre- and post-loss while the canvas
backing follows the surface metrics. The asset case proves byte-accurate
loading, not the ≤ 8 ms main-thread bound. Handle staleness after WebGL2
restore was not exercised, so ER-05-06 is PASS for recovery timing/hash/epoch
and open on that clause. All of this is headless desktop Chrome; no TV/Android
claim is made.

## Engine M0 — sRGB output correction and golden re-record (RV-76) (2026-10-23)

> RV-76. Both built-in backends stored linear light in a framebuffer the display
> reads as sRGB, so the authored colour `#ffd166` displayed as `(255,162,34)`.
> The shaders now encode linear→sRGB exactly once at fragment output; sRGB
> textures remain hardware-decoded. All cube and scene5000 goldens were
> re-recorded deliberately on the corrected build. The M0 rows above are kept
> as historical evidence and are superseded by this section.

### Probe: platform limit and displayed colour

Command: `node experiments/e-m0-engine/srgb-probe.mjs` (page
`experiments/e-m0-engine/srgb-probe.html`). Headless Chrome 155.0.8059.85 via
CDP on Windows 11 Home Single Language 10.0.26300, DPR 1.

| Probe | Result |
|---|---|
| `GPUCanvasContext.configure({ format: "bgra8unorm-srgb" })` | **rejected** — `TypeError: Failed to execute 'configure' on 'GPUCanvasContext': Unsupported canvas context format 'bgra8unorm-srgb'.` |
| same with `"rgba8unorm-srgb"` | **rejected** — same `Unsupported canvas context format` error |
| `navigator.gpu.getPreferredCanvasFormat()` | `bgra8unorm` |
| WebGL2 `EXT_sRGB_write_control` | absent (`false`) |
| WebGL2 clear and shader output of linear 0.5 | read back `(127,127,127,255)` both — the default framebuffer is not sRGB |
| Engine, pre-fix, lit centre, both backends | `(137,87,18,255)` |
| Engine, pre-fix, unlit centre, both backends | `(255,162,34,255)` |
| Engine, post-fix, unlit centre/below/left/corner, both backends | `(255,209,102,255)` = `#ffd166` |
| Engine, post-fix, lit centre, both backends | `(193,158,75,255)` |
| Engine, post-fix, lit bottom edge, both backends | `(254,208,102,255)` |

Both backends agreed with each other before the fix, which is why cross-backend
parity passed while both displayed the wrong colour. The pre-fix unlit values
are the decoded-linear contents of the `#ffd166` texture written directly as
display bytes; the lit values apply the light term in linear space.

### Mechanism

A real sRGB swapchain cannot be used on this platform (probe above), so both
backends take the fallback defined for this case: one linear→sRGB encode at
fragment output.

- `packages/engine/renderer-webgpu/src/shaders/lit.wgsl.ts`: `encodeSrgb()`
  wraps the final lit colour and the unlit colour; alpha is untouched. Canvas
  format stays `bgra8unorm`. Base-colour textures keep `rgba8unorm-srgb` and
  are decoded by the sampler; there is no shader decode.
- `packages/engine/renderer-webgl2/src/shaders/forwardLit.ts`: the same helper
  wraps both `UNLIT` preprocessor branches. `rgba8unorm-srgb` maps to
  `SRGB8_ALPHA8`, so the sampler decodes textures and the shader encodes only
  the final colour.
- The encode is IEC 61966-2-1: `12.92·x` at or below 0.0031308, otherwise
  `1.055·x^(1/2.4) − 0.055`, with negative values clamped to 0.
- No frozen contract changed. `WebGpuCanvasFormat` still accepts only
  `bgra8unorm` / `rgba8unorm`; an sRGB preferred format is refused with
  `E_BACKEND_INIT` rather than silently double-encoding.

Unit coverage added (8 tests): shader output path and IEC constants in
`packages/engine/renderer-webgpu/test/abi.test.ts` (ER-04-09, ER-04-11), canvas
format selection and sRGB-format refusal in `factory.test.ts` (ER-04-09), and
the WebGL2 encode plus `SRGB8_ALPHA8` texture path in
`packages/engine/renderer-webgl2/test/abi.test.ts` (ER-05-01). Scoped checks:
23 renderer test files / 358 tests pass; `tsc -b` and `eslint` pass for both
packages; both built dists passed all browser runs below.

### Build identity

Engine build: SHA-256
`ec7533855f0712417a7c926cfd67dcc0dd25931ea0fa650fc7634f178a3541d1` over 199
built engine JS files (1,511,952 bytes). The superseded identity was
`bed149c46487770bb4e977a05f57f6444ad0e50d5ce07b2c8d662f6776de9d4f` over 135
files (959,937 bytes). Per-page builds in this re-record: WebGPU
`f133e3b77908f4db47ab4daf964c762b3d99c7bf37baf9e82de8cd6a420e11bb` (71 modules,
453,293 B) and WebGL2
`9b428497356e77fd433371f0b4e9b85118b3b518b8f05e4490cab134c690902d` (88 modules,
600,886 B).

### Re-recorded goldens

Golden runner v2: capture at frame 60 after 30 warm-up; benchmark 120 warm-up +
600 measured frames, nearest-rank percentiles. Command pattern:
`node experiments/e-m0-engine/run.mjs --scene <cube|scene5000> --instances <1|5000> --size <640x360|1920x1080> --bench 1 --backend <webgpu|webgl2> [--update-golden]`.
The eight update runs were made
with `--update-golden`; a second set of eight runs without the flag re-verified
them. All eight verification runs exited 0 with `golden.status = "matched"` and
`gpuErrors = 0`. Timings below are the values recorded in `golden.json` by the
update runs; the verify re-runs measured p50 8.3 / p95 8.4 ms (max 8.5–8.7) on
every fixture because headless rAF paced differently. Neither figure is 60 Hz
vsync evidence.

| Fixture | Spec | Backend | Golden | p50 ms | p95 ms | max ms | textureBytes |
|---|---|---:|---:|---:|---:|---:|---:|
| cube 1 instance, 640×360 | target (A.1) | WebGPU | `243224a8` | 10.0 | 10.1 | 10.9 | 922,880 |
| cube 1 instance, 640×360 | target (A.1) | WebGL2 | `243224a8` | 10.0 | 10.1 | 11.1 | 256 |
| cube 1 instance, 1920×1080 | lab fallback | WebGPU | `540a35fc` | 10.0 | 10.1 | 10.5 | 8,295,680 |
| cube 1 instance, 1920×1080 | lab fallback | WebGL2 | `540a35fc` | 10.0 | 10.1 | 10.6 | 256 |
| scene5000, 1920×1080 | target (A.2) | WebGPU | `cb91b2b4` | 10.0 | 10.2 | 10.6 | 8,295,680 |
| scene5000, 1920×1080 | target (A.2) | WebGL2 | `0883832e` | 10.0 | 10.1 | 10.8 | 256 |
| scene5000, 640×360 | lab fallback | WebGPU | `e136aeda` | 8.3 | 8.4 | 16.6 | 922,880 |
| scene5000, 640×360 | lab fallback | WebGL2 | `e136aeda` | 8.3 | 8.4 | 8.7 | 256 |

- Non-clear / bright / distinct-colour counts: cube 640×360 53,970 / 53,970 /
  7 on both; cube 1920×1080 485,769 / 485,769 / 7 on both; scene5000 1920×1080
  241,631 / 126,459 / 348 (WebGPU) and 241,633 / 126,459 / 347 (WebGL2);
  scene5000 640×360 26,953 / 14,084 / 318 on both. One draw call and 12 or
  60,000 triangles respectively; 0 GPU errors.
- WebGPU `textureBytes` includes the swapchain depth attachment (921,600 B at
  640×360, 8,294,400 B at 1920×1080); every fixture passes the runner's 12 MiB
  ceiling.
- Screenshot SHA-256: cube 640×360 both
  `5f1e38cd63fcb1ad407dcc8e5e57fdbd888d617c8c137f2dc404d580f7add8d5`
  (3,533 B); cube 1920×1080 both
  `8f57cee73d6844c7236079335505c2ad453c55ded9a5d9dee954637a5b411d2c`
  (13,461 B); scene5000 1920×1080 WebGPU
  `389094ca305a8b7aeddf95f68d0dab04deae482c69ce2b08849357b464af4530`
  (172,566 B), WebGL2
  `adfe11b31e0882bfb745094a45c0a30f99a50b7226640bd6de9612f871296c21`
  (172,574 B); scene5000 640×360 both
  `62e664b0f0703e4749da0f5f34756954ab03d1ca233aa42934987057902fa410`
  (35,865 B).
- The 640×360 cube and 1920×1080 scene5000 are the spec fixtures; the other two
  sizes are labelled lab fallbacks (`specConformant = false`) and are not target
  acceptance evidence.

### Cross-backend diff

Direct comparison of the new PNG pairs, threshold >8/255 on any channel,
allowance 2% of pixels:

| Fixture | Different pixels | Total | Percent | Max channel delta | Budget |
|---|---:|---:|---:|---:|---|
| cube 640×360 | 0 | 230,400 | 0% | 0 | pass |
| cube 1920×1080 | 0 | 2,073,600 | 0% | 0 | pass |
| scene5000 1920×1080 | 4 | 2,073,600 | 0.000193% | 86 | pass |
| scene5000 640×360 | 0 | 230,400 | 0% | 0 | pass |

The cube fixture is exact and the scene5000 spec fixture differs on 4 pixels,
the same count as before the fix (max delta rose from 37 to 86). No tolerance
was loosened.

### Why the old goldens are invalid

The old hashes — cube `32312240`, scene5000 `83a995ef` / `fc205f5d`, and the
`32312240` hash in the loss cases — were stable across backends but encoded the
uncorrected transfer function. They cannot remain pass criteria: correctly
displaying the same authored content necessarily produces a different image.
The change is deliberate and covers both backends together. It is visible in
the pixel statistics: cube bright pixels 26,884 → 53,970; scene5000 bright
pixels 14,698 → 126,459 and distinct colours 304 → 348/347. The old rows above
remain as historical evidence.

**Still PENDING:** no GPU timestamp exists (`gpuFrameMs = null`); headless rAF
was not 60 Hz-vsynced; no TV, Android or other real-hardware run was performed.
Every TV/Android row elsewhere in this file stays PENDING.

## A15 — Rapier payload (2026-10-23)

Dependency installed for the 3D physics adapter: `@dimforge/rapier3d-compat`
**0.21.0**, pinned exactly (no caret). Environment: Windows 11 Home Single
Language (10.0.26300), Node v22.14.0, npm 10.9.2. No browser was involved.

| File (installed package) | Raw bytes | gzip level 9 |
|---|---:|---:|
| `node_modules/@dimforge/rapier3d-compat/dist/rapier_wasm3d_bg.wasm` | 3,082,103 | 1,175,669 |
| `node_modules/@dimforge/rapier3d-compat/dist/rapier.mjs` | 4,340,292 | 1,644,109 |

- Version: `0.21.0` from the installed `package.json`.
- License: `Apache-2.0` (`license` field); the installed `LICENSE` file's first
  line reads `Apache License`.
- Method (run from the repo root; no network, no build):
  `node -e "const fs=require('fs'),z=require('zlib');for(const f of
  ['node_modules/@dimforge/rapier3d-compat/dist/rapier_wasm3d_bg.wasm',
  'node_modules/@dimforge/rapier3d-compat/dist/rapier.mjs']){const
  b=fs.readFileSync(f);console.log(f,'raw',b.length,'gzip9',
  z.gzipSync(b,{level:9}).length)}"`

**These are local file-size measurements, not browser transfer sizes.**
Nothing here says what a host page downloads or compiles at runtime: the
`-compat` package inlines the WASM as base64 in the ESM bundle, so a browser
fetches the JS bundle (or a bundler-produced variant), not the two files
above. No frame times, step times or hardware numbers are recorded, and
ER-07-10 (80 KB gzip physics package) and ER-07-13 stay PENDING.

**Budget consequence (recorded, not hidden):** ER-07-10 was written for a
no-Rapier package. It is amended to 80 KB gzip for the physics package JS
**excluding** the Rapier payload, ≤ 2 MiB gzip for the lazy Rapier payload,
and the unchanged ≤ 5 MB host + game total. The package-size gate stays
PENDING until the runtime imports physics.

---

## Engine bake-off — ADR-0003 input (2026-10-23)

> Measured bake-off for the engine-base decision. One row per contender/run.
> Every row is transcribed from `experiments/bakeoff/runner/results.json`
> (official shared matrix, generated `2026-10-23T06:40:26.604Z`); nothing is
> estimated. The contender-local files remain supplementary and are recorded
> below. The decision and fairness caveats are in
> [`docs/ADR-0003-engine-base.md`](ADR-0003-engine-base.md).

**Environment:** Windows 11 Home Single Language 10.0.26300 x64; Intel Core
i7-11800H (16 logical processors); 16,931,676,160 B RAM; NVIDIA GeForce RTX
3050 Ti Laptop GPU via ANGLE Direct3D11
(`ANGLE (NVIDIA, NVIDIA GeForce RTX 3050 Ti Laptop GPU (0x000025A0) Direct3D11 vs_5_0 ps_5_0, D3D11)`);
Google Chrome 155.0.8059.85 headless (`HeadlessChrome/155.0.0.0`); 1920×1080 at
DPR 1; Node v22.14.0; COOP/COEP present and `crossOriginIsolated: true` in every
official run; date 2026-10-23.

**Scene (shared contract):** 3×3 grid of 64 m cells; 14 buildings in the centre
cell; 50 skinned pedestrians; 1 car; 1 directional light with shadows and a sky;
per-cell streaming; 60 s camera path. All contenders consume the same shared
glTF assets in `experiments/bakeoff/assets/`.

**Protocol:** 5 s warm-up + 60 s sampled, 3 runs per contender, WebGPU
preferred with WebGL2 fallback. Frame intervals come from the runner's
independent **uncapped** `requestAnimationFrame` probe
(`--disable-frame-rate-limit`, `--disable-gpu-vsync`): they are render work, not
display cadence and not GPU timestamp queries. Percentiles are nearest-rank.
Cold boot is the production build measured with zlib gzip level 9 per file,
summed, source maps excluded. Draw calls, triangles and instances are the
runner's **final-frame snapshot**, not peak-scene values.

| Contender | Run | Backend | p50 ms | p95 ms | max ms | First frame ms | Draw calls | Triangles | Instances | Act / Deact | Cold boot gzip | Verdict |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| PlayCanvas 2.23.3 | 1 | — | — | — | — | — | — | — | — | — | 2,223,430 B (2.120 MiB) | **error — rAF sampler captured no frame intervals** |
| PlayCanvas 2.23.3 | 2 | webgpu | 3.745 | 13.96 | 35.355 | 794.1 | 65 | 8,658 | 20 | 30 / 29 | 2,223,430 B (2.120 MiB) | measured |
| PlayCanvas 2.23.3 | 3 | webgpu | 3.995 | 13.09 | 35.32 | 1,148.7 | 65 | 8,658 | 20 | 30 / 29 | 2,223,430 B (2.120 MiB) | measured |
| Babylon.js 9.32.0 | 1 | webgpu | 1.725 | 7.39 | 75.955 | 1,216.005 | 61 | 2,218 | 15 | 214 / 200 | 1,730,261 B (1.650 MiB) | measured |
| Babylon.js 9.32.0 | 2 | webgpu | 1.895 | 10.865 | 56.07 | 932.88 | 61 | 2,218 | 15 | 214 / 200 | 1,730,261 B (1.650 MiB) | measured |
| Babylon.js 9.32.0 | 3 | webgpu | 1.045 | 7.835 | 18.07 | 1,197.235 | 61 | 2,218 | 15 | 214 / 200 | 1,730,261 B (1.650 MiB) | measured |
| Custom (current engine) | 1 | webgpu | 0.37 | 0.735 | 32 | 823.73 | 36 | 607,970 | 160 | 64 / 0 | 1,766,889 B (1.685 MiB) | measured |
| Custom (current engine) | 2 | webgpu | 0.39 | 0.79 | 33.81 | 842.535 | 36 | 607,970 | 160 | 64 / 0 | 1,766,889 B (1.685 MiB) | measured |
| Custom (current engine) | 3 | webgpu | 0.415 | 0.845 | 19.435 | 1,102.425 | 36 | 621,714 | 162 | 64 / 0 | 1,766,889 B (1.685 MiB) | measured |

**Per-contender aggregates (measured runs only, no best-run selection):**

| Contender | p50 min / median / max ms | p95 min / median / max ms | Max frame ms | Cold boot gzip |
|---|---|---|---|---:|---:|
| PlayCanvas 2.23.3 | 3.745 / 3.87 / 3.995 | 13.09 / 13.525 / 13.96 | 35.355 | 2,223,430 B (2.120 MiB) |
| Babylon.js 9.32.0 | 1.045 / 1.725 / 1.895 | 7.39 / 7.835 / 10.865 | 75.955 | 1,730,261 B (1.650 MiB) |
| Custom (current engine) | 0.37 / 0.39 / 0.415 | 0.735 / 0.79 / 0.845 | 33.81 | 1,766,889 B (1.685 MiB) |

PlayCanvas's aggregate covers 2 measured runs; run 1 produced no frame
intervals. Babylon and custom each cover 3 measured runs.

**Notes and caveats:**

- All eight measured rows are `webgpu`, Chrome 155.0.8059.85, 2026-10-23, on
  the RTX 3050 Ti above. No software renderer was used. PlayCanvas run 1 is
  `error`, not a measurement: reason "the rAF sampler captured no frame
  intervals", runner errors "sampler did not finish within 135 s" and
  "window.__BAKEOFF__ disappeared before the final snapshot", no screenshot.
- Every measured run meets the 14 ms p95 target. PlayCanvas's two measured runs
  are 13.96 and 13.09 ms (headroom 0.04 and 0.91 ms). Babylon is 7.39 / 10.865 /
  7.835 ms (worst run 3.135 ms below target). Custom is 0.735 / 0.79 / 0.845 ms.
  PlayCanvas run 1 is a harness error, not a p95 miss.
- The earlier contender-local PlayCanvas file
  (`experiments/bakeoff/playcanvas/results.json`, generated
  `2026-10-23T05:55:16.933Z`) recorded a conflicting result: p95 15.55 / 15.345
  / 12.255 ms, p50 2.96 / 3.645 / 4.275 ms, maxima 40.58 / 56.86 / 324.28 ms,
  first frame 1,043.5 / 1,307.8 / 1,309.6 ms, 65–67 draw calls and
  8,658–8,682 triangles. The official matrix is authoritative and records
  13.96 / 13.09 ms over two measured runs. The difference is run-to-run
  variance, recorded rather than smoothed; the decision is unaffected because
  Babylon's headroom is far larger under either file.
- The end-of-run snapshots are not peak loads. PlayCanvas ended with the
  pedestrian cells streamed out: 20 instances, 65 draw calls, 8,658 triangles.
  Its separate 10 s full-active diagnostic (not an official row) recorded 70
  instances, 120 draw calls and 448,358 triangles (HUD 121 / 462,090) with p95
  8.815 ms. Babylon ended with pedestrian cells deactivated: 15 instances, 61
  draw calls, 2,218 triangles (214 activations / 200 deactivations); a 6 s
  smoke run saw `peakActivePeds: 50`, but peak draw calls and triangles were not
  measured. Custom ended with 160–162 instances, 36 draw calls and
  607,970–621,714 triangles (64 / 0). Do not compare these columns as
  peak-scene values.
- Cold boot covers the contender `dist` only. Shared scene assets are common and
  excluded. Babylon's checklist records the combined `dist` + shared-scene gzip
  as 2,137,756 B (2.04 MiB); all contender-only figures are far below the
  5,242,880 B hard budget. PlayCanvas's measured cold boot is its profiler
  build, which is larger than the normal entry; Babylon's includes 662,067 B
  gzip of Havok WASM. Custom's 1,766,889 B is its full contender build.
- WebGL2 was a forced smoke test, not a 3-run measurement: PlayCanvas reported
  97 draw calls / 269,722 triangles / 70 instances and needed `antialias: false`
  to avoid an ANGLE/D3D11 MSAA resolve error; Babylon reported 711 samples with
  p50 8.325 / p95 10.215 ms and no errors; custom's `?backend=webgl2` probe
  rendered the full city with 0 dropped draws and 0 page errors. None is a
  3-run fallback result.
- One unified run now exists: `runner/results.json` (9,381,691 B, generated
  `2026-10-23T06:40:26.604Z`) covers all three contenders from one
  serial invocation, one Chrome at a time, order PlayCanvas → Babylon → custom.
  It is not interleaved or randomised, so thermal or machine-state drift is not
  controlled. The earlier per-contender files (`playcanvas/results.json` at
  `05:55:16Z`, `babylon/results-babylon.json` at `06:13:47Z`,
  `custom/results.json` at `06:28:19Z`) are supplementary; run-to-run variance
  exists between them and the matrix.
- Audio playback is not verified for any contender: the runner uses
  `--mute-audio` and headless Chrome blocks the AudioContext before a user
  gesture. PlayCanvas's positional-audio checklist item is PENDING; Babylon's
  is PASS for wiring only; custom's is PENDING (`state: "locked"`, fixed pitch).
- Babylon's `GameContext` end-to-end integration and allocation-free operation
  are PENDING; PlayCanvas's `GameContext` PASS is a structural import-graph
  check, and its hot-path PASS is a documented substitute. Custom's
  `GameContext` item is FAILED (the page is built directly on engine packages),
  and its allocation-free item is a code-level claim with no counter.
- The custom frame time is not like-for-like. Its checklist records #4
  (directional/cascaded shadows) **FAILED** — `shadowCascades: 0`, no shadow
  maps, contact discs instead; #3 (skeletal animation) as a documented
  equivalent — CPU pose-bucket switching, not GPU skinning or weighted
  blending; #10 (`GameContext`) **FAILED**; #12 (licence) PENDING; #7 (audio)
  PENDING; #8 streaming deactivation unobserved (`deactivations: 0`); and #2
  glTF loading as static GLB only, with the car and skinned ped parsed by the
  contender's own `src/glb.js`. Its geometry is also heavier
  (607,970–621,714 end-snapshot triangles vs 2,218–8,658), so its p95 measures
  a different workload, not the same scene at a faster speed.
- The custom checklist's cold-boot per-file figures do not sum to its stated
  total: 1,395 + 1,764,018 + 9,249 + 227 = 1,774,889 B, while it states
  1,766,889 B. The matrix's per-file figures do sum correctly (227 + 9,258 +
  1,756,017 + 1,387 = 1,766,889 B); the matrix is authoritative.
- Exact build identity is the content-hashed bundle filename; no git commit hash
  is recorded in the results files. PlayCanvas `dist/assets/index-D-OM44cV.js`
  (2,180,392 B gzip); Babylon `dist/assets/index-C7XQw-5e.js` (615,949 B gzip)
  plus Havok WASM (662,067 B gzip); custom `dist/assets/index-Dx8GrSMK.js`
  (1,756,017 B gzip) plus `dist/assets/decode.worker-C_a7vKHJ.js` (9,258 B
  gzip).
- Runner-recorded non-blank source lines: PlayCanvas 1,522; Babylon 1,544;
  custom 2,981. This counts contender-folder source, not shared assets or
  engine source.

## Babylon host spike — B1 (2026-10-23)

First measured run of the host itself on the Babylon engine base (A19/ADR-0003,
spec 21). Evidence: `experiments/babylon-host/results.json`, generated
`2026-10-23T08:18:47.901Z`; screenshots `cube-webgpu.png` (71,168 B) and
`cube-webgl2.png` (70,426 B).

**Environment:** Windows 11 10.0.26300, Intel i7-11800H, NVIDIA RTX 3050 Ti
Laptop (ANGLE D3D11), Chrome HeadlessChrome 155.0.8059.85, `crossOriginIsolated:
true`. Canvas backbuffer 1920×1080 DPR 1 (emulated host viewport 1936×1200 for
the 48px stage chrome and 8px stage padding). Frame intervals come from an
independent uncapped rAF probe (`--disable-frame-rate-limit`,
`--disable-gpu-vsync`); they are not display-paced and not GPU timestamps.
Nearest-rank percentiles over one 60 s sample after a 5 s warm-up.

| Scene | Backend | Draw calls | Canvas | Samples | p50 ms | p95 ms | max ms | Errors |
|---|---|---|---:|---|---:|---:|---:|---:|---:|
| engine-cube through `GameContext` | webgpu | 3 | 1920×1080 | 335,560 | 0.15 | 0.26 | 19.055 | 0 |
| engine-cube through `GameContext`, forced fallback | webgl2 | 3 | 1920×1080 | — | — | — | — | 0 |

**Boot size (dev gate, gzip):** host 613,530 B over 58 files (dev budget
3,145,728 B, 19.5%); controller unchanged at 40,794 / 40,960 B. The lazy
Babylon path in this build is three chunks:
`babylonBindings-Bx0_kgbU.js` 773,883 B raw / 185,237 B gzip,
`createBabylonEngines-B_eK9ftf.js` 350,975 B / 87,705 B gzip and
`createBabylonRenderer-DtdPAFFV.js` 7,005 B / 2,698 B gzip. None is downloaded
by 2D games.

**What this proves and what it does not:**

- The host lifecycle, fixed loop, `GameContext`, room, layout and overlay paths
  run unchanged with Babylon drawing the frame. Three cubes are visible in both
  screenshots with 0 page errors.
- The 0.26 ms p95 is the throughput of a three-cube scene under an uncapped
  headless rAF; it is **not** a frame budget for the M1 city scene and must not
  be quoted as one. The bake-off scene (14 buildings, 50 skinned pedestrians,
  shadows) remains the comparable measurement.
- Only the cube path is wired. Assets, animation, lighting, shadows, 3D physics
  and streaming are not integrated, and no phone was connected during this run.
- The automated start used a trusted CDP mouse click and
  `--autoplay-policy=no-user-gesture-required`; neither changes rendering cost.
- The debug overlay was visible (`?debug=1`) and is included in the screenshots.
