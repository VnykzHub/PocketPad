# Layer: Protocol

**Package:** `packages/protocol`
**Owns:** wire types, constants, binary codecs, JSON message catalogue, frame validation, protocol version.
**Must not own:** sockets, rooms, sessions, rendering, game rules.
**Goal contribution:** G2 (hot path), G3 (zero-dependency byte budget), G4 (caps/slots), G5 (input fields), G7 (zero deps), G8 (public contract).

## Invariants

1. Zero runtime dependencies; no Node built-ins; runs in Node, browsers and Deno (FR-10.1).
2. Binary frames are little-endian `DataView`; sizes are exact and tested.
3. JSON control messages are one discriminated union on `t`; unknown `t` is rejected.
4. Frame caps: binary ≤ 64 B, JSON ≤ 4096 UTF-8 bytes; server closes on violation (SR-6).
5. Additive changes only within `PROTOCOL_VERSION = 1`; breaking changes bump the version and return `badVersion` (A10).
6. `tick` is a u32 server-time millisecond estimate, not a frame count (A3).
7. Layout/panel bodies are opaque `JsonValue`; the protocol never interprets them (FR-7.9).

## Todo index

| ID | Title | Stage | File |
|---|---|---|---|
| D0-PROTO-01 | Constants, types, message catalogue | D0 | `phase-1-dev/D0-foundations.md` |
| D0-PROTO-02 | Binary codecs + property/golden tests | D0 | `phase-1-dev/D0-foundations.md` |
| D0-PROTO-03 | JSON framing, validation, frame caps | D0 | `phase-1-dev/D0-foundations.md` |
| D4-PROTO-01 | Session/host-state/reconnect messages (A9, A10) | D4 | `phase-1-dev/D4-pairing-sessions.md` |
| D5-PROTO-01 | `layoutAck`, event/panel validation completion | D5 | `phase-1-dev/D5-layouts-events.md` |
| P1-SRV-01 | Relay consumes protocol in production | P1 | `phase-2-production/P1-relay.md` |
| P4-DOCS-02 | Protocol reference documentation | P4 | `phase-2-production/P4-sdk-open-source.md` |

## Requirement coverage

| Requirement | Where |
|---|---|
| FR-4.4 | D0-PROTO-01 (WS-only constants) |
| FR-7.2, FR-7.4–7.6 | D0-PROTO-01/02 |
| FR-7.3, FR-7.11/7.12 | D0-PROTO-02 + D2-RT-01 |
| FR-7.8, FR-7.9 | D0-PROTO-03, D5-PROTO-01, D5-SRV-01 |
| FR-7.10 | A3 + D3-RT-03 + D4-EXP-01 |
| FR-10.1 | D0-PROTO-01 dependency test |
| SR-6 | D0-PROTO-02/03, D5-SRV-01, P1-SRV-02 |
| SR-11 | D0-SRV-03, P1-SRV-03 (Origin is transport, but close codes/limits live here) |
| A2, A3, A9, A10, A11 | D0/D4/P3 protocol additions |

## Verification

- Property tests round-trip every frame type (fast-check, ≥ 1000 cases).
- Golden vectors pin endianness and byte offsets.
- A dependency test asserts `dependencies` is empty.
- The trace checker maps every requirement above to a tagged test.

## Change rules

- New message → add union variant + validator + test; no side-channel formats.
- New field → optional, documented, version-compatible.
- Never put game-specific fields in the protocol; use opaque `event`/`panel` data.
- Never add a dependency to this package. If a codec needs compression/encryption, it belongs in a higher layer.
