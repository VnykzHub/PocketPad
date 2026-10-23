# Checkpoint — Wave 0 contracts (2026-10-23)

**Branch:** `feat/babylon-engine`.
**Gate:** `npm run check` exit 0 — 269 test files / 2,995 tests; controller 40,794 / 51,200 B gz; host 614,816 / 3,145,728 B gz; trace 0 unknown.

## Shipped

| Item | Evidence |
|---|---|
| Build brief saved | `docs/todos/BUILD-BRIEF.md` |
| ADR-0004 (D1–D8 accepted as defaults) | `docs/ADR-0004-ps5-build.md`; `decisions.dm` entry |
| Spec 22 — `ctx.world` | `docs/engine/22-world3d-api.md`; `sdk/src/world3d.ts` |
| Spec 23 — assets/audio | `docs/engine/23-assets-audio.md`; `sdk/src/assets.ts`, `sdk/schema/game-assets.schema.json` |
| Spec 24 — game kit | `docs/engine/24-game-kit.md` (stream F implements) |
| Spec 25 — console shell | `docs/engine/25-console-shell.md`; `presentation` in manifest type, validator and schema; `DESIGN.md` console-shell tier |
| Streamer rename | `ctx.world?: WorldStreamer` → `ctx.streaming`; `ctx.world?: GameWorld3D` (ADR-0004 clarification 1) |
| Headless test kit | `@lanpad/sdk/testing` → `createFakeWorld`, `createFakeInput`, `createFakeAudio`, `createFakeAssets`, `createFakeContext` |
| Glob registration | `tools/game-registry.mjs`; dynamic Vitest game projects; template game appears in the launcher DOM with zero root edits |
| `npm run play` | root script: build all, then start the dev server (prints URLs + QR) |
| Opt-in TLS | `LANPAD_TLS_CERT` + `LANPAD_TLS_KEY`; HTTPS banner warning; unit tests |
| Controller budget | dev 40,960 → 51,200 B (D4); hard 61,440 unchanged |
| Flaky deadzone | signed-zero ordering fixed in `radialDeadzoneInto`; deadzone 0 is now bit-exact |
| Babylon override | `?babylon-backend=webgl2` only works with `?debug=1` |
| Babylon context loss | WebGL2 lost + restored in Chrome; 3 draw calls, 0 errors, non-blank screenshot |
| Template game | `packages/games/template-game/` — manifest, layout, entry, tsconfig, test; no root-file edit |

## Contract clarifications recorded

1. The spec-12 streamer member moved to `ctx.streaming`; `ctx.world` is the spec-22 3D world. No game consumed the old name.
2. `assets.json` is optional per game; absent means no assets.
3. `presentation` is optional; existing manifests validate unchanged.
4. `@lanpad/game-kit` is a new package depending on `@lanpad/sdk` only.

## Open / PENDING

- WebGPU context loss is PENDING; only the WebGL2 loss path was exercised.
- Phone-as-remote launcher events are not yet emitted by the controller; E is adding the `remote` event mapping to the host contract.
- Real GLB→AssetContainer loading in the host is Node-tested only; browser evidence is PENDING.
- `lowTier` is not passed to the launcher (no classifier exists); reduced motion still follows the OS preference.
- Launcher player chips use synthesized P1..P8 identities; game-kit identity wiring is a follow-up.
- TLS was unit-tested but not exercised with a real certificate on a phone.
- `npm run play` was run end to end on 2026-10-23: build completed, the server printed the LAN URL/QR, `/healthz` returned 200, then it was stopped.
- The template game is a Wave 0 fixture; retire it once a real game proves registration.
- Hardware rows (phones, TV, gyro, haptics) remain PENDING.

## Next

Wave 1: streams A (Babylon world), B (assets/audio), C (curation), F (game kit) start in parallel; G (host integration) after A and B; D/E/H next. Merge order per the brief.

## Wave 1 merges

| Stream | Branch / commit | Evidence |
|---|---|---|
| F — `@lanpad/game-kit` | `ws/f-game-kit` → merged; integration wires `tsconfig`, Vitest and the lockfile | 79 package tests; sample 184 lines; whole gate 278 files / 3,074 tests, 0 unknown |
| C — asset curation | `ws/c-asset-curation` → merged; root wiring committed | 32 CC0 files, 1,936,734 B raw / 740,904 B per-file gzip; 15 tests; Chrome OGG decode PASS, Firefox/Safari PENDING; gate 281 files / 3,089 tests |
| B — assets/audio runtime | `ws/b-assets-audio` → merged | 50 asset/audio tests with real GLB/OGG fixture bytes; host boot 623,121 B gz; gate 285 files / 3,120 tests |
| A — Babylon world | `ws/a-babylon-world` → merged | 68 tests + official ER-22-01 fake conformance; WebGPU 3.865 ms / WebGL2 3.185 ms p95 at 1280×720 headless, 0 errors; ER-22-05 allocation PENDING; host boot 712,199 B gz |
| I — Sumo Bumpers (Minimal) | `ws/i-sumo-bumpers` → merged | 26 tests; 2–8 players; dash + hit haptics in the default layout per the brief, overriding the older plan's Full-only note (accepted); PERF-01 PENDING; gate 289 files / 3,209 tests, host 720,931 B gz |
| J — Snake Royale (Minimal) | `ws/i-snake-royale` → merged | 50 tests; 32×32 grid, 2–8 players, d-pad, shrink/food/grace; PERF-01 PENDING |
| L — Beat Tap (Minimal) | `ws/i-beat-tap` → merged | 60 tests; 4 lanes, timing windows, calibration, 1–4 players; chart is self-made CC0, audio cue absent/silent; PERF-01 and real audio PENDING |
| K — Bomb Defusal (Minimal) | `ws/i-bomb-defusal` → merged | 34 tests; procedural wires/button/keypad, private manuals, solvability over 10,000 seeds; 2–8 players (plan/product cap; the prompt's 2–4 was too narrow); PERF and hardware PENDING |
| D — console launcher | `ws/d-console-launcher` → merged via G's branch after a revert/re-apply; host wiring in G | 69 tests; 1920×1080 screenshots (start, 4/13 tiles, empty, 8-player lobby, loading, reduced); backdrop-cost ≤4 ms PENDING |
| G — host integration | `ws/g-host-integration` → merged | Assets/audio + Babylon world wiring, launcher lifecycle/deps, phone/gamepad launcher input, real 4-bot e2e; Babylon loader moved inside `src/babylon` to restore ER-21-08 |
| E — controllers/input | `ws/e-controllers` → merged | 501 controller tests + 50 bot tests; launcher remote layout, gyro calibration, steering/tap-tempo/haptics, reconnect/UGC flows, QA probe; controller 40,923 / 51,200 B gz |
| Host launcher smoke | real Chrome, 2026-10-23 | `.console-shell` + live room code + seven tiles (Beat Tap, Bomb Defusal, Coin Run, Reaction Duel, Snake Royale, Sumo Bumpers, Template Game); Engine Cube hidden without `?debug=1` |
| Trace tooling — game IDs | `GAME-…` prefix registered; 37 merged-game rows added | `tools/trace-check` recognizes the prefix; stage trace 0 unknown, 44 deferred; gate 308 files / 3,353 tests |
| D — console launcher | `ws/d-console-launcher` in flight | UI-only, independent of A/B |
| I — Sumo Bumpers (Minimal) | `ws/i-sumo-bumpers` in flight | Flat 2D, game-kit + SDK fakes |
| J — Snake Royale (Minimal) | `ws/i-snake-royale` in flight | Flat 2D, game-kit + SDK fakes |
| K — Bomb Defusal (Minimal) | `ws/i-bomb-defusal` in flight | Panels + flat 2D |
| L — Beat Tap (Minimal) | `ws/i-beat-tap` in flight | Chart + flat 2D |

Concurrency note: D and four Minimal games started before A/B/G because Wave 0 and the game kit were already green and those streams touch disjoint paths. G (shared host wiring) still waits for A and B.
