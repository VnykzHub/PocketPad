# Layer: Server

**Packages:** `packages/broker` (shared core), `packages/dev-server` (dev adapter), `packages/relay` (production adapter).
**Owns:** room lifecycle, codes/PIN/tokens, sessions/reservations, host loss, message fan-out, rate limits, WS transport, Origin allowlist, stats.
**Must not own:** game simulation, rendering, layout/panel interpretation, HTML pages in the broker.
**Goal contribution:** G1 (join), G2 (relay latency), G4 (8 controllers/reconnect), G5 (private routing/event fan-out), G6 (production path), G7 (security/limits).

## Invariants

1. One broker core for dev and production (A1); adapters add static/TLS/health only.
2. Broker never interprets game payloads; `event`/`panel` bodies are forwarded intact (FR-7.9).
3. Room state is in memory and ephemeral; no game state, no message bodies persisted (SR-12).
4. Tokens are 128-bit, constant-time compared, never logged (SR-1, SR-9).
5. Caps: 8 controllers, 64 B binary, 4 KB JSON, 30/s event burst 60, 20 Hz haptics, 2 s heartbeat/5 s dead.
6. One relay instance per region in v1; room affinity is a deployment constraint.
7. Origin allowlist is exact; production allows only the pages origin (SR-11).

## Todo index

| ID | Title | Stage | File |
|---|---|---|---|
| D0-SRV-01 | Dev static/LAN/warning/QR | D0 | `phase-1-dev/D0-foundations.md` |
| D0-SRV-02 | Broker room create/join/echo | D0 | `phase-1-dev/D0-foundations.md` |
| D0-SRV-03 | WS lifecycle/origin/heartbeat/close codes | D0 | `phase-1-dev/D0-foundations.md` |
| D4-SRV-01 | Tokens/PIN/constant-time/join rate limit | D4 | `phase-1-dev/D4-pairing-sessions.md` |
| D4-SRV-02 | Sessions/slots/reservations/expiry | D4 | `phase-1-dev/D4-pairing-sessions.md` |
| D4-SRV-03 | Host token/lost recovery/stats | D4 | `phase-1-dev/D4-pairing-sessions.md` |
| D5-SRV-01 | Opaque layout/panel/event routing + limits | D5 | `phase-1-dev/D5-layouts-events.md` |
| D6-SRV-01 | Haptic routing + 20 Hz limit | D6 | `phase-1-dev/D6-sensors-haptics.md` |
| P1-SRV-01 | Relay adapter on broker + CORS | P1 | `phase-2-production/P1-relay.md` |
| P1-SRV-02 | WSS/TLS/health/limits/shutdown | P1 | `phase-2-production/P1-relay.md` |
| P1-SRV-03 | Production origins/proxy/redaction/audit | P1 | `phase-2-production/P1-relay.md` |
| P1-SRV-04 | Deploy/staging/rollback | P1 | `phase-2-production/P1-relay.md` |
| P3-SEC-01 | Unified rate limits/abuse handling | P3 | `phase-2-production/P3-hardening.md` |
| P3-SEC-02 | PIN modes | P3 | `phase-2-production/P3-hardening.md` |
| P3-OPS-01 | Privacy-safe logs/retention | P3 | `phase-2-production/P3-hardening.md` |

## Requirement coverage

| Requirement | Where |
|---|---|
| FR-4.4 | D0-SRV-03 |
| FR-5.2–5.5 | D4-SRV-02 |
| FR-5.6 | D4-SRV-01 / D4-CTRL-01 |
| FR-7.8/7.9 | D5-SRV-01 |
| FR-7.14–7.16 | D4-SRV-03 / D0-SRV-03 |
| FR-8.11 | D6-SRV-01 |
| SR-1, SR-4, SR-5 | D4-SRV-01, P3-SEC-02 |
| SR-6 | D0-SRV-03, D5-SRV-01, P1-SRV-02 |
| SR-9, SR-12 | D0-SRV-03, P1-SRV-03, P3-OPS-01 |
| SR-11 | D0-SRV-03, P1-SRV-03 |
| PR-6.1 | D0-SRV-03 |
| G1/G2/G4 | D4 + P1 |

## Verification

- Broker unit tests with injected clock/RNG; fake peers.
- WS integration tests: origin, oversized frames, heartbeat, roles, joins.
- 8-bot stability and 50-room staging load (P1-QA-01).
- Log redaction tests after a full join/input session.
- Trace checker covers every requirement above.

## Change rules

- Room/session semantics change in `packages/broker` only; dev-server/relay are adapters.
- Never log tokens/PINs/bodies; add new audit events with redacted fields.
- Limits are config, not literals; P3 tunes them.
- A production-only behavior must be config-driven, not a code fork.
