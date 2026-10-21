# Game: Coin Run (2D Platformer)

| Field | Value |
|---|---|
| Stage | Accelerated track, Wave 3 — **dev-tier extra** |
| Spec | **Not in `SPEC.md` §17.** New scope approved for the accelerated first-playable slice; it does not replace any §17 game |
| Capabilities | C1 d-pad/buttons/stick, C9 circle/AABB physics |
| Goals | G2 latency, G4 up to 4 players, G5 multi-touch, G8 SDK boundary; G1 advanced by the D0 join flow (QR proof stays in D4) |
| Depends on | D2 layout/controls/mapper, D3 loop/`GameHost`, D7-SDK-01 registry/`RoundManager`, D7-RT-01 renderer/physics/HUD/results |
| Work-item prefix | `GAME-PF-*` |
| Working title | **Coin Run** |
| Slice route | `/games/platformer/` (temporary manifest selector, see `GAME-PF-01`) |
| Execution map | [`../ACCELERATED-PLATFORMER.md`](../ACCELERATED-PLATFORMER.md) |

> **Status:** plan only. Every step in this file is unchecked. No measurements exist for this game yet; the tuning values below are design targets, not measured results.

---

## 0. Scope and non-negotiable boundaries

**Game scope (Minimal v1).** One side-scrolling level. 1–4 players. Each phone controls one character with left/right (d-pad or stick) plus one jump button. Gravity, ground/platform collision, coins, goal flag, fall respawn, shared team score, results screen and rematch.

**Boundaries**

1. **Extra game, not a proof game.** The four D7 proof games — Reaction Duel, Sumo Bumpers, Draw and Guess, Tilt Maze Race — remain required by the Dev Exit Gate. Coin Run does not satisfy D7 and must not delay it.
2. **Frozen contracts only.** The game consumes the D2 `LayoutDocument`/`ControllerState`, the D3 `Game`/`GameContext`/`GameHost`, the D7-SDK-01 registry/`RoundManager`, and the D7-RT-01 renderer/physics primitives. No direct sockets, protocol frames, broker calls, or controller internals in game code (FR-7.17).
3. **No new runtime dependencies.** The game uses `@lanpad/sdk` types and the runtime game-facing APIs only (G7).
4. **No assets required for Minimal.** Procedural shapes only; the manifest still declares a byte budget so the size gate is exercised early.
5. **Data-driven.** Level, layouts, tuning and coin count are JSON/config, never hard-coded arrays that later need extraction.
6. **Additive slice path.** The first playable uses the existing D0 room create/join flow and a direct `/games/platformer/` route. The full hub, D4 sessions and D5 layout hot-swap arrive later and mount the same `GameHost`; they must not force a game rewrite.
7. **No analytics, uploads, cookies or PII.** Same rule as every other game (SR-7).

---

## 1. Minimal (v1 acceptance)

**Gameplay contract**

- One level, `120 × 18` world units, y-down, no vertical scrolling. Ground with three pits, five floating platforms, two checkpoints, 20 coins and one goal flag.
- 1–4 players share one fixed-aspect camera. Each player is a circle collider with a slot label and a distinct pattern (not colour alone).
- Left/right movement comes from the **d-pad bits `DLeft`/`DRight` (10/11)** or the **left stick `lx`**; jump is the **A button bit 0 edge** (FR-7.2, FR-7.3). No gyro, no haptics, no private panel.
- Movement: horizontal speed, gravity, one fixed jump impulse, coyote time and jump buffering. No player–player collision in Minimal.
- Coins are collected once each and add to **one shared team score**. Per-player contributions are recorded for the results screen only.
- Falling below the kill plane respawns that player at their last checkpoint after a short delay; collected coins are kept and no life is lost. Minimal has no fail state.
- The first player to touch the goal flag completes the level for everyone. Results show team coins/total, elapsed time and per-slot contributions.
- Rematch resets the level, coins, checkpoints and scores. The host operates the results actions with arrow keys and Enter (AR-4).
- Round flow: runtime start screen → lobby → 3 s countdown → playing → results. The game starts when at least one controller is connected and the host confirms.
- **Slice reconnect gap:** D0 has no session tokens/QR. A phone reload joins as a new slot; the game has no slot-list event until D4/D5, so the old character may remain idle for the session. D4 adds rejoin without changing game rules. This is documented, not silently hidden.

**Out of scope for Minimal**

- Enemies, power-ups, moving platforms, one-way platforms, individual scoring, level selection, assets, music, gyro, haptics, panels, text, canvas, hub integration, QR/PIN sessions.

---

## 2. Contracts used (frozen; do not extend from game code)

| Contract | Source | Used for |
|---|---|---|
| `LayoutDocument`, `validateLayout` | D2-LAYOUT-01 / `sdk/src/layout.ts` | `pf-dpad-v1`, `pf-stick-v1` |
| `ButtonControl`, `DpadControl`, `StickControl` | D2-LAYOUT-01 | jump + left/right |
| `ControllerState`, `InputSnapshot` | D2-RT-01 | per-slot buttons/edges/axes |
| `Game`, `GameModule`, `GameContext`, `GameHost`, `loadGame` | D3-SDK-01 | lifecycle and context |
| `Renderer2D` | D3-RT-02 | all drawing; no raw canvas in game code |
| `AudioBus` (optional) | D3-RT-05 | coin/jump/goal SFX; additive only |
| `GameEntry`, `getGames()`, `RoundManager`, `RoundPhase` | D7-SDK-01 | registry + phase shell |
| `Vec2`, `CircleBody`, `Aabb`, `integrate`, `resolveCircleCircle`, `resolveCircleAabb` | D7-RT-01 | player and platform collision |
| `Canvas2DRenderer`, `Hud`, `ResultsScreen`, `AssetPack` | D7-RT-01 | presentation and results |

**Rule:** if an export is missing at the Wave 2 contract freeze, fix the runtime to the frozen contract — do not fork a private copy inside the game. A game-local read-only trigger overlap (coin/flag) is allowed; it must not resolve or mutate physics bodies.

---

## 3. Layer coverage

| Layer | Work items |
|---|---|
| Games | `GAME-PF-01` … `GAME-PF-06` |
| SDK | manifest/layout validation through `@lanpad/sdk` |
| Host runtime | consumed only: `GameHost`, `Renderer2D`, physics, `Hud`, `ResultsScreen` |
| Controller | consumed only: D2 control renderers + layout document |
| Tools/CI | size gate, trace checker, recorded-trace replay |
| QA | TV + 1/2/4-phone acceptance run, budgets |

**Goals advanced:** G2 (input-to-physics at fixed tick; E5 baseline recorded per game), G4 (4 of 8 slots exercised; the 8-controller proof remains D4/D7), G5 (multi-touch d-pad + jump; gyro/panels/haptics not used), G8 (folder + manifest + `GameHost` boundary), G1 advanced only (D0 code join; QR timing remains a D4 proof).

---

## 4. Files

```
packages/games/platformer/
  game.manifest.json
  layouts/
    pf-dpad-v1.json
    pf-stick-v1.json
  src/
    index.ts          # GameModule default factory
    config.ts         # tuning values; no magic pixels
    level.ts          # level types + hand-written validator
    level-01.json     # the one level
    world.ts          # pooled coins, platforms, checkpoints, goal
    input.ts          # ControllerState -> PlayerCommand
    player.ts         # movement, jump, grounding, respawn
    rules.ts          # coins, goal, shared score, phase flow
    camera.ts         # follow + clamp + edge indicators
    render.ts         # Renderer2D draw list
    hud.ts            # cached HUD strings + results content
  test/
    manifest.test.ts
    level.test.ts
    player.test.ts
    rules.test.ts
    camera.test.ts
    render.test.ts
    replay.test.ts
  README.md
```

**Slice-only integration files** (owned by the integration stream, not the game logic):

- `packages/dev-server/src/main.ts` — exact-path alias `/games/platformer/` → host SPA; `/games/` keeps its 404 behaviour for missing assets.
- `packages/runtime/src/main.ts` — manifest selector for `/games/platformer/` and `?game=platformer`; mounts the normal `GameHost`.
- `packages/controller/src/dev/devLayoutSource.ts` — same-origin layout fetch for the slice; D5 `setLayout` replaces the source, not the control registry.
- `packages/games/platformer/vite.config.ts` — only if the shared games build from D7-SDK-01 does not yet emit this folder; removed when the shared build covers it.

---

## 5. Work items

### GAME-PF-01 — Package, manifest, layouts and direct play entry

| Field | Value |
|---|---|
| Layer | Games + SDK |
| Spec | §8.1, §10; FR-8.1, FR-8.4, FR-10.3; G5, G8 |
| Depends on | D2-LAYOUT-01, D2-CTRL-02, D3-SDK-01, D7-SDK-01 |
| Unblocks | `GAME-PF-02` … `GAME-PF-06` |
| Deliverables | `packages/games/platformer/game.manifest.json`, `layouts/pf-dpad-v1.json`, `layouts/pf-stick-v1.json`, `src/index.ts` (skeleton), `src/config.ts`, `packages/games/platformer/README.md`; slice-only files listed in §4 |

**Manifest**

```json
{
  "schemaVersion": 1,
  "name": "Coin Run",
  "entry": "index.js",
  "layouts": ["layouts/pf-dpad-v1.json", "layouts/pf-stick-v1.json"],
  "assetBudget": { "initialBytes": 262144, "totalBytes": 1048576 },
  "minPlayers": 1,
  "maxPlayers": 4,
  "needsGyro": false
}
```

- `entry` is the built module in `packages/games/dist/platformer/index.js`; the source is `src/index.ts`.
- The budget is a design target, not a measurement. `GAME-PF-06` records the real bytes.

**Layouts**

- `pf-dpad-v1.json`: landscape; d-pad `move` at bottom-left with bits up/down/left/right = 8/9/10/11 (up/down intentionally unused); jump button `jump` at bottom-right, circle, bit 0, radius ≥ 14% of the short viewport side (≥ 44 px on a 360 px-wide phone).
- `pf-stick-v1.json`: landscape; floating left stick `move` (`axis: "left"`), jump button `jump` bit 0. No second channel binding.
- Both must pass `validateLayout`; no duplicate ids, bits or channels; 44 px minimum targets (AR-5).

**Freeze this interface**

```ts
// packages/games/platformer/src/index.ts
import type { Game, GameManifest, GameModule } from "@lanpad/sdk";

const createGame: GameModule = (manifest: GameManifest): Game => new CoinRunGame(manifest);
export default createGame;
```

The skeleton must implement `init`, `simulate`, `render`, `dispose`; until `GAME-PF-02` it renders "Waiting for players" and never touches sockets. `dispose` is idempotent.

**Slice-only direct route**

- `packages/dev-server/src/main.ts` maps the **exact** path `/games/platformer/` to the host SPA. It must not add SPA fallback under `/games/*`.
- `packages/runtime/src/main.ts` selects the manifest `/games/platformer/game.manifest.json` for that path (or `?game=platformer`) and mounts `GameHost`. This is a selector, not a second host implementation.
- `packages/controller/src/dev/devLayoutSource.ts` fetches `/games/platformer/layouts/pf-dpad-v1.json` (or the stick layout) when the controller URL carries `?layout=pf-dpad-v1`, validates it with `validateLayout`, and calls the same `renderLayout()` entry point that D5 `setLayout` will call. The host prints the controller URL with the layout query in dev. Retire the fetch when D5 lands; keep the render entry.

**Steps**

- [ ] Create the folder, manifest and both layouts.
- [ ] Add manifest fixtures to `test/manifest.test.ts`; assert `validateManifest` accepts the real file and rejects a 5-player manifest and a missing layout.
- [ ] Add layout tests using the shared validator fixtures; assert 44 px sizing data is exposed.
- [ ] Implement the `Game` skeleton and confirm `getGames()` lists `platformer` without editing registry code.
- [ ] Add the exact-path dev-server alias and the runtime manifest selector; verify `/` still works unchanged.
- [ ] Add the controller dev layout source behind `?layout=`; verify a d-pad tap and a jump edge reach the host.
- [ ] Build the game folder to `packages/games/dist/platformer/`; if the shared games build is absent, add the temporary `vite.config.ts` and record it as slice-only.
- [ ] Write `README.md`: how to play directly, layout query, known D0 join limitations.

**Acceptance**

- [ ] `getGames()` returns `platformer` from the manifest alone; no switch statement was added.
- [ ] `/games/platformer/` boots the host, creates a D0 room, accepts a phone join and shows the phone layout.
- [ ] A jump press produces an edge at the host; left/right render from both layouts.
- [ ] The game module has no socket, fetch, broker or controller import.
- [ ] `npm run check` stays green.

**Tests (tagged)**

- `[FR-10.3] the platformer manifest loads from its folder with entry, layouts and budgets`
- `[FR-8.1] button, d-pad and stick render from the platformer layout data`
- `[FR-8.4] platformer layouts pass the shared validator and reject duplicate channels`
- `[AR-5] platformer controls meet the 44 px touch-target minimum`
- `[G8] the platformer is added by folder plus manifest only`
- `[FR-7.17] the platformer module receives only GameContext`

**Anti-rework**

- The direct route selects a manifest; it does not become a second launcher. D7-HUB-01/P6 replace the selector with the hub and keep `GameHost`.
- The layout bridge is a **source adapter** only. The D2 control registry and D5 render path are untouched.
- No game slug appears in the registry, hub, broker or controller.
- The temporary build config is deleted as soon as the shared games build emits the folder.

**Risks**

- The D2 controller has no layout-delivery path before D5; the bridge is the known gap. If the bridge grows beyond fetching + validating, stop and move the work into D5.
- The `/games/platformer/` alias can mask a missing game bundle; restrict it to that exact path and keep `/games/*` asset 404s.
- A manifest budget that is too small fails the load; measure before tightening it.

---

### GAME-PF-02 — Level data, world geometry and pooled entities

| Field | Value |
|---|---|
| Layer | Games |
| Spec | §6.2, §9.5; FR-7.17, FR-10.3; PR-9.3, PR-9.4; C9 |
| Depends on | `GAME-PF-01`; D7-RT-01 `Vec2`/`Aabb` |
| Unblocks | `GAME-PF-03`, `GAME-PF-05` |
| Deliverables | `src/level.ts`, `src/level-01.json`, `src/world.ts`, `test/level.test.ts` |

**Level shape (y-down, world units)**

```json
{
  "version": 1,
  "width": 120,
  "height": 18,
  "killY": 21,
  "spawns": [{ "x": 2, "y": 15.6 }, { "x": 4, "y": 15.6 }, { "x": 6, "y": 15.6 }, { "x": 8, "y": 15.6 }],
  "platforms": [{ "x": 0, "y": 16, "w": 30, "h": 2 }],
  "checkpoints": [{ "x": 34, "y": 14 }, { "x": 78, "y": 14 }],
  "coins": [{ "x": 10, "y": 13 }],
  "goal": { "x": 116, "y": 11, "w": 2, "h": 5 }
}
```

- `platforms` includes ground segments, floating platforms and level borders. Ground gaps are simply absent segments; the kill plane catches falls.
- One level only: 120 units wide, 18 high, 3 pits, 5 floating platforms, 2 checkpoints, 20 coins, 1 goal. All values live in JSON.
- The level validator is hand-written (zero dependencies): finite numbers, positive sizes, 1–4 spawns, 1–200 coins, 1–80 platforms, 0–4 checkpoints, goal inside bounds, coin/checkpoint/spawn centres not inside a platform, `killY > height`.
- `World` preallocates four player slots and the full coin array at `init`; `reset()` restores `active`/`collected` flags without constructing objects (PR-9.4).
- Platform queries use an x-sorted array and a small index window per player; no `map`/`filter` in `simulate` (PR-9.5).
- **Spawning:** four fixed spawns, no random spawns, no initial overlap with platforms. No player–player collision in Minimal, so spawn spacing is visual only.
- **Reset:** coins, checkpoints, goal state and player positions return to level start; no allocations.

**Steps**

- [ ] Define `LevelData`, `PlatformAabb`, `Coin`, `Checkpoint`, `Goal` types and the validator.
- [ ] Author `level-01.json`; verify all five floating platforms are jump-reachable with the configured jump height (manual and a test helper that checks vertical gaps).
- [ ] Implement `World` with preallocated arrays, `reset()` and a platform query window.
- [ ] Implement checkpoint activation and the kill-plane predicate.
- [ ] Add tests for invalid levels, spawn safety, coin count, reset idempotence and zero allocations after setup.

**Acceptance**

- [ ] The level validates at load; an invalid level fails with a readable path and field.
- [ ] Four spawns are on ground and not inside any platform.
- [ ] 20 coins, 2 checkpoints and 1 goal load from JSON; `reset()` restores all of them.
- [ ] A second `reset()` allocates no new coin/platform/player objects.
- [ ] All platform gaps are clearable with jump height from `config.ts`.

**Tests (tagged)**

- `[FR-10.3] the level loads from JSON and is validated at startup`
- `[C9] the world exposes AABBs for every platform`
- `[PR-9.3] world update and reset allocate nothing after setup`
- `[PR-9.4] coin and player entities are pooled and reused on rematch`
- `[PR-9.5] platform lookup uses a precomputed index, not map/filter`

**Anti-rework**

- New levels are new JSON files, never new `if (level === ...)` branches.
- The world uses the runtime `Aabb`/`Vec2` types; no duplicate vector math.
- Coins are triggers, not physics bodies; do not add coin impulses to runtime physics.

**Risks**

- Circle-vs-AABB corner snag on platform edges; use a 0.01 skin and resolve the smaller penetration axis in `GAME-PF-03`.
- A level that is too wide makes 4 players unreadable; keep the one level compact and test at 4 players.
- JSON schema drift; one validator and one fixture set.

---

### GAME-PF-03 — Player movement, input mapping and respawn

| Field | Value |
|---|---|
| Layer | Games |
| Spec | §7.3, §9.1; FR-7.3, FR-7.4, FR-7.11, FR-7.12, FR-8.10; G2, G5; C9 |
| Depends on | `GAME-PF-02`; D2-RT-01, D3-RT-01, D3-RT-04 |
| Unblocks | `GAME-PF-04`, `GAME-PF-05` |
| Deliverables | `src/input.ts`, `src/player.ts`, `test/player.test.ts` |

**Input mapping (per slot, fixed update)**

```ts
export interface PlayerCommand {
  moveX: -1 | 0 | 1;
  jumpPressed: boolean;
}

export function readCommand(state: ControllerState, out: PlayerCommand): void;
```

- Left/right: `buttons & (1 << 10)` for DLeft, `buttons & (1 << 11)` for DRight; if neither, use `lx` with threshold `±0.25` (controller deadzone already applied).
- Jump: `edges & (1 << 0)` only. A held button does not re-jump. The edge is consumed once because `InputReader` drains it once per tick (FR-7.12).
- The function writes into a preallocated `PlayerCommand`; no per-slot allocation.
- No gyro, no triggers, no panels. The game is fully playable when only buttons/d-pad exist (FR-8.10).

**Player physics**

- One `CircleBody` per slot, radius `0.4`, mass `1`, restitution `0`, friction `0`, pooled for 4 slots.
- Initial tuning values in `config.ts` (design targets, not measurements): `moveSpeed 9.0`, `accel 60`, `gravity 55`, `jumpVelocity 18`, `maxFall 30`, `coyoteMs 80`, `jumpBufferMs 100`, `respawnMs 750`, `invulnMs 1000`, `skin 0.01`.
- Horizontal: target velocity from `moveX`, clamped acceleration; vertical: gravity, terminal velocity.
- Collision: for each nearby platform, call `resolveCircleAabb`; classify the contact from the pre-resolution overlap. Grounded when the contact normal is upward and `vy >= 0`; snap y to the platform top and zero `vy`.
- Jump: consume the buffer when grounded or within coyote time; apply `jumpVelocity`; clear coyote and buffer.
- Jump height is ~3 world units (v²/2g with the values above), enough for the level's 3-unit gaps; `GAME-PF-02` verifies reachability.
- Fall: when `y - radius > killY`, set `falling` and a respawn timer; after `respawnMs`, place the player at the last checkpoint (or spawn), zero velocity, give `invulnMs` during which the platform collision still applies.
- Determinism: same initial state + same fixed `dt` + same command sequence ⇒ same positions. Use only the loop's fixed `dt`; never a wall-clock delta.
- No player–player collision in Minimal; players pass through each other.

**Steps**

- [ ] Implement `readCommand` with d-pad priority and stick fallback; test both layouts.
- [ ] Implement gravity, horizontal acceleration, jump, coyote and buffer in `player.ts`.
- [ ] Implement platform collision with contact classification and the skin.
- [ ] Implement death-plane detection, respawn timer and checkpoint selection.
- [ ] Add tests: one jump per edge, held button no re-jump, sub-tick edge across two packets, coyote window, jump buffer, landing on a platform, corner snag, respawn at the correct checkpoint, deterministic replay.

**Acceptance**

- [ ] A single edge produces exactly one jump, even when two packets arrive in one tick.
- [ ] Holding jump does not repeat jumps.
- [ ] The player lands and remains grounded without jitter or sinking.
- [ ] A fall respawns at the last checkpoint and keeps the team score.
- [ ] The same fixed input sequence produces the same final position on every run.
- [ ] No allocation occurs in `simulate` after `init`.

**Tests (tagged)**

- `[FR-7.2] only d-pad bits 10/11 and jump bit 0 drive the player`
- `[FR-7.3] a sub-tick jump edge is recovered and consumed exactly once`
- `[FR-7.12] accumulated edges produce one jump per press`
- `[FR-7.4] stick input maps to left/right without jitter at the threshold`
- `[FR-7.11] the player uses only the latest level state per tick`
- `[FR-8.10] the game is fully playable with d-pad and one button`
- `[G2] a jump edge changes the player state on the next fixed tick`
- `[C9] circle–AABB platform collision marks grounded and resolves penetration`
- `[PR-9.3] player and input update allocate nothing per tick`

**Anti-rework**

- Physics primitives stay in runtime; the game supplies body parameters, contact classification and rules only.
- Commands are a per-slot pooled array; do not create objects in the input path.
- The jump feel lives in `config.ts`, not in hard-coded branches.

**Risks**

- Circle corners can snag; resolve the smaller penetration axis and test at platform seams.
- Coyote/buffer values can mask a real collision bug; disable them in the collision tests.
- Float drift across platforms; tests compare with an epsilon, the game uses fixed `dt` only.
- A held button from a stuck touch must not auto-jump; edges only.

---

### GAME-PF-04 — Coins, goal, shared score, round flow and rematch

| Field | Value |
|---|---|
| Layer | Games |
| Spec | §7.5, §9.6; FR-7.17, FR-9.1; G4, G5, G8; AR-4 |
| Depends on | `GAME-PF-03`; D7-SDK-01 `RoundManager`, D7-RT-01 `ResultsScreen` |
| Unblocks | `GAME-PF-05`, `GAME-PF-06` |
| Deliverables | `src/rules.ts`, `test/rules.test.ts` |

**Rules**

- **Coins:** circle-vs-circle overlap against the preallocated coin array. On overlap, mark the coin collected, increment the shared team score and the collector's count. A coin never reactivates until rematch.
- **Checkpoints:** circle-vs-AABB overlap; store the checkpoint index per slot. A checkpoint stays active for the rest of the level.
- **Goal:** circle-vs-AABB overlap with the goal. The first player to touch it sets `phase = "results"` for everyone and freezes simulation. No individual winner in Minimal; the shared score is the result.
- **Shared score:** one team pool; per-slot contributions are display data only. This is a co-op slice by design.
- **Fall:** handled by `GAME-PF-03`; no score penalty and no elimination.
- **Phase flow:** `lobby → countdown(3 s) → playing → results`. Use `RoundManager` for phase bookkeeping and `reset()`; the game owns the level and score reset.
- **Start condition:** at least 1 connected controller; the host confirms on the start screen. The slice has no lobby roster beyond the D0 room slots.
- **Results:** team coins / total coins, elapsed time, per-slot coin counts, "Rematch" and "Back to start". `ResultsScreen` provides the remote-operable shell; the game supplies strings and the callbacks (AR-4).
- **Rematch:** `World.reset()` + player reset + score reset + `RoundManager.reset()`; no page reload, no new entities (PR-9.4).
- **Host refresh:** state is lost in the slice; the start screen must say so. D4 session work is not attempted here.
- **Phone reload:** joins as a new slot. The game receives no slot-list event in the slice, so the old body may remain idle for the session; cap active bodies at four and document the gap. D4 supplies slot lifecycle at the host, not in game rules.

**Steps**

- [ ] Implement coin pickup, checkpoint activation and goal detection as read-only trigger predicates.
- [ ] Implement the shared score and per-slot contribution arrays; reset on rematch.
- [ ] Wire `RoundManager` phases and the 3 s countdown; start at ≥ 1 controller.
- [ ] Build the results content and rematch/back callbacks with `ResultsScreen`.
- [ ] Add fake-clock tests for countdown → playing → results → rematch.
- [ ] Add tests for one coin counted once even with two overlapping players on the same tick.
- [ ] Document the D0 reconnect gap in the game README and on the start screen.

**Acceptance**

- [ ] Two players collecting the same coin in one tick increment the score by exactly one.
- [ ] A coin cannot be collected twice; rematch restores all 20.
- [ ] The first goal touch ends the level for all players and shows one results screen.
- [ ] Rematch resets coins, checkpoints, positions, score and time with no new allocations.
- [ ] Results and rematch are operable with arrow keys and Enter.
- [ ] The game never reads a socket or event to run a rule.

**Tests (tagged)**

- `[G4] four players contribute to one shared score without losing a pickup`
- `[G5] per-slot state stays independent across all four players`
- `[G8] round phases use the SDK RoundManager, not a hub-specific flow`
- `[FR-9.1] phase transitions run on the fixed simulation tick`
- `[FR-7.17] rules read InputSnapshot and GameContext only`
- `[AR-4] results and rematch are fully remote-operable`
- `[PR-9.4] rematch reuses pooled coins, players and level data`

**Anti-rework**

- Scoring and win rules stay in the game; `ResultsScreen` and the hub never learn game rules.
- The shared score model is additive: later individual modes add fields, not a rewrite.
- D4 slot/lifecycle handling stays in the host; the game consumes slots and never sessions.
- No level-specific branches in `rules.ts`; data drives the counts.

**Risks**

- Shared score can feel uncompetitive; this is a deliberate co-op first slice.
- Results may appear before the last coin animation; freeze input and resolve the frame deterministically.
- Two players touching the goal in the same tick: first slot index wins; document the rule.
- D0 reload creates duplicate bodies; cap at four and document. Do not invent a session system in the game.

---

### GAME-PF-05 — Camera, 2D presentation and cached HUD

| Field | Value |
|---|---|
| Layer | Games |
| Spec | §9.2, §9.3, §9.5; FR-9.4, PR-9.1, PR-9.3, PR-9.5, PR-9.8; G5 |
| Depends on | `GAME-PF-02`, `GAME-PF-03`, `GAME-PF-04`; D7-RT-01 `Renderer2D`/`Hud` |
| Unblocks | `GAME-PF-06` |
| Deliverables | `src/camera.ts`, `src/render.ts`, `src/hud.ts`, `test/camera.test.ts`, `test/render.test.ts` |

**Camera**

- Fixed vertical view of 18 world units; no vertical scroll. Horizontal view width follows the 16:9 host surface.
- Target is the mean x of active players, clamped to `[viewWidth/2, levelWidth - viewWidth/2]`.
- Deadzone `2.0` units and exponential smoothing (`12` per second) to avoid jitter; the camera never adds an input delay.
- Off-screen players get a slot-labelled edge arrow at the screen border.
- On resize, recompute the view width and clamp; no fixed pixel constants.

**Presentation**

- Draw order: background bands (two solid parallax layers, no assets), platforms, checkpoints, coins, goal flag, players, slot labels, HUD.
- All drawing goes through `Renderer2D` (`clear`, `rect`, `circle`, `polyline`, `text`; `sprite` only if D7-RT-01 finalizes it); no raw canvas/WebGL in game code.
- Procedural visuals only: platforms as filled rects, coins as circles with a scale pulse, players as circles with a pattern and slot label, goal as a flag made of rects.
- Cull platforms and coins outside the camera view before drawing; precompute the draw list once per frame.
- Draw-call target ≤ 120 per frame (PR-9.1). One full level should stay well below it; the test records the real count.
- HUD: `COINS n/20`, `TIME mm:ss`, and a slot label for each player. Text is rendered to a cached offscreen canvas and invalidated only when a value changes (PR-9.8).
- No per-frame `map`/`filter` and no per-frame allocation in `render` (PR-9.3/9.5).
- Audio is optional: jump/coin/goal SFX through `AudioBus`; the game must be fully playable muted. Audio never gates state.
- Players are distinguishable by label and pattern, not colour alone (G5).
- TV profile: DPR 1 and CSS upscale are the runtime's job; the game renders in world units and never reads `devicePixelRatio`.

**Steps**

- [ ] Implement `camera.ts` with clamp, deadzone, smoothing and edge indicators.
- [ ] Implement `render.ts` with the fixed draw order, culling and a draw-call count exposed to debug.
- [ ] Implement `hud.ts` with cached strings and invalidation on change.
- [ ] Hook optional SFX behind `AudioBus.unlocked`; ensure no audio call before unlock.
- [ ] Add camera tests: clamp at both ends, deadzone, four-player midpoint, resize.
- [ ] Add a fake-`Renderer2D` render test that counts calls for a full frame.
- [ ] Add a visual 1/2/4-player check on the TV at couch distance; labels readable.

**Acceptance**

- [ ] Camera never shows outside the level; no jitter while walking.
- [ ] A full frame stays at or below 120 draw calls and allocates nothing per frame.
- [ ] HUD text is redrawn only when coins/time/labels change.
- [ ] Four players remain identifiable at TV distance without colour alone.
- [ ] Off-screen players have a visible edge indicator.
- [ ] Audio can be muted/unlocked without affecting the simulation.

**Tests (tagged)**

- `[PR-9.1] one full platformer frame stays under 120 draw calls`
- `[PR-9.3] the render path allocates nothing per frame`
- `[PR-9.5] culling and draw-list building use no map/filter`
- `[PR-9.8] HUD text is cached and invalidated only on change`
- `[FR-9.4] the game renders in world units and respects the TV profile`
- `[G5] four players are distinguishable by label and pattern, not colour alone`

**Anti-rework**

- The game never touches a canvas directly; `Renderer2D` is the only drawing surface.
- HUD/results layout lives in runtime; the game provides content strings.
- Camera bounds come from level data; no per-level camera code.
- Procedural art is replaceable by an `AssetPack` later without changing game rules.

**Risks**

- Canvas2D fill rate on weak TVs; keep shapes small, no shadows/blur, and test E3's target device.
- A camera that follows the mean can cut off a trailing player; edge arrows and a deadzone mitigate it.
- Cached HUD invalidation bugs can show stale coins; test each value transition.
- Font metrics differ by TV; use the runtime's cached-text path, not game-side measuring.

---

### GAME-PF-06 — Integration, replay test, budgets and acceptance run

| Field | Value |
|---|---|
| Layer | Games + QA |
| Spec | §11, §16; FR-9.6, PR-11.1, NR-6.1; G1, G2, G4, G5, G8 |
| Depends on | `GAME-PF-01` … `GAME-PF-05`; D0-TOOL-02 size gate, D0-QA-01 trace checker, D3-TOOL-01 latency harness |
| Unblocks | Slice sign-off |
| Deliverables | `test/replay.test.ts`, `README.md`, `docs/RESULTS.md` Coin Run rows |

**Replay test**

- Record one 60 s, 2-player trace at 60 Hz: left/right, jump, a sub-tick tap, a fall, a checkpoint, a coin overlap and the goal.
- Replay through `Game.simulate` with a fake `GameContext`; assert deterministic final state: coin count, player positions (epsilon), checkpoint indices, phase and elapsed ticks.
- Re-run the same trace twice in one process; assert identical results and no new entity allocations.

**Acceptance run (real devices)**

| Run | Players | Layout | What to prove |
|---|---|---|---|
| A | 1 | d-pad | Move, jump, coins, fall/respawn, goal, results |
| B | 2 | d-pad + stick | Shared score, simultaneous pickups, camera, rematch |
| C | 4 | mixed | All bodies independent, labels readable, no stuck slot |

- TV host + Android phones in Chrome. Record device, OS/browser version and exact numbers in `docs/RESULTS.md`.
- Record: initial and total gzip bytes, max draw calls, frame time p50/p95, input-to-canvas p95 (E5 harness if available), join-to-first-input time (D0 flow; QR is deferred), 10-minute memory sample.
- 10-minute continuous run: no crash, no stuck player, no unbounded memory growth; state the observed growth.
- Rematch twice in one session; verify no duplicate entities or listeners.

**Steps**

- [ ] Capture the trace and add the replay test.
- [ ] Run A, B and C; record every number with device/browser/version.
- [ ] Run the 10-minute session and record memory samples.
- [ ] Verify the size gate reports the game under the manifest budget.
- [ ] Verify the trace checker covers every ID this game claims.
- [ ] Write the README known-limitations section: D0 join, no sessions/QR, reload = new slot, host refresh loses state, no hub.
- [ ] Update this plan's checkboxes and `docs/RESULTS.md`; do not change any requirement ID.
- [ ] Confirm the four D7 proof-game files and plans were not modified by this work.

**Acceptance**

- [ ] 1, 2 and 4 players complete the level; all rules work.
- [ ] Replay is deterministic and allocation-free after setup.
- [ ] Every recorded budget is under its target, or the gap is written down with a fix.
- [ ] 10-minute run has no leak, crash or stuck slot.
- [ ] No socket/protocol import exists anywhere under `packages/games/platformer/`.
- [ ] The direct route works after a clean build and restart.
- [ ] `npm run check` is green.

**Tests (tagged)**

- `[G1] join-to-first-input time is recorded on the D0 join flow (QR remains a D4 proof)`
- `[G2] input-to-canvas p95 is recorded during a real game run`
- `[G4] four controllers play the same level simultaneously`
- `[G5] d-pad and jump work multi-touch on one phone`
- `[G8] the game runs through manifest → GameHost with no platform switch`
- `[FR-9.6] the initial platformer payload is under the manifest and platform budgets`
- `[NR-6.1] host JS including the game stays under the 5 MB gzip cap`
- `[PR-11.1] the latency harness records the accepted platformer run`

**Anti-rework**

- The acceptance harness and trace format are reused by D7 and the P6 hub.
- The direct route stays a manifest selector; D4/D5 add transport and UI, never game rules.
- Results rows are append-only; never edit a past measurement.

**Risks**

- E5 measurement conditions differ per TV; record Game Mode and refresh rate with the number.
- A 10-minute sample is not a soak; E17 remains the D7 4-hour gate.
- Four players on one camera can still be crowded; if unreadable, shorten the level before adding features.
- The slice's D0 join path is not G1-complete; do not claim QR performance.

---

## 6. Requirement coverage

| ID | Where exercised | Evidence |
|---|---|---|
| FR-7.2 | `GAME-PF-03` | d-pad bits 10/11, jump bit 0 tests |
| FR-7.3 | `GAME-PF-03` | sub-tick jump edge test |
| FR-7.4 | `GAME-PF-03` | stick threshold test |
| FR-7.11/7.12 | `GAME-PF-03` | latest-state and one-jump-per-edge tests |
| FR-7.17 | `GAME-PF-01..06` | no-socket import test + context-only rules |
| FR-8.1 | `GAME-PF-01` | both layouts render from data |
| FR-8.2 | D5 (deferred) | hot-swap not used by the slice |
| FR-8.4 | `GAME-PF-01` | layouts pass the validator |
| FR-8.10 | `GAME-PF-03` | d-pad/button-only play |
| FR-9.1 | `GAME-PF-04` | fixed-tick phase transitions |
| FR-9.4 | `GAME-PF-05` | world-unit rendering, TV profile |
| FR-9.6 | `GAME-PF-06` | initial payload measured |
| FR-10.3 | `GAME-PF-01` | manifest + registry entry |
| NR-6.1 | `GAME-PF-06` | gzip size recorded |
| PR-9.1 | `GAME-PF-05` | draw-call count |
| PR-9.3/9.4/9.5 | `GAME-PF-02/03/04/05` | allocation/pooling/no-map tests |
| PR-9.8 | `GAME-PF-05` | cached HUD test |
| PR-11.1 | `GAME-PF-06` | trace replay through the harness |
| AR-4 | `GAME-PF-04` | results/rematch keyboard test |
| AR-5 | `GAME-PF-01` | 44 px layout sizing |
| G1 | `GAME-PF-06` | join time recorded on D0 flow; QR deferred |
| G2 | `GAME-PF-03/06` | fixed-tick response + E5 measurement |
| G4 | `GAME-PF-04/06` | four players in one level |
| G5 | `GAME-PF-01/05` | multi-touch layouts + four-player readability |
| G8 | `GAME-PF-01/04/06` | folder + manifest + `GameHost` path |

---

## 7. Anti-rework rules (game-wide)

1. **No sockets, protocol, broker or controller imports.** The game sees `GameContext` only (FR-7.17).
2. **No raw canvas/DOM.** Every pixel goes through `Renderer2D`; every result string through `Hud`/`ResultsScreen`.
3. **Manifest is the boundary.** Adding the game is a folder + manifest; no registry or hub switch.
4. **Layouts are data.** The phone UI is `pf-dpad-v1`/`pf-stick-v1`; no game-specific controller code.
5. **Levels are data.** New levels are JSON; no level branches in code.
6. **Pool everything.** Coins, players and draw lists are allocated once; rematch resets flags, not objects.
7. **Physics stays in runtime.** The game supplies body parameters, contact classification and rules; it must not grow a second collision engine.
8. **Slice bridges are temporary.** The route alias, manifest selector and controller layout source are thin adapters. D5's `setLayout` and D7-HUB-01 replace the sources, not the game.
9. **No new runtime dependencies.** No physics, ECS, tween, audio or asset library.
10. **No scope creep.** Enemies, power-ups, assets, hub, sessions and gyro stay in later waves.

---

## 8. Full version (post-slice backlog)

- [ ] 3–5 levels with a level-select screen and per-level coin totals.
- [ ] Moving platforms, one-way platforms, springs, hazards.
- [ ] Enemies with stomp/bounce rules and pooled projectiles.
- [ ] Individual and team scoring modes; time attack; best-run ghost.
- [ ] Sprite atlas + `AssetPack` art, parallax backgrounds, music and SFX.
- [ ] 5–8 players with a split-follow camera or a shared-arena camera.
- [ ] D4 sessions: reconnect into the same slot, suspend/resume, QR timing proof (G1).
- [ ] D5 hot-swap layouts, private panels (personal coin counts), event channel.
- [ ] D6 haptics on coin/jump (optional, never required), gyro never required.
- [ ] Hub integration, thumbnails, settings and accessibility toggles (P6).

---

## 9. Risks / watch-outs

- **No layout delivery before D5.** The slice bridge is the known gap; keep it to fetch + validate and retire it at D5.
- **D0 join has no sessions/QR.** Reloads become new slots; state this on the start screen and in `docs/RESULTS.md`. Do not build a second session system in the game.
- **Circle collider corner snag.** Use a 0.01 skin and smaller-axis resolution; test platform seams.
- **4-player readability.** One compact level, labels + patterns, edge arrows, and a mean-follow camera with a deadzone.
- **Jump feel.** Tune from `config.ts`; coyote/buffer can hide collision bugs, so test collisions with them disabled.
- **Canvas2D fill rate on TVs.** Small shapes, no shadows/blur, cull aggressively, and record frame p95 on the real TV.
- **Determinism.** Fixed `dt` only; no `performance.now()` in simulation; replay with an epsilon.
- **Score semantics.** Shared score is deliberate for the slice; do not add individual win rules halfway.
- **D7 contracts are planned, not implemented.** If D7-RT-01 changes, update this file in the same commit; never fork the contract.
- **Do not let the platformer delay D7.** The four proof games and E17 remain on the Dev Exit Gate path.

---

## 10. Minimal checklist

- [ ] `GAME-PF-01` … `GAME-PF-06` complete.
- [ ] One level playable with 1, 2 and 4 players on the TV + phones.
- [ ] D-pad and stick layouts both render; jump works multi-touch.
- [ ] Gravity, ground/platform collision, coins, goal flag, fall respawn, shared score, results and rematch work.
- [ ] Direct `/games/platformer/` route uses the D0 room flow; the hub is not required.
- [ ] No game code imports sockets, protocol, broker or controller internals.
- [ ] Replay test is deterministic; no per-frame allocations in simulate/render.
- [ ] Size, draw-call, frame-time and input-to-canvas numbers are recorded in `docs/RESULTS.md` with device/browser/version.
- [ ] The four D7 proof games and their plans are unchanged; the platformer is additional scope.
- [ ] No new runtime dependency; `npm run check` is green.
