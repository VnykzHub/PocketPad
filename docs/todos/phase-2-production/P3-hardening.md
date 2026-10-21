# P3 — Production Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Steps use checkbox syntax.
>
> **Goal:** Harden the deployed platform against abuse and misuse: consistent rate limits, PIN modes, injection defenses, a content-filter hook, privacy-safe logging, and a tested incident runbook.
>
> **Architecture:** Limits live in the broker/relay config, not in games. The controller and host keep their sanitization from D5. The content filter is a pure hook applied to UGC before display, with a family-mode toggle. Logs are structured and redacted; nothing stores message bodies.
>
> **Tech stack:** Broker/relay token buckets, CSP/headers, SDK sanitizers, a small word-list filter, structured logs, dependency audit.
>
> **Spec:** `SPEC.md` §13, §14 P3, §19 UGC caveat; SR-4, SR-5, SR-6, SR-7, SR-8, SR-9, SR-12, SR-13.
>
> **Program position:** Phase 2, after P1 and P2. P4's API freeze depends on the hardened surface; P5 beta depends on this checklist.

## Global constraints

- Manual join always requires a PIN (SR-4); QR PIN mode is optional per room.
- Join 5 attempts/min/IP → lockout; room creation 10/min/IP; events 30/s burst 60 per slot; haptics 20 Hz per slot.
- Frame caps remain 64 B binary / 4 KB JSON; violations close the socket.
- UGC is never stored and never rendered as HTML; filter before display (SR-13).
- No PII, no analytics; IPs hashed in logs; no message bodies (SR-7/9/12).
- CSP has no `unsafe-inline`/`unsafe-eval`.
- iOS remains out of scope (A5).

---

## Stage goal and exit criteria

**Exit criteria (§14 P3):**

> Rate limits, PIN modes, abuse handling, content-filter hook, privacy-safe logging.

Concretely:

- [ ] Every public endpoint/socket has an enforced, configurable limit.
- [ ] Manual join requires PIN; QR PIN mode can be enabled per room and works.
- [ ] Injection/XSS/frame-fuzz suites pass.
- [ ] Content-filter hook runs on text, names, and drawing labels; family mode toggle works; nothing is stored.
- [ ] Logs/metrics contain no tokens/PINs/bodies/PII; retention documented.
- [ ] Abuse drills pass with measured mitigation and acceptable false positives.
- [ ] Security/abuse checklist signed.

**Layer coverage**

| Layer | Work items |
|---|---|
| Security | P3-SEC-01..04 |
| Infra/ops | P3-OPS-01 |
| QA | P3-QA-01 |

**Goals advanced:** G4 (abuse-resistant rooms), G5 (safe private screens), G7 (privacy/security discipline).

---

## Work items

### P3-SEC-01 — Rate limits and abuse handling across all surfaces

| Field | Value |
|---|---|
| Layer | Security/Server |
| Spec | §13; SR-5, SR-6; §14 P3 |
| Depends on | P1-SRV-02/03, D4-SRV-01, D5-SRV-01 |
| Unblocks | P3-QA-01, P5 |
| Deliverables | unified limiter config, `docs/LIMITS.md`, abuse counters |

**Policy**

| Surface | Limit | Response |
|---|---|---|
| Join attempts | 5/min/IP, lockout 60 s doubling to 5 min | `rateLimited`; no token compare while locked |
| Room creation | 10/min/IP | HTTP 429; `Retry-After` |
| Controller connections | 16/IP (configurable) | Reject/close new sockets |
| Event messages | 30/s per slot, burst 60 | Drop + counter; close only on sustained egregious abuse |
| Haptics | 20 Hz per slot | Coalesce/drop |
| Per-socket messages | 120/s sustained | Close 1008 |
| Frame sizes | 64 B / 4 KB | Close 1009 |
| Room count | provider/config cap | New rooms 503; existing unaffected |

- All limits are config-driven and documented; no magic numbers in handlers.
- Lockouts are per-IP-hash in memory; a restart resets them (document).
- Abuse events are counted and logged with reason + hashed IP.
- A global kill switch (config) can disable room creation under attack without taking down existing rooms.
- False-positive considerations: school/hostel NAT, IPv6 rotation; P5 monitors.

**Steps**

- [ ] Centralize limit values in `RelayConfig`/broker config.
- [ ] Implement the room-create limiter and 429/Retry-After.
- [ ] Implement per-IP connection caps and a global cap.
- [ ] Add drop counters by reason to metrics.
- [ ] Add the room-creation kill switch.
- [ ] Write `docs/LIMITS.md` with the table and rationale.
- [ ] Test each limit at the boundary and just over it.

**Acceptance**

- [ ] Every row in the policy table has a test.
- [ ] Lockout, 429, close codes, and drop counters behave as specified.
- [ ] The kill switch stops new rooms without affecting existing ones.
- [ ] Limits are configurable without a code change.

**Tests (tagged)**

- `[SR-5]` join lockout and room-create 429
- `[SR-6]` frame/message/connection caps
- `[FR-7.8]` event and haptic limits hold
- `[G4]` limits protect 8-player rooms from one abusive client

**Anti-rework**

- One limiter utility for all surfaces; do not fork it per handler.
- P5 tunes numbers via config, not code.

**Risks**

- IP-based limits can punish shared NAT; document and monitor.
- Aggressive socket closes can look like network bugs; use clear close codes and logs.

---

### P3-SEC-02 — PIN modes and room join policy

| Field | Value |
|---|---|
| Layer | Security/Server |
| Spec | §5.1, §5.3, §13; SR-4, FR-5.6 |
| Depends on | D4-SRV-01, D4-HOST-01, P3-SEC-01 |
| Unblocks | P5 |
| Deliverables | room `requirePinForQr` field, host toggle, join validation, tests |

**Behavior**

- Manual join (code + PIN) always requires the PIN; no exceptions.
- Room setting `requirePinForQr` (default false):
  - false: QR token alone joins (current behavior).
  - true: QR token **and** PIN are both required; the controller shows a PIN prompt after reading the token.
- Host lobby exposes a toggle "Require PIN even with QR" with a short explanation; the setting is per room, not global.
- The PIN is never included in the QR; the player types it.
- Server validates: if the room requires both, a join with only `token` returns a distinguishable error so the controller can prompt.
  - Add `joinError.reason: "pinRequired"` (additive, A11) rather than reusing `badPin`; the controller shows the PIN field instead of a generic failure.
- Rate limiting applies to the token+PIN join the same as manual.
- Turning the setting on mid-room affects new joins only; existing players stay.

**Steps**

- [ ] Add `requirePinForQr` to the room creation request/response and `Room` state.
- [ ] Add the host toggle with a clear warning.
- [ ] Add `pinRequired` to the join error union (A11) and protocol validation.
- [ ] Implement the two-credential join check and tests.
- [ ] Implement the controller PIN prompt after a `pinRequired` error.
- [ ] Ensure the manual path is unchanged.
- [ ] Record the UX in `docs/RESULTS.md`.

**Acceptance**

- [ ] Manual join without PIN always fails.
- [ ] QR-only join succeeds when the setting is off.
- [ ] QR join without PIN gets `pinRequired` and the controller shows a PIN prompt when on.
- [ ] Token+PIN join succeeds when on.
- [ ] Existing players are unaffected by a mid-room toggle.

**Tests (tagged)**

- `[SR-4]` manual join requires PIN
- `[SR-4]` QR PIN mode requires both token and PIN
- `[FR-5.6]` manual join remains camera-free
- `[FR-5.1]` PIN is never in the QR
- `[A11]` pinRequired is representable (if added)

**Anti-rework**

- The setting lives on the room, not a global env, so P5 can test both modes.
- Controller prompt reuses the manual join form component.

**Risks**

- Extra PIN entry hurts G1; default stays off. Measure the on-mode latency separately.
- A user may forget the PIN; the host can read it aloud.

---

### P3-SEC-03 — Injection, XSS, frame-fuzz and CSP hardening

| Field | Value |
|---|---|
| Layer | Security |
| Spec | §13; SR-6, SR-8, SR-13 |
| Depends on | P2-SEC-01, D5-SEC-01 |
| Unblocks | P4, P5 |
| Deliverables | fuzz suite, header checks, `docs/SECURITY-TESTS.md` |

**Suites**

- Frame fuzz:
  - Random bytes, truncated frames, wrong type, oversized binary/text, zero-length, huge `n` in Haptic, invalid slot, NaN-ish values.
  - Assert: no crash, no unhandled rejection, correct close code.
- JSON fuzz:
  - Random `t`, missing fields, wrong types, nested depth, 4 KB boundary, `__proto__` keys, unicode edge cases.
  - Assert: parse rejects or safely ignores; no prototype pollution.
- XSS suite (from D5) rerun against production CSP:
  - Panel text/blocks/image, player names, text events, choice values, stroke color/width.
  - Assert: inert, CSP violation-free.
- CSP:
  - Automated header assertions; no `unsafe-*`; relay HTTPS+WSS present.
  - Browser console check for violations during a full session.
- Input validation:
  - Layout/panel/event limits enforced before render; oversized rejected.
- Dependency:
  - `npm audit` (or equivalent) with a documented allowlist for dev-only advisories; no high/critical runtime advisories.
- Secrets:
  - Scan repo/history for tokens/keys; `.env` ignored.

**Steps**

- [ ] Build the fuzz harness with a seeded random generator; run in CI (short) and a longer local run.
- [ ] Add property assertions for no crash/close codes.
- [ ] Rerun the XSS suite under the production CSP.
- [ ] Add automated CSP/header tests.
- [ ] Add dependency audit with an allowlist file and expiry dates.
- [ ] Add a secrets scan to CI.
- [ ] Record results in `docs/SECURITY-TESTS.md`.

**Acceptance**

- [ ] Fuzz suites pass 10k+ cases locally; CI runs a smaller fixed seed set.
- [ ] No prototype pollution from JSON.
- [ ] XSS suite is inert with zero CSP violations.
- [ ] No high/critical runtime dependency advisories.
- [ ] No secrets in the repo/history.

**Tests (tagged)**

- `[SR-6]` fuzzed frames never crash the relay
- `[SR-13]` hostile UGC is inert under production CSP
- `[SR-8]` CSP/header assertions pass
- `[SR-7]` no third-party/analytics requests
- `[G7]` dependency audit has no unaccepted high/critical issues

**Anti-rework**

- Fuzz seeds are fixtures; rerun them in P5 with every release.
- Header tests run against the deployed URL, not a local mock.

**Risks**

- Fuzzing WebSocket servers can be slow; run in-process against the broker for most cases.
- CSP on TV browsers may behave differently; include one real-TV check.

---

### P3-SEC-04 — Content-filter hook and family-friendly mode

| Field | Value |
|---|---|
| Layer | Security/Content |
| Spec | §13, SR-13; §22 Q4 |
| Depends on | D5-SEC-01, P3-SEC-03 |
| Unblocks | P5, Draw/Bluff/Spy in P6 |
| Deliverables | `sdk/src/filter.ts`, controller/host integration, `docs/CONTENT-FILTER.md` |

**Freeze this interface**

```ts
export interface FilterContext {
  source: "text" | "name" | "choice" | "panel";
  gameSlug?: string;
}

export interface FilterResult {
  allowed: boolean;
  text?: string;        // filtered text if allowed
  reason?: string;      // for logs/debug, no PII
}

export type ContentFilter = (text: string, ctx: FilterContext) => FilterResult;

export function createWordListFilter(words: readonly string[], mode: "mask" | "reject"): ContentFilter;
```

**Behavior**

- Apply to:
  - Player names at join (server-side, before storing/display).
  - Text event values (controller-side before send and host-side before render).
  - Choice labels are game-authored; skip unless they contain user data.
  - Panel text authored by a game is trusted game content; filter only if it embeds UGC (games should not).
  - Drawing has no text in v1; future labels filter.
- Family mode:
  - Host toggle "Family-friendly" (default OFF in dev; decide before P5).
  - When on, use the bundled word list (mask for names, reject for guesses); when off, a no-op filter.
  - The filter is a pure function; nothing is logged with the offending text.
- No storage of filtered or original text; no analytics.
- The list is small, bundled, and versioned; no network fetch.
- The hook is pluggable so a hosted deployment can add a stronger filter later without changing games.

**Steps**

- [ ] Implement the filter interface and word-list implementation with tests (case, word boundaries, simple leetspeak replacements).
- [ ] Apply at name join and text-event send/render.
- [ ] Add the host family-mode toggle and persist it per room.
- [ ] Ensure rejected text shows a friendly message and is not echoed back.
- [ ] Log only `filter.reject` with a count/reason, no text.
- [ ] Document the policy and the limits of a word list.
- [ ] Test with benign, masked, and rejected examples.

**Acceptance**

- [ ] A blocked name never reaches the room.
- [ ] A blocked guess shows a local message and sends nothing.
- [ ] Family mode off is a no-op; on applies the list.
- [ ] No original/blocked text is stored or logged.
- [ ] The filter adds < 1 ms per event on the phone.

**Tests (tagged)**

- `[SR-13]` filter hooks apply to names and text events
- `[SR-13]` blocked UGC is never displayed or stored
- `[SR-7]` filter logs contain no text/PII
- `[FR-7.8]` filtering does not break event rate/order

**Anti-rework**

- The hook is SDK-level so P6 games get it automatically.
- No game implements its own moderation.

**Risks**

- Word lists are easily bypassed; document that this is a family-friendly aid, not a security control.
- Over-blocking names can frustrate players; use mask for names, reject for guesses.

---

### P3-OPS-01 — Privacy-safe logging, retention and incident runbook

| Field | Value |
|---|---|
| Layer | Infra/ops |
| Spec | §13; SR-7, SR-9, SR-12; §14 P3 |
| Depends on | P1-SRV-03, P1-OPS-01 |
| Unblocks | P5 |
| Deliverables | `docs/PRIVACY.md`, `docs/INCIDENT-RUNBOOK.md`, retention config |

**Logging policy**

- Log: room create/join/leave/expire, host lost/resume, rate-limit rejects, filter rejects (no text), deploy/health events.
- Never log: tokens, PINs, QR URLs, message bodies, raw IPs, player names (names are UGC), text/answers/drawings.
- IPs are hashed with a per-environment salt; hashes rotate with retention.
- Metrics have no high-cardinality PII labels.
- No analytics, no third-party scripts, no cookies beyond functional storage.

**Retention**

```md
| Data | Retention | Notes |
|---|---|---|
| Audit logs | 30 days | room events only |
| Metrics | 30 days | aggregated |
| Error logs | 14 days | redacted |
| Room state | in-memory, max 4 h | never persisted |
| Session/host tokens | client storage only | user can clear |
```

- Document deletion: clear browser storage; no server-side account/data.
- If a provider stores logs longer, configure retention or document the gap.

**Incident runbook**

- Abuse/flood: engage kill switch, raise limits, block IP hash, notify.
- Token leak report: expire the room, advise a new code; tokens are ephemeral.
- Relay outage: check provider status, roll back, status message (P5 adds a status page).
- Data exposure: determine logs/metrics contents, purge, document.
- Security report contact: add a SECURITY.md in P4.

**Steps**

- [ ] Audit every log statement; replace raw IP/name/body with redacted fields.
- [ ] Add the hashing salt config and rotation note.
- [ ] Set provider log retention to match the table (or document the limitation).
- [ ] Write the incident runbook with exact commands/links.
- [ ] Add a privacy checklist to the release process.
- [ ] Test that a name/text/token never appears in captured logs.

**Acceptance**

- [ ] A captured log sample from a full session contains no UGC/tokens/PINs/raw IPs.
- [ ] Retention matches the table or the gap is documented.
- [ ] The runbook covers abuse, outage, leak, and rollback.
- [ ] No analytics/tracking requests exist.

**Tests (tagged)**

- `[SR-7]` no PII/analytics in logs or requests
- `[SR-9]` logs contain no tokens/PINs
- `[SR-12]` message bodies are not retained
- `[SR-13]` UGC text is not logged

**Anti-rework**

- One logging policy for P5/P6; new events must fit the schema.
- Retention is configured, not aspirational.

**Risks**

- Provider access logs (IPs) may sit outside app control; document and disable if possible.
- Hashing is pseudonymization, not anonymization; treat IP hashes as personal data.

---

### P3-QA-01 — Security suite, abuse drills and sign-off

| Field | Value |
|---|---|
| Layer | QA |
| Spec | §14 P3, §16, §13 |
| Depends on | P3-SEC-01..04, P3-OPS-01 |
| Unblocks | P4 |
| Deliverables | `docs/SECURITY-CHECKLIST.md`, drill report |

**Drills**

- Join flood: 100 attempts/min from one IP; expect lockout, no room compromised.
- Room creation flood: 30/min; expect 429 and stable relay.
- Event flood: 200 events/s from one slot; expect drops, other slots unaffected.
- Connection flood: open 32 sockets from one IP; expect cap, existing rooms stable.
- Oversized/malformed frames: expect correct closes, no crash.
- XSS/filter payloads: inert, blocked, no logs with content.
- Token leakage scan: grep logs for token patterns after a full session.
- Dependency/secrets scan.

**Steps**

- [ ] Run each drill on staging; record before/after metrics.
- [ ] Verify no cross-room or cross-slot impact.
- [ ] Verify false-positive behavior for a shared-IP simulation (two clients behind one NAT).
- [ ] Complete the security checklist with evidence links.
- [ ] Sign off or list blocking conditions.
- [ ] Record the drill report in `docs/RESULTS.md`.

**Acceptance**

- [ ] All drills pass or have an accepted mitigation.
- [ ] One abusive client cannot degrade other rooms/slots.
- [ ] No token/UGC leakage in logs.
- [ ] Checklist signed.

**Tests (tagged)**

- `[SR-5]` flood drills trigger limits, not outages
- `[SR-6]` malformed frames close safely
- `[SR-13]` filter/XSS drills pass
- `[G4]` abuse on one slot does not affect the other seven

**Anti-rework**

- Drills are scripts/config, reusable in P5.
- The checklist is the P4 entry gate.

**Risks**

- Staging flood tests can affect other staging users; isolate or use a dedicated environment.
- Rate limits may need tuning after real beta; P5 can adjust config.

---

## Stage exit checklist

- [ ] P3-SEC-01..04, P3-OPS-01, P3-QA-01 complete.
- [ ] Rate-limit policy table fully tested.
- [ ] PIN modes work, default preserves G1.
- [ ] XSS/fuzz/CSP/dependency/secrets suites pass.
- [ ] Content filter hook and family mode work; nothing stored.
- [ ] Logs/metrics privacy-safe; retention configured.
- [ ] Abuse drills pass; checklist signed.
- [ ] `docs/RESULTS.md` P3 row complete.

## Handoff to P4

- P4 freezes the hardened public API; no new security controls during SDK work.
- The content-filter hook and sanitizers are part of the SDK surface.
- P5 beta uses the drills and checklist as regression.

## Explicitly not in P3

- New games (P6).
- Multi-instance relay scaling.
- Accounts/moderation tooling.
- iOS work (A5).
