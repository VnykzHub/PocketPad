# PocketPad: Audit and Parallel Dev Plan

Oct 22, 2026 · @Vinayak

PocketPad today is a solid phone-controller and room platform with a cube-demo renderer. It is not yet an engine. The fastest route to the north star is to stop sequencing by stage, freeze executable contracts first, then run about ten independent engine layers in parallel.

## What exists (checkpoint/wave5-green, one commit, `b214c51`)

About 35k lines of non-test TypeScript. Roughly three quarters of it is the phone and room platform, not engine.

| Package | Non-test LOC | What it is | Engine relevance |
| --- | --- | --- | --- |
| `controller` | 12,651 | Phone UI: 11 control types, touch engine, sensors, reconnect | Input device only |
| `runtime` | 14,129 | Host shell, UI, loop, input mapper, 2D physics, renderers, asset loader, audio bus | Mixed; engine part is small |
| `broker` | 3,161 | Rooms, sessions, slots, relay | Networking (local only) |
| `games` | 3,642 | Coin Run, Reaction Duel (2D) | Proof of platform |
| `protocol` | 1,304 | 26-byte input frame, JSON union | Frozen contract |
| `dev-server` | 609 | Static serving, WebSocket adapter | Tooling |

The engine-relevant code is: a fixed 60 Hz loop (161 lines), a cube-only WebGL2 renderer (856 lines, one shader, no textures, no lighting, matrix math inlined), circle/AABB 2D physics (about 350 lines), an asset loader that is a stub in practice (`GAME_ASSETS` is an empty array in `main.ts`), and a Web Audio bus with 8 voices.

Not present at all: WebGPU, any Vec3/Mat4/Quat library, scene graph or ECS, textures, glTF/KTX2, PBR, shadows, skeletal animation, 3D physics, navigation, streaming, text or UI rendering, save/load, keyboard/mouse/gamepad input, and any of the 20 engine specs. `docs/engine/` contains only its README.

The docs are about 152k words against roughly 35k lines of source. Most of the words are the serial stage plans (D0 to P6) and 16 game plans for the platform.

## Findings, most severe first

| # | Finding | Evidence | Fix |
| --- | --- | --- | --- |
| 1 | The 3D renderer contract is a placeholder. `Renderer3D` is `setCamera` plus `drawCube`; bundled games are forced onto Canvas2D. Every future layer hangs off this contract. | `render/Renderer.ts`, ENGINE.md §2.1 | Replace with a real `RenderBackend` contract in Wave 0, one owner |
| 2 | The "green gate" does not reproduce from a clean checkout. `npm ci` fails: `@lanpad/latency-harness` is missing from `package-lock.json`. CI runs `npm ci`, so it would fail too. | I ran `npm ci` on this branch | Regenerate the lockfile, add a lockfile check to the gate |
| 3 | The plan is a serial waterfall (D0 → D7 → Gate → P0 → P6) gated on TV and phone hardware rows that are all PENDING. That is the opposite of the layered parallel goal. | `IMPLEMENTATION-ORDER.md` §1; RESULTS.md | Retire stage gating for the engine track (see next section) |
| 4 | The 20 engine specs do not exist. The program depends on them, and `docs/engine/` holds only the index. | `ls docs/engine` | Write them first, as executable contracts |
| 5 | Docs contradict each other on core decisions. `DEPENDENCIES.md` still plans `three`; `Renderer.ts` says the Three.js vs custom decision (E12) is pending; CLAUDE.md says Three.js is rejected. ENGINE.md still calls the product TV-first and "not a general-purpose engine". | Those files | One decision record, delete the stale text |
| 6 | The trace check is hard-coded to stage D0, so the gate does not cover later stages. The checkpoint records a D7 run that failed on a missing `FR-4.5` tag. | `package.json`, wave-7 checkpoint §0 | Run every stage in the gate |
| 7 | `main.ts` is 1,296 lines in one file, which the one-writer-per-file rule turns into a serial bottleneck. The controller bundle has 237 bytes of headroom against its gzip budget (checkpoint figure, not re-measured). | `wc -l`; wave-7 checkpoint §3.2 | Split `main.ts` by route and panel; raise or restructure the budget |
| 8 | Cross-origin isolation is not set (no COOP/COEP). Without it, `SharedArrayBuffer` and worker-based job systems are unavailable, which a streaming open world needs. | ENGINE.md §3.5 header list | Decide early; it affects the CSP and the LAN/QR flow |
| 9 | No GPU test rig: no golden-image tests, no frame-time benchmark in CI, no determinism replay for 3D. Without these, parallel agents cannot verify rendering work. | `vitest.config.ts` projects | Build the rig in Wave 0 (see below) |

What is good and should be kept: the enforced layer boundaries in ESLint, the frozen additive-only protocol, pooled allocation-free hot paths, test titles tied to requirement IDs, and the honesty rules (no invented measurements, no "GTA-class" claim). The platform is a sound foundation; the plan around it is what needs to change.

## Why the current process is slow, and what replaces it

The repo already says "parallel, spec-first", but the machinery contradicts it.

1. **Stage gates instead of layer contracts.** Work is ordered by stage (D0 to P6), each waiting on the previous exit checklist and on physical TV/phone evidence. Engine layers have no hardware dependency; gate them on automated oracles, not on a TV.
2. **Prose specs, not executable ones.** A spec that is only English lets two agents implement the same interface differently, and the difference shows up at integration. The cost lands on the one serial step.
3. **Integration only at wave end.** Cross-package defects pile up and a single integration agent clears them at the boundary. Integrate continuously instead, per layer boundary, behind feature flags.
4. **No cheap oracle for graphics.** An agent writing a shadow pass cannot tell if it is right. Parallel work is only as fast as its verification.
5. **Wide shared files.** `main.ts` and the renderer interface are single-owner and everything waits on them.

The replacement, in one line: **contracts first (types plus conformance tests), then fan out by layer, integrate continuously, verify with automated oracles, and reserve human time for planning, integration and hardware.**

## Target layers and what runs in parallel

This keeps your 20-spec index but regroups it by true dependency. Everything inside a tier runs concurrently; a tier starts when its contracts are frozen and conformance tests exist, not when the previous tier is finished.

| Tier | Streams (each an independent package) | Needs | Oracle that tells an agent it is right |
| --- | --- | --- | --- |
| **T0 Contracts** (serial, one owner) | Architecture, `RenderBackend`, `Scene`/ECS data layout, `AssetHandle`, `Physics3D`, `Audio`, `Input` action API, job/worker model, `GameContext` v2 | Nothing | Type declarations plus a conformance suite per contract |
| **T1 Foundations** (about 10 parallel) | Math; core loop, jobs, pools; WebGPU device and pipeline core; WebGL2 backend core; asset parsers (glTF/GLB, KTX2, WebP, Opus, fonts); KB/M/gamepad input; audio mixer; 3D physics core; snapshot networking on the existing broker; GPU test rig and profiler | T0 | Property tests, golden images, microbenchmarks |
| **T2 Systems** (about 8 parallel) | Scene graph and culling; PBR; cascaded shadows; post (tonemap, bloom, AA); skeletal animation; navmesh and agents; world streaming; UI and SDF text; save/load | T1 contracts and stubs | Golden images, frame-time budgets, replay determinism |
| **T3 Gameplay framework** (about 6 parallel) | Vehicle, character controller, camera rigs, mission scripting, traffic and pedestrian AI, HUD, minimap, radio | T2 interfaces | Scripted playthrough bots (the repo already has an input-bot tool) |
| **T4 Content and tools** | Asset pipeline CLI, world editor, vertical-slice city block | T3 | End-to-end acceptance scene at a measured frame time |

Two decisions shape this map. **Physics:** the program says custom first. A custom 3D vehicle and character stack is quick to write but slow to tune, and tuning is human time. I recommend a `Physics3D` interface with a WASM engine (Rapier) behind it, and a custom core only if it proves necessary. **Shaders:** author once in WGSL and give WebGL2 a reduced feature set (no compute culling, fewer lights) instead of keeping two full pipelines in lockstep.

## The spec-driven machine

The existing 10-section spec template is good. Make each spec executable by adding four things, so an agent that never saw the chat can finish and prove it:

1. **A `.d.ts` contract file** committed beside the spec, frozen and additive-only. The spec's prose explains it; the types are the authority.
2. **A conformance suite** written in Wave 0, before any implementation. Every backend or implementation (WebGPU, WebGL2, Rapier adapter, custom) must pass the same suite. This is what makes parallel work safe.
3. **A reference fixture and a numeric budget.** For rendering, a golden image plus a tolerance. For systems, a replay file and an expected hash. For hot paths, a benchmark with a ceiling. "Fast" is never an acceptance criterion.
4. **An ownership manifest** listing exact files. Extend one-writer-per-file to one-writer-per-package, and keep cross-package changes to a request filed against the owning spec.

Verification rig to build in Wave 0, because every later stream depends on it:

- Headless Chromium with WebGPU or software rendering in CI for golden-image diffs. Chromium and Playwright are already available in the dev environment; I did not test WebGPU there.
- A determinism harness: fixed seed, recorded input, state hash per N ticks, run twice.
- A frame-time and allocation budget test using the existing debug overlay counters.
- A lockfile, typecheck and all-stage trace check that runs on every merge.

Integration changes from wave-end to continuous: each layer merges to trunk behind a feature flag the moment its conformance suite passes, so incompatibilities surface in hours.

## Wave plan

Durations are my estimates for AI-assisted work with a human doing planning, review and integration. They are not measurements, and each wave only ends on its exit evidence.

| Wave | Work | Exit evidence | Estimate |
| --- | --- | --- | --- |
| **W0 Reset and contracts** | Fix lockfile and CI; all-stage trace in the gate; split `main.ts`; record the renderer, physics and isolation decisions; freeze T0 contracts and conformance suites; build the GPU test rig; write specs 00 to 19 with 5 to 6 parallel writers, then one architect pass for cross-spec consistency | Clean `npm ci && npm run check`; every spec has a `.d.ts`, a conformance suite and a fixture; rig renders a golden triangle in CI | 1 to 2 days |
| **W1 Foundations (M0)** | The ten T1 streams in parallel | Textured, lit glTF scene on WebGPU and WebGL2 passing golden diffs; KB/M/gamepad plus phone input; physics boxes and raycasts; positional audio; benchmark page; gate green | 2 to 4 days |
| **W2 Systems** | The eight T2 streams in parallel, merged continuously | Skinned animated character under cascaded shadows with post; navmesh path; streamed grid cells with a memory cap; SDF text HUD; save/load round trip | 3 to 6 days |
| **W3 Gameplay and slice (M1)** | The T3 streams, then integration of one city block | Drive a car through a block with pedestrians, one mission, audio and save/load; frame p95 measured on a named desktop; replay determinism passes | 4 to 7 days |
| **W4 Completeness (M2)** | Profile-driven optimisation, LOD, GPU culling, editor, asset pipeline hardening, device matrix | Budgets met on named hardware; docs sufficient to build a game without reading engine source | Weeks, bound by tuning on real hardware |
| **W5 Open-world proof (M3)** | Content, missions, traffic density, world scale | Vice City-scale slice measured on target hardware | Months or more; bound by content, not code |

On this plan the engine through M1 is plausibly two to three weeks rather than months. M3 stays a content program: code is parallel, but art, audio, level design and mission writing are not free.

## Where real time still goes, and what I need from you

Code volume is no longer the constraint. What stays slow, in order:

1. **Planning and contract design.** A wrong T0 contract costs every stream. Spend your review time here.
2. **Integration and verification.** Merging ten streams, and judging results an oracle cannot (frame feel, visual quality).
3. **Content.** A Vice City-scale world needs models, textures, animation, audio and missions. Decide early whether it is generated, licensed or hand-made, and check licences.
4. **Hardware tuning.** Frame time, memory and thermals need real devices. Desktop Chrome is the right provisional target.
5. **Game feel.** Vehicle handling and camera are tuned by playing.

Decisions that unblock Wave 0:

- [ ] Physics: adopt a WASM engine (Rapier) behind `Physics3D`, or stay custom as the docs say?
- [ ] Retire stage gating (D0 to P6) for the engine track, keeping the phone platform frozen and maintained separately?
- [ ] Enable cross-origin isolation (COOP/COEP) now, accepting the change to the CSP and QR join flow?
- [ ] Pick the WebGL2 fallback scope: reduced feature set, or full parity?
- [ ] Content strategy for M3: generated, licensed or hand-made?
- [ ] Browser support floor for WebGPU (verify the current matrix before fixing it).

## Limits of this audit

- I read the code and docs statically on a read-only shallow clone of the `checkpoint/wave5-green` branch (one commit). I could not see history or other branches.
- I did **not** run the test suite or the gate. `npm ci` failed on a lockfile mismatch, and my attempt to run `npm install` and `npm run check` was blocked by the session's permission policy, so I did not work around it. The test counts (1,569 tests, 132 files) and the bundle sizes are the checkpoint's claims, not my measurements.
- Line counts come from `wc -l` on non-test TypeScript; the 152k-word figure counts all Markdown under `docs/` plus `SPEC.md`.
- I did not review the broker, protocol or controller code in depth, since the north star depends on the engine layers.
- All durations are estimates.
