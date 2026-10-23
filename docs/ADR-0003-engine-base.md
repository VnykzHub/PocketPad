# ADR-0003: Engine base after the 2026-10-23 bake-off

- **Status:** **Accepted — Babylon.js 9.32.0 adopted as the engine base, based on the official shared matrix.** Supersedes [ADR-0002](ADR-0002-webgpu-engine.md)'s engine-base choice; ADR-0002's own status line is a follow-up owner edit.
- **Date:** 2026-10-23
- **Decision owner:** engine program, from the bake-off plan in [`references/decision we need.md`](../references/decision%20we%20need.md)
- **Scope:** the engine base for the host runtime: renderer, assets, animation, audio and UI/text. The phone/room platform, protocol, controller, broker/dev-server and SDK contracts stay outside this decision.
- **Related:** [`experiments/bakeoff/README.md`](../experiments/bakeoff/README.md), [`docs/RESULTS.md`](RESULTS.md) § "Engine bake-off — ADR-0003 input (2026-10-23)", [`docs/BUDGETS.md`](BUDGETS.md), [`docs/ADR-0002-webgpu-engine.md`](ADR-0002-webgpu-engine.md)

## Context

The bake-off compared three contenders on one machine on 2026-10-23:

- **A. Custom** — the current engine packages in `experiments/bakeoff/custom/`.
- **B. PlayCanvas** — `playcanvas@2.23.3` in `experiments/bakeoff/playcanvas/`.
- **C. Babylon.js** — `@babylonjs/core@9.32.0` in `experiments/bakeoff/babylon/`.

The binding contract is `experiments/bakeoff/README.md`. The scene is identical by
contract: a 3×3 grid of 64 m cells, 14 buildings in the centre cell, 50 skinned
pedestrians, one car, one directional light with shadows and a sky, per-cell
streaming, and a 60 s camera path. Every contender consumes the same shared glTF
assets from `experiments/bakeoff/assets/`.

The measurement protocol is 5 s warm-up plus 60 s sampled, three runs per
contender, 1920×1080 at DPR 1, WebGPU preferred with WebGL2 fallback, on desktop
Chrome 155.0.8059.85. Frame intervals are an independent, uncapped
`requestAnimationFrame` probe. Percentiles are nearest-rank. Cold boot is the
production build measured with zlib gzip level 9, per file, summed, source maps
excluded.

[ADR-0002](ADR-0002-webgpu-engine.md) currently selects a custom WebGPU-first
engine with a WebGL2 fallback. This ADR reopens **only the engine base**, and
only on measured bake-off evidence. It does not by itself amend `SPEC.md` or the
plan amendment register; that is a separate owner action. The custom engine code
and all platform packages stay in the tree regardless of the outcome.

## Decision rule

The governing plan and the bake-off README state the same rule:

> Adopt PlayCanvas or Babylon.js unless one of these is true:
>
> 1. Your renderer meets the frame budget (p95 14 ms at 1080p, from your own
>    `BUDGETS.md`) on the benchmark scene and both alternatives miss it.
> 2. Both alternatives have a blocking gap in the checklist below that cannot be
>    fixed with a plugin.
> 3. The bundle cost of either alternative breaks your 5 MiB gzip boot budget.

Budget anchors from `docs/BUDGETS.md`: frame-time p95 target **14 ms** at
1920×1080 (16.7 ms frame interval; 20 ms hard fail); host runtime + game boot
budget **5,242,880 B gzip (5 MiB) hard**. The rule does not rank PlayCanvas
against Babylon.js; it only triggers adoption. The ranking below is a tie-break
on the same measured criteria, not a new rule.

## Measured evidence

The official table is `experiments/bakeoff/runner/results.json`, generated
`2026-10-23T06:40:26.604Z` by one all-contender matrix run. The earlier
per-contender files are retained as supplementary evidence:

- `experiments/bakeoff/runner/results.json` — **official shared matrix**:
  PlayCanvas, Babylon and custom, three runs each, one Chrome profile per run.
- `experiments/bakeoff/playcanvas/results.json` (generated
  `2026-10-23T05:55:16.933Z`) and `experiments/bakeoff/playcanvas/CHECKLIST.md`
  — earlier PlayCanvas invocation and capability evidence.
- `experiments/bakeoff/babylon/results-babylon.json` (generated
  `2026-10-23T06:13:47.701Z`) and `experiments/bakeoff/babylon/CHECKLIST.md` —
  earlier Babylon invocation and capability evidence.
- `experiments/bakeoff/custom/results.json` and
  `experiments/bakeoff/custom/CHECKLIST.md` — **supplementary** custom evidence
  (generated `2026-10-23T06:28:19.175Z`); the matrix re-ran the same build.

### Build identity (exact hashed bundle filenames)

The recorded run files do not carry a git commit hash. The exact measured builds
are identified by the content-hashed filenames in each `dist`:

- **PlayCanvas 2.23.3:** `dist/assets/index-D-OM44cV.js` (2,180,392 B gzip), plus
  `dist/index.html` and `dist/audio/engine.wav`; total cold boot 2,223,430 B.
- **Babylon.js 9.32.0:** `dist/assets/index-C7XQw-5e.js` (615,949 B gzip), plus
  Havok WASM (662,067 B gzip) and other build files; total cold boot 1,730,261 B.
- **Custom (current engine):** `dist/assets/index-Dx8GrSMK.js` (1,756,017 B gzip)
  and `dist/assets/decode.worker-C_a7vKHJ.js` (9,258 B gzip); total cold boot
  1,766,889 B.

The custom `CHECKLIST.md` lists slightly different per-file gzip figures
(1,764,018 + 9,249 + 1,395 + 227 = 1,774,889 B) while also stating the
1,766,889 B total. The `custom/results.json` per-file figures sum to the stated
total; the checklist's per-file bytes appear to come from a later rebuild and
need correction. The hashed filenames are identical in both records.

### Environment

| Field | Value |
|---|---|
| Machine | Windows 11 Home Single Language 10.0.26300 x64 |
| CPU / RAM | Intel Core i7-11800H, 16 logical processors / 16,931,676,160 B RAM |
| GPU | NVIDIA GeForce RTX 3050 Ti Laptop GPU, ANGLE Direct3D11 (`ANGLE (NVIDIA, NVIDIA GeForce RTX 3050 Ti Laptop GPU (0x000025A0) Direct3D11 vs_5_0 ps_5_0, D3D11)`) |
| Browser | Chrome 155.0.8059.85 headless (`HeadlessChrome/155.0.0.0`) |
| Viewport | 1920×1080, DPR 1 |
| Date | 2026-10-23 |
| Node | v22.14.0 |
| Isolation | COOP/COEP present; `crossOriginIsolated: true` in every official run |
| Frame source | independent uncapped rAF probe (`--disable-frame-rate-limit`, `--disable-gpu-vsync`); not GPU timestamp queries, not display-paced |
| Percentiles | nearest-rank over sampled intervals |
| Cold boot | production build, zlib gzip level 9 per file, summed, source maps excluded |
| Runs | 3 per contender; 5 s warm-up + 60 s sampled |
| Scene | 3×3 grid of 64 m cells; 14 buildings; 50 skinned pedestrians; 1 car; 1 directional light + shadows + sky; per-cell streaming; 60 s camera path |

### Official measurements

Every row below is from the official shared matrix: Chrome 155.0.8059.85,
2026-10-23, 1920×1080 DPR 1, on the RTX 3050 Ti above. The scene counts are 3×3
cells, 14 buildings, 50 pedestrians and 1 car. Eight rows are measured
**webgpu** runs; PlayCanvas run 1 errored before producing frame intervals. The
backend column is included for the contract even though no measured run fell
back. Draw calls, triangles and instances are the runner's **final-frame
snapshot**, not peak-scene values.

| Contender | Run | Backend | p50 ms | p95 ms | max ms | First frame ms | Draw calls | Triangles | Instances | Act / Deact | Cold boot gzip | Status |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| PlayCanvas 2.23.3 | 1 | — | — | — | — | — | — | — | — | — | 2,223,430 B (2.120 MiB) | **error — sampler captured no frame intervals** |
| PlayCanvas 2.23.3 | 2 | webgpu | 3.745 | 13.96 | 35.355 | 794.1 | 65 | 8,658 | 20 | 30 / 29 | 2,223,430 B (2.120 MiB) | measured |
| PlayCanvas 2.23.3 | 3 | webgpu | 3.995 | 13.09 | 35.32 | 1,148.7 | 65 | 8,658 | 20 | 30 / 29 | 2,223,430 B (2.120 MiB) | measured |
| Babylon.js 9.32.0 | 1 | webgpu | 1.725 | 7.39 | 75.955 | 1,216.005 | 61 | 2,218 | 15 | 214 / 200 | 1,730,261 B (1.650 MiB) | measured |
| Babylon.js 9.32.0 | 2 | webgpu | 1.895 | 10.865 | 56.07 | 932.88 | 61 | 2,218 | 15 | 214 / 200 | 1,730,261 B (1.650 MiB) | measured |
| Babylon.js 9.32.0 | 3 | webgpu | 1.045 | 7.835 | 18.07 | 1,197.235 | 61 | 2,218 | 15 | 214 / 200 | 1,730,261 B (1.650 MiB) | measured |
| Custom (current engine) | 1 | webgpu | 0.37 | 0.735 | 32 | 823.73 | 36 | 607,970 | 160 | 64 / 0 | 1,766,889 B (1.685 MiB) | measured |
| Custom (current engine) | 2 | webgpu | 0.39 | 0.79 | 33.81 | 842.535 | 36 | 607,970 | 160 | 64 / 0 | 1,766,889 B (1.685 MiB) | measured |
| Custom (current engine) | 3 | webgpu | 0.415 | 0.845 | 19.435 | 1,102.425 | 36 | 621,714 | 162 | 64 / 0 | 1,766,889 B (1.685 MiB) | measured |

- Chrome 155.0.8059.85 and 2026-10-23 apply to every row. The GPU is the RTX
  3050 Ti listed above; no software renderer was used. PlayCanvas run 1 has no
  frame data: its status is `error`, reason "the rAF sampler captured no frame
  intervals", with runner errors "sampler did not finish within 135 s" and
  "window.__BAKEOFF__ disappeared before the final snapshot".
- Official aggregates, measured runs only (PlayCanvas 2 of 3, Babylon 3 of 3,
  custom 3 of 3): p95 PlayCanvas min 13.09 / median 13.525 / max 13.96 ms;
  Babylon min 7.39 / median 7.835 / max 10.865 ms; custom min 0.735 / median
  0.79 / max 0.845 ms. p50: PlayCanvas 3.745 / 3.87 / 3.995 ms; Babylon
  1.045 / 1.725 / 1.895 ms; custom 0.37 / 0.39 / 0.415 ms. All runs are
  reported; the median is not a best-run figure.
- Every measured run meets the 14 ms p95 target. PlayCanvas has 13.96 and
  13.09 ms (0.04 and 0.91 ms headroom); Babylon has 7.39 / 10.865 / 7.835 ms
  (worst 3.135 ms headroom); custom has 0.735 / 0.79 / 0.845 ms. PlayCanvas
  run 1 is a harness error, not a p95 miss. The custom p95 is uncapped render
  work on a reduced scene (no shadow maps, CPU pose buckets, no `GameContext`),
  not a like-for-like frame time.
- The earlier contender-local PlayCanvas file recorded p95 15.55 / 15.345 /
  12.255 ms over three measured runs. The shared matrix's two measured runs are
  both under 14 ms. The matrix is authoritative; the difference is run-to-run
  variance and is recorded as a fairness caveat.
- Cold boot is the contender's `dist` only. Shared scene assets fetched from
  `experiments/bakeoff/assets/` are common and excluded. Babylon's checklist
  records the combined `dist` + shared-scene gzip as 2,137,756 B (2.04 MiB).
  The contender-only figures are PlayCanvas 2,223,430 B, Babylon 1,730,261 B
  and custom 1,766,889 B, all below the 5,242,880 B hard budget.
- Runner-recorded non-blank source lines: PlayCanvas 1,522; Babylon 1,544;
  custom 2,981. This counts contender-folder source, not shared assets or
  engine source.

### Custom contender — supplementary evidence (not the official matrix)

The official matrix now has three measured custom runs (table above). The
custom contender's own earlier `custom/results.json` (generated
`2026-10-23T06:28:19.175Z`) and `custom/CHECKLIST.md` remain supplementary
evidence: the file is a second measurement of the same build, and the checklist
is the capability evidence the runner does not record. The matrix is
authoritative. The earlier local file reported p95 0.79 / 0.845 / 0.9 ms, p50
0.39 / 0.41 / 0.445 ms, maxima 55.3 / 71.84 / 35.66 ms, first frame
1,315.895–1,440.17 ms, cold boot 1,766,889 B and 32–36 draw calls / 607,970–
621,714 triangles / 160–162 instances. The matrix re-run is faster
(0.735–0.845 ms p95; 823.73–1,102.425 ms first frame). Both show the same
reduced workload.

**The custom frame time is not comparable to Babylon or PlayCanvas.** Its
checklist records:

- **#4 shadows — FAILED (engine gap).** The M0 WebGPU renderer reports
  `shadowCascades: 0`; the scene draws one directional light plus ambient and
  contact discs under the car and peds. No shadow map is rendered.
- **#3 skeletal animation — PASS (documented equivalent, not GPU skinning).**
  The renderer ABI has no joint indices/skin weights or dynamic mesh update, so
  the contender CPU-skins 16 pose buckets at boot and switches buckets per ped.
  There is no GPU skinning and no weighted cross-clip blending.
- **#10 `GameContext` — FAILED (out of scope by task).** The page is built
  directly on the engine packages and does not use the phone host or
  `GameContext`.
- **#12 licence — PENDING.** The first-party engine packages have no `license`
  field, and there is no root `LICENSE` file; the engine licence is unstated.
- **#7 audio — PENDING.** The AudioContext stays autoplay-locked in the
  headless runner; the M0 audio contract has no live playback-rate control.
- **#8 streaming — PASS (activation); deactivation unobserved.** 64 activations
  at boot, 0 deactivations in 60 s; the scripted route never leaves the centre
  neighbourhood, so the deactivation path is not exercised.
- **#2 glTF — PASS with a caveat.** The engine asset path loads static GLB
  only; the multi-mesh car and skinned ped are parsed by the contender's own
  407-line GLB reader.

The low custom p95 therefore reflects a **reduced workload**, not a faster
engine on the same scene. Do not cite it as a like-for-like win over Babylon or
PlayCanvas. Its p95 is also far below the runner's 8.33 ms display floor; it is
an uncapped render-work measurement, not a display-paced 60 Hz result.

### Checklist verdicts

The full evidence for the two alternatives is in their `CHECKLIST.md`. The
custom contender's checklist is supplementary evidence and is reported
separately after the table.

| # | Checklist item | PlayCanvas 2.23.3 | Babylon.js 9.32.0 |
|---:|---|---|---|
| 1 | WebGPU with WebGL2 fallback | **PASS** (3 official WebGPU runs; forced WebGL2 smoke) | **PASS** (3 official WebGPU runs; forced WebGL2 smoke) |
| 2 | glTF with the shared assets | **PASS** | **PASS** |
| 3 | Skeletal animation with blending or documented equivalent | **PASS (documented equivalent)** — one `walk` clip; per-instance speed | **PASS (documented equivalent)** — one `walk` clip; per-ped animation group |
| 4 | Cascaded/directional shadows | **PASS** | **PASS** (2 cascades, 1024, PCF) |
| 5 | Vehicle physics (Rapier or Havok) | **PASS** — Rapier 0.21.0 raycast vehicle | **PASS with limitation** — Havok box body, velocity/angular servo, no raycast wheels or suspension |
| 6 | Character controller or equivalent | **PASS (equivalent)** — waypoint loops | **PASS** — 50 `PhysicsCharacterController` instances |
| 7 | Positional audio | **PENDING** — API/asset loaded; audible playback not verified | **PASS (wiring)** — spatial sound attached; audible playback not verified |
| 8 | Streaming hooks, per-cell activation | **PASS** — 30 / 29 | **PASS** — 214 / 200 |
| 9 | Runs with COOP/COEP | **PASS** | **PASS** |
| 10 | Can sit behind `GameContext` without engine types in the game | **PASS** (structural import-graph check; no adapter installed) | **PENDING** — no `GameContext` harness |
| 11 | Pooled/allocation-free hot path or documented substitute | **PASS (documented substitute)** — app code pools; Rapier/PlayCanvas allocate internally | **PENDING** — no allocation profile |
| 12 | Licence compatible with a commercial browser game | **PASS** — MIT / Apache-2.0 / CC0 | **PASS** — Apache-2.0 / Havok MIT per shipped licence / CC0 |

### Custom checklist (supplementary)

| # | Checklist item | Custom verdict |
|---:|---|---|
| 1 | WebGPU with WebGL2 fallback | **PASS** — measured runs WebGPU; a separate `?backend=webgl2` probe rendered the city with zero dropped draws and zero page errors, but WebGL2 was not a measured backend |
| 2 | glTF with the shared assets | **PASS with caveat** — engine path loads static GLB; car and ped parsed by the contender's own 407-line GLB reader |
| 3 | Skeletal animation with blending or documented equivalent | **PASS (documented equivalent)** — CPU pose buckets, no GPU skinning or weighted blending |
| 4 | Cascaded/directional shadows | **FAILED** — `shadowCascades: 0`; no shadow maps, contact discs only |
| 5 | Vehicle physics | **PASS** — Rapier 0.21, 1,250 kg chassis |
| 6 | Character controller or equivalent | **PASS** — Rapier character controllers per ped |
| 7 | Positional audio | **PENDING** — AudioContext locked; fixed pitch; no audible verification |
| 8 | Streaming hooks, per-cell activation | **PASS (activation)** — 64 activations / 0 deactivations; deactivation path not exercised |
| 9 | Runs with COOP/COEP | **PASS** — `crossOriginIsolated: true` |
| 10 | Can sit behind `GameContext` | **FAILED** — page built directly on engine packages; no `GameContext` integration |
| 11 | Pooled/allocation-free hot path | **PASS (by construction)** — no allocation-counter measurement |
| 12 | Licence compatible with a commercial browser game | **PENDING** — engine packages have no `license` field and there is no root `LICENSE` |

## Applying the rule

### 1. Custom frame-budget exception — not triggered

The official custom row is measured: p95 0.735 / 0.79 / 0.845 ms, all far below
14 ms. The first half of the clause is therefore met. The second half is not: it
requires **both** alternatives to miss 14 ms. Babylon does not miss in any
measured run (7.39 / 10.865 / 7.835 ms). PlayCanvas's two measured runs also
meet it (13.96 and 13.09 ms); its run 1 is a harness error, not a p95 miss.
"Both alternatives miss it" is therefore false, and the custom exception does
not apply. The custom p95 is not like-for-like in any case: no shadow maps (#4
FAILED), CPU pose buckets instead of GPU skinning/blending (#3 documented
equivalent), and no `GameContext` integration (#10 FAILED). Its low number
reflects a reduced workload, not a faster engine on the same scene.

### 2. Blocking-gap exception — not triggered

The checklist gaps are evidence gaps and integration work, not demonstrated
blocking capability gaps, and they are not shared by both alternatives:

- PlayCanvas's only PENDING is audible positional audio (the sound component
  and asset loaded; headless Chrome blocked the AudioContext and the runner
  mutes audio). That is a verification gap, not a missing plugin-level feature.
- Babylon's PENDINGs are end-to-end `GameContext` integration (encapsulation is
  structural only) and allocation-free operation (no profiler run). Neither is
  a demonstrated engine limitation, and PlayCanvas does not share them.
- The one-clip animation and hot-path items are explicitly covered by the
  checklist's "documented equivalent" and "documented substitute" allowances.

The custom checklist's own FAILED items (#4 shadows, #10 `GameContext`) and its
PENDING licence (#12) are custom-side gaps. They do not satisfy the
blocking-gap clause either, which asks about **both alternatives**; they do mean
the custom contender is not checklist-complete.

No "blocking gap in both alternatives that cannot be fixed with a plugin" is
recorded.

### 3. Bundle exception — not triggered

PlayCanvas cold boot is 2,223,430 B gzip (2.120 MiB, and that is the larger
profiler entry needed for draw-call counters). Babylon cold boot is 1,730,261 B
gzip (1.650 MiB, including 662,067 B of Havok WASM). Both are below the
5,242,880 B hard budget. Neither alternative breaks the 5 MiB boot budget on the
measured build. The custom build is 1,766,889 B gzip; it is not an
alternative and does not affect this clause.

### Verdict

The rule **triggers adoption** of a third-party alternative: no exception is
met. The official matrix confirms the choice:
**Babylon.js 9.32.0**. Every measured run meets the 14 ms p95 target, so the
custom exception is blocked by both alternatives meeting it, not by custom
missing it. The custom p95 is lower (median 0.79 ms vs Babylon's 7.835 ms), but
it is not like-for-like (no shadow maps, no GPU skinning/blending, no
`GameContext`), so it is not evidence that the custom engine is faster on the
same workload. The rule does not name which alternative. On the official
criteria, **Babylon.js 9.32.0** is the choice:

- It has the lowest worst-case p95 among the alternatives: 7.39 / 10.865 /
  7.835 ms (worst 3.135 ms below target). PlayCanvas's two measured runs are
  13.96 and 13.09 ms (worst only 0.04 ms below target) and its third run
  errored.
- Its cold boot is 493,169 B (0.470 MiB) smaller than PlayCanvas's measured
  profiler build (1,730,261 B vs 2,223,430 B), giving more headroom inside the
  5 MiB budget.
- It produced three clean measured runs; PlayCanvas produced two measured runs
  and one sampler error. That is a reliability difference under the same
  harness, not a frame-budget miss.
- Its first-frame time is comparable to PlayCanvas's in the matrix (0.93–1.22 s
  vs 0.79–1.15 s). The rule does not use first-frame time, so this does not
  change the outcome, but it is recorded rather than omitted.

This is a tie-break on measured frame and boot budgets, not a preference. The
fairness caveats below mean the frame comparison is not a visual-parity
comparison; they do not change which recorded p95 each contender produced under
the same protocol.

## Decision

**Adopt Babylon.js 9.32.0 as the engine base for the host runtime.** The
official shared matrix (`runner/results.json`, generated
`2026-10-23T06:40:26.604Z`) records three clean Babylon runs and is the basis
for this decision. The packages measured are
`@babylonjs/core@9.32.0`, `@babylonjs/loaders@9.32.0` and
`@babylonjs/materials@9.32.0` (Apache-2.0); the bake-off also used
`@babylonjs/havok@1.3.14` for physics.

This decision does **not**:

- change the protocol, controller, broker/dev-server, room/session, layout,
  panel or haptics contracts;
- decide physics. Amendment A15 selects Rapier behind `Physics3D`; the bake-off
  used Havok. Babylon + Rapier is an integration task below, not a settled
  consequence of this ADR. Choosing Havok instead would require its own
  amendment;
- authorise deleting the custom engine packages. The bake-off plan says
  everything built so far stays in the repo;
- authorise migration code. The outline below is a plan, not an implementation
  mandate.

The decision is final for this bake-off. PlayCanvas run 1's sampler error is
recorded, not hidden; it does not flip the rule because Babylon meets the budget
and the custom exception requires both alternatives to miss. A later defect in
the custom run could invalidate the custom row, but it cannot make the custom
engine the rule's winner while Babylon meets the budget. ADR-0002's status line
still says Accepted and needs an owner update to point here.

## Fairness caveats

These are recorded so no reader treats the table as an apples-to-apples visual
or physics comparison.

1. **Uncapped rAF, not display cadence.** Chrome ran with
   `--disable-frame-rate-limit` and `--disable-gpu-vsync`; the intervals are
   compositor rAF deltas, not GPU timestamp queries and not 60 Hz vsync. The
   14 ms budget is applied to this uncapped protocol because that is the
   bake-off contract. A display-paced run sits at the runner's recorded 8.33 ms
   floor and would hide sub-floor differences. No display-paced contender run
   exists; the runner's `--capped` mode was exercised only by the harness
   self-test.
2. **PlayCanvas's official result is two measured runs plus one harness
   error.** In the shared matrix its p95 values are 13.96 and 13.09 ms (both
   under 14 ms); run 1 is an error ("the rAF sampler captured no frame
   intervals"), not a p95 miss. Its p50 is 3.745–3.995 ms and its p99 is
   16.33–16.47 ms. The earlier contender-local file recorded p95 15.55 / 15.345
   / 12.255 ms over three runs, which conflicts with the matrix; the matrix is
   authoritative and the discrepancy is unresolved. Either way, PlayCanvas has
   far less headroom than Babylon (0.04 ms vs 3.135 ms at the worst measured
   p95), so the outcome does not depend on which file is used.
3. **Babylon's scene is not PlayCanvas's scene in implementation.** Babylon's
   pedestrians do **not cast or receive shadows**, use a single `walk` clip
   (only one exists in the shared asset), and its car is a single box rigid
   body driven by velocity/angular-velocity path following, with visual wheel
   spin and no raycast wheels, suspension, tyre friction or building collision.
   PlayCanvas also disables pedestrian shadows and has the same single clip,
   but it uses a Rapier raycast vehicle with four wheels and a 1,250 kg chassis.
   PlayCanvas also drives a 12 m ring route, not the shared `layout.cameraPath`,
   because the shared polyline retraces its stem and closes with a zero-radius
   180° reversal at (0, 32) that a 20 m/s vehicle cannot follow; measured on
   the identical 704 m polyline, the car averaged 15.19 m/s with 17.562 m
   maximum lateral error. The physics and pedestrian workloads therefore
   differ.
4. **Different final active-instance snapshots.** PlayCanvas's official
   end-of-run snapshot is 20 active instances, 65 draw calls and 8,658
   triangles with the pedestrian cells streamed out. Its separate full-active
   diagnostic (not an official row) recorded 70 instances, 120 draw calls and
   448,358 triangles (HUD 121 / 462,090) with p95 8.815 ms over 10 s.
   Babylon's official end snapshot is 15 instances, 61 draw calls and
   2,218 triangles, also with pedestrian cells deactivated; a 6 s smoke run saw
   `peakActivePeds: 50` but peak draw calls and triangles were not measured.
   Custom's official end snapshot is 160–162 instances, 36 draw calls and
   607,970–621,714 triangles. The table's draw/triangle/instance columns are not
   peak-scene comparisons. PlayCanvas's full-active 120–121 draw calls are at
   or just over the engine's ≤120 draw-call target; Babylon's peak is unknown.
5. **The unified matrix now exists, but the contender-local files disagree with
   it.** `runner/results.json` (generated 2026-10-23T06:40:26.604Z) is one
   all-contender invocation and is authoritative. The earlier per-contender
   files (`playcanvas/results.json` at 05:55:16Z,
   `babylon/results-babylon.json` at 06:13:47Z, `custom/results.json` at
   06:28:19Z) came from separate `--only` invocations; they are supplementary,
   and their numbers differ run-to-run — most visibly PlayCanvas's p95. The
   matrix runs serially (one Chrome at a time, PlayCanvas → Babylon → custom),
   not interleaved or randomised, so thermal or machine-state drift is reduced
   but not controlled away.
6. **WebGL2 is a smoke test, not a 3-run measurement.** All official rows are
   WebGPU. PlayCanvas's forced WebGL2 smoke produced 97 draw calls / 269,722
   triangles / 70 instances with no errors, but it needed `antialias: false` to
   avoid an ANGLE/D3D11 MSAA resolve error
   (`glBlitFramebuffer: Invalid operation on multisampled framebuffer`) that
   otherwise produced a black canvas. Babylon's forced WebGL2 smoke produced
   711 samples with p50 8.325 / p95 10.215 ms and no errors. Custom's forced
   WebGL2 probe rendered the full city with 0 dropped draws and 0 page errors
   (`?backend=webgl2`, `probe-webgl2.png`). None is a 3-run fallback result.
7. **Audio is not audibly verified.** PlayCanvas's positional audio is PENDING:
   the asset loaded but headless Chrome blocked the AudioContext before a user
   gesture and the runner mutes audio. Babylon reports the sound wiring as
   playing, but the same mute applies. Custom's positional audio wiring is
   likewise PENDING: the AudioContext stayed autoplay-locked
   (`state: "locked"`) and playback rate is fixed. The bake-off does not
   establish audible output, audio quality or latency for any contender.
8. **Two Babylon checklist items are PENDING.** `GameContext` integration was
   not exercised end-to-end (only structural encapsulation was checked), and
   allocation-free operation was not profiled. PlayCanvas's `GameContext` PASS
   is also structural (no adapter installed), and its hot-path PASS relies on
   the documented-substitute allowance because Rapier and PlayCanvas allocate
   internally. These are migration risks, not measured capability failures.
9. **Shared asset metadata differs from the bake-off README.** The delivered
   `ped.glb` has a 65-joint rig and a 1.333333 s `walk` clip, not the README's
   1.0 s. `assets/MANIFEST.json` is stale. No contender patches the shared
   assets; the comparison uses the delivered asset.
10. **Bundle accounting is not the production game.** PlayCanvas's measured
    cold boot is the profiler build (larger than the normal entry, which lacks
    the draw-call counters). Babylon's includes Havok WASM; a Babylon + Rapier
    production build will have a different byte count. Custom's 1,766,889 B is
    its full contender build. Shared scene assets are excluded from every
    contender figure. The 5 MiB check is a contender-build check, not a full
    game check.
11. **Custom's frame number is not like-for-like.** Its scene skips the shadow
    pass entirely (#4 FAILED: `shadowCascades: 0`, no shadow maps, contact
    discs instead), substitutes CPU pose-bucket switching for GPU skinning with
    weighted blending (#3 documented equivalent), and was never integrated with
    `GameContext` (#10 FAILED); licence (#12) and audio (#7) remain PENDING and
    the deactivation path was never observed (#8). Its geometry is also heavier
    (607,970–621,714 end-snapshot triangles vs 2,218–8,658), so it is not
    like-for-like in either direction. Its p95 measures a different workload,
    not the same scene at a faster speed.
12. **No other hardware.** Every number is desktop Chrome 155 on this RTX 3050
    Ti machine. No TV, Android, iOS or other GPU was measured, and no
    display-paced contender run, GPU-timestamp run or memory-ceiling run
    exists. Do not generalize these numbers to a TV or phone target.

## Migration outline (Babylon.js adoption)

### Keep

- `packages/protocol`, `packages/broker`, `packages/dev-server`,
  `packages/controller`, and the host runtime's lifecycle, fixed loop, input
  mapper, room/session, layout, panel, events, haptics and debug paths.
- `sdk/` and the frozen `GameContext` boundary. Games keep consuming
  `GameContext`; Babylon types must not leak into game code.
- The phone/room platform, QR/join flow, protocol version, layout schema and
  security headers (COOP/COEP/CORP, Origin allowlist, CSP). No
  `PROTOCOL_VERSION` bump is expected because only host internals change.
- `Physics3D` and the Rapier decision (A15) unless a separate physics amendment
  chooses Havok.

### Replace

- The engine-track custom WebGPU and WebGL2 renderers with a Babylon backend
  behind the existing renderer contract.
- The custom asset loaders (glTF, KTX2, images, audio), skeletal animation,
  positional audio and UI/text layers with Babylon equivalents behind the
  existing asset/animation/audio/UI interfaces.
- The scene/streaming adapter with a Babylon scene adapter that preserves
  per-cell activation and the asset-manifest/licence-ledger rules.

### First three integration tasks

1. **Contract adapter and conformance.** Implement a Babylon backend behind
   `RenderBackend` / `Renderer3D`, with an engine-neutral scene adapter and no
   Babylon imports in `GameContext` or game code. Port the existing golden cube
   and scene5000 fixtures, run them on WebGPU and WebGL2, and pass the
   conformance suite. Evidence: golden parity within tolerance, `npm run check`
   green, zero protocol/schema changes.
2. **Assets, animation, audio and UI behind the existing interfaces.** Load the
   shared manifest assets through Babylon loaders; keep `assets/LICENSES.csv`
   validation and the manifest validator's refusal of unledgered assets. Port
   the skinned pedestrian with its single clip, a positional audio source and
   the HUD/text path. Evidence: asset-manifest validation, load and gzip
   accounting, COOP/COEP, and audible audio verified on a real user gesture
   (headless audio remains PENDING).
3. **M1 Block 7 slice on Babylon.** Build the city block, 50 pedestrians,
   drivable car, shadows, streaming and one mission on the Babylon backend;
   route the existing phone controller through the unchanged host input path.
   Measure three 60 s runs at 1920×1080. Evidence: p95 ≤ 14 ms target and
   ≤ 20 ms hard fail on the same protocol; peak draw calls ≤ 120; peak
   triangles/instances recorded; host + game gzip ≤ 5,242,880 B; controller
   bundle unchanged under its 61,440 B hard cap; no per-frame allocation
   regression; `GameContext` end-to-end test.

### Bundle and performance evidence required before migration is called done

- Production host + game gzip ≤ **5,242,880 B**; do not carry the 1,730,261 B
  bake-off figure forward as the game's bundle. Re-measure with the real game
  and the chosen physics payload.
- Frame p95 ≤ **14 ms** at 1920×1080 on the M1 scene, three runs, 5 s warm-up +
  60 s, uncapped rAF protocol; report p50/p95/max and every run. Also record a
  display-paced run so the 60 Hz frame-interval picture is explicit.
- Peak draw calls (≤ 120 target), peak triangles and peak active instances,
  because the bake-off snapshots are end-of-run values with pedestrians
  streamed out.
- WebGL2 3-run fallback, not a smoke test; the forced PlayCanvas MSAA
  workaround is a warning, not a migration shortcut.
- `GameContext` end-to-end integration and an allocation profile (both Babylon
  PENDING), plus the provisional memory budgets (358 MB JS heap / 128 MB
  texture) re-checked on the real scene.
- Physics evidence for Rapier behind Babylon, or a separate Havok amendment if
  the owner chooses Havok. The bake-off's Havok box-body car is not sufficient
  evidence for M1 vehicle behaviour.
- Controller budget: no Babylon/engine code in `packages/controller`; the
  controller stays under its existing hard cap (61,440 B gzip).

## What would change this conclusion

| Trigger | Effect |
|---|---|
| The custom row meets p95 ≤ 14 ms **and** a same-protocol Babylon re-run misses 14 ms (so both alternatives miss) | The custom exception applies; revisit the engine base. The custom row alone cannot do this while Babylon is below 14 ms. |
| The PlayCanvas run 1 sampler error is resolved with clean runs that show materially more p95 headroom or reliability than Babylon | Re-examine the choice between the two alternatives; the rule still triggers adoption. |
| Babylon's contender cold boot or the real host + game gzip exceeds 5,242,880 B | The bundle exception applies; revisit. |
| Both alternatives are shown to have a blocking checklist gap that cannot be fixed with a plugin | The blocking-gap exception applies; revisit. |
| A like-for-like re-run removes the scene differences (ped shadows, car physics, active snapshot) and PlayCanvas meets 14 ms while Babylon does not | The named alternative changes to PlayCanvas; the rule still triggers adoption. |
| Babylon is demonstrated unable to sit behind `GameContext` (not merely untested) while PlayCanvas can | PlayCanvas becomes the named alternative; adoption still stands. |
| The 14 ms target or 5 MiB budget changes in `docs/BUDGETS.md` | Re-apply the rule; a budget change is not a bake-off measurement. |

## References

- `references/decision we need.md` — governing plan and decision rule.
- `experiments/bakeoff/README.md` — binding scene, protocol and checklist.
- `experiments/bakeoff/playcanvas/results.json`,
  `experiments/bakeoff/playcanvas/CHECKLIST.md` — PlayCanvas evidence.
- `experiments/bakeoff/babylon/results-babylon.json`,
  `experiments/bakeoff/babylon/CHECKLIST.md` — Babylon evidence.
- `experiments/bakeoff/runner/results.json` — official shared matrix,
  generated 2026-10-23T06:40:26.604Z; the authoritative rows.
- `experiments/bakeoff/custom/results.json`,
  `experiments/bakeoff/custom/CHECKLIST.md` — supplementary custom evidence.
- `experiments/bakeoff/AUDIT.md` — independent audit: percentiles recompute
  within 0.005 ms, cold-boot totals exact, eight measured screenshots non-blank.
  It confirms the rule verdict and flags paper-trail issues that do not change
  the numbers: the stale unreferenced `runner/screenshots/playcanvas-run1.png`,
  an understated PlayCanvas heap range in its local checklist, a custom
  checklist gzip component-sum typo (matrix total is correct), and no persisted
  build-hash field in `runner/results.json`.
- `docs/RESULTS.md` § "Engine bake-off — ADR-0003 input (2026-10-23)" — one row
  per measured run.
- `docs/BUDGETS.md` — 14 ms p95 target, 20 ms hard fail, 5,242,880 B host+game
  hard cap.
- `docs/ADR-0002-webgpu-engine.md` — custom-engine decision; its status now
  records that this ADR supersedes its engine-base choice.
