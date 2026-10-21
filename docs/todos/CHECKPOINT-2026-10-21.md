# Session checkpoint — 2026-10-21

> Written while three workflows are still running. Read this first after a
> restart. Do not start a new wave from this file alone; inspect the workflow
> journals and run the integration gate.

## Running workflows

| Track | Task ID | Run ID | Current phase at checkpoint | Completed agents |
|---|---|---|---|---|
| D1 probes + deferred platformer plan | `w5ycngf3o` | `wf_4ca7274f-202` | Complete — 9/9, review pass; D1 exit OPEN | all 9 |
| D2 controller v0 | `wdeejqzrj` | `wf_21277d8a-2eb` | Complete — 9/9, review pass; manual acceptance pending | all 9 |
| D4 session foundation | `w4j3ngqny` | `wf_ca3aee14-a1c` | Complete — 9/9, review pass; end-to-end wiring NOT complete | all 9 |

Workflow journal directory:
`C:\Users\vinay\.claude\projects\E--PROJECTS-2026-PocketPad\bf11b480-3f39-488e-8a76-1801bc9dbb64\subagents\workflows\`

## Current first-game decision

The first playable game is **Reaction Duel four-button** (amendment A12).
The platformer is deferred to the later 2D track. The platformer planning
documents are useful backlog, but their accelerated map is not the active
order.

Critical path: `D2 controller -> D3 runtime -> D7-SDK-01 -> GAME-RD four-button`.

## Completed agent results

- `platformer-plan`: created `docs/todos/games/platformer.md` and
  `docs/todos/ACCELERATED-PLATFORMER.md`. It flagged the Reaction-Duel-first
  conflict and added a reconciliation note. Both docs are for the later track.
- `d1-shared`: D1-EXP-01 experiment index, shared report/probe helpers, WebGL2
  failure fixture, `docs/RESULTS-TEMPLATE.md`, and 15 tagged tests. It also
  added an experiments project to the root `vitest.config.ts`.
- `d2-layout`: SDK layout schema v0, validator, JSON Schema mirror, and 20
  tagged tests. SDK tests: 74 passing.
- `d2-touch`: controller hit-testing and touch engine, 29 new tagged tests.
  Controller suite reported 46/46 passing at that point.
- `d4-proto`: protocol A9 `hostStatus`, A10 `badVersion`, validators and 10
  tagged tests. Protocol tests: 53/53 passing. A9/A10 README/TRACEABILITY rows
  were verified already present.
- `d4-auth`: broker token generation, constant-time compare, unbiased PIN,
  sliding-window join rate limiter, and 20 tagged tests. Broker: 49 passing.

### D1 completion (2026-10-21)

The D1 workflow finished 9/9 agents with 0 errors. The independent review
returned **PASS** for the artifact audit, but the D1 stage exit remains OPEN:

- **E1:** desktop Chrome 155 on this Windows 11 PC passed 14/14 checks:
  WebGL2 yes, MAX_TEXTURE_SIZE 16384, binary WebSocket 26->27 bytes at 1.4 ms,
  rAF ~114 Hz, RTX 3050 Ti. Explicitly **not TV evidence**.
- **E2:** safe mode stopped at the enforced 512 MB per-phase cap. No full
  ceiling was measured; the safe cap is not a budget basis.
- **E3:** 10 scene/resolution runs recorded; the 720p/1k criterion passed at
  ~120 fps. Wall-clock is vsync-capped; GPU timer values separate the scenes.
- **E14:** PENDING; 0 attempts, no cloudflared/ngrok installed. Manual steps
  are recorded in `docs/RESULTS.md`.
- Docs updated: `docs/RESULTS.md`, `docs/DEVICES.md`, `docs/BUDGETS.md`,
  `docs/DEVICE-MATRIX.md`; E2/E14 are marked recorded-safe-mode/PENDING, not
  PASS.
- Tracker reconciliation still needed: the program table previously said D1
  "Not started" and `[ ] D1 measured on the actual TV` is still unchecked.
  Change the status to "probes/docs done; actual TV, E2 full ceiling and E14
  pending"; do not mark D1 complete.
- The D1 review also observed a `tools/input-bot` TS2300 during a concurrent
  D4 edit; re-run after D4 settles.

### D4 completion (2026-10-21)

The D4 workflow finished 9/9 agents with 0 errors. The independent review
returned **PASS** for module-level artifacts, but the session foundation is
**not wired end-to-end**.

Tested modules:

- Protocol A9 `hostStatus` and A10 `badVersion`; protocol 53/53.
- Broker tokens, unbiased PIN, constant-time compare, sliding-window rate
  limiter; broker suite 89/89.
- Sessions, 30 s reservations, rejoin, room expiry, host recovery and stats
  modules with deterministic tests.
- Controller join flow and session storage, 33 new tests; controller 126/126
  except one D2-owned `controllerClient.ts` type error.
- Reconnect/Suspend/Wake Lock modules; RoomPanel QR/code/PIN; input-bot
  session/jitter/loss/churn logic.

Not wired — required before D4 can be called complete:

1. `packages/broker/src/ws-server.ts` ignores `suspend`/`event`, ignores
   `hostPause`/`hostResume`, calls `leave` instead of `detach` on socket close,
   uses D0 `hostLeave` on host close, and starts no `StatsTicker`.
2. `packages/broker/src/registry.ts` is not wired to `HostRecovery` or
   `StatsCollector`; host-lost recovery and 1 Hz stats are not functional
   end-to-end.
3. Controller `main.ts`/`controllerClient.ts` are not wired to the join flow or
   reconnect controller; RoomPanel is not mounted; input-bot CLI flags are not
   wired.
4. The join rate limiter is currently applied only to PIN-bearing attempts;
   the review flagged this caveat.
5. A11 `pinRequired` is not in the `JoinErrorReason` union; a token-only join
   to a `requirePinForQr` room returns `badPin` as the closest reason.
6. `packages/protocol/dist` was not rebuilt; build protocol before consumers.

### D2 completion (2026-10-21)

The D2 workflow finished 9/9 agents with 0 errors. The independent review
returned **PASS for the implementation**, not for manual acceptance.

Delivered and tested:

- Layout schema v0 and validator (20 tests).
- Touch engine and hit-testing (29 tests; 10 touches, 44 px minimum).
- InputStore, SendLoop and ClockSync (60 Hz active / 10 Hz idle, edges, A3).
- Button, d-pad and stick renderers with same-frame feedback.
- Host InputMapper (latest-wins level, accumulated edges, golden traces).
- Controller integration: layout mount, send loop, ping, debug overlay.
- QA golden traces and perf tests; controller suite passes within the full
  59-file / 661-test run.

Still open for D2 exit:

- D2 RESULTS row; 240 fps same-frame camera check; real-phone 10-touch,
  two-finger and no-scroll checks; Android p50/p95.
- End-to-end layout delivery is not possible until D5 routes `setLayout`; D2
  accepts `joined.layout` or the first matching `setLayout`.
- By design, no auto-reconnect and no layout hot-swap in D2.
- `packages/controller/src/index.ts` does not export every new module; imports
  from `src/input`, `src/touch` and `src/net` are used directly.

### Final integration gate (all three workflows)

`npm run check` **EXIT 0**:

- typecheck and lint clean.
- 59 test files, 661 tests passed.
- build passed.
- size: controller 16,605 gz (budget 40,960), host 5,739 gz (budget 3,145,728).
- trace stage D0: 20/137 required, 0 missing, 56 deferred, 0 unknown.

Stale generated Vite bundles were removed before this run. If source changes
make the size gate report multiple controller/host files, delete
`packages/controller/dist/assets` and `packages/runtime/dist/assets` before
rebuilding.

## Known transient integration failures

These were reported by agents while other work was still in flight. Re-run them
after all three workflows finish; do not "fix" them in isolation.

1. `packages/controller/src/net/controllerClient.ts` — `JOIN_ERROR_TEXT` lacks
   the new protocol `badVersion` key from A10.
2. `packages/controller/src/touch/touchEngine.ts` — TouchEvent listener type
   overloads reported by a repo-wide check.
3. `packages/broker/test/rateLimit.test.ts` — `prefer-const` lint report seen
   by another agent. Re-check after D4 auth lands.
4. `packages/protocol/dist` was intentionally not rebuilt during parallel work.
   Run the full build before broker/controller/runtime consumers resolve the
   new declarations.
5. D2 and D4 were forbidden from editing
   `packages/controller/src/main.ts` and `net/controllerClient.ts`; a single
   integration agent must wire both join/reconnect and D2 controls after their
   modules land.
6. The D1 shared agent edited root `vitest.config.ts` outside its ownership to
   add the experiments project. Review that change during integration.
7. D1 review observed a `tools/input-bot` TS2300 during the measurement window;
   it came from a concurrent D4 edit. Re-run after D4 settles.
8. D4 review found `ws-server.ts` and `registry.ts` not wired to host recovery,
   stats, suspend/event or detach; see the D4 completion section.
9. D4 join/reconnect/RoomPanel/bot modules exist but are not mounted or wired
   into `main.ts`, `controllerClient.ts` or the input-bot CLI.

## Resume / integration order

1. All three Wave 1 workflow journals show 9/9 results, 0 errors.
2. `npm run check` is green as of this checkpoint; run it again after a restart
   before making changes.
3. Fix only cross-package integration defects. Typical expected fixes:
   `badVersion` in the controller error map, TouchEvent overloads, `prefer-const`
   in rateLimit tests, and rebuilding protocol before consumers.
4. Wire `controller/main.ts` and `controllerClient.ts` once for both D2 and D4.
5. Wire broker `ws-server.ts` and `registry.ts` to `HostRecovery`,
   `StatsCollector`, `StatsTicker`, `detach`, `suspend`, `hostPause` and
   `hostResume`; apply the join limiter before credential comparison.
6. Mount the host `RoomPanel`, wire the input-bot CLI flags, and add the
   controller `hostStatus` case.
7. Reconcile `ACCELERATED-PLATFORMER.md` to the Reaction-Duel-first order.
6. Add amendment A12 to README/TRACEABILITY only after D4-PROTO-01's A9/A10
   edits are settled, to avoid a concurrent-edit conflict.
7. Do not start D3 until E1 records WebGL2 and binary WebSocket support.
8. Update `docs/RESULTS.md` only with observed measurements; E2 Safe mode and
   E14 tunnel blocked/pending are not PASS.
9. Do not mark D1 complete just because its workflow completed. The actual-TV
   matrix, E2 full ceiling and E14 tunnel remain open. D3 may use the desktop
   E1/E3 smoke data for desktop work, but the TV gate is still open.

## Rules

- No git commit was made at checkpoint time.
- No measurements were fabricated; E1/E2/E3/E14 rows must state what actually
  ran.
- D1, D2 and D4 are not complete until their review agents pass and the
  integration gate is green.
- Reaction Duel is the first game; the platformer does not replace the four D7
  proof games.
