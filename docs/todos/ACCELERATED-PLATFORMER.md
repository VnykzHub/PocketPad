# Accelerated Track — First Playable Platformer

> **Deferred for first-game sequencing (2026-10-21):** the active first game is
> **Reaction Duel four-button** (`IMPLEMENTATION-ORDER.md` §7). This platformer
> map is backlog for the later 2D track after D7-RT-01; do not dispatch its Wave 3
> from this document. Amendment A12 now belongs to Reaction Duel.
>
> **Status:** plan only — every step in this file is unchecked.
> **Goal:** reach the first playable 2D side-scrolling platformer (**Coin Run**) on the TV plus phones with the smallest platform slice that does not force a rewrite when D4–D7 land.
> **Source:** the user's acceleration request of 2026-10-21. `SPEC.md` v0.3 remains authoritative; `docs/todos/IMPLEMENTATION-ORDER.md` remains the baseline sequence for the full program.
> **Game plan:** [`games/platformer.md`](games/platformer.md) — work items `GAME-PF-01` … `GAME-PF-06`.

---

## 0. Relationship to the existing plan set

This map **adds** an accelerated path. It does not rewrite the stage plans.

1. **No spec change.** The platformer is not in `SPEC.md` §17. It is an extra dev-tier game. The four D7 proof games (Reaction Duel, Sumo Bumpers, Draw and Guess, Tilt Maze Race) remain required by the Dev Exit Gate and are not replaced.
2. **No existing plan file is edited by this track.** The only edits to stage files are the normal checkbox/status updates performed by the agents executing those stages, in their own files.
3. **Two deliberate deviations from `IMPLEMENTATION-ORDER.md`, both recorded here before work starts:**
   - **D2 starts in parallel with D1** instead of waiting for E1–E3. D2 touches only `sdk/layout*`, `packages/controller` and `packages/runtime/src/input`; it does not depend on the TV renderer. A proposed amendment (unnumbered; A12 is now the Reaction Duel four-button amendment) for `docs/todos/README.md` §1.
   - **D7-SDK-01 and D7-RT-01 are pulled forward into Wave 2** so the platformer has its frozen game registry, renderer, physics and results shell. Only the platformer-relevant subset moves; D7-RT-02 audits, E13/E17 and the four proof games stay in D7.
4. **D3 is not accelerated past its gate:** **D3 must not start before E1 WebGL2 is recorded.** This is the one hard ordering rule this track does not bend.
5. **Deferred, not cancelled:** D4 pairing/sessions, D5 layouts/events, D6 sensors/haptics, D7 proof games, the hub, the Dev Exit Gate and all of Phase 2. The slice runs on the D0 room flow and a direct route.
6. **No new spec requirement IDs.** Every work item in this track is `GAME-PF-*`; every test tag uses an existing ID from `TRACEABILITY.md`.

**Reconciliation note (added during review):** `IMPLEMENTATION-ORDER.md` §7–§8 was written concurrently and now schedules the Reaction Duel four-button game as the *first* playable, with the platformer on the later 2D track after D7-RT-01. This map remains the platformer-specific execution plan; "Wave 3" below means *the platformer wave, after D7-SDK-01/D7-RT-01 freeze*, not the same Wave 3 as the Reaction Duel track. If the project keeps Reaction Duel first, `GAME-PF-01` starts one wave later than the Reaction Duel slice and nothing else in this map changes. Reconcile the two wave numbers in `IMPLEMENTATION-ORDER.md` before dispatching Wave 3; do not run both first-game tracks with the same agent.

---

## 1. Waves

### Wave 0 — Entry gate (no new work in this map)

**Entry condition:** the D0 exit recorded in `IMPLEMENTATION-ORDER.md` still holds. Re-run the local gate before starting:

- [ ] `npm ci`
- [ ] `npm run check` (typecheck, lint, tests, build, size, stage-D0 trace)
- [ ] Confirm the D0 room create/join + echo path still works on the LAN with the test controller
- [ ] Confirm no uncommitted change from another agent overlaps the files a wave will touch

**Exit:** the local D0 gate is green and the D0 room flow is usable by the slice.

---

### Wave 1 — D1 probes **parallel with** D2 controller v0

**Purpose:** measure the TV envelope (E1/E2/E3/E14) while the controller and input mapper are built. D2 does not need the renderer; D1 does not need the controller.

| Stream | Work items | Owns | Parallel with |
|---|---|---|---|
| **1A — D1 probes** | `D1-EXP-01` → (`D1-EXP-02` E1 ∥ `D1-EXP-03` E2) → `D1-EXP-04` E3 → `D1-EXP-05` E14 → `D1-DOC-01` → `D1-BUDGET-01` → `D1-QA-01` | `experiments/**`, `docs/RESULTS.md`, `docs/DEVICES.md`, `docs/BUDGETS.md`, probe pages only | 1B |
| **1B — D2 controller v0** | `D2-LAYOUT-01` → `D2-CTRL-01` → `D2-CTRL-03` → `D2-CTRL-02` → `D2-CTRL-04`; `D2-RT-01` after `D2-CTRL-03`; `D2-QA-01`/`D2-PERF-01` last | `sdk/src/layout*`, `sdk/schema/layout.schema.json`, `packages/controller/**` (control/touch/input/net), `packages/runtime/src/input/**` | 1A |
| **1C — Slice preparation** | Plan review, trace-tag fixtures, acceptance-harness design, route/layout-bridge design | new docs and tests only; no product code | 1A, 1B |

**D1 probe constraints (unchanged):** probe pages are standalone, do not import `packages/runtime`, make no network requests except same-origin dev-server/WebSocket calls, and add no analytics, uploads, cookies or PII. Results are transcribed into `docs/RESULTS.md`; no measurement is recorded until it is observed on a real device.

**Wave 1 exit (all must be true):**

- [ ] E1 recorded: WebGL2 yes/no, max texture size, compressed-texture extensions, Web Audio, binary WebSocket, `requestAnimationFrame` behaviour.
- [ ] E2 recorded: usable memory limit and the 70% working budget.
- [ ] E3 recorded: fps at 720p for the instance benchmarks on the actual TV.
- [ ] E14 recorded: HTTPS page cannot open `ws://LAN-IP`; private-network behaviour noted.
- [ ] `docs/BUDGETS.md` has provisional memory, texture and frame budgets.
- [ ] D2 exit green: button/d-pad/stick render from layout data, same-frame pressed state, 10 simultaneous touches, sub-tick edge survives, controller size under budget.
- [ ] **Hard gate for Wave 2: E1 records WebGL2 and binary WebSocket as present.**

**Stop rule:** if E1 lacks WebGL2 or binary WebSocket, stop the track at this gate. Follow D1's stop rule and revise D3/the renderer target before any Wave 2 code. Do not bypass FR-9.3 with a silent Canvas2D-only host.

**Why this parallel is safe:** D2's files (`sdk/src/layout*`, `packages/controller/**`, `packages/runtime/src/input/**`) do not overlap D1's (`experiments/**`, probe pages, `docs/RESULTS.md`). No agent edits another stream's files. D2's entry gate deviation is explicit (A12); E1 failure invalidates Wave 2, not the D2 controller work.

---

### Wave 2 — D3 runtime + D7-RT-01/SDK slice

**Entry:** Wave 1 exit and the E1 WebGL2 gate. **D3 must not start before E1 WebGL2 is recorded.**

**Purpose:** build the host runtime and the game framework subset the platformer needs.

| Step | Work items | Depends on | Exit evidence |
|---|---|---|---|
| **2A — Runtime v0** | `D3-RT-01` → (`D3-RT-02` ∥ `D3-RT-03` ∥ `D3-RT-04`) → `D3-RT-05`/`D3-RT-06`/`D3-RT-07`; `D3-SDK-01` after `RT-01/04/05`; `D3-TOOL-01` → `D3-EXP-01` → `D3-QA-01` | Wave 1 exit | Cube moves from a phone on the TV; `GameHost` loads the cube demo through a manifest; E5 baseline recorded |
| **2B — Game framework subset** | `D7-SDK-01` (registry, `RoundManager`, finalized `sdk/src/game-api.ts`) → `D7-RT-01` (Canvas2D renderer, physics primitives, `Hud`, `ResultsScreen`, `AssetPack`) | `D3-SDK-01` frozen; `D3-RT-02` renderer interface | Registry lists a folder by manifest; physics tests pass; HUD/results tests pass |
| **2C — Contract freeze review** | Read-only review of the frozen interfaces used by `GAME-PF-*` | 2A + 2B | A written list of exports and tests that the platformer may import |

**Pull-forward scope (only what the platformer needs):**

- `D7-SDK-01`: `GameEntry`, `getGames()`, `RoundManager`, finalized `Game`/`GameModule` types.
- `D7-RT-01`: `Vec2`, `CircleBody`, `Aabb`, `integrate`, `resolveCircleCircle`, `resolveCircleAabb`, finalized `Canvas2DRenderer` (`sprite`, `polyline`, `text`, camera, draw-call counter), cached `Hud`, `ResultsScreen`, `AssetPack` budget enforcement.
- **Not pulled forward:** D7-RT-02 full per-frame audits, D7-HUB-01, D7-EXP-01 (E13/E17), D7-PERF-01 per-game table, D7-QA-01, and the four proof games.

**Wave 2 exit:**

- [ ] D3 exit checklist green (cube on TV, E5 baseline, debug overlay, start screen/audio, loader).
- [ ] `D7-SDK-01` and `D7-RT-01` acceptance tests green.
- [ ] The platformer's import list (§3 of `games/platformer.md`) exists in code and is exported.
- [ ] No game-specific hook was added to the runtime or SDK.
- [ ] `packages/games/platformer/` can be added without editing the registry.

**Stop rules:**

- If `D3-SDK-01`'s `Game`/`GameContext` shape changes after 2A, stop 2B and update the platformer plan first.
- If `D7-RT-01` cannot provide a needed primitive, raise a formal runtime change; never fork physics inside the game.
- If the Canvas2D renderer cannot hit the TV frame budget, record the number and cut visual scope before adding a second renderer.

---

### Wave 3 — Platformer

**Entry:** Wave 2 exit, contract freeze reviewed.

**Order:** `GAME-PF-01` → `GAME-PF-02` → `GAME-PF-03` → `GAME-PF-04` → `GAME-PF-05` → `GAME-PF-06`.

- `GAME-PF-03` and `GAME-PF-04` may overlap only on test fixtures, never source files.
- `GAME-PF-05` may start its camera test scaffolding after `GAME-PF-02`; rendering of coins/results waits for `GAME-PF-04`.
- `GAME-PF-06` is the final gate and runs the real-device acceptance.

**Slice exit checklist:**

- [ ] One side-scrolling level playable with 1, 2 and 4 players.
- [ ] Each phone controls one character with left/right (d-pad or stick) plus a jump button.
- [ ] Gravity, ground/platform collision, coins, goal flag, fall respawn, shared score, results and rematch work.
- [ ] Direct `/games/platformer/` route works through the D0 room create/join flow.
- [ ] The controller gets the platformer layout through the slice bridge; D5 `setLayout` is not required.
- [ ] No game code imports sockets, protocol, broker or controller internals.
- [ ] Size, draw calls, frame p50/p95, input-to-canvas p95 and join-to-first-input recorded with device/browser/version.
- [ ] Replay test is deterministic; no per-frame allocations in simulate/render.
- [ ] `npm run check` green; trace checker green for every ID the game tags.
- [ ] D7 proof games and plans untouched; the platformer remains extra scope.

---

## 2. Deferred for this slice (explicit)

| Deferred area | Stage | What the slice uses instead | What stays open |
|---|---|---|---|
| QR, PIN, sessions, reconnect, suspend | D4 | D0 room create/join and manual code entry | G1 QR timing, 8-client stability, E4/E9/E15 |
| Layout hot-swap, `panel`, `text`, `choice`, `canvas`, `event` | D5 | Two static layouts loaded by the slice bridge | Full layout system, E10/E16, private panels |
| Gyro, vibration, tunnel | D6 | None; the game needs no gyro or haptics | E7/E8, gyro games |
| Four proof games, full launcher, E13, E17 soak | D7 | Direct manifest route only | Dev Exit Gate cannot pass without them |
| Production infra, relay, pages, hardening | P0–P3 | Local dev server only | All Phase 2 gates |
| SDK docs/open source, beta, catalog/hub | P4–P6 | None | G8 full proof, P6 hub |

**The hub is deferred.** D7-HUB-01/P6-HUB-01 later replace the direct route's manifest selector with the launcher/hub. They mount the same `GameHost`; the platformer must not add launcher, catalog, lobby or voting code now.

**D4–D6 are deferred.** The slice accepts three documented gaps:

1. No QR/session: a phone reload joins as a new slot; G1 is **advanced, not proven**.
2. No layout hot-swap: layouts are fetched and validated by the slice bridge; the D2 control registry is the same one D5 will drive.
3. No sensors/haptics: the game is playable with d-pad/buttons only (FR-8.10).

---

## 3. Critical path

```
D0 local gate
   |
   +--> Wave 1A: D1 probes (E1/E2/E3/E14)
   |
   +--> Wave 1B: D2 controller v0
   |
   +--> [HARD GATE: E1 WebGL2 + binary WS recorded]
                |
                v
        Wave 2A: D3 runtime v0 + GameHost/loadGame
                |
                v
        Wave 2B: D7-SDK-01 registry/RoundManager
                 D7-RT-01 Canvas2D/physics/HUD/results
                |
                v
        Wave 3: GAME-PF-01..06
                |
                v
        First playable slice acceptance
```

D4–D6 are **not** on this path. D7 is not on this path for the slice, but remains on the program's path to the Dev Exit Gate.

---

## 4. Parallel dispatch plan (fan-out)

One agent per stream; no two agents edit the same file.

| Stream | Agent scope | Owns (write) | Starts | Blocks |
|---|---|---|---|---|
| **A — TV probes** | D1 experiment pages and results | `experiments/**`, `docs/RESULTS.md`, `docs/DEVICES.md`, `docs/BUDGETS.md` | Wave 1 | Wave 2 (E1 gate) |
| **B — Controller v0** | D2 layouts, controls, touch, input, mapper | `sdk/src/layout*`, `sdk/schema/layout.schema.json`, `packages/controller/**`, `packages/runtime/src/input/**` | Wave 1 | Wave 2A integration |
| **C — Runtime v0** | D3 loop, renderer, net, context, audio, loader, debug | `packages/runtime/src/**` except `src/input/**` and the D7 framework files | After E1 gate | Wave 2B, Wave 3 |
| **D — Game framework** | D7-SDK-01 + D7-RT-01 subset | `packages/runtime/src/game/registry.ts`, `RoundManager.ts`, `packages/runtime/src/physics/**`, `render/Canvas2DRenderer.ts`, `assets/**`, `ui/Hud.ts`, `ui/ResultsScreen.ts`, `sdk/src/game-api.ts` | After `D3-SDK-01` freezes | Wave 3 |
| **E — Platformer** | `GAME-PF-01..06` | `packages/games/platformer/**` | After Wave 2 exit | Slice acceptance |
| **F — Integration/QA** | Routes, layout bridge, budgets, trace, acceptance | `packages/dev-server/src/main.ts`, `packages/runtime/src/main.ts`, `packages/controller/src/dev/devLayoutSource.ts`, `tools/**`, `docs/RESULTS.md` slice rows | Wave 1 design; Wave 3 execution | Slice sign-off |

**Conflict rules**

1. C and D both touch `packages/runtime`; D starts only after C's `D3-SDK-01` files are frozen, and they never run concurrently on the same file.
2. B owns `packages/runtime/src/input/**`; C integrates it but does not rewrite it. Any mapper change goes back to B.
3. E never edits runtime, controller, dev-server or SDK. If the game needs a platform change, E files it; C/D/F own the fix.
4. F owns the exact-path route and the controller layout bridge; E consumes them and does not grow a second route.
5. One agent per file at a time, even inside a stream.
6. A and B are the only cross-stream pair that starts simultaneously in Wave 1. C/D are sequential. E starts only after the Wave 2 exit.

---

## 5. Contracts frozen at each wave

| Wave | Frozen output | Consumed by |
|---|---|---|
| Wave 1A | Device facts: WebGL2, memory ceiling, frame budget, binary WS, mixed-content result | Wave 2 renderer/budgets; Gate |
| Wave 1B | `LayoutDocument` v0 + validator, `ControllerState`/`InputSnapshot`, mapper latest-wins/edge policy, send policy, clock sync | Wave 2, all games |
| Wave 2A | `Game`, `GameModule`, `GameContext`, `GameHost`, `loadGame`, `Renderer2D`, `AudioBus`, loader, debug fields | Wave 2B, Wave 3 |
| Wave 2B | `GameEntry`, `getGames()`, `RoundManager`, `Vec2`, `CircleBody`, `Aabb`, `integrate`, `resolveCircleCircle`, `resolveCircleAabb`, `Hud`, `ResultsScreen`, `AssetPack` | Wave 3, later D7 games |
| Wave 3 | Platformer manifest, layouts, level data, config | Post-slice D4/D5 hub integration |

**Rule:** later stages may add fields; they may not rename or repurpose a frozen field without a protocol/version bump and an update to `games/platformer.md`.

---

## 6. Slice-only bridges (must not become architecture)

| Bridge | File | Why | Retirement condition |
|---|---|---|---|
| Exact-path direct route | `packages/dev-server/src/main.ts` + `packages/runtime/src/main.ts` | Play the game before the hub exists | D7-HUB-01/P6-HUB-01 mount the same `GameHost`; keep the path as a debug deep link or remove it |
| Controller layout source | `packages/controller/src/dev/devLayoutSource.ts` | D2 can render layouts but D5 owns `setLayout` | D5 delivers `setLayout`; delete the fetch and keep the render entry |
| Single-game build config | `packages/games/platformer/vite.config.ts` (only if needed) | Shared games build may not exist at Wave 2 exit | D7-SDK-01 shared build emits the folder |
| Start-screen state notice | Platformer README + start screen text | The slice has no sessions/host recovery | D4 sessions restore state; replace the notice |

**Stop rule:** if a bridge grows game rules, UI, rooms or layout hot-swap, stop and move that work into its owning stage (D4/D5/D7), not into the bridge.

---

## 7. Risks and stop rules

| Risk | Trigger | Response |
|---|---|---|
| E1 lacks WebGL2 or binary WS | E1 result | Stop Wave 2; revise D3 per D1; do not ship a silent Canvas2D host |
| E2/E3 miss the frame/memory envelope | Recorded numbers | Cut platformer visual scope (fewer coins/effects, lower render scale) before changing the platform |
| D2 sub-tick edge test fails | D2 exit | Stop; jump correctness depends on edges; fix the mapper before Wave 2 |
| D3 `Game`/`GameContext` changes after freeze | Contract review | Stop Wave 2B/3; update the plan and the SDK in one change |
| D7-RT-01 lacks a needed primitive | PF-02/PF-03 | Raise a formal runtime change; never fork physics in the game |
| Layout bridge grows into a layout system | Bridge review | Stop; assign to D5; keep the D2 control registry |
| Direct route accumulates hub logic | Route review | Stop; the route stays a manifest selector |
| 4-player camera unreadable | Acceptance run | Shorten/narrow the level, add edge indicators; do not add split-screen or 8 players |
| Platformer delays D7 | Stage review | Freeze platformer scope at the Minimal checklist; D7 proof games and E17 remain mandatory |
| New dependency proposed | Dependency review | Reject; the slice has no runtime dependencies |
| Secret/token in a log or doc | Any review | Release blocker, not a note |

---

## 8. Goal and requirement coverage for the slice

| ID | Slice claim | Evidence | Still open for later |
|---|---|---|---|
| G1 | **Advanced only** | D0 join-to-first-input time is recorded | QR scan→playable proof stays in D4 |
| G2 | **Advanced** | Fixed-tick input response + E5 baseline per game | Production p95 gate stays in P5 |
| G4 | **Partially advanced** | 4 controllers play one level | 8-controller stability stays in D4/D7 |
| G5 | **Partially advanced** | Multi-touch d-pad/jump; four-player readability | Gyro, haptics, private panels stay in D5/D6 |
| G8 | **Advanced** | Folder + manifest + `GameHost` + no platform switch | Clean-machine SDK dry run stays in P4 |
| FR-7.2/7.3/7.4/7.12 | Exercised | Jump/d-pad/stick/edge tests | — |
| FR-7.17 | Exercised | No-socket import test and context-only rules | — |
| FR-8.1/8.4/8.10 | Exercised | Both layouts, validator, button-only play | Hot-swap stays in D5 |
| FR-9.1/9.4/9.6 | Exercised | Fixed tick, TV profile, payload budget | Lazy per-scene loading stays in D7 |
| FR-10.3 | Exercised | Manifest loads and registers the game | — |
| PR-9.1/9.3/9.4/9.5/9.8 | Exercised | Draw-call, allocation, pooling, cached HUD tests | E17 soak stays in D7 |
| AR-4/AR-5 | Exercised | Remote results/rematch, 44 px controls | Full TV accessibility review stays in P5 |

**Not claimed by the slice:** G3 as a product gate, G6 TV-only production path, G7 dependency audit, G8 third-party dry run, SR-* production security, TR-1 full coverage.

---

## 9. Execution order at a glance

| # | Item | Wave | Depends on | Parallel with |
|---:|---|---|---|---|
| 1 | `D1-EXP-01` | 1 | D0 | B |
| 2 | `D1-EXP-02` (E1) ∥ `D1-EXP-03` (E2) | 1 | 1 | B |
| 3 | `D1-EXP-04` (E3) | 1 | E1 | B |
| 4 | `D1-EXP-05` (E14) | 1 | 3 | B |
| 5 | `D1-DOC-01` → `D1-BUDGET-01` → `D1-QA-01` | 1 | 2–4 | B |
| 6 | `D2-LAYOUT-01` → `D2-CTRL-01` → `D2-CTRL-03` → `D2-CTRL-02` → `D2-CTRL-04` | 1 | D0 | A |
| 7 | `D2-RT-01` | 1 | `D2-CTRL-03` | A |
| 8 | `D2-QA-01` / `D2-PERF-01` | 1 | 6–7 | — |
| 9 | **E1 WebGL2 hard gate** | 1→2 | 2 | — |
| 10 | `D3-RT-01` | 2 | 9 | — |
| 11 | `D3-RT-02` ∥ `D3-RT-03` ∥ `D3-RT-04` | 2 | 10 | each other |
| 12 | `D3-RT-05` / `D3-RT-06` / `D3-RT-07` | 2 | 11 | each other |
| 13 | `D3-SDK-01` | 2 | 10, 11 | 12 |
| 14 | `D3-TOOL-01` → `D3-EXP-01` → `D3-QA-01` | 2 | 11–13 | — |
| 15 | `D7-SDK-01` | 2 | 13 | 12/14 |
| 16 | `D7-RT-01` | 2 | 11, 13, 15 | 14 |
| 17 | Contract freeze review | 2→3 | 14–16 | — |
| 18 | `GAME-PF-01` | 3 | 17 | — |
| 19 | `GAME-PF-02` | 3 | 18 | — |
| 20 | `GAME-PF-03` | 3 | 19 | — |
| 21 | `GAME-PF-04` | 3 | 20 | fixture-only overlap with 20 |
| 22 | `GAME-PF-05` | 3 | 21 | camera scaffolding after 19 |
| 23 | `GAME-PF-06` | 3 | 22 | — |

Every row is a step; every step is unchecked.

---

## 10. Definition of Done for the accelerated slice

- [ ] Wave 0 local gate re-run and green.
- [ ] Wave 1 exit: E1/E2/E3/E14 recorded with device/browser/version/numbers; D2 exit green.
- [ ] E1 WebGL2 + binary WS gate passed; D3 started only after it.
- [ ] Wave 2 exit: cube on TV; `GameHost` manifest path; E5 baseline; D7-SDK-01/D7-RT-01 acceptance green.
- [ ] `GAME-PF-01..06` complete and the Minimal checklist in `games/platformer.md` fully checked.
- [ ] One level playable with 1, 2 and 4 players through the direct route and D0 join.
- [ ] All measured numbers recorded in `docs/RESULTS.md`; no fabricated values.
- [ ] No game code imports sockets/protocol/broker/controller; no new runtime dependency.
- [ ] Slice bridges documented and owned; no bridge contains game rules.
- [ ] D4–D6, D7 proof games, the hub and Phase 2 remain open and unchanged in the plan.
- [ ] `npm run check` green; trace checker green for every tagged ID.

---

## 11. Decisions to confirm before Wave 1

These are planning defaults, not approved decisions. Each is unchecked until the owner records the answer.

- [ ] **A12 — D2 parallel with D1.** Accept the controller-only exception to the D2 entry gate; record it in `docs/todos/README.md` §1. Default: accept, because D2 has no renderer dependency and D3 remains gated on E1.
- [ ] **D7 pull-forward.** Accept `D7-SDK-01` + `D7-RT-01` in Wave 2. Default: accept the subset in §1; reject any wider D7 pull-forward.
- [ ] **Slice bridge.** Accept the direct route and the controller layout source as temporary. Default: accept with the retirement conditions in §6.
- [ ] **Player count.** Confirm 1–4 players for the platformer instead of 8. Default: 4, because one shared camera must stay readable.
- [ ] **Score model.** Confirm shared co-op score for the slice. Default: shared score with per-slot contribution display.
- [ ] **No assets.** Confirm procedural shapes only for Minimal. Default: no sprite/audio assets; audio is optional.
- [ ] **D7 priority.** Confirm the platformer never blocks D7. Default: platformer pauses if the D7 critical path needs the same agent or contract.
