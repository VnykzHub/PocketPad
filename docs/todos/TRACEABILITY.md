# Requirement Traceability Matrix

> Canonical mapping for TR-1: **every** requirement ID in `SPEC.md` has an owning work item, a layer, a goal, and at least one tagged test.
> This file is a view. The work itself lives in the stage files; the checkboxes there are the status.

**How the trace checker works (built in `D0-QA-01`):**

1. Parse the `ID` column of every table below.
2. Scan `packages/**/test/**`, `tools/**/test/**`, and `experiments/**` for test titles or `@req` annotations containing each ID.
3. Fail CI if any ID has zero tags.
4. Also fail if a test references an ID not present here (catches typos and stale tags).

**Tag format:** `test('[FR-7.3] sub-tick tap keeps its edge bit', ...)` or a leading comment `// @req FR-7.3`. One test may carry multiple IDs, but every ID needs at least one test that actually exercises it.

**Updating:** when a requirement's implementation moves, update its `Primary work item` cell in the same commit that moves the work. Never delete a row; mark it with the successor ID if the spec changes.

---

## 1. Product goals

Goals are not one-time tasks; they are proof points. Each must be demonstrated at the listed stage.

| ID | Goal | Proof stage | Evidence |
|---|---|---|---|
| G1 | Phone joins as controller in under 5 s from QR scan | D4 | `G1 scan→playable` timing log + manual run in D4-EXP-01 |
| G2 | Input-to-canvas under 35 ms p95 prod, under 25 ms LAN dev | D3 baseline, D7 per game, P5 gate | E5 results, per-game latency, P5-QA-02 |
| G3 | Baseline game bundle under 5 MB gz (target 3.5 MB) | D0 gate, D7, P5 | Size report per build |
| G4 | 8 simultaneous controllers per room | D4, P5 | 8-client input-bot run |
| G5 | Multi-touch, gyro, vibration, private screens with graceful degradation | D2/D5/D6, D7 games | Device checklist + game acceptance |
| G6 | Primary path works on a TV browser alone, no PC | P2, P5 | TV-only acceptance run |
| G7 | Every dependency justified by byte cost and measured TV performance | D0, every stage, Gate | Dependency review + size gate |
| G8 | Game SDK so third parties can ship games | P4 | Clean-machine SDK dry run |

---

## 2. Functional requirements

### 2.1 Architecture and transport (§4)

| ID | Short requirement | Layer | Primary work item(s) | Goal |
|---|---|---|---|---|
| FR-4.1 | Host reaches playable with no local process and no PC | Infra/ops | P2-INFRA-01, P2-QA-01 | G6 |
| FR-4.2 | Production relay runs in a region near users (Mumbai-class) | Infra/ops | P0-OPS-01, P0-OPS-02 | G2 |
| FR-4.3 | Same host/controller/runtime code in both environments; only origin differs | SDK/Runtime | D0-SDK-01, P2-INFRA-02 | G6, G7 |
| FR-4.4 | WebSocket is the only transport in v1 | Protocol/Server | D0-PROTO-01, D0-SRV-03 | G2 |
| FR-4.5 | WebRTC is an experiment, not a v1 feature | Docs/experiments | D7-EXP-01, P0-OPS-01 | G2 |
| FR-4.6 | Server URL comes from config; users never configure transport | SDK/Runtime | D0-SDK-01 | G6 |

### 2.2 Pairing and sessions (§5)

| ID | Short requirement | Layer | Primary work item(s) | Goal |
|---|---|---|---|---|
| FR-5.1 | Room token lives in the URL fragment only | Controller | D4-HOST-01, D4-CTRL-01 | G1 |
| FR-5.2 | Rooms expire after 10 min idle or 4 h maximum | Server | D4-SRV-02 | G4 |
| FR-5.3 | A 9th controller receives `roomFull` | Server | D4-SRV-02 | G4 |
| FR-5.4 | Rejoin with session token returns the same slot while the 30 s reservation is live; never uses the room token | Server/Controller | D4-SRV-02, D4-CTRL-02 | G1, G4 |
| FR-5.5 | Expired reservation: phone rejoins as a new player or the host/game decides | Server | D4-SRV-02 | G1 |
| FR-5.6 | Manual join (code + PIN) works with no camera | Controller | D4-CTRL-01 | G1 |

### 2.3 Protocol (§7)

| ID | Short requirement | Layer | Primary work item(s) | Goal |
|---|---|---|---|---|
| FR-7.1 | Send Input at 60 Hz with input, 10 Hz idle, immediately on any change | Controller | D2-CTRL-03 | G2 |
| FR-7.2 | `buttons` is the 16-bit level bitfield defined in the spec | Protocol | D0-PROTO-01 | G5 |
| FR-7.3 | `edges` is a press-edge bitfield; sub-tick taps are recoverable | Protocol/Runtime | D0-PROTO-02, D2-CTRL-03, D2-RT-01 | G2, G5 |
| FR-7.4 | Analog values are i16 [-32767, 32767]; client deadzone 8%, host configurable | Protocol/Controller | D0-PROTO-02, D2-CTRL-03 | G5 |
| FR-7.5 | Gyro values are i16 dps × 10 (range ±3276 dps) | Protocol | D0-PROTO-02, D6-CTRL-02 | G5 |
| FR-7.6 | `flags` bit 0 motion active, bit 1 recentered, bits 2–7 reserved | Protocol | D0-PROTO-02, D6-CTRL-02 | G5 |
| FR-7.7 | Touchpad maps to `rx/ry`, sliders to `lt/rt`; duplicate channel bindings rejected | SDK/Server | D5-SDK-01, D5-CTRL-01 | G5 |
| FR-7.8 | `event` is rate-limited 30/s burst 60 per slot and size-limited 4 KB; strokes batch | Server/Controller | D5-SRV-01, D5-CTRL-05 | G5, G4 |
| FR-7.9 | Server never interprets `event` or `panel` bodies | Server | D5-SRV-01 | G4 |
| FR-7.10 | Input is stamped from the synced clock; fair games compare timestamps, not arrival order | Runtime/Server | D3-RT-03, D4-EXP-01 | G2 |
| FR-7.11 | Latest level state wins; at most a 1-frame smoothing buffer | Runtime | D2-RT-01 | G2 |
| FR-7.12 | Edges OR-accumulate across every packet since the last tick; `poll()` clears | Runtime | D2-RT-01 | G2 |
| FR-7.13 | Report input-to-canvas and canvas-to-photon separately | Tools/Runtime | D3-TOOL-01, D3-EXP-01 | G2 |
| FR-7.14 | Heartbeat every 2 s; dead after 5 s silence | Controller/Server | D4-CTRL-02, D4-SRV-03 | G4 |
| FR-7.15 | Reconnect backoff 250 ms to 4 s cap; rejoin with session token | Controller | D4-CTRL-02 | G1 |
| FR-7.16 | Host drop → `hostLost` for 30 s; host token restores the room | Server | D4-SRV-03, D4-HOST-02 | G4 |
| FR-7.17 | Game code reads `ControllerState` and events only, never sockets | Runtime/SDK | D3-SDK-01, D7-SDK-01 | G8 |

### 2.4 Controller app (§8)

| ID | Short requirement | Layer | Primary work item(s) | Goal |
|---|---|---|---|---|
| FR-8.1 | v1 control types: button, dpad, stick, trigger, touchpad, slider, gyro, choice, panel, text, canvas | Controller/SDK | D2-LAYOUT-01, D5-CTRL-01 | G5 |
| FR-8.2 | Layouts hot-swap per slot or for all with no page reload | Controller | D5-CTRL-02 | G5 |
| FR-8.3 | ≤ 2 ms scripting per frame; transform/opacity only; cache rects on resize/orientation | Controller | D2-CTRL-02, D5-CTRL-02, D2-PERF-01 | G3, G5 |
| FR-8.4 | Layout validator runs on host and controller; supports `?layout=debug` grid | SDK | D5-SDK-01 | G5, G8 |
| FR-8.5 | Gyro smoothing configurable per layout (default alpha 0.15) | Controller/Runtime | D6-CTRL-02, D6-RT-01 | G5 |
| FR-8.6 | Support 10 simultaneous touches | Controller | D2-CTRL-01 | G5 |
| FR-8.7 | Pressed state renders in the same frame as the touch | Controller | D2-CTRL-02 | G2, G5 |
| FR-8.8 | On hidden: `suspend`, stop sensors, release wake lock; on visible: rejoin by session | Controller | D4-CTRL-02 | G1, G4 |
| FR-8.9 | `text`/`canvas` handle the on-screen keyboard resizing the viewport | Controller | D5-CTRL-03 | G5 |
| FR-8.10 | Games always provide a non-gyro fallback | Controller/SDK | D5-SDK-01, D6-CTRL-03 | G5 |
| FR-8.11 | Haptics rate-limited 20 Hz per slot and coalesced | Controller | D6-CTRL-04, D6-SRV-01, D6-RT-01 | G5 |
| FR-8.12 | Global haptics toggle | Controller | D6-CTRL-04 | G5 |

### 2.5 Host runtime (§9)

| ID | Short requirement | Layer | Primary work item(s) | Goal |
|---|---|---|---|---|
| FR-9.1 | Fixed timestep, variable render, interpolation | Runtime | D3-RT-01 | G2 |
| FR-9.2 | Host hidden → pause sim and send `hostPause` | Runtime | D4-HOST-02 | G4 |
| FR-9.3 | WebGL2 only in v1; friendly failure screen otherwise | Runtime | D3-RT-02 | G6 |
| FR-9.4 | TV profile: DPR 1, render at 1080p or lower, CSS upscale | Runtime | D3-RT-07 | G3 |
| FR-9.5 | Frame time > 20 ms for 30 frames → drop render scale 10% (floor 60%), recover slowly | Runtime | D3-RT-07 | G3 |
| FR-9.6 | Initial download ≤ 5 MB; lazy-load per scene | Runtime/Games | D3-RT-02, D7-PERF-01 | G3 |
| FR-9.7 | Real progress bar tied to fetched bytes | Runtime | D3-RT-02 | G3 |
| FR-9.8 | Chunked streaming with configurable load/unload radius | Runtime | P6-RT-01 | G3 |
| FR-9.9 | ≥ 3 LOD tiers per streamed object; no per-frame GPU buffer allocation | Runtime | P6-RT-01 | G3 |
| FR-9.10 | Streaming work never blocks main thread > 8 ms; decode in a worker where possible | Runtime | P6-RT-01 | G3 |
| FR-9.11 | Audio needs a gesture; host opens on "Press Enter to start" | Runtime | D3-RT-05 | G6 |
| FR-9.12 | Dev root is host page; production has a short TV URL | Infra/ops | D0-SRV-01, P2-INFRA-03 | G1, G6 |
| FR-9.13 | Game picker: any player can browse/vote; host shows the pick | Games | P6-HUB-01, P6-HUB-02 | G5, G8 |

### 2.6 Repo and licensing (§10)

| ID | Short requirement | Layer | Primary work item(s) | Goal |
|---|---|---|---|---|
| FR-10.1 | `protocol` has zero dependencies and runs in Node, browsers and Deno | Protocol | D0-PROTO-01, D0-REPO-01 | G7, G8 |
| FR-10.2 | `runtime` must not import `controller` (ESLint rule) | Runtime/Tools | D0-REPO-01 | G7 |
| FR-10.3 | Game manifest: name, entry, layouts, assetBudget, minPlayers, maxPlayers, needsGyro, chunkConfig? | SDK | D0-SDK-01, D3-SDK-01, D7-SDK-01 | G8 |
| FR-10.4 | Engine/protocol/controller/SDK MIT; games keep their authors' licenses; brand boundary documented | Docs | P4-DOCS-01 | G8 |

### 2.7 Device capability (§12)

| ID | Short requirement | Layer | Primary work item(s) | Goal |
|---|---|---|---|---|
| FR-12.1 | Feature-detect everything; no UA sniffing for capability | Runtime/Controller | D1-EXP-02, D3-RT-02, D6-CTRL-01 | G5, G6 |
| FR-12.2 | `?debug=1` overlay: backend, FPS, frame p50/p95, ticks, draw calls, texture MB, per-slot stats | Runtime | D3-RT-06 | G2, G4 |

---

## 3. Non-functional requirements

| ID | Short requirement | Layer | Primary work item(s) | Goal |
|---|---|---|---|---|
| NR-6.1 | Host JS (engine + game) gz ≤ 5 MB; engine core aspirational < 400 KB gz | Runtime/Tools | D0-TOOL-02, D3-RT-02, D7-PERF-01 | G3 |
| NR-6.2 | No virtual-DOM framework in the render loop | Runtime | D3-RT-02, P4 review | G3 |
| NR-6.3 | Controller JS ≤ 60 KB gz (target 40 dev / 50 prod) | Controller/Tools | D0-TOOL-02, D2-PERF-01 | G1, G3 |

---

## 4. Performance requirements

| ID | Short requirement | Layer | Primary work item(s) | Goal |
|---|---|---|---|---|
| PR-6.1 | `setNoDelay(true)` on all sockets | Server | D0-SRV-03 | G2 |
| PR-9.1 | ≤ 120 draw calls per frame | Runtime/Games | D3-RT-02, D7-RT-02 | G3 |
| PR-9.2 | GPU texture memory budget from E2 (provisional 128 MB) | Runtime | D1-BUDGET-01, D3-RT-02 | G3 |
| PR-9.3 | Zero allocations in the hot loop | Runtime/Games | D3-RT-01, D7-RT-02 | G2 |
| PR-9.4 | Pool all spawned entities | Runtime/Games | D7-RT-02 | G3 |
| PR-9.5 | No `map`/`filter` in per-frame paths | Runtime/Games | D7-RT-02 | G2 |
| PR-9.6 | Instance repeated meshes (> 10 copies) | Runtime | D3-RT-02, P6-RT-01 | G3 |
| PR-9.7 | Frustum culling always on | Runtime | D3-RT-02, P6-RT-01 | G3 |
| PR-9.8 | HUD text drawn to a cached offscreen canvas | Runtime | D7-RT-01 | G3 |
| PR-11.1 | Latency harness measures tap-to-host-canvas flash; input-bot automates regression | Tools | D3-TOOL-01, D7-EXP-01, P5-QA-02 | G2 |
| PR-11.2 | No memory hard-fail before E2 runs on real TVs | Docs/experiments | D1-BUDGET-01, GATE-PERF-01 | G3 |

---

## 5. Security and privacy requirements

| ID | Short requirement | Layer | Primary work item(s) | Goal |
|---|---|---|---|---|
| SR-1 | Tokens ≥ 128-bit random; constant-time compare | Server | D4-SRV-01, P1-SRV-03 | G1, G4 |
| SR-2 | Room token in URL fragment only | Controller | D4-HOST-01, D4-CTRL-01 | G1 |
| SR-3 | Dev server binds to LAN with visible warning; never public | Server | D0-SRV-01 | G7 |
| SR-4 | PIN always required for manual join; optional PIN-required-for-QR mode | Server | D4-SRV-01, P3-SEC-02 | G1 |
| SR-5 | Join rate limit 5 attempts/min/IP, then lockout | Server | D4-SRV-01, P3-SEC-01 | G4 |
| SR-6 | Max 8 controllers; binary frames > 64 B and JSON > 4 KB rejected and socket closed (A13: `setLayout` JSON up to 16 KB) | Protocol/Server | D0-PROTO-03, D5-PROTO-01, D5-SRV-01, D5-CTRL-05, P3-SEC-03 | G4 |
| SR-7 | No PII, no analytics | Infra/docs | P3-OPS-01, P4-DOCS-01 | G7 |
| SR-8 | CSP on both apps; production CSP lists relay origins | Infra/ops | P2-SEC-01, P3-SEC-03 | G6 |
| SR-9 | Log room create/join/leave, never tokens | Server | D0-SRV-03, D4-SRV-01, P3-OPS-01 | G7 |
| SR-10 | Persistent "Anyone with this code can join" notice on the host | Controller/Host UI | D4-HOST-01 | G1 |
| SR-11 | Validate WebSocket `Origin` against an allowlist | Server | D0-SRV-03, P1-SRV-03 | G4 |
| SR-12 | Relay never persists message bodies | Server | P1-SRV-03, P3-OPS-01 | G7 |
| SR-13 | UGC shown only to the room, never stored; profanity-filter hook | Docs/Controller | D5-SEC-01, P3-SEC-04 | G5 |

---

## 6. Accessibility requirements

| ID | Short requirement | Layer | Primary work item(s) | Goal |
|---|---|---|---|---|
| AR-3 | Global haptics toggle | Controller | D6-CTRL-04 | G5 |
| AR-4 | Host is operable with TV remote arrow keys and Enter | Runtime/Hub | D3-RT-05, D4-HOST-01, P6-HUB-01, P5-QA-04 | G6 |
| AR-5 | Minimum touch target 44 × 44 CSS px | Controller | D2-CTRL-01, D2-CTRL-02 | G5 |

---

## 7. Testing requirement

| ID | Short requirement | Layer | Primary work item(s) | Goal |
|---|---|---|---|---|
| TR-1 | Every requirement ID has at least one tagged test | Docs/QA | D0-QA-01, GATE-ARCH-01 | G7, G8 |

---

## 8. Experiments

Each experiment is a verification task, not a feature. Results go in `docs/RESULTS.md` with device, OS, browser version and numbers.

| ID | Question | Stage | Work item | Pass criterion |
|---|---|---|---|---|
| E1 | What can the TV browser do? | D1 | D1-EXP-02 | WebGL2 + binary WS present |
| E2 | How much memory can the page use? | D1 | D1-EXP-03 | Usable limit recorded; budgets at 70% |
| E3 | How fast is the TV? | D1 | D1-EXP-04 | ≥ 30 fps at 720p with 1k+ instances |
| E4 | LAN network quality | D4 | D4-EXP-01 | RTT p95 < 8 ms on 5 GHz |
| E5 | Real input-to-canvas latency | D3 | D3-EXP-01 | p95 < 25 ms (LAN) |
| E6 | TV display lag | D3 | D3-EXP-01 | Number recorded (Game Mode on/off) |
| E7 | Gyro reality | D6 | D6-EXP-01 | Stable, remappable rates on Android; iOS deferred (A5) |
| E8 | Vibration feel | D6 | D6-EXP-01 | Distinct patterns at 20 Hz on Android |
| E9 | Clock-sync fairness | D4 | D4-EXP-01 | Timestamp error < 5 ms |
| E10 | Stroke streaming | D5 | D5-EXP-01 | < 20 KB/s per drawer, delay < 100 ms |
| E11 | Audio on TV | D3 | D3-EXP-01 | Latency measurable and calibratable |
| E12 | Three.js vs thin custom renderer | D3 | D3-EXP-01 | Decision recorded |
| E13 | Production infra | D7 | D7-EXP-01, P0-OPS-01 | Mumbai-class RTT p95 < 25 ms |
| E14 | Mixed content / private network restrictions | D1 | D1-EXP-05 | Confirmed |
| E15 | Phone lifecycle recovery | D4 | D4-EXP-01 | Recovery < 1 s inside the 30 s reservation |
| E16 | Keyboard handling | D5 | D5-EXP-01 | Layout stays usable |
| E17 | Soak | D7 | D7-EXP-01 | Memory growth < 10%, no crashes |

---

## 9. Game capability tags

These are not requirements; they map which platform capability each game needs and when it is built.

| ID | Capability | Built in | First exercised by |
|---|---|---|---|
| C1 | Buttons, stick, multi-touch | D2 | Reaction Duel, Sumo Bumpers |
| C2 | Edge latch, synced timestamps | D2–D3 | Reaction Duel |
| C3 | Private panel | D5 | Draw and Guess |
| C4 | Text entry and choice list | D5 | Draw and Guess, Bluff Quiz |
| C5 | Canvas stroke streaming | D5 | Draw and Guess |
| C6 | Gyro | D6 | Tilt Maze Race |
| C7 | Haptics (Android) | D6 | Sumo Bumpers full, Sword Swing Duel |
| C8 | Host audio and sync | D3, E11 | Reaction Duel, Beat Tap |
| C9 | Simple physics (circles/AABB) | D3, D7 | Sumo Bumpers, Tilt Maze Race |
| C10 | 3D rendering, LOD, streaming | D3, P6 | Open-World Showcase |

---

## 10. Coverage audit checklist (Gate)

- [ ] Every ID in §2–§7 appears in at least one tagged test.
- [ ] Every experiment E1–E17 has a `docs/RESULTS.md` row with device/OS/browser/numbers.
- [ ] Every goal G1–G8 has the listed evidence recorded.
- [ ] Every capability C1–C10 is exercised by at least one proof or catalog game.
- [ ] No test tags reference an ID that does not exist here.
- [ ] Amendments A1–A13 are either implemented or explicitly rejected with a replacement plan.

---

## 10.1 Engine acceptance rows (W0+)

Engine acceptance IDs are Gate-audited, not owned by a phone-platform stage. A row is added when its first tagged test lands.

| ID | Short requirement | Layer | Primary work item(s) | Goal |
|---|---|---|---|---|
| ER-00-02 | The engine package graph has no forbidden edge; `engine-core` has zero runtime dependencies | Engine/QA | W0-CONTRACTS | M0 |
| ER-00-14 | Renderer selection probes WebGPU → WebGL2 → Canvas2D, refuses 3D on Canvas2D and leaks no exception text | Engine/QA | W1-RUNTIME | M0 |
| ER-00-15 | The scene encoder resolves ready assets, sorts deterministically and reuses pooled buffers | Engine/QA | W1-RUNTIME | M0 |
| ER-00-16 | Ready assets resolve to cached GPU handles with ABI 1 mesh packing, format gating and refcounted destruction | Engine/QA | W1-RUNTIME | M0 |
| ER-01-01 | The fixed 60 Hz loop produces the expected tick count and alpha for 30–144 Hz input | Engine/QA | W1-CORE | M0 |
| ER-01-02 | A long stall is clamped to `maxCatchUpSteps` with no backlog | Engine/QA | W1-CORE | M0 |
| ER-01-03 | Pause runs no ticks; paused frames render alpha 0; resume runs exactly one | Engine/QA | W1-CORE | M0 |
| ER-01-04 | Held pause reasons aggregate and release only when all are clear | Engine/QA | W1-CORE | M0 |
| ER-01-05 | The loop clock is monotonic under random and invalid deltas | Engine/QA | W1-CORE | M0 |
| ER-01-06 | Frame stats percentiles match nearest-rank and reuse caller objects | Engine/QA | W1-CORE | M0 |
| ER-01-10 | Jobs dispatch by priority, drain globally by id, and contain cancellation/crashes | Engine/QA | W1-CORE | M0 |
| ER-01-12 | The host tick order matches the seven-step contract | Engine/QA | W1-CORE | M0 |
| ER-02-01 | Vec algebra, aliasing and degenerate inputs behave as specified | Engine/QA | W1-CORE | M0 |
| ER-02-02 | Mat3/Mat4 algebra, inversion and TRS decomposition are correct | Engine/QA | W1-CORE | M0 |
| ER-02-03 | TRS compose/decompose round-trips within tolerance | Engine/QA | W1-CORE | M0 |
| ER-02-04 | Quaternion product order, rotation and conversions are correct | Engine/QA | W1-CORE | M0 |
| ER-02-05 | Both projection families map near/far to the correct NDC depth | Engine/QA | W1-CORE | M0 |
| ER-02-06 | `lookAt` is right-handed, orthonormal and finite on degenerates | Engine/QA | W1-CORE | M0 |
| ER-02-07 | Ray/AABB/plane intersections and ranges are correct | Engine/QA | W1-CORE | M0 |
| ER-02-08 | OBB SAT and AABB tests are symmetric, including touching pairs | Engine/QA | W1-CORE | M0 |
| ER-02-09 | Frustum containment/intersection uses positive-inside and strict near | Engine/QA | W1-CORE | M0 |
| ER-03-01 | Entity allocation, generations and slot reuse are correct | Engine/QA | W1-CORE | M0 |
| ER-03-02 | Sparse-set component storage add/get/remove/column semantics are correct | Engine/QA | W1-CORE | M0 |
| ER-03-03 | Queries are allocation-free, ordered and exclude disabled entities | Engine/QA | W1-CORE | M0 |
| ER-03-05 | Hierarchy links validate cycles, self-parents and depth limits | Engine/QA | W1-CORE | M0 |
| ER-03-06 | Transform dirty propagation and world matrices are correct | Engine/QA | W1-CORE | M0 |
| ER-03-09 | Scene snapshot serialization round-trips deterministically | Engine/QA | W1-CORE | M0 |
| ER-03-10 | Prefabs instantiate and entity pools reuse slots correctly | Engine/QA | W1-CORE | M0 |
| ER-03-11 | 10,000 renderables and 1,000 physics writes stay within the scene contract | Engine/QA | W1-CORE | M0 |
| ER-04-03 | The pipeline cache hits, caches failures and creates no pipelines in steady state | Engine/QA | W1-RENDERERS | M0 |
| ER-04-04 | Resource creation/destruction, byte counters and handle staleness behave as specified | Engine/QA | W1-RENDERERS | M0 |
| ER-04-05 | Device loss and restore rebuild built-ins, keep live handles valid and go stale only when non-restorable; browser PASS 2026-10-23 via the dev-only real-destroy hook (hash `32312240` pre/post, 63.6 ms/1 frame, handles reused, second loss terminal); no-asset-refetch/no-game-restart unobserved on the asset-free page | Engine/QA | W1-RENDERERS | M0 |
| ER-04-06 | Resize coalescing, DPR backing size and zero-size frame behavior are correct; browser resize PASS on both backends, one-configure assertion PENDING (no counter) | Engine/QA | W1-RENDERERS | M0 |
| ER-04-07 | Descriptor validation and error-scope handling never throw from uncaptured errors | Engine/QA | W1-RENDERERS | M0 |
| ER-04-08 | Steady-state frames reuse buffers and allocate no new instance arrays in unit tests; the 480-frame heap-growth browser bench remains PENDING | Engine/QA | W1-RENDERERS | M0 |
| ER-04-09 | WebGPU and WebGL2 render the shared lit fixture with matching output; the smoke page hashes match, the tick-300 golden remains PENDING | Engine/QA | W1-RENDERERS | M0 |
| ER-04-10 | Frustum culling and the 65,536-instance cap behave as specified under batching | Engine/QA | W1-RENDERERS | M0 |
| ER-04-11 | M0 opaque unlit selects a cached unlit pipeline and samples base colour × tint; full M1 material fixture remains PENDING | Engine/QA | W1-RENDERERS | M0 |
| ER-04-15 | Readback and timestamp features are refused or reported exactly as the contract allows | Engine/QA | W1-RENDERERS | M0 |
| ER-04-16 | The package depends only on engine-core and is structurally assignable to RenderDevice and the SDK capabilities | Engine/QA | W1-RENDERERS | M0 |
| ER-04-17 | Device factory, resize, resource lifecycle, draw counts and dispose idempotence behave as specified | Engine/QA | W1-RENDERERS | M0 |
| ER-05-01 | The WebGL2 device implements the RenderDevice contract with ABI 1, texture mapping, pipeline cache and frame recording | Engine/QA | W1-RENDERERS | M0 |
| ER-05-05 | Capability classification is deterministic and monotone across the fixture cases | Engine/QA | W1-RENDERERS | M0 |
| ER-05-06 | Context loss increments the epoch once, lost frames are dropped and restore rebuilds under the same handles; browser PASS 2026-10-23 (hash `32312240` pre/post, 29.2 ms/3 frames, epoch incremented), handle-staleness clause not exercised | Engine/QA | W1-RENDERERS | M0 |
| ER-05-07 | A 3D game on Canvas2D is refused before init with the unsupported-feature error | Engine/QA | W1-RENDERERS | M0 |
| ER-05-08 | Canvas2D preserves the 2D drawing contract and refuses 3D operations | Engine/QA | W1-RENDERERS | M0 |
| ER-05-11 | The WebGL2 package has zero third-party runtime dependencies and stays within the host budget | Engine/QA | W1-RENDERERS | M0 |
| ER-05-12 | Failure notices have fixed copy, correct retry flags and no token/URL/PII | Engine/QA | W1-RENDERERS | M0 |
| ER-06-01 | Manifests validate: the valid fixture loads and all 16 invalid fixtures fail with the named code and path | Engine/QA | W1-ASSETS | M0 |
| ER-06-02 | Asset fetch is byte-accurate, reports progress and fails on short/long/non-2xx/abort/timeout | Engine/QA | W1-ASSETS | M0 |
| ER-06-03 | The M0 GLB subset decodes meshes and rejects unsupported layouts by code | Engine/QA | W1-ASSETS | M0 |
| ER-06-04 | KTX2 headers, levels and format gating validate; unsupported formats are refused | Engine/QA | W1-ASSETS | M0 |
| ER-06-05 | WebP/PNG decode through the injected bitmap seam and enforce dimension limits | Engine/QA | W1-ASSETS | M0 |
| ER-06-06 | Audio, font, JSON and material decoders validate their formats and clamps | Engine/QA | W1-ASSETS | M0 |
| ER-06-07 | Refcounts, budgets, progress, trim and dispose follow the library contract | Engine/QA | W1-ASSETS | M0 |
| ER-06-08 | The worker pool is lazy, bounded, replaces one failure then degrades, and meets its deadlines | Engine/QA | W1-ASSETS | M0 |
| ER-06-09 | A 5 MB load keeps main-thread tasks ≤ 8 ms and per-asset work ≤ 2 ms p95 | Engine/QA | W1-ASSETS | M0 |
| ER-07-01 | The physics wave is gated: the full check is green, every test carries its ID and none is skipped or weakened; gate green 2026-10-23 (234 files / 2,685 tests), contract suite 31/31, M1 fixtures still absent | Engine/QA | W1-PHYSICS | M1 |
| ER-07-02 | 600-tick mixed-body determinism: Node PASS, two runs hash `3733532183`; `velocityIterations` 4 changes it to `3756658819`; Chrome replay PENDING | Engine/QA | W1-PHYSICS | M1 |
| ER-07-03 | Vehicle slalom fixture: Node PASS, 30 m/s at 6.22 s, 150.53 m slalom, no wheel-air ticks, stops at 0.155 m/s; hardware run PENDING | Engine/QA | W1-PHYSICS | M1 |
| ER-07-04 | Character course: Node PASS, ramp stop, 0.3 m step, 2 m drop, wall penetration 0.00074 m and ceiling detected | Engine/QA | W1-PHYSICS | M1 |
| ER-07-06 | CCD wall: Node PASS, 10,000 crossings at 250 m/s with no tunnel; the per-body `ccd:false` control is unavailable on Rapier 0.21 (RV-75) | Engine/QA | W1-PHYSICS | M1 |
| ER-07-07 | 64-box stack: Node PASS, all sleep at tick 31, drift 0, 32/32 island split on wake | Engine/QA | W1-PHYSICS | M1 |
| ER-07-08 | 32-layer filter matrix: Node PASS, all 1,024 pairs match, sensor and `collideConnected` cases correct | Engine/QA | W1-PHYSICS | M1 |
| ER-07-09 | 2D migration parity: the moved `two-d` solver reproduces the pre-migration 300-tick golden bit-for-bit (fixture sha256 `c8d0546c…`, tick-300 hash `31b03748`); no game API changed | Engine/QA | W1-PHYSICS | M1 |
| ER-08-01 | The animation facade lifecycle, handles, stats, clamping and hash behave as specified; unit PASS, full-gate half via the root project | Engine/QA | W1-ANIMATION | M1 |
| ER-08-02 | Two identical 600-tick 32-instance runs hash identically; speed and fade changes alter the hash; Chrome replay PENDING | Engine/QA | W1-ANIMATION | M1 |
| ER-08-03 | Sampling, interpolation, loop wrap, blend/crossfade, masks, palette and the 600-tick golden blend are correct in Node | Engine/QA | W1-ANIMATION | M1 |
| ER-08-04 | Event windows, loop wrap, dominant-base emission and overflow policy are correct in Node | Engine/QA | W1-ANIMATION | M1 |
| ER-08-05 | Root motion delta, yaw-only default, apply/zero and teleport rejection are correct in Node | Engine/QA | W1-ANIMATION | M1 |
| ER-08-10 | CPU morph weights, clamping and hash inclusion are correct; GPU deformation PENDING | Engine/QA | W1-ANIMATION | M2 |
| ER-09-01 | One AudioContext at most, constructed only on unlock, including concurrent and repeated unlocks | Engine/QA | W1-AUDIO | M0 |
| ER-09-02 | Offline positional render shows the correct left/right RMS difference; unit math exists, render PENDING | Engine/QA | W1-AUDIO | M1 |
| ER-09-03 | Offline distance render matches the inverse model within ±1 dB; unit arithmetic exists, render PENDING | Engine/QA | W1-AUDIO | M1 |
| ER-09-04 | Voice pool bounds, steal order and accounting hold (unit PASS: 56 steals / 0 drops); browser voices case PENDING | Engine/QA | W1-AUDIO | M1 |
| ER-09-05 | Crossfade and music ramps match cos/sin within ±2% in an offline render; unit scheduling only, render PENDING | Engine/QA | W1-AUDIO | M1 |
| ER-09-06 | Clock monotonicity and click placement; unit half PASS with a fake clock, offline render PENDING | Engine/QA | W1-AUDIO | M1 |
| ER-09-07 | Latency values are recorded after unlock | Engine/QA | W1-AUDIO | M1 |
| ER-09-08 | Hidden-tab suspend/resume preserves track and clock | Engine/QA | W1-AUDIO | M1 |
| ER-09-09 | Missing/throwing Web Audio yields unavailable with silent no-ops and no rejected promises | Engine/QA | W1-AUDIO | M0 |
| ER-09-10 | AudioBus migration parity (unit PASS) and both games unlock from the start-screen gesture (PENDING) | Engine/QA | W1-AUDIO | M0 |
| ER-09-11 | Audio hot path heap/frame regression budgets | Engine/QA | W1-AUDIO | M1 |
| ER-09-12 | Decoded audio stays within budget and a failed asset keeps the previous buffer | Engine/QA | W1-AUDIO | M1 |
| ER-09-13 | TV unlock, continuity and latency | Engine/QA | W1-AUDIO | M1 |
| ER-09-14 | A 10,000-call API sequence in every state never throws or corrupts state | Engine/QA | W1-AUDIO | M0 |
| ER-09-15 | Mix/radio config validation fails malformed documents with `E_AUDIO_FORMAT` and a JSON path | Engine/QA | W1-AUDIO | M0 |
| ER-10-01 | Keyboard traces produce the expected action levels, values and edges per tick | Engine/QA | W1-INPUT | M0 |
| ER-10-02 | Sub-tick taps emit exactly one press/release edge and never duplicate across ticks | Engine/QA | W1-INPUT | M0 |
| ER-10-04 | Phone tick semantics handle older/equal/wrapped ticks and bursts with OR-accumulated edges | Engine/QA | W1-INPUT | M0 |
| ER-10-05 | Deadzone math is continuous, monotonic, bounded and exact at zero deadzone | Engine/QA | W1-INPUT | M0 |
| ER-10-06 | Gamepad traces map standard pads correctly and ignore non-standard pads | Engine/QA | W1-INPUT | M0 |
| ER-10-07 | Device assignment keeps phone/keyboard/pad slots deterministic and stable on disconnect | Engine/QA | W1-INPUT | M0 |
| ER-10-08 | Rebinding capture, conflicts, reserved keys, timeout and overlay round-trip behave as specified | Engine/QA | W1-INPUT | M0 |
| ER-10-09 | Focus loss releases held inputs once and pointer-lock exit clears buttons | Engine/QA | W1-INPUT | M0 |
| ER-10-10 | The default desktop map synthesizes the controller bits the reference games expect | Engine/QA | W1-INPUT | M0 |
| ER-10-12 | `poll` is idempotent per tick and rejects non-monotonic ticks in dev | Engine/QA | W1-INPUT | M0 |
| ER-10-13 | Invalid action maps fail with `E_INPUT_FORMAT` and a JSON path, leaving the previous map intact | Engine/QA | W1-INPUT | M0 |
| ER-10-15 | Pointer move/wheel accumulation, button edges and pointer-lock behavior are correct | Engine/QA | W1-INPUT | M0 |
| ER-12-01 | The world manifest parses/validates, rejects the documented invalid keys/URLs/LODs and enforces the cell caps; timing p95 PENDING | Engine/QA | W1-STREAMING | M1 |
| ER-12-03 | The resident ledger never exceeds its byte or cell budget; pressure/eviction stages work in unit tests, full pressure run PENDING | Engine/QA | W1-STREAMING | M1 |
| ER-12-06 | LOD bands and hysteresis resist ±2 m oscillation and monotone sweeps | Engine/QA | W1-STREAMING | M1 |
| ER-12-07 | Residency transitions, cancellation, caps and stop-zeroing are correct; full teleport streamer test PENDING | Engine/QA | W1-STREAMING | M1 |
| ER-12-08 | Cell headers reject bad magic/version/alignment/overlap/hash/size/kind and survive the truncation/fuzz sweep | Engine/QA | W1-STREAMING | M1 |
| ER-12-09 | CSTR dense/sparse golden hashes and byte-identical round trips hold; invalid payloads are rejected atomically | Engine/QA | W1-STREAMING | M1 |
| ER-12-11 | Ten focuses are accepted (eleven rejected), far focuses cap at LOD2 and the score order is deterministic | Engine/QA | W1-STREAMING | M1 |
| ER-12-12 | The checked-in 4,096-cell manifest is within the 512 KiB gzip budget; browser boot/CacheStorage/network PENDING | Engine/QA | W1-STREAMING | M1 |
| ER-15-01 | The v1 header codec reproduces the 85-byte fixture and round-trips boundary fields | Engine/QA | W1-CORE | M0 |
| ER-15-02 | Malformed headers are refused as a unit with the named save error | Engine/QA | W1-CORE | M0 |
| ER-15-03 | Property tests cover valid round-trips, bit mutations, arbitrary bytes and truncation | Engine/QA | W1-CORE | M0 |
| ER-15-04 | FNV-1a 32 matches published vectors and the golden payload | Engine/QA | W1-CORE | M0 |
| ER-15-05 | Newer save versions are refused and left untouched; M0 refuses version 0 as format | Engine/QA | W1-CORE | M0 |
| ER-15-06 | Payload bit flips are refused with a hash error and never mutate the file | Engine/QA | W1-CORE | M0 |
| ER-15-11 | A save for a different game is refused with `E_SAVE_GAME` when checked | Engine/QA | W1-CORE | M0 |
| ER-15-07 | Crash/failure points never yield a partial save; the old save survives every pre-commit failure; init removes only temp files (memory adapter PASS; OPFS rename points PENDING) | Engine/QA | W1-RUNTIME | M1 |
| ER-15-08 | Quota and slot-cap failures return named codes, leave the previous save intact and never evict; browser quota PENDING | Engine/QA | W1-RUNTIME | M1 |
| ER-15-09 | OPFS adapter round trip against a mocked file tree: golden bytes, temp→move order, no destination delete, temp-only cleanup, corruption listed unreadable; real browser OPFS/32 MiB payload PENDING | Engine/QA | W1-RUNTIME | M1 |
| ER-15-10 | Storage tier selection: OPFS when secure+move, IndexedDB fallback, otherwise `ctx.save` absent; adapters pass in Node (mock OPFS, `fake-indexeddb`), real browser/reload PENDING | Engine/QA | W1-RUNTIME | M1 |
| ER-15-12 | Stored headers/metadata/log lines contain no token, room, PIN, session, email or IPv4; errors never include payload bytes (unit PASS, CI review PENDING) | Engine/QA | W1-RUNTIME | M1 |
| ER-18-02 | Engine `Scene`, `AssetLibrary` and `RendererCapabilities` are assignable to the SDK structural projections; the negative fixture remains PENDING | Engine/QA | W1-RUNTIME | M0 |
| ER-19-01 | Engine rig commands, result schema and exit codes are contract-tested; malformed suites and results are refused | Engine/QA | W0-CONTRACTS | M0 |
| ER-19-11 | The shared conformance suite runs against every backend and reports each case in declaration order | Engine/QA | W0-CONTRACTS | M0 |
| ER-21-01 | Babylon adapter helpers parse colours, round backing sizes and reject non-finite cube positions exactly like the frozen `Renderer3D` semantics | Engine/QA | W8-BABYLON | B1 |
| ER-21-02 | `engine-cube` renders three cubes on WebGPU, reports `backend: "webgpu"` and produces a non-blank 1920×1080 screenshot; browser PASS 2026-10-23 | Engine/QA | W8-BABYLON | B1 |
| ER-21-03 | Forced WebGL2 selects the fallback without attempting WebGPU; unit PASS and browser PASS 2026-10-23 (1920×1080, 3 draw calls, 0 errors) | Engine/QA | W8-BABYLON | B1 |
| ER-21-08 | Babylon imports stay inside `packages/runtime/src/babylon/**` and no runtime file starts a Babylon render loop | Engine/QA | W8-BABYLON | B1 |
| ER-21-09 | Both Babylon backends unavailable returns fixed copy with no adapter or driver text in the result | Engine/QA | W8-BABYLON | B1 |
| ER-21-10 | `BabylonGameRenderer.dispose()` is idempotent and frees the engine exactly once; drawing before `init` is a programming error | Engine/QA | W8-BABYLON | B1 |
| ER-22-01 | The SDK fake world satisfies the 3D world contract without a GPU | Engine/QA | W0-CONTRACTS | Wave 0 |
| ER-22-08 | `spawnModel` with a missing asset throws `E_WORLD_ASSET` and creates no actor | Engine/QA | W0-CONTRACTS | Wave 0 |
| ER-22-09 | Exceeding the instance limit throws `E_WORLD_LIMIT` | Engine/QA | W0-CONTRACTS | Wave 0 |
| ER-22-10 | World `dispose` is idempotent and later updates fail with `E_WORLD_DISPOSED` | Engine/QA | W0-CONTRACTS | Wave 0 |
| ER-22-02 | Babylon renders a GLB model, an instance batch and a primitive in Chrome on WebGPU; browser PASS 2026-10-23 at 1280×720, 0 errors | Engine/QA | W1-BABYLON | Wave 1 |
| ER-22-03 | Clip play/crossfade/stop advance and blend; a skinned character is posed; still screenshots PASS, video PENDING | Engine/QA | W1-BABYLON | Wave 1 |
| ER-22-04 | Sun, ambient, fog, sky and shadow tier are visible; post reports false on WebGL2; browser PASS | Engine/QA | W1-BABYLON | Wave 1 |
| ER-22-05 | Follow converges to the target (error 0 across 640/790 samples); per-tick allocation not measured | Engine/QA | W1-BABYLON | Wave 1 |
| ER-22-06 | The same scene renders on WebGL2 with reduced capabilities and post false; browser PASS | Engine/QA | W1-BABYLON | Wave 1 |
| ER-22-07 | No Babylon/engine import appears in `sdk/**` or `packages/games/**`; source scan PASS | Engine/QA | W1-BABYLON | Wave 1 |
| ER-23-01 | A valid `assets.json` loads; missing ledger rows, duplicate ids, path escapes and over-budget sets fail with codes and JSON paths | Engine/QA | W0-CONTRACTS | Wave 0 |
| ER-25-01 | `presentation` is optional; a fully-populated manifest validates | Engine/QA | W0-CONTRACTS | Wave 0 |
| ER-25-02 | Invalid presentation fields fail with their JSON path | Engine/QA | W0-CONTRACTS | Wave 0 |
| ER-25-03 | A game folder with a manifest, layout, entry and tsconfig registers without any root-file edit | Engine/QA | W0-CONTRACTS | Wave 0 |
| ER-24-01 | Match transitions lobby→countdown→playing→results→next are legal and illegal transitions throw | Engine/QA | W1-GAMEKIT | Wave 1 |
| ER-24-02 | Scoreboard ordering, ties and reset are deterministic | Engine/QA | W1-GAMEKIT | Wave 1 |
| ER-24-03 | Player colours match DESIGN tokens and always pair with label + shape | Engine/QA | W1-GAMEKIT | Wave 1 |
| ER-24-04 | Pack draws are deterministic for a seed and wrap without replacement until reset | Engine/QA | W1-GAMEKIT | Wave 1 |
| ER-24-05 | Pool acquire/release never allocates after warm-up; exhaustion throws the named error | Engine/QA | W1-GAMEKIT | Wave 1 |
| ER-24-06 | Choice/text/canvas helpers ignore malformed payloads without throwing | Engine/QA | W1-GAMEKIT | Wave 1 |
| ER-24-07 | The package imports only `@lanpad/sdk` (source scan) | Engine/QA | W1-GAMEKIT | Wave 1 |
| ER-24-08 | The sample game is playable headlessly through the kit in under 200 lines | Engine/QA | W1-GAMEKIT | Wave 1 |

---

## 11. Amendments (non-spec decisions that affect implementation)

| ID | Amendment | Owner work item | Why |
|---|---|---|---|
| A1 | Shared `packages/broker` used by dev-server and relay | D0-SRV-02, P1-SRV-01 | Avoid duplicating room/session logic in Phase 2 |
| A2 | `hostJoin` / `hostJoined` host WebSocket auth | D0-PROTO-01, D4-PROTO-01, D4-SRV-03 | Spec defines a host token but no host join message |
| A3 | `tick` = u32 server-clock milliseconds at send | D0-PROTO-01, D2-CTRL-03 | FR-7.10 needs one timestamp definition |
| A4 | CSP `connect-src` includes `https://relay.vynkzhub.com` | P2-SEC-01 | `POST /api/rooms` is an HTTPS fetch, not WSS |
| A5 | iOS is out of v1 acceptance | D6 file, README §2.3 | User decision; code stays feature-detected |
| A6 | npm workspaces / TS strict / Vitest / ESLint / GitHub Actions / vanilla controller | D0-REPO-01 | Spec names libraries but not tooling |
| A7 | `SPEC.md` stays at repo root for now | D0-REPO-01 | Avoid link churn; can move in D0 |
| A8 | `hostToken` returned by room creation | D0-PROTO-01, D0-SRV-02, D4-HOST-01 | Needed for A2 host recovery |
| A9 | `hostStatus {active\|paused\|lost}` S→C | D4-PROTO-01, D4-SRV-03, D4-CTRL-02 | Spec requires "Waiting for TV" but has no message |
| A10 | `badVersion` join error reason | D4-PROTO-01 | Version mismatch must be distinguishable from a bad token |
| A11 | `pinRequired` + `token`+`pin` join for QR PIN mode | P3-SEC-02 | Optional QR PIN mode needs a prompt path; additive error value |
| A12 | Reaction Duel four-button target-match Minimal | games/reaction-duel.md, D2-CTRL-02, D7-SDK-01 | User wants at least four inputs per controller; one-button mode remains Full |
| A13 | `setLayout` JSON frames may be up to 16 KB; all other JSON frames remain capped at 4 KB (SR-6). The broker enforces the per-message cap | D5-PROTO-01, D0-SRV-03, D5-RT-01 | SDK accepts 16 KB layouts (FR-8.4) but SR-6 caps JSON at 4 KB; without the exception a valid layout never reaches controllers |
