# lanpad / vynkzhub — Development Plan Set

> **Status:** implementation in progress — wave 7 (full UI page pass), 2026-10-22. Work is uncommitted; no stage exit is claimed.
> **Source spec:** `SPEC.md` v0.3 (repo root). The spec is authoritative.
> **Scope:** Phase 1 Dev (D0–D7 + Dev Exit Gate), Phase 2 Production (P0–P6), every game, every architectural layer.
> **Execution model:** one stage at a time, each stage gated by its own exit checklist. Phase 2 is blocked until the Dev Exit Gate is signed off.

---

## 0. How to use this folder

This folder turns `SPEC.md` into an executable backlog.

| Question | File |
|---|---|
| What is the overall order and what freezes at each handoff? | this README, §5–§8; [`IMPLEMENTATION-ORDER.md`](IMPLEMENTATION-ORDER.md) is the execution tracker |
| Which requirement is implemented where? | [`TRACEABILITY.md`](TRACEABILITY.md) |
| What exactly do I build for stage D3? | [`phase-1-dev/D3-runtime-v0.md`](phase-1-dev/D3-runtime-v0.md) |
| What does the protocol layer own across all stages? | [`layers/protocol.md`](layers/protocol.md) |
| What is the complete todo for Sumo Bumpers? | [`games/sumo-bumpers.md`](games/sumo-bumpers.md) |
| Where is iOS mentioned? | this README §2.3, [`layers/controller.md`](layers/controller.md), [`phase-1-dev/D6-sensors-haptics.md`](phase-1-dev/D6-sensors-haptics.md) |

**Rules of engagement**

1. Work items are executed in ID order within a stage unless a dependency says otherwise.
2. A stage is done only when its exit checklist is complete and its tagged tests pass.
3. Never start a later stage to "get ahead" — the stage boundaries exist to keep interfaces frozen.
4. If reality forces a design change, update the owning plan file **and** this README's amendment register in the same commit.
5. No secrets, tokens, or customer data in plan files, tests, or logs.

---

## 1. Precedence and amendments

`SPEC.md` outranks these plans. Where a plan contradicts the spec, the spec wins until the amendment is approved and recorded here.

These are the only deliberate deviations or gap-fills. Each one exists to prevent a known rework.

| ID | Amendment | Why it is needed | Spec anchor | Approve before |
|---|---|---|---|---|
| **A1** | Add `packages/broker`: shared room/session/fan-out core imported by both `dev-server` and `relay`. `dev-server` adds static serving and dev LAN discovery; `relay` adds TLS, health, and production hardening. | §10 lists `dev-server` and `relay` separately. If the D4 room/session logic lives only in `dev-server`, P1 copies or rewrites it. A shared core makes Phase 2 an adapter change, not a rework. | §10, §14 P1, §4.5 | D0 |
| **A2** | Add host WebSocket auth: `hostJoin {v, code, hostToken}` → `hostJoined {code, serverTime}` or `joinError`. | The spec defines a host token (§7.16) and `POST /api/rooms`, but no message that authenticates the host socket. Without it, `hostLost` recovery is unimplementable. | §5.2, §7.16 | D0 (types), D4 (behavior) |
| **A3** | Define `tick` in the Input packet as the client's estimate of **server time in milliseconds at send time**, truncated to `u32` (wraps every ~49.7 days). It is a timestamp, not a frame counter. | FR-7.10 requires fairness comparisons on synced timestamps; the spec calls the field `tick` but never defines its unit. Both host adjudication and the input mapper need one definition. | FR-7.10, §7.1 | D0 |
| **A4** | Production CSP `connect-src` must include `https://relay.vynkzhub.com` in addition to `wss://relay.vynkzhub.com`. | `POST /api/rooms` is an HTTPS fetch to the relay origin, not a WebSocket. SR-8's example omits the HTTPS origin and would block room creation. | SR-8, §5.2 | P2 |
| **A5** | iOS controller is **out of v1 acceptance**. Code remains feature-detected and degrades gracefully; no iOS-specific work, device testing, or exit criterion is scheduled. E7's iOS leg is deferred. | Explicit user decision (2026-10-21): no iOS device, not needed for v1. | §12, D6 exit, E7 | D6 |
| **A6** | Tooling choices: npm workspaces, TypeScript strict, Vitest + fast-check, ESLint, GitHub Actions. Vanilla TS for the controller (spec permits vanilla or Preact). | The spec names Vite and libraries but not the workspace/test/CI toolchain. These keep setup boring and dependency-light. | §6, §10, §16 | D0 |
| **A7** | `SPEC.md` stays at the repo root instead of moving to `docs/SPEC.md` for now. | Avoids breaking every plan link before D0. Can be moved in D0 if desired. | §10 | — |
| **A8** | Add `hostToken` to the `POST /api/rooms` response and store it only in host memory/sessionStorage. It never goes in a URL. | Required by A2. Host token is a 128-bit secret, same class as room/session tokens. | §5.1, SR-1 | D0 |
| **A9** | Add server→controller `hostStatus {state: "active" \| "paused" \| "lost"}`. | The spec requires controllers to show "Waiting for TV" on host loss but defines no message that tells them. Without it, the UX is guesswork. Additive variant. | §7.16, §8.5 | D4 |
| **A10** | Add `badVersion` to the `JoinErrorReason` union. | `join`/`hostJoin` carry `v`; a mismatched client must learn why. Reusing `badToken` would hide the cause and confuse reconnect logic. | §7.2 | D4 |
| **A11** | Add `pinRequired` to `JoinErrorReason`; allow `join` to carry `token` + `pin` together when the room has `requirePinForQr`. | The optional "PIN required for QR" mode needs a way to prompt for the PIN and then submit both credentials. `badPin` alone cannot distinguish "prompt" from "wrong PIN". Additive error value; the credential rule becomes session-alone, token-alone, pin-alone, or token+pin (QR PIN mode); `session` never combines with token/pin. | §5.1, SR-4 | P3 |
| **A12** | Reaction Duel Minimal uses four buttons per controller (A/B/X/Y target match); the one-button tap mode remains a Full-version mode. | User decision 2026-10-21: the first game must require at least four inputs per controller. The four-button layout exercises D2 multi-button/touch without needing D5 hot-swap. | §17.2, FR-8.1, FR-8.6 | D7 |
| **A13** | `setLayout` JSON frames may be up to 16 KB; all other JSON frames remain capped at 4 KB (SR-6). The broker enforces the per-message cap. | The SDK accepts layout documents up to 16 KB (FR-8.4), but SR-6 caps every JSON frame at 4 KB, so a valid 5-16 KB layout could never reach a controller. Only the layout channel needs the larger frame. | §7.2, SR-6, FR-8.2 | D5 |

### 1.1 Adopted defaults where the spec is silent

| Topic | Adopted default | Notes |
|---|---|---|
| Room code alphabet | Crockford base32, 4 chars (excludes I, L, O, U) | 20 bits, as specified |
| Room token / session / host token | 16 random bytes, base64url (22 chars) | SR-1 |
| Room idle expiry | 10 min with no host/controller traffic | FR-5.2 |
| Room maximum life | 4 h from creation | FR-5.2 |
| Slot reservation after suspend/drop | 30 s | FR-5.4 |
| Failed join lockout | 5 attempts/min/IP → 60 s lockout, doubling to 5 min on repeat | SR-5 says "then lockout" without a duration |
| Heartbeat / dead | 2 s / 5 s silence | FR-7.14 |
| Reconnect backoff | 250 ms doubling to 4 s cap | FR-7.15 |
| Haptic rate | 20 Hz per slot, coalesced | FR-8.11 |
| Event rate | 30/s sustained, burst 60 per slot, 4 KB body cap | FR-7.8 |
| Layout limits | ≤ 16 KB JSON, ≤ 24 controls, unique ids, unique channel bindings | FR-8.4, FR-7.7 |
| Player name | Optional, ≤ 24 chars, rendered as text only | Not in spec; needed for lobby |
| Reaction Duel tie rule | Earliest synced timestamp wins; a difference of < 1 ms is a replay round | FR-7.10, §17.2 |
| Family-friendly mode | Hook built in D5/P3; default OFF in dev, decision required before P5 | SR-13, §22 Q4 |
| TV short URL | `vynkzhub.com/tv` (plan also supports `/`) | FR-9.12 |

---

## 2. Scope

### 2.1 In scope for v1

Everything in `SPEC.md` §14 Phase 1 and Phase 2, minus the exclusions below. The proof games are the v1 gate; the remaining games ship in P6 after the platform is stable.

### 2.2 Out of scope for v1 (from spec §2)

- Matchmaking, accounts, cloud saves
- Video streaming of the game to phones
- Native apps
- WebGPU
- Custom peer-to-peer networking
- LAN-direct mode from an HTTPS page
- iOS haptics (no browser API) and, per A5, iOS acceptance testing overall

### 2.3 iOS position (explicit)

iOS is **not** a v1 target. We will not spend time on iOS Safari testing, iOS-specific layout fixes, or the iOS motion-permission flow beyond keeping the feature-detection code path harmless. The controller must still **not crash or break** on iOS: unsupported sensors fall back to buttons, haptics fall back to a visual pulse, and every gyro game must have a non-gyro control set. If iOS becomes a target later, the work is: enable the existing `DeviceMotionEvent.requestPermission` path, add iOS to the device matrix, and run E7/E8 iOS legs. No architectural change should be required.

### 2.4 Deferred, not cancelled

- Three.js vs custom WebGL2 final choice: E12 in D3, before any 3D game.
- World streaming/LOD: P6, only if E3/E12 justify the Open-World showcase.
- Hub voting/catalog: P6. D7 ships a minimal launcher/registry so proof games are playable without building the full hub.
- Visual layout editor: not in v1; JSON + `?layout=debug` is the authoring path.

---

## 3. Program map

Program **Phase 1 — Dev** proves every concept on a LAN with no production infrastructure. Program **Phase 2 — Production** is blocked until the Dev Exit Gate is signed.

| Stage | Plan file | Goal of the stage | Exit criterion (short) | Spec |
|---|---|---|---|---|
| D0 | [`phase-1-dev/D0-foundations.md`](phase-1-dev/D0-foundations.md) | Repo, protocol, dev-server, size gate, input-bot skeleton | Two clients join and echo input; CI size gate live | §14 D0 |
| D1 | [`phase-1-dev/D1-device-probes.md`](phase-1-dev/D1-device-probes.md) | E1, E2, E3, E14 device probes | Findings recorded for the actual TV(s) | §14 D1, §20 |
| D2 | [`phase-1-dev/D2-controller-v0.md`](phase-1-dev/D2-controller-v0.md) | Buttons, sticks, multi-touch, edges, input mapper | Same-frame pressed state; edges survive sub-tick taps | §14 D2 |
| D3 | [`phase-1-dev/D3-runtime-v0.md`](phase-1-dev/D3-runtime-v0.md) | Loop, renderer, host net client, latency baseline | Cube moves from a phone on the actual TV; E5 baseline recorded | §14 D3 |
| D4 | [`phase-1-dev/D4-pairing-sessions.md`](phase-1-dev/D4-pairing-sessions.md) | QR, code, PIN, sessions, reconnect, suspend | G1 met; 8 input-bot clients stable | §14 D4 |
| D5 | [`phase-1-dev/D5-layouts-events.md`](phase-1-dev/D5-layouts-events.md) | Full layout system, panel, text, choice, canvas, events | Private panel + text/draw round-trip; E10 passes | §14 D5 |
| D6 | [`phase-1-dev/D6-sensors-haptics.md`](phase-1-dev/D6-sensors-haptics.md) | Gyro, haptics, tunnel test flow (Android; iOS deferred) | Android gyro + vibration work; swing feasibility known | §14 D6 |
| D7 | [`phase-1-dev/D7-proof-games.md`](phase-1-dev/D7-proof-games.md) | Four proof games at Minimal + soak | All four Minimals reachable; E17 passes | §14 D7 |
| Gate | [`phase-1-dev/GATE-dev-exit.md`](phase-1-dev/GATE-dev-exit.md) | Experiment synthesis, budget freeze, go/no-go | Written go/no-go + infra choice for P0 | §14 Gate |
| P0 | [`phase-2-production/P0-infra-decision.md`](phase-2-production/P0-infra-decision.md) | Relay host/region, pages host, DNS | Decision records signed | §14 P0 |
| P1 | [`phase-2-production/P1-relay.md`](phase-2-production/P1-relay.md) | Production relay deployed | WSS relay healthy in staging with all security gates | §14 P1 |
| P2 | [`phase-2-production/P2-pages.md`](phase-2-production/P2-pages.md) | Pages on Vercel, short TV URL, prod config | Host playable with no local process (FR-4.1) | §14 P2 |
| P3 | [`phase-2-production/P3-hardening.md`](phase-2-production/P3-hardening.md) | Rate limits, PIN modes, abuse, filters, logging | Security/abuse checklist signed | §14 P3 |
| P4 | [`phase-2-production/P4-sdk-open-source.md`](phase-2-production/P4-sdk-open-source.md) | SDK, docs, sample game, open source | Clean-machine SDK dry run passes | §14 P4 |
| P5 | [`phase-2-production/P5-beta.md`](phase-2-production/P5-beta.md) | Beta on real TVs/phones | All §11 production gates pass | §14 P5 |
| P6 | [`phase-2-production/P6-games-hub.md`](phase-2-production/P6-games-hub.md) | Remaining games + full hub | Catalog ships; per-game budgets pass | §14 P6 |

**Critical path:** D0 → D1 → D2 → D3 → D4 → D5 → D6 → D7 → Gate → P0 → P1/P2 → P3 → P4 → P5 → P6.

D1 is deliberately before the controller work: E1–E3 set the performance envelope. If a TV cannot do WebGL2 or binary WebSockets, the product target changes before we build D2–D3, not after.

---

## 4. Architectural layers

Nine layers. Every work item in this plan set belongs to exactly one. Layer files hold the cross-phase index; the detailed work stays in the stage files.

| Layer | Code/docs | Owns | Must not own | Layer file |
|---|---|---|---|---|
| **Protocol** | `packages/protocol` | Types, constants, binary codecs, JSON message schemas, frame validation | Sockets, rooms, game rules | [`layers/protocol.md`](layers/protocol.md) |
| **Server** | `packages/broker`, `packages/dev-server`, `packages/relay` | Room lifecycle, auth, fan-out, rate limits, transport | Game state, rendering | [`layers/server.md`](layers/server.md) |
| **Host runtime** | `packages/runtime`, host page | Loop, renderer, input mapper, net client, loader, audio, streaming, debug overlay | Sockets inside game code, controller UI | [`layers/runtime.md`](layers/runtime.md) |
| **Controller** | `packages/controller` | Layout rendering, touch capture, sensors, haptics, join/reconnect UX | Game rules, server logic | [`layers/controller.md`](layers/controller.md) |
| **Games** | `packages/games`, game framework | Simulation, scoring, content, per-game layouts | Sockets, direct DOM/canvas outside the renderer API | [`layers/games.md`](layers/games.md) |
| **SDK** | `sdk/` | Manifest schema, layout schema/validator, game interface docs, sample game | Runtime internals, brand assets | [`layers/sdk.md`](layers/sdk.md) |
| **Tools/CI** | `tools/`, `.github/` | size-budget, input-bot, latency-harness, trace check, experiments server | Product behavior | [`layers/tools.md`](layers/tools.md) |
| **Infra/ops** | deployment, DNS, TLS, config | Environments, deploy, secrets, observability, rollback | Application logic | [`layers/infra.md`](layers/infra.md) |
| **Docs/experiments** | `docs/`, `experiments/` | RESULTS, ADRs, traceability, device matrix, testing policy | Product code | [`layers/docs-experiments.md`](layers/docs-experiments.md) |

**Dependency rules** (enforced by review; FR-10.2 gets an ESLint rule in D0):

```
games ──> sdk/runtime interfaces ──> runtime ──> protocol
controller ─────────────────────────> protocol
broker ─────────────────────────────> protocol
dev-server ──> broker ──────────────> protocol
relay ───────> broker ──────────────> protocol
sdk ────────────────────────────────> protocol (types only)
```

- `protocol` depends on nothing.
- `runtime` must never import `controller` (FR-10.2).
- `games` must never import `controller`, `broker`, `dev-server`, or `relay`.
- `controller` and host share `protocol`, never each other's internals.
- `broker` knows nothing about HTML, static files, Vercel, TLS, or game rules.

---

## 5. Goals × layers

Which layer carries which product goal. `●` = primary owner, `○` = contributes, `–` = not involved.

| Goal | Protocol | Server | Runtime | Controller | Games | SDK | Tools | Infra | Docs |
|---|---|---|---|---|---|---|---|---|---|
| **G1** Phone joins < 5 s from QR | ○ | ● | ○ | ● | – | – | ● | ○ | ○ |
| **G2** Input-to-canvas < 35 ms p95 | ● | ● | ● | ● | ○ | ○ | ● | ● | ○ |
| **G3** Baseline bundle < 5 MB gz | ● | – | ● | ● | ● | ● | ● | – | ○ |
| **G4** 8 controllers per room | ● | ● | ○ | ○ | ○ | – | ● | ● | ○ |
| **G5** Multi-touch, gyro, vibration, private screens | ● | ● | ● | ● | ● | ● | – | – | ○ |
| **G6** TV-only primary path | ○ | ● | ● | – | – | – | – | ● | ○ |
| **G7** Every dependency justified | ● | ● | ● | ● | ● | ● | ● | ○ | ○ |
| **G8** Game SDK for third parties | ○ | – | ● | ○ | ● | ● | ● | – | ● |

**Goal proof points**

- **G1** is measured in D4 (`G1 scan→playable` instrumentation + manual stopwatch run).
- **G2** is measured in D3 (E5 baseline), D7 (per-game), and P5 (production gate).
- **G3** is enforced from D0 by the size gate and per game from D7.
- **G4** is proven in D4 by the input-bot with 8 clients; re-proven in P5 load tests.
- **G5** is built in D2/D5/D6 and exercised by the proof games in D7.
- **G6** is proven in P2 with the TV-only acceptance run (no PC, no local process).
- **G7** is a standing review rule plus the size/dependency gate.
- **G8** is proven in P4 by a clean-machine external developer dry run.

---

## 6. Anti-rework contract

These are the rules that let each stage expand into the next without a rewrite. They are not suggestions; a violation is a plan defect.

1. **One protocol, versioned.** All wire formats live in `packages/protocol`; JSON control messages are a discriminated union on `t`; binary messages use little-endian `DataView`. `PROTOCOL_VERSION` ships from D0. No ad-hoc `JSON.stringify` messages outside the protocol package.
2. **No hard-coded origin.** Host, controller, QR builder, and tests read the server origin from config (`VITE_SERVER_ORIGIN` at build time; same-origin fallback). `ws://`/`wss://` literals are banned outside config files. FR-4.3/4.6 depend on this.
3. **One broker core.** Room codes, tokens, slots, reservations, expiry, auth, rate limits, and fan-out live in `packages/broker`. Dev and prod are adapters (A1).
4. **Same client code both environments.** Dev and production differ only by origin/TLS/config. No `if (dev)` branches in game, runtime, or controller logic.
5. **Games never see sockets.** Game code receives `ControllerState`, events, and rendering/audio/panel/haptic APIs (FR-7.17). This is what makes games testable from recorded traces and portable to the SDK.
6. **Layouts are data, not code.** The layout schema is versioned, validated on both ends, and rendered by a control registry. New control types are added to the registry, never by hard-coding a game's phone UI.
7. **The renderer is an interface.** Games depend on `Renderer2D`/`Renderer3D`, not Three.js or raw WebGL. E12 can swap the 3D backend without touching a game.
8. **The manifest is the game boundary.** `game.manifest.json` is defined in D0 (schema stub), consumed by the loader in D3, and used by the hub in P6. Adding a game is adding a folder + manifest, not editing a switch statement.
9. **Room/session semantics exist before games.** D4 must be complete before D7; games never implement reconnection, slots, or tokens.
10. **Requirement tags from day one.** Every test title starts with its requirement ID (`[FR-7.3] ...`). The trace checker fails CI when an ID has no tagged test (TR-1).
11. **Budgets are executable.** The size gate exists in D0 and runs on every build; game assets declare their budget in the manifest. Performance rules PR-9.x get instrumentation in D3, not post-hoc profiling.
12. **Data-driven content.** Word packs, quiz banks, charts, mazes, and maps are JSON/asset data from the first implementation, never hard-coded arrays that must be extracted later.
13. **Server never interprets game payloads.** `event` and `panel` bodies are opaque to the broker (FR-7.9). Adding a game never changes server code.
14. **iOS is deferred, not architected out.** Feature detection stays; no game may require gyro or haptics; the controller must remain usable with buttons only.
15. **Stage contracts are frozen in writing.** Each stage file has a "Contracts frozen" section. Later stages may add fields; they may not rename or repurpose frozen ones without a protocol version bump.

---

## 7. Phase handoffs — what freezes when

| Handoff | Frozen contracts | Consumed by |
|---|---|---|
| D0 → D1/D2 | Protocol types/codecs/version, frame caps, config loading, room/session data shape, manifest stub, CI gates | Every later stage |
| D1 → D2/D3 | Device facts (WebGL2, memory ceiling, frame budget), provisional budgets, renderer target | D2 sizing, D3 renderer, Gate |
| D2 → D3 | Input mapper semantics (latest-wins level, OR-accumulated edges), `ControllerState`, send-rate policy, edge encoding | D3 loop/net, all games |
| D3 → D4 | Fixed-step loop contract, host net client, host auth handshake, game interface, start-screen/audio unlock | D4 sessions, D5 panels, D7 games |
| D4 → D5 | Join/rejoin/suspend/hostLost semantics, slot identity, session token lifecycle, `stats` shape | D5 routing, all subsequent stages |
| D5 → D6 | Layout schema v1 + validator, `setLayout`/`layoutAck`, `panel`/`event` routing and limits, sanitization rules | D6 sensor/haptic layouts, D7 games |
| D6 → D7 | Gyro encoding/remap/calibration contract, haptic command path and limits, non-gyro fallback rule | D7 Tilt Maze, later gyro games |
| D7 → Gate | Proof games at Minimal, experiment results, budget evidence | Gate review |
| Gate → P0 | Measured budgets, go/no-go, infra candidates and criteria | P0 decision |
| P0 → P1/P2 | Production config schema, environment matrix, relay/pages choice, DNS/TLS plan | P1, P2 |
| P1/P2 → P3 | Deployed staging surface, real origins, CSP baseline, health/metrics endpoints | P3 hardening |
| P3 → P4 | Hardened public API surface, rate limits, content-filter hook, logging policy | P4 SDK freeze |
| P4 → P5 | Frozen SDK/API, docs, sample game, license boundary | P5 beta |
| P5 → P6 | Production gates passed, stable platform, known-issue list | P6 catalog |

---

## 8. Work item conventions

**ID format:** `<STAGE>-<LAYER>-<NN>` — e.g. `D0-PROTO-02`, `D5-CTRL-04`, `P1-SRV-03`, `GATE-PERF-01`.

| Abbreviation | Layer |
|---|---|
| `PROTO` | Protocol |
| `SRV` | Server (broker/dev-server/relay) |
| `RT` | Host runtime |
| `CTRL` | Controller |
| `SDK` | SDK |
| `TOOL` | Tools/CI |
| `QA` | Cross-layer verification (still owned by a layer) |
| `EXP` | Experiment/docs |
| `OPS` / `INFRA` | Infra/ops |

**Every work item must contain:**

1. Layer, spec anchors (section + requirement IDs), goals, dependencies, what it unblocks.
2. Exact deliverables: file paths and exported names.
3. The interface it freezes, with TypeScript/Pseudocode where applicable.
4. Checkbox steps that are concrete actions, not "implement X".
5. Acceptance criteria with measurable thresholds.
6. Tagged tests (at least one per requirement ID it claims; TR-1).
7. Anti-rework notes and risks.

**Status:** checkboxes are the only status. Do not add a second status table. A game/game-tier is "done" only when its Minimal checklist is fully checked and its acceptance run is recorded in `docs/RESULTS.md`.

**Definition of Done (every work item):**

- [ ] Code merged, types strict, lint clean.
- [ ] Tagged tests written first and passing.
- [ ] Relevant budget measured and under target (size/frame/latency as applicable).
- [ ] Debug/observability hooks added where the item touches runtime behavior.
- [ ] Plan file checkboxes updated; TRACEABILITY row still correct.
- [ ] No secrets/tokens in logs, fixtures, or commits.

---

## 9. Execution order and gates

1. **D0 is the only starting point.** It creates the contracts every other stage consumes.
2. D0 → D1 sequential. Do not skip the TV probes: if the TV fails WebGL2, the renderer target changes before D2/D3.
3. D2 → D7 sequential. Each stage's exit checklist is the entry checklist for the next.
4. **Dev Exit Gate is a human review**, not a checkbox sprint. If it says no-go, Phase 2 does not start; the plan returns to the failing stage.
5. P0 decides infrastructure. P1 and P2 can run in parallel after P0 because they touch different origins; both must be done before P3.
6. P3 → P4 → P5 sequential. P4's API freeze is meaningless before P3's hardening.
7. P6 starts only after P5 production gates pass. Games inside P6 ship in waves; each game has its own file and its own acceptance.
8. **Every stage ends with a commit** that updates the stage checklist and, when a measurement changes a budget, the budget config + `docs/RESULTS.md`.

**Testing gates per stage**

| Stage | Must pass before exit |
|---|---|
| D0 | Unit tests, protocol property tests, size gate, 2-client echo |
| D1 | E1–E3, E14 results recorded with device/browser/numbers |
| D2 | Mapper golden traces, sub-tick tap tests, controller budget |
| D3 | E5 baseline, E6/E11/E12 recorded, cube-on-TV run |
| D4 | G1, 8 bots, reconnect matrix, E4/E9/E15 |
| D5 | Panel/text/draw round-trip, E10/E16, XSS/size tests |
| D6 | E7/E8 (Android), fallback tests, swing feasibility note |
| D7 | Four game Minimals, E13/E17, per-game budgets |
| Gate | All E1–E17 recorded, TR-1 audit, security checklist, go/no-go |
| P0–P6 | As listed in each stage file; production gates use §11 prod targets |

---

## 10. File index

### Phase 1 — Dev
- [`phase-1-dev/D0-foundations.md`](phase-1-dev/D0-foundations.md)
- [`phase-1-dev/D1-device-probes.md`](phase-1-dev/D1-device-probes.md)
- [`phase-1-dev/D2-controller-v0.md`](phase-1-dev/D2-controller-v0.md)
- [`phase-1-dev/D3-runtime-v0.md`](phase-1-dev/D3-runtime-v0.md)
- [`phase-1-dev/D4-pairing-sessions.md`](phase-1-dev/D4-pairing-sessions.md)
- [`phase-1-dev/D5-layouts-events.md`](phase-1-dev/D5-layouts-events.md)
- [`phase-1-dev/D6-sensors-haptics.md`](phase-1-dev/D6-sensors-haptics.md)
- [`phase-1-dev/D7-proof-games.md`](phase-1-dev/D7-proof-games.md)
- [`phase-1-dev/GATE-dev-exit.md`](phase-1-dev/GATE-dev-exit.md)

### Phase 2 — Production
- [`phase-2-production/P0-infra-decision.md`](phase-2-production/P0-infra-decision.md)
- [`phase-2-production/P1-relay.md`](phase-2-production/P1-relay.md)
- [`phase-2-production/P2-pages.md`](phase-2-production/P2-pages.md)
- [`phase-2-production/P3-hardening.md`](phase-2-production/P3-hardening.md)
- [`phase-2-production/P4-sdk-open-source.md`](phase-2-production/P4-sdk-open-source.md)
- [`phase-2-production/P5-beta.md`](phase-2-production/P5-beta.md)
- [`phase-2-production/P6-games-hub.md`](phase-2-production/P6-games-hub.md)

### Games
- [`games/reaction-duel.md`](games/reaction-duel.md) — D7
- [`games/sumo-bumpers.md`](games/sumo-bumpers.md) — D7
- [`games/draw-and-guess.md`](games/draw-and-guess.md) — D7
- [`games/tilt-maze-race.md`](games/tilt-maze-race.md) — D7
- [`games/steering-wheel-racer.md`](games/steering-wheel-racer.md) — P6
- [`games/tank-arena.md`](games/tank-arena.md) — P6
- [`games/snake-royale.md`](games/snake-royale.md) — P6
- [`games/bluff-quiz.md`](games/bluff-quiz.md) — P6
- [`games/spy-in-the-room.md`](games/spy-in-the-room.md) — P6
- [`games/sword-swing-duel.md`](games/sword-swing-duel.md) — P6
- [`games/bomb-defusal.md`](games/bomb-defusal.md) — P6
- [`games/heist-planner.md`](games/heist-planner.md) — P6
- [`games/beat-tap.md`](games/beat-tap.md) — P6
- [`games/open-world-showcase.md`](games/open-world-showcase.md) — P6, gated
- [`games/hub.md`](games/hub.md) — D7 minimal launcher, P6 full hub

### Layers
- [`layers/protocol.md`](layers/protocol.md)
- [`layers/server.md`](layers/server.md)
- [`layers/runtime.md`](layers/runtime.md)
- [`layers/controller.md`](layers/controller.md)
- [`layers/games.md`](layers/games.md)
- [`layers/sdk.md`](layers/sdk.md)
- [`layers/tools.md`](layers/tools.md)
- [`layers/infra.md`](layers/infra.md)
- [`layers/docs-experiments.md`](layers/docs-experiments.md)

### Traceability and execution
- [`TRACEABILITY.md`](TRACEABILITY.md) — every requirement ID → layer → owning work item → goal → test tag.
- [`IMPLEMENTATION-ORDER.md`](IMPLEMENTATION-ORDER.md) — the stage-by-stage execution tracker and parallelism rules.

---

## 11. Open product questions and plan defaults

The spec's §22 questions, with the default this plan uses until answered.

| # | Question | Plan default | Must be answered by |
|---|---|---|---|
| 1 | Which TV(s), brand/year, are the real test devices? | D1 records whatever is available; assume at least one 2020-era Android TV/Chromium. | D1 |
| 2 | Is PC + HDMI an acceptable fallback if the TV browser fails E1–E3? | Yes; it is the spec's stated fallback. | D1 / Gate |
| 3 | One global brand domain, or custom domains later? | One domain (`vynkzhub.com`) for v1; custom hosting deferred. | P4 |
| 4 | Family-friendly mode default on or off? | Build the hook; default OFF in dev. Decide before public beta. | P3/P5 |
| 5 | Visual layout editor in SDK v1.1? | No editor in v1; JSON + `?layout=debug` only. | P4 |

**Unverified spec claims are verification tasks, not assumptions.** §22 items map to E1/E7/E8/E13 and the P0/P1 work; do not treat any as true until `docs/RESULTS.md` records a measurement.

---

## 12. Plan set at a glance

| Item | Count |
|---|---|
| Stage plans (D0–D7, Gate, P0–P6) | 16 |
| Game todos (14 games + hub) | 15 |
| Layer todos | 9 |
| Index + traceability | 2 |
| **Total files** | **42** |
| Stage-level work items (`###` headings) | 127 |
| Requirement / experiment / capability IDs mapped | 100+ |

**Start at [`phase-1-dev/D0-foundations.md`](phase-1-dev/D0-foundations.md).** Implementation began at `D0-REPO-01`; see [`IMPLEMENTATION-ORDER.md`](IMPLEMENTATION-ORDER.md) for the current wave. Do not skip D1's device probes, and do not start Phase 2 before the Dev Exit Gate signs GO.

If a spec requirement seems missing, check [`TRACEABILITY.md`](TRACEABILITY.md) first; if it is genuinely unowned, add the row and the owning work item before implementing.
