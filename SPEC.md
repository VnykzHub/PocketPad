# Spec: Browser Game Platform with Phone Controllers

**Codename:** PocketPad
**Version:** 0.3
**Status:** Ready for Phase 1 (Dev). Phase 2 (Production) is blocked until the Dev Exit Gate passes.
**Target site:** vynkzhub.com

> **Amendment banner (2026-10-22, updated 2026-10-23).** A14–A18 in `docs/todos/README.md` reframe this product as a **browser-native game engine for any display** and record the renderer (custom WebGPU-first, WebGL2 reduced fallback, no Three.js), physics (Rapier behind `Physics3D`), host input (keyboard/mouse and gamepad), engine gating (D0–P6 retired for the engine track) and cross-origin isolation (COOP/COEP). **A19 (2026-10-23) re-decides the renderer only: Babylon.js 9.32.0 is the engine base after the audited bake-off ([ADR-0003](docs/ADR-0003-engine-base.md)); the custom WebGPU/WebGL2 packages remain frozen in the tree, not deleted.** **A20 (2026-10-23) freezes the Wave 0 contracts: `ctx.world` is the game-facing 3D world, the spec-12 streamer moves to `ctx.streaming`, and per-game `assets.json` / manifest `presentation` are additive ([ADR-0004](docs/ADR-0004-ps5-build.md)).** Where this spec says TV-first, phone-only input or Canvas2D-only rendering, the amendments win. The wire protocol, budgets and phone/room contract are unchanged.

---

## 0. How to read this doc

| Part | Sections | Purpose |
|---|---|---|
| Context | 1-3 | What and why |
| Build spec | 4-10 | Architecture, protocol, controller, host runtime, repo |
| Budgets and constraints | 11-13 | Testable requirements |
| Process | 14-16 | Phases, milestones, testing |
| Games | 17 | Game catalog: minimal and full versions, plus what each needs |
| Reasoning | 18-22 | Strengths, caveats, experiments, decision log, unverified claims |

Requirement IDs: FR (functional), NR (non-functional), PR (performance), SR (security), AR (accessibility), TR (test). Every ID should become a ticket and at least one test.

**Status tags:** [VERIFIED] = confirmed against documentation or a measurement. [ASSUMED] = believed true, not yet confirmed. [EXPERIMENT] = must be measured in Phase 1 (see section 20). Nothing in this version is marked VERIFIED yet, because no live documentation has been checked. Section 22 lists what to verify first.

---

## 1. Product vision

Open a website on a TV browser. It becomes a game console. Every phone becomes a full-featured controller: no app install, no cables, no account.

**Differentiators**

1. **Controller platform.** Zero-install phones with multi-touch, gyro, vibration (Android), custom per-game layouts, private screens, text input and drawing.
2. **Lightweight runtime** that boots fast on weak TV browsers.
3. **Open ecosystem.** MIT engine and SDK so others can build games and contribute. The hosted hub (rooms, catalog, brand) is the product.

**Honest note on "not replicable":** all browser code is readable. The moat is the platform, the games, the polish and the community, not secrecy.

---

## 2. Goals and non-goals

### Goals

| ID | Goal |
|---|---|
| G1 | Phone joins as a controller in under 5 s from QR scan |
| G2 | Input-to-canvas latency under 35 ms p95 in production, under 25 ms on LAN in dev |
| G3 | Baseline game bundle under 5 MB gzipped (target 3.5 MB) |
| G4 | 8 simultaneous controllers per room |
| G5 | Multi-touch, gyro, vibration and private screens, with graceful degradation per platform |
| G6 | Primary path works on a TV browser alone, with no PC |
| G7 | Every dependency justified by byte cost and measured TV performance |
| G8 | Game SDK so third parties can ship games |

### Non-goals (v1)

- Matchmaking, accounts, cloud saves
- Video streaming of the game to phones
- Native apps
- WebGPU (TV browsers will not use it)
- iOS haptics (no browser API exists)
- Custom peer-to-peer networking
- A LAN-direct mode that connects an HTTPS page to a local service (blocked by browsers, see section 18)

---

## 3. Glossary

| Term | Meaning |
|---|---|
| Host | Browser page rendering the game (TV or PC) |
| Controller | Phone web page |
| Server | The process that pairs hosts and controllers and relays messages. In dev it is one Node process. In production it is the Relay |
| Relay | Production server, separate from the page host |
| Room | Session with a 4-char code, a PIN, a host and up to 8 controllers |
| Slot | Player position P1 to P8 |
| Layout | JSON description of a controller's on-screen controls |
| Private panel | Per-player screen content sent by the host (secret word, hand of cards, manual page) |
| Edge | A button press that happened since the last host tick |

---

## 4. Architecture

### 4.1 Principle: inputs travel, frames do not

The simulation runs entirely on the host. Phones send controller state (about 26 bytes per packet). The server holds room state and relays messages but never simulates the game.

### 4.2 Two environments

**Dev (Phase 1): one process, one origin, LAN IPs**

```
TV browser     http://192.168.x.x:8080/        (root = host page)
Phone browser  http://192.168.x.x:8080/c/CODE
                   |  same origin, ws://  |
                   +-------> dev-server (Node) <-------+
                             serves static + WebSocket
```

- No domain, no certs, no CORS, no mixed content. Everything works over plain HTTP except gyro (see 4.4).
- Dev server prints its LAN URLs and a QR code in the terminal.

**Production (Phase 2): split by capability**

```
vynkzhub.com (Vercel, static pages)         relay.vynkzhub.com (Node, persistent)
  /            host page (TV)                 WSS room broker + message relay
  /c/CODE      controller page    <--WSS-->   regional deployment near users
  /games/...   game bundles
```

Vercel serves pages but cannot hold WebSocket connections open [ASSUMED, verify], so the relay runs on a separate host (Fly.io, Railway, Cloudflare Durable Objects or similar; chosen in P0 from measurements).

- **FR-4.1** The host page must reach "playable" with no local process and no PC.
- **FR-4.2** Production relay must run in a region near the user base. For India, that means Mumbai or similar. Measure before choosing (E13).
- **FR-4.3** The same host, controller and runtime code runs in both environments. Only the server origin differs, supplied by config, never hard-coded.

### 4.3 Transport

- **FR-4.4** WebSocket is the only transport in v1.
- **FR-4.5** WebRTC data channels are an experiment (E13), not a v1 feature. Even if they work on the phone, TV browsers may restrict them, and there is no proven latency gain through a cloud relay.
- **FR-4.6** Controller and host select the server URL from config. Users never configure transport.

### 4.4 Secure context rules (why gyro needs HTTPS)

- Motion sensor events require a secure context (HTTPS) on Chrome Android and iOS Safari [ASSUMED, verify E7]. `localhost` counts as secure. A LAN IP over HTTP does not.
- **Dev workarounds for sensor testing:**
  1. `cloudflared`/ngrok tunnel to the dev server. It gives an HTTPS URL, and gyro works everywhere including iOS. It adds latency, so use it for sensor tests only.
  2. Android Chrome: `chrome://flags/#unsafely-treat-insecure-origin-as-secure` with the LAN URL allowlisted.
  3. mkcert plus installing its root CA on the phone (fiddly on iOS).
- Production is HTTPS everywhere, so none of this applies.

### 4.5 Component responsibilities

| Component | Owns | Must not own |
|---|---|---|
| Game runtime | Simulation, rendering, input mapping, interpolation | Sockets |
| Net client (host) | Connection, reconnect, clock sync, input buffer | Game logic |
| Server / Relay | Room lifecycle, auth, fan-out, rate limits | Game state |
| Controller app | Input capture, layout rendering, sensors, haptics, reconnect | Game rules |

---

## 5. Pairing and sessions

### 5.1 Join credentials

| Credential | Format | Use |
|---|---|---|
| Room code | 4 chars, Crockford base32 (20 bits) | Identifies the room |
| Room token | 16 random bytes, base64url (22 chars) | In the QR URL fragment. Proves the phone scanned the screen |
| Room PIN | 4 digits, shown on the host | Manual join when scanning is impossible. Always enabled |
| Session token | 16 random bytes, issued per player on join | Reclaiming a specific slot after a drop |

QR URL: `<origin>/c/<code>#<roomToken>`. The token is in the fragment so it never reaches server logs or referrers (**FR-5.1**).

### 5.2 Flow

1. Host calls `POST /api/rooms`. The server returns `{code, pin, roomToken}`.
2. Host shows the QR, the code and the PIN (large, readable from a couch).
3. Phone opens the URL and sends `join` with `{code, token}`, or `{code, pin}` if typed manually.
4. Server validates, assigns the lowest free slot, and replies `joined {slot, session, serverTime}`.
5. Host receives `playerJoined {slot}`.
6. Phone stores `session` (sessionStorage, plus localStorage with expiry for browser restarts) and uses it for all rejoins.

### 5.3 Rules

- **FR-5.2** Rooms expire after 10 min idle or 4 h maximum.
- **FR-5.3** A 9th controller gets `roomFull`.
- **FR-5.4** Rejoin uses the session token and returns the same slot if the reservation (30 s) is live. It never uses the shared room token.
- **FR-5.5** If the reservation expired, the phone joins as a new player or the host decides (game-defined).
- **FR-5.6** Manual join (code + PIN) must work with no camera.

---

## 6. Technology stack

### 6.1 Server (dev and production)

| Layer | Pick | Note |
|---|---|---|
| Runtime | Node.js LTS | Fast to iterate. Revisit Go/Rust only if relay scale demands |
| WebSocket | `ws` | Minimal |
| Static (dev only) | `sirv` | Dev server serves pages |
| QR | `qrcode` | Host page and terminal |

`setNoDelay(true)` on all sockets (**PR-6.1**).

### 6.2 Host runtime

| Layer | Pick | Note |
|---|---|---|
| Loop and state | Own fixed-timestep loop (about 100 lines, section 9.1) | Third-party loop libraries are unverified and not needed |
| 3D | Three.js, WebGL2 path | See E12: compare against a thin custom WebGL2 renderer |
| 2D | Canvas2D first, PixiJS if profiling demands | Many games here are 2D |
| Physics | Custom circle/AABB first. Rapier (WASM) only if a game needs it | Keeps size and memory down |
| Audio | Web Audio API directly | |
| Build | Vite | |

- **NR-6.1** Host JS payload (engine + game), gzipped, at most 5 MB. CI gate. Aspirational: engine core without assets under 400 KB gz, to be validated by E12.
- **NR-6.2** No virtual-DOM framework in the render loop.

### 6.3 Controller app

| Layer | Pick |
|---|---|
| UI | Vanilla TS or Preact (about 4 KB) |
| Rendering | DOM with `transform`/`opacity` only |
| Sensors | `DeviceMotionEvent.rotationRate` (degrees/second) for gyro rate. `deviceorientation` only for absolute tilt |
| Haptics | `navigator.vibrate()` (duration patterns, no amplitude) |

- **NR-6.3** Controller JS at most 60 KB gz (target 40 KB dev, 50 KB prod).

---

## 7. Protocol

**Transport framing**

- WebSocket **text frames** = JSON control messages.
- WebSocket **binary frames** = hot path. First byte is the type. Little-endian.
- **SR-6** Binary frames over 64 bytes and JSON frames over 4 KB are rejected and the socket is closed.

### 7.1 Binary messages

| Dir | Type | Name | Payload |
|---|---|---|---|
| C to S | 0x02 | Input | `u32 tick, u16 buttons, u16 edges, i16 lx, i16 ly, i16 rx, i16 ry, i16 gx, i16 gy, i16 gz, u8 lt, u8 rt, u8 flags` (26 bytes with type) |
| C to S | 0x03 | Ping | `u32 clientTimeMs` |
| S to C | 0x82 | Pong | `u32 clientTimeMs, u32 serverTimeMs` |
| S to C | 0x84 | Haptic | `u8 n, u16[n] durationsMs` (alternating vibrate/pause, n at most 8) |
| H to S | 0xA2 | HapticCmd | `u8 slot, u8 n, u16[n]` |
| S to H | 0xB2 | InputFwd | `u8 slot` + Input body (27 bytes) |

- **FR-7.1** Send Input at 60 Hz while any input is nonzero, 10 Hz keepalive when idle, and immediately on any change.
- **FR-7.2** `buttons` is a level bitfield: 0 A, 1 B, 2 X, 3 Y, 4 L1, 5 R1, 6 L2, 7 R2, 8 DUp, 9 DDown, 10 DLeft, 11 DRight, 12 L3, 13 R3, 14 Start, 15 Select.
- **FR-7.3** `edges` is a press-edge bitfield. A bit is set in the packet sent at the moment of press. Taps shorter than one host tick are recovered from `edges`. Release edges are not sent; a tap shows as `edge set, level clear`.
- **FR-7.4** Analog values are i16 in [-32767, 32767]. Client deadzone 8%, host deadzone configurable.
- **FR-7.5** Gyro values are i16 in degrees/second x 10 (range +/-3276 dps).
- **FR-7.6** `flags`: bit 0 motion active, bit 1 recentered this packet, bits 2-7 reserved.
- **FR-7.7** Touchpad XY maps onto `rx/ry`, sliders onto `lt/rt`. The layout validator rejects layouts that bind two controls to the same channel. Richer input uses the event channel (7.2).

### 7.2 JSON messages

| Dir | `t` | Fields |
|---|---|---|
| C to S | `join` | `v, code, token` or `pin` or `session`; `name?` |
| S to C | `joined` | `slot, session, serverTime, layout?` |
| S to C | `joinError` | `reason`: roomFull, badToken, badPin, expired, rateLimited |
| S to H | `playerJoined / playerLeft / playerSuspended / playerResumed` | `slot` |
| C to S | `suspend` | on page hidden (slot reserved 30 s) |
| C to S | `leave` | explicit leave, frees slot immediately |
| H to S | `hostPause / hostResume` | host tab hidden / visible |
| H to S to C | `setLayout` | `slot` or `all`, `layout` |
| C to S | `layoutAck` | `layoutId` |
| H to S to C | `panel` | `slot`, content for the private panel (text, simple blocks, small images) |
| C to S to H | `event` | `slot, name, data` (text answers, votes, strokes, choices) |
| S to C | `kick` | `reason` |
| S to H | `stats` | per-slot RTT, drops, 1 Hz |

- **FR-7.8** `event` is rate-limited per slot (default 30/s, burst 60) and size-limited (4 KB). Drawing strokes are batched.
- **FR-7.9** Server must never interpret `event` or `panel` bodies.

### 7.3 Clock sync and input timing

- Controller sends Ping every 5 s. Offset is taken from the minimum-RTT sample over a 30 s window.
- **FR-7.10** Input is stamped with `tick` from the synced clock. Games that need fairness (Reaction Duel) compare synced timestamps, not arrival order. Accuracy is an experiment (E9).
- **FR-7.11 Latest state wins.** The host input mapper keeps only the newest level state per slot and applies at most a 1-frame smoothing buffer. A 2-4 frame buffer adds 33-66 ms and breaks G2.
- **FR-7.12 Edges accumulate.** The mapper ORs `edges` from every packet received since the last tick into a per-slot accumulator. `poll()` returns it and clears it. Only level fields are latest-wins.
- **FR-7.13** Report input-to-canvas latency and canvas-to-photon (TV display) lag separately. Display lag is measured but not gated.

### 7.4 Heartbeat and reconnect

- **FR-7.14** Heartbeat every 2 s, dead after 5 s of silence.
- **FR-7.15** Reconnect backoff 250 ms to 4 s cap, rejoin with the session token.
- **FR-7.16** Host drop: room enters `hostLost` for 30 s, controllers show "Waiting for TV". If the host returns with its host token, the room resumes.

### 7.5 Host-side input interface

```ts
interface ControllerState {
  slot: number;
  buttons: number;       // level
  edges: number;         // accumulated press edges since last poll
  lx: number; ly: number; rx: number; ry: number; // -1..1
  gyro: { x: number; y: number; z: number };      // dps
  triggers: { lt: number; rt: number };           // 0..1
  tick: number;
}
```

- **FR-7.17** Game code reads `ControllerState` and events only. It never touches sockets. This makes games testable with recorded input traces.

---

## 8. Controller app

### 8.1 Layout system

Layouts are JSON, sent by the host, rendered by the phone. Games ship layouts and never build phone UI.

```json
{
  "id": "platformer-v1",
  "orientation": "landscape",
  "background": "#101014",
  "controls": [
    { "type": "button", "id": "jump", "label": "Jump", "shape": "circle",
      "x": "82%", "y": "70%", "r": "11%", "bit": 0, "haptic": [12] },
    { "type": "stick", "id": "move", "x": "14%", "y": "72%", "size": "24%",
      "axis": "left", "mode": "floating" },
    { "type": "panel", "id": "secret", "x": "30%", "y": "10%", "w": "40%", "h": "30%" },
    { "type": "text", "id": "answer", "event": "answer", "maxLen": 60 }
  ],
  "sensors": { "gyro": "steer", "sensitivity": 1.4, "smoothing": 0.15 }
}
```

- **FR-8.1** Control types in v1: `button`, `dpad`, `stick`, `trigger`, `touchpad`, `slider`, `gyro`, `choice` (list of options emitting an event), `panel` (private display), `text` (text entry emitting an event), `canvas` (freehand stroke capture emitting batched events).
- **FR-8.2** Layouts hot-swap per slot or for all players with no page reload.
- **FR-8.3** Scripting cost at most 2 ms per frame. `transform` and `opacity` only. Cache rects on resize and orientation change.
- **FR-8.4** Layout validator runs on host and controller, rejects invalid or oversized layouts, and supports `?layout=debug` grid overlay.
- **FR-8.5** Gyro smoothing is configurable per layout (default alpha 0.15). A low-pass adds lag, so steering layouts may set it lower.

### 8.2 Input capture

- `touchstart/move/end/cancel` with `{passive:false}`, `touch-action:none`, `user-select:none`.
- Track by touch `identifier`. **FR-8.6** Support 10 simultaneous touches.
- **FR-8.7** Pressed state renders in the same frame as the touch, never waiting for the network.
- Cached hit-test rects with 8 px slop. **AR-5** Minimum touch target 44x44 CSS px.
- **FR-8.8** On `visibilitychange` hidden: send `suspend`, stop sensors, release wake lock. On visible: rejoin by session token.
- **FR-8.9** `text` and `canvas` controls must handle the on-screen keyboard resizing the viewport without breaking the layout (E16).

### 8.3 Sensors

1. On first tap show "Enable motion". Feature-detect `DeviceMotionEvent.requestPermission`. Only call it if it exists (iOS). Chrome Android has no such function [ASSUMED, verify E7].
2. Listen to `devicemotion`, read `rotationRate` (degrees/second) [EXPERIMENT E7: verify units and axis mapping per browser].
3. Remap axes by `screen.orientation.angle`.
4. Apply one-pole low-pass (configurable).
5. Auto-zero in the first 500 ms. Provide a visible "Recalibrate" button.
6. Emit at 60 Hz as i16 (dps x 10).
7. If motion is unavailable or denied, fall back to the layout's non-gyro controls. Games must always provide a non-gyro fallback (**FR-8.10**).

### 8.4 Haptics

| Platform | Behavior |
|---|---|
| Android Chrome/Firefox | `navigator.vibrate(pattern)` |
| iOS Safari | No vibration API. Visual pulse, optional Web Audio click |
| Desktop | On-screen pulse |

- **FR-8.11** Rate-limit to 20 Hz per slot and coalesce, because `vibrate()` calls cancel each other.
- **FR-8.12** Global haptics toggle (**AR-3**).
- Never design a game that requires haptics to be playable.

### 8.5 UX

- Connection pill: Connecting / Connected (P2) / Reconnecting / Waiting for TV / Disconnected.
- Landscape prompt when required.
- Wake Lock while connected.
- Triple-tap top-left: debug overlay (RTT, jitter, packets/s, drops).

---

## 9. Host runtime

### 9.1 Core loop (units consistent)

```ts
const TICK_HZ = 60;
const DT = 1 / TICK_HZ;       // seconds
let acc = 0, lastMs = 0;

function frame(nowMs: number) {
  acc += (nowMs - lastMs) / 1000;
  lastMs = nowMs;
  if (acc > 5 * DT) acc = 5 * DT;        // death-spiral clamp
  while (acc >= DT) {
    simulate(DT, inputMapper.pollAll());
    acc -= DT;
  }
  render(acc / DT);                      // interpolation alpha
  requestAnimationFrame(frame);
}
```

- **FR-9.1** Fixed timestep, variable render, interpolation.
- **FR-9.2** On host tab hidden: pause the sim and send `hostPause`.

### 9.2 Rendering

- **FR-9.3** WebGL2 only in v1. Fail with a friendly screen otherwise.
- **FR-9.4** TV profile: DPR 1, render at 1080p or lower, CSS upscale.
- **FR-9.5** Dynamic resolution: if frame time exceeds 20 ms for 30 consecutive frames, drop render scale 10% (floor 60%), recover slowly.

### 9.3 Assets

| Asset | Format |
|---|---|
| Textures | KTX2 (Basis) where TV supports it, else small WebP/PNG atlases. Verify in E1 |
| Models | glTF with Meshopt or Draco |
| Sprites | One WebP atlas per scene |
| Audio | WebM/Opus with AAC fallback. Stream music, preload SFX |
| Fonts | Subset WOFF2, bitmap font for HUD numbers |

- **FR-9.6** Initial download at most 5 MB, lazy-load the rest per scene.
- **FR-9.7** Real progress bar tied to fetched bytes.

### 9.4 World streaming (for open-world games)

- **FR-9.8** Chunked streaming with configurable load and unload radius.
- **FR-9.9** At least 3 LOD tiers per streamed object, with no per-frame GPU buffer allocation.
- **FR-9.10** Streaming work never blocks the main thread more than 8 ms. Decode in a worker where possible.

### 9.5 Optimization rules

| ID | Rule |
|---|---|
| PR-9.1 | At most 120 draw calls per frame |
| PR-9.2 | GPU texture memory budget set from E2 (provisional 128 MB) |
| PR-9.3 | Zero allocations in the hot loop |
| PR-9.4 | Pool all spawned entities |
| PR-9.5 | No `map/filter` in per-frame paths |
| PR-9.6 | Instance repeated meshes (more than 10 copies) |
| PR-9.7 | Frustum culling always on |
| PR-9.8 | HUD text drawn to a cached offscreen canvas |

### 9.6 TV and lobby UX

- **AR-4** Everything on the host is operable with TV remote arrow keys and Enter.
- **FR-9.11** Audio needs a user gesture. The host opens on a "Press Enter to start" screen, which also unlocks audio.
- **FR-9.12** In dev, the TV opens `http://<ip>:8080/`, where the root is the host page. In production, provide a short URL (for example `vynkzhub.com/tv`), because typing on a remote is painful.
- **FR-9.13** Game picker: any player can browse and vote from their phone. The host shows the picked game.

---

## 10. Repo layout

```
vynkzhub/
|- packages/
|  |- protocol/       # types + binary codecs, zero deps
|  |- dev-server/     # Phase 1: static + WS broker, one process
|  |- relay/          # Phase 2: production broker
|  |- runtime/        # loop, renderer, input mapper, loader, streaming
|  |- controller/     # phone app
|  `- games/          # one folder per game + manifest
|- experiments/       # standalone probe pages e01..e17 (section 20), served by dev-server at /x/<id>
|- sdk/               # game.manifest.json schema, layout validator, sample game, docs
|- tools/
|  |- latency-harness/
|  |- input-bot/      # N fake controllers with scripted macros
|  `- size-budget/    # CI gate
`- docs/SPEC.md
```

- **FR-10.1** `protocol` has zero dependencies and runs in Node, browsers and Deno.
- **FR-10.2** `runtime` must not import from `controller` (ESLint rule).
- **FR-10.3** Game manifest: `name, entry, layouts, assetBudget, minPlayers, maxPlayers, needsGyro, chunkConfig?`.
- **FR-10.4** Licensing: engine, protocol, controller and SDK are MIT. Games carry their authors' licenses. The "vynkzhub" brand and hosted hub are not covered by MIT. Document the boundary in the SDK.

---

## 11. Performance budgets

| Metric | Dev target | Prod target | Hard fail |
|---|---|---|---|
| Controller JS (gz) | 40 KB | 50 KB | 60 KB |
| Controller TTI | 1 s (LAN) | 1.5 s (4G) | 3 s |
| Host runtime + demo (gz) | 3 MB | 3.5 MB | 5 MB |
| Input to canvas p50 | 15 ms | 20 ms | n/a |
| Input to canvas p95 | 25 ms | 35 ms | 50 ms |
| Display lag (canvas to photon) | measure | measure | not gated |
| WS RTT p95 | 8 ms | 25 ms (same region) | 50 ms |
| Host frame time p95 | 14 ms | 14 ms | 20 ms |
| Reconnect after Wi-Fi blip | 1 s | 1 s | 3 s |
| Room setup to playable | 5 s | 5 s | 10 s |
| Host memory (TV) | set from E2 | set from E2 | set from E2 |

- **PR-11.1** The latency harness measures tap to host-canvas flash. The controller flashes on touch, the host flashes on receipt, and a 240 fps camera or photodiode records both. The input-bot automates regression runs.
- **PR-11.2** No memory hard-fail is set until the TV memory probe (E2) has run on real target TVs.

---

## 12. Device matrix

| Platform | Renderer | Gyro | Vibration | Notes |
|---|---|---|---|---|
| Chrome desktop | WebGL2 | n/a | n/a | Dev target |
| Chrome Android | n/a (controller) | Yes, HTTPS | Yes | Primary controller |
| Safari iOS 17+ | n/a (controller) | HTTPS + gesture | No | "Enable motion" button |
| Android TV (Chromium) | WebGL2 | n/a | n/a | Test a 2020-era device |
| Tizen | WebGL2 | n/a | n/a | Chromium version varies by year |
| webOS | WebGL2 | n/a | n/a | Weak GPU, test dynamic resolution |
| Firefox | WebGL2 | HTTPS | Yes | Verify binary WS |

- **FR-12.1** Feature-detect everything. No UA sniffing for capability.
- **FR-12.2** `?debug=1` host overlay: backend, FPS, frame ms p50/p95, sim ticks, draw calls, texture MB, per-slot RTT/jitter/last-input-age/packets-per-s/drops.

---

## 13. Security and privacy

| ID | Requirement |
|---|---|
| SR-1 | Tokens at least 128-bit random, constant-time compare |
| SR-2 | Room token in URL fragment only |
| SR-3 | Dev server binds to LAN with a visible warning. Never run dev-server on a public network |
| SR-4 | PIN always required for manual join; optional "PIN required for QR too" mode |
| SR-5 | Join rate limit: 5 attempts/min/IP, then lockout. 20-bit codes are guessable, so the token or PIN is the real secret |
| SR-6 | Max 8 controllers/room, frame size caps (7.x) |
| SR-7 | No PII, no analytics |
| SR-8 | CSP on both apps. Production: `default-src 'self'; connect-src 'self' wss://relay.vynkzhub.com; script-src 'self'` (relay origin must be listed, since pages and relay are different origins) |
| SR-9 | Log room create/join/leave, never tokens |
| SR-10 | Persistent "Anyone with this code can join" notice on the host |
| SR-11 | Validate WebSocket `Origin` against an allowlist (vynkzhub.com in production, configured LAN origin in dev) |
| SR-12 | Relay never persists message bodies |
| SR-13 | User-generated content (drawings, typed text) is shown on the TV only to the room, never stored. Provide a profanity filter hook for family-friendly mode |

---

## 14. Phases

### Phase 1: Dev (all concepts proven on LAN, no production infra)

Rule: no domain, no Vercel, no cloud relay, no accounts until the Dev Exit Gate passes.

| Stage | Deliverable | Exit criteria |
|---|---|---|
| D0 | Repo, `protocol`, `dev-server`, `size-budget`, `input-bot` skeleton | Two clients join a room and echo input. CI size gate is live |
| D1 | TV and device probes (E1, E2, E3) | Findings recorded for your actual TV(s): WebGL2, memory ceiling, frame budget, WS support |
| D2 | Controller v0 (buttons, sticks, multi-touch, edges) | Same-frame pressed state. Edges survive sub-tick taps |
| D3 | Runtime v0: loop, renderer, input mapper | Cube moves from a phone on the actual TV. Latency harness (E5) baseline recorded |
| D4 | Pairing: QR, code, PIN, sessions, reconnect, suspend | G1 met (scan to playable under 5 s). 8 input-bot clients stable |
| D5 | Layout system: hot swap, `panel`, `text`, `choice`, `canvas`, event channel | Private panels and text/draw round-trip. Stroke test (E10) passes |
| D6 | Sensors and haptics through a tunnel (E7, E8) | Gyro on Android + iOS (gesture flow). Android vibration. Swing detection feasibility known |
| D7 | Proof games: Reaction Duel, Sumo Bumpers, Draw and Guess, Tilt Maze Race (section 17) | Each reaches Minimal. Soak test (E17) passes |
| **Gate** | **Dev Exit Review** | All Phase 1 experiments recorded. Budgets in section 11 set from measurements. Written go/no-go and infra choice for P0 |

### Phase 2: Production (only after the Gate)

| Stage | Deliverable |
|---|---|
| P0 | Infra decision from E13 data: relay host and region, Vercel pages, domain and DNS |
| P1 | Relay deployed (single instance per region first, see room-affinity caveat in section 19), HTTPS/WSS, origin allowlist, CSP |
| P2 | Pages on Vercel, short TV URL, production config |
| P3 | Hardening: rate limits, PIN modes, abuse handling, content-filter hook, privacy-safe logging |
| P4 | SDK, docs, sample game, open-sourcing, contribution guide |
| P5 | Beta on real TVs and a spread of phones. All section 11 production gates pass |
| P6 | Remaining games and the hub (picker, catalog) |

---

## 15. Milestone summary

D0 to D7 and the Gate (Phase 1), then P0 to P6 (Phase 2), as above.

---

## 16. Testing strategy

| Layer | Approach |
|---|---|
| Protocol codec | Property-based round trip (fast-check) |
| Input mapper | Golden trace tests, including edge accumulation across multiple packets per tick |
| Latest-state policy | Simulated delay/jitter/loss. Assert no stale-state replay and no lost edges |
| Latency | Harness per release candidate (PR-11.1) |
| Multi-controller | input-bot: 8 headless clients with scripted macros |
| Soak | 4 h, 8 bots, 30 ms injected jitter, memory growth under 10% |
| Device matrix | Manual checklist per section 12 each stage |
| Size | CI fails on budget breach |
| Reconnect | Kill Wi-Fi, background the phone, sleep the TV, assert slot recovery |

**TR-1** Every requirement ID has at least one tagged test.

---

## 17. Game catalog

### 17.1 Capability tags

| Tag | Capability | Built in stage |
|---|---|---|
| C1 | Buttons, stick, multi-touch | D2 |
| C2 | Edge latch, synced timestamps | D2-D3 |
| C3 | Private panel | D5 |
| C4 | Text entry and choice list | D5 |
| C5 | Canvas stroke streaming | D5 |
| C6 | Gyro | D6 |
| C7 | Haptics (Android) | D6 |
| C8 | Host audio and sync | D3, E11 |
| C9 | Simple physics (circles/AABB) | D3 |
| C10 | 3D rendering, LOD, streaming | D3, later |

### 17.2 Proof set (build first)

#### Reaction Duel
- **Needs:** C1, C2. Easiest game, and the best test of rooms, timing and scoring.
- **Minimal:** TV shows "wait", then a signal after a random 2-6 s delay. First valid tap wins the round. Tapping early is a false start and loses the round. Best of 5, scoreboard, 2-8 players.
- **Full:** Several modes (colour match, count the taps, memory sequence), phone buzz at the signal (Android), sound, animated scoreboard, tournament bracket, latency-fair adjudication using synced timestamps, spectator view, themes.
- **Watch out:** Fairness depends on clock-sync accuracy (E9). Tied or near-tied taps need a documented rule.

#### Sumo Bumpers
- **Needs:** C1, C9. Joystick plus dash button.
- **Minimal:** Top-down arena, each player a circle with joystick movement, collisions push others, the arena shrinks, last one standing wins the round. 2-8 players, round scoring.
- **Full:** Dash and charge mechanics, power-ups, several arenas with hazards, hit-stop and screen shake, Android haptics on hit, sounds, bot fill-ins, 3D low-poly stage, skins, results screen.
- **Watch out:** Collision feel (mass, friction) takes tuning. Keep physics custom and small.

#### Draw and Guess
- **Needs:** C3, C4, C5.
- **Minimal:** Rotating drawer gets the secret word on a panel and draws on a canvas control. Strokes appear live on the TV. Others type guesses. First correct guess scores. Fixed word list, 3 rounds.
- **Full:** Colours, brush sizes, undo, hints that reveal letters, word packs and categories, scoring by speed, avatars, round gallery, family-friendly filter, replay.
- **Watch out:** Stroke bandwidth (E10), keyboard resizing the viewport (E16), content moderation (SR-13).

#### Tilt Maze Race
- **Needs:** C6, C1 (fallback), C9.
- **Minimal:** Shared maze, each player's ball driven by tilt, walls collide, first to the exit wins. Joystick fallback when gyro is unavailable. Recalibrate button.
- **Full:** Procedural mazes, traps and moving walls, power-ups, 3D ball physics, haptic wall hits, ghost trails, race and survival modes, minimap, difficulty levels.
- **Watch out:** Gyro needs HTTPS and a calibration flow. Tilt control from `rotationRate` must be integrated into an angle, and drift needs handling (E7).

### 17.3 Next tier

#### Steering Wheel Racer
- **Needs:** C1, C6, C9, C7.
- **Minimal:** Top-down track, one shared camera that fits all cars (Micro Machines style), phone steers by gyro (or buttons), tap to accelerate and brake, simple car physics, 3 laps, 2-8 players.
- **Full:** 3D low-poly tracks, drift model, items, AI bots, ghosts, several tracks, engine audio, curb rumble, leaderboards.
- **Watch out:** One screen for 8 cars forces camera design. Steering must work without gyro.

#### Tank Arena
- **Needs:** C1, C9.
- **Minimal:** Left stick drives, right stick aims, auto-fire on aim, pooled bullets, static walls, HP, respawn, free-for-all.
- **Full:** Destructible walls, bouncing shots, power-ups, team modes, many maps, recoil haptics, camera shake.

#### Snake Royale
- **Needs:** C1.
- **Minimal:** Grid snake, d-pad or swipe, food, last snake alive wins, shrinking arena.
- **Full:** Power-ups, smooth interpolated movement, shrink zones, themes, bots.

#### Bluff Quiz
- **Needs:** C3, C4.
- **Minimal:** JSON question bank. Each phone gets a question and types a fake answer, then votes on the list (real answer mixed in). Scoring for fooling players and finding the truth.
- **Full:** Categories and packs, timers, image and audio rounds, duplicate-answer handling, host narration, content filter, pack editor.

#### Spy in the Room
- **Needs:** C3, C4. Almost no realtime load, so it is cheap to ship.
- **Minimal:** Each phone shows a secret word, one player gets a different word. Timed discussion on the TV, vote with `choice`, reveal.
- **Full:** Word packs, role variants, spy last-guess, animated reveals, scoring across rounds.

### 17.4 Ambitious tier

#### Sword Swing Duel
- **Needs:** C6, C7, C9.
- **Minimal:** Two players, side-view 2D. Swing detection from `rotationRate` magnitude classifies left, right and overhead. Hold a button to block. Buttons fallback for every move.
- **Full:** 3D animated fighters, parry timing windows, stances, haptics, sound, tutorial and calibration, ranked best-of.
- **Watch out:** Swing classification reliability and latency. Do a feasibility test in D6 before committing.

#### Bomb Defusal
- **Needs:** C3, C4, per-slot layouts, procedural content.
- **Minimal:** The TV shows a ticking bomb. One phone is the defuser (three module types: wires, button, keypad). Other phones show manual pages on private panels. Procedurally generated rules. Win by defusing before time runs out.
- **Full:** 8+ modules, difficulty levels, rotating roles, tension audio, ticking haptics, a proper manual generator, campaign.
- **Watch out:** Rule generation must be solvable and fair. Manual content must stay readable on small screens.

#### Heist Planner
- **Needs:** C1, C3, live host-to-phone data.
- **Minimal:** One runner moves on a 2D grid map on the TV. Other phones show patrol timing diagrams on private panels. One level, reach the vault.
- **Full:** Multiple levels, roles and gadgets, a level editor, replays.
- **Watch out:** Highest design and content cost in the catalog. Needs a rate-limited host-to-phone state feed.

#### Beat Tap
- **Needs:** C1, C8, audio sync.
- **Minimal:** 4 lanes, one chart (JSON) with CC0 or self-composed music, timing windows, combo score.
- **Full:** Several songs, difficulty levels, chart editor, calibration wizard (tap to a beat), per-hit haptics, results.
- **Watch out:** TV audio latency can be large and varies, especially with Bluetooth speakers (E11). A calibration step is required. Do not use copyrighted songs.

#### Open-World Showcase (engine stress test)
- **Needs:** C1, C9, C10.
- **Minimal:** About 1 km2 of low-poly terrain with chunk streaming, three LOD tiers, 2 players walking or driving, day-night with baked lighting, fixed 30 fps target on the TV.
- **Full:** Traffic and pedestrians, missions, more players, destructible props, a proper art style, audio, a map. Only attempt this after E3 and E12 results justify it.

### 17.5 Hub (not a game, but required)

- **Minimal:** TV menu with remote navigation, P1 phone picks a game, lobby shows joined players.
- **Full:** Phone-side voting, per-game settings, catalog with thumbnails, recent games, profanity filter toggle, accessibility toggles.

### 17.6 Suggested order

1. Reaction Duel (proves rooms, timing, scoring)
2. Sumo Bumpers (proves sticks, physics, 8 players)
3. Draw and Guess (proves panels, text, canvas)
4. Tilt Maze Race (proves gyro)
5. Spy in the Room and Bluff Quiz (cheap content games)
6. Tank Arena, Snake Royale, Steering Wheel Racer
7. Sword Swing Duel, Bomb Defusal, Beat Tap
8. Heist Planner, Open-World Showcase

---

## 18. Reasoning behind the key decisions

**Why a server is mandatory.** A browser cannot listen on a socket, so two browsers can never connect directly without a third party. WebRTC still needs signaling. Hence a server, always.

**Why dev is one origin on plain HTTP.** It removes domains, certs, CORS and mixed content from the learning loop. Almost everything except gyro works on a LAN IP. Gyro is tested through a tunnel.

**Why the old "LAN service upgrade" was removed.** An HTTPS page cannot open `ws://192.168.x.x` because browsers block mixed content and restrict access to private networks. Offering both a LAN mode and a hosted site would need a second, separate page origin. It is not worth it in v1. PC plus HDMI against the hosted site is the fallback instead.

**Why Vercel plus a separate relay.** Vercel is excellent for static pages but its functions are short-lived, so WebSocket connections cannot stay open [ASSUMED]. The relay needs a long-running process.

**Why WebSocket and not WebRTC.** Simplicity, universal support, and TV browsers may block WebRTC. A cloud relay needs signaling anyway, so the gain is uncertain until E13.

**Why latest-state wins with edge accumulation.** Controller input is mostly a stream of the current state, so old packets are worthless. But presses are events that can be lost if two packets land in one tick. Splitting level (latest) from edges (OR-accumulate) keeps both latency and correctness.

**Why a per-player session token.** The QR token is shared by everyone, so it cannot say which player is reconnecting.

**Why gyro uses `rotationRate`.** `deviceorientation` gives angles, not rates. Rates are what you stream for steering and swing detection. Angles can be integrated from rates, with drift correction.

**Why own loop and custom physics first.** Smaller, easier to understand, and no unverified dependencies. Add Rapier or PixiJS only when a game proves the need.

**Why not WebGPU.** TV browsers will not have it. Three.js already abstracts WebGL2/WebGPU, so maintaining two renderers doubles work for no TV benefit.

**Why Mumbai/regional relay.** Distance sets the latency floor. A relay on another continent can use the whole latency budget by itself.

---

## 19. Strengths and caveats

### Strengths

- Zero install, which removes the biggest barrier for party games.
- Phones are better controllers than most gamepads for custom layouts: multi-touch, gyro, a screen, a keyboard.
- Inputs travel, frames do not, so 8 players are cheap for the server and phones.
- Private screens enable whole game types (hidden roles, secret words) that a single TV cannot.
- Small footprint is a real differentiator on TV browsers.
- MIT SDK plus hosted hub is a sensible open-source business shape.

### Caveats to plan around

| Caveat | Impact | Plan |
|---|---|---|
| TV browsers are old and memory-starved | Everything about performance | E1, E2, E3 first. Set budgets from data |
| TV display lag (50-150 ms outside Game Mode) | Feels laggy through no fault of the app | Measure separately. Tell users to enable Game Mode |
| Wi-Fi quality | Jitter dominates latency | Recommend 5 GHz. Show RTT in debug HUD |
| **AP/client isolation** on many routers, guest networks, hostels and hotels | In dev, phone cannot reach your PC on the LAN | Test early. Disable isolation or use a tunnel. Production relay avoids this |
| iOS needs HTTPS and a gesture for motion, and has no vibration | Feature parity gap | "Enable motion" button, visual/audio feedback, honest docs |
| Phones sleep, tabs get killed | Dropped players | Wake Lock, suspend/resume, session tokens, 30 s reservation |
| Remote-control text entry on TVs | Bad URL and lobby UX | Short URL, QR, PIN; remote-friendly menus |
| TV audio gesture rule and unknown audio latency | Silent start, rhythm games unusable | Start screen, calibration (E11) |
| Room code is only 20 bits | Guessable | Token or PIN is the real secret. Rate limits |
| Relay horizontal scaling | A room's host and controllers must hit the same instance | One instance per region in v1. Later, route by room (region-prefixed routing, Durable Objects) |
| User-generated content (drawings, text) | Moderation and liability | Filter hook, nothing stored, family mode |
| Music and IP in rhythm and party games | Legal risk | CC0 or self-made assets only |
| Scope creep toward a full engine | Never ships | Rule: runtime = loop + renderer + input + loader + streaming. Add nothing without removing something |
| "Hyper-optimised open world" ambition | Months of work | Treat as a showcase after the proof games, not a v1 blocker |

---

## 20. Experiments (Phase 1)

Each experiment is a standalone page in `experiments/`, served by the dev server. Record results in `docs/RESULTS.md` with device, OS, browser version and numbers.

| ID | Question | Method | Pass criterion | If it fails |
|---|---|---|---|---|
| E1 | What can the TV browser do? | Probe page: WebGL2, max texture size, extensions (KTX2/ASTC/ETC2), Web Audio, WebSocket binary, WebRTC, `requestAnimationFrame` rate, Wake Lock | WebGL2 and binary WS present | Lower the target: Canvas2D-only fallback |
| E2 | How much memory can the page use? | Allocate typed arrays and textures in steps until slowdown or crash | Usable limit recorded, budgets set at 70% of it | Cut texture and chunk budgets |
| E3 | How fast is the TV? | Benchmark scene: 1k, 5k, 10k instances, 1M triangles, one texture atlas | At least 30 fps at 720p with 1k+ instances | Lower complexity target, dynamic res |
| E4 | LAN network quality | Ping/echo over WS between phone and TV via dev server, 2.4 vs 5 GHz, idle vs busy | RTT p95 under 8 ms on 5 GHz | Document Wi-Fi advice; consider wired TV |
| E5 | Real input-to-canvas latency | Latency harness, 240 fps camera, 1000 samples | p95 under 25 ms (LAN) | Profile: touch handling, send rate, render |
| E6 | TV display lag | Photodiode or 240 fps camera on a flash test page, with Game Mode on and off | Number recorded | Show in-app advice |
| E7 | Gyro reality | Log `rotationRate` units, axes and drift on Chrome Android and iOS Safari, secure-context and permission behavior | Stable, remappable rates on both | Buttons fallback, restrict gyro games |
| E8 | Vibration feel | Pattern, coalescing and rate-limit tests on several Android phones | Distinct, non-stuttering patterns at 20 Hz | Lower rate, simplify patterns |
| E9 | Clock-sync fairness | Two phones tap a signal together, compare synced timestamps vs arrival order | Timestamp error under 5 ms | Use arrival order plus a documented tie rule |
| E10 | Stroke streaming | Draw fast on `canvas` control, measure bytes/s and visible delay on the TV | Under 20 KB/s per drawer, delay under 100 ms | Batch and simplify strokes |
| E11 | Audio on TV | Gesture unlock, output latency via tap-to-click test, with speakers vs Bluetooth | Latency measurable and calibratable | Drop rhythm games or require calibration |
| E12 | Three.js vs thin custom renderer | Same scene, compare gz size, frame time and memory on the TV | Decision recorded | Pick the smaller if equal visuals |
| E13 | Production infra | Compare relay options (Fly region, Cloudflare Durable Objects, managed realtime) from your location: RTT, cold start, cost. Also test WebRTC on the TV | Mumbai-class RTT p95 under 25 ms | Pick another region or host |
| E14 | Mixed content | Confirm an HTTPS page cannot open `ws://LAN-IP`, and note private-network restrictions | Confirmed | Revisit LAN design if wrong |
| E15 | Phone lifecycle | Lock screen, switch apps, kill browser: measure time to reconnect and slot recovery | Recovery under 1 s within the 30 s reservation | Tune heartbeat/reservation |
| E16 | Keyboard handling | `text` control with software keyboard on iOS and Android, various layouts | Layout stays usable | Dedicated text screen |
| E17 | Soak | 4 h, 8 bots, 30 ms jitter, Reaction Duel + Sumo on the TV | Memory growth under 10%, no crashes | Find leaks, pool more |

Run E1 to E3 first. Everything downstream depends on them.

---

## 21. Decision log

| Version | Decision | Reason |
|---|---|---|
| 0.1 to 0.2 | Cloud relay promoted to primary, DNS-01 LAN HTTPS removed | Goal is TV-only usage. Certificate approach was not workable |
| 0.1 to 0.2 | Jitter buffer cut from 2-4 frames to 0-1 | Buffer alone broke the latency budget |
| 0.1 to 0.2 | WebGPU removed, gyro moved to `rotationRate`, haptic amplitude removed | TV targets, correct sensor API, Vibration API has no amplitude |
| 0.2 to 0.3 | LAN-direct service removed from v1 | HTTPS page cannot connect to ws:// LAN |
| 0.2 to 0.3 | Per-player session token added | Shared room token cannot identify a returning player |
| 0.2 to 0.3 | Edges OR-accumulate on the host | Prevents lost presses with latest-wins |
| 0.2 to 0.3 | CSP and Origin updated for the Vercel + relay split | `default-src 'self'` would block the relay |
| 0.2 to 0.3 | Manual join (code + PIN) required | Phones that cannot scan the QR |
| 0.2 to 0.3 | `requestPermission` made feature-detected | It does not exist on Chrome Android [ASSUMED] |
| 0.2 to 0.3 | Gyro smoothing configurable per layout | Fixed low-pass hurts steering feel |
| 0.2 to 0.3 | TV audio start screen added | Audio autoplay needs a gesture |
| 0.2 to 0.3 | Messages added: `leave`, `suspend`, `hostPause/Resume`, `event`, `panel` | Gaps found in review and needed by games |
| 0.2 to 0.3 | Two-phase plan (Dev, then Production) | Prove concepts before spending on infra |
| 0.2 to 0.3 | Removed claims that technical points were "verified" and that a third-party loop library was confirmed | Not actually checked |

---

## 22. Unverified claims and open questions

**Check these first (documentation or a quick test):**

1. Motion sensors require a secure context on Chrome Android, and `requestPermission` is iOS-only.
2. `rotationRate` units and axis order on current Chrome Android and iOS Safari.
3. Vercel cannot host long-lived WebSocket servers.
4. A relay host with a Mumbai (or nearby) region, and its real RTT from your users.
5. Vibration API support level on target Android browsers and any rate limits.
6. KTX2/compressed-texture support on your TV browsers (E1).
7. Any WebRTC restrictions on specific TV platforms (E13).
8. Whether any third-party loop/ECS library is worth adopting at all. None is assumed.

**Open questions for you (answer before D2):**

1. Which TV(s), brand and year, will be your real test devices?
2. Is PC plus HDMI an acceptable fallback if the TV browser fails E1 to E3?
3. Should the hub support one global brand domain only, or custom domains for third-party game hosts later?
4. Family-friendly mode default on or off?
5. Do you want a visual layout editor in SDK v1.1, or is JSON plus the debug grid enough?
