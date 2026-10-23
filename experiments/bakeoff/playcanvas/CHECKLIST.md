# PlayCanvas contender — bake-off checklist (2026-10-23)

Contender: **PlayCanvas 2.23.3** (`playcanvas/profiler` entry), built with Vite 8.3.5.
The binding scene, metrics and checklist are defined in `../README.md`.
Every number below comes from a recorded run in this folder; nothing is estimated.
Official runs were made on 2026-10-23 with the build below in headless Chrome at
1920×1080, DPR 1, on an NVIDIA RTX 3050 Ti (hardware, not SwiftShader).

## Build and environment

| Item | Value |
|---|---|
| Dependencies | `playcanvas@2.23.3` (MIT), `@dimforge/rapier3d-compat@0.21.0` (Apache-2.0) |
| Build tool | `vite@8.3.5` (MIT), `base: './'`, `dist/` is statically servable from the repo root |
| Bundle | `dist/assets/index-D-OM44cV.js` 6,437,029 B raw / 2,180,392 B gzip |
| Other dist files | `dist/index.html` 1,943 B / 934 B gzip; `dist/audio/engine.wav` 44,144 B / 42,104 B gzip |
| **Cold boot gzip** | **2,223,430 B = 2.120 MiB** (zlib level 9, per file, source maps excluded) |
| Node / npm | 22.14.0 / 10.9.2 |
| Browser | Chrome 155.0.8059.85, `HeadlessChrome/155.0.0.0` |
| GPU / backend | ANGLE (NVIDIA GeForce RTX 3050 Ti Laptop GPU, Direct3D11), **webgpu** |
| Isolation | COOP/COEP present; `crossOriginIsolated: true` in every run |
| Measurement | 3 runs × (5 s warm-up + 60 s sampled), runner protocol, uncapped rAF |
| Raw result | `experiments/bakeoff/playcanvas/results.json` (generated 2026-10-23T05:55:16Z) |

The profiler entry of PlayCanvas is deliberate: it exposes `app.stats.drawCallCount`
and `app.stats.primitiveCount`, which supply the contract's draw-call and triangle
fields. The normal build does not expose those counters.

## Official measurement — all three runs

Frame intervals are compositor `requestAnimationFrame` deltas with Chrome's frame
rate limit and GPU vsync disabled (runner defaults), not GPU timestamp queries and
not display-paced values. Percentiles are nearest-rank over the sampled intervals.

| Run | Backend | p50 ms | p95 ms | p99 ms | max ms | mean ms | Frames | Observed fps | First frame ms | Draw calls | Triangles | Instances | Act / Deact | Errors |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | webgpu | 3.645 | 15.55 | 20.0 | 56.86 | 5.731 | 10,471 | 174.498 | 1043.5 | 67 | 8,682 | 20 | 30 / 29 | none |
| 2 | webgpu | 2.96 | 15.345 | 18.575 | 40.58 | 5.564 | 10,784 | 179.713 | 1307.8 | 65 | 8,658 | 20 | 30 / 29 | none |
| 3 | webgpu | 4.275 | 12.255 | 16.805 | 324.28 | 5.068 | 11,842 | 197.327 | 1309.6 | 66 | 8,670 | 20 | 30 / 29 | none |

- Aggregate p95: min 12.255, median **15.345**, max 15.55 ms. Aggregate p50: min 2.96,
  median 3.645, max 4.275 ms. Per the README, all runs are reported; the median is
  not a best-run figure.
- Run 3 contains one 324.28 ms outlier (p99 is 16.805 ms), so it does not drive the
  p95. Run-to-run spread is real and reported.
- `pageErrors` and `runnerErrors` were empty in every run; the in-page `errors` array
  stayed empty (HUD: `errors 0`).
- First frame 1.0–1.3 s from page load; `readyAfterMs` 1050 / 1316 / 1315 ms.
- Heap samples (used JS heap, first → last sample): 52.9 → 57.6 MB, 41.3 → 40.0 MB,
  36.0 → 32.7 MB. Total heap 104–112 MB. Fluctuation is GC, not a demonstrated leak.
- The contract's draw-call/triangle/instance fields are **instantaneous samples taken
  at the end of the run**. All three runs ended on the building side with the three
  pedestrian cells streamed out: 20 active instances, no peds, 65–67 draw calls and
  about 8.7k triangles. This is correct streaming, not missing content.

### Full-active-set diagnostic (not an official measurement row)

A separate 10 s run of the same build (`smoke/results.json`) sampled while buildings
and all 50 pedestrians were active. It is recorded only as content evidence:

- Backend webgpu, no page or runner errors.
- 120 draw calls and 448,358 triangles in the recorded contract sample (the HUD,
  refreshed on its own 500 ms cadence, showed 121 / 462,090 for the same active set),
  **70 active instances** (14 buildings + 50 peds + ground + 4 road strips + car
  object), 9 activations / 5 deactivations.
- p50 0.65 ms, p95 8.815 ms over 3,726 frames. Do not use these as the contender's
  official frame result; the official three-run table above is authoritative.

## Verification of the scene and the fallback

- WebGPU is the measured backend in all three official runs.
- Forced WebGL2: `node scripts/check-webgl2.mjs http://127.0.0.1:47999` against the
  runner static server. Latest result: ready true, `backend: "webgl2"`,
  `errors: []`, `glError: 0`, 97 draw calls / 269,722 triangles / 70 instances,
  hardware renderer string identical to the WebGPU runs, `crossOriginIsolated: true`.
  In-frame pixel samples contained sky (111,151,195), ground (152,158,147) and road
  (37,38,44) values. Evidence: `smoke/webgl2-fallback.png`, `smoke/webgl2-canvas.png`.
- Screenshots: `screenshots/playcanvas-run{1,2,3}.png` are the official end-of-run
  captures. The 10 s diagnostic is `smoke/screenshots/playcanvas-run1.png`.

### Exact WebGL2 MSAA error and the fix

On this ANGLE/D3D11 headless environment, PlayCanvas's default 4x MSAA resolve on
WebGL2 failed every frame with:

```
GL_INVALID_OPERATION: glBlitFramebuffer: Invalid operation on multisampled framebuffer.
```

The result was a ready marker, nonzero engine draw-call counts, and a black canvas.
The probe also raised `glReadPixelsRobustANGLE: Invalid operation on multisampled
framebuffer`. Passing `antialias: false` to `pc.createGraphicsDevice` avoids the
resolve (WebGPU already defaulted to no backbuffer MSAA) and produced the verified
WebGL2 output above. This is a PlayCanvas-WebGL2-on-ANGLE limitation, not scene code.

## Vehicle physics validation (Node, Rapier only)

`scripts/vehicle-sim.mjs` runs the same forces and pursuit controller as
`src/physics.js` without a browser. It is a physics check, not a frame measurement.
Run: `node scripts/vehicle-sim.mjs` (60 s):

| Metric | Ring road (used in browser) |
|---|---|
| Path length | 221.65 m |
| Distance in 60 s | 1,127.5 m (5.09 laps) |
| Speed max / avg | 19.21 / 18.77 m/s (target 20) |
| Lateral error max | 0.544 m |
| Upright fraction | 1.0 |

**Documented deviation:** the browser car follows the README's 12 m ring road, not
`layout.cameraPath`. The shared polyline retraces its stem and closes with a
zero-radius 180° reversal at (0, 32), which a 20 m/s vehicle cannot follow. Measured
with `node scripts/vehicle-sim.mjs 60 --layout-path` on the identical 704 m polyline:
speed max 15.45 m/s, average 15.19 m/s, lateral error max **17.562 m**, 1.3 laps in
60 s, ending at (16.66, 0.59, 24.98). The ring route keeps the car moving and is the
route used for every browser run above.

## Capability checklist

| # | Item | Verdict |
|---|---|---|
| 1 | WebGPU with WebGL2 fallback | **PASS** |
| 2 | glTF loading with the shared assets | **PASS** |
| 3 | Skeletal animation with blending or documented equivalent | **PASS (documented equivalent)** |
| 4 | Cascaded/directional shadows enabled | **PASS** |
| 5 | Vehicle physics (Rapier or Havok) driving the car | **PASS** |
| 6 | Character controller or equivalent for the peds | **PASS (equivalent)** |
| 7 | Positional audio (single engine loop/horn allowed) | **PENDING** |
| 8 | Streaming hooks: per-cell activation/deactivation | **PASS** |
| 9 | Runs with COOP/COEP headers | **PASS** |
| 10 | Can sit behind `GameContext` without engine types in the game | **PASS** |
| 11 | Pooled/allocation-free hot path, or documented substitute | **PASS (documented substitute)** |
| 12 | Licence compatible with a commercial browser game | **PASS** |

### 1. WebGPU with WebGL2 fallback — PASS

WebGPU ran the three official runs (backend `webgpu`, RTX 3050 Ti via ANGLE D3D11).
The forced WebGL2 path was exercised with `?backend=webgl2` and the check script:
ready, zero errors, hardware GL renderer, visible scene. See the MSAA section above
for the one required option. Caveat: the automatic `['webgpu', 'webgl2']` selection
order was not separately simulated with WebGPU disabled; both backend code paths
were run.

### 2. glTF loading with the shared assets — PASS

`pc.Asset` containers for `ground.glb`, `building.glb`, `car.glb`, `ped.glb`, loaded
with `pc.AssetListLoader`; `instantiateRenderEntity()` clones for buildings, peds and
the car. A failed load rejects with the asset names. All four assets loaded in every
run (HUD and screenshots); no failed assets were recorded.

### 3. Skeletal animation — PASS (documented equivalent)

`ped.glb` (shared asset, Quaternius CC0) has a 65-joint skin and one clip named
`walk`, duration **1.333333 s** (41 keys; the README's asset table says 1.0 s, the
delivered asset differs). Each of the 50 clones has a PlayCanvas `AnimComponent`
playing that clip at a per-ped speed of `0.92 + (i % 7) * 0.03`, i.e. 0.92–1.10×.
Only one clip exists, so there is no cross-clip blending; per-instance playback speed
is the documented equivalent. Screenshots show walking poses, not a bind pose.

### 4. Cascaded/directional shadows — PASS

One directional light, `castShadows: true`, `shadowDistance: 90`, 2048 map,
`numCascades: 3`, `SHADOW_PCF3_32F`, bias 0.2, normal offset 0.05. Building and car
shadows are visible in `screenshots/playcanvas-run1.png` and the WebGL2 capture.
Ped shadows are disabled in this contender; the light and cascaded shadow map are
active and visible.

### 5. Vehicle physics — PASS

`@dimforge/rapier3d-compat@0.21.0` raycast vehicle: 1,250 kg chassis, four wheels,
rear-wheel drive, front steering, pure-pursuit path following at a 20 m/s target.
The PlayCanvas car entity is synced from the Rapier pose every rendered frame; wheel
spin is a visual function of speed. Browser HUD reported 19.1–19.2 m/s. The Node
validation above is the reproducible physics evidence. Deviation from
`layout.cameraPath` is documented there.

**Plugin requirement:** no physics engine is bundled in `playcanvas@2.23.3`; Rapier
is an additional application dependency, not a PlayCanvas engine plugin.

### 6. Character controller — PASS (equivalent)

Peds follow per-cell rectangular waypoint loops via `stepPed` in `src/sim.js` at
1.2 m/s, with heading and position updated only for active cells. There is no
navmesh, collision response or gravity for peds; the README's requirement is a walk
loop, and this is the documented equivalent.

### 7. Positional audio — PENDING

The car has a positional `SoundComponent` (linear distance model, ref 4 m, max 40 m)
with a looping generated CC0 engine WAV. The asset loaded in every run (`audio=loaded`
in the HUD; `dist/audio/engine.wav`). Audible playback was **not** verified:
headless Chrome blocks the AudioContext before a user gesture (console:
"The AudioContext was not allowed to start..."), and the runner launches Chrome with
`--mute-audio`. No claim of audible audio is made.

### 8. Streaming hooks — PASS

One group per occupied cell; active when the camera's cell is equal or adjacent,
otherwise all group entities are disabled. Official 60 s runs recorded **30
activations / 29 deactivations** each; the 10 s diagnostic recorded 9 / 5. Active
instances varied from 20 (building side, peds streamed out) to 70 (buildings plus all
50 peds).

### 9. COOP/COEP — PASS

The runner serves COOP `same-origin`, COEP `require-corp` and CORP `same-origin`.
Every measured run and the WebGL2 check reported `crossOriginIsolated: true`; the
page also creates a 12-byte `SharedArrayBuffer` as a smoke check. Production must keep
these headers (per `CLAUDE.md`), but that is outside this contender folder.

### 10. GameContext fit — PASS

The game-facing logic in `src/sim.js` imports nothing (layout validation, ring and
polyline paths, pure pursuit, ped loops, cell math). Engine-specific code is confined
to the adapters `src/view.js` (PlayCanvas) and `src/physics.js` (Rapier); `src/main.js`
is a composition root. There are no PlayCanvas types in the game logic, so it can sit
behind `GameContext`. Caveat: this bake-off page does not actually install a
`GameContext` adapter; the assessment is structural, evidenced by the import graph.

### 11. Hot path — PASS (documented substitute)

Our per-frame path preallocates `cameraPosition`, `lookTarget`, `carRotation`,
`spinQuat`, one quaternion per wheel, and reuses the vehicle's output record; the ped
path uses scalar state; there are no `map`/`filter`/array allocations in the frame
path. Substitute/caveat: Rapier's compat API returns small transient objects from
`translation()`, `rotation()` and `currentVehicleSpeed()` on every physics step, and
PlayCanvas allocates internally in its renderer. This contender does not add a global
pool around third-party APIs; if the item is read as "zero allocation anywhere in the
frame", it would fail. It is marked PASS under the README's documented-substitute
allowance, with the caveat stated explicitly.

### 12. Licence — PASS

| Component | Licence | Evidence |
|---|---|---|
| PlayCanvas 2.23.3 | MIT | `node_modules/playcanvas/package.json` |
| `@dimforge/rapier3d-compat` 0.21.0 | Apache-2.0 | `node_modules/@dimforge/rapier3d-compat/package.json` |
| Vite 8.3.5 (build only) | MIT | `node_modules/vite/package.json` |
| `car.glb` | CC0 1.0 (Kenney) | `../assets/LICENSES.csv` |
| `ped.glb` | CC0 1.0 (Quaternius) | `../assets/LICENSES.csv` |
| `ground.glb`, `building.glb`, `facade.png`, `layout.json` | CC0 1.0 (generated in-repo) | `../assets/LICENSES.csv` |
| `engine.wav` | CC0 1.0 (generated in-repo by `scripts/make-engine-audio.mjs`) | source and `../assets/LICENSES.csv` |

No Mixamo, bitmoji or unclear-licence asset is used. The full asset ledger is
`../assets/LICENSES.csv`.

## PlayCanvas and scene limitations

- **No bundled physics.** Rapier is a separate dependency (see item 5).
- **WebGL2 MSAA resolve failure** on this ANGLE/D3D11 headless environment, requiring
  `antialias: false` for the fallback. Without it the canvas is black while the engine
  still reports draw calls. Exact error in the MSAA section.
- **Profiler build.** Draw-call and triangle counters require the larger profiler
  entry. The full build remains 2.12 MiB gzip, under the 5 MiB boot budget, but the
  normal build would be smaller at the cost of the counters.
- **Draw-call peak.** 120–121 draw calls observed at the full active set (recorded
  contract sample 120, HUD 121), against the engine's 120 target; official end
  samples are 65–67 because peds are streamed out.
- **Car visual/physics scale mismatch.** The Kenney car is about 1.5 × 1.15 × 2.55 m;
  the Rapier chassis is 2.0 × 0.5 × 4.0 m with wheel connections at ±1.05 / ±1.3 m.
  The visual is offset by -0.09 m and wheels spin/steer from the vehicle state, but
  per-wheel suspension poses are not copied to the four wheel nodes.
- **Shared cameraPath is not drivable at 20 m/s** (measured 17.562 m lateral error,
  1.3 laps); the car uses the 12 m ring instead. This is a deviation from the shared
  layout, recorded here and in the harness output.
- **Shared asset metadata differs from the README**: the delivered `ped.glb` has a
  65-joint rig and a 1.3333 s walk clip, and `../assets/MANIFEST.json` is stale
  (older sizes). The contender loads what the container provides and does not patch
  the assets; asset ownership is outside this folder.
- **Headless audio autoplay** blocks actual playback (item 7).
- **In-page frame series is capped at 6,000 samples** to bound memory; the runner's
  independent series is the complete 60 s measurement. Page and runner percentiles
  are reported separately by the runner.
- **Frame pacing.** Uncapped headless rAF produced a bimodal interval distribution;
  p95 values are protocol values, not display-cadence or GPU-timestamp values. The
  one 324 ms outlier is reported, not discarded.

## Reproduce

```bash
# contender package (only this folder)
cd experiments/bakeoff/playcanvas
npm install
npm run build

# official protocol: 3 runs, 5 s warm-up, 60 s sampled
cd ../runner
node run.mjs --only playcanvas --runs 3 --warmup 5 --seconds 60 \
  --out ../playcanvas/results.json

# forced WebGL2 fallback (needs the static server)
node run.mjs --serve-only --port 47999
cd ../playcanvas
node scripts/check-webgl2.mjs http://127.0.0.1:47999

# Rapier physics validation (Node; not a frame measurement)
node scripts/vehicle-sim.mjs
node scripts/vehicle-sim.mjs 60 --layout-path
```

The official raw output for this contender is `playcanvas/results.json`. The runner's
aggregate `runner/results.json` belongs to the runner owner and was not modified.
No commit was made.
