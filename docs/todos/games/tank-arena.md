# Game: Tank Arena

| Field | Value |
|---|---|
| Stage | P6 (next tier, wave 2) |
| Spec | `SPEC.md` §17.3 Tank Arena |
| Capabilities | C1 two sticks, C9 physics |
| Goals | G4 8 players, G5 multi-touch, G8 |
| Depends on | D2 dual-stick mapping, D7 physics/pools, D3 loop |
| Work-item prefix | `GAME-TA-*` |

## Minimal (v1 acceptance)

**Gameplay contract**

- Top-down arena with static walls.
- Left stick drives, right stick aims; the tank auto-fires in the aim direction (with a cooldown).
- Bullets are pooled, collide with walls/tanks, and deal damage.
- HP per tank; destroyed tanks respawn after 3 s at a free spawn point.
- Free-for-all; first to 10 kills wins (or highest after 5 min).
- 2–8 players.

**Host work items**

- [ ] `GAME-TA-HOST-01` — Input mapping: left stick → movement vector/angle; right stick → aim angle; auto-fire when aim magnitude > deadzone and cooldown ready.
- [ ] `GAME-TA-HOST-02` — Bullets: fixed-size pool (e.g. 128), spawn at muzzle, velocity, lifetime, wall/tank collision, damage, no allocation.
- [ ] `GAME-TA-HOST-03` — Tanks: movement with wall collision, HP, respawn timer, spawn-point selection, score, invulnerability 1 s after respawn.
- [ ] `GAME-TA-HOST-04` — Arena: walls from data, bounds, distinct tank patterns/labels, HP bars, scoreboard, results/rematch.
- [ ] `GAME-TA-HOST-05` — Reconnect: a dropped tank is inert/despawned after 2 s; rejoining respawns with the current score; no duplicate bodies.

**Controller work**

- [ ] `GAME-TA-CTRL-01` — Layout `ta-twin-v1`: left stick (movement), right stick or touchpad (aim), 44 px targets, multi-touch for both simultaneously.
- [ ] `GAME-TA-CTRL-02` — No fire button in Minimal (auto-fire); show a small "cooldown" status.
- [ ] `GAME-TA-CTRL-03` — Full: fire button, reload/charge, haptic recoil.

**Data / manifest**

```json
{
  "schemaVersion": 1,
  "name": "Tank Arena",
  "entry": "index.js",
  "layouts": ["layouts/ta-twin-v1.json"],
  "assetBudget": { "initialBytes": 524288, "totalBytes": 2097152 },
  "minPlayers": 2,
  "maxPlayers": 8,
  "needsGyro": false
}
```

- [ ] `GAME-TA-DATA-01` — One CC0/self-made arena `{walls:[{x,y,w,h}], spawns:[{x,y,angle}]}`.
- [ ] `GAME-TA-DATA-02` — Config: `moveSpeed`, `bulletSpeed`, `fireCooldownMs`, `damage`, `hp`, `respawnMs`, `invulnMs`, `killTarget`.

**Tests / acceptance**

- [ ] `GAME-TA-TEST-01` — Twin-stick mapping: left moves, right aims; both simultaneous; deadzones.
- [ ] `GAME-TA-TEST-02` — Bullet pool: reuse, lifetime, wall collision, no per-frame allocation.
- [ ] `GAME-TA-TEST-03` — Damage/respawn/score; spawn point not occupied; invulnerability.
- [ ] `GAME-TA-TEST-04` — 8 players: independent movement/aim; no cross-slot input.
- [ ] `GAME-TA-TEST-05` — Reconnect mid-match; no duplicate tank.
- [ ] `GAME-TA-PERF-01` — 8 tanks + 128 bullets within draw-call/frame budgets.

**Anti-rework**

- Bullets and tanks are pooled; the game uses runtime physics/pools.
- Aim is a right-stick/touchpad axis, not a separate pointer event path.
- Arena data is external; no hard-coded wall arrays.

## Full version (post-v1 backlog)

- [ ] Destructible walls.
- [ ] Bouncing shots, ricochet.
- [ ] Power-ups (shield, rapid fire, triple shot).
- [ ] Team modes (2v2/4v4) and friendly fire option.
- [ ] Many maps, rotating hazards.
- [ ] Recoil haptics, camera shake, hit particles.
- [ ] Bots for empty slots.

## Risks / watch-outs

- **Two sticks on a phone** need enough space and multi-touch; test 44 px and overlap.
- **Auto-fire fairness:** cooldown and aim deadzone must be consistent.
- **Bullet count:** cap the pool and lifetime; no unbounded arrays.
- **Respawn spawn-camping:** choose the spawn farthest from enemies or add invulnerability.
- **Readability:** 8 tanks + bullets on a TV; use shapes/labels, not only color.

## Acceptance checklist

- [ ] Minimal contract playable with 2 and 8 players.
- [ ] Twin-stick, bullets, respawn, scoring tests pass.
- [ ] Bullet/tank pools allocation-free.
- [ ] Reconnect behavior documented.
- [ ] Budget/frame metrics recorded.
- [ ] No platform changes required.
