# Physics contract fixtures

Status: W0 contract data for `@lanpad/engine-physics`. Everything here is
synthetic. **No value in this directory is a measurement.** Counts,
thresholds, positions and shapes are contract examples from
`docs/engine/07-physics3d.md` or deliberately chosen fixture values.

These files are data only: no tests, no solver, no Rapier import, no WASM and
no network access. `tools/engine-test` is the intended consumer once a
physics validator exists; spec 07 §8 assigns the eventual unit cases to
`packages/engine/physics/test/unit/**`. No physics runner exists in W0.

## Files

| File | Purpose |
|---|---|
| `bodies-cases.json` | Body and collider descriptors with expected acceptance, rejection code and mass mode. Covers static, dynamic, kinematic, sphere, box, capsule, trimesh, sensors, compounds, layers, explicit mass and a body without colliders. |
| `raycast-cases.json` | A synthetic world plus ray, `raycastAll` and `sphereCast` cases with expected nearest-hit topology, sensor handling, layer masks, exclusions, disabled bodies, solid-inside distance and trimesh triangle index. |
| `fixed-step.json` | One-step-per-tick cases, host accumulator remainders in tick units, and determinism metadata for solver iterations, substeps, warm starting and the unused seed. |

## Conventions

- `$fixture` names the spec, sections, `"synthetic": true` and
  `"measured": false`. Unknown fields are ignored by the eventual loader.
- `fixtureVersion` is `1`. It is a fixture-shape version, not a physics
  contract version.
- Vectors are JSON arrays: `Vec3` is `[x, y, z]` in metres; `Quat` is
  `[x, y, z, w]`. A harness converts them to engine-core objects.
- Trimesh `vertices` and `indices` are arrays in JSON and become
  `Float32Array` / `Uint32Array` on create. `triangleCount` is
  `indices.length / 3`.
- Masks are u32 values. `4294967295` is all 32 layers.
- There are **no dates** anywhere in this directory. The fixtures are
  contract cases, not run results; an acceptance run records its own build,
  device, browser and date in `docs/RESULTS.md`.
- Percentiles, frame times, heap values, gzip sizes and state hashes are
  absent by design. Every `expectedStateHash` is `null` until a real run
  records it.

## Body cases

`bodies-cases.json` records:

- acceptance and the stage that rejects (`createBody` or `createCollider`);
- the error code where 07 names it, with `errorBasis` distinguishing
  `"explicit"` (the dynamic-trimesh rule names `E_ASSET_FORMAT`) from
  `"inferred-07-5.16"` (generic descriptor validation, where 07 lists the
  possible codes but does not name this case);
- `massMode` (`explicit`, `derived-from-colliders`, `static-infinite`,
  `not-applicable`) and `massKg` only when the descriptor states it.

07 §3.1 requires derived mass and inertia from collider density and volume,
and §5.2 names a `mass.ts` formula module, but **no numeric formula is stated
in the spec**. Derived `massKg` and every `inertia` are therefore `null`
rather than invented. A later spec amendment that states the formulas can
fill them additively.

## Query cases

`raycast-cases.json` fixes the synthetic world inline. The expected values
are topology only:

- which collider is nearest, its sensor flag and `triangleIndex`;
- the ordered collider list for `raycastAll`;
- the contract-mandated distance `0` for a solid ray starting inside a shape.

Points, normals, travel and ordinary distances are not asserted: they are
geometry-dependent and no engine exists to measure them. The harness must
resolve fixture body ids such as `"sphere"` to `BodyHandle` values.

## Fixed-step cases

`fixed-step.json` separates three kinds:

- `step-count`: engine ticks, `world.step()` calls and the resulting `tick`.
  A second call in one tick is included because 07 §3.2 says it is legal
  API-wise but doubles simulated time.
- `host-accumulator`: the world has no accumulator (07 §3.2). `hostFrameTicks`
  is a count of fixed ticks carried by the host loop, so remainders are exact
  decimal tick quantities, not measured seconds.
- `determinism`: full 07 §5.11 replay metadata (`ticks`, `solver`,
  `substeps`, `seed`, `bodies`, `joints`, `inputTrace`,
  `expectedStateHash`). `bodies`, `joints` and `inputTrace` are `null`
  because this wave authors no scene. `seed` is present but unused; 07 §5.11
  states the world has no RNG.

## Not here

- No measured frame times, step times, memory sizes, bundle sizes or
  hardware results.
- No acceptance hashes, vehicle trace, character trace, CCD trace or
  64-box stack. Those are ER-07-02 through ER-07-07 and land with the M1
  implementation.
- No Vitest tests and no `ER-*` trace tags. This wave is contract data only.
- No Rapier types, WASM or implementation code.
