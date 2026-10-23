# Bake-off evidence audit - 2026-10-23

Read-only evidence audit. No browser runs, no contender or runner edits, no
ADR write, no commit. The only file written is this audit.

**Audit basis.** The official shared matrix is
`experiments/bakeoff/runner/results.json`, generated
`2026-10-23T06:40:26.604Z`, 9,381,691 B, SHA-256
`3f635a059cb05ad0a4d571022659f9afbc8fab48c5be35a781d5b5bd44f2bf18`.
The per-contender files (`playcanvas/results.json`,
`babylon/results-babylon.json`, `custom/results.json`) are earlier or
supplementary run sets, not the official matrix. `docs/RESULTS.md` (mtime
12:17:14 IST) and `docs/ADR-0003-engine-base.md` (mtime 12:17:52 IST) are other
owners' documents; they were not edited or audited here.

**Bottom line.** The official matrix is internally consistent and usable as
decision evidence, but it is not a controlled like-for-like engine-speed
comparison. No exception in the decision rule fires. Babylon.js has the
strongest measured case: a complete 3/3 official set, worst p95 10.865 ms,
1,730,261 B cold boot, and evidence for the required capabilities except the
explicitly PENDING integration/profiling items. PlayCanvas is not disqualified
by its harness error, but its official set is 2/3 and its car used a 221.65 m
ring instead of the shared 704 m `layout.cameraPath`. The custom p95
(0.735-0.845 ms official) is not a like-for-like result: it has no shadow maps,
uses CPU pose-bucket skinning rather than GPU skinning/blending, has no
`GameContext`, and its end snapshot keeps all 50 peds active while the
alternatives streamed theirs out. It cannot be used to claim exception (a).
The measured evidence supports adopting an off-the-shelf engine; the rule does
not itself choose between PlayCanvas and Babylon.js.

---

## 1. Artifact map and provenance

| Artifact | Generated | Role | Runs |
|---|---|---|---|
| `runner/results.json` | `2026-10-23T06:40:26.604Z` | Official shared matrix | PC 2 measured + 1 error; Babylon 3 measured; custom 3 measured |
| `playcanvas/results.json` | `2026-10-23T05:55:16.933Z` | Earlier PlayCanvas-local set; supplementary | 3 measured |
| `babylon/results-babylon.json` | `2026-10-23T06:13:47.701Z` | Earlier Babylon-local set; supplementary | 3 measured |
| `custom/results.json` | `2026-10-23T06:28:19.175Z` | Custom-local supplementary set | 3 measured |
| `runner/selftest/*` | earlier | Preliminary/selftest runs | Not the official matrix |
| `docs/RESULTS.md` | mtime `2026-10-23 12:17:14 +0530` | Official matrix rows and caveats | Not edited |
| `docs/ADR-0003-engine-base.md` | mtime `2026-10-23 12:17:52 +0530` | Decision record (out of scope) | Not edited |

Naming caveat: the PlayCanvas, Babylon and custom `CHECKLIST.md` files call
their local run sets "official". In this audit, "official" always means the
shared `runner/results.json`; the local sets are protocol-conforming but
supplementary. The builds are the same across both sets (section 4), so the
differences are repeat-run variance, not a build change or a leaked copy.

Environment for all nine official runs: Chrome `155.0.8059.85`, Windows 11,
RTX 3050 Ti Laptop via ANGLE/D3D11, `webgpu: true`, `webgl2: true`,
`crossOriginIsolated: true`, no SwiftShader string. GPU string:
`ANGLE (NVIDIA, NVIDIA GeForce RTX 3050 Ti Laptop GPU (0x000025A0) Direct3D11 vs_5_0 ps_5_0, D3D11)`.

---

## 2. Protocol pass/fail table

| Check | Result | Evidence |
|---|---|---|
| Three runs per contender | **FAIL (PlayCanvas)** | PlayCanvas: 3 requested, 2 measured, 1 error. Babylon: 3/3 measured. Custom: 3/3 measured. |
| 5 s warm-up + 60 s sampled | **PASS** | Eight measured runs have `frames.wallMs` 60,000.645-60,007.885. PlayCanvas run 1 is the recorded exception: `measuredWallMs` 135,147, sampler timeout. |
| 1920x1080, DPR 1 | **PASS** | Protocol object and all eight official screenshots are 1920x1080. |
| Same Chrome build | **PASS** | `Chrome/155.0.8059.85` on all nine runs, including the failed PlayCanvas run. |
| Same machine, hardware GPU, no software renderer | **PASS** | All nine runs report the RTX 3050 Ti ANGLE/D3D11 string; no SwiftShader. |
| Backend recorded; WebGPU preferred | **PASS (measured runs)** | Eight measured runs are `webgpu`; PlayCanvas run 1 has `backend: null`. No official WebGL2 run exists. |
| Independent frame source | **PASS** | Runner-injected uncapped `requestAnimationFrame` probe, separate from page `frameTimesMs`; not GPU timestamp queries. |
| Nearest-rank percentiles | **PASS** | Recomputing from `frames.frameTimesMs` matches stored p50/p95/p99 within 0.005 ms (section 4). Counts, max and mean match. |
| Cold-boot definition | **PASS** | zlib level 9, per file, summed over `dist`; source maps excluded. Recomputed totals match exactly. |
| Errors recorded, not hidden | **PASS** | Eight measured runs: `pageErrors: []`, `runnerErrors: []`. PlayCanvas run 1 error and both runner errors are retained in the matrix. |
| Screenshot per measured run | **PASS with caveat** | Eight official screenshots exist, are 1920x1080 and non-blank. PlayCanvas run 1 has `screenshot: null`; one stale, unreferenced `runner/screenshots/playcanvas-run1.png` exists (section 4). |
| Report all runs, not the best | **PASS** | All nine rows are present, including the error row. Aggregates use measured runs only. |
| COOP/COEP | **PASS** | `crossOriginIsolated: true` in all nine runs. |
| Serial, one Chrome at a time | **PASS** | Run timestamps do not overlap; order is PlayCanvas -> Babylon -> custom, 06:28:57.722Z to 06:40:26.528Z. |
| Build identity recorded | **PASS with caveat** | Dist tree hashes reproduce (section 4), but no build hash is stored in `runner/results.json`. |
| No contender-harness leakage | **PASS** | Zero exact run-tuple overlaps between official measured runs and the local sets; separate page/frame series; aggregate contains only the three `internal: false` contenders (section 4). |
| Identical benchmark scene | **FAIL** | PlayCanvas used a 221.65 m ring, not the shared 704 m `layout.cameraPath`; custom has no shadow maps. Lighting, MSAA, vehicle physics and end-snapshot content also differ (section 5). |
| WebGL2 measured 3-run set | **UNVERIFIED** | Fallback was a forced smoke test for all three; no saved JSON statistics and no 3-run fallback measurement. |
| Screenshot per contender per backend | **UNVERIFIED** | Official screenshots are WebGPU only; fallback smoke screenshots exist in contender folders. |
| KTX2 textures | **UNVERIFIED** | The shared assets use GLB plus PNG; no KTX2 asset was exercised by any contender. |
| Skeletal animation with blending | **UNVERIFIED (strict wording)** | All three use the single `walk` clip; no cross-clip blend/additive layering was exercised. |
| Keyboard driving | **UNVERIFIED** | None of the three implemented keyboard driving; all used scripted paths. The binding README makes keyboard optional, but the decision document's benchmark says keyboard. |
| Allocation per frame | **PARTIAL** | 1 Hz heap samples exist; no allocation counter or allocation profile was run. |
| Lines of glue code | **PASS** | Runner-recorded non-blank source: PlayCanvas 1,522, Babylon 1,544, custom 2,981. Custom's count excludes the engine packages it imports (section 5). |

Overall protocol result: **usable for the adopt/not-adopt rule, not sufficient
for a clean PlayCanvas-vs-Babylon ranking.** The PlayCanvas run-count failure
and the scene differences are the material defects.

---

## 3. Official matrix results

Values below are transcribed from `runner/results.json`; `p50`, `p95`, `p99`
and `max` are `frames.*` fields. `startup` is `firstFrameMs / readyAfterMs`.
PC = PlayCanvas 2.23.3, B = Babylon.js 9.32.0, C = custom engine packages.

| Contender | Run | Status | Backend | p50 ms | p95 ms | p99 ms | max ms | frames | draws | tris | inst | act/deact | startup ms |
|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| PC | 1 | error | - | - | - | - | - | 0 | - | - | - | - | - / 1,295 |
| PC | 2 | measured | webgpu | 3.745 | 13.96 | 16.33 | 35.355 | 10,505 | 65 | 8,658 | 20 | 30 / 29 | 794.1 / 799 |
| PC | 3 | measured | webgpu | 3.995 | 13.09 | 16.47 | 35.32 | 12,281 | 65 | 8,658 | 20 | 30 / 29 | 1,148.7 / 1,155 |
| B | 1 | measured | webgpu | 1.725 | 7.39 | 10.83 | 75.955 | 21,306 | 61 | 2,218 | 15 | 214 / 200 | 1,216.005 / 1,227 |
| B | 2 | measured | webgpu | 1.895 | 10.865 | 14.515 | 56.07 | 17,937 | 61 | 2,218 | 15 | 214 / 200 | 932.88 / 940 |
| B | 3 | measured | webgpu | 1.045 | 7.835 | 10.225 | 18.07 | 25,201 | 61 | 2,218 | 15 | 214 / 200 | 1,197.235 / 1,207 |
| C | 1 | measured | webgpu | 0.37 | 0.735 | 2.195 | 32 | 132,581 | 36 | 607,970 | 160 | 64 / 0 | 823.73 / 834 |
| C | 2 | measured | webgpu | 0.39 | 0.79 | 2.41 | 33.81 | 125,527 | 36 | 607,970 | 160 | 64 / 0 | 842.535 / 853 |
| C | 3 | measured | webgpu | 0.415 | 0.845 | 2.5 | 19.435 | 119,226 | 36 | 621,714 | 162 | 64 / 0 | 1,102.425 / 1,117 |

PlayCanvas run 1 is an error, not a p95 miss:
`status: "error"`, `reason: "the rAF sampler captured no frame intervals"`,
`runnerErrors: ["sampler did not finish within 135 s", "window.__BAKEOFF__
disappeared before the final snapshot"]`, `pageErrors: []`, no screenshot.
The contender-level status is `partial` but `contender.reason` is `null`; the
run-level reason carries the explanation. That is a paper-trail wrinkle, not a
measurement.

Aggregate:

| Contender | Measured runs | p50 min / median / max | p95 min / median / max | Max frame | Cold boot gzip |
|---|---:|---|---|---:|---:|
| PlayCanvas 2.23.3 | 2 | 3.745 / 3.87 / 3.995 | 13.09 / 13.525 / 13.96 | 35.355 | 2,223,430 B (2.120 MiB) |
| Babylon.js 9.32.0 | 3 | 1.045 / 1.725 / 1.895 | 7.39 / 7.835 / 10.865 | 75.955 | 1,730,261 B (1.650 MiB) |
| Custom | 3 | 0.37 / 0.39 / 0.415 | 0.735 / 0.79 / 0.845 | 33.81 | 1,766,889 B (1.685 MiB) |

All three cold boots are below the 5,242,880 B (5 MiB) hard budget. Babylon's
cold boot includes 662,067 B gzip of Havok WASM. PlayCanvas's is its profiler
build and includes 42,104 B gzip of engine audio. Shared scene assets are
excluded from all three totals; Babylon's checklist records 407,495 B gzip for
the five shared files it fetches, for a combined 2,137,756 B (2.04 MiB).

---

## 4. Verification of the raw numbers

### 4.1 Percentiles

The runner uses nearest-rank over the sampled intervals. Recomputing p50/p95/p99
from the stored `frames.frameTimesMs` gives the stored three-decimal value
within 0.005 ms in every case. Examples:

- PlayCanvas run 2: p50 3.74 vs stored 3.745; p95 13.96 exact; p99 16.33 exact.
- Babylon run 2: p95 10.86 vs stored 10.865; p99 14.52 vs 14.515.
- Custom run 1: p95 0.74 vs stored 0.735; p99 2.19 vs 2.195.
- Custom run 3: p95 0.84 vs stored 0.845; p50 0.42 vs stored 0.415.

The small deltas come from the source array being stored at two decimal places
while the percentile fields are stored at three. Counts, maxima and means match
exactly. The stored percentile fields are authoritative; no corrected p95 is
substituted in this audit.

### 4.2 Cold boot

| Contender | Files | Total gzip | Code gzip | Composition |
|---|---:|---:|---:|---|
| PlayCanvas | 3 | 2,223,430 B | 2,181,326 B | JS 2,180,392 + HTML 934; audio WAV 42,104 included in total, excluded from code |
| Babylon | 237 | 1,730,261 B | 1,730,261 B | Havok WASM 662,067 B gzip (38.3%); largest JS chunk 615,949 B gzip |
| Custom | 4 | 1,766,889 B | 1,766,889 B | manifest 227 + worker 9,258 + main bundle 1,756,017 + HTML 1,387 |

Recomputed from the stored per-file records, all three totals match exactly.
The custom `CHECKLIST.md` component table does **not** match: it states 1,395 +
1,764,018 + 9,249 + 227 = 1,774,889 B while claiming 1,766,889 B. The official
matrix's per-file values (1,387 + 1,756,017 + 9,258 + 227) sum to 1,766,889 B
and are correct. `docs/RESULTS.md` already records this discrepancy. This is a
paper-trail error in the contender checklist, not a wrong official total.

### 4.3 Screenshots

All eight official measured-run screenshots are 1920x1080, 8-bit RGB
(`ct=2`), and non-blank (`blackFrac: 0`):

| Screenshot | Bytes | Unique RGB colors |
|---|---:|---:|
| `playcanvas-run2.png` | 316,677 | 1,811 |
| `playcanvas-run3.png` | 323,271 | 1,775 |
| `babylon-run1.png` | 544,773 | 7,700 |
| `babylon-run2.png` | 62,342 | 2,732 |
| `babylon-run3.png` | 516,206 | 7,648 |
| `custom-run1.png` | 293,577 | 1,251 |
| `custom-run2.png` | 293,287 | 1,237 |
| `custom-run3.png` | 293,451 | 1,241 |

PlayCanvas run 1 has no official screenshot. A file
`runner/screenshots/playcanvas-run1.png` exists (mtime 11:48:03 IST, before the
official matrix started at 11:58:35 IST), SHA-256
`c9fd65eb746bddf10b090f8a9cc067a6429b16972947c337e6d4d0ff80771f29`. It is not
referenced by the matrix and is not the contender-local PC run 1 screenshot
(`playcanvas/screenshots/playcanvas-run1.png`, SHA-256
`f9781d12d800d6232d0adbe859569948134dce89edaeb9085bd4d8cb2a5a46da`, mtime
11:22:59 IST). Do not attribute the stale file to the official error row.

Screenshot content is not a performance metric. The visible framing does
differ: PC run 2/3 show a building and road close to the camera; Babylon run 2
shows mostly ground and sky; custom run 1 shows a building, road and all 50 peds
with contact discs rather than shadow maps. This corroborates that the visible
workload/framing differed; it does not by itself prove the cause.

### 4.4 Build identity

The documented tree hash is computed from `experiments/bakeoff` with the
contender-name path prefix:

```bash
cd "E:/PROJECTS 2026/PocketPad/experiments/bakeoff"
find custom/dist -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum
```

Result: `075f09129b51c4c63cb037344b00553e8ed9a03470ab49c09f6843ebbb7b50e1`.

The other two builds reproduce as:

| Build | Tree SHA-256 |
|---|---|
| PlayCanvas | `eea93dea834f94176198ed462e83f069b469e733147600d4babf9b15c4c0de88` |
| Babylon | `76a995c8aa2ce699b3c6fd27a872651583ddfb6aef63c2bfa768338d6434c8ef` |
| Custom | `075f09129b51c4c63cb037344b00553e8ed9a03470ab49c09f6843ebbb7b50e1` |

The custom individual files also verify:

| File | SHA-256 |
|---|---|
| `dist/index.html` | `c1189d5fa867faa7cd5c94573c544d1705740c273fd25117a3bf70ef4035b4ee` |
| `dist/assets/index-Dx8GrSMK.js` | `8a7df5c17c17003f92f953bb1653d5d898e3e6e580646570376f95e6a4587ac2` |
| `dist/assets/decode.worker-C_a7vKHJ.js` | `7bf0d41a9393b69391d50ba22be365f1f92ebc19d64bebc4086472577071b087` |
| `dist/assets-manifest.json` | `634eca4170b710efc05cedccc27f6123c65c93c2859f0ca0ecf7ef5ece3e3008` |

Path-prefix nuance: the tree hash is sensitive to the file names that
`sha256sum` hashes, not only file bytes. Running `cd custom && find dist ...`
produces `ad6f8ad3447c4156c7a17f85b04c2e1d945896b0bbca53d2a94338607f3583fa`,
not `075f0912...`, for the same files. `075f0912...` is correct under the
documented `experiments/bakeoff` + `<contender>/dist` invocation. Any future
verification must use the same path prefix or record the individual file hashes.

The runner agent recorded the same three hashes before and after the official
matrix; this audit reproduced them at 12:10-12:20 IST. The custom index mtime
(11:52:51 IST) precedes both the custom-local set (finished 11:58:19 IST) and
the official custom runs (started 12:37:03 IST in local time / 06:37:03Z), so
both custom sets used the same build. PlayCanvas and Babylon index mtimes also
precede both sets, and their tree hashes are unchanged.

Paper-trail gap: `runner/results.json` has no `buildHash` field. The hash exists
only in the runner agent's messages/transcript and now in this audit. Add it to
the result metadata on the next run so the measured rows stay pinned to a build.

### 4.5 No contender-harness numbers leaked

Checked the eight official measured runs against all nine local measured runs:

- Exact overlap of the tuple `(backend, p50, p95, p99, max, frames, drawCalls,
  triangles, instances, activations, deactivations, firstFrame, readyAfter)`:
  **0** for PlayCanvas, **0** for Babylon, **0** for custom.
- The official values differ from the local values even though the builds are
  identical: PC official p95 13.96 / 13.09 vs local 15.55 / 15.345 / 12.255;
  Babylon official 7.39 / 10.865 / 7.835 vs local 8.54 / 8.255 / 8.68; custom
  official 0.735 / 0.79 / 0.845 vs local 0.845 / 0.9 / 0.79. These are repeat
  measurements, not copies.
- Official run timestamps are serial and distinct: PC 06:28:57.722-06:33:35.925Z,
  Babylon 06:33:40.264-06:37:02.679Z, custom 06:37:03.023-06:40:26.528Z.
- Page `pageFrames` series are separate and capped differently: PC 6,000
  samples, Babylon 18,016 (run 2: 17,906), custom 20,000. Page p95 and runner
  p95 differ accordingly, for example PC run 3 page 9.985 vs runner 13.09, and
  custom run 3 page 0.74 vs runner 0.845. The runner series is the measured one.
- The official aggregate contains only `playcanvas`, `babylon`, `custom`, all
  `internal: false`; no selftest or internal contender is included.
- Cold-boot values are identical between the official and local files because
  the build is identical. That is expected, not leakage.

Conclusion: the official matrix is a fresh serial rerun, not a merged copy of
the contender-local harness outputs. The only provenance trap is the stale
PlayCanvas run 1 screenshot described in 4.3.

---

## 5. Fairness caveats and scene comparability

The binding README requires the same scene in all three contenders. The
execution did not fully satisfy that. The p95 columns therefore measure
different workloads and different feature sets.

| Element | PlayCanvas | Babylon | Custom | Effect on comparison |
|---|---|---|---|---|
| Car route | **221.65 m, 12 m ring** (`buildRingPath`) | 704 m `layout.cameraPath` | 704 m `layout.cameraPath` | PC is the outlier. The shared polyline has a stem and a zero-radius 180-degree reversal; a 20 m/s vehicle cannot follow it. PC's Node check on the shared path: 15.45 m/s max, 15.19 m/s average, **17.562 m lateral error max**, 1.3 laps in 60 s. Browser HUD: 19.1-19.2 m/s. The official PC screenshot shows a building/road close-up, consistent with the ring route. |
| Shadows | 3 cascades, 2048, `shadowDistance` 90, PCF; ped shadows off | 2 cascades, 1024, PCF, plus hemispheric fill; peds no shadow | **No shadow map** (`shadowCascades: 0`); contact discs | Custom fails the required shadow item and the scene contract. PC and Babylon both pay shadow-pass cost, but with different cascade counts and resolutions. |
| MSAA / device options | `antialias: false` (required to avoid ANGLE/D3D11 WebGL2 MSAA resolve error) | `antialias: true` | WebGPU options do not request MSAA; WebGL2 fallback `antialias: true` | Different raster cost and different fallback quality. PC's WebGL2 fallback needed the MSAA workaround; the official runs are WebGPU. |
| Build entry | PlayCanvas profiler build (needed for `app.stats`) | Normal production build | Normal production build | PC's cold boot and possibly runtime overhead include the profiler entry; the normal build would be smaller but has no draw/triangle counters. |
| Lighting / sky | Directional + ambient + skybox | Directional + hemispheric fill + `SkyMaterial` | Directional + ambient + skybox | Not identical lighting or shadow cost. |
| Road geometry | Built by contender | Four ground strips built by contender (shared ground has no road) | Built by contender | Geometry/draw counts include different road construction. |
| Camera / framing | Chase car around ring; building-heavy end frame | Chase car on shared path; run 2 end frame mostly ground/sky | Chase car on shared path; building + all peds end frame | Visible content differs; frame cost is not a controlled comparison. |
| End snapshot | 65 draws, 8,658 tris, 20 instances; peds streamed out | 61 draws, 2,218 tris, 15 instances; peds streamed out | 36 draws, 607,970-621,714 tris, 160-162 instances; all peds active | Counts are end-of-run snapshots, not peaks. PC/B snapshots understate their active-ped workload; custom's keeps more geometry. Definitions also differ (below). |
| Draw/triangle metric | `app.stats.drawCallCount` / `primitiveCount`, includes shadow/depth passes | Sum over active meshes; triangle count once per mesh | `device.stats.drawCalls` / `triangles` | PC counts passes, Babylon counts objects once, custom counts its device submissions. Triangle counts are not comparable. |
| Instances | 20 = fixed scene + car; peds out | 15 = buildings + car; peds out | 160-162 = buildings + 50 peds + other active objects | Different definitions, not a content-equivalence count. |
| Activation counters | 30 activations / 29 deactivations, per cell group | 214 / 200, per object | 64 / 0, per object; deactivation unobserved | Counts cannot be compared across contenders. Custom did not exercise streaming-out in the measured window. |
| Vehicle | Rapier 0.21.0 raycast vehicle, 4 wheels, 1,250 kg | Havok 1.3.14 box body, 1,250 kg, velocity/angular servo; 4 visual wheel nodes, no raycast wheel or suspension | Rapier 0.21.0 vehicle, 4 wheels, 1,250 kg | Babylon meets "Havok physics driving the car" only with a box-body limitation. PC/custom have physical wheels. The benchmark's 4-wheel requirement is only partial for Babylon. |
| Animation | One `walk` clip; per-ped playback speed 0.92-1.10x; no cross-clip blending | One `walk` clip; per-ped `AnimationGroup`; no cross-clip blending | 16 CPU pose buckets sampled at boot; no GPU skinning, no weighted blending | The strict "skeletal animation with blending" item is unexercised for all three. Custom's rendering cost is not equivalent to skinned GPU animation. |
| Audio | Positional `SoundComponent`, asset loaded; headless muted, PENDING | Positional `Sound`, spatial, attached to car; headless muted, PASS for wiring only | `EngineAudioSystem` positional loop; AudioContext locked, fixed pitch, PENDING | No audible positional audio was verified for any contender. |
| WebGL2 fallback | Forced smoke: 97 draws / 269,722 tris / 70 instances; `antialias:false`; screenshot 1904x929; no saved JSON stats | Forced smoke: 711 samples, p50 8.325 / p95 10.215 ms; no saved JSON stats | `?backend=webgl2` probe renders the city; screenshot 1904x985; no saved JSON stats, 0 dropped draws claimed | Fallback capability exists but is not a measured 3-run result. |
| Keyboard driving | Scripted path | Scripted path | Scripted path | Binding README makes keyboard optional; the decision document's benchmark says keyboard. Interactive input is untested for all. |
| KTX2 | Not exercised | Not exercised | Not exercised | No evidence for or against; absence of a test is not a demonstrated blocker. |
| Allocation | App-level pooling; Rapier/PlayCanvas internally allocate; no profiler | No allocation profiler; PENDING | Code-level claim of no `new`/`map`/`filter` in update/render; no profiler | Allocation per frame is not measured for any contender. Heap samples show GC churn, not allocation rate. |
| Glue-code count | 1,522 non-blank in contender folder | 1,544 | 2,981, excluding the engine packages it imports | Custom's count is not a total-cost comparison; it understates the full custom engine surface. |

Specific scene and metric consequences:

1. **The custom p95 is not admissible as "the benchmark scene."** It omits
   shadow maps (a required item and a required scene feature) and uses CPU
   pose-bucket skinning instead of GPU skinning. Its 607,970-621,714 end
   triangles reflect all 50 peds still active, while PC/B ended with peds
   streamed out. It is a different workload, not the same scene at a faster
   speed. The correct reading is: the custom engine can render its variant
   quickly; the bake-off did not measure it on the required scene.
2. **The PC p95 is measured on a different route.** The car follows the 12 m
   ring (221.65 m), not the shared 704 m cameraPath. The PC checklist documents
   this and the 17.562 m lateral error on the shared path. The official PC
   screenshots show a building-heavy frame. This is a plausible confounder for
   PC's 13.09-13.96 ms p95 and for its end snapshot; it is not evidence of a
   controlled win or loss.
3. **The Babylon scene is closest to the contract** on route and shadows, but
   its car is a box body with visual wheels, its lighting differs, and its
   end snapshot has peds streamed out. It is not a perfect reference either.
4. **Snapshot counts are not peaks.** PC's separate full-active diagnostic
   recorded 120-121 draws and 448,358-462,090 triangles with all peds active;
   Babylon's 6 s smoke saw `peakActivePeds: 50` but did not measure peak draws
   or triangles; custom's 36 draws / 607,970-621,714 triangles are its active
   set. Do not compare these columns as if they were peak loads.
5. **The p95 values are uncapped render intervals, not display-paced frame
   times.** The runner disables frame-rate limit and vsync. The custom p95 is
   far below the ~8.33 ms display floor; PC/B p95 are below or near it. The
   numbers measure render work under the probe, not whether a 60 Hz display
   cadence was held. The decision rule's 14 ms budget is a budget, not a
   display-cadence proof; the protocol is consistent for all three, but the
   absolute values need that caveat.

---

## 6. Capability checklist verification

The README's binding checklist (12 items) and the stricter wording in
`references/decision we need.md` are not identical. The table below uses the
README items and records the strict-rule gaps separately.

| # | Item | PlayCanvas | Babylon | Custom |
|---:|---|---|---|---|
| 1 | WebGPU with WebGL2 fallback | **PASS with caveat**: official runs WebGPU; forced WebGL2 works with `antialias:false`; automatic selection not separately simulated; no saved fallback JSON | **PASS with caveat**: official runs WebGPU; forced WebGL2 smoke 711 samples, p50 8.325 / p95 10.215 ms; no saved fallback JSON | **PASS with caveat**: official runs WebGPU; `?backend=webgl2` probe renders the city; no saved stats |
| 2 | glTF loading with shared assets | **PASS**: all four assets load; HUD/screenshots | **PASS**: `assets` flags all true; 14 buildings, 50 peds, car wheel nodes | **PASS with caveat**: ground/building/facade via engine assets; car and ped via contender's own 407-line `glb.js`; engine path covers static GLB only |
| 3 | Skeletal animation with blending or documented equivalent | **PASS (documented equivalent)**: one `walk` clip, per-ped speed; no cross-clip blend | **PASS (documented equivalent)**: one `walk` clip, per-ped group; no cross-clip blend | **PASS (documented equivalent)**: 16 CPU pose buckets; no GPU skinning, no weighted blending |
| 4 | Cascaded/directional shadows enabled | **PASS**: 3 cascades, 2048, PCF; visible building/car shadows; ped shadows off | **PASS**: 2 cascades, 1024, PCF + fill; visible shadows; peds no shadow | **FAILED**: `shadowCascades: 0`; no shadow map; contact discs only |
| 5 | Vehicle physics (Rapier or Havok) driving the car | **PASS**: Rapier 0.21 raycast vehicle, 1,250 kg, 4 wheels; ring route | **PASS with limitation**: Havok box body, 1,250 kg, velocity/angular servo; visual wheels, no raycast wheel/suspension | **PASS**: Rapier 0.21, 1,250 kg, 4 wheels; shared cameraPath |
| 6 | Character controller or equivalent | **PASS (equivalent)**: waypoint loops, 1.2 m/s; no navmesh/gravity | **PASS**: 50 `PhysicsCharacterController` instances | **PASS**: Rapier character controller per ped |
| 7 | Positional audio | **UNVERIFIED audible**: positional sound, asset loaded; PENDING; headless muted/locked | **UNVERIFIED audible**: spatial sound attached; PASS for wiring only; headless muted | **UNVERIFIED audible**: positional loop wired; PENDING; AudioContext locked; fixed pitch |
| 8 | Streaming hooks: per-cell activation/deactivation | **PASS**: 30 activations / 29 deactivations | **PASS**: 214 / 200 | **PARTIAL**: 64 activations / 0 deactivations; code path exists, deactivation not observed |
| 9 | COOP/COEP | **PASS**: `crossOriginIsolated: true` | **PASS**: `crossOriginIsolated: true` | **PASS**: `crossOriginIsolated: true` |
| 10 | Can sit behind `GameContext` without engine-specific types | **PASS (structural)**: `src/sim.js` imports nothing; adapters isolate PlayCanvas/Rapier; no adapter installed; end-to-end unverified | **UNVERIFIED end-to-end**: backend returns engine-neutral API; only `main.js` imports Babylon; no harness; checklist PENDING | **FAILED / not attempted**: page is built directly on engine packages; no `GameContext`; consumes public render/physics contracts only |
| 11 | Pooled/allocation-free hot path or documented substitute | **PASS (documented substitute)**: app pools; Rapier/PlayCanvas allocate internally; no allocation profile | **UNVERIFIED**: no allocation profile; scratch vectors reused only | **UNVERIFIED**: code-level no `new`/`map`/`filter` claim; no allocation counter; heap samples only |
| 12 | Licence compatible with commercial browser game | **PASS**: PlayCanvas MIT, Rapier Apache-2.0, assets CC0 | **PASS**: Babylon Apache-2.0, Havok MIT per shipped LICENSE, assets CC0 | **PENDING**: engine packages `private: true`, no `license`, no root LICENSE; third-party pieces traceable |

Strict decision-document items:

| Strict item | Result |
|---|---|
| glTF with KTX2 textures | **UNVERIFIED** for all three; no KTX2 asset in the shared scene |
| Skeletal animation with blending | **UNVERIFIED** for all three; one clip, no cross-clip blend/additive test |
| Keyboard driving | **UNVERIFIED** for all three; scripted paths |
| Physics car with 4 wheels | PC **PASS**; custom **PASS**; Babylon **PARTIAL** (box body, visual wheels, no raycast wheel/suspension) |
| Cascaded shadows | PC **PASS**; Babylon **PASS**; custom **FAILED** |
| Streaming out | PC **PASS**; Babylon **PASS**; custom **UNVERIFIED** (0 deactivations) |
| `GameContext` | PC **UNVERIFIED end-to-end** (structural only); Babylon **UNVERIFIED end-to-end** (PENDING); custom **FAILED** |
| Allocation per frame | **UNVERIFIED** for all three; no allocation profiler |
| Licence | PC **PASS**; Babylon **PASS**; custom **PENDING** |

Label inconsistencies worth recording:

- Audio: PlayCanvas says PENDING, Babylon says PASS (wiring), custom says
  PENDING, for equivalent evidence: API/asset loaded, runner `--mute-audio`,
  AudioContext locked. None verified audible output.
- `GameContext`: PlayCanvas says PASS on a structural import-graph check;
  Babylon says PENDING for the same class of missing end-to-end harness; custom
  says FAILED because it did not attempt the host. The honest normalized status
  is: PC/B unverified end-to-end, custom not attempted/failed for the rule.
- Allocation: PlayCanvas says PASS under a documented substitute, Babylon says
  PENDING, custom says PASS by construction. No contender has an allocation
  counter. The normalized status is unverified for the "allocation per frame"
  metric, with a code-level substitute claim only.
- Custom shadows and `GameContext` are genuine FAILED items; custom licence is
  genuinely PENDING. These are custom-side gaps, not alternative gaps.

No contender has end-to-end evidence for all twelve items under the strict
decision-document wording. That incompleteness is an evidence gap, not proof of
an unfixable alternative gap.

---

## 7. Exact discrepancies

### Measurement and provenance

1. **PlayCanvas official run 1 is an error, not a measurement.**
   `runner/results.json`: `status: "error"`, `frames.count: 0`, null p50/p95/p99/max,
   `readyAfterMs: 1295`, `measuredWallMs: 135147`, `runnerErrors` =
   "sampler did not finish within 135 s" and "window.__BAKEOFF__ disappeared
   before the final snapshot", `pageErrors: []`, `screenshot: null`. The
   contender status is `partial` with `reason: null`; the run-level reason is
   the explanation. It must not be counted as a p95 miss or success.
2. **Two run sets with ambiguous "official" labels.** The official matrix and
   the contender-local files are separate. Official p95: PC 13.96 / 13.09;
   Babylon 7.39 / 10.865 / 7.835; custom 0.735 / 0.79 / 0.845. Local p95: PC
   15.55 / 15.345 / 12.255; Babylon 8.54 / 8.255 / 8.68; custom 0.845 / 0.9 /
   0.79. Build hashes are identical, so this is run-to-run variance, not a
   build difference. The checklists' use of "official" for their local sets is
   stale/ambiguous; the shared matrix is authoritative.
3. **Stale PlayCanvas run 1 screenshot.** `runner/screenshots/playcanvas-run1.png`
   exists (mtime 11:48:03 IST, SHA-256 `c9fd65...`) but the official PC run 1
   has `screenshot: null`. The contender-local PC run 1 screenshot is a
   different file (`f9781d...`, mtime 11:22:59 IST). The stale file is not
   referenced by the matrix and must not be used as official evidence.
4. **Build hash not persisted.** The custom build hash `075f0912...` is
   verified, but `runner/results.json` has no build-hash field. The hash is
   path-prefix sensitive: `find custom/dist` from `experiments/bakeoff` gives
   `075f0912...`; `find dist` from inside `custom/` gives `ad6f8a...` for the
   same bytes. Record the invocation and hash in the result metadata next time.
5. **Percentile storage rounding.** The stored frame arrays are two-decimal;
   stored percentiles are three-decimal. Recomputations differ by at most
   0.005 ms. This is rounding, not a mismatch. The page series is separate and
   capped (PC 6,000; Babylon 18,016 or 17,906; custom 20,000) and must not be
   merged with the runner series.
6. **No official WebGL2 3-run data.** All fallback evidence is smoke-level.
   PC: 97 draws / 269,722 tris / 70 instances, screenshot 1904x929, no saved
   JSON. Babylon: 711 samples, p50 8.325 / p95 10.215 ms, no saved JSON.
   Custom: `?backend=webgl2` probe renders the city, screenshot 1904x985, no
   saved stats. The fallback capability is present; fallback performance is
   unverified.
7. **Page screenshot/HUD vs snapshot.** Custom run 1 HUD showed 32 draws while
   the end snapshot says 36 (triangles match at 607,970); the local custom run 1
   HUD showed 28 / 511,762 vs snapshot 36 / 607,970. The HUD refreshes on its
   own cadence; the snapshot is the contract field. Do not use the HUD as the
   result.

### Scene and workload

8. **PlayCanvas route deviation.** The browser car follows a 221.65 m ring, not
   the shared 704 m `layout.cameraPath`. The checklist's Node validation on the
   shared path: 15.45 m/s max, 15.19 m/s average, 17.562 m lateral error,
   1.3 laps in 60 s, ending at (16.66, 0.59, 24.98). Browser HUD: 19.1-19.2 m/s.
   The shared path has a stem and a zero-radius 180-degree reversal that a
   20 m/s vehicle cannot follow. This is documented in
   `playcanvas/CHECKLIST.md`, but it means the scene was not identical.
9. **Custom no shadows.** `custom/src/main.js` requests `shadowCascades: 0` on
   both WebGPU and WebGL2; the engine capability reports zero cascades. Contact
   discs are drawn instead. This fails checklist item 4 and the README's
   "directional light with shadows enabled" scene requirement.
10. **Shadow configurations differ between PC and Babylon.** PC: 3 cascades,
    2048, shadowDistance 90, PCF, ped shadows off. Babylon: 2 cascades, 1024,
    PCF, plus hemispheric fill, peds no shadow. Both pass the item, but their
    shadow cost is not the same.
11. **MSAA/devices differ.** PC uses `antialias:false` on both device creation
    paths; the WebGL2 fallback required it to avoid
    `GL_INVALID_OPERATION: glBlitFramebuffer: Invalid operation on multisampled
    framebuffer` on ANGLE/D3D11. Babylon uses `antialias:true`. Custom's WebGPU
    options do not request MSAA; its WebGL2 fallback does. Raster cost differs.
12. **PlayCanvas uses the profiler build.** Draw-call/triangle counters require
    `playcanvas/profiler`; the normal build does not expose them. The cold boot
    (2,223,430 B) is the profiler build, and the normal build was not measured.
13. **Metric definitions differ.** PC uses `app.stats.drawCallCount` /
    `primitiveCount`, which include shadow/depth passes; Babylon sums active
    mesh draws and triangles once; custom uses its device stats. Instances:
    PC 20 (fixed + car, peds out), Babylon 15 (buildings + car), custom 160-162
    (all active). Activations/deactivations: PC groups 30/29, Babylon objects
    214/200, custom objects 64/0. None of these columns is a like-for-like
    engine comparison.
14. **End snapshots are not peaks.** PC's full-active diagnostic: 120-121
    draws, 448,358-462,090 triangles, 70 instances, p95 8.815 ms (10 s, not an
    official row). Babylon's 6 s smoke: `peakActivePeds: 50`, peak draws/tris
    not measured. Custom: 36 draws, 607,970-621,714 triangles, 160-162
    instances, all peds active. PC/B official snapshots (65/8,658/20 and
    61/2,218/15) understate their active-ped content.
15. **Vehicle fidelity differs.** PC and custom use Rapier raycast vehicles with
    four wheels; Babylon uses a Havok box body with four visual wheel nodes and
    no raycast wheel/suspension. The 4-wheel benchmark item is partial for
    Babylon.
16. **Animation is not blended anywhere.** All three use the single `walk`
    clip. PC varies playback speed per ped; Babylon uses per-ped animation
    groups; custom CPU-skins 16 pose buckets at boot and switches buckets. The
    strict "with blending" item is unverified for all three.
17. **Custom streaming-out unobserved.** `deactivations: 0` in all three custom
    runs; its route never leaves the center neighbourhood. The code path exists,
    but the measured window did not exercise it. PC/B show deactivations.
18. **Audio is muted and unverified.** The runner uses `--mute-audio`; headless
    Chrome blocks the AudioContext before a gesture. PC: PENDING; Babylon:
    PASS for wiring only; custom: PENDING, `state: "locked"`, fixed pitch. No
    audible positional-audio evidence for any contender.
19. **Not tested at all:** KTX2 textures, cross-clip animation blending, keyboard
    driving, and a 4-physical-wheel car for Babylon. The binding README makes
    keyboard optional, but the decision document's benchmark says keyboard.
    Absence of these tests is not proof of an unfixable blocker, but it is a
    checklist-completeness gap.
20. **Custom source-line count excludes engine source.** Runner non-blank:
    PC 1,522, Babylon 1,544, custom 2,981. Custom's count includes its own GLB,
    PNG and probe code but not the imported engine packages, so it is not a
    total-cost comparison. It is evidence that the contender-side glue was
    larger, not a complete engine-size measure.

### Documentation and metadata

21. **Custom cold-boot component mismatch.** `custom/CHECKLIST.md` states
    1,395 + 1,764,018 + 9,249 + 227 = 1,774,889 B while claiming 1,766,889 B.
    The official matrix has 1,387 + 1,756,017 + 9,258 + 227 = 1,766,889 B.
    `docs/RESULTS.md` already records the mismatch; the matrix total is correct.
22. **PlayCanvas heap range understated.** The checklist says total heap
    104-112 MB. Stored total samples: local runs 104.4-112.3, 105.7-121.2,
    105.0-108.9 MB; official measured runs 103.1-112.8 and 106.8-124.4 MB
    (the failed run has 49 samples, 103.1-115.2 MB). The 104-112 MB statement
    does not cover the 121.2/124.4 MB peaks. Heap is not a decision-rule
    criterion; this is a reporting error only.
23. **Ped clip duration mismatch.** The README asset table says 1.0 s;
    `ped.glb` has a 65-joint rig and a 1.333333 s `walk` clip. The contenders
    use the delivered asset. This is a shared-asset metadata discrepancy, not a
    contender error.
24. **Inconsistent capability labels.** Audio: PC PENDING vs Babylon PASS
    (wiring) vs custom PENDING. `GameContext`: PC PASS (structural) vs Babylon
    PENDING vs custom FAILED. Allocation: PC PASS (substitute) vs Babylon
    PENDING vs custom PASS (by construction). Normalize before comparing
    contenders; the underlying evidence is much narrower than the labels.
25. **Current docs have caught up.** At audit time, `docs/RESULTS.md` (mtime
    12:17:14 IST) already transcribes the official matrix, the PlayCanvas local
    conflict, the custom cold-boot component mismatch, the custom
    not-like-for-like caveat, and the audio/GameContext/allocation labels. It
    does not cover the PC ring-route deviation, the PC heap-range error, or the
    vehicle wheel-fidelity difference; this audit adds those. `ADR-0003` is a
    separate owner document and was not audited or edited.

---

## 8. Applying the decision rule

Rule:

> Adopt PlayCanvas or Babylon.js unless one of these is true:
> - Your renderer meets the frame budget (p95 14 ms at 1080p, from your own
>   `BUDGETS.md`) on the benchmark scene and both alternatives miss it.
> - Both alternatives have a blocking gap in the checklist below that cannot be
>   fixed with a plugin.
> - The bundle cost of either alternative breaks your 5 MiB gzip boot budget.

### Exception (a): custom meets the budget and both alternatives miss

**Not triggered.**

- Official custom p95: 0.735 / 0.79 / 0.845 ms.
- Official PlayCanvas measured p95: 13.96 / 13.09 ms (both under 14 ms; 0.04 and
  0.91 ms headroom).
- Official Babylon p95: 7.39 / 10.865 / 7.835 ms (all under 14 ms; worst
  headroom 3.135 ms).
- Local PlayCanvas p95: 15.55 / 15.345 / 12.255 (two misses), but Babylon
  still meets in every local run (8.54 / 8.255 / 8.68). "Both alternatives
  miss" is false under either run set. PlayCanvas's official run 1 is an error,
  not a miss.
- Independently, custom's p95 is not measured on the required scene: no shadow
  maps, CPU pose-bucket skinning, no `GameContext`, and an end snapshot with all
  50 peds active. The decision rule requires the custom renderer to meet the
  budget "on the benchmark scene"; this is a variant scene, not the benchmark
  scene. The custom p95 cannot support exception (a).

### Exception (b): both alternatives have a blocking gap that cannot be fixed

**Not triggered.**

- PlayCanvas: no bundled physics (Rapier is an application dependency and
  works), WebGL2 MSAA needs `antialias:false` on this ANGLE/D3D11 environment,
  audible audio is PENDING, `GameContext` is structural only, allocation is a
  documented substitute, and KTX2/blending are untested. None is demonstrated
  as unfixable; the MSAA issue has a working workaround, and the rest are
  integration or test gaps.
- Babylon: `GameContext` end-to-end and allocation-free operation are PENDING,
  audio is wiring-only, the car is a box with visual wheels, and KTX2/blending
  are untested. None is demonstrated as a blocking engine limitation; they are
  integration/profiling/feature-work gaps. Havok and shadows are present.
- The custom's own FAILED shadows and `GameContext`, and PENDING licence, are
  custom-side gaps. They do not satisfy the "both alternatives" condition; they
  argue against retaining the custom engine, not for exception (b).

### Exception (c): either alternative's cold boot breaks 5 MiB

**Not triggered.**

- PlayCanvas: 2,223,430 B = 2.120 MiB.
- Babylon: 1,730,261 B = 1.650 MiB; combined with the 407,495 B shared scene
  fetch, 2,137,756 B = 2.04 MiB.
- Custom: 1,766,889 B = 1.685 MiB (not an alternative, but also under).
- 5 MiB hard budget = 5,242,880 B. All are under.

### Verdict

The rule's default applies: **adopt an off-the-shelf engine.** The measured
evidence supports that decision. It also supports **Babylon.js as the stronger
measured candidate** on the tie-break criteria: the only complete 3/3 official
set, every official p95 under 14 ms with at least 3.135 ms headroom, the lowest
cold boot, shadows present, shared `layout.cameraPath` followed, and a full
capability set except the explicitly PENDING integration/profiling items.
The rule does not rank PlayCanvas against Babylon.js, and this audit does not
claim a controlled raw-speed win: the route, shadows, MSAA, profiler build,
metric definitions and end snapshots differ. PlayCanvas is not disqualified by
its harness error, but its official set is partial, its route is the ring, and
its p95 headroom is 0.04-0.91 ms in the official runs (the local set straddles
the budget). A clean 3/3 PlayCanvas run on the shared cameraPath and shadows
would be needed before ranking it fairly. The custom engine cannot claim
exception (a), and its own checklist gaps make it unsuitable as the base for
the required scene.

What would change the verdict:

- Both PlayCanvas and Babylon missing 14 ms on the shared scene in a clean
  matrix, while custom met it with shadows and `GameContext`.
- Both alternatives having a demonstrated blocking gap that cannot be fixed.
- Either alternative's cold boot exceeding 5 MiB.
- Evidence that the official matrix was copied, merged or built from a
  different revision. No such evidence was found.

---

## 9. Recommended paper-trail fixes (not made here)

1. Persist the dist tree hash and its exact `find` invocation in
   `runner/results.json` (and the results page) so measured rows stay pinned.
2. Re-run PlayCanvas 3/3 on the shared `layout.cameraPath` and shadows, or
   record the ring as a formal scene deviation and do not compare its p95 as
   if it were the shared path. Do not substitute the local PlayCanvas run 1 or
   the stale screenshot.
3. Keep the official matrix as the only source for decision rows; label the
   per-contender files "supplementary/earlier" in every checklist.
4. Fix the custom `CHECKLIST.md` cold-boot component values (1,387 / 1,756,017
   / 9,258 / 227 = 1,766,889 B); keep the "no shadows / CPU pose buckets / no
   `GameContext`" caveat next to any custom p95.
5. Fix the PlayCanvas heap range (up to 121.2 MB local, 124.4 MB official) or
   label it as a sampled range, not a hard bound.
6. Qualify the fallback numbers as smoke-only and save their JSON if they are
   to be cited; do not call them 3-run results.
7. Normalize the capability labels (audio wiring vs audible; structural vs
   end-to-end `GameContext`; code-level vs measured allocation).
8. If the strict decision-document checklist is binding, add KTX2, cross-clip
   blending, keyboard driving and a physical 4-wheel test for Babylon.
9. Do not use the custom p95 as a like-for-like engine-speed claim or as
   exception (a); it is a different scene/workload.
10. Keep `npm run check` out of scope for this audit; no code was changed and
    no browser run was started. No commit was made.

---

## Appendix: pinned evidence

| Artifact | SHA-256 | Size / note |
|---|---|---|
| `runner/results.json` | `3f635a059cb05ad0a4d571022659f9afbc8fab48c5be35a781d5b5bd44f2bf18` | 9,381,691 B; official matrix |
| `custom/results.json` | `4a57ddf7175218ffcf801bbf85ad9d5618becd0a07affecb318045166c00ac77` | 7,186,885 B; supplementary |
| `playcanvas/results.json` | `554ac6582fd8cd6922931ed12057d4fa3c33081f21e9d2f56d45daa085619633` | supplementary |
| `babylon/results-babylon.json` | `0930c0a7552df7c430c24b16ebc6b1683147943653cab7a9313d5625dce68439` | supplementary |
| PlayCanvas dist tree | `eea93dea834f94176198ed462e83f069b469e733147600d4babf9b15c4c0de88` | `find playcanvas/dist` from `experiments/bakeoff` |
| Babylon dist tree | `76a995c8aa2ce699b3c6fd27a872651583ddfb6aef63c2bfa768338d6434c8ef` | `find babylon/dist` from `experiments/bakeoff` |
| Custom dist tree | `075f09129b51c4c63cb037344b00553e8ed9a03470ab49c09f6843ebbb7b50e1` | `find custom/dist` from `experiments/bakeoff` |
| Stale PC run 1 screenshot | `c9fd65eb746bddf10b090f8a9cc067a6429b16972947c337e6d4d0ff80771f29` | Not referenced by official matrix |
| Contender PC run 1 screenshot | `f9781d12d800d6232d0adbe859569948134dce89edaeb9085bd4d8cb2a5a46da` | Supplementary local set |

Official screenshot paths (relative to `runner/`):
`screenshots/playcanvas-run2.png`, `screenshots/playcanvas-run3.png`,
`screenshots/babylon-run1.png`, `screenshots/babylon-run2.png`,
`screenshots/babylon-run3.png`, `screenshots/custom-run1.png`,
`screenshots/custom-run2.png`, `screenshots/custom-run3.png`.
