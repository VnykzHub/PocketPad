# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

PocketPad (codename `lanpad`) turns a TV browser into a game console and phones into controllers. The host page runs the entire simulation and renders the game; phones send only controller state (~26 bytes per packet) over WebSocket; the server pairs rooms and relays messages. Up to 8 controllers per room, with private panels, JSON-defined layouts, gyro, and Android haptics.

Phase 1 is LAN-only dev (one Node process, no domain, no cloud). Phase 2 is production (static pages + regional relay) and must not start before the Dev Exit Gate signs GO.

`SPEC.md` at the repo root is authoritative. `docs/todos/README.md` records the agreed amendments (A1–A12); where a plan contradicts the spec, the spec wins until an amendment is recorded.

## Operating mode: accelerated but solid

The user's standing directive is to build as much as possible in parallel, then integrate every wave. Parallelism never means skipping the gate.

- **One writer per file.** Before fanning out agents, declare file ownership. Never run two agents on the same file. Split large directories by file, not by vague area.
- **Parallel inside a stage, serial across stage exits.** Disjoint workstreams may run together even when they touch different layers (the repo already runs D3/D4/D5/D6 work in waves). A stage is done only when its own exit checklist and measurements are real.
- **Every wave ends with `npm run check`.** The integration agent fixes cross-package defects; feature agents do not run repo-wide builds concurrently.
- **Never leave the tree non-green at a wave boundary.** Do not weaken, skip, or delete a test to land a wave; fix the defect in its owning layer.
- **Frozen contracts change additively.** Protocol/version, `ControllerState`, layout schema, and `GameContext` were frozen in D0/D2/D3/D5. Renames or semantic changes require a `PROTOCOL_VERSION` bump and an amendment.
- **No game-specific code in the platform.** A game needing a platform feature goes back to the owning stage; it does not get a branch in broker/controller/runtime.
- **Do not commit unless the user asks.**
- **Never invent measurements.** TV, Android gyro, and vibration rows stay `PENDING` until run on real hardware. Desktop Chrome 155 is the provisional v1 target by user decision.
- **Update the paper trail in the same change:** stage checklist, `docs/todos/IMPLEMENTATION-ORDER.md`, `docs/todos/TRACEABILITY.md` (if ownership moved), and `docs/RESULTS.md` (if a measurement changed).

## Commands

Node >= 20, npm workspaces, ESM, TypeScript strict.

```bash
npm ci                    # clean install
npm run check             # THE gate: typecheck, lint, tests, build, size, trace
npm run typecheck         # tsc -b across project references
npm run lint              # eslint (includes layer-boundary rules)
npm test                  # every Vitest project once
npm run build             # every workspace (builds controller/host bundles)
npm run size              # controller + host gzip budgets (dev tier)
npm run trace             # trace check, hard-coded to --stage D0
```

Useful scoped commands:

```bash
# One workspace's tests
npm test -- --project packages/runtime

# One test file
npx vitest run packages/runtime/test/fixedLoop.test.ts

# One test by name
npm test -- --project packages/controller -t "hot-swap"

# Build one workspace
npm run build --workspace @lanpad/controller

# Trace a later stage (root script is D0-only)
node tools/trace-check/dist/cli.js --stage D5

# Dev server (there is no `npm run dev`; build first)
npm run build
node packages/dev-server/dist/main.js        # 0.0.0.0:8080, prints LAN URLs + terminal QR

# 8-bot room load / reconnect scenarios
node tools/input-bot/dist/cli.js --server http://<lan-ip>:8080 \
  --code ABCD --pin 1234 --scenario steady --clients 8 --duration 10m

# Latency harness CLI
node tools/latency-harness/dist/cli.js --help
```

Experiments are standalone pages served by the dev server at `/x/<id>` (E1–E17). The host page is `/`; controllers are `/c/<CODE>`; game bundles are `/games/*`.

## Architecture

npm workspace: `packages/*`, `sdk`, `tools/*`. The layer rules below are enforced by `eslint.config.js`, not convention.

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

- **`packages/protocol`** — wire truth: constants, binary codecs, JSON discriminated union, frame caps, `PROTOCOL_VERSION = 1`. No runtime dependencies, no Node built-ins; must run in Node, browsers, and Deno. Input is exactly 26 bytes; `InputFwd` 27; binary frames > 64 B and JSON > 4 KB are rejected. `tick` is a u32 estimate of server time in ms (A3), not a frame counter.
- **`packages/broker`** — transport-agnostic room/session core: codes, PINs, 128-bit tokens, constant-time compare, slots/reservations, host loss, rate limits, fan-out, stats. Never interprets `event`/`panel`/layout bodies. `packages/dev-server` is a thin adapter adding static serving, LAN discovery, and the `ws` transport; the future `relay` reuses the same core (A1).
- **`packages/runtime`** — host side: fixed 60 Hz loop with interpolation and a 5×DT death-spiral clamp; `Renderer2D`/`Renderer3D` interfaces with WebGL2 + Canvas2D fallback; host WebSocket client; input mapper; game host/context; asset loader; audio unlock; debug overlay; TV profile and dynamic resolution.
- **`packages/controller`** — phone side: layout renderer and control registry, touch engine (10 touches, 44 px targets), `InputStore`/`SendLoop`/`ClockSync`, join/session/reconnect/suspend, event queue, sensors, haptics. Controls never touch the socket.
- **`sdk/`** — the public game boundary: manifest schema/validator, layout and panel validators, UGC sanitizers, config helpers, and `GameContext`/`Game` types. Validators are hand-written and shared by host and controller.
- **`packages/games/*`** — one folder per game with `game.manifest.json` + entry. Games consume `GameContext` only; no sockets, fetch, DOM, or storage. They ship layouts, never phone UI code.
- **`tools/`** — `input-bot` (N fake controllers, scenarios, jitter/loss), `latency-harness` (E5), `size-budget` (CI gate), `trace-check` (TR-1).
- **`experiments/`** — standalone probe pages, never shipped to production.

### Data flow

1. Host `POST /api/rooms` → `{ code, pin, roomToken, hostToken, expiresAt, serverTime }`.
2. Host opens `/ws` and sends `hostJoin {v, code, hostToken}`; controllers send `join` with exactly one of `token`, `pin`, or `session` (token+PIN allowed only in QR-PIN mode), and receive `{slot, session, serverTime}`.
3. Controller input: binary `Input` (C→S) → broker → `InputFwd` (S→H). The host mapper applies **latest-wins level state** and **OR-accumulated edges**; `pollAll()` clears edges once per sim tick.
4. Control: JSON `setLayout` / `panel` (H→S→C), `event` / `layoutAck` (C→S→H), `stats` (S→H), `hostStatus` (S→C). Layout/panel bodies are opaque to the broker; panel content is private to the addressed slot.
5. Games see `GameContext` only: `input`, `panels`, `layouts`, `events`, `haptics`, `renderer`, `audio`, `rng`, `debug`, `serverNow()`.

### Frozen defaults worth knowing

- Control loop 60 Hz; active send 60 Hz, idle 10 Hz, immediate on change; client deadzone 8%.
- Gyro i16 `dps × 10`; flags bit 0 motion active, bit 1 recentered.
- Haptics: 1–8 u16 durations, alternating vibrate/pause; 20 Hz per slot; slot 0 = all; global toggle mandatory.
- Sessions: 30 s slot/host reservation; rooms expire after 10 min idle or 4 h; reconnect backoff 250 ms → 4 s; heartbeat 2 s / dead after 5 s.
- Layouts: ≤ 16 KB JSON, ≤ 24 controls, unique ids/bits/channels, all 11 control types, hot-swap per slot or all with no reload.
- Events: 30/s sustained, burst 60, 4 KB per frame; strokes batch.
- Budgets: controller ≤ 60 KB gz hard (40 dev / 50 prod target); host + game ≤ 5 MB gz hard; input-to-canvas p95 < 25 ms LAN / < 35 ms prod; 8 controllers; join < 5 s.
- Security: tokens are never logged, never in a URL except the room token in the QR fragment; UGC rendered with `textContent`/canvas only; no PII or analytics; Origin allowlist and CSP on both apps.
- iOS is out of v1 acceptance (A5): feature-detect `DeviceMotionEvent.requestPermission`, never require gyro or haptics, keep a playable fallback.

## Which docs to read before which task

Do not trust the checkboxes in stage files — most are unfilled planning templates. Live status is `docs/todos/IMPLEMENTATION-ORDER.md` §6/§8 plus the newest `docs/todos/CHECKPOINT-*.md`.

| Task | Read first |
|---|---|
| Any task | `SPEC.md`; `docs/todos/README.md`; `docs/todos/IMPLEMENTATION-ORDER.md`; `docs/todos/TRACEABILITY.md`; newest checkpoint |
| D0 foundations | `docs/todos/phase-1-dev/D0-foundations.md` |
| D1 device probes | `docs/todos/phase-1-dev/D1-device-probes.md` |
| D2 controller v0 | `docs/todos/phase-1-dev/D2-controller-v0.md` |
| D3 runtime v0 | `docs/todos/phase-1-dev/D3-runtime-v0.md` |
| D4 pairing/sessions | `docs/todos/phase-1-dev/D4-pairing-sessions.md` |
| D5 layouts/events | `docs/todos/phase-1-dev/D5-layouts-events.md` |
| D6 sensors/haptics | `docs/todos/phase-1-dev/D6-sensors-haptics.md` |
| D7 proof games | `docs/todos/phase-1-dev/D7-proof-games.md` + `docs/todos/games/<game>.md` |
| Dev Exit Gate | `docs/todos/phase-1-dev/GATE-dev-exit.md` |
| Phase 2 (P0–P6) | `docs/todos/phase-2-production/P<n>-*.md` |
| Protocol change | `docs/todos/layers/protocol.md` + `SPEC.md` §7 + the owning stage's protocol section |
| Broker/server change | `docs/todos/layers/server.md` + the owning stage's server section |
| Runtime change | `docs/todos/layers/runtime.md` + the owning stage's runtime section |
| Controller change | `docs/todos/layers/controller.md` + the owning stage's controller section |
| SDK/validator change | `docs/todos/layers/sdk.md` + the owning SDK section |
| Game work | `docs/todos/layers/games.md` + the game's file + D7 |
| Tools/CI change | `docs/todos/layers/tools.md` |
| Experiment/measurement | `docs/todos/layers/docs-experiments.md` + `docs/TESTING.md` + `docs/RESULTS-TEMPLATE.md` |
| Security/UGC | D5-SEC-01 section + `SPEC.md` §13 |
| Production infra | `docs/todos/layers/infra.md` + P0–P2 |

## Testing and definition of done

- Every test title carries its requirement ID: `test("[FR-7.3] sub-tick tap keeps its edge bit", ...)` or a leading `// @req FR-7.3`. A tag must resolve to a row in `TRACEABILITY.md`.
- `npm run trace` is D0-scoped; for other stages use the CLI with `--stage D<n>`. The Gate runs the full matrix.
- Test layers: unit, property (`fast-check`), golden wire fixtures, integration (real dev server + broker + WebSocket), manual (`docs/RESULTS.md`).
- Integration tests bind `127.0.0.1:0`; wait on messages, never fixed sleeps; never mock the dev server/broker in integration tests.
- A work item is done only when `npm run check` is green, relevant budgets are measured under target, docs/checklists are updated, and no secret/token appears in logs, fixtures, or commits.

## Sharp edges discovered in this repo

- The controller and runtime `build` scripts delete `dist/assets` before Vite runs. Vite is configured with `emptyOutDir: false` to preserve `tsc` output; without the cleanup, stale hashed bundles are summed by the size gate and produce false breaches.
- `sdk/dist` is generated. Never patch it; change `sdk/src/**` and rebuild.
- `README.md` still links `docs/SPEC.md`; the actual spec is root `SPEC.md` (amendment A7).
- `packages/games/reaction-duel` is currently a folder with no workspace `package.json`; adding a game requires the manifest, entry, and registry path from D7-SDK-01, not a hard-coded menu.
- The root Vitest config defines projects explicitly. A new workspace/tool needs a project entry or its tests will not run under `npm test`.
- `npm run dev` does not exist. Build, then run `node packages/dev-server/dist/main.js`.
- Do not claim TV/Android results from a desktop browser. Desktop Chrome 155 (WebGL2 + binary WS) is the provisional target; TV/E2-full/E14 remain PENDING.
