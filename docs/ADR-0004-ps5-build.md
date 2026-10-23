# ADR-0004: PS5-style build program — contracts, tiers and defaults

- **Status:** Accepted (Wave 0, 2026-10-23).
- **Decision owner:** user brief [`docs/todos/BUILD-BRIEF.md`](../todos/BUILD-BRIEF.md); recorded by the Wave 0 owner.
- **Scope:** launcher, game-facing world/assets/kit contracts, controller budget, dev TLS, asset curation, physics for Babylon scenes.
- **Related:** [ADR-0003](ADR-0003-engine-base.md), [`docs/engine/22-world3d-api.md`](engine/22-world3d-api.md), [`23-assets-audio.md`](engine/23-assets-audio.md), [`24-game-kit.md`](engine/24-game-kit.md), [`25-console-shell.md`](engine/25-console-shell.md), [`DESIGN.md`](../DESIGN.md), [`decisions.dm`](../decisions.dm).

## Context

The Babylon host spike (B1) proved the engine base but the game-facing surface is still only `setCamera`/`drawCube`; assets, audio and a shared game lifecycle are not wired. The build brief freezes those contracts in a serial Wave 0 before ten streams fan out.

## Decisions

The user's defaults D1–D8 are accepted unchanged:

| ID | Decision |
|---|---|
| D1 | **Physics for Babylon scenes — outcome: Rapier.** The initial default was Havok-first with the vehicle test deciding. Stream H measured both: Havok 1.3.14 is MIT (675,471 B gz total), Rapier 0.21.0 is Apache-2.0 (~1.21–1.64 MB gz). Rapier is already the contract-complete backend and measured comparable or better (faster 0–50 km/h, more slalom travel with less roll, drop/wall pass, deterministic); both fail a 0.3 m walking step-up. **Rapier stays behind `Physics3D`; the character controller's blocked-state sinking must be fixed before a shipping character.** Havok would need a Babylon-coupled adapter and a hand-written vehicle. |
| D2 | **Game tiers:** every game ships a Minimal tier on the current Canvas2D/primitive path first, then a Full tier with Babylon and curated assets. Draw and Guess, Bluff Quiz and Spy in the Room stay 2D; Babylon is used only for the launcher backdrop. |
| D3 | **Launcher motion:** amend `DESIGN.md` with a console-shell tier (focus scale, ≤8px parallax, accent glow, backdrop crossfade). Full tier on capable devices; reduced tier when `prefers-reduced-motion` or a low-tier device; input is never delayed by motion. |
| D4 | **Controller budget:** dev target rises from 40 KB to 50 KB gzip; the 60 KB hard cap stays. |
| D5 | **Phone sensors over HTTPS:** opt-in TLS mode in the dev server (cert paths from env or mkcert), a documented tunnel option, and one `npm run play` that builds, starts, prints the join URL and QR. No production hardening claimed. |
| D6 | **Audio format:** keep OGG Vorbis only if a decode smoke test passes in Chrome, Firefox and Safari; otherwise curate to Opus. |
| D7 | **Asset curation:** nothing loads from `Game-assets/`. A curation tool copies a size-budgeted subset to `assets/`, optimises GLBs and writes `LICENSES.csv`; the validator rejects any asset without a ledger row. The unlicensed palms stay out until licence evidence (URL + date) is recorded. |
| D8 | **Missing assets:** no tank, weapon, engine-loop or song. Use primitives or recoloured vehicles, a synthesised engine sound, and a self-made or CC0 track. |

### Wave 0 contract clarifications (not new user decisions)

1. **`ctx.world` naming.** The existing additive `GameContext.world?: WorldStreamer` (spec 12) is renamed to `ctx.streaming?: WorldStreamer`. `ctx.world` becomes the game-facing 3D world API in spec 22. No game consumes the streamer today, so this is a contract rename recorded before first use; spec 12, spec 18 and the SDK projection are updated in the same change.
2. **`@lanpad/game-kit`** is a new workspace package that depends on `@lanpad/sdk` only. It is not imported by the runtime, controller or engine packages.
3. **`assets.json`** is an optional per-game file next to `game.manifest.json`; absence means no assets. `GAME_ASSETS` in the stage is deleted when stream B lands.
4. **Presentation fields** are additive manifest fields validated by the SDK; a manifest without them still validates and the launcher generates a gradient/monogram fallback.

## Consequences

- Ten streams can work against specs and fakes without touching shared contracts.
- The controller budget gains ~9 KB of headroom; the hard cap is unchanged.
- `ctx.world` is unavailable on 2D-only hosts and on the custom engine path until a world backend exists; games must feature-detect `ctx.world === undefined`.
- Havok is a try-first, not a commitment; A15 Rapier remains the fallback until stream H's measured recommendation.
- **D1 outcome (2026-10-23): Rapier.** Stream H's measured comparison supports the existing A15 backend; Havok's licence is fine but it would add a Babylon-coupled adapter, a hand-written vehicle and no contract-complete event/query surface. The character controller's blocked-state sinking is a known defect to fix before a shipping character. Evidence: [`docs/RESULTS.md`](RESULTS.md) § "Havok vs Rapier physics spike".
- No hardware rows close in this ADR; every device measurement remains PENDING until run.

## Reopen conditions

- Havok's licence or WASM size fails the check, or the vehicle test favours Rapier.
- The 5 MiB boot budget would be breached by the world/assets streaming design.
- A frozen contract needs a breaking change; that requires a new amendment before implementation.
