# Wave 3 checkpoint — 2026-10-22

> **Status:** Wave 3 integration is complete and `npm run check` is green.
> **No stage exit is claimed.** Every D1–D7 exit checklist still has open items.
> The work is **uncommitted** (42 modified + 54 untracked = 96 paths when this
> checkpoint was written; counts move while agents work); no commit, revert,
> checkout or clean was performed.
> Read this file before resuming. Device and TV evidence stays PENDING, and
> E2-full, E14 and every TV row remain open.

## 1. Scope of this wave

Six workstreams from waves 2–3 were integrated without reverting earlier work:

| Workstream | Work items landed |
|---|---|
| D3 runtime v0 | D3-RT-01..07, D3-SDK-01, D3-TOOL-01 (EXP/QA partial) |
| D4 pairing/sessions | D4-PROTO-01, D4-SRV-01..03, D4-HOST-01/02, D4-CTRL-01/02, D4-TOOL-01 |
| D5 layouts/events | D5-SDK-01, D5-PROTO-01, D5-SRV-01, D5-CTRL-01..05, D5-RT-01 (`D5-SEC-01` not landed) |
| D6 sensors/haptics | D6-CTRL-01..04, D6-SRV-01, D6-RT-01 (the layout-only `sensors.gyro` motion strip is still open) |
| D7 proof games | D7-SDK-01 core and the Reaction Duel four-button adapter; `sdk/README.md` and the rest of D7 are open |
| SDK/integration | Game-facing `layouts`/`panels`/`events`/`haptics` APIs reconciled; controller haptics and layout sensor wiring |

## 2. Gate result

The integration agent's full gate is the authoritative whole-repo result:

| Command | Result | Evidence |
|---|---|---|
| `npm run check` | **PASS** | typecheck, lint, test, build, size and trace all pass |
| `npx vitest run` | **PASS** | 105 test files, 1,225 tests, 18.00 s |
| `npm run build` | **PASS** | all workspaces built; controller 129.78 kB JS; runtime main 156.21 kB + 11.36 kB game chunk |
| `npm run size` | **PASS** | controller 129,781 B raw / **36,712 B gz** (budget 40,960; task cap 61,440); host 169,437 B raw / **54,199 B gz** (budget 3,145,728) |
| `npm run trace` | **PASS** | stage D0: 20/138 required IDs, 0 missing, 28 deferred, 0 unknown across 188 test files; FR 52/60, NR 3/3, PR 10/11, SR 12/13, AR 3/3, TR 1/1, A 8/12, G 8/8, E 12/17, C 1/10 |
| Reaction Duel scoped suite | **PASS** | 4 files, 67 tests (its own config; the root Vitest projects omit it) |

Reaction Duel is verified by scoped suite and route tests only; the **playable-on-LAN gate with two phones and a host was not performed**.

### Docs-agent scoped re-verification

A 2026-10-22 01:25 run of `packages/runtime`, `packages/controller`, `packages/broker`, `packages/dev-server` and `sdk` produced 74 files / 957 tests with one failure: `packages/controller/test/perf.test.ts` measured 7.58 ms against the 2 ms tap-to-encode budget under concurrent agent load. The same file passed **6/6 in isolation at 01:26** (`tap-to-send` test 354 ms total). Treat the failure as load-sensitive, not a code regression; re-run the full gate on an idle machine.

## 3. Completed work

### D3 — Runtime v0

- `D3-RT-01` fixed loop, `D3-RT-02` renderer (custom WebGL2 + Canvas2D fallback), `D3-RT-03` host net client, `D3-RT-04` input/game context, `D3-RT-05` start screen + AudioBus, `D3-RT-06` `?debug=1` overlay, `D3-RT-07` TV profile + dynamic resolution are implemented with tests (`fixedLoop`, `renderer`, `hostClient`, `inputReader`, `audioBus`, `startScreen`, `overlay`, `resolution`, `tvProfile`, `loader`, `traceReplay`).
- `D3-SDK-01`: `Game`, `GameHost`, `loadGame` and the manifest-driven cube demo path.
- `D3-TOOL-01`: `tools/latency-harness` exists with 3 files / 16 tests, but the root `vitest.config.ts` has no project for it.
- Renderer decision: custom WebGL2 with Canvas2D fallback, no Three.js dependency. **Desktop-provisional**; the TV comparison was not run.

### D4 — Pairing and sessions

- Protocol A9 `hostStatus` / A10 `badVersion`; broker tokens, constant-time compare, PIN, join rate limiter, sessions, 30 s reservations, rejoin, room expiry, host recovery, stats, detach/suspend, hostPause/hostResume.
- Controller join precedence, session store, reconnect/backoff, suspend/Wake Lock, RoomPanel QR/code/PIN, hostStatus and kick handling.
- Input-bot session/jitter/loss/churn logic and CLI flags.
- D4 experiments: E4 loopback 200/200, E9 same-machine PASS, G1 in-page `runToJoined` 31.3 ms. All are **desktop or same-machine baselines**, not the stage criteria.

### D5 — Layouts and events

- `D5-SDK-01`: layout schema/validator, gyro non-gyro fallback, event-name rules.
- `D5-PROTO-01`: `setLayout`, `panel`, `event`, `layoutAck` message shapes.
- `D5-SRV-01`: opaque event routing with authenticated slot binding, 30/s burst-60 per-slot token bucket, per-slot layout state, private panels, `layoutAck` forwarding, rejoin replay, cleanup on leave/reservation/expiry.
- `D5-CTRL-01..05`: all 11 control types, in-place hot-swap (cancel touches, one `replaceChildren`, re-cache rects, panel content preserved by control id), text/canvas/gyro/choice renderers, viewport tracking and the per-client `EventQueue`.
- `D5-RT-01`: `LayoutApi`, `PanelApi`, `EventRouter` installed into the runtime game context; host resend on join/resume/reconnect.

### D6 — Sensors and haptics

- `D6-CTRL-01`: motion permission/secure-context detection, tap-gated enable, no prompt on load.
- `D6-CTRL-02`: rotationRate capture, screen-angle remap, one-pole smoothing, 500 ms auto-zero, i16 encoding.
- `D6-CTRL-03`: gyro control with 60 Hz `GyroSampleBinding`, flags, recalibration and keyboard activation.
- `D6-CTRL-04`: `HapticPlayer` decode/validate, 20 Hz coalescing, vibrate fallback and persisted `HapticsToggle`.
- `D6-SRV-01`: broker haptic routing, slot-0 fan-out, 20 Hz per-slot limit, no pattern storage/logging.
- `D6-RT-01`: `HapticApi` 20 Hz per-target coalescing over binary `HapticCmd`, `TiltIntegrator`.
- Integration wiring: `ControllerClient.onHaptic` (MSG.Haptic 0x84), HapticPlayer + HapticsToggle in controller `main.ts`, layout `sensors.smoothing`/`sensitivity` merged into gyro controls.
- **Still open:** the motion status strip for a layout that declares `sensors.gyro` but renders no visible gyro control (see §7).

### D7 — Proof games (partial)

- `D7-SDK-01` core: `packages/runtime/src/game/registry.ts` (Vite-glob manifest discovery + validation + duplicate rejection), `RoundManager`, `createBundledGames`, `manifestLayouts`. The draft `sdk/README.md` deliverable is still missing.
- Reaction Duel four-button adapter: `packages/games/reaction-duel/src/game.ts`, GameContext-only, layout applied on join, earliest synced tick decides, rematch and idempotent dispose; 18 adapter tests plus model/adjudication/layout tests (67 total).
- Dev-server `/games/<slug>/` host SPA route, built-bundle serving, source manifest/layout fallback only, `/demo/*` host-files route (fixes the earlier cube-manifest 404).

## 4. Files touched in the working tree

Paths are repo-relative; 96 changed paths (42 modified + 54 untracked) when this checkpoint was written. Counts move while other agents work.

**Broker:** `packages/broker/src/room/{events,haptics,layout,rateLimit}.ts`, `src/{room,registry,ws-server,index}.ts`; tests `eventRouting`, `panelPrivacy`, `hapticRouting`, `ws`, `helpers`.

**Controller:** `src/net/controllerClient.ts`, `src/touch/touchEngine.ts`, `src/main.ts`, `src/index.ts`, `index.html`, `src/styles.css`; controls `control`, `eventSink`, `canvas`, `gyro`, `text`, `strokeBatcher`, `textInput`, plus `src/events/EventQueue.ts`, `src/sensors/*`, `src/haptics/*`, `src/layout/*`; tests `hotSwap`, `eventQueue`, `gyroControl`, `hapticsPlayer`, `hapticsToggle`, `motionSource`, `motionPermission`, `motionEnable`, `layoutSensors`, `controllerClient`, `controlRegistry`, `controls`.

**Runtime:** `src/game/{LayoutApi,PanelApi,EventRouter,HapticApi,registry,RoundManager,gameRoute,manifestLayouts,GameContext,InputReader}.ts`, `src/net/{hostClient,hostReconnect}.ts`, `src/input/TiltIntegrator.ts`, `src/ui/{HostStatus,RoomPanel}.ts`, `src/main.ts`, `src/index.ts`, `src/demo/bundledGames.ts`, `public/demo/cube-demo/*`; tests `layoutApi`, `panelApi`, `eventRouter`, `hapticApi`, `tiltIntegrator`, `hostReconnect`, `gameRegistry`, `roundManager`, `gameRoute`, `manifestLayouts`, `inputReader`, `renderer`, `inputMapper`, `roomUrl`.

**Dev server:** `packages/dev-server/src/main.ts`, `src/static.ts`, `test/gamesRoute.test.ts`.

**Games:** `packages/games/reaction-duel/src/game.ts`, `test/game.test.ts`, `README.md`, manifest and layout.

**SDK:** `sdk/src/game-api.ts`, `sdk/src/index.ts`, `sdk/src/layout-validate.ts`.

**Tools/experiments:** `tools/input-bot/src/{cli,index}.ts`, `test/cli.test.ts`, `tools/latency-harness/`, `experiments/e05/`, `e06/`, `e09/`.

**Docs:** `docs/RESULTS.md` (experiments agent rows), `docs/todos/IMPLEMENTATION-ORDER.md`, `docs/todos/TRACEABILITY.md`, this file.

## 5. Tests reported by the scoped workstreams

These are pre-integration scoped runs; the full gate above is the authoritative result.

| Suite | Files / tests |
|---|---|
| Controller (`--project packages/controller`) | 26 files / 403 tests |
| Runtime (`--project packages/runtime`) | 23 files / 277 tests |
| Protocol + broker | 18 files / 194 tests (protocol 7/63, broker 11/131) |
| Dev server | 5 files / 34 tests |
| Reaction Duel (`--config packages/games/reaction-duel/vitest.config.ts`) | 4 files / 67 tests |
| Experiments | 18 files / 126 tests |
| Latency harness | 3 files / 16 tests (external temp config; root config has no project) |

Notable new suites: `hotSwap` 9, `layoutSensors` 1, `hapticsPlayer` 7, `hapticsToggle` 5, `motion*` suites, `eventQueue`, `hostReconnect` 12, `layoutApi` 9, `panelApi` 6, `eventRouter` 8, `hapticApi` 7, `tiltIntegrator` 10, `gameRegistry` 10, `roundManager` 17, `gameRoute`, `manifestLayouts`, `gamesRoute` 15.

## 6. Stage exit status — none claimed

> Historical wave-3 state. Section 11 supersedes the `D5-SEC-01`, `D6-DOC-01`
> and motion-strip rows below; the stage exits themselves remain open.

| Stage | Status | Open exit items |
|---|---|---|
| D0 Foundations | Complete (local acceptance) | CI run still needs a commit/push |
| D1 Device probes | **Open** | Actual TV, E2 full ceiling, E14 tunnel |
| D2 Controller v0 | **Open** | Manual 240 fps/10-touch/no-scroll/Android p50-p95 checks; D2 RESULTS row |
| D3 Runtime v0 | **Open** | Cube-on-TV (`D3-QA-01`), E6/E11, E12 ADR, TV frame/memory comparison |
| D4 Pairing/sessions | **Open** | 8 bots × 10 min, G1 device trials, E4 5 GHz, E9 phone pair, E15 |
| D5 Layouts/events | **Open** | `D5-SEC-01`, E10/E16 (`D5-EXP-01`), `D5-QA-01` |
| D6 Sensors/haptics | **Open** | `D6-CTRL-03` motion strip, E7/E8 (`D6-EXP-01`), `D6-DOC-01`, `D6-QA-01` |
| D7 Proof games | **Open** | `D7-RT-01/02`, `D7-HUB-01`, `D7-PERF-01`, `D7-EXP-01` (E13/E17), `D7-QA-01`, `sdk/README.md`; three proof games; LAN play unverified |
| Dev Exit Gate | Not started | Needs D7 + E1–E17 |

## 7. Open gaps

### Documentation and plan deliverables

1. **`D5-SEC-01` is not implemented.** `packages/controller/src/render/safeRender.ts`, `packages/runtime/src/game/safeData.ts` and `test/xss.test.ts` do not exist. Inline `textContent` use, event-name validation and panel URL rules are present, but the plan's deliverables, payload tests and `innerHTML` grep test are missing.
2. **`D6-DOC-01`: `docs/SENSOR-TESTING.md` does not exist.** The secure-context procedure is unwritten.
3. **`D7-SDK-01` deliverable `sdk/README.md` (draft authoring guide) does not exist.**
4. **`docs/ADR-0001-renderer.md` does not exist.** The E12 decision is recorded in `docs/RESULTS.md`, but the D3-EXP-01 ADR deliverable remains open, and `packages/runtime/src/render/Renderer.ts` still has a stale "E12 pending" header comment.
5. **`docs/todos/README.md` is stale:** it still says "No implementation has started." It is outside this task's ownership and needs a status-line update.

### Functional gaps

6. **No motion status strip** when a layout declares `sensors.gyro` but renders no visible gyro control (`D6-CTRL-03` requirement). Motion can currently be granted only by tapping a visible gyro control.
7. **`LayoutApi.clear(target)` is host-state-only.** There is no protocol "clear layout" message, so controllers keep rendering the last layout until the next `setLayout`.
8. **Reaction Duel draws in fixed 1280x720 design coordinates** onto a CSS-pixel Canvas2D surface; small host windows clip rather than scale.
9. **Tilt is not game-facing.** The SDK exposes no tilt angles, and `TiltIntegrator` is exported only from `@lanpad/runtime`; it is not instantiated in `main.ts`.
10. **Host reload stores only `{code, hostToken}`.** PIN and room token do not survive; connected phones remain in the 30 s reservation, but new phones need a new room.
11. **SDK `GameRenderer3D` has no 2D methods.** Reaction Duel feature-detects `clear/rect/circle/text`; Canvas2D works because the runtime passes that renderer, not because the SDK type exposes it.

### Verification gaps

12. **TV, E2 full ceiling and E14 remain PENDING.** All physical-device rows are PENDING: E5 phone/TV, E6, E7, E8, E9 two-phone, E10, E11, E15, G1 device trials, E13, E16, E17, swing feasibility and D3-QA-01 cube-on-TV.
13. **Wave 3 gate "Reaction Duel playable on LAN" is unverified.** The adapter, route and tests pass, but no two-phone host run was recorded.
14. **D4 QA is PENDING:** 8 bots × 10 minutes and the reconnect matrix were not run.
15. **E12 is desktop-provisional.** The desktop overlay run showed FPS 0/draw calls 0; a browser re-run is required before changing any recorded verdict.
16. **Root `vitest.config.ts` omits `packages/games/reaction-duel` and `tools/latency-harness`.** `npx vitest run` does not cover them; Reaction Duel used its own config and the harness used an external temp config. Adding projects is a root-config change and needs explicit approval.
17. **The cube-manifest 404 note in `docs/RESULTS.md` is addressed in code** (dev-server `/demo/*` route plus `packages/runtime/dist/demo/cube-demo/game.manifest.json` after build), but no browser re-run was performed. The RESULTS rows were left unchanged.
18. **One load-sensitive perf failure was observed** during the docs-agent scoped run (7.58 ms vs 2 ms); it passed in isolation. Re-run the full gate on an idle machine.

### Packaging and environment

19. **Dev-server `defaultConfig()` derives `allowedOrigins` from port 8080.** Overriding the port leaves browser WebSocket origins rejected.
20. **`@lanpad/runtime` dist is not Node-importable** because the build runs `tsc` and then Vite with an empty `outDir`; pre-existing packaging behavior.
21. **No commits.** The wave is entirely in the working tree; do not clean or checkout.

## 8. Next actions, in order

1. **Run Reaction Duel on the LAN** with a host and two phones; record the first visible input and confirm four-button layouts. This closes the Wave 3 gate.
2. **Implement `D5-SEC-01`** (`safeRender`, `safeData`, hostile-payload tests, `innerHTML` grep) and run `D5-EXP-01` E10/E16.
3. **Add `docs/SENSOR-TESTING.md`** and the motion status strip for `sensors.gyro` without a visible gyro control; then run E7/E8 on Android.
4. **Write `docs/ADR-0001-renderer.md`**, update the stale `Renderer.ts` header, and re-run D3-QA-01 with the fixed `/demo/` route; record E6/E11 on hardware.
5. **Run D4 QA:** 8 bots × 10 minutes, G1 device trials, E4 on 5 GHz, E9 two-phone, E15.
6. **Finish D7:** `D7-RT-01` physics/HUD/results/asset pack, `D7-HUB-01`, `D7-PERF-01`, `D7-EXP-01` (E13/E17), `D7-QA-01`, and the Sumo/Draw/Tilt games.
7. **Add root Vitest projects** for `packages/games/reaction-duel` and `tools/latency-harness` once root-config changes are approved.
8. **Re-run `npm run check` on an idle machine** before any commit, then commit only when the user asks.

## 9. Rules for the next agent

- Do not revert, clean, checkout or commit any wave work.
- Do not claim a stage exit until the full checklist in its plan file is met.
- Do not convert a PENDING experiment row to PASS without device evidence.
- Do not edit root config or `package.json` to work around the test-project gaps without explicit approval.
- Treat `docs/RESULTS.md` rows as the experiments agent's record; append notes, never rewrite a verdict.

---

## 10. Wave 4 addendum — independent-review fixes (2026-10-22)

> **Status:** the seven review findings below are fixed and integrated in the
> working tree, and the full `npm run check` gate is green. **No stage exit is
> claimed.** Everything is still **uncommitted**; no commit, revert, checkout
> or clean was performed. Device, TV, iOS and LAN evidence remains PENDING.
>
> This section is appended to the wave-3 record. It supersedes §7 items 1, 2,
> 4, 5, 6 and 9 where marked below; the rest of §7 still stands.

### 10.1 The seven findings and what was fixed

| # | Finding | Fix | Verification |
|---|---|---|---|
| 1 | **High:** a valid 4–16 KB `setLayout` could never reach a controller. FR-8.4 accepts layouts up to 16 KB, but SR-6 capped every JSON frame at 4 KB. | Amendment A13 (§10.2): per-message frame cap in `@lanpad/protocol`; broker transport ceiling raised to 16 KB; `LayoutApi.set` no longer swallows send failures. | Protocol 67/67, broker 138/138, runtime 292/292. Broker forwards 5 KB and 14 KB layouts to a real controller socket; 4.1 KB panel/event frames close with 1009; >16 KB closes with 1009. |
| 2 | D6-RT-01: tilt existed only as an internal integrator. The SDK exposed no tilt or gyro flags to games. | SDK `GameTiltState` plus required `gyroActive`/`gyroRecentered` on `GameControllerState`; runtime `ControllerState.tilt`; 8 pooled `TiltIntegrator`s in `GameHost` updated before input/game simulate; overlay per-slot gyro/tilt fields. | New `tiltWiring.test.ts` (6) drives the real FixedLoop + InputMapper + GameHost path; overlay tests (2). Runtime 292/292. |
| 3 | **Medium:** a layout declaring `sensors.gyro` with no visible `gyro` control left motion unreachable. | `packages/controller/src/layout/motionStrip.ts`: 300x60 visible strip with a 112x44 action, slop-inset hit rect so it cannot steal touches, full insecure/unsupported/denied/requesting/no-data/paused states, visibility pause/resume, dispose on layout swap. | `motionStrip.test.ts` 14 tests; affected controller set 97/97. |
| 4 | A12 / FR-7.12: rematch was reachable only through the named `onEvent("rematch")` path, not from a real button press on the results screen. | `ReactionDuelGame.simulate` captures `resultsOpen` before the model update and calls `model.rematch()` on any present slot's A/B/X/Y press edge; prompt text is "Press any button to rematch". | Reaction Duel 4 files / 69 tests, including the new rematch-edge test. |
| 5 | FR-8.2 / FR-5.4: a reused slot kept the previous player's layout and score; departure never cleared the slot. | `seenMask` replaces the never-pruned set; departure calls `ctx.layouts.clear(slot)` and `model.removePlayer(slot)`; rejoin re-applies `rd-four-button-v1` and `model.reuseSlot(slot)` resets the score to 0. | Reaction Duel 69 tests, including the new slot-reuse test. |
| 6 | SR-13 / SR-7 / FR-7.9: D5-SEC-01 was not implemented. No safe-render helpers, no payload validation, no hostile-payload or source-hygiene tests. | SDK validation (`isAllowedColor`, `sanitizePlayerName`, `isAllowedImageSrc` as a type predicate); controller `render/safeRender.ts` wired into panel/text/choice; runtime `game/safeData.ts`; hostile-payload suites and an `innerHTML`/`eval`/`srcdoc` source grep test. | SDK 107/107, controller 432/432, runtime 301/301 (pre-integration); 21 hostile tests plus the grep test. `EventRouter` was wired to the new helpers during integration (§10.3). |
| 7 | An offline panel `content:null` was deleted from room state, so it was never replayed on rejoin. | `Room.panels` stores a `null` clear marker; `replayChannelState` uses `has(slot)` and replays `{t:"panel", slot, content:null}`. A never-set slot still gets no frame. | Broker 135/135; `panelPrivacy.test.ts` 14 tests covering replay-once, never-set silence, slot-2 privacy and marker removal on leave. |

Two test files outside the fix agents' declared ownership were edited because
they encoded the old behavior: `packages/protocol/test/layoutMessages.test.ts`
(a 4.1 KB `setLayout` must no longer be rejected) and
`packages/runtime/test/inputMapper.test.ts` (the pooled `tilt` key). No
production file outside an agent's ownership was touched.

Scoped counts in this table are the fix agents' runs at the time they landed;
they moved as other fix tests were added. The final `npm run check` in §10.4 is
authoritative.

### 10.2 Amendment A13

A13 is recorded in `docs/todos/README.md` §1 (row A13) and
`docs/todos/TRACEABILITY.md` (SR-6 annotation, A1–A13 checklist, amendments
table). The integration contract:

- `@lanpad/protocol` exports `MAX_LAYOUT_JSON_FRAME_BYTES = 16_384`;
  `MAX_JSON_FRAME_BYTES` stays `4096`.
- `parseJsonMessage` hard-rejects any frame over 16,384 bytes before
  `JSON.parse`, then applies 16,384 to `t:"setLayout"` and 4,096 to every other
  message type. Unparseable frames between 4 KB and 16 KB also report
  `tooLarge` because they cannot be `setLayout`.
- `stringifyJsonMessage` picks the cap from `message.t`.
- The broker WSS `maxPayload` is 16,384; per-type enforcement still closes
  non-layout JSON over 4 KB with 1009 (`CLOSE.tooLarge`).
- `assertJsonWithinLimit` is unchanged at 4,096 and must not be used for
  `setLayout`.
- `LayoutApi.set` now throws a descriptive `Error` on transport failure,
  increments `sendFailures`, clears the pending ack, and exposes
  `get lastError()`. Recovery re-sends record `lastError` without throwing.
  Current call sites are guarded; future games must wrap `set` or inspect
  `lastError`.
- Manual invariant: 16,384 is intentionally duplicated in the protocol package
  (dependency-free) and the SDK's `MAX_LAYOUT_BYTES`. Keep them in sync; they
  are not cross-imported.
- Build order: `packages/protocol/dist` and `sdk/dist` are gitignored and
  rebuilt by the gate. Rebuild protocol after protocol changes and SDK after
  SDK changes before running broker/runtime/controller scoped suites.

### 10.3 Integration seams closed

The six workstreams left three wiring seams plus one stale comment. The
integration pass closed all four:

1. `packages/runtime/src/game/EventRouter.ts` now rejects with
   `isSafeEventName(name) || isSafeEventPayload(data)` before envelope sizing;
   `on()` uses `isSafeEventName`. New regression test
   `[SR-13][FR-7.9] receive rejects payloads that cannot be safe JSON`.
2. `packages/runtime/src/main.ts` feeds per-slot `gyroActive`/`tilt` into the
   debug overlay and a tracked `lastHaptic` pulse record (`target`, `steps`,
   `ageMs`) through a `GameHaptics` wrapper around the existing `HapticApi`.
3. `packages/controller/src/controls/canvas.ts` uses the shared
   `isAllowedColor` instead of a duplicated regex; signatures unchanged.
4. `packages/broker/src/room.ts` documents that `Room.panels` may contain
   `null` as a clear marker and that a missing key means never-set.

### 10.4 Gate result (authoritative for this wave)

`npm run check` was run after every integration edit and is green:

| Stage | Result | Evidence |
|---|---|---|
| Typecheck | PASS | `tsc -b` |
| Lint | PASS | `eslint .` |
| Tests | PASS | 109 test files, **1,285 tests** |
| Build | PASS | all workspaces, including protocol and SDK `dist` |
| Size | PASS | controller **134,307 B raw / 37,911 B gz** (dev 40,960; hard 61,440); host **55,754 B gz** (dev 3,145,728; hard 5,242,880) |
| Trace (stage D0) | PASS | 20/139 required IDs, 0 missing, 28 deferred, 0 unknown, 192 test files |
| Trace (stage D6, tagging sweep) | PASS | 8/139 required IDs, 0 missing, 25 deferred, 0 unknown |
| Reaction Duel scoped | PASS | 4 files, 69 tests (own config; still not a root Vitest project) |

Delta from the wave-3 checkpoint: 1,225 → 1,285 tests (+60); controller
36,712 → 37,911 B gz (+1,199 B, +3.3%); host 54,199 → 55,754 B gz (+1,555 B,
+2.9%). The working tree grew from 96 paths at the checkpoint to 114 when this
addendum was written (55 modified + 59 untracked), before the two new docs in
this task; counts move while agents work.

**This is not a full Gate run.** The gate's trace stage checks the IDs required
for stage D0. The full Gate matrix still has 25 IDs with no tagged test
(FR-4.1, FR-4.2, FR-4.5, FR-9.8, FR-9.9, FR-9.10, FR-10.4, PR-9.5, SR-8, A4,
A6, A7, A13, E6, E13, E17, C1–C7, C9, C10).

### 10.5 What this closes from §7

| §7 item | Status after wave 4 |
|---|---|
| 1. D5-SEC-01 not implemented | **Closed.** Helpers, tests and the `EventRouter` wiring exist. |
| 2. `docs/SENSOR-TESTING.md` missing | **Closed.** Written 2026-10-22; the E7/E8 device run is still PENDING. |
| 3. `sdk/README.md` missing | **Still open.** D7-SDK-01 deliverable. |
| 4. `docs/ADR-0001-renderer.md` missing | **Closed.** ADR written and marked desktop-provisional. The stale "E12 pending" comment in `packages/runtime/src/render/Renderer.ts` is a code edit and was not made by this docs wave. |
| 5. `docs/todos/README.md` stale | **Closed.** Status line and closing paragraph were updated by the layout-frame-cap agent and this wave. |
| 6. No motion status strip | **Closed.** Implemented and unit-tested; device acceptance PENDING. |
| 9. Tilt is not game-facing | **Closed.** SDK contract, host integration and overlay wiring landed. |
| 7, 8, 10, 11 (functional gaps) | **Still open.** LayoutApi.clear has no protocol message; Reaction Duel fixed 1280x720 coordinates; host reload stores only `{code, hostToken}`; `GameRenderer3D` has no 2D methods. |
| 12–18 (verification gaps) | **Still open.** E12 desktop re-run, TV/E2/E14, phone rows, Reaction Duel LAN, D4 QA, root Vitest omissions remain. |
| 19–21 (packaging) | **Still open.** Dev-server origins still derive from port 8080 (documented in `docs/SENSOR-TESTING.md` §3.3); runtime dist is still not Node-importable; still no commits. |

### 10.6 Remaining open items

1. **No stage exit.** Every D1–D7 exit checklist still has open items; the Dev
   Exit Gate has not started.
2. **Physical-device evidence is PENDING:** TV E1/E2/E3 and D3-QA-01, E5
   phone/TV, E6, E7/E8/swing, E9 phone pair, E10/E16, E11, E13, E14, E15, G1
   device trials, and Reaction Duel playable on LAN with two phones.
3. **E12 stays desktop-provisional.** The TV frame/memory comparison was not
   run. The desktop cube-scene overlay was not re-run after the `/demo/*` 404
   fix, so there is still no valid cube-scene frame or memory number.
4. **E7/E8 tooling is incomplete.** `experiments/e07/`, `experiments/e08/` and
   the swing page do not exist. `docs/SENSOR-TESTING.md` documents a runnable
   console leg, but the in-app leg also needs a layout that declares
   `sensors.gyro`; no bundled game ships one.
5. **`sdk/README.md` (D7-SDK-01 authoring guide) is still missing.**
6. **`packages/runtime/src/render/Renderer.ts` still says "E12 pending".** The
   ADR now exists; the header needs a code-owner update.
7. **The full Gate matrix is not green:** 25 IDs have no tagged test (§10.4).
8. **Contract changes future code must honor:**
   - `LayoutApi.set` can throw on transport failure; wrap it or check
     `lastError`.
   - A13's 16,384-byte literal is duplicated in protocol and SDK by design.
   - `Room.panels` may contain `null` (cleared marker); use `has(slot)`, not
     `get(slot) !== undefined`.
   - Tilt is optional in the runtime `ControllerState` type; the host always
     populates it from the mapper.
   - Reaction Duel treats every rejoin as reuse and resets that slot to 0
     because the input snapshot carries no player identity.
   - A clear marker is replayed on every rejoin of that slot (idempotent).
   - Overlay `lastHaptic.ageMs` is measured at the game's pulse call, not at
     the actual send; a coalesced pulse can look up to ~50 ms older.
   - `sanitizePlayerName` is exported and tested but has no production caller
     yet.
9. **Performance test is load-sensitive.** The wave-3 docs run saw
   `packages/controller/test/perf.test.ts` at 7.58 ms against a 2 ms budget
   under parallel agent load; it passed in isolation. The final gate on the
   integration run passed. Re-run the full gate on an idle machine before any
   commit.
10. **No commits and no root-config changes.** The tree is uncommitted; root
    `vitest.config.ts` still omits `packages/games/reaction-duel` and
    `tools/latency-harness`. Adding projects needs explicit approval.
11. **No real-device, LAN or iOS run was performed for this wave.** The iOS
    position is unchanged: deferred by A5, feature detection harmless, no
    acceptance test scheduled.

### 10.7 Files touched by wave 4 (by area)

| Area | Files |
|---|---|
| Protocol | `src/constants.ts`, `src/json.ts`; tests `json.test.ts`, `constants.test.ts`, `layoutMessages.test.ts` |
| Broker | `src/ws-server.ts`, `src/room/layout.ts`, `src/room.ts` (comment); tests `ws.test.ts`, `panelPrivacy.test.ts` |
| Runtime | `src/game/LayoutApi.ts`, `src/game/GameHost.ts`, `src/game/EventRouter.ts`, `src/game/safeData.ts`, `src/input/types.ts`, `src/input/InputMapper.ts`, `src/debug/Overlay.ts`, `src/main.ts`; tests `layoutApi`, `tiltWiring`, `overlay`, `inputMapper`, `eventRouter`, `xss` |
| Controller | `src/render/safeRender.ts`, `src/controls/panel.ts`, `src/controls/text.ts`, `src/controls/choice.ts`, `src/controls/canvas.ts`, `src/controls/gyro.ts`, `src/net/controllerClient.ts`, `src/layout/motionStrip.ts`; tests `xss`, `motionStrip`, `controlRegistry` |
| Games | `packages/games/reaction-duel/src/game.ts`, `src/model.ts`, `test/game.test.ts` |
| SDK | `sdk/src/game-api.ts`, `sdk/src/ugc.ts`; test `ugc.test.ts` |
| Docs | `docs/todos/README.md`, `docs/todos/TRACEABILITY.md`, this checkpoint, `docs/ADR-0001-renderer.md`, `docs/SENSOR-TESTING.md`, a note in `docs/RESULTS.md` §E12 |

No root config, `package.json`, or unrelated source file was edited by this
wave.

### 10.8 Rules unchanged

The §9 rules still apply in full. In particular: do not revert, clean,
checkout or commit; do not claim a stage exit; do not turn PENDING evidence
into PASS; append to `docs/RESULTS.md`, never rewrite a verdict.

---

## 11. Wave 5 cleanup (2026-10-22)

> **Status:** final review-cleanup wave. No stage exit is claimed and no device
> evidence was produced. Work remains **uncommitted**; no revert, checkout,
> clean or commit was performed. The §10.8 rules still apply.

| Item | Outcome | Evidence |
|---|---|---|
| Reaction Duel gate coverage | The root Vitest config now includes `packages/games/reaction-duel`, and `npm run typecheck` runs the game's own `tsconfig.json` via `typecheck:games`. The suite is part of `npm run check` rather than a separate manual config. | `vitest.config.ts`, root `package.json`; `npx vitest run --project packages/games/reaction-duel` is green with 4 files / 69 tests. |
| Canonical test tags | Reaction Duel and dev-server route tests now carry canonical requirement IDs (for example `[A12]`, `[FR-7.3]`, `[FR-7.10]`, `[FR-8.1]`, `[FR-8.2]`, `[FR-8.3]`, `[FR-10.3]`, `[G1]`, `[G2]`, `[G3]`, `[G4]`, `[G5]`, `[PR-9.3]`). Work-item tokens such as `[D7-SDK-01]` or `[GAME-RD-TEST-03]` may remain alongside them as context; trace-check ignores them. | Test titles in `packages/games/reaction-duel/test/*.test.ts` and `packages/dev-server/test/gamesRoute.test.ts`. |
| Dev-server route flake | Fixed; the `/games/<slug>/` route suite passes repeatedly. | `packages/dev-server/test/gamesRoute.test.ts`: 15/15 tests, six consecutive clean runs. |
| Tracker reconciliation | `IMPLEMENTATION-ORDER.md` records D5-SEC-01 and the D6-CTRL-03 motion strip as implemented, with file/test evidence; `README.md` status moved to wave 5. Stage exits and every PENDING device row are unchanged. | This file, `IMPLEMENTATION-ORDER.md`, `README.md`. |
| Final wave-5 gate | **Green.** `npm run check` passed end to end: typecheck (`tsc -b` plus `typecheck:games`), lint, 113 test files / 1,354 tests, build, size and trace. | controller JS 37,911 B gz of the 40,960 B dev budget; host 55,754 B gz; stage-D0 trace 20/139 required IDs, 0 missing, 24 deferred, 0 unknown (192 test files). |

Where §6 still lists `D5-SEC-01`, `D6-DOC-01` or the motion strip among open
exit items, this section supersedes that list; the stage exits themselves
remain Open.

The tracker reconciliation changed docs only. No code, root config or
`docs/RESULTS.md` experiment row was edited by that work. TV, Android, LAN and
iOS evidence remains PENDING.

---

## 12. Wave 6 — connected layout fix and Coin Run slice (2026-10-22)

> **Status:** code in the working tree, **uncommitted**; this section is a docs
> reconciliation written by the docs task. Added: the connected-flag fix and
> the Coin Run platformer slice (`GAME-PF-01`..`05` code plus scoped tests;
> `GAME-PF-06` PENDING). **No stage exit is claimed and the Dev Exit Gate has
> not started.** No device, LAN or browser run was performed by this wave. The
> §10.8 rules still apply.

### 12.1 Root cause and the connected-layout fix

**Symptom:** opening a phone controller for Reaction Duel showed the D0
**Test** button instead of the game's four-button layout.

**Root cause:** a phone's first controller packet carries `tick = 0` and an
all-zero input state. Reaction Duel's old `isPresent` predicate required
`tick > 0 || buttons !== 0 || edges !== 0 || axes !== 0`, so a freshly joined
slot was never treated as present. `applyLayout` therefore never ran, the
broker never sent `setLayout`, and the phone stayed on the default D0 control
surface.

**Fix (packet-driven presence, not an input heuristic):**

1. `ControllerState` in `packages/runtime/src/input/types.ts` gains
   `readonly connected: boolean`.
2. `InputMapper.apply()` sets `record.connected = true` **before** the
   tick-staleness check, so the first `tick = 0` packet already counts.
   `pollAll()` publishes `state.connected = record.connected`;
   `reset()`/`clearRecord()` clear it on disconnect.
3. `GameControllerState` in `sdk/src/game-api.ts` mirrors
   `readonly connected: boolean`.
4. Reaction Duel replaces the `isPresent` heuristic with
   `player.connected` and adds `addConnectedPlayer`, which calls
   `model?.addPlayer(slot)`; a reconnect reuses the slot and keeps its score
   (the old `reuseSlot` path reset it).
5. Coin Run uses the same flag in `isConnectedSlot(player, maxPlayers)`:
   a connection edge applies the slot layout once, disconnect clears the
   layout and idles the body, and a later packet re-applies it.

**Evidence:** `packages/runtime/test/inputMapper.test.ts` (25 tests,
including tick-0 marks connected, an all-zero packet creates no edges, and
reset clears the flag); `packages/games/reaction-duel/test/game.test.ts`
(24 tests, 4 files / 73 total); Coin Run connectivity tests in
`packages/games/platformer/test/game.test.ts` (`[FR-8.2]` tick-0 layout,
disconnect/reconnect, disconnected-with-input is not present, throwing
layouts API).

### 12.2 Coin Run implementation map

| Work item | Files | Status |
|---|---|---|
| `GAME-PF-01` package/manifest/layouts/route | `game.manifest.json`, `layouts/pf-dpad-v1.json`, `layouts/pf-stick-v1.json`, `src/game.ts`, `README.md` | Code + tests |
| `GAME-PF-02` level/world | `src/level.ts`, `src/level-01.json`, `src/world.ts` | Code + tests |
| `GAME-PF-03` input/player | `src/input.ts`, `src/player.ts`, `src/config.ts` | Code + tests |
| `GAME-PF-04` rules/flow | local phase machine and score in `src/game.ts`, results content in `src/hud.ts` | Code + tests; deviations below |
| `GAME-PF-05` camera/render/HUD | `src/camera.ts`, `src/render.ts`, `src/hud.ts` | Code + tests; deviations below |
| `GAME-PF-06` replay/budgets/device run | — | **PENDING** (`test/replay.test.ts` does not exist) |

Scoped test files: `game.test.ts` 19, `player.test.ts` 20, `level.test.ts`
27, `camera.test.ts` 11, `layout.test.ts` 5, `manifest.test.ts` 4 — **6 files
/ 86 tests, green.**

**Deviations from the plan (recorded, not hidden):** no `src/index.ts` (the
default export is in `src/game.ts`); no `rules.ts`/`rules.test.ts`; phases use
a local `lobby → countdown(3000 ms) → playing → results` machine, not
`RoundManager`; results are painted by the game, not `ResultsScreen`, and
there is no Back callback; no edge arrows; no draw-call debug counter; no
audio; no `render.test.ts`, `hud.test.ts` or `replay.test.ts`; the README
still has stale `?game=platformer`/`packages/games/dist` lines.

### 12.3 Scoped verification (this task)

| Suite | Result |
|---|---|
| `packages/games/platformer` | 6 files / 86 tests, green |
| `packages/runtime` selected — `inputMapper`, `gameRegistry`, `bundledGames`, `physics` | 4 files / 61 tests, green |
| `packages/dev-server` — `gamesRoute` | 1 file / 16 tests, green |
| `packages/games/reaction-duel` | 4 files / 73 tests, green |

The **full `npm run check` was not run by this docs task**; the integration
agent is authoritative. The last recorded full gate is §11: 113 test files /
1,354 tests, build and size green, trace 0 missing / 0 unknown. No new number
from this wave should be treated as a gate result.

### 12.4 Remaining device and LAN work

- `GAME-PF-06` acceptance runs A (1 player, d-pad), B (2 players, d-pad +
  stick), C (4 players, mixed) on a TV host + Android Chrome phones, with
  device/browser versions.
- The connected fix must be re-verified on real phones: a fresh join shows the
  platformer layout, not the D0 Test surface; a reload becomes a new slot and
  the old body idles.
- Reaction Duel two-phone LAN re-check after the fix.
- Numbers still missing: initial/total gzip, max draw calls, frame p50/p95,
  input-to-canvas p95, join-to-first-input, 10-minute memory.
- 60 s replay trace, size-gate check, trace-checker coverage for Coin Run.
- 4-player readability, off-screen edge arrows, Back-to-start, audio.
- No commits exist for any of this work; the tree is dirty.

### 12.5 Rules unchanged

No revert, clean, checkout or commit; no stage exit or Dev Exit Gate claim;
PENDING device rows stay PENDING; `docs/RESULTS.md` is append-only and no
measurement may be invented.
