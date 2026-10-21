# P6 — Remaining Games and Full Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Steps use checkbox syntax.
>
> **Goal:** Ship the remaining 10 games in gated waves and complete the hub: phone-side pick/vote, catalog, recent games, per-game settings, content packs, and accessibility toggles. Open-World streaming is included only if the measured renderer/device envelope justifies it.
>
> **Architecture:** Games are manifest-driven modules on the frozen P4 SDK; no platform code changes per game. The hub is a host-side catalog + lobby plus a controller-side picker/vote using `choice` layouts. Content (word packs, quizzes, charts, maps) is data with licenses recorded.
>
> **Tech stack:** Frozen SDK/runtime, Canvas2D/Three (per E12), JSON packs, manifest extensions for per-game settings (versioned).
>
> **Spec:** `SPEC.md` §17, §14 P6, §19; FR-8.1, FR-9.8–9.13, G8; C1–C10.
>
> **Program position:** Phase 2, last stage; blocked by P5-GATE-01 GO. Waves are ordered by risk and dependency.

## Global constraints

- No game-specific server, controller, broker, or runtime changes; if a game needs one, it returns to the owning stage and is re-gated.
- Each game meets its own Minimal checklist before Full features; Full is post-v1 unless listed as P6 scope.
- Per-game manifest budget enforced by CI; host initial download stays ≤ 5 MB.
- Every game has a non-gyro fallback and no haptics requirement.
- Content is CC0/self-made; licenses recorded; no copyrighted music.
- iOS remains out of scope (A5).
- The hub must be remote-operable and usable with 8 players.

---

## Stage goal and exit criteria

**Exit criteria (§14 P6):**

> Remaining games and the hub (picker, catalog).

Concretely:

- [ ] Hub Minimal: TV menu with remote navigation, P1 phone picks a game, lobby shows players.
- [ ] Hub Full: phone voting, per-game settings, catalog thumbnails, recent games, family-filter toggle, accessibility toggles.
- [ ] Wave 1–3 games reach their Minimal checklists; Wave 4 is attempted only if E3/E12 justify it.
- [ ] Each game passes its own acceptance and per-game budget.
- [ ] Streaming/LOD meets FR-9.8–9.10 for Open-World, or that game is explicitly deferred with a written decision.
- [ ] Content packs are data-driven and licensed.

**Layer coverage**

| Layer | Work items |
|---|---|
| Hub | P6-HUB-01, P6-HUB-02 |
| Runtime | P6-RT-01 (gated) |
| Games | GAME-SIR, GAME-BQ, GAME-TA, GAME-SR, GAME-SWR, GAME-SSD, GAME-BD, GAME-BT, GAME-HP, GAME-OWS |
| QA | P6-QA-01 |
| Docs | P6-DOCS-01 |

**Goals advanced:** G5 (full capability range), G8 (catalog on the SDK), G3 (streaming/budgets), G4 (8-player party games).

---

## Work items

### P6-HUB-01 — Hub Minimal: TV menu, P1 phone pick, lobby

| Field | Value |
|---|---|
| Layer | Hub |
| Spec | §17.5 (Minimal), §9.6; FR-9.13, FR-9.12; AR-4 |
| Depends on | P5-GATE-01, D7-HUB-01 |
| Unblocks | P6-HUB-02, wave games |
| Deliverables | `packages/runtime/src/hub/Hub.ts`, `src/hub/GamePicker.ts`, `packages/controller/src/controls` (choice reuse), tests |

**Behavior**

- TV menu lists `getGames()` with name, players, gyro badge; remote arrows/Enter navigate and launch (AR-4).
- P1 phone can pick: host sends a `choice` layout listing games to slot 1; the pick is an event; host highlights and launches.
- Lobby shows joined players/slots and the QR/code/PIN.
- Host can override with the remote (P1 is a convenience, not a requirement).
- Returning from a game disposes it and returns to the hub.
- No voting yet (P6-HUB-02).
- Pick events are rate-limited by the existing event channel.

**Steps**

- [ ] Implement the hub state machine: lobby → picker → launching → game → lobby.
- [ ] Send the picker layout to slot 1 only; handle `choice` events.
- [ ] Show picks on the TV and allow remote override.
- [ ] Reuse `GameHost` launch/dispose; verify no leaks.
- [ ] Add tests for picker layout, event handling, and remote navigation.
- [ ] Play with 2 and 8 players; record.

**Acceptance**

- [ ] P1 can pick a game from the phone; the TV launches it.
- [ ] The remote can also pick/launch.
- [ ] Lobby shows all players and the QR.
- [ ] Returning to the hub works repeatedly.
- [ ] No game-specific hub code.

**Tests (tagged)**

- `[FR-9.13]` P1 phone picks a game
- `[AR-4]` hub is remote-operable
- `[FR-8.1]` picker uses the choice control
- `[G8]` hub reads the game registry only

**Anti-rework**

- Hub Minimal is the only menu; P6-HUB-02 extends it, no second shell.
- Pick/vote share the event/layout path; no new protocol messages.

**Risks**

- P1 may disconnect during picking; allow a remote fallback or re-prompt.
- A phone picker with 10+ games needs scrolling; test on a small screen.

---

### P6-HUB-02 — Hub Full: voting, settings, catalog, recents, filters

| Field | Value |
|---|---|
| Layer | Hub |
| Spec | §17.5 (Full), §9.13; FR-9.13; SR-13; AR-3 |
| Depends on | P6-HUB-01 |
| Unblocks | catalog launch |
| Deliverables | `src/hub/Vote.ts`, `Catalog.ts`, `GameSettings.ts`, manifest extension schema, tests |

**Behavior**

- Phone voting: all players get a `choice` layout with game options; host tallies, shows live votes, launches the winner (tie → host or seeded random).
- Catalog: thumbnails (small WebP/PNG, budgeted), descriptions, player counts, gyro badge, recent games, categories.
- Per-game settings: optional manifest `settings` (versioned) → host renders a small form/phone choice; values passed to the game via context (`settings`), validated by the game.
- Recent games persisted on the host only (localStorage), no accounts.
- Family-friendly toggle and accessibility toggles (haptics, reduced motion) in the hub; persisted locally.
- Profanity filter toggle wires to P3-SEC-04.
- All catalog images licensed and size-budgeted.

**Steps**

- [ ] Add the versioned manifest `settings` extension (additive, schemaVersion 1).
- [ ] Implement voting with live tally and tie rule.
- [ ] Implement the catalog with thumbnails and recents.
- [ ] Implement per-game settings rendering and validation.
- [ ] Add family/accessibility toggles and persistence.
- [ ] Add tests for tally/tie, settings validation, recents.
- [ ] Test with 8 phones and 10+ games.

**Acceptance**

- [ ] Voting works for 2–8 players; ties resolve by the documented rule.
- [ ] Catalog loads within budget and looks right on a TV.
- [ ] Settings are per game and validated; invalid values fall back to defaults.
- [ ] Toggles persist and affect behavior.
- [ ] No PII/analytics.

**Tests (tagged)**

- `[FR-9.13]` phone voting and catalog work
- `[SR-13]` family filter toggle affects UGC
- `[AR-3]` accessibility toggles persist
- `[G3]` catalog thumbnails fit the budget
- `[G8]` settings are manifest-driven

**Anti-rework**

- Settings extend the manifest, not a bespoke per-game host UI.
- Catalog reads registry metadata; no hard-coded list.

**Risks**

- Thumbnails can blow the bundle; lazy-load and budget them.
- Voting adds latency; keep it event-based and rate-limited.

---

### P6-RT-01 — World streaming and LOD (gated by E3/E12)

| Field | Value |
|---|---|
| Layer | Runtime |
| Spec | §9.4; FR-9.8–9.10; C10; §17.4 Open-World |
| Depends on | P5-GATE-01, D3-RT-02, E3/E12 results |
| Unblocks | GAME-OWS |
| Deliverables | `packages/runtime/src/streaming/ChunkManager.ts`, `Lod.ts`, `worker/decoder.ts`, tests |

**Gate**

Do not start unless:
- E3 shows ≥ 30 fps at 720p with the target instance counts, and
- E12's renderer choice can handle the scene within the memory budget.

If not, record a written deferral of Open-World and ship the other games.

**Behavior**

- Chunked terrain/objects with configurable load/unload radius.
- At least 3 LOD tiers; swap by distance; no per-frame GPU buffer allocation.
- Decode/parse in a Web Worker where possible; main-thread work per chunk ≤ 8 ms.
- Pooled chunk objects; deterministic unload.
- Budget checks against E2 memory and PR-9.2 texture memory.
- Debug overlay: loaded chunks, LOD counts, worker queue, main-thread chunk time.

**Steps**

- [ ] Implement `ChunkManager` with a fake loader and tests for load/unload radius.
- [ ] Implement LOD tiers and distance swap with pooled buffers.
- [ ] Move decode to a worker; measure main-thread time.
- [ ] Add budget instrumentation and a stress scene.
- [ ] Measure on the TV; compare to E3/E12.
- [ ] If it cannot hold 30 fps at the target scene, stop and document.

**Acceptance**

- [ ] Loaded chunk count stays within the configured radius.
- [ ] 3 LOD tiers swap without per-frame allocation.
- [ ] Chunk work ≤ 8 ms main thread; worker used where possible.
- [ ] Scene meets the frame budget on the TV or is deferred.

**Tests (tagged)**

- `[FR-9.8]` load/unload radius works
- `[FR-9.9]` three LOD tiers, no per-frame GPU allocation
- `[FR-9.10]` main-thread chunk work ≤ 8 ms
- `[PR-9.2]` texture memory within E2 budget
- `[C10]` 3D streaming is proven before Open-World

**Anti-rework**

- Streaming lives in runtime, not the game; other 3D games can use it.
- If deferred, the interface can remain unbuilt without blocking 2D games.

**Risks**

- Streaming is the highest-complexity runtime feature in the plan; the gate exists to avoid sinking P6 into it.

---

### P6-QA-01 — Catalog waves, per-game acceptance and budgets

| Field | Value |
|---|---|
| Layer | QA |
| Spec | §17.6 order, §14 P6, §16 |
| Depends on | P6-HUB-01/02, wave games |
| Unblocks | Public catalog |
| Deliverables | per-game acceptance logs, catalog budget table |

**Waves**

1. **Cheap content:** Spy in the Room, Bluff Quiz — D5 capabilities only; no new platform features.
2. **Action 2D:** Tank Arena, Snake Royale, Steering Wheel Racer — physics/input reuse; no new runtime.
3. **Ambitious:** Sword Swing Duel (only if D6 swing feasibility positive), Bomb Defusal (per-slot layouts), Beat Tap (audio calibration from E11).
4. **Gated:** Heist Planner (host→phone state feed rate-limited), Open-World Showcase (only if P6-RT-01 passes).

**Per-game acceptance**

- [ ] Game file Minimal checklist complete.
- [ ] 2-player and max-player runs.
- [ ] Reconnect mid-game; slot preserved; game-defined continuation.
- [ ] Gyro/haptics toggles off remains playable.
- [ ] Size/frame/draw-call budgets pass.
- [ ] No console errors; no platform changes.

**Catalog**

- [ ] Hub lists every shipped game with correct metadata.
- [ ] Thumbnails licensed and lazy-loaded.
- [ ] 8-player party game runs on the TV.
- [ ] 30-minute catalog soak with game switching.

**Steps**

- [ ] Ship Wave 1; run acceptance.
- [ ] Ship Wave 2; run acceptance.
- [ ] Ship Wave 3 only for games whose prerequisites passed.
- [ ] Decide Wave 4 with recorded E3/E12/E11 evidence.
- [ ] Record per-game budgets and acceptance in `docs/RESULTS.md`.
- [ ] Update the hub metadata/thumbnails.

**Acceptance**

- [ ] Every shipped game meets its game-file Minimal.
- [ ] Catalog is complete and budgeted.
- [ ] No game required platform changes.
- [ ] Deferred games are documented with reasons.

**Tests (tagged)**

- `[G8]` catalog games use the frozen SDK
- `[G3]` per-game budgets pass
- `[G4]` max-player games are stable
- `[G5]` gyro/haptics degradation works
- `[FR-9.13]` catalog/picker works for every game

**Anti-rework**

- Waves are ordered by dependency; do not start a game whose capability is unproven.
- Deferral is an accepted outcome, not a failure.

**Risks**

- Ambitious games can consume the entire P6 budget; cap their scope and ship the catalog first.
- Content moderation for quiz/word packs; use family filter and licensed packs.

---

### P6-DOCS-01 — Content packs and game authoring

| Field | Value |
|---|---|
| Layer | Docs/games |
| Spec | §17, §10; G8 |
| Depends on | P6-QA-01, P4-DOCS-02 |
| Unblocks | future game contributions |
| Deliverables | `docs/PACKS.md`, `sdk/schemas/pack.schema.json`, sample pack |

**Pack schema**

```json
{
  "id": "words-family-v1",
  "type": "word-list",
  "license": "CC0-1.0",
  "items": ["apple", "bicycle", "..."],
  "meta": { "category": "family", "language": "en" }
}
```

- Types: `word-list` (Draw/Spy), `quiz` (Bluff), `chart` (Beat Tap), `maze`/`map` (Tilt/Heist).
- Validate pack size/license/items; no executable content.
- Packs are loaded by games, not the platform; the platform only provides JSON loading.
- Document how to add a pack, license rules, and family filtering.
- Sample pack with CC0 content.

**Steps**

- [ ] Define the pack schema and validator.
- [ ] Write the sample pack and docs.
- [ ] Add license metadata and a content checklist.
- [ ] Verify every shipped game's content uses a pack (no hard-coded word lists).
- [ ] Add a test that packs validate and are size-bounded.
- [ ] Document contribution of new packs.

**Acceptance**

- [ ] Each content game loads its content from a pack.
- [ ] Packs declare licenses and validate.
- [ ] No hard-coded copyrighted content.
- [ ] Docs let a contributor add a pack safely.

**Tests (tagged)**

- `[G8]` content packs are documented and validated
- `[SR-13]` packs contain no executable content
- `[G7]` pack licenses are recorded
- `[FR-9.6]` packs lazy-load within budget

**Anti-rework**

- Packs are data; new content does not change code.
- The pack schema is additive/versioned like other schemas.

**Risks**

- User-contributed packs can contain offensive content; family filter and review policy.
- Chart/map formats can grow complex; keep v1 minimal.

---

## Game wave index

| Wave | Game | File | Prerequisite |
|---|---|---|---|
| 1 | Spy in the Room | [games/spy-in-the-room.md](../games/spy-in-the-room.md) | D5 panels/choice |
| 1 | Bluff Quiz | [games/bluff-quiz.md](../games/bluff-quiz.md) | D5 text/panel |
| 2 | Tank Arena | [games/tank-arena.md](../games/tank-arena.md) | D3/D7 physics |
| 2 | Snake Royale | [games/snake-royale.md](../games/snake-royale.md) | D2 D-pad/stick |
| 2 | Steering Wheel Racer | [games/steering-wheel-racer.md](../games/steering-wheel-racer.md) | D6 gyro + fallback |
| 3 | Sword Swing Duel | [games/sword-swing-duel.md](../games/sword-swing-duel.md) | D6 swing feasibility positive |
| 3 | Bomb Defusal | [games/bomb-defusal.md](../games/bomb-defusal.md) | D5 per-slot layouts/panels |
| 3 | Beat Tap | [games/beat-tap.md](../games/beat-tap.md) | E11 audio calibration |
| 4 | Heist Planner | [games/heist-planner.md](../games/heist-planner.md) | host→phone state feed |
| 4 | Open-World Showcase | [games/open-world-showcase.md](../games/open-world-showcase.md) | P6-RT-01 passes |

---

## Stage exit checklist

- [ ] P6-HUB-01/02 complete; hub Minimal and Full.
- [ ] Wave 1–3 games shipped at their Minimals (Wave 3 only where prerequisites passed).
- [ ] P6-RT-01 decided; Open-World shipped or documented as deferred.
- [ ] Per-game budgets and acceptance recorded.
- [ ] Content packs licensed and data-driven.
- [ ] Catalog remote-operable with 8 players.
- [ ] `docs/RESULTS.md` P6 row complete.

## Final handoff

- The platform is feature-complete for v1: hub + catalog + shipped games.
- Remaining Full game features are a post-v1 backlog in each game file.
- Any new platform capability starts a new stage with its own experiments and gate.
- iOS remains a future scope decision (A5).

## Explicitly not in P6

- Accounts, matchmaking, cloud saves.
- iOS support.
- Multi-region relay scaling.
- A visual layout editor.
- Full versions of games not listed in P6 scope.
