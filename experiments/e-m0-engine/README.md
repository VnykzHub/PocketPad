# M0 engine demo — real browser render

This experiment proves the **built** engine backends can render the M0 scenes in
a real browser. It does not use a private WebGL/WebGPU path, a CDN or a bundled
framework. The page imports the same-origin dist entries:

- `/packages/engine/core/dist/index.js` (math)
- `/packages/engine/renderer-webgpu/dist/index.js`
- `/packages/engine/renderer-webgl2/dist/index.js`

Two deterministic fixtures are supported:

| Scene | Fixture | Content |
|---|---|---|
| `cube` (default) | A.1 textured cube | One 1.1-unit cube, 4x4 sRGB checker, 640x360, 1 instance |
| `scene5000` | A.2 instanced scene | 5,000 cubes in one `drawInstanced` call, 1920x1080 |

Both fixtures use the same opaque base-colour material and the fixed built-in
M0 directional light. `scene5000` is a 50-column grid with 1.5 m spacing,
`y = 0.5`, `rotationY = (i * 0.37) mod 2π`, viewed by the A.2 camera at
`(0, 70, 140)` looking at the origin (FOV 60°, near 0.1, far 500). The cube uses
its A.1 camera (FOV 45°, near 0.1, far 100). A page render is a single
`frame.drawInstanced(...)` for `scene5000` and `frame.draw(...)` for `cube`;
`scene5000` must report exactly one draw call and `instances × 12` triangles.

## Page modes and query parameters

| Parameter | Values | Default |
|---|---|---|
| `backend` | `auto`, `webgpu`, `webgl2` | `auto` |
| `scene` | `cube`, `scene5000` | `cube` |
| `instances` | `1..16384`; `cube` requires exactly 1 | fixture default |
| `size` | `WxH`, 64..8192 per axis | `640x360` (cube), `1920x1080` (scene5000) |
| `bench` | `1` or `0` | `0` |

The acceptance URL is:

```
?scene=scene5000&instances=5000&size=1920x1080&bench=1
```

A smaller count or size is accepted as a labelled fallback, but it is not
ER-04-02/ER-05-03 evidence. The page sets `fixture.conformant = false` and the
runner keeps `specConformant = false`; never present a fallback as the target
fixture.

### Golden capture

The page captures its RGBA readback at **frame 60 after 30 warm-up frames**.
This is the hash compared with `golden.json`. The page finishes at frame 60
without `bench`, or at frame 780 with `bench` (60 capture + 120 warm-up + 600
measured). The runner takes its canvas PNG after the page reports completion;
the scene is static, so it is the same frame content.

### Benchmark mode

`bench=1` records exactly **600** `requestAnimationFrame` intervals after
**120** warm-up frames. Percentiles use nearest rank:

- target: p95 ≤ 14 ms
- hard: p95 ≤ 20 ms
- status: `target-met`, `over-target-under-hard` or `hard-fail`

The result reports min/p50/p95/max, `drawCalls`, `triangles`, `instances`,
`textureBytes`, `gpuErrors`, adapter, browser, page build hash, CSS size and DPR.
The per-frame render stats are checked against the page's top-level fields.
`gpuFrameMs` is not collected by this page (`null`); `cpuFrameMs` is reported.

## Run

Node >= 20. No install step. `ws` is already hoisted at the repo root.

```bash
# A.1 cube, once per backend to record goldens, then verify
node experiments/e-m0-engine/run.mjs --backend webgpu --update-golden
node experiments/e-m0-engine/run.mjs --backend webgl2 --update-golden
node experiments/e-m0-engine/run.mjs --backend webgpu
node experiments/e-m0-engine/run.mjs --backend webgl2

# A.2 scene5000 acceptance fixture
node experiments/e-m0-engine/run.mjs --backend webgpu \
  --scene scene5000 --instances 5000 --size 1920x1080 --bench --update-golden
node experiments/e-m0-engine/run.mjs --backend webgl2 \
  --scene scene5000 --instances 5000 --size 1920x1080 --bench --update-golden
node experiments/e-m0-engine/run.mjs --backend webgpu \
  --scene scene5000 --instances 5000 --size 1920x1080 --bench
node experiments/e-m0-engine/run.mjs --backend webgl2 \
  --scene scene5000 --instances 5000 --size 1920x1080 --bench
```

Record WebGPU first, then WebGL2. The cross-backend diff reads the canonical
counterpart artifact, so the second update run compares against the first
updated artifact. To compare arbitrary runs, use the canonical output paths (or
rerun both backends for the same fixture).

The runner:

1. serves the **repository root** on `127.0.0.1:0` (never a fixed port);
2. launches headless Chrome with a fresh temporary profile and CDP;
3. sets a viewport large enough for the fixture, then sets device metrics to
   `width x height` at DPR 1;
4. opens `/experiments/e-m0-engine/index.html` with `backend`, `scene`,
   `instances`, `size` and, when requested, `bench=1`;
5. polls `window.__M0_DONE__` (no fixed sleeps) and captures the canvas PNG;
6. validates the page result, screenshot and benchmark;
7. writes the summary JSON and PNG;
8. compares the frame-60 hash with `golden.json`;
9. diffs the screenshot against the other backend's PNG for the same fixture.

Options: `--backend auto|webgpu|webgl2`, `--scene cube|scene5000`,
`--instances <n>`, `--size <width>x<height>`, `--bench`, `--chrome <path>` or
`CHROME_PATH`, `--timeout <ms>` (default 90000), `--out <json>`,
`--screenshot <png>`, `--update-golden`, `--help`.

The page needs an inline import map, so the runner rewrites that one tag with a
per-process nonce and sends a nonce-based CSP. There are no inline handlers,
styles or other inline scripts.

## Measured results

Goldens were recorded from real headless Chrome runs on 2026-10-22. The
verification runs below were rerun on 2026-10-23 **without** `--update-golden`;
both exited 0 with `golden.status = "matched"`. Their JSON and PNGs are the
canonical artifacts listed below.

Environment:

- Windows 11 Home Single Language 10.0.26300; host OS/Chrome matches the
  recorded `pc-win11-rtx3050` named-desktop baseline.
> **Historical values below (pre-RV-76).** The sRGB output correction re-recorded
> every cube/scene5000 golden. Current hashes and timings are in
> `docs/RESULTS.md` → “Engine M0 — sRGB output correction and golden re-record
> (RV-76)”: cube 640 `243224a8` on both backends; scene5000 1920p
> `cb91b2b4` (WebGPU) / `0883832e` (WebGL2). The tables in this file are kept as
> the pre-fix record and are not acceptance evidence.

- Headless Chrome CDP version `Chrome/155.0.8059.85`; page UA
  `HeadlessChrome/155.0.0.0`.
- Adapter strings: `nvidia ampere` (WebGPU), `webgl2 | WebKit WebGL` (WebGL2).
  The page does not report the exact GPU model.
- DPR 1 for every run below.
- `engineBuildHash` for both fixtures/backends:
  `bed149c46487770bb4e977a05f57f6444ad0e50d5ce07b2c8d662f6776de9d4f`
  (SHA-256 over 135 built `.js` files / 959,937 bytes under `packages/engine`).

These are desktop headless-Chrome measurements. TV, Android and any acceptance
row that requires a person-run session remain PENDING.

### A.2 scene5000 — 5,000 instances at 1920x1080

| Field | WebGPU | WebGL2 |
|---|---|---|
| golden hash | `83a995ef` | `fc205f5d` |
| drawCalls | 1 | 1 |
| triangles | 60,000 | 60,000 |
| instances | 5,000 | 5,000 |
| textureBytes | 8,295,680 | 256 |
| gpuErrors | 0 | 0 |
| nonClearPixels (frame 60) | 241,631 | 241,633 |
| distinctColors (frame 60) | 304 | 304 |
| rAF intervals | 600 | 600 |
| min / p50 / p95 / max (ms) | 9.0 / 9.2 / 10.1 / 10.2 | 9.0 / 9.3 / 10.2 / 10.7 |
| budget status | `target-met` | `target-met` |
| CSS size / DPR | 1920x1080 / 1 | 1920x1080 / 1 |
| framesRendered | 780 | 780 |
| golden status | `matched` | `matched` |

Cross-backend pixel diff:

- total pixels: 2,073,600; differing pixels: **4**; difference:
  **0.000193%**; maximum channel delta: **37**;
- rule: a pixel differs when any RGBA channel delta is > 8/255; allowed
  differing fraction is 2%; **within budget**;
- same repository `engineBuildHash` on both sides;
- per-backend pixel hashes and per-backend loaded-module hashes are recorded but
  **never compared**. The differing hashes `83a995ef` / `fc205f5d` are not a
  parity failure.

Canonical evidence:

- `artifacts/scene5000-5000-1920x1080/webgpu.json`
- `artifacts/scene5000-5000-1920x1080/webgpu.png` — 165,984 bytes, SHA-256
  `9d4c04afe1c794d131fb83c11dad437b3fccb0cbd36e169439a32d8c486737e7`
- `artifacts/scene5000-5000-1920x1080/webgl2.json`
- `artifacts/scene5000-5000-1920x1080/webgl2.png` — 165,992 bytes, SHA-256
  `64ef1b1dbf6236ff771aa57e54487574cf7c87d6f1e63209d873c8d9c1e54a53`

Both screenshots are 1920x1080, 8-bit RGB PNGs and show the full grid.

### A.1 cube — 640x360

| Field | WebGPU | WebGL2 |
|---|---|---|
| golden hash | `32312240` | `32312240` |
| drawCalls | 1 | 1 |
| triangles | 12 | 12 |
| instances | 1 | 1 |
| textureBytes | 922,880 | 256 |
| gpuErrors | 0 | 0 |
| nonClearPixels | 53,970 | 53,970 |
| distinctColors | 7 | 7 |
| framesRendered | 60 | 60 |
| golden status | `matched` | `matched` |

The screenshots are byte-identical: both are 3,553 bytes with SHA-256
`97a9ad5558a8f768bfa95c340346e7d13cf934197a67b01b810d8d055419484f`.
Cross-backend pixel diff: 0 of 230,400 pixels differ (0%), maximum channel delta
0. The stale WebGL2 blue-only/material-block claim in the previous README is
not reproducible on the current engine build; do not repeat it.

### Benchmark interpretation

The p50 values of about 9.2–9.3 ms show that headless Chrome was running rAF at
roughly 108 Hz during these runs. That is a real measurement of the requested
rAF interval, but it is not evidence of 60 Hz frame pacing. The p95 target is
met on this host; results do not transfer to another GPU, OS, browser or to a
TV/Android target without a new run.

## Known engine caveats found by this demo

### WebGPU `textureBytes` exceeds the A.2 expected value

A.2 expects `textureBytes ≤ 1 MiB`. WebGPU reports **8,295,680 bytes** at
1920x1080. This is a real renderer statistic, not a fabricated value:

- `WebGpuDevice.ensureDepth` creates a `swapchain-depth` `depth24plus` texture
  at the surface size and adds `width × height × 4 = 8,294,400` bytes to
  `stats.textureBytes`;
- the built-in 1x1 white texture contributes 256 bytes;
- the 4x4 checker is accounted at its 256-byte row stride (1,024 bytes) rather
  than its 64 logical bytes.

The material texture itself is only 64 bytes. The 128 MiB hard texture budget is
met, but `acceptance.textureBytesWithinSpecExpected` is **false** for WebGPU.
Until the owning renderer/spec decides whether swapchain depth belongs in the
asset-facing `textureBytes` statistic, do not claim full A.2 expected-stat
conformance on WebGPU. The functional render, one draw call, performance and
pixel parity pass independently. WebGL2 reports 256 bytes and passes the 1 MiB
expected check.

### Texture usage mismatch

Data-backed textures disagree between the backends:

- WebGPU's validator requires `copy-dst` in `TextureDesc.usage` when `data` is
  supplied.
- WebGL2 M0 rejects every usage except `sample`; passing `copy-dst` raises
  `E_UNSUPPORTED_FEATURE`.

The demo therefore passes `["sample", "copy-dst"]` to WebGPU and `["sample"]` to
WebGL2, and records the backend-specific usage. This is a real engine
inconsistency for the owning renderer specs to resolve.

### Fixed light and perspective conventions

There is no public light API. Both shaders contain one fixed directional light;
the page reports `light.kind = "built-in-directional"` and
`configurable: false`.

The backends use `mat4PerspectiveWebGPU` and `mat4PerspectiveWebGL2`
respectively. Their perspective conventions differ, which is why per-backend
hashes differ. The measured pixel diff above is the parity evidence; hashes are
never compared across backends.

### Headless Chrome diagnostic

WebGPU emits the known warning that `powerPreference` is ignored on Windows.
It is recorded in `diagnostics` and is not a blocker.

## Golden rules

- `golden.json` is version 2. Fixtures are keyed by
  `"<scene>|<instances>|<width>x<height>"`.
- Each fixture records `scene`, `sceneKey`, `instances`, `width`, `height`,
  `specConformant` and a `backends` object with one entry per backend.
- Each backend entry contains the frame-60 hash, non-clear/bright pixel counts,
  distinct colours, drawCalls/triangles/instances, textureBytes, gpuErrors,
  adapter, Chrome version, browser, DPR, page buildHash, repository
  engineBuildHash, capture frame, optional benchmark summary and `recordedAt`.
- `golden.json` is written **only** by a successful real run with
  `--update-golden`, after every validation passes. Never hand-write or copy a
  hash.
- No golden for a backend is a **failure**, not a pass. Record it with
  `--backend <backend> --update-golden` for the exact fixture.
- A golden is machine-, Chrome-, DPR-, driver- and build-specific. Re-record it
  when any of those change; do not weaken a check to make an old hash pass.
- Running without `--update-golden` must report `golden.status = "matched"` and
  exit 0.
- The page build hash covers the engine JS modules that backend actually loaded,
  so it legitimately differs between WebGPU and WebGL2. It is provenance only.
  Cross-backend comparability uses the runner's repository-wide
  `engineBuildHash` over all built engine JS files. Neither hash is compared
  across backends as a pixel check.

## Cross-backend pixel diff

The runner compares the current canvas PNG with the canonical counterpart PNG
for the same fixture only. It requires the counterpart summary to be `ok: true`,
the same `scene` and `instances`, and the same CSS size. It then:

- decodes both PNGs with a dependency-free decoder supporting 8-bit
  greyscale/RGB/greyscale-alpha/RGBA, non-interlaced, all standard filters;
- marks a pixel as different when any RGBA channel differs by more than 8/255;
- allows at most 2% of pixels to differ;
- records the maximum channel delta and differing percentage.

Statuses are `compared`, `build-mismatch`, `size-mismatch`, `stale-counterpart`,
`invalid-counterpart`, `not-available`, `no-current-capture` or `error`. A
size mismatch or a `compared` result over budget is a parity failure and exits
1 when the functional run passed. A build mismatch or missing counterpart means
parity is **not established** (`crossBackendParityPass = null`); do not report
it as a pass. Hashes are recorded but not compared.

## Artifact layout

- Cube default: `artifacts/<backend>.json` and `artifacts/<backend>.png`.
- Other fixtures:
  `artifacts/<sceneKey>-<instances>-<width>x<height>/<backend>.json` and
  `.png`.
- `--out` and `--screenshot` override the write paths. The cross-backend diff
  still reads the canonical counterpart path, not an overridden path.

## What counts as a pass

All of the following are required, per backend:

- `window.__M0_DONE__ === true` and `window.__M0__.ok === true`;
- schema `m0-engine-demo/v2`; the returned backend is `webgpu` or `webgl2` and,
  when a specific backend was requested, matches it;
- scene, sceneKey and instance count match the requested fixture;
- canvas CSS size matches, DPR is 1, and backing size is CSS size × DPR;
- capture frame is 60 after 30 warm-up frames;
- `framesRendered` is exactly 60 without `bench` and exactly 780 with `bench`;
- exactly 1 draw call, exactly `instances × 12` triangles, and the requested
  instance count;
- finite `textureBytes` no greater than the 128 MiB hard budget;
- `gpuErrors === 0`;
- adapter, browser and a 64-hex page build hash are present, and the build
  hash covered at least one engine module with positive byte count;
- at least `max(1000, 1% of backing pixels)` non-clear pixels and at least
  2 distinct colours (a flat canvas is not a pass);
- a base-colour texture was created and a light is reported;
- a valid PNG screenshot exists and its decoded dimensions equal the backing
  size;
- the frame-60 hash matches `golden.json` (or was recorded with
  `--update-golden`).

With `--bench` additionally:

- `warmupFrames === 120`, `measuredFrames === 600`, exactly 600 finite,
  ordered intervals;
- min ≤ p50 ≤ p95 ≤ max;
- the budget status matches the measured p95 and the 14 ms / 20 ms thresholds;
- per-frame render stats are consistent across all 600 measured frames;
- the benchmark fields are mirrored at the top level of the result.

Brightness is deliberately not a gate. Content coverage, more than one colour,
the golden hash and the screenshot are the blank/failure evidence. A missing
page, a page that is still running, a blank canvas, a failed page, a missing or
stale golden, or an invalid screenshot is never a pass. The runner exits
non-zero and the page shows a red failure state with the exact stage and error.

## Files

| File | Purpose |
|---|---|
| `index.html` | CSP-safe page: canvas, backend selector, status panel, import map |
| `styles.css` | External stylesheet (no inline styles), including the wide-stage layout |
| `main.js` | Real device/scene/render/capture/benchmark/readback path |
| `run.mjs` | Repo-root server + headless Chrome + CDP + validation + golden + pixel diff |
| `golden.json` | Version 2 per-fixture, per-backend hashes from real runs (generated) |
| `artifacts/` | Result JSON and canvas PNGs, per fixture and backend (generated) |
