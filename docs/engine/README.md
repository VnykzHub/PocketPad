# PocketPad Engine Program

**Status:** program index. The engine specs below are the work list; each becomes authoritative for its subsystem when written.
**Authority:** [`SPEC.md`](../../SPEC.md) for the protocol/product contract, [`docs/ENGINE.md`](../ENGINE.md) for what exists today. When this program and the spec disagree, the spec wins until an amendment is recorded.

## 1. What we are building

A **browser-native game engine**, not a TV accessory:

- runs entirely in the browser, on any display (desktop, laptop, TV, tablet);
- 2D and 3D, local multiplayer with phones as controllers;
- custom **WebGPU-first** renderer with a **WebGL2 fallback**, no Three.js;
- inputs: phones, keyboard/mouse, gamepad;
- architectural ceiling: a Vice City-scale open-world game.

The ceiling is not the v1 claim. The program is a sequence of evidence-gated milestones; each one must produce measurable evidence before the next is called complete.

## 2. Decisions (fixed)

| Decision | Choice | Why |
|---|---|---|
| Renderer | Custom WebGPU + WebGL2 fallback | Full control; Three.js rejected as a gaming foundation |
| Physics | Custom first; Rapier only if a game proves the need | Control, size, determinism |
| Input | Phones + KB/M + gamepad | Local multiplayer plus desktop/single-player |
| Multiplayer | Local-first; online relay later | Get games playable before state sync |
| Benchmark | Vice City as north star, not v1 | Architecture for the ceiling, prove with slices |
| Platform | Browser-only | Portability is the product |

## 3. What a 1–2 day foundation wave can deliver

With parallel agents and precise specs, a foundation wave can produce:

- the spec set for every subsystem in §6;
- `engine-core`: time, math (`Vec3`/`Mat4`/`Quat`), a scene/ECS skeleton, resource lifetime;
- `renderer-webgpu`: device/swapchain, pipeline cache, camera, textured mesh, one lit scene;
- `renderer-webgl2`: the same scene behind the same interface;
- `assets`: manifest asset list, glTF/KTX2/WebP/audio loaders, budget enforcement;
- `input`: keyboard/mouse/gamepad plus the existing phone input bridge;
- one textured 3D demo and the first vertical-slice skeleton;
- a green gate, a benchmark page, and docs a new agent can implement from.

It **cannot** deliver: PBR + shadows + post, skeletal animation, 3D physics/vehicles, AI traffic, world streaming, an editor, save/load, or anything resembling a GTA-scale game. Those are M1–M3 and are measured in weeks to months, not days. Do not promise otherwise.

## 4. Definition of "complete"

The engine is complete for a milestone only when:

1. Every subsystem in that milestone has an implemented spec and tests.
2. The gate is green (`npm run check`).
3. The acceptance scene/target runs at the measured budget on the stated hardware.
4. The docs and API reference are good enough for a new game to be built without reading engine source.
5. No game-specific code lives in engine packages.

“Complete” is always **complete for a milestone**, never “done forever”.

## 5. Parallelisation rules

- **One writer per file.** Declare ownership before fan-out; never two agents on one file.
- **Specs are the interface.** An agent implements from its spec, not from chat.
- **Disjoint workstreams run in parallel**; integration is serial at the wave boundary.
- **Shared contracts are single-owner per wave:** `GameContext`, `Renderer`, `AssetHandle`, `Scene`, protocol.
- **Every wave ends with `npm run check`.** No non-green boundary; no weakened tests.
- **New engine packages must not import the host app.** `packages/runtime` becomes a consumer.
- **No invented measurements.** Every number is measured on a named device.

## 6. Spec index

Each spec lives at `docs/engine/<nn>-<name>.md` and follows the template in §7.

| Spec | Scope | Depends on |
|---|---|---|
| `00-architecture.md` | Layer map, package boundaries, contracts, migration from `packages/runtime` | — |
| `01-core-loop-time.md` | Fixed loop, clock, scheduler, pause, frame stats | 00 |
| `02-math.md` | Vec2/Vec3/Vec4, Mat3/Mat4, Quat, AABB/OBB, ray, plane, frustum | 00 |
| `03-scene-ecs.md` | Scene graph, transforms, entity/component storage, queries, pooling | 01, 02 |
| `04-renderer-webgpu.md` | Device, swapchain, pipelines, bind groups, PBR, shadows, post, LOD, GPU resources | 02, 03 |
| `05-renderer-webgl2.md` | Fallback backend implementing the same renderer contract | 04 |
| `06-assets.md` | Manifest asset list, glTF/GLB, KTX2, WebP, Opus/AAC, WOFF2, streaming, hot reload | 02 |
| `07-physics3d.md` | Bodies, shapes, constraints, vehicles, character controller, raycasts, determinism | 02, 03 |
| `08-animation.md` | Skeletal animation, clips, blend trees, root motion, morph targets | 03, 06 |
| `09-audio.md` | Positional audio, mixer, buses, streaming music, radio, sync | 01 |
| `10-input.md` | Phone bridge, keyboard/mouse/gamepad, action maps, rebinding, focus | 01 |
| `11-ai-navigation.md` | Navmesh, pathfinding, behavior trees, traffic/pedestrian agents | 03, 07 |
| `12-world-streaming.md` | Cell partitioning, LOD, budgeted async load/unload, memory pressure | 03, 06 |
| `13-ui-text.md` | 2D/3D UI, bitmap/SDF text, HUD, menus, focus and accessibility | 04, 06 |
| `14-networking.md` | Local rooms (existing), online relay, snapshot sync, prediction, reconciliation | 00, 10 |
| `15-save-load.md` | World/player persistence, versioned saves, migration | 03, 07 |
| `16-tooling-profiler.md` | Frame/GPU/JS profiler, budgets, debug draws, asset audit | 01, 04 |
| `17-editor.md` | Scene/world editor, placement, lighting, asset browser, play-in-editor | 03, 04, 06 |
| `18-game-sdk.md` | Game lifecycle, `GameContext` evolution, packaging, templates, API reference | all |
| `19-testing-benchmarks.md` | Unit/property/golden/integration/benchmark harness, acceptance scenes | all |

This index is the plan. A spec that does not exist yet is not a contract; write it before implementing.

## 7. Spec template

Every spec must contain, in this order:

1. **Goal** — the problem and the player-visible outcome.
2. **Non-goals** — what this spec deliberately does not do.
3. **Public interfaces** — TypeScript types/functions another layer may use; frozen or additive.
4. **Data formats** — files, schemas, limits, versioning.
5. **Architecture** — modules, ownership, data flow, hot paths.
6. **File ownership** — exact paths for the implementing agent.
7. **Acceptance** — measurable criteria on named hardware, with a scene/fixture.
8. **Test plan** — unit, property, golden, integration, benchmark.
9. **Dependencies** — specs and packages that must land first.
10. **Risks** — what is likely to go wrong and the fallback.

A spec without acceptance criteria is a wish, not a spec.

## 8. Milestones

| Milestone | Acceptance | Honest scale |
|---|---|---|
| **M0 — Foundation** | Specs for §6; WebGPU + WebGL2 backends; math/scene; asset manifest/loaders; KB/M/gamepad input; textured 3D scene; gate green | 1–2 day foundation wave with parallel agents, if the specs are precise |
| **M1 — Vertical slice** | A city block, a drivable vehicle, pedestrians, a mission, streaming, audio, save/load; measured frame p95 on desktop | Weeks |
| **M2 — Engine completeness** | PBR/lighting, shadows/post, skeletal animation, 3D physics, AI/navigation, world streaming, 3D UI/text, profiler | Months |
| **M3 — Open-world proof** | Vice City-scale slice with traffic, missions, content pipeline; measured on target hardware | Multi-year content and engine effort |
| **M4 — Product** | Local multiplayer everywhere, online relay, editor/tooling, SDK and docs for third-party games | After M2–M3 |

A milestone is complete only when its acceptance evidence exists. Until then, describe the engine as “in progress”, never as “GTA-class”.

## 9. Current baseline (before M0)

What exists today, described in [`docs/ENGINE.md`](../ENGINE.md):

- fixed 60 Hz loop, `GameHost`, `GameContext`, input mapping;
- custom WebGL2 cube renderer + Canvas2D fallback;
- 2D physics (circles/AABB);
- rooms/sessions/slots/reconnect;
- 11 phone controls, layouts, panels, events, haptics;
- two 2D games, 134 test files / 1,571 tests, green gate.

Missing for the engine goal: WebGPU backend, asset pipeline, glTF/KTX2, textures, PBR/lighting, animation, 3D physics, AI, streaming, 3D UI/text, editor, save/load, KB/M/gamepad input. That is the work list.

