# ADR-0001: Custom WebGL2 renderer with a Canvas2D fallback

- **Status:** **Superseded by [ADR-0002](ADR-0002-webgpu-engine.md) on
  2026-10-22.** Kept for history; do not use as the current renderer decision.
- **Date:** 2026-10-22
- **Decision owner:** `D3-RT-02`, `D3-EXP-01` (E12)
- **Scope:** `packages/runtime` renderer and every game that draws through
  `Renderer2D` / `Renderer3D`.
- **Related:** `docs/RESULTS.md` §E12, `docs/BUDGETS.md`,
  `docs/todos/phase-1-dev/D3-runtime-v0.md` (`D3-EXP-01`).

## Context

D3 needs a renderer that can run on a TV browser, is small enough for the host
budget, and can be replaced without touching game code. The plan left the
choice between Three.js and a thin custom implementation to E12, with the rule
"pick the smaller if visuals are equal" and a requirement to compare gz size,
frame-time p95 and memory on the TV.

The implemented runtime has:

- `Renderer` plus the frozen `Renderer2D` and `Renderer3D` interfaces in
  `packages/runtime/src/render/Renderer.ts`:
  - `Renderer2D`: `clear`, `circle`, `rect`, `text`, `polyline`.
  - `Renderer3D`: `setCamera`, `drawCube`.
  - Both extend `Renderer` (`init`, `resize`, `beginFrame`, `endFrame`,
    `dispose`, `drawCalls`, `textureMemoryMB`).
- `WebGL2Renderer` (custom WebGL2, no engine dependency) implementing
  `Renderer3D`.
- `Canvas2DRenderer` implementing both `Renderer2D` and `Renderer3D`, used when
  WebGL2 is unavailable or fails to initialise.
- `initRenderer` performing feature detection and returning the backend plus a
  user-facing fallback notice; it rejects only when both backends fail.

`packages/runtime/package.json` declares only `@lanpad/protocol` and
`@lanpad/sdk`. There is no Three.js dependency in the tree.

## Decision

Use the custom `WebGL2Renderer` as the 3D backend and `Canvas2DRenderer` as the
fallback, both behind the existing `Renderer` interfaces. Do not add Three.js
in D3.

This ADR records the decision as implemented. It does not claim the TV
comparison has been run; see **Desktop-provisional status** below.

## Evidence

### Bundle sizes measured in this wave

Source: the final `npm run check` size stage for the independent-review wave
(2026-10-22). The size gate measures `dist/assets/**/*.js` per target
(`tools/size-budget/budgets.json`).

| Target | Raw | Gzip | Budget | Headroom | Share of dev target |
|---|---:|---:|---:|---:|---:|
| Controller JS | 134,307 B | **37,911 B** | dev 40,960 B; hard 61,440 B | 3,049 B to dev; 23,529 B to hard | 92.6% of dev; 61.7% of hard |
| Host runtime JS | not reported | **55,754 B** | dev 3,145,728 B; hard 5,242,880 B | large | 1.8% of dev; 1.1% of hard |

Context: before this wave the same gate measured the controller at 36,712 B gz
and the host at 54,199 B gz. The wave added 1,199 B gz (+3.3%) to the
controller and 1,555 B gz (+2.9%) to the host while adding the review fixes
(safe rendering, motion strip, tilt/overlay wiring and game changes). The
renderer itself did not change.

The controller number is not renderer code: the renderer ships in the host
runtime. It is recorded because the controller has the tightest budget and the
platform must not pull a renderer-sized dependency into it.

### E12 standalone desktop measurement (earlier, different method)

From `docs/RESULTS.md` §E12, measured on `pc-win11-rtx3050`, Windows 11,
Chrome 155.0.0.0, using gzip via `zlib.gzipSync` on the built
`packages/runtime/dist`:

| Measure | Value |
|---|---:|
| Page-load HTML + CSS + JS | 128,073 B raw / **42,353 B gz** |
| All `.js/.css/.html/.json` in `dist` (37 files) | 332,079 B raw / **105,746 B gz** |
| Hard bundle cap | 5,242,880 B gz |

The all-text figure over-counts when compared with the size gate because the
tsc module tree is not all loaded by the page. Both figures are far below the
5 MB cap.

### What is still missing

| E12 input | Status |
|---|---|
| Frame-time p95 on the same cube scene, 1080p, on a TV | **PENDING** — no TV |
| Texture / JS memory on a TV | **PENDING** — no TV |
| Desktop cube-scene frame p95 | Not measured. The only desktop overlay run reported `backend webgl2` but FPS 0, draw calls 0 because `/demo/cube-demo/game.manifest.json` returned 404. The `/demo/*` route is fixed in the tree, but the overlay was not re-run. |
| Three.js delta | **Not measured in this repo.** The D3 plan notes ~150 KB gz as an estimate; it is not a measurement and is not used as one here. |

Desktop context only, not E12 evidence: the D1/E3 desktop runs recorded a
frame p95 of 8.4–8.5 ms wall clock across five scenes at 720p/1080p on a
120 Hz-capped rAF. That is not a TV frame budget and not a cube-scene E12 run.

## Why this choice

### 1. Smaller bundle

No Three.js runtime package is added. The renderer ships inside the 55,754 B gz
host bundle, and the controller's 37,911 B gz stays under its 40,960 B dev
target. The plan's ~150 KB gz Three.js estimate is roughly four times the
controller's entire 40,960 B dev target, so it could never be pulled into
shared controller code; keeping the renderer dependency-free avoids that class
of regression.

### 2. One interface

Games depend on `Renderer2D` / `Renderer3D`, never on a concrete backend. A
Three.js backend would be another class behind the same interfaces, so the
swap point is explicit and game code is unaffected. The custom backend also
forces the runtime to depend only on the drawing operations its games actually
use.

### 3. TV target

The primary product target is a TV browser with no PC in the loop. WebGL2 is
feature-detected, not assumed; Canvas2D is a real fallback, and the friendly
failure screen names the browser and suggests PC + HDMI when both backends
fail. This keeps the cheap path cheap while the actual TV WebGL2 result is
still unmeasured.

### 4. Dependency discipline (G7)

The runtime has zero new runtime packages. There is no engine upgrade cadence,
no license surface, and no tree-shaking uncertainty to manage in D3.

## Consequences

Positive:

- Minimal host bundle and no new dependency.
- The renderer contract is frozen and testable; both backends implement it.
- A future engine decision is a new class, not a game rewrite.

Negative:

- The feature set is deliberately thin: no glTF/GLB scenes, skeletal
  animation, PBR materials, shadows, post-processing or instancing beyond the
  current draw calls. A game needing those must either extend the renderer or
  trigger a revisit.
- A bespoke renderer can grow into an engine by accretion. Feature requests
  must be evaluated against this ADR, not added one at a time.
- The Canvas2D `Renderer3D` path is approximate; visuals and performance are
  degraded by design.

## Desktop-provisional status

Measured so far: bundle sizes and dependency count on desktop.

Not measured: TV WebGL2 availability, cube-scene frame p95, memory, and
whether the custom path holds the 14 ms spec target / 16.7 ms frame interval
at 1080p on a TV.

Until the TV run exists, do not treat this ADR as a final hardware verdict.
Start no large 3D game work on the strength of it; either record the TV E12
run or write an explicit deferral with a date. The cube demo and 2D games are
unaffected.

## Conditions that would revisit this decision

Re-run E12 with both backends on the same cube scene (one texture, 1080p) and
record gz, frame p95 and memory in `docs/RESULTS.md` if any of these occurs:

| # | Trigger | Action |
|---|---|---|
| 1 | TV cube-scene frame p95 misses the 16.7 ms frame interval (or the 14 ms spec target) at 1080p | Compare Three.js on the same scene; if it meets the budget and the custom path does not, switch behind `Renderer3D` |
| 2 | TV memory exceeds the `docs/BUDGETS.md` provisional values (358 MB JS heap placeholder, 128 MB texture) or the context is lost under load | Measure both backends; switch if Three.js is within budget and the custom path is not |
| 3 | The first real 3D game needs glTF meshes, animation, lighting/shadows, PBR or post-processing | Estimate the custom work; if it would exceed the measured Three.js bundle delta plus integration, adopt Three.js |
| 4 | The bespoke renderer's gzip cost plus planned engine work exceeds Three.js's measured cost for the same scenes | Switch; the interface makes this a renderer-only change |
| 5 | The asset pipeline mandates glTF/KTX2 and the custom loader duplicates Three.js loaders | Adopt the engine rather than rebuild the loaders |
| 6 | A target TV fails WebGL2 (E1) | Three.js would not help; revisit the device target or rely on PC + HDMI / Canvas2D |
| 7 | The P6 open-world showcase is approved (world streaming/LOD) | Re-evaluate against a real engine; the thin renderer is not a world renderer |
| 8 | The host or controller size budget changes materially | Re-run the size comparison before adding any engine dependency |

## Decision record for a future revisit

1. Keep the `Renderer2D` / `Renderer3D` interfaces frozen.
2. Implement the alternative behind them (for example `ThreeRenderer`) without
   changing game or SDK code.
3. Measure the same scene with both backends on the same device: gz, frame p95,
   texture/JS memory.
4. Append the numbers to `docs/RESULTS.md` §E12 and supersede this ADR with a
   new dated decision.

## References

- `docs/RESULTS.md` §E12 — measured desktop rows and PENDING TV row.
- `docs/BUDGETS.md` — size, memory and frame budgets.
- `docs/todos/phase-1-dev/D3-runtime-v0.md` — `D3-RT-02`, `D3-EXP-01`.
- `packages/runtime/src/render/Renderer.ts` — interfaces, feature detection,
  fallback notice.
- `packages/runtime/src/render/WebGL2Renderer.ts`,
  `packages/runtime/src/render/Canvas2DRenderer.ts`.
