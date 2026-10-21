# D1 — Device Probes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Steps use checkbox syntax.
>
> **Goal:** Measure what the real TV browsers can do (E1), how much memory they have (E2), how fast they render (E3), and whether an HTTPS page can reach a LAN WebSocket (E14) — before committing to a renderer or budgets.
>
> **Architecture:** Standalone probe pages under `experiments/`, served by the D0 dev server at `/x/<id>`. Results are recorded by hand in `docs/RESULTS.md`; nothing is uploaded or persisted (SR-7).
>
> **Tech stack:** Raw DOM/WebGL2/Web Audio/WebSocket in experiment pages; Vite build output; no game runtime, no Three.js (E12 decides the renderer later).
>
> **Spec:** `SPEC.md` §12, §14 D1, §19 caveats, §20 E1/E2/E3/E14, §22 items 1 and 6.
>
> **Program position:** Phase 1, immediately after D0. D2/D3 must not start until E1–E3 are recorded. A failed E1 changes the D3 renderer target before any renderer code exists.

## Global constraints

- Probes run in the TV/phone browser, not Node.
- No analytics, no uploads, no cookies, no PII (SR-7). Results are transcribed manually into `docs/RESULTS.md`.
- Probe pages must be safe to crash: E2 allocates until failure; it must warn before starting and never auto-run on page load.
- Record device, OS, browser version and exact numbers for every result. "Looks fine" is not a result.
- iOS is out of v1 scope (A5); do not schedule iOS runs. The probe page may still be opened on iOS without blocking.
- `experiments/` is not shipped to production.

## Stage goal and exit criteria

**Exit criteria (§14 D1):**

> Findings recorded for your actual TV(s): WebGL2, memory ceiling, frame budget, WS support.

Concretely:

- [ ] `docs/RESULTS.md` has E1, E2, E3 and E14 rows for every available TV, with device/browser/version/numbers.
- [ ] `docs/DEVICES.md` lists the actual test devices and which §12 matrix rows are available.
- [ ] `docs/BUDGETS.md` records provisional memory, texture and frame budgets derived from E2/E3.
- [ ] A written "TV target decision" states: WebGL2 yes/no, Canvas2D fallback needed yes/no, max safe render resolution, and whether PC+HDMI is the fallback.
- [ ] If E1 fails WebGL2 or binary WebSocket, the D3 renderer plan is revised here, before D3 starts.

**Layer coverage**

| Layer | Work items |
|---|---|
| Experiments/docs | D1-EXP-01..05, D1-DOC-01 |
| Host runtime | D1-EXP-02..04 (probe pages only; no runtime engine) |
| Tools/CI | D1-BUDGET-01 |
| QA | D1-QA-01 |

**Goals advanced:** G3 (memory/frame envelope), G6 (TV-only feasibility), G7 (measured dependency decisions), G2 (frame-time baseline).

---

## Work items

### D1-EXP-01 — Experiment host and results template

| Field | Value |
|---|---|
| Layer | Experiments/docs |
| Spec | §20, §10 (`experiments/`, `/x/<id>`), §14 D1 |
| Depends on | D0-SRV-01 |
| Unblocks | D1-EXP-02..05 |
| Deliverables | `experiments/index.html`, `experiments/e01/index.html`, `experiments/shared/probe.ts`, `experiments/shared/report.ts`, `docs/RESULTS.md`, `docs/RESULTS-TEMPLATE.md` |

**Behavior**

- `/x/` lists all probes with a one-line description and a link.
- Each probe page has: a title, a "Run" button (no auto-run), a results table, and a "Copy JSON" button.
- `experiments/shared/report.ts` formats a result object into a readable table and a JSON block; no network calls.
- `docs/RESULTS.md` is the only record; the page shows the exact JSON to paste into it.

**Steps**

- [ ] Create the experiments index and shared probe/report helpers.
- [ ] Add the dev-server route fallback for `/x/<id>` if D0's static route needs it (D0 already routes `/x/*`).
- [ ] Add `docs/RESULTS-TEMPLATE.md` with the row format:
  ```md
  | E1 | 2026-10-21 | Sony Bravia X75 2020 | Android TV 10 | Chromium 92 | 1080p, Game Mode off | WebGL2 yes, maxTex 8192, ... | PASS | ... |
  ```
- [ ] Add an experiment page that intentionally throws a `WebGL2` context error to verify the failure display is readable.
- [ ] Ensure the pages build with the existing Vite setup; no new runtime dependency.

**Acceptance**

- [ ] `/x/` lists E1, E2, E3, E14.
- [ ] No probe runs until the user presses Run (E2 especially).
- [ ] Results can be copied without devtools.
- [ ] The template is filled with synthetic values, not production data.

**Tests (tagged)**

- `[E1] experiments index links every planned probe`
- `[SR-7] probe pages make no network requests except the dev server`
- `[FR-12.1] probe reports capabilities by feature detection, not UA`

**Anti-rework**

- Probe pages never import `packages/runtime`; they measure the browser, not our engine.
- The report format is stable so later probes (E5/E7/E8) can reuse it.

**Risks**

- TV browsers may lack ES2020 features; compile probes to ES2019 for D1 only and note it.
- Very old browsers may not load the page at all; record that as an E1 failure, not a code bug.

---

### D1-EXP-02 — E1: TV browser capability probe

| Field | Value |
|---|---|
| Layer | Experiments/docs |
| Spec | §20 E1; §12; FR-12.1; §22 item 6 |
| Depends on | D1-EXP-01, D0-SRV-03 (binary WS echo) |
| Unblocks | D3-RT-02, D1-BUDGET-01, Gate |
| Deliverables | `experiments/e01/index.html`, `experiments/e01/probe.ts` |

**What to measure**

| Capability | Method | Record |
|---|---|---|
| WebGL2 | `canvas.getContext("webgl2")` | yes/no, context attributes |
| Max texture size | `gl.getParameter(gl.MAX_TEXTURE_SIZE)` | integer |
| Compressed formats | Extensions `WEBGL_compressed_texture_astc`, `_etc`, `_etc1`, `_s3tc`, `EXT_texture_compression_bptc` | list |
| Web Audio | `AudioContext` construct + state after a click | running/suspended/failed |
| Binary WebSocket | connect to `/ws`, send a 26-byte `Input`, receive a 27-byte `InputFwd` (host echo) | pass/fail, round-trip ms |
| WebRTC presence | `typeof RTCPeerConnection` (presence only; not used in v1) | yes/no |
| rAF rate | 120 frames, mean interval | Hz |
| Wake Lock | `"wakeLock" in navigator` | yes/no |
| Device memory | `navigator.deviceMemory` | GB or unknown |
| Hardware concurrency | `navigator.hardwareConcurrency` | integer |
| Screen/DPR | `screen.width/height`, `devicePixelRatio` | values |
| UA string | `navigator.userAgent` | recorded, never used for capability |

**Steps**

- [ ] Build the probe with the table above; run each check in a `try/catch` and record errors.
- [ ] Use a visible "Run all" button; Web Audio requires a user gesture, so run it from the click handler.
- [ ] For binary WS, connect to the same origin `/ws`, join a room created by `POST /api/rooms` (via a test controller flow), send Input, and have the host echo `InputFwd`. If the host is hard to automate on a TV, add a temporary dev-only echo endpoint `/x/ws-echo` that echoes the same frame type; record which path was used.
- [ ] Record extension support exactly; do not infer KTX2 support from ASTC alone (the Basis transcoder may still be needed).
- [ ] Add a copyable JSON result and a human table.
- [ ] Run on every TV in `docs/DEVICES.md`; if a TV browser has no WebGL2, record the friendly fallback decision.

**Acceptance**

- [ ] E1 row exists per TV with all fields above.
- [ ] Pass criterion: WebGL2 **and** binary WebSocket present.
- [ ] If either fails, a written decision in `docs/BUDGETS.md` or `docs/RESULTS.md` states the fallback (Canvas2D only, PC+HDMI, or drop the TV).
- [ ] No UA-based capability decisions are made in code (FR-12.1).

**Tests (tagged)**

- `[E1] WebGL2 presence is detected without UA sniffing`
- `[E1] binary websocket round-trip is measured`
- `[E1] compressed texture extensions are listed`
- `[FR-12.1] capability probe uses feature detection`
- `[G6] TV-only viability is recorded`

**Anti-rework**

- E1 results feed D3-RT-02's capability gate and texture strategy; do not hard-code a texture format before this row exists.
- The probe is throwaway; do not import it into the runtime.

**Risks**

- Some TV browsers report WebGL2 but fail on real shaders; E3 catches that.
- Binary WebSocket support may exist but be slow; record round-trip and frame rate, not just a boolean.

---

### D1-EXP-03 — E2: memory ceiling probe

| Field | Value |
|---|---|
| Layer | Experiments/docs |
| Spec | §20 E2; PR-11.2; §19 TV memory caveat |
| Depends on | D1-EXP-01 |
| Unblocks | D1-BUDGET-01, D3-RT-02 (texture budget), Gate |
| Deliverables | `experiments/e02/index.html`, `experiments/e02/probe.ts` |

**Method**

- Warn the user: "This test allocates memory until the browser slows or crashes. Close other tabs. It may reload the page."
- Allocate `Uint8Array` blocks in 32 MB steps; touch every page (`fill` or a stride write) to force commit; keep references in an array.
- Between steps, measure a fixed rAF benchmark (e.g., 60 frames) and record frame time; stop when:
  - allocation throws;
  - frame time p95 > 3× baseline for 2 consecutive steps;
  - the page reloads/crashes (record the last successful step).
- Separately allocate WebGL textures (1024×1024 RGBA) in steps and draw them; stop on context loss.
- Report: last stable JS heap MB, last stable texture MB, total estimated, and the failure mode.

**Steps**

- [ ] Implement the allocation loop with a visible stop button and a running log.
- [ ] Use `performance.now()` around a fixed render; record baseline before allocation.
- [ ] Handle `webglcontextlost` and record it.
- [ ] Provide a "safe mode" that stops at 512 MB for quick sanity runs.
- [ ] Run on each TV with Game Mode on and off (frame time differs); record both.
- [ ] Set budgets at 70% of the measured stable limit (PR-11.2), not at the crash point.

**Acceptance**

- [ ] E2 row records: stable JS MB, stable texture MB, failure mode, baseline frame ms.
- [ ] `docs/BUDGETS.md` sets `textureMemoryMB` and `hostMemoryMB` at 70% of the measured stable limit.
- [ ] No production hard-fail memory number is set before this row exists (PR-11.2).
- [ ] The probe is not run automatically and does not upload anything.

**Tests (tagged)**

- `[E2] memory probe stops at the first unstable step`
- `[PR-11.2] budgets are set from the measured limit, not guessed`
- `[G3] texture memory budget is derived from E2`
- `[SR-7] memory results stay on the device`

**Anti-rework**

- E2's numbers feed D3's dynamic-resolution floor and P6's streaming budgets; store them in `docs/BUDGETS.md` as named constants so code and docs agree.
- Do not treat the crash point as the budget; 70% is the rule.

**Risks**

- A TV may OOM the whole browser or the OS; that is a valid result. Record the last stable step.
- `deviceMemory` is coarse and not a substitute for this measurement.

---

### D1-EXP-04 — E3: TV render benchmark

| Field | Value |
|---|---|
| Layer | Experiments/docs |
| Spec | §20 E3; PR-9.1, PR-9.6, PR-9.7; §14 D1 |
| Depends on | D1-EXP-01, D1-EXP-02 (WebGL2 confirmed) |
| Unblocks | D3-RT-02, D3-RT-07, D1-BUDGET-01, Gate |
| Deliverables | `experiments/e03/index.html`, `experiments/e03/bench.ts` |

**Scenes** (raw WebGL2, no Three.js)

1. 1,000 instanced quads, one texture atlas.
2. 5,000 instanced quads.
3. 10,000 instanced quads.
4. 1,000,000 triangles static mesh.
5. 1 texture atlas (2048×2048) sampled across all instances.

Run each scene for 10 seconds at 1280×720 and 1920×1080, DPR 1. Record frame time p50/p95, FPS, draw calls, and GPU memory estimate.

**Steps**

- [ ] Write a minimal instanced-quad shader and a static mesh path; no framework.
- [ ] Use `EXT_disjoint_timer_query_webgl2` if available for GPU time; otherwise wall-clock rAF.
- [ ] Warm up 2 seconds before measuring; discard the first 30 frames.
- [ ] Display a live table and a copyable JSON result.
- [ ] Run with TV Game Mode on and off; record both (display lag is E6, but frame pacing differs).
- [ ] Record whether the browser throttles rAF when the tab is not focused/fullscreen.

**Acceptance**

- [ ] Pass criterion: ≥ 30 fps at 720p with 1k+ instances.
- [ ] E3 rows include each scene, resolution, p50/p95, draw calls.
- [ ] If the pass criterion fails, the D3 renderer target and scene complexity are revised in writing.
- [ ] No Three.js is added to the experiment; E12 owns the renderer comparison.

**Tests (tagged)**

- `[E3] instanced benchmark measures p50 and p95 frame time`
- `[E3] 720p 1k instances meets or misses the 30 fps criterion`
- `[PR-9.1] draw calls are counted per frame`
- `[PR-9.7] frustum culling is not assumed; benchmark records visible instances`

**Anti-rework**

- E3 measures the device, not a library. D3's renderer decision (E12) uses these numbers plus bundle size.
- Store the scene definitions as data so D3 can reuse the benchmark for regression.

**Risks**

- Raw WebGL2 is more code than a Three.js scene; keep it minimal and throwaway.
- TV browsers may cap rAF at 30 Hz; record the cap rather than treating it as a bug.

---

### D1-EXP-05 — E14: mixed content and private-network reachability

| Field | Value |
|---|---|
| Layer | Experiments/docs |
| Spec | §20 E14; §4.4; §18 |
| Depends on | D0-SRV-01, an HTTPS tunnel (`cloudflared` or `ngrok`) |
| Unblocks | Gate; confirms the dev/prod split assumption |
| Deliverables | `experiments/e14/index.html`, `docs/RESULTS.md` row |

**Method**

- Serve the dev server on the LAN.
- Open the HTTPS tunnel URL for `/x/e14` (e.g. `cloudflared tunnel --url http://localhost:8080`).
- From the HTTPS page, attempt:
  1. `new WebSocket("ws://<LAN-IP>:8080/ws")`;
  2. `fetch("http://<LAN-IP>:8080/healthz")`;
  3. `new WebSocket("ws://localhost:8080/ws")` (control).
- Record which attempts are blocked, the console error, and the browser/version.
- Repeat on Android Chrome and desktop Chrome. iOS is not required (A5).

**Steps**

- [ ] Build the E14 page with three buttons and a result table; no auto-run.
- [ ] Run the tunnel and record the exact commands in `docs/RESULTS.md`.
- [ ] Record the secure-context rules observed (mixed content, private network access).
- [ ] If the result contradicts the spec's assumption, write a decision note before D2/D3.

**Acceptance**

- [ ] E14 row per browser with blocked/allowed per attempt.
- [ ] The spec's LAN-direct removal is either confirmed or flagged as wrong.
- [ ] No production code depends on this result yet.

**Tests (tagged)**

- `[E14] HTTPS page cannot open ws:// to a LAN IP`
- `[E14] HTTPS page cannot fetch http:// to a LAN IP`
- `[FR-4.3] the dev/prod split remains config-driven regardless of E14`

**Anti-rework**

- This is a one-off verification; do not build a tunnel into the app.
- Tunnel usage for gyro tests is documented in D6-DOC-01, not here.

**Risks**

- Tunnel providers may block WebSockets or inject headers; use the raw tunnel URL and record the provider/version.
- Corporate/hostel networks may block the tunnel; record the network.

---

### D1-DOC-01 — Device inventory and results recording protocol

| Field | Value |
|---|---|
| Layer | Docs/experiments |
| Spec | §12, §20, §22 Q1/Q2; §14 D1 |
| Depends on | D1-EXP-02..05 |
| Unblocks | D1-BUDGET-01, D1-QA-01, Gate |
| Deliverables | `docs/DEVICES.md`, `docs/RESULTS.md` (populated), `docs/RESULTS-TEMPLATE.md` |

**`docs/DEVICES.md` contents**

| Field | Example |
|---|---|
| Role | TV / phone / desktop / fallback |
| Brand + model | Sony Bravia X75 |
| Year | 2020 |
| OS | Android TV 10 |
| Browser + version | Chromium 92 |
| Renderer | WebGL2 / Canvas2D fallback |
| Network | 5 GHz Wi-Fi / Ethernet |
| Game Mode | on/off |
| Available? | yes/no |

Also record the router model/band, AP isolation status, and whether phone→PC LAN reachability works (this is the §19 caveat).

**Steps**

- [ ] Create `docs/DEVICES.md` and fill in every device actually available. Do not invent devices.
- [ ] Mark unavailable §12 rows as "not tested" rather than pass/fail.
- [ ] Record the TV's exact browser version from the E1 page; do not infer from the model.
- [ ] Record whether PC+HDMI is available as the fallback (§22 Q2).
- [ ] Link each device row to its E1/E2/E3 results.

**Acceptance**

- [ ] Every result row names a device that exists in `DEVICES.md`.
- [ ] Unavailable devices are explicitly marked, not omitted silently.
- [ ] The fallback decision (PC+HDMI) is recorded.

**Tests (tagged)**

- `[G6] actual TV devices are inventoried before the renderer is chosen`
- `[E1] every E1 result maps to a device row`

**Anti-rework**

- The device matrix is reused by P5 beta; use stable IDs (e.g. `tv-sony-x75-2020`).
- Results are append-only; never overwrite a past measurement.

**Risks**

- TV browser versions auto-update; record the version and date with every run.

---

### D1-BUDGET-01 — Provisional budgets from E1–E3

| Field | Value |
|---|---|
| Layer | Tools/CI + docs |
| Spec | §11, PR-11.2, PR-9.2, NR-6.1; §14 D1 |
| Depends on | D1-EXP-02, D1-EXP-03, D1-EXP-04 |
| Unblocks | D3-RT-02, D3-RT-07, GATE-PERF-01 |
| Deliverables | `docs/BUDGETS.md`, `tools/size-budget/budgets.json` (if host targets change) |

**Record**

```md
| Budget | Value | Source | Confidence |
|---|---|---|---|
| TV max texture size | 8192 | E1 | measured |
| Texture memory | 89 MB | E2: 128 MB stable × 0.7 | measured, 70% rule |
| Host memory | 210 MB | E2: 300 MB stable × 0.7 | measured, 70% rule |
| Min render resolution | 720p | E3: 30 fps at 720p | measured |
| Render scale floor | 60% | spec default, adjusted after E2 | provisional |
| Frame budget p95 | 16.7 ms (60 Hz) / 33.3 ms (30 Hz TV) | E3 | measured |
| Controller JS | 60 KB hard | spec | fixed |
| Host JS | 5 MB hard | spec | fixed |
```

**Steps**

- [ ] Write `docs/BUDGETS.md` with a value, source, confidence and date for every budget.
- [ ] Apply the 70% rule to every measured memory limit (PR-11.2).
- [ ] If E3 shows a 30 Hz display cap, record that the frame budget is 33.3 ms for that device class.
- [ ] Update `tools/size-budget/budgets.json` only if E1–E3 change the host/controller byte budgets; do not invent new hard caps.
- [ ] Mark every number as `measured`, `provisional`, or `spec-fixed`.
- [ ] Link the Gate checklist (GATE-PERF-01) to this file.

**Acceptance**

- [ ] No budget is marked `measured` without a matching `RESULTS.md` row.
- [ ] Memory budgets are ≤ 70% of the E2 stable limit.
- [ ] The D3 plan can read one file and know the render target, texture budget and resolution floor.

**Tests (tagged)**

- `[PR-11.2] memory budgets are set at 70% of the measured ceiling`
- `[PR-9.2] texture memory budget has an E2 source`
- `[G3] host and controller byte budgets remain under spec hard caps`
- `[E3] frame budget is derived from the measured device capability`

**Anti-rework**

- `docs/BUDGETS.md` is the single source for memory/frame numbers; code imports named constants from a generated `budgets.ts` only if the build needs them.
- Do not encode a TV model into runtime code; budgets apply to a device class, with per-device caps in docs.

**Risks**

- E2 can vary run to run; record range and use the conservative end.
- A TV's Game Mode changes frame pacing, not GPU capability; record both.

---

### D1-QA-01 — Device matrix checklist template

| Field | Value |
|---|---|
| Layer | QA/docs |
| Spec | §12, §16 ("Device matrix: manual checklist per section 12 each stage") |
| Depends on | D1-DOC-01 |
| Unblocks | every later stage's device checks; P5 beta |
| Deliverables | `docs/DEVICE-MATRIX.md` |

**Contents**

A checklist per §12 row, with columns: Device ID, Stage checked, E1, E2, E3, Controller join, Gyro, Vibration, Join < 5 s, Reconnect, Notes. Rows: Chrome desktop, Chrome Android, Android TV (Chromium), Tizen, webOS, Firefox desktop. iOS is marked **deferred (A5)** and not scheduled.

**Steps**

- [ ] Create the matrix with every §12 row, even if the device is unavailable.
- [ ] Add a "checked at stage" column so D4/D5/D6 can tick their own checks.
- [ ] Add a column for AP/client isolation (the §19 caveat).
- [ ] Link the matrix from `README.md` §9 or the Gate checklist.
- [ ] Mark iOS as deferred with a pointer to README §2.3.

**Acceptance**

- [ ] Every §12 row appears, including unavailable devices.
- [ ] iOS is explicitly deferred, not silently missing.
- [ ] The matrix is usable at D4/D5/D6 without editing its structure.

**Tests (tagged)**

- `[FR-12.1] device matrix checks are manual per browser, not UA assumptions`
- `[A5] iOS row is marked deferred`

**Anti-rework**

- The matrix is a living document; later stages append check results, they do not create a new checklist.
- Keep device IDs stable across docs.

**Risks**

- Testers may skip unavailable devices; the "not tested" state must be explicit so the Gate does not treat it as a pass.

---

## Stage exit checklist

- [ ] D1-EXP-01..05 complete.
- [ ] E1 results recorded for every available TV.
- [ ] E2 results recorded with stable limits and failure modes.
- [ ] E3 results recorded at 720p and 1080p, Game Mode on/off where possible.
- [ ] E14 results recorded for desktop Chrome and Android Chrome.
- [ ] `docs/DEVICES.md`, `docs/DEVICE-MATRIX.md`, `docs/BUDGETS.md` exist and are linked.
- [ ] The TV target decision is written: WebGL2 yes/no, fallback, resolution floor.
- [ ] No D3 renderer code has started before this checklist is complete.

## Handoff to D2/D3

- D2's controller work is unaffected by TV results except for the controller size goal; proceed with the 60 KB budget.
- D3-RT-02 must branch on E1's WebGL2 result: if absent, the friendly fallback and Canvas2D-only target replace WebGL2.
- D3-RT-07 uses D1's resolution floor and E2's memory budget for dynamic resolution.
- If E1 or E3 fails hard, stop D3 and revise the product target before writing the loop/renderer.

## Explicitly not in D1

- Three.js vs custom renderer decision (E12, D3).
- Gyro/vibration (E7/E8, D6).
- Production infrastructure (E13, D7/P0).
- iOS testing (A5).
