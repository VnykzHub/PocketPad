# D7 — Proof Games Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Steps use checkbox syntax.
>
> **Goal:** Ship the four proof games at their Minimal scope — Reaction Duel, Sumo Bumpers, Draw and Guess, Tilt Maze Race — on top of the frozen platform, and survive the 4-hour soak. This is the last stage before the Dev Exit Gate.
>
> **Architecture:** D7 completes the game framework (2D rendering, physics, HUD/results, asset packs, game registry) and then implements each game as a manifest-driven module. Games consume `GameContext` only: input, events, layouts, panels, haptics, audio, renderer. The broker and controller code are not modified for game logic.
>
> **Tech stack:** TypeScript, Canvas2D, custom circle/AABB physics, Web Audio, `@lanpad/sdk`, Vite dynamic imports.
>
> **Spec:** `SPEC.md` §9, §14 D7, §16, §17.2, §20 E13/E17; FR-7.17, FR-9.6, FR-9.13 groundwork; C1–C9; PR-9.3–9.8.
>
> **Program position:** Phase 1, last stage. The Dev Exit Gate cannot start until all four Minimals pass and E17 passes.

## Global constraints

- Every game is a folder with `game.manifest.json` + entry; no game-specific server or controller code.
- Each game's Minimal scope only; Full-version features stay in the game file's backlog.
- No per-frame allocations, no `map`/`filter` in hot loops, pool spawned entities (PR-9.3–9.5).
- Draw calls ≤ 120 per frame; HUD text cached offscreen (PR-9.1, PR-9.8).
- Per-game asset budgets from the manifest; initial load ≤ 5 MB; size gate enforces.
- Games never import sockets, broker, or controller internals (FR-7.17).
- No game requires gyro or haptics to be playable (FR-8.10, AR-3).
- No copyrighted music/assets; CC0 or self-made only.

---

## Stage goal and exit criteria

**Exit criteria (§14 D7):**

> Each reaches Minimal. Soak test (E17) passes.

Concretely:

- [ ] Reaction Duel, Sumo Bumpers, Draw and Guess, Tilt Maze Race each meet their game file's Minimal checklist.
- [ ] All four are playable through the game registry/launcher on the TV with phones.
- [ ] E13 infrastructure comparison recorded for P0.
- [ ] E17 soak: 4 h, 8 bots, 30 ms jitter, Reaction Duel + Sumo on the TV; memory growth < 10%, no crashes.
- [ ] Per-game size and frame budgets measured and under target.
- [ ] No platform code changed for a game's rules.

**Layer coverage**

| Layer | Work items |
|---|---|
| SDK | D7-SDK-01 |
| Host runtime | D7-RT-01, D7-RT-02 |
| Games | GAME-RD-*, GAME-SB-*, GAME-DG-*, GAME-TM-* |
| Hub | D7-HUB-01 |
| Experiments/docs | D7-EXP-01 |
| Tools/CI | D7-PERF-01 |
| QA | D7-QA-01 |

**Goals advanced:** G1 (join→play under 5 s in a real game), G2 (latency in games), G3 (per-game bundles), G4 (8 players), G5 (all capabilities exercised), G8 (SDK shape proven).

---

## Contracts frozen in D7

1. **Game module**: `export default (manifest) => Game` loaded by `loadGame` from a manifest folder.
2. **Game registry**: build-time list of manifests; `getGames()` returns `{slug, name, minPlayers, maxPlayers, needsGyro, manifestUrl}`; no switch statements.
3. **Round shell**: games may use `RoundManager` (lobby → countdown → playing → results → next), but it is optional; the platform does not impose scoring.
4. **Physics primitives**: `Vec2`, circle-circle and circle-AABB resolution, arena bounds, pooled entities, fixed-step updates.
5. **HUD/results**: cached offscreen text; results screen with rematch action; remote-operable on the host where the game uses host UI.
6. **Per-game budget**: manifest `assetBudget` is enforced at load; the size gate reports each game.
7. **Recorded traces**: each game ships at least one input trace replay test via the D2 harness.

---

## Work items

### D7-SDK-01 — Game registry, lifecycle finalization and authoring contract

| Field | Value |
|---|---|
| Layer | SDK + runtime |
| Spec | §10 (`games/`, manifest), §17; FR-10.3, FR-7.17; G8 |
| Depends on | D3-SDK-01, D0-SDK-01 |
| Unblocks | D7-HUB-01, all proof games, P4 |
| Deliverables | `packages/runtime/src/game/registry.ts`, `src/game/RoundManager.ts`, `sdk/src/game-api.ts` (finalized), `sdk/README.md` (draft) |

**Freeze this interface**

```ts
export interface GameEntry {
  slug: string;              // folder name
  name: string;
  minPlayers: number;
  maxPlayers: number;
  needsGyro: boolean;
  manifestUrl: string;
}

export function getGames(): ReadonlyArray<GameEntry>;

export type RoundPhase = "lobby" | "countdown" | "playing" | "results";

export class RoundManager {
  constructor(opts: { minPlayers: number; maxPlayers: number; countdownMs?: number; roundsToWin?: number });
  phase: RoundPhase;
  startWhenReady(connectedSlots: ReadonlyArray<number>): boolean;
  beginRound(nowMs: number): void;
  endRound(result: RoundResult): void;
  nextRound(nowMs: number): boolean;
  reset(): void;
}
```

**Behavior**

- Registry scans `packages/games/*/game.manifest.json` at build time (Vite `import.meta.glob` with eager JSON imports); validates each manifest with `validateManifest`; fails the build on an invalid manifest or duplicate slug.
- `getGames()` is sorted by name; used by the minimal launcher and P6 hub.
- `RoundManager` is a convenience, not a requirement: it handles player-count gating, countdown, phase transitions and best-of shells. Games own their rules.
- `Game.dispose()` must remove listeners/timers; the registry can unload/reload a game without a page reload.
- `sdk/README.md` documents the module shape, manifest, context APIs, layouts, events, and a minimal example (not the full game).
- No game-specific fields in the SDK; per-game settings use a versioned manifest extension later (P6).

**Steps**

- [ ] Implement the build-time registry with manifest validation and duplicate detection.
- [ ] Implement `RoundManager` with fake-clock tests for phase transitions and best-of.
- [ ] Finalize `sdk/src/game-api.ts` as the public contract; add a type-level test that a missing `simulate` fails.
- [ ] Write the draft authoring guide with a 30-line sample game (button → score).
- [ ] Add a registry test: adding a folder adds a game without code changes.
- [ ] Ensure `dispose` is idempotent and unloads cleanly.

**Acceptance**

- [ ] Adding `packages/games/foo/game.manifest.json` makes `foo` appear in `getGames()`.
- [ ] An invalid manifest fails the build with a file path and error list.
- [ ] `RoundManager` blocks start below `minPlayers` and advances rounds correctly.
- [ ] The SDK docs are sufficient for a developer to build the sample without reading runtime internals.

**Tests (tagged)**

- `[G8] a new game is added by folder + manifest only`
- `[FR-10.3] registry validates every manifest`
- `[FR-7.17] game modules receive only GameContext`
- `[G3] registry rejects a game over its declared asset budget`
- `[FR-9.13] registry exposes game metadata for the picker`

**Anti-rework**

- The registry is the single game list; P6's hub reads it, no hard-coded menu.
- `RoundManager` is generic; games with unusual flows may ignore it.
- The manifest remains the boundary; per-game settings are additive and versioned.

**Risks**

- Vite glob path resolution differs dev vs build; test both.
- A game that throws during `init` must not break the registry/launcher; show an error and allow returning to the menu.

---

### D7-RT-01 — 2D renderer, physics primitives, HUD/results and asset packs

| Field | Value |
|---|---|
| Layer | Host runtime |
| Spec | §6.2, §9.2, §9.3, §9.5; FR-9.6, PR-9.1, PR-9.3–9.8; C9 |
| Depends on | D3-RT-02, D3-SDK-01 |
| Unblocks | Sumo Bumpers, Tilt Maze Race, later 2D games |
| Deliverables | `packages/runtime/src/render/Canvas2DRenderer.ts` (completed), `src/physics/Vec2.ts`, `circleBody.ts`, `collide.ts`, `src/game/Hud.ts`, `ResultsScreen.ts`, `src/assets/AssetPack.ts`, `test/physics.test.ts`, `test/hud.test.ts` |

**Physics contract**

```ts
export interface CircleBody {
  x: number; y: number; vx: number; vy: number;
  radius: number; mass: number; restitution: number; friction: number;
  active: boolean; id: number;
}

export function integrate(body: CircleBody, dt: number, arena: { minX: number; maxX: number; minY: number; maxY: number }): void;
export function resolveCircleCircle(a: CircleBody, b: CircleBody): boolean;
export function resolveCircleAabb(circle: CircleBody, box: Aabb): boolean;
```

- Integration: semi-implicit Euler; clamp velocity; arena walls with restitution.
- Circle-circle: positional correction proportional to inverse mass; impulse along the normal with restitution; friction on the tangent.
- Pooled bodies; no allocation in `integrate`/`resolve`.
- Deterministic given the same initial state and fixed dt; seeded RNG for spawns.
- Tests: head-on equal mass exchange, heavy vs light push, overlap correction, wall bounce, zero velocity stability.

**2D renderer / HUD**

- `Renderer2D` from D3 finalized with `sprite`, `polyline`, `text`, camera transform; draw-call counter.
- HUD text is rendered to a cached offscreen canvas and blitted; invalidated only when the text changes (PR-9.8).
- Results screen: winner, scores, rematch/return actions; host remote-operable (arrow keys/Enter).
- Asset pack: a game-owned `assets.json` group → `AssetLoader`; atlas metadata (JSON) for sprites; lazy-loaded per scene. The manifest does not list every asset; it declares the total initial/total budget that the loader enforces. No undeclared network fetches.
- No per-frame `map/filter`; precompute draw lists.

**Steps**

- [ ] Implement physics primitives and tests; benchmark 8 bodies for zero allocations.
- [ ] Finalize the Canvas2D renderer with sprites/polyline and a draw-call counter.
- [ ] Implement cached HUD text and results screen.
- [ ] Implement `AssetPack` for per-scene lazy loading with a manifest budget check.
- [ ] Add a demo scene with 8 circles bouncing and colliding; record frame time.
- [ ] Ensure the HUD cache invalidates on value change only.
- [ ] Add tests for physics invariants and HUD cache behavior.

**Acceptance**

- [ ] 8 circles collide and push correctly; no tunneling at normal speeds (substep if needed).
- [ ] Physics functions allocate nothing after setup.
- [ ] HUD text is cached and does not re-render every frame.
- [ ] Results screen is keyboard-operable.
- [ ] Asset groups load lazily and respect the manifest budget.

**Tests (tagged)**

- `[C9] circle-circle and circle-AABB collision resolution works`
- `[PR-9.3] physics update allocates nothing per frame`
- `[PR-9.4] entity pools are reused`
- `[PR-9.8] HUD text is cached offscreen`
- `[PR-9.1] demo draw calls stay under 120`
- `[AR-4] results screen is remote-operable`

**Anti-rework**

- Physics is small and custom; if a game needs Rapier later, it can import it behind the game, not in runtime (spec §6.2).
- HUD/results are generic; games provide content, not layout.
- Asset packs are the only game asset path; no ad-hoc fetch in games.

**Risks**

- Collision feel needs tuning; expose mass/friction/restitution in game data, not code constants.
- Canvas2D performance on a TV can be fill-rate bound; keep sprites small and avoid shadows/blur.

---

### D7-RT-02 — Performance instrumentation, pooling rules and per-frame audits

| Field | Value |
|---|---|
| Layer | Host runtime |
| Spec | §9.5; PR-9.1–9.8; §11 |
| Depends on | D3-RT-06, D7-RT-01 |
| Unblocks | D7-PERF-01, Gate, P5 |
| Deliverables | `packages/runtime/src/perf/FrameAudit.ts`, `src/perf/pools.ts`, `test/frameAudit.test.ts` |

**Behavior**

- `FrameAudit` (dev/`?debug=1` only):
  - Counts draw calls, texture MB, active entities, allocated objects (explicit counters, not heap sampling), sim step time, render time.
  - Flags PR violations: draw calls > 120, any `map`/`filter` in a per-frame path, new entity objects outside a pool, per-frame DOM writes.
  - Exposes per-game counters through `GameContext.debug`.
- `ObjectPool<T>` with `acquire/release/forEachActive`; no allocation after warm-up; reset semantics.
- Games must pool spawned entities (bullets, particles, balls).
- A CI grep test bans `.map(`/`.filter(` in files under `packages/games/*/src/sim/` and `packages/runtime/src/loop|input|physics` unless annotated `// allowed: not per-frame`.
- Record a baseline frame time for each proof game.

**Steps**

- [ ] Implement `ObjectPool` and tests for reuse/no-allocation.
- [ ] Implement `FrameAudit` counters and overlay integration.
- [ ] Add the grep test with an allowlist comment convention.
- [ ] Run the 8-circle demo and record draw calls/entity counts.
- [ ] Add per-game `debug` counters to the overlay.
- [ ] Record a "no new allocations" heap check for a 60 s Sumo run (Chrome performance panel as evidence).

**Acceptance**

- [ ] Pool reuse is proven by identity and zero allocations after warm-up.
- [ ] The audit flags a deliberate 121-draw-call test scene.
- [ ] The grep test fails on an unannotated `.map` in a sim path.
- [ ] Each proof game has baseline counters recorded.

**Tests (tagged)**

- `[PR-9.3] hot loops allocate nothing after warm-up`
- `[PR-9.4] spawned entities come from pools`
- `[PR-9.5] no map/filter in per-frame paths`
- `[PR-9.1] draw calls over 120 are flagged`
- `[PR-9.2] texture memory is reported against the E2 budget`

**Anti-rework**

- The audit is the Gate's evidence source; keep counters stable.
- Pools are generic and used by later games.

**Risks**

- JS engines may allocate internally; measure explicit object creation, not heap noise.
- Over-aggressive pooling can leak state; reset every acquired object.

---

### D7-HUB-01 — Minimal game launcher and lobby shell

| Field | Value |
|---|---|
| Layer | Hub/games |
| Spec | §17.5 (Minimal), §9.6; FR-9.13 groundwork; AR-4 |
| Depends on | D7-SDK-01, D4-HOST-01 |
| Unblocks | D7-QA-01, P6-HUB-01 |
| Deliverables | `packages/runtime/src/ui/GameLauncher.ts`, `src/ui/Lobby.ts`, `test/launcher.test.ts` |

**Behavior**

- Host starts on a launcher: game cards from `getGames()` (name, players, gyro badge), selected with arrow keys, launched with Enter (AR-4).
- Shows room code/PIN/QR via `RoomPanel`; players joining appear in a lobby list with slots.
- "P1 phone picks" is **not** required for D7; that is P6-HUB-01. D7 uses the TV remote. The launcher data model supports phone selection later. Note: the spec's §17.5 Hub **Minimal** (including P1 phone pick) is delivered in P6-HUB-01; D7-HUB-01 is the host-only prototype that lets the proof games be played without building the hub first.
- Starting a game mounts it via `GameHost`; returning to the launcher unloads/disposes it.
- The launcher shows per-game `needsGyro` and warns "controllers need motion; fallback available".
- No catalog thumbnails in D7 (text cards); P6 adds images.
- Remote focus is visible; no pointer-only actions.

**Steps**

- [ ] Implement the launcher list with keyboard focus and Enter.
- [ ] Implement the lobby list bound to `playerJoined/Left/Suspended/Resumed`.
- [ ] Wire launch/unload through `GameHost`; test no leaked timers/listeners after return.
- [ ] Show the QR/code/PIN panel in the lobby.
- [ ] Add tests for focus movement and game selection.
- [ ] Record a screenshot in `docs/RESULTS.md`.

**Acceptance**

- [ ] All four proof games appear and launch from the launcher.
- [ ] Returning to the launcher disposes the game and allows another launch.
- [ ] Arrow keys/Enter work with a TV remote.
- [ ] Joining players appear in the lobby without reload.
- [ ] Gyro games are labelled and the fallback is noted.

**Tests (tagged)**

- `[AR-4] launcher is fully remote-operable`
- `[FR-9.13] launcher lists games from the registry`
- `[FR-7.17] launching a game passes only GameContext`
- `[FR-8.10] gyro games are labelled with a fallback note`
- `[G8] adding a game updates the launcher automatically`

**Anti-rework**

- The launcher is the P6 hub's skeleton; add features there, not a second menu.
- Game metadata comes from manifests; no hard-coded cards.

**Risks**

- TV remote key codes vary; use standard Arrow/Enter and test on the TV.
- Game unload may leave audio playing; `dispose` must stop music/SFX.

---

### D7-EXP-01 — E13 production infrastructure and E17 soak

| Field | Value |
|---|---|
| Layer | Experiments/docs |
| Spec | §20 E13/E17; §14 D7; §19 relay caveats; §11 |
| Depends on | D7-QA-01 (soak needs games), D3-TOOL-01, D4-TOOL-01 |
| Unblocks | Gate, P0 |
| Deliverables | `docs/RESULTS.md` E13/E17 rows, raw logs |

**E13 — production infrastructure comparison**

- From the user's location, measure:
  - Fly.io Mumbai region (or nearest) WebSocket RTT p50/p95, cold start, cost.
  - Cloudflare Durable Objects WebSocket RTT/cold start/cost.
  - A managed realtime provider (if viable) RTT/cost.
  - WebRTC data channel on the TV (presence/behavior; not a v1 feature).
- Pass: Mumbai-class RTT p95 < 25 ms. Record cost per 100 room-hours.
- This is a Phase 1 experiment even though it informs P0; no production deployment yet.

**E17 — soak**

- 4 h, 8 input-bots, 30 ms injected jitter, Reaction Duel + Sumo Bumpers alternating on the TV.
- Measure server memory every minute, browser memory (if available), crashes, dropped slots, event errors.
- Pass: memory growth < 10%, no crashes, no stuck slots.
- Run overnight; keep logs; record the exact commit.

**Steps**

- [ ] Write an E13 measurement script (small WS echo client) and run it against candidate hosts/regions.
- [ ] Record RTT/cold start/cost in a comparison table.
- [ ] Run E17 with the bot scenarios and both games; monitor the TV.
- [ ] Record memory samples and compute growth.
- [ ] File leaks/crashes as blocking defects; fix and re-run.
- [ ] Record both rows with dates, versions, and the commit hash.

**Acceptance**

- [ ] E13 table has at least two viable options with numbers and costs.
- [ ] E17 memory growth < 10% over 4 h; no crash/stuck slot.
- [ ] Raw logs are retained and referenced.
- [ ] A written recommendation for P0 exists.

**Tests (tagged)**

- `[E13] relay candidates are compared on RTT, cold start and cost`
- `[E13] Mumbai-class RTT p95 is under 25 ms`
- `[E17] four-hour soak stays under 10% memory growth`
- `[E17] eight bots and two games run without crashes or stuck slots`
- `[G4] eight-player load is stable for the soak duration`

**Anti-rework**

- E13's numbers are the sole input to P0's decision; do not pick a host earlier.
- E17's harness is reused in P5 with production targets.

**Risks**

- A 4 h soak on a dev laptop may be throttled/sleep; disable sleep and record power settings.
- Cloud providers' free tiers may limit test duration; note quotas.

---

### D7-PERF-01 — Per-game size, frame and asset budgets

| Field | Value |
|---|---|
| Layer | Tools/CI |
| Spec | §11; NR-6.1, G3; FR-9.6; PR-9.1 |
| Depends on | D0-TOOL-02, D7-SDK-01, D7-RT-02 |
| Unblocks | Gate, P5 |
| Deliverables | `tools/size-budget` game mode, `docs/RESULTS.md` per-game table |

**Behavior**

- Read every game manifest; measure its built JS + declared initial assets.
- Enforce `assetBudget.initialBytes` / `totalBytes` per game; fail CI on breach.
- Report host runtime + each game separately; overall initial download ≤ 5 MB.
- Record frame p95, draw calls and texture MB per game on the TV.
- Store a `docs/BUDGETS.md` table per game.

**Steps**

- [ ] Extend the size tool to discover manifests and map build outputs by slug.
- [ ] Add CI invocation for every game; fail on missing assets.
- [ ] Measure each proof game's initial bytes and total bytes.
- [ ] Record frame p95/draw calls on the TV for each game.
- [ ] Add per-game rows to `docs/BUDGETS.md`.
- [ ] Ensure a synthetic over-budget game fails the gate.

**Acceptance**

- [ ] All four proof games under 5 MB initial and within their manifest budgets.
- [ ] CI fails when a game exceeds its declared budget.
- [ ] Per-game frame/draw-call numbers recorded.
- [ ] The Gate can read one table for all game budgets.

**Tests (tagged)**

- `[G3] each game stays within its manifest asset budget`
- `[NR-6.1] host + game initial download is under 5 MB`
- `[PR-9.1] each game stays under 120 draw calls`
- `[FR-9.6] per-scene assets load lazily`
- `[G7] every game dependency is accounted for in its budget`

**Anti-rework**

- Budgets are manifest data; no hard-coded per-game numbers in CI.
- P6 games use the same gate without changes.

**Risks**

- Vite chunking can hide shared runtime bytes; report both per-game and total.
- Asset compression differences (gzip vs brotli) can mislead; use gzip per spec.

---

### D7-QA-01 — Four game Minimals and platform integration acceptance

| Field | Value |
|---|---|
| Layer | QA |
| Spec | §14 D7 exit, §17.2; each game file's Minimal checklist |
| Depends on | D7-SDK-01, D7-RT-01/02, D7-HUB-01, all four GAME-* items |
| Unblocks | Gate |
| Deliverables | `docs/RESULTS.md` D7 row, four game checklists completed |

**Per-game acceptance**

- **Reaction Duel** — [games/reaction-duel.md](../games/reaction-duel.md): wait/four-button target/false-start/best-of-5, 2–8 players, synced-timestamp adjudication, scoreboard. Four-button target match is amendment A12.
- **Sumo Bumpers** — [games/sumo-bumpers.md](../games/sumo-bumpers.md): top-down circles, joystick movement, collisions push, shrinking arena, last standing, 2–8 players.
- **Draw and Guess** — [games/draw-and-guess.md](../games/draw-and-guess.md): rotating drawer, secret word on a panel, live strokes on TV, text guesses, first correct scores, 3 rounds.
- **Tilt Maze Race** — [games/tilt-maze-race.md](../games/tilt-maze-race.md): shared maze, tilt-driven balls, wall collisions, first to exit, joystick fallback, recalibrate.

**Cross-game scenarios**

- [ ] Launch each game from the launcher with 2 players, then 8 bots where supported.
- [ ] Return to launcher and launch another game without reload; no leaked timers/audio.
- [ ] A phone drops mid-game and rejoins; the game continues, slot preserved.
- [ ] Host refresh mid-game resumes the room; the game reinitialises or resumes per its rules (document which).
- [ ] Haptics off and gyro denied paths remain playable.
- [ ] No console errors on the TV or phone.
- [ ] Record per-game frame p95 and asset size.

**Steps**

- [ ] Run each game's own acceptance checklist to completion; link the evidence.
- [ ] Run the cross-game scenarios on the TV + at least two phones.
- [ ] Run the input-bot for 8-player Sumo and Reaction Duel.
- [ ] Record results/screenshots in `docs/RESULTS.md`.
- [ ] File any platform defect as a D-stage bug, not a game hack.
- [ ] Confirm no game-specific changes leaked into broker/controller/runtime.

**Acceptance**

- [ ] Four Minimals pass their checklists.
- [ ] Cross-game scenarios pass.
- [ ] 8-player games stable.
- [ ] Reconnect behavior is documented per game.
- [ ] No platform regressions.

**Tests (tagged)**

- `[C1] all proof games use buttons/sticks/multi-touch`
- `[C2] Reaction Duel uses edges and synced timestamps`
- `[C3] Draw and Guess uses private panels`
- `[C4] Draw and Guess uses text events`
- `[C5] Draw and Guess uses canvas strokes`
- `[C6] Tilt Maze uses gyro with a fallback`
- `[C9] Sumo and Tilt Maze use the physics primitives`
- `[G1] a game is playable within 5 s of scanning`
- `[G4] eight players run a game simultaneously`

**Anti-rework**

- Game acceptance is the template for P6; do not invent a different checklist per game.
- Platform defects are fixed in the platform, never worked around per game.

**Risks**

- 8-player games on one TV can be visually crowded; accept Minimal with a clear scoreboard, tune in Full.
- Host refresh mid-game may not preserve game state; document "restart round" as acceptable for proof games.

---

## Stage exit checklist

- [ ] D7-SDK-01, D7-RT-01/02, D7-HUB-01, D7-EXP-01, D7-PERF-01, D7-QA-01 complete.
- [ ] Four proof games meet their game-file Minimal checklists.
- [ ] All four launch from the registry/launcher.
- [ ] E13 and E17 recorded; soak passes.
- [ ] Per-game size/frame budgets recorded.
- [ ] No game-specific code in broker/controller/runtime.
- [ ] `docs/RESULTS.md` D7 row complete.

## Handoff to the Dev Exit Gate

- The Gate consumes: E1–E17 results, the four game checklists, per-game budgets, the E13 recommendation, and the security checklist.
- Do not start P0 until the Gate writes a go/no-go.
- Any open blocking defect returns to its owning D-stage; the Gate is not a bug-fix sprint.

## Explicitly not in D7

- Full versions of the proof games (game files' backlog).
- Hub phone voting/catalog (P6).
- Remaining 10 games (P6).
- Production deployment (P0–P2).
- iOS testing (A5).
