# Babylon.js 9.32.0 — bake-off checklist

- **Contender:** Babylon.js 9.32.0 (`experiments/bakeoff/babylon`)
- **Measured:** 2026-10-23, desktop Chrome 155.0.8059.85, headless, 1920x1080 DPR 1, WebGPU
- **Contract:** `experiments/bakeoff/README.md`; shared assets consumed through `../assets/` as required by `experiments/bakeoff/assets/INTEGRATION.md`. The build does not copy or modify the shared assets.
- **Result files:** `results-babylon.json`, `screenshots/babylon-run{1,2,3}.png`, smoke screenshots in this folder.

## Dependencies (exact)

| Package | Version | Licence | Role |
|---|---|---|---|
| `@babylonjs/core` | 9.32.0 | Apache-2.0 | Engine, scene, WebGPU/WebGL2, animation, shadows, audio |
| `@babylonjs/loaders` | 9.32.0 | Apache-2.0 | glTF 2.0 loading |
| `@babylonjs/materials` | 9.32.0 | Apache-2.0 | `SkyMaterial` |
| `@babylonjs/havok` | 1.3.14 | MIT (shipped `LICENSE`) | Havok physics WASM + Babylon Physics V2 `HavokPlugin` |
| `vite` | 7.3.7 | MIT | Build only |

**Physics choice:** Havok, not Rapier. `HavokPlugin` is Babylon's first-party Physics V2 integration and needs one package plus its WASM; Rapier would require a custom adapter/plugin. The car is a dynamic Havok body (mass 1,250 kg); four wheel nodes are visual.

The shipped `@babylonjs/havok` package metadata and `LICENSE` file both say MIT (Copyright 2023 Babylon.js). Havok is Microsoft technology; this is a licence-file/metadata check, not legal advice.

## Build and payload

Built with `npm run build` (Vite, `base: './'`) into `dist/index.html`. The page is served at the runner's URL, `/experiments/bakeoff/babylon/`, and fetches shared assets from `/experiments/bakeoff/assets/`.

| Measure | Value |
|---|---|
| `dist` files | 237 |
| `dist` raw total | 6,326,635 B (6,178.4 KiB) |
| `dist` gzip total | 1,730,261 B (1,689.7 KiB / 1.65 MiB) |
| Runner cold-boot gzip | 1,730,261 B — PASS against 5,242,880 B |
| Runner code gzip (same build; all files are html/js/wasm/json) | 1,730,261 B |
| Havok WASM | 2,094,563 B raw / 662,067 B gzip (38.3% of cold boot) |
| Largest JS chunk (`dist/assets/index-C7XQw-5e.js`) | 2,516,380 B raw / 615,949 B gzip |
| `dist/index.html` | 1,065 B raw / 634 B gzip |
| Non-asset source lines in contender folder (runner count) | 1,664 total / 1,544 non-blank |

Gzip method: zlib level 9, per file, summed; source maps excluded. The runner's cold-boot definition covers the production build only. The page additionally fetches five shared files (`layout.json`, `ground.glb`, `building.glb`, `car.glb`, `ped.glb`); their measured gzip sum is 407,495 B. They are common to all contenders and are therefore not part of the contender cold-boot number, but the combined dist + fetched-scene gzip is 2,137,756 B (2.04 MiB), still under 5 MiB.

## Official measurement — 3 runs, 5 s warm-up + 60 s sampled

Runner: `runner/run.mjs --only babylon --runs 3 --warmup 5 --seconds 60`. Frame source is the runner's independent uncapped `requestAnimationFrame` probe; the page-reported series is separate.

| Run | Backend | p50 ms | p95 ms | p99 ms | max ms | frames | draws | triangles | instances | act / deact | firstFrame ms | readyAfter ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | webgpu | 1.450 | 8.540 | 11.545 | 35.805 | 21,026 | 61 | 2,218 | 15 | 214 / 200 | 1,226.95 | 1,236 |
| 2 | webgpu | 1.370 | 8.255 | 10.985 | 32.650 | 21,562 | 61 | 2,218 | 15 | 214 / 200 | 1,503.23 | 1,517 |
| 3 | webgpu | 1.470 | 8.680 | 11.345 | 27.475 | 20,484 | 61 | 2,218 | 15 | 214 / 200 | 1,568.58 | 1,581 |

Aggregate p95 (min / median / max): **8.255 / 8.540 / 8.680 ms**. Aggregate p50: 1.370 / 1.450 / 1.470 ms. Per-run observed FPS: 350.4 / 359.4 / 341.4 (uncapped probe). All three runs: `pageErrors: []`, `runnerErrors: []`, `crossOriginIsolated: true`, `backend: webgpu`.

Page-reported series (not merged with runner): run 1 p50 1.345 / p95 8.185 / max 44.810 ms; run 2 p50 1.345 / p95 8.550 / max 33.205 ms; run 3 p50 1.275 / p95 8.660 / max 33.590 ms; 18,016 samples each.

Heap used (`Runtime.getHeapUsage`, about once per second): run 1 100.1 MB → 128.9 MB (min 87.5, max 140.2); run 2 110.5 MB → 136.5 MB (min 91.6, max 146.3); run 3 84.7 MB → 117.9 MB (min 84.7, max 135.0). This is not a leak test.

The final-frame contract snapshot is 61 draw calls / 2,218 triangles / 15 instances. This is the end-of-run camera view with the pedestrian cells deactivated; it is not a peak-scene measurement. The 6 s smoke run reports 57 draws / 2,190 triangles / 15 instances at its end, with `peakActivePeds: 50` during the run.

## Capability checklist

| # | Capability | Result | Evidence |
|---|---|---|---|
| 1 | WebGPU with WebGL2 fallback | **PASS** | All official runs `backend: webgpu`. Forced `?backend=webgl2` smoke: backend `webgl2`, ANGLE/NVIDIA RTX 3050 Ti, 711 samples, p50 8.325 / p95 10.215 ms, no errors. |
| 2 | glTF loading with the shared assets | **PASS** | `assets: {ground:true, building:true, car:true, ped:true}`; 14 buildings, 50 peds, car with 4 named wheel nodes; `smoke-initial.png`, `smoke-peds.png`. |
| 3 | Skeletal animation with blending or documented equivalent | **PASS (documented equivalent)** | 50 peds each own an `AnimationGroup` for the shared `walk` clip; `animatedPeds: 50`; peds are visibly mid-stride in `smoke-peds.png`. Only one clip exists in the shared asset, so cross-clip weight/additive blending is not exercised. |
| 4 | Cascaded/directional shadows | **PASS** | One directional sun plus fill; `CascadedShadowGenerator` (2 cascades, 1024, PCF), `shadows: "cascaded"`; visible building/car shadows in official screenshots. |
| 5 | Vehicle physics (Rapier or Havok) driving the car | **PASS with limitation** | Havok 1.3.14 `HavokPlugin`; dynamic 1,250 kg `PhysicsBody` with a box collider driven along the 704 m path by velocity/angular servo at 20 m/s; `carPhysics: true`, `physics: true`. No wheel raycast vehicle or suspension; wheels spin visually. |
| 6 | Character controller or equivalent for peds | **PASS** | 50 `PhysicsCharacterController` instances (0.3 m radius, 1.8 m capsule, 70 kg mass); waypoint loops at 1.2 m/s while active; `pedestrianControllers: 50`. |
| 7 | Positional audio | **PASS (wiring)** | Babylon `Sound` with `spatialSound: true`, `maxDistance: 80`, attached to the car; `audio: "playing"`. Official runner mutes audio, so audible output is not verified. |
| 8 | Streaming hooks: per-cell activation/deactivation | **PASS** | Camera-cell plus Chebyshev-neighbour activation; official runs report 214 activations / 200 deactivations over 60 s; smoke `peakActivePeds: 50`. |
| 9 | Runs with COOP/COEP headers | **PASS** | `crossOriginIsolated: true` in every official run; smoke server and runner both send `COOP: same-origin`, `COEP: require-corp`, `CORP: same-origin`. |
| 10 | Can sit behind `GameContext` without engine-specific types in the game | **PENDING** | The standalone bake-off has no PocketPad `GameContext` harness. Encapsulation exists (`createBabylonBackend` returns an engine-neutral API; only `src/main.js` imports Babylon), but end-to-end `GameContext` integration was not exercised. This is an integration-scope gap, not a Babylon capability gap. |
| 11 | Pooled/allocation-free hot path or acceptable documented substitute | **PENDING** | No allocation profiler was run. Application update loops reuse scratch vectors, but Babylon and the measurement path allocate; allocation-free operation is not proven. Heap samples are reported above. |
| 12 | Licence compatible with a commercial browser game | **PASS** | Babylon core/loaders/materials Apache-2.0; `@babylonjs/havok` MIT per shipped `LICENSE`; Vite MIT (build only); shared scene assets CC0 1.0 (`assets/LICENSES.csv`). |

## Scene implementation notes

- The shared `ground.glb` is a single 192x192 plane with one material and contains no road. The required 12 m ring road is therefore built by the contender from four Babylon `MeshBuilder.CreateGround` strips: outer edge +/-38 m, inner edge +/-26 m, centre lines at x/z = +/-32 m. The side strips stop at the inner edge of the south/north strips, so the four pieces do not overlap or z-fight. The road receives shadows; the road material is dark asphalt.
- The ring is visible in `smoke-peds.png` and in the official end-of-run screenshots. The car's scripted path leaves the ring after the start, so most chase-camera frames show it crossing the centre cell, not driving the ring.

## Limitations / caveats

1. **Havok is a large part of boot:** 662,067 B gzip of the 1,730,261 B cold boot; it is required for the car and character controllers.
2. **Vehicle model:** a single box rigid body with velocity/angular-velocity path following. There is no raycast-wheel suspension, tyre friction model or building collision. The car follows the scripted path regardless of obstacles.
3. **Crowd model:** 50 separate skinned clones, not GPU instances; draw calls and skinning cost scale with visible pedestrians. Peds use waypoint loops, not a navmesh, and do not cast or receive shadows.
4. **One animation clip:** the shared `ped.glb` has only `walk`; cross-clip blending and additive layering are untested. Per-ped groups give independent playback but the scene does not need to blend clips.
5. **Streaming snapshot:** the 60 s endpoint can have the pedestrian cells deactivated, so the contract's final-frame 61 draws / 2,218 triangles / 15 instances understate the peak scene. Peak rendered triangles were not measured; no number is claimed.
6. **Boot path:** `dist` is not standalone. Serve it at `/experiments/bakeoff/babylon/` with `/experiments/bakeoff/assets/` present, per the integration contract. Opening `dist/index.html` alone will not resolve `../assets/`.
7. **GameContext:** not wired to the PocketPad host in this standalone package.
8. **Allocation-free:** not proven; no allocation profile.
9. **Audio:** headless runner uses `--mute-audio`; only API state is evidenced.
10. **Hardware scope:** desktop Chrome 155 on this machine only. No TV, Android, iOS or other GPU was measured. WebGL2 was a forced smoke test, not a 3-run measurement.
11. **Frame spikes:** p95 is below 9 ms in all runs, but individual frames reached 35.8 ms (run 1), 32.7 ms (run 2) and 27.5 ms (run 3). These maxima are reported, not trimmed.
12. **`npm run check` was not run** (per task instruction). No root workspace, engine package, docs, decisions, other contender, runner file or lockfile was modified. No commit was made.

## Visual evidence

- `smoke-initial.png` — WebGPU start view: centre-cell buildings, car, road, shadows.
- `smoke-peds.png` — WebGPU overhead view of the south cells with pedestrians and the full 12 m ring road.
- `smoke-webgl2-initial.png`, `smoke-webgl2-peds.png` — same scene on the forced WebGL2 fallback.
- `screenshots/babylon-run{1,2,3}.png` — official end-of-run views, all showing buildings, the car and the road.

## Bring-up notes (not final errors)

- Early runs reported `triangles: 0` while draw calls were non-zero. Babylon exposes `mesh.instances` as an empty array on non-instanced meshes, so multiplying by `mesh.instances.length` zeroed the count. Fixed to treat an empty array as one draw; the final build reports 2,218 active triangles in the official runs.
- The first build copied the shared assets into `dist/shared`, which inflated cold boot to 2,178,933 B gzip and violated the integration contract. The copy was removed; the final build fetches `../assets/` and measures 1,730,261 B gzip.
- No final page errors or runner errors: `pageErrors: []`, `runnerErrors: []` in all three official runs.
