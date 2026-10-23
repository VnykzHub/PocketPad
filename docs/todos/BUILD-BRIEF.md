# PocketPad: Parallel Build Brief

Oct 23, 2026 · @Vinayak

Instructions for the local agent to build the PS5-style launcher, fully working phone controllers and all 13 remaining planned games on the Babylon.js branch. The order is one short serial wave to freeze contracts, then about ten parallel streams, then integration. Branch audited: `feat/babylon-engine` at `f1b69db`.

## Audit: what the branch has and what blocks the goal

The platform is solid: rooms, sessions, 11 controller control types, layouts, panels, haptics, a fixed-step host and a working Babylon cube on WebGPU and WebGL2. I read the code and docs only; I did not run the gate, so test counts below are the branch's own claims (267 files, 2,980 tests).

| # | Blocker | Evidence | Consequence |
| --- | --- | --- | --- |
| 1 | **The game-facing 3D API is only `setCamera` and `drawCube`.** The Babylon adapter (375 lines) implements just that. The SDK's optional `Scene`, `AssetLibrary` and animation types describe the custom engine's ECS, not Babylon | `sdk/src/game-api.ts`, `packages/runtime/src/babylon/` | No game can place a model, play a clip, use lights or shadows. This is the central contract of the whole build |
| 2 | **Game assets are not wired.** `GAME_ASSETS` is an empty array; `AudioBus` only plays buffers already registered by id, and nothing registers them | `host/stage.ts` line 54, `audio/AudioBus.ts` | No game has any model or sound |
| 3 | **Only 3 games exist** (Reaction Duel, Coin Run, Engine Cube). The 13 planned games have plans but no code | `packages/games/` | Largest volume of work, but highly parallel |
| 4 | **The launcher is a flat card grid by design.** `DESIGN.md` forbids shadows, glass and animated focus ("focus moves instantly") | `ui/Launcher.ts`, `DESIGN.md` | A PS5-style home contradicts the written design system; it needs an amendment, not a patch |
| 5 | **No HTTPS in the dev server**, and there is no single launch script (`npm run dev` does not exist) | `dev-server/src/terminal.ts`, `package.json` | Phone motion sensors need a secure context (SPEC §4.4), so the gyro games cannot work on a LAN phone as is |
| 6 | **All hardware evidence is PENDING** (49 rows in `docs/RESULTS.md`): phones, TV, sensors, haptics | `docs/RESULTS.md` | Agents cannot close these; a person with a phone must |
| 7 | **The controller bundle has 166 bytes of headroom** (40,794 of 40,960 gz at the dev target; the SPEC hard limit is 60 KB) | Branch report, CLAUDE.md | Any new control needs a budget decision first |
| 8 | **Babylon open items:** context loss untested, a `?babylon-backend` override sits in production stage code, two 3D backends coexist, Havok vs Rapier undecided | Branch report | Fine for a spike; must be closed before games depend on it |
| 9 | **Boot size will grow.** Lazy Babylon chunks are about 275 KB gz for the cube path; the bake-off scene with glTF, shadows and Havok was 1.73 MB gz | `21-babylon-migration.md`, ADR-0003 | Budget is 5 MiB gz; track it from the first merge |
| 10 | **Inventory is raw and uncurated.** 1.3 GB, gitignored; no curated `assets/` subset or full ledger yet; FBX-only packs and the palms folder (no licence file) are unusable as is; no tank, weapon, engine-loop or song assets | `docs/ASSET-INVENTORY.md` | A curation step must come before any game uses an asset |
| 11 | **One test flaked under load** (`deadzone.property`) | Branch report | Fix before ten agents hammer the gate in parallel |

## Decisions to lock first (defaults the agent should assume)

Each default is mine; you can change any of them before the run starts. Record the final set as `ADR-0004` and in `decisions.dm`.

| # | Decision | Default |
| --- | --- | --- |
| D1 | Physics for Babylon scenes | Havok first, behind the existing `Physics3D` interface, if its licence check passes; keep Rapier as the fallback. Decide on the vehicle test (stream P1), not on theory. Small 2D party games keep the existing 2D physics |
| D2 | Which games use Babylon | Games ship a **Minimal** tier on the current Canvas2D/primitive path first, then a **Full** tier with Babylon scenes and inventory assets. 2D-only party games (Draw and Guess, Bluff Quiz, Spy in the Room) stay 2D and use Babylon only for the launcher backdrop |
| D3 | Launcher motion vs `DESIGN.md` | Amend the design system with a **console shell** tier: animation, parallax and glow allowed on capable devices; honour reduced-motion and a low tier that keeps today's instant focus for older TV browsers |
| D4 | Controller size budget | Raise the dev target from 40 KB to 50 KB gz (the SPEC production target); the 60 KB hard limit stays |
| D5 | HTTPS for phone sensors | Add an opt-in TLS mode to the dev server (certificate paths from env or mkcert) plus a documented tunnel option, and a single `npm run play` that builds and starts everything with the join URL and QR printed. No production hardening claimed |
| D6 | Audio format | Keep the inventory's OGG Vorbis only if a decode smoke test passes in Chrome, Firefox and Safari; otherwise the curation step transcodes to Opus |
| D7 | Asset curation | Nothing loads from `Game-assets/`. A curation tool copies a size-budgeted subset to `assets/`, optimises GLBs, and writes `LICENSES.csv`; the asset validator rejects any file without a ledger row. The unlicensed palms stay out unless licence evidence is recorded (the OpenGameArt page for the exotic palms states CC0 by FabinhoSC; record that URL and date if the files match) |
| D8 | Missing assets | No tank, weapon, engine-loop or song in the inventory. Use primitives or recoloured vehicles, a synthesised engine sound, and either a self-made chart or the CC0 "Synth Wave" track on OpenGameArt |

## Wave 0: contracts to freeze before fan-out

One owner, serial, aiming for under a day. Nothing in Wave 1 starts until each item below has a spec, types, a fake implementation and a conformance test. This is what lets ten agents work without colliding.

1. **Spec 22, the game-facing 3D world API** (`ctx.world`, additive to `GameContext`, absent on 2D-only hosts). Opaque handles only; no Babylon types anywhere in `@lanpad/sdk`. Minimum surface:
   - Models: load by asset id, spawn and destroy actors, repeated meshes as instances, set transform, tint and emissive colour, visibility.
   - Animation: play, stop and crossfade a named clip on an actor, with speed and loop.
   - Scene: sun direction, colour and intensity; ambient; fog; sky preset or HDRI id; shadow tier; post tier (bloom, colour grade, vignette).
   - Camera: position, target, field of view, and a follow helper.
   - Primitives: box, sphere, cylinder, plane and ground with colour and emissive, for arenas and for assets the inventory lacks.
   - Rules: pooled and allocation-free per frame; capability tiers (WebGPU high, WebGL2 reduced); a pure fake (`createFakeWorld`) so games are testable without a GPU.
2. **Spec 23, game assets and audio wiring.** A per-game `assets.json` (id, path, kind, bytes, group, ledger row) replaces `GAME_ASSETS`; the host loader fills `ctx.assets` and registers audio buffers so `playSfx(id)` and `playMusic(id)` work; lazy groups, byte-accurate progress, the 5 MiB boot cap, and a validator that rejects any asset without a `LICENSES.csv` row.
3. **Spec 24, `@lanpad/game-kit`.** A shared library depending on `@lanpad/sdk` only: lobby, countdown, round and results state machine (wrapping the existing `RoundManager`), scoreboard, player colours and slots, seeded content-pack loading, object pools, and helpers for panels, choice and text events. Games import this instead of copying 500-line lifecycle code.
4. **Spec 25, console shell.** Additive manifest `presentation` fields (tagline, accent colour, hero model or thumbnail asset id, categories, input badges) with validator and schema; the `DESIGN.md` console-tier amendment (decision D3).
5. **Game registration without shared files.** Make discovery, `typecheck:games` and Vitest projects glob-based so adding `packages/games/<slug>/` touches no root file. Today a new game edits the root `package.json` and `vitest.config.ts`, which would serialise every game agent.
6. **Dev ergonomics and stability.** `npm run play` (build, start, print join URL and QR), the opt-in TLS mode (D5), the controller budget change (D4), a fix or quarantine plan for the flaky `deadzone.property` test, gate the `?babylon-backend` override to dev builds, and add a Babylon context-loss test.
7. **Fakes and a test kit.** Extend the SDK test fakes so any game can run `simulate` and `render` headlessly against fake input, world, audio and assets.

**Exit:** specs 22 to 25 and `ADR-0004` merged; fakes and conformance tests green; `npm run check` green; a trivial game created from a template compiles, registers and appears in the launcher with zero root-file edits.

## Workstreams and file ownership

Each stream runs in its own git worktree on `ws/<id>` off `feat/babylon-engine`. One writer per path. The integrator is the only agent that edits shared files and merges, running `npm run check` before each merge. Feature agents run only scoped commands (their package's typecheck, lint and tests), per `CLAUDE.md`.

| Wave | Stream | Owns (exclusive) | Delivers | Acceptance |
| --- | --- | --- | --- | --- |
| **0** | **W0 Contracts** | `sdk/**` additions, `docs/engine/22–25*`, `docs/ADR-0004*`, `DESIGN.md` amendment | Section above | Wave 0 exit |
| **1** | **A Babylon world** | `packages/runtime/src/babylon/**` | Spec 22 on Babylon: models, instances, clips, lights, shadows, sky, post, primitives, context-loss recovery, idempotent dispose | Conformance suite passes against the real adapter in Chrome; cube and a skinned character render; WebGL2 fallback renders |
| 1 | **B Assets and audio runtime** | `packages/runtime/src/assets/**`, `src/audio/**`, `src/engine/assetBridge.ts` | Spec 23: manifest loading, GLB/PNG/OGG, audio registry, progress, budgets | A test game plays a sound and shows a GLB from its `assets.json`; over-budget and missing-ledger assets fail loudly |
| 1 | **C Asset curation** | `tools/asset-curate/**`, `assets/**` | Curated subset of the inventory, optimised GLBs, `LICENSES.csv`, per-game asset lists | Boot set under budget; every file has a ledger row; FBX-only packs and the palms folder excluded unless evidence recorded |
| 1 | **D Console launcher** | `packages/runtime/src/ui/console/**`, `src/host/launcher.ts`, launcher CSS | The PS5-style home (next section), built on procedural art first | Launcher acceptance below, on keyboard, gamepad and phone-as-remote |
| 1 | **E Controllers and input** | `packages/controller/**`, `tools/input-bot/**` | Remote layout, calibration flows, size work within D4, multi-bot scenarios, on-device QA pages | Controller section below |
| 1 | **F Game kit** | `packages/game-kit/**` | Spec 24 | A sample game built only from the kit in under 200 lines; boundary lint passes |
| 1 | **G Host integration** (integrator) | `host/stage.ts`, `host/bootstrap.ts`, `packages/dev-server/**`, `playwright` e2e, CI | Wiring of A and B, `npm run play`, TLS mode, multi-bot e2e, merges | End-to-end: host, 4 bots, a game, results, return to launcher |
| 1 | **H Physics spike** | `experiments/babylon-physics/**`, `packages/runtime/src/physics3d/**` | Havok vs Rapier on one drivable car with wheels and steering, and a character controller, behind `Physics3D` | Measured comparison and a recommendation recorded in `ADR-0004` |
| 1b | **I–T Minimal games** (12 agents, 4 to 6 at a time) | `packages/games/<slug>/**` each | Minimal tier of each game below, using `@lanpad/game-kit` and the Wave 0 fakes | Per-game acceptance below |
| **2** | **Full-tier games and polish** | Same game folders; backdrop scene in D's folder | 3D presentations using `ctx.world` and curated assets; sound pass for every game; launcher 3D backdrop and key art | Full-tier column below; sound on every interaction |
| **3** | **Integration and release candidate** | Integrator | Performance pass against budgets, accessibility and reduced-motion pass, docs, device QA by a person | Hardware checklist signed off; `npm run check` green; budgets measured |

**Concurrency guidance.** Wave 1 has 8 infrastructure streams plus 12 games. Start A, B, C, F and G first (they unblock everything), then D, E and H, then release games in batches of 4 to 6 as capacity allows. Games can begin as soon as Wave 0 and F's first release land, because they build against the fakes, not the real adapter.

**Merge order inside Wave 1:** W0, F, B, A, C, G, D, E, H, then games in any order. After each merge the integrator runs the full gate and posts a one-line status to `docs/todos/CHECKPOINT-*.md`.

## Launcher: PS5-style home

Owned by stream D. Take the interaction pattern of a living-room console home screen; do not copy PlayStation logos, icons, sounds, fonts or exact trade dress. Everything comes from game manifests, with no per-game code.

**Structure**

1. **Start screen.** Press any key, button or tap on a phone. This is also the audio unlock gesture, so no sound plays before it.
2. **Top bar.** Room code, PIN and a QR toggle on the left; connection state and a clock on the right; one chip per connected player in that player's slot colour with a label and shape, never colour alone.
3. **Game row.** A horizontal row of tiles. The focused tile grows, shows its title, tagline, player range and input badges (gyro, haptics, text entry) and a Play action. Tiles beside it stay quiet.
4. **Backdrop.** A full-screen backdrop that crossfades to the focused game's theme: gradient and accent first, then in Wave 2 a slow 3D scene built from the city kits through `ctx.world`.
5. **Hint bar.** Controls for the current input (arrows and Enter, gamepad buttons, or the phone remote).
6. **Players and lobby.** A side panel with who has joined, which slot is which, and a clear "scan to join" empty state.
7. **Launch and return.** Select, a loading screen with real byte progress, game, then back to the launcher with focus restored. Leaving must free timers, audio and GPU resources.

**Input.** Keyboard, standard gamepad and the existing five-key TV remote path all work. The P1 phone shows a remote layout (d-pad, confirm, back) that drives the launcher. Focus never gets trapped.

**Sound.** Move, select, back and error sounds from Kenney UI Audio and Interface Sounds, only after the start gesture, at a low default volume, with a mute toggle.

**Motion tiers (decision D3).**

- *Full:* focus scale up to about 1.08, parallax of at most 8 px on tile art, soft accent glow, backdrop crossfade, using only `transform` and `opacity` with the existing duration and easing tokens.
- *Reduced:* applies when `prefers-reduced-motion` is set or the device is classed low tier. It keeps today's instant focus, no parallax and a static backdrop.
- Motion must never delay input: a key press is acted on immediately, whatever the animation is doing.

**Data.** Tile content comes from manifest `presentation` fields (spec 25). Missing fields fall back to a generated gradient and monogram. The Engine Cube demo appears only with `?debug=1`.

**Acceptance**

- Fully operable with arrows and Enter alone; also with a gamepad and with the phone remote.
- Adding a game folder adds a tile with no code change.
- Launcher backdrop costs at most 4 ms per frame on the dev machine in the Full tier, and the backdrop is paused while a game runs.
- Launch and return 20 times in a row leaves no leaked listeners, timers, audio nodes or GPU resources (a test asserts this).
- Reduced tier passes the same navigation tests with animations off.
- Screenshot checks at 1920x1080 for start screen, home with 4 and with 13 tiles, empty state, and lobby with 8 players.

## Games: all 13 planned, with assets and gaps

Each game has a plan in `docs/todos/games/<slug>.md`; those remain authoritative for rules and acceptance. This table adds the tiering and the inventory mapping. **Minimal** is the plan's minimal contract on the current renderers and game kit (Wave 1b). **Full** adds Babylon presentation and curated assets (Wave 2). Gaps are things the inventory does not contain, so the agent must use the stated fallback instead of blocking.

| Game | Minimal (Wave 1b) | Full (Wave 2) | Inventory assets | Gap and fallback |
| --- | --- | --- | --- | --- |
| Sumo Bumpers | Top-down circle arena, stick plus dash, shrinking floor, 2 to 8 players | 3D low-poly stage, characters as bumpers, hit-stop, shake, haptics | Quaternius characters; Kenney impact sounds and jingles | No arena model: primitives |
| Draw and Guess | Drawer panel with secret word, canvas strokes live on host, typed guesses, 3 rounds | Colours, brush sizes, hints, round gallery | UI sounds and jingles | Word filter and stroke-rate test needed (E10) |
| Spy in the Room | Secret-word panels, timed discussion, vote with `choice`, reveal | Word packs, animated reveals | UI sounds | None |
| Bluff Quiz | JSON question bank, fake answers, vote, scoring | Image rounds, categories | UI sounds, jingles | Content packs written by the agent |
| Tilt Maze Race | Top-down maze, tilt control with stick fallback, recalibrate | 3D ball maze on Babylon with physics, traps | Sci-fi sounds | Gyro needs HTTPS (D5) and a real phone |
| Steering Wheel Racer | Top-down track, shared camera for all cars, gyro or buttons, 3 laps | 3D tracks from road kit, Kenney cars, drift, bots | Car kit (50), road kit (95), retro urban props | No engine loop: synthesise with Web Audio |
| Tank Arena | Dual-stick drive and aim, pooled bullets, walls, HP, respawn | 3D arena, destructible walls, shake | Impact and sci-fi sounds | No tank model: recoloured car-kit body plus primitive turret |
| Snake Royale | Grid snake, d-pad, food, shrinking arena | Smooth movement, themes | Mini-forest props | None |
| Sword Swing Duel | 2D side view with button moves first; swing detection behind a feasibility flag | 3D fighters with animation clips | 52 characters, Universal Animation Library (43 clips) | No weapon model: primitive blade. Swing reliability needs an Android test |
| Bomb Defusal | Procedural wires, button and keypad modules, manuals on private panels, solvable by construction | Tension audio, more modules | Sci-fi and digital audio | Rule generator must be tested for solvability |
| Beat Tap | Four lanes, JSON chart, timing windows, combo, tap-to-beat calibration | More charts and difficulties | Music jingles | No song: self-made synthesised track, or the CC0 Synth Wave track on OpenGameArt |
| Heist Planner | 2D grid map, runner, patrol diagrams on private panels, one level | Isometric 3D with city props | Retro urban and city kits | Highest design cost; keep to one level |
| Open-World Showcase | Not applicable; Full tier only (Wave 2) | About 1 km2 streamed low-poly city, 2 players walking or driving, day-night | City kits, car kit, characters, driving and walking clips | Needs streams A, B, C and H; reuse the streaming design in `packages/engine/streaming` |

**Existing games.** Reaction Duel and Coin Run get launcher metadata, thumbnails and a sound pass. Engine Cube becomes a debug-only tech demo.

**Every game must**

- Use `GameContext` and `@lanpad/game-kit` only; no Babylon imports, no engine internals.
- Ship a manifest with `presentation` fields and layouts that pass the validator.
- Handle disconnect, reconnect and host pause, and clean up everything in `dispose`.
- Allocate nothing in `simulate` or `render` after warm-up.
- Load assets only from the curated list through `assets.json`, and stay within its declared budget.
- Have tests with requirement IDs registered in `TRACEABILITY.md`, a fake-driven playthrough test, and a 4-bot scripted run in e2e.
- Be playable by keyboard on a desktop for developer testing, where the plan allows.

## Phone controllers: what is built, what stream E does, what only you can do

All 11 control types (button, d-pad, stick, trigger, touchpad, slider, gyro, choice, panel, text, canvas) exist with unit and integration tests. What is missing is game-level wiring and real-device proof.

**Stream E delivers**

- Layouts for every game, validated by the SDK, plus a launcher remote layout (d-pad, confirm, back).
- Gyro flows: permission prompt on a gesture, recentre, a visible calibration step, and a stick or button fallback for every gyro game.
- Steering mapping for the racer, tap-to-beat calibration for Beat Tap, and haptic patterns per game event.
- Text, choice and canvas flows tested end to end for Draw and Guess, Bluff Quiz and Spy in the Room, including the keyboard-resize case.
- Reconnect behaviour per game: slot kept, layout and panel replayed, no duplicate avatars.
- Size work inside the 50 KB gz dev target (D4), lazy-loading rarely used controls if needed.
- `tools/input-bot` scenarios for 4 and 8 simultaneous bots, used by every game's e2e test.
- Screenshot checks of each layout in portrait and landscape at common phone sizes, with 44 px minimum touch targets asserted.

**Only a person with hardware can close these.** The agent prepares the page, steps and result template for each; you run them on a real phone and record the result in `docs/RESULTS.md`. Until then each row stays PENDING.

- [ ] Join time from QR scan to working controls, 10 trials, median under 5 s (G1)
- [ ] Input to canvas latency on LAN, 1,000 taps, camera-measured (E5)
- [ ] Lock the screen, switch apps and kill the browser, then rejoin within 30 s (E15)
- [ ] Gyro axes, units, drift and secure-context behaviour on Android over HTTPS (E7)
- [ ] Haptic patterns on Android (E8)
- [ ] Fast drawing bandwidth for Draw and Guess (E10)
- [ ] Text entry with the keyboard open, then rotate (E16)
- [ ] Two phones tapping together, to confirm the tie rule (E9)
- [ ] Eight controllers for ten minutes, then reconnect matrix
- [ ] Swing detection for Sword Swing Duel, 30 swings per direction
- [ ] Audibility check: UI sounds, engine synthesis and music on the actual TV or speakers

iOS is not a v1 acceptance target; the controllers must still feature-detect motion and haptics and stay playable without them.

## Rules, gates and evidence

These extend `CLAUDE.md`; where they conflict, `CLAUDE.md` and `SPEC.md` win until an amendment is recorded.

- **Spec first, contracts additive.** No stream changes a frozen contract. A needed change goes to the Wave 0 owner as an amendment request; do not patch it inside a stream.
- **One writer per path.** Streams edit only the paths they own in the table. Shared files (`stage.ts`, `bootstrap.ts`, root configs, `TRACEABILITY.md`) belong to the integrator.
- **Budgets, measured at every merge:** boot set at most 5 MiB gzip; controller at most 50 KB gz dev target (60 KB hard); frame p95 at most 14 ms at 1080p on the dev machine, hard 20 ms; at most 120 draw calls; texture memory at most 128 MB provisional; no per-frame allocation in `simulate` or `render`.
- **The gate.** `npm run check` must be green at every merge. Never skip, weaken, rename or delete a test to get green; if a merge turns the gate red, the integrator reverts the merge and sends it back.
- **Evidence.** Add measured rows to `docs/RESULTS.md` with device, browser version, date and values. Never invent a number. Desktop Chrome on the RTX 3050 Ti is provisional; TV, phone and integrated-GPU rows stay PENDING until run.
- **Assets and IP.** Only curated assets from `assets/` with a ledger row. Nothing from `Game-assets/` directly. Treat `references/` as read-only inspiration and never copy from it into the repo. No PlayStation or Rockstar logos, sounds, fonts, names or assets.
- **Git.** Work in worktrees on `ws/<id>` branches; commit there. Merge into `feat/babylon-engine` through the integrator. No force pushes and no pushes to `main`.
- **Handoffs.** Each stream ends with a short entry in the checkpoint file: what shipped, evidence, open items, and files touched.
- **Stop rules.** Stop and report if a stream needs a file it does not own, if the 5 MiB budget would be breached, if Babylon types would leak into the SDK or a game, or if a game plan and its acceptance disagree.

## Kickoff prompt and limits

Export this doc to Markdown, save it in the repo as `docs/todos/BUILD-BRIEF.md`, then give the local agent this:

```text
Read docs/todos/BUILD-BRIEF.md, CLAUDE.md, docs/engine/21-babylon-migration.md,
docs/ADR-0003-engine-base.md and docs/ASSET-INVENTORY.md.
Branch: feat/babylon-engine. You are the orchestrator and the integrator.

1. Do Wave 0 yourself, serially: specs 22-25, ADR-0004 with decisions D1-D8 at
   the defaults in the brief, fakes, glob-based game registration, npm run play,
   TLS option, flake fix. Do not fan out until Wave 0 exit is met and the gate is green.
2. Then start streams A, B, C, F and G in separate git worktrees (ws/<id>), one
   agent each, with the file ownership in the brief. After they land, start D, E, H.
3. Release the 12 Minimal games in batches of 4-6. Open-World Showcase is Wave 2 only.
4. Merge in the order in the brief. Run npm run check before every merge. Revert
   a merge that turns the gate red; never weaken a test.
5. Never invent a measurement. Leave hardware rows PENDING and prepare their
   steps. Write a checkpoint entry after each merge.
6. Ask me only for overrides of D1-D8 or a stop-rule trigger. Otherwise proceed
   on the defaults and say which you used.
```

**Limits of this audit**

- I read the branch statically and did not run the gate, the host or any game; test counts and measurements are the branch's own claims.
- I could not see `Game-assets/` (gitignored); asset facts come from `docs/ASSET-INVENTORY.md`, so check file names and formats before curation relies on them.
- Contents of `references/` are unknown to me.
- Havok's licence terms and OGG decoding on TV browsers are unverified.
- The stream and wave split is my design; adjust concurrency to the agents and budget you actually have. I have not estimated cost or duration, since your usage dashboard from the Wave 0 run will give a better number than I can.
