# PocketPad — Autonomous Engine Log

**Directive (2026-10-22):** resume and keep working until the engine is complete; run subagents in parallel; no questions for 8 hours; record every path choice here.
**Session mode:** autonomous. This file is the audit trail: append an entry whenever a choice is made.

## Standing decisions

| ID | Decision | Source |
|---|---|---|
| D-001 | Custom **WebGPU-first** renderer; WebGL2 is a **reduced-feature** fallback; Canvas2D is 2D-only; **no Three.js** — superseded by D-008 for the engine base | ADR-0002; user 2026-10-22 |
| D-002 | **Rapier** behind a `Physics3D` interface; custom physics only if a measured need appears | User 2026-10-22 |
| D-003 | Retire D0–P6 stage gating for the engine track; the phone/room platform stays frozen and maintained separately | User 2026-10-22; audit |
| D-004 | Enable **COOP/COEP** cross-origin isolation in W0 | User 2026-10-22 |
| D-005 | Specs before implementation; each contract spec also lands a `.d.ts`, a conformance suite, a fixture with a numeric budget, and an ownership manifest | Audit; program README §7.1 |
| D-006 | One writer per file; parallel inside a wave; every wave ends with `npm run check`; never weaken a test | CLAUDE.md |
| D-007 | No invented measurements; TV/Android rows stay PENDING | CLAUDE.md |
| D-008 | **Babylon.js 9.32.0 is the engine base** (A19, ADR-0003). WebGPU first, WebGL2 fallback; custom engine packages frozen, not deleted; manifest gains additive `"babylon"` | User 2026-10-23; ADR-0003 |

## Log

### 2026-10-22 — resume after pause

- **State:** HEAD `b214c51`; 23 uncommitted entries; 12 engine specs written (`00,01,02,04,05,07,09,11,12,13,16,17`); missing `03,06,08,10,14,15,18,19` and `REVIEW.md`; dev server stopped.
- **Chose:** resume the stopped spec workflow from run `wf_b6430fb8-f11` rather than restart it. Cached agents replay; only missing specs and the review run.
- **Chose:** keep the four answered decisions (D-001…D-004) and write them into the program docs after the specs land.
- **Chose:** start with the audit's W0 items while the spec workflow runs; do not start implementation from prose specs.
- **Next:** finish specs → review → record decisions → W0 (all-stage trace, `main.ts` split, GPU rig, COOP/COEP, dependency audit) → contracts/conformance → W1.

### 2026-10-22 — W0 progress

- **Trace:** every stage D0–D7 exits 0. The full Gate matrix (no `--stage`) fails on unimplemented capability IDs C3–C10, as expected. **Chose:** `npm run trace` now runs D0–D7; added `trace:gate` for the full matrix. The Gate matrix stays red until the engine capabilities exist — no green-wash.
- **Dependencies:** `npm audit --omit=dev` finds 0 vulnerabilities; the 3 advisories are dev-only. **Chose:** no `npm audit fix --force` (breaking); record and revisit in W4.
- **Isolation:** added `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, and `Cross-Origin-Resource-Policy: same-origin` to every dev-server response. **Chose** enabling now (D-004); routes tests 9/9 pass.
- **Specs:** resumed the stopped workflow; 12 of 19 specs exist, missing `03,06,08,10,14,15,18,19` and `REVIEW.md`.
- **Parallel W0:** launched a `main.ts` split agent and a GPU-rig agent; both are disjoint from the spec files.
- **Next:** contracts/conformance once specs land → W1 foundations.

### 2026-10-22 — amendments recorded

- **Chose:** use the amendment IDs the specs already reserved — **A14 = browser-native engine reframe**, **A15 = physics engine replacement (Rapier)** — and shift the remaining decisions to **A16 host input, A17 engine gating, A18 cross-origin isolation**. Verified no spec had claimed A16–A19 (`Grep \bA1[6-9]\b` → no matches).
- **Wrote:** A14–A18 into `docs/todos/README.md` §1. A14 names the renderer decision and supersedes ADR-0001; A15 names the Rapier license (Apache-2.0) and defers the exact version pin and WASM-size measurement to W2 integration, because neither exists yet and inventing them would violate D-007.
- **Wrote:** a precedence banner at the top of `SPEC.md` so its TV-first prose cannot override A14–A18; the wire protocol, budgets and phone/room contract are explicitly unchanged.
- **Updated:** `docs/engine/README.md` §9 from "open decisions" to recorded decisions; `CLAUDE.md` product decisions, trace command and physics layer row.
- **Observed:** `docs/engine/03-scene-ecs.md` has appeared; the resumed spec workflow is still producing the missing specs.
- **Next:** wait for `REVIEW.md`, then freeze the contracts (`.d.ts` + conformance + fixture + budget + ownership) before W1 code.

### 2026-10-22 — 402 outage, top-up, restart

- **Failure:** all seven remaining spec agents and both W0 agents died with **402 Insufficient Balance** (`deepseek-flash`). Partial outputs still landed: specs `06,08,10,11,12,13,14,18` were written between 22:26 and 22:37; `03` completed; **15, 19 and `REVIEW.md` are missing**. The runtime split left seven orphan `src/host/*` modules with `main.ts` untouched; the GPU rig left only `probe.js`.
- **User action:** topped up the balance and said "use agent".
- **Chose:** relaunch four **disjoint** agents — spec 15 (save/load), spec 19 (testing/benchmarks), GPU rig completion, and `main.ts` split completion. No repo-wide builds inside agents; each runs only scoped checks. Contracts and `REVIEW.md` wait for their return.
- **Chose:** the main thread resolves the known **renderer ABI conflict** between specs 04 and 05 (attribute locations and texture-format tokens) before any contract is frozen. A shared conformance suite is impossible while the two specs disagree.
- **Watchdog:** the scheduled check remains active; this entry is the restart point after the outage.

### 2026-10-22 — renderer ABI conflict resolved

- **Conflict:** spec 04 defined ABI-1 `static-pbr-v1` as position 0, normal 1, uv 2, instance matrix 3–6, and explicitly deferred tangents/skinning. Spec 05 defined a superset with tangent 2, texcoord 3, color 4, joints 5, weights 6, texcoord_1 7, instance matrix 8–11. The shared conformance suite could not exist while both were "canonical". Texture tokens also disagreed (`rgba8unorm` vs `rgba8`, `rgba16float` vs `rgba16f`, `depth24plus` vs `depth24`).
- **Chose 04 as canonical** because 04 owns `RENDERER_ABI_VERSION` and 05 already said the tokens are owned by 04. Aligned 05 to exactly the two ABI-1 layouts and moved skinned/morph layouts to future new layout ids with an ABI bump, never shifted locations.
- **Chose one texture vocabulary:** expanded 04's `TextureFormat` with `rgba32float`, `rgb10a2unorm` and the compressed tokens (`s3tc-*`, `etc2-*`, `astc-*`, `bptc-rgba`) that its feature flags already referenced; 05 now maps those exact tokens to WebGL2 internal formats and marks `bgra8unorm` unsupported on Tier B. This is a pre-freeze contract change; no code exists.
- **Next:** resolve `ComponentType` ownership (00 §3.2 assigns it to 01/04; 03 defines it as the ECS registration contract), then write `REVIEW.md` once specs 15 and 19 land.

### 2026-10-22 — ownership and cross-spec checks

- **Fixed:** 00 §3.2 no longer assigns `ComponentType` to 01/04; spec 03 owns the ECS registration contract. This matches 03's explicit ownership note and removes the only duplicate definition.
- **Verified:** `Renderable` is defined once, in 03 (`mesh`/`material` asset ids, `visible`, `layer`); 04/05 do not declare a parallel component. 18's SDK exposes `query` only (disabled entities excluded); `queryAll` stays engine-internal, so pooled objects cannot leak into game queries.
- **Verified:** 02 fixes right-handed 3D, −Z forward, column-major matrices, and two projection families (`mat4PerspectiveWebGL2` z∈[−1,1], `mat4PerspectiveWebGPU` z∈[0,1]) with a matching `clip` argument for culling. Downstream specs reference 02 rather than restating it; the conformance suite must include a handedness/depth invariant test so a mismatch fails loudly.
- **Pending review items:** 01's host tick step 7 (`scene.updateWorldTransforms()`) needs the runtime integration point; 05's dependency list was truncated in the workflow report; 15 must not persist runtime-local `Entity` ids.

### 2026-10-22 — scene encoder ownership

- **Conflict:** 04 assigned the "scene encoder" to spec 03; 03 assigned extraction/sorting to the renderer (04/05); neither spec actually defines an encoder. The renderer cannot resolve asset ids because it must not import the assets package (zero runtime deps).
- **Chose:** the **runtime composition root owns the scene encoder** (`packages/runtime/src/engine/sceneEncoder.ts` in the M0 migration). It queries `Renderable`, resolves ids through spec 06's `AssetLibrary`, sorts by layer/material/mesh and submits low-level draws. Backends execute draws and never import assets; spec 03 stays data-only.
- **Wrote:** corrected 04 §5.4 step 2, 03 §5.11's render-path row, and 05's stale dependency table (04/01/02/03/16 are written; ABI reconciled). Rephrased 05's "TV-first" to "primary TV backend" per A14.
- **Next:** `REVIEW.md` when specs 15 and 19 land; then freeze the core contracts (00/01/02/03) first, since their interfaces are now stable.

### 2026-10-22 — contracts layout and dependency hygiene

- **Finding:** ten specs still marked already-written dependencies as "not written". This is stale status, not design. **Chose:** delegate a status-only normalization agent (owns only the dependency cells in 04, 06, 09, 10, 11, 12, 13, 16, 17, 18; leaves 15/19 as pending; no prose changes).
- **Chose the contracts layout:** a contract is a `.d.ts` module in the owning package (`packages/engine/<pkg>/src/contracts/<name>.d.ts`), re-exported from the package entry. Runtime constants live in a `.ts` module beside it and must match the declared type. Conformance suites live under `tools/engine-test/conformance/**` and import package entries only; fixtures sit beside the suite or in the owning package's `test/fixtures/`.
- **Why:** contracts must compile and be importable by the conformance suite; putting `.d.ts` files in `docs/` would need a tsconfig path hack and would not be built. `docs/engine/README.md` §7.1 was clarified to match this.
- **Next:** REVIEW.md once 15/19 land; then freeze core contracts and start W1 foundations.

### 2026-10-22 — spec 19 landed

- **Done:** `docs/engine/19-testing-benchmarks.md` (827 lines, ER-19-01…16, all PENDING). It defines the result JSON, golden manifest, replay and suite formats; CLI exit codes 0/1/2/3; the shared conformance runner; red-rig-blocks-wave policy; golden-update safety; artifact redaction.
- **Chose `tools/engine-test/**` as the canonical rig path**, not `tools/bench/`. Spec 16 §5.1 still assigns `tools/bench/` to 19; that is a stale ownership row and will be corrected once the dependency-status agent releases file 16 (one writer per file).
- **Trace:** the `ER-\d+-\d+` grammar is not accepted by `tools/trace-check` yet. The spec correctly requires the grammar, `TRACEABILITY.md` rows and the first tagged tests to land atomically; tagging before that would turn `npm run trace` red. This is an integration task, not a spec edit.
- **Still open:** spec 15 (save/load) is the only missing spec. `REVIEW.md` follows it.

### 2026-10-22 — GPU rig verified on real hardware

- **Done:** `tools/gpu-rig/` completed and run headless on this machine (Chrome 155.0.8059.85, NVIDIA RTX 3050 Ti Laptop, `headless=new`). Real results, not fabricated: WebGPU hash `cd0a1f0b`, WebGL2 hash `781faf16`, `drawCalls: 1`, 256×256, `stable: true` on repeat runs. A missing golden exits 1, as required.
- **Chose:** record both hashes in `tools/gpu-rig/golden.json` with adapter/Chrome metadata. They are machine-dependent by design; a mismatch on another adapter is not automatically a renderer regression.
- **Integration:** regenerated `package-lock.json` for the new `@lanpad/gpu-rig` workspace; `npm ci --dry-run` exits 0. The 3 dev-only advisories are unchanged; no `--force` fix.
- **Honest limit:** this is a triangle smoke test, not a frame-time, memory or TV measurement. W0's CI-golden criterion is met only once the rig runs in CI; the local run is evidence, not a CI gate.

### 2026-10-22 — all specs exist; ER trace grammar landed

- **Done:** spec 15 (save/load, 973 lines, ER-15-01…14) and spec 19 (testing/benchmarks, 827 lines, ER-19-01…16) landed. Every numbered engine document 00–19 now exists; `REVIEW.md` is the only missing program artifact.
- **SaveHeader:** 15 correctly kept 00's frozen FNV-1a 32 in-file hash instead of silently switching to SHA-256; SHA-256 is optional slot metadata, and an in-file change would need A19 + format v2. M0 is the header codec only; SaveStore/OPFS/IDB are M1+.
- **Trace:** added `ER-\d+-\d+` to `tools/trace-check` (ID regex, prefix order, `idParts` ordering) plus a canonical-row/tag fixture test. `tools/trace-check` 16/16, build green, D0 exit 0. ER rows remain Gate-audited (like A/G/E/C) and are not required by D0–D7 stage runs.
- **Open additive requests from 15:** add `version?: string` to the game manifest (18); add `E_SAVE_GAME`, `E_SAVE_QUOTA`, `E_SAVE_IO`, `E_SAVE_MIGRATION`, `E_SAVE_SLOT`, `E_SAVE_UNSUPPORTED` to 00's `EngineErrorCode`; reconcile 12's claim that 15 embeds the CSTR payload (the engine payload stays opaque).
- **Next:** close those three, fix 16's stale `tools/bench/` ownership row, then write `REVIEW.md` and freeze contracts.

### 2026-10-22 — REVIEW.md written; contracts unblocked

- **Done:** `docs/engine/REVIEW.md` — inventory of all 20 specs (17,615 lines), 10 resolved conflicts, 10 open findings with owners, contract-freeze order. Verdict: implementation-ready **for contracts**, not for unchecked implementation.
- **Resolved in the review:** renderer ABI 1, texture vocabulary, `ComponentType`, single `Renderable`, `query`/`queryAll` boundary, runtime scene encoder, math conventions, frozen save header + new error codes, `ER-*` trace grammar.
- **Open and assigned:** RV-01 game `version?` (18), RV-02 `tools/bench` → `tools/engine-test` (16), RV-03 CSTR wording (12), RV-04 tick step 7 runtime adapter, RV-05 handedness conformance test, RV-06 shared golden, RV-07 root engine workspace config, RV-08 swapchain format, RV-09 `ER-*` traceability rows, RV-10 storage adapters stay in runtime.
- **Chose:** wait for the dependency-normalization agent to release files 12/16/18 before applying RV-01/02/03 (one writer per file). Meanwhile, core contract work (00/01/02/03) is unblocked and does not touch those files.
- **Next:** launch the T0 core-contract stream (package scaffold + `.d.ts` + conformance fixtures) with root config owned by the integration agent.

### 2026-10-22 — review findings closed; host split complete

- **Host split:** `packages/runtime/src/main.ts` went from 1,296 to 47 lines; 16 `src/host/*` modules, no behavior change. Scoped evidence: `tsc -b packages/runtime`, test tsconfig, eslint, and **377/377 runtime tests** pass; Vite build succeeds. Residual risk: the real renderer/GameHost launch path is not exercised by jsdom; a manual smoke run is recommended, not claimed.
- **Closed RV-01/02/03:** 18 now has optional `version?: string` (1–32 UTF-8 bytes, used by saves); 16 §5.1 now names `tools/engine-test/` (no `tools/bench/`); 12 now says the game/runtime stores the opaque CSTR payload and 15 never parses it. Spec 19's path-conflict note records the reconciliation.
- **Closed all stale dependency statuses:** the normalization agent fixed 44 cells; a follow-up closed the remaining 15/19 "pending" rows now that both specs exist.
- **In flight:** T0 `packages/engine/core` contracts and `tools/engine-test` conformance runner, both package-local. Root workspaces/tsconfig/Vitest/eslint wiring stays with the integration agent after they land.

### 2026-10-22 — watchdog: T0 first files

- **Changed:** `tools/engine-test/` now has `package.json`, `tsconfig.json`, `tsconfig.test.json` and `src/schema.ts` (9.2 KB). `packages/engine/core/` has no files yet; its agent is still reading.
- **Chose:** do not add either package to root `tsconfig.json`/`vitest.config.ts` or the workspace glob until both agents report complete. A half-written project reference would make `npm run typecheck`/`npm test` red, violating the green-tree rule.
- **Next:** on completion, wire `packages/engine/*` into workspaces, add project references and Vitest projects for core + engine-test, regenerate the lockfile, then run `npm ci`/`npm run check`. After that, freeze renderer contracts (04/05).

### 2026-10-22 — conformance runner wired; gate caught core lint

- **Done:** `tools/engine-test` is in the root tsconfig references and Vitest projects. 14/14 tests pass, eslint is clean, `npm run trace` exits 0 with **ER 2/2**, lockfile refreshed, `npm ci --dry-run` exits 0.
- **Fixed:** the conformance tests were tagged `ER-19-10`; spec 19 assigns that to allocation and `ER-19-11` to shared conformance. Renamed the seven tags, added `ER-19-01` and `ER-19-11` rows to `TRACEABILITY.md` §10.1 under `W0-CONTRACTS`.
- **Gate attempt:** ran full `npm run check` as a baseline. Typecheck passed, then lint failed on the in-flight core package: `packages/engine/core/src/contracts/engine.d.ts:86:22 — 'T' is defined but never used`. Sent the exact error to the owning agent; did not edit its file concurrently. Test/build/size/trace did not run in that invocation, so **W0 is not green yet**.
- **Next:** on the core agent's report, add `packages/engine/core` to the root tsconfig/Vitest/workspaces, regenerate the lockfile, and rerun the full gate.

### 2026-10-22 — watchdog: core lint fixed, fixtures landing

- **Changed:** the core agent fixed the unused `T` by making `JobPayload<T> = unknown | T` (a documented phantom use; `unknown | T` is still `unknown`, so the payload contract is unchanged). `npx eslint packages/engine/core` exits 0. The package typechecks under both `tsconfig.json` and `tsconfig.test.json`.
- **Fixtures on disk:** `math-projection.json`, `math-quat-order.json`, `scene-lifecycle.json`, `tick-order.json`. The package is still in flight — no final report, and `test/conformance/README.md` / a render-contract fixture are not present yet.
- **Chose:** do not add the `packages/engine/*` workspace glob or root project reference until the agent reports. Adding them now would pull a mid-write package into `npm run build --workspaces` and could break the green tree.
- **Next:** on report, wire the workspace + tsconfig + Vitest project, regenerate the lockfile, and rerun `npm run check` from the top.

### 2026-10-22 — core contracts integrated; full gate green

- **Green gate:** `npm run check` exits 0 with **136 test files / 1,595 tests**, build, size and every trace stage D0–D7 clean (0 missing, 0 unknown, ER 2/2). Controller bundle 40.79 kB gz against the 40.96 kB dev budget.
- **Integrated:** `packages/engine/core` is in the workspace glob, root tsconfig references and root Vitest projects. Lockfile regenerated; `npm ci --dry-run` exits 0. Core contract tests 10/10 after the additions.
- **Contract/spec deltas:** added `E_SCENE_FORMAT` and `E_FRAME_CLOSED` to 00 §5.9 and the contract; aligned 01's `JobPayload<T>` phantom with the frozen contract; added `supportedFormats` to `RendererCapabilities` in 04 and the contract. REVIEW now has 13 resolved items and RV-11…RV-13 open.
- **Blocked, not bypassed:** the engine-layer ESLint boundary could not be added because the config-protection hook forbids `eslint.config.js` edits. **Chose** a source-level import-boundary test in W1 instead of disabling the hook (RV-12). Existing lint is green.
- **W0 is not complete:** only core has contracts. The renderer (04/05), assets (06), input (10) and save (15) contract wave is now running as five package-local agents. W0 exits only when those land, are wired, and the gate is green again.
- **Next:** integrate each package (tsconfig/Vitest/lockfile), add the source-level boundary test, rerun the full gate.

### 2026-10-22 — watchdog: save fixture verified, five contracts landing

- **Save agent output on disk:** `src/contracts/save.d.ts`, `src/index.ts` export, `test/save/fixtures/header-v1.{hex,json,bin}` and `test/save/README.md`. Independent verification (not the agent's claim): `header-v1.bin` is exactly **85 bytes**, magic `PPSV`, `headerBytes` 56, `payloadBytes` 29, stored `payloadHash` `0x635f8bc4`, and FNV-1a over the payload bytes alone is also `0x635f8bc4`; payload is `demo-payload:seed=1;tick=3600`.
- **Renderer/assets scaffolds:** `packages/engine/renderer-webgpu`, `renderer-webgl2` and `assets` now have package.json/tsconfig; input is still in its read phase. No reports yet.
- **Chose:** no root wiring or full gate while five agents are writing. The workspace glob already covers new engine packages, so adding package references mid-write would pull partial packages into build/typecheck.
- **Next:** on each report, add tsconfig/Vitest entries, refresh the lockfile once, run the full gate, and close W0 contracts.

### 2026-10-22 — WebGPU agent partial; resumed

- **Partial:** the WebGPU agent wrote `package.json`, both tsconfigs and `scripts/copy-contracts.mjs`, but the Fact-Forcing Gate interrupted it before the contract, version, index and four fixtures. It handed back a complete design.
- **Chose:** resume the same agent with the drafted design instead of rewriting from scratch. Its decisions are sound: the canvas comes from `Surface.native` (not options), `restore`/listeners stay on core `RenderDevice`, the factory returns `WebGpuDeviceInitResult` with `device`, and pipeline-key fixtures assert equality rather than literal key strings.
- **Recorded:** REVIEW resolved item 14 and open RV-14 (pipeline-key canonicalization), RV-15 (BPTC feature token), RV-16 (factory return shape in 04).
- **Next:** finish WebGPU, collect the other four reports, then wire all packages and run the gate.

### 2026-10-22 — save contract complete; spec arithmetic fixed

- **Delivered:** `packages/engine/core/src/contracts/save.d.ts` plus the 85-byte `header-v1.bin`, `.hex`, decoded `.json` and README. Scoped checks pass: `tsc -b`, test tsconfig, core tests **10/10**, eslint clean.
- **Independently verified:** 85 bytes, magic `PPSV`, header 56 / payload 29, `payloadHash` `0x635F8BC4`, FNV-1a over payload matches, payload ASCII matches. The agent's extra SHA-256 matches 15 §4.10.
- **Spec fix:** 15 §4.9 printed `1667197892` as the decimal of `0x635F8BC4`; the correct value is **1667206084** (Node-verified). Corrected both occurrences. Also replaced the stale "request six codes from 00" sentence and marked the 00/18 integration rows done.
- **Recorded:** REVIEW resolved item 15; open RV-17 — the save constants are type-only in `save.d.ts` until W1 adds a runtime constants module.
- **Next:** WebGPU (resumed), WebGL2, assets and input contracts; then one integration pass.

### 2026-10-22 — both renderer contracts complete; factory shapes unified

- **WebGPU:** 11 files, scoped `tsc`/eslint/`node --check` exit 0; fixtures cover ABI-1 layouts, 12 pipeline-key cases and all 19 texture tokens. No core type is redeclared. It uses a temporary `paths` mapping to core `dist` because the workspace link does not exist until `npm install`.
- **WebGL2:** 13 files, scoped checks exit 0 using a transient `node_modules/@lanpad/engine-core` junction (removed immediately). It records 9 ambiguities, including that `WebGL2Capabilities` must extend core `RendererCapabilities`, `maxSamples` must clamp to `1 | 4`, and BPTC has no `EngineFeature` token.
- **Chose one factory shape:** made core `DeviceInitResult<T>` generic with `device`; WebGPU returns `WebGpuDeviceInitResult` and WebGL2 returns `WebGL2DeviceInitResult`, each narrowing backend/capabilities. Updated 04 §3.6, 05 §3.2 and both contracts. Recorded as REVIEW resolved 16/17.
- **Open:** BPTC feature token (RV-15); pipeline-key canonicalization (RV-14); assets and input contracts still running.
- **Next:** on the last two reports, run `npm install`, remove the WebGPU `paths` workaround, add all project references/Vitest entries, and run the full gate.

### 2026-10-22 — assets contract complete; error codes unified

- **Assets:** 8 deliverables, 18 synthetic fixtures (1 valid manifest, 16 invalid cases, format matrix), 5 runtime version constants. Scoped `tsc`/eslint/`node --check` exit 0; no `any`; no implementation.
- **Core gap fixed:** 06 used five additive `E_ASSET_*` codes (`NOT_READY`, `UNKNOWN`, `ABORTED`, `UNSUPPORTED`, `EVICTED`) that `EngineErrorCode` did not declare. Added them to 00 §5.9 and core; `AssetErrorCode` is now a pure `Extract` from core, not a parallel union.
- **06 fixes:** step 6 now classifies format vs budget vs fetch failures instead of blaming everything on `E_ASSET_FORMAT`; added the injectable `fetch?: typeof globalThis.fetch` option the contract uses.
- **Verified:** core rebuild, assets typecheck, core tests **10/10** after the changes.
- **Remaining:** input contract is the last agent. Then one integration pass: `npm install`, remove temporary `paths`/junction workarounds, add project references and Vitest entries, full gate.

### 2026-10-22 — five foundation contracts integrated; gate green; final T0 wave

- **Integrated:** `packages/engine/{core,renderer-webgpu,renderer-webgl2,assets,input}` are all in the workspace, root project references and Vitest projects. `npm install` created the links; the temporary `paths` overrides were removed from all three package tsconfigs; root `tsc -b` exits 0.
- **Gate:** `npm run check` exit 0 with 136 test files / 1,595 tests, build, size and every trace stage clean. Controller 40,794 / 40,960 gz dev; host 78,051 / 3,145,728 gz.
- **Input contract:** complete (21 invalid maps, deadzone and tick fixtures, 34 constants). Core now owns the six `E_INPUT_*` codes; `InputErrorCode` is a narrow `Extract`. Recorded the 0..7 engine vs 1..8 SDK slot mapping and three low-severity spec ambiguities (RV-18…RV-20).
- **Contract deltas this wave:** unified `DeviceInitResult<T>` with the device; WebGPU/WebGL2 factories return narrowed init results; five `E_ASSET_*` codes added to core; 06 error classification corrected; save hash decimal fixed; REVIEW now has 22 resolved items.
- **Final T0 wave launched:** Physics3D (07), Audio (09) and GameContext v2 (18). These are the remaining contracts in the program's T0 list; no implementations.
- **Next:** integrate the three, rerun the gate, then W0's contract criterion is met and W1 implementations can start (math, scene, loop first).

### 2026-10-23 — boundary test lands; final T0 agents still reading

- **RV-12 closed:** added `packages/engine/core/test/boundaries.test.ts` (ER-00-02). It scans engine source imports for forbidden host/controller/server/SDK edges and unlisted engine-to-engine edges, checks relative imports stay inside their package, and asserts `engine-core` has zero runtime dependencies. Core tests now **12/12**.
- **Why this instead of ESLint:** the config-protection hook forbids `eslint.config.js` edits. A source-level test enforces the same rule without weakening or bypassing the hook.
- **Traceability:** added ER-00-02 to `TRACEABILITY.md` §10.1.
- **No change from the three T0 agents yet** (physics, audio, SDK context are still reading); no duplicate work started.

### 2026-10-23 — watchdog: final T0 files landing

- **Physics:** package scaffold, tsconfigs, `src/contracts/physics3d.d.ts` (25.9 KB), `src/version.ts`, `src/index.ts` exist.
- **Audio:** package scaffold, tsconfigs, `src/contracts/audio.d.ts` (19 KB), copy script exist; fixtures not yet.
- **SDK:** `sdk/src/game-api.ts` is modified in place; no new `contextV2.ts` yet.
- **Chose:** no tsconfig/Vitest wiring, no `npm install`, no full gate while the three agents are writing. Scoped checks after their reports.
- **Next:** on reports, add each package to the root project graph, run `npm install`, rerun the full gate, and close W0's contract criterion.

### 2026-10-23 — SDK context v2 complete; asset projection corrected

- **SDK:** `GameContext` v2 landed type-only in `sdk/src/game-api.ts` — optional `assets`, `scene`, `animation`, `world`, `ui`, `actions`, `save`; `renderer.backend` gains `"webgpu"`; `renderer.capabilities?`; `debug.draw?`. Frozen members unchanged. SDK tests 6 files / 107 tests; lint/typecheck clean; controller still 40,794 / 40,960 gz and host 78,051 / 3,145,728 gz.
- **Real conflict found and fixed:** 18's `AssetHandle`/`AssetLibrary` projection was not a subset of spec 06 — wrong `kind`, `state`, `value`, `error`, `progress` and `retain` return. Rewrote the SDK projection and 18 §3.4 to the engine shapes (eight kinds, `disposed`, `value: T`, `failed: AssetFailure | null`, `progress: AssetProgress`, `retain(): AssetHandle<T>`). SDK still compiles and 107/107 pass.
- **Manifest:** `version?: string` added to the type and JSON schema; runtime validation deferred for the controller size gate (RV-22).
- **Open:** RV-21 — a tracked engine→SDK assignability test must live in `packages/runtime`, because the SDK and engine packages may not import each other. The asset mismatch proves this is necessary.
- **Audio:** scoped `tsc`/eslint/`node --check` exit 0; waiting for its hand-back report. **Physics:** still running.
- **Next:** integrate audio + physics, run the gate; SDK needs no package wiring (existing workspace).

### 2026-10-23 — audio contract integrated

- **Audio:** 11 files, 53 public types and 50 runtime constants, three synthetic fixture sets (bus, positional, format). Independent scoped checks pass: `tsc` both configs, eslint, `node --check`.
- **Core gap fixed:** 09's four additive codes (`E_AUDIO_DEVICE`, `E_AUDIO_DECODE`, `E_AUDIO_FORMAT`, `E_AUDIO_BUDGET`) are now in 00 §5.9 and core; `AudioErrorCode` is a narrow `Extract`, not a parallel union.
- **Wired:** audio is in root tsconfig references and Vitest projects. Core rebuild + tests **12/12**, audio lint clean.
- **Recorded:** REVIEW resolved 26 and open RV-23 (equal-priority stealing vs ER-09-04's drop count), RV-24 (voice-count rounding), RV-25 (`AudioVoice`/`AudioDeviceState` not canonical).
- **Remaining:** physics (07) is the only T0 contract still running. Then `npm install`, full gate, W0 contract criterion closed.

### 2026-10-23 — all T0 contracts complete; clean gate green

- **Physics:** contract-only, no Rapier dependency; 38 runtime constants, 42 synthetic fixture cases (bodies/raycast/fixed-step) and a compile-time adapter-boundary test. Scoped `tsc` both configs, eslint and `node --check` pass. No core error-code gap.
- **Integrated:** physics and audio added to root tsconfig references and Vitest projects; `npm install` linked both. Root `tsc -b` exit 0.
- **Clean gate:** `npm ci` + `npm run check` exits 0 — **137 test files / 1,597 tests**, size controller 40,794 / 40,960 gz, host 78,051 / 3,145,728 gz, trace D0–D7 clean.
- **T0 contract freeze is complete:** 00–07, 09, 10, 15 and 18 now have frozen types, fixtures and, where relevant, runtime constants. REVIEW has 27 resolved items.
- **Honest W0 status:** the literal README criterion ("every spec has a `.d.ts`/conformance/fixture") is not met for the later-tier specs 08, 11–14, 16 and 17. Their contracts belong to T2; W0 stays open on that row. The T0 gate that W1 depends on is met. Physics ambiguities recorded: RV-26 (mass/inertia formulas), RV-27 (`tick` in §3.2), RV-28 (contact/vehicle shapes).
- **Chose to start W1:** implement math (02), scene/ECS (03) and loop/jobs (01) in parallel, each owning its own `engine-core` subtree; the integration agent owns `src/index.ts` and traceability rows.
- **Launched:** math (`src/math/**`, `test/math/**`), scene (`src/scene/**`, `test/scene/**`) and loop/jobs (`src/time/**`, `src/jobs/**`, `src/platform/**`, their tests). Each runs only scoped Vitest/eslint — no package-wide `tsc` — because sibling subtrees are being written concurrently. No agent edits `src/index.ts`.
- **Boundary plan:** after all three report, integration wires `src/index.ts`, adds the ER-01/02/03 rows actually used, runs root `tsc -b` and the full gate, then starts renderer/asset/input/save implementations.

### 2026-10-23 — watchdog: W1 agents reading

- **No files yet** under `src/{math,scene,time,jobs,platform}` or their tests; the three agents are still in their read/design phase. No notifications.
- **Chose:** do not start later-tier contract packages (08, 11–14, 16, 17) while the core wave is unintegrated. W0's literal "every contract spec" row stays open by design; adding packages now would increase integration surface without helping M0.
- **Next:** on reports, wire `src/index.ts`, add precise TRACEABILITY rows for the ER IDs actually used, run root `tsc -b` and the full gate, then fix cross-subtree type defects.

### 2026-10-23 — watchdog: W1 code landing

- **Progress:** all three agents are running (19m). Files now include `src/math/{index,Frustum,...}`, `src/scene/{Scene,EntityPool,Serialization,Prefab,index}`, `src/jobs/{JobQueue,types,WorkerProtocol}`, and tests under `test/math`, `test/time`. No reports yet.
- **Chose:** no scoped checks or index wiring while the agents are writing; sibling-file imports can be transiently broken during a wave. Integration starts at the reports.
- **Next:** collect the three hand-backs, wire `src/index.ts`, add ER-01/02/03 rows, run `tsc -b` + full gate, and fix cross-subtree defects.
- **Boundary note:** `math/index.ts` re-exports the `Quat` type while `contracts/math.d.ts` also declares it. When wiring `src/index.ts`, prefer value-only implementation exports and keep the contract as the single type source; check for TS2308 duplicate-export errors.

### 2026-10-23 — loop/jobs/platform implementation complete

- **Delivered:** 15 source files and 8 test files under `src/time`, `src/jobs`, `src/platform`; 23 tests, scoped Vitest and eslint green. No files outside the owned subtrees.
- **ER coverage:** ER-01-01/02/03/04/05/06/10/12. Added those rows to `TRACEABILITY.md` §10.1. ER-01-07/08/09/11/13 remain PENDING (benchmark page, replay fixture or TV hardware).
- **Spec corrections:** ER-01-04 said seven pause reasons, the contract has six; fixed. ER-01-06's Node heap assertion moved to ER-01-07; the unit test asserts caller-object reuse. ER-01-10 now states dispatch by priority band with globally ascending `drainCompleted`.
- **Boundary notes:** do **not** `export *` from `time`/`jobs`/`platform` barrels — `EngineLoop`, `LoopClock`, `FrameStatsRing`, `createBrowserScheduler` and `ManualScheduler` would collide with the contract star exports. Use explicit value re-exports. First `onTick` sees `tick === 1` (legacy poll saw 0); the host adapter must expect that.
- **Owed:** `test/platform` coverage (RV-29) and the ER-01-12 Coin Run/Reaction Duel migration evidence (RV-30). Math and scene agents are still running.

### 2026-10-23 — math implementation complete

- **Delivered:** 13 source files and 15 test files; **141/141** math tests, scoped ESLint clean. Both hand-verified conformance fixtures are loaded and asserted, including all 16 projection matrix elements and both quaternion product orders.
- **ER coverage:** ER-02-01…09; rows added to `TRACEABILITY.md` §10.1. ER-02-10…13 are benchmark/hardware rows and remain PENDING.
- **Implementation note:** added a relative SAT slop in `Obb.ts` so touching pairs remain symmetric under float addition order (ER-02-08). Recorded as REVIEW resolved 31.
- **Type-source issue:** math modules define their own `Vec3`/`Mat4`/`Quat` interfaces instead of importing the frozen contract. The package entry will explicitly re-export the contract types to avoid TS2308; RV-32 records the W2 refactor. No drift observed, but it is not ideal.
- **Ambiguities recorded:** signed-zero min/max (RV-31); normalize/invert return conventions are asserted from the contract.
- **Next:** scene is the last W1 agent; then wire `src/index.ts` (explicit values, contract types), add ER-03 rows, run `tsc -b` and the full gate.

### 2026-10-23 — scene/ECS complete; W1 core code done

- **Delivered:** 14 source files and 12 test files; **71/71** scene tests, scoped ESLint clean. Conformance replay loads `scene-lifecycle.json`; property tests cover queries, hierarchy and transforms; pool and 10k-renderable integration cases pass.
- **ER coverage:** ER-03-01/02/03/05/06/09/10/11; rows added to `TRACEABILITY.md` §10.1. ER-03-04/07/08/12/13 remain PENDING (benchmark, migration, TV).
- **Spec reconciliations:** 03 §5.5 now states the stale-child vs stale-parent error distinction and the subtree-height depth rule that the implementation and tests use. REVIEW resolved 32.
- **Findings:** RV-33 (remove-absent dev counter not implemented), RV-34 (32 MiB snapshot / 4 MiB prefab byte limits not enforced).
- **W1 core code is complete:** math 141, scene 71, time/jobs 23 = **235 tests** across the three subtrees, all scoped green. Next is the package-entry wiring and the root gate.

### 2026-10-23 — W1 core integrated; full gate green

- **Package entry wired:** math value exports, scene values (built-in type/value merged in `builtins.ts`), explicit time/jobs/platform values, and selective contract type exports. `src/index.ts` no longer star-exports contract modules that also have implementations.
- **Integration defects fixed (found only by package-wide tsc):**
  - `Mat4` indexed writes now satisfy `noUncheckedIndexedAccess`.
  - `EntityAllocator.freeStack` grows as `Uint32Array` (it was declared Uint32 but grown as Int32).
  - `Serialization` preserves the fixture key order `parent, enabled?, components` and casts the transform store value.
  - Built-in component types are aliases merged with their runtime consts; empty interfaces failed lint.
- **Test timeout:** the core Vitest project gets `testTimeout: 30_000`. Four 10,000-case fast-check tests exceeded the 5 s default under full-suite CPU contention; no assertion or case count was reduced.
- **Gate:** `npm run check` exit 0 — **171 test files / 1,832 tests**, controller 40,794 / 40,960 gz, host 78,051 / 3,145,728 gz, trace clean.
- **REVIEW:** resolved 33 for the integration fixes. RV-29 (platform tests), RV-30 (ER-01-12 migration), RV-32 (math type duplication), RV-33 (remove-absent counter), RV-34 (scene byte limits) remain.
- **Next:** W1 continues with renderer-webgpu (04), renderer-webgl2 (05), assets (06), input (10) and save codec (15) implementations, each in its own package.

### 2026-10-23 — W1 wave 2 launched

- **Wave 1 closed green:** core math/scene/time/jobs implemented, wired and gated. Full `npm run check` exit 0 with 171 files / 1,832 tests; size unchanged; trace clean.
- **Launched five package-local agents:**
  - `renderer-webgpu` (04): M0 device/pipelines/uniforms/textured instanced mesh/one light/culling/device loss. Node tests with fakes; real GPU evidence deferred to the rig.
  - `renderer-webgl2` (05): probe/classify/device, ABI 1, texture mapping, context loss, and the `./canvas2d` entry.
  - `assets` (06): manifest validation against all fixtures, byte-accurate fetch, refcounts, budgets, GLB/KTX2/WebP/audio seams.
  - `input` (10): map/overlay validation, deadzone/edges, router and device assignment, DOM-free cores.
  - save codec (15): the 40-byte header codec + runtime constants, reproducing the 85-byte fixture.
- **Rules:** no agent edits core except the save-codec owner's `core/src/save/**` and the save export line; no root configs or lockfile; scoped tests only; every test tagged with its ER ID for later traceability rows.
- **Next:** integrate all five, add ER-04/05/06/10/15 rows, run root typecheck and the full gate, then wire the runtime to the engine (M0 composition).

### 2026-10-23 — watchdog: wave 2 reading

- **All five agents running** (2–3m): renderer-webgpu, renderer-webgl2, assets, input, save codec. No new implementation files on disk yet; the listed files are the frozen contracts and fixtures from the earlier waves.
- **Chose:** no checks, no cross-package wiring, no duplicate implementation work while they read. The last gate remains the authoritative green point (171 files / 1,832 tests).
- **Next:** collect hand-backs, integrate each package, add its ER rows, then run the full gate. Only after that does runtime composition start.

### 2026-10-23 — watchdog: wave 2 code landing

- **Save codec:** `core/src/save/{constants,errors,header,file,index}.ts` are on disk, and the save-codec owner added the value exports to `core/src/index.ts` (header/file functions and constants). This is the expected owner for that export line.
- **WebGL2:** `src/classify.ts` and `src/errors.ts` have landed; the rest is still in progress.
- **WebGPU, assets, input:** no implementation files yet; still reading.
- **All five agents running** (9m). No checks or integration while they write.
- **Next:** on reports, run scoped suites independently, add ER rows, wire any missing exports, then the full gate.

### 2026-10-23 — save codec complete

- **Codec delivered:** `core/src/save/{constants,errors,header,file,index}.ts` plus tests. Reproduces `header-v1.bin` byte-for-byte (85 bytes, header 56, FNV `0x635F8BC4`, SHA-256 metadata matches). Core suite now **283/283** across 39 files; test tsconfig and lint clean.
- **Contract gap fixed:** `save.d.ts` named the codec functions in prose but did not declare them. Added `fnv1a32`, `createSaveHeader`, `encode/decodeSaveHeader`, `encode/decodeSaveFile`, `CreateSaveHeaderInput` and `DecodedSaveFile`, including the additive optional `expectedGameId` argument for `E_SAVE_GAME`.
- **Spec fixes:** ER-15-01's `headerBytes` bounds are the reachable 48/136 (40/144 are structurally invalid); ER-15-05 uses `E_SAVE_FORMAT` for version 0 in M0, with migration deferred to M1.
- **Test hygiene:** fixed the five pre-existing test-only type errors (stale error-code list, fixture type imports, heterogeneous component narrowing). `tsconfig.test.json` now has zero errors.
- **Docs:** updated `test/save/README.md` (codec exists now) and registered ER-15-01..06/11 in traceability.
- **Remaining wave 2:** renderer-webgpu, renderer-webgl2, assets and input are still running.

### 2026-10-23 — watchdog: wave 2 implementation in depth

- **Save** is integrated and green (283/283 core tests, fixture proof, contract declarations fixed).
- **WebGL2:** `texture.ts` (23 KB), `mesh`, `material`, `buffer`, `state`, `shaders/forwardLit` landed.
- **Assets:** codec dispatch plus `image`, `audio`, `font`, `material`, `json` modules landed.
- **Input:** `InputRouter.ts` (58 KB) plus supporting modules landed.
- **WebGPU:** device descriptors/handles and texture format mapping landed.
- **All four agents still running** (24–25m); no hand-backs yet. No checks or integration while they write.
- **Next:** collect reports, run each scoped suite independently, add ER-04/05/06/10 rows, then the full gate.

### 2026-10-23 — watchdog: wave 2 large modules

- **All four agents still running** (39m). Latest files: WebGL2 `device.ts` (45 KB), `frame.ts`, `capability.ts`, Canvas2D `device`/`draw2d`; assets `library.ts` (36 KB), `handle.ts`, `worker/pool.ts`; input `mapValidation.test.ts`; WebGPU remains active on its device/pipeline modules.
- **No hand-backs yet.** No checks or integration while files are being written; the last green point is core 283/283.
- **Next:** reports → independent scoped suites → ER rows → full gate. If an agent runs much longer, check whether it is stuck on a single failing test rather than waiting indefinitely.

### 2026-10-23 — assets implementation partial; spec 06 completed

- **Assets agent handed back partial:** implementation (library, handle, budget, worker pool, fetch, manifest, URL, variants, GLB/KTX2/image/audio/font/json/material decoders) is written, but tests cover only manifest and fetch; GLB and ER-06-04…08 were blocked or unfinished and were never run. **Resumed the same agent** to finish the tests and run the scoped checks; the assignment is not recorded as done.
- **Spec 06 gap found:** it ended at §6, with no acceptance, test plan, dependencies or risks, and only ER-06-09 existed in prose. Added §7 (ER-06-01…09), §8 test plan, §9 dependencies and §10 risks, plus W1 clarifications for failure stickiness, dependency-on-any-kind, and disposed vs evicted errors.
- **Traceability:** added ER-06-01…09 rows; ER-06-09 stays a browser/hardware row.
- **Other agents:** renderers and input are still running.

### 2026-10-23 — assets complete and verified

- **Tests ran:** the resumed agent delivered GLB/KTX2/image/codec/library/pool suites; the first run was 129/133. Fixed:
  - two fetch tests set `contentLength: null` so a short/long body reaches the body-read path instead of failing early on the header;
  - the borrowed-handle test no longer calls `release()` (`get()` adds no reference);
  - buffered audio now carries the manifest's `durationSeconds` (real metadata bug; duration is not decoded from Ogg).
- **Result:** assets **133/133** across 8 files; `tsconfig.json` and `tsconfig.test.json` both clean; eslint clean.
- **Coverage:** manifest/fetch/refcounts/budgets/LRU/worker pool/GLB/KTX2/image/audio/font/json/material. Decoders are M0 subsets; KTX2 supercompression, transcoding and real worker execution remain out of scope.
- **Next:** renderer WebGPU, renderer WebGL2 and input hand-backs; then integration + full gate.

### 2026-10-23 — input complete and verified

- **Input:** 13 files / **141 tests**, all scoped commands green (Vitest, src tsc, test tsc, eslint). ER-10-01/02/04/05/06/07/08/09/10/12/13/15 covered; rows added to traceability.
- **Real bug fixed:** `applyStick` overwrote `rx/ry` whenever no stick output existed, clobbering `output.axis` values. It now writes only the sides that have a stick output, per 10 §5.9. The test that exposed it was kept, not weakened.
- **Deferred:** ER-10-03 (real server/WebSocket harness), ER-10-11/14 (benchmarks), ER-10-16 (TV), plus the browser halves of ER-10-09/10. Node seams cover the logic; those rows stay PENDING.
- **Wave 2 status:** save, assets and input done; renderer-webgpu and renderer-webgl2 still running.

### 2026-10-23 — WebGL2 complete and verified

- **WebGL2:** 9 test files / **178 tests**, test typecheck and eslint clean. Covers device/ABI/textures/pipelines, capability classification, context loss/restore, Canvas2D, failure notices and package boundaries. ER-05-01/05/06/07/08/11/12 rows added.
- **Defects fixed by the agent:** disposed Canvas2D draws still executed (now return early); `WebGL2DeviceInitResult` referenced an unimported base type that `skipLibCheck` hid (import added); extension-gated formats threw `E_BACKEND_INIT` instead of `E_UNSUPPORTED_FEATURE`.
- **Spec corrections:** 05 now assigns per-draw frustum culling to the backend (consistent with 04) and keeps handles valid across restore, stale only after destroy/dispose. Updated the stale contract header note.
- **Honesty:** all rendering evidence is from a hand-written fake GL recorder. Real pixels, frame times, hardware context loss and TV behavior remain PENDING.
- **Open:** RV-36 (`ShaderModuleDesc.language` has no GLSL; custom shaders must refuse explicitly), RV-37 (internal GL counters not in `RenderStats`).
- **Wave 2:** only renderer-webgpu remains.

### 2026-10-23 — W1 wave 2 complete; full gate green

- **All five packages delivered and independently verified:**
  - save codec: 283 core tests, 85-byte fixture proof;
  - assets: 133 tests, src+test typecheck, lint clean;
  - input: 141 tests, src+test typecheck, lint clean;
  - renderer-webgl2: 178 tests, src+test typecheck, lint clean;
  - renderer-webgpu: 165 tests, src+test typecheck, lint clean.
- **Full gate:** `npm run check` exit 0 — **218 test files / 2,485 tests**, size controller 40,794 / 40,960 gz, host 78,051 / 3,145,728 gz, trace clean. No test weakened or skipped.
- **Evidence honesty:** both renderers are verified only against hand-written fake GPU/GL devices. No real pixel, frame-time, driver-loss or TV evidence exists yet. Every hardware-dependent ER row stays PENDING.
- **Open:** RV-38 (`WebGpuDevice.ts` is ~127 KB and should be split after M0), RV-39 (real GPU validation/WGSL/golden evidence), RV-40 (input browser halves), RV-41 (assets browser decode).
- **Next:** M0 composition — runtime renderer selection/engine loop/scene encoder and a real-GPU demo page under `experiments/e-m0-engine`.

### 2026-10-23 — M0 composition wave launched

- **Runtime agent:** owns `packages/runtime/src/engine/**`, `src/render/selectRenderer.ts`, `src/compat/**`, runtime package.json/tsconfig and the minimum host wiring. Goal: select WebGPU → WebGL2 → Canvas2D, wire the engine fixed loop/scene/input/assets behind the existing GameHost, keep both 2D games and 377 runtime tests green.
- **Experiment agent:** owns `experiments/e-m0-engine/**` only. Goal: a real-browser page that imports the built engine packages via import maps, renders a textured lit cube and an instanced scene on WebGPU and WebGL2, captures the golden frame hash and basic stats, and runs headless if Chrome is available. No timing claims without measurements.
- **Rules:** disjoint ownership, scoped checks only, no root config or lockfile edits (integration handles those), no commits.

### 2026-10-23 — watchdog: M0 agents reading

- **Both agents running** (4m), still reading the contracts and existing runtime. No `src/engine/**`, `selectRenderer.ts` or `experiments/e-m0-engine/**` files yet.
- **Chose:** no checks or duplicate work while they read. The last full gate remains green: 218 files / 2,485 tests.
- **Next:** on hand-backs, verify runtime tests and any real browser output, then run the full gate and record only measured evidence.

### 2026-10-23 — first real-GPU run: WebGL2 renders, WebGPU broken

- **Real artifacts exist:** `experiments/e-m0-engine/artifacts/{webgpu,webgl2}.json` + PNGs from headless Chrome 155.
- **WebGL2: real render confirmed.** The screenshot shows a textured lit cube; `nonClearPixels 53,970`, `distinctColors 3`, 1 draw / 12 triangles. The runner marked it FAIL only because its `brightPixels = 0` threshold is wrong for a dark scene. Told the experiment owner to use non-clear/color/luminance signals.
- **WebGPU: genuinely broken.** Validation errors:
  1. the 2 MiB object uniform ring exceeds `maxUniformBufferBindingSize` 65,536;
  2. `frame-bind-group`/`light-bind-group` are validated against the `builtin-material` layout;
  3. the material bind group has no `textureView`.
  The command buffer is invalid and the canvas is black. Resumed the WebGPU owner with the exact errors and the real-page command.
- **Spec implication:** 04 §4.4's 2 MiB object ring may itself be invalid under default WebGPU limits. An amendment may be needed: bind a ≤64 KiB window, split the ring, or raise the adapter limit. Do not silently ignore it.
- **Honesty:** this is why fake-device tests are insufficient. No rendering row is PASS until the real page meets a robust capture criterion; the WebGL2 screenshot is strong evidence but the runner verdict must first be corrected.

### 2026-10-23 — watchdog: WebGPU still building

- **WebGPU agent running ~1h**, actively writing: `device/WebGpuDevice.ts` is now 126 KB, with resource, pipeline-cache and ABI tests plus a fake WebGPU device. No hand-back yet.
- **Concern to review:** spec 04 §5.1 lays out a multi-module device (device/pipeline/buffer/texture/frame/culling). A 126 KB single class file may be an overgrown implementation; at hand-back, check whether it should be split or whether the size is mostly generated tables. Do not edit while the agent is active.
- **No other agents running.** Save, assets, input and WebGL2 are integrated and green; the full gate waits only on WebGPU.
- **Next:** hand-back → run its scoped suite independently → add ER-04 rows → full gate. If it exceeds ~90m, request a status.

### 2026-10-23 — watchdog: WebGPU tests

- **WebGPU still active**, now writing `culling.test.ts`, `instancing.test.ts` and `src/culling/FrustumCuller.ts`; the device implementation is stable at ~127 KB.
- **No other agents running.** Four packages are integrated and green; WebGPU is the only blocker for the wave gate.
- **Next:** hand-back, independent scoped run, ER-04 rows, then `npm run check`. Revisit the 127 KB device file only after the tests pass; do not refactor mid-implementation.

### 2026-10-23 — watchdog: WebGPU broad test set

- **WebGPU still active**, writing swapchain, error-scope, device, readback, device-loss and production-mode tests. It is thorough rather than stalled.
- **No other agents.** Save/assets/input/WebGL2 are integrated and green; WebGPU alone blocks the wave gate.
- **Next:** wait for the hand-back; if the next watchdog tick still has no report, send a status request rather than continuing to wait silently.

### 2026-10-23 — watchdog: wave 2 test suites

- **Assets:** resumed agent has created `glb.test.ts` and `ktx2.test.ts` and is continuing the decoder/lifecycle suites.
- **Input:** `keyboard`, `axisComposition`, `edges.property`, `deadzone.property` and map-validation tests are on disk.
- **WebGL2:** fake canvas/WebGL2 harness exists; device/frame tests are being written.
- **WebGPU:** still active on its device/pipeline test layer.
- **All four agents running 56m.** No hand-backs yet; no checks while they write.
- **Next:** on reports, run each suite independently; if an agent exceeds ~75m without a hand-back, request a status instead of waiting.

### 2026-10-23 — watchdog: wave 2 tests, one hour

- **All four agents running 1h and actively writing tests**, not stalled:
  - WebGPU: ABI suite and a 16 KB fake WebGPU device.
  - Assets: `library.test.ts` (24 KB) and `codecs.test.ts` (16 KB) added to GLB/KTX2.
  - Input: poll-once, rebind and assignment-property suites.
  - WebGL2: `device.test.ts` (31 KB), ABI and pipeline-cache suites.
- **No hand-backs yet.** No checks while the packages are in flight; save remains the only completed wave-2 package.
- **Next:** on reports, independent scoped runs, ER rows for 04/05/06/10, then the full gate. Because the agents are still writing productively, no status interruption yet.

### 2026-10-23 — watchdog: math/scene in test phase

- **Time/jobs:** independently re-ran the scoped suite: 8 files, **23/23** pass. Its ER rows are in traceability.
- **Math:** property tests now cover Mat4, quaternion, camera, ray, OBB and frustum; implementation files are present. Agent still running.
- **Scene:** unit/property tests cover hierarchy and transforms; `Scene`, pool and serialization are present. Agent still running.
- **Chose:** no scoped checks or `src/index.ts` wiring until both hand back; sibling subtrees are still being written.
- **Next:** on reports, wire explicit value exports, add ER-02/03 rows, run root `tsc -b` and the full gate.

### 2026-10-23 — M0 runtime composition (selector + scene encoder)

- **Chose:** put backend selection in `packages/runtime/src/render/selectRenderer.ts` with all factories/probes injectable and lazy dynamic imports only in the default factories. Order is WebGPU → WebGL2 → Canvas2D; a Canvas2D result is rejected with `E_UNSUPPORTED_FEATURE`/`3d-on-canvas2d` when `require3D` is set, before any Canvas2D factory call. Rationale: 05 §3.2 allows only one context type per canvas, so a failed WebGPU/WebGL2 attempt may claim it; the selector tracks `canvasClaimed`, disposes a failed device, and builds a disposable replacement canvas for the next backend. Failures expose fixed tokens only — no exception text, URLs, or tokens.
- **Chose:** leave `packages/runtime/src/host/stage.ts` on the legacy `initRenderer(..., "canvas2d")` path. Both bundled games draw through `GameRenderer3D`/`drawCube`; the engine Canvas2D device deliberately exposes no 3D primitives and throws `3d-on-canvas2d`. Switching now would break the cube demo or force edits to engine packages, both out of scope. No `src/compat/**` adapter was created: it cannot preserve `drawCube` without engine changes. Revisit when the runtime 3D renderer is wired.
- **Chose:** keep the scene encoder in the runtime (`src/engine/sceneEncoder.ts`) rather than a renderer package, because renderers must not import `engine-assets`. It queries `Renderable`, resolves ready asset handles through an injected `AssetLibrary`-shaped resolver, reads `scene.worldMatrix` (never updates transforms — RV-04), stable-sorts layer/material/mesh/submission order, and submits pooled draws. The asset-to-GPU bridge (decoded bytes → `MeshHandle`/`MaterialHandle`) remains deferred to the assets/renderer integration.
- **Chose:** update the stale exact allowlist at `packages/runtime/test/renderer.test.ts:832` to include the five required engine workspace packages. The assignment required both “add workspace deps” and “keep every runtime test green”; the old assertion made those mutually exclusive. The `[NR-6.2]` no-virtual-DOM intent and the react/vue checks are unchanged — this is an allowlist update, not a weakened test. Flagged for the integration owner.
- **Deps:** `@lanpad/engine-{core,renderer-webgpu,renderer-webgl2,assets,input}` added to `packages/runtime/package.json` and `tsconfig.json` references. Root lockfile untouched; integration must run `npm install` to record the workspace edges.
- **ER rows:** only `[ER-05-07]` exists and genuinely covers the 3D-on-Canvas2D refusal. No row exists for fallback order or the scene encoder; docs owner should add e.g. `ER-00-14` (fallback order/sanitized failure) and `ER-04-18` (encoder ordering/pooling) before those tests are tagged.
- **Evidence:** scoped runtime suite 40 files / 388 tests pass; `tsc` source and test configs exit 0; scoped ESLint exits 0.

### 2026-10-23 — runtime composition verified; host switch deferred

- **Independent verification:** runtime suite **388/388**, test typecheck clean. `selectRenderer` and `sceneEncoder` are real and tested with injected factories; the stage still uses the legacy Canvas2D path, deliberately, because both games rely on `GameRenderer3D`/`drawCube` and Canvas2D cannot host 3D.
- **Traceability:** added ER-00-14 (fallback order/sanitized failure) and ER-00-15 (scene encoding) to 00 §7 and TRACEABILITY; tagged the 10 previously untagged tests. The 3D-on-Canvas2D test keeps ER-05-07.
- **Deps:** `npm install` recorded the five engine workspace edges for runtime; `npm ci --dry-run` exits 0. The stale allowlist in `runtime/test/renderer.test.ts` was extended to include the engine packages; the no-virtual-DOM check is unchanged.
- **Deferred:** host wiring, asset-to-GPU bridge, device-loss fallback policy, required-feature refusal. These are the next M0 composition steps after the renderers are fixed.
- **Concurrent:** WebGPU owner is fixing the real validation failures; experiment owner is correcting the blank-canvas detector.

### 2026-10-23 — real GPU demo: WebGPU pass, WebGL2 material bug

- **WebGPU is fixed and real:** the object bind group now binds 256 B at offset 0 with a dynamic offset into the 2 MiB ring; frame/light/material layouts are separated; an opaque unlit pipeline variant was added because the M0 fixture requires it. Real headless run: hash `b7d53f49`, 53,970 non-clear pixels, 3 colors, golden matched, no validation warnings. Screenshot shows the dark checker cube.
- **WebGL2 is not accepted:** geometry, depth and checker render (53,970 non-clear pixels), but the material colors are wrong and camera-position dependent (red↔blue), consistent with the material UBO reading the frame block (`gl.uniformBlockBinding` missing for binding 1). The recorded golden `6cc911b1` encodes the wrong image and must be replaced after the fix. The runner currently passes because it compares against that wrong golden; that is not evidence of correctness.
- **Demo artifacts:** `experiments/e-m0-engine/` page, importer, CDP runner, per-backend JSON + PNG, README. The runner serves the repo root because dist imports bare `@lanpad/engine-core`; the import map resolves it.
- **Spec:** ER-04-11 is now M0/M1 (opaque unlit is M0; full material fixture M1); Appendix B lists opaque unlit in M0; §4.4 states bind group 3 binds 256 B, never the whole ring. ER-04-11 added to traceability.
- **Next:** WebGL2 owner fixes the material block; re-record the WebGL2 golden with `--update-golden`; verify without update; run the full gate.

### 2026-10-23 — watchdog: WebGL2 material fix in progress

- **WebGL2 agent active (2m)**, editing `src/pipelineCache.ts` and the fake WebGL2 harness, consistent with adding/validating explicit `gl.uniformBlockBinding` assignments for frame vs material blocks.
- **No report yet.** No checks while it writes; the last gate remains green (2,485 tests), and the WebGL2 real-page golden is still known-wrong.
- **Next:** hand-back → re-run the real page with `--update-golden` for WebGL2 → verify without update → full gate.

### 2026-10-23 — WebGL2 fixed; WebGPU lit output still wrong

- **WebGL2 root cause confirmed:** GLSL ES 3.00 uniform blocks both defaulted to binding 0; `material.ts` bound the UBO to index 1 but never called `uniformBlockBinding`, so the fragment shader read the frame UBO for `MaterialBlock` (camera-dependent colors). Fixed in `pipelineCache.ts` with explicit FrameBlock→0 / MaterialBlock→1 association, guarded by `INVALID_INDEX`, plus a regression test. 179/179 tests, tsc/lint clean, dist rebuilt.
- **Real page re-recorded:** WebGL2 hash `32312240`, screenshot shows a tan/black lit checker cube; verify run without `--update-golden` exits 0.
- **WebGPU still wrong:** the page material is lit (no `unlit`), yet WebGPU is nearly black while WebGL2 is tan. The earlier golden `b7d53f49` encodes that wrong image and is not accepted. The unlit path added earlier is unused by this fixture. Resumed the WebGPU owner with the parity evidence to fix light/ambient uniform packing or texture sampling; its golden will be re-recorded after the fix.
- **Acceptance:** cross-backend parity (ER-04-09/ER-05-04) stays PENDING; the runner compares each backend only to its own golden. Add a cross-backend diff check once both images are correct.

### 2026-10-23 — WebGPU lit fix; both backends match

- **Two real WebGPU defects fixed:** the lit path never called `writeNormalMatrix`, so every object had a zero normal matrix and rendered ambient-only; and the fixed M0 light (`0.4,0.8,0.5`, intensity 3, ambient 0.03) pointed away from the page camera. Aligned to the WebGL2/fixture light `(-0.45,-0.8,-0.35)`, intensity 1, ambient 0.18, and added a regression test that checks the inverse-transpose normal matrix under non-uniform scale.
- **Parity achieved at the smoke fixture:** both backends produce hash **`32312240`**, 53,970 non-clear pixels, runner exit 0 against their re-recorded goldens. WebGPU `brightPixels` is now 26,884 (was 0), colors 7 (was 3). Screenshot shows the tan/black lit checker.
- **Spec fixture aligned:** Appendix A.1 now describes the tested scene (camera `(-1.15,-0.95,-2.2)`, FOV 45°, 1.1-unit cube, 4×4 checker, roughness 0.62, light `(-0.45,-0.8,-0.35)` intensity 1, ambient 0.18). Acceptance resolution/frame counts stay 1920×1080/frame 60; the smoke page is 640×360.
- **Still PENDING:** 5,000 instances, 1920×1080, frame-time p95, shared tick-300 golden, device loss/resize browser cases. No timing claim is made.
- **Next:** full gate, then host wiring and the 5,000-instance acceptance run.

### 2026-10-23 — parity achieved; gate green

- **WebGPU root causes:** the lit object uniform never called `writeNormalMatrix`, so normals were zero and output was ambient-only; the fixed light also pointed away from the page camera and differed from WebGL2. Fixed both, added a normal-matrix regression test under non-uniform scale.
- **Parity:** both backends now render the same fixture at hash **`32312240`**, 53,970 non-clear pixels, 7 colors, runner exit 0 against re-recorded goldens. Appendix A.1 now describes the tested camera/FOV/cube/material/light.
- **Deadzone edge case:** a 10k-case property test found a one-ulp amplification near full deflection (`0.9999999999999997` → `0.9999999999999998`). The scalar and radial formulas now clamp the scaled magnitude so deadzone never amplifies; added the exact counterexample as a regression. Input 142/142.
- **Full gate:** exit 0, **220 test files / 2,501 tests**, size unchanged, trace clean.
- **Still PENDING:** 5,000-instance scene, 1920×1080, frame-time p95, shared tick-300 golden, browser resize/device-loss, host wiring, asset-to-GPU bridge.
- **Next:** acceptance page at 5,000 instances/1080p with measured frame stats, plus the engine→SDK assignability test.

### 2026-10-23 — engine→SDK projections pass; acceptance run launched

- **ER-18-02 (partial):** added `packages/runtime/test/types/sdk-assignability.test-d.ts`, a type-only check that engine `Scene`, `AssetLibrary` and `RendererCapabilities` satisfy the SDK structural projections. `tsc -p packages/runtime/tsconfig.test.json` exits 0. The negative-fixture half remains PENDING.
- **Full gate before this change:** exit 0, 220 files / 2,501 tests.
- **Launched the acceptance-page agent:** 5,000 instanced cubes, 1920×1080, 120 warm-up + 600 measured frames, p50/p95/max, draw calls/triangles/texture bytes, frame-60 golden, cross-backend pixel diff ≤2% >8/255. Real Chrome only; no invented numbers. The existing cube page remains at hash `32312240` on both backends.
- **Next:** integrate the acceptance results, record ER-00-03/04, ER-04-01/02/08/09 and ER-05-03/04 only where the run supports them; then host wiring and the asset-to-GPU bridge.

### 2026-10-23 — M0 scene5000 measured on both backends

- **Real 1920×1080 run:** 5,000 instanced cubes, one draw call, 60,000 triangles, 0 GPU errors.
  - WebGPU (`nvidia ampere`): p50 9.2 / p95 10.1 / max 10.2 ms, textureBytes 8,295,680, golden `83a995ef`.
  - WebGL2 (`WebKit WebGL`): p50 9.3 / p95 10.2 / max 10.7 ms, textureBytes 256, golden `fc205f5d`.
  - Cross-backend diff: **4 / 2,073,600 pixels = 0.000193%** over 8/255 (max delta 37); allowance 2%.
- **Recorded:** `docs/RESULTS.md` has the full row and build hash. ER-00-03/04, ER-04-02 and ER-05-03 are marked PASS with the measured evidence. ER-04-09/ER-05-04 stay PENDING because they specify a tick-300 golden (this run captures frame 60), even though the observed diff is far inside tolerance.
- **Spec fix:** Appendix A.2's expected `textureBytes ≤ 1 MiB` ignored the 1080p depth attachment; it now says `≤ 12 MiB` including depth (content textures ≤ 1 MiB). The 128 MiB hard budget passes.
- **Caveats:** headless rAF ran at ~108 Hz, so this is not 60 Hz-vsync evidence; `gpuFrameMs` is null; no TV/Android, driver-loss or resize run. RV-45 (copy-dst vs sample) and RV-46 (60 Hz evidence) remain open.
- **Next:** runtime host wiring + asset-to-GPU bridge, then browser resize/device-loss and the 2D-game parity check.

### 2026-10-23 — M0 measurement recorded; edge cases and asset bridge launched

- **Recorded:** the scene5000 numbers, caveats and build hash are in `docs/RESULTS.md`; ER-00-03/04, ER-04-02 and ER-05-03 are PASS with that evidence. ER-04-09/ER-05-04 stay PENDING (frame 60, not tick 300).
- **Trace:** `npm run trace` exits 0 after the new ER rows and the ER-18-02 type check.
- **Launched two agents:**
  - browser edge cases in `experiments/e-m0-engine/**`: resize, WebGL2 `WEBGL_lose_context` loss/restore, and a 5 MB asset long-task case; no fake passes.
  - runtime `assetBridge.ts`: decoded Mesh/Texture/Material → GPU handles with cache, refcounts, ABI 1 packing, format refusal and cleanup tests.
- **Remaining after these:** host wiring of `selectRenderer` for engine-rendered games, 60 Hz/GPU-timestamp evidence, browser asset decode, TV/Android, then M1 (city block, vehicle, mission).

### 2026-10-23 — watchdog: edge cases and asset bridge reading

- **Both agents running <1m**, still reading contracts/specs. No new `assetBridge` or case files yet. The measured scene5000 artifacts remain the current evidence.
- **Chose:** no checks or duplicate work. Trace exited 0 after the new ER rows; test gate remains 220 files / 2,501 tests.
- **Next:** hand-backs → scoped verification → full gate. If a browser case reveals another real renderer defect, fix it before closing an acceptance row.

### 2026-10-23 — watchdog: acceptance agent reading

- **Acceptance agent running <1m**, still reading the existing demo/spec. No new experiment files yet; the cube artifacts remain verified at hash `32312240` on both backends.
- **Chose:** no checks or duplicate work. Last gate: 220 files / 2,501 tests, exit 0.
- **Next:** hand-back → verify the bench JSON fields and cross-backend diff → record only measured results. Then host wiring/asset bridge.

### 2026-10-23 — M1 dependency wave opened (physics + audio)

- **Gate before the wave:** exit 0, **222 files / 2,525 tests**, trace 0 missing, controller 40,794/40,960 gz, host **75,798**/3,145,728 gz. Host gzip fell after the engine Canvas2D switch because the legacy WebGL2 renderer left the host chunk.
- **Chose two parallel agents on disjoint existing packages** rather than new packages, because new packages would force concurrent edits to root tsconfig, Vitest and the lockfile:
  - **Physics owner** (`packages/engine/physics/**`, its package.json and the lockfile): install exact-pinned `@dimforge/rapier3d-compat` under A15, record version/license/WASM file+gzip bytes in RESULTS, implement the Rapier adapter behind the frozen `Physics3D`, author ER-07 fixtures, scoped checks only.
  - **Audio owner** (`packages/engine/audio/**`): implement the Web Audio system behind the frozen contract with an injected factory, unit/property tests, browser audio renders left PENDING.
- **Deliberate deferrals:** streaming (12) and animation (08) are new packages; their skeleton + root wiring waits until the lockfile is free so two npm installs never race. The 2D solver move to `two-d/` also waits: it would touch `packages/runtime/src/physics` while host wiring is fresh.
- **No new rows claimed** until each hand-back is independently verified and the full gate is green.
- **Next:** browser edge-case hand-back, then physics/audio hand-backs → scoped verification → traceability rows → full gate.

### 2026-10-23 — host now runs 2D games on the engine Canvas2D device

- **Chose the engine path for the production 2D host.** `stage.ts` previously used the legacy `render/Canvas2DRenderer.ts`; it now creates the engine `Canvas2DDevice` (`@lanpad/engine-renderer-webgl2/canvas2d`) and wraps it in `engine/canvas2DRenderer.ts`. No game changed: both games already draw through `GameRenderer3D` + feature-detected 2D calls.
- **Adapter decisions:**
  - The device is initialized once by `createCanvas2DDevice`; the adapter's `init` only verifies the canvas and returns Canvas2D capabilities. No double init.
  - Negative circle radii are clamped to 0, preserving the legacy behavior the engine device would otherwise throw on.
  - The adapter is typed `Renderer2D & Renderer3D` because `GameHost` holds that type, but `setCamera`/`drawCube` throw instead of drawing flat cubes. A 3D game must never silently land on Canvas2D (05 §3.5).
  - Canvas2D failure is wrapped in `RendererUnavailableError` with the existing friendly notice, so stage error handling is unchanged.
- **Verified:** adapter 6/6, runtime project 410/410, runtime tsc/lint/build clean, host gzip **78,051 → 75,798 B** (the legacy WebGL2 renderer left the host chunk). No browser parity capture yet; ER-00-10 stays PENDING.
- **WebGL2 `copy-dst` fix verified independently:** 9 files / 181 tests; `sample` remains mandatory and `copy-dst` alone is `E_CONTRACT`. RV-45 closed in REVIEW.
- **Not done:** no manifest 3D flag and no engine 3D game, so `selectRenderer` is still exercised only by its integration test. Wiring the first 3D game is M1 work, not a reason to invent product surface now.
- **Next:** browser edge-case hand-back → full gate → record only measured evidence.

### 2026-10-23 — asset bridge verified and documented

- **Verified independently:** `assetBridge.test.ts` 16/16, runtime src+test tsc and eslint exit 0. It caches one GPU resource per ready asset, packs ABI 1 meshes (`uint32` widening above 65,535 vertices), maps formats through the canonical table, resolves material texture ids through the same cache, and destroys the last owner or a partial material upload.
- **Chose a dedicated acceptance row:** added **ER-00-16** to `00-architecture.md` §7 and `TRACEABILITY.md`; the bridge test carries `// @req ER-00-16`. The existing ER-04/05/06 tags stay on individual tests because those behaviors are owned by those specs.
- **Defects found by the bridge, recorded instead of hidden:** RV-47 (compressed-sRGB tokens absent from canonical `TextureFormat`, so they are refused) and RV-48 (merged primitives lose per-primitive material slots; no mip generation). Both are M1 work; M0 uses uncompressed textures and one material per mesh.
- **RV-45 was a real integration defect, not just demo drift:** the bridge emits `["sample","copy-dst"]`, which WebGL2 rejected. The WebGL2 owner fixed it; 181 tests pass and the row is closed.
- **Status:** bridge is unit-verified but not yet wired into a 3D host path; there is no engine 3D game to consume it until M1.

### 2026-10-23 — browser edge cases measured; WebGPU loss honestly blocked

- **Resize PASS on both backends:** ten CSS-size changes in one task; `device.size` matched CSS on every call; final 640×360 @ DPR 2 → 1280×720 backing; 0 GPU errors. WebGPU defers the backing change to the next frame, which is recorded rather than hidden.
- **WebGL2 context loss PASS:** real `WEBGL_lose_context` events, epoch 0→1, pre/post hash `32312240`, recovery to content in **29.2 ms / 3 frames**, 0 uncaught errors. Handle-staleness after restore was not exercised, so ER-05-06 is PASS on recovery and open on that clause.
- **WebGPU device loss BLOCKED, not passed:** the built renderer exposes no public force-loss hook. The page refused to monkey-patch or fake a loss and exited 1. ER-04-05 stays PENDING; the fix is a dev-only engine hook, not a test fake.
- **5 MiB asset load PASS, 8 ms bound not proven:** same-origin WOFF2, transfer 5,243,180 B, decoded exact, 77.4 ms load, 0 long-task entries. `PerformanceObserver` only reports tasks >50 ms, so no ≤8 ms claim is possible; recorded as a gap.
- **Resize configure count PENDING:** no swapchain/configure counter in the contract; ten `resize()` calls observed, `configureCalls:null`. ER-04-06 is partial.
- **Runner defect fixed:** `run.mjs` still checked a 1 MiB texture ceiling after 04 A.2 was corrected to 12 MiB including depth. Raised to 12 MiB and re-ran scene5000 on both backends: all acceptance flags true, textureBytes 8,295,680 (WebGPU) / 256 (WebGL2). New build `2657192f…`; p95 10.3 / 10.2 ms; 4-pixel diff; goldens matched.
- **Recorded:** `docs/RESULTS.md` has the re-run table and the edge-case table; TRACEABILITY and REVIEW updated. No row marked PASS beyond its evidence.
- **Also wrote:** `docs/engine/20-m1-vertical-slice.md` — the M1 “Block 7 courier run” execution spec, indexed in README §6. It records assumptions, coordinates, data fields, budgets and twelve PENDING acceptance rows.

### 2026-10-23 — WebGPU loss hook: real destroy, not a fake event

- **Chose a symbol-gated dev hook over a public device method.** Added `FORCE_DEVICE_LOST` and a `[FORCE_DEVICE_LOST]()` member in `WebGpuRendererDevice`; the only supported caller is the new `@lanpad/engine-renderer-webgpu/dev` subpath (`forceWebGpuDeviceLost`). It calls `GPUDevice.destroy()`, so the real `device.lost` promise runs the existing loss/restore path. Production code does not import the subpath and cannot call the symbol by accident.
- **Why not monkey-patch in the page:** the browser agent refused to fake a loss; that was correct. This gives it a real loss to exercise.
- **Unit evidence:** `deviceloss.test.ts` asserts the hook destroys, reaches `lost`, refuses a second call while not running, and restores to `running`; the fake's `destroy()` now resolves `lost` with reason `destroyed`, matching WebGPU. WebGPU suite **169/169**, tsc/lint clean, package rebuilt with `dist/dev.js`.
- **Browser half in flight:** the browser owner is extending the WebGPU `contextloss` case to include first-loss recovery and the terminal second-loss rule.
- **Next:** browser hand-back → ER-04-05 evidence (or an honest blocker) → full gate.

### 2026-10-23 — watchdog: M1 wave in flight

- **Changed since the last entry:** physics owner has begun the Rapier subtree (`src/rapier/{load,internal,hash,errors}.ts`); audio owner has 15+ modules (clock, mixer, spatial, voice, config, decode); browser owner is extending the WebGPU loss case with the new dev hook. No hand-back yet.
- **No gate run while three agents write.** Last green gate stands: 222 files / 2,525 tests before the WebGPU hook; the WebGPU suite alone is 169/169 after it.
- **Chose not to start streaming/animation packages yet:** new packages need a root install and root config edits; doing that while the physics owner may still touch the lockfile is the kind of race the wave rules forbid. It starts after the physics hand-back.
- **Next:** verify each hand-back scoped (tests, tsc, lint, build), add only the traceability rows whose tags exist, then one full gate.

### 2026-10-23 — real-browser smoke found and fixed the “tiny game” stage bug

- **What the browser showed:** opening Coin Run in the real host produced a **300×150** game near the bottom of a 2560×1384 window — the exact symptom the user reported earlier (“a very small screen at the bottom”). The pixel content was drawn; only layout was wrong.
- **Root causes (both real, both fixed):**
  1. `.lanpad-stage-bar` is inserted as the second child of the `.host` grid. With only two declared rows, it took the `minmax(0,1fr)` row (1162px) and pushed `.host-body` into an implicit auto row (158px) at the bottom. Fix: `.host` now declares `64px auto minmax(0,1fr)`; the stage bar is a 40px row, the stage body is the flexible one. The reconnect banner became an absolute overlay so it never shifts the game.
  2. The renderer writes inline `style.width/height` on resize. On first mount it measured the canvas's intrinsic 300×150 and froze it there, and inline styles beat the stage stylesheet. Fix: `applySize()` clears the inline width/height before measuring, so the stylesheet computes the 16:9 box; the renderer then writes the measured size. Dynamic resolution still only changes DPR, not the CSS box.
- **Viewport budget corrected:** the canvas formula still assumed only a 64px header. It now reserves the 64px header + 40px stage bar + 16px margin.
- **Verified in real Chrome at two sizes:** 2560×1384 → canvas 2247×1264, `scrollHeight === clientHeight`, no scrollbar; live resize to 1280×720 → backing and CSS box 1067×600, still no overflow. Screenshot shows the full Coin Run stage with HUD and “Waiting for players”.
- **Code touched:** `packages/runtime/src/style.css` (host rows, stage bar, reconnect overlay, canvas fit) and `packages/runtime/src/host/stage.ts` (`applySize`). No game, engine or contract change.
- **Not claimed:** this is desktop Chrome layout evidence, not TV/Android; the controller-join path still needs a phone to start a round.
- **Next:** runtime tests after the host change, then the physics/audio/browser hand-backs and one full gate.

### 2026-10-23 — WebGPU loss PASS; phone join confirmed, layout loop not yet proven

- **ER-04-05 now has real browser evidence.** The dev hook destroyed the real `GPUDevice`; the real `device.lost` promise drove the engine path. States `running → lost → running → failed`; pre/post hash both `32312240`; recovery **63.6 ms / 1 frame**; 3 handles unchanged and reused; second loss reached `failed` after exactly one refused `restore()` (`E_DEVICE_LOST`). `gpuErrors` is 2, which is correct for two real losses, not a failure.
- **Honest limits kept:** the page loads no assets and runs no game loop, so `noAssetRefetch` and `noGameRestart` are `null`, not true. `device.size` reads 0×0 because the page never resizes in that case; the canvas backing is correct and the artifact documents it. Headless desktop only.
- **Recorded:** `docs/RESULTS.md`, TRACEABILITY ER-04-05, REVIEW RV-39 updated. No row claims the unobserved clauses.
- **Phone loop smoke (partial, deliberately not a claim):** a real controller tab joined room `09NV` as **P1** and showed “Connected (P1)”; the host showed 1 player. The controller never mounted a layout in this single-browser two-tab test. Cause is not isolated: Chrome background-tab throttling plus host visibility pause make the two-tab setup unreliable, and the host direct route later fell back to the lobby. This is **not** recorded as a pass or as a product bug yet; it needs a two-device or two-window run.
- **Second finding to verify separately:** after a host resume, the room panel renders `PIN ----`, so a new phone cannot join a resumed room from the displayed UI. Recorded here as an observation; the phone platform is frozen and this was not changed.
- **Next:** physics/audio hand-backs, then the full gate. Input/layout parity gets a dedicated two-device test, not an inference from this run.

### 2026-10-23 — watchdog: in-flight audio tests make trace transiently red

- **Changed since the last entry:** the audio owner has added tagged tests across `unlock`, `distance`, `voiceStealing`, `budget`, `config` and `audioSystem`; the physics owner has `RapierPhysics3D.ts`, `Character.ts`, `Vehicle.ts` but no tagged tests yet. Both agents still running (~44m).
- **Trace is red for one reason only:** 83 unknown tags, all `ER-09-*`, because `TRACEABILITY.md` has no audio rows yet and the audio tests are already on disk. No `ER-07` tags exist yet. This is the expected mid-wave state; the gate is not run until the hand-backs.
- **Do not pre-add rows:** ER-09-15 appears only in a test comment as a placeholder and is **not** in spec 09. At integration I will either add a real spec row + acceptance for the config behavior or retag that test to an existing ID. Adding a row just to silence the trace would be the wrong fix.
- **Also noticed:** `git status` shows the whole `docs/engine/` tree as untracked (expected; nothing committed in this checkout).
- **Next:** hand-backs → scoped verification → rows only for tags that resolve to a spec requirement → full gate.

### 2026-10-23 — audio implementation integrated

- **Verified independently:** 11 files / **128 tests**, tsc, eslint and the package build all clean. No files outside `packages/engine/audio/**` were touched by the owner.
- **Rows registered:** ER-09-01…15 added to TRACEABILITY. Unit-backed: 01, 04 (policy half), 06 (clock half), 09, 10 (AudioBus half), 12, 14, 15. The rest stay PENDING for offline renders, browser visibility, heap/frame, latency or TV.
- **Spec fixes, not test weakening:**
  - ER-09-04's acceptance expected `droppedPlays = 56` while §5.4 permits stealing equal priority. Amended the row to `steals = 56`, `droppedPlays = 0`, with §5.4 as the authority. RV-50 closed.
  - Config validation had no acceptance row even though §4.2/§4.3 and 18 tests cover it. Added **ER-09-15** and tagged `config.test.ts` with `@req ER-09-15`; removed the placeholder comment that made the trace see a non-existent ID.
- **Open findings:** RV-51 (stream registration exists only on the concrete class) and RV-52 (`AudioBus.decodeAudio` rejects while locked as frozen parity; the new path no-ops).
- **No RESULTS claim:** there is no browser or hardware measurement for audio yet, so nothing is marked PASS beyond CI unit evidence.
- **Next:** physics hand-back, then the full gate and a trace with 0 unknown.

### 2026-10-23 — physics adapter integrated (partial); full gate green

- **Accepted what is real, recorded what is not.** The Rapier adapter exists (`RapierPhysics3D.ts`, character, vehicle, hash, loader; ~2,100 lines) with 31 contract tests covering lifecycle, fixed-dt, caps, validation, queries, joints, events, scene sync and determinism primitives. **None of the six M1 acceptance fixtures were authored**, so ER-07-02/03/04/05/06/07/08/09/10/11/12 stay PENDING. No row was promoted on adapter existence alone.
- **A15 recorded from the installed package:** Rapier **0.21.0**, Apache-2.0; wasm 3,082,103 B / **1,175,669 B gz**; `rapier.mjs` 4,340,292 B / **1,644,109 B gz**. Local file-size measurement only — not a browser transfer size. `DEPENDENCIES.md` now has the installed row.
- **Budget amended:** ER-07-10's 80 KB physics budget predated A15. It now excludes the Rapier payload: package JS ≤80 KB gz, lazy Rapier ≤2 MiB gz, host total still ≤5 MB. RV-53 closed; the package-size gate runs when the runtime imports physics.
- **Defects found and recorded, not hidden:** RV-54 (queries miss before the first step), RV-55 (sleep overlay, island wake untested), **RV-56 (solver iterations/warm-start accepted but unused — ER-07-02 sensitivity is hollow until fixed)**, RV-57 (friction combine is Average, spec requires geometric mean), RV-58 (zero telemetry), RV-59 (validation matrix gaps), RV-60 (approximate contact counts).
- **Full gate:** exit 0, **234 files / 2,685 tests**, trace 0 missing / 0 unknown, controller 40,794/40,960 gz, host **75,822**/3,145,728 gz.
- **Next:** resume the physics owner with one narrow job — author the six fixtures and fix RV-56/RV-57 first; no new surface area. Then the streaming package wave.

### 2026-10-23 — topology wave: physics fixtures, streaming, animation

- **Chose three parallel owners on disjoint new/old package trees:** physics follow-up (`packages/engine/physics/**`), world streaming (`packages/engine/streaming/**` new), skeletal animation (`packages/engine/animation/**` new). Streaming and animation own package-local configs only; root tsconfig/vitest/lockfile wiring stays with integration so no two agents touch a shared file.
- **Physics follow-up is deliberately narrow:** geometric-mean friction (RV-57), real solver-config sensitivity (RV-56), then the six ER-07 fixtures. No new API surface. The agent must report any fixture that exposes a spec/Rapier conflict instead of weakening it.
- **Streaming wave scope:** deterministic core (grid, index, LOD, priority, residency, ledger, CSTR, decode validation, stats, cache, facade) plus generated fixtures; worker/browser/heap rows stay PENDING.
- **Animation wave scope:** sampling, blend trees, layers/masks, root motion, morphs, event markers, pooled instances; synthetic fixtures; browser skinning stays PENDING.
- **Gate before this wave:** exit 0, 234 files / 2,685 tests, trace 0 unknown, host 75,822 gz.
- **Next:** hand-backs → root wiring for the two new packages (`tsconfig.json`, `vitest.config.ts`, workspace install) → traceability rows for only the real ER-08/ER-12 tags → full gate.

### 2026-10-23 — watchdog: three owners reading specs

- **Changed since the last entry:** nothing on disk from the three owners yet; all are 3–4 minutes in and still reading specs. Physics follow-up, streaming and animation were launched.
- **Tree state:** the last full gate is still green (234 files / 2,685 tests, trace 0 unknown). The in-flight owners write only inside their packages, and the two new packages are not yet in root configs, so the gate is not polluted mid-wave.
- **Chose not to start host 3D wiring (RV-49) in parallel:** it touches sdk + runtime + launcher and needs a browser pass; starting it while three hand-backs are due would compete for integration attention and risk two writers on the host. It is the first task after this wave.
- **Next:** on each hand-back, wire the package, register only tags that resolve to a spec row, scoped-verify, then one full gate.

### 2026-10-23 — watchdog: all three waves producing code

- **Changed since the last entry:**
  - Streaming is unblocked: `StreamEvents`, `Grid`, `Index`, `Lod`, `Priority`, `Memory`, `StateStore`, `Cache` exist, plus the contract. The exact Glob→facts→write protocol worked.
  - Animation has `PoseBuffer`, interpolation, clip compile/sampling, skeleton, blend1d, layers, root motion, palette, events, hash, instance API and both contracts.
  - Physics has authored `determinism-600.json`, `vehicle-slalom.json`, `ccd-wall.json` and the matching tagged tests (`determinism`, `vehicle`, `ccd`).
- **Tree note:** physics tests now carry ER-07-02/03/06 tags that have no TRACEABILITY rows yet, so the trace would be red until integration. The two new packages are still outside root configs. No gate run mid-wave.
- **Chose not to add rows for physics yet:** the agent may still be iterating on those fixtures; rows are added after its hand-back, only for tags whose tests remain.
- **Next:** hand-backs → scoped verification → root wiring for streaming/animation → rows → full gate.

### 2026-10-23 — watchdog: all modules present, tests in progress

- **Changed since the last entry:** streaming now has every core module plus `index.ts`, a package vitest config, and test helpers/support; animation has the API facade and `index.ts` with tests; physics has added a temporary `test/unit/_probe.test.ts` used to generate/verify fixtures.
- **Chose:** no integration edits while the owners still hold their files. `_probe.test.ts` must be deleted before the wave lands — it is a probe, not an acceptance test, and must not survive into the gate.
- **Tree note:** the last full gate remains green; these packages are outside root configs (streaming/animation) and the new physics tags have no rows yet, so the trace is transiently red by design.
- **Next:** hand-backs → remove probes → wire both packages into root tsconfig/vitest and install → add only surviving ER-07/08/12 rows → full gate.

### 2026-10-23 — watchdog: fixture generation under way

- **Changed since the last entry:** streaming has generated its 64×64 manifest, invalid cell/manifest fixtures, drive/focus fixtures and golden `.cell`/hash files; animation has six unit suites (sampling, blending, events, morph, root motion, determinism); physics still has `_probe.test.ts` plus `materials.test.ts` (the RV-57 fix test) and its fixture suites.
- **Chose:** let the owners finish rather than interrupting at 49m. No shared file is touched; the gate remains green at the last run. The probe test is still flagged for removal at integration if the owner does not remove it.
- **Next:** hand-backs → scoped verification → root wiring → rows → full gate.

### 2026-10-23 — animation integrated (unit)

- **Verified independently:** 7 files / **52 tests**, tsc, eslint, package build and the root `npm run typecheck` all clean. No files outside `packages/engine/animation/**`.
- **Root-wired:** added the package to root `tsconfig.json` references and the Vitest project list, ran `npm install` to link the workspace, and the root project runs the same 52 tests. `npm audit --omit=dev` remains **0 vulnerabilities** (the 3 advisories npm reported are dev-only).
- **Rows registered only where tests exist:** ER-08-01…05 and ER-08-10 in TRACEABILITY, each with its PENDING browser/GPU half stated. ER-08-06…09/11/12 have no tagged tests and were not registered — adding them would make the trace report missing IDs.
- **Recorded findings:** RV-66 root-motion delta semantics need a spec decision; RV-67/68 additive `scene` and `loop`; RV-69 CPU morphs without GPU deformation; RV-70 additive layers rejected at M1; RV-71 dead `rootAccumClamp`.
- **Not claimed:** GPU skinning, 2D blend trees, ping-pong, performance/memory/bundle/TV, or Chrome determinism. The package is unit-complete for M1 sampling, not renderer-complete.
- **Next:** physics and streaming hand-backs → wire streaming → final gate.

### 2026-10-23 — streaming integrated; budget bug found and fixed

- **Verified independently:** 7 files / **108 tests**, tsc, eslint, package build, root typecheck and the root Vitest project all clean. Root-wired `tsconfig.json` + `vitest.config.ts`; the workspace was already linked.
- **Found a real acceptance bug, not just a missing test:** `tryActivate` charged decoded payloads without checking `ledger.wouldExceed()` or `maxResidentCells`, so ER-12-03's "residentBytes never exceeds the budget" was false under load. Fixed activation to compare the decoded byte delta and the resident-cell cap before marking resident; a cell that does not fit stays ready. Added `streamer-budget.test.ts` asserting both budgets on every tick; 2 new tests. RV-72 closed.
- **Fixed the check failures the owner left:** two test type errors, one lint error (`manifestUrl`), and a semantics slip while fixing an optional-chained bit test (corrected to `(flags ?? 0) & 0x1`).
- **Rows registered only for existing tags:** ER-12-01/03/06/07/08/09/11/12. ER-12-02/05/10 and the browser rows stay unregistered/PENDING; I removed a comment that mentioned ER-12-10 without a test.
- **Spec amendments recorded:** ER-12-02's arithmetic (2 km at 40 m/s ≠ 120 s) is now 4.8 km / 120 s and the fixture was renamed `drive-path-4_8km.json`; ER-12-01 rejects every hole until a water/void flag exists; ER-12-03 names the sim-ring admission guard.
- **Review:** RV-72 closed; RV-73 (LOD re-activation) and RV-74 (CSTR flags) added. RV-61/62 (core types/error codes) and RV-63/64 remain open.
- **Trace now:** 0 missing, 7 unknown — all ER-07-02/03/04/06/07 from the physics fixtures awaiting its hand-back.
- **Next:** physics hand-back → its rows → full gate.

### 2026-10-23 — watchdog: physics sleep fix in progress

- **Changed since the last entry:** streaming is integrated (108 tests, root-wired, budget guard fixed); physics is the only red suite: ER-07-07's 64-box stack never all sleeps (`sleepTick = -1`). The owner updated `RapierPhysics3D.ts` (07:10) and `stack.test.ts` (07:15) and is still running, so it is actively on that failure.
- **Chose:** no second writer on `packages/engine/physics/**`. The gate is held; do not mark ER-07-07 or remove the test. The failure is exactly RV-55 (island sleep), and it must be fixed in the adapter, not weakened.
- **Trace:** 0 missing / 0 unknown with the new ER-07 and ER-12 rows; 486 test files.
- **Next:** physics hand-back → rerun its suite → full gate. If the owner returns without a green stack test, fix the island-sleep path directly or resume it, never skip.

### 2026-10-23 — watchdog: sleep probe still running; takeover deadline set

- **Changed since the last entry:** the physics owner added `test/tmp-probe.test.ts`, a raw-Rapier diagnostic comparing adapter and native world parameters; `RapierPhysics3D.ts` and `stack.test.ts` were updated again. ER-07-07 still fails at 07:38 (`sleepTick = -1`).
- **Chose a deadline:** if there is no green stack test and hand-back by the next watchdog (~15 min), I will stop the owner to preserve one-writer, delete the three temporary probes (`tmp-probe.test.ts`, `_probe.test.ts`, any other `*probe*`), and fix the island-sleep path in the adapter myself. The acceptance assertion stays exactly as written.
- **Root-cause direction (recorded, not yet applied):** the overlay sleeps individual bodies; Rapier wakes neighbours through contacts, so the stack never reaches all-asleep. The likely fix is native island sleeping (`setCanSleep(true)` with the overlay used only as a threshold shim) or an explicit island sleep when the timer expires.
- **Tree:** trace is green (0 unknown); the physics suite is the only red one. Gate remains held.

### 2026-10-23 — watchdog: island sleep fixed; two typecheck errors left

- **Changed since the last entry:** the physics owner fixed ER-07-07 — the 64-box stack now sleeps and wakes only its island. Full physics Vitest is **7 files / 40 tests green**, including determinism-600 and the solver-sensitivity check (RV-56), plus ER-07-08's filter matrix.
- **Still red at the type level:** `tsc -p .../tsconfig.test.json` reports two errors — a `BodySlot` initializer missing the new `sleepGravityScale` field, and `character.test.ts` importing `Vec3` from the package index instead of `@lanpad/engine-core`. Lint is clean; the package build fails only because of these.
- **Chose:** give the active owner a short window to fix its own files (one-writer); if the next check still shows these errors, fix them directly. Do not touch the passing assertions.
- **Next:** fix tsc → add ER-07-08 row → full gate.

### 2026-10-23 — physics acceptance wave complete (Node)

- **Verified independently:** 8 files / **43 tests**, tsc, eslint and the package build all clean; no probe files remain. The suite is now real acceptance fixtures, not just the contract surface.
- **Measured Node evidence recorded:** determinism-600 (259 bodies, two runs `3733532183`; `velocityIterations` 4 → `3756658819`), vehicle slalom (30 m/s at 6.22 s, 150.53 m, zero wheel-air ticks), character course (ramp/step/drop/wall/ceiling), CCD 10,000 crossings with zero tunnels, 64-box sleep at tick 31 with drift 0 and a 32/32 island split, and the 1,024-pair filter matrix.
- **RV-55/57 closed; RV-56 partially closed:** island sleep is implemented with contact/joint BFS plus gravity-scale zeroing; friction is the true geometric mean. `positionIterations`/`warmStarting` still have no Rapier 0.21 JS mapping, so the spec now names `velocityIterations` as the sensitivity knob instead of pretending all four work.
- **New backend limit recorded (RV-75):** Rapier 0.21 CCD is world-wide via `maxCcdSubsteps`; per-body `ccd:false` cannot produce ER-07-06's pass-through control. The test asserts only the no-tunnelling half and records `specConflict`; the row stays PENDING on that clause.
- **Spec amended:** ER-07-02 names `velocityIterations`; ER-07-06 records the CCD limitation. No assertion was weakened.
- **Next:** full gate across all 486+ test files.

### 2026-10-23 — wave gate green after physics/streaming/animation

- **Full gate:** exit 0, **255 files / 2,857 tests**, trace 0 missing / 0 unknown, controller 40,794/40,960 gz, host **75,822**/3,145,728 gz. This is the wave boundary; the tree is green.
- **What the wave added:** streaming core (108 tests + budget guard), animation sampling/blending (52), physics acceptance fixtures (43), audio (128), asset bridge and Canvas2D host adapter.
- **What it did not add:** no browser/hardware halves for physics, streaming, animation or audio; no 3D host path; no Block 7 game. Those remain the M1 program.
- **Next wave decision:** open the M1 host 3D path (RV-49) and, in parallel, the 2D solver migration plus core world types/error codes (RV-61/62). The Block 7 game follows the host path, because a 3D game cannot open on the Canvas2D-only stage today.

### 2026-10-23 — M1 host-3D and core-contract wave opened

- **Chose two disjoint owners:**
  - **Host 3D path (RV-49):** additive manifest `renderer?: "canvas2d" | "engine"`, load-before-select in `stage.ts`, `selectRenderer(require3D)` for engine games, and a new `EngineGameRenderer` that maps `setCamera`/`drawCube` onto the engine `RenderDevice` (one cube mesh, cached per-color materials, `drawInstanced`). Adds a small `engine-cube` game and root game wiring so the path is exercised end-to-end. Owns sdk manifest/schema, the runtime renderer block, the new adapter and the new game.
  - **Core contract gaps (RV-61/62):** world types (`CellKey`, `WorldCell`, `CellState`, …) and all `E_WORLD_*`/`E_CELL_*`/`E_STREAM_*`/`E_STATE_*` codes move into `engine-core` additively; streaming re-exports instead of redeclaring. Owns core contracts/index/tests plus the streaming contract/error re-export only.
- **Not started:** the 2D solver move to `engine/physics/src/two-d/` and the Block 7 content slice. The 2D move waits until the host-3D owner releases the runtime; Block 7 waits for the engine renderer path.
- **Constraint restated to both owners:** the Fact-Forcing Gate protocol (Glob → four facts → same Write) and scoped checks only; no full gate.
- **Gate before this wave:** exit 0, 255 files / 2,857 tests, trace 0/0, host 75,822 gz.
- **Next:** hand-backs → browser verification of the 3D host path → full gate.

### 2026-10-23 — watchdog: M1 wave reading specs

- **Changed since the last entry:** nothing on disk yet; both owners are ~5 minutes in and still reading (`engine3DRenderer.ts` and `engine-cube/` do not exist; no core `world.d.ts` yet). No workflow notifications.
- **Chose:** no third work stream and no pre-emptive edits to runtime/sdk/core while both owners hold those files. The gate remains green at 255 files / 2,857 tests.
- **Next:** hand-backs → scoped verification → browser check of the engine-cube path on WebGPU/WebGL2 → full gate.

### 2026-10-23 — core world types and error codes closed

- **Verified independently:** core **40 files / 290 tests**, streaming **108 tests**, both package typechecks, eslint and both builds clean.
- **What moved:** `CellKey`, `WorldCellId`, `CellState`, `WorldCell` now live in `engine-core/contracts/world.d.ts` and are re-exported by streaming; 32 `E_WORLD_*`/`E_CELL_*`/`E_STREAM_*`/`E_STATE_*` codes were added additively (union 39 → 71). `StreamingErrorCode` is now an `Extract` of the core union; no duplicate definitions remain and a source/type test enforces that.
- **No behavior change:** declaration-only and type-only; `StreamingErrorCode` erases, `RECOVERABLE`/`errorCodeOf` unchanged.
- **Watch item:** core's `worldContract.test.ts` imports streaming types, so a cold package-level core typecheck needs streaming built once. The root `tsc -b` order already handles project references; recorded for tooling.
- **RV-61/62 closed.** Next: the host 3D hand-back, then one full gate.

### 2026-10-23 — watchdog: 3D host files landed; core contracts closed

- **Changed since the last entry:** the host-3D owner has produced `engine3DRenderer.ts`, its unit test, a renderer-selection test, `packages/games/engine-cube/` (manifest, layout, game, test, tsconfig, vitest config), and the root Vitest project entry. It is still running, likely on checks.
- **Core agent is complete and verified:** 290 core tests / 108 streaming tests, tsc/lint/build clean; RV-61/62 closed.
- **Integration issue identified for the hand-back:** the adapter reports `"webgl2"` on both engine backends because the runtime's legacy `RendererBackend` has no `"webgpu"`; the overlay would lie. Plan: widen that runtime-internal union additively to `"webgpu"` and report `device.backend`, then update the overlay/test expectations.
- **Next:** hand-back → fix backend reporting → browser-verify `engine-cube` on WebGPU and WebGL2 → full gate.

### 2026-10-23 — host 3D path verified on WebGPU

- **Verified independently:** runtime **423 tests**, engine-cube **8**, sdk **115**, typecheck and lint clean. I widened the runtime `RendererBackend` union additively with `"webgpu"` and fixed two places that still hardcoded `"webgl2"` (the adapter and the stage return), so the overlay reports the true backend. The WebGPU-success selection test now asserts `webgpu`; the WebGL2-fallback test still asserts `webgl2`.
- **Real browser evidence:** served the built host, opened `/games/engine-cube/`, pressed the start gesture, and the stage ran a 2007×1129 canvas with a **real WebGPU context** (`getContext("webgpu")` non-null, `getContext("webgl2")` null) rendering three spinning cubes. Screenshot captured. This closes RV-49; no frame-time or WebGL2-host claim is made.
- **Found a renderer defect, not a host bug:** the cubes render dark (`#6ee7ff`/`#ffd166` appear teal/brown). Cause: the WebGPU swapchain is `bgra8unorm` and `fs_main` writes unencoded linear light. Converting CSS colors to linear in the adapter made it darker still, so I reverted that and recorded **RV-76** with the real fix (sRGB swapchain or shader encode, then re-record goldens). No adapter compensation.
- **Unit evidence for the rest:** the adapter tests cover mesh-once, per-color grouping, camera/depth convention, resize, invalid frames, buffer reuse, material cap and dispose; selection tests cover Canvas2D refusal and WebGPU→WebGL2 fallback.
- **Next:** stop the smoke server, rebuild, and run the full gate. WebGL2 host rendering remains unit-backed until a forced-WebGL2 browser run exists.

### 2026-10-23 — 3D host wave gate green

- **Full gate:** exit 0, **259 files / 2,894 tests**, trace 0 missing / 0 unknown, controller 40,794/40,960 gz, host **127,778**/3,145,728 gz. Host gzip rose from 75,822 because the 3D adapter and `selectRenderer` engine code are now in the host chunk; still ~4% of the hard budget.
- **Trace fix:** the new 3D tests tagged ER-04-08, which had no row. Added it with the honest split: buffer reuse proven in unit tests, 480-frame heap bench still PENDING.
- **What is proven:** a real WebGPU host path for `renderer: "engine"` games (engine-cube), a truthful `webgpu` backend report, Canvas2D refusal, WebGPU→WebGL2 fallback in unit tests, and 423 runtime tests. What is not: WebGL2 host browser pixels, frame times, and correct color output (RV-76).
- **Next wave:** (a) move the 2D solver into `engine/physics/src/two-d/` with the runtime compatibility re-export and a golden parity fixture (ER-07-09); (b) implement the runtime save API on the existing save codecs. The Block 7 slice waits for a game-facing physics/`ctx.world` layer.

### 2026-10-23 — 2D migration and runtime save wave opened

- **Chose two disjoint owners:**
  - **2D solver migration (ER-07-09):** move `Vec2`/AABB/collision/integrate into `engine/physics/src/two-d/` with a `./two-d` export; runtime `src/physics` becomes a compatibility re-export. A pre-migration 300-tick golden must be reproduced exactly; no game edits and no behavior change allowed.
  - **Runtime save API (15/18):** implement `SaveApi` over the existing core codecs with an injected storage adapter, atomic writes, quota/corruption handling, per-game isolation, and additive `ctx.save` wiring. Browser storage rows stay PENDING.
- **Ownership is disjoint:** physics+`runtime/src/physics` vs `runtime/src/game`+capabilities+tests. No root config, sdk, docs or engine-core edits by either.
- **Deferred:** RV-76 (WebGPU sRGB output). It is a renderer-wide color-pipeline change that will move every golden; it needs its own wave with re-recorded goldens and both backends aligned. Do not let a game adapter compensate in the meantime.
- **Gate before this wave:** exit 0, 259 files / 2,894 tests, trace 0/0, host 127,778 gz.
- **Next:** hand-backs → scoped verification → trace rows only for existing IDs → full gate.

### 2026-10-23 — watchdog: 2D/save owners reading

- **Changed since the last entry:** no source files from either owner yet (`two-d/` and `SaveApi.ts` do not exist); both are in the reading phase.
- **Tree:** the last full gate is green (259 files / 2,894 tests, trace 0/0); no shared file is being written.
- **Chose:** wait rather than start a third stream. The RV-76 color fix is deliberately deferred to its own golden-moving wave.
- **Next:** hand-backs → scoped verification → full gate.

### 2026-10-23 — watchdog: 2D files moved, save still reading

- **Changed since the last entry:** `packages/engine/physics/src/two-d/` now contains `Vec2`, `Aabb`, `collide` and `index`; the save owner has not written `SaveApi.ts` yet. Both owners ~8 minutes in.
- **Chose:** no interference. The 2D owner must still prove the pre-migration 300-tick golden; file existence alone is not parity.
- **Tree:** last full gate green (259 files / 2,894 tests, trace 0/0).
- **Next:** hand-backs → scoped verification of both → full gate.

### 2026-10-23 — 2D solver migration integrated

- **Verified independently:** physics **11 files / 58 tests** (15 new two-d tests), runtime physics 22/22, platformer 90/90, both typechecks, lint and both package builds clean.
- **Parity evidence:** the moved solver reproduces the pre-migration 300-tick golden bit-for-bit — fixture sha256 `c8d0546c…`, first hash `6ea8c94a`, tick-300 `31b03748`, 16 bodies, 10 samples; the generator was deleted before the move and the fixture was not edited.
- **Wiring fixes the owner could not make:** added `@lanpad/engine-physics` to the runtime dependencies, added the physics project reference to `packages/runtime/tsconfig.json`, updated `docs/ENGINE.md`'s physics source path/bullet, registered ER-07-09, and ran `npm install`.
- **Spec reconciliation:** RV-77 — spec 02's deprecated-re-export table conflicts with 07 §5.15's move; resolved in favour of 07/M1, since the files moved byte-identically and nothing imports the removed modules. RV-78 records the frozen solver's denormal underflow as documented, unchanged behavior.
- **Next:** save-API hand-back → full gate.

### 2026-10-23 — watchdog: save tests green, wiring in progress

- **Changed since the last entry:** `SaveApi.ts` and `saveApi.test.ts` exist; the new save suite passes **29/29**. `GameContext.ts` is modified; the owner is still running, likely finishing `GameHost`/capability wiring and scoped checks. 2D migration is fully integrated and verified.
- **Chose:** no gate while `GameContext`/`GameHost` are mid-wiring. No second writer.
- **Tree:** last full gate green (259 files / 2,894 tests); the save files are outside root configs until they land.
- **Next:** hand-back → verify the save wiring (context exposes `save`, storage-unavailable path) → full gate.

### 2026-10-23 — save API: localStorage brief rejected by spec; OPFS/IDB follow-up

- **The agent delivered a solid SaveApi at 29 tests**, but it flagged that spec 15 §4.11 explicitly rejects localStorage (sync, ~5 MB, string-only, no atomic replace). My brief had named localStorage; the spec wins. Sent it back to implement the spec tiers: **OPFS primary when secure + `getDirectory` + `move`, IndexedDB fallback, no localStorage production adapter**.
- **Integration fixes already applied:** added `@lanpad/engine-physics` to the runtime dependencies and project references, updated the renderer dependency allowlist (the cross-wave failure), passed `gameId: slug` into `GameHost` so production `ctx.save` can bind, and registered ER-15-07/08/10/12 rows with their PENDING browser halves.
- **Not claimed:** the localStorage adapter is provisional and will be removed; no save browser evidence exists.
- **Chose:** one follow-up owner instead of a second parallel save implementation; the storage seam is already in place.
- **Next:** OPFS/IDB hand-back → runtime suite green → full gate.

### 2026-10-23 — color-pipeline wave opened (RV-76)

- **Reversed the earlier deferral:** RV-76 is high-severity visual correctness, not polish. Opened a renderer owner now because the save owner is confined to runtime/game and the two do not overlap.
- **Scope:** fix output encoding once, in the renderer, for **both** backends — prefer an sRGB swapchain format when probed as supported, else encode linear→sRGB exactly once at shader output, without double-encoding sRGB textures. Unit tests for the encoding path; all existing renderer tests stay green.
- **Goldens:** re-record cube and scene5000 only after the fix, via the runner, and record new hashes/timings plus the cross-backend diff in a new RESULTS section. Old rows stay as historical evidence. If the backends cannot align within 2%/8-255, the owner must stop and report, not loosen the tolerance.
- **Explicit non-goal:** no compensation in `EngineGameRenderer`, any game, or the Canvas2D adapter. The runtime adapter keeps passing CSS colors through until the renderer is correct.
- **Gate before the wave:** exit 0 at 259 files / 2,894 tests (before the save integration, which is in flight).
- **Next:** both hand-backs → scoped verification → one full gate.

### 2026-10-23 — save storage corrected to OPFS/IndexedDB

- **Verified independently:** save suite **48/48**, runtime project **472/472**, tsc/lint clean. The production selector is OPFS (secure + `getDirectory` + `move`) → IndexedDB → absent; localStorage is test-only and a regression test proves the selector never picks it. GameHost awaits the async provider before `game.init` and rebuilds the frozen context; the stage passes `gameId: slug`.
- **Dependency:** `fake-indexeddb@^6.2.4` added as a test-only devDependency; DEPENDENCIES row added (0 browser bytes).
- **Rows:** ER-15-09 and ER-15-10 registered with adapter-level PASS and real-browser PENDING; ER-15-07/08/12 remain as recorded.
- **Residual findings:** RV-79 closed (localStorage brief was wrong); RV-80 no Web Locks, RV-81 no storage.estimate preflight, RV-82 no SHA-256, RV-83 no late-open dispose.
- **Not claimed:** real OPFS/IDB round trips, reload persistence, 32 MiB payloads, TV storage. No localStorage in production.
- **Next:** wait for the color hand-back → full gate.

### 2026-10-23 — watchdog: color goldens re-recorded, hand-back pending

- **Changed since the last entry:** the color owner re-recorded cube and scene5000 artifacts at 640×360 and 1920×1080; the WebGPU cube and scene5000 artifacts report `goldenPass` and `crossBackendParityPass` both true. A new `docs/RESULTS.md` section exists (owner was allowed that one section). The owner is still running, likely final checks.
- **Save is closed:** OPFS→IndexedDB→absent, 48 tests, runtime 472/472, dependency/docs recorded.
- **Chose:** no gate until the color owner hands back its measured explanation and re-recorded hashes; then one full gate over both waves.
- **Next:** color hand-back → full gate → record final totals and close RV-76 if the evidence supports it.

### 2026-10-23 — color output corrected; goldens re-recorded

- **Verified independently:** both renderer suites **23 files / 358 tests**, both tsc and eslint clean. The agent ran 8 browser verify passes; all exit 0 with `golden.status = "matched"` and `gpuErrors = 0`.
- **Platform fact, probed not assumed:** Chrome 155 rejects both `bgra8unorm-srgb` and `rgba8unorm-srgb` canvas formats; WebGL2 has no `EXT_sRGB_write_control`. So both backends now encode linear→sRGB **once** at fragment output, with sRGB textures still sampler-decoded (no double encode). The probe shows authored `#ffd166` unlit as exactly (255,209,102) on both backends.
- **Goldens deliberately re-recorded:** cube 640 both `243224a8`; scene5000 1920p `cb91b2b4` (WebGPU) / `0883832e` (WebGL2); scene5000 640 both `e136aeda`. Cross-backend diff 0 pixels on cube/640 scene, 4 pixels at 1080p (0.000193%), tolerance unchanged. Old hashes remain as historical rows with pointers.
- **Docs:** new RESULTS section; spec 04 §5.13 corrected from “encoded to the swapchain’s sRGB format” to the shader-output encode and the platform limit; experiment README now carries a historical banner pointing at the current hashes. RV-76 closed.
- **Still PENDING:** TV/Android, GPU timestamps, 60 Hz vsync, and ER-04-09/ER-05-04’s tick-300 clause (capture is frame 60).
- **Next:** full gate across both the save and color waves.

### 2026-10-23 — watchdog: color probe and save storage in flight

- **Changed since the last entry:** the color owner has modified both shaders (`lit.wgsl.ts`, `forwardLit.ts`) and added a dedicated `srgb-probe.html/.mjs` to measure authored colors on both backends; the save owner has updated `SaveApi.ts`, `GameContext.ts` and `GameHost.ts` for the OPFS/IDB tiers.
- **Chose:** no gate while both write. The color wave must show measured pre/post pixels and aligned goldens; the save wave must show the OPFS/IDB adapters and no production localStorage.
- **Tree:** last full gate green (259 files / 2,894 tests); the save integration and shader changes are not yet claimed.
- **Next:** hand-backs → scoped verification → full gate; then update RESULTS/checkpoint with only measured values.

### 2026-10-23 — watchdog: final test passes

- **Changed since the last entry:** animation is integrated (52 tests, root-wired) — already recorded above. Physics added the character-course fixture/test; streaming has six unit suites and its support fixture. Both owners are still running at ~1h, likely on their final scoped checks.
- **Chose:** no new work stream until these two hand back. Animation's integration is complete; the host 3D path (RV-49) starts after the wave, not in parallel with it.
- **Tree note:** the last full gate is green; streaming is outside root configs, and the physics fixture tags still lack traceability rows until its hand-back.
- **Next:** hand-backs → rows → wire streaming → remove `_probe.test.ts` if it survives → full gate.

### 2026-10-23 — engine breadth frozen; bake-off started immediately

- **User decision:** run the bake-off from `references/decision we need.md` now, not a week-long plan. Freeze custom-engine breadth until the result: no new PBR, shadows, UI/text, editor or navigation work on the custom engine.
- **Contract:** `experiments/bakeoff/README.md` fixes one shared scene (3×3 cells, 14 buildings, car, 50 skinned peds, shadowed directional light, sky, cell activation), one metrics interface (`window.__BAKEOFF__`), one measurement protocol (1080p, 5 s warm-up + 60 s, three runs, all runs reported) and a 12-item capability checklist.
- **Owners (disjoint):** shared assets + runner; custom contender; PlayCanvas contender (`playcanvas@2.23.3` + Rapier); Babylon contender (`@babylonjs/core@9.32.0` + Havok/Rapier). No commits; no root config edits.
- **Assets:** generated in-repo (CC0), including a minimal skinned `ped.glb`; no Mixamo/bitmoji/restricted assets. `LICENSES.csv` required.
- **Decision rule:** adopt PlayCanvas or Babylon unless custom meets p95 14 ms at 1080p and both alternatives miss, or both have an unfixable blocking gap, or a bundle breaks 5 MiB gz.
- **What is frozen:** all custom-engine feature work, including the `ctx.world`/Block 7 plan, until ADR-0003 is written. Existing work stays in the repo and the green commit stands.
- **Next:** hand-backs → run the shared harness → ADR-0003 from measured results, not preference.

### 2026-10-23 — bake-off complete: Babylon.js adopted

- **Official matrix** (`experiments/bakeoff/runner/results.json`, sha256 `3f635a05…`, 11:58:35→12:10:26, one Chrome at a time, 3×60 s uncapped at 1080p):
  - Babylon: 3/3, p95 **7.39 / 10.865 / 7.835 ms**, boot **1,730,261 B gz**.
  - PlayCanvas: 2/3, p95 **13.96 / 13.09 ms**, boot **2,223,430 B gz**, run 1 lost the page context.
  - Custom: 3/3, p95 **0.735 / 0.79 / 0.845 ms**, boot **1,766,889 B gz**, but a reduced scene (no shadows, CPU pose buckets, no GameContext).
- **Decision rule applied:** custom cannot win because the clause requires both alternatives to miss 14 ms, and both measured alternatives meet it. No blocking-gap or bundle exception is met. Tie-break: Babylon has the lowest worst-case p95, the smallest boot, and 3 clean runs; **Babylon.js 9.32.0 is adopted as the engine base** (`docs/ADR-0003-engine-base.md`).
- **Not decided:** physics. A15 still selects Rapier; the bake-off used Havok, so Babylon+Rapier vs Havok needs its own integration/amendment. No migration code has been written.
- **Preserved:** protocol, broker/dev-server, controller, host lifecycle, SDK/GameContext, phone/room flow, layouts/panels/haptics, save/streaming design, all custom engine packages in the repo.
- **Freeze:** custom-engine feature work remains frozen. Migration planning may start; implementation waits for the user's explicit go.
- **Caveats:** uncapped rAF (not 60 Hz vsync), non-identical scenes, final-frame snapshots, PlayCanvas run 1 not rerun, desktop RTX 3050 Ti only, audio not audibly verified. Audit pending.
- **No commits.** The bake-off evidence and ADR are untracked/working-tree changes.

### 2026-10-23 — bake-off audit complete

- **Verdict unchanged:** `experiments/bakeoff/AUDIT.md` independently recomputed all official percentiles from raw frame arrays (within 0.005 ms storage rounding), verified cold-boot sums, confirmed 8/8 measured screenshots are 1920×1080 and non-blank, and found no per-contender harness leakage into `runner/results.json`. No exception fires; the rule triggers adoption, and Babylon has the strongest measured case (3/3, worst p95 10.865 ms, lowest boot, shadows present, shared 704 m path followed).
- **PlayCanvas not disqualified but not fairly rankable:** 2/3 runs, one context loss, and its car drove a 221.65 m ring rather than the shared 704 m path. A clean 3/3 shared-path run would be needed before ranking it fairly.
- **Paper-trail discrepancies recorded, none decision-changing:** stale unreferenced `runner/screenshots/playcanvas-run1.png`; PlayCanvas local heap range understated; custom checklist gzip component sum typo (matrix total 1,766,889 B is correct); ped clip is 1.333 s vs README 1.0 s; no build-hash field in runner results.
- **ADR updated** with the audit reference and ADR-0002's superseded status; `docs/RESULTS.md` keeps the measured matrix.
- **State:** custom-engine breadth remains frozen; no migration code; no commits. Migration starts only on the user's explicit go.

### 2026-10-23 — B1 host-on-Babylon spike

- **Go:** user asked to commit/push the bake-off decision and branch for Babylon work. Commit `7d9c7f4` pushed to `checkpoint/wave5-green`; branch `feat/babylon-engine` created and pushed.
- **Boundary chosen:** Babylon sits behind the frozen `Renderer3D`/`GameContext`; no Babylon type outside `packages/runtime/src/babylon/**`. Manifest gets an additive `"babylon"` value; `"engine"` (custom) stays until wave B4. This keeps every existing game and test contract intact during migration.
- **Clock:** GameHost keeps the fixed loop; the adapter calls `engine.beginFrame()`, `scene.render()`, `engine.endFrame()` inside the host frame. `runRenderLoop` is never used; a source-scan test enforces it.
- **Backend order:** WebGPU first (`WebGPUEngine.IsSupportedAsync` + `initAsync`), fresh canvas if it fails, then WebGL2 `Engine`. Both failing returns fixed copy, not an exception.
- **Physics:** unchanged. A15 Rapier stays in force; no physics package is loaded by the cube path. Havok vs Rapier decision deferred to a dedicated ADR after assets/B2, as planned.
- **Measured:** headless Chrome 155 / RTX 3050 Ti, canvas 1920×1080; WebGPU 3 draw calls, 335,560 rAF samples, p95 0.26 ms (uncapped; trivial scene), 0 errors; forced WebGL2 3 draw calls, 0 errors. Full gate exit 0: 267 files / 2,980 tests. Host dev boot 613,530 B gz (19.5% of budget); lazy Babylon chunks 185,237 + 87,705 + 2,698 B gz. Evidence in `experiments/babylon-host/`.
- **Not claimed:** no phone input run, no assets/animation/shadows/physics, no M1 frame budget. The 0.28 ms number is not a city-scene result.
- **No commit on this branch yet:** the user asked to branch, not to commit the migration spike.

### 2026-10-23 — Wave 0 contracts complete (PS5 build brief)

- **Defaults accepted:** D1–D8 exactly as written; recorded in `docs/ADR-0004-ps5-build.md`. Havok is try-first behind `Physics3D`; Rapier stays the fallback until stream H's vehicle test.
- **Contracts:** spec 22 `ctx.world` (`GameWorld3D`), spec 23 `assets.json` + validator, spec 24 `@lanpad/game-kit`, spec 25 `presentation` + console-shell `DESIGN.md` tier. The spec-12 streamer moved from `ctx.world` to `ctx.streaming` because no game consumed it (ADR-0004 clarification 1, amendment A20).
- **Shipped:** `sdk/src/world3d.ts`, `sdk/src/assets.ts`, `sdk/src/testing.ts` (`@lanpad/sdk/testing`), manifest presentation validation/schema, glob-based game discovery, `npm run play`, opt-in TLS, controller dev budget 50 KB (D4), debug-gated `?babylon-backend`, deadzone signed-zero fix, WebGL2 Babylon context-loss test, `template-game` fixture.
- **Evidence:** gate exit 0 — 269 files / 2,995 tests; controller 40,794 / 51,200 B gz; host 614,816 / 3,145,728 B gz; trace 0 unknown. Template Game appears in the launcher DOM with zero root-file edits. WebGL2 context loss: lost + restored, 3 draw calls, 0 errors.
- **Open:** WebGPU loss PENDING; TLS not exercised with a real cert/phone; `npm run play` not run end to end; template game to retire; all hardware rows PENDING.
- **Next:** Wave 1 streams A, B, C, F in parallel; G after A/B; D, E, H next.
