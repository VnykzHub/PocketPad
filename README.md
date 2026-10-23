# PocketPad

**A browser-native game engine. Phones become controllers. Any screen becomes the console.**

PocketPad is a custom, highly optimised game engine that runs entirely in the browser. It targets 2D and 3D games — from same-room party games to an open-world benchmark in the class of *GTA Vice City*. There is nothing to install: a host page runs the simulation and renders the game, and phones join as controllers over WebSocket, receiving a control layout built for the current game.

> **Status:** Phase 1 working build. Host, controller, rooms, sessions, layouts, sensors, 2D physics, two playable games and a custom WebGL2 renderer exist and pass the gate. A WebGPU-first renderer, the asset pipeline and the 3D engine layers are the current program. **Not yet GTA-class.** See [`docs/ENGINE.md`](docs/ENGINE.md) for what exists today and [`docs/engine/README.md`](docs/engine/README.md) for the engine program.

---

## The idea

A browser is the most portable runtime we have. Phones are the most personal input device. Put them together and you get a game platform with no install, no cables, no account, and a controller per player that also has a private screen.

The engine is not a TV accessory. **Any browser is a display target** — desktop, laptop, TV, tablet. The same engine should run a two-player party game on a TV and a single-player open-world game on a desktop, with phones joining as controllers when local multiplayer makes sense.

**North star:** an engine strong enough to build a game of *GTA Vice City*'s scope in the browser — streaming world, vehicles, pedestrians, animation, missions, audio — at a frame rate that feels good. That is the architectural ceiling. It is not the v1 claim, and this repository will not pretend otherwise.

## Why it is different

- **Zero install.** A browser on the display; a browser on each phone.
- **The phone is a first-class controller.** Multi-touch, gyro, vibration, a private screen, and per-game layouts.
- **Any screen.** The host is display-agnostic: desktop, laptop, TV, tablet.
- **A real engine, not a rendering library.** Custom WebGPU renderer with a WebGL2 fallback, scene and asset pipelines, physics, animation, audio, input, networking and tooling designed as one system.
- **Built for parallel development.** Every subsystem has a spec; games and engine layers can be developed against stable contracts at the same time.
- **Open.** The engine and SDK are intended for MIT release; games keep their authors' licenses.

## How it works today

```text
Display browser (host)  <---->  Server  <---->  Phone browser (controller)
runs the simulation            pairs rooms,       sends touch, gyro,
and renders the game           relays messages    buttons; shows private UI
```

1. The host page asks the server for a room and shows a QR code, a 4-character code and a PIN.
2. A phone scans the QR (or types the code and PIN) and joins as P1–P8.
3. The phone sends input over a WebSocket (~26 bytes per packet); the host maps it and the game reacts.
4. The game can send back vibration, layout changes and private content to any phone.

The host is authoritative. Phones never simulate, never see game state beyond their layout and private panel, and never touch a socket from control code.

## Current state (verified)

| Area | Status |
| --- | --- |
| Protocol, broker, sessions, reconnect | Working; 8 slots, 30 s reservations, host loss/recovery |
| Controller | 11 control types, touch engine, gyro, haptics, fullscreen |
| Host runtime | Fixed 60 Hz loop, `GameHost`, `GameContext`, Canvas2D + custom WebGL2 |
| Physics | 2D circles/AABB, integration, arena walls |
| Games | Reaction Duel and Coin Run (2D platformer) |
| Host/controller UI | Lobby, launcher, stage, results, notices, phone shell |
| Tests | 134 files / 1,571 tests; `npm run check` green |
| 3D engine | Cube renderer only; WebGPU backend, assets, animation, lighting, 3D physics and streaming are **not built** |

## Roadmap

| Milestone | What it proves |
| --- | --- |
| **M0 — Foundation** | Specs for every engine subsystem; WebGPU renderer with WebGL2 fallback; 3D math/scene; asset manifest and loaders; keyboard/mouse/gamepad input; a textured 3D scene |
| **M1 — Vertical slice** | A real 3D slice: a city block, a drivable vehicle, pedestrians, a mission, streaming, audio and save/load |
| **M2 — Engine completeness** | Animation, PBR/lighting, 3D physics, AI/navigation, world streaming, UI/text in 3D, profiling and budgets |
| **M3 — Open-world proof** | A Vice City-scale vertical slice with traffic, missions and a content pipeline |
| **M4 — Product** | Local multiplayer everywhere, online relay, editor/tooling, SDK and docs for third-party games |

Milestones are evidence-gated. A milestone is done only when its acceptance measurements are real, not when the code compiles.

## Quick start

Node 20+ and a modern Chromium browser.

```bash
npm ci
npm run build
node packages/dev-server/dist/main.js
```

The server binds `0.0.0.0:8080` and prints the LAN URLs.

- **Host:** `http://<lan-ip>:8080/` — use the LAN address, not localhost, so the join QR is phone-reachable.
- **Phone:** `http://<lan-ip>:8080/c` — or scan the QR.
- **Engine experiments:** `http://<lan-ip>:8080/x/`
- **Controller sensor probe:** `http://<lan-ip>:8080/x/e18/?v=3`

There is no `npm run dev`; build first.

## Repository layout

```text
packages/protocol/     wire types and binary codecs
packages/broker/       rooms, sessions, slots, relay core
packages/dev-server/   LAN dev server and static routes
packages/runtime/      host runtime: loop, GameHost, renderer, input, physics, audio
packages/controller/   phone controller
packages/games/        games
sdk/                   manifest, layout, panel, UGC validators and GameContext types
tools/                 input bots, latency harness, size budget, trace check
experiments/           standalone probe pages
docs/                  spec, engine guide, page plans, checkpoints, results
```

The engine program adds `docs/engine/` — one spec per subsystem, each with interfaces, formats, acceptance tests and file ownership so agents and humans can work in parallel.

## Honest limits

- **No 3D games yet.** The WebGL2 renderer draws cubes; the WebGPU backend and the 3D layers are the current program.
- **No asset pipeline yet.** `GAME_ASSETS` is empty; glTF/KTX2/WebP/audio/font loading is specified but not wired.
- **TV and Android evidence is PENDING.** Desktop Chrome is the provisional target; no TV, phone-sensor or haptics measurement is claimed.
- **iOS has no vibration API and gyro needs HTTPS.**
- **A Vice City-class game is a multi-year content and engine effort.** The architecture is being built for it; the repository is not there.

## Documentation

- [`SPEC.md`](SPEC.md) — product and protocol contract (authoritative).
- [`docs/ENGINE.md`](docs/ENGINE.md) — how the current engine works, end to end.
- [`docs/engine/`](docs/engine/) — engine program: architecture, subsystem specs, roadmap.
- [`docs/PAGE-PLANS.md`](docs/PAGE-PLANS.md) — host and controller page plans.
- [`docs/RESULTS.md`](docs/RESULTS.md) — measurements, including every PENDING row.
- [`docs/todos/`](docs/todos/) — stage plans, checkpoints, traceability.

## License

The engine, protocol, controller app and SDK are intended for MIT release. Games keep their authors' licenses. The project name and the hosted hub are not covered.
