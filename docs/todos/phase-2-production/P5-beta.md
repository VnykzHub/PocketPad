# P5 — Production Beta Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Steps use checkbox syntax.
>
> **Goal:** Run a real beta on real TVs and phones, measure every §11 production gate, fix launch-blocking defects, and sign a production go/no-go. P6 does not start until this passes.
>
> **Architecture:** No new architecture. P5 exercises the deployed P1/P2/P3 system with the frozen P4 SDK, real devices, and real networks. Changes are fixes and config tuning only; no new features.
>
> **Tech stack:** Production relay/pages, latency harness, input-bot, manual device checklist, feedback form (no analytics).
>
> **Spec:** `SPEC.md` §11, §12, §14 P5, §16, §19; G1–G7; SR-7.
>
> **Program position:** Phase 2, after P3/P4. P6 starts only after P5-GATE-01 signs GO.

## Global constraints

- No analytics/tracking; beta feedback is explicit and manual (SR-7).
- Production targets from §11 are hard gates; display lag is measured but not gated.
- No new features during beta; fixes only, with a regression test.
- iOS remains out of scope (A5); note it in the beta scope.
- Do not run load tests against production without a written plan and off-peak window.
- All incidents are logged with time, impact, action, and follow-up.

---

## Stage goal and exit criteria

**Exit criteria (§14 P5):**

> Beta on real TVs and a spread of phones. All section 11 production gates pass.

Concretely:

- [ ] Beta cohort runs the proof games and hub on at least 2 TVs and 3+ phone models.
- [ ] Production gates in §11 pass (or a written exception is signed).
- [ ] Stability: 4 h soak and a 50-room load test on staging/production-like infrastructure.
- [ ] Failure injection: relay restart, network loss, host loss, phone kill — recover per spec.
- [ ] Accessibility checks pass (AR-3/4/5, remote operability).
- [ ] Runbook/rollback/support path is live.
- [ ] Production go/no-go signed.

**Layer coverage**

| Layer | Work items |
|---|---|
| QA | P5-QA-01..04 |
| Infra/ops | P5-OPS-01 |
| Decision | P5-GATE-01 |

**Goals advanced:** G1–G7 proven in production conditions.

---

## Work items

### P5-QA-01 — Beta cohort, device spread and feedback loop

| Field | Value |
|---|---|
| Layer | QA |
| Spec | §12, §14 P5; SR-7 |
| Depends on | P4-QA-01, P3-QA-01 |
| Unblocks | P5-QA-02..04 |
| Deliverables | beta plan, feedback form/template, device log |

**Cohort**

- 5–10 households, at least:
  - 2 TV models (the D1 TV + one different brand/year).
  - 3 phone models (Samsung/Pixel-class + a mid-range).
  - One non-engineer host to test the couch experience.
- Scenarios: QR join, manual join, 2-player and 8-player games, reconnect, host refresh, text/draw, gyro/fallback.
- Feedback: a simple form (device, browser, scenario, severity, notes). No analytics, no screen recording without consent.
- Record consent and keep PII out of the repo.

**Steps**

- [ ] Recruit the cohort; explain scope and privacy.
- [ ] Prepare a one-page test script per household.
- [ ] Collect feedback into a triage board with severity (blocker/major/minor).
- [ ] Reproduce blockers; file with device/browser/logs (redacted).
- [ ] Track fixes and re-test with the same household.
- [ ] Record the device matrix results.

**Acceptance**

- [ ] At least 2 TVs and 3 phones tested.
- [ ] Every blocker has a repro and a fix/decision.
- [ ] Feedback stored without PII.
- [ ] A non-engineer can host a session from the on-screen instructions.

**Tests (tagged)**

- `[G1]` real households join by QR in under 5 s
- `[G6]` TV-only host works in real homes
- `[SR-7]` beta feedback contains no analytics/PII
- `[FR-5.6]` manual join works for a non-scanner

**Anti-rework**

- The beta script becomes the launch checklist.
- Feedback themes feed P6 priorities, not ad-hoc features.

**Risks**

- Small cohort may miss device-specific bugs; include at least one weak/old TV.
- Friends may be too forgiving; ask for explicit failure reports.

---

### P5-QA-02 — Production performance gates (§11)

| Field | Value |
|---|---|
| Layer | QA |
| Spec | §11, PR-11.1, §14 P5; G2 |
| Depends on | P5-QA-01, P1-QA-01, D3-TOOL-01 |
| Unblocks | P5-GATE-01 |
| Deliverables | `docs/RESULTS.md` P5 perf rows |

**Gates**

| Metric | Prod target | Hard fail | Method |
|---|---|---|---|
| Controller JS gz | 50 KB | 60 KB | size gate |
| Controller TTI | 1.5 s (4G) | 3 s | throttled load |
| Host runtime + demo gz | 3.5 MB | 5 MB | size gate |
| Input-to-canvas p50 | 20 ms | — | E5 harness |
| Input-to-canvas p95 | 35 ms | 50 ms | E5 harness, 1000 taps |
| WS RTT p95 | 25 ms same region | 50 ms | input-bot |
| Host frame p95 | 14 ms | 20 ms | debug overlay/harness |
| Reconnect after Wi-Fi blip | 1 s | 3 s | manual/bot |
| Room setup to playable | 5 s | 10 s | G1 timing |
| Display lag | measure | not gated | E6 method |
| Host memory (TV) | from E2 | from E2 | devtools/overlay |

**Steps**

- [ ] Run the size gate on the release build; record.
- [ ] Run E5 with 1000 taps on the production URL from a real phone/TV; record p50/p95.
- [ ] Run WS RTT from a phone/PC in the target region; record p95.
- [ ] Measure frame p95 on the TV for each proof game.
- [ ] Measure reconnect and room setup 10 times; record median/p95.
- [ ] Measure display lag and audio latency; record advisory numbers.
- [ ] Compare against targets; file regressions.

**Acceptance**

- [ ] Every gated metric is measured on production infrastructure.
- [ ] All targets pass or a written exception is signed by the Gate.
- [ ] Measurements include device, network, region, commit.
- [ ] Display lag and audio are recorded separately.

**Tests (tagged)**

- `[G2]` input-to-canvas p95 < 35 ms prod
- `[PR-11.1]` latency harness used on the release candidate
- `[G3]` size budgets pass
- `[G1]` room setup < 5 s
- `[FR-7.13]` display lag is measured separately

**Anti-rework**

- Same harness/config as D3; no new measurement method.
- P6 uses these baselines for new games.

**Risks**

- Real networks are noisier than LAN; measure on 4G/5 GHz and record.
- TV display lag can dominate perception; include Game Mode advice.

---

### P5-QA-03 — Stability, load and failure injection

| Field | Value |
|---|---|
| Layer | QA |
| Spec | §16, §19; §14 P5 |
| Depends on | P1-QA-01, P5-QA-01 |
| Unblocks | P5-GATE-01 |
| Deliverables | stability report, incident log |

**Scenarios**

- 4 h soak: 8 bots, 30 ms jitter, alternating proof games; memory growth < 10%.
- Load: 50 rooms × 2 bots (or the approved cap); record CPU/mem/errors.
- Relay restart during a room: clients kicked; can create/join a new room; no crash.
- Network loss: 5 s Wi-Fi blip; reconnect same slot.
- Host loss: refresh within/after 30 s.
- Phone kill/restart: session recovery per D4.
- Slow TV: force dynamic resolution; no sim slowdown.
- Abuse: one slot floods events; others unaffected.

**Steps**

- [ ] Schedule load/restart tests off-peak with a written plan.
- [ ] Run the soak on staging/production-like; record memory every minute.
- [ ] Inject each failure; record recovery and user-visible state.
- [ ] Verify no cross-room impact.
- [ ] File any leak/crash as launch-blocking.
- [ ] Record results and the incident log.

**Acceptance**

- [ ] Soak growth < 10%, no crash/stuck room.
- [ ] Failure injection recovers per spec.
- [ ] Load test stays within CPU/mem headroom.
- [ ] No cross-room/slot impact from abuse.

**Tests (tagged)**

- `[E17]` 4 h soak passes on production-like infra
- `[FR-7.15]` reconnect after network loss < 1 s
- `[FR-7.16]` host loss/recovery works
- `[G4]` 8 players and 50 rooms behave
- `[FR-9.5]` slow TV triggers dynamic resolution

**Anti-rework**

- Failure scripts become the launch regression.
- P6 reuses the load harness.

**Risks**

- Production load tests can affect beta users; use staging or a maintenance window.
- Mobile networks drop more than Wi-Fi; test both.

---

### P5-QA-04 — Accessibility and remote-control audit

| Field | Value |
|---|---|
| Layer | QA |
| Spec | AR-3, AR-4, AR-5; §14 P5 |
| Depends on | D6-CTRL-04, D7-HUB-01, P3 |
| Unblocks | P5-GATE-01 |
| Deliverables | accessibility checklist, fixes |

**Checks**

- [ ] Every interactive phone control ≥ 44×44 CSS px.
- [ ] Haptics toggle reachable and persistent; no game requires haptics.
- [ ] Host launcher/lobby/results fully operable with arrow keys + Enter; visible focus.
- [ ] No keyboard traps; Back/Escape behavior sane.
- [ ] Text contrast on TV at couch distance; large type for code/PIN.
- [ ] Color is not the only signal (score/winner states).
- [ ] Controller labels/ARIA for screen readers are present (best effort; games are visual).
- [ ] Reduced-motion preference respected where feasible (optional, not a gate).
- [ ] Audio cues have visual equivalents for critical timing (e.g., Reaction Duel signal).

**Steps**

- [ ] Run the checklist on the TV + phones with a remote.
- [ ] Test one screen-reader pass on the controller join flow (Android TalkBack) as best effort.
- [ ] Fix blockers; record accepted limitations.
- [ ] Add accessibility items to the PR template.
- [ ] Record the checklist in `docs/RESULTS.md`.

**Acceptance**

- [ ] AR-3/4/5 pass.
- [ ] Remote-only host flow works end to end.
- [ ] Touch targets meet 44 px.
- [ ] Critical game signals have a visual or audio alternative.

**Tests (tagged)**

- `[AR-3]` haptics toggle works
- `[AR-4]` host remote-only flow works
- `[AR-5]` 44px targets
- `[G5]` graceful degradation is usable

**Anti-rework**

- The checklist is reused for every P6 game.
- Accessibility is a release gate, not a retrofit.

**Risks**

- Screen readers on TV browsers are limited; document best effort.
- Game visuals are inherently visual; focus on controls and critical signals.

---

### P5-OPS-01 — Launch runbook, support and incident response

| Field | Value |
|---|---|
| Layer | Infra/ops |
| Spec | §14 P5, §19; SR-7 |
| Depends on | P3-OPS-01, P1-OPS-01 |
| Unblocks | P5-GATE-01 |
| Deliverables | `docs/LAUNCH-RUNBOOK.md`, support channel, status plan |

**Contents**

- Deploy/rollback commands for relay and pages.
- Health checks and dashboards; alert thresholds.
- Incident severities and response steps (outage, abuse, token leak, data issue).
- Status communication: a simple page or pinned message; no email PII.
- Support: a GitHub issue template or a monitored inbox; response expectations.
- Beta feedback triage and release cadence.
- Kill switches: room creation, feature flags.
- Backup: none needed for ephemeral rooms; config/ADRs in the repo.
- On-call: document realistic response windows for the current team size.

**Steps**

- [ ] Write the runbook with exact commands/links.
- [ ] Create the support channel and issue template.
- [ ] Test rollback and kill switches.
- [ ] Define status update templates.
- [ ] Run a tabletop incident exercise.
- [ ] Record the launch checklist.

**Acceptance**

- [ ] Rollback tested in production/staging.
- [ ] Support channel is live and monitored.
- [ ] Incident steps are executable by one person.
- [ ] Status templates are ready.

**Tests (tagged)**

- `[FR-4.1]` launch/rollback keeps the TV path working
- `[SR-7]` support/status channels collect no unnecessary PII
- `[G7]` operational cost/alerts are documented

**Anti-rework**

- P6 launches use the same runbook; add game-specific notes only.
- No ad-hoc deploy scripts outside CI.

**Risks**

- Solo on-call can miss alerts; set conservative thresholds and a maintenance window.
- Status page may be overkill for v1; a pinned note is acceptable.

---

### P5-GATE-01 — Production go/no-go

| Field | Value |
|---|---|
| Layer | Decision |
| Spec | §14 P5; §11 |
| Depends on | P5-QA-01..04, P5-OPS-01 |
| Unblocks | P6 |
| Deliverables | `docs/ADR-0006-production-go.md` |

**Decision template**

```md
## Production readiness

- Decision: GO | CONDITIONAL GO | NO-GO
- Date: 2026-10-21
- Release commit: <sha>
- Beta cohort: <n> households, <tvs>, <phones>

### Gates
| Gate | Target | Measured | Pass |
|---|---|---|---|
| Controller gz | ≤50/60 KB | ... | ... |
| Input-to-canvas p95 | ≤35/50 ms | ... | ... |
| WS RTT p95 | ≤25/50 ms | ... | ... |
| Frame p95 | ≤14/20 ms | ... | ... |
| Reconnect | ≤1/3 s | ... | ... |
| Room setup | ≤5/10 s | ... | ... |
| Soak | <10% growth | ... | ... |
| Accessibility | AR-3/4/5 | ... | ... |

### Blockers
- ...

### Accepted limitations
- Display lag depends on TV Game Mode: ...
- iOS not supported: ...
- Single relay region: ...

### Launch checklist
- [ ] Rollback tested
- [ ] Support channel live
- [ ] Alerts live
- [ ] Docs updated
- [ ] P6 scope agreed
```

**Steps**

- [ ] Fill the table from P5-QA-02/03/04.
- [ ] List blockers; fix or accept.
- [ ] Confirm the launch checklist.
- [ ] Sign and date.
- [ ] If NO-GO, return to the failing work item and set a re-review date.

**Acceptance**

- [ ] Every gate has a measured number and pass/fail.
- [ ] No blocker is unowned.
- [ ] Accepted limitations are documented for users.
- [ ] P6 has a clear starting scope.

**Tests (tagged)**

- `[G1]`–`[G7]` production evidence summarized
- `[PR-11.1]` production latency gate passed
- `[AR-3]`/`[AR-4]`/`[AR-5]` accessibility passed
- `[E17]` soak passed

**Anti-rework**

- P6 does not reopen platform decisions; it adds games/hub within this envelope.
- Any post-launch regression reopens the relevant gate with a measured number.

**Risks**

- Pressure to launch can relax gates; the table makes that visible and signed.
- A small beta may not represent all phones; list accepted device gaps.

---

## Stage exit checklist

- [ ] P5-QA-01..04, P5-OPS-01, P5-GATE-01 complete.
- [ ] Beta on at least 2 TVs and 3 phones.
- [ ] All §11 production gates measured; pass or signed exception.
- [ ] Stability/load/failure injection passed.
- [ ] Accessibility checklist passed.
- [ ] Launch runbook/support live.
- [ ] Production go/no-go signed.
- [ ] `docs/RESULTS.md` P5 row complete.

## Handoff to P6

- P6 ships games/hub inside the proven envelope: same budget, same limits, same SDK.
- New games must not add platform code; if they do, it returns to the owning D-stage and is re-gated.
- The P5 device matrix and performance baselines are the P6 acceptance baseline.

## Explicitly not in P5

- New games or hub features (P6).
- iOS support (A5).
- Multi-region relay scaling (post-v1).
- New platform capabilities outside the frozen SDK.
