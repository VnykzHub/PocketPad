# Layer: Docs and Experiments

**Paths:** `docs/`, `experiments/`, ADRs, traceability.
**Owns:** RESULTS, DEVICES, BUDGETS, ADRs, testing policy, traceability, experiment pages, gate documents.
**Must not own:** product code, runtime behavior.
**Goal contribution:** G2/G3/G6 (measurement), G7 (decision evidence), G8 (SDK docs/dry run), TR-1 (coverage).

## Invariants

1. Every experiment row has device, OS, browser version, date, method, and a number. "Looks fine" is not a result.
2. Results are append-only; never overwrite a past measurement.
3. `TRACEABILITY.md` is the single requirement list; the trace checker enforces TR-1.
4. No PII/analytics in docs or probes; redact device IDs/IPs before publishing.
5. ADRs are short, numeric, and dated; they do not re-litigate signed decisions.
6. Spec wins on conflict; amendments are recorded in README §1.
7. Experiments are not shipped to production.

## Todo index

| ID | Title | Stage | File |
|---|---|---|---|
| D1-EXP-01 | Experiment host/results template | D1 | `phase-1-dev/D1-device-probes.md` |
| D1-EXP-02..05 | E1/E2/E3/E14 | D1 | `phase-1-dev/D1-device-probes.md` |
| D1-DOC-01 | Device inventory/results protocol | D1 | `phase-1-dev/D1-device-probes.md` |
| D1-BUDGET-01 | Provisional budgets | D1 | `phase-1-dev/D1-device-probes.md` |
| D1-QA-01 | Device matrix template | D1 | `phase-1-dev/D1-device-probes.md` |
| D3-EXP-01 | E5/E6/E11/E12 | D3 | `phase-1-dev/D3-runtime-v0.md` |
| D4-EXP-01 | E4/E9/E15/G1 | D4 | `phase-1-dev/D4-pairing-sessions.md` |
| D5-EXP-01 | E10/E16 | D5 | `phase-1-dev/D5-layouts-events.md` |
| D6-DOC-01 | Secure-context procedure/iOS note | D6 | `phase-1-dev/D6-sensors-haptics.md` |
| D6-EXP-01 | E7/E8/swing | D6 | `phase-1-dev/D6-sensors-haptics.md` |
| D7-EXP-01 | E13/E17 | D7 | `phase-1-dev/D7-proof-games.md` |
| GATE-QA-01..02 | Gate audits/regression | Gate | `phase-1-dev/GATE-dev-exit.md` |
| GATE-PERF/ARCH/SEC/OPS/DOC | Gate decisions | Gate | `phase-1-dev/GATE-dev-exit.md` |
| P0-OPS-02/03, P0-PLAN-01 | ADRs/entry | P0 | `phase-2-production/P0-infra-decision.md` |
| P4-DOCS-01/02 | README/license/protocol docs | P4 | `phase-2-production/P4-sdk-open-source.md` |
| P5-GATE-01 | Production go/no-go | P5 | `phase-2-production/P5-beta.md` |

## Requirement coverage

| Requirement | Where |
|---|---|
| E1–E17 | stage experiment rows |
| TR-1 | D0-QA-01, GATE-ARCH-01 |
| G2/G3/G4/G6/G7 | measurements/evidence |
| SR-7 | experiment/probe policy |
| A5 (iOS) | D6-DOC-01, README §2.3 |

## Verification

- RESULTS completeness audit at the Gate.
- Trace report: zero missing/unknown IDs.
- Device matrix reviewed for tested/not-tested/deferred.
- ADRs signed and linked from the stage files.

## Change rules

- A measurement that changes a budget updates `docs/BUDGETS.md` and the CI config together.
- A new experiment gets an ID (or an explicit auxiliary note if outside E1–E17) and a row.
- Never publish personal device names/IPs without redaction.
