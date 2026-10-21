# Layer: SDK

**Package:** `sdk/` (`@lanpad/sdk`) plus the public API from runtime.
**Owns:** manifest schema/validator, layout schema/validator, panel schema, game API types/docs, config helpers, sanitizers, content-filter hook, sample game.
**Must not own:** runtime internals, broker/relay, controller DOM, brand assets.
**Goal contribution:** G3 (budgets/manifests), G5 (layout capabilities), G7 (lean public surface/dependencies), G8 (third-party games).

## Invariants

1. Public surface only: `@lanpad/protocol` + `@lanpad/sdk` + documented runtime game types.
2. Schemas are versioned; additive changes only within v1 (manifest `schemaVersion`, layout/panel v1).
3. Validators are hand-written and shared by host and controller; no Ajv in the browser path.
4. Sanitizers are the only path for text/image UGC; no HTML.
5. Games depend on the SDK, never on runtime internals or broker.
6. The sample game compiles in CI with public imports only.
7. No brand assets or hosted-hub code in MIT packages (FR-10.4).

## Todo index

| ID | Title | Stage | File |
|---|---|---|---|
| D0-SDK-01 | Manifest + config contract | D0 | `phase-1-dev/D0-foundations.md` |
| D2-LAYOUT-01 | Layout schema union/validator foundation | D2 | `phase-1-dev/D2-controller-v0.md` |
| D3-SDK-01 | Game interface/manifest loader | D3 | `phase-1-dev/D3-runtime-v0.md` |
| D5-SDK-01 | Full layout/panel/UGC validators | D5 | `phase-1-dev/D5-layouts-events.md` |
| D5-SEC-01 | Sanitization/XSS helpers | D5 | `phase-1-dev/D5-layouts-events.md` |
| D7-SDK-01 | Registry/RoundManager/authoring | D7 | `phase-1-dev/D7-proof-games.md` |
| P3-SEC-04 | Content-filter hook | P3 | `phase-2-production/P3-hardening.md` |
| P4-SDK-01 | Public API freeze/versioning | P4 | `phase-2-production/P4-sdk-open-source.md` |
| P4-SDK-02 | Sample game | P4 | `phase-2-production/P4-sdk-open-source.md` |
| P4-DOCS-01/02 | Docs/license/protocol reference | P4 | `phase-2-production/P4-sdk-open-source.md` |
| P6-DOCS-01 | Pack schema/authoring | P6 | `phase-2-production/P6-games-hub.md` |

## Requirement coverage

| Requirement | Where |
|---|---|
| FR-8.1, 8.4 | D2-LAYOUT-01, D5-SDK-01 |
| FR-10.3 | D0-SDK-01, D3-SDK-01, D7-SDK-01 |
| FR-10.4 | P4-DOCS-01 |
| SR-13 | D5-SEC-01, P3-SEC-04 |
| G3 | manifest `assetBudget` + size gate |
| G8 | P4-SDK-01/02 + dry run |

## Verification

- JSON Schema fixtures and hand-written validator agree.
- Layout/panel/filter tests include hostile inputs.
- Sample game compiles/plays with public imports only.
- Clean-machine dry run (P4-QA-01).
- Trace checker covers the requirements above.

## Change rules

- Breaking change = major version + migration note; additive optional fields only within v1.
- A validator rule must be enforced on both host and controller; no one-sided trust.
- No game-specific helper in the SDK; game logic stays in the game.
- Keep the sample game small and compiling; it is the API canary.
