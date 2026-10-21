# Layer: Infra and Ops

**Paths:** deployment configs, DNS/TLS, environment variables, CI deploy jobs, dashboards, runbooks.
**Owns:** relay/pages hosting, regions, domains, TLS, production config, observability, cost, rollback, incident response.
**Must not own:** application logic, room/session semantics, game rules.
**Goal contribution:** G2 (region latency), G4 (capacity for 8-player rooms), G6 (TV-only production), G7 (cost/security/ops discipline).

## Invariants

1. One artifact per service promotes staging → production; only env values differ (FR-4.3).
2. No secrets in the repo or frontend bundle; env vars only.
3. One relay instance per region in v1; rooms are ephemeral; no cross-instance sharding.
4. TLS/WSS only in staging/production; HTTPS redirect at the edge.
5. Production origin allowlist is exact; CSP lists both relay HTTPS and WSS (A4, SR-8).
6. Logs/metrics contain no tokens, PINs, bodies, raw IPs, or PII (SR-7/9/12).
7. Rollback is tested; a failed health check blocks/rolls back.
8. Limits and alerts are config, not code; a kill switch exists for room creation.

## Todo index

| ID | Title | Stage | File |
|---|---|---|---|
| P0-OPS-01 | E13 synthesis | P0 | `phase-2-production/P0-infra-decision.md` |
| P0-OPS-02 | Relay host/region ADR | P0 | `phase-2-production/P0-infra-decision.md` |
| P0-OPS-03 | Pages/DNS ADR | P0 | `phase-2-production/P0-infra-decision.md` |
| P0-OPS-04 | Cost model/quotas/alerts | P0 | `phase-2-production/P0-infra-decision.md` |
| P0-ARCH-01 | Production config schema | P0 | `phase-2-production/P0-infra-decision.md` |
| P0-SEC-01 | Threat model/CSP plan | P0 | `phase-2-production/P0-infra-decision.md` |
| P0-PLAN-01 | Phase 2 entry/handoff | P0 | `phase-2-production/P0-infra-decision.md` |
| P1-SRV-04 | Relay deploy/staging/rollback | P1 | `phase-2-production/P1-relay.md` |
| P1-OPS-01 | Metrics/alerts/dashboard | P1 | `phase-2-production/P1-relay.md` |
| P2-INFRA-01..03 | Vercel build/routes/config/short URL | P2 | `phase-2-production/P2-pages.md` |
| P2-SEC-01 | CSP/headers/cache | P2 | `phase-2-production/P2-pages.md` |
| P2-OPS-01 | Pages deploy/rollback | P2 | `phase-2-production/P2-pages.md` |
| P3-OPS-01 | Privacy logging/retention/runbook | P3 | `phase-2-production/P3-hardening.md` |
| P4-OPS-01 | Public CI/release | P4 | `phase-2-production/P4-sdk-open-source.md` |
| P5-OPS-01 | Launch runbook/support/status | P5 | `phase-2-production/P5-beta.md` |

## Requirement coverage

| Requirement | Where |
|---|---|
| FR-4.1–4.3 | P0-ARCH-01, P2-INFRA-01/02 |
| FR-4.2 | P0-OPS-01/02 |
| FR-9.12 | P2-INFRA-03 |
| SR-7, SR-8 | P2-SEC-01, P3-OPS-01 |
| SR-9, SR-12 | P1-SRV-03, P3-OPS-01 |
| SR-11 | P1-SRV-03, P2-SEC-01 |
| G2/G6/G7 | P0–P5 |

## Verification

- E13 measurements → ADRs.
- Staging smoke, 50-room load, restart/rollback tests.
- CSP/header assertions against the deployed pages.
- Log/metrics scans for tokens/PII.
- P5 device/network gates.

## Change rules

- No production provisioning before P0 decisions are signed.
- No code fork for an environment; config only.
- New infrastructure requires a cost/security note and a rollback plan.
- Production load tests require a written plan and an off-peak window.
