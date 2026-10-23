# 20 — M1 vertical slice: “Block 7 courier run”

**Status:** specification. Nothing in this document is implemented. It exists so the M1 gameplay, content and engine work can proceed in parallel against one target.

**Goal:** prove the engine architecture on one playable slice — a streamed city block, a drivable car, pedestrians, one mission, positional audio and save/load — and measure it on Desktop Chrome at 1080p. M1 is complete only when §10 has evidence; until then the engine is “in progress”.

**Non-goals:** traffic density beyond the block, combat, ragdolls, online play, mission scripting language, editor-authored content, TV hardware acceptance. Those are M2/M3.

---

## 1. Assumptions (recorded so a fresh agent can start)

1. **Axes and units:** right-handed, **+Y up**, **−Z forward**, metres and seconds (00/02). Cells are XZ squares; Y is elevation (12).
2. **Cell size:** 64 m. The slice is a **3×3 cell grid** (192 m square): the centre cell is the block, the eight neighbours carry road, verge and distant façades.
3. **Players:** one player drives in M1. Phone slot 1, keyboard/mouse and gamepad map to the same action set; slots 2–8 join as passengers in M1.1, not M1.0.
4. **Performance target:** 1920×1080, frame p95 ≤ 14 ms (hard 20 ms), ≤ 120 draw calls, no per-frame allocation in simulate/render (SPEC, 00).
5. **WebGPU first, WebGL2 Tier B:** the slice must run on WebGL2 with reduced LOD and no shadows. Canvas2D is not a target.
6. **Boot budget:** the boot set (host + game code + first-ring assets) stays ≤ **5 MiB gzip**, the SPEC hard budget. Streamed cell payloads are fetched on demand and capped at **12 MiB resident**; they are never bundled into the boot set.
7. **No invented numbers:** every §10 row is PENDING until a recorded run names build, browser, GPU, date and values.

---

## 2. What the slice contains

| Element | M1.0 quantity | Notes |
|---|---|---|
| Streamed cells | 9 authored cells (3×3) | Centre at origin; each cell is one `.cell` payload |
| Buildings | 14 boxes, 3–7 storeys | One material atlas; no interiors |
| Roads | Ring road, 12 m wide, 4 lanes | Flat, with curbs and lane markings baked into the visual mesh |
| Vehicle | 1 sedan | 4 wheels, 1,250 kg, enter/exit, engine audio |
| Pedestrians | 12 | Waypoint walkers, panic on horn, no ragdoll |
| Mission | 1 (“Courier run”) | 3 checkpoints, 90 s, pass/fail/results |
| Audio | 7 cues | engine loop, tyre skid, horn, footstep, checkpoint, success, music bed |
| Save slots | 1 local | Mission checkpoint + vehicle pose + settings |

---

## 3. World layout

```
        z−96        z−32         z32         z96
 x−96  ┌───────────┬───────────┬───────────┐
       │    C3     │    C2     │    C1     │   ring road / façades
       ├───────────┼───────────┼───────────┤
 x−32  │    C4     │  BLOCK 7  │    C6     │   centre cell = city block
       ├───────────┼───────────┼───────────┤
 x32   │    C7     │    C8     │    C9     │   spawn + results
       └───────────┴───────────┴───────────┘
```

- **Origin** is the centre of the road intersection south of the block. The centre cell spans `[-32, 32]` on both XZ axes. The car spawns on the south road at `(0, 0.5, 32)`, facing **+X** (yaw +90° about Y, eastbound).
- **Block 7** occupies the centre cell: a 40 m × 40 m building footprint (`[-20, 20]` on both axes), with a 6 m service alley on its east side.
- **Ring road** runs along the cell boundaries at ±32 m; sidewalks are 4 m; building façades sit behind them.
- **Checkpoints** are 6 m radius discs at: north-west bend `(-40, 0, -40)`, east road `(38, 0, 8)`, south-east bend `(44, 0, 40)`. The delivery marker is `(0, 0, 38)` on the south road.
- **Spawn ring** (C7/C8/C9) holds 12 pedestrians on a waypoint loop; they never leave the ring in M1.0.

Cells are authored in the 12 format with `cellSizeMeters: 64`, `origin` at `(-96, 0, -96)` for the 3×3 subset, and LOD0/1/2/3 payloads. LOD3 reuses the LOD2 geometry in M1.0 (12 requires an authored LOD3); it may be an impostor atlas later.

---

## 4. Vehicle

**Controls (action map, identical on all input sources):**

| Action | Phone | Keyboard | Gamepad |
|---|---|---|---|
| `throttle` | right trigger | W / ↑ | RT |
| `brake` | left trigger | S / ↓ | LT |
| `steer` | left stick X | A/D or ←/→ | left stick X |
| `handbrake` | B | Space | A |
| `horn` | A | H | B |
| `interact` | Y | E | Y |
| `camera` | right stick | mouse | right stick |

**Physics parameters (targets, tuned in M1.0):** mass 1,250 kg, wheel radius 0.34 m, suspension travel 0.22 m, max steer 32°, engine force 5,800 N, brake force 12,000 N, top speed 42 m/s, CCD on above 25 m/s.

**Acceptance behaviours:** 0→30 m/s in ≤ 8 s; the 150 m slalom from ER-07-03 without rollover; brake to < 0.2 m/s; no wheel leaves contact for more than 5 consecutive ticks. These reuse the physics fixtures; the slice does not duplicate them.

**Camera:** chase camera 5.5 m behind, 2.2 m above, 0.12 s critically damped follow, 8° look-down; a raycast keeps it out of buildings. Camera interpolation uses the loop alpha.

---

## 5. Pedestrians

- Capsule bodies (radius 0.28 m, height 1.7 m), kinematic by default; they become dynamic only when pushed, then return to waypoint motion.
- Waypoint graph: 8 nodes per sidewalk loop, 1.2 m/s walk, 2.5 m/s panic run for 4 s after a horn within 12 m.
- Animation: `idle`, `walk`, `run`, `panic` clips sampled at 30 Hz; skinned meshes share one skeleton. No ragdoll, no IK, no root motion in M1.0.
- Peds are simulated only while their cell is resident at LOD0/LOD1; at LOD2 they are static silhouettes. Despawn/respawn must not change the mission outcome.

---

## 6. Mission: “Courier run”

A deterministic state machine, owned by the game (not the engine):

```
idle → enterCar → driveTo(0) → driveTo(1) → driveTo(2) → deliver → results
         ↑                           │
         └──────── fail/retry ───────┘
```

| State | Entry condition | Exit condition | Fail |
|---|---|---|---|
| `idle` | game init | player presses `interact` near the car | — |
| `enterCar` | car entered | car moves 5 m | — |
| `driveTo(n)` | previous checkpoint reached | car within 6 m of checkpoint n at < 3 m/s | timer expires or car destroyed |
| `deliver` | 3 checkpoints | 2 s hold at the delivery marker | leaves the marker |
| `results` | delivered | `retry` or `exit` | — |
| `fail` | any fail | `retry` | — |

- Timer: 90 s from `enterCar`; HUD shows mm:ss.t; the last 10 s pulse red.
- Retry resets the car, peds, timer and mission state from the same seed; it does not reload assets.
- Results show time, checkpoints, top speed, and a star rating (time thresholds are game data, not engine constants).
- Mission data lives in `mission.json`: `id`, `checkpoints[{x,z,radius}]`, `timeLimitSeconds`, `delivery{x,z}`, `seed`. No dates, no PII.

**Determinism:** the same seed and input trace produce the same mission state hash at tick 600. The game hashes only gameplay state (phase, checkpoint index, timer ticks, car pose quantised to 1 cm, ped positions quantised to 1 cm); it excludes render and audio state.

---

## 7. Audio

| Cue | Bus | Positional | Trigger |
|---|---|---|---|
| `engine-loop` | SFX | yes (car) | RPM-derived pitch/volume, one voice |
| `tyre-skid` | SFX | yes | slip > 0.35, one voice |
| `horn` | SFX | yes | `horn` action, 0.4 s |
| `footstep` | SFX | yes | animation event, peds within 20 m |
| `checkpoint` | SFX | no | checkpoint reached |
| `mission-success` | Music | no | deliver complete |
| `music-bed` | Music | no | loop from `enterCar`, stop at `results` |

Rules from 09 apply: no `AudioContext` before the start-screen gesture; one context; voices capped at 24; music crossfade 1.5 s; hidden tab suspends and resumes the same track; missing audio is silent but playable. Engine tone is synthesised from two detuned oscillators through a low-pass; no engine sample ships in M1.0.

---

## 8. Save and load

Save once at `deliver` and when the player exits the mission; load from the start screen's “Continue”.

Payload (opaque to the engine, wrapped in the 15 save envelope):

| Field | Type | Meaning |
|---|---|---|
| `phase` | string enum | last mission phase (`enterCar`, `driveTo`, `deliver`, `results`) |
| `checkpointIndex` | u8 0–3 | next checkpoint |
| `elapsedMs` | u32 | mission time at save |
| `carPosition` | 3× f32 | quantised to 1 cm |
| `carYaw` | f32 | radians, normalised |
| `seed` | u32 | mission seed |
| `gameVersion` | string | manifest `version` |

- `savedAt` is the engine's u32 epoch seconds (15), never a JS `Date` string.
- Missing or corrupt save: start a new run, show a fixed notice, never a stack trace.
- A save from a different `gameVersion` or seed is rejected with `E_SAVE_VERSION`/`E_SAVE_FORMAT` as 15 specifies.
- No PII, no token, no room code in a save.

---

## 9. Interfaces and budgets

| Concern | Interface | Owner |
|---|---|---|
| Game lifecycle | `GameContext` v2 (`scene`, `assets`, `animation`, additive `world`) | 18 |
| Vehicle, peds | Engine `Physics3D` behind the additive `ctx.world` layer (no `ctx.physics` member is frozen) | 07 |
| World load | `WorldStreamer` + `WorldCell` | 12 |
| Animation | `AnimationApi` | 08 |
| Audio | `AudioSystem` | 09 |
| Input | action map, phone + KB/M + gamepad | 10 |
| HUD | 2D overlay + SDF text | 13 |
| Persistence | save envelope | 15 |

Slice budgets:

- frame p95 ≤ 14 ms; physics step p95 ≤ 2.5 ms; streamer `update` p95 ≤ 2 ms; apply p95 ≤ 0.5 ms per cell; audio hot path ≤ 0.3 ms.
- ≤ 120 draw calls; ≤ 128 MiB texture memory; ≤ 64 MiB physics heap.
- No main-thread task caused by streaming or decode longer than 8 ms.
- Controller bundle stays ≤ 60 KB gz and byte-identical to the pre-slice build (no controller feature is added).

---

## 10. Acceptance rows

| ID | Acceptance | Evidence | Status |
|---|---|---|---|
| M1-A1 | The 3×3 world manifest validates and all 9 cells become resident at LOD0 within 3 s on a local server | `packages/games/block7/test/`, browser run | PENDING |
| M1-A2 | Drive the full route at ≥ 20 m/s with no cell activating late or popping at LOD0 inside 96 m | recorded drive + streamer stats | PENDING |
| M1-A3 | Car: 0→30 m/s ≤ 8 s, slalom without rollover, brake < 0.2 m/s (reuses ER-07-03) | physics fixture + slice run | PENDING |
| M1-A4 | 12 peds walk their loops for 10 minutes without leaving their cells or NaN transforms | deterministic 36,000-tick run | PENDING |
| M1-A5 | Mission completes, fails and retries from the same seed with identical state hashes at tick 600 | `test/fixtures/mission-600.json` | PENDING |
| M1-A6 | Save → reload → save is byte-identical for the same state; corrupt saves fail with the named code | unit + browser | PENDING |
| M1-A7 | Frame p95 ≤ 14 ms at 1920×1080 on Desktop Chrome 155 / RTX 3050 Ti, WebGPU; WebGL2 Tier B records its own p95 | `docs/RESULTS.md`, `?bench=1` | PENDING |
| M1-A8 | ≤ 120 draw calls and zero per-frame allocations in simulate/render after warm-up | profiler + allocation counter | PENDING |
| M1-A9 | Phone slot 1 completes the mission; KB/M and gamepad produce the same action stream for the same scripted input | input-bot + manual | PENDING |
| M1-A10 | Hidden tab pauses simulation and audio; resume continues the same track without a clock jump | browser integration | PENDING |
| M1-A11 | A simulated device loss on WebGL2 restores the slice without losing the save or mission state | browser integration | PENDING |
| M1-A12 | No secret, token or PII appears in a save, a log or a fixture | grep audit in the gate | PENDING |

Every row maps to a test tag or a `docs/RESULTS.md` row once implemented. A row is never marked PASS from a unit test when it names a browser or hardware run.

---

## 11. File ownership for the M1 wave

| Area | Files | Notes |
|---|---|---|
| Game | `packages/games/block7/**` (manifest, entry, render, mission, hud, audio) | Consumes `GameContext` only; no engine imports |
| Assets | `packages/games/block7/assets/**` + generated `.cell` files | Hand-authored or scripted; licences recorded in `docs/DEPENDENCIES.md` |
| Physics tuning | `packages/engine/physics/src/rapier/**` | One owner; no game-specific code |
| Streaming | `packages/engine/streaming/**` | One owner; no game-specific code |
| Animation | `packages/engine/animation/**` | One owner |
| Host integration | `packages/runtime/src/engine/**`, `host/stage.ts` | One owner per file; manifest renderer flag is additive (RV-49) |

Games never import an engine package; the runtime projects engine objects into the SDK shapes (18).

---

## 12. Dependencies and risks

| Dependency | Needed for | Risk |
|---|---|---|
| Rapier adapter (07/A15) | vehicle, peds, camera raycast | WASM size and determinism; blocked until the A15 payload row exists |
| Streaming (12) | cells, LOD, budgets | main-thread stalls; needs worker decode |
| Animation (08) | peds | skinning path not implemented yet |
| Audio (09) | engine loop, music | autoplay gesture on TV; browser rows PENDING |
| Save (15) | continue | envelope implemented in core; game payload is new |
| Host 3D path (RV-49) | opening a 3D game at all | stage currently forces Canvas2D; fix with this slice |

**Stop rules:** if the streaming package cannot keep `update` p95 ≤ 2 ms with worker decode, reduce the slice to 1×1 authored cell before weakening any acceptance row. If Rapier's payload breaks the 5 MB gz host budget, re-open A15 rather than splitting into a per-game path.

---

## 13. Paper trail

- This spec is the W3 target in `docs/engine/README.md` §8.1.
- Measurements land in `docs/RESULTS.md`; status lands in the newest checkpoint.
- A design change updates this spec and its acceptance in the same change.
