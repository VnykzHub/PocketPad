# CLAUDE.md

This file gives Claude Code the product context, architecture and working rules for this repository. Read it before touching code.

## What this is

PocketPad is a **browser-native game engine**. It runs entirely in the browser, renders on any display (desktop, laptop, TV, tablet) and turns phones into controllers over WebSocket. It targets 2D and 3D games, from same-room party games to an open-world benchmark in the class of *GTA Vice City*.

The host page is authoritative: it runs the simulation and renders the game. Phones send input (~26 bytes per packet) and receive a per-game control layout, private panels, haptics and layout swaps. The server pairs rooms and relays messages.

**North star:** an engine strong enough to build a Vice City-scale browser game — streaming world, vehicles, pedestrians, animation, missions, audio — at a good frame rate. That is the architectural ceiling, **not** a v1 claim. Do not describe the engine as GTA-class until the M3 acceptance exists.

`SPEC.md` at the repo root is authoritative for the protocol and product contract. `docs/ENGINE.md` describes the current engine. `docs/engine/` holds the engine program specs. Where a plan contradicts the spec, the spec wins until an amendment is recorded in `docs/todos/README.md`.

## Product decisions (do not re-litigate without the user)

- **Renderer:** **Babylon.js 9.32.0 is the engine base** (A19, ADR-0003), WebGPU-first with its WebGL2 fallback, behind the host's `Renderer3D`/`GameContext` contracts. No Three.js. The custom WebGPU/WebGL2 packages remain frozen in the tree, not deleted; spec 21 governs the migration.
- **Inputs:** phones **and** keyboard/mouse **and** gamepad. Phones are the signature local-multiplayer controller, not the only input.
- **Multiplayer:** local-first (same room / LAN). Online relay and state sync are a later engine layer.
- **Benchmark:** GTA Vice City is the north star. A vertical slice proves the architecture; full parity is a multi-year program.
- **Platform:** browser-only. No native app, no Electron requirement for players.
- **Display:** any browser; TV is one target, not the product boundary.
- **Physics:** **Rapier** behind a `Physics3D` interface; custom physics only if a measured need appears.
- **Engine gating:** the D0–P6 stage waterfall is retired for the engine track. Engine work uses the T0–T4 tiers and W0–W5 waves in `docs/engine/README.md`; the phone/room platform stays frozen and maintained on its own plan.
- **Isolation:** the dev server enables **COOP/COEP** (`same-origin` / `require-corp`) and CORP `same-origin`; production must keep them once the engine uses workers.

## Operating mode: spec-first, parallel, evidence-gated

The standing directive is to build as much as possible in parallel, then integrate every wave. Parallelism never skips the gate, and a 1–2 day sprint is a **foundation wave**, never “the whole engine”.

### Spec-first

- Every engine subsystem gets a spec in `docs/engine/<nn>-<name>.md` before implementation: goal, non-goals, public interfaces, data formats, file ownership, acceptance criteria, tests, dependencies, risks.
- Agents work from the spec, not from chat context. A spec must be self-contained enough for a fresh agent.
- A spec change is a design change: update the spec and its acceptance in the same change.

### One writer per file

- Before fanning out agents, declare file ownership. Never run two agents on the same file.
- Split large directories by file, not by vague area.
- Shared contracts (`GameContext`, `Renderer`, protocol, layout schema) are owned by one agent per wave.

### Waves

- Parallel inside a wave; serial at the wave boundary.
- Every wave ends with `npm run check` (typecheck, lint, tests, build, size, trace). The integration agent fixes cross-package defects; feature agents do not run repo-wide builds concurrently.
- Never leave the tree non-green at a wave boundary. Do not weaken, skip or delete a test to land a wave.
- Update the paper trail in the same change: engine spec, roadmap, `docs/ENGINE.md`, `docs/RESULTS.md` if a measurement changed, and the checkpoint.

### Contracts

- Frozen contracts change **additively**: protocol/version, `ControllerState`, layout schema, `GameContext`, renderer interfaces. Renames or semantic changes require a `PROTOCOL_VERSION` bump and an amendment.
- No game-specific code in the engine, broker, controller or runtime. A game needing a platform feature goes back to the owning engine spec.
- Pooled hot paths: no per-tick allocation in `simulate` or `render`, no `map/filter` in frame paths.

### Honesty

- **Do not commit unless the user asks.** This checkout is being pushed at the user's explicit request; that does not relax the rule for future changes.
- **Never invent measurements.** TV, Android gyro, vibration, frame time and memory stay `PENDING` until run on real hardware. Desktop Chrome is the provisional target.
- **Do not claim a milestone complete** because the code compiles. Each milestone has acceptance evidence.

## Current architecture

```
protocol  (zero deps)
   ↑
broker ← dev-server (adapter)          relay (Phase 2, same broker core)
   ↑
runtime ← games (GameContext only)
   ↑
sdk (manifest, layout, panel, UGC validators, game API, config)

controller → protocol + sdk only
tools → protocol + sdk only
```

- **`packages/protocol`** — wire truth: constants, binary codecs, JSON union, frame caps, `PROTOCOL_VERSION = 1`. Input 26 B, InputFwd 27 B, binary frames ≤ 64 B, JSON ≤ 4 KB (setLayout ≤ 16 KB, A13).
- **`packages/broker`** — transport-agnostic rooms/sessions: codes, PINs, tokens, slots/reservations, host loss, rate limits, fan-out, stats. Never interprets `event`/`panel`/layout bodies.
- **`packages/dev-server`** — thin adapter: static serving, LAN discovery, `ws` transport. The future relay reuses the broker core.
- **`packages/runtime`** — host side: fixed 60 Hz loop, input mapper, game host/context, renderer, assets, audio, debug, TV profile.
- **`packages/controller`** — phone side: layout renderer, touch engine, InputStore/SendLoop/ClockSync, join/session/reconnect, sensors, haptics.
- **`sdk/`** — the public game boundary: manifest/layout/panel/UGC validators, `GameContext`/`Game`.
- **`packages/games/*`** — one folder per game with `game.manifest.json` + entry. Games consume `GameContext` only.
- **`tools/`** — input-bot, latency-harness, size-budget, trace-check.
- **`experiments/`** — standalone probe pages.

### Target engine layers (the program)

New packages, added behind stable interfaces, without breaking the host app:

```
engine-core      loop, time, math (Vec3/Mat4/Quat), ECS/scene, jobs, memory
renderer-webgpu  WebGPU pipeline, PBR, shadows, post, LOD, GPU resources
renderer-webgl2  fallback backend behind the same interface
assets           glTF, KTX2, WebP, Opus/AAC, WOFF2, streaming, hot reload
physics          3D collision, vehicles, character, raycasts (Rapier behind Physics3D)
animation        skeletal, blend trees, root motion
audio            positional, mixer, streaming music, radio
input            phones + keyboard/mouse/gamepad, action mapping
ai               navmesh, behavior trees, traffic/peds
streaming        world cells, LOD, budgeted loading
ui               in-world/2D UI, bitmap/SDF text, HUD
tooling          editor, asset pipeline, profiler, debug
```

Migration rule: new engine packages must not import the host app. `packages/runtime` becomes a consumer of the engine. Games keep consuming `GameContext`; the renderer swap stays behind `Renderer2D`/`Renderer3D`.

## Commands

Node >= 20, npm workspaces, ESM, TypeScript strict.

```bash
npm ci                    # clean install
npm run check             # THE gate: typecheck, lint, tests, build, size, trace
npm run typecheck         # tsc -b across project references
npm run lint              # eslint (includes layer-boundary rules)
npm test                  # every Vitest project once
npm run build             # every workspace
npm run size              # controller + host gzip budgets
npm run trace             # trace check for every stage D0–D7
npm run trace:gate        # full-matrix Gate audit (red until the engine IDs exist)
```

Useful scoped commands:

```bash
npm test -- --project packages/runtime
npx vitest run packages/runtime/test/fixedLoop.test.ts
npm test -- --project packages/controller -t "hot-swap"
npm run build --workspace @lanpad/controller
node tools/trace-check/dist/cli.js --stage D7
node packages/dev-server/dist/main.js        # after npm run build
```

There is no `npm run dev`.

## Frozen defaults worth knowing

- Control loop 60 Hz; active send 60 Hz, idle 10 Hz, immediate on change; client deadzone 8%.
- Gyro i16 `dps × 10`; flags bit 0 motion active, bit 1 recentered.
- Haptics: 1–8 u16 durations, alternating vibrate/pause; 20 Hz per slot; slot 0 = all.
- Sessions: 30 s slot/host reservation; rooms expire after 10 min idle or 4 h; reconnect backoff 250 ms → 4 s; heartbeat 2 s / dead after 5 s.
- Layouts: ≤ 16 KB JSON, ≤ 24 controls, unique ids/bits/channels, all 11 control types, hot-swap per slot or all.
- Events: 30/s sustained, burst 60, 4 KB per frame; strokes batch.
- Budgets: controller ≤ 60 KB gz hard (40 dev / 50 prod target); host + game ≤ 5 MB gz hard; input-to-canvas p95 < 25 ms LAN / < 35 ms prod; 8 controllers; join < 5 s.
- 3D targets (once the engine exists): 1080p, frame p95 14 ms (hard 20 ms), ≤ 120 draw calls, ≤ 128 MB texture memory provisional, no per-frame allocations.
- Security: tokens never logged, never in a URL except the room token in the QR fragment; UGC text/canvas only; no PII or analytics; Origin allowlist and CSP.
- iOS is out of v1 acceptance: feature-detect motion/haptics, keep a playable fallback.

## Which docs to read before which task

Live status is `docs/todos/IMPLEMENTATION-ORDER.md` §6/§8 plus the newest `docs/todos/CHECKPOINT-*.md`. Do not trust unfilled stage-file checkboxes.

| Task | Read first |
|---|---|
| Any task | `SPEC.md`; `docs/ENGINE.md`; `docs/engine/README.md`; `docs/todos/IMPLEMENTATION-ORDER.md`; newest checkpoint |
| Engine subsystem | its spec in `docs/engine/`; `docs/ENGINE.md`; the owning layer doc |
| Protocol change | `docs/todos/layers/protocol.md` + `SPEC.md` §7 |
| Broker/server change | `docs/todos/layers/server.md` |
| Runtime change | `docs/todos/layers/runtime.md` |
| Controller change | `docs/todos/layers/controller.md` |
| SDK/validator change | `docs/todos/layers/sdk.md` |
| Game work | `docs/todos/layers/games.md` + the game file + D7 |
| Tools/CI change | `docs/todos/layers/tools.md` |
| Experiment/measurement | `docs/todos/layers/docs-experiments.md` + `docs/TESTING.md` + `docs/RESULTS-TEMPLATE.md` |
| Security/UGC | D5-SEC-01 section + `SPEC.md` §13 |
| Production infra | `docs/todos/layers/infra.md` + P0–P2 |

## Testing and definition of done

- Every test title carries its requirement ID: `test("[FR-7.3] sub-tick tap keeps its edge bit", ...)` or a leading `// @req FR-7.3`. A tag must resolve to a row in `TRACEABILITY.md`.
- `npm run trace` runs stages D0–D7. `npm run trace:gate` is the full-matrix Gate audit; it stays red until the engine capability IDs are implemented.
- Test layers: unit, property (`fast-check`), golden wire fixtures, integration (real dev server + broker + WebSocket), manual (`docs/RESULTS.md`).
- Integration tests bind `127.0.0.1:0`; wait on messages, never fixed sleeps.
- A work item is done only when `npm run check` is green, budgets are measured, docs/checklists are updated, and no secret/token appears in logs, fixtures or commits.

## Sharp edges discovered in this repo

- The controller and runtime `build` scripts delete `dist/assets` before Vite runs; Vite uses `emptyOutDir: false` to preserve `tsc` output. Without the cleanup, stale hashed bundles inflate the size gate.
- `sdk/dist` is generated. Never patch it; change `sdk/src/**` and rebuild.
- `packages/games/reaction-duel` and `packages/games/platformer` have no workspace `package.json`; they are discovered by Vite globs and covered by `typecheck:games` and explicit Vitest projects. A new game needs both.
- The root Vitest config defines projects explicitly. A new workspace/tool needs a project entry or its tests will not run.
- `GAME_ASSETS` in `packages/runtime/src/host/stage.ts` is currently an empty array; the asset pipeline is a stub. Do not document asset loading as working until it is wired. `packages/runtime/src/main.ts` is now a 47-line composition root; host wiring lives in `src/host/*`.
- Games are currently forced onto Canvas2D; the custom WebGL2 renderer is used by the cube demo. A 3D game cannot ship on the Canvas2D fallback.
- The controller bundle has very little headroom (40,794 / 40,960 gz dev at the last gate). Any controller feature needs a size pass.
- Host reconnect uses 250 ms → 4 s with no jitter; controller reconnect uses ±20%. Confirm before changing either.
- Host layout uses JS-set `stage-active` / `room-empty` / `connection-bad` classes; do not reintroduce `:has()` for host layout. Older TV browsers do not support it.
- The dev server alone sets `allowMissingOrigin` for bots. Production must not.
- `npm run dev` does not exist. Build, then run `node packages/dev-server/dist/main.js`.

## Engine program milestones

| Milestone | Acceptance |
|---|---|
| **M0 — Foundation** | Specs for every subsystem; WebGPU backend + WebGL2 fallback; 3D math/scene; asset manifest/loaders; KB/M/gamepad input; a textured 3D scene; gate green |
| **M1 — Vertical slice** | A 3D city block, a drivable vehicle, pedestrians, a mission, streaming, audio, save/load; measured frame p95 on desktop |
| **M2 — Engine completeness** | Animation, PBR/lighting, 3D physics, AI/navigation, world streaming, 3D UI/text, profiling budgets |
| **M3 — Open-world proof** | Vice City-scale slice with traffic, missions, content pipeline; measured on target hardware |
| **M4 — Product** | Local multiplayer, online relay, editor/tooling, SDK and docs for third-party games |

A milestone is complete only when its acceptance evidence exists. Until then, describe the engine as “in progress”, never as “GTA-class”.
