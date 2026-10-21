# P0 — Infrastructure Decision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Steps use checkbox syntax.
>
> **Goal:** Turn the Dev Exit Gate's measurements into signed infrastructure decisions: relay host and region, pages host, domains/DNS, production config, cost model, and a public-internet threat model.
>
> **Architecture:** Pages stay static on Vercel at `vynkzhub.com`; the relay runs a persistent Node process on a host with a Mumbai-class region at `relay.vynkzhub.com`. Both read a shared production config; clients differ only by origin. No application logic changes in P0.
>
> **Tech stack:** Fly.io / Cloudflare Durable Objects / managed realtime (choose one), Vercel, DNS/TLS, environment variables, ADRs.
>
> **Spec:** `SPEC.md` §4.2, §14 P0, §18, §19 relay caveats, §20 E13; FR-4.1–4.3, SR-8, SR-11.
>
> **Program position:** Phase 2, first stage. P1 and P2 may run in parallel after P0, but neither starts before the decisions are signed.

## Global constraints

- No production provisioning in P0 beyond accounts/quotas needed to validate the decision.
- One relay instance per region in v1; room affinity is a known limitation.
- Pages and relay are different origins; CSP and Origin allowlists must account for both.
- No secrets in the repo; config is environment-driven.
- iOS remains out of scope (A5).

---

## Stage goal and exit criteria

**Exit criteria (§14 P0):**

> Infra decision from E13 data: relay host and region, Vercel pages, domain and DNS.

Concretely:

- [ ] `docs/ADR-0003-relay.md` signed with host, region, cost, limits, and rejected alternatives.
- [ ] `docs/ADR-0004-pages-dns.md` signed with pages host, domains, TLS, DNS, rollback.
- [ ] Production config schema and dev/staging/prod matrix documented.
- [ ] Cost model and quotas recorded; alerts identified.
- [ ] Public-internet threat model and CSP/origin plan documented.
- [ ] P1 and P2 entry checklists are ready.

**Layer coverage**

| Layer | Work items |
|---|---|
| Infra/ops | P0-OPS-01..04, P0-PLAN-01 |
| Architecture/config | P0-ARCH-01 |
| Security | P0-SEC-01 |

**Goals advanced:** G2 (region latency), G6 (TV-only production), G7 (cost/dependency discipline).

---

## Work items

### P0-OPS-01 — E13 synthesis: relay candidates

| Field | Value |
|---|---|
| Layer | Infra/ops |
| Spec | §14 P0, §20 E13; FR-4.2; §19 relay caveats |
| Depends on | D7-EXP-01 |
| Unblocks | P0-OPS-02 |
| Deliverables | `docs/RESULTS.md` E13 comparison table, `docs/ADR-0003-relay.md` draft |

**Candidates to compare**

| Candidate | Region | Why consider | Watch |
|---|---|---|---|
| Fly.io (Node app) | Mumbai (`bom`) or nearest | Long-lived process, simple `ws`, cheap at low scale | Cold start, single-instance affinity |
| Cloudflare Durable Objects | Mumbai/auto | Per-room object affinity, global edge | Runtime constraints, pricing model, Node compatibility |
| Managed realtime (Ably/Pusher-class) | Multi-region | Ops burden low | Cost, vendor lock-in, message size/rate limits |
| Railway/Render | Singapore/Mumbai if available | Simple deploy | Region distance, cold starts |

**Record per candidate**

- RTT p50/p95 from the user's location (E13 method) to the region.
- Cold start / connection setup time.
- Cost per 100 room-hours and at 100 rooms/day (inputs/events/bandwidth).
- WSS support, max connections, message size, idle timeouts.
- Ops: deploy, logs, metrics, scaling, region availability.
- Whether WebRTC works on the TV (note only; v1 uses WS).

**Steps**

- [ ] Reuse the E13 measurement script; run each candidate from the same network/location.
- [ ] Record raw samples and percentiles in `docs/RESULTS.md`.
- [ ] Compute cost with the E13 traffic model (see P0-OPS-04).
- [ ] Write a comparison table with a recommendation and rejected reasons.
- [ ] Note the room-affinity limitation for each candidate.

**Acceptance**

- [ ] At least two candidates have comparable RTT and cost numbers.
- [ ] The Mumbai-class p95 < 25 ms criterion is marked pass/fail per candidate.
- [ ] The recommendation names one host and one region.
- [ ] Raw logs are referenced, not just summaries.

**Tests (tagged)**

- `[FR-4.2]` relay region RTT is measured from the user location
- `[E13]` candidates are compared on RTT, cold start and cost
- `[G2]` the chosen region keeps the latency floor within budget

**Anti-rework**

- This table is the only input to P0-OPS-02; do not re-run E13 in P1.
- Cost assumptions are shared with P0-OPS-04, not duplicated.

**Risks**

- Free tiers may throttle long-lived sockets; record limits before committing.
- The user's network may differ from beta users; note the location.

---

### P0-OPS-02 — Relay host and region decision (ADR)

| Field | Value |
|---|---|
| Layer | Infra/ops |
| Spec | §14 P0/P1, §18, §19; FR-4.2 |
| Depends on | P0-OPS-01 |
| Unblocks | P1-SRV-01..04 |
| Deliverables | `docs/ADR-0003-relay.md` |

**ADR contents**

- Decision: host, region, instance count (one per region in v1), runtime (Node LTS), process model.
- Alternatives rejected with numbers.
- Room affinity: one instance per region; how rooms are routed (single host) and what breaks at scale.
- Cold start and keep-warm policy (if applicable).
- TLS/WSS termination (managed vs proxy), health endpoint, graceful shutdown.
- Cost estimate and quotas.
- Rollback: deploy previous image, DNS unchanged; data loss on restart (rooms are ephemeral) and how clients recover.
- Open risks: provider outage, region latency, connection limits.

**Steps**

- [ ] Fill the ADR from P0-OPS-01 data.
- [ ] State the v1 scaling model explicitly: one relay process per region, no horizontal relay scaling.
- [ ] Define the deploy artifact (container image or platform build) and runtime version.
- [ ] Define the health endpoint and the deploy smoke test.
- [ ] Get sign-off (even if self-signed) and date it.

**Acceptance**

- [ ] One host/region is chosen with numbers.
- [ ] Room-affinity limitation is documented.
- [ ] Cost and quotas are stated.
- [ ] P1 can implement without re-deciding.

**Tests (tagged)**

- `[FR-4.2]` chosen region is nearest to the user base
- `[E13]` decision cites measured RTT/cost
- `[FR-7.16]` restart/data-loss behavior is documented for host recovery

**Anti-rework**

- P1 treats this ADR as fixed; changing hosts later is a new ADR.
- Keep the relay container/platform-agnostic where possible (Node + env config).

**Risks**

- A provider's Mumbai region may be unavailable at signup; choose the nearest with measured numbers and record it.

---

### P0-OPS-03 — Pages, domain and DNS decision (ADR)

| Field | Value |
|---|---|
| Layer | Infra/ops |
| Spec | §4.2, §14 P0/P2; FR-4.1, FR-9.12, SR-8 |
| Depends on | P0-OPS-01 |
| Unblocks | P2-INFRA-01..03 |
| Deliverables | `docs/ADR-0004-pages-dns.md` |

**ADR contents**

- Pages host: Vercel (assumed); project structure (one project with routes, or separate host/controller projects).
- Domains: apex `vynkzhub.com`, `www` redirect, `relay.vynkzhub.com`.
- TLS: Vercel-managed cert for pages; relay host/termination for `relay`.
- DNS records: A/CNAME/AAAA, TTL, propagation.
- Short TV URL: `vynkzhub.com/tv` → host page; root `/` may also serve the host.
- Controller URL: `vynkzhub.com/c/<CODE>`.
- Cache policy: HTML no-cache, hashed assets immutable; relay not cached.
- Rollback: redeploy previous Vercel build; DNS TTL.
- Region/CDN behavior for India.

**Steps**

- [ ] Confirm Vercel's WebSocket limitation for the relay (it cannot host the relay; keeps the split).
- [ ] Define the route map for pages.
- [ ] Define DNS records and TTLs.
- [ ] Define the TLS plan and renewal ownership.
- [ ] Write the rollback steps.
- [ ] Get sign-off and date it.

**Acceptance**

- [ ] Domains and routes are explicit.
- [ ] TLS ownership is explicit.
- [ ] Rollback is a concrete sequence.
- [ ] The short TV URL is decided.

**Tests (tagged)**

- `[FR-4.1]` pages host can serve the host with no local process
- `[FR-9.12]` short TV URL is defined
- `[SR-8]` pages/relay origins are listed for CSP

**Anti-rework**

- The route map matches the Dev server's routes (`/`, `/c/*`, `/games/*`) so builds are reused.
- P2 implements this ADR; no new decision.

**Risks**

- DNS propagation can take hours; plan a staging domain first.
- Apex vs `www` certificate quirks; use Vercel's recommended setup.

---

### P0-ARCH-01 — Production config schema and environment matrix

| Field | Value |
|---|---|
| Layer | Architecture/config |
| Spec | §4.2/4.3, §14 P0; FR-4.3, FR-4.6 |
| Depends on | P0-OPS-02/03 |
| Unblocks | P1-SRV-01, P2-INFRA-02 |
| Deliverables | `sdk/src/config.ts` (extended types), `docs/CONFIG.md`, `.env.example` |

**Freeze this schema**

```ts
export interface PublicConfig {
  env: "dev" | "staging" | "production";
  publicOrigin: string;      // pages origin, e.g. https://vynkzhub.com
  relayOrigin: string;       // https://relay.vynkzhub.com
  wsOrigin: string;          // wss://relay.vynkzhub.com
  region: string;            // e.g. "bom"
  requirePinForQr: boolean;  // room default; P3 toggles per room
}

export interface RelayConfig {
  env: "dev" | "staging" | "production";
  port: number;
  allowedOrigins: string[];
  trustProxy: boolean;
  logLevel: "debug" | "info" | "warn" | "error";
  heartbeatMs: number;
  deadAfterMs: number;
  reservationMs: number;
  roomIdleMs: number;
  roomMaxLifeMs: number;
}
```

**Environment matrix**

| Value | dev | staging | production |
|---|---|---|---|
| publicOrigin | LAN URL | staging pages URL | `https://vynkzhub.com` |
| relayOrigin | same as pages | staging relay | `https://relay.vynkzhub.com` |
| wsOrigin | same-origin `ws://` | `wss://staging-relay...` | `wss://relay.vynkzhub.com` |
| allowedOrigins | LAN + localhost | staging pages | `https://vynkzhub.com` only |
| trustProxy | false | true | true |
| logLevel | debug | info | info |

**Rules**

- Clients read `PublicConfig` from build-time env; no literals.
- Relay reads `RelayConfig` from environment variables at boot; fails fast on missing values.
- `requirePinForQr` default false in v1; P3 exposes the room toggle.
- No secret values in `PublicConfig`; nothing secret is needed for v1 except provider credentials held by CI/deploy.
- `.env.example` lists every variable with a placeholder; `.env*` is gitignored.

**Steps**

- [ ] Extend `sdk/src/config.ts` with the types and a `parsePublicConfig` validator.
- [ ] Write `docs/CONFIG.md` with the matrix and fail-fast behavior.
- [ ] Add `.env.example` for relay/pages build vars.
- [ ] Add tests for missing/invalid config and origin normalization.
- [ ] Ensure the dev server still works with same-origin defaults (no env required).
- [ ] Add a build-time check that production builds contain no LAN/localhost origins.

**Acceptance**

- [ ] The same client build works in staging and production with only env values changed.
- [ ] Relay boot fails with a clear error if `allowedOrigins` or origins are missing.
- [ ] No origin literal exists outside config files.
- [ ] `.env.example` is complete and safe.

**Tests (tagged)**

- `[FR-4.3]` client code is origin-configurable, not rebuilt
- `[FR-4.6]` users never configure transport
- `[SR-11]` production allowed origins are explicit
- `[SR-8]` CSP origins derive from config

**Anti-rework**

- One schema for P1/P2/P5; no duplicate config modules.
- `PublicConfig` is safe to expose; `RelayConfig` is server-only.

**Risks**

- Vite env variables are embedded at build time; changing a domain means a redeploy. Document.
- `trustProxy` misconfiguration can break rate limits; P1 tests it.

---

### P0-OPS-04 — Cost model, quotas and alerts

| Field | Value |
|---|---|
| Layer | Infra/ops |
| Spec | §11, §19; G7 |
| Depends on | P0-OPS-01/02 |
| Unblocks | P1-OPS-01, P5 |
| Deliverables | `docs/COST.md`, alert thresholds |

**Traffic model**

```md
Per controller input: 26 B at 60 Hz max + WS framing ≈ 2 KB/s.
8 controllers per room ≈ 16 KB/s (input only).
Panels/events: ≤ 4 KB per message, 30/s per slot worst case ≈ 120 KB/s; typical much lower.
100 concurrent rooms ≈ 1.6 MB/s input; ~4 TB/month if continuously busy.
Use typical duty cycle (e.g. 20%) and record both peak and typical.
```

**Checklist**

- [ ] Compute bytes/room-hour at idle (10 Hz) and active (60 Hz), 8 controllers.
- [ ] Add panel/event typical and worst-case estimates.
- [ ] Price egress, compute, and any per-connection fees per candidate.
- [ ] Record free-tier limits and the first paid threshold.
- [ ] Define alerts: cost > X/month, concurrent rooms > Y, bandwidth > Z, error rate.
- [ ] Record a monthly budget and a limit/kill switch (e.g. connection cap) for abuse.

**Acceptance**

- [ ] A cost table per candidate at 10/100/1000 rooms/day.
- [ ] The assumptions are explicit and testable.
- [ ] Alert thresholds are concrete.
- [ ] The chosen host's cost is within the stated budget at expected usage.

**Tests (tagged)**

- `[G7]` infrastructure cost is quantified
- `[G4]` cost model uses 8 controllers/room
- `[E13]` candidate costs are comparable

**Anti-rework**

- P5 uses the same model with real usage; update the table, not the method.
- Keep the traffic constants in one document.

**Risks**

- Bandwidth pricing often dominates; do not model only compute.
- Worst-case event floods are bounded by rate limits; use those, not unbounded.

---

### P0-SEC-01 — Public-internet threat model and production security plan

| Field | Value |
|---|---|
| Layer | Security |
| Spec | §13, SR-1..13; §19 caveats |
| Depends on | P0-ARCH-01 |
| Unblocks | P1-SRV-03, P2-SEC-01, P3 |
| Deliverables | `docs/THREAT-MODEL.md`, security plan section |

**Threats**

| Threat | Vector | Mitigation | Owner |
|---|---|---|---|
| Room code guessing | 20-bit code | PIN/token required, 5/min/IP lockout, no code-only join | D4/P3 |
| Token leakage | URL/logs/referrer | Fragment only, no token logs, no third-party scripts | D4/P3 |
| Join flooding | Many sockets/attempts | Rate limits, connection caps, origin allowlist | P1/P3 |
| Frame abuse | Oversized/malformed frames | 64 B/4 KB caps, close socket, per-socket msg rate | D0/P3 |
| UGC abuse | Drawings/text | Sanitize, room-only, filter hook, no storage | D5/P3 |
| XSS | Panel/text/render | textContent, allowlisted images, CSP | D5/P2 |
| Origin spoofing | WS Origin header | Allowlist, `trustProxy` correctness | D0/P1 |
| Relay DoS | Connection exhaustion | Provider limits, per-IP caps, graceful degradation | P1/P3 |
| Supply chain | npm deps | Minimal deps, lockfile, audit, pinned versions | P4 |
| Privacy | Logs/analytics | No PII, no analytics, redacted logs | P3 |

**Production CSP draft (A4)**

```
default-src 'self';
connect-src 'self' https://relay.vynkzhub.com wss://relay.vynkzhub.com;
img-src 'self' data:;
media-src 'self';
script-src 'self';
style-src 'self';
font-src 'self';
base-uri 'none';
frame-ancestors 'none';
```

- No `unsafe-inline`/`unsafe-eval`.
- Dev CSP differs only by same-origin `ws:` allowance.
- The relay HTTPS origin is required for `POST /api/rooms` (A4).

**Steps**

- [ ] Write the threat table with mitigations and owning stage.
- [ ] Map every SR-1..13 to a control and a test.
- [ ] Confirm the CSP includes both HTTPS and WSS relay origins.
- [ ] Document the abuse response: rate-limit, close, block IP, rotate code.
- [ ] Note what v1 deliberately does not defend (distributed DoS, determined attackers with tokens).

**Acceptance**

- [ ] Every SR has a control owner.
- [ ] CSP is ready for P2.
- [ ] The threat model names residual risks honestly.
- [ ] No mitigation depends on secrecy of client code.

**Tests (tagged)**

- `[SR-1]`–`[SR-13]` mapped to controls
- `[SR-8]` CSP lists both relay origins
- `[SR-11]` origin allowlist plan is explicit

**Anti-rework**

- P1/P3 implement this plan; they do not invent a new security model.
- The threat model is revisited at P5 with beta findings.

**Risks**

- `trustProxy` misconfiguration can make all clients share one IP or trust a spoofed header; P1 verifies with synthetic headers.

---

### P0-PLAN-01 — Written Phase 2 entry and P1/P2 handoff

| Field | Value |
|---|---|
| Layer | Docs/ops |
| Spec | §14 P0 |
| Depends on | P0-OPS-01..04, P0-ARCH-01, P0-SEC-01 |
| Unblocks | P1, P2 |
| Deliverables | `docs/ADR-0005-phase2-entry.md` |

**Checklist**

- [ ] Record the Dev Gate decision and date.
- [ ] Link ADR-0003 (relay), ADR-0004 (pages/DNS), CONFIG, COST, THREAT-MODEL.
- [ ] State P1 and P2 entry checklists.
- [ ] State that P1 and P2 may run in parallel but both must finish before P3.
- [ ] Record the staging environment plan and who owns deploys.
- [ ] Record the rollback and incident contacts.
- [ ] Sign and date.

**Acceptance**

- [ ] A new engineer can start P1 or P2 from this document alone.
- [ ] No open decision blocks P1/P2.
- [ ] The parallel/sequence rule is explicit.

**Tests (tagged)**

- `[FR-4.1]` P2 entry is tied to TV-only play
- `[FR-4.2]` P1 entry is tied to the relay ADR
- `[G6]` production path ownership is clear

**Anti-rework**

- This is the Phase 2 contract; changes require an updated ADR.
- P1/P2 do not re-litigate P0 decisions.

**Risks**

- Over-planning P0 delays Phase 2; keep the ADRs short and numeric.

---

## Stage exit checklist

- [ ] P0-OPS-01..04, P0-ARCH-01, P0-SEC-01, P0-PLAN-01 complete.
- [ ] Relay host/region ADR signed.
- [ ] Pages/domain/DNS ADR signed.
- [ ] Production config schema and matrix documented.
- [ ] Cost model and alerts recorded.
- [ ] Threat model and CSP draft complete.
- [ ] P1 and P2 entry checklists written.

## Handoff to P1/P2

- P1 implements the relay ADR and `RelayConfig`; it does not change broker semantics.
- P2 implements the pages/DNS ADR and `PublicConfig`; it does not change client behavior.
- Both must pass their staging checks before P3.

## Explicitly not in P0

- Provisioning production (P1/P2).
- Changing application code.
- Production beta (P5).
- iOS work (A5).
