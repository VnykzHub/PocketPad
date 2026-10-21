# Game: Heist Planner

| Field | Value |
|---|---|
| Stage | P6 (ambitious, wave 4) |
| Spec | `SPEC.md` §17.4 Heist Planner |
| Capabilities | C1 movement, C3 private panels, live host→phone data |
| Goals | G5 private screens, G8; highest content cost |
| Depends on | D5 panels/hot-swap, D2 movement, D4 sessions |
| Work-item prefix | `GAME-HP-*` |

## Minimal (v1 acceptance)

**Gameplay contract**

- One runner moves on a 2D grid map shown on the TV.
- Other phones show patrol timing diagrams on private panels (routes and timing, not live positions).
- Guards patrol on deterministic loops; the runner must reach the vault without being seen.
- One hand-authored level for Minimal.
- 2–8 players: one runner, the rest are planners reading panels and calling out timing.
- Win when the runner reaches the vault; lose on detection or timer expiry.

**Host work items**

- [ ] `GAME-HP-HOST-01` — Level data: grid/walls, vault, start, guard patrol paths with period/offset; deterministic simulation.
- [ ] `GAME-HP-HOST-02` — Runner movement: grid or continuous with wall collision; move via stick/buttons; no teleport.
- [ ] `GAME-HP-HOST-03` — Guards/vision: patrol interpolation, line-of-sight cones or grid visibility; detection triggers loss; debug toggle to visualize.
- [ ] `GAME-HP-HOST-04` — Panel feed: send each planner slot a compact timing diagram, rate-limited (≤ 2 Hz) and only on change; no live guard positions (Minimal).
- [ ] `GAME-HP-HOST-05` — Timer/win/loss, results/restart; reconnect: runner/planner can rejoin; planner panels re-sent on resume.
- [ ] `GAME-HP-HOST-06` — Host refresh: restart the level (proof scope); document.

**Controller work**

- [ ] `GAME-HP-CTRL-01` — Runner layout `hp-runner-v1`: stick or D-pad + a "sneak/run" toggle; 44 px.
- [ ] `GAME-HP-CTRL-02` — Planner layout `hp-planner-v1`: private panel with the timing diagram (text/blocks rendered from data), paging if needed.
- [ ] `GAME-HP-CTRL-03` — Show role, timer, and detected/win state.
- [ ] `GAME-HP-CTRL-04` — No live map on the phone in Minimal; planners must communicate.

**Data / manifest**

```json
{
  "schemaVersion": 1,
  "name": "Heist Planner",
  "entry": "index.js",
  "layouts": ["layouts/hp-runner-v1.json", "layouts/hp-planner-v1.json"],
  "assetBudget": { "initialBytes": 524288, "totalBytes": 2097152 },
  "minPlayers": 2,
  "maxPlayers": 8,
  "needsGyro": false
}
```

- [ ] `GAME-HP-DATA-01` — One CC0/self-made level `{grid, walls, patrols:[{path, periodMs, offsetMs}], vault, start}`.
- [ ] `GAME-HP-DATA-02` — Config: `tickHz`, `runnerSpeed`, `detectionRadius`, `timerMs`, `panelHz`.

**Tests / acceptance**

- [ ] `GAME-HP-TEST-01` — Patrol determinism: same period/offset yields the same positions at a given time.
- [ ] `GAME-HP-TEST-02` — Detection: line-of-sight/radius; loss triggers once; no false positives through walls.
- [ ] `GAME-HP-TEST-03` — Runner collision: walls block; vault triggers win.
- [ ] `GAME-HP-TEST-04` — Panel feed: ≤ 2 Hz, only on change, per-slot privacy; planner never receives live positions.
- [ ] `GAME-HP-TEST-05` — Reconnect: panels re-sent; runner resumes.
- [ ] `GAME-HP-PERF-01` — Map/guards within frame budget; panel JSON under 4 KB.

**Anti-rework**

- Level content is a pack; no hard-coded maps.
- Panel feed uses the existing `panel` message and rate limits; no new protocol.
- Patrol timing is data; the simulation is deterministic.

## Full version (post-v1 backlog)

- [ ] Multiple levels and a level editor.
- [ ] Roles/gadgets (hacker, lookout, distraction).
- [ ] Live patrol positions with rate-limited feeds (still private).
- [ ] Replays and scoring.
- [ ] More guard types, cameras, doors.
- [ ] A proper art style and audio.

## Risks / watch-outs

- **Highest design/content cost** in the catalog; keep Minimal to one excellent level.
- **Panel readability:** timing diagrams must be understandable without live positions.
- **Host→phone feed:** never stream at 60 Hz; rate-limit and send on change.
- **Fairness:** patrol timing must be readable and deterministic; no hidden randomness.
- **Scope:** do not start until the simpler P6 games ship.

## Acceptance checklist

- [ ] Minimal contract playable with 2–8 players.
- [ ] Patrol/detection/win tests pass.
- [ ] Panel privacy and feed rate verified.
- [ ] Reconnect and host-refresh documented.
- [ ] Content pack licensed.
- [ ] No platform changes required.
