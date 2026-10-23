# WebGPU backend contract fixtures

These files are **contract data**, not tests. No test runner executes them in
the contract wave; they are consumed later by the shared conformance suite
under `tools/engine-test/conformance/**`.

They are not measurements. Every value is defined by the spec and is marked
`synthetic: true`; nothing here was produced by running a GPU or a browser.

| Fixture | Spec | Covers |
|---|---|---|
| `vertex-layouts.json` | `docs/engine/04-renderer-webgpu.md` §4.3 | `static-pbr-v1`, `instanced-transform-v1`, byte offsets and strides, the u16/u32 index rule |
| `pipeline-keys.json` | §4.8, Appendix C | canonical key field order, cache-hit and miss relations, descriptor-change isolation, defines-order equivalence, cache limits |
| `texture-formats.json` | §4.5, §5.2 step 4 | all 19 ABI 1 format tokens, their `EngineFeature` and WebGPU feature gates, render-target restrictions |

## Rules

- `formatVersion` is `1`. A change to a fixture's shape or meaning is a
  contract change and needs the spec updated in the same change.
- `synthetic` is always `true`. Never add a measured value to these files;
  measurements belong in `docs/RESULTS.md`.
- Pipeline key serialization is **not frozen** (§4.8). Cases assert whether
  two descriptors produce the same key and whether the cache hits; they never
  assert a literal canonical string or hash.
- `source` cites the spec section that owns each fixture. If a fixture and the
  spec disagree, the spec wins and the fixture is the bug.
