# Game: Snake Royale

| Field | Value |
|---|---|
| Stage | P6 (next tier, wave 2) |
| Spec | `SPEC.md` §17.3 Snake Royale |
| Capabilities | C1 D-pad/touchpad |
| Goals | G4 8 players, G8 |
| Depends on | D2 D-pad/touchpad, D3 fixed loop, D7 HUD |
| Work-item prefix | `GAME-SR-*` |

## Minimal (v1 acceptance)

**Gameplay contract**

- Grid-based snakes; each player turns with a D-pad or swipe.
- Food spawns on free cells; eating grows the snake.
- Hitting a wall, yourself, or another snake eliminates you.
- The arena shrinks over time (cells become walls).
- Last snake alive wins; 2–8 players.
- Simulation steps at 8–10 Hz; rendering interpolates between steps (FR-9.1).

**Host work items**

- [ ] `GAME-SR-HOST-01` — Grid state: `gridSize`, wall mask, food set, snakes with cell lists and directions; deterministic step order.
- [ ] `GAME-SR-HOST-02` — Step rules: simultaneous direction resolve, move, collision (wall/self/other), food growth, elimination, food respawn on free cells.
- [ ] `GAME-SR-HOST-03` — Shrink: remove border cells on a schedule; eliminate snakes occupying removed cells; show the shrinking border.
- [ ] `GAME-SR-HOST-04` — Render interpolation: draw snakes between previous/current cells using `alpha`; HUD scores/lengths; results/rematch.
- [ ] `GAME-SR-HOST-05` — Reconnect: a dropped snake stays on the grid without turning (or is removed after 5 s); rejoining resumes control if alive.

**Controller work**

- [ ] `GAME-SR-CTRL-01` — Layout `snake-dpad-v1`: D-pad (4 directions) + optional touchpad swipe; 44 px; same-frame direction feedback.
- [ ] `GAME-SR-CTRL-02` — Direction changes are edge-triggered; ignore 180° reversals.
- [ ] `GAME-SR-CTRL-03` — Show alive/eliminated status and your length.

**Data / manifest**

```json
{
  "schemaVersion": 1,
  "name": "Snake Royale",
  "entry": "index.js",
  "layouts": ["layouts/snake-dpad-v1.json"],
  "assetBudget": { "initialBytes": 262144, "totalBytes": 1048576 },
  "minPlayers": 2,
  "maxPlayers": 8,
  "needsGyro": false
}
```

- [ ] `GAME-SR-DATA-01` — Config: `gridSize: 32`, `stepHz: 8`, `initialLength: 4`, `shrinkEveryMs: 15000`, `foodCount: 3`, `respawnGraceMs`.
- [ ] `GAME-SR-DATA-02` — Spawn positions on a ring/edges, spaced; no overlap; no food under snakes.

**Tests / acceptance**

- [ ] `GAME-SR-TEST-01` — Step rules: growth on food, self/wall/other collision, 180° rejection.
- [ ] `GAME-SR-TEST-02` — Simultaneous head-on collision: both die (documented) or a deterministic rule.
- [ ] `GAME-SR-TEST-03` — Shrink removes border cells and eliminates occupants.
- [ ] `GAME-SR-TEST-04` — Last-alive detection and winner; 8-snake run.
- [ ] `GAME-SR-TEST-05` — Interpolation alpha maps previous/current cells without visual snapping.
- [ ] `GAME-SR-TEST-06` — Reconnect behavior documented.
- [ ] `GAME-SR-PERF-01` — 8 snakes within frame budget; HUD cached.

**Anti-rework**

- Grid rules are game logic; the platform only provides input/loop/render.
- Direction input uses the D-pad bits/touchpad axes, no custom protocol.
- Food/shrink are data-driven schedules.

## Full version (post-v1 backlog)

- [ ] Power-ups (speed, ghost, magnet).
- [ ] Smooth interpolated movement with rounded segments.
- [ ] Shrink zones with warnings and safe zones.
- [ ] Themes and skins.
- [ ] Bots for empty slots.
- [ ] Team modes and score by length/food.

## Risks / watch-outs

- **Input latency at 8 Hz steps** can feel unresponsive; apply direction changes at the next step but show the queued turn immediately.
- **Head-on collisions** need a documented rule; deterministic is better than random.
- **8 snakes on a 32×32 grid** can fill space fast; tune shrink/food.
- **Interpolation** must not show a snake passing through a wall; render only the valid segment.

## Acceptance checklist

- [ ] Minimal contract playable with 2 and 8 players.
- [ ] Step, collision, shrink, winner tests pass.
- [ ] Interpolation looks smooth at 8–10 Hz.
- [ ] Reconnect behavior documented.
- [ ] Budget/frame metrics recorded.
- [ ] No platform changes required.
