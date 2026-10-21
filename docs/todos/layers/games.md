# Layer: Games

**Packages:** `packages/games/*` + the game framework in runtime.
**Owns:** simulation, rules, scoring, rounds, per-game layouts, content packs, game-specific HUD/results content.
**Must not own:** sockets, room/session logic, controller DOM, renderer internals.
**Goal contribution:** G2 (latency in games), G3 (per-game budgets), G4 (8 players), G5 (capabilities), G7 (pooling/dependency discipline), G8 (SDK proof).

## Invariants

1. Every game is a folder + `game.manifest.json` + entry; no switch statements.
2. Games consume `GameContext` only; no sockets, fetch, DOM, or storage (FR-7.17).
3. Games ship layouts; they never build phone UI.
4. Spawned entities are pooled; no per-frame allocations; no `map`/`filter` in sim paths (PR-9.3–9.5).
5. Content is data packs with licenses; no hard-coded word lists/charts/maps.
6. No game requires gyro or haptics; every gyro layout has a fallback (FR-8.10, AR-3).
7. Per-game `assetBudget` is enforced at load and in CI.
8. A game needing a platform feature returns to the owning stage; no game-specific server/controller hacks.

## Todo index

| ID | Title | Stage | File |
|---|---|---|---|
| D7-RT-01 | 2D/physics/HUD/results/assets | D7 | `phase-1-dev/D7-proof-games.md` |
| D7-RT-02 | Frame audit/pools | D7 | `phase-1-dev/D7-proof-games.md` |
| D7-HUB-01 | Minimal launcher/lobby | D7 | `phase-1-dev/D7-proof-games.md` |
| D7-QA-01 | Four proof Minimals | D7 | `phase-1-dev/D7-proof-games.md` |
| GAME-RD-* | Reaction Duel | D7 | `games/reaction-duel.md` |
| GAME-SB-* | Sumo Bumpers | D7 | `games/sumo-bumpers.md` |
| GAME-DG-* | Draw and Guess | D7 | `games/draw-and-guess.md` |
| GAME-TM-* | Tilt Maze Race | D7 | `games/tilt-maze-race.md` |
| GAME-SIR-* | Spy in the Room | P6 wave 1 | `games/spy-in-the-room.md` |
| GAME-BQ-* | Bluff Quiz | P6 wave 1 | `games/bluff-quiz.md` |
| GAME-TA-* | Tank Arena | P6 wave 2 | `games/tank-arena.md` |
| GAME-SR-* | Snake Royale | P6 wave 2 | `games/snake-royale.md` |
| GAME-SWR-* | Steering Wheel Racer | P6 wave 2 | `games/steering-wheel-racer.md` |
| GAME-SSD-* | Sword Swing Duel | P6 wave 3 (gated) | `games/sword-swing-duel.md` |
| GAME-BD-* | Bomb Defusal | P6 wave 3 | `games/bomb-defusal.md` |
| GAME-BT-* | Beat Tap | P6 wave 3 (gated) | `games/beat-tap.md` |
| GAME-HP-* | Heist Planner | P6 wave 4 | `games/heist-planner.md` |
| GAME-OWS-* | Open-World Showcase | P6 wave 4 (gated) | `games/open-world-showcase.md` |
| HUB-* | Hub minimal/full | D7/P6 | `games/hub.md` |
| P6-QA-01 | Catalog waves/acceptance | P6 | `phase-2-production/P6-games-hub.md` |
| P6-DOCS-01 | Content packs/authoring | P6 | `phase-2-production/P6-games-hub.md` |

## Capability map

| Capability | Built | First game |
|---|---|---|
| C1 buttons/stick/multi-touch | D2 | Reaction Duel, Sumo |
| C2 edges/synced timestamps | D2–D3 | Reaction Duel |
| C3 private panel | D5 | Draw and Guess |
| C4 text/choice | D5 | Draw and Guess, Bluff |
| C5 canvas strokes | D5 | Draw and Guess |
| C6 gyro | D6 | Tilt Maze |
| C7 haptics | D6 | Sumo Full, Sword Full |
| C8 audio sync | D3/E11 | Reaction Duel, Beat Tap |
| C9 circle/AABB physics | D3/D7 | Sumo, Tilt Maze |
| C10 3D/LOD/streaming | D3/P6 | Open-World |

## Requirement coverage

| Requirement | Where |
|---|---|
| FR-7.17 | D3-SDK-01, D7-SDK-01, every game |
| FR-9.6 | D7-PERF-01, manifests |
| FR-9.13 | D7-HUB-01, P6-HUB-01/02 |
| PR-9.1–9.8 | D7-RT-01/02, game acceptance |
| FR-8.10, AR-3 | gyro games, haptics games |
| G2/G3/G4/G5/G8 | per-game acceptance |

## Verification

- Each game's own Minimal checklist + tests.
- Recorded input traces; fake clock; bot runs; 8-player runs.
- Per-game size/frame/draw-call budget.
- Reconnect and host-refresh behavior documented per game.

## Change rules

- No platform code changes for game rules. If one seems necessary, file it against the owning stage.
- New content is a pack, not code.
- New capability is a new stage/experiment, not a game hack.
