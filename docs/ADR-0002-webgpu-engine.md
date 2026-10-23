# ADR-0002: Custom WebGPU-first browser engine with a WebGL2 fallback

- **Status:** Accepted. Supersedes [ADR-0001](ADR-0001-renderer.md).
- **Date:** 2026-10-22
- **Decision owner:** engine program (user decision)
- **Scope:** renderer, engine packages, host runtime, games
- **Related:** [`docs/engine/README.md`](engine/README.md), `docs/engine/04-renderer-webgpu.md`, `docs/engine/05-renderer-webgl2.md`, [`docs/RESULTS.md`](RESULTS.md) §E12

## Context

PocketPad is no longer a TV-first 2D platform. The target is a **browser-native game engine** capable of 2D and 3D games, with a Vice City-scale open world as the architectural north star.

The previous decision (ADR-0001) adopted a thin custom WebGL2 renderer with a Canvas2D fallback, chosen on desktop-provisional bundle-size evidence. That decision explicitly listed glTF/GLB, skeletal animation, PBR, shadows, post-processing and world streaming as absent, and required a TV E12 comparison or a dated deferral before large 3D work. Neither exists.

Three.js was evaluated as the 3D foundation and rejected: it is a rendering library, not a game engine, and the product needs control over the whole pipeline — GPU resource lifetime, culling, streaming, render graph, compute, and the frame budget — not a dependency's abstractions.

## Decision

1. **Build a custom engine.** No Three.js, no third-party renderer.
2. **WebGPU is the primary renderer.** WGSL shaders, render pipelines, bind groups, compute where it earns its place, explicit GPU resource lifetime, device-loss recovery.
3. **WebGL2 is the compatibility tier**, behind the same backend contract. It ships a reduced feature set, not feature parity: fewer lights, no compute culling, simplified shadows/post. A game declares the minimum tier it needs; the host shows a clear failure screen if no available backend meets it.
4. **Canvas2D remains a 2D-only fallback.** It is never a 3D fallback and never a place to hide a missing 3D feature.
5. **Shaders are authored once in WGSL** for WebGPU. The WebGL2 tier gets a written GLSL equivalent with its reduced feature set; the two are not kept in lockstep feature-for-feature.
6. **The renderer contract stays backend-agnostic.** `Renderer2D`/`Renderer3D` (or their successor `RenderBackend`) are the game-facing surface; the WebGPU and WebGL2 implementations are separate packages behind it.

This ADR does **not** decide physics (custom vs Rapier behind `Physics3D`), cross-origin isolation (COOP/COEP), or the content strategy for the open-world proof. Those are separate decisions in the engine program.

## Consequences

Positive:

- Full control of the frame, GPU resources, culling, streaming and the render graph — the layers a Vice City-class game needs.
- One engine, one contract; games do not depend on a backend.
- WebGL2 keeps older Chromium targets alive with a clear feature floor.
- No third-party engine dependency or upgrade cadence.

Negative:

- The WebGPU backend is new code: device/pipeline core, WGSL library, resource lifetime, device-loss recovery, testing rig.
- The WebGL2 tier is a second implementation with a deliberate feature gap; it must be tested separately.
- The TV/WebGPU support matrix is unverified; E12 must be re-run on target hardware.
- The engine's bundle grows; the host budget is ample, but the controller budget must not absorb renderer code.

## Feature tiers (initial)

| Feature | WebGPU | WebGL2 | Canvas2D |
|---|---|---|---|
| 2D primitives/text | yes | yes | yes |
| Textured lit mesh | yes | yes | no |
| PBR materials | yes | simplified | no |
| Shadows | cascaded | basic/none | no |
| Post-processing | yes | reduced | no |
| GPU compute culling | yes | no | no |
| Skeletal animation | yes | reduced | no |
| World streaming | yes | yes (lower budget) | no |

## Revisit triggers

1. A target TV/browser lacks WebGPU **and** the WebGL2 tier cannot meet a game's declared minimum.
2. WebGPU device loss or driver instability is not recoverable within the frame budget.
3. The WebGL2 tier's maintenance cost exceeds its user value on the target matrix.
4. A measurement shows the custom pipeline missing the frame budget where a proven engine meets it.

## References

- [`ADR-0001-renderer.md`](ADR-0001-renderer.md) — superseded WebGL2-first decision, kept for history.
- [`docs/ENGINE.md`](ENGINE.md) — the current implementation.
- [`docs/engine/README.md`](engine/README.md) — engine program, tiers and wave plan.
- [`docs/RESULTS.md`](RESULTS.md) §E12 — measured rows; TV/WebGPU rows PENDING.

