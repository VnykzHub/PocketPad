# Checkpoint — Engine W0 (2026-10-22)

**Status:** in progress. Branch `checkpoint/wave5-green`. Nothing committed (the user has not asked for a commit).

W0 is the reset-and-contracts wave from `docs/engine/README.md` §8.1. Its exit evidence is a clean `npm ci && npm run check`, every engine spec carrying a `.d.ts` contract, conformance suite and fixture, and a GPU rig that renders a golden triangle.

## Done

| Item | Evidence |
|---|---|
| Clean install fixed | `package-lock.json` regenerated; `npm ci --dry-run` exits 0; `@lanpad/latency-harness` is present |
| All-stage trace | `npm run trace` runs D0–D7, every stage exits 0 with 0 missing; `npm run trace:gate` is the full-matrix audit and stays red on unimplemented C3–C10 (expected) |
| Cross-origin isolation | `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, `Cross-Origin-Resource-Policy: same-origin` on every dev-server response; routes tests 9/9 |
| Decisions recorded | A14 reframe, A15 Rapier, A16 host input, A17 engine gating, A18 isolation in `docs/todos/README.md`; precedence banner in `SPEC.md` |
| Live docs consistent | `README.md`, `CLAUDE.md`, `docs/ENGINE.md`, `docs/DEPENDENCIES.md`, `docs/ADR-0002-webgpu-engine.md`, `docs/engine/README.md` §9 |
| Dependency audit | `npm audit --omit=dev` → 0 production vulnerabilities; 3 dev-only advisories accepted, revisit W4 |
| Decision log | `decisions.dm` records every path choice and the standing decisions D-001…D-007 |

## In flight

| Work | Owner | Notes |
|---|---|---|
| Engine specs 00–19 + `REVIEW.md` | complete | **All 20 numbered documents exist** (00–19, 17,615 lines); `REVIEW.md` records 10 resolved conflicts and 7 open findings. RV-01 (18 version), RV-02 (16 path) and RV-03 (12 CSTR) were closed on 2026-10-22 |
| `packages/runtime/src/main.ts` split into `src/host/*` | **done** | 1,296 → 47 lines, 16 modules; scoped typecheck, lint, build and **377/377 runtime tests** pass. Manual game-launch smoke run still recommended |
| Headless GPU rig `tools/gpu-rig/` | **done** | Real headless runs on Chrome 155 / RTX 3050 Ti: WebGPU `cd0a1f0b`, WebGL2 `781faf16`, both stable; missing golden exits 1. Lockfile regenerated; `npm ci --dry-run` exits 0 |
| Core contracts | **done** | `packages/engine/core` contract skeleton (00/01/02/03): 10/10 contract tests, lint/typecheck clean, four hand-verified conformance fixtures. Wired into workspaces, tsconfig and Vitest. Full gate exits 0: 136 test files, 1,595 tests |
| Full gate after integration | **done** | `npm run check` exit 0: typecheck, lint, 136 test files / 1,595 tests, build, size, trace D0–D7 (0 missing, 0 unknown, ER 2/2). Controller 40.79 KB gz / 40.96 KB dev |
| Foundation contracts | **done** | `renderer-webgpu` (04), `renderer-webgl2` (05), `assets` (06), input (10) and save/load (15): contracts, fixtures, scoped checks; no implementation. Integrated with real workspace links; full gate exit 0 |
| Final T0 contracts | **done** | Physics3D (07), Audio (09) and GameContext v2 (18) delivered and wired. Physics: 38 constants, 42 fixture cases, adapter-boundary type test, no Rapier dependency. Full clean gate exit 0: 137 files / 1,597 tests |
| W1 implementation | **core done** | Math (02), scene/ECS (03) and loop/jobs (01) implemented, wired and gated. Core tests 247/247; full gate 171 files / 1,832 tests, exit 0 |
| W1 packages | **5 of 5 done** | Save 283/283, assets 133/133, input 142/142, WebGL2 181/181, WebGPU 168/168. Full gate green; size unchanged |
| M0 composition | **partial** | Runtime selection + scene encoder + asset bridge + Canvas2D host adapter + 3D host path. 1920×1080 scene5000 p95 10.3/10.2 ms; WebGL2 and WebGPU loss/restore PASS; `engine-cube` renders on real WebGPU. Remaining: 60 Hz/GPU-timestamp, browser 2D parity, WebGL2 host pixels, RV-76 color output. **Full gate green 2026-10-23: 259 files / 2,894 tests, trace 0 unknown, host 127,778 gz** |
| Host 3D path | **done (WebGPU browser)** | Manifest `renderer?: "canvas2d" \| "engine"`; stage selects 3D with `selectRenderer(require3D)` and refuses Canvas2D; `EngineGameRenderer` maps `setCamera`/`drawCube` to instanced engine draws. `engine-cube` ran in real Chrome on WebGPU: 2007×1129 canvas, WebGPU context, three cubes. Runtime 423, game 8, sdk 115. RV-49 closed; RV-76 (sRGB output) open |
| Host wiring | **done (unit + browser layout)** | `stage.ts` now runs both 2D games on the engine Canvas2D device through `engine/canvas2DRenderer.ts`; the adapter preserves legacy draw semantics and refuses 3D. Host gzip fell 78,051 → 75,798 B. Real Chrome found the stage grid/canvas-freeze bug; fixed in `style.css` + `applySize`. Verified 2247×1264 at 2560×1384 and 1067×600 after a live resize, no overflow. Browser parity capture is still required for ER-00-10 |
| Asset bridge | **done (unit)** | `engine/assetBridge.ts` resolves ready assets to cached GPU handles, packs ABI 1, gates formats, refcounts destruction (16 tests, ER-00-16). Deferred: RV-47 compressed-sRGB tokens, RV-48 multi-primitive materials and mips |
| Audio | **done (unit)** | Spec 09 implemented: unlock/one-context, buses, mixer, positional math, voice pool/stealing, clock, crossfade/radio, streaming hooks, budget, fallback, property suite. 11 files / **128 tests**, tsc/lint/build clean. ER-09-01…15 registered; browser renders and TV remain PENDING. RV-50 closed, RV-51/52 open |
| Physics | **acceptance (Node)** | Rapier 0.21.0 behind `Physics3D`; 8 files / **43 tests**, including determinism-600, vehicle slalom, character course, CCD, 64-box island sleep, 1,024-pair filters and the contract suite. tsc/lint/build clean. Browser halves of ER-07-02…08 PENDING; ER-07-09/10/11/12 PENDING. RV-55/57 closed, RV-56 partial, RV-75 open (Rapier CCD is world-wide) |
| Animation | **done (unit)** | Sampling/interpolation, 1D blend/crossfade, masks, palette, events, root motion, CPU morphs, pooled instances, hash. 7 files / **52 tests**, root-wired, tsc/lint/build/typecheck clean. ER-08-01…05/10 registered; GPU skinning, 2D trees and all measurements PENDING. RV-66…71 open |
| Streaming | **core done (unit)** | Grid/index/LOD/priority/residency/ledger/CSTR/cache/decode/stats/facade. 7 files / **108 tests**, root-wired, tsc/lint/build/typecheck clean. Activation budget guard fixed + regression-tested (RV-72). ER-12-01/03/06…09/11/12 registered; driven/pressure/browser rows PENDING. RV-61…64/73/74 open |
| Browser edge cases | **measured** | Resize PASS both backends; WebGL2 loss/restore PASS (hash `32312240` pre/post, 29.2 ms/3 frames); **WebGPU real loss/restore PASS** via the dev hook (hash matched, 63.6 ms/1 frame, handles reused, second loss terminal); 5 MiB WOFF2 load PASS with exact bytes, ≤8 ms bound not provable. ER-04-05 and ER-05-06 PASS on the observed clauses; ER-04-06 partial (configure count). Details in `docs/RESULTS.md` |
| M1 target spec | **written** | `docs/engine/20-m1-vertical-slice.md`: “Block 7 courier run”, 3×3 cells, one sedan, 12 peds, one mission, audio, save; 12 PENDING acceptance rows. Indexed in README §6 |
| Import boundary | **done** | `packages/engine/core/test/boundaries.test.ts` enforces 00 §5.2 D1–D3 from source text (ER-00-02); core tests 12/12, trace exit 0 with ER 3/3. ESLint boundary deferred because the config is protected |
| Core world contracts | **done** | `CellKey`/`WorldCell`/`CellState` now in `engine-core`; 32 streaming error codes added additively (union 71). Streaming re-exports, no duplicates. Core 40 files / 290 tests, streaming 108, tsc/lint/build clean. RV-61/62 closed |
| Engine bake-off | **decided + audited** | Official 3×3 matrix at 1080p: Babylon p95 7.39/10.865/7.835 ms, boot 1.73 MB gz, 3/3; PlayCanvas 13.96/13.09 ms, 2.23 MB, 2/3 (one context loss); custom 0.735–0.845 ms but no shadows/GPU skinning/GameContext. Rule triggers adoption; **Babylon.js 9.32.0 adopted** in ADR-0003. Audit recomputed percentiles/boot and found no decision-changing discrepancy. No migration code; custom packages stay |
| Host-on-Babylon B1 | **done (WebGPU + WebGL2 browser, gate green)** | Spec 21; additive `"babylon"` manifest value; `BabylonGameRenderer` + factory in `packages/runtime/src/babylon/`; `engine-cube` runs through `GameContext` on both backends at 1920×1080 with 3 draw calls and 0 errors. WebGPU rAF p95 0.26 ms (uncapped, trivial scene — not a city budget). Full gate exit 0: 267 files / 2,980 tests; host dev boot 613,530 B gz; lazy Babylon chunks 185,237 + 87,705 + 2,698 B gz. Unit tests ER-21-01/03/08/09/10; evidence in `experiments/babylon-host/` |

## In flight

- **Host 3D path (RV-49):** additive manifest `renderer`, stage selection with `selectRenderer(require3D)`, `EngineGameRenderer` over `RenderDevice`, and an `engine-cube` demo game.
- **Core contract gaps (RV-61/62):** world types and streaming error codes move into `engine-core`; streaming re-exports.
- **Deferred:** 2D solver move (07 §5.15) and the Block 7 content slice.
- **Gate state:** green before this wave: 255 files / 2,857 tests, trace 0 unknown, host 75,822 gz.

## Not started

- The M1 slice itself (`packages/games/block7/**`): vehicle, pedestrians, mission, HUD, save payload.
- Later-tier contracts (11, 13, 14, 16, 17) and their conformance suites.
- WebGPU force-device-loss hook, 60 Hz/GPU-timestamp evidence, 2D browser parity.

## W0 exit checklist

- [x] `npm ci && npm run check` green from a clean tree (137 files / 1,597 tests)
- [x] Specs 00–19 present and reviewed (`REVIEW.md`); no contradiction with A14–A18 remains
- [ ] Every contract spec has a `.d.ts`, conformance suite, fixture and budget — **T0 set (00–07, 09, 10, 15, 18) has types + fixtures; later-tier specs defer their contracts to T2**
- [x] GPU rig runs headless and captures a golden triangle (local evidence; CI wiring still open)
- [ ] `decisions.dm` and this checkpoint updated at W0 exit

## Next wave

W1 implementation: core math, scene/ECS and loop/jobs now; then renderers, assets, input and save codecs; then runtime composition and the M0 textured scene. File ownership is the table in `docs/engine/00-architecture.md` §6; one writer per file, one writer per package.

## Honest limits

- No 3D renderer, asset pipeline, 3D physics, animation, AI, streaming, UI/text or editor exists yet.
- The full Gate matrix is red by design until the engine capability IDs exist.
- TV, Android gyro, vibration, frame time and memory remain `PENDING`; no measurement has been invented.
