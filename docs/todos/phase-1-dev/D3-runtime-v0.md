# D3 — Runtime v0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Steps use checkbox syntax.
>
> **Goal:** A host runtime that boots on the TV, runs a fixed-timestep simulation, renders in WebGL2, consumes phone input through the D2 mapper, and moves a cube. Record the first real input-to-canvas latency baseline (E5).
>
> **Architecture:** `packages/runtime` owns the loop, renderer interface, host net client, input mapper integration, audio unlock, asset loader and debug overlay. Games implement a `Game` interface and never see sockets. Renderer and asset backends are interfaces so E12 can choose Three.js vs custom WebGL2 without touching game code.
>
> **Tech stack:** TypeScript, Vite, Canvas2D + WebGL2, Three.js for the 3D path (pending E12), Web Audio API, `@lanpad/protocol`, `@lanpad/sdk`.
>
> **Spec:** `SPEC.md` §6.2, §7.3, §9.1–§9.7, §11, §14 D3, §16, §20 E5/E6/E11/E12; FR-9.1–9.7, FR-9.11, FR-12.2, PR-9.1–9.8.
>
> **Program position:** Phase 1, after D2. D3's `Game` interface and loop contract are used by every game and the SDK; they must be frozen before D7.

## Global constraints

- Fixed timestep 60 Hz; variable render with interpolation (FR-9.1).
- WebGL2 in v1; a friendly failure screen if unavailable (FR-9.3). If D1 says WebGL2 is absent, use the documented Canvas2D fallback instead.
- TV profile: DPR 1, render at 1080p or lower, CSS upscale (FR-9.4).
- Dynamic resolution: >20 ms for 30 consecutive frames → scale −10%, floor 60%; recover slowly (FR-9.5).
- Initial download ≤ 5 MB; real progress bar tied to bytes (FR-9.6/9.7).
- Audio only after a user gesture; start screen unlocks it (FR-9.11).
- Zero per-frame allocations in the loop and mapper; no `map`/`filter` in hot paths (PR-9.3/9.5).
- Games never import sockets or broker code (FR-7.17).
- No panels/layouts hot-swap (D5), no sensors/haptics (D6), no games beyond the cube demo (D7).

---

## Stage goal and exit criteria

**Exit criteria (§14 D3):**

> Cube moves from a phone on the actual TV. Latency harness (E5) baseline recorded.

Concretely:

- [ ] `npm run dev` on the LAN; the TV opens `/`, presses Enter, sees the start screen, then the cube.
- [ ] A phone joins with D2's controller and the cube moves/rotates from stick/buttons.
- [ ] The host uses `InputMapper.pollAll()` once per tick.
- [ ] `?debug=1` shows backend, FPS, frame p50/p95, sim ticks, draw calls, texture MB, per-slot input age.
- [ ] E5 baseline recorded with p50/p95 and method; E6, E11, E12 recorded or explicitly deferred with a date.
- [ ] E12 renderer decision recorded before any 3D game starts.
- [ ] Runtime + demo gz size recorded and under the §11 hard cap.

**Layer coverage**

| Layer | Work items |
|---|---|
| Host runtime | D3-RT-01..07 |
| SDK | D3-SDK-01 |
| Tools | D3-TOOL-01 |
| Experiments/docs | D3-EXP-01 |
| QA | D3-QA-01 |

**Goals advanced:** G2 (loop, mapper, latency harness), G3 (bundle, dynamic resolution), G6 (TV boot), G8 (game interface).

---

## Contracts frozen in D3

1. **Loop:** `update(nowMs)` accumulates time, clamps at 5 × DT, runs `simulate(DT, snapshot)` zero or more times, then `render(alpha)`; `requestAnimationFrame` drives it.
2. **Game interface:** `init(ctx)`, `simulate(dt, snapshot)`, `render(alpha)`, `dispose()`, optional `onEvent(slot, name, data)`. Games receive no sockets.
3. **Renderer interface:** a game-facing 2D API and a 3D API behind `Renderer2D`/`Renderer3D`; `beginFrame(alpha)`/`endFrame()`; `resize(w,h,dpr)`; `backend`.
4. **Host net client:** `hostJoin`, binary `InputFwd` decode into `InputMapper.apply()`, server-time offset from `hostJoined`; no game logic.
5. **Audio:** `AudioBus.unlock()` from a user gesture; `playSfx`, `playMusic`, `stopMusic`, `now()`; no autoplay.
6. **Loader:** `AssetLoader.load(manifest, onProgress)`; progress is bytes fetched / bytes declared; no fake progress.
7. **Debug overlay:** `?debug=1` fields; controller triple-tap overlay extended in D4.
8. **Frame budget:** 16.7 ms at 60 Hz; 33.3 ms if the TV panel is 30 Hz (E3); dynamic resolution reacts to 20 ms.

---

## Work items

### D3-RT-01 — Fixed-timestep loop with interpolation and death-spiral clamp

| Field | Value |
|---|---|
| Layer | Host runtime |
| Spec | §9.1; FR-9.1, FR-9.2; PR-9.3; §14 D3 |
| Depends on | D2-RT-01 |
| Unblocks | D3-RT-02..04, D7 games, all simulation |
| Deliverables | `packages/runtime/src/loop/FixedLoop.ts`, `src/loop/types.ts`, `test/fixedLoop.test.ts` |

**Freeze this interface**

```ts
export interface LoopHooks {
  simulate(dt: number, snapshot: InputSnapshot): void;
  render(alpha: number): void;
  onFrameStats?(stats: { frameMs: number; simTicks: number; alpha: number }): void;
}

export class FixedLoop {
  constructor(hooks: LoopHooks, deps: { now: () => number; raf: (cb: (t: number) => void) => number; cancel: (id: number) => void; mapper: InputMapper });
  readonly tickHz: number;       // 60
  readonly dt: number;           // 1/60
  start(): void;
  stop(): void;
  pause(): void;                 // stops sim, keeps RAF for the paused screen
  resume(): void;
  readonly simTick: number;
}
```

**Behavior**

- `acc += (nowMs - lastMs)/1000`; clamp `acc` to `5 * dt` (death-spiral clamp).
- `while (acc >= dt) { simulate(dt, mapper.pollAll(simTick)); acc -= dt; simTick++; }`.
- `render(acc / dt)` once per rAF, even when zero sim steps ran.
- `pause()` stops simulation and calls `render` with alpha 0 (or a paused screen); `resume()` resets `lastMs` so the pause duration is not simulated.
- No allocation per frame: hooks are stable; `pollAll` reuses its snapshot; the loop reuses its stats object.
- `onFrameStats` reports frame time and tick count (used by the overlay).
- The loop never reads sockets, DOM events, or game state directly.

**Steps**

- [ ] Implement `FixedLoop` with injectable `now`/`raf`/`cancel` for tests.
- [ ] Implement the accumulator clamp and verify a 2 s stall produces at most 5 sim steps, not 120.
- [ ] Verify interpolation alpha is in `[0,1)` and `render` runs exactly once per rAF.
- [ ] Verify `pollAll` is called exactly once per sim tick, never per render.
- [ ] Implement pause/resume without a time jump.
- [ ] Add a no-allocation test with a stable snapshot identity across frames (PR-9.3).
- [ ] Add a test that a hidden document does not advance simulation (the host page calls `pause()` on `visibilitychange`; the loop itself does not read DOM).

**Acceptance**

- [ ] At a simulated 60 Hz, one rAF at 16.7 ms runs exactly one sim tick.
- [ ] At a simulated 50 ms frame, at most 5 sim ticks run; the accumulator does not grow unbounded.
- [ ] Pause/resume does not fast-forward.
- [ ] `render` receives alpha and is called once per frame.
- [ ] The loop allocates nothing after construction (identity assertions).

**Tests (tagged)**

- `[FR-9.1] fixed timestep runs at 60 Hz with variable render`
- `[FR-9.1] pause and resume do not simulate wall-clock gap`
- `[PR-9.3] loop performs no per-frame allocations`
- `[FR-7.12] mapper poll happens once per sim tick`
- `[FR-9.2] paused loop stops simulation`

**Anti-rework**

- `simulate(dt, snapshot)` is the only game entry point per tick; D7 games build on it.
- Do not add a second loop for menus; use `pause()` plus a UI render path.
- Keep the loop independent of renderer and net client.

**Risks**

- `requestAnimationFrame` timestamps can jump after tab restore; `pause/resume` resets `lastMs`.
- A very slow frame can still hitch visuals; dynamic resolution (D3-RT-07) handles render cost, not sim cost.

---

### D3-RT-02 — Renderer interface, WebGL2 gate, cube scene, asset loader and progress

| Field | Value |
|---|---|
| Layer | Host runtime |
| Spec | §6.2, §9.2, §9.3; FR-9.3, FR-9.4, FR-9.6, FR-9.7; NR-6.1, NR-6.2; PR-9.1, PR-9.6, PR-9.7 |
| Depends on | D1-EXP-02, D3-RT-01 |
| Unblocks | D3-RT-07, D3-EXP-01 (E12), D7 games |
| Deliverables | `packages/runtime/src/render/Renderer.ts`, `Canvas2DRenderer.ts`, `ThreeRenderer.ts`, `src/assets/AssetLoader.ts`, `src/assets/ProgressBar.ts`, `src/demo/CubeDemo.ts`, `test/renderer.test.ts`, `test/loader.test.ts` |

**Freeze this interface**

```ts
export type RendererBackend = "webgl2" | "canvas2d";

export interface Renderer {
  readonly backend: RendererBackend;
  init(canvas: HTMLCanvasElement): Promise<{ maxTextureSize: number; compressedFormats: string[] }>;
  resize(cssWidth: number, cssHeight: number, dpr: number): void;
  beginFrame(alpha: number): void;
  endFrame(): void;
  dispose(): void;
  readonly drawCalls: number;
  readonly textureMemoryMB: number;
}

export interface Renderer2D extends Renderer {
  clear(color: string): void;
  circle(x: number, y: number, r: number, color: string): void;
  rect(x: number, y: number, w: number, h: number, color: string): void;
  text(text: string, x: number, y: number, size: number, color: string, align?: "left" | "center" | "right"): void;
  polyline(points: ReadonlyArray<{ x: number; y: number }>, width: number, color: string): void;
}

export interface Renderer3D extends Renderer {
  setCamera(position: { x: number; y: number; z: number }, target: { x: number; y: number; z: number }): void;
  drawCube(position: { x: number; y: number; z: number }, size: number, color: string, rotationY: number): void;
}
```

**Behavior**

- `createRenderer(preferred)` feature-detects WebGL2; if absent, returns the Canvas2D renderer and the host shows the friendly fallback (FR-9.3). The friendly screen names the browser and suggests updating or using PC+HDMI.
- Three.js path: a minimal scene with a cube, one texture atlas, a camera and a resize handler; no post-processing, no shadows initially. Count draw calls and texture memory for the overlay. Use instancing for repeated meshes (>10 copies, PR-9.6) and frustum culling (PR-9.7).
- Canvas2D path: same cube demo projected in 2D (a rotating square) so the runtime still works if WebGL2 is absent; clearly labelled.
- Asset loader:
  - `load(entries: AssetEntry[], onProgress)`: each entry `{url, type:"image"|"audio"|"json"|"texture"}`; fetch with `Content-Length` if present; otherwise count bytes read from the stream.
  - Progress = total bytes read / total declared; if a total is unknown, show an indeterminate bar and say so; never fake a percentage (FR-9.7).
  - Supports WebP/PNG images, WebM/Opus audio (AAC fallback), JSON; KTX2 is a hook, implemented only if E1 says the TV needs compressed textures.
  - glTF + Meshopt/Draco is a hook for 3D games (P6); do not load it in D3.
  - Fonts: subset WOFF2 for UI text; HUD numbers use a cached/bitmap path (PR-9.8). No third-party font CDNs.
  - Lazy-loading API `loadGroup(name)` for per-scene assets (FR-9.6).
- `CubeDemo`: `Game` implementation that renders a cube and maps the left stick to rotation, A to a color pulse. It proves input→sim→render.
- Initial bundle must stay under 5 MB gz including Three.js; measure and record.

**Steps**

- [ ] Implement `Renderer` types and a factory with feature detection.
- [ ] Implement `Canvas2DRenderer` first (boring, testable); use it for logic tests.
- [ ] Implement `ThreeRenderer` with one cube, one texture, a camera and resize; count draw calls/texture MB.
- [ ] Implement the friendly no-WebGL2 screen with a clear message and a PC+HDMI suggestion.
- [ ] Implement `AssetLoader` with streaming progress, abort support, and error reporting; no fake progress.
- [ ] Implement `ProgressBar` bound to the loader; complete → start screen.
- [ ] Implement `CubeDemo` as a `Game` that uses the renderer interface only.
- [ ] Add tests: Canvas2D draw-call counter, loader byte math (including unknown totals), renderer resize, no-WebGL2 fallback decision.
- [ ] Measure runtime + CubeDemo gz; record in `docs/RESULTS.md`.

**Acceptance**

- [ ] On a WebGL2 TV, the cube renders; on a non-WebGL2 browser, the friendly screen renders and no exception is thrown.
- [ ] The progress bar tracks bytes and never claims completion before assets resolve.
- [ ] Runtime + demo gz ≤ 5 MB hard; engine core target < 400 KB recorded (aspirational).
- [ ] The cube moves from stick input and pulses on A.
- [ ] Draw calls ≤ 120 for the demo (PR-9.1).
- [ ] No VDOM framework is used (NR-6.2).

**Tests (tagged)**

- `[FR-9.3] WebGL2 absence shows a friendly fallback and does not crash`
- `[FR-9.4] TV profile renders at DPR 1 and upscales via CSS`
- `[FR-9.6] initial assets stay under 5 MB and load lazily`
- `[FR-9.7] progress is tied to fetched bytes`
- `[PR-9.1] demo draw calls stay under 120`
- `[NR-6.2] no virtual DOM in the render loop`
- `[E12] renderer backend is swappable behind the interface`

**Anti-rework**

- E12 can replace the Three.js backend without changing `CubeDemo` or any game; games depend on `Renderer3D`, not Three.
- The loader's `AssetEntry`/progress contract is used by every game manifest; do not add game-specific loaders.
- Keep Canvas2D as a real path, not a stub: it is the fallback and the 2D games' renderer.

**Risks**

- Three.js adds ~150 KB gz; E12 may choose the custom renderer. Keep the import isolated to `ThreeRenderer.ts`.
- `Content-Length` is often missing; implement stream counting and an indeterminate state.
- KTX2/Basis adds a transcoder payload; defer unless E1 requires it.

---

### D3-RT-03 — Host net client: host join, InputFwd routing, server time

| Field | Value |
|---|---|
| Layer | Host runtime |
| Spec | §5.2, §7.1, §7.3, §7.4; FR-7.10, FR-7.11, FR-7.16 groundwork; A2 |
| Depends on | D0-RT-01, D0-PROTO-02, D2-RT-01 |
| Unblocks | D3-RT-04, D4-HOST-02, D7 games |
| Deliverables | `packages/runtime/src/net/HostClient.ts`, `test/hostClient.test.ts` |

**Freeze this interface**

```ts
export interface HostClient {
  connect(origin: string): Promise<void>;
  createRoom(): Promise<RoomCredentials>;
  hostJoin(code: string, hostToken: string): Promise<{ serverTime: number }>;
  onInput(cb: (slot: number, packet: InputState) => void): void;
  onPlayer(cb: (event: "joined" | "left" | "suspended" | "resumed", slot: number) => void): void;
  onServerStats(cb: (slots: SlotStats[]) => void): void;
  send(msg: HostToServerMessage): void;
  close(): void;
  readonly state: "idle" | "connecting" | "connected" | "reconnecting" | "hostLost" | "closed";
}
```

**Behavior**

- Reuse `@lanpad/sdk` config helpers; never hard-code an origin.
- `createRoom` posts to `/api/rooms`; store `hostToken` in `sessionStorage` keyed by code (D0).
- `hostJoin` sends `{t:"hostJoin", v:PROTOCOL_VERSION, code, hostToken}` and resolves on `hostJoined` with the server time offset: `serverTimeOffset = serverTime - performance.now()`.
- Binary `InputFwd` frames decode with `decodeInputFwdInto` (no allocation) and dispatch `(slot, packet)` to the mapper. Do not parse JSON for hot-path input.
- `player*` and `stats` JSON messages dispatch to callbacks; unknown messages are ignored with a debug counter.
- `send` serializes host JSON (`hostPause`, `hostResume`, `setLayout`, `panel`).
- D3 has no reconnect; D4 adds backoff and `hostLost`. The state enum is present now so D4 fills it.
- On close, state becomes `closed`; the loop pauses.

**Steps**

- [ ] Implement `HostClient` with a single WebSocket and typed message parsing.
- [ ] Decode `InputFwd` with the allocation-free path; test slot/tick/edges.
- [ ] Implement `serverTimeOffset` from `hostJoined`; expose `serverNow()`.
- [ ] Dispatch player events without allocating a new array per message.
- [ ] Add tests with a fake WebSocket: hostJoin success/error, InputFwd order, stats dispatch, close behavior.
- [ ] Instrument: packet count, decode time p95, last packet age per slot.

**Acceptance**

- [ ] The host connects, joins, and receives InputFwd for slots 1..8.
- [ ] InputFwd decoding allocates nothing after startup.
- [ ] `serverNow()` is monotonic and offset-corrected.
- [ ] The client never sends controller-only messages.
- [ ] No origin literal exists in runtime code.

**Tests (tagged)**

- `[FR-7.10] host server-time offset comes from hostJoined`
- `[A2] hostJoin uses the host token, not the room token`
- `[FR-7.17] game code never receives the socket`
- `[PR-9.3] InputFwd decode is allocation-free`
- `[FR-4.3] host client reads the server origin from config`

**Anti-rework**

- `HostClient` is the only socket owner on the host; the game interface never exposes it.
- `state` includes future values now; D4 adds transitions without changing the enum.
- Use `decodeInputFwdInto`; D7's trace harness depends on the same packet shape.

**Risks**

- The host's `performance.now()` clock can drift from the server; refresh the offset on `hostJoined` only in D3, on stats in D4 if needed.
- A server restart closes the socket; D4's reconnect is required before production.

---

### D3-RT-04 — Input integration and the game-facing context

| Field | Value |
|---|---|
| Layer | Host runtime |
| Spec | §7.5, §9.1; FR-7.17, FR-7.11/7.12; §14 D3 |
| Depends on | D2-RT-01, D3-RT-01, D3-RT-03 |
| Unblocks | D3-SDK-01, D7 games |
| Deliverables | `packages/runtime/src/game/GameContext.ts`, `src/game/InputReader.ts`, `test/inputReader.test.ts` |

**Freeze this interface**

```ts
export interface InputReader {
  readonly snapshot: InputSnapshot;      // latest poll
  poll(): InputSnapshot;                 // called once per sim tick by the loop
  player(slot: number): ControllerState | undefined;
  events(): ReadonlyArray<GameEvent>;    // drained per tick; empty in D3
}

export interface GameEvent { slot: number; name: string; data: JsonValue; }
```

**Behavior**

- `InputReader` holds the latest `InputSnapshot` from the loop's single `pollAll`.
- `player(slot)` is an index into the fixed slot array; no allocation.
- `events()` returns the drained event queue; D5 fills it from the server `event` message.
- The loop passes the same snapshot to `simulate`; a game must not call `pollAll` itself.
- `GameContext` exposes `input`, `events` (queue/router; D5 fills it), `renderer`, `audio`, `panels` (stub), `layouts` (stub), `haptics` (stub), `debug`, `rng` (seeded), and `serverNow()`. P6 adds `settings` via the manifest extension; the shape stays additive.
- No socket, no fetch, no DOM access in the context.

**Steps**

- [ ] Implement `InputReader` around the mapper's snapshot; `poll()` is a no-op view update because the loop already polled.
- [ ] Implement the event queue with a fixed-capacity ring (D5 fills it).
- [ ] Implement a seeded RNG (`mulberry32`) for deterministic tests and replays.
- [ ] Define `GameContext` with stubs for later capabilities; stubs throw a clear "not available until D5/D6" error if called early.
- [ ] Add tests: player indexing, event drain, RNG determinism, no socket property on the context.

**Acceptance**

- [ ] A game can read every slot's `ControllerState` and see edges exactly once per tick.
- [ ] `events()` returns and drains; the next tick is empty if no events arrived.
- [ ] The seeded RNG produces the same sequence for the same seed.
- [ ] The context has no `socket`, `ws`, or `fetch` member.

**Tests (tagged)**

- `[FR-7.17] GameContext exposes input and events, never sockets`
- `[FR-7.12] events and edges are drained exactly once per tick`
- `[FR-7.11] player snapshot reflects latest state`
- `[G8] game context is SDK-documented and third-party usable`

**Anti-rework**

- Stubs for panels/layouts/haptics let D5/D6 fill them without changing the context shape.
- Games receive the latest snapshot; do not add per-game mapper instances.
- `GameEvent` is the only UGC path into games; keep it opaque `JsonValue`.

**Risks**

- A game that holds a `ControllerState` across ticks will see reused objects mutating; document "copy if you retain".
- Event queue capacity (e.g. 256/tick) must drop oldest with a counter, not grow unbounded.

---

### D3-RT-05 — Start screen, audio unlock and AudioBus

| Field | Value |
|---|---|
| Layer | Host runtime |
| Spec | §9.6; FR-9.11; AR-4; §20 E11 |
| Depends on | D3-RT-02 |
| Unblocks | D7 games (C8), Beat Tap, E11 |
| Deliverables | `packages/runtime/src/audio/AudioBus.ts`, `src/ui/StartScreen.ts`, `test/audioBus.test.ts` |

**Freeze this interface**

```ts
export interface AudioBus {
  unlock(): Promise<void>;                 // from a user gesture
  playSfx(id: string, opts?: { volume?: number; rate?: number }): void;
  playMusic(id: string, opts?: { loop?: boolean; fadeMs?: number }): void;
  stopMusic(fadeMs?: number): void;
  now(): number;                           // AudioContext time
  readonly unlocked: boolean;
  readonly latencyHint: "interactive" | "balanced";
}
```

**Behavior**

- The host opens on a start screen: game title, room code/PIN, "Press Enter to start" (remote-friendly), and a muted speaker icon if audio is not unlocked.
- Enter/Space/click calls `AudioBus.unlock()` (`AudioContext.resume()`); then starts the game. No audio before this.
- `AudioBus` owns one `AudioContext`; `playSfx` uses short buffers, pooled gain nodes; `playMusic` streams via `<audio>` or `AudioBufferSourceNode` with a gain fade.
- `latencyHint: "interactive"` by default; E11 records actual output latency.
- Start screen is operable with arrow keys/Enter (AR-4) and has a clear focus state.
- The game does not start until assets are loaded and audio is unlocked; show progress.

**Steps**

- [ ] Implement `StartScreen` with keyboard focus and a single primary action.
- [ ] Implement `AudioBus.unlock()` and a test with a fake AudioContext.
- [ ] Implement `playSfx`/`playMusic` with gain and stop/fade; no allocation per SFX.
- [ ] Wire the start screen to the loader progress and the Enter key.
- [ ] Record the audio unlock behavior on the TV (silent before Enter, audible after).
- [ ] Expose `audio.now()` for Beat Tap's scheduling later.

**Acceptance**

- [ ] No AudioContext is created/resumed before a user gesture.
- [ ] Enter starts the game and unlocks audio on Chrome desktop and TV Chromium.
- [ ] Music can fade out without clicks; SFX can overlap.
- [ ] The start screen is fully keyboard-operable.

**Tests (tagged)**

- `[FR-9.11] audio is unlocked only after Enter`
- `[AR-4] start screen is operable with remote arrows and Enter`
- `[C8] audio bus exposes now() for rhythm scheduling`
- `[E11] output latency is measurable via the audio clock`

**Anti-rework**

- `AudioBus` is the only audio path for games; Beat Tap uses `now()` rather than `Date.now()`.
- The start screen is also the lobby shell in D4; keep it composable.

**Risks**

- TV browsers may require a click, not just a key; support both.
- `<audio>` streaming latency differs from Web Audio buffers; E11 documents both.

---

### D3-RT-06 — Debug overlay `?debug=1`

| Field | Value |
|---|---|
| Layer | Host runtime |
| Spec | §12; FR-12.2; §8.5 controller overlay |
| Depends on | D3-RT-01, D3-RT-02, D3-RT-03 |
| Unblocks | D4 stats, D7 per-game profiling, GATE-PERF-01 |
| Deliverables | `packages/runtime/src/debug/Overlay.ts`, `test/overlay.test.ts` |

**Fields**

- Backend (`webgl2`/`canvas2d`), FPS, frame ms p50/p95, sim ticks/s, draw calls, texture MB.
- Per-slot: RTT, jitter, last input age, packets/s, drops (RTT/jitter arrive from server stats in D4; show `—` until then).
- Resolution scale, DPR, canvas size, visible-instance count.
- Toggle with `?debug=1`; optional key `D` to hide/show. No tokens.

**Behavior**

- Fixed-position panel, monospace, textContent updates only; redraw at 4 Hz, not every frame.
- Uses a ring buffer for frame times; p50/p95 computed from the last 120 frames.
- Does not allocate during frame updates beyond fixed buffers.
- Hidden by default; `?debug=1` is the only enable path (no accidental TV clutter).

**Steps**

- [ ] Implement the ring buffer and percentile math with tests.
- [ ] Render the overlay into a `<pre>` or fixed grid; update at 4 Hz.
- [ ] Wire frame stats from the loop, renderer stats, and mapper stats.
- [ ] Add placeholders for RTT/jitter/drops; D4 fills them.
- [ ] Verify it does not affect frame time when hidden (no work).
- [ ] Record a screenshot for `docs/RESULTS.md`.

**Acceptance**

- [ ] All listed fields appear; unavailable fields show `—`.
- [ ] Overlay update cost ≤ 0.5 ms at 4 Hz.
- [ ] No token/PIN appears.
- [ ] Hiding the overlay removes all work.

**Tests (tagged)**

- `[FR-12.2] debug overlay shows backend, FPS, frame p50/p95, draw calls and texture MB`
- `[FR-12.2] overlay includes per-slot input age and packet rate`
- `[PR-9.8] overlay text is cached/updated off the hot path`
- `[SR-9] overlay never displays tokens`

**Anti-rework**

- D4 adds RTT/jitter/drops to the same fields; D7 adds per-game counters via a `debugCounters` map.
- Keep field names stable for screenshots and Gate evidence.

**Risks**

- DOM updates can cost more than expected on a TV; 4 Hz and fixed nodes mitigate.
- `p95` from 120 samples is coarse; record the window size in the overlay.

---

### D3-RT-07 — TV profile, dynamic resolution, frame pacing

| Field | Value |
|---|---|
| Layer | Host runtime |
| Spec | §9.2; FR-9.4, FR-9.5; PR-9.1, PR-9.2 |
| Depends on | D1-BUDGET-01, D3-RT-01, D3-RT-02 |
| Unblocks | D7 per-game budgets, P5 production gates |
| Deliverables | `packages/runtime/src/render/ResolutionController.ts`, `src/render/tvProfile.ts`, `test/resolution.test.ts` |

**Behavior**

- `tvProfile`: detect a TV-like environment by viewport size + input modality (no UA sniffing); set DPR 1, max render height 1080, CSS upscale. Phones/desktop may use DPR up to 2.
- `ResolutionController`: monitors frame time; if > 20 ms for 30 consecutive frames, reduces render scale by 10% (floor 60%). If < 12 ms for 120 consecutive frames, increases by 5% up to 100%. Hysteresis prevents oscillation.
- Applies scale to the renderer's backing store (`renderWidth = cssWidth * scale`, renderHeight similarly), leaves CSS size unchanged.
- Never changes simulation step; only render resolution.
- Exposes `scale`, `reason`, and counters to the debug overlay.

**Steps**

- [ ] Implement `tvProfile` with a documented heuristic and a `?tv=1` override for testing.
- [ ] Implement `ResolutionController` with injectable thresholds and a deterministic test sequence.
- [ ] Wire it to the loop's frame stats and the renderer resize.
- [ ] Verify the floor and ceiling; verify no oscillation with alternating 15/25 ms frames.
- [ ] Record the scale behavior on the actual TV in `docs/RESULTS.md`.
- [ ] Add the current scale to the debug overlay.

**Acceptance**

- [ ] DPR is 1 on the TV profile; the canvas backing store is ≤ 1080p.
- [ ] 30 consecutive > 20 ms frames trigger one 10% drop; 120 < 12 ms frames trigger one 5% rise.
- [ ] Scale never goes below 60% or above 100%.
- [ ] Simulation tick rate is unaffected.
- [ ] No oscillation across a synthetic alternating sequence.

**Tests (tagged)**

- `[FR-9.4] TV profile uses DPR 1 and caps at 1080p`
- `[FR-9.5] dynamic resolution drops 10% after 30 slow frames and recovers slowly`
- `[PR-9.2] texture memory stays within the E2 budget`
- `[G3] dynamic resolution protects the frame budget`

**Anti-rework**

- The controller is independent of the renderer backend; E12 can swap renderers.
- Thresholds come from `docs/BUDGETS.md`; do not hard-code a second set.
- P5 reuses the same controller for production telemetry.

**Risks**

- Upscaling makes text blurry; HUD text is rendered at the final scale or cached offscreen (D7-PR-9.8).
- A TV that always renders at 30 Hz will sit at the floor; record it and adjust the frame budget instead of fighting it.

---

### D3-SDK-01 — Game interface, manifest loader and scene lifecycle

| Field | Value |
|---|---|
| Layer | SDK + runtime |
| Spec | §10 (manifest), §7.5; FR-7.17, FR-10.3; G8 |
| Depends on | D0-SDK-01, D3-RT-01, D3-RT-04, D3-RT-05 |
| Unblocks | D7-SDK-01, all games, P4 SDK |
| Deliverables | `packages/runtime/src/game/Game.ts`, `src/game/GameHost.ts`, `src/game/loadGame.ts`, `sdk/src/game-api.ts`, `test/gameHost.test.ts` |

**Freeze this interface**

```ts
export interface Game {
  readonly manifest: GameManifest;
  init(ctx: GameContext): void | Promise<void>;
  simulate(dt: number, input: InputSnapshot): void;
  render(alpha: number): void;
  onEvent?(slot: number, name: string, data: JsonValue): void;
  dispose(): void;
}

export interface GameModule { default: (manifest: GameManifest) => Game; }

export async function loadGame(manifestUrl: string): Promise<{ game: Game; manifest: GameManifest }>;
```

**Behavior**

- `loadGame` fetches and validates the manifest, then dynamic-imports `entry` relative to the manifest URL, and calls the default factory.
- `GameHost` owns the loaded game, builds the `GameContext`, mounts the renderer surface, runs `init`, then starts the loop. On unload, calls `dispose`.
- Scene lifecycle: `loading → startScreen → playing → paused → results` (results is a game-level state later; D3 only needs loading/start/playing/paused).
- Manifest `assetBudget` is checked against the loader's declared bytes; a game over budget fails to load with a clear error (G3).
- `GameHost` never exposes the host client; it passes only the `GameContext`.
- The cube demo is loaded through the same path as a real game (manifest + entry), proving the SDK boundary.

**Steps**

- [ ] Define `Game`/`GameModule` in `sdk/src/game-api.ts` and re-export from runtime.
- [ ] Implement `loadGame` with manifest validation, relative entry resolution, and a clear error for a bad manifest.
- [ ] Implement `GameHost` mounting into `#game-root`, with start screen integration and pause on hidden.
- [ ] Convert `CubeDemo` into `games/cube-demo/` with a `game.manifest.json` and entry, loaded via `loadGame`.
- [ ] Add tests: invalid manifest fails before import; budget breach fails; game init/render/dispose order; no socket in context.
- [ ] Document the interface in `sdk/README.md` (draft; P4 finalizes).

**Acceptance**

- [ ] The cube demo is a manifest-driven game, not hard-coded in `main.ts`.
- [ ] A manifest with `entry: "../x"` is rejected.
- [ ] A game over its `assetBudget` fails with a readable message.
- [ ] `dispose` runs on unload; no timers/listeners leak.
- [ ] A recorded input trace can drive `simulate` without a socket (D7 uses this).

**Tests (tagged)**

- `[FR-7.17] Game interface exposes no sockets`
- `[FR-10.3] game loads from manifest with entry/layouts/budgets`
- `[G8] third-party game module shape is documented and tested`
- `[G3] assetBudget is enforced at load`
- `[FR-9.1] GameHost runs simulate/render through the fixed loop`

**Anti-rework**

- This interface is the SDK's public game API; P4 freezes it. Do not add game-specific hooks.
- `GameContext` stubs (panels/layouts/haptics) are filled in D5/D6 without changing the interface.
- The manifest loader is used by the hub in P6; no registry switch statements.

**Risks**

- Dynamic import paths on Vercel need correct base URLs; P2 verifies.
- A game factory that throws must not wedge the host; show an error screen and allow reload.

---

### D3-TOOL-01 — Latency harness (E5 foundation)

| Field | Value |
|---|---|
| Layer | Tools/CI |
| Spec | §11 PR-11.1, §20 E5; FR-7.13 |
| Depends on | D3-RT-02, D3-RT-06, D2-CTRL-04 |
| Unblocks | D3-EXP-01, D7-EXP-01, P5-QA-02 |
| Deliverables | `tools/latency-harness/README.md`, `experiments/e05/index.html`, `experiments/e05/controller.html`, `tools/latency-harness/analyze.ts` |

**Harness design**

- Controller page: a full-screen button that turns white on `touchstart` and sends an Input edge; records `performance.now()` and posts a debug mark to `/x/e5/log` (dev-only, in-memory) or prints to console.
- Host page: a full-screen region that turns white when it receives an Input edge; records receive and render timestamps.
- Instrumentation gives a software baseline; the 240 fps camera/photodiode gives the true input-to-canvas number.
- `analyze.ts` reads exported JSON logs (host + controller) and computes p50/p95 from `touchTime → hostReceive → hostPaint`; prints a table.
- Input-bot can automate repeated taps for regression runs (PR-11.1), but the camera is the ground truth.
- E5 procedure documented in `tools/latency-harness/README.md`: device setup, camera frame rate, 1000 samples, Game Mode on/off.

**Steps**

- [ ] Implement the E5 host and controller pages with high-contrast flashes and timestamp logging.
- [ ] Add a dev-only in-memory log endpoint (or use `console.log` + manual copy); no persistence (SR-7).
- [ ] Implement `analyze.ts` for the JSON format `{touchMs, hostReceiveMs, hostPaintMs}`.
- [ ] Document the camera procedure and the software-only fallback.
- [ ] Run 100 samples as a smoke test; record the method and numbers.
- [ ] Wire input-bot macros for repeatable tap sequences (optional at D3; required D7).

**Acceptance**

- [ ] The harness produces p50/p95 from a log with 100+ samples.
- [ ] The controller flash is visible in the same frame as the touch.
- [ ] The host flash is visible in the frame after receipt.
- [ ] The README lets another person run the test without asking questions.
- [ ] No analytics/upload; logs stay local.

**Tests (tagged)**

- `[PR-11.1] latency harness measures tap-to-host-canvas flash`
- `[FR-7.13] input-to-canvas and display-lag measurements are reported separately`
- `[G2] E5 baseline is recorded with p50/p95`
- `[SR-7] latency logs stay on the device`

**Anti-rework**

- The analyzer's input format is reused by P5's production latency gate.
- The flash page is separate from the game runtime; do not couple it to a game.
- Keep the camera procedure in the README; it is the evidence for the Gate.

**Risks**

- Phone camera frame timing is imprecise; use 240 fps and a visible frame counter if possible.
- Software timestamps understate display lag; E6 measures that separately.

---

### D3-EXP-01 — E5 baseline, E6 display lag, E11 audio, E12 renderer decision

| Field | Value |
|---|---|
| Layer | Experiments/docs |
| Spec | §20 E5/E6/E11/E12; §14 D3; §11 |
| Depends on | D3-TOOL-01, D3-RT-05, D3-RT-02 |
| Unblocks | D7, Gate, P0 (E12 size input) |
| Deliverables | `experiments/e11/index.html`, `experiments/e12/index.html`, `docs/RESULTS.md` rows, `docs/ADR-0001-renderer.md` (E12) |

**E5 — input-to-canvas**

- LAN, phone + TV via dev server, 1000 taps (or 100 for the first baseline).
- Record p50/p95 software and camera-measured; pass criterion p95 < 25 ms LAN.
- If p95 fails, profile: touch handler, send rate, server relay, render. Do not proceed to D7 without a plan.

**E6 — TV display lag**

- Flash test page (from D3-TOOL-01) with Game Mode on/off; photodiode or 240 fps camera.
- Record the number; it is measured, not gated (FR-7.13).
- Write user advice for the final product ("enable Game Mode").

**E11 — audio on TV**

- After the start-screen gesture, play a click and measure output latency with a tap-to-beat test; repeat with Bluetooth speakers if available.
- Record whether latency is measurable and calibratable; if not, Beat Tap is at risk (P6).

**E12 — Three.js vs thin custom renderer**

- Same cube scene, one texture, 1080p; compare gz size, frame time p95, memory on the TV.
- Record a decision in `docs/ADR-0001-renderer.md`: Three.js or custom, with numbers. Pick the smaller if visuals are equal.
- If custom is chosen, the swap is confined to `ThreeRenderer.ts` behind `Renderer3D`; schedule it before the first 3D game (P6).

**Steps**

- [ ] Run E5 and record p50/p95 (software + camera), sample count, devices, Game Mode.
- [ ] Run E6 and record display lag on/off.
- [ ] Run E11 and record audio latency, wired and Bluetooth if available.
- [ ] Run E12 and write the ADR with bundle/frame/memory numbers.
- [ ] Update `docs/BUDGETS.md` if E5/E6 change the latency budget assumptions.
- [ ] Mark any experiment not run as `not run — blocked by <reason>` with a date.

**Acceptance**

- [ ] E5 baseline exists and is under 25 ms p95 LAN, or a written remediation plan exists.
- [ ] E6 number recorded; display lag is not confused with input latency.
- [ ] E11 result recorded or explicitly deferred with a note.
- [ ] E12 decision recorded before any 3D game work.
- [ ] Results include device, browser, date, method, sample count.

**Tests (tagged)**

- `[E5] input-to-canvas p95 is recorded on LAN`
- `[E6] display lag is measured separately from input latency`
- `[E11] TV audio latency is measurable and calibratable`
- `[E12] renderer choice is backed by size/frame/memory numbers`
- `[PR-11.1] latency harness is used for the release candidate baseline`

**Anti-rework**

- E12's ADR constrains P6 3D work; if it is not written, do not start 3D games.
- E11's result decides whether Beat Tap is viable; do not build it earlier.
- Keep raw logs and screenshots referenced from `docs/RESULTS.md`.

**Risks**

- Camera measurement is laborious; start with software timestamps and a smaller camera sample.
- Bluetooth audio can add 100–300 ms; record it separately.

---

### D3-QA-01 — Cube on TV acceptance run

| Field | Value |
|---|---|
| Layer | QA |
| Spec | §14 D3 exit; G2, G6 |
| Depends on | D3-RT-01..07, D3-SDK-01, D3-TOOL-01 |
| Unblocks | D4 entry |
| Deliverables | `docs/RESULTS.md` D3 row, screenshot |

**Steps**

- [ ] Start the dev server; open `/` on the actual TV; press Enter; confirm the start screen, audio unlock, loader progress, and cube.
- [ ] Join with a phone; move the stick; confirm the cube responds without visible lag; press A; confirm the pulse.
- [ ] Open `?debug=1`; record backend, FPS, frame p50/p95, sim ticks, draw calls, texture MB, slot input age.
- [ ] Hide the host tab; confirm simulation pauses and the controller shows a waiting state (D4 completes the UX; D3 just pauses).
- [ ] Run E5 with 100 taps; record p50/p95.
- [ ] Record runtime + demo gz size.
- [ ] Take a screenshot for `docs/RESULTS.md` (TV + phone in frame if possible).

**Acceptance**

- [ ] Cube moves from the phone on the TV.
- [ ] No console errors on the TV.
- [ ] Frame p95 ≤ 14 ms on the TV at the chosen resolution, or dynamic resolution engaged and recorded.
- [ ] Debug overlay fields present.
- [ ] E5 baseline recorded.

**Tests (tagged)**

- `[G2] cube responds to phone input within the LAN latency target`
- `[G6] host runs on the TV with no PC in the loop`
- `[FR-9.5] dynamic resolution reacts if frame time exceeds 20 ms`
- `[FR-12.2] debug overlay is usable on the TV`

**Anti-rework**

- This run is the template for every game acceptance in D7; record commands, devices, and observations.
- Keep the cube demo as a smoke test for the runtime after later changes.

**Risks**

- TV remote Enter may not reach the page if focus is lost; test keyboard focus explicitly.
- TV browsers may block Web Audio until a click, not a key; try both.

---

## Stage exit checklist

- [ ] D3-RT-01..07, D3-SDK-01, D3-TOOL-01, D3-EXP-01, D3-QA-01 complete.
- [ ] Fixed loop, renderer, host client, input integration, audio, overlay and dynamic resolution work.
- [ ] Cube moves from a phone on the actual TV.
- [ ] E5 baseline recorded; E6/E11/E12 recorded or explicitly deferred.
- [ ] E12 ADR written; no 3D game work before it.
- [ ] Runtime + demo gz size recorded; under 5 MB.
- [ ] No per-frame allocations in the loop/mapper (tests).
- [ ] `docs/RESULTS.md` D3 row complete.

## Handoff to D4

- D4 wraps the existing `HostClient` and controller client with sessions, reconnect, suspend/resume and host-lost UX.
- D4 fills the overlay's RTT/jitter/drops fields from server stats.
- D4's QR/room UI reuses the start screen and room credentials from D0.
- Do not change the loop, mapper, renderer or game interface in D4.

## Explicitly not in D3

- Sessions, QR display, reconnect (D4).
- Full layouts, panels, text, canvas, events (D5).
- Sensors and haptics (D6).
- Proof games (D7) and world streaming (P6).
- Production deployment (P0–P2).
- iOS work (A5).
