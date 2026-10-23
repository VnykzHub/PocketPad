# 21 — Babylon.js engine-base migration

**Status:** specification. [ADR-0003](../ADR-0003-engine-base.md) selects Babylon.js 9.32.0 as the engine base; this spec defines how the host adopts it without breaking the platform contract. Wave B1 (the host-on-Babylon spike) is the first implementation.

**Goal:** move the host's rendering, assets, animation, audio and UI onto Babylon.js behind the existing `GameContext`, prove it with the existing `engine-cube` game on real Chrome, and measure the result before authoring the M1 slice again.

**Non-goals:** protocol, controller, broker or dev-server changes; deleting the custom engine packages; choosing Havok; traffic, missions, streaming content or a Vice City slice. Those stay on their own specs.

---

## 1. Decisions this spec records

1. **Babylon sits behind the existing game-facing contracts.** Games keep consuming `GameContext` and the SDK renderer shapes; no Babylon type appears in `@lanpad/sdk`, `packages/games/*` or the controller.
2. **The 3D adapter implements `Renderer3D`.** The first Babylon backend is a `Renderer3D` implementation (`setCamera`/`drawCube`/`init`/`resize`/`beginFrame`/`endFrame`/`dispose`) in `packages/runtime/src/babylon/`. This keeps `engine-cube` and any existing 3D game code unchanged.
3. **Manifest gets an additive renderer value `"babylon"`.** `"engine"` (custom WebGPU/WebGL2) and `"canvas2d"` stay valid until the custom path is retired. Manifest schema version stays 1 because the change is additive and the validator accepts one more value.
4. **GameHost keeps the clock.** Babylon's `runRenderLoop` is never started. Each host frame calls `engine.beginFrame()`, then `scene.render()`, then `engine.endFrame()` inside the adapter's `beginFrame`/`endFrame`. Babylon 9.32's WebGPU engine submits command buffers in `endFrame`, so the sequence is required.
5. **WebGPU first, WebGL2 second.** The factory tries `WebGPUEngine.IsSupportedAsync` and `initAsync()`; on failure it creates a fresh canvas (canvas contexts cannot be re-claimed) and an `Engine` WebGL2 fallback. A failure of both surfaces a fixed `RendererUnavailableError` notice, never a stack trace.
6. **The bake-off build is the measured build.** `@babylonjs/core` is pinned exactly to `9.32.0` and `@babylonjs/loaders` to the same version when assets land; upgrades require a re-measure against ADR-0003.
7. **Physics is not decided here.** A15 (Rapier behind `Physics3D`) remains in force. The bake-off used Havok; whether the Babylon path keeps Rapier behind the engine interface or adopts Havok is a separate ADR after the spike. No physics package is loaded by the cube path.
8. **The custom engine is frozen, not removed.** `packages/engine/*` stays buildable and tested; only new feature work stops. Its renderer remains reachable through `"engine"` for comparison until the migration waves retire it.

## 2. What is kept, replaced and deferred

| Area | Today | After B1 spike | Later |
|---|---|---|---|
| Protocol/broker/dev-server/controller | frozen platform | unchanged | unchanged |
| Host lifecycle, fixed loop, rooms, layouts, panels, haptics, debug | runtime | unchanged | unchanged |
| SDK, `GameContext`, manifest validation | `sdk/` | one additive renderer value | schema v2 only if a second breaking change lands |
| 3D renderer | custom WebGPU/WebGL2 | **Babylon `Renderer3D` adapter** | native Babylon scene API behind the engine layer |
| 2D renderer | Canvas2D engine device | unchanged | Babylon GUI or custom 2D backend (M2) |
| Assets | custom manifest/GLB subset | unchanged | Babylon loaders (glTF, KTX2, audio) under the asset spec |
| Animation | custom CPU sampler | unchanged | Babylon `AnimationGroup`/skeletons |
| Audio | custom `AudioBus` (Web Audio) | unchanged | Babylon `Sound` only if it wins a measured comparison; positional audio contract stays |
| Physics | Rapier behind `Physics3D` | unchanged | A15 revisit after B2 |
| UI/text | DOM/canvas HUD | unchanged | Babylon GUI where in-world 3D UI is needed |

## 3. Public interfaces

### 3.1 Manifest

```jsonc
{ "renderer": "canvas2d" | "engine" | "babylon" }
```

- Missing means `canvas2d` (unchanged).
- `babylon` requires the same 3D-capable browser as `engine`; Canvas2D is never used as a 3D fallback.
- A manifest that asks for `babylon` on a browser with neither WebGPU nor WebGL2 gets the existing fixed "3D is not available" notice.

### 3.2 Renderer adapter

`packages/runtime/src/babylon/BabylonGameRenderer.ts` implements the frozen `Renderer3D`:

| Member | Behaviour |
|---|---|
| `backend` | `"webgpu"` or `"webgl2"`, from the engine actually created |
| `init(canvas)` | builds camera, lights and a lazily grown pool of box meshes; returns `maxTextureSize`, empty compressed-format list until the Babylon capability map lands |
| `resize(cssWidth, cssHeight, dpr)` | `engine.setSize(round(cssWidth*dpr), round(cssHeight*dpr))`; hardware scaling level stays 1 |
| `beginFrame(alpha)` | `engine.beginFrame()`; resets the per-frame instance count |
| `drawCube(position, size, color, rotationY)` | writes the pooled instance transform and material; ignoring non-finite input exactly like `EngineGameRenderer` |
| `setCamera(position, target)` | updates the Babylon camera position/target |
| `endFrame()` | `scene.render()` then `engine.endFrame()`; reports draw calls as the active cube count |
| `dispose()` | idempotent; stops neither a host loop nor the room |

### 3.3 Factory

`createBabylonGameRenderer(options)` returns:

```ts
type BabylonRendererChoice =
  | { ok: true; renderer: BabylonGameRenderer; backend: "webgpu" | "webgl2"; canvas: HTMLCanvasElement; usedFallback: boolean }
  | { ok: false; reason: "unavailable"; message: string };
```

It may return a canvas different from the requested one after a failed WebGPU claim. The stage already supports mounting a replacement canvas.

## 4. Frame and lifecycle model

```
GameHost rAF tick
  simulate(dt)                 // fixed-step simulation, unchanged
  renderer.beginFrame(alpha)   // engine.beginFrame()
  game.render(alpha)           // setCamera / drawCube
  renderer.endFrame()          // scene.render() + engine.endFrame()
  host measures frameMs        // unchanged
  overlay records              // unchanged
```

- The host's fixed 60 Hz simulation stays authoritative; Babylon never owns time.
- No `engine.runRenderLoop` anywhere in the runtime. A lint/test guard fails if `runRenderLoop` appears under `packages/runtime/src`.
- Context loss: the stage's existing DOM listeners still fire. Babylon installs its own `webglcontextlost`/`restored` handlers in its constructor; the spike must verify a simulated WebGL2 loss does not leave a black canvas, and record what recovery actually happens. If Babylon's recovery is insufficient, the stage-level `ContextLossRecovery` stays the outer fallback.
- Dispose order: game → renderer → canvas, matching `stage.teardownGame()` today.

## 5. File ownership

| Path | Owner | Wave |
|---|---|---|
| `packages/runtime/src/babylon/**` | Babylon adapter owner | B1 |
| `packages/runtime/src/host/stage.ts` | host owner | B1 (additive branch only) |
| `packages/runtime/src/render/Renderer.ts` | frozen; no Babylon types | — |
| `sdk/src/manifest.ts`, `sdk/schema/game-manifest.schema.json` | SDK owner | B1 (additive value, tests) |
| `packages/games/engine-cube/game.manifest.json` | game owner | B1 (one value flip) |
| `docs/engine/21-babylon-migration.md` | this spec | B1 |

One writer per file. B1 touches only the rows above.

## 6. Migration waves

| Wave | Deliverable | Exit evidence |
|---|---|---|
| **B1 — host spike** | Babylon `Renderer3D` adapter, `"babylon"` manifest value, engine-cube on the Babylon path | cube renders in real Chrome on WebGPU; WebGL2 fallback renders; 1080p p95 recorded; boot gzip recorded; gate green |
| **B2 — assets/animation** | Babylon glTF/GLB loader behind the asset spec; skinned pedestrian + animation; `KHR_texture_transform` solved by Babylon | the bake-off scene loads through the host asset path; skinning and shadows verified |
| **B3 — M1 rebuild** | `block7` slice on Babylon: vehicle, pedestrians, mission, HUD, audio, save | ER-20 rows re-measured on the Babylon build |
| **B4 — retire custom path** | remove `"engine"` from the manifest and the custom renderer from the host dependency graph; keep the packages in the archive | gate green with one renderer backend; docs and ADR updated |

Waves are serial at the boundary; parallel agents only inside a wave with declared file ownership.

## 7. Acceptance criteria

| ID | Criterion | Evidence |
|---|---|---|
| ER-21-01 | The adapter's pure helpers (colour parse, instance transform, size rounding, backend mapping) match the frozen `Renderer3D` semantics in unit tests | Vitest — **PASS** |
| ER-21-02 | In real Chrome, `engine-cube` with `"renderer": "babylon"` renders three cubes on WebGPU, reports `backend: "webgpu"`, and a screenshot is visibly non-blank | browser run + screenshot — **PASS 2026-10-23** (`cube-webgpu.png`) |
| ER-21-03 | Forced WebGL2 renders the same scene non-blank and reports `backend: "webgl2"` | browser run + screenshot — **PASS 2026-10-23** (`cube-webgl2.png`); unit PASS |
| ER-21-04 | The cube scene at 1920×1080 DPR 1 over 60 s sampled after 5 s warm-up has p95 ≤ 14 ms, measured with the uncapped-rAF harness | **PASS 0.26 ms** (`experiments/babylon-host/results.json`); uncapped and trivial — not a city-scene budget |
| ER-21-05 | Production host + game boot for the cube path is measured per-file at gzip level 9 and stays ≤ 5 MiB, with the Babylon chunk identified | **PASS** host dev boot 613,530 B gz; lazy Babylon chunks 185,237 + 87,705 + 2,698 B gz |
| ER-21-06 | The existing room/join/input path still works with the Babylon stage: the current integration suite is green without test changes | `npm test` — **PASS** 267 files / 2,980 tests |
| ER-21-07 | `npm run check` is green at the wave boundary | **PASS** exit 0 (typecheck, lint, tests, build, size, trace) |
| ER-21-08 | No Babylon import exists outside `packages/runtime/src/babylon/**` and `experiments/**` | source scan — **PASS** |
| ER-21-09 | When neither WebGPU nor WebGL2 starts, the user sees the fixed "3D is not available" notice and no exception text | unit PASS; browser failure path not exercised |
| ER-21-10 | `dispose()` is idempotent and frees the engine; a second call is a no-op | unit PASS |

Every row is PENDING until its evidence exists. ER-21-02…05 need real hardware; they must not be inferred from unit tests.

## 8. Tests

- Unit: `packages/runtime/test/babylon/*` for colour parsing, transform composition, size rounding, backend mapping, idempotent dispose, and the source-scan boundary (ER-21-08).
- Integration: existing host/stage tests, with a fake Babylon factory injected through the stage seam; no real GPU in Node.
- Browser: a scripted Chrome run (`experiments/babylon-host/` or the existing Playwright tooling) that loads `/games/engine-cube/`, screenshots after 2 s, reads the overlay's backend/draw calls, and records the frame samples. The harness is measurement tooling, not a game dependency.
- No test may skip, weaken or rename an existing requirement tag. New tags register in `docs/todos/TRACEABILITY.md`.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Babylon's boot chunk (615,949 B gz in the bake-off without Havok) plus the host code approaches budgets | measure ER-21-05 per file; defer unused subsystems; tree-shaken deep imports only |
| WebGPU engine is async and can claim a canvas before failing | factory creates a replacement canvas on failure; stage already mounts returned canvases |
| Babylon's own rAF loop could double-render if accidentally started | source-scan test; adapter never starts it |
| Per-frame allocations inside Babylon violate the pooled hot-path rule | measure with the existing counters; record any allocation as a known gap rather than claiming zero |
| Context loss handling differs between Babylon and the custom engine | simulated loss test; keep stage-level recovery as the outer fallback |
| Babylon types leak into game or SDK packages | ESLint boundary + source scan test |
| Hiding a Babylon regression behind the custom path | B1 records both builds side by side; ADR-0003 reopen conditions apply |

## 10. Open questions (do not silently decide)

1. **Physics adapter:** Rapier via `Physics3D` vs Havok via Babylon's plugin. A15 remains in force until a measured/ADR decision; B1 loads neither.
2. **2D backend:** whether the 2D games stay on the custom Canvas2D device or move to Babylon's 2D layer. Not needed for the cube spike.
3. **Native Babylon scene API for new games:** the engine layer may expose Babylon nodes rather than `drawCube` once the SDK is redesigned; that is an M2 spec, not B1.
