# Dev Exit Gate

> **For agentic workers:** This is a review gate, not an implementation stage. Use `superpowers:verification-before-completion` and `superpowers:requesting-code-review` while gathering evidence. Do not write feature code here unless a blocking defect is found.
>
> **Goal:** Decide, in writing, whether Phase 1 proved the platform well enough to spend on Phase 2 — and hand P0 a measured budget and infrastructure recommendation.
>
> **Spec:** `SPEC.md` §14 Gate, §11, §16, §20, §22.
>
> **Rule:** Phase 2 does not start without a signed **GO**. A **CONDITIONAL GO** must list every condition as a dated work item in the owning D-stage. **NO-GO** returns to the failing stage; it is not a failure of the process.

## Gate inputs

| Input | Source | Required |
|---|---|---|
| E1–E17 results with device/OS/browser/numbers | `docs/RESULTS.md` | All 17 |
| Four proof-game Minimal checklists | `games/*.md`, `docs/RESULTS.md` | Complete |
| Per-game size/frame budgets | `docs/BUDGETS.md`, size gate | Complete |
| Device matrix | `docs/DEVICE-MATRIX.md` | §12 rows marked tested/not-tested |
| Security checklist | this file, SR-1..13 | Complete |
| TR-1 coverage report | `docs/TRACE-REPORT.md` | Zero missing IDs |
| E13 recommendation | `docs/RESULTS.md` | Written |
| Open defect list | issue tracker/plan files | Triaged |

## Gate decision template (fill in)

```md
## Decision

- Decision: GO | CONDITIONAL GO | NO-GO
- Date: 2026-10-21
- Commit: <sha>
- Signed off by: <name>

### Reasons
- ...

### Blocking conditions (for conditional go)
- [ ] <condition> — owner — due date — owning stage

### Accepted risks
- ... (with impact and mitigation)

### Budgets frozen (see docs/BUDGETS.md)
- Controller: <KB gz> (hard 60)
- Host + game initial: <MB gz> (hard 5)
- Input-to-canvas p95 dev: <ms> (target 25)
- Frame p95 TV: <ms>
- Memory: <MB> (70% of E2)
- WS RTT p95 LAN: <ms>
- Reconnect: <s>

### P0 inputs
- Recommended relay host/region: ...
- Recommended pages host: ...
- Estimated monthly cost at <rooms/day>: ...
- Open infra risks: ...
```

---

## Work items

### GATE-QA-01 — Experiment and proof-game completeness audit

| Field | Value |
|---|---|
| Layer | Docs/QA |
| Spec | §14 Gate, §20 |
| Depends on | D1–D7 |
| Unblocks | the rest of the Gate |
| Deliverables | populated `docs/RESULTS.md`, audit rows in this file |

**Checklist**

- [ ] E1: WebGL2/binary WS/extensions/audio per TV.
- [ ] E2: stable memory limit and 70% budgets.
- [ ] E3: frame benchmark at 720p/1080p.
- [ ] E4: LAN RTT p95 on 5 GHz (and 2.4 GHz comparison).
- [ ] E5: input-to-canvas p50/p95, camera + software.
- [ ] E6: display lag Game Mode on/off.
- [ ] E7: Android gyro units/axes/drift/secure context; iOS marked deferred.
- [ ] E8: vibration patterns at 20 Hz.
- [ ] E9: clock-sync timestamp error.
- [ ] E10: stroke bytes/s and delay.
- [ ] E11: TV audio latency, wired/Bluetooth.
- [ ] E12: renderer decision with numbers.
- [ ] E13: relay host/region comparison and cost.
- [ ] E14: mixed content/private network confirmation.
- [ ] E15: lifecycle recovery times.
- [ ] E16: keyboard handling.
- [ ] E17: 4 h soak memory/crashes.
- [ ] Each proof game Minimal checklist complete and linked.
- [ ] Every row has device, OS, browser version, date, method.

**Acceptance**

- [ ] Zero missing experiments; a genuinely blocked experiment has a written reason and a P0/P5 owner.
- [ ] No result is marked PASS without a number.
- [ ] The Gate document references the raw logs/screenshots.

**Tests (tagged)**

- `[E1]`–`[E17]` rows exist with measurements
- `[G2]` latency evidence is present
- `[G4]` eight-client evidence is present

**Anti-rework**

- Do not re-run experiments opportunistically during the Gate; use the recorded results.
- If a result is missing, return to its owning stage.

---

### GATE-PERF-01 — Freeze budgets from measurements

| Field | Value |
|---|---|
| Layer | Tools/CI + docs |
| Spec | §11, PR-11.2 |
| Depends on | GATE-QA-01 |
| Unblocks | P0, P5 |
| Deliverables | updated `docs/BUDGETS.md`, `tools/size-budget/budgets.json`, CI config |

**Checklist**

- [ ] Controller hard cap 60 KB gz; dev/prod targets confirmed.
- [ ] Host + initial game ≤ 5 MB hard; engine core target recorded.
- [ ] Input-to-canvas p95 dev target set from E5 (spec 25 ms; update only with evidence).
- [ ] Frame p95 target set from E3/E6 (14 ms at 60 Hz; 33 ms if 30 Hz panel).
- [ ] Memory budget set at 70% of E2 stable limit.
- [ ] Texture memory budget set from E2.
- [ ] WS RTT p95 target set from E4 (8 ms LAN).
- [ ] Reconnect target 1 s (hard 3 s) confirmed from E15.
- [ ] CI size gate uses the frozen numbers; a deliberate over-budget build fails.
- [ ] `SPEC.md` §11 numbers are unchanged or changes are recorded as an amendment.

**Acceptance**

- [ ] Every budget has a source (E-number or spec).
- [ ] CI enforces hard caps.
- [ ] P5 can compare production numbers against the same table.

**Tests (tagged)**

- `[PR-11.2]` memory hard-fail comes from E2
- `[G3]` size budgets are enforced
- `[G2]` latency budgets are recorded

**Anti-rework**

- One budget table for dev and production; no duplicate numbers in code.
- If a measurement is worse than the spec target, record either a remediation plan or a scope change; do not silently relax.

---

### GATE-ARCH-01 — Requirement coverage, layer boundaries and dependency audit

| Field | Value |
|---|---|
| Layer | Docs/architecture |
| Spec | §16 TR-1, §10, G7 |
| Depends on | GATE-QA-01 |
| Unblocks | P0 |
| Deliverables | `docs/TRACE-REPORT.md`, `docs/DEPENDENCIES.md` update, architecture notes |

**Checklist**

- [ ] Every FR/NR/PR/SR/AR/TR ID has at least one tagged test (trace checker green).
- [ ] No test tags an unknown ID.
- [ ] `runtime` does not import `controller` (ESLint).
- [ ] `games` import no server/controller packages.
- [ ] `protocol` has zero runtime dependencies.
- [ ] Dev and production clients differ only by config (no dev branches in game/runtime/controller).
- [ ] No game-specific code in broker/controller/runtime.
- [ ] Every dependency has a `docs/DEPENDENCIES.md` row with a justification and browser byte cost.
- [ ] Dead code/exports identified and either used or removed with approval.
- [ ] A1–A11 amendments are implemented or explicitly rejected.

**Acceptance**

- [ ] Trace report: 0 missing, 0 unknown.
- [ ] Layer rules hold by lint and by spot-check.
- [ ] Dependency table matches `package.json` files.

**Tests (tagged)**

- `[TR-1]` every requirement has a tagged test
- `[G7]` every dependency is justified
- `[FR-10.2]` runtime does not import controller

**Anti-rework**

- Fix violations in their owning stage; do not paper over them in the Gate.
- Keep the report generated, not hand-edited.

---

### GATE-SEC-01 — Security and privacy checklist

| Field | Value |
|---|---|
| Layer | Security |
| Spec | §13; SR-1..13 |
| Depends on | D0, D4, D5, D7 |
| Unblocks | P0 |
| Deliverables | completed checklist in this file, test references |

**Checklist**

- [ ] SR-1: 128-bit tokens; constant-time compare (test).
- [ ] SR-2: room token only in the fragment (test).
- [ ] SR-3: dev server prints LAN-only warning; binding documented (test).
- [ ] SR-4: PIN required for manual join; QR-PIN mode exists as a room field (test).
- [ ] SR-5: 5 join attempts/min/IP lockout (test).
- [ ] SR-6: 8 controllers; 64 B/4 KB frame caps close sockets (test).
- [ ] SR-7: no PII/analytics; no external requests from probes (test/manual).
- [ ] SR-8: dev CSP present; production CSP drafted (P2 completes).
- [ ] SR-9: logs contain no tokens/PINs/bodies (test + spot-check).
- [ ] SR-10: "Anyone with this code can join" notice (manual).
- [ ] SR-11: Origin allowlist on WS (test).
- [ ] SR-12: no message bodies persisted (code review).
- [ ] SR-13: UGC sanitized, not stored, filter hook planned (XSS suite).
- [ ] No secrets in repo/history (scan).
- [ ] Dependency audit: no high/critical known vulnerabilities in runtime deps; dev-only exceptions documented.

**Acceptance**

- [ ] Every SR has evidence (test name or manual note).
- [ ] Any exception is a dated, owned work item for P3.
- [ ] No token appears in logs during the D4 matrix or Gate runs.

**Tests (tagged)**

- `[SR-1]`…`[SR-13]` mapped to tests
- `[SR-7]` no analytics/PII
- `[SR-13]` UGC inert

**Anti-rework**

- P3 hardens; it does not discover basic issues for the first time.
- Production-only controls (CSP, proxy IPs) are explicitly deferred to P2/P3, not claimed here.

---

### GATE-OPS-01 — P0 inputs: infrastructure, cost and region

| Field | Value |
|---|---|
| Layer | Infra/ops + docs |
| Spec | §14 P0, §20 E13; FR-4.2 |
| Depends on | D7-EXP-01, GATE-PERF-01 |
| Unblocks | P0 |
| Deliverables | `docs/RESULTS.md` E13 recommendation, P0 entry checklist |

**Checklist**

- [ ] Relay candidates compared: Fly Mumbai/nearest, Cloudflare Durable Objects, managed realtime.
- [ ] RTT p50/p95 from the user's location; cold start; cost per 100 room-hours.
- [ ] WebRTC-on-TV note (not v1).
- [ ] Pages host assumption (Vercel) and the WSS limitation documented.
- [ ] Domain/DNS plan for `vynkzhub.com` and `relay.vynkzhub.com`.
- [ ] Room-affinity limitation (one instance per region) documented.
- [ ] Cost model at expected usage (e.g. 100 rooms/day, 8 players) with a free-tier/limit note.
- [ ] P0 entry checklist: accounts, billing, region, secrets handling, rollback.

**Acceptance**

- [ ] A recommended relay host and region with numbers, not vibes.
- [ ] Cost estimate and limits recorded.
- [ ] P0 can start without re-running E13.

**Tests (tagged)**

- `[FR-4.2]` regional relay choice is measured
- `[E13]` Mumbai-class RTT p95 < 25 ms or a documented alternative
- `[G6]` TV-only path remains viable

**Anti-rework**

- P0 is a decision/record stage; this item supplies its evidence.
- Do not provision infrastructure here.

---

### GATE-QA-02 — Full regression, soak and device matrix sign-off

| Field | Value |
|---|---|
| Layer | QA |
| Spec | §16, §14 Gate |
| Depends on | D4-QA-01, D7-QA-01, GATE-PERF-01 |
| Unblocks | Gate decision |
| Deliverables | signed matrix, regression log |

**Checklist**

- [ ] 4 h E17 soak with 8 bots; memory growth < 10%.
- [ ] Reconnect matrix from D4 passes after D5–D7 changes.
- [ ] All four proof games re-run on the actual TV and at least two phones.
- [ ] Device matrix §12 rows: tested / not-tested / deferred (iOS).
- [ ] No console errors on TV/phone during a 30-minute session.
- [ ] A clean clone builds and passes `npm run check`.
- [ ] CI is green on the Gate commit.

**Acceptance**

- [ ] Regression log lists every scenario and outcome.
- [ ] Any failure is a blocking condition or an accepted risk.
- [ ] The Gate commit is identified by SHA.

**Tests (tagged)**

- `[E17]` soak passes
- `[FR-5.4]` reconnect matrix passes
- `[G4]` 8-player stability
- `[TR-1]` CI green

**Anti-rework**

- Reuse the D4/D7 scripts; do not invent a new test plan at the Gate.
- Run the regression on the exact commit that will be tagged.

---

### GATE-DOC-01 — Written go/no-go and Phase 2 handoff

| Field | Value |
|---|---|
| Layer | Docs/ops |
| Spec | §14 Gate |
| Depends on | all Gate items |
| Unblocks | P0 |
| Deliverables | this file's Decision section, `docs/ADR-0002-dev-exit.md` |

**Checklist**

- [ ] Fill the decision template.
- [ ] List every blocking condition with owner/date if conditional.
- [ ] List accepted risks with impact/mitigation.
- [ ] Freeze budgets and link `docs/BUDGETS.md`.
- [ ] Record the E13 recommendation and P0 inputs.
- [ ] Record scope changes since spec v0.3 (iOS deferred, A1–A11).
- [ ] Write the production backlog: P0–P6, known debt, Full-game backlog.
- [ ] Sign and date; commit the Gate document.

**Acceptance**

- [ ] A reader can tell exactly what was proven, what was not, and what happens next.
- [ ] No "TBD" in the decision.
- [ ] P0's entry checklist is explicit.

**Tests (tagged)**

- `[G1]`–`[G8]` evidence summarized
- `[TR-1]` coverage summarized
- `[E1]`–`[E17]` status summarized

**Anti-rework**

- The Gate document is the Phase 2 contract; update it if P0 changes assumptions.
- Do not start P0 work items before the decision is GO/CONDITIONAL GO with conditions accepted.

---

## Gate exit checklist

- [ ] GATE-QA-01, GATE-PERF-01, GATE-ARCH-01, GATE-SEC-01, GATE-OPS-01, GATE-QA-02, GATE-DOC-01 complete.
- [ ] All E1–E17 recorded (or explicitly blocked with an owner).
- [ ] Four proof games at Minimal.
- [ ] Budgets frozen from measurements.
- [ ] TR-1 audit green.
- [ ] Security checklist complete.
- [ ] Decision written and signed: GO / CONDITIONAL GO / NO-GO.
- [ ] If GO, P0 entry checklist is ready.

## Explicitly not in the Gate

- Production deployment (P0–P2).
- New features or Full game versions.
- iOS work (A5).
- Re-running experiments without a documented reason.
