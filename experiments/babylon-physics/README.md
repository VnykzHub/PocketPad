# Babylon physics spike — Havok vs Rapier (stream H)

Date: 2026-10-23. Branch: `ws/h-physics`. Status: experiment complete; no
`docs/`, `TRACEABILITY.md`, `packages/engine/physics/**` or ADR edit is part
of this stream.

## Goal

Implement one small seam twice — Babylon 9.32.0 with **Havok**
(`@babylonjs/havok` 1.3.14 + Babylon's `HavokPlugin`) and with **Rapier**
(`@dimforge/rapier3d-compat` 0.21.0, plus the shipping
`@lanpad/engine-physics` adapter) — and compare:

- one drivable 4-wheel car with steering, acceleration and braking;
- one character controller over a step / drop / wall course.

Both backends receive the same descriptors and scripted inputs. Also measured:
licence, exact package bytes, boot time, physics cost, frame cost,
determinism and API gaps against the frozen `Physics3D` contract (spec 07,
A15). The deliverable is evidence and an integration seam, not a game.

Non-goals: target-hardware acceptance, netcode, a tuned racing model, and
"fixing" the character step by weakening the scenario.

## How to run

```bash
cd experiments/babylon-physics
node scripts/run.mjs                          # havok + rapier at 1920x1080 and 1280x720
node scripts/run.mjs --engine=havok           # one engine
node scripts/run.mjs --engine=rapier --size=1280x720
node scripts/run.mjs --no-build               # reuse dist/
node scripts/run.mjs --engine=havok --probe   # Havok step-up cast diagnostics
node scripts/size.mjs                         # licence + exact bytes only
npx vitest run --root ../.. --project experiments babylon-physics/test/poseBridge.test.ts
```

The runner builds `dist/` with Vite, serves it with COOP/COEP/CORP, drives one
headless Chrome per run over CDP, and writes `results.json` (or
`results-partial.json` for a filtered run), `size-report.json` and
`screenshots/*.png`. Chrome is found from `%ProgramFiles%` or `CHROME_PATH`.
`--probe=1` (via `--probe`) sets `globalThis.__PHYSICS_DEBUG__` and wraps two
private Havok character-controller methods; it is off for all numbers below.

The page selects `?engine=havok|rapier` and imports only that engine's module
dynamically, so a Havok run never downloads Rapier's 4 MB bundle and boot
numbers are not contaminated by the other engine.

## Measurement environment (label)

Headless Chrome 155 (`--headless=new`) via CDP; WebGL2 through ANGLE/D3D11 on
an NVIDIA GeForce RTX 3050 Ti Laptop GPU (see `environment.renderer` in
`results.json`). This is **not** a software rasteriser. Viewport 1920x1080 or
1280x720, `deviceScaleFactor` 1, isolation headers on the static server.

These are behaviour and relative-cost numbers on **one desktop GPU**, not
target-hardware acceptance. TV, phones, WebGPU, long-running memory and
8-controller load are `PENDING`. Frame numbers include one unchanging showcase
scene with 501 draw calls, not a game.

## Licence and exact bytes

`scripts/size.mjs` reads the installed packages; the stop rule ("if the
licence is not permissive, stop and report") was **not** triggered.

| package | version | declared licence | licence file | licence SHA-256 |
|---|---|---|---|---|
| `@babylonjs/havok` | 1.3.14 | MIT | `node_modules/@babylonjs/havok/LICENSE` (first line `# MIT License`) | `d8b00cac49e55c3e93840e02868989c73520e50a865dfbd25b9d20d35397ccf0` |
| `@dimforge/rapier3d-compat` | 0.21.0 | Apache-2.0 | `node_modules/@dimforge/rapier3d-compat/LICENSE` (first line `Apache License`) | `4c05555705e3efde601fb1252ae48f1d63992af8a8fb8947745b7fa834e8f519` |

Exact file bytes (gzip level 9, from `size-report.json`):

| group | file | raw bytes | gzip bytes |
|---|---|---:|---:|
| Havok | `lib/esm/HavokPhysics.wasm` | 2,094,563 | 662,067 |
| Havok | `lib/esm/HavokPhysics_es.js` (ESM glue) | 67,400 | 13,404 |
| Rapier | `dist/rapier.mjs` (compat bundle, WASM inlined) | 4,340,292 | 1,644,109 |
| Rapier | `dist/rapier_wasm3d_bg.wasm` (standalone) | 3,082,103 | 1,175,669 |
| Rapier | `dist/rapier_wasm3d.js` (standalone loader) | 342,560 | 34,702 |

The host + game boot budget is 5 MiB gzip. Shipping one engine at a time:
Havok adds **675,471 B gz** (WASM + glue); the Rapier compat bundle adds
**1,644,109 B gz**, or **1,210,371 B gz** if the host serves the standalone
WASM instead of the inlined bundle. Both fit; Rapier leaves about 1.0 MB gz
less headroom in inline mode. The spike's own Vite build emitted the Rapier
chunk at 1,662,809 B gz and the Havok WASM at 662,067 B gz.

Upstream Havok terms: the installed package declares MIT and ships that
LICENSE; legal should still confirm the redistribution terms for Microsoft's
Havok WASM before production.

## Results (one desktop GPU, headless Chrome)

### Boot and behaviour

| metric | Havok | Rapier |
|---|---:|---:|
| WASM init (ms) | 31.7 | 29.9 |
| first world, cumulative from physics start (ms) | 47.4 | 36.1 |
| navigation → ready (ms) | 452.5 | 486.6 |
| car 0–50 km/h (s) | 2.700 | 2.617 |
| car speed at 10 s (km/h) | 122.66 | 125.61 |
| car distance at 10 s (m) | 206.92 | 212.56 |
| car max roll (deg) | 1.35 | 1.41 |
| car upright throughout | yes | yes |
| slalom peak yaw rate (deg/s) | 64.2 | 66.6 |
| slalom lateral range (m) | 23.74 | 35.90 |
| slalom max roll (deg) | 3.4 | 0.6 |
| 0.3 m step climbed | **no** | **no** |
| step end position | (0, 0.95, −1.667) | (−0.002, 0.834, −1.699) |
| step blocked ticks | 55 / 105 | 54 / 105 |
| 2 m drop landed | yes, tick 100 | yes, tick 104 |
| drop fall ticks / peak fall speed | 28 / 6.069 m/s | 31 / 5.886 m/s |
| drop end y (m) | 0.952 | 0.897 |
| wall slide | yes (x 2.121, z −2.401) | yes (x 2.108, z −2.449) |
| determinism, 240 ticks, two fresh worlds | identical (`34a1f02f`) | identical (`d7d66da3`) |

Car, slalom and character outcomes are identical between 1080p and 720p runs;
the resolutions only change rendering cost. The car comparison is "hand-rolled
Havok raycast suspension" vs "Rapier's built-in raycast vehicle" with
identical wheel descriptors and inputs. Havok's plugin exposes no vehicle
controller in the JS API.

### Cost at 500 dynamic boxes

| metric | Havok 1080p | Rapier 1080p | Havok 720p | Rapier 720p |
|---|---:|---:|---:|---:|
| physics p50 / p95 / p99 (ms) | 0.255 / 0.31 / 0.44 | 0.295 / 0.47 / 0.585 | 0.275 / 0.50 / 0.57 | 0.325 / 0.585 / 0.66 |
| step + render p50 / p95 (ms) | 3.135 / 5.79 | 2.165 / 3.535 | 2.37 / 4.915 | 2.605 / 4.815 |
| frame interval p50 / p95 (ms) | 8.33 / 8.525 | 8.335 / 8.495 | 8.335 / 8.515 | 8.335 / 8.52 |
| fps from interval | 119.2 | 119.5 | 118.9 | 120.0 |
| draw calls | 501 | 501 | 501 | 501 |

300 measured physics steps after 180 warmup steps; 235 frame samples after 60
warmup frames. Both engines are far inside the 14 ms frame target in this
scene, and the renderer dominates the step + render figure. Rapier's physics
step is ~0.16 ms (p95) slower in this 500-body pile.

## Behaviour findings and API gaps

1. **Havok character step-up fails.** Babylon's `PhysicsCharacterController`
   (`maxStepHeight = 0.35`, default `keepDistance = 0.05`) runs only two of its
   three casts (up, forward) and returns `-1`. Its forward fraction is backed
   off by `keepDistance / horizontalDistance = 0.05 / (2 / 60)`, which clamps
   to zero before the down cast. Lowering `keepDistance` to 0.0167 lets all
   three casts run, but the forward probe then advances only 0.0167 m and the
   down cast misses the 0.3 m step's top edge. No `keepDistance` value works
   for this 0.3 m curb / 0.3 m radius / 2 m/s / 60 Hz geometry. The character
   is spawned at y = 0.95 because at exactly 0.9 the up cast starts inside the
   ground; Babylon's controller only settles to the 0.05 m keep-distance gap
   after a landing.
2. **Rapier character step-up also fails, for a different reason.** The
   shipping adapter configures `enableAutostep(0.35, sqrt2 * radius, false)`,
   but while blocked the character sinks ~0.066 m (contact at y ≈ 0.834), so
   the 0.3 m step becomes an effective ~0.366 m, just above the 0.35 m limit.
   The same sinking shows in the drop test (end y 0.897 vs Havok 0.952). This
   is an adapter defect/limitation in `packages/engine/physics`; that package
   is outside stream H's ownership, so it is reported, not edited.
3. **Havok is Babylon-scene-bound.** The plugin installs on a Babylon `Scene`
   (`HavokPlugin`), and this spike disables `scene.physicsEnabled` and calls
   the private `plugin._step(1/60)` for an explicit, deterministic step. A
   `Physics3D` backend built on Havok would therefore live inside the Babylon
   adapter and would need its own handle lifetimes, event mapping, state hash
   and vehicle implementation. Rapier's adapter is already Babylon-free and
   covers the contract.
4. **Descriptor conventions differ.** Havok `PhysicsShapeBox` takes full
   extents; `PhysicsMassProperties.inertia` is per unit mass (I/m). The spike
   doubles half extents and uses unit inertia. Rapier's adapter takes half
   extents directly.
5. **Callbacks are limited.** Havok has no built-in contact/trigger event
   stream matching `drainContactEvents`/`drainTriggerEvents`; a contract
   adapter would have to build one. Rapier's adapter already implements both.
6. **Wall metric caveat.** The scenario marks a tick `hitWall` when achieved
   horizontal movement is below 50% of requested. Havok's controller slides at
   ~71% of the requested diagonal speed, so it never trips the threshold
   (`hitWallTicks = 0`) even though it is visibly blocked and sliding; Rapier's
   controller reports `hitWall` directly (71 ticks). Same outcome, different
   metric source.
7. **Private API in diagnostics only.** The `--probe` path wraps
   `_tryStepUp`/`_castWithCollectors`. It is diagnostic and is not part of the
   measured runs.

## Integration seam delivered

`packages/runtime/src/physics3d/index.ts` (owned by this stream):

```ts
const bridge = createPhysicsPoseBridge(world); // world: Physics3D
bridge.bind(bodyHandle, node);                // node: { position, rotationQuaternion? }
bridge.stepAndSync(1 / 60);                   // step, then copy poses
bridge.unbind(bodyHandle);
bridge.dispose();
```

- **No Babylon import.** `PoseTarget` is structural (`position` plus optional
  writable `rotationQuaternion`), which a Babylon `TransformNode` satisfies.
  The runtime Babylon boundary test (`ER-21-08`) still passes; a test under
  `packages/runtime/src` would be emitted to `dist`, so the bridge tests live
  in `experiments/babylon-physics/test/`.
- **No per-tick allocation.** Each slot owns one `BodyState`; `sync()` calls
  `readBody(handle, out)` and copies numbers. No `map`/`filter`.
- **Generational safety.** Bindings match on `index` + `generation`. Destroyed
  bodies are pruned during `sync()` with swap-pop (backwards iteration, so no
  neighbour is skipped), and a reused slot index replaces the stale binding on
  `bind`.
- **Rotation rule.** Rotation is written only when the target already has a
  non-null quaternion. Assigning a plain object to a Babylon node's
  `rotationQuaternion` would break `computeWorldMatrix`, and writing euler
  `rotation` needs a different API; euler-only nodes sync position-only.
- **Ownership.** `dispose()` drops bindings only; the world and nodes stay
  caller-owned. Further `bind`/`sync`/`stepAndSync` throw after dispose;
  `dispose` is idempotent.
- **Validation.** `stepAndSync(dt)` delegates to `world.step(dt)`, so the
  world's `dt === fixedDt` check remains the single authority.

11 Vitest cases pass: position/quaternion copy, accessor-backed writes,
position-only targets, null quaternion, rebind, exact-handle unbind, destroyed
body pruning with swap-pop, reused slot index, `stepAndSync` with gravity,
`dt` rejection, dispose idempotence and world independence.

No trace tag is attached to these tests: stream H has no requirement ID in
`docs/todos/TRACEABILITY.md`, and an invented ID would fail `npm run trace` as
unknown.

## Recommendation

**Rapier behind `Physics3D` for Babylon scenes**, conditional on fixing the
blocked-state sinking in the character controller. This agrees with the merged
`CLAUDE.md` product decision; ADR-0004 D1 says "Havok first, with the vehicle
test deciding". The ADR was not edited; the conflict is reported for the owner.

Why Rapier:

1. It is already the backend: one adapter covers bodies, colliders, joints,
   vehicles, characters, queries, events, `readBody` and `stateHash`. Havok
   would require a new Babylon-coupled adapter plus a hand-written vehicle.
2. Measured behaviour is comparable or better: 0–50 km/h in 2.617 s vs 2.700 s,
   no rollover, more slalom travel (35.9 m vs 23.7 m) with less body roll
   (0.6° vs 3.4°); drop and wall pass.
3. It is deterministic in this matrix (identical hashes across two fresh
   worlds), as is Havok.
4. Licence is permissive (Apache-2.0). It costs ~1.0 MB gz more than Havok in
   the inlined bundle, or ~0.53 MB gz more with standalone WASM; the 5 MiB
   budget has room.
5. The measured physics penalty (p95 0.47 ms vs 0.31 ms per 500 bodies) is
   small next to the 16.67 ms step budget and the render cost in this scene.

Pick Havok instead only if Babylon's scene-level integration is worth a
Babylon-bound backend and a hand-rolled vehicle. Either way, **0.3 m curbs at
walking speed must work before the engine ships a character controller**;
Havok's step-up has a geometry/speed limitation here, Rapier's is a fixable
sinking defect.

## PENDING / not measured

- TV, phone, integrated-GPU, WebGPU and 4K runs — `PENDING`.
- Long-running memory, 8 controllers, production bundling/minification —
  `PENDING`.
- Rapier standalone-WASM transfer in the actual host — byte-measured here,
  not loaded by the host.
- Character step-up fix in `packages/engine/physics` — not attempted
  (outside ownership); the spike records the failure.
- Havok redistribution/legal review of upstream terms — `PENDING`.

## Files

- `src/constants.js` — shared engine-neutral descriptors and scenario numbers.
- `src/engines/havok.js` — Havok backend: boxes, raycast car, character,
  explicit `_step`, optional probe.
- `src/engines/rapier.js` — Rapier backend over `@lanpad/engine-physics`.
- `src/scenarios.js` — car acceleration, slalom, character step/drop/wall,
  determinism, 500-box benchmark, showcase.
- `src/render.js`, `src/main.js` — Babylon scene, engine selection, report on
  `window.__SPIKE__`.
- `scripts/run.mjs` — Vite build, static server, CDP runner, JSON + screenshots.
- `scripts/size.mjs` — licence and byte report.
- `test/poseBridge.test.ts` — bridge tests against a real Rapier world.
- `results.json`, `results-partial.json`, `size-report.json`,
  `screenshots/*.png` — the evidence behind the tables above.
