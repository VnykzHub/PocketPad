# D0 — Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Goal:** Stand up the monorepo, the protocol, the dev server and broker skeleton, the size gate, and the input-bot so two clients can join a room and echo input.
>
> **Architecture:** npm-workspace monorepo. `packages/protocol` is the zero-dependency wire contract; `packages/broker` owns rooms/slots/tokens/fan-out; `packages/dev-server` adds static serving, LAN discovery and a WebSocket adapter; the host and controller pages are thin shells. Everything later is built on these interfaces.
>
> **Tech stack:** Node.js LTS, TypeScript strict, npm workspaces, Vite, `ws`, `sirv`, `qrcode`, Vitest, fast-check, ESLint, GitHub Actions.
>
> **Spec:** `SPEC.md` §4, §5, §6.1, §7, §10, §13, §14 D0, §16, §20.
>
> **Program position:** Phase 1, first stage. D0's exit is the entry condition for D1 and D2. Nothing here may depend on later-stage code.

## Global constraints (apply to every task)

- Node.js ≥ 20; ESM only; TypeScript `strict: true`.
- `packages/protocol` has **zero runtime dependencies** (FR-10.1) and no Node built-ins.
- WebSocket is the only transport (FR-4.4). Binary frames are little-endian `DataView`; JSON control messages are a discriminated union on `t`.
- Frame caps: binary ≤ 64 bytes, JSON ≤ 4096 UTF-8 bytes; violation closes the socket (SR-6).
- All client code resolves the server origin from config; no `ws://`/`wss://` literals outside config files (FR-4.3/4.6).
- No tokens, PINs or message bodies in logs (SR-9, SR-12).
- Every test title carries its requirement ID, e.g. `[FR-7.3] ...` (TR-1).
- No game logic, layout rendering, sensors, production infra or sessions in D0.

---

## Stage goal and exit criteria

**Exit criteria (from §14 D0):**

> Two clients join a room and echo input. CI size gate is live.

Concretely:

- [ ] `npm ci && npm run check` passes from a clean clone.
- [ ] A host page creates a room, connects as host, and shows live input from two controller pages.
- [ ] Two independent clients (browser tabs or input-bots) join the same room and their input is forwarded with slots 1 and 2.
- [ ] The size gate fails the build when the controller exceeds 60 KB gz; current sizes are recorded.
- [ ] Protocol property tests and golden vectors pass.
- [ ] CI workflow runs typecheck, lint, tests, builds, size gate, trace check.
- [ ] No token appears in any log line (checked by a test).

**Layer coverage in D0**

| Layer | Work items |
|---|---|
| Protocol | D0-PROTO-01, D0-PROTO-02, D0-PROTO-03 |
| Server | D0-SRV-01, D0-SRV-02, D0-SRV-03 |
| Host runtime | D0-RT-01 |
| Controller | D0-CTRL-01 |
| SDK | D0-SDK-01 |
| Tools/CI | D0-TOOL-01, D0-TOOL-02 |
| QA / docs | D0-QA-01, D0-QA-02 |
| Repo/tooling | D0-REPO-01 |

**Goals advanced:** G1 (room skeleton), G2 (binary hot path from day one), G3 (size gate), G4 (8-slot model), G5 (button/axis wire format), G7 (dependency discipline), G8 (manifest contract).

---

## Contracts frozen in D0

These are consumed by every later stage. Additive changes are allowed; renames or semantic changes require a `PROTOCOL_VERSION` bump.

1. `packages/protocol` constants: `PROTOCOL_VERSION = 1`, `TICK_HZ = 60`, `MAX_CONTROLLERS = 8`, frame caps, message IDs, button bits, JSON message union.
2. Input binary layout: 26 bytes with type; `InputFwd` 27 bytes with slot; little-endian.
3. `tick` = client estimate of server time in ms at send, truncated to u32 (A3).
4. `POST /api/rooms` response: `{ code, pin, roomToken, hostToken, expiresAt, serverTime }` (A8).
5. Host WebSocket auth: `hostJoin {v, code, hostToken}` → `hostJoined {code, serverTime}` (A2).
6. WebSocket endpoint: `/ws`; health: `GET /healthz`; dev routes `/`, `/c/*`, `/x/*`, `/games/*`.
7. Room model fields (even if D0 only populates some): code, pin, tokens, createdAt, lastActivityAt, state, host peer, controllers by slot, reservations.
8. Manifest contract (`sdk/src/manifest.ts`): required fields from FR-10.3.
9. Config contract: `resolveServerOrigin()` + `toWebSocketUrl()`; `VITE_SERVER_ORIGIN` build-time override.
10. Test tag convention and `TRACEABILITY.md` as the canonical ID list.

---

## Work items

### D0-REPO-01 — Workspace scaffold and dependency policy

| Field | Value |
|---|---|
| Layer | Tools/CI + repo |
| Spec | §10, §6, §16; FR-10.1, FR-10.2; NR-6.1, NR-6.3; G7 |
| Depends on | — |
| Unblocks | every other D0 item |
| Deliverables | root `package.json`, `tsconfig.base.json`, `eslint.config.js`, `vitest.config.ts`, `.gitignore`, `.editorconfig`, `.github/workflows/ci.yml`, `docs/DEPENDENCIES.md` |

**Steps**

- [ ] Create the root `package.json`:
  ```json
  {
    "name": "lanpad",
    "private": true,
    "type": "module",
    "workspaces": ["packages/*", "sdk", "tools/*"],
    "engines": { "node": ">=20" },
    "scripts": {
      "build": "npm run build --workspaces --if-present",
      "typecheck": "tsc -b",
      "lint": "eslint .",
      "test": "vitest run",
      "size": "node tools/size-budget/dist/cli.js",
      "trace": "node tools/trace-check/dist/cli.js",
      "check": "npm run typecheck && npm run lint && npm run test && npm run build && npm run size && npm run trace"
    }
  }
  ```
- [ ] Add `tsconfig.base.json`: `target: ES2022`, `module: ESNext`, `moduleResolution: Bundler`, `strict: true`, `noUncheckedIndexedAccess: true`, `noImplicitOverride: true`, `exactOptionalPropertyTypes: true`, `verbatimModuleSyntax: true`, `lib: ["ES2022", "DOM", "DOM.Iterable"]` (server packages override `lib` to `["ES2022"]` and add `types: ["node"]`).
- [ ] Add `eslint.config.js` with the dependency rules:
  - `packages/runtime/**` may not import `@lanpad/controller`.
  - `packages/controller/**` may not import `@lanpad/runtime` or `@lanpad/broker`.
  - `packages/games/**` may not import `@lanpad/broker`, `@lanpad/dev-server`, `@lanpad/relay`, `@lanpad/controller`.
  - `packages/protocol/**` may not import any other workspace package.
  - `no-restricted-syntax` bans string literals matching `/^wss?:\/\//` outside `**/config.ts`, `**/*.test.ts`, and `tools/**`.
- [ ] Add `vitest.config.ts` with projects for `packages/*`, `sdk`, `tools/*`; node environment default, jsdom only for controller tests (add `jsdom` as a dev dependency and justify it).
- [ ] Add `.github/workflows/ci.yml`: checkout → `actions/setup-node@v4` with Node 20 and npm cache → `npm ci` → `npm run check`.
- [ ] Write `docs/DEPENDENCIES.md` with a table: package, version, why, browser byte cost (gz), alternative rejected. At D0 it lists `ws`, `sirv`, `qrcode`, `vite`, `three` (planned), and dev-only tools. Rule: no dependency enters without a row.
- [ ] Add `.gitignore`: `node_modules/`, `dist/`, `coverage/`, `.env`, `.env.*`, `*.local`, `*.log`.
- [ ] Run `npm install` once to generate a single root lockfile; commit it. Verify every workspace resolves.

**Acceptance**

- [ ] `npm ci` from a clean clone succeeds on Windows and Linux CI.
- [ ] `npm run typecheck`, `npm run lint`, `npm run test` run (empty suites are allowed until the next items add tests).
- [ ] The ESLint import restrictions are verified by a deliberately failing fixture test (or an inline `// eslint-disable` check in CI is forbidden).
- [ ] `docs/DEPENDENCIES.md` has a row for every dependency in every `package.json`.

**Anti-rework**

- One lockfile at the root. No per-package lockfiles.
- Workspace packages are named `@lanpad/<name>` and export ESM only.
- CI invokes the same `npm run check` developers run; no CI-only scripts.
- `three` is listed but not installed until D3; do not add a dependency earlier than the task that uses it.

**Risks**

- `exactOptionalPropertyTypes` can be noisy with optional JSON fields; if it blocks the protocol union, relax it only in the protocol package and record why in `docs/DEPENDENCIES.md`/an ADR.
- `jsdom` adds install weight; keep it dev-only and scoped to controller tests.

---

### D0-PROTO-01 — Protocol constants, types and message catalogue

| Field | Value |
|---|---|
| Layer | Protocol |
| Spec | §7.1, §7.2, §7.4; FR-7.2, FR-7.4, FR-7.5, FR-7.6; FR-4.4, FR-10.1; SR-6; A2, A3 |
| Depends on | D0-REPO-01 |
| Unblocks | D0-PROTO-02, D0-PROTO-03, D0-SRV-02, D0-CTRL-01, D0-RT-01 |
| Deliverables | `packages/protocol/package.json`, `src/constants.ts`, `src/messages.ts`, `src/index.ts`, `test/constants.test.ts` |

**Freeze this interface**

```ts
// src/constants.ts
export const PROTOCOL_VERSION = 1;
export const TICK_HZ = 60;
export const MAX_CONTROLLERS = 8;
export const MAX_BINARY_FRAME_BYTES = 64;
export const MAX_JSON_FRAME_BYTES = 4096;
export const MAX_HAPTIC_STEPS = 8;
export const INPUT_FRAME_BYTES = 26;
export const INPUT_FWD_FRAME_BYTES = 27;
export const ROOM_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ROOM_CODE_LENGTH = 4;
export const ROOM_PIN_LENGTH = 4;
export const TOKEN_BYTES = 16;
export const TOKEN_LENGTH = 22; // base64url of 16 bytes

export const MSG = {
  Input: 0x02,
  Ping: 0x03,
  Pong: 0x82,
  Haptic: 0x84,
  HapticCmd: 0xa2,
  InputFwd: 0xb2,
} as const;

export const BUTTON_BITS = {
  A: 0, B: 1, X: 2, Y: 3,
  L1: 4, R1: 5, L2: 6, R2: 7,
  DUp: 8, DDown: 9, DLeft: 10, DRight: 11,
  L3: 12, R3: 13, Start: 14, Select: 15,
} as const;
```

```ts
// src/messages.ts
export type JsonValue =
  | string | number | boolean | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JoinErrorReason =
  | "roomFull" | "badToken" | "badPin" | "expired"
  | "rateLimited" | "badCode" | "badHostToken";

export interface SlotStats {
  slot: number;
  rttMs: number;
  jitterMs: number;
  lastInputAgeMs: number;
  packetsPerSecond: number;
  drops: number;
}

export type ClientToServerMessage =
  | { t: "join"; v: number; code: string; token?: string; pin?: string; session?: string; name?: string }
  | { t: "hostJoin"; v: number; code: string; hostToken: string }
  | { t: "suspend" }
  | { t: "leave" }
  | { t: "event"; slot: number; name: string; data: JsonValue };

export type HostToServerMessage =
  | { t: "hostPause" }
  | { t: "hostResume" }
  | { t: "setLayout"; slot: number | "all"; layout: JsonValue }
  | { t: "panel"; slot: number; content: JsonValue };

export type ServerToClientMessage =
  | { t: "joined"; slot: number; session: string; serverTime: number; layout?: JsonValue }
  | { t: "hostJoined"; code: string; serverTime: number }
  | { t: "joinError"; reason: JoinErrorReason }
  | { t: "playerJoined"; slot: number }
  | { t: "playerLeft"; slot: number }
  | { t: "playerSuspended"; slot: number }
  | { t: "playerResumed"; slot: number }
  | { t: "setLayout"; slot: number | "all"; layout: JsonValue }
  | { t: "panel"; slot: number; content: JsonValue }
  | { t: "kick"; reason: string }
  | { t: "stats"; slots: SlotStats[] };

export type JsonControlMessage =
  | ClientToServerMessage
  | HostToServerMessage
  | ServerToClientMessage;
```

**Steps**

- [ ] Create `packages/protocol/package.json` with `"name": "@lanpad/protocol"`, `"type": "module"`, `"sideEffects": false`, `"dependencies": {}`, and an `exports` map for `"."`.
- [ ] Implement the constants and types above. Use `as const` objects, not enums (no TS runtime dependency).
- [ ] Add `src/index.ts` re-exporting both files.
- [ ] Add a test that reads `package.json` and asserts `dependencies` is empty (FR-10.1).
- [ ] Add a compile-time test (type-level `Expect<Equal<...>>` or `@ts-expect-error`) that rejects a message with an unknown `t` and a `join` without `code`.
- [ ] Add a snapshot test for `MSG` values and button bit positions (FR-7.2).

**Acceptance**

- [ ] `PROTOCOL_VERSION`, message IDs, button bits and frame sizes match the spec tables exactly.
- [ ] The package has no runtime dependencies and imports no Node built-ins.
- [ ] `tsc -b packages/protocol` produces no errors under strict mode.

**Tests (tagged)**

- `[FR-10.1] protocol package has zero runtime dependencies`
- `[FR-7.2] button bitfield matches spec positions`
- `[FR-7.4] analog and trigger ranges are documented in types` (type-level)
- `[FR-4.4] only WebSocket transport constants are exported`

**Anti-rework**

- `Layout` and `PanelContent` are `JsonValue` here. Do not import the SDK into protocol; the server is not allowed to interpret them (FR-7.9).
- The JSON union is the single catalogue. Later stages add variants; they do not create side-channel message types.
- `tick` is a u32 millisecond timestamp (A3); write a comment in `messages.ts` so nobody later treats it as a frame counter.

**Risks**

- A single union for both directions makes it possible to send the wrong message type. The broker's router (D0-SRV-02) must reject messages not valid for the peer role.

---

### D0-PROTO-02 — Binary codecs and property tests

| Field | Value |
|---|---|
| Layer | Protocol |
| Spec | §7.1, §7.3; FR-7.3, FR-7.4, FR-7.5, FR-7.6; SR-6; §16 |
| Depends on | D0-PROTO-01 |
| Unblocks | D0-SRV-02, D0-SRV-03, D0-TOOL-01, D2-CTRL-03, D2-RT-01 |
| Deliverables | `src/binary.ts`, `test/binary.test.ts`, `test/binary.golden.test.ts` |

**Freeze this interface**

```ts
export interface InputState {
  tick: number;      // u32, server-time ms estimate (A3)
  buttons: number;   // u16 level
  edges: number;     // u16 press edges
  lx: number; ly: number; rx: number; ry: number; // i16
  gx: number; gy: number; gz: number;             // i16, dps x10
  lt: number; rt: number;                         // u8
  flags: number;                                  // u8
}

export class ProtocolError extends Error {
  constructor(readonly code: "tooLarge" | "badType" | "badLength" | "badValue", message: string);
}

export function frameType(frame: Uint8Array): number | null;
export function encodeInput(state: InputState): Uint8Array;              // 26
export function decodeInput(frame: Uint8Array): InputState;              // allocates
export function decodeInputInto(frame: Uint8Array, out: InputState): InputState;
export function encodeInputFwd(slot: number, state: InputState): Uint8Array; // 27
export function decodeInputFwd(frame: Uint8Array): { slot: number; state: InputState };
export function decodeInputFwdInto(frame: Uint8Array, out: InputState): number;
export function encodePing(clientTimeMs: number): Uint8Array;            // 5
export function decodePing(frame: Uint8Array): { clientTimeMs: number };
export function encodePong(clientTimeMs: number, serverTimeMs: number): Uint8Array; // 9
export function decodePong(frame: Uint8Array): { clientTimeMs: number; serverTimeMs: number };
export function encodeHaptic(durationsMs: readonly number[]): Uint8Array;    // 2 + 2n
export function decodeHaptic(frame: Uint8Array): number[];
export function encodeHapticCmd(slot: number, durationsMs: readonly number[]): Uint8Array; // 3 + 2n (type + slot + n)
export function decodeHapticCmd(frame: Uint8Array): { slot: number; durationsMs: number[] };
```

**Steps**

- [ ] Implement an internal `Writer`/`Reader` pair over `DataView`; all multi-byte writes use `littleEndian = true`.
- [ ] Encode `Input` exactly as: type (u8), tick (u32), buttons (u16), edges (u16), lx/ly/rx/ry (i16 ×4), gx/gy/gz (i16 ×3), lt/rt (u8 ×2), flags (u8) = 26 bytes.
- [ ] Encode `InputFwd` as: type 0xB2 (u8), slot (u8), then the same 25-byte body without the Input type = 27 bytes.
- [ ] Encode `Ping` as type + u32 = 5 bytes; `Pong` as type + u32 + u32 = 9 bytes.
- [ ] Encode `Haptic` as type + n (u8) + n × u16; `HapticCmd` as type + slot + n + n × u16. Reject `n > 8` with `ProtocolError("badValue")`.
- [ ] Clamp analog inputs to `[-32768, 32767]`, triggers to `[0, 255]`, buttons/edges to `0xffff`; `InputFwd` slot is `1..8`; `HapticCmd` slot is `0..8` (0 = all, D6); reject non-finite numbers with `ProtocolError("badValue")`.
- [ ] Decode must validate exact lengths and type bytes; reject anything over `MAX_BINARY_FRAME_BYTES` before reading (`ProtocolError("tooLarge")`).
- [ ] Implement `decodeInputInto` / `decodeInputFwdInto` without allocation for the host hot path (PR-9.3 groundwork).
- [ ] Write golden vectors for endianness: `tick = 0x01020304` → bytes `04 03 02 01`; `lx = -1` → `ff ff`; `lx = 32767` → `ff 7f`; `lx = -32768` → `00 80`.
- [ ] Write fast-check properties: arbitrary `InputState` round-trips exactly; arbitrary duration arrays of length 0–8 round-trip; wrong type/truncated/oversized frames throw the expected `ProtocolError`; encode length is always exact.

**Acceptance**

- [ ] All frame sizes asserted in tests: Input 26, InputFwd 27, Ping 5, Pong 9, Haptic 2 + 2n, HapticCmd 3 + 2n (type + slot + n).
- [ ] Golden vectors prove little-endian encoding.
- [ ] Property tests run ≥ 1000 cases per property and pass.
- [ ] `frameType` returns `null` for an empty frame and the correct ID for each valid frame.

**Tests (tagged)**

- `[FR-7.3] input round-trip preserves edges including level zero`
- `[FR-7.4] analog i16 round-trip at min, max and zero`
- `[FR-7.5] gyro dps x10 round-trip`
- `[FR-7.6] reserved flag bits survive round-trip`
- `[SR-6] binary frame over 64 bytes is rejected`
- `[PR-9.3] decodeInputInto performs no allocation` (fixture: reuse an `out` object, assert identity)

**Anti-rework**

- Do not use `Buffer`; use `Uint8Array` + `DataView` so the package runs in Deno and browsers (FR-10.1).
- Do not add fields to Input. Add a new message type + version bump if the wire format must grow.
- Keep `decodeInputInto` as the hot-path API; games and mappers must not call the allocating decoder per packet.

**Risks**

- `exactOptionalPropertyTypes` and optional JSON fields: the binary types have no optionals.
- JavaScript bitwise ops are signed 32-bit; use `>>> 0` when packing u32 and `& 0xffff` for unsigned 16-bit.

---

### D0-PROTO-03 — JSON framing, validation and frame caps

| Field | Value |
|---|---|
| Layer | Protocol / Server |
| Spec | §7.2; SR-6, SR-9; A2 |
| Depends on | D0-PROTO-01 |
| Unblocks | D0-SRV-02, D0-SRV-03, D0-CTRL-01, D4-PROTO-01, D5-PROTO-01 |
| Deliverables | `src/json.ts`, `test/json.test.ts` |

**Freeze this interface**

```ts
export function jsonByteLength(text: string): number;          // TextEncoder, UTF-8
export function parseJsonMessage(text: string): JsonControlMessage;
export function stringifyJsonMessage(message: JsonControlMessage): string;
export function assertJsonWithinLimit(text: string): void;     // throws ProtocolError("tooLarge")
export function isClientToServerMessage(m: JsonControlMessage): m is ClientToServerMessage;
export function isHostToServerMessage(m: JsonControlMessage): m is HostToServerMessage;
```

**Validation rules**

- Reject text whose UTF-8 byte length > 4096 (`tooLarge`).
- Reject invalid JSON, non-object roots, missing/unknown `t` (`badType`).
- `join`: `v` number, `code` string of length 4, `name` optional ≤ 24 chars. Credentials are one of: `session` alone; `token` alone; `pin` alone; or `token` + `pin` together when the room has `requirePinForQr` (A11). `session` never combines with token/pin.
- `hostJoin`: `v` number, `code` length 4, `hostToken` length 22.
- `event`: `slot` integer 1–8, `name` ≤ 64 chars, `data` any `JsonValue`.
- `setLayout`: `slot` either 1–8 or `"all"`, `layout` any `JsonValue`.
- `panel`: `slot` 1–8, `content` any `JsonValue`.
- `joinError.reason` in the allowed union.
- Do **not** validate layout/panel internals here; that is the SDK validator's job and the server must stay opaque (FR-7.9).

**Steps**

- [ ] Implement `jsonByteLength` with a cached `TextEncoder`.
- [ ] Implement `parseJsonMessage` with a single structural validator per message type; no `eval`, no prototype walking.
- [ ] Implement role guards (`isClientToServerMessage`, `isHostToServerMessage`) so the broker can reject wrong-direction messages.
- [ ] Add tests for 4096-byte accept and 4097-byte reject using multi-byte UTF-8 to prove byte (not character) counting.
- [ ] Add tests for every malformed case above.
- [ ] Add a test that a layout object with arbitrary nested `JsonValue` passes through unchanged (FR-7.9 groundwork).

**Acceptance**

- [ ] A 4097-byte string of `é` characters is rejected; a 4096-byte ASCII string is accepted.
- [ ] Unknown `t`, missing required fields, wrong `slot`, and `session` combined with token/pin are rejected; `token` + `pin` is accepted only when `requirePinForQr` is on (A11).
- [ ] The parser never inspects `layout`/`content` beyond `JsonValue` shape.

**Tests (tagged)**

- `[SR-6] JSON frame over 4096 bytes is rejected and closes the socket`
- `[FR-7.9] arbitrary panel body passes through unmodified`
- `[FR-5.1] join accepts token, pin, session, or token+pin in QR PIN mode; not session+token`
- `[A2] hostJoin requires code and hostToken`

**Anti-rework**

- All server and client JSON goes through this module; no ad-hoc `JSON.parse`.
- Add a new message by adding a validator branch + union variant; do not add a second parser.

**Risks**

- `JSON.parse` accepts `__proto__` keys; since values are passed through to game code, the controller must render with `textContent` and the SDK validator must reject dangerous panel shapes in D5. The parser itself must not merge objects.

---

### D0-SRV-01 — Dev server: static serving, LAN discovery, warning, terminal QR

| Field | Value |
|---|---|
| Layer | Server |
| Spec | §4.2, §6.1, §14 D0; SR-3; FR-9.12 |
| Depends on | D0-REPO-01 |
| Unblocks | D0-SRV-02, D0-RT-01, D0-CTRL-01, D1-EXP-01 |
| Deliverables | `packages/dev-server/package.json`, `src/main.ts`, `src/static.ts`, `src/lan.ts`, `src/terminal.ts`, `test/lan.test.ts`, `test/routes.test.ts` |

**Freeze this interface**

```ts
export interface DevServerConfig {
  host: string;              // default 0.0.0.0
  port: number;              // default 8080
  staticRoots: {
    host: string;            // packages/runtime/dist
    controller: string;      // packages/controller/dist
    games: string;           // packages/games/dist
    experiments: string;     // experiments
  };
  allowedOrigins: string[];  // derived at boot from LAN IPs + localhost
}

export function lanUrls(port: number, interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string[];
```

**Routes**

| Method | Path | Behavior |
|---|---|---|
| GET | `/` | host page `index.html` (no-store) |
| GET | `/c/*` | controller page `index.html` (SPA fallback, no-store) |
| GET | `/games/*` | game bundles, immutable cache |
| GET | `/x/*` | experiments, no-store |
| GET | `/assets/*` | built assets, immutable cache |
| GET | `/healthz` | `{ ok: true, now, rooms }` |
| POST | `/api/rooms` | creates a room via the broker (D0-SRV-02) |
| GET | `/ws` upgrade | WebSocket (D0-SRV-03) |

**Steps**

- [ ] Create the Node HTTP server; configure `sirv` for each static root with `single: true` only for `/` and `/c/*`.
- [ ] Implement `lanUrls`: collect non-internal IPv4 addresses, return `http://<ip>:<port>` plus `http://localhost:<port>`.
- [ ] Print at boot:
  ```
  lanpad dev server
  TV / host:   http://192.168.1.20:8080/
  Controller:  http://192.168.1.20:8080/c/<CODE>
  WARNING: LAN only. This server has no TLS and no production hardening.
  Do not expose it to a public network. (SR-3)
  ```
- [ ] Print a terminal QR for the root URL using `qrcode` (`toString(url, {type:"terminal", small:true})`).
- [ ] Derive `allowedOrigins` from `lanUrls` and pass it to the broker/WS adapter; never use `*`.
- [ ] Add security headers on HTML: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, a dev CSP: `default-src 'self'; connect-src 'self' ws:; img-src 'self' data:; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'`.
- [ ] Cache policy: HTML and `/x/*` → `Cache-Control: no-store`; hashed assets and game bundles → `public, max-age=31536000, immutable`.
- [ ] Log only method, path, status, duration; never query strings, tokens or headers (SR-9).

**Acceptance**

- [ ] `http://localhost:8080/` serves the host shell; `/c/ABCD` serves the controller shell; `/x/e1` serves an experiment placeholder.
- [ ] The boot log lists every LAN URL and the warning; QR renders in a standard Windows terminal.
- [ ] A request with an unlisted `Origin` is rejected at the WS upgrade (tested in D0-SRV-03).
- [ ] Static traversal (`/c/../../etc/passwd`) returns 404, not a file.

**Tests (tagged)**

- `[SR-3] dev server boot prints the LAN-only warning`
- `[FR-9.12] root route serves the host page`
- `[SR-11] allowed origins contain only LAN/localhost URLs`
- `[FR-4.3] URL builder uses the request origin, not a hard-coded host`

**Anti-rework**

- The dev server is an adapter: static + LAN + WS. Room logic stays in `packages/broker` (A1).
- Route mapping is shared with the production adapter where possible; P2 reuses the same build outputs.
- Do not add CORS headers. Dev is same-origin; production is config-driven.

**Risks**

- `sirv` SPA fallback can mask missing assets; ensure `/assets/*` returns 404 rather than `index.html`.
- Windows firewall may block LAN access; D1's device checklist records the actual phone→PC reachability.

---

### D0-SRV-02 — Broker core: room registry, create/join, echo

| Field | Value |
|---|---|
| Layer | Server (broker) |
| Spec | §4.5, §5, §7; §14 D0; A1, A2, A8; FR-5.2, FR-5.3; SR-1, SR-5 |
| Depends on | D0-PROTO-01, D0-PROTO-02, D0-PROTO-03 |
| Unblocks | D0-SRV-03, D0-RT-01, D0-CTRL-01, D4-SRV-01..03 |
| Deliverables | `packages/broker/package.json`, `src/room.ts`, `src/registry.ts`, `src/peer.ts`, `src/index.ts`, `test/registry.test.ts` |

**Freeze this interface**

```ts
export interface Peer {
  send(data: string | Uint8Array): void;
  close(code: number, reason: string): void;
  readonly remoteAddress: string;
}

export interface RoomCredentials {
  code: string;
  pin: string;
  roomToken: string;
  hostToken: string;
  expiresAt: number; // epoch ms, creation + 4h
  serverTime: number;
}

export interface Room {
  code: string;
  pin: string;
  roomToken: string;
  hostToken: string;
  createdAt: number;
  lastActivityAt: number;
  state: "active" | "hostLost" | "expired";
  host: Peer | null;
  controllers: Map<number, ControllerSlot>; // 1..8
  reservations: Map<string, { slot: number; expiresAt: number }>; // session -> reservation, filled in D4
}

export interface JoinRequest {
  code: string;
  token?: string;
  pin?: string;
  session?: string;
  name?: string;
}

export type JoinResult =
  | { ok: true; slot: number; session: string; serverTime: number }
  | { ok: false; reason: JoinErrorReason };

export class RoomRegistry {
  constructor(deps: { now: () => number; randomBytes: (n: number) => Uint8Array; logger: Logger });
  createRoom(): RoomCredentials;
  hostJoin(code: string, hostToken: string, peer: Peer): { ok: true } | { ok: false; reason: JoinErrorReason };
  join(req: JoinRequest, peer: Peer): JoinResult;
  routeInput(code: string, slot: number, state: InputState): void; // forwards InputFwd to host
  sweep(): void;
}
```

**D0 behavior (minimal, no sessions yet)**

- `createRoom`: generate code (4 chars from Crockford alphabet, retry until unique, max 10 tries), PIN (4 digits), room token and host token (16 random bytes base64url); insert; return credentials.
- `hostJoin`: look up by code, constant-time compare `hostToken`; attach peer; reject a second host.
- `join`: look up by code; if no room or expired → `badCode`/`expired`; validate token (constant-time) or PIN (constant-time, 4 digits); find lowest free slot 1..8; if none → `roomFull`; create a session token; attach peer; return slot/session/serverTime.
- `routeInput`: encode `InputFwd` and send to `room.host`; if host absent, drop and count.
- `sweep`: expire rooms whose `createdAt + 4h < now` or `lastActivityAt + 10min < now`; D0 can call it every 1s.
- Any input from a controller with no valid slot is dropped; never broadcast to other controllers.

**Steps**

- [ ] Create `packages/broker` with `ws` as its only runtime dependency (it is the server layer; protocol stays zero-dep).
- [ ] Implement random code/token/PIN generation using `node:crypto` injected through a `randomBytes` function so tests are deterministic.
- [ ] Implement constant-time compare with `crypto.timingSafeEqual` on equal-length buffers; compare lengths first without early-exit leaks.
- [ ] Implement lowest-free-slot assignment and the 9th `roomFull` result.
- [ ] Implement a `Logger` interface with `info(event: string, fields: Record<string, string|number>)`; the broker logs `room.create`, `room.join`, `room.leave`, `room.expire` only (SR-9).
- [ ] Wire `POST /api/rooms` in the dev server to `registry.createRoom()`; return JSON with credentials (A8). Set `Cache-Control: no-store`.
- [ ] Wire `join`/`hostJoin` JSON messages to the registry in D0-SRV-03.
- [ ] Add fake-clock tests: room creation, duplicate-code retry, token/PIN rejection, slot assignment, 9th rejection, 4h and 10min expiry, host token rejection.
- [ ] Add a routing test: controller input at slot 1 encodes an `InputFwd` with slot 1 and the same tick/edges.

**Acceptance**

- [ ] 1,000 generated codes are unique in a seeded test and all match `^[0-9A-HJKMNP-TV-Z]{4}$`.
- [ ] PINs match `^\d{4}$`; tokens are 22-char base64url.
- [ ] The 9th join returns `{ok:false, reason:"roomFull"}`.
- [ ] A wrong token, wrong PIN, missing room, expired room, and bad host token each return the correct reason.
- [ ] The host receives exactly one `InputFwd` per controller input with the correct slot.
- [ ] No log line contains a token or PIN (assert by capturing logger calls).

**Tests (tagged)**

- `[FR-5.2] room expires after 10 minutes idle and 4 hours maximum`
- `[FR-5.3] ninth controller receives roomFull`
- `[SR-1] token comparison is constant-time and length-safe`
- `[SR-5] join rejection path is rate-limit ready` (interface hook; enforcement in D4)
- `[SR-9] broker logs never include tokens or PINs`
- `[FR-7.3] forwarded InputFwd preserves edges`

**Anti-rework**

- The `Room` interface includes `reservations` and `state` now; D4 fills behavior without changing field names.
- Broker is transport-agnostic via `Peer`; the `ws` adapter lives in D0-SRV-03.
- Broker never imports protocol types for layout/panel semantics; it only forwards opaque `JsonValue` (FR-7.9).
- Room affinity is a deployment property, not a broker API change (P0/P1).

**Risks**

- `crypto.timingSafeEqual` throws on different lengths; guard with a dummy compare and return false.
- Room code collisions are rare (20 bits); retry with a bounded loop and fail loudly rather than overwrite.
- `POST /api/rooms` is unauthenticated in dev; production adds rate limits in P3. Record this as a hardening item, not a dev blocker.

---

### D0-SRV-03 — WebSocket lifecycle, origin allowlist, heartbeat, close codes

| Field | Value |
|---|---|
| Layer | Server |
| Spec | §6.1, §7.4; PR-6.1, SR-6, SR-9, SR-11; FR-4.4, FR-7.14 |
| Depends on | D0-SRV-01, D0-SRV-02, D0-PROTO-03 |
| Unblocks | D0-RT-01, D0-CTRL-01, D4-SRV-03, P1-SRV-02 |
| Deliverables | `packages/broker/src/ws-server.ts`, `test/ws.test.ts` |

**Freeze this interface**

```ts
export interface WsServerConfig {
  allowedOrigins: string[];
  allowMissingOrigin: boolean; // true only in dev for bots; false in production
  heartbeatMs: number;         // 2000
  deadAfterMs: number;         // 5000
  maxBufferedBytes: number;    // 262144
}

export function attachWebSocketServer(
  server: import("node:http").Server,
  deps: { registry: RoomRegistry; config: WsServerConfig; logger: Logger }
): import("ws").WebSocketServer;
```

**Behavior**

- Accept upgrades only on `/ws`; verify `Origin` against `allowedOrigins`; missing origin allowed only if `allowMissingOrigin`.
- `maxPayload: 4096`; additionally reject any binary frame > 64 bytes and close with 1009.
- Binary dispatch: `frameType` → Input/Ping/Haptic; unknown → close 1002; oversized → 1009.
- Text dispatch: `parseJsonMessage`; unknown/invalid → close 1008; oversized → 1009.
- Role routing: a controller socket may send `join/suspend/leave/event`; a host socket may send `hostJoin/hostPause/hostResume/setLayout/panel`; anything else closes 1008.
- Heartbeat: server `ping()` every 2 s; mark alive on `pong`; terminate after 5 s of silence (FR-7.14).
- `setNoDelay(true)` on the underlying socket (PR-6.1).
- Backpressure: if `bufferedAmount > maxBufferedBytes`, drop level-only Input packets for that peer and increment a drop counter; never drop edge packets. Log at debug level.
- Close codes exported as `CLOSE = { protocol: 1002, policy: 1008, tooLarge: 1009 }`.

**Steps**

- [ ] Implement the upgrade handler with `noServer: true`.
- [ ] Implement origin checks, including a test for a spoofed/missing origin.
- [ ] Implement frame dispatch and role routing; keep one `Peer` wrapper per socket with `send`, `close`, `remoteAddress`, `bufferedAmount`, and a `dropCount`.
- [ ] Attach the broker's `join`/`hostJoin` handlers; on join success send `joined`; on failure send `joinError` and keep the socket open for a retry (until rate-limited in D4).
- [ ] On socket close, detach the peer from the room; D0 frees the slot immediately (D4 changes this to a 30 s reservation).
- [ ] Implement heartbeat and a test with fake timers.
- [ ] Emit `setNoDelay(true)` immediately after upgrade; add a comment because `ws` exposes the raw socket as `_socket`.
- [ ] Add integration tests using a real `ws` client: origin reject, oversized binary, invalid JSON, wrong-role message, heartbeat timeout, joined/input forwarding.

**Acceptance**

- [ ] A connection from `http://evil.example` is rejected with 403 before upgrade.
- [ ] A 65-byte binary frame closes with 1009; a 4097-byte text frame closes with 1009.
- [ ] A controller sending `hostPause` closes with 1008.
- [ ] An idle socket is terminated after 5 s.
- [ ] `socket._socket.setNoDelay` is called (instrumented in a unit test).

**Tests (tagged)**

- `[SR-11] websocket origin allowlist rejects unknown origins`
- `[SR-6] oversized binary and JSON frames close the socket`
- `[PR-6.1] websockets are configured with noDelay`
- `[FR-7.14] heartbeat terminates a silent socket after 5 seconds`
- `[SR-9] connection logs contain no tokens`
- `[FR-4.4] only websocket upgrades are accepted on /ws`

**Anti-rework**

- The adapter is shared by dev-server now and relay in P1 (A1). Do not put dev-only assumptions in it.
- Close codes and frame caps come from protocol constants; never duplicate numbers.
- The broker handles semantics; the adapter handles transport only.

**Risks**

- `ws` `maxPayload` applies before our frame check; set it to 4096 so valid JSON fits, then enforce 64 for binary.
- Some bots omit `Origin`; dev allows missing origin only when explicitly configured.

---

### D0-RT-01 — Host page shell: create room, host join, live input debug

| Field | Value |
|---|---|
| Layer | Host runtime |
| Spec | §4.2, §9.6; §14 D0; FR-4.3; AR-4 groundwork |
| Depends on | D0-SRV-01, D0-SRV-02, D0-SRV-03, D0-PROTO-02 |
| Unblocks | D3-RT-01, D4-HOST-01 |
| Deliverables | `packages/runtime/package.json`, `index.html`, `src/main.ts`, `src/net/hostClient.ts`, `src/debug/inputTable.ts`, `test/hostClient.test.ts` |

**Behavior**

- On load: `POST /api/rooms`, display code and PIN large, never display `roomToken` or `hostToken`.
- Connect to `resolveServerOrigin()` + `/ws`, send `hostJoin`, show connection state.
- On `playerJoined/Left`, update a slot table.
- On binary `InputFwd`, show slot, buttons/edges (hex), axes, triggers, last packet age.
- `?debug=1` shows the same table plus raw timestamps; default D0 view is already a debug table because there is no game yet.
- Enter key triggers connect/create (AR-4 groundwork); no pointer-only controls.
- Mount point `#game-root` exists but is empty; D3 replaces the table with the runtime.

**Steps**

- [ ] Create a minimal `index.html` with `#app`, `#game-root`, `#connection`, `#slots`.
- [ ] Implement `hostClient.ts`: `connect(origin)`, `createRoom()`, `sendHostJoin(code, hostToken)`, `onMessage(cb)`, `close()`, with reconnect hook left for D4.
- [ ] Store `hostToken` in `sessionStorage` under `lanpad.host.<code>`; never in a URL or DOM.
- [ ] Render slot rows with `textContent` only; use a fixed-size array of 8 `<tr>` rows and update cells in place (no VDOM, NR-6.2).
- [ ] Add a keyboard handler: Enter creates a room when idle; no other host UI yet.
- [ ] Add unit tests for the room-create response parser and the slot row formatter.

**Acceptance**

- [ ] Opening `/` creates a room and shows a 4-char code and 4-digit PIN.
- [ ] Two controller pages joining change the host table from 0 to 2 players without a reload.
- [ ] Pressing a controller button updates the host row within the next frame of updates.
- [ ] No token appears in DOM, console, or network URL.

**Tests (tagged)**

- `[FR-5.1] host never puts roomToken or hostToken in a URL`
- `[AR-4] room creation is reachable with the Enter key`
- `[FR-4.3] host client uses resolveServerOrigin rather than a literal`
- `[FR-9.6] host shell has no game assets yet` (bundle-size awareness)

**Anti-rework**

- `hostClient` is the only socket owner on the host; games never see it (FR-7.17).
- The page is a shell; D3 mounts the runtime into `#game-root` and keeps the debug table behind `?debug=1`.
- Use the protocol's message types; do not hand-roll JSON.

**Risks**

- `sessionStorage` is per-tab; a duplicated tab loses the host token. D4 adds a clearer host-lost UX.
- Displaying the PIN is intentional (SR-10 notice comes in D4).

---

### D0-CTRL-01 — Controller page shell: join and send a test button

| Field | Value |
|---|---|
| Layer | Controller |
| Spec | §4.2, §8.5; §14 D0; FR-5.6, FR-7.1 |
| Depends on | D0-SRV-01..03, D0-PROTO-01/02/03 |
| Unblocks | D2-CTRL-01..04, D4-CTRL-01 |
| Deliverables | `packages/controller/package.json`, `index.html`, `src/main.ts`, `src/net/controllerClient.ts`, `src/route.ts`, `test/route.test.ts` |

**Behavior**

- Parse `/c/<code>`; normalize code to uppercase; if absent or invalid, show a manual code + PIN form (FR-5.6 groundwork).
- Connect to same-origin `/ws`, send `join {v, code, pin}` (D0).
- On `joined`, show slot and a single full-width "Test" button.
- Touch/click the test button sends `Input` with A bit level+edge on press and level 0 on release, immediately (FR-7.1 groundwork).
- Show a connection pill: Connecting / Connected (P{n}) / Disconnected.
- No layout rendering, no sensors, no haptics yet.

**Steps**

- [ ] Create the controller `index.html` with a status pill, slot label, and a test button.
- [ ] Implement `route.ts`: `parseControllerPath(pathname): {code: string | null; token: string | null}`; token from `location.hash` (D4 uses it; D0 only parses and clears it with `history.replaceState`).
- [ ] Implement `controllerClient.ts`: connect, join, send Input, receive joined/joinError/kick, expose `onState`.
- [ ] Implement press/release using `pointerdown`/`pointerup`/`pointercancel` for D0; D2 replaces this with the multi-touch layer.
- [ ] Send an immediate packet on press (edge set) and on release (level 0, no edge). Between transitions, D0 sends at 10 Hz idle.
- [ ] Add unit tests for route parsing and the press/release packet sequence with a fake clock.

**Acceptance**

- [ ] `/c/ABCD` joins room ABCD with a PIN and shows slot 1.
- [ ] Pressing Test makes the host row show A pressed; releasing clears it.
- [ ] A wrong PIN shows a readable error and an editable form, not a dead end.
- [ ] The fragment is cleared before any network request.

**Tests (tagged)**

- `[FR-5.6] manual join works without a camera or token`
- `[FR-5.1] controller clears the URL fragment after reading it`
- `[FR-7.1] press sends immediately and release sends immediately`
- `[FR-7.3] a press edge is present even if release follows in the same millisecond`

**Anti-rework**

- The controller shell is separate from the layout renderer (D2/D5). `main.ts` wires modules; no framework.
- The socket module is the only network owner; controls emit state, never packets directly.
- Route parsing and token handling are shared with D4's QR flow.

**Risks**

- Mobile browsers may delay `pointerup`; D2's touch layer fixes this with `touchstart/move/end/cancel`.
- Clipboard/camera access is not used; manual join is the fallback.

---

### D0-SDK-01 — Manifest schema and client config contract

| Field | Value |
|---|---|
| Layer | SDK |
| Spec | §10, §6.2; FR-4.3, FR-4.6, FR-10.3; A6 |
| Depends on | D0-REPO-01 |
| Unblocks | D3-SDK-01, D7-SDK-01, P4-SDK-01, P6-HUB-01 |
| Deliverables | `sdk/package.json`, `sdk/src/manifest.ts`, `sdk/src/config.ts`, `sdk/schema/game-manifest.schema.json`, `sdk/test/manifest.test.ts`, `sdk/test/config.test.ts` |

**Freeze this interface**

```ts
export interface GameManifest {
  schemaVersion?: 1;
  name: string;                 // 1..64 chars
  entry: string;                // relative path, no ".."
  layouts: string[];            // relative layout JSON paths, 1..16
  assetBudget: { initialBytes: number; totalBytes: number }; // >0, initial <= total
  minPlayers: number;           // 1..8
  maxPlayers: number;           // minPlayers..8
  needsGyro: boolean;
  chunkConfig?: {
    chunkSize: number;
    loadRadius: number;
    unloadRadius: number;
    lodTiers: number[];         // >= 3 entries when present
  };
}

export function validateManifest(value: unknown): { ok: true; manifest: GameManifest } | { ok: false; errors: string[] };

export function resolveServerOrigin(explicit?: string): string; // strips trailing slash
export function toWebSocketUrl(origin: string, path?: string): string; // http->ws, https->wss
```

**Steps**

- [ ] Create `sdk/package.json` as `@lanpad/sdk`, zero runtime deps (types only; optional `@lanpad/protocol` as a type-only dev dependency).
- [ ] Write `sdk/schema/game-manifest.schema.json` (draft 2020-12) mirroring the interface.
- [ ] Implement `validateManifest` by hand (no Ajv in the browser path); return all errors, not the first.
- [ ] Implement config helpers using `globalThis.location` when no explicit origin is given; throw a clear error in a non-browser environment without an explicit origin.
- [ ] Add tests for valid/invalid manifests: missing fields, `..` in entry, maxPlayers > 8, min > max, initial > total, zero/negative budgets, too many layouts, chunkConfig with < 3 LOD tiers.
- [ ] Add tests for origin normalization (`https://x/` → `https://x`), WS scheme conversion, and rejection of non-http(s) origins.

**Acceptance**

- [ ] The JSON Schema and `validateManifest` accept the same valid fixture and reject the same invalid fixtures.
- [ ] A manifest with `entry: "../evil.js"` is rejected.
- [ ] `toWebSocketUrl("https://relay.example")` returns `wss://relay.example/ws`.
- [ ] No hard-coded origin exists in the SDK.

**Tests (tagged)**

- `[FR-10.3] manifest requires name, entry, layouts, assetBudget, minPlayers, maxPlayers, needsGyro`
- `[FR-4.3] server origin resolves from config, not a literal`
- `[FR-4.6] websocket URL derives scheme from the origin`
- `[G8] manifest validator is usable by third-party games`

**Anti-rework**

- The manifest is the game boundary. D3's loader consumes this exact type; P6's hub lists manifests without game-specific code.
- `schemaVersion` is optional and defaults to 1; it exists for future SDK compatibility without a new file format.
- Do not import runtime internals into the SDK.

**Risks**

- Hand-written validation can drift from the JSON Schema; keep one shared fixture suite used by both tests.
- `location` is absent in Node tests; always pass an explicit origin there.

---

### D0-TOOL-01 — input-bot skeleton

| Field | Value |
|---|---|
| Layer | Tools/CI |
| Spec | §10, §16; §14 D0; PR-11.1 groundwork |
| Depends on | D0-PROTO-01/02/03, D0-SRV-02 |
| Unblocks | D4-TOOL-01, D3-TOOL-01, D7-EXP-01 |
| Deliverables | `tools/input-bot/package.json`, `src/cli.ts`, `src/bot.ts`, `src/macros.ts`, `test/macros.test.ts`, `test/bot.test.ts` |

**CLI**

```bash
node tools/input-bot/dist/cli.js \
  --server http://192.168.1.20:8080 \
  --code ABCD --pin 1234 \
  --clients 2 --macro tools/input-bot/macros/tap.json \
  --duration 5s
```

**Macro format**

```json
[
  { "atMs": 0,   "type": "press",   "buttons": ["A"] },
  { "atMs": 80,  "type": "release", "buttons": ["A"] },
  { "atMs": 200, "type": "axis",    "lx": 32767, "ly": 0 }
]
```

**Steps**

- [ ] Create the CLI parser (no dependency; parse `--key value` and `--key=value`).
- [ ] Implement `Bot`: connect WS, send `join`, on `joined` start a scheduler at 60 Hz with changes and 10 Hz idle keepalive.
- [ ] Implement macro compilation: `press` sets level+edge in the next packet; `release` clears level; `axis` sets i16 values. A press followed by a release within one tick must still emit the edge.
- [ ] Implement Ping every 5 s and RTT p50/p95 reporting; print a JSON summary on exit.
- [ ] Support `--clients N` up to 8, each independent.
- [ ] Add tests for macro validation, scheduling with fake timers, and edge preservation.

**Acceptance**

- [ ] Two bots join and the host sees slots 1 and 2.
- [ ] A 40 ms tap produces one packet with the edge bit and a later packet with the level cleared.
- [ ] The summary includes `sent`, `rttP50`, `rttP95`, `drops`.
- [ ] An invalid macro fails with a field-level error.

**Tests (tagged)**

- `[FR-7.1] bot sends at 60 Hz with input and 10 Hz idle`
- `[FR-7.3] bot preserves a sub-tick tap edge`
- `[FR-7.4] axis macro clamps to i16`
- `[G4] bot can create 8 independent clients`

**Anti-rework**

- The bot uses `@lanpad/protocol` only; it never imports controller code. It is a second implementation of the sender, which is acceptable and useful for independent verification.
- Macros are JSON so D4/D7 can reuse them for regression scenarios.
- Keep the scheduler injectable for fake-clock tests.

**Risks**

- Node timers drift; for D0 it is acceptable. D4 adds jitter/loss injection and a higher-resolution scheduler.
- The bot must not print PINs/tokens in normal logs.

---

### D0-TOOL-02 — Size-budget gate and CI wiring

| Field | Value |
|---|---|
| Layer | Tools/CI |
| Spec | §11; NR-6.1, NR-6.3; G3, G7 |
| Depends on | D0-REPO-01 |
| Unblocks | D2-PERF-01, D7-PERF-01, GATE-PERF-01, P5-QA-02 |
| Deliverables | `tools/size-budget/package.json`, `src/cli.ts`, `budgets.json`, `test/budget.test.ts`, CI step |

**Budget file**

```json
{
  "targets": {
    "controller": { "dev": 40960, "prod": 51200, "hard": 61440 },
    "host":       { "dev": 3145728, "prod": 3670016, "hard": 5242880 },
    "engineCore": { "aspirational": 409600 }
  },
  "games": {}
}
```

**Behavior**

- CLI: `node tools/size-budget/dist/cli.js --target controller --env dev --file packages/controller/dist/assets/*.js`.
- Expand globs with a small recursive walker (no glob dependency).
- Measure gzip bytes (`zlib.gzipSync`), not raw bytes.
- Print: target, env, files, raw bytes, gz bytes, budget, status.
- Exit 1 on `hard` breach; exit 0 with a warning when over the dev/prod target but under hard. CI treats any non-zero as failure.
- JSON output mode `--json` for later dashboards.
- Game budgets are read from manifests in D7; D0 leaves `games` empty.

**Steps**

- [ ] Create the tool and its tests.
- [ ] Implement glob expansion supporting `*` within one directory (enough for Vite assets); document the limitation.
- [ ] Implement gzip measurement and deterministic output.
- [ ] Add `npm run size` at the root and call it from `npm run check`.
- [ ] Add the CI step (already inside `npm run check`).
- [ ] Build the controller and host shells first, then run the gate; record the actual sizes in this file's exit notes.
- [ ] Add a test fixture with a synthetic 70 KB file that must fail the 60 KB hard cap.

**Acceptance**

- [ ] The gate fails on a 61 KB controller bundle and passes at 60 KB.
- [ ] The tool reports engine core separately once D3 introduces it.
- [ ] CI fails the build when the budget is exceeded (verified with a temporary fixture in a branch).
- [ ] Actual D0 sizes are recorded in `docs/RESULTS.md`.

**Tests (tagged)**

- `[NR-6.3] controller bundle over 60 KB gz fails the gate`
- `[NR-6.1] host bundle budget is 5 MB hard, 3/3.5 MB targets`
- `[PR-11.2] no memory budget is asserted from the size gate`
- `[G7] every browser bundle has a budget entry`

**Anti-rework**

- Budgets live in one JSON file consumed by CI, P5, and future dashboards.
- Games get budget entries from manifests in D7; do not hard-code game sizes in the tool.
- Measure gzip, as the spec budgets state; record brotli separately later if useful.

**Risks**

- Vite output names are hashed; the glob must match multiple files and sum them.
- Source maps can inflate the directory; exclude `*.map`.

---

### D0-QA-01 — Test tags and trace checker

| Field | Value |
|---|---|
| Layer | Docs/QA + Tools |
| Spec | §16; TR-1 |
| Depends on | D0-REPO-01 |
| Unblocks | every stage's TR-1 compliance; GATE-ARCH-01 |
| Deliverables | `tools/trace-check/package.json`, `src/cli.ts`, `test/trace.test.ts`, `docs/TESTING.md` |

**Behavior**

- Parse IDs from `docs/todos/TRACEABILITY.md`: regex `\b(?:FR|NR|PR|SR|AR|TR|A|G|E|C)-?[0-9]+(?:\.[0-9]+)?\b` adjusted per prefix (`G1`, `E1`, `C1`, `A1` have no dash). Amendment tags like `[A9]` are valid and must resolve to the amendments table.
- Scan `packages/**/test/**`, `packages/**/*.test.ts`, `tools/**/*.test.ts`, `sdk/**/*.test.ts`, `experiments/**` for `[ID]` in test titles or `@req ID` comments.
- Fail if any ID has zero tags; fail if a tag references an unknown ID.
- Print a coverage summary grouped by prefix.
- `--update` writes a report to `docs/TRACE-REPORT.md` (generated, never hand-edited).

**Steps**

- [ ] Implement the parser and scanner with a temp-fixture test suite.
- [ ] Add fixtures: missing tag fails, unknown tag fails, valid tag passes.
- [ ] Add `npm run trace` to `npm run check`.
- [ ] Write `docs/TESTING.md`: tag convention, test layers (unit/property/golden/integration/manual), how to record manual results in `docs/RESULTS.md`.
- [ ] Confirm the D0 tests written so far are tagged; fix any that are not.

**Acceptance**

- [ ] Removing a tag from a test makes `npm run trace` fail.
- [ ] Adding a test tagged `[FR-99.9]` fails as unknown.
- [ ] The report lists every ID and at least one test file per ID.
- [ ] CI runs the checker.

**Tests (tagged)**

- `[TR-1] every requirement ID has at least one tagged test`
- `[TR-1] unknown requirement tags fail the checker`

**Anti-rework**

- `TRACEABILITY.md` is the single source; no second ID list.
- The checker runs locally and in CI; no separate manual audit until the Gate.
- Test files may be added in any stage; the checker grows automatically.

**Risks**

- Comments can satisfy a tag without a real test. Mitigation: the Gate audit (GATE-ARCH-01) samples tests for actual assertions; do not allow empty test bodies.

---

### D0-QA-02 — Two-client echo acceptance run

| Field | Value |
|---|---|
| Layer | Server + QA |
| Spec | §14 D0 exit; §16 multi-controller |
| Depends on | D0-SRV-01..03, D0-RT-01, D0-CTRL-01, D0-TOOL-01 |
| Unblocks | D1 entry |
| Deliverables | `test/e2e/d0-echo.test.ts`, `docs/RESULTS.md` D0 row |

**Steps**

- [x] Write an integration test that boots the dev server on port 0 with a temp static root, creates a room via `POST /api/rooms`, connects a host client with `hostJoin`, connects two bots/controllers, and asserts:
  - `joined` slots are 1 and 2;
  - the host receives `InputFwd` with slot 1 and then slot 2;
  - edges survive a 40 ms tap;
  - a 9th client gets `roomFull` (even though sessions are D4, slot cap is D0).
- [x] Run the manual two-phone (or two-tab) run on the LAN and record: device, browser, room code, join time, observed latency feel.
- [x] Add a `docs/RESULTS.md` D0 section with the commands and outcomes.
- [x] Fix any flakiness by waiting on messages, not fixed sleeps.

**Acceptance**

- [x] The integration test passes 10 consecutive runs.
- [x] The manual run works on at least one phone and the host browser.
- [ ] Results are recorded with date, device, and browser version — date, device and Chrome are recorded; exact Chrome version strings and the host browser name are pending.

**Tests (tagged)**

- `[G4] two clients join and are assigned slots 1 and 2`
- `[FR-7.3] sub-tick tap edge reaches the host`
- `[FR-5.3] ninth client is rejected`
- `[G2] input reaches the host within one event-loop turn in the test harness` (not a latency proof; E5 is)

**Anti-rework**

- Boot the real dev server and real broker, not mocks. This test becomes the regression harness for D4 sessions.
- Keep the harness reusable; D4 adds reconnect and 8 bots to it.

**Risks**

- Windows port binding and IPv6 localhost; bind tests to `127.0.0.1` and port 0.
- Browser tabs may throttle timers when hidden; keep the manual run visible.

---

## Stage exit checklist

- [ ] D0-REPO-01 through D0-QA-02 complete and checked.
- [ ] `npm ci && npm run check` green on a clean clone.
- [ ] CI workflow green on the default branch.
- [x] Two clients echo input through the real dev server; recorded in `docs/RESULTS.md`.
- [x] Protocol property tests and golden vectors pass.
- [x] Controller gz size measured and under 60 KB hard cap; host size recorded.
- [x] No token/PIN in logs (test).
- [x] `docs/DEPENDENCIES.md` covers every dependency.
- [x] `TRACEABILITY.md` IDs used in D0 tests exist and are tagged.

## Handoff to D1

- D1 adds `/x/<id>` experiment pages; the dev server already routes them (D0-SRV-01).
- D1 records the device envelope; if the TV lacks WebGL2 or binary WS, stop and revise the D3 target before writing the renderer.
- Do **not** start D2 controller work until D1's E1–E3 results are recorded.

## Explicitly not in D0

- Sessions, reservations, reconnect, QR display (D4).
- Layouts, panels, text, canvas, events (D5).
- Sensors, haptics (D6).
- Game loop, renderer, audio (D3) and games (D7).
- Relay, TLS, DNS, Vercel (P0–P2).
- iOS work of any kind (A5).
