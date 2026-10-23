# 14 — Networking

**Status:** authoritative for `@lanpad/engine-net`: the online world-replication layer built on the existing broker/relay. Local rooms and the controller wire protocol are frozen and remain the default. Written before implementation; nothing in this document is implemented.
**Milestone:** **M2** for relay world sync and the `/net` endpoint. M0/M1 keep the current local-only broker path. Prediction/reconciliation and lag compensation are M2; interest management is M2 and scales at M3.
**Requirement ID prefix:** `ER-14-*`. Each row in §7 must be registered in `docs/todos/TRACEABILITY.md` before implementation starts.
**Authority:** [`SPEC.md`](../../SPEC.md) §4, §7, §11, §13 for the product/protocol/security contract; [`docs/ENGINE.md`](../ENGINE.md) for what exists today; [`docs/engine/README.md`](README.md) for the programme rules; [`00-architecture.md`](00-architecture.md) for package boundaries and frozen contracts. Where this spec and `SPEC.md` disagree, `SPEC.md` wins until an amendment is recorded in [`docs/todos/README.md`](../todos/README.md).

**Compatibility statement.** The existing controller path is **not changed**: WebSocket `/ws`, `PROTOCOL_VERSION = 1`, 26-byte `Input`, 27-byte `InputFwd`, JSON control messages, room codes, PINs, sessions, slots, reconnect and all broker limits keep their current semantics (ENGINE.md §3). Online world replication is additive: a separate `/net` endpoint with its own `NET_PROTOCOL_VERSION = 1`, negotiated per socket, and a separate frame budget. A build with `engine-net` absent behaves exactly like the current build.

---

## 1. Goal

Today a room is local-only: the host, the broker and the phones share a LAN, and the broker relays 26-byte input frames to the host. That is the right default and it stays. The gap is that a host cannot play with a remote display client — a second browser, a laptop on another network, a remote spectator, or a future second-room peer — because there is no replicated world state, no authority model for remote commands, and no way to survive latency without rubber-banding.

This spec defines the **world plane**: a host-authoritative, snapshot-based replication layer that:

- keeps the host as the only simulation authority, exactly as the local product does today;
- sends compact delta snapshots from the host to remote peers at a fixed 20 Hz, with a keyframe fallback;
- accepts **input commands** from remote peers, not state, and applies them at a deterministic tick;
- predicts the local peer's owned entity on its own client and reconciles against the authoritative snapshot without visible snapping;
- interpolates remote entities behind a fixed delay, with bounded extrapolation;
- rewinds recorded hitbox/transform history for lag compensation up to a stated cap;
- sends only what each peer can perceive, using the same cell grid as world streaming;
- degrades to local mode when the relay or network fails, with no change to the phone join flow;
- exposes one interface that a game consumes through an optional `GameContext.net`, so existing games ignore it and new online games do not touch a socket.

**Player-visible outcome.** A player on a different network joins a room, sees the same world as the host, controls their own character or vehicle with no more than one input of visible lag on a 40–80 ms connection, and does not see other players teleport when packets are late. If the relay is unavailable, the host still starts a local room and phones still join — online is an option, never a boot dependency.

**Engineering outcome.** The local path and the online path share the broker's room/session/auth core; only transport and replication are new. The controller bundle and the controller protocol are untouched. The net package is deterministic in the same per-build sense as the rest of the engine (00 §5.8): the same commands and seed produce the same host state hash. Cross-browser bit-identical lockstep remains out of scope.

**Definition of done.** A host and one remote client complete a 600-tick scripted session over the relay with the acceptance error bounds, all existing local-room tests pass unchanged, and the two-client sync fixture is recorded in `docs/RESULTS.md`.

---

## 2. Non-goals

- **No server-side simulation.** The relay never runs `simulate`, never owns game state and never corrects a host. It authenticates, pairs, forwards and rate-limits. This preserves the product's host-authoritative model and the relay's low cost.
- **No host migration or peer-to-peer authority transfer.** If the host leaves, the room ends under the existing `hostLost` rules. A future host-handoff spec may add it; this one does not.
- **No dedicated game servers, matchmaking service, accounts or ranked play.** Rooms remain code/PIN/token based. P4 owns public matchmaking if it ever happens.
- **No lockstep or rollback netcode.** The model is snapshot replication with client prediction. Fighting-game rollback is a different architecture and is not a v1 goal.
- **No cheat-proofing.** The host owns the game; a modified host can cheat its own room. The relay enforces identity, rate and frame limits, not game rules. Server-authoritative anti-cheat is out of scope.
- **No WebRTC requirement.** The first transport is WSS through the relay. WebRTC data channels may be added later behind `NetTransport`; they are not a dependency and NAT traversal is not in v1.
- **No changes to the controller protocol, controller bundle or controller controls.** Phones remain input-only. A phone that never opens `/net` is a first-class participant.
- **No change to the local room semantics.** Codes, PINs, slots, reservations, host loss, expiry, layouts, panels, events, haptics and stats keep their current behaviour and tests.
- **No persistence of network state.** Saves are spec 15. The relay stores no message bodies (SR-12); a session buffer is memory-only and bounded.
- **No general-purpose RPC or pub/sub bus.** The world plane carries commands, snapshots and engine events. Game-specific messages use the existing `event` channel or a typed game payload inside the snapshot, never a new ad-hoc socket protocol.
- **No cross-room play, voice chat, text chat or presence beyond the room roster.**
- **No bandwidth promise on TV or mobile networks before measurement.** Targets are stated; TV and cellular rows stay PENDING until run.

---

## 3. Public interfaces

All types are backend-neutral: no `WebSocket`, `RTCDataChannel`, DOM event or broker `Peer` appears in a game-facing signature. The SDK restates the game-facing types structurally (00 §3.6). `Entity`, `Transform`, `Vec3`, `Quat` and `Aabb3` come from specs 02/03. `CellKey` comes from 00 §4.4 and spec 12.

### 3.1 Constants

```ts
export const NET_PROTOCOL_VERSION = 1;

export const NET_LIMITS = {
  maxPeers: 8,                    // online peers per room, including the host
  maxSpectators: 4,               // subset of maxPeers; receive-only
  maxFrameBytes: 1200,            // one binary frame on /net
  maxFragments: 8,                // snapshot fragments per message
  maxSnapshotBytes: 9600,         // 8 × 1200, fragment header included
  snapshotHz: 20,                 // default
  minSnapshotHz: 10,
  maxSnapshotHz: 30,
  commandHz: 30,                  // default client command rate
  maxCommandBytes: 32,
  commandRedundancy: 3,           // last N commands repeated per packet
  maxCommandBufferMs: 250,        // host rejects commands older than this
  maxInterpolationDelayMs: 150,
  defaultInterpolationDelayMs: 100,
  maxExtrapolationMs: 100,
  maxLagCompensationMs: 250,
  defaultLagCompensationMs: 100,
  historyMs: 1000,                // transform/hitbox ring per owned entity
  maxEntitiesPerInterestSet: 2048,
  maxEntitiesPerSnapshot: 512,
  maxSpawnsPerSnapshot: 64,
  maxEventsPerSnapshot: 32,
  defaultBytesPerSecondPerPeer: 65_536,
  maxBytesPerSecondPerPeer: 131_072,
  keyframeIntervalTicks: 300,     // 5 s at 60 Hz
  baselineLifetimeMs: 2000,
  reconnectWindowMs: 30_000,
  maxRoomPeers: 8,
} as const;
```

Numbers are targets, not measurements. They are chosen to fit a 1,200-byte frame and a 64 KB/s default peer budget; §7 measures them.

### 3.2 Session model

```ts
export type NetMode = "off" | "local" | "relay";
export type NetRole = "host" | "client" | "spectator";
export type NetState =
  | "idle" | "connecting" | "handshaking" | "synced"
  | "degraded" | "reconnecting" | "closed" | "failed";

export type PeerId = number;       // 1..8, assigned by the relay; 0 = host/system
export type NetTick = number;      // host simulation tick, u32, wraps after ~2.2 years at 60 Hz
export type NetEntityId = number;  // u32, host-assigned, dense-per-session, never reused

export interface NetConfig {
  readonly mode: NetMode;                 // default "off"
  readonly endpoint?: string;             // same-origin "/net" default; never hard-coded
  readonly room?: { readonly code: string; readonly token: string };
  readonly role: NetRole;                 // "host" for the simulation owner
  readonly snapshotHz?: number;           // 10..30, default 20
  readonly commandHz?: number;            // 10..60, default 30
  readonly interpolationDelayMs?: number; // 0..150, default 100
  readonly lagCompensationMs?: number;    // 0..250, default 100
  readonly bytesPerSecondPerPeer?: number; // default 65_536, hard 131_072
  readonly maxPeers?: number;             // 2..8, cannot exceed the room's controller limit
  readonly spectator?: boolean;           // receive-only client
  readonly spectatorSlot?: number;        // existing controller slot for the spectator's phone, optional
}

export interface NetStats {
  readonly role: NetRole;
  readonly state: NetState;
  readonly peers: number;
  readonly rttMs: number;                 // EWMA of the best samples
  readonly jitterMs: number;              // EWMA of RTT variance
  readonly snapshotHz: number;            // measured received/sent rate
  readonly bytesPerSecondOut: number;
  readonly bytesPerSecondIn: number;
  readonly snapshotsSent: number;
  readonly snapshotsReceived: number;
  readonly snapshotsDropped: number;
  readonly keyframesSent: number;
  readonly keyframesReceived: number;
  readonly commandsSent: number;
  readonly commandsReceived: number;
  readonly commandsRejected: number;      // stale, unauthorized, malformed or over budget
  readonly predictionErrors: number;
  readonly corrections: number;           // hard snaps, not smoothing
  readonly rewindQueries: number;         // lag-compensation lookups
  readonly interestSets: number;
  readonly lastErrorCode: string | null;
}
```

### 3.3 Host session

```ts
export interface HostSession {
  readonly role: "host";
  readonly state: NetState;
  readonly stats: NetStats;

  /** Starts listening on /net after the room exists. Idempotent. */
  start(config: NetConfig): Promise<void>;

  /** Registers a game-owned entity for replication. Host-side only. */
  replicate(entity: Entity, init: ReplicateInit): NetEntityId;
  /** Stops replicating; clients receive a despawn on the next snapshot. */
  unreplicate(id: NetEntityId): void;

  /** Assigns authority over an entity to a peer (or 0 for the host). */
  setOwner(id: NetEntityId, owner: PeerId): void;
  ownerOf(id: NetEntityId): PeerId;

  /** Queues a reliable engine event for one peer or all peers. */
  sendEvent(event: NetEvent, to?: PeerId | "all"): void;

  /** Called exactly once per fixed tick by the runtime, after simulate. */
  update(tick: NetTick): void;

  /** Authoritative transform history for interpolation and rewind. */
  readonly history: TransformHistory;

  /** Recorded transform for lag compensation; false when out of range. */
  rewind(entity: Entity, atServerMs: number, out: Transform): boolean;

  onCommand(listener: (peer: PeerId, command: InputCommand) => void): () => void;
  onPeerChange(listener: (event: PeerEvent) => void): () => void;

  close(reason?: string): void;           // idempotent
  dispose(): void;                        // close + release; idempotent
}
```

### 3.4 Client session

```ts
export interface ClientSession {
  readonly role: "client" | "spectator";
  readonly state: NetState;
  readonly stats: NetStats;
  readonly localPeer: PeerId;
  /** Host tick the client currently renders. */
  readonly renderTick: NetTick;

  start(config: NetConfig): Promise<void>;

  /** Queues one command for the next send; sequence and client tick are filled by the session. */
  sendCommand(command: InputCommand): void;

  /** Authoritative state last accepted from the host. */
  authoritative(id: NetEntityId, out: Transform): boolean;
  /** Predicted state for a locally owned entity. */
  predicted(id: NetEntityId, out: Transform): boolean;
  /** Interpolated state for a remote entity at the render tick. */
  interpolated(id: NetEntityId, out: Transform): boolean;

  onSnapshot(listener: (snapshot: SnapshotView) => void): () => void;
  onSpawn(listener: (id: NetEntityId, entity: ReplicatedEntity) => void): () => void;
  onDespawn(listener: (id: NetEntityId) => void): () => void;
  onEvent(listener: (event: NetEvent) => void): () => void;
  onCorrection(listener: (id: NetEntityId, errorMeters: number) => void): () => void;

  close(reason?: string): void;           // idempotent
  dispose(): void;                        // idempotent
}
```

### 3.5 Commands, entities and snapshots

```ts
/** One quantized input command. The game maps buttons/axes to actions. */
export interface InputCommand {
  readonly sequence: number;              // u32, client-scoped, never wraps to 0
  readonly clientTick: number;            // client estimate of host tick, u32
  readonly buttons: number;               // u32 bitfield, game-defined mapping
  readonly axes: readonly [number, number, number, number]; // -1..1, 4 analog axes
  readonly yaw: number;                   // -180..180 degrees, quantized i16
  readonly pitch: number;                 // -90..90 degrees, quantized i16
}

export interface ReplicateInit {
  readonly kind: number;                   // u16, game-defined; 0xFFFF reserved
  readonly owner: PeerId;                  // 0 = host-owned
  readonly priority?: number;              // 0..3, default 1; ownership adds +2
  readonly sendRateHz?: number;            // 0 = every snapshot, 1..30 otherwise
  readonly payload?: Uint8Array;           // <= 256 bytes, game-defined, reliable on spawn
}

export interface ReplicatedEntity {
  readonly id: NetEntityId;
  readonly kind: number;
  readonly owner: PeerId;
  readonly payload?: Uint8Array;
}

export interface EntityState {
  readonly id: NetEntityId;
  readonly position: Vec3;                // metres
  readonly rotation: Quat;
  readonly velocity: Vec3;                // metres/second
  readonly flags: number;                 // u8: 0 alive, 1 sleeping, 2 teleported, 3 owner-local, ...
  readonly payload?: Uint8Array;          // <= 64 bytes, optional per-snapshot game data
}

export interface SnapshotView {
  readonly hostTick: NetTick;
  readonly serverTimeMs: number;
  readonly ackedCommand: number;          // last command sequence applied to this peer
  readonly baselineId: number;            // 0 = keyframe
  readonly entities: readonly EntityState[];
  readonly events: readonly NetEvent[];
}

export interface NetEvent {
  readonly type: "spawn" | "despawn" | "game";
  readonly tick: NetTick;
  readonly entity?: NetEntityId;
  readonly payload?: Uint8Array;          // <= 512 bytes for game events
}

export interface PeerEvent {
  readonly peer: PeerId;
  readonly type: "joined" | "left" | "timedOut" | "roleChanged";
  readonly slot?: number;                 // phone slot when the peer has one
}

export interface TransformHistory {
  /** Samples at each recorded tick; out is caller-owned. */
  sample(id: NetEntityId, tick: NetTick, out: Transform): boolean;
  sampleAtTime(id: NetEntityId, serverMs: number, out: Transform): boolean;
  readonly oldestTick: NetTick;
  readonly newestTick: NetTick;
}
```

### 3.6 Interest and transport

```ts
export interface InterestView {
  readonly position: Vec3;                // client's view or avatar position
  readonly forward: Vec3;                 // XZ, normalized
  readonly radiusMeters: number;          // default 220; max 512
  readonly cell: CellKey | null;          // streamed cell containing the view
  readonly ownedEntities: readonly NetEntityId[];
}

export interface InterestSet {
  readonly peer: PeerId;
  readonly entities: readonly NetEntityId[]; // canonical ascending id order
  readonly bytesPerSecond: number;
  readonly isFull: boolean;               // hit maxEntitiesPerInterestSet
}

export interface NetTransport {
  send(bytes: Uint8Array): void;          // one datagram-like message; the session may fragment
  close(code?: number, reason?: string): void;
  readonly state: "connecting" | "open" | "closed";
  onMessage(listener: (bytes: Uint8Array) => void): () => void;
  onClose(listener: (code: number, reason: string) => void): () => void;
}

export interface NetSession {
  readonly role: NetRole;
  readonly state: NetState;
  readonly stats: NetStats;
  readonly transport: NetTransport;
  update(tick: NetTick): void;
  close(reason?: string): void;
  dispose(): void;
}
```

### 3.7 Game-facing surface

`GameContext` is frozen (00 §3.1). This spec adds one optional member, restated structurally in `sdk/src/game-api.ts` by spec 18:

```ts
/**
 * The game supplies prediction only for entities it already simulates locally.
 * Without hooks, prediction is disabled and the client interpolates the
 * authoritative state with the configured interpolation delay.
 */
export interface PredictionHooks {
  /** Advance the local view by one 1/60 s step for an owned entity. */
  step(id: NetEntityId, command: InputCommand, dt: number): void;
  /** Replace the local view with authoritative state before replay. */
  restore(id: NetEntityId, state: EntityState): void;
  /** Re-apply commands the host has not acknowledged, in sequence order. */
  replay(id: NetEntityId, commands: readonly InputCommand[]): void;
  /** Current visual error in metres, used for snap-vs-smooth. */
  error(id: NetEntityId): number;
}

export interface GameNet {
  readonly isHost: boolean;
  readonly localPeer: PeerId;             // 1..8; host uses 0
  readonly state: NetState;
  readonly stats: NetStats;

  /** Host: make an entity authoritative for a peer and replicate it. Client: read-only handle. */
  replicate(entity: Entity, init: ReplicateInit): NetEntityId;
  unreplicate(id: NetEntityId): void;
  setOwner(id: NetEntityId, owner: PeerId): void;

  sendEvent(event: NetEvent, to?: PeerId | "all"): void;
  onCommand(listener: (peer: PeerId, command: InputCommand) => void): () => void;
  onEvent(listener: (event: NetEvent) => void): () => void;

  /** Client: install or clear prediction for locally owned entities. Host: no-op. */
  setPredictionHooks(hooks: PredictionHooks | null): void;

  /** True when the host has authority over this entity and the local peer owns it. */
  isOwnedLocally(id: NetEntityId): boolean;
}

export interface GameContext {
  // ... existing frozen members unchanged
  readonly net?: GameNet;                 // additive; undefined when NetMode is "off"
}
```

A game that uses `ctx.net` must handle `undefined` and run offline. A single-player game never sees it. The runtime installs the member only when the host or client session reaches `synced`, and removes it on close. Calling a missing capability fails with `CapabilityUnavailableError`, never silently.

**Freeze rule.** `NetSession`, `HostSession`, `ClientSession`, `InputCommand`, `SnapshotView`, `NetStats` and `GameNet` freeze after the first M2 release. New fields are additive and optional. A wire-layout change bumps `NET_PROTOCOL_VERSION` and requires a migration note; removing a member requires an SDK major.

---

## 4. Data formats

Everything in this section is little-endian and is read/written through `DataView`. The world plane has its own version constant and its own endpoint; it never shares a frame with `PROTOCOL_VERSION = 1`.

### 4.1 Endpoint and handshake

`/net` is a WebSocket upgrade on the same origin as the host page and the relay. The Origin header is checked against the same allowlist as `/ws` (SPEC SR-11); the dev server's `allowMissingOrigin` exception is for bots on `/ws` and **never** applies to `/net`. No credential appears in the URL, query string or fragment. The first frame after the upgrade must be a JSON `netHello` within **2 s**, or the relay closes with 1008.

```json
{ "t": "netHello", "v": 1, "code": "ABCD", "role": "host", "token": "<host-token>" }
```

```json
{ "t": "netWelcome", "v": 1, "peer": 3, "hostPeer": 0, "slot": null,
  "serverTime": 1761177600123, "snapshotHz": 20, "commandHz": 30,
  "tickHz": 60, "maxFrameBytes": 1200 }
```

```json
{ "t": "netError", "reason": "badVersion" }
{ "t": "netBye", "reason": "hostLost" }
```

- `role`: `"host"` requires the room's `hostToken`; `"client"` requires either the room token or a live session token; `"spectator"` requires a live session token and is receive-only.
- `code` is 4 Crockford-base32 characters, normalized uppercase. `token` is 22 base64url characters. Credentials are compared in constant time by the broker's existing auth helpers; the relay never logs them (SR-9).
- The relay assigns `peer` (1..8) and returns it. A client's existing controller `slot` is echoed when the same session joined `/ws`; the fields are independent, and a peer may have no slot.
- `reason` is one of `badVersion`, `badToken`, `badPin`, `expired`, `roomFull`, `notHost`, `rateLimited`, `unsupported`, `hostLost`. The union may grow additively.
- After `netWelcome`, only binary frames are accepted on `/net`. `netError`/`netBye` are the only JSON messages after the handshake. JSON frames on `/net` are capped at **512 bytes**; larger or unknown JSON closes 1009/1002.
- Handshake timeout, wrong role, a second host socket, or a peer count above `maxPeers` closes with 1008. The room and the controller path are unaffected.

**Why a separate endpoint.** The controller protocol's 64-byte binary cap and 4 KB JSON cap are frozen and load-bearing for the controller bundle. Snapshot traffic cannot share them without a version bump and a controller change. `/net` is additive: an older relay without `/net` returns 404 and the host stays local.

### 4.2 Binary frame header

```
offset 0  u8   type
offset 1  u8   flags       bit 0 = fragmented; bits 1..7 reserved, must be 0
offset 2  u16  bodyBytes   body length, excluding this 4-byte header
offset 4  ...  body
```

A frame is rejected and the socket closed 1009 when `bodyBytes + 4 > 1200`. Reserved flag bits set are a protocol error (1002). Unknown types are a protocol error, never ignored, because an ignored type can desynchronise a snapshot stream.

| Type | Name | Direction | Body |
|---:|---|---|---|
| `0x10` | `SNAPSHOT` | host → peer | §4.3 |
| `0x11` | `SNAPSHOT_FRAGMENT` | host → peer | §4.4 |
| `0x12` | `SNAPSHOT_ACK` | peer → host | §4.5 |
| `0x13` | `COMMAND` | peer → host | §4.6 |
| `0x14` | `COMMAND_BATCH` | peer → host | §4.6 |
| `0x15` | `EVENT` | host → peer | §4.7 |
| `0x16` | `EVENT_ACK` | peer → host | §4.7 |
| `0x17` | `PING` | both | §4.8 |
| `0x18` | `PONG` | both | §4.8 |
| `0x19` | `KEYFRAME_REQUEST` | peer → host | §4.5 |
| `0x1A` | `PEER_STATE` | host/relay → peer | §4.9 |
| `0x1B` | `BYE` | both | §4.9 |

### 4.3 Snapshot body

```
u16 snapshotId          // 1..65535, wraps; 0 is never a snapshot id
u16 baselineId          // 0 = keyframe; otherwise a snapshotId this peer acked
u32 hostTick
u32 serverTimeMs        // relay clock at send time
u32 ackedCommand        // highest command sequence applied for this peer; 0 = none
u16 spawnCount
u16 deltaCount
u16 eventCount
u16 reserved            // must be 0
spawn[spawnCount]
delta[deltaCount]
event[eventCount]
```

Spawn:

```
u32 netId
u16 kind
u8  owner
u8  flags               // bit 0 = spectator-visible, bits 1..7 reserved
u16 payloadBytes        // <= 256
u8[payloadBytes] payload
```

Delta:

```
u32 netId
u16 fieldMask           // 0 = no state change (keepalive)
u16 payloadBytes        // 0 when fieldMask bit 4 is clear
// in bit order:
// bit 0  position  3 × i32 centimetres
// bit 1  rotation  u32 smallest-three
// bit 2  velocity  3 × i16 centimetres/second
// bit 3  flags     u8
// bit 4  payload   payloadBytes bytes (<= 64)
```

Event:

```
u16 eventId             // 1..65535, host-scoped, monotonic
u8  type                // 0 spawn, 1 despawn, 2 game
u8  flags               // bit 0 = critical (never dropped), bits 1..7 reserved
u32 entity              // netId for spawn/despawn; 0 for game events
u16 payloadBytes        // <= 512
u8[payloadBytes] payload
```

A keyframe (`baselineId == 0`) carries the local spawn set implicitly: every entity in the sender's interest set is sent as a spawn if it has not been spawned for this peer, and as a full delta otherwise. The receiver rebuilds its table from the keyframe. A keyframe is never fragmented across more than `maxFragments` frames.

### 4.4 Fragmentation

A snapshot larger than the frame budget is sent as `SNAPSHOT_FRAGMENT` frames:

```
u16 messageId           // host-scoped, increments per logical snapshot
u8  index               // 0..count-1
u8  count               // 1..8
u16 totalBytes          // logical snapshot body size, <= 9600
u8[bodyBytes - 6] chunk
```

Rules:

- All fragments of one message arrive in order over one WebSocket. A receiver must still tolerate interleaving with other message ids and reassemble into a bounded map keyed by `messageId`.
- Reassembly is capped at `maxSnapshotBytes`; a duplicate fragment with different bytes is a protocol error. An incomplete message is discarded after **2 s** or when a newer keyframe arrives.
- Fragment headers count toward `maxFrameBytes`. A logical snapshot above 9,600 bytes is split across more frames by the sender's interest budget instead (it must drop low-priority entities), never by adding fragments beyond 8.
- Fragmentation exists for a 1,200-byte path-MTU-safe frame on future transports. On WSS it is an envelope choice, not a reliability mechanism.

### 4.5 Snapshot acknowledgement and keyframes

`SNAPSHOT_ACK`:

```
u16 snapshotId          // newest snapshot received
u16 receivedBaseline    // baselineId of that snapshot (0 = keyframe)
u16 eventHighWater      // newest eventId received
u16 reserved            // 0
```

- The host keeps the last **64** snapshots per peer (about 3.2 s at 20 Hz) and uses the acked `snapshotId` as the next baseline. A baseline older than `baselineLifetimeMs` or evicted from the ring forces a keyframe.
- A keyframe is sent when: no ack has arrived for **2 s**; the peer requested one; a snapshot would exceed the budget and the baseline is missing; or `keyframeIntervalTicks` elapsed since the last keyframe.
- `KEYFRAME_REQUEST` is `u16 lastSnapshotId; u16 reserved`. The host honours at most one request per 500 ms per peer.
- A stale ack is ignored. An ack for a snapshot the host no longer retains is treated as no ack and triggers a keyframe.
- The host never retransmits a snapshot. It sends the newest state; a lost snapshot is superseded. This is what keeps latency bounded on a reliable transport with head-of-line blocking.

### 4.6 Command body

`COMMAND`:

```
u32 sequence            // client-scoped, starts at 1, never 0
u32 clientTick          // client estimate of host tick
u32 buttons             // 32-bit game-defined bitfield
i16 axis0, axis1, axis2, axis3   // -32767..32767, mapped to -1..1
i16 yaw                 // degrees × 100, -18000..18000
i16 pitch               // degrees × 100, -9000..9000
```

Body size is **24 bytes**; `COMMAND` total is 28 bytes. `COMMAND_BATCH` repeats the last `commandRedundancy` commands (oldest first):

```
u8 count                // 1..3
u8 reserved             // 0
command[count]
```

A batch is at most `1 + 1 + 3 × 24 = 74` bytes, well inside one frame. Redundancy covers the case where one command is lost or delayed; the host deduplicates by `sequence`.

Rules:

- The host accepts a command whose `sequence` is greater than the highest seen for that peer, or a duplicate of one already seen (ignored). It buffers out-of-order commands for at most `maxCommandBufferMs`; a command older than **250 ms** relative to the current tick is rejected and counted.
- A client sends at `commandHz` (default 30 Hz) while any input is non-zero, and at 10 Hz when idle, mirroring the controller's send policy. A command is sent immediately on a press edge, but never more than once per 4 ms.
- The host applies at most one command per peer per tick. If two are due, the newer level fields win and any press edges are OR-accumulated, exactly as the existing input mapper does (SPEC FR-7.11/7.12). Edges are never lost because of sampling.
- A missing command repeats the last command's level state for at most 250 ms, then falls back to the neutral command (`buttons=0`, axes 0). This is the same behaviour as a phone that stops sending.
- `spectator` peers may not send commands; a command from a spectator is counted and dropped, never applied.

### 4.7 Events and reliability

Events are host-to-peer and use a small reliable stream carried by the ordered WebSocket:

```
EVENT:      u16 eventId, u8 type, u8 flags, u32 entity, u16 payloadBytes, payload
EVENT_ACK:  u16 eventHighWater, u16 reserved
```

- `spawn` and `despawn` are **critical** (`flags` bit 0 = 1) and are queued until acked. A peer whose critical queue exceeds **1,024** events is disconnected with `netError{reason:"overflow"}`; applying a partial entity table would be worse than a clean reconnect.
- Game events are non-critical: up to **256** pending; when full, the oldest non-critical event is dropped and `stats.eventsDropped` increments.
- Events are resent at most every **250 ms** while unacked, up to **10 s**; then the peer is marked `degraded` and a keyframe is requested. An event id is never reused within a session.
- Snapshot deltas do not depend on event delivery order. A spawn event creates the entity table entry; the delta that follows may arrive before the event on a future non-ordered transport, so a delta for an unknown `netId` is buffered for up to **500 ms** and then dropped with a counter.

### 4.8 Clock and ping

```
PING:  u32 clientTimeMs, u32 lastSnapshotId
PONG:  u32 clientTimeMs, u32 serverTimeMs, u32 hostTick, u16 snapshotHz, u16 reserved
```

- Either side may ping. The host sends a ping at 1 Hz when no command has arrived for 1 s; the peer answers immediately.
- The client derives `rtt = receivedAt - clientTime` and `offset = serverTime - (clientTime + rtt/2)`, using the same minimum-RTT logic as the controller (controller clockSync: 30 s window, discard samples above 2× the window minimum). The host tick is derived from `hostTick + round((now - serverTime) / 16.667)`.
- `serverTime` is the relay's clock, not the host's wall clock. The host's simulation tick is authoritative; the mapping is monotonic and clamped so a clock adjustment cannot jump the render tick by more than 100 ms at once.
- The player-visible render tick is `estimatedHostTick - interpolationDelayTicks`, where `interpolationDelayTicks = round(interpolationDelayMs / 16.667)`, clamped to `0..9` (0–150 ms). The client never renders ahead of the newest received host tick.

### 4.9 Peer state and close

```
PEER_STATE: u8 peer, u8 state, u16 slot, u32 reserved
             state: 0 joined, 1 left, 2 spectator, 3 timedOut, 4 ownerChanged
BYE:         u16 code, u16 reasonCode
```

`BYE` codes reuse WebSocket close semantics: 1000 normal, 1001 host lost, 1002 protocol, 1008 policy, 1009 oversized, 1011 internal. `reasonCode` is a small enum (`0 none`, `1 hostLost`, `2 roomExpired`, `3 kicked`, `4 version`, `5 overflow`, `6 timeout`) and is rendered as a human sentence by the host shell, never as raw text from the peer.

### 4.10 Quantization and limits

| Value | Encoding | Precision / range | Bytes |
|---|---|---|---:|
| Position | 3 × i32 centimetres, absolute world coordinates | 0.01 m; ±21,474 km | 12 |
| Rotation | u32 smallest-three (2-bit index + 3 × 10-bit) | ≈0.11° | 4 |
| Velocity | 3 × i16 cm/s | 0.01 m/s; ±327.67 m/s | 6 |
| Flags | u8 | 8 bits | 1 |
| Payload | u16 length + bytes | ≤ 64 per delta, ≤ 256 on spawn | 2+n |
| Command axes | 4 × i16 | −1..1 mapped to −32767..32767 | 8 |
| Yaw / pitch | i16 degrees × 100 | 0.01°; ±327.67° / ±90° | 4 |
| Tick / time | u32 milliseconds or ticks | wraps per type; never compared across wraps without a signed delta | 4 |

A representative delta for a moving entity is `4 + 2 + 12 + 4 + 6 + 1 = 29` bytes. A 100-entity snapshot at 20 Hz is about **58 KB/s** before headers and events, inside the default 64 KB/s peer budget; an entity that changes only position is 18 bytes. The host's interest budget, not this table, is the enforcement point.

### 4.11 Versioning and compatibility

- `NET_PROTOCOL_VERSION = 1` is negotiated in `netHello`/`netWelcome`. A relay that does not support the offered version returns `netError{badVersion}`; the host stays local and the client sees a notice.
- Adding a field uses a reserved bit in `flags` or a new frame type; reserved bytes and bits are written as 0 and **validated as 0** in v1. A reader that sees a reserved bit set closes 1002 rather than guessing.
- Changing a field's meaning, width or order is a version bump and a migration note. The relay accepts the current version and, at most, the previous one during a rollout window; it never guesses.
- The local controller protocol is untouched. `PROTOCOL_VERSION` stays 1; the existing protocol, broker and controller tests are the regression gate for every net wave.
- A build without `engine-net` has no `/net` route, no new bundle chunk and no change to the host/controller size. The feature is lazy-loaded when `NetMode` is `relay`.

### 4.12 Security rules

- Auth uses the broker's room credentials; the relay issues the peer id. A command frame has **no sender field**, so a peer cannot impersonate another peer or the host.
- The host role is granted only with `hostToken`; a second host socket is refused. A spectator cannot send `COMMAND`, `EVENT_ACK` or `KEYFRAME_REQUEST`; only `PING`, `PONG` and `BYE` are accepted.
- Frame size, fragment count, reassembly bytes and JSON size are capped before allocation. A malformed frame closes 1002/1009 and is counted.
- Per-IP connection limits, per-room peer limits and per-peer token buckets apply before any fan-out. Snapshot and event bodies are never logged and never persisted (SR-12).
- The relay must not parse game payloads. It may inspect only the header fields needed for routing, rate limiting and framing.
- No PII, no analytics, no player names in URLs. A display name, when present, is sanitized by the existing SDK rules and rendered as text only.
- TLS/WSS is required in production (SR-8); the CSP must list the relay origin in `connect-src` and must not add a wildcard.

---

## 5. Architecture

### 5.1 Module map

```
packages/net/
  src/index.ts                 public exports, NET_PROTOCOL_VERSION, limits
  src/session/host.ts          HostSession lifecycle, peer table, tick update
  src/session/client.ts        ClientSession lifecycle, command queue, render clock
  src/session/state.ts         NetState transitions, timers, error mapping
  src/replication/entityTable.ts  netId ↔ Entity, ownership, spawn/despawn queues
  src/replication/snapshot.ts     snapshot build, baseline ring, keyframes
  src/replication/delta.ts        field masks, delta encode/decode
  src/replication/quantize.ts     position/rotation/velocity/command codecs
  src/replication/interest.ts     grid broad phase, scoring, hysteresis, budget
  src/prediction/commandBuffer.ts sequence ring, dedupe, replay window
  src/prediction/predictor.ts     hooks, predicted entity state, error measurement
  src/prediction/reconcile.ts     restore + replay, snap-vs-smooth decision
  src/history/transformHistory.ts tick/time ring, sampling
  src/history/lagCompensation.ts  rewind query, clamp, counters
  src/wire/frames.ts              header, all frame codecs, fragmentation
  src/wire/handshake.ts           netHello/netWelcome validation
  src/wire/limits.ts              shared constants and byte accounting
  src/clock/clockSync.ts          minimum-RTT offset, host-tick mapping
  src/transport/relayTransport.ts WebSocket adapter (DOM)
  src/transport/memoryTransport.ts deterministic test transport
  src/security/validate.ts        role, sequence, range, reserved-bit checks
  test/unit/**                    codecs, quantization, delta, interest
  test/property/**                round-trip, budget, no-NaN, ordering
  test/golden/**                  frame fixtures, snapshot bytes, sync hashes
  test/integration/**             two-client sync, reconnect, local-room regression
  test/bench/**                   snapshot build, interest, prediction cost
```

**Dependencies.** `engine-net` imports `@lanpad/engine-core` only (types, math, `EngineError`). It must not import `@lanpad/protocol`, `@lanpad/sdk`, `@lanpad/broker`, `@lanpad/runtime`, a renderer, or a game (00 §5.2 D3). The relay-side adapter lives in `packages/broker/src/net/**` and is implemented by the broker owner; it imports `@lanpad/protocol` and `@lanpad/broker` as it does today, never `engine-net` and never a game. The browser transport is injected by the runtime, so the package's pure logic runs in Node for tests.

**Package path note.** The wave ownership manifest names `packages/net/**` for this package; 00 §5.3/§6 lists engine packages under `packages/engine/*` and does not yet include `engine-net`. The integration agent must add the path, workspace name, tsconfig reference, Vitest project and eslint boundary rule to 00's tables in the same wave. This is bookkeeping, not an interface change; the package name `@lanpad/engine-net` is fixed by this spec.

### 5.2 Authority and tick pipeline

**Host tick** (one fixed 60 Hz step):

```
1. input.poll()                       local host input, one snapshot
2. net.applyCommands(tick)            one command per peer, sequence order, OR edges
3. game.simulate(dt, snapshot)        authoritative game update
4. net.recordHistory(tick)            transforms + game hitboxes for owned entities
5. net.update(tick)                   interest update (every 6 ticks), snapshots (per snapshotHz)
```

**Client tick** (one fixed 60 Hz step, same loop):

```
1. local input -> InputCommand -> net.sendCommand()
2. net.applyLocalPrediction(dt)       hooks.step for locally owned entities
3. net.receiveSnapshots()             decode, ack, baseline update, reconcile
4. net.advanceRenderTick()            newest hostTick - interpolation delay, clamped
5. game.render(alpha)                 interpolation for remote, prediction for local
```

Rules:

- The host applies commands **before** `simulate`, in the same tick. It never applies a command mid-frame. A command that arrives during `simulate` waits for the next tick.
- Commands are total-ordered per peer by `sequence`; peers are processed in ascending `PeerId` order, so the host's state hash is independent of socket arrival order.
- A command from a peer whose entity ownership is unknown is rejected. Ownership is assigned by `setOwner` and replicated as a critical event; a command for an entity owned by another peer is ignored and counted.
- The client never applies a remote snapshot directly to the game's simulation state. Authoritative state feeds interpolation (remote entities) or reconciliation (owned entity). The client's game simulation remains local-only for presentation.
- The host's `update` is allocation-free after warm-up: peer slots, snapshot buffers, interest arrays, delta buffers and fragment buffers are preallocated per peer.
- `snapshotHz` is a divisor of 60: 10, 15, 20, 30. The default 20 means snapshots on ticks where `tick % 3 == 0`; a change takes effect at the next host tick and is sent in the welcome message.

### 5.3 Snapshot pipeline

1. **Interest set.** Every `decisionIntervalTicks` (6 ticks by default), recompute each peer's candidate set from the grid and view. Between decisions, retain the previous set and add any newly owned entity immediately.
2. **Priority.** Each entity gets a score: distance band (0–3), visibility cone (0/2), ownership (+6), recent event/damage (+4), and a per-entity accumulator (`+= priority` each snapshot). The top entities that fit the byte budget are sent. This guarantees a far entity is not starved forever.
3. **Delta vs baseline.** Look up the peer's last acked snapshot. If the baseline is missing or older than 2 s, emit a keyframe. Otherwise encode only changed fields; a `fieldMask` of 0 is a keepalive and costs 6 bytes.
4. **Order.** Entities are sorted by `netId` ascending inside a snapshot. Spawns precede deltas; events follow. This makes golden bytes and state hashes deterministic.
5. **Budget.** Stop adding entities when the next record would exceed `bytesPerSecondPerPeer` for this send window or `maxEntitiesPerSnapshot`. Drop the lowest-score entity first, never a critical spawn/despawn. Count `budgetDrops`.
6. **Fragment and send.** If the body exceeds `maxFrameBytes - 4`, fragment up to 8 frames. If it still exceeds `maxSnapshotBytes`, reduce the entity set and rebuild before sending.
7. **Remember.** Store the snapshot body and entity versions in the per-peer baseline ring for subsequent deltas. The ring is 64 entries; an entry is evicted by age or count.
8. **Record stats.** `snapshotsSent`, bytes, draw-relevant counters. No string formatting on the hot path.

The snapshot builder never allocates a new object per entity; it writes into a per-peer `ArrayBuffer` and a reusable record scratch. A keyframe rebuild is the only path that may grow a table.

### 5.4 Prediction and reconciliation

Prediction is opt-in and game-supplied; the engine does not guess game rules.

1. The client sends each command with a local sequence and predicted tick.
2. If `PredictionHooks` are installed, the client calls `hooks.step(id, command, 1/60)` for every locally owned entity immediately, and stores `{ sequence, tick, command }` in a 512-entry ring.
3. When a snapshot arrives with `ackedCommand = N`, the client removes commands `<= N`, calls `hooks.restore(id, authoritativeState)`, then `hooks.replay(id, remainingCommands)` in sequence order.
4. `hooks.error(id)` reports the position error before replay. If error > **0.02 m** or the rotation error > **1°**, the client snaps and counts a correction; otherwise it keeps a decaying visual offset (100 ms) so the correction is not visible.
5. Without hooks, the client does not predict: the owned entity is interpolated from authoritative snapshots with the same delay as remote entities, and input feels the RTT. The host still accepts commands and the game remains correct.

Bounds:

- At most **32** locally owned entities are predicted; beyond that, prediction falls back to interpolation and counts `predictionLimit`.
- The command ring is 512 entries (about 8.5 s at 60 Hz). A peer that falls further behind is resynced with a keyframe and its ring is cleared.
- Prediction is deterministic per build/browser only. A different browser may produce slightly different float results; the correction threshold absorbs it. Cross-browser lockstep is not a goal (00 §5.8).
- A teleport flag (`EntityState.flags` bit 2) forces a snap, never a smooth correction.

### 5.5 Remote interpolation and extrapolation

- Remote entities are sampled at `renderTick = newestHostTick - interpolationDelayTicks`. Two surrounding snapshots are interpolated linearly for position and slerped for rotation. Velocity is interpolated for effects only.
- If only an older sample exists, the client extrapolates using velocity for at most `maxExtrapolationMs` (100 ms), then freezes the last pose. It never extrapolates through a teleport or a despawn.
- An entity that leaves the interest set is kept for **2 s** (hidden after 500 ms without an update) before removal, preventing a visible pop when the camera crosses a cell boundary.
- Snapshot ordering: a snapshot older than the current newest is discarded; equal ticks are merged by field. The client never moves its render clock backwards.

### 5.6 Lag compensation

- The host records, per replicated entity, a ring of `{ tick, serverTimeMs, Transform }` for `historyMs = 1000`. The ring is allocated at replication time; recording is O(1) and allocation-free.
- `HostSession.rewind(entity, atServerMs, out)` clamps the requested time to `[now - lagCompensationMs, now]` (default 100 ms, cap 250 ms), interpolates between the two nearest samples and returns false when the entity has no history in range.
- The game uses `rewind` for hitscan or melee queries against a target's **past** transform. The engine does not rewind the whole world, does not re-simulate, and does not rewind physics bodies. This is a bounded, explicit contract: a game that needs full historical collision must record its own shapes per tick.
- A rewind query is not allowed to mutate simulation state. It runs inside the tick that resolves the shot and returns a value; the game applies damage in the normal simulation path.
- The host counts `rewindQueries` and exposes `stats`. A game that never calls it pays only the history memory: `1000 ms × 60 ticks × 8 peers × 32 bytes ≈ 1.5 MB` at the default entity cap, preallocated.

### 5.7 Interest management

- **Broad phase.** Entities are bucketed by the same 64 m `CellKey` grid as streaming (00 §4.4, spec 12). A peer's view covers its cell plus a radius-derived ring; only those buckets are scanned. Static world content is not replicated at all; it streams separately.
- **View.** The client sends an `InterestView` in its `COMMAND` payload? No — the view is derived from the peer's owned entity on the host, or from an explicit `INTEREST` message for spectators. To keep the command frame fixed, the host uses the peer's owned entity transform; a spectator sends a `game` event of type `interest` at 2 Hz (payload ≤ 32 bytes: position + forward + radius). This is the only spectator→host message besides ping.
- **Scoring.** `score = priority + 6·owned + 4·recentEvent + 3·insideViewCone + 2·sameCell + distanceBandWeight`, where distance bands are 0/1/2/3 at 48/96/192/384 m. Ties break by `netId` ascending.
- **Hysteresis.** An entity entering at the radius edge stays for 2 s; an entity leaving is not removed until it has been outside for 2 s. This prevents cell-boundary churn at 20 Hz.
- **Budget.** The per-peer byte budget is enforced in the snapshot builder. The interest set is capped at 2,048; a full set reports `isFull` and drops the lowest-score entities.
- **Hidden information.** The host never sends an entity outside the interest set, except an owned entity and a critical event that affects it. A game that needs global state (score, mission stage) sends it as a game event, not as a replicated entity.
- **Spectators.** A spectator receives the union of the observed player's set plus the camera set, capped at 1,024 entities and a lower byte budget (32 KB/s). The spectator never receives private panel content; panels stay on the existing controller channel.

### 5.8 Clock, ordering and determinism

- The host tick is the only simulation clock. `serverTimeMs` is for latency estimation and for save timestamps, never for simulation decisions.
- Command application is total-ordered by `(tick, peerId, sequence)`. Duplicate sequences are ignored. The host's state hash is recorded every 60 ticks in dev; two replays of the same command trace must match.
- Quantization is deterministic: integer rounding uses `Math.round` on a finite value, clamps before rounding, and never uses `toFixed`. A NaN or Infinity in a transform is a bug: the entity is skipped, a counter increments, and dev logs once.
- No `Math.random`, `Date.now` or `performance.now` inside the replication tick. Time enters as `tick` and `serverTimeMs`. The clock module is the only place that reads wall time.
- The per-peer snapshot ring, interest arrays, command rings and fragment buffers are allocated at session start and reused. No `map/filter/forEach`, no object literals in the tick path (00 §5.10).
- Floats are transmitted as quantized integers, so the wire is stable across engines even though the simulation is not bit-identical across browsers.

### 5.9 Local-first migration path

The migration is additive and reversible; every stage leaves the existing local product working.

| Stage | What lands | What stays unchanged | Exit evidence |
|---|---|---|---|
| **0 — Today** | Broker local rooms, `/ws`, controller input, `hostLost`, 30 s reservations | — | Existing broker/controller tests green |
| **1 — Relay skeleton** | `/net` endpoint in the relay, handshake, room pairing, heartbeat, auth, `/net` disabled by default | Controller protocol, controller bundle, local rooms, `PROTOCOL_VERSION = 1` | Two sockets pair in a room; a build without config has no `/net` traffic |
| **2 — World sync (M2)** | Snapshot/delta/command codecs, host session, client session, interpolation, keyframes, interest v1 | Local boot and phone join never wait for the relay; `NetMode.off` is the default | Two-client sync fixture passes on `127.0.0.1:0`; local-room tests unchanged |
| **3 — Prediction and lag compensation** | `PredictionHooks`, reconciliation, rewind ring, degradation policy | Games without hooks run as in stage 2 | Prediction error bounds; rewind fixture |
| **4 — Production relay** | WSS, Origin allowlist, CSP, room affinity, region config, rate limits, monitoring counts | Local mode remains the offline fallback | P1/P2 infrastructure rows in `docs/RESULTS.md` |
| **5 — Optional transport** | WebRTC data channel behind `NetTransport`; relay as signalling/fallback | Same session API and wire messages | Only if a measured need appears; no requirement in M2 |

Rules:

- `NetMode` is host configuration, not a game manifest requirement. A game that needs online play declares `supportsOnline: true` in its manifest (additive SDK field, spec 18); the host still decides whether to enable it.
- The runtime composition root (`selectNet.ts`, owned by the integration agent) chooses `off`, `local` or `relay`. `local` keeps the existing `hostClient` path and exposes no `ctx.net`. `relay` starts `/net` after the room exists; if it fails, the host logs a notice and continues in `local`/offline mode.
- A remote peer without the engine's net chunk can still join as a phone controller. It simply gets no replicated world.
- The relay and the host may be deployed independently during a rollout. Version negotiation is explicit; an old relay returns 404/`badVersion` and the host stays local.
- No local-room code path may call `/net`, and no `/net` code path may change a controller frame. The two planes share room auth and nothing else.

### 5.10 Failure handling

| Failure | Behaviour |
|---|---|
| `/net` upgrade fails (404, TLS, CSP, relay down) | Host stays local, shows one notice, does not retry more than 3 times with backoff 250 ms → 4 s |
| Handshake timeout or `badVersion` | Close the socket, stay local, count; no game failure |
| Relay drops while a session is active | Enter `reconnecting` for 30 s; peers buffer commands; on reconnect, host sends a keyframe and clients clear stale predictions |
| Host socket drops | Existing `hostLost` rules for controllers; online peers receive `BYE{hostLost}` and show "Waiting for TV"; no host migration |
| Peer silent for 5 s (2 s heartbeat) | Mark `timedOut`, release ownership, despawn its entities after 2 s, notify the game via `PeerEvent` |
| Peer command buffer full or sequence gap > 250 ms | Reject old commands, repeat the last level, count; request a keyframe if prediction diverges |
| Critical event queue > 1,024 | Disconnect that peer with `overflow`; the room continues |
| Baseline lost or ack stale | Send a keyframe on the next snapshot tick; never block the tick |
| Snapshot exceeds budget | Drop lowest-priority entities, rebuild, count; never exceed `maxSnapshotBytes` |
| Prediction error above threshold | Snap the owned entity, count a correction, continue; three hard corrections in 2 s disable prediction for that entity and fall back to interpolation |
| Client clock skew or host tick wrap | Clamp the render tick to `newest - 9..newest`; signed 32-bit delta for tick comparisons; never render backwards |
| Room full or unauthorized peer | `netError` and close 1008; the room roster is unchanged |
| Spectator sends a command | Drop, count, do not close (a spectator client may have a phone UI bug) |
| Unsupported feature (e.g. no WebSocket) | `E_UNSUPPORTED_FEATURE`; local mode remains |

All recoverable failures increment a counter and degrade one feature. An unrecoverable protocol error closes only that socket and routes an `EngineError` (`layer: "host"` or a new `"net"` layer, added additively) to the host notice panel (00 §5.9). Tokens, room codes and raw payloads never appear in an error message.

### 5.11 What the first implementation must not do

- It must not change `PROTOCOL_VERSION`, the controller bundle, the 26/27-byte input frames or any local room rule.
- It must not put the relay in the simulation path, or let a client send state instead of commands.
- It must not implement host migration, matchmaking, accounts, voice, text chat or a general RPC bus.
- It must not retransmit snapshots, or queue an unbounded snapshot backlog per peer.
- It must not rewind physics or re-simulate the world for lag compensation.
- It must not replicate static world geometry; streaming owns that.
- It must not expose `WebSocket`, `RTCDataChannel`, `Peer` or a broker type in `GameNet`.
- It must not allocate per entity per tick or format strings in the snapshot path.
- It must not claim a bandwidth, latency or TV row from a desktop run.
- It must not enable `/net` by default or make boot depend on the relay.

---

## 6. File ownership

One writer per path for the implementation wave. The task's ownership manifest names `packages/net/**`; this spec fixes the package name `@lanpad/engine-net` and the paths below.

### 6.1 Owned by this spec

| Path | Contents |
|---|---|
| `packages/net/package.json` | workspace package, name `@lanpad/engine-net`, ESM, no DOM-only deps |
| `packages/net/tsconfig.json` | project reference to `engine-core` only |
| `packages/net/src/index.ts` | public exports; `NET_PROTOCOL_VERSION`; no transitive host imports |
| `packages/net/src/session/host.ts` | `HostSession`, peer table, tick update, ownership |
| `packages/net/src/session/client.ts` | `ClientSession`, command queue, render clock |
| `packages/net/src/session/state.ts` | `NetState`, transitions, timers, error mapping |
| `packages/net/src/replication/entityTable.ts` | `netId` allocation, `Entity` binding, spawn/despawn queues |
| `packages/net/src/replication/snapshot.ts` | snapshot assembly, baseline ring, keyframe policy |
| `packages/net/src/replication/delta.ts` | field-mask encode/decode, record layout |
| `packages/net/src/replication/quantize.ts` | position, rotation, velocity, command codecs |
| `packages/net/src/replication/interest.ts` | grid broad phase, scoring, hysteresis, budget |
| `packages/net/src/prediction/commandBuffer.ts` | sequence ring, dedupe, replay window |
| `packages/net/src/prediction/predictor.ts` | `PredictionHooks` driver, predicted state |
| `packages/net/src/prediction/reconcile.ts` | restore/replay, snap-vs-smooth, error counters |
| `packages/net/src/history/transformHistory.ts` | ring records, sampling, memory accounting |
| `packages/net/src/history/lagCompensation.ts` | `rewind`, clamp, counters |
| `packages/net/src/wire/frames.ts` | 4-byte header, all frame codecs, fragmentation |
| `packages/net/src/wire/handshake.ts` | `netHello`/`netWelcome`/error validation |
| `packages/net/src/wire/limits.ts` | shared constants; byte accounting |
| `packages/net/src/clock/clockSync.ts` | min-RTT offset, host-tick mapping, clamp |
| `packages/net/src/transport/relayTransport.ts` | WebSocket adapter; the only file that touches `WebSocket` |
| `packages/net/src/transport/memoryTransport.ts` | deterministic in-memory transport for tests |
| `packages/net/src/security/validate.ts` | role, sequence, range and reserved-bit checks |
| `packages/net/test/unit/**` | codec, quantization, delta, interest, ordering |
| `packages/net/test/property/**` | round-trip, invariants, budget, corruption |
| `packages/net/test/golden/**` | frame fixtures, snapshot byte hashes, sync trace hashes |
| `packages/net/test/integration/**` | two-client sync, reconnect, local-room regression |
| `packages/net/test/bench/**` | snapshot, interest, prediction, history benchmarks |
| `packages/net/fixtures/**` | input traces, expected hashes, sample snapshots |
| `docs/engine/contracts/14-net.d.ts` | frozen additive contract beside this spec |
| `experiments/e-net-sync/**` | acceptance fixture page described in §7 |

`docs/engine/contracts/14-net.d.ts` is generated by hand from §3 and frozen with this spec. It is additive-only until an M2 release, and it is the file a fresh agent implements against.

### 6.2 Owned by other agents (coordination required, not editable here)

| Path | Owner | Request |
|---|---|---|
| `packages/broker/src/net/relay.ts` | broker owner | `/net` upgrade, auth reuse, peer assignment, rate limits, fan-out |
| `packages/broker/src/net/framing.ts` | broker owner | frame size cap before allocation; no payload parsing |
| `packages/broker/src/net/limits.ts` | broker owner | per-IP, per-room, per-peer buckets |
| `packages/dev-server/src/net.ts` | dev-server owner | mount `/net` in dev only, disabled by default |
| `packages/runtime/src/net/selectNet.ts` | integration agent | choose `off` / `local` / `relay`; lazy-load engine-net |
| `packages/runtime/src/net/bridge.ts` | integration agent | connect `GameHost` tick to `HostSession`; expose `GameContext.net` |
| `sdk/src/net.ts` | SDK owner (spec 18) | additive `net?: GameNet` on `GameContext`, `supportsOnline` manifest flag |
| `docs/engine/00-architecture.md` | architecture owner | add `engine-net` to package catalogue, dependency rules, version registry |
| `packages/controller/**` | controller owner | **no change**; local room path is the regression contract |
| `docs/engine/14-networking.md` | this spec | only this agent edits this file in this wave |

No engine-net file imports `@lanpad/runtime`, `@lanpad/broker`, `@lanpad/protocol`, `@lanpad/sdk`, a renderer or a game. No relay file imports `@lanpad/engine-net`. The only shared things are the room credentials and the `/net` handshake, which the relay validates through the broker's existing auth helpers.

### 6.3 Boundary rules the reviewer enforces

- `packages/net/src/transport/relayTransport.ts` is the only file allowed to reference `WebSocket`, `MessageEvent`, `CloseEvent` or `ArrayBuffer` DOM types. The session and codec layers take a `NetTransport`.
- `packages/net/src/**` must run in Node with `memoryTransport`; a codec test must never open a socket.
- Nothing in `engine-net` reads `Math.random`, `Date.now` or `performance.now` outside `src/clock/` and `src/transport/`.
- Relay code never reads a snapshot body, a command body or an event payload. It reads only `type`, `flags`, `bodyBytes`, the peer and the room.
- The controller package and `packages/protocol` are not touched. If an implementation needs a change there, it is a spec amendment, not a local edit.

---

## 7. Acceptance

The acceptance fixture is `experiments/e-net-sync/`:

- `index.html` boots a host page with a minimal 3D/2D scene: a flat plane, 8 moving cubes, one owned cube per peer, and a HUD showing peer, snapshot, tick, RTT, bytes/s, `NetState` and `NetStats`.
- `?role=host&code=ABCD&bots=2&latency=0&loss=0` runs the host; `?role=client&code=ABCD&bot=1` runs a synthetic client that sends scripted commands. Both are plain pages served by the existing dev server; no new server feature is required.
- `?freeze=1` uses a fixed 60 Hz accumulator driven by `requestAnimationFrame` plus a recorded wall-clock stub, so two runs produce the same command trace and the same state hash.
- The browser-side client is driven by Playwright over CDP; latency/loss emulation uses `Network.emulateNetworkConditions` and the transport's in-memory fault injection for unit runs. Both are labelled separately in the results.

Named hardware for desktop rows: **`pc-win11-rtx3050`** (Windows 11 Home, Ryzen 5 5600, RTX 3050, 16 GB RAM), Chrome **155.0.8059.85**, 1920×1080, power plugged in. The fixture may run headless for CI evidence; a headed run is required for frame-time rows. Rows that need a TV, a phone radio or a real WAN are **PENDING** with the exact device/run named.

| ID | Criterion | Fixture / method | Target | Status |
|---|---|---|---|---|
| ER-14-01 | Two clients converge to the host's authoritative state | `e-net-sync` host + 2 bot clients, 30 s scripted trace, `freeze=1`; compare each client's reconstructed entity table with the host's at every snapshot | position error ≤ 0.02 m, rotation error ≤ 0.5°, entity set identical at each keyframe; **0** desyncs | Required M2 |
| ER-14-02 | Deterministic snapshot bytes | same command trace replayed twice; FNV-1a hash of every snapshot body | hashes identical across runs on the same build/browser | Required M2 |
| ER-14-03 | Command loss / duplication tolerance | `memoryTransport` with 10% loss, 5% duplication, reorder window 100 ms, 10,000 commands | final applied sequence equals highest sent; no dropped press edge; state hash matches a lossless run within the game's tolerance | Required M2 |
| ER-14-04 | Snapshot loss tolerance | 10% snapshot loss + 2 s stall; 60 s run | client recovers via keyframe; `NetState` returns to `connected`; no entity lost; render clock never jumps > 100 ms at once | Required M2 |
| ER-14-05 | Prediction correction bound | local client at 80 ms emulated RTT, 1% loss, owned cube on a fixed path; 60 s | mean position error ≤ 0.05 m, p95 ≤ 0.15 m; corrections ≤ 2/s; no snap while error ≤ 0.02 m | Required M3 |
| ER-14-06 | Interpolation smoothness | remote cube at 100 ms emulated RTT, 20 Hz snapshots; record per-frame position | no visible stall > 150 ms; rendered position is C0 continuous across snapshot boundaries; extrapolation never exceeds 100 ms | Required M2 |
| ER-14-07 | Lag-compensation accuracy | host moves a target at 8 m/s; `rewind` query at 100 ms in the past; 1,000 samples | returned position within 0.05 m of the recorded past transform; false when history is absent or clamped | Required M3 |
| ER-14-08 | Interest management | 400 entities on a 64 m grid, camera moving across cells; 60 s | per-peer entity count ≤ 2,048; no boundary thrash > 2 enter/leave per entity per 2 s; owned entity always present; hidden entities never sent | Required M2 |
| ER-14-09 | Bandwidth | 8 peers, 100 moving entities each in view, 20 Hz, 30 Hz commands | per-peer ≤ 64 KB/s sustained (128 KB/s ceiling), host egress ≤ 512 KB/s at 8 peers; measured with `NetStats` and the browser network panel | Required M2 |
| ER-14-10 | Tick cost | snapshot build + command apply + interest, 256 entities, 8 peers | CPU p95 ≤ 0.8 ms/tick on `pc-win11-rtx3050`; no allocation after warm-up (`NetStats.allocBytesPerTick == 0` in dev) | Required M2 |
| ER-14-11 | Memory | 8 peers, 256 entities, 1,000 ms history | net buffers ≤ 16 MB total; no growth over a 10-minute run (slope < 64 KB/min) | Required M2 |
| ER-14-12 | Reconnect | kill relay socket mid-session, restore after 2 s; host keeps running | client back in ≤ 30 s using 250 ms → 4 s backoff; keyframe resync; no duplicate entities; no command applied twice | Required M2 |
| ER-14-13 | Local first | full existing gate with `/net` disabled and enabled-but-unused | `PROTOCOL_VERSION == 1`, controller bundle within its existing 40 KB gz budget, join < 5 s, existing integration tests unchanged | Required M2 |
| ER-14-14 | Security | scripted probes: no token URL, wrong token, second host, spectator command, 2,000-byte frame, 9 fragments, reserved bit, malformed JSON | all refused with the specified close code; tokens absent from logs and error text; relay memory flat during 60 s probe flood | Required M2 |
| ER-14-15 | WAN latency | two peers on separate networks ≥ 500 km apart, 60 s drive fixture | input-to-remote-visual p95 **PENDING** real run; do not fill from loopback | **PENDING** |
| ER-14-16 | TV client | Android TV browser as a spectator/client over Wi-Fi | frame and legibility **PENDING** real device; the row is not claimed | **PENDING** |
| ER-14-17 | Phone controller unaffected | existing controller on `/ws` while `/net` carries world traffic | input-to-canvas p95 < 25 ms LAN (existing budget), no added controller bytes | Required M2 |

Status values mean exactly what they say: `Required M2` is a gate for the first replication release; `Required M3` may land one wave later; `PENDING` is not evidence and must not be cited as passing.

### 7.1 Acceptance data to record in `docs/RESULTS.md`

For each run: date, commit, browser + version, OS, CPU/GPU/RAM, fixture URL, seed, emulated RTT/loss, entity count, peer count, snapshot/command Hz, `NetStats` samples (p50/p95/max) for RTT, bytes/s, tick cost, corrections, budget drops, and the state-hash comparison result. A row without the seed and the trace id is not reproducible and does not count.

### 7.2 What is not accepted

- A green unit suite with no two-client run.
- A loopback-only latency number presented as WAN latency.
- A screenshot of interpolated motion without recorded positions.
- "No visible desync" without an entity-table comparison.
- A bandwidth number measured with the fixture's HUD hidden or snapshots disabled.
- A TV row inferred from a desktop browser window resized to 1080p.

---

## 8. Test plan

Tests carry requirement IDs (`// @req ER-14-03` or a title tag); every tag resolves to a row in `TRACEABILITY.md`.

### 8.1 Unit (`packages/net/test/unit/**`)

- Frame header round-trip for every type; reject unknown type, reserved flag, oversized body.
- Quantization: position cm round-trip error ≤ 0.5 cm over ±10 km; rotation ≤ 0.11°; velocity ≤ 0.5 cm/s; command yaw/pitch boundary values; NaN/Infinity rejected.
- Delta field-mask encode/decode for every subset; `fieldMask == 0`; payload boundary 64/256.
- `netId` allocation never reuses a live id; wraps only after the live set is empty (test with a small id space injected).
- Snapshot assembly ordering: spawns before deltas before events; stable `netId` sort.
- Baseline ring eviction and keyframe trigger at 2 s with a fake clock.
- Interest scoring determinism with tied distances; hysteresis enter/leave timers.
- Command ring dedupe, out-of-order window, replay ordering.
- Clock sync min-RTT selection, outlier rejection, tick clamp.
- Error mapping for each `netError.reason` and `BYE.reasonCode`.
- Validators: spectator command rejected; frame with nonzero reserved byte rejected; fragment count 0/9 rejected.

### 8.2 Property (`fast-check`)

- Encode/decode of random `ReplicatedEntity` and `InputCommand` values is lossless within quantization tolerance (`ER-14-03`).
- For any random byte buffer up to 9,600 bytes, decoding either returns a valid value or throws a typed `NetError`; it never reads out of bounds, never hangs, never allocates unbounded (fragment reassembly).
- For any snapshot body below the budget, fragmenting and reassembling yields the identical body; for any body above 9,600 bytes, the builder refuses rather than emitting > 8 fragments.
- Interest set only shrinks when the byte budget shrinks; owned entities are never removed by budget.
- Command sequences applied in any arrival order produce the same applied command per tick as sorted order.
- Rewind sampling never returns a transform newer than the requested time (within one tick).
- No `NaN`/`Infinity` reaches a wire encoder from a random finite input range.

### 8.3 Golden (`packages/net/test/golden/**`)

- `snapshot-keyframe.bin`, `snapshot-delta.bin`, `command-batch.bin`, `event-spawn.bin`, `fragment-3of7.bin`: exact bytes and FNV-1a hashes, checked in and reviewed. A changed byte fails the test and requires a version note.
- `sync-trace-a.json`: a recorded 600-tick command trace with input seed and per-tick state hash (`ER-14-02`).
- `handshake.json`: valid and invalid `netHello`/`netWelcome` matrices.

Golden files are small (≤ 10 KB each) and contain no tokens, room codes or personal data. They are generated by a checked-in tool under `packages/net/test/golden/make.ts`, not by hand.

### 8.4 Contract / conformance

- `docs/engine/contracts/14-net.d.ts` typechecks against the implementation's exported surface (`npm run typecheck` with a fixture that imports every public symbol).
- A conformance suite runs `HostSession` + `ClientSession` over `memoryTransport` and asserts the §3 semantics: ownership, `replicate` visibility, `rewind` clamp, `NetStats` monotonicity, close/dispose idempotence.
- A second conformance run uses a future alternate transport (a `NetTransport` stub with 200 ms delay and reordering) to prove the session layer does not assume WebSocket ordering.

### 8.5 Integration (`packages/net/test/integration/**`)

Bound to `127.0.0.1:0`; waits on messages, never fixed sleeps.

1. **Two-client sync (`ER-14-01`)** — start the real dev server/broker/relay, create a room, connect a host socket and two client sockets, run the recorded trace, compare entity tables at every keyframe. This is the acceptance test the task names.
2. **Reconnect (`ER-14-12`)** — drop and restore one client socket; assert resync and no duplicate entities.
3. **Host loss** — drop the host socket; peers get `BYE{hostLost}`, room follows existing `hostLost` rules, controllers still show the existing waiting state.
4. **Local-room regression (`ER-14-13`)** — run the existing two-phone join/input/reconnect journey with `/net` mounted and with it absent; assert identical behaviour and `PROTOCOL_VERSION == 1`.
5. **Auth** — wrong token, expired room, second host, room full, spectator command; assert close codes and no token in logs (capture stderr).
6. **Rate limits** — 100 snapshots/s from a malicious host and 100 commands/s from a peer; assert buckets hold and the room survives.

### 8.6 Benchmarks (`packages/net/test/bench/**`)

- Snapshot build for 64/256/1,024 entities × 8 peers, p50/p95/max, after a 5 s warm-up.
- Interest update for 1,000/10,000 entities on the grid.
- Command apply for 8 peers × 30 Hz.
- History record + rewind query for 100 entities.
- Allocation counter per tick (`ER-14-10`).

Benchmarks fail on a ceiling, not on a percentage regression, and are run on `pc-win11-rtx3050` or the CI runner named in the results row. A CI-only number is labelled as such.

### 8.7 Browser / end-to-end

Playwright drives `experiments/e-net-sync/` in Chromium at 1920×1080 and 1280×720. It asserts HUD values, `NetState`, the frozen clock, and captured `NetStats`. CDP network emulation covers RTT/jitter rows; the browser's own clock is not used for exact tick assertions. WebGL2 fallback and WebGPU both run the same fixture; a failure in either blocks the row.

### 8.8 Manual / measurement

Only the rows in §7 that need hardware: TV client, real WAN, phone radio. Each records device, OS, browser, network, date, commit and the raw trace file path in `docs/RESULTS.md`. Until then, the row stays `PENDING`.

### 8.9 Meta and hygiene

- Every test title/leading comment carries an `ER-14-*` id.
- No test opens a fixed port; no test sleeps; no test depends on wall-clock date.
- No fixture contains a real token, room code that resolves, IP address or player name.
- The gate runs `packages/net` in the root Vitest config; adding the package without the project entry fails the gate by design.
- Debug counters (`NetStats`) are read by tests, not parsed from console strings.

---

## 9. Dependencies

### 9.1 Specs and packages

| Dependency | Why | Landed? |
|---|---|---|
| `00-architecture.md` | package boundaries, `EngineError`, version registry, save/streaming interaction | yes (uncommitted) |
| `01-core-loop-time.md` | fixed 60 Hz tick, accumulator, pause, frame stats | yes (uncommitted) |
| `03-scene-ecs.md` | `Entity`, transform component, entity lifetime, stable ids | yes (uncommitted) |
| `10-input.md` | command field semantics, action mapping, deadzones, press edges | yes (uncommitted) |
| `12-world-streaming.md` | 64 m `CellKey` grid reused for interest; static world not replicated | yes (uncommitted) |
| `19-testing-benchmarks.md` | golden/determinism/benchmark harness | yes (uncommitted) |
| `packages/protocol` | unchanged; local rooms and controller frames remain the frozen contract | yes (v1) |
| `packages/broker` | room auth, session tokens, host tokens, rate-limit primitives | yes |
| `packages/dev-server` | static serving, `/ws`, Origin policy, LAN discovery | yes |
| `packages/runtime` | composition root, tick loop, `GameHost` | yes |
| `sdk` / spec 18 | additive `net` on `GameContext`, `supportsOnline` manifest field | pending 18 |
| `engine-core` | math types, `EngineError`, pool helpers | pending W1 |

### 9.2 Sequencing

1. **Contracts first (T0):** freeze `14-net.d.ts`, the handshake and frame header, and the `NetTransport` interface. No implementation before these types are in the tree.
2. **Codecs + memory transport (T1):** all encode/decode, quantization, fragmentation, golden bytes, property tests. This wave needs no relay and no browser.
3. **Host/client sessions over `memoryTransport`:** command apply, snapshots, keyframes, convergence tests. Still no relay.
4. **Relay adapter (broker owner):** `/net`, auth, peer assignment, rate limits, fan-out, integration tests on `127.0.0.1:0`.
5. **Runtime bridge + fixture:** `selectNet`, `GameHost` wiring, `e-net-sync`, browser acceptance.
6. **Prediction, history, lag compensation:** after basic replication is green; these are M3 rows and may slip without blocking M2.
7. **Production relay:** WSS, CSP, Origin allowlist, region config, monitoring. Infra owner, after M2.

A later step may consume an earlier step's types, never the reverse. Step 2 must not wait for step 4; `memoryTransport` exists exactly for that.

### 9.3 Prerequisites for the first implementation PR

- `packages/net` added to root workspaces, root `tsconfig.json` references, root Vitest projects and the eslint layer-boundary config. Without those, tests do not run and the gate lies.
- `NetStats` counters wired to the existing debug overlay (spec 16) so acceptance can read them without a new UI.
- A decision recorded in `docs/todos/README.md` that online relay is **additive to local-first**, not a replacement.
- The relay's `/net` route disabled by default in dev-server config, with an explicit `--net` flag; production enables it deliberately.

Dependencies that do **not** exist and must not be invented: matchmaking service, account system, Redis, a database, a second protocol version, a controller change, WebRTC, or a cloud save backend.

---

## 10. Risks

| ID | Risk | Likelihood | Impact | Mitigation / fallback |
|---|---|---|---|---|
| R14-1 | Scope creep turns "add online" into a full multiplayer platform | High | Slips M2, destabilises local play | The non-goals in §2 are contractual; no accounts/matchmaking/chat; `/net` is off by default |
| R14-2 | Snapshot bandwidth explodes with entity count | High | Misses ER-14-09, unusable on Wi-Fi | Interest grid + scoring + hard per-peer byte budget from day one; delta masks; budget drops are counted and visible |
| R14-3 | WebSocket head-of-line blocking makes 20 Hz snapshots bursty | Medium | Visible stutter under loss | Latest-wins coalescing, 1,200-byte frames, no snapshot retransmission; future `NetTransport` can be WebRTC without changing sessions |
| R14-4 | Prediction diverges on a different browser/CPU | Medium | Rubber-banding, "unfair" feel | Prediction is opt-in; error threshold 0.02 m/1°; fallback to interpolation after repeated hard corrections; no cross-browser lockstep claim |
| R14-5 | Lag compensation rewinds too far or through walls | Medium | Unfair hits, "shot around corner" | Clamp to 100 ms default/250 ms cap; history only for replicated entities; game owns hitbox recording; explicit counter and telemetry in dev |
| R14-6 | Auth or token leakage on the new endpoint | Low | Security incident | Reuse broker auth, constant-time compare, token in body only, never log, Origin allowlist, CSP, probe tests in ER-14-14 |
| R14-7 | Relay starts parsing game payloads "just for X" | Medium | Couples relay to games, breaks isolation | §6.3 boundary rule; review rejects any payload read; relay imports no game/net package |
| R14-8 | Local rooms regress while adding `/net` | Medium | Breaks the shipped product | Local path is a regression suite (ER-14-13); controller and protocol files are off-limits; `/net` failure falls back to local |
| R14-9 | Keyframe storm after loss amplifies traffic | Medium | Congestion collapse | Keyframes per peer at most once per 2 s unless requested; request rate limited; baseline ring 64; no retransmit |
| R14-10 | Interest set pops at cell boundaries | High if ignored | Visible spawn/despawn flicker | 2 s hysteresis, 2 s retention, 500 ms hide; grid radius; acceptance ER-14-08 counts thrash |
| R14-11 | Tick cost exceeds budget with 8 peers | Medium | Frame drops, 14 ms budget lost | Preallocated buffers, O(peers × visible) work, benchmarks with ceilings, budget drops; profile with spec 16 before optimising |
| R14-12 | Determinism claims overreach | Medium | False confidence, wasted debugging | State hash per build/browser only; wire values are integers; document that cross-browser lockstep is not a goal |
| R14-13 | Two agents implement the relay and the session against different handshakes | Medium | Integration wave fails | `14-net.d.ts` + golden handshake fixtures frozen in T0; conformance suite is the gate |
| R14-14 | Package path mismatch (`packages/net` vs `packages/engine/net`) breaks the build | High until fixed | Gate red, work lost | §6 note: integration agent updates 00 catalogue, root workspaces, tsconfig, Vitest and eslint in the same wave; the package name is fixed here |
| R14-15 | Tests pass on loopback but real WAN is unplayable | High | Product promise broken | WAN row is PENDING, never filled from loopback; fixture records RTT/loss; interpolation delay and command redundancy are tuned only against measured WAN data |
| R14-16 | Save/load tries to persist live net sessions | Low | Corrupt saves, deadlocks | §2 non-goal: net state is not persisted; save spec 15 stores world/player only; a loaded game starts a fresh session |
| R14-17 | Relay deployment (TLS, CSP, Origin, region) is treated as "just a server" | Medium | Blocks launch or opens a hole | Production relay is stage 4 with infra owner, P1/P2 rows, CSP and Origin tests; local-first remains the fallback |

### 10.1 Fallbacks, in order

1. Reduce `maxPeers` from 8 to 4 (config, no wire change) if bandwidth or tick cost fails.
2. Reduce `snapshotHz` from 20 to 15 or 10 (config, divisor of 60).
3. Disable prediction (game does not install hooks) — correctness preserved, feel degrades.
4. Disable relay and ship local-first only — the M2 acceptance rows ER-14-15/16 remain PENDING and are not claimed.
5. `NET_PROTOCOL_VERSION` never bumps to "fix" a performance problem; config and interest budgets are the knobs.

---
