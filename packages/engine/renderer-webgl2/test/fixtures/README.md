# WebGL2 backend fixtures

Status: contract-wave data. These files are synthetic fixtures, not evidence
and not measurements. No frame time, memory, tier or adapter value here was
read from a device.

## Files

| File | Spec | Purpose |
|---|---|---|
| `capability-cases.json` | 05 §3.3, §4.8 | Synthetic limit/extension sets mapped to the expected tier and exact `EngineFeature` set (ER-05-05). |
| `texture-format-map.json` | 05 §4.4 | Every canonical core `TextureFormat` token mapped to its WebGL2 internalformat, required extension, or `unsupported`. |
| `abi-parity.json` | 04 §4.3, 05 §4.3 | The two ABI-1 layouts plus the attributes and layout ids Tier B must reject at creation. |

## Consumption

These fixtures are consumed by the shared engine verification rig
(`tools/engine-test`, spec 19) and by the first implementation wave's tests:

- `capability-cases.json` feeds the pure `classifyWebGL2` tests; the
  `classify` contract is `src/contracts/webgl2.d.ts`.
- `texture-format-map.json` matches `WebGL2TextureFormatMap`; a
  `Record<TextureFormat, …>` makes a missing or invented token a type error.
- `abi-parity.json` feeds the shared render-contract conformance lane; 04 is
  canonical and 05 is aligned to it (REVIEW.md conflict 1).

No Vitest test, conformance suite or `ER-*` tag is added in this contract
wave, so nothing reads these files yet. The first tagged test adds the
`ER-05-*` traceability rows in the same change (REVIEW.md RV-09).

## Rules

- `expected.features` in `capability-cases.json` is the **exact** feature set;
  array order is not significant.
- `texture-format-map.json` uses only the 19 canonical tokens owned by 04
  §4.5; it never introduces a second format union.
- `bgra8unorm` is listed as `unsupported` because it is the WebGPU swapchain
  format, not a Tier B format.
- ABI-1 rejection is `E_CONTRACT` at resource creation, never at draw time.
- Timestamps are deliberately absent. If a future schema needs one, it must
  be an ISO-8601 UTC string, and it still must not be presented as a
  measurement.
