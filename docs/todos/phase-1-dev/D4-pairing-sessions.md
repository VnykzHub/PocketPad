# D4 — Pairing and Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Steps use checkbox syntax.
>
> **Goal:** Make joining effortless and robust: QR/token, code+PIN manual join, per-player sessions, 30 s slot reservations, reconnect, suspend/resume, host-lost recovery, and 8 stable controller clients.
>
> **Architecture:** `packages/broker` owns all room/session semantics; the dev server's WS adapter routes messages. The host renders QR/code/PIN and reconnects with a host token. The controller stores its session and rejoins by token; it never uses the shared room token to reclaim a slot.
>
> **Tech stack:** `ws`, `qrcode`, Web Crypto/Node crypto, `sessionStorage`/`localStorage`, Wake Lock API, Vitest fake timers, input-bot.
>
> **Spec:** `SPEC.md` §5, §7.2, §7.4, §8.5, §14 D4, §16, §20 E4/E9/E15; FR-5.1–5.6, FR-7.10, FR-7.14–7.16, FR-8.8, SR-1–5, SR-10, SR-11.
>
> **Program position:** Phase 1, after D3. Sessions must be complete before D5 routing and D7 games; no game may implement its own reconnect.

## Global constraints

- Room code 4 chars Crockford base32; PIN 4 digits; room/host/session tokens 16 random bytes base64url (22 chars).
- Room expiry: 10 min idle, 4 h max. Slot reservation: 30 s. Host reservation: 30 s.
- Rejoin uses the session token; the shared room token is only for a *new* join after a reservation expires.
- Heartbeat 2 s, dead after 5 s; reconnect backoff 250 ms → 4 s cap.
- Rate limit: 5 join attempts/min/IP, then lockout (60 s, doubling to 5 min).
- No tokens/PINs in logs, URLs (except the room token in the QR fragment), or DOM text.
- Connection pill states: Connecting / Connected (P#) / Reconnecting / Waiting for TV / Disconnected.
- iOS is out of scope (A5); Wake Lock and reconnect code must feature-detect and not crash.

---

## Stage goal and exit criteria

**Exit criteria (§14 D4):**

> G1 met (scan to playable under 5 s). 8 input-bot clients stable.

Concretely:

- [ ] Host shows a QR, a 4-char code and a 4-digit PIN, large and readable from a couch.
- [ ] Scanning the QR joins in one tap; manual code+PIN works with no camera.
- [ ] A dropped controller reclaims its slot within 30 s; after that it can join fresh.
- [ ] Host hidden pauses; host drop shows "Waiting for TV" for 30 s; host reload resumes the room.
- [ ] 8 bots stay connected and slot-stable for a 10-minute run.
- [ ] G1 timing recorded: QR scan/page load → first input visible on host < 5 s.
- [ ] E4, E9, E15 recorded.

**Layer coverage**

| Layer | Work items |
|---|---|
| Protocol | D4-PROTO-01 |
| Server | D4-SRV-01, D4-SRV-02, D4-SRV-03 |
| Host runtime | D4-HOST-01, D4-HOST-02 |
| Controller | D4-CTRL-01, D4-CTRL-02 |
| Tools | D4-TOOL-01 |
| Experiments/docs | D4-EXP-01 |
| QA | D4-QA-01 |

**Goals advanced:** G1 (join), G4 (8 controllers/reconnect), G5 (lifecycle UX), G7 (security).

---

## Protocol amendment A9 (required)

The spec defines host loss (§7.16) and says controllers show "Waiting for TV", but it provides no server→controller message for host state. D4 adds:

```ts
// S -> C
| { t: "hostStatus"; state: "active" | "paused" | "lost" }
```

- Sent to all controllers on host join (`active`), host pause (`paused`), host resume (`active`), host disconnect (`lost`).
- `lost` starts the 30 s host reservation; `active` cancels it.
- This is additive to `PROTOCOL_VERSION = 1`; no existing message changes.
- Record A9 in `README.md` §1 and `TRACEABILITY.md` before implementing.

## Contracts frozen in D4

1. **Join request** is exactly one of `token`, `pin`, or `session`, plus `code` and `v`.
2. **Session record** (controller): `{ code, session, slot, roomToken?, expiresAt }`; `session` in `sessionStorage`, mirrored to `localStorage` with a 4 h expiry for browser restarts.
3. **Reservation**: 30 s from `suspend` or socket close; the slot remains occupied for assignment; `playerSuspended` → `playerResumed` or `playerLeft`.
4. **Host reservation**: 30 s from socket close; room state `hostLost`; controllers receive `hostStatus lost`; host `hostJoin` with the same token resumes.
5. **Stats**: 1 Hz to the host, per slot `{slot, rttMs, jitterMs, lastInputAgeMs, packetsPerSecond, drops}`.
6. **Reconnect**: exponential backoff 250 ms → 4 s with ±20% jitter; rejoin with `session`; on `joinError expired`, fall back to room token or manual join.
7. **G1 instrumentation**: controller records `pageLoadAt`, `joinedAt`, `firstInputSentAt`; host records `playerJoinedAt` and `firstInputRenderedAt`.

---

## Work items

### D4-PROTO-01 — Session, host-state and reconnect message contract

| Field | Value |
|---|---|
| Layer | Protocol |
| Spec | §5.2, §7.2, §7.4, §7.16; A2, A9; FR-5.4, FR-7.14–7.16 |
| Depends on | D0-PROTO-01, D0-PROTO-03 |
| Unblocks | D4-SRV-01..03, D4-CTRL-01/02, D4-HOST-02 |
| Deliverables | `packages/protocol/src/messages.ts` (extended), `src/json.ts` (validators), `test/sessionMessages.test.ts`, README/TRACEABILITY A9 rows |

**Additions**

```ts
export type ServerToClientMessage =
  // ...existing...
  | { t: "hostStatus"; state: "active" | "paused" | "lost" };
```

Validation rules:
- `hostStatus.state` in the union; no other fields.
- `join` credentials: `session` alone; `token` alone; `pin` alone; or `token` + `pin` when `requirePinForQr` is on (A11). `session` never combines with token/pin.
- `hostJoin` requires `hostToken` length 22 and `v === PROTOCOL_VERSION`.
- `suspend`/`leave` take no fields.
- `playerJoined`/`playerLeft`/`playerSuspended`/`playerResumed` require `slot` 1–8.
- `stats` requires an array of 0–8 `SlotStats`, each with finite non-negative numbers; reject > 8 entries.

**Steps**

- [ ] Add `hostStatus` to the server→client union and validator.
- [ ] Add tests for each message and each invalid case.
- [ ] Add a version check: `join`/`hostJoin` with `v !== PROTOCOL_VERSION` returns `joinError` reason `badVersion` (add to `JoinErrorReason` as an additive value).
- [ ] Update `TRACEABILITY.md` with an A9 row and `README.md` §1 A9.
- [ ] Update the controller/host TypeScript switches so all messages are handled or explicitly ignored.

**Acceptance**

- [ ] `hostStatus` round-trips through `parseJsonMessage` and is delivered to controllers.
- [ ] A join with two credentials fails.
- [ ] An unknown `hostStatus.state` fails with `badType`.
- [ ] A `stats` message with 9 slots fails.

**Tests (tagged)**

- `[A9] hostStatus carries active/paused/lost to controllers`
- `[FR-5.4] join accepts session alone or token[+pin]; session never combines`
- `[FR-7.16] hostStatus lost is representable on the wire`
- `[SR-6] stats over 8 slots is rejected`

**Anti-rework**

- Additive variant; do not create a separate "presence" channel. Later host states extend the enum with a version check.
- Keep `JoinErrorReason` closed; games never parse raw reasons.

**Risks**

- Older controllers (cached) may not know `hostStatus`; the controller must ignore unknown JSON messages rather than crash. Add a default ignore branch.

---

### D4-SRV-01 — Tokens, PIN, constant-time compare and join rate limiting

| Field | Value |
|---|---|
| Layer | Server (broker) |
| Spec | §5.1, §5.3; SR-1, SR-4, SR-5, SR-9; FR-5.6 |
| Depends on | D0-SRV-02, D4-PROTO-01 |
| Unblocks | D4-SRV-02, D4-CTRL-01, P1-SRV-03, P3-SEC-01 |
| Deliverables | `packages/broker/src/auth/tokens.ts`, `src/auth/rateLimit.ts`, `test/tokens.test.ts`, `test/rateLimit.test.ts` |

**Freeze this interface**

```ts
export function generateToken(randomBytes: (n: number) => Uint8Array): string; // 16 bytes base64url, 22 chars
export function constantTimeEqual(a: string, b: string): boolean;

export interface JoinRateLimiter {
  check(ip: string, nowMs: number): { allowed: true } | { allowed: false; retryAfterMs: number };
  recordFailure(ip: string, nowMs: number): void;
  recordSuccess(ip: string, nowMs: number): void;
}
export function createJoinRateLimiter(opts?: { maxAttempts?: number; windowMs?: number; lockoutMs?: number; maxLockoutMs?: number }): JoinRateLimiter;
```

**Behavior**

- Token: `base64url(randomBytes(16))`; exactly 22 chars, no padding.
- Constant-time compare: compare lengths without early return; if lengths differ, compare a fixed dummy buffer and return false; if equal, `crypto.timingSafeEqual`.
- PIN: exactly 4 digits; compare constant-time as a 4-char string (also guard the length branch).
- Rate limiter: 5 failed attempts in any 60 s window per IP → lockout 60 s; repeated lockouts double to a 5 min cap. A successful join resets the window and the lockout level.
- IP source: `Peer.remoteAddress` in dev. Behind a proxy, only trust `X-Forwarded-For` when `TRUST_PROXY=1` (P1 config); otherwise use the socket address.
- Manual join always requires the PIN (SR-4). QR-token join does not require the PIN unless the room has `requirePinForQr` (P3 adds the setting; D4 default false).
- Never log the PIN or tokens; log `join.reject` with reason and IP hash (not raw IP) at most once per attempt.

**Steps**

- [ ] Implement token generation and constant-time compare with tests for length mismatch, equal, and unequal values.
- [ ] Implement the PIN generator (`randomInt(0,10000)` padded to 4) and validate exactly 4 digits.
- [ ] Implement the rate limiter with injected `now`; test the 5th failure, lockout expiry, doubling, cap, and success reset.
- [ ] Wire the limiter into `join` before token/PIN comparison; a locked-out IP gets `rateLimited` without a token comparison.
- [ ] Add a test that logs never contain the token/PIN.
- [ ] Add a test that `requirePinForQr` false allows token-only join, true requires both.
- [ ] Add a test that a wrong PIN and a wrong token both return `badPin`/`badToken` but are rate-limited equally.

**Acceptance**

- [ ] Generated tokens match `^[A-Za-z0-9_-]{22}$`.
- [ ] 5 failures in 60 s block the 6th attempt; after 60 s it is allowed; repeated lockout doubles.
- [ ] A correct PIN resets the limiter.
- [ ] No log line contains a token or PIN.
- [ ] Manual join without a PIN is rejected.

**Tests (tagged)**

- `[SR-1] tokens are 128-bit base64url and compared in constant time`
- `[SR-4] manual join requires the PIN`
- `[SR-5] five failures per minute lock out the IP`
- `[SR-9] join logs never include tokens or PINs`
- `[FR-5.6] manual join is independent of camera/token`

**Anti-rework**

- Rate limiter is reused by room creation and event limits (with different policies) in P3; keep it generic.
- Token format is shared by room/session/host tokens; do not create a second generator.
- `requirePinForQr` is a room field from D4; P3 toggles it, no protocol change.

**Risks**

- In-memory rate limits reset on restart; acceptable in dev, P1 documents relay restart behavior.
- IPs in IPv4-mapped IPv6 form (`::ffff:1.2.3.4`) must normalize before keying.

---

### D4-SRV-02 — Sessions, slots, reservations, rejoin and room expiry

| Field | Value |
|---|---|
| Layer | Server (broker) |
| Spec | §5.2, §5.3, §7.16; FR-5.2–5.5, FR-7.14/7.15; SR-6 |
| Depends on | D0-SRV-02, D4-SRV-01, D4-PROTO-01 |
| Unblocks | D5-SRV-01, D7 games, D4-QA-01 |
| Deliverables | `packages/broker/src/room/sessions.ts`, `src/room/registry.ts` (extended), `test/sessions.test.ts`, `test/expiry.test.ts` |

**Freeze this interface**

```ts
export interface ControllerSlot {
  slot: number;
  session: string;
  peer: Peer | null;
  name?: string;
  joinedAt: number;
  lastSeenAt: number;
  reservationExpiresAt: number | null;
  rttMs: number;
  jitterMs: number;
  packetsPerSecond: number;
  drops: number;
}

export class RoomRegistry {
  join(req: JoinRequest, peer: Peer): JoinResult;       // session-aware in D4
  suspend(code: string, slot: number, now: number): void;
  leave(code: string, slot: number, now: number): void;
  detach(code: string, slot: number, now: number): void; // socket close, reserves slot
  sweep(now: number): void;
}
```

**Join precedence (strict)**

1. `session` alone: look up the slot by session (active or reserved). If found and the reservation is live (or the peer is active), attach and return the same slot; close any old peer. If the session is unknown/expired → `joinError {reason:"expired"}` (no fallback inside the server). A session combined with token/pin is malformed → `badToken`.
2. `token` + `pin` together, room `requirePinForQr=true`: rate limit, verify both in constant time, then assign the lowest free slot. If the PIN is missing/wrong → `pinRequired` / `badPin` (A11).
3. `token` alone, room `requirePinForQr=false`: constant-time compare room token; assign the lowest free slot. If the room requires a PIN → `pinRequired` (A11). If no slot → `roomFull`. A `token`+`pin` pair when the PIN is not required is accepted and the PIN is ignored (the token is sufficient); this tolerates clients that always prompt.
4. `pin` alone: rate limit, then constant-time compare PIN; assign the lowest free slot (manual join; FR-5.6). If `requirePinForQr` is false this is still valid, but a room token is not required for manual entry.
5. Anything else (no credential, session+token, session+pin) → `badToken` (malformed).

**Reservation behavior**

- `suspend` or socket close: keep the slot, set `peer=null`, `reservationExpiresAt = now + 30_000`, notify host `playerSuspended` (socket close also uses this; an explicit `leave` uses `playerLeft`).
- Rejoin with session within the window: clear reservation, attach peer, notify host `playerResumed`.
- `sweep` after expiry: remove the slot, notify host `playerLeft`; the slot becomes assignable.
- Explicit `leave`: free immediately, notify `playerLeft`, do not reserve.
- `roomFull` counts active + reserved slots. A 9th join gets `roomFull`.
- Sessions are random 16-byte tokens issued on first join; never derived from the room token.

**Room expiry**

- `lastActivityAt` updates on any valid controller/host message (input counts).
- Idle 10 min or age 4 h → state `expired`, send `kick {reason:"expired"}` to all peers, close sockets, remove from registry.
- `sweep` runs every 1 s (setInterval in the adapter, not the pure broker).

**Steps**

- [ ] Extend `ControllerSlot` with the fields above; keep D0's room shape.
- [ ] Implement session lookup and the precedence rules; test every combination.
- [ ] Implement suspend/detach/leave/reservation; test with fake timers.
- [ ] Implement `sweep`: reservations, idle expiry, max age; test each boundary.
- [ ] Ensure a rejoin after 29.9 s succeeds and after 30.1 s fails with `expired`.
- [ ] Ensure the 9th attempt during a reservation still returns `roomFull`.
- [ ] Update `lastActivityAt` on input and host messages; verify an idle-but-active room does not expire.
- [ ] Add a test that a session token cannot be used to join a different room.

**Acceptance**

- [ ] Rejoin within 30 s returns the same slot and `playerResumed`.
- [ ] Rejoin after 30 s returns `expired`; the slot is free.
- [ ] 8 active + 1 reserved rejects a 9th with `roomFull`.
- [ ] Explicit leave frees the slot immediately and does not reserve.
- [ ] Idle 10 min or 4 h max expires the room and kicks all peers.
- [ ] Session tokens are unique per join and never equal the room token.

**Tests (tagged)**

- `[FR-5.2] room expires at 10 minutes idle or 4 hours max`
- `[FR-5.3] roomFull counts active and reserved slots`
- `[FR-5.4] session rejoin returns the same slot inside 30 seconds`
- `[FR-5.5] expired reservation frees the slot`
- `[FR-7.14] silent sockets are detached and reserved`
- `[SR-6] a ninth controller is rejected`
- `[SR-1] session tokens are independent random 128-bit values`

**Anti-rework**

- Reservations are a room-level map keyed by session; do not add a second reconnect mechanism in the controller.
- Game code never sees reservations; the host only sees `playerSuspended/Resumed`.
- Keep `join` pure (injected `now`), so P5 load tests can simulate time.

**Risks**

- A host that never returns leaves 8 controllers waiting; the 30 s timer must expire the room, not just the host.
- Keeping a slot reserved blocks a new player for 30 s; that is the spec's tradeoff. The host UI must show "reserved" vs "empty".

---

### D4-SRV-03 — Host token, host-lost recovery, stats and heartbeat integration

| Field | Value |
|---|---|
| Layer | Server (broker + WS adapter) |
| Spec | §5.2, §7.2, §7.4, §7.16; FR-7.14, FR-7.16; A2, A9 |
| Depends on | D4-SRV-02, D0-SRV-03 |
| Unblocks | D4-HOST-02, D4-QA-01, P1-SRV-02 |
| Deliverables | `packages/broker/src/room/host.ts`, `src/room/stats.ts`, `test/hostRecovery.test.ts`, `test/stats.test.ts` |

**Behavior**

- `hostJoin`: constant-time compare `hostToken`; if the room is `hostLost` and the 30 s reservation is live, attach, set `active`, cancel the timer, notify controllers `hostStatus active`; if expired, `joinError expired`.
- Host socket close: `host=null`, state `hostLost`, start 30 s timer, notify controllers `hostStatus lost`. Controllers keep their slots and sessions; their input is dropped until the host returns.
- Host returns within 30 s: room resumes; controllers get `active`; the host receives one `playerJoined` per active slot to rebuild its table. Reserved slots are replayed as `playerSuspended`.
- Host does not return: after 30 s, send `kick {reason:"hostLost"}` to controllers, expire the room.
- `hostPause`/`hostResume`: set room state `paused`/`active`, broadcast `hostStatus paused/active`; the host pauses its loop. Controllers keep sending; the server may drop inputs while paused.
- Stats: every 1 s send `stats` to the host:
  - `rttMs`: WS-level ping/pong RTT per controller (server timestamps `ws.ping()` and the `pong` event).
  - `jitterMs`: EWMA of `|rtt - previousRtt|` (alpha 0.2).
  - `lastInputAgeMs`: now − last input received for that slot.
  - `packetsPerSecond`: sliding 1 s count of Input frames.
  - `drops`: count of frames dropped due to backpressure or invalid slot.
- Heartbeat: the D0 adapter already pings every 2 s and terminates after 5 s; D4 uses the same pong timestamps for stats.
- Logs: host lost/resumed, no tokens.

**Steps**

- [ ] Implement `hostJoin` resume and the 30 s timer with fake clocks.
- [ ] On host rejoin, replay `playerJoined` for each active slot and `playerSuspended` for reserved slots.
- [ ] Implement `hostStatus` broadcasts on join/pause/resume/lost.
- [ ] Implement stats collection from the WS adapter's ping/pong; expose an injectable clock for tests.
- [ ] Test: host drop → lost; controllers see lost; host returns at 29 s → active; returns at 31 s → expired/kick.
- [ ] Test: pause/resume changes hostStatus and input is dropped while paused.
- [ ] Test: stats message has one entry per active slot, finite numbers, 1 Hz.
- [ ] Ensure no token appears in host-lost logs.

**Acceptance**

- [ ] Host reload within 30 s resumes the same room and slot list.
- [ ] Host reload after 30 s closes the room and kicks controllers with `hostLost`.
- [ ] Controllers show `Waiting for TV` on `hostStatus lost` and recover on `active`.
- [ ] Pause/resume reaches controllers.
- [ ] Stats arrive at 1 Hz with RTT/jitter/age/packets/drops per slot.

**Tests (tagged)**

- `[FR-7.16] host lost for 30 seconds resumes with the host token`
- `[A9] controllers receive hostStatus lost/active/paused`
- `[FR-7.14] heartbeat pong timestamps feed per-slot RTT`
- `[FR-7.16] no host return expires the room and kicks controllers`
- `[FR-9.2] hostPause pauses the room and notifies controllers`
- `[SR-9] host recovery logs contain no tokens`

**Anti-rework**

- Stats is the single monitoring surface for the host overlay and P5; do not add ad-hoc ping messages.
- Host resume uses `hostToken` and produces normal `playerJoined` events, so the host UI needs no separate snapshot message.
- The 30 s constants live in one config object shared with the controller reservation.

**Risks**

- WS ping/pong may be answered by the browser automatically even when the app is backgrounded; stats RTT can look healthy while the app is asleep. Combine with `lastInputAgeMs`.
- On a relay restart, in-memory rooms are lost; P1 documents this as a single-instance limitation until persistence/affinity is designed.

---

### D4-HOST-01 — QR, code and PIN display; manual join path; security notice

| Field | Value |
|---|---|
| Layer | Host runtime |
| Spec | §5.1, §5.2, §8.5; FR-5.1, FR-5.6, SR-2, SR-10; AR-4 |
| Depends on | D4-SRV-01, D4-CTRL-01, D0-RT-01 |
| Unblocks | D4-QA-01, D7 games, P6 hub |
| Deliverables | `packages/runtime/src/ui/RoomPanel.ts`, `src/ui/QrCode.ts`, `test/roomUrl.test.ts` |

**Behavior**

- On room creation, show:
  - A QR code for `<publicOrigin>/c/<CODE>#<roomToken>`.
  - The 4-char code and 4-digit PIN in very large type (readable from 3 m).
  - Persistent notice: "Anyone with this code can join. Only share it with people in the room."
  - A short manual line: "Or open vynkzhub.com/c and enter the code + PIN" (dev: LAN URL).
- `publicOrigin`: `location.origin` in dev; `VITE_PUBLIC_ORIGIN` in production (pages origin, not relay). Never build a QR from the relay origin.
- The room token is in the URL fragment; it is never displayed as text, never logged, and never sent in an HTTP request.
- QR generation uses `qrcode` on a canvas; regenerate only when the room code/token changes.
- Remote operable: Enter creates a room; a focused "New room" button is reachable with arrows/Enter; no pointer-only flow (AR-4). The QR panel itself is static.
- If QR generation fails, show the URL/code and a clear fallback; manual join always works (FR-5.6).
- Hide the token from DOM attributes; use it only to build the URL string for the QR and pass it to `QrCode` as a short-lived value.

**Steps**

- [ ] Implement `buildJoinUrl(publicOrigin, code, roomToken)` with a test that the token is after `#` and never in the query/path.
- [ ] Implement `RoomPanel` with code/PIN large type and the notice (fixed text, no dismissal).
- [ ] Implement `QrCode` with `qrcode.toCanvas`; test that the encoded string contains the fragment and correct origin.
- [ ] Add a keyboard-accessible "New room" action; verify Enter/Space.
- [ ] Ensure the host never logs the QR URL (contains the token).
- [ ] Add a manual fallback display if `qrcode` throws.
- [ ] Record a screenshot for `docs/RESULTS.md`.

**Acceptance**

- [ ] QR scans to `/c/CODE#TOKEN` on the pages origin.
- [ ] Code/PIN are readable at 3 m in the test TV's resolution.
- [ ] Notice is persistent.
- [ ] Manual join path is shown.
- [ ] No token in the visible DOM or logs.
- [ ] Room creation is keyboard-only.

**Tests (tagged)**

- `[FR-5.1] room token is only in the URL fragment`
- `[SR-2] QR URL never puts the token in path or query`
- `[SR-10] host shows the anyone-with-this-code notice`
- `[FR-5.6] manual join instructions are always visible`
- `[AR-4] room creation is operable with a TV remote`
- `[SR-9] host logs never include the QR URL or token`

**Anti-rework**

- `publicOrigin` is shared with P2's short TV URL; do not hard-code `vynkzhub.com` in dev.
- The RoomPanel is reusable in the P6 hub lobby.
- Keep QR generation isolated in `QrCode.ts`; P2 can swap in a server-rendered QR if needed.

**Risks**

- A TV browser may not render a large canvas QR sharply; test scan distance and increase module size/render resolution if needed.
- `qrcode` adds bundle bytes; it is host-only and within the 5 MB budget.

---

### D4-HOST-02 — Host reconnect, pause/resume and waiting-for-TV UX

| Field | Value |
|---|---|
| Layer | Host runtime |
| Spec | §7.4, §7.16, §9.1; FR-7.16, FR-9.2; A2 |
| Depends on | D3-RT-03, D4-SRV-03 |
| Unblocks | D7 games, P5 stability |
| Deliverables | `packages/runtime/src/net/hostReconnect.ts`, `src/ui/HostStatus.ts`, `test/hostReconnect.test.ts` |

**Behavior**

- Host stores `{code, hostToken}` in `sessionStorage`; on reload, reconnect and `hostJoin` before creating a new room.
- If `hostJoin` succeeds: rebuild slot UI from the `playerJoined` replay, resume the loop; show "Room resumed".
- If it fails (`expired`/`badHostToken`): create a new room and show a clear message that the old room ended.
- On host tab hidden: send `hostPause`, pause the loop. On visible: `hostResume`, resume the loop.
- On socket close: state `reconnecting`, attempt with backoff 250 ms → 4 s; keep the host token; after 30 s the server expires the room, so stop and create a new room.
- Controllers see `hostStatus` from the server, not from the host directly.
- Host UI shows a status line: Connected / Reconnecting / Room lost.
- No input is simulated while paused; when resumed, `lastMs` resets (D3 loop).

**Steps**

- [ ] Implement `hostReconnect` using the existing `HostClient`; add `hostJoin` retry.
- [ ] Wire `visibilitychange` to `hostPause/Resume` and loop pause/resume.
- [ ] Rebuild the slot table from replayed `playerJoined` events without duplicating rows.
- [ ] On expired host token, clear sessionStorage and create a new room.
- [ ] Add tests with fake timers: drop → retry → resume; 30 s expiry → new room.
- [ ] Add a manual test: refresh the TV page mid-game; room resumes within 30 s.
- [ ] Record the behavior in `docs/RESULTS.md`.

**Acceptance**

- [ ] Host refresh within 30 s resumes the same room and controllers stay connected.
- [ ] Host hidden pauses simulation within one frame; visible resumes without a time jump.
- [ ] Host refresh after 30 s creates a new room with a new code.
- [ ] No duplicate slots in the host table.
- [ ] Controllers show Waiting for TV during the gap.

**Tests (tagged)**

- `[FR-7.16] host reload within 30 seconds resumes with the host token`
- `[FR-9.2] host hidden sends hostPause and pauses simulation`
- `[FR-9.2] host visible sends hostResume without fast-forward`
- `[G4] reconnect does not duplicate or lose slots`
- `[A2] host reconnect uses hostToken, never the room token`

**Anti-rework**

- The host token is the only host re-entry mechanism; do not add a second "resume code".
- P1's relay restart uses the same client behavior; no dev-specific logic.
- Slot replay uses normal player events, so the hub/lobby can reuse it.

**Risks**

- `sessionStorage` is per-tab; a new tab creates a new room. Acceptable for v1; document it.
- TV browsers may not fire `visibilitychange` consistently; also handle `pagehide`/`pageshow` where available.

---

### D4-CTRL-01 — Join flow: QR token, manual code+PIN, session storage

| Field | Value |
|---|---|
| Layer | Controller |
| Spec | §5.2, §5.3; FR-5.1, FR-5.4–5.6; SR-2, SR-4 |
| Depends on | D4-PROTO-01, D4-SRV-01/02, D0-CTRL-01 |
| Unblocks | D4-CTRL-02, D5-CTRL-01, all games |
| Deliverables | `packages/controller/src/join/joinFlow.ts`, `src/join/sessionStore.ts`, `src/join/ManualJoin.ts`, `test/joinFlow.test.ts`, `test/sessionStore.test.ts` |

**Behavior**

- On load:
  1. Parse `/c/<code>` and `location.hash`.
  2. Clear the fragment with `history.replaceState(null, "", pathname + search)`.
  3. Read `sessionStore` for the code. If a session exists and is unexpired, send `join {session}` first.
  4. Else if a room token exists (from the QR or stored), send `join {token}`.
  5. Else show `ManualJoin` (code + PIN) and send `join {pin}`.
- On `joinError`:
  - `expired` with a stored session → try the room token (new join) if available; else show manual join with a message.
  - `badToken`/`badPin` → show the manual form with an inline error; do not loop.
  - `roomFull` → show "Room is full (8/8)" with retry.
  - `rateLimited` → show retry-after seconds; disable submit until then.
- Session storage:
  - `sessionStorage["lanpad.session.<CODE>"] = {session, slot, roomToken?, expiresAt}`.
  - Mirror to `localStorage` with a 4 h expiry for browser restarts; on read, discard if expired.
  - Clear on explicit `leave` and on `kick` (except `hostLost`, which keeps the session for a possible resume? Host-lost kicks after 30 s; clear then).
- Never send the room token for a rejoin if a session exists; the session path is tried first (FR-5.4).
- The room token is kept only to join as a new player after an expired reservation; it is not displayed.
- Manual join validates code 4 chars and PIN 4 digits client-side; server remains authoritative.
- Show a "Joining…" state and a clear error; no dead ends.

**Steps**

- [ ] Implement `parseJoinInput(pathname, hash)` returning `{code, roomToken}`; test percent-encoded hashes and missing values.
- [ ] Implement `sessionStore` with get/set/clear and expiry; test sessionStorage and localStorage fallbacks.
- [ ] Implement the precedence: session → room token → manual.
- [ ] Implement each `joinError` branch with a user-facing message.
- [ ] Clear the fragment before the first network call; test with a spy.
- [ ] Add a test that a rejoin never sends `token` when `session` is present.
- [ ] Add a test that manual join sends only `pin`, never a token.

**Acceptance**

- [ ] QR URL joins in one tap; the fragment is gone from the address bar immediately.
- [ ] Manual code+PIN joins with no camera.
- [ ] A stored valid session reconnects to the same slot.
- [ ] An expired session falls back to the room token and joins as a new player, or shows the manual form.
- [ ] `roomFull`, `rateLimited`, `badPin` each show a distinct, actionable message.
- [ ] No token in any log.

**Tests (tagged)**

- `[FR-5.1] controller reads the token from the fragment and clears it`
- `[FR-5.4] session rejoin is attempted before the shared room token`
- `[FR-5.5] expired session falls back to a new join or manual form`
- `[FR-5.6] manual join works without a camera`
- `[SR-2] the room token never appears in a query string or log`
- `[SR-4] manual join requires the PIN`

**Anti-rework**

- The precedence logic is the only join path for every later stage; games never handle join errors.
- `sessionStore` is reused by D5 hot-swap and D6 lifecycle tests.
- `parseJoinInput` is shared with the dev server's route matching.

**Risks**

- Some browsers strip the fragment on redirects; if the token is missing, manual join must work.
- localStorage can be disabled in private mode; every access must be wrapped in try/catch.

---

### D4-CTRL-02 — Reconnect, heartbeat, suspend/resume, Wake Lock and connection pill

| Field | Value |
|---|---|
| Layer | Controller |
| Spec | §7.4, §8.5; FR-7.14, FR-7.15, FR-8.8; A9 |
| Depends on | D4-CTRL-01, D4-SRV-02/03 |
| Unblocks | D4-QA-01, D5/D6 UX |
| Deliverables | `packages/controller/src/net/reconnect.ts`, `src/lifecycle/suspend.ts`, `src/ui/ConnectionPill.ts`, `src/lifecycle/wakeLock.ts`, `test/reconnect.test.ts`, `test/suspend.test.ts` |

**Behavior**

- Socket close (not explicit leave):
  - Stop the send loop, keep the input state (edges held).
  - Set pill `Reconnecting`.
  - Backoff: 250 ms × 2^n, cap 4 s, ±20% jitter; each attempt sends `join {session}` (D4-CTRL-01 precedence).
  - On success: pill `Connected (P#)`; resume sending; edges accumulated while disconnected are sent once (they are still presses).
  - On `expired`: fall back to a new join or `Disconnected` with a manual form.
- Heartbeat: server pings every 2 s and terminates after 5 s; the controller relies on socket close/error. Additionally, if no server activity for 7 s, proactively close and reconnect (guards blackholed sockets).
- `visibilitychange` hidden:
  - Send `suspend` (if socket open), stop sensors (D6), release Wake Lock, stop the send loop, pause the clock sync.
  - Do not close the socket immediately; the server reserves the slot.
- Visible:
  - If the socket is open, send `join {session}` to resume (or rely on the existing connection if the server kept it). If closed, reconnect.
  - Reacquire Wake Lock; restart clock sync; resume sending.
- Wake Lock: request on `Connected`; release on hidden/disconnected; reacquire on visible. Feature-detect `navigator.wakeLock`; failures are non-fatal and logged to the debug overlay.
- Connection pill states: Connecting, Connected (P#), Reconnecting, Waiting for TV (`hostStatus lost`), Disconnected. `hostStatus paused` shows "TV paused".
- No reconnect when the user explicitly leaves or is kicked for `roomFull`/`expired`.

**Steps**

- [ ] Implement `reconnect` with injectable timers and attempt counter; test the backoff sequence and cap.
- [ ] Preserve edges across a short disconnect; test that a press during the gap is sent on reconnect.
- [ ] Implement `suspend` on hidden and resume on visible; test with fake visibility events.
- [ ] Implement Wake Lock request/release with feature detection and error handling.
- [ ] Implement the pill state machine; map `hostStatus` and socket states.
- [ ] Add a watchdog: no server activity for 7 s → close and reconnect.
- [ ] Add a manual test: lock the phone, unlock, confirm slot recovery and pill transitions.
- [ ] Ensure the send loop never runs while disconnected.

**Acceptance**

- [ ] A 5 s Wi-Fi blip reconnects within 1 s after the network returns, same slot.
- [ ] Locking the phone for < 30 s resumes the same slot; > 30 s joins as new/manual.
- [ ] Pill shows Waiting for TV on host loss and Paused on host pause.
- [ ] No timer leaks after leave/kick.
- [ ] Edges pressed during the gap are not lost (or are explicitly dropped with a counter if too old).

**Tests (tagged)**

- `[FR-7.15] reconnect backoff starts at 250 ms and caps at 4 s`
- `[FR-5.4] reconnect uses the session token and keeps the slot`
- `[FR-7.14] a silent socket is detected and reconnected`
- `[FR-8.8] hidden sends suspend and releases wake lock`
- `[FR-8.8] visible resumes the session`
- `[A9] pill shows Waiting for TV and Paused from hostStatus`
- `[AR-3] wake lock is best-effort and never blocks input`

**Anti-rework**

- The reconnect state machine is the only reconnection logic; games never see it.
- The pill maps protocol states; do not add game-specific messages.
- Suspend/resume hooks are used by D6 to stop sensors.

**Risks**

- Some browsers fire `visibilitychange` on screen lock but not on app switch; test both Android paths.
- Wake Lock is not available on all Android browsers; never gate input on it.
- Holding edges indefinitely could replay an old tap; cap held edges at 5 s and drop with a counter if the disconnect is longer.

---

### D4-TOOL-01 — input-bot: 8 clients, macros, jitter/loss, reconnect

| Field | Value |
|---|---|
| Layer | Tools/CI |
| Spec | §10, §16; G4; §20 E4/E17 |
| Depends on | D0-TOOL-01, D4-SRV-02 |
| Unblocks | D4-QA-01, D7-EXP-01, P5 load tests |
| Deliverables | `tools/input-bot/src/bot.ts` (extended), `src/scenarios.ts`, `macros/*.json`, `test/botScenarios.test.ts` |

**Behavior**

- `--clients 8` creates 8 independent sockets, joins, and holds slots.
- `--jitter-ms 30` delays each packet by a uniform 0–30 ms; `--loss 0.05` drops 5% of level-only packets (never edge packets, to keep the mapper test meaningful).
- `--reconnect-every 60s` closes/reopens a socket with the session token; verify the same slot.
- `--suspend-every 45s` sends `suspend`, waits 1 s, rejoins.
- Scenarios: `steady`, `taps`, `sticks`, `churn` (join/leave/rejoin), `full-room` (9th client expects `roomFull`).
- Output JSON summary per client: slot, sent, edges, reconnects, failures, RTT p50/p95.
- Exit non-zero on any unexpected `joinError` or lost slot.
- Print no PIN/token in logs.

**Steps**

- [ ] Extend the bot with session tracking and the reconnect scenario.
- [ ] Implement jitter/loss injection at the send scheduler, preserving edge packets.
- [ ] Implement `full-room` and `churn` scenarios.
- [ ] Add a 10-minute `steady` scenario for the D4 exit.
- [ ] Add tests for scenario parsing and slot stability with fake timers.
- [ ] Record the 8-client run in `docs/RESULTS.md` (duration, memory if available, failures).

**Acceptance**

- [ ] 8 clients join and hold slots 1–8 for 10 minutes.
- [ ] A 9th gets `roomFull`.
- [ ] `--reconnect-every` recovers the same slot every time.
- [ ] Jitter/loss do not produce a false failure unless the bot itself is at fault.
- [ ] Summary is machine-readable.

**Tests (tagged)**

- `[G4] eight bots hold eight slots for ten minutes`
- `[FR-5.3] ninth bot receives roomFull`
- `[FR-5.4] bot reconnect reclaims its slot`
- `[FR-7.15] bot reconnect backoff is exercised`
- `[SR-9] bot output contains no room token or PIN`

**Anti-rework**

- Scenarios are data/config, reused by D7 soak and P5 load tests.
- The bot uses the protocol, not controller internals; it remains an independent verifier.

**Risks**

- Eight Node clients on one machine can starve timers; record CPU and use one process per client if needed.
- Jitter injection can create false p95 latency; report bot-side delay separately.

---

### D4-EXP-01 — E4 LAN quality, E9 clock fairness, E15 lifecycle, G1 timing

| Field | Value |
|---|---|
| Layer | Experiments/docs |
| Spec | §20 E4/E9/E15; G1; §11 |
| Depends on | D4-CTRL-02, D4-TOOL-01, D4-SRV-03 |
| Unblocks | D7, Gate, P5 |
| Deliverables | `docs/RESULTS.md` rows; `experiments/e09/index.html`; G1 timing notes |

**E4 — LAN network quality**

- Run input-bot Ping/Pong for 1000 samples on 2.4 GHz and 5 GHz, idle and busy.
- Record RTT p50/p95, jitter, loss.
- Pass: p95 < 8 ms on 5 GHz. If not, document Wi-Fi advice and consider wired TV.

**E9 — clock-sync fairness**

- Two phones (or two bots) tap a signal together; compare synced timestamps vs arrival order.
- Use the host signal flash timestamp and controller packet ticks; compute the difference between the two players' implied press times.
- Pass: timestamp error < 5 ms. If not, Reaction Duel uses arrival order plus a documented tie rule.

**E15 — phone lifecycle**

- Lock screen, switch apps, kill the browser; measure reconnect time and slot recovery.
- Pass: recovery < 1 s inside the 30 s reservation.

**G1 — scan-to-playable**

- Record `pageLoadAt`, `joinedAt`, `firstInputSentAt` on the controller; `playerJoinedAt`, `firstInputRenderedAt` on the host.
- Manual stopwatch from QR scan to visible movement; 10 trials.
- Pass: < 5 s median; hard fail 10 s.

**Steps**

- [ ] Build the E9 test page (signal + two-player tap display).
- [ ] Run E4 with the bot, both bands, idle/busy.
- [ ] Run E9 with two phones and with two bots for a repeatable baseline.
- [ ] Run E15 three ways (lock, app switch, browser kill) and record.
- [ ] Run G1 10 times and record median/p95.
- [ ] Record all rows with device, browser, date, method.

**Acceptance**

- [ ] E4 p95 recorded; pass/fail noted.
- [ ] E9 timestamp error recorded; tie rule decided if needed.
- [ ] E15 recovery time recorded for all three lifecycle events.
- [ ] G1 median < 5 s; failures investigated.

**Tests (tagged)**

- `[E4] LAN RTT p95 on 5 GHz is recorded`
- `[E9] synced timestamps agree within 5 ms for simultaneous taps`
- `[E15] slot recovery after lock/app switch/kill is under 1 second`
- `[G1] QR scan to first visible input is under 5 seconds`
- `[FR-7.10] clock sync is based on minimum-RTT samples`

**Anti-rework**

- E9's result determines Reaction Duel's adjudication rule; record it before D7.
- G1 instrumentation is reused in P5; keep the marks in the controller/host code, not the test page.

**Risks**

- Two-phone simultaneity is humanly imprecise; the bot baseline is the controlled measurement.
- AP isolation can block the LAN entirely; record it and use a tunnel for any remote tests.

---

### D4-QA-01 — Reconnect matrix, 8-bot stability and room edge cases

| Field | Value |
|---|---|
| Layer | QA |
| Spec | §16 testing table; §14 D4 exit |
| Depends on | D4-SRV-01..03, D4-CTRL-01/02, D4-TOOL-01 |
| Unblocks | D5 entry |
| Deliverables | `docs/RESULTS.md` D4 row; `docs/DEVICE-MATRIX.md` updates |

**Scenarios**

- [ ] Kill Wi-Fi for 5 s; restore; same slot, input works, pill returns to Connected.
- [ ] Background the phone for 10 s; foreground; same slot.
- [ ] Background the phone for 45 s; foreground; new join or manual form.
- [ ] Kill the browser and reopen the URL; session from localStorage reclaims the slot if < 30 s.
- [ ] Host refresh; room resumes; controllers show Waiting for TV then Connected.
- [ ] Host refresh after 35 s; old room ended; new room.
- [ ] 9th controller; `roomFull`.
- [ ] Wrong PIN 5 times; lockout; correct PIN after lockout.
- [ ] Room idle for 10 min; expiry and kick.
- [ ] 8 bots for 10 min with 30 ms jitter; no slot loss, no crash.

**Steps**

- [ ] Run each scenario on Android Chrome and desktop Chrome; record pass/fail.
- [ ] Use the input-bot for the 8-client/10-minute run; record memory of the server process if available.
- [ ] Record the exact steps for each scenario so they are repeatable.
- [ ] Add any discovered bug as a new work item rather than a note.
- [ ] Update `docs/DEVICE-MATRIX.md` with the lifecycle results.

**Acceptance**

- [ ] All scenarios pass or have a documented, accepted deviation.
- [ ] 8 bots hold slots for 10 min.
- [ ] No token leak in logs during the matrix.
- [ ] Results include device, browser, date.

**Tests (tagged)**

- `[FR-5.4] reconnect matrix preserves slots within 30 seconds`
- `[FR-5.5] expired reservation joins as new`
- `[FR-7.16] host refresh resumes or ends the room correctly`
- `[G4] eight bots remain stable for ten minutes`
- `[SR-5] brute-force PIN attempts are locked out`

**Anti-rework**

- This matrix is the regression suite for every later stage; automate the bot-able parts.
- P5 reuses it with production targets.

**Risks**

- Manual lifecycle tests vary by Android OEM; record the device and OS version.
- Server memory measurement on Windows dev is approximate; use `process.memoryUsage()` in the bot summary if needed.

---

## Stage exit checklist

- [ ] D4-PROTO-01, D4-SRV-01..03, D4-HOST-01/02, D4-CTRL-01/02, D4-TOOL-01, D4-EXP-01, D4-QA-01 complete.
- [ ] QR and manual join both work; token is fragment-only.
- [ ] Session rejoin, 30 s reservation, host-lost recovery and pause/resume work.
- [ ] 8 bots stable for 10 minutes.
- [ ] G1 median < 5 s.
- [ ] E4/E9/E15 recorded.
- [ ] No token/PIN in logs or DOM.
- [ ] A9 recorded in README and TRACEABILITY.
- [ ] `docs/RESULTS.md` D4 row complete.

## Handoff to D5

- D5 routing uses `slot` identity from sessions; panels/events are addressed by slot.
- `hostStatus` drives the controller UI during layout swaps and panel updates.
- D5 must not add its own reconnect/session logic.
- The host's slot replay on reconnect must also rebuild layout/panel state in D5 (re-send current layout/panel on `playerResumed`).

## Explicitly not in D4

- Full layout system, panels, text, canvas, events (D5).
- Sensors and haptics (D6).
- Production relay/TLS/DNS (P1/P2).
- iOS testing (A5).
