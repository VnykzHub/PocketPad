# Game: Steering Wheel Racer

| Field | Value |
|---|---|
| Stage | P6 (next tier, wave 2) |
| Spec | `SPEC.md` §17.3 Steering Wheel Racer |
| Capabilities | C1 buttons, C6 gyro, C7 haptics (Full), C9 physics |
| Goals | G4 8 players, G5 gyro + fallback, G8 |
| Depends on | D2 mapper, D6 gyro, D7 physics, D3 audio |
| Work-item prefix | `GAME-SWR-*` |

## Minimal (v1 acceptance)

**Gameplay contract**

- Top-down track with one shared camera that fits all cars (Micro Machines style).
- Phone steers by gyro (preferred) or buttons; tap/hold to accelerate and brake.
- Simple car physics: speed, steering rate proportional to speed, friction, wall slowdown.
- 3 laps; first to finish wins; positions shown; 2–8 players.
- Every car is always visible; the camera zooms to fit the spread, with a maximum zoom-out.
- No gyro required: the button layout is fully playable.

**Host work items**

- [ ] `GAME-SWR-HOST-01` — Track data: centerline/polygon, width, start/finish line, checkpoints; collision keeps cars inside or slows them on grass.
- [ ] `GAME-SWR-HOST-02` — Car physics: acceleration/brake, steering with speed-dependent rate, lateral friction/drift-lite, wall response; no tunneling.
- [ ] `GAME-SWR-HOST-03` — Camera: fit all active cars with padding; clamp zoom; keep the track readable; smooth follow (no jitter).
- [ ] `GAME-SWR-HOST-04` — Race state: countdown, lap/checkpoint validation (must pass checkpoints in order), finish order, results/rematch.
- [ ] `GAME-SWR-HOST-05` — Reconnect: a dropped car coasts/stops; rejoining resumes its position/lap; no teleport.

**Controller work**

- [ ] `GAME-SWR-CTRL-01` — Layout `swr-drive-v1`: gyro steering strip + accelerate/brake buttons + a "Recalibrate" control; fallback button layout `swr-buttons-v1` with left/right + accel/brake.
- [ ] `GAME-SWR-CTRL-02` — Trigger channels `rt` accelerate, `lt` brake (or two large buttons); steering via `gx`/`gy` rate from D6; buttons use `lx` for steering.
- [ ] `GAME-SWR-CTRL-03` — Haptics (Full): curb rumble and collision pulses; optional.
- [ ] `GAME-SWR-CTRL-04` — Show lap/position status and a "Finished" state.

**Data / manifest**

```json
{
  "schemaVersion": 1,
  "name": "Steering Wheel Racer",
  "entry": "index.js",
  "layouts": ["layouts/swr-drive-v1.json", "layouts/swr-buttons-v1.json"],
  "assetBudget": { "initialBytes": 1048576, "totalBytes": 3145728 },
  "minPlayers": 2,
  "maxPlayers": 8,
  "needsGyro": false
}
```

- [ ] `GAME-SWR-DATA-01` — One CC0/self-made track for Minimal: `{centerline, width, checkpoints, laps:3}`.
- [ ] `GAME-SWR-DATA-02` — Config: `maxSpeed`, `accel`, `brake`, `steerRate`, `grip`, `wallSlow`, `cameraPadding`.

**Tests / acceptance**

- [ ] `GAME-SWR-TEST-01` — Physics: acceleration/brake/steering curves; wall collision; no tunneling at max speed.
- [ ] `GAME-SWR-TEST-02` — Lap validation: checkpoints in order; shortcut does not count; finish after 3 laps.
- [ ] `GAME-SWR-TEST-03` — Camera: 2 cars and 8 cars both fit; no car off-screen; zoom clamped.
- [ ] `GAME-SWR-TEST-04` — Gyro and button-only cars race together; both complete 3 laps.
- [ ] `GAME-SWR-TEST-05` — Reconnect mid-race; position/lap preserved.
- [ ] `GAME-SWR-PERF-01` — 8 cars + track within draw-call/frame budgets.

**Anti-rework**

- Track and car parameters are data; one physics path for all cars.
- Button steering uses the same `lx` mapping as the stick; gyro uses the D6 rate path. No per-input physics fork.
- Camera fit is a pure function of car positions; testable without rendering.

## Full version (post-v1 backlog)

- [ ] 3D low-poly tracks and cars (after E12).
- [ ] Drift model, boost, items.
- [ ] AI bots and ghost laps.
- [ ] Several tracks, reverse variants, weather.
- [ ] Engine/curb audio, music, haptic rumble.
- [ ] Leaderboards (local first; no accounts).
- [ ] Per-player camera modes; TV single screen only for v1.

## Risks / watch-outs

- **One screen for 8 cars** forces camera design; test the worst spread and a pile-up.
- **Steering without gyro** must feel good; the button layout is not a fallback afterthought.
- **Gyro drift** over a 3-lap race; recalibrate must be reachable without stopping.
- **Fairness:** gyro and buttons have different precision; document and tune.
- **Track readability** at maximum zoom-out on a TV.

## Acceptance checklist

- [ ] Minimal contract playable with 2 and 8 players.
- [ ] Gyro and button-only paths complete a race.
- [ ] Camera fit and lap validation tests pass.
- [ ] Reconnect behavior documented.
- [ ] Budget/frame metrics recorded.
- [ ] No platform changes required.
