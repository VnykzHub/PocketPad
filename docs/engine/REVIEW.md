# Engine spec review — 2026-10-22

**Scope.** A cross-spec consistency review of the 20 numbered engine documents (00–19, 17,615 lines) before the W0 contract freeze. It checks interfaces, ownership, shared conventions and contradictions. It is **not** a line-by-line acceptance audit and it certifies no measurement.

**Verdict.** The spec set is **implementation-ready for W0 contracts** after the fixes recorded below. No spec contradicts amendments A14–A18. The remaining items are integration gaps with named owners, not design conflicts. Implementation still requires each contract's `.d.ts`, conformance suite and fixture; prose alone is not permission to build.

## 1. Inventory

| Spec | Lines | State |
|---|---:|---|
| `00-architecture.md` | 975 | Complete; ownership and frozen-contract policy |
| `01-core-loop-time.md` | 611 | Complete |
| `02-math.md` | 681 | Complete; conventions fixed |
| `03-scene-ecs.md` | 888 | Complete |
| `04-renderer-webgpu.md` | 1,147 | Complete; ABI 1 canonical |
| `05-renderer-webgl2.md` | 828 | Complete; aligned to ABI 1 |
| `06-assets.md` | 710 | Complete |
| `07-physics3d.md` | 1,077 | Complete; Rapier behind `Physics3D` |
| `08-animation.md` | 1,031 | Complete |
| `09-audio.md` | 652 | Complete |
| `10-input.md` | 901 | Complete |
| `11-ai-navigation.md` | 989 | Complete |
| `12-world-streaming.md` | 810 | Complete |
| `13-ui-text.md` | 950 | Complete |
| `14-networking.md` | 1,094 | Complete |
| `15-save-load.md` | 973 | Complete; M0 = header codec only |
| `16-tooling-profiler.md` | 698 | Complete |
| `17-editor.md` | 635 | Complete |
| `18-game-sdk.md` | 776 | Complete |
| `19-testing-benchmarks.md` | 1,003 | Complete; rig path canonical |

## 2. Resolved before freeze

| # | Conflict | Resolution | Where |
|---|---|---|---|
| 1 | 04 and 05 defined different ABI-1 vertex locations and instance slots | **04 is canonical.** ABI 1 is position 0, normal 1, uv 2, instance matrices 3–6. 05 accepts exactly those two layouts. Skinned/morph layouts become new layout ids with an ABI bump, never shifted locations | 04 §4.3; 05 §4.3 |
| 2 | Texture tokens differed (`rgba8unorm` vs `rgba8`, `rgba16float` vs `rgba16f`, `depth24plus` vs `depth24`) | One canonical `TextureFormat` union in 04, including compressed and float formats; 05 maps the exact tokens to WebGL2 internal formats and marks `bgra8unorm` unsupported on Tier B | 04 §4.5; 05 §4.4 |
| 3 | 00 assigned `ComponentType` to specs 01/04; 03 defines it | **03 owns** the ECS registration contract | 00 §3.2; 03 §3.2 |
| 4 | A second `Renderable` could appear in the renderer | Defined once in 03 as asset ids + visibility + layer; 04/05 declare no parallel component | 03 §3.3 |
| 5 | `queryAll` could leak pooled/disabled entities to games | Games see `query` only (disabled excluded); `queryAll`/`column` stay engine-internal; 18 exposes `query` only | 03 §3.4; 18 §3.4 |
| 6 | 04 assigned the scene encoder to spec 03; 03 assigned extraction to the renderer; neither defined it | **Runtime composition owns the encoder.** It queries `Renderable`, resolves asset ids through 06, sorts and submits low-level draws; backends never import assets | 03 §5.11; 04 §5.4 |
| 7 | Handedness/depth could drift between math, renderers, physics and animation | 02 fixes right-handed, **+Y up, −Z forward**, column-major, and two projection families (`webgl` z∈[−1,1], `webgpu` z∈[0,1]); downstream specs consume 02 | 02 §3.1 |
| 8 | 15's brief suggested SHA-256 in the save file; 00 freezes FNV-1a 32 | 15 keeps the frozen header. FNV-1a is the in-file check; SHA-256 is optional slot metadata. In-file SHA-256 would need A19 + save-format v2 | 00 §3.5; 15 §4 |
| 9 | 15 needs new save failures | Added `E_SAVE_GAME`, `E_SAVE_QUOTA`, `E_SAVE_IO`, `E_SAVE_MIGRATION`, `E_SAVE_SLOT`, `E_SAVE_UNSUPPORTED` to `EngineErrorCode` (codes may be added, never removed) | 00 §5.9 |
| 10 | The trace grammar rejected `ER-*` | Added `ER-\d+-\d+` to the ID regex, prefix order and numeric ordering; fixture test added. 16/16 trace tests pass, D0 exit 0 | `tools/trace-check` |
| 11 | 00's error union lacked two codes the specs already use | Added `E_SCENE_FORMAT` and `E_FRAME_CLOSED` additively to 00 §5.9 and the contract | 00 §5.9 |
| 12 | `Job<T>`'s phantom `T` tripped the unused-variable lint | `JobPayload<T> = unknown | T` (always `unknown`); spec 01 §3.6 and the contract now match | 01 §3.6 |
| 13 | 04 referenced `supportedFormats` but `RendererCapabilities` had no such field | Added `supportedFormats: ReadonlySet<TextureFormat>` to 04 and the contract | 04 §3 |
| 14 | 04 §3.6 names `createWebGpuDevice` but defines no return shape; §5.11 names four device states | Contract uses `WebGpuDeviceInitResult extends DeviceInitResult` with `device`, and a total state union including `uninitialized`/`disposed` | 04 §3.6, §5.11 |
| 15 | 15 §4.9 printed the wrong decimal for `0x635F8BC4` (off by 8192) | Corrected to `1667206084`, verified against the payload FNV-1a and the 85-byte fixture | 15 §4.9 |
| 16 | WebGPU and WebGL2 factories returned different shapes; core `DeviceInitResult` had no device | Made `DeviceInitResult<T>` generic with `device`; both factories return their narrowed `*DeviceInitResult`. Core, 04, 05 and both contracts aligned | 00 §3.2, 04 §3.6, 05 §3.2 |
| 17 | 05 §3.3's capability list omitted fields required by core `RendererCapabilities`; `maxSamples` is `number` in GL limits and `1 | 4` in core | `WebGL2Capabilities extends RendererCapabilities & WebGL2DesignCaps`; capabilities clamp `maxSamples` to `1 | 4` | 05 §3.3 |
| 18 | 06 used five additive `E_ASSET_*` codes that core did not declare | Added all five to 00 §5.9 and the core contract; `AssetErrorCode` is now a pure `Extract` of core | 00 §5.9, 06 §3.7 |
| 19 | 06 §4.2 step 6 said any manifest failure rejects with `E_ASSET_FORMAT`, contradicting the budget rows | Step 6 now classifies structural/path/format as `E_ASSET_FORMAT`, budget as `E_ASSET_BUDGET`, fetch as `E_ASSET_LOAD` | 06 §4.2 |
| 20 | 06's `AssetLibraryOptions` had no injectable fetch although the contract needs one for tests/offline | Added optional `fetch?: typeof globalThis.fetch`; production defaults to the global | 06 §3.4 |
| 21 | Engine input slots are 0..7 while the frozen SDK/runtime use 1..8 | `InputFrame`/`ControllerView` use 0..7; `InputSnapshot` is SDK-shaped 1..8; the runtime adapter owns the +1 mapping | 10 §3 |
| 22 | 10 used six additive `E_INPUT_*` codes that core did not declare | Added all six to 00 §5.9 and core; `InputErrorCode` is a narrow `Extract`, not a parallel union | 00 §5.9, 10 §3.9 |
| 23 | 18's `AssetHandle`/`AssetLibrary` projection did not match spec 06 (kind, state, value, error, progress, retain) | Made the SDK projection a structural subset of the engine library: eight engine kinds, `disposed`, `value: T`, `failed: AssetFailure | null`, `progress: AssetProgress`, `retain(): AssetHandle<T>` | 18 §3.4, 06 §3.1 |
| 24 | `GameContext` v2 was the last T0 contract; it could accidentally change runtime | Added optional members only, type-only, with a compile-time contract assertion. SDK tests 107/107; controller remains 40,794 / 40,960 gz | 18 §3.4 |
| 25 | `GameManifest` had no `version` for save metadata | Added optional `version` (1–32 UTF-8 bytes) to the type and JSON schema | 18 §3.5 |
| 26 | 09 used four additive `E_AUDIO_*` codes that core did not declare | Added all four to 00 §5.9 and core; `AudioErrorCode` is a narrow `Extract` of core | 00 §5.9, 09 §3.7 |
| 27 | 07 has `PhysicsWorld.step()` while A15 asks for `Physics3D.step(dt)`; no `VehicleController` shape | Contract exports both over shared `Physics3DOperations`; `RigidBodyDesc` aliases `BodyDesc`; `VehicleController` aliases `VehicleHandle` | 07 §3.2 |
| 28 | ER-01-04 said "seven pause reasons" while the contract defines six | Corrected the ER row to six; implementation and tests cover all six | 01 §7 |
| 29 | ER-01-06 demanded a heap assertion that Node cannot make deterministically | Reworded to caller-owned reuse; heap growth is measured in ER-01-07 on the benchmark page | 01 §7 |
| 30 | ER-01-10 said "ascending id within a priority band", but the contract drains globally ascending | Dispatch follows priority bands; `drainCompleted` is globally ascending by id | 01 §7 |
| 31 | OBB SAT symmetry failed at a seeded property case due to float addition order | Added a shared relative SAT slop (touching still intersects); tests pass at all seeds | 02 implementation |
| 32 | 03 did not distinguish a stale child from a stale parent, and its depth rule checked only the child's own depth | Spec now fixes `E_STALE_HANDLE` for a stale child, `E_SCENE_INVALID` for a stale parent, and validates `depth(parent) + subtreeHeight(child)` | 03 §5.5 |
| 33 | Package-wide typecheck exposed defects hidden by Vitest transpile: contract/implementation duplicate exports, an Int32/Uint32 free stack, unchecked matrix indexing, and serialization key order | Fixed all four in the integration pass; core tests 247/247, full gate 1,832/1,832 | W1 integration |
| 34 | The save codec functions and constants were named in prose but absent from `save.d.ts`; `E_SAVE_GAME` needed a game id | Declared the codec functions plus `CreateSaveHeaderInput`/`DecodedSaveFile` in the contract; added optional `expectedGameId` to `decodeSaveFile` | 15 §3.3 |
| 35 | ER-15-01 required unreachable `headerBytes` 40/144; ER-15-05 expected `E_SAVE_MIGRATION` for version 0 | Corrected ER-15-01 to the reachable 48/136 range and ER-15-05 to `E_SAVE_FORMAT` in M0; migration is M1 | 15 §7 |
| 36 | Five test-only type errors from earlier waves were hidden by Vitest's transpile-only run | Fixed imports, the stale error-code list and heterogeneous component narrowing; `tsconfig.test.json` is now clean | W1 tests |
| 37 | Spec 06 ended at §6 with no acceptance, test plan, dependencies or risks and only ER-06-09 in prose | Added §7 (ER-06-01…09), §8 test plan, §9 dependencies and §10 risks | 06 §7–§10 |
| 38 | 06 §5.2 vs §5.8 disagreed on retry, §5.3 restricted `dependsOn` against its own example, and the disposed/evicted error split was unstated | Recorded the three clarifications in §7.1: sticky while referenced, dependencies on any kind, `E_STALE_HANDLE` vs `E_ASSET_EVICTED` | 06 §7.1 |
| 39 | The assets hand-back was partial and its tests had never run; four failed | Two fetch tests now omit `Content-Length` so they exercise the body-read path; the borrowed-handle test no longer calls `release()`; buffered audio carries the manifest's `durationSeconds`. Assets 133/133, src+test typecheck and lint clean | W1 assets |
| 40 | The input router's synthesized output overwrote right-stick axis outputs when no stick action existed | Fixed `applyStick` to write only the sides that have a stick output, matching 10 §5.9; input 141/141, src+test typecheck and lint clean | W1 input |
| 41 | WebGL2 implementation found three defects: disposed 2D draws still executed, `WebGL2DeviceInitResult` used an unimported base type hidden by `skipLibCheck`, and an extension-gated format threw the wrong error | Canvas2D calls now return early after dispose, the contract imports the base type, and a missing extension is `E_UNSUPPORTED_FEATURE`; 178/178 tests | W1 WebGL2 |
| 42 | 05 said the backend does not own culling and that handles go stale on restore, contradicting 04 and the implemented rebuild | 05 now assigns per-draw frustum culling to the backend and keeps handles valid across restore (stale only after destroy/dispose) | 05 §1, §4.6 |
| 43 | WebGPU tests had two fixture mistakes (bind-switch count, geometry outside the WebGPU depth range) and the device had lint-only debt | Corrected the fixtures, fixed lint hygiene without behavior changes; 165/165 tests, src+test typecheck and lint clean | W1 WebGPU |
| 44 | The lit WebGPU path never wrote the normal matrix and its fixed light differed from WebGL2 | Fixed both; both backends now match hash `32312240`; Appendix A.1 aligned to the tested scene | 04/05 implementation |
| 45 | A deadzone property test found one-ulp amplification near full deflection | Scalar and radial deadzone now clamp scaled magnitude to the input magnitude; regression case added; input 142/142 | 10 implementation |

## 3. Open findings

| ID | Severity | Finding | Owner | Action |
|---|---|---|---|---|
| RV-01 | Medium | 18's manifest has no `version?` field, but 15's `SaveApi` takes a game-supplied `gameVersion` | 18 | **Closed 2026-10-22:** `version?: string` added (1–32 UTF-8 bytes); when absent, the save layer requires `gameVersion` explicitly |
| RV-02 | Low | 16 §5.1 assigns `tools/bench/` to spec 19; 19 declares `tools/engine-test/` canonical | 16 | **Closed 2026-10-22:** 16 §5.1 now names `tools/engine-test/`; `tools/bench/` is not created |
| RV-03 | Low | 12 says spec 15 embeds the CSTR payload; 15 says the engine payload is opaque and the game/runtime embeds it | 12 | **Closed 2026-10-22:** 12 now says the game/runtime stores the opaque payload; 15 never parses it |
| RV-04 | Medium | 01 adds host tick step 7 `scene.updateWorldTransforms()`; no runtime adapter exists yet | W1 integration | Wire it behind `ctx.scene !== undefined`; legacy 2D games stay a no-op |
| RV-05 | Medium | No spec-level conformance test enforces 02's handedness/depth conventions across 04/05/07/08 | T0 conformance | Add a projection/frustum invariant test that fails on a swapped depth range or winding |
| RV-06 | Low | 05's parity tolerance must use the same scene and golden as 04 | 19 | One fixture id, one tolerance pair; 05 ER-05-04 references it |
| RV-07 | Medium | Root workspace, tsconfig references, Vitest projects, eslint boundary rules and CI are unchanged for `packages/engine/*` | Integration | **Partially closed 2026-10-22:** workspaces, tsconfig and Vitest are wired; the ESLint boundary is deferred to RV-12; CI remains |
| RV-08 | Low | `bgra8unorm` is WebGPU's preferred swapchain format but is not a Tier B format | 04/05 | Renderer picks the canvas-preferred format; conformance probe covers it |
| RV-09 | Low | `TRACEABILITY.md` has no `ER-*` rows yet | 19 + integration | Add rows atomically with the first tagged engine test; do not tag early |
| RV-10 | Low | 15's runtime storage adapters use OPFS/IDB, outside 00's D11 allowlist for `engine-core` | 15/00 | Keep the codec pure in core; storage adapters in `packages/runtime/src/engine/save*` (already specified) |
| RV-11 | Medium | `BufferDesc`/`PipelineDesc` are required by 00/04 but no spec defines their fields; the contract declares them opaque | 04 | Narrow them before the renderer implementation; additive fields do not bump ABI 1 until freeze |
| RV-12 | Medium | The engine-layer ESLint boundary is not active; the config-protection hook blocks `eslint.config.js` edits | Integration | **Closed 2026-10-23:** `packages/engine/core/test/boundaries.test.ts` enforces 00 §5.2 D1–D3 from source text and covers ER-00-02; ESLint rules remain optional while the config is protected |
| RV-13 | Low | The core package needs `scripts/copy-contracts.mjs` because `tsc` does not emit input `.d.ts` files | Integration/W1 | Add a clean-install consumer test; remove the script if native emit is possible |
| RV-14 | Medium | 04 §4.8 does not freeze pipeline-cache key escaping or `defines` canonicalization | 04 | Freeze the equality rules before the pipeline cache is implemented; fixtures assert equality/inequality, never literal key strings |
| RV-15 | Low | `bptc-rgba` has no `EngineFeature` token on either backend; it is gated by the adapter's BC feature and reported through `supportedFormats` | 04/05 | Add a feature token or document the exception explicitly |
| RV-16 | Low | 04 §3.6 omits the return shape of `createWebGpuDevice` | 04 | Record `WebGpuDeviceInitResult` in the spec so the contract is not the only source |
| RV-17 | Low | The save constants live only in `save.d.ts`; `index.ts` uses `export type *`, so they are not runtime values yet | W1 | Add a `save/constants.ts` runtime module and explicit value exports when the codec lands |
| RV-18 | Low | 10 §5.8.3 and §4.1 disagree on the default `component` for gamepad axis bindings | 10 | Make `component` explicit for axis/vector bindings or state the default once |
| RV-19 | Low | 10 §5.8.4 defines `pressed` as `value >= threshold`, while per-binding engagement uses hysteresis | 10 | Define `pressed` and `engaged` semantics explicitly |
| RV-20 | Low | `Escape` is bound to `pause` in the default map yet reserved/never bindable when rebinding | 10 | Resolve the default map or the reserved-key list |
| RV-21 | Medium | No tracked compile-time test proves every SDK projection is assignable from its engine type; the asset projection was already wrong once | W1 integration | Add `packages/runtime/test/engineSdkAssignable.test.ts` (runtime may import both; SDK and engine may not import each other) |
| RV-22 | Low | `GameManifest.version` is typed and schema-validated but `validateManifest` does not check it yet | 18/W1 | Add validation with the first SDK size pass; the controller has 166 bytes of headroom |
| RV-23 | Medium | 09 §5.4 permits stealing an equal-priority voice, while ER-09-04 expects 64 calls into 8 voices to drop 56; both are recorded as fixtures | 09 | Resolve the stealing rule and the expected drop count before implementing the voice pool |
| RV-24 | Low | 09 does not fix voice-count rounding; the M0 bus floors (2.7 → 2) | 09 | State the rounding rule once |
| RV-25 | Low | `AudioVoice` and `AudioDeviceState` have no canonical 09 shapes; the contract derives them from §5.4 | 09 | Add the shapes or mark them implementation-defined |
| RV-26 | Medium | 07 requires derived mass/inertia but gives no numeric formula; fixtures deliberately leave them `null` | 07 | Define the formulas before the Rapier adapter lands; never invent values |
| RV-27 | Low | 07 §3.2 omits `tick` from the fixed-step signature though §5.3 increments it | 07 | Add `tick` to the spec |
| RV-28 | Low | `ContactEvent`/`TriggerEvent` fields and `VehicleController` are unspecified in 07 | 07 | Add minimum shapes; the contract uses pair identity plus enter/exit phase |
| RV-29 | Low | `src/platform` has no unit tests; `frameScheduler` and `deviceProfile` are typechecked and linted only | W1 | Add `test/platform` coverage for scheduler cadence and profile feature detection |
| RV-30 | Medium | ER-01-12 (Coin Run/Reaction Duel migration evidence) is still owed; the conformance fixture is only a proxy | W1 integration | Add the `GameHost` adapter test when the runtime consumes the engine loop |
| RV-31 | Low | 02 does not define signed-zero behavior for `vecNMin/Max`; tests compare numerically, not bitwise | 02 | Specify the tie rule or state that the sign of zero is unspecified |
| RV-32 | Medium | The math modules re-declare contract interfaces (`Vec3`, `Mat4`, `Quat`, …) instead of importing them, so two type sources can drift | W2 cleanup | Refactor the math modules to import the frozen contract types; the package entry currently disambiguates explicitly |
| RV-33 | Low | 03 §3.4 says removing an absent component increments a dev counter; the implementation is a silent no-op with no dedicated counter | 03/W2 | Add the counter or amend the spec |
| RV-34 | Medium | Scene snapshot (32 MiB) and prefab (4 MiB) byte-size limits are specified but not enforced; entity/component/depth limits are | W2 | Enforce the byte limits in serialization before large scenes ship |
| RV-35 | Low | `decodeSaveHeader` validates the payload cap before string lengths; only the reported code on multi-defect files can differ | 15 | Align the validation order with §4.2 or state that all such files are `E_SAVE_FORMAT` |
| RV-36 | Low | `ShaderModuleDesc.language` is only `"wgsl"`; the WebGL2 backend stores descriptors but cannot compile GLSL custom shaders | 04/05 | Make custom shader pipelines fail explicitly with `E_UNSUPPORTED_FEATURE` until M2 defines a GLSL path |
| RV-37 | Low | Several WebGL2 diagnostic counters are not in `RenderStats`; tests cast to a mutable view | 04 | Decide which counters are public stats vs internal debug fields |
| RV-38 | Medium | `packages/engine/renderer-webgpu/src/device/WebGpuDevice.ts` is ~127 KB in one file, against 04's multi-module map | W2 | Split by concern after M0 without changing behavior; keep the public entry stable |
| RV-39 | High | Both renderers are verified only on hand-written fakes; no real WGSL compilation, pixels, driver loss or timing | M0 evidence | **Partially closed 2026-10-23:** real Chrome measured the 5,000-cube 1920×1080 scene on both backends (p95 10.3/10.2 ms, 4-pixel diff), ten-call resize on both, WebGL2 loss/restore (hash `32312240` pre/post, 29.2 ms/3 frames), and real WebGPU device destroy/restore (hash matched, 63.6 ms/1 frame, second loss terminal). GPU timestamps and TV/Android evidence remain PENDING |
| RV-40 | Medium | Input's browser halves (focus/pointer-lock listeners) and the real server/WebSocket parity harness are not run | W1/M0 | Add the browser page and input-bot integration; rows ER-10-03/09/10 stay PENDING |
| RV-41 | Medium | Assets' real `createImageBitmap`, Worker decode and 5 MB long-task budget are not exercised | M0 evidence | **Partially closed 2026-10-23:** a real 5 MiB same-origin WOFF2 loaded with exact transfer/decoded bytes in Chrome. `createImageBitmap`, Worker decode and the ≤ 8 ms long-task proof remain PENDING |
| RV-45 | Low | WebGPU data-backed textures require `copy-dst`, while WebGL2 M0 rejects anything but `sample`; the demo passes backend-specific usage lists | 04/05 | **Closed 2026-10-23:** WebGL2 accepts `copy-dst` as an upload no-op (`sample` still required, `copy-dst` alone is `E_CONTRACT`); 181 backend tests, including a bridge-shaped base-colour draw. Real-GPU textured pixels remain part of the hardware pass |
| RV-46 | Medium | The 1080p acceptance run used headless rAF at ~108 Hz, so there is no 60 Hz-vsync or GPU-timestamp evidence | M0 evidence | Run a headed/60 Hz session or add GPU timestamps before citing 60 Hz pacing; current numbers are frame intervals only |
| RV-47 | Low | The asset bridge refuses compressed sRGB texture tokens because the canonical core `TextureFormat` union has no compressed-sRGB member | 04/06 M1 | Add canonical compressed-sRGB tokens with backend support, or transcode away from sRGB compression; M0 uses uncompressed formats only |
| RV-48 | Low | The asset bridge merges all mesh primitives into one ABI 1 buffer, so per-primitive material slots are lost, and it uploads level 0 without generating mip chains | 06 M1 | Carry primitive ranges in `MeshDesc` or emit one mesh per material; add mip generation before textured 3D content ships |
| RV-49 | Medium | `stage.ts` always creates a Canvas2D device and the adapter refuses 3D calls; there is no manifest renderer flag, so the host cannot yet open a 3D game on WebGPU/WebGL2 | 00/18 M1 | **Closed 2026-10-23:** additive manifest `renderer?: "canvas2d" \| "engine"`; stage loads the manifest before selection, uses `selectRenderer(require3D)` for engine games and refuses Canvas2D; `EngineGameRenderer` renders cubes on the selected device. Real browser: `engine-cube` on WebGPU, 2007×1129 canvas, WebGPU context confirmed. The runtime backend union was widened to report `webgpu` truthfully |
| RV-50 | Low | ER-09-04 expected `droppedPlays = 56` for 64 equal-priority plays into 8 voices, while §5.4 permits stealing equal priority — the two acceptance paths disagreed | 09 | **Closed 2026-10-23:** acceptance amended to `steals = 56`, `droppedPlays = 0`, with §5.4 named as the authority; the implementation and property tests follow it |
| RV-51 | Medium | The frozen `AudioSystem` has no way to register a streaming source; the concrete `EngineAudioSystem` adds `registerStream`/`releaseStream`/`streamCount` outside the interface | 09/06 | Add the stream registration to spec 09 §3 additively before asset-pipeline integration, or keep it concrete-only and document the caller contract; do not put it on the SDK surface yet |
| RV-52 | Low | `AudioBus.decodeAudio` rejects while locked, which is an exception to ER-09-09's "every public call is a silent no-op" | 09 | Accepted as frozen M0 parity: the legacy bus rejects, the new `AudioSystem` path is the one that must no-op. State this in the ER-09-09 evidence note |
| RV-53 | Medium | ER-07-10's 80 KB gzip physics budget was written for a no-Rapier package; A15's measured bundle is 1,644,109 B gz (`rapier.mjs`) and 1,175,669 B gz (raw WASM) | 07/A15 | **Closed 2026-10-23:** ER-07-10 amended to 80 KB for the package JS excluding Rapier, ≤2 MiB for the lazy Rapier payload, host total still ≤5 MB. The package-size gate runs once the runtime imports physics |
| RV-54 | Medium | Rapier publishes colliders to its query structures during `step()`, so a query issued immediately after creation returns a miss; the contract suite steps once before querying | 07 | Document "queries are valid after the first step" or force an eager broadphase update on create; do not leave callers to discover it |
| RV-55 | Medium | Sleep thresholds are a per-body overlay because Rapier's are fixed; all bodies are created `setCanSleep(false)` and island wake propagation is delegated but untested | 07 | **Closed 2026-10-23:** the adapter sleeps a whole contact/joint island, zeroes gravity scale at the transition and restores it on wake, and all public wake paths BFS the island. ER-07-07 passes: 64 boxes sleep at tick 31, drift 0, 32/32 island split |
| RV-56 | High | `positionIterations` and `warmStarting` are accepted but unused, so changing them may not change the state hash — the ER-07-02 sensitivity requirement is not demonstrated | 07 | **Partially closed 2026-10-23:** `velocityIterations` maps to `numSolverIterations` and changes the hash (3733532183 → 3756658819); `substeps` is the outer loop. `positionIterations`/`warmStarting` have no Rapier 0.21 JS mapping; the spec now names `velocityIterations` as the sensitivity knob. Keep the fields replay-recorded, do not fake sensitivity |
| RV-57 | Medium | Material friction combine is Average; spec 07 §5.7 requires the geometric mean `sqrt(muA * muB)` | 07 | **Closed 2026-10-23:** friction is stored as `sqrt(mu)` with Rapier Multiply, which yields exactly the geometric mean; `materials.test.ts` distinguishes it from Average on a 25° ramp |
| RV-58 | Low | Joint `error`/`motorImpulse` and wheel `slipRatio`/`slipAngle` telemetry always return 0 | 07 | Populate from Rapier where available or remove the fields from the M1 claim; add a test that fails on a known non-zero case |
| RV-59 | Low | Slider joints reject non-parallel axes; trimesh-vs-trimesh is not explicitly rejected; a dynamic body holding a trimesh throws `E_ASSET_FORMAT` | 07 | Add the explicit validation matrix and codes; keep the trimesh rule documented |
| RV-60 | Low | `pairCount`/`contactCount` are approximated from tracked event pairs | 07 | Decide whether stats are exact or documented estimates; if estimates, name the method in the contract |
| RV-61 | Medium | 00 §3.5/§4.4 and 12 §3 say `CellKey`/`WorldCell`/`CellState` are re-exported from `engine-core`, but core defines none of them; streaming declared local shapes | 00/12 | **Closed 2026-10-23:** core now declares the frozen world types in `contracts/world.d.ts`; streaming imports and re-exports them. A contract test fails if a duplicate declaration returns |
| RV-62 | Medium | Core's frozen `EngineErrorCode` omits every `E_WORLD_*`, `E_CELL_*`, `E_STREAM_*` and `E_STATE_*` code that spec 12 names | 00/12 | **Closed 2026-10-23:** 32 streaming codes added additively (union now 71); `StreamingErrorCode` is `Extract<EngineErrorCode, …>` and a runtime test asserts every used code resolves. No behavior changed |
| RV-63 | Medium | 12 §4.1 says a missing grid entry is legal only with a water/void flags bit, but a missing cell has no `.cell` payload and `CellIndexEntry` has no water field; ER-12-01 still demands holes without the flag be rejected | 12 | Amend §4.1/ER-12-01: reject all holes with `E_WORLD_HOLE` until the manifest carries an explicit water/void flag. Do not invent a positive case |
| RV-64 | Low | ER-12-02's fixture arithmetic is inconsistent: 2 km at 40 m/s is 50 s, not the stated 120 s | 12 | Amend to 2 km / 50 s (3,000 ticks) or 4.8 km / 120 s; keep the fixture name and hash stable |
| RV-65 | Low | `AudioEmitterRecord` (09) and `CellEntityRecord` (03) are named but never defined; streaming typed them `unknown` | 09/03 | Define the records in their owning specs before M1 content consumes them |
| RV-72 | High | `tryActivate` charged decoded payloads without checking `ledger.wouldExceed()` or `maxResidentCells`, so ER-12-03's "never exceeds the budget" was false under load | 12 | **Closed 2026-10-23:** activation now checks the decoded byte delta and the resident-cell cap before marking resident; a cell that does not fit stays ready. `streamer-budget.test.ts` asserts both budgets on every tick |
| RV-73 | Low | A LOD swap re-activates a cell because `onCellLodChange` carries no content, so the sink receives deactivate+activate instead of a LOD change | 12 | Extend the sink contract with the new content or define LOD swaps as a re-activation; do it before content streaming |
| RV-74 | Low | CSTR entity-record `flags u16` has no counterpart in `EntityStateRecord`; serialize writes 0 and restore ignores it | 03/12 | Add the flags to the entity record or remove the field from the CSTR record |
| RV-75 | Medium | Rapier 0.21 applies CCD world-wide through `maxCcdSubsteps`; the per-body `ccd` flag has no observable effect, so ER-07-06's `ccd: false` pass-through control cannot be produced | 07/A15 | Keep the no-tunnelling half as the row; record the backend limitation and either amend the row or provide the negative control through a different backend knob. Do not fake it |
| RV-76 | High | The WebGPU swapchain uses `bgra8unorm` (non-sRGB) and `fs_main` writes unencoded linear light; authored sRGB colors render dark and an adapter-side sRGB→linear conversion makes them darker still. The browser smoke test showed `#6ee7ff`/`#ffd166` cubes as teal/brown | 04 | **Closed 2026-10-23:** the platform rejects sRGB canvas formats and WebGL2 lacks write control, so both backends now apply one linear→sRGB encode at fragment output (no double decode). Probe: authored `#ffd166` unlit reads exactly (255,209,102) on both; cube/scene5000 goldens re-recorded; cross-backend diff 0–4 px, tolerance unchanged |
| RV-77 | Low | Spec 02's file table says the old runtime `Vec2.ts`/`Aabb.ts` become deprecated re-exports, while 07 §5.15 says they move to `engine/physics/src/two-d/` and the runtime keeps only `index.ts` | 02/07 | **Resolved 2026-10-23 in favour of 07/M1:** the files moved byte-identically, the runtime keeps a compatibility `index.ts`, and no game imports the removed modules. Update spec 02's table in the next docs pass |
| RV-78 | Low | The frozen 2D solver's squared-distance math underflows at denormal scales (e.g. `1.57e-162` separation, `5e-324` mass); the property tests bound generation to game-scale values | 07 | Pre-existing behavior preserved by ER-07-09 parity. Document the supported range; do not "fix" it without a determinism fixture and a game that needs it |
| RV-79 | High | The save brief named localStorage as the production adapter, but spec 15 §4.11 explicitly rejects it (sync, ~5 MB, no atomic replace) | 15 | **Closed 2026-10-23:** production now selects OPFS (secure + `getDirectory` + `move`) then IndexedDB; localStorage is test-only and a regression test proves the selector never picks it |
| RV-80 | Medium | Save §5.10 Web Locks serialization is not implemented; concurrent tabs rely on last-completed-write-wins and atomic replace | 15 | Add `navigator.locks` around write/remove when available, or amend §5.10 with the no-lock behavior; do it before multi-tab saves are supported |
| RV-81 | Low | Save §5.7 `navigator.storage.estimate()` preflight is not implemented; quota is mapped only when a write refuses | 15 | Add the preflight for large payloads or record why the write-time mapping is sufficient |
| RV-82 | Low | `payloadSha256` is always null and not recomputed on read; FNV-1a 32 is verified. Spec allows null only without `crypto.subtle` | 15 | Add the SHA-256 codec or amend the contract for the M1 adapter |
| RV-83 | Low | If the host disposes while OPFS/IDB is opening, the resolved adapter is dropped without an explicit dispose | 15 | Close the opened store on late resolution; GC covers it today |
| RV-66 | Medium | Spec 08 §5.9's root-motion delta wording implies a delta-matrix translation; the implementation uses the model-space root position difference to avoid double-applying the delta rotation | 08 | Decide the semantics (delta matrix vs position difference) and amend the spec; add a rotation+translation fixture that would distinguish them |
| RV-67 | Low | `AnimationApiOptions.scene?: Scene` is additive and not in §3.5; it exists so `rootMotion: "apply"` can write the hierarchy | 08 | Add it to the contract additively with the same ownership rule as `GameContext.scene` |
| RV-68 | Low | `AnimationSource.loop?: ClipLoopMode` is additive; it lets a compiled clip carry its default loop mode | 08 | Add to the contract in the next additive revision |
| RV-69 | Low | Morph-target sampling/clamping/hashing landed even though spec 08 marks morph as M2; GPU deformation does not exist | 08 | Keep the CPU path, but do not cite ER-08-10 as complete until the GPU half exists |
| RV-70 | Low | Additive layers are implemented and formula-tested, but the instance API rejects them at M1 (`E_UNSUPPORTED_FEATURE`) | 08 | Remove the rejection when M2 opens the layer surface; keep the test as the formula contract |
| RV-71 | Low | `rootAccumClamp` exists but is never incremented because root motion is per-tick, not accumulator-based | 08 | Remove the dead counter or document why it stays zero |
| RV-42 | High | The first real WebGPU run is black: a 2 MiB object uniform binding exceeds the 64 KiB limit, bind-group layouts are mismatched, and the material texture view is unset | 04/W1 | **Closed 2026-10-23:** bind group 3 now binds 256 B at offset 0, frame/light/material layouts are separated, and an opaque unlit path was added. Real page: hash `b7d53f49`, 53,970 non-clear pixels, golden matched |
| RV-43 | High | The WebGL2 real page renders the wrong material colors: the material UBO appears to read the frame block (camera-position-dependent red/blue cube) | 05/W1 | **Closed 2026-10-23:** explicit `uniformBlockBinding` for FrameBlock→0 and MaterialBlock→1, with a regression test; real page now renders the tan lit checker (`32312240`) |
| RV-44 | High | WebGPU and WebGL2 disagree on the same lit scene: WebGPU is nearly black and WebGL2 is tan; the WebGPU golden `b7d53f49` encodes the wrong image | 04/W1 | **Closed 2026-10-23:** the lit path never wrote the normal matrix (ambient-only), and the fixed light differed from WebGL2. Both fixed; both backends now render hash `32312240`. Appendix A.1 now describes the tested camera/material/light |

## 4. Contract-freeze order

1. **Core contracts (00/01/02/03):** `RenderDevice` stub, loop/time, math, scene. These unblock everything else.
2. **Renderer contracts (04/05):** ABI 1 pipeline, draw contract, capability flags; the shared conformance suite lands with them.
3. **Foundations (06/10/15):** asset handles, action maps, save header codec.
4. **Systems and content (07–14, 16–19)** in their tiers; no layer starts before its contract and fixture exist.

A contract file is a `.d.ts` module in the owning package (`packages/engine/<pkg>/src/contracts/<name>.d.ts`), re-exported by the package entry. Runtime constants live in a `.ts` module beside it and must match. Conformance suites live under `tools/engine-test/conformance/**`.

## 5. Honesty

- No frame time, memory, TV, gyro or haptic number is claimed anywhere in this review.
- The GPU rig hashes (`cd0a1f0b` WebGPU, `781faf16` WebGL2) are a **smoke test** on one adapter, not performance evidence, and are machine-dependent.
- Every hardware-dependent `ER-*` row remains PENDING until run on the named device and recorded in `docs/RESULTS.md`.
- A green typecheck does not make a milestone complete; acceptance evidence does.
