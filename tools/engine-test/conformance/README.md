# Conformance suites

Status: W0/T1 skeleton. This directory holds the conformance-suite **data**
format for the engine verification rig. The runner is Node-only: it needs no
browser, GPU or Chrome, and it is not acceptance evidence. The browser
conformance lane (spec 19 §5.9) lands later.

## Files

- `example.suite.json` — synthetic example. It is not a measurement, not a
  fixture the engine must pass, and not evidence.
- Real suites are authored beside the fixtures they exercise. Shared renderer
  case data lives in `packages/engine/core/test/conformance/`.

## Suite file format

```json
{
  "formatVersion": 1,
  "kind": "engine-conformance-suite",
  "suiteId": "render-device",
  "cases": [
    {
      "suiteId": "render-device",
      "id": "clear-writes-drawing-buffer",
      "kind": "render-contract",
      "input": { "format": "rgba8unorm" }
    }
  ]
}
```

| Field | Rule |
|---|---|
| `formatVersion` | Exactly `1` (`CONFORMANCE_SUITE_FORMAT_VERSION`) |
| `kind` | Exactly `"engine-conformance-suite"` |
| `suiteId` | `^[a-z0-9][a-z0-9-]{0,63}$` |
| `cases` | Non-empty array; case ids unique within the suite |
| `cases[].suiteId` | Same pattern; must equal the suite `suiteId` |
| `cases[].id` | `^[a-z0-9][a-z0-9-]{0,63}$`; unique in the suite |
| `cases[].kind` | `math-projection`, `math-quat-order`, `scene-lifecycle`, `tick-order`, `render-contract` |
| `cases[].input` | Required; any finite JSON value (`{}` when unused) |
| `cases[].skip` | Optional boolean; only `true` skips |
| `cases[].reason` | Required when `skip` is `true`; non-empty, at most 280 characters |

Unknown fields are ignored so a suite can gain optional fields without a
version bump. Known fields are strict. A suite with zero cases is rejected:
an empty suite would pass vacuously, which is the failure mode this rig exists
to prevent.

`loadSuite` throws `ConformanceSuiteError` with a stable `code` and a JSON
`path`:

| Code | Cause |
|---|---|
| `E_CONFORMANCE_JSON` | Root is not a plain JSON object |
| `E_CONFORMANCE_FORMAT_VERSION` | `formatVersion` is not `1` |
| `E_CONFORMANCE_KIND` | `kind` is not `engine-conformance-suite` |
| `E_CONFORMANCE_SUITE_ID` | Missing or malformed `suiteId` |
| `E_CONFORMANCE_CASES` | `cases` missing, not an array, or empty |
| `E_CONFORMANCE_CASE` | Case is not an object, or a field has the wrong basic type |
| `E_CONFORMANCE_CASE_SUITE_ID` | Case `suiteId` missing, malformed, or not equal to the suite id |
| `E_CONFORMANCE_CASE_ID` | Missing or malformed case id |
| `E_CONFORMANCE_CASE_KIND` | Unknown case kind |
| `E_CONFORMANCE_CASE_INPUT` | `input` missing or not a finite JSON value |
| `E_CONFORMANCE_CASE_DUPLICATE` | Two cases share an id |
| `E_CONFORMANCE_SKIP_REASON` | `skip: true` without a reason, or a malformed reason |

## Running cases

`runConformance(suite, implementations, options)` takes a map of
implementations keyed by case id. An implementation receives the case `input`
and returns either a boolean or `{ pass: boolean, message?: string }`. A
thrown error fails the case; it is not a harness crash. A missing or
non-callable implementation fails the case with `E_CONFORMANCE_MISSING` in the
failure message — it is never counted as skipped.

- Cases run and are reported in declaration order. Two runs over the same
  suite and implementations produce equal results.
- `cases` is the total; `passed + failed + skipped === cases`.
- `pass` is true only when `failed === 0`. An explicit `skip` with a reason
  does not fail the suite; a missing implementation does.
- `skipped` is incremented only for `skip: true` with a non-empty reason. A
  hand-built skip without a reason fails the case with
  `E_CONFORMANCE_SKIP_REASON`; the loader rejects such a suite before it runs.
- `options.onCaseResult` observes every case in order (used later by the CLI
  run log). It receives `{ suiteId, id, kind, status, message }`.

The returned object is the §3.2 `ConformanceSummary` shape, exported as both
`ConformanceResult` and `ConformanceSummary`. It carries no version field of
its own; the §4.6 `CONFORMANCE_REPORT_VERSION = 1` applies when a case-level
report is written separately.

## Contracts and fixtures

The runner imports no engine package. An implementation closes over whatever
object it is testing, so the runner works before the contracts exist.

When the core contracts land, the intended import path is
`packages/engine/core/src/contracts/renderDevice.d.ts`, re-exported by the
`@lanpad/engine-core` package entry. Shared case fixtures belong in
`packages/engine/core/test/conformance/`; spec 19 §5.9 names the Vitest
wrapper `packages/engine/core/test/contract/renderDevice.conformance.test.ts`,
which consumes those fixtures. The `math-projection` and `math-quat-order`
kinds exist to pin 02 §3.1 (right-handed, +Y up, -Z forward, column-major;
WebGL depth z in [-1, 1], WebGPU depth z in [0, 1]) and the quaternion
component order, the gap recorded as RV-05 in `docs/engine/REVIEW.md`.

## Not implemented here

The CLI executable, Chrome/CDP launcher, browser runner, golden-image diff,
bench and determinism orchestration are deliberately absent. The CLI is not
scaffolded because a stub that cannot run a command would be less honest than
no entry point. Add them behind spec 19 §5.1 when the browser rig lands.

## Wiring

This package still needs root wiring owned by the integration agent:

- `package-lock.json` must record the workspace (run `npm install`; not done here).
- Root `tsconfig.json` needs `{ "path": "./tools/engine-test" }`.
- Root `vitest.config.ts` needs `nodeProject("tools/engine-test")`; without it
  `npm test` and the package `test` script do not run these tests.
- `docs/todos/TRACEABILITY.md` needs the `ER-19-*` rows before the tags in
  `test/conformance.test.ts` are gate evidence (REVIEW RV-09).
