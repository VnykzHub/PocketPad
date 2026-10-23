# Engine-core conformance fixtures (W0)

These files are **data**, not tests. Nothing in `packages/engine/core/test` executes them.
They are consumed by the engine conformance runner under `tools/engine-test/conformance/**`
(RV-05) once the matching engine-core implementation exists in W1.

| Fixture | Spec | Covers |
|---|---|---|
| `math-projection.json` | 02 §3.6 | Perspective and orthographic matrices for both clip conventions, plus `lookAt` depth direction |
| `math-quat-order.json` | 02 §3.7 | `quatMultiply(a,b) = a*b` order and vector images |
| `scene-lifecycle.json` | 03 §3.1–3.7 | Entity creation, enable filter, destroy and generation reuse, query order |
| `tick-order.json` | 01 §3.7 | The seven-step host tick order |

Rules:

- Values are hand-computed from the named spec formulas, never pasted output of an
  implementation and never measured hardware results.
- Every fixture carries `formatVersion: 1` and `synthetic: true`.
- Changing a fixture is a **contract change**. Update the owning spec or record an
  amendment in `docs/todos/README.md` in the same change; do not edit a value to make
  an implementation pass.
- Entity ids in `scene-lifecycle.json` are runtime-local. The fixture asserts the
  allocator's documented reuse behaviour, not a stable persisted id.
