# P4 — SDK and Open Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Steps use checkbox syntax.
>
> **Goal:** Freeze the public game API, ship a sample game, document the protocol/SDK and the MIT/brand boundary, clean the repo for external contributors, and prove a clean-machine developer can build a game from the docs alone.
>
> **Architecture:** The public surface is `@lanpad/protocol` (wire), `@lanpad/sdk` (manifest, layout/panel schemas, game API types, sanitizers, filter hook) and `@lanpad/runtime`'s game context. Hosted hub, brand assets, relay operations and the production domain remain outside the MIT grant. Games keep their authors' licenses.
>
> **Tech stack:** npm packages (MIT), TypeScript declaration output, Markdown docs, GitHub CI/templates, semantic versioning.
>
> **Spec:** `SPEC.md` §10, §14 P4, §17.6, §19; FR-10.1–10.4, G8; §22 Q5.
>
> **Program position:** Phase 2, after P3. P5 beta cannot start until the SDK dry run passes; P6 games are built against this frozen API.

## Global constraints

- MIT covers engine, protocol, controller SDK and sample game scaffolding; the brand and hosted hub are not MIT (FR-10.4).
- No API changes after freeze without a version bump and a compatibility note.
- The sample game uses only public packages; no imports from runtime internals or broker.
- Docs must be enough to build, test, and package a game without reading our source.
- No secrets, internal URLs, customer data, or private notes in the public tree.
- iOS remains out of scope (A5).

---

## Stage goal and exit criteria

**Exit criteria (§14 P4):**

> SDK, docs, sample game, open-sourcing, contribution guide.

Concretely:

- [ ] Public API frozen and versioned: protocol v1, manifest schema v1, game API v1.
- [ ] `sdk/sample-game` builds and runs using only public packages.
- [ ] README, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, LICENSE/NOTICE, protocol reference and SDK reference exist.
- [ ] The MIT/brand boundary is explicit.
- [ ] A clean-machine dry run by someone with no repo knowledge succeeds.
- [ ] CI works for external contributors; release/tag process documented.

**Layer coverage**

| Layer | Work items |
|---|---|
| SDK | P4-SDK-01, P4-SDK-02 |
| Docs | P4-DOCS-01, P4-DOCS-02 |
| Infra/ops | P4-OPS-01 |
| QA | P4-QA-01 |

**Goals advanced:** G8 (third-party games), G7 (dependency/license hygiene).

---

## Work items

### P4-SDK-01 — Public API freeze and versioning policy

| Field | Value |
|---|---|
| Layer | SDK |
| Spec | §10, §14 P4; FR-10.3/10.4; G8 |
| Depends on | P3-QA-01, D7-SDK-01 |
| Unblocks | P4-SDK-02, P4-DOCS-02, P6 games |
| Deliverables | `sdk/src/index.ts` public exports, `docs/API-VERSIONING.md`, compatibility tests |

**Freeze**

```md
| Surface | Version | Compatibility rule |
|---|---|---|
| Protocol | 1 | Additive variants only; breaking change = version 2, host rejects mismatched `v` with badVersion |
| Manifest schema | 1 | Additive optional fields only; required-field changes = schemaVersion 2 |
| Layout schema | 1 | Additive control types only; field renames = new type or layout id version |
| Panel schema | 1 | Additive block types only |
| Game API | 1 | Additive optional hooks/context methods only; rename = major |
| Event data | per game | Game-owned; SDK only carries it |
```

**Public exports**

- `@lanpad/protocol`: constants, types, codecs, JSON parse/stringify, limits.
- `@lanpad/sdk`: `GameManifest`, `validateManifest`, `LayoutDocument`, `validateLayout`, `PanelContent`, `validatePanelContent`, `Game`, `GameContext`, `GameEvent`, sanitizers, `ContentFilter`.
- Not public: `broker`, `dev-server`, `relay`, runtime internals (renderer implementations, loop internals).

**Policy**

- Semver: `0.x` until P5 beta; `1.0` at public release.
- Deprecation: announce one minor version ahead, keep for one major.
- The host advertises `PROTOCOL_VERSION`; a mismatch returns `badVersion` (A10).
- Manifests declare `schemaVersion`; missing defaults to 1.
- No runtime feature detection based on package version strings.

**Steps**

- [ ] Define the export lists and add a test that no internal module leaks through `index.ts`.
- [ ] Generate `.d.ts` for the public packages and include them in the release artifact.
- [ ] Write `docs/API-VERSIONING.md` with the table and deprecation policy.
- [ ] Add compatibility tests: a v1 manifest/layout/game module still loads after additive changes.
- [ ] Add a CI check that breaking changes to public types fail without a version constant bump (API extractor or a manual review checklist).
- [ ] Freeze the API and tag `sdk-v0.9.0-beta.1` (1.0.0 at public release after P5).

**Acceptance**

- [ ] Public packages expose only the documented surface.
- [ ] A game built against the frozen types compiles with no internal imports.
- [ ] Version constants and docs agree.
- [ ] A deliberate breaking change fails the review/CI check.

**Tests (tagged)**

- `[G8]` public API is sufficient for a third-party game
- `[FR-10.3]` manifest schema is frozen and versioned
- `[A10]` protocol version mismatch is a distinct error
- `[G7]` public packages list only justified dependencies

**Anti-rework**

- P6 games build against this surface; changing it later is a major version and a migration.
- The sample game is the compile-time proof of the API.

**Risks**

- Freezing too early can lock in a bad shape; P3's hardened surface and D7's four games are the evidence it is ready.
- Declaration generation can expose internal types accidentally; audit.

---

### P4-SDK-02 — Sample game built with public packages only

| Field | Value |
|---|---|
| Layer | SDK/games |
| Spec | §10, §14 P4; G8; §22 Q5 |
| Depends on | P4-SDK-01 |
| Unblocks | P4-DOCS-01/02, P4-QA-01 |
| Deliverables | `sdk/sample-game/` (manifest, layout, entry, test), docs link |

**Scope**

- A tiny button-timing or tap-counter game: one button layout, a score, a results screen.
- Uses `@lanpad/sdk` and the published `Game`/`GameContext` types; no imports from `packages/runtime/src` internals.
- Includes:
  - `game.manifest.json`
  - `layout.json` (button + maybe text)
  - `index.ts` (~30–60 lines)
  - a unit test using the public trace harness or a fake context
  - a README section explaining each file.
- Proves the full path: manifest → registry → layout → input → simulate → render → results.

**Steps**

- [ ] Write the sample with only public imports.
- [ ] Add it to the dev server's registry and play it on a phone.
- [ ] Add a test that runs it with a recorded input trace.
- [ ] Verify its manifest validates and its bundle is under its declared budget.
- [ ] Write the "build your first game" walkthrough around it.
- [ ] Ensure it contains no internal URLs/secrets.

**Acceptance**

- [ ] The sample builds and plays from a clean clone.
- [ ] It imports only public packages (lint/test).
- [ ] Its test runs without a browser.
- [ ] The walkthrough matches the code exactly.

**Tests (tagged)**

- `[G8]` sample game uses only the public SDK
- `[FR-10.3]` sample manifest validates
- `[FR-7.17]` sample game receives only GameContext
- `[G3]` sample game stays within its asset budget

**Anti-rework**

- The sample is the canonical example; keep it small and updated with the API.
- Do not use it to demo advanced panels/canvas; those have docs and proof games.

**Risks**

- A sample that drifts from the API is worse than none; compile it in CI.

---

### P4-DOCS-01 — README, contributing, license boundary and security policy

| Field | Value |
|---|---|
| Layer | Docs |
| Spec | §10, §14 P4; FR-10.4; §19 |
| Depends on | P4-SDK-01/02 |
| Unblocks | P4-QA-01, public release |
| Deliverables | `README.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `LICENSE`, `NOTICE`, `docs/LICENSING.md` |

**Content**

- README: what it is, quick start (dev server, TV, phone), architecture in one diagram, package map, links to spec/SDK docs, license summary, status (beta).
- CONTRIBUTING: setup, test commands, coding standards, PR checklist, commit style, where to ask questions, how to add a game.
- CODE_OF_CONDUCT: standard Contributor Covenant (or a short equivalent).
- SECURITY: how to report vulnerabilities privately, scope, response expectations, no public exploits.
- LICENSE: MIT for the engine/protocol/controller/SDK.
- NOTICE: brand/hosted hub exclusion, third-party asset licenses, game licenses.
- `docs/LICENSING.md`: the exact boundary:
  - MIT: `packages/protocol`, `packages/runtime`, `packages/controller`, `packages/broker`, `packages/dev-server`, `packages/relay`, `sdk/`, sample game.
  - Not MIT: the "vynkzhub" name/logo, the hosted hub, production configs, operational data.
  - Games: each game folder carries its author's license; our proof games are MIT unless noted.
  - Assets: CC0/self-made only; list sources.

**Steps**

- [ ] Write the README with a verified quick start.
- [ ] Write CONTRIBUTING with commands that pass on a clean clone.
- [ ] Add CODE_OF_CONDUCT and SECURITY.
- [ ] Add LICENSE/NOTICE and the licensing boundary doc.
- [ ] Audit assets for licenses; replace anything unclear.
- [ ] Add a PR template with tests/budget/security checkboxes.
- [ ] Link the docs from the repo root and the SDK package.

**Acceptance**

- [ ] A newcomer can run the project from the README.
- [ ] The license boundary is unambiguous.
- [ ] Every asset has a recorded license/source.
- [ ] SECURITY.md has a private reporting path.

**Tests (tagged)**

- `[FR-10.4]` MIT boundary is documented
- `[G8]` contribution guide covers adding a game
- `[G7]` third-party assets are licensed
- `[SR-7]` docs contain no private data/URLs

**Anti-rework**

- Docs are verified against the code; commands are tested.
- License text is not edited piecemeal; the boundary doc is the reference.

**Risks**

- Choosing a code of conduct or license text is a legal-ish decision; use standard texts.
- Brand exclusion must be clear enough for forks to understand what they cannot use.

---

### P4-DOCS-02 — Protocol and SDK reference documentation

| Field | Value |
|---|---|
| Layer | Docs |
| Spec | §7, §8.1, §10, §14 P4 |
| Depends on | P4-SDK-01, D0-PROTO-01..03 |
| Unblocks | P4-QA-01, external developers |
| Deliverables | `docs/PROTOCOL.md`, `docs/LAYOUTS.md`, `docs/GAME-API.md`, `docs/EVENTS.md` |

**Protocol reference**

- Message catalogue with direction, fields, binary layout, sizes, endianness, limits.
- Tick definition (A3), versioning (A10), close codes, error reasons.
- Worked byte examples for Input/InputFwd/Ping/Pong/Haptic.
- Frame caps and rate limits.

**Layout reference**

- Every control type with a JSON example and required/optional fields.
- Coordinate/size rules (percentages vs px), channel uniqueness, bit assignments.
- Debug grid, hot-swap behavior, validation errors.

**Game API reference**

- `Game` lifecycle, `GameContext` members, `InputSnapshot`/`ControllerState`, `GameEvent`, panels/layouts/haptics/audio, seeded RNG, trace testing.
- What games must not do (sockets, DOM, storage).
- Manifest fields and asset budgets.

**Events reference**

- Stroke batching shape, text/choice payloads, rate/size limits, sanitization rules.
- Examples for a guess, a vote, a stroke batch.

**Steps**

- [ ] Write the protocol reference from the code/tests; include golden byte examples.
- [ ] Write the layout reference with all 11 controls and the debug grid.
- [ ] Write the game API reference with a lifecycle diagram.
- [ ] Write the events reference with shapes and limits.
- [ ] Cross-link from README/SDK README.
- [ ] Verify every code sample compiles or is marked pseudo-code.

**Acceptance**

- [ ] Docs match the frozen protocol/layout/game APIs.
- [ ] Byte examples match the golden tests.
- [ ] A developer can implement a client from the protocol doc alone.
- [ ] No internal-only endpoints are documented as public.

**Tests (tagged)**

- `[G8]` protocol/SDK docs are publishable
- `[FR-10.1]` protocol is documented as zero-dependency
- `[FR-8.1]` all control types are documented
- `[FR-7.17]` game API docs prohibit socket access

**Anti-rework**

- Docs are part of the API freeze; changes ride the same version.
- Link to tests as executable examples.

**Risks**

- Docs drift; add a CI link/type check where possible and review with each release.

---

### P4-OPS-01 — Repo hygiene, CI for contributors and release process

| Field | Value |
|---|---|
| Layer | Infra/ops |
| Spec | §10, §14 P4; G7 |
| Depends on | P4-DOCS-01, P4-SDK-01 |
| Unblocks | P4-QA-01, public release |
| Deliverables | cleaned repo, public CI config, `docs/RELEASING.md`, changelog |

**Hygiene**

- Remove internal notes, scratch files, machine-specific paths, tokens, and `.env`.
- Keep `SPEC.md` public (it is a product spec; decide if any section is internal).
- `.gitignore` covers env, build, coverage, logs.
- History scan for secrets; if found, rotate and rewrite history before publishing.
- `docs/RESULTS.md`, `docs/DEVICES.md` may contain personal device names/IPs; redact before publishing or keep in a private repo.
- Decide what stays private: relay ops, cost, threat model details may be private; protocol/SDK/engine public.

**CI**

- External PRs run typecheck/lint/tests/build/size/trace; no secrets required.
- A "good first issue" path and a PR template.
- Nightly (or release) fuzz/soak jobs optional.
- Dependency updates: Dependabot/Renovate with a review policy.

**Release**

- Semver tags: `protocol-v1.x`, `sdk-v1.x`, `runtime-v1.x`, `controller-v1.x` (or a single `v1.x` with package versions).
- Changelog per release; breaking changes called out.
- Publish `@lanpad/protocol` and `@lanpad/sdk` to npm if the SDK is to be consumed outside the monorepo; document install.
- Release checklist: tests, budgets, docs, license, security scan, sample game.
- Keep the hosted hub deployment separate from the OSS release.

**Steps**

- [ ] Run a secret/history scan; clean/rotate.
- [ ] Redact or relocate personal device/network data.
- [ ] Add the public CI workflow and PR template.
- [ ] Write `docs/RELEASING.md` and `CHANGELOG.md`.
- [ ] Configure package metadata (license, repository, files, exports).
- [ ] Do a dry-run `npm pack` of the public packages; inspect contents.
- [ ] Tag the first beta release.

**Acceptance**

- [ ] No secrets/PII in the public tree/history.
- [ ] External CI runs without private credentials.
- [ ] `npm pack` contains only intended files.
- [ ] Release/rollback steps are documented.
- [ ] Changelog matches the tag.

**Tests (tagged)**

- `[G7]` public artifacts contain only justified files/deps
- `[FR-10.4]` license metadata is correct in package.json
- `[SR-7]` no PII/secrets in the public tree

**Anti-rework**

- One release checklist for all packages; no ad-hoc publishing.
- Public/private split is decided once, documented, and enforced by repo boundaries.

**Risks**

- Git history rewriting is disruptive; do it before the repo is public, not after.
- Publishing to npm is irreversible for a version; use `npm publish --dry-run` first.

---

### P4-QA-01 — Clean-machine external developer dry run

| Field | Value |
|---|---|
| Layer | QA |
| Spec | §14 P4; G8 |
| Depends on | P4-SDK-01/02, P4-DOCS-01/02, P4-OPS-01 |
| Unblocks | P5 |
| Deliverables | dry-run report, fixed doc gaps |

**Method**

- Use a clean machine/VM/container with only Node LTS and git (no repo cache, no internal knowledge).
- Follow the README exactly: clone, `npm ci`, build, run dev server, open TV page, join with a phone, run the sample game.
- Then build a *new* tiny game from the SDK docs without reading runtime internals; manifest, layout, entry, test.
- Record every point of confusion, missing command, or hidden dependency.
- Fix docs/code; repeat until a second person can do it without help.

**Steps**

- [ ] Prepare the clean environment; record OS/Node version.
- [ ] Run the quick start; time it; note failures.
- [ ] Build the new game from docs only; note API gaps.
- [ ] Run its test and load it in the dev server.
- [ ] Fix every blocker; add commands/snippets to docs.
- [ ] Repeat with a second person if possible.
- [ ] Record the report and sign off.

**Acceptance**

- [ ] Quick start works on a clean machine without asking questions.
- [ ] A new game is added by folder + manifest + entry, per docs.
- [ ] No internal imports or undocumented flags are needed.
- [ ] The dry-run report has zero unresolved blockers.

**Tests (tagged)**

- `[G8]` external developer can build a game from docs
- `[FR-10.3]` manifest workflow works as documented
- `[G3]` sample/new game respects size budgets
- `[FR-10.4]` license boundary is understood by the tester

**Anti-rework**

- The dry run is repeated for each major SDK release; keep the checklist.
- Doc fixes are part of the release, not a follow-up.

**Risks**

- The tester may unconsciously use internal knowledge; use a real external person if possible.
- Windows/macOS/Linux differences; test at least one clean OS matching the target contributors.

---

## Stage exit checklist

- [ ] P4-SDK-01/02, P4-DOCS-01/02, P4-OPS-01, P4-QA-01 complete.
- [ ] Public API frozen and versioned.
- [ ] Sample game builds with public packages only.
- [ ] Docs and license boundary published.
- [ ] Repo cleaned; CI works for external contributors; release process documented.
- [ ] Clean-machine dry run passes.
- [ ] `docs/RESULTS.md` P4 row complete.

## Handoff to P5

- P5 beta tests the frozen SDK with real users and devices.
- No API changes during beta without a patch/minor release and docs update.
- P6 games are built against this API; no exceptions.

## Explicitly not in P4

- New games (P6).
- Production scaling changes.
- iOS support (A5).
- A visual layout editor (post-v1).
