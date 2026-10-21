# Game: Sumo Bumpers

| Field | Value |
|---|---|
| Stage | D7 (proof set) |
| Spec | `SPEC.md` §17.2 Sumo Bumpers |
| Capabilities | C1 stick/buttons, C9 circle physics |
| Goals | G2 touch latency, G4 8 players, G5 multi-touch, G8 SDK proof |
| Depends on | D2 controller, D3 loop, D7-RT-01 physics, D4 sessions |
| Work-item prefix | `GAME-SB-*` |

## Minimal (v1 acceptance)

**Gameplay contract**

- Top-down circular arena; each player is a circle with a joystick-driven acceleration.
- Collisions push players using mass and restitution (custom physics, not Rapier).
- The arena radius shrinks over time; a player fully outside the radius is eliminated.
- Last player standing wins the round; first to 3 round wins takes the match.
- 2–8 players; eliminated players spectate from their phone (status text).
- The match starts when at least 2 players are connected and the host confirms.

**Host work items**

- [ ] `GAME-SB-HOST-01` — Arena state: radius schedule (e.g. 1.0 → 0.35 over 60 s, stepped), spawn ring positions, elimination check, round/match flow.
- [ ] `GAME-SB-HOST-02` — Player physics: acceleration from stick, friction, mass proportional to radius/skin, collision resolution using `resolveCircleCircle`, arena boundary clamp/fall-off.
- [ ] `GAME-SB-HOST-03` — Presentation: circles with distinct colors/patterns and slot labels, shrink indicator, score, round winner, match winner; results screen remote-operable.
- [ ] `GAME-SB-HOST-04` — Reconnect: a dropped player's body stays for 2 s then is removed; rejoining before the next round respawns them; during a round they stay out (documented).
- [ ] `GAME-SB-HOST-05` — Host refresh: restart the match at the current scores (proof scope), or reset; document.

**Controller work**

- [ ] `GAME-SB-CTRL-01` — Layout `sb-stick-v1`: one large floating/fixed left stick, no other controls in Minimal; 44 px targets; same-frame knob.
- [ ] `GAME-SB-CTRL-02` — Show a large "Eliminated — spectating" status when the host sends it (panel or layout status text).
- [ ] `GAME-SB-CTRL-03` — Full version only: a dash button and haptic hit feedback.

**Data / manifest**

```json
{
  "schemaVersion": 1,
  "name": "Sumo Bumpers",
  "entry": "index.js",
  "layouts": ["layouts/sb-stick-v1.json"],
  "assetBudget": { "initialBytes": 524288, "totalBytes": 2097152 },
  "minPlayers": 2,
  "maxPlayers": 8,
  "needsGyro": false
}
```

- [ ] `GAME-SB-DATA-01` — Config: `arenaStartR: 0.48`, `arenaEndR: 0.18`, `shrinkDurationMs: 60000`, `playerRadius: 0.035`, `accel: 42`, `friction: 3.2`, `restitution: 0.65`, `massScale: 1.0`, `roundsToWin: 3`.
- [ ] `GAME-SB-DATA-02` — Arena sizes are normalized to the smaller viewport dimension; no magic pixel constants.

**Tests / acceptance**

- [ ] `GAME-SB-TEST-01` — Physics unit tests: equal-mass head-on exchange, heavy pushes light, overlap correction, wall/outside elimination.
- [ ] `GAME-SB-TEST-02` — Shrink schedule: radius monotonic, elimination at the boundary, last-standing detection.
- [ ] `GAME-SB-TEST-03` — 8-player spawn has no initial overlaps; 8 sticks drive independently.
- [ ] `GAME-SB-TEST-04` — Reconnect/host-refresh behavior documented and tested.
- [ ] `GAME-SB-TEST-05` — 8-bot 10-minute run: no stuck bodies, no leak in the pool.
- [ ] `GAME-SB-PERF-01` — 8 bodies + arena ≤ 120 draw calls; frame p95 recorded; zero per-frame allocations.

**Anti-rework**

- Physics primitives live in runtime; the game only supplies body parameters and rules.
- Circles are pooled; elimination returns the body to the pool.
- No server/game-state changes; collisions are host-authoritative.

## Full version (post-v1 backlog)

- [ ] Dash and charge mechanics (hold to charge, release to dash).
- [ ] Power-ups (speed, mass, shockwave) with spawn timing.
- [ ] Several arenas with hazards (spikes, moving walls, ice).
- [ ] Hit-stop, screen shake, particle hit effects.
- [ ] Android haptics on hit, sounds, announcer.
- [ ] Bot fill-ins for empty slots.
- [ ] 3D low-poly stage, skins, results screen with stats.

## Risks / watch-outs

- **Collision feel** (mass, friction, restitution) needs tuning; keep values in data and test 2/4/8 players.
- **Spawn fairness:** spawn on a ring, not random, to avoid initial collisions.
- **8-player readability:** distinct patterns + labels, not color alone.
- **Edge cases:** two players eliminated on the same tick → both out; if one remains, they win.
- **Phone reconnect:** a body without input should drift/stop, not teleport.

## Acceptance checklist

- [ ] Minimal contract playable with 2 and 8 players.
- [ ] Physics, shrink, elimination and last-standing tests pass.
- [ ] 8-bot run stable; no per-frame allocations.
- [ ] Reconnect/host-refresh documented.
- [ ] Budget/frame metrics recorded.
- [ ] No platform changes required.
