# Asset contract fixtures

Status: W0/W1 contract data for `@lanpad/engine-assets`. Everything here is
synthetic. **No value in this directory is a measurement.** Sizes, counts,
durations and thresholds are contract limits from `docs/engine/06-assets.md`
or deliberately chosen fixture values.

These files are data only: no tests, no loaders, no network access, no worker
code. `tools/engine-test` and later asset validator tests consume them.

## Files

| File | Purpose |
|---|---|
| `manifest-valid.json` | A complete v1 manifest that must be accepted. Covers all six M0-supported kinds (`mesh`, `texture`, `material`, `audio`, `font`, `json`), a texture variant, a hash, `meta`, dependencies and group/initial flags. |
| `format-matrix.json` | Declarative map of the containers, codecs, signatures, texture tokens, vkFormat values, capability requirements and limits 06 accepts. `"measured": false`. |
| `manifest-invalid/*.json` | One violated manifest rule per file. Every file has a `$fixture` object naming the expected code and rule. |

## Conventions

- All manifests use the synthetic game id `example-game` and budget boundary
  values computed from the listed entries. They are not real game budgets.
- `$fixture` and `x-*` keys are **unknown fields**. 06 §4.1 says unknown
  fields are ignored, so their presence does not change acceptance. The valid
  manifest includes them intentionally as coverage of that rule.
- Invalid fixtures contain no query-bearing, cross-origin or parent-segment
  URL that is ever fetched. Validation must reject every one of them before a
  network request, which is the point of the fixture.
- `format-matrix.json` has no dates, no percentile data, no byte measurements
  and no timing values. The numbers it contains are format limits, version
  numbers and capability thresholds.

## Valid manifest arithmetic

`manifest-valid.json` uses exact boundary values:

- initial default sum: `4096 + 524288 + 32768 = 561152` =
  `budget.initialBytes`;
- all default entry bytes: `1415168` = `budget.totalBytes`.

The texture KTX2 variant is additional declared bytes (`131072`) and is not
included in either sum, matching 06 §4.2/§5.4. The variant requires
`compressed-s3tc` and names `bc7-rgba-unorm`.

## Invalid manifest rules

| File | Violated rule | Expected code |
|---|---|---|
| `format-version-unknown.json` | `formatVersion` must be exactly `1`. | `E_ASSET_FORMAT` |
| `missing-format-version.json` | `formatVersion` is required. | `E_ASSET_FORMAT` |
| `missing-budget.json` | `budget` is required. | `E_ASSET_FORMAT` |
| `missing-entry-field.json` | `assets[].url` is required. | `E_ASSET_FORMAT` |
| `budget-initial-over-five-mib.json` | `budget.initialBytes` and the initial asset sum must not exceed `5242880`. | `E_ASSET_BUDGET` |
| `budget-initial-above-total.json` | `budget.totalBytes` must be ≥ `budget.initialBytes` (declaration invariant, nothing would overrun). | `E_ASSET_FORMAT` |
| `budget-total-below-asset-sum.json` | Declared entry bytes (`1000`) exceed `budget.totalBytes` (`999`). | `E_ASSET_BUDGET` |
| `path-parent-segment.json` | No `..` path segment. | `E_ASSET_FORMAT` |
| `path-absolute.json` | Asset URLs are relative, not absolute. | `E_ASSET_FORMAT` |
| `path-scheme.json` | No scheme or host. | `E_ASSET_FORMAT` |
| `path-query-string.json` | No query string. | `E_ASSET_FORMAT` |
| `path-encoded-dot.json` | No percent-encoded dot. | `E_ASSET_FORMAT` |
| `unknown-kind.json` | `kind` must be one of the eight `AssetKind` values. | `E_ASSET_FORMAT` |
| `duplicate-id.json` | Asset ids are unique. | `E_ASSET_FORMAT` |
| `dependency-cycle.json` | Dependencies are acyclic. | `E_ASSET_FORMAT` |
| `url-extension-mismatch.json` | URL extension must agree with the kind/container. | `E_ASSET_FORMAT` |

Schema, URL, id, kind, dependency and declaration-invariant violations reject
with `E_ASSET_FORMAT` (06 §3.7, §4.2 step 6). A manifest whose declared
content or initial set would exceed its declared or capped budget rejects with
`E_ASSET_BUDGET` (06 §3.7, §5.11). Every file records the expected code in
`$fixture.code`; validation happens before any asset fetch.

## Not here

- No real game assets, no binary payloads and no hashes of real files.
- No measured sizes, frame times, memory values or hardware results.
- No Vitest tests and no `ER-*` trace tags; those arrive with the asset test
  wave.
