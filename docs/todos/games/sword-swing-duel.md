# Game: Sword Swing Duel

| Field | Value |
|---|---|
| Stage | P6 (ambitious, wave 3) — **gated by D6 swing feasibility** |
| Spec | `SPEC.md` §17.4 Sword Swing Duel |
| Capabilities | C6 gyro, C7 haptics (Full), C9 physics-lite |
| Goals | G5 motion control, G8; high risk |
| Depends on | D6 motion/remap, D6-EXP-01 swing feasibility, D2 mapper, D3 loop |
| Work-item prefix | `GAME-SSD-*` |

## Gate

Do **not** start this game unless the D6 swing-feasibility note reports reliable left/right/overhead classification (target: ≥ 90% over 30 swings per direction, false positives acceptable for gameplay). If not, either ship a button-only duel or defer the game. Record the decision in `docs/RESULTS.md`.

## Minimal (v1 acceptance)

**Gameplay contract**

- Two players, side-view 2D arena.
- Swing detection from `rotationRate` magnitude/axis classifies left, right, and overhead swings.
- Hold a button to block; a correct block reduces/negates damage.
- Every move is also available as a button (fallback); the game is fully playable without gyro.
- Best of 3 rounds; HP per round; winner scoreboard.
- 2 players only (duel); spectators not required.

**Host work items**

- [ ] `GAME-SSD-HOST-01` — Fighter state machine: idle, swinging, blocking, hit, KO; attack wind-up/active/recovery windows; block window; hitstun.
- [ ] `GAME-SSD-HOST-02` — Swing classification: consume `gyro` rates with a threshold/hysteresis classifier (left/right/overhead); only accept one swing per gesture; cooldown. Record raw traces and tune.
- [ ] `GAME-SSD-HOST-03` — Hit resolution: attack hitbox vs defender hurtbox; block reduces damage; facing matters; no double hits per swing.
- [ ] `GAME-SSD-HOST-04` — Rounds: best-of-3, HP bars, KO, round/match results, rematch/return (remote-operable).
- [ ] `GAME-SSD-HOST-05` — Reconnect: a dropped fighter pauses the round for 20 s then forfeits; rejoining resumes if within the pause.

**Controller work**

- [ ] `GAME-SSD-CTRL-01` — Layout `ssd-swing-v1`: gyro status + block button + fallback attack buttons (left/right/overhead); `ssd-buttons-v1` for no-gyro.
- [ ] `GAME-SSD-CTRL-02` — Block is a held button; release to stop blocking; same-frame pressed state.
- [ ] `GAME-SSD-CTRL-03` — Haptics (Full): hit/block pulses; optional.
- [ ] `GAME-SSD-CTRL-04` — Show HP/round and a "Swing!" hint; no full-screen motion prompt after enable.

**Data / manifest**

```json
{
  "schemaVersion": 1,
  "name": "Sword Swing Duel",
  "entry": "index.js",
  "layouts": ["layouts/ssd-swing-v1.json", "layouts/ssd-buttons-v1.json"],
  "assetBudget": { "initialBytes": 524288, "totalBytes": 2097152 },
  "minPlayers": 2,
  "maxPlayers": 2,
  "needsGyro": false
}
```

- [ ] `GAME-SSD-DATA-01` — Config: `roundsToWin: 2`, `hp: 100`, `swingDamage`, `blockReduction`, `swingThresholdDps`, `cooldownMs`, `hitstunMs`.
- [ ] `GAME-SSD-DATA-02` — Recorded swing traces per direction for offline classification tests.

**Tests / acceptance**

- [ ] `GAME-SSD-TEST-01` — Classification over recorded traces: confusion matrix; meets the gate threshold.
- [ ] `GAME-SSD-TEST-02` — Hit/block windows; block reduces damage; no double hit; facing.
- [ ] `GAME-SSD-TEST-03` — Button-only path plays a full match; gyro path plays a full match.
- [ ] `GAME-SSD-TEST-04` — Best-of-3, KO, rematch.
- [ ] `GAME-SSD-TEST-05` — Reconnect/forfeit behavior.
- [ ] `GAME-SSD-PERF-01` — Effects/frame budget; no per-swing allocations.

**Anti-rework**

- Classification is host-side over streamed rates; do not add a new gesture protocol.
- Buttons map to the same attack actions as classified swings; one combat state machine.
- If the gate fails, the button-only version is still a valid Minimal; do not half-ship gyro.

## Full version (post-v1 backlog)

- [ ] 3D animated fighters (after E12).
- [ ] Parry timing windows, stances, combo chains.
- [ ] Haptics, sound design, hit-stop.
- [ ] Tutorial and per-device calibration.
- [ ] Ranked best-of and local stats.
- [ ] Multiple weapons/arenas.

## Risks / watch-outs

- **Classification reliability and latency** are the whole game; the D6 gate exists for this.
- **Safety:** players swing phones; show a "hold firmly, clear space" warning before enabling motion.
- **Gyro drift:** recalibrate between rounds; classifier should tolerate bias.
- **Fairness:** button players vs gyro players have different timing; separate modes or document.
- **Scope:** this is the riskiest P6 game; ship after the safer waves.

## Acceptance checklist

- [ ] D6 gate positive or game deferred/button-only decision recorded.
- [ ] Classification confusion matrix meets the threshold.
- [ ] Button-only and gyro matches both complete.
- [ ] Hit/block/round rules tested.
- [ ] Reconnect/forfeit documented.
- [ ] Budget/frame metrics recorded.
- [ ] No platform changes required.
