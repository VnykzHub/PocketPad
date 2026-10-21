# Implementation Order

> **Status:** active — 2026-10-21
> **Purpose:** the single execution tracker for the plan set in this folder.
> **Rule:** a stage starts only when the previous stage's exit checklist is green. Parallel work is allowed only inside a stage, or P1 ∥ P2 after P0.
> **Source of truth for item-level dependencies:** each stage file's `Depends on` field and `docs/todos/README.md` §7.

## 1. Program order

| # | Stage | Plan file | Entry gate | Parallel with | Status |
|---:|---|---|---|---|---|
| 1 | D0 Foundations | `phase-1-dev/D0-foundations.md` | approved plan | — | Complete (local acceptance; CI run pending) |
| 2 | D1 Device probes | `phase-1-dev/D1-device-probes.md` | D0 exit | — | In progress — desktop probes/docs done; actual TV, E2 full, E14 deferred |
| 3 | D2 Controller v0 | `phase-1-dev/D2-controller-v0.md` | D1 E1–E3 recorded | — | Implementation done; manual acceptance pending |
| 4 | D3 Runtime v0 | `phase-1-dev/D3-runtime-v0.md` | D2 exit | — | In progress (Wave 2; desktop provisional target) |
| 5 | D4 Pairing/sessions | `phase-1-dev/D4-pairing-sessions.md` | D3 exit | — | In progress (Wave 2 close-out wiring) |
| 6 | D5 Layouts/events | `phase-1-dev/D5-layouts-events.md` | D4 exit | — | In progress (Wave 2 SDK/protocol/controls) |
| 7 | D6 Sensors/haptics | `phase-1-dev/D6-sensors-haptics.md` | D5 exit | — | Not started |
| 8 | D7 Proof games | `phase-1-dev/D7-proof-games.md` | D6 exit | — | Not started |
| 9 | Dev Exit Gate | `phase-1-dev/GATE-dev-exit.md` | D7 + all E1–E17 | — | Not started |
| 10 | P0 Infra decision | `phase-2-production/P0-infra-decision.md` | Gate GO | — | Not started |
| 11 | P1 Relay | `phase-2-production/P1-relay.md` | P0 signed | **P2** | Not started |
| 12 | P2 Pages | `phase-2-production/P2-pages.md` | P0 signed | **P1** | Not started |
| 13 | P3 Hardening | `phase-2-production/P3-hardening.md` | P1 **and** P2 | — | Not started |
| 14 | P4 SDK/open source | `phase-2-production/P4-sdk-open-source.md` | P3 checklist | — | Not started |
| 15 | P5 Beta | `phase-2-production/P5-beta.md` | P4 dry run | — | Not started |
| 16 | P6 Games/hub | `phase-2-production/P6-games-hub.md` | P5 production GO | waves 1→4 | Not started |

**Critical path:**
`D0 → D1 → D2 → D3 → D4 → D5 → D6 → D7 → Gate → P0 → P1/P2 → P3 → P4 → P5 → P6`

## 2. D0 exact work-item order

| # | Work item | Depends on | Can parallel with | Status |
|---:|---|---|---|---|
| 1 | `D0-REPO-01` | — | — | Done |
| 2 | `D0-PROTO-01` | REPO-01 | — | Done |
| 3 | `D0-PROTO-02` | PROTO-01 | PROTO-03 | Done |
| 4 | `D0-PROTO-03` | PROTO-01 | PROTO-02 | Done |
| 5 | `D0-SDK-01` | REPO-01 | server/tooling work | Done |
| 6 | `D0-SRV-01` | REPO-01 | SDK-01, TOOL-02 | Done |
| 7 | `D0-SRV-02` | PROTO-01/02/03, SRV-01 | — | Done |
| 8 | `D0-SRV-03` | SRV-02, PROTO-03 | — | Done |
| 9 | `D0-RT-01` | SRV-01/02/03, PROTO-02 | CTRL-01 | Done |
| 10 | `D0-CTRL-01` | SRV-01/02/03, PROTO-01/02/03 | RT-01 | Done (assets/CSS verified) |
| 11 | `D0-TOOL-01` | PROTO-01/02/03, SRV-02 | TOOL-02, QA-01 | Done |
| 12 | `D0-TOOL-02` | REPO-01 + builds from RT-01/CTRL-01 | TOOL-01, QA-01 | Done |
| 13 | `D0-QA-01` | REPO-01 | TOOL-01/02 | Done |
| 14 | `D0-QA-02` | all D0 items | — | Done (Android phone + tablet in Chrome; exact versions not recorded) |

**D0 status (2026-10-21):** all D0 work items are complete. Automated gates are green: `npm ci`, typecheck, lint (root `eslint.config.js`, 63 TS files), the full test suite (232 tests), build, size and stage-D0 trace. `D0-CTRL-01`'s `/c/` asset and CSP fixes are verified. `D0-QA-02` passed on real devices — this Windows 11 PC as the host screen, an Android phone and an Android tablet in Chrome; joins were instant, Test press/release registered on the host, and disconnects happened only on screen-off or manual reload. Exact Chrome versions and the host browser name were not recorded. Clean-clone/CI verification still requires a commit/push; none was made.

**D0 exit:** local `npm ci && npm run check` green; two clients joined and echoed input on real devices; CI workflow defined but not yet run on GitHub (no commit); no token/PIN in logs.

## 3. Stage-internal order

### D1 — Device probes
`D1-EXP-01` → (`D1-EXP-02` E1 ∥ `D1-EXP-03` E2) → `D1-EXP-04` E3 (needs WebGL2 confirmed) → `D1-EXP-05` E14 → `D1-DOC-01` → `D1-BUDGET-01` → `D1-QA-01`.
**Stop rule:** if E1 lacks WebGL2 or binary WS, revise D3 before D2.

### D2 — Controller v0
`D2-LAYOUT-01` → `D2-CTRL-01` → `D2-CTRL-03` → `D2-CTRL-02` → `D2-CTRL-04`; `D2-RT-01` in parallel after `CTRL-03`; `D2-QA-01`/`D2-PERF-01` last.

### D3 — Runtime v0
`D3-RT-01` → (`D3-RT-02` ∥ `D3-RT-03` ∥ `D3-RT-04`) → `D3-RT-05`/`D3-RT-06`/`D3-RT-07`; `D3-SDK-01` after RT-01/04/05; `D3-TOOL-01` → `D3-EXP-01` → `D3-QA-01`.

### D4 — Pairing/sessions
`D4-PROTO-01` → `D4-SRV-01` → `D4-SRV-02` → `D4-SRV-03`; then `D4-HOST-01`/`D4-HOST-02` ∥ `D4-CTRL-01`/`D4-CTRL-02`; `D4-TOOL-01` → `D4-EXP-01` → `D4-QA-01`.

### D5 — Layouts/events
`D5-SDK-01` → `D5-PROTO-01` → `D5-SRV-01` → `D5-CTRL-01` → `D5-CTRL-02` → (`D5-CTRL-03` ∥ `D5-CTRL-04` ∥ `D5-CTRL-05`) → `D5-RT-01` → `D5-SEC-01` → `D5-EXP-01` → `D5-QA-01`.

### D6 — Sensors/haptics
`D6-CTRL-01` → `D6-CTRL-02` → `D6-CTRL-03`; `D6-CTRL-04` ∥ `D6-SRV-01` ∥ `D6-RT-01`; `D6-DOC-01` → `D6-EXP-01` → `D6-QA-01`. iOS deferred (A5).

### D7 — Proof games
`D7-SDK-01` → `D7-RT-01` → `D7-RT-02` → `D7-HUB-01`; then the four game files in parallel: `GAME-RD-*`, `GAME-SB-*`, `GAME-DG-*`, `GAME-TM-*`; `D7-PERF-01`; E13 early, **E17 last** (4 h soak); `D7-QA-01` closes the stage.

### Gate
`GATE-QA-01` → (`GATE-PERF-01` ∥ `GATE-ARCH-01` ∥ `GATE-SEC-01` ∥ `GATE-OPS-01`) → `GATE-QA-02` → `GATE-DOC-01` (decision).

### P0
`P0-OPS-01` → (`P0-OPS-02` ∥ `P0-OPS-03`) → `P0-ARCH-01` → (`P0-SEC-01` ∥ `P0-OPS-04`) → `P0-PLAN-01`.

### P1
`P1-SRV-01` → (`P1-SRV-02` ∥ `P1-SRV-03`) → `P1-SRV-04` → (`P1-OPS-01` ∥ `P1-TOOL-01`) → `P1-QA-01`.

### P2
`P2-INFRA-01` → (`P2-INFRA-02` ∥ `P2-INFRA-03`) → `P2-SEC-01` → `P2-OPS-01` → `P2-QA-01`.

### P3
`P3-SEC-01` → (`P3-SEC-02` ∥ `P3-SEC-03` ∥ `P3-SEC-04`) → `P3-OPS-01` → `P3-QA-01`.

### P4
`P4-SDK-01` → (`P4-SDK-02` ∥ `P4-DOCS-01` ∥ `P4-DOCS-02`) → `P4-OPS-01` → `P4-QA-01`.

### P5
`P5-QA-01` → (`P5-QA-02` ∥ `P5-QA-03` ∥ `P5-QA-04` ∥ `P5-OPS-01`) → `P5-GATE-01`.

### P6
`P6-HUB-01` → `P6-HUB-02`; Wave 1 (Spy, Bluff) → Wave 2 (Tank, Snake, Racer) → Wave 3 (Sword*, Bomb, Beat*) → `P6-RT-01` decision → Wave 4 (Heist, Open-World*); `P6-QA-01` after each wave; `P6-DOCS-01` after content games.
`*` gated by D6 swing feasibility, E11 audio, or E3/E12.

## 4. Parallelism rules

1. **Stages are serial; work items inside a stage may be parallel only when their `Depends on` fields allow it.**
2. Do not run two agents on the same file at the same time. File ownership:
   - protocol agent: `packages/protocol/**`
   - server agent: `packages/broker/**`, `packages/dev-server/**`
   - runtime agent: `packages/runtime/**`
   - controller agent: `packages/controller/**`
   - SDK agent: `sdk/**`
   - tools agent: `tools/**`
   - scaffold/integrate: root config and cross-package fixes only.
3. P1 and P2 are the only cross-stage parallel pair (after P0).
4. E13 can run while D7 games are being built; E17 must be last.
5. P6 waves are ordered by risk, not parallel across waves.

## 5. Stop rules

- **D1 failure:** no WebGL2 or binary WS on the TV → stop, revise D3/P2 target; do not continue D2 as if it passed.
- **D4 failure:** G1 > 5 s or 8 clients unstable → fix before D5.
- **D5 failure:** panel privacy or E10 → fix before D6.
- **D7 failure:** any proof game Minimal or E17 → fix before Gate.
- **Gate NO-GO:** do not start P0.
- **P5 NO-GO:** do not start P6.
- **Any secret/token in a log:** release blocker, not a note.

## 6. Current execution

- [x] Plan set complete (`docs/todos/`).
- [x] D0 automated gates — protocol, SDK, server, runtime, controller and tools done; `npm ci`, typecheck, lint, 232 tests, build, size and stage-D0 trace pass.
- [x] `D0-QA-02` manual two-phone/TV acceptance run — Android phone + Android tablet in Chrome, instant join, Test input registered on the host.
- [x] D1 probe pages, tests and desktop measurements — E1/E3 on desktop Chrome; **D1 exit still open**: actual TV, E2 full ceiling, E14 tunnel.
- [x] D2 implementation — layout/touch/input/controls/mapper/integration/QA/perf; **manual device acceptance and D2 RESULTS row pending**.
- [x] D4 foundation modules — protocol/auth/sessions/host recovery/join/reconnect/room panel/bot; **end-to-end wiring pending**.
- [x] Wave 1 code integration — `npm run check` green: 59 test files, 661 tests, build, size and stage-D0 trace.
- [ ] Wave 1 acceptance close-out — D4 wiring, D2 manual checks, D1 TV/E2-full/E14.
- [ ] D2–D7 stage exits.
- [ ] Dev Exit Gate.
- [ ] Phase 2.

**Wave 1 workflows completed (2026-10-21):** all three finished 9/9 agents with 0 errors.
- D1 device probes + platformer plan — `w5ycngf3o` (`wf_4ca7274f-202`).
- D2 controller v0 — `wdeejqzrj` (`wf_21277d8a-2eb`).
- D4 session foundation — `w4j3ngqny` (`wf_ca3aee14-a1c`).

**Wave 1 integration gate:** `npm run check` green — typecheck, lint, 59 test files / 661 tests, build, size (controller 16,605 gz; host 5,739 gz) and stage-D0 trace with 0 missing / 0 unknown. Checkpoint commits: `d326559`, `d454f85`.

**Wave 2 running (2026-10-21):**
- D3 runtime v0 — `wyqpp0wp8` (`wf_6ef70fed-d7b`).
- D4 close-out wiring — `w9bllbzpc` (`wf_6595d802-0b9`).
- D5 contracts/controls — `wm15jx0dy` (`wf_a2030ee4-769`).
- Reaction Duel content — `w5qw3xkpw` (`wf_5ad3a8f2-cf8`).

**TV assumption:** actual-TV probing is deferred by user decision. Desktop Chrome 155 (WebGL2 yes, binary WS yes, RTX 3050 Ti) is the provisional v1 target. Agents must mark TV rows PENDING and must not claim TV measurements. Revisit the TV matrix before the Dev Exit Gate.

**Next action:** Wave 2 integration gate, then D7-SDK-01 and the Reaction Duel adapter. D5-SRV-01, D5-CTRL-02 hot-swap, D5-RT-01/SEC/QA, D4-HOST-02 and D6 follow; the platformer follows after D7-RT-01.

## 7. Accelerated first-game track — Reaction Duel four-button (2026-10-21)

> User decision: the first game is Reaction Duel with at least four inputs per
> controller. Amendment A12 defines the four-button target-match variant; the
> original one-button mode remains a Full-version mode.
> The platformer is deferred to the later 2D track: `games/platformer.md` and
> `ACCELERATED-PLATFORMER.md`.

| Wave | Contents | Gate |
|---|---|---|
| 1 | D1 probes ∥ D2 controller v0 ∥ D4 session foundation; platformer plan (deferred) | Completed 9/9 each; reviews pass; close-out open (D1 TV/E2/E14, D2 manual, D4 wiring) |
| 2 | D3 runtime v0 + D7-SDK-01 | E1 WebGL2 and binary WebSocket recorded; D2 exit |
| 3 | Reaction Duel four-button `GAME-RD-*` + direct `/games/reaction-duel/` route | Playable on LAN with 2–8 phones, four buttons each |
| Later | Platformer after D7-RT-01; D5 layouts/events, D6 sensors, remaining proof games, hub | Additive; no rewrite of Reaction Duel |

## 8. Parallel execution map (2026-10-21)

Two tracks run at once. **Critical path** is the shortest path to the first
playable game (Reaction Duel); **completeness** finishes the planned product.

**Critical path:** `D2 controller → D3 runtime → D7-SDK-01 → GAME-RD four-button`.

**Completeness track:** `D4 sessions (running) → D5 layouts/events → D6 sensors/haptics → D7 proof games → hub`.

D7-RT-01 (2D renderer/physics) is **not** on the Reaction Duel path; it is only
needed for the platformer and physics proof games.

| Wave | Runs in parallel | Depends on | Integration gate |
|---|---|---|---|
| 1 (running) | D1 probes and docs; D2 controller; D4 protocol/server/join/reconnect; platformer plan (deferred) | D0 | Full `npm run check`, trace and docs reconciliation |
| 2 (running) | D3-RT-01/03 → RT-02/05/06/07 → RT-04/SDK/TOOL/EXP/QA; D4 close-out wiring/QA; D5-SDK-01 + PROTO-01 → CTRL-01/03/04/05; Reaction Duel layout + pure rules | Wave 1 | Full check; D3 desktop cube; D5 contract/control tests; RD rules tests; TV rows PENDING |
| 3 | D3-SDK/TOOL/EXP/QA; D7-SDK-01; GAME-RD four-button; D7-RT-01 (platformer path); D4-HOST-02; D5-CTRL-01..05 after D5-SDK + D4-CTRL-01; D5-SRV-01 after D4-SRV-02 | E1 + D2 + D4 proto/server | Full check; Reaction Duel playable on LAN |
| 4 | GAME-PF platformer after D7-RT-01; D5-RT-01/SEC/EXP/QA; D6-CTRL/SRV/RT after D5 | Wave 3 | Platformer playable on LAN; D5/D6 exit |
| 5 | D7 proof games, D7-RT-02/PERF/EXP/QA, hub after D4-HOST-01 | D6 + D4/D5 | Dev Exit Gate |
| 6 | P0-P6 production | Gate GO | Production gates |

**File-ownership rules for parallel work:**

- D1 owns `experiments/**` and D1 docs; D2 owns `packages/controller/**`,
  `packages/runtime/src/input/**`, and `sdk/src/layout*`.
- D4 owns `packages/protocol/src/*session*`, `packages/broker/src/auth/**`,
  `packages/broker/src/room/**`, `packages/controller/src/join/**`,
  `packages/controller/src/net/reconnect.ts`,
  `packages/controller/src/lifecycle/**`, `packages/runtime/src/ui/RoomPanel.ts`,
  and `tools/input-bot/**`.
- D2 and D4 both must not edit `packages/controller/src/main.ts` or
  `controllerClient.ts`; a single integration agent wires both after their
  modules land.
- D3 owns `packages/runtime/**` except `src/input/**` and `src/ui/RoomPanel.ts`
  until Wave 3 integration.
- One integration agent per wave; no two agents edit the same file.
