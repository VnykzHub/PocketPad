# PocketPad Engine Guide

**Status:** describes the code in this working tree as of 2026-10-22 (Wave 7 + the UI portability fixes).
**Authority:** [`SPEC.md`](../SPEC.md) is the contract; this guide explains the implementation. Where the two differ, the spec wins until an amendment is recorded in [`docs/todos/README.md`](todos/README.md).

---

## 1. What the engine is

PocketPad is not a general-purpose game engine. It is a **TV-first, host-authoritative, fixed-timestep engine** for games that render on one big screen and take input from phones on the same LAN.

Three roles:

| Role | Runs on | Owns |
| --- | --- | --- |
| **Host runtime** | TV / laptop browser | Simulation, rendering, audio, assets, game lifecycle, platform UI |
| **Controller** | Each phone browser | Touch controls, input state, send loop, clock sync, haptics, sensors |
| **Broker + dev server** | One Node process | Rooms, sessions, slots, relay, static serving, security headers |

The host simulates. Phones never simulate, never see the game, and never receive game state beyond the layout and their private panel. A phone sends a 26-byte input frame; the host maps it and feeds the game.

```
┌─────────────────────┐   Input 26 B (binary)   ┌──────────────────────────┐
│ Phone controller    │ ──────────────────────▶ │ Broker                   │
│ touch → InputStore  │                         │ rooms · sessions · slots │
│ SendLoop · ClockSync│ ◀────────────────────── │ setLayout · panel · stats│
└─────────────────────┘   JSON control frames   └────────────┬─────────────┘
                                                              │ InputFwd 27 B
                                                              ▼
                                                   ┌──────────────────────────┐
                                                   │ Host runtime             │
                                                   │ InputMapper → GameHost   │
                                                   │ FixedLoop 60 Hz → game   │
                                                   │ Renderer → canvas        │
                                                   └──────────────────────────┘
```

**Design invariants**

1. **Host-authoritative.** Only the host runs `simulate` and owns game state.
2. **Fixed timestep.** Simulation is 60 Hz; rendering interpolates. No wall-clock time inside a game.
3. **Phones send input only.** Controls never touch a socket directly; the client owns the transport.
4. **Binary input, JSON control.** Input is a fixed 26-byte frame; everything else is a validated JSON union.
5. **Pooled hot paths.** Snapshots and collision objects are reused; games are told to copy anything they retain.
6. **Frozen contracts change additively.** Protocol, `ControllerState`, layout schema and `GameContext` are frozen.
7. **No game-specific code in the platform.** A game that needs a platform feature goes back to the owning stage.

---

## 2. Host runtime

### 2.1 Boot sequence

1. `packages/runtime/index.html` mounts the host shell (`#app`, top bar, room section, `#game-root`, roster).
2. `src/main.ts` resolves the TV profile, chooses the renderer, and creates or resumes the room.
3. The shell joins the broker as host, then either shows the launcher (`/`) or loads a game (`/games/<slug>/`).
4. `openGame()` validates the manifest, registers its layouts, creates a `GameHost`, loads assets, and either shows the start screen or auto-starts after a launcher gesture.
5. `GameHost.start()` calls `game.init(ctx)` once, then starts the fixed loop.

**Renderer selection.** `initRenderer(canvas, preferred)` tries WebGL2 first, then Canvas2D, and rejects only when both fail. The host currently forces **Canvas2D for bundled games** because the 2D game API is implemented there; the cube demo still uses WebGL2. A fallback returns a `RendererFallbackNotice` (title, message, hints) instead of throwing.

**Failure handling.** A manifest/load error, a `game.init` throw, or a `simulate`/`render` throw stops the loop, records the error, and routes it to the host notice panel. `dispose()` is idempotent and calls `game.dispose()` exactly once.

### 2.2 Fixed loop

Source: `packages/runtime/src/loop/FixedLoop.ts`.

| Constant | Value | Meaning |
| --- | --- | --- |
| `TICK_HZ` | `60` | Simulation ticks per second |
| `DT` | `1/60` s | Fixed simulation step |
| `MAX_CATCH_UP_STEPS` | `5` | At most five simulation steps per animation frame |
| `MAX_ACCUMULATED_SECONDS` | `5 × DT` = 83.3 ms | Accumulator clamp; the death-spiral guard |

Per animation frame:

1. Accumulate `deltaMs / 1000` only while running and `delta > 0`; clamp the accumulator to 83.3 ms.
2. While `accumulator >= DT`: run `simulate(DT, mapper.pollAll(tick))`, decrement the accumulator, increment the tick.
3. `alpha = paused ? 0 : accumulator / DT`, always in `[0, 1)`.
4. Call `render(alpha)` exactly once.
5. Schedule the next `requestAnimationFrame`.

`pause()` renders one frame at alpha 0 and stops accumulating. `resume()` re-baselines the clock, so paused wall time is never simulated. `stop()` cancels the pending frame. The loop reads no DOM, socket or wall clock directly; `now`, `raf`, `cancel` and `mapper` are injected.

### 2.3 Game lifecycle

Source: `packages/runtime/src/game/GameHost.ts`.

Phases: `idle → starting → playing → paused → failed → disposed`.

`start()` is only valid from `idle`. It awaits `game.init(ctx)`, then enters `playing` and starts the loop. A second call is a no-op.

**Tick order** (this order is part of the contract):

1. `updateTilt(dt, snapshot)` — integrate gyro rates into pooled `tilt.angleX/angleY` (±30° clamp).
2. `input.update(snapshot)` — publish the snapshot to the game-facing reader and run the tick hook (the event router dispatches named handlers here).
3. `events.drain()` — copy queued events into the fixed-capacity ring.
4. `game.onEvent(slot, name, data)` for each event.
5. `game.simulate(dt, snapshot)`.
6. On the render frame: `game.render(alpha)`.

Pause comes from `hostPause`, a hidden tab, a lost network, an open leave-confirm, or a visible results overlay. Resume reverses it. `pushEvent()` queues for the next tick; it never runs a handler inline.

### 2.4 `GameContext`

Source: `sdk/src/game-api.ts`; runtime assembly in `packages/runtime/src/game/GameContext.ts`.

| Member | Type | What a game gets |
| --- | --- | --- |
| `manifest` | `GameManifest` | The validated manifest |
| `input` | `GameInputReader` | `snapshot`, `poll()`, `player(slot)`, `events()`; the host polls, the game reads |
| `renderer` | `GameRenderer3D` | `backend`, `beginFrame/endFrame`, `drawCalls`, `textureMemoryMB`, `setCamera`, `drawCube` |
| `audio` | `GameAudio` | `playSfx/playMusic/stopMusic`, `now()`, `unlocked`, `latencyHint` |
| `rng` | `GameRng` | Seeded mulberry32: `seed`, `next()` in [0,1), `int()` inclusive |
| `debug` | `GameDebug` | `enabled`, `setCounter` |
| `panels` | `GamePanels` | `set/show/clear` a private slot panel |
| `layouts` | `GameLayouts` | `set(target, layout)`, `clear` for one slot or `"all"` |
| `haptics` | `GameHaptics` | `pulse(target, 1..8 durations)` |
| `events` | `GameEvents` | `on(name, fn)`, `onAny(fn)`; both return an unsubscribe |
| `serverNow()` | `number \| null` | Estimated server clock; `null` before the host joins |

The context object is frozen. The default RNG seed is `1`, so a trace replays deterministically unless the game changes the seed. Unavailable host capabilities throw `CapabilityUnavailableError` rather than silently doing nothing.

### 2.5 Input pipeline

```
phone Input (26 B)
  → broker InputFwd (27 B, slot added)
  → InputMapper.apply(slot, input)
      levels are latest-wins; edges are OR-accumulated
  → InputMapper.pollAll(tick)   // once per fixed tick, clears edges
  → GameControllerState per slot
  → GameContext.input.snapshot
```

`ControllerState` / `GameControllerState`:

| Field | Unit / meaning |
| --- | --- |
| `slot` | 1..8 |
| `connected` | Set by the first accepted packet, including a tick-0 all-zero packet; cleared by `reset(slot)`. Never derived from `tick` or button values |
| `buttons` | u16 level bitfield, bits 0..15 |
| `edges` | u16 press edges accumulated since the last poll; each press is seen once |
| `lx`, `ly`, `rx`, `ry` | Sticks, −1..1 |
| `triggers.lt`, `triggers.rt` | 0..1 |
| `gyro.{x,y,z}` | Degrees per second (wire is i16 ×10) |
| `gyroActive` | Motion is active (flags bit 0) |
| `gyroRecentered` | A recenter happened in this packet (flags bit 1; level until the next packet) |
| `tilt` | Host-integrated `angleX/angleY` in degrees, ±30°, plus `available` |
| `tick` | Controller's estimate of server time in ms, u32; not a frame counter |

**Edges are per tick.** `pollAll()` clears edges after publishing, so a tap shorter than a frame still survives to the next simulation tick. Games must read jump-style actions from `edges`, not from `buttons`.

**Deadzone.** The controller applies an 8% radial deadzone before encoding; the host can add a poll-time deadzone. A stick output is clamped to the unit circle and rescaled to span 0..1 from the deadzone edge.

### 2.6 Rendering

Source: `packages/runtime/src/render/`.

Interfaces:

- `Renderer`: `backend`, `init(canvas)`, `resize(cssW, cssH, dpr)`, optional `size`, `beginFrame(alpha)`, `endFrame()`, `dispose()`, `drawCalls`, `textureMemoryMB`.
- `Renderer2D`: `clear`, `circle`, `rect`, `text`, `polyline`.
- `Renderer3D`: `setCamera`, `drawCube`.

**Size and design space.** `size` is the **actual CSS pixel size** of the surface, zero before the first resize. Games draw in a fixed **1280×720 design space** and scale/letterbox themselves; the renderer owns the backing store and DPR. This is the contract that fixed the Coin Run / Reaction Duel clipping: a game must never assume its canvas is 1280×720 CSS pixels.

`resize(cssW, cssH, dpr)` sets the backing store to `round(css × dpr)`. `maxRenderHeight` caps the backing-store height only; the CSS size is untouched, so the browser upscales.

**Backends.**

- **WebGL2** — one shader program, one cube mesh, instanced path above 10 instances, sphere-frustum culling, texture memory reported as 0 (no textures yet). Context loss is recovered, not fatal.
- **Canvas2D** — real backend, CSS-pixel coordinates via `setTransform`, draws the cube as a rotated square, implements the flat 2D calls.

**Budgets** (`packages/runtime/src/profile/budgets.ts`): 120 draw calls, 128 MB provisional texture memory, frame p95 14 ms, hard fail 20 ms. These are provisional until hardware measurements replace them.

### 2.7 Physics

Source: `packages/runtime/src/physics/`.

- `Vec2 { x, y }`, `Aabb { x, y, w, h }`, `Arena { minX, maxX, minY, maxY }`.
- `CircleBody`: position, velocity, radius, mass, restitution, friction, active flag, id. `Contact { nx, ny, depth }` is caller-owned.
- **y points down**, units are world units and seconds. `MAX_SPEED = 1000` world units/s.
- `resolveCircleAabb(circle, box, out?)`: static AABB, full positional correction, normal out of the box, velocity reflection by restitution and tangential damping by friction.
- `resolveCircleCircle(a, b, out?)`: normal a→b, correction and impulse split by inverse mass (mass ≤ 0 is static), restitution = max, friction = average, Coulomb-clamped tangent.
- `integrate(body, dt, arena)`: semi-implicit Euler; the caller applies gravity first; speed is clamped before and after; walls reverse the normal velocity.

All three are allocation-free with a caller-owned `Contact`; inactive bodies and non-positive `dt` are no-ops.

### 2.8 Assets, audio, RNG, debug

**Assets** (`assets/AssetLoader.ts`): types `image | audio | json | texture | text`; 5 MB initial-download cap. Progress is bytes fetched over declared bytes; unknown lengths report `determinate: false`. `done` only after every asset decodes. Images use `createImageBitmap`; audio stays a `Blob` for the audio bus; textures stay raw bytes.

**Audio** (`audio/AudioBus.ts`): states `locked | unlocked | unavailable`. No `AudioContext` exists before `unlock()` from a user gesture. One master gain, one music gain, eight pooled SFX voices by default. Fades/stop use `AudioContext.currentTime`; `pause()/resume()` suspend/resume the context; playback while locked is a silent no-op.

**RNG** (`game/GameContext.ts`): mulberry32; deterministic seed (default 1); `next()` uniform [0,1); `int()` inclusive.

**Debug** (`debug/Overlay.ts`): `?debug=1` only; a 120-frame window updated at 4 Hz; allocation-free recording; counters are no-ops when disabled. The host also mounts the raw input table only with `?debug=1`, fixed to the viewport so it stays visible during play.

---

## 3. Room and session layer

Source: `packages/protocol/`, `packages/broker/`, `packages/dev-server/`.

### 3.1 Protocol

`PROTOCOL_VERSION = 1`.

| Limit | Value |
| --- | --- |
| Binary frame | ≤ 64 bytes |
| JSON frame | ≤ 4096 UTF-8 bytes |
| `setLayout` frame | ≤ 16,384 bytes (A13; the only JSON exception) |
| `Input` | 26 bytes |
| `InputFwd` | 27 bytes |
| Haptic pattern | ≤ 8 durations |
| Controllers | 8 |

Binary type bytes: Input `0x02`, Ping `0x03`, Pong `0x82`, Haptic `0x84`, HapticCmd `0xa2`, InputFwd `0xb2`. All little-endian via `DataView`; no Buffer, no Node built-ins.

`Input` body: `u32 tick`, `u16 buttons`, `u16 edges`, `i16 lx, ly, rx, ry, gx, gy, gz`, `u8 lt, rt, flags` (25 bytes of body). `tick` is a client estimate of server time in milliseconds, not a frame number.

JSON messages, discriminated on `t`:

- **Controller → server:** `join`, `suspend`, `leave`, `event`, `layoutAck`.
- **Host → server:** `hostJoin`, `hostPause`, `hostResume`, `setLayout`, `panel`.
- **Server → controller:** `joined`, `hostJoined`, `hostStatus`, `joinError`, `playerJoined/Left/Suspended/Resumed`, `setLayout`, `panel`, `event`, `layoutAck`, `kick`, `stats`.
- **Server → host:** `InputFwd` (binary), `hostJoined`, `stats`, `kick`, and the events above.

A join carries exactly one of `session`, `token`, or `pin`; token + PIN is structurally valid only for QR-PIN mode. Event names match `^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$`.

### 3.2 Broker state

- **Room states:** `active | hostLost | expired`.
- **Credentials:** room code = 4 Crockford-base32 characters; PIN = 4 digits; room/session/host tokens = 16 random bytes → 22 base64url characters. Tokens are compared with `timingSafeEqual` and never logged.
- **Join precedence:** session → room token → code + PIN. The rate-limit check runs before any credential comparison.
- **Slots:** lowest free slot 1..8, including live reservations. A slot is reserved for 30 s after suspend or socket close. Explicit `leave` frees immediately.
- **Room expiry:** 10 minutes idle or 4 hours from creation. Expiry sends `kick{expired}`, closes the socket, deletes the room and clears channel state.
- **Host loss:** a host socket close marks the room `hostLost` for 30 s. Controllers see `hostStatus lost`; input is dropped and counted. If the host does not return, controllers are kicked and the room is deleted.
- **Pause:** `hostPause` makes the room reject input; `hostResume` restores it.

### 3.3 Relay rules

- **Input:** unknown room/slot/reserved slot → dropped. No host, host lost, or host paused → dropped and counted. If the host's buffered amount exceeds 256 KiB, **level-only** packets (`edges == 0`) are dropped; edge packets are never dropped.
- **Events:** per-slot token bucket, 30/s sustained, burst 60. The wire slot must equal the authenticated slot. A failed host send is counted; the socket stays open.
- **Haptics:** 20/s sustained, burst 20. Slot 0 = all connected players.
- **Layout:** `setLayout` is sent to one slot or all slots; a reserved slot's layout is stored and replayed on rejoin.
- **Panel:** sent **only** to the addressed slot's peer. Never to the host, never to another controller. `content: null` clears.
- **Stats:** 1 Hz to the host while attached; RTT from ping/pong, jitter EWMA, packets/s over a 1 s window, drops counter.

### 3.4 Reconnect behaviour

| Side | Backoff | Window | Notes |
| --- | --- | --- | --- |
| Controller | 250 ms → 4 s, ±20% jitter | 7 s silence watchdog | Rejoins with `session`, never the room token |
| Host | 250 ms → 4 s, no jitter | 30 s | Stores only `{code, hostToken}`; `expired`/`badHostToken` are terminal |
| Slot reservation | 30 s | — | Rejoin restores the slot and replays layout/panel |

The controller clears the URL fragment before any network call. A hidden tab suspends; visible resumes with a fresh packet. A kick clears the session and never reconnects.

### 3.5 Routes and security

| Route | Serves |
| --- | --- |
| `GET/HEAD /healthz` | `{ ok, now, rooms }` |
| `POST /api/rooms` | 201 room credentials |
| `/`, `/index.html` | Host SPA |
| `/c`, `/c/<CODE>` | Controller SPA |
| `/games/<slug>/` | Host SPA when a manifest exists; otherwise the game bundle |
| `/x/*` | Experiment pages |
| `/ws` | WebSocket upgrade only |

Every response sets `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and a strict CSP (`default-src 'self'; connect-src 'self' ws:; img-src 'self' data:; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'`). No CORS headers. The WebSocket Origin must match the LAN/localhost allowlist; the dev server alone permits a missing Origin for bots.

Close codes: 1002 protocol, 1008 policy, 1009 oversized.

---

## 4. Phone controller

### 4.1 Touch engine

Source: `packages/controller/src/touch/`.

- Four passive-false touch listeners; no pointer events, no pointer capture.
- Ownership is a `Map<Touch.identifier, TouchBinding>`; the default cap is 10 touches. Over-cap touches are dropped and counted.
- Hit testing is a pure rect scan in viewport CSS pixels; highest `z` wins, ties go to the later entry.
- A control's box is raised to at least 44×44, then given 8 px of slop on every side. Slop only enlarges.
- Coordinates: `clientX/clientY` against cached rects; layout `x/y` are percentages of surface width/height, `size/r` of `min(w,h)`.
- Resize/orientation cancels all touches, marks the layout stale, and rebuilds once via `requestAnimationFrame`. Blur, hidden documents, and hot-swap also cancel all touches.

### 4.2 Input store and send loop

Source: `packages/controller/src/input/`.

- Buttons/edges: u16 bits 0..15. Axes: −1..1 encoded i16 ±32767. Triggers: 0..1 → u8. Gyro: i16. Flags: u8.
- 8% radial deadzone, clamped to the unit circle, rescaled so output spans 0..1 from the deadzone edge.
- A down transition latches an edge; repeat-down does not relatch; release never latches.
- Send cadence: any change sends immediately but never within 4 ms of the previous send. **60 Hz active, 10 Hz idle.** Edges clear only after `send()` returns, so a failed send holds them for the next attempt. A late timer never causes a catch-up burst.
- `tick` is the synced server time; 0 before the first clock sample. Clock sync pings every 5 s, keeps a 30 s window, discards samples above 2× the window minimum RTT, and uses the minimum-RTT sample.

### 4.3 Control types

All renderers emit `.control` and `.control-<type>`, toggle `.is-pressed`, and use the shared class/state helpers.

| Type | Emits | Priority | Visual states | Limits |
| --- | --- | --- | --- | --- |
| `button` | one `buttons` bit, hold level | — | pressed fill/scale, `aria-pressed` | bit 0..15; optional haptic ≤8 steps |
| `dpad` | four `buttons` bits | — | per-zone pressed; 8 sectors, diagonals OR two bits | four distinct bits; centre dead zone 12% radius, min 6 px |
| `stick` | `lx/ly` or `rx/ry`, −1..1 | — | 42% knob, fixed/floating | one finger; deadzone 0..0.5, default 0.08 |
| `trigger` | `lt/rt` 0..1 → u8 | — | fill, value readout, `aria-valuenow` | one finger; absolute position |
| `touchpad` | `rx/ry` absolute | — | crosshair, 18% knob, trail | one finger; 2% centre snap |
| `slider` | `lt/rt` 0..1 | — | 32 px thumb, filled track | one finger; horizontal default |
| `gyro` | `gx/gy/gz` dps×10 + flags bit 0/1 | — | level bubble, permission states | 60 Hz sampling; gesture-gated permission; non-gyro fallback required |
| `choice` | event `{ value }` | high | selected inversion; scroll | 1..12 unique options; 44 px rows |
| `panel` | none (display only) | — | private card, scroll | no state/event |
| `text` | event `{ value }` | high | field, send, counter | `maxLen` 1..200 |
| `canvas` | stroke batch `{points,color,width,phase,count?}` | low | local ink, empty state | 16 ms/8 px sampling, 50 ms flush, 16 pts/batch, 64 pending, 20 KB/s, 4096 hard cap |

Event queue: 30/s, burst 60, 4096-byte frame, 50 pending, 5 s reconnect buffer. High-priority events are never silently dropped; low-priority strokes coalesce.

### 4.4 Controller shell states

`join → connecting → error/lockout → waiting → playing → reconnecting → orientation`.

- The URL fragment is cleared before any network call.
- A landscape layout on a portrait phone shows the rotate screen and does not mount controls.
- Reconnect keeps controls visible and pressable; presses are latched.
- The D0 Test button is debug-only (`?debug=1`); the normal waiting page is a real “Player N, connected” screen.
- The shell owns the status pill, haptics toggle and fullscreen toggle; controls never touch the socket.

---

## 5. SDK and game contract

Source: `sdk/src/`.

### 5.1 Manifest

| Field | Rule |
| --- | --- |
| `name` | 1..64 characters |
| `description` | optional, ≤140 characters; display only |
| `entry` | relative path, no absolute path, no `..` |
| `layouts` | 1..16 relative paths |
| `assetBudget` | positive; `initialBytes ≤ totalBytes` |
| `minPlayers`, `maxPlayers` | 1..8; `min ≤ max` |
| `needsGyro` | boolean |
| `chunkConfig` | optional; positive chunk size, radii ≥0, ≥3 LOD tiers |

### 5.2 Layout

- ≤ 16,384 serialized bytes; `id` 1..64.
- `orientation`: `portrait | landscape | any`; optional `background` `#rgb`/`#rrggbb`.
- 1..24 controls; unique control ids (1..32 characters).
- Positions: percent 0..100 or px 0..4096; `x/y` reference viewport width/height, `size/r` reference `min(w,h)`, `w/h` reference width/height.
- Bits 0..15, unique across controls; dpad's four bits distinct.
- Channels unique across controls: `lx/ly`, `rx/ry`, `lt`, `rt`.
- Gyro requires a non-gyro fallback.
- Event names match `^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$`.
- `choice`: 1..12 unique options; `text.maxLen` 1..200; `canvas.maxStrokePoints` positive; haptic ≤8 integers 0..65535; stick `deadzone` 0..0.5; gyro `sensitivity > 0`, `smoothing` 0..1.

### 5.3 Panel and UGC

- Panel ≤ 3584 bytes; kinds `text | blocks | image`; title ≤80; text ≤1000; ≤20 blocks; ≤12 list items; item/alt ≤120.
- Images: same-origin relative URL or `data:image/(png|jpeg|webp);base64,` ≤2048 characters.
- Player name ≤24 code points; colors `#rgb`/`#rrggbb` only; `sanitizeText` strips C0/C1 except tab/LF/CR; stroke points clamp to 0..1.

### 5.4 Game lifecycle

`GameModule` default export `(manifest) => Game`:

1. `init(ctx)` once.
2. `simulate(dt, snapshot)` at a fixed 1/60 s.
3. `render(alpha)` per display frame.
4. `onEvent(slot, name, data)` before that tick's `simulate`.
5. `dispose()` exactly once.

Snapshots and player objects are pooled; copy anything retained.

### 5.5 Reference games

| Game | Input | Lifecycle | Notes |
| --- | --- | --- | --- |
| **Coin Run** (`packages/games/platformer`) | d-pad bits 10/11 (win over stick), left stick `lx` ±0.25, jump = edge bit 0 | lobby → 3 s countdown → playing → results | 4 slots; first goal ends the round; layouts alternate by slot parity; disconnect idles the body and clears the layout |
| **Reaction Duel** (`packages/games/reaction-duel`) | buttons 0..3 | lobby → countdown → waiting → signal → round result → match result | 2..8 players; earliest synced `tick` wins; pre-signal press is a false start; first to 3; reconnect preserves score |

---

## 6. Extending the engine

### 6.1 Add a game

1. Create `packages/games/<slug>/game.manifest.json` with `name`, `description`, `entry`, `layouts`, `assetBudget`, `minPlayers`, `maxPlayers`, `needsGyro`.
2. Add `src/game.ts` exporting a `Game` as the module default.
3. Add layouts under `layouts/` and keep them within the schema limits.
4. The registry discovers the folder with `import.meta.glob`; no menu list is hard-coded.
5. Add the game's `tsconfig.json` to the root `typecheck:games` script and a Vitest project entry if it has tests.
6. Run `npm run check`; the launcher, route and game typecheck must all see it.

### 6.2 Add a control type

1. Extend the SDK `Control` union and the validator (`sdk/src/layout.ts`, `layout-validate.ts`, schema JSON).
2. Add a renderer under `packages/controller/src/controls/`, register it in `registry.ts`, and give it a stable `.control-<type>` class.
3. Map it in `InputStore` (bit/axis/channel) or the event queue (choice/text/canvas).
4. Add CSS in `styles.css`; no inline visual styles.
5. Add renderer, validator and mapping tests; update the traceability/tag matrix if the requirement is new.

### 6.3 Add a renderer backend

Implement `Renderer` plus `Renderer2D` and/or `Renderer3D`, expose the real CSS `size`, honour `resize(cssW, cssH, dpr)`, and return a `RendererFallbackNotice` path through `initRenderer`. Games draw in the 1280×720 design space; the backend owns backing-store scaling and DPR.

### 6.4 Add an experiment

Create `experiments/eNN/` with `index.html`, `page.js`, optional `page.css`; the dev server serves it at `/x/eNN/`. The dev CSP is `script-src 'self'`, so **inline scripts and inline styles are blocked** — use external files.

### 6.5 Commands

```bash
npm ci
npm run check          # typecheck, lint, tests, build, size, trace D0
npm run typecheck
npm run lint
npm test
npm run build
npm run size
node tools/trace-check/dist/cli.js --stage D7
node packages/dev-server/dist/main.js   # 0.0.0.0:8080
node tools/input-bot/dist/cli.js --server http://<lan-ip>:8080 --code ABCD --pin 1234 --scenario steady --clients 8 --duration 10m
```

---

## 7. Current status and known gaps

**Verified on this tree**

- `npm run check` exit 0: 134 test files / 1,571 tests, typecheck, lint, build, size, D0 trace 0 missing.
- Controller bundle: 40,794 gz / 40,960 dev (166 bytes headroom). Host: 75,752 gz / 3,145,728.
- D7 trace: 0 missing (requires a separate `--stage D7` run; the root `trace` script is pinned to D0).

**Open**

1. **Three proof games are missing** for D7: Sumo Bumpers, Draw and Guess, Tilt Maze Race. Coin Run is an extra game, not one of the four.
2. **No TV/Android hardware evidence.** Every device row in `docs/RESULTS.md` is PENDING. Desktop Chrome 155 is only the provisional target.
3. **The home is a DOM launcher, not an engine-driven scene.** There is no P1-controlled console home yet; a game-engine home is a design change, not a tweak.
4. **The platform results overlay has no producer.** `ResultsOverlay` is built and tested, but both games still draw their own results.
5. **Controller size headroom is 166 gz.** Any controller feature needs a size pass first.
6. **Host reconnect has no jitter** (250 ms → 4 s), while controller reconnect uses ±20%. This is a deliberate-looking asymmetry, not a bug, but it is worth confirming.
7. **The dev server allows a missing Origin** for bots; production must not. It is the only allowlist relaxation in the codebase.
8. **Phase 2 has not started** (relay, static pages, hardening, SDK open-source, beta, games hub).

---

## 8. File map

**Host runtime**

- `packages/runtime/src/loop/FixedLoop.ts` — fixed 60 Hz loop, clamp, alpha, pause.
- `packages/runtime/src/game/GameHost.ts` — lifecycle, tick order, error/pause/dispose.
- `packages/runtime/src/game/GameContext.ts` — context assembly, RNG, capability stubs.
- `packages/runtime/src/game/InputReader.ts` — snapshot reader and event ring.
- `packages/runtime/src/game/loadGame.ts` — manifest validation and entry containment.
- `packages/runtime/src/render/Renderer.ts` — interfaces, selection, fallback, size contract.
- `packages/runtime/src/render/Canvas2DRenderer.ts` — 2D backend.
- `packages/runtime/src/render/WebGL2Renderer.ts` — instanced WebGL2 backend.
- `packages/runtime/src/profile/budgets.ts` — frame/resolution numbers.
- `packages/runtime/src/profile/resolutionController.ts` — dynamic resolution.
- `packages/runtime/src/assets/AssetLoader.ts` — byte-accurate loading.
- `packages/runtime/src/audio/AudioBus.ts` — gesture unlock, voices, fades.
- `packages/runtime/src/physics/collide.ts` — circle/AABB/circle physics.
- `packages/runtime/src/main.ts` — host shell wiring.

**Protocol / broker / server**

- `packages/protocol/src/constants.ts` — version, caps, limits.
- `packages/protocol/src/binary.ts` — 26/27-byte codecs.
- `packages/protocol/src/json.ts` — JSON union and framing.
- `packages/broker/src/registry.ts` — rooms, joins, slots, expiry.
- `packages/broker/src/room/sessions.ts` — reservations and expiry.
- `packages/broker/src/room/host.ts` — host loss and recovery.
- `packages/broker/src/room/{events,layout,haptics,stats}.ts` — relay rules.
- `packages/broker/src/ws-server.ts` — WebSocket protocol and close codes.
- `packages/dev-server/src/main.ts` — routes and LAN URLs.
- `packages/dev-server/src/static.ts` — security headers and CSP.

**Controller**

- `packages/controller/src/touch/touchEngine.ts`, `hitTest.ts` — touch ownership and 44 px floor.
- `packages/controller/src/input/InputStore.ts`, `sendLoop.ts` — state and cadence.
- `packages/controller/src/net/clockSync.ts`, `controllerClient.ts`, `reconnect.ts` — clock and session.
- `packages/controller/src/controls/*` — the 11 renderers.
- `packages/controller/src/controls/strokeBatcher.ts`, `eventSink.ts` — events and strokes.

**SDK / games**

- `sdk/src/game-api.ts` — the frozen game-facing surface.
- `sdk/src/manifest.ts`, `layout.ts`, `layout-validate.ts`, `panel.ts`, `ugc.ts` — schemas and validators.
- `packages/games/platformer/src/*` — Coin Run reference game.
- `packages/games/reaction-duel/src/*` — Reaction Duel reference game.

