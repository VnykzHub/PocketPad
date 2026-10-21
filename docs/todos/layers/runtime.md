# Layer: Host Runtime

**Package:** `packages/runtime` + the host page.
**Owns:** fixed loop, renderer interfaces (Canvas2D/WebGL2), input mapper integration, host net client, asset loader, audio, HUD/results, streaming/LOD, debug overlay.
**Must not own:** controller internals, broker logic, game rules, virtual DOM in the render loop.
**Goal contribution:** G2 (loop/mapper/latency), G3 (bundle/dynamic resolution), G5 (private screens/events), G6 (TV boot), G7 (dependency/perf discipline), G8 (game API).

## Invariants

1. Fixed timestep 60 Hz, variable render with interpolation, death-spiral clamp (FR-9.1).
2. `runtime` never imports `controller` (FR-10.2, ESLint).
3. Games receive `GameContext`, never sockets (FR-7.17).
4. No per-frame allocations in loop/mapper; pools for entities (PR-9.3/9.4).
5. Renderer is an interface; games never import Three.js directly (E12 isolation).
6. TV profile: DPR 1, ≤1080p backing store, CSS upscale; dynamic resolution responds to 20 ms (FR-9.4/9.5).
7. Audio requires a gesture; the start screen unlocks it (FR-9.11).
8. Initial assets ≤ 5 MB with byte-accurate progress (FR-9.6/9.7).

## Todo index

| ID | Title | Stage | File |
|---|---|---|---|
| D0-RT-01 | Host page shell/room create/echo | D0 | `phase-1-dev/D0-foundations.md` |
| D2-RT-01 | Input mapper: latest-wins + edges | D2 | `phase-1-dev/D2-controller-v0.md` |
| D3-RT-01 | Fixed loop + interpolation | D3 | `phase-1-dev/D3-runtime-v0.md` |
| D3-RT-02 | Renderer interface/WebGL2/loader/progress | D3 | `phase-1-dev/D3-runtime-v0.md` |
| D3-RT-03 | Host net client + server time | D3 | `phase-1-dev/D3-runtime-v0.md` |
| D3-RT-04 | InputReader/GameContext | D3 | `phase-1-dev/D3-runtime-v0.md` |
| D3-RT-05 | Start screen/audio unlock | D3 | `phase-1-dev/D3-runtime-v0.md` |
| D3-RT-06 | Debug overlay | D3 | `phase-1-dev/D3-runtime-v0.md` |
| D3-RT-07 | TV profile/dynamic resolution | D3 | `phase-1-dev/D3-runtime-v0.md` |
| D4-HOST-01 | QR/code/PIN UI | D4 | `phase-1-dev/D4-pairing-sessions.md` |
| D4-HOST-02 | Host reconnect/pause/resume | D4 | `phase-1-dev/D4-pairing-sessions.md` |
| D5-RT-01 | Layout/panel/event APIs | D5 | `phase-1-dev/D5-layouts-events.md` |
| D6-RT-01 | Tilt integration/haptic API | D6 | `phase-1-dev/D6-sensors-haptics.md` |
| D7-RT-01 | 2D/physics/HUD/results/assets | D7 | `phase-1-dev/D7-proof-games.md` |
| D7-RT-02 | Perf instrumentation/pools | D7 | `phase-1-dev/D7-proof-games.md` |
| P6-RT-01 | Streaming/LOD (gated) | P6 | `phase-2-production/P6-games-hub.md` |

## Requirement coverage

| Requirement | Where |
|---|---|
| FR-7.10–7.13, 7.17 | D2-RT-01, D3-RT-03/04 |
| FR-9.1–9.7, 9.11 | D3-RT-01/02/05/07 |
| FR-9.8–9.10 | P6-RT-01 |
| FR-9.2 | D4-HOST-02 |
| FR-12.2 | D3-RT-06 |
| NR-6.1/6.2 | D3-RT-02, size gate |
| PR-9.1–9.8 | D3/D7 instrumentation/games |
| AR-4 | D3-RT-05, D4-HOST-01, D7-RT-01 |
| G2/G3/G6/G8 | throughout |

## Verification

- Loop/mapper unit tests with fake clocks and identity assertions.
- Renderer tests on Canvas2D; manual TV run for WebGL2.
- E5/E6/E11/E12 experiments (D3).
- Per-game frame/draw-call budgets (D7/P6).
- Trace checker covers the requirements above.

## Change rules

- A game needing renderer internals means the interface is missing something; fix the interface, not the game.
- Do not add DOM UI frameworks; the host is vanilla TS/DOM plus canvas.
- Any new per-frame path must pass the allocation and draw-call audits.
- Streaming stays in runtime, never in a game.
