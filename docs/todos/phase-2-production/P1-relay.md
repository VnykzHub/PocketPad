# P1 — Production Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Steps use checkbox syntax.
>
> **Goal:** Deploy the relay that already exists as `packages/broker` behind TLS/WSS with production security, observability, a staging environment, and load evidence. No room/session logic is rewritten.
>
> **Architecture:** `packages/relay` is a thin adapter: an HTTP server for `POST /api/rooms` and `/healthz`, a `ws` upgrade on `/ws`, and the shared broker core. TLS terminates at the platform/proxy; the relay reads `RelayConfig` from env and trusts proxy headers only when configured.
>
> **Tech stack:** Node.js LTS, `ws`, the shared broker, the chosen host from ADR-0003 (container or platform build), structured JSON logs, Prometheus-compatible metrics or platform metrics.
>
> **Spec:** `SPEC.md` §4.2, §5, §6.1, §13, §14 P1, §19; FR-4.1–4.3, FR-7.14–7.16, SR-1, SR-5, SR-8, SR-9, SR-11, SR-12; PR-6.1.
>
> **Program position:** Phase 2, after P0. P1 and P2 may run in parallel; both must pass staging before P3.

## Global constraints

- Relay holds room state and relays messages; it never simulates a game (FR-7.9).
- One relay instance per region in v1; rooms are not sharded across instances.
- TLS/WSS only in staging/production; no plain `ws://` public endpoint.
- Origin allowlist is exact (no `*`, no wildcards); production allows only the pages origin.
- Tokens/PINs/message bodies never appear in logs (SR-9, SR-12).
- Frame caps remain 64 B/4 KB; `setNoDelay(true)` on every socket (PR-6.1).
- No secrets in the repo; env vars only.
- iOS remains out of scope (A5).

---

## Stage goal and exit criteria

**Exit criteria (§14 P1):**

> Relay deployed (single instance per region first), HTTPS/WSS, origin allowlist, CSP.

Concretely:

- [ ] Staging relay is reachable at `wss://staging-relay...` and passes a smoke test.
- [ ] Production relay is deployed but not announced; beta traffic waits for P5.
- [ ] Origin allowlist rejects unknown origins; production allows only `https://vynkzhub.com`.
- [ ] 8 bots join, exchange input, reconnect, and survive a 30-minute run.
- [ ] Health/metrics endpoints work; logs contain no tokens/PINs/bodies.
- [ ] P1-QA-01 records RTT/CPU/memory at the expected load.

**Layer coverage**

| Layer | Work items |
|---|---|
| Server | P1-SRV-01..04 |
| Infra/ops | P1-OPS-01, P1-QA-01 |
| Tools | P1-TOOL-01 |

**Goals advanced:** G2 (regional latency), G4 (8 players at scale), G6 (TV-only production), G7 (secure, observable ops).

---

## Work items

### P1-SRV-01 — Relay application on the shared broker

| Field | Value |
|---|---|
| Layer | Server |
| Spec | §4.2, §4.5, §14 P1; A1; FR-4.1–4.3; FR-7.9 |
| Depends on | P0-ARCH-01, D0-SRV-02, D0-SRV-03 |
| Unblocks | P1-SRV-02..04 |
| Deliverables | `packages/relay/package.json`, `src/main.ts`, `src/config.ts`, `test/relay.test.ts` |

**Behavior**

- `packages/relay` imports `@lanpad/broker` and `@lanpad/protocol`; it adds no room logic.
- HTTP:
  - `POST /api/rooms` → broker `createRoom`, returns credentials; no cache; JSON.
  - `GET /healthz` → `{ ok: true, uptimeS, rooms, version }`; no secrets.
  - Everything else → 404 (no static files; pages are on Vercel).
- WS:
  - Upgrade only on `/ws`, via the shared `attachWebSocketServer`.
  - Origin allowlist from `RelayConfig`.
- Boot:
  - Parse env with `parseRelayConfig`; fail fast with a clear message on missing/invalid values.
  - Log one startup line with env, region, port (no secrets).
  - Handle `SIGTERM`/`SIGINT`: stop accepting upgrades, close rooms with `kick {reason:"shutdown"}`, close HTTP, exit within 10 s.
- No CORS headers on WS; **but** `POST /api/rooms` from `https://vynkzhub.com` to `https://relay.vynkzhub.com` is cross-origin, so add a strict CORS allowlist for that endpoint:
  - Only the pages origin, `POST`, `content-type`; `Vary: Origin`; no credentials.
  - Without this, production room creation fails even though CSP allows the fetch (A4).
- Room creation rate limit per IP (10/min) to blunt abuse (P3 can tune).
- The same binary runs in staging and production; only env differs.

**Steps**

- [ ] Create `packages/relay` with a thin HTTP+WS adapter and no copied broker code.
- [ ] Add strict CORS for `POST /api/rooms` (`allowedOrigins` exact, `POST`, `content-type`).
- [ ] Add `/healthz` with uptime/room count; no tokens.
- [ ] Add graceful shutdown: drain upgrades, kick rooms, close within 10 s.
- [ ] Add startup config validation and fail-fast tests.
- [ ] Add a smoke integration test: create room, hostJoin, 2 controllers, input echo.
- [ ] Verify the relay serves no static files and does not fall back to HTML.

**Acceptance**

- [ ] The relay talks to the same broker code as dev; no copy/paste.
- [ ] `POST /api/rooms` from the allowed pages origin succeeds; from another origin, CORS blocks it server-side.
- [ ] `/healthz` responds under 100 ms and leaks nothing.
- [ ] SIGTERM closes within 10 s and clients receive a kick.
- [ ] Missing `PUBLIC_ORIGIN`/`ALLOWED_ORIGINS` fails boot with a readable error.

**Tests (tagged)**

- `[A1]` relay reuses the shared broker core
- `[FR-4.2]` relay boots with region config
- `[SR-11]` origin allowlist is enforced for WS and CORS
- `[SR-8]` relay origin is the only cross-origin API allowed
- `[SR-9]` health/startup logs contain no secrets

**Anti-rework**

- Any room/session change goes into `packages/broker`, never the relay adapter.
- The adapter is intentionally boring; production hardening lives in config and infrastructure, not forked logic.

**Risks**

- Cross-origin `POST` needs CORS even though WS uses Origin; forgetting it breaks room creation in production.
- Proxy TLS termination means the relay sees `http`; do not redirect or assume the scheme internally.

---

### P1-SRV-02 — WSS, TLS, health checks, limits and graceful shutdown

| Field | Value |
|---|---|
| Layer | Server |
| Spec | §6.1, §7.4, §14 P1; PR-6.1, SR-6; FR-7.14 |
| Depends on | P1-SRV-01 |
| Unblocks | P1-SRV-04, P1-QA-01 |
| Deliverables | deployment config (Dockerfile/platform), `src/lifecycle.ts`, `test/limits.test.ts` |

**Behavior**

- TLS terminates at the platform/proxy; the relay listens on `PORT` over HTTP inside the private network. Never expose plain HTTP publicly.
- WSS upgrade path `/ws` only; health check at `/healthz` for the platform.
- Limits:
  - Max concurrent connections per IP (default 16; configurable).
  - Max total connections from provider capacity (configurable).
  - `maxPayload` 4096; binary > 64 B closes 1009; text > 4096 closes 1009.
  - Per-socket message rate: 120 msgs/s sustained; close 1008 on sustained abuse (P3 tunes).
  - Room/session limits from the broker (8 controllers, 30 s reservations).
- Keepalive: WS ping every 2 s, dead after 5 s (FR-7.14); `setNoDelay(true)`.
- Graceful shutdown:
  - Stop accepting upgrades.
  - Send `kick {reason:"shutdown"}` to all peers.
  - Close sockets after a short flush window (500 ms).
  - Close HTTP; exit 0. Force-exit after 10 s.
- Health check returns 200 only when the event loop is responsive; include `rooms` count.
- Restart behavior: rooms are ephemeral; clients reconnect with session/host tokens if the new instance is reachable. In practice, a restart loses rooms; document and rely on clients creating/joining anew.

**Steps**

- [ ] Configure the platform/proxy for TLS and WSS; enforce HTTPS redirect at the edge.
- [ ] Add connection caps per IP and globally; return 503 for HTTP room creation when saturated.
- [ ] Add the per-socket message rate guard with a close code and counter.
- [ ] Implement graceful shutdown and test it with open sockets.
- [ ] Add a test that a 65 B binary frame and a 4097 B text frame close with 1009.
- [ ] Verify `setNoDelay` is applied on every upgrade.
- [ ] Record a restart test: clients see a kick and can rejoin a new room.

**Acceptance**

- [ ] Public HTTP is redirected to HTTPS; plain WS is refused.
- [ ] A 17th connection from one IP is rejected/closed according to config.
- [ ] Oversized frames close with 1009; flood closes with 1008.
- [ ] SIGTERM drains within 10 s.
- [ ] Health check reflects room count and stays responsive under load.

**Tests (tagged)**

- `[PR-6.1]` all relay sockets use noDelay
- `[SR-6]` frame and message-rate limits hold in production mode
- `[FR-7.14]` dead sockets are detected within 5 s
- `[FR-7.16]` shutdown lets clients reconnect cleanly
- `[G4]` per-IP and global connection caps protect the relay

**Anti-rework**

- Limits are config-driven; P3/P5 tune numbers without code changes.
- The shutdown kick uses the existing message; no new lifecycle channel.

**Risks**

- Proxy buffering can hide a dead socket; rely on WS pings, not TCP alone.
- Per-IP caps can punish a school/hostel NAT; P5 monitors false positives and may raise the cap.

---

### P1-SRV-03 — Production security: origins, proxy trust, redaction and audit

| Field | Value |
|---|---|
| Layer | Server + security |
| Spec | §13; SR-1, SR-5, SR-9, SR-11, SR-12; §14 P1 |
| Depends on | P1-SRV-01, P0-SEC-01 |
| Unblocks | P3-SEC-01, P3-OPS-01 |
| Deliverables | `src/security/origin.ts`, `src/security/log.ts`, `test/security.test.ts` |

**Behavior**

- Origin allowlist:
  - Exact match only; no wildcards; normalize scheme/host/port.
  - Production: `https://vynkzhub.com` only (add `https://www...` only if it serves pages, redirect otherwise).
  - Staging: the staging pages origin.
  - Missing Origin on WS: reject in production; allow only in dev.
- CORS:
  - `POST /api/rooms` allows only the pages origin; `Vary: Origin`; no credentials.
  - Preflight `OPTIONS` handled with the same allowlist.
- Proxy trust:
  - `trustProxy=false` → use socket remote address.
  - `trustProxy=true` → use the platform's trusted header (`x-forwarded-for`/`cf-connecting-ip`) only from the known proxy; parse the first valid IP, validate it.
  - Never trust arbitrary client-supplied headers.
- Rate limits:
  - Join 5/min/IP lockout (broker, D4).
  - Room create 10/min/IP (relay).
  - Rejected attempts logged with reason and a hashed IP, never the token/PIN.
- Logging:
  - Structured JSON: timestamp, level, event, room code, slot, hashed IP, reason.
  - Never log layout/panel/event bodies, tokens, PINs, QR URLs, or raw IPs (hash with a per-environment salt).
  - Request logs exclude query strings and headers.
- Audit events: room.create, room.join, room.leave, room.expire, host.lost, host.resume, join.reject, limit.close. No bodies.

**Steps**

- [ ] Implement exact origin normalization/comparison and tests for case/port/scheme tricks.
- [ ] Implement CORS/preflight with `Vary: Origin`.
- [ ] Implement proxy IP extraction with an explicit trusted-header config and tests for spoofed headers.
- [ ] Implement the redacting logger and replace ad-hoc `console.log`.
- [ ] Add a test that scans captured logs for token/PIN patterns after a full join flow.
- [ ] Add room-create rate limiting with a token bucket.
- [ ] Document the audit event list.

**Acceptance**

- [ ] `http://vynkzhub.com`, `https://evil.com`, and a null origin are rejected in production.
- [ ] A spoofed `X-Forwarded-For` is ignored when `trustProxy` is false or the source is not the proxy.
- [ ] Logs contain room codes/slots but no tokens/PINs/bodies/QR URLs.
- [ ] CORS preflight succeeds only for the allowed origin.
- [ ] Room-create flooding is limited.

**Tests (tagged)**

- `[SR-11]` exact origin allowlist rejects tricks
- `[SR-5]` join/room-create rate limits hold behind a proxy
- `[SR-9]` audit logs never contain tokens or PINs
- `[SR-12]` message bodies are never logged
- `[SR-1]` token comparisons remain constant-time in production

**Anti-rework**

- One origin policy for WS and CORS; do not duplicate lists.
- P3 adds abuse handling on top of the same audit events.

**Risks**

- A misconfigured proxy header can collapse all clients to one IP and trigger global lockouts; test with a staging proxy.
- IPv6 normalization is easy to get wrong; use a library or a small tested helper, not regex alone.

---

### P1-SRV-04 — Deployment pipeline, staging/production and rollback

| Field | Value |
|---|---|
| Layer | Infra/ops |
| Spec | §14 P1, §19 room affinity; P0 ADR-0003 |
| Depends on | P1-SRV-01..03, P0-OPS-02 |
| Unblocks | P1-QA-01, P2/P3 |
| Deliverables | `.github/workflows/deploy-relay.yml` or platform CI, `deploy/` config, `docs/DEPLOY-RELAY.md` |

**Behavior**

- Build a deterministic artifact (Docker image or platform build) from the monorepo; only relay + broker + protocol in the runtime image (no games/controller assets).
- Environments:
  - Staging: separate app/region, staging origin allowlist, staging pages URL.
  - Production: `relay.vynkzhub.com`, production origin, one instance per region.
- Deploy:
  - CI: typecheck, test, build, size gate (server bundle not gated by the browser budget, but record), deploy staging on main, manual promotion to production.
  - Health check gates the deploy; rollback to the previous image on failure.
- Secrets: provider credentials only in CI; relay config via env; no secrets in image.
- Logs/metrics exported to the provider or a collector; retention per P3.
- Room affinity: single instance; do not enable autoscaling across instances in v1. Document the future route-by-room plan.
- Rollback: redeploy previous image; rooms lost (accepted for v1); clients reconnect/create.

**Steps**

- [ ] Write the relay Dockerfile/platform build with a multi-stage build and non-root user.
- [ ] Add CI deploy to staging on merge; manual approval for production.
- [ ] Add a post-deploy smoke test (create room, 2 clients, input, health).
- [ ] Add rollback steps and test them in staging.
- [ ] Configure one instance per region and disable cross-instance scaling.
- [ ] Document env vars, secrets, and the deploy/rollback runbook.
- [ ] Record the first staging deploy and its smoke result.

**Acceptance**

- [ ] A merge deploys staging automatically; production requires approval.
- [ ] A failed health check blocks/rolls back.
- [ ] The image contains no dev files, games, or controller assets.
- [ ] Rollback restores the previous working version.
- [ ] Room affinity limitation is documented.

**Tests (tagged)**

- `[FR-4.2]` staging and production run in the chosen region
- `[G7]` the relay image contains only server dependencies
- `[FR-7.16]` rollback behavior for live rooms is documented
- `[SR-9]` deploy logs contain no secrets

**Anti-rework**

- The same artifact promotes staging → production; env differs only.
- Do not add a second relay implementation for staging.

**Risks**

- Cold starts on scale-to-zero can hurt G1; keep one warm instance or measure cold start.
- Free tiers may sleep; disable sleeping for staging during tests.

---

### P1-OPS-01 — Observability: metrics, alerts and dashboards

| Field | Value |
|---|---|
| Layer | Infra/ops |
| Spec | §11, §19; G4, G7 |
| Depends on | P1-SRV-02/04, P0-OPS-04 |
| Unblocks | P3-OPS-01, P5 |
| Deliverables | metrics endpoint or platform dashboard, `docs/OBSERVABILITY.md`, alert config |

**Metrics**

```md
relay_connections{state=open|closed}
relay_rooms{state=active|hostLost}
relay_players{slot_state=active|reserved}
relay_messages_total{type=input|json|binary|dropped}
relay_ws_rtt_ms{quantile=0.5|0.95}
relay_errors_total{kind=protocol|limit|auth|internal}
process_cpu_seconds_total, process_resident_memory_bytes
```

- No tokens, PINs, IPs, or room codes as metric labels (high cardinality/PII). Room codes only in logs.
- Alerts:
  - Error rate > 1% for 5 min.
  - p95 WS RTT > 25 ms for 10 min in-region.
  - Connections > 80% of cap.
  - Memory > 80% of plan.
  - No healthy instance for 1 min.
- Dashboard: rooms, players, connection churn, message rate, drops, RTT, CPU/mem, cost estimate.
- Keep logs and metrics retention aligned with P3's privacy policy.

**Steps**

- [ ] Expose metrics or configure the platform's equivalent; ensure labels are low-cardinality.
- [ ] Add counters for drops by reason (backpressure, rate limit, invalid slot).
- [ ] Create the dashboard and alerts per P0's thresholds.
- [ ] Test alerts in staging (synthetic error/load).
- [ ] Document on-call basics and the dashboard link.
- [ ] Verify no PII/tokens in metrics or logs.

**Acceptance**

- [ ] Metrics show rooms/players/connections and message/drop rates.
- [ ] Alerts fire in staging for a synthetic error and a load spike.
- [ ] No token/PIN in metrics or logs.
- [ ] The dashboard answers: is it healthy, how many rooms, where is latency.

**Tests (tagged)**

- `[G4]` capacity and connections are observable
- `[G2]` RTT/drops are observable
- `[SR-7]` metrics contain no PII/tokens
- `[SR-9]` log redaction holds under load

**Anti-rework**

- P5 reuses the dashboard; add panels, not a second stack.
- Metrics names are stable; document them.

**Risks**

- High-cardinality labels (room code, IP) will blow up metrics; forbid them.
- Provider log retention may be short; export critical audit events if needed (P3).

---

### P1-QA-01 — Staging load, reconnect, origin and latency acceptance

| Field | Value |
|---|---|
| Layer | QA |
| Spec | §14 P1, §16, §20 E4/E15 |
| Depends on | P1-SRV-01..04, P1-TOOL-01 |
| Unblocks | P3 |
| Deliverables | `docs/RESULTS.md` P1 row, load report |

**Scenarios**

- [ ] 8 bots join, hold slots 30 min, reconnect every 60 s; no lost slot.
- [ ] 50 rooms × 2 bots concurrently (resource/capacity smoke; record limits).
- [ ] Wrong origin rejected; allowed origin accepted for WS and CORS.
- [ ] Oversized frames/messages close correctly.
- [ ] Host drop/reload within 30 s resumes; after 30 s expires.
- [ ] RTT p50/p95 from the user's location to staging; compare E13 prediction.
- [ ] CPU/memory at 10/50 rooms; record headroom.
- [ ] Graceful restart: clients kicked, can rejoin a new room.

**Steps**

- [ ] Run the input-bot against staging with the scenarios; capture JSON summaries.
- [ ] Run a small load script (rooms × bots) and record CPU/mem/connections.
- [ ] Measure RTT from the user's network; compare with E13.
- [ ] Test origin/CORS/frame caps with raw clients.
- [ ] Record all results with date, region, instance size, commit.
- [ ] File capacity/headroom notes for P5.

**Acceptance**

- [ ] 8-bot 30-min stability passes.
- [ ] 50-room smoke passes without errors (or the limit is recorded).
- [ ] Origin/CORS/frame tests pass.
- [ ] Staging RTT is within the E13 range.
- [ ] Headroom at expected load is recorded.

**Tests (tagged)**

- `[G4]` 8 bots stable on staging for 30 minutes
- `[SR-11]` production origin policy works in staging
- `[SR-6]` frame/message limits work on staging
- `[E13]` staging RTT matches the measured region
- `[FR-7.16]` host recovery works on staging

**Anti-rework**

- These scripts are reused by P5 with production endpoints.
- Load numbers feed P0's cost model; update if the model was wrong.

**Risks**

- Staging may share resources with production on some hosts; record instance size.
- 50 rooms × 2 bots from one machine is client-limited, not relay-limited; separate the two.

---

### P1-TOOL-01 — Harness against staging/production

| Field | Value |
|---|---|
| Layer | Tools |
| Spec | §10, §16; PR-11.1 |
| Depends on | P1-SRV-04, D4-TOOL-01, D3-TOOL-01 |
| Unblocks | P1-QA-01, P5-QA-02 |
| Deliverables | `tools/input-bot` `--wss` support, `tools/latency-harness` staging mode |

**Behavior**

- Input-bot accepts `wss://` endpoints with a valid Origin header (configurable) and no PIN logging.
- Latency harness can point at staging pages + relay; logs stay local.
- Add `--origin` to the bot for origin tests and `--insecure` only for self-signed staging (not production).
- Add a `--summary-json` output for automation.
- Document the production run procedure and safety limits (don't flood prod; use a staging or a dedicated room).

**Steps**

- [ ] Add WSS/origin options to the bot; test against staging.
- [ ] Add a staging mode to the latency harness.
- [ ] Add summary JSON and CI-friendly exit codes.
- [ ] Document safe production testing (small runs, off-peak, kill switch).
- [ ] Record a staging run.

**Acceptance**

- [ ] Bot connects to staging over WSS with the allowed Origin.
- [ ] An unknown Origin is rejected.
- [ ] Latency harness works against staging.
- [ ] No token/PIN in bot output.

**Tests (tagged)**

- `[PR-11.1]` harness runs against staging/production
- `[SR-11]` bot can exercise the origin allowlist
- `[G4]` bot load works over WSS

**Anti-rework**

- One tool for dev/staging/prod; config selects the endpoint.
- Keep production runs opt-in; never run in CI by default.

**Risks**

- WSS latency includes TLS setup per connection; measure after connection, not connect time.
- Production load tests can be abused; gate behind a flag and a written plan.

---

## Stage exit checklist

- [ ] P1-SRV-01..04, P1-OPS-01, P1-QA-01, P1-TOOL-01 complete.
- [ ] Staging relay live over WSS with the shared broker.
- [ ] Production relay deployed but not announced.
- [ ] Origin/CORS/proxy/redaction tests pass.
- [ ] 8-bot 30-min stability and 50-room smoke recorded.
- [ ] Metrics/alerts/dashboard live.
- [ ] Rollback tested.
- [ ] `docs/RESULTS.md` P1 row complete.

## Handoff to P2/P3

- P2 points pages at the staging relay and then production; A4 CSP includes both origins.
- P3 tunes rate limits and abuse handling using P1's metrics and logs.
- Do not change broker semantics in P2/P3.

## Explicitly not in P1

- Pages/Vercel (P2).
- Beta traffic (P5).
- Multi-instance relay sharding (post-v1).
- Persistence of rooms across restarts (v1 rooms are ephemeral).
- iOS work (A5).
