# Game: Open-World Showcase

| Field | Value |
|---|---|
| Stage | P6 (ambitious, wave 4) — **gated by E3, E12 and P6-RT-01** |
| Spec | `SPEC.md` §17.4 Open-World Showcase, §9.4 |
| Capabilities | C1 movement, C9 physics-lite, C10 3D/LOD/streaming |
| Goals | G3 bundle/streaming, G5, G8; engine stress test |
| Depends on | P6-RT-01 streaming, D3 renderer/E12, E3 device benchmark |
| Work-item prefix | `GAME-OWS-*` |

## Gate

Do **not** start unless:
- E3 shows the TV can handle the target scene at ≥ 30 fps at 720p, and
- E12's renderer decision is implemented and within memory/texture budgets, and
- P6-RT-01's streaming meets FR-9.8–9.10.

If any gate fails, mark this game **deferred** in `docs/RESULTS.md` and ship the rest of the catalog. This is a showcase, not a v1 blocker (spec §19).

## Minimal (v1 acceptance)

**Gameplay contract**

- About 1 km² of low-poly terrain with chunk streaming.
- Three LOD tiers per streamed object.
- 2 players walking or driving on the same screen.
- Day-night cycle with baked lighting (no dynamic shadow cost).
- Fixed 30 fps target on the TV; dynamic resolution may lower render scale, not sim rate.
- No missions, traffic or pedestrians in Minimal; the goal is to prove the engine.

**Host work items**

- [ ] `GAME-OWS-HOST-01` — Terrain: low-poly heightfield chunks, deterministic generation from a seed, collision height sampling.
- [ ] `GAME-OWS-HOST-02` — Streaming: use `ChunkManager` (P6-RT-01); load/unload by player positions; worker decode; pooled meshes.
- [ ] `GAME-OWS-HOST-03` — LOD: 3 tiers, distance swap, no per-frame allocation; frustum culling (PR-9.7).
- [ ] `GAME-OWS-HOST-04` — Player: walk/drive modes, camera follow, terrain collision, 2 slots; simple vehicle physics.
- [ ] `GAME-OWS-HOST-05` — Day-night: baked lighting states or a simple sun rotation with precomputed colors; no expensive realtime shadows.
- [ ] `GAME-OWS-HOST-06` — Budget instrumentation: chunks, LOD counts, draw calls, texture MB, frame p95; debug overlay.
- [ ] `GAME-OWS-HOST-07` — Reconnect: a player's avatar persists; rejoining resumes control; no duplicate avatars.

**Controller work**

- [ ] `GAME-OWS-CTRL-01` — Layout `ows-drive-v1`: left stick movement, A to toggle walk/drive, B to brake/interact; 44 px.
- [ ] `GAME-OWS-CTRL-02` — No gyro; the game is fully playable with buttons/sticks.
- [ ] `GAME-OWS-CTRL-03` — Show mode/speed and a simple map/coords (optional).

**Data / manifest**

```json
{
  "schemaVersion": 1,
  "name": "Open-World Showcase",
  "entry": "index.js",
  "layouts": ["layouts/ows-drive-v1.json"],
  "assetBudget": { "initialBytes": 3145728, "totalBytes": 5242880 },
  "minPlayers": 1,
  "maxPlayers": 2,
  "needsGyro": false,
  "chunkConfig": {
    "chunkSize": 64,
    "loadRadius": 3,
    "unloadRadius": 4,
    "lodTiers": [0, 80, 200]
  }
}
```

- [ ] `GAME-OWS-DATA-01` — One seeded terrain config; no external art beyond a small texture atlas; all assets licensed.
- [ ] `GAME-OWS-DATA-02` — Config: `terrainSize`, `chunkSize`, `loadRadius`, `unloadRadius`, `lodTiers`, `walkSpeed`, `driveSpeed`, `dayLengthMs`.

**Tests / acceptance**

- [ ] `GAME-OWS-TEST-01` — Chunk load/unload radius; no duplicate chunks; deterministic generation.
- [ ] `GAME-OWS-TEST-02` — LOD swap at thresholds; no per-frame GPU buffer allocation.
- [ ] `GAME-OWS-TEST-03` — Main-thread chunk work ≤ 8 ms; worker used where possible.
- [ ] `GAME-OWS-TEST-04` — 2 players move independently; camera keeps both visible.
- [ ] `GAME-OWS-TEST-05` — 30-minute drive/walk: memory stable, no chunk leak, frame p95 within budget.
- [ ] `GAME-OWS-TEST-06` — Texture memory within E2; draw calls ≤ 120 (or a documented exception).
- [ ] `GAME-OWS-PERF-01` — 30 fps target at 720p on the TV; record scale and p95.

**Anti-rework**

- Streaming/LOD live in runtime (P6-RT-01), not the game.
- Terrain is seeded data; no hand-placed meshes for Minimal.
- The renderer is behind the E12 decision; no direct Three.js calls in game code.
- If deferred, the streaming interface remains available for future 3D games.

## Full version (post-v1 backlog)

- [ ] Traffic and pedestrians.
- [ ] Missions and objectives.
- [ ] More players (4–8).
- [ ] Destructible props.
- [ ] A proper art style and audio.
- [ ] A map/menu and fast travel.
- [ ] Weather and advanced lighting.

## Risks / watch-outs

- **Months of work** if allowed to grow; the Minimal is deliberately an engine demo, not a game.
- **TV memory/GPU** is the hard constraint; the gate exists so this does not sink P6.
- **Streaming hitching** on the main thread; worker decode and ≤ 8 ms chunks are mandatory.
- **Scope creep:** no missions/traffic in Minimal; ship the catalog first.
- **Asset budget:** 1 km² of low-poly terrain must still fit the 5 MB initial limit; stream the rest.

## Acceptance checklist

- [ ] E3/E12/P6-RT-01 gates positive or game deferred in writing.
- [ ] Minimal demo runs at 30 fps on the TV at 720p.
- [ ] Streaming/LOD/memory tests pass.
- [ ] 2-player walk/drive works.
- [ ] 30-minute stability run recorded.
- [ ] No platform changes outside P6-RT-01.
