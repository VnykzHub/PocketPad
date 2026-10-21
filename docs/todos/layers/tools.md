# Layer: Tools and CI

**Paths:** `tools/`, `.github/`, `experiments/`.
**Owns:** size-budget gate, input-bot, latency harness, trace checker, experiments runner, CI workflows.
**Must not own:** product behavior, game rules, server room logic.
**Goal contribution:** G1 (join/latency harness), G2 (latency harness), G3 (size gate), G4 (8-client bots), G7 (dependency/CI discipline), G8 (SDK dry-run tooling), TR-1.

## Invariants

1. Tools use the public protocol/SDK; they do not import product internals to "make it work".
2. CI runs the same commands developers run (`npm run check`); no CI-only behavior.
3. Budgets live in one config file; no hard-coded sizes in CI.
4. Test tags map to `TRACEABILITY.md`; the trace checker is the source of truth for TR-1.
5. Experiments never upload data or require analytics (SR-7).
6. Bots never print tokens/PINs; production load runs are opt-in and documented.
7. The latency harness measures tap→host canvas; display lag is measured separately.

## Todo index

| ID | Title | Stage | File |
|---|---|---|---|
| D0-TOOL-01 | input-bot skeleton | D0 | `phase-1-dev/D0-foundations.md` |
| D0-TOOL-02 | size-budget gate + CI | D0 | `phase-1-dev/D0-foundations.md` |
| D0-QA-01 | Test tags + trace checker | D0 | `phase-1-dev/D0-foundations.md` |
| D1-EXP-01 | Experiment host/results template | D1 | `phase-1-dev/D1-device-probes.md` |
| D1-EXP-02..05 | E1/E2/E3/E14 probes | D1 | `phase-1-dev/D1-device-probes.md` |
| D3-TOOL-01 | Latency harness (E5) | D3 | `phase-1-dev/D3-runtime-v0.md` |
| D4-TOOL-01 | 8-client bot/jitter/reconnect | D4 | `phase-1-dev/D4-pairing-sessions.md` |
| D5-EXP-01 | E10/E16 experiments | D5 | `phase-1-dev/D5-layouts-events.md` |
| D6-EXP-01 | E7/E8/swing experiments | D6 | `phase-1-dev/D6-sensors-haptics.md` |
| D7-EXP-01 | E13/E17 experiments | D7 | `phase-1-dev/D7-proof-games.md` |
| D7-PERF-01 | Per-game budgets | D7 | `phase-1-dev/D7-proof-games.md` |
| P1-TOOL-01 | Staging/production harness | P1 | `phase-2-production/P1-relay.md` |
| P1-QA-01 | Staging load/latency acceptance | P1 | `phase-2-production/P1-relay.md` |
| P4-OPS-01 | Public CI/release | P4 | `phase-2-production/P4-sdk-open-source.md` |
| P5-QA-02/03 | Production perf/stability | P5 | `phase-2-production/P5-beta.md` |

## Requirement coverage

| Requirement | Where |
|---|---|
| PR-11.1 | D3-TOOL-01, D7-EXP-01, P5-QA-02 |
| NR-6.1, NR-6.3 | D0-TOOL-02, D7-PERF-01 |
| TR-1 | D0-QA-01, GATE-ARCH-01 |
| G2/G3/G4/G7 | tools above |
| E1–E17 | experiments runner + RESULTS |

## Verification

- Tool unit tests with fixtures (over-budget file, missing tags, malformed macro).
- A deliberate over-budget build fails CI.
- A missing requirement tag fails CI.
- Staging/production harness runs are recorded, not ad-hoc.

## Change rules

- A new gate needs a test fixture that fails without it.
- Keep tools dependency-light; no framework for a CLI.
- Never make a production run part of CI; require an explicit flag/plan.
- Experiment results go to `docs/RESULTS.md`, not tool-local files.
