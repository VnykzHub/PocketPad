# Game: Tilt Maze Race

| Field | Value |
|---|---|
| Stage | D7 (proof set) |
| Spec | `SPEC.md` §17.2 Tilt Maze Race |
| Capabilities | C6 gyro, C1 fallback stick, C9 circle physics |
| Goals | G5 gyro with graceful degradation, G2, G8 |
| Depends on | D6 MotionSource/TiltIntegrator, D2 mapper, D7-RT-01 physics, D4 sessions |
| Work-item prefix | `GAME-TM-*` |

## Minimal (v1 acceptance)

**Gameplay contract**

- A shared maze is shown on the TV; each player drives a ball by tilting their phone.
- Walls collide; the first ball to reach the exit wins the race.
- A joystick fallback is always available; a Recalibrate button is visible.
- 2–8 players; all balls share the same maze but have independent start positions.
- Tilt is host-integrated from `rotationRate` (D6-RT-01): the controller sends rates, the host maintains an angle per slot.
- If motion is unavailable/denied, the stick controls the same ball with the same physics.

**Host work items**

- [ ] `GAME-TM-HOST-01` — Maze data + collision: grid walls, ball-vs-wall AABB/circle resolution, start/exit cells, per-player start offsets.
- [ ] `GAME-TM-HOST-02` — Tilt integration: use `TiltIntegrator` angles as acceleration (e.g. `accel = sin(angle) * g`); clamp; recenter resets; fallback stick maps directly to acceleration.
- [ ] `GAME-TM-HOST-03` — Camera: fit the whole maze at once (Minimal); scale to the TV, keep balls visible; no scrolling.
- [ ] `GAME-TM-HOST-04` — Race state: countdown, first-to-exit, finish times, winner, results/rematch; Minimal has no traps.
- [ ] `GAME-TM-HOST-05` — Reconnect: a dropped ball freezes/coasts; rejoining resumes at its position; a motion-disabled player uses the stick seamlessly.

**Controller work**

- [ ] `GAME-TM-CTRL-01` — Layout `tm-tilt-v1`: gyro control/status + Recalibrate + a stick fallback + a small "finish" status. `sensors.gyro: "tilt"`, sensitivity 1.2, smoothing 0.12.
- [ ] `GAME-TM-CTRL-02` — Enable-motion flow (D6); if denied, the stick remains fully usable; no full-screen block.
- [ ] `GAME-TM-CTRL-03` — Recalibrate sends the recenter flag; the host resets the angle.
- [ ] `GAME-TM-CTRL-04` — Show a "Finished!" state and disable input after the race.

**Data / manifest**

```json
{
  "schemaVersion": 1,
  "name": "Tilt Maze Race",
  "entry": "index.js",
  "layouts": ["layouts/tm-tilt-v1.json", "layouts/tm-stick-v1.json"],
  "assetBudget": { "initialBytes": 262144, "totalBytes": 1048576 },
  "minPlayers": 2,
  "maxPlayers": 8,
  "needsGyro": false
}
```

- The game declares `needsGyro: false` because the stick fallback is always present; the gyro layout is preferred. This avoids blocking the launcher for gyro-less players.
- [ ] `GAME-TM-DATA-01` — Maze JSON `{width, height, walls: [[x,y,w,h]], start: [{x,y}], exit: {x,y}}`; one hand-authored maze for Minimal, CC0/self-made.
- [ ] `GAME-TM-DATA-02` — Config: `ballRadius`, `accelScale`, `maxSpeed`, `friction`, `recenterClampDeg`, `countdownMs`.

**Tests / acceptance**

- [ ] `GAME-TM-TEST-01` — Axis remap: tilt forward/back/left/right maps to the expected acceleration in landscape and portrait.
- [ ] `GAME-TM-TEST-02` — Drift: a stationary phone does not move the ball after auto-zero; recalibrate resets.
- [ ] `GAME-TM-TEST-03` — Fallback: motion denied → stick drives the ball; play the full race.
- [ ] `GAME-TM-TEST-04` — Wall collisions: no tunneling at max speed; ball stays inside; exit triggers a finish.
- [ ] `GAME-TM-TEST-05` — 8 players race; first-to-exit; finish order stable.
- [ ] `GAME-TM-TEST-06` — Reconnect mid-race; position preserved; motion-disabled player unaffected.
- [ ] `GAME-TM-PERF-01` — Maze + 8 balls within draw-call/frame budgets.

**Anti-rework**

- Controller sends rates; host integrates angles. Do not move integration into the game or controller per game.
- The same physics path serves gyro and stick; the input source is the only difference.
- Maze data and start positions are data, not code.

## Full version (post-v1 backlog)

- [ ] Procedural mazes with solvability checks.
- [ ] Traps, moving walls, one-way gates.
- [ ] Power-ups (speed, shield, freeze).
- [ ] 3D ball physics and a tilted-board camera.
- [ ] Haptic wall hits on Android.
- [ ] Ghost trails of best runs.
- [ ] Race and survival modes, minimap, difficulty levels.
- [ ] Per-player camera options for big mazes.

## Risks / watch-outs

- **Gyro needs HTTPS and calibration (E7):** the tunnel dev flow is mandatory for sensor tests; production is HTTPS.
- **Drift:** auto-zero + recalibrate + host decay; test 60 s stationary.
- **Fairness:** different phones may report different rates; sensitivity is per layout, not per device. Document.
- **Fallback parity:** the stick must be genuinely playable, not a token control; game acceptance includes a stick-only race.
- **Maze readability on a TV:** high-contrast walls, distinct ball colors/patterns, start/exit labels.

## Acceptance checklist

- [ ] Minimal contract playable with 2–8 players.
- [ ] Gyro and stick paths both complete a race.
- [ ] Axis remap/drift/recalibrate tests pass.
- [ ] Wall collision and finish detection pass.
- [ ] Reconnect behavior documented.
- [ ] Budget/frame metrics recorded.
- [ ] No platform changes required.
