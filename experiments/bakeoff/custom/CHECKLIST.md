# Custom contender — capability checklist

Scene: 3×3 grid of 64 m cells, 192×192 m ground, 14 textured buildings in the
centre cell, a 1250 kg Rapier car on a 704 m scripted route, 50 pedestrians in
the south cells, one directional light, sky. Fixed 60 Hz simulation inside a
`requestAnimationFrame` loop; wall-clock frame intervals measured by the runner
after a 5 s warm-up for 60 s.

Measured on desktop Chrome 155, NVIDIA RTX 3050 Ti (ANGLE D3D11), 1920×1080
DPR 1, uncapped. Raw evidence: `results.json` (written by
`experiments/bakeoff/runner/run.mjs`, not hand-edited) and
`screenshots/custom-run{1,2,3}.png`.

## Commands

```bash
cd experiments/bakeoff/custom
npm install
npm run build                      # emits dist/index.html + assets

node serve.mjs                     # serves the repo root on :4173
# http://127.0.0.1:4173/experiments/bakeoff/custom/
# http://127.0.0.1:4173/experiments/bakeoff/custom/?backend=webgl2

# official measurement (runner owns the protocol)
cd ../runner
node run.mjs --only custom --runs 3 --warmup 5 --seconds 60 \
  --out ../custom/results.json
```

## Results (3 runs, all WebGPU)

| run | p50 | p95 | p99 | max | frames | ready | first frame |
|---|---|---|---|---|---|---|---|
| 1 | 0.41 ms | 0.845 ms | 2.635 ms | 55.3 ms | 120,930 | 1459 ms | 1440 ms |
| 2 | 0.445 ms | 0.900 ms | 2.675 ms | 71.84 ms | 112,413 | 1449 ms | 1434 ms |
| 3 | 0.390 ms | 0.790 ms | 2.435 ms | 35.66 ms | 126,040 | 1336 ms | 1316 ms |

`drawCalls` 32–36, `triangles` 607,970–621,714, `instances` 160–162,
`activations` 64 (14 buildings + 50 peds), `deactivations` 0, `pageErrors` [] in
all three runs. Heap used 13.7–17.3 MB at 1 s, 12.4–22.5 MB at 60 s (GC churn,
not monotonic).

Cold-boot gzip: **1,766,889 B (1.685 MiB)**, 4 files —
`dist/index.html` 1,395 gz, `dist/assets/index-Dx8GrSMK.js` 1,764,018 gz,
`dist/assets/decode.worker-C_a7vKHJ.js` 9,249 gz,
`dist/assets-manifest.json` 227 gz. Under the 5 MiB budget.

## Checklist

1. **WebGPU with WebGL2 fallback — PASS.**
   `src/main.js:107-153` tries WebGPU (`createWebGpuDevice` + explicit
   `device.init`) and falls back to a fresh canvas + `createWebGL2Device`.
   Measured runs selected WebGPU; `?backend=webgl2` was probed separately and
   renders the full city (`probe-webgl2.png`, ready, 0 dropped draws, 0 page
   errors). WebGL2 performs per-instance frustum culling (150 instances culled
   at the boot camera) and is not the measured backend.

2. **glTF loading with the shared assets — PASS, with a caveat.**
   `ground.glb`, `building.glb` and `facade.png` load through
   `@lanpad/engine-assets` from a generated manifest
   (`scripts/gen-assets-manifest.mjs`, `src/main.js:208-246`); the textured
   buildings in the screenshots come from that path. `car.glb` (five meshes)
   and `ped.glb` (65-joint skin) are not accepted by the M0 glTF loader and are
   parsed by the contender's own reader `src/glb.js` (407 lines) and uploaded
   through the public `RenderDevice.createMesh` ABI. Stated as a gap, not
   hidden: the engine asset path covers static GLB only.

3. **Skeletal animation with blending or a documented equivalent — PASS
   (documented equivalent, not GPU skinning).**
   The renderer ABI has no joint indices/skin weights and no dynamic mesh
   update, so runtime GPU skinning is not expressible. `src/peds.js` parses the
   65-joint skin from `ped.glb`, samples the in-place walk clip through
   `@lanpad/engine-animation` into 16 pose buckets at boot, CPU-skins one
   vertex buffer per bucket, and each ped selects the bucket for its walk
   phase. This is bucket switching, not weighted blending; it is a visible
   walk cycle in the screenshots and is documented in the file header.

4. **Cascaded/directional shadows — FAILED (engine gap).**
   The M0 WebGPU renderer reports `shadowCascades: 0` and documents "no shadow
   cascades" (`packages/engine/renderer-webgpu/src/device/capabilities.ts:5,182`,
   `WebGpuDevice.ts:7`). The scene therefore draws one directional light plus
   ambient and paints contact discs under the car and peds
   (`src/scene.js:787-832`). No shadow map is claimed.

5. **Vehicle physics driving the car — PASS.**
   Rapier 0.21 through `@lanpad/engine-physics`; 1250 kg dynamic chassis,
   `createRapierWorld` stepped at a fixed 1/60 s. Boot dump:
   `bodyCount: 53`, `colliderCount: 66`. The car follows the 704 m route under
   physics for the full 60 s and is visible in every screenshot.

6. **Character controller or equivalent for the peds — PASS.**
   Each ped owns a Rapier character controller (`src/peds.js:215`,
   `physics.createCharacter`), walks at 1.2 m/s inside the south cells and is
   enabled/disabled with cell activation (`physics.setEnabled`).

7. **Positional audio — PENDING.**
   `src/audio.js` wires `EngineAudioSystem`: procedural 2 s engine hum
   registered with `registerBuffer`, positional looping source, per-tick
   `setSourcePosition`, listener position/orientation, `update(dt)`. In the
   headless runner the AudioContext stays autoplay-locked
   (`state: "locked"`, `unlockAttempted: true`), so no sound was heard. Also
   noted: the M0 audio contract exposes no live playback-rate control, so pitch
   is fixed. Not claimed as verified.

8. **Streaming hooks: per-cell activation/deactivation — PASS (activation),
   deactivation unobserved.**
   `CellGrid` from `@lanpad/engine-streaming` tracks the active cell
   neighbourhood; buildings and peds are activated/deactivated per cell
   (`src/scene.js:562-575`), and deactivated buildings are compacted out of the
   instance buffer so they are not submitted at all (`src/scene.js:344-345,
   765-785`). `activations: 64` at boot in every run. `deactivations: 0` in all
   three 60 s runs: the scripted route never leaves the centre neighbourhood,
   so the deactivation path was not observed firing. The code path exists but
   is not claimed as exercised.

9. **Runs with COOP/COEP headers — PASS.**
   `crossOriginIsolated: true` in all three measured runs (`gpu` block in
   `results.json`); the dev/runner server sets COOP `same-origin`, COEP
   `require-corp` and CORP `same-origin` on every response.

10. **Can sit behind `GameContext` without engine-specific types — FAILED (out
    of scope by task).**
    This contender deliberately does not use the phone host/`GameHost` or
    `GameContext`; it is a renderer/physics comparison page built directly on
    the engine packages. It therefore cannot demonstrate `GameContext`
    compatibility. The scene consumes only public `RenderDevice` and
    `Physics3D` contracts, which is the closest evidence available.

11. **Pooled/allocation-free hot path — PASS (by construction).**
    Per-frame state is preallocated: building transform/instance buffers
    (`scene.js:340-345`), matrices (`scene.js:633-639`), ped disc transforms,
    pooled device rings in both backends. `update` and `render` contain no
    `new`, no `map`/`filter`; the audio view is a reused object refreshed every
    6 frames. Heap samples are non-monotonic with GC, so this is a code-level
    claim, not an allocation-counter measurement.

12. **Licence compatible with a commercial browser game — PENDING.**
    The engine packages are first-party repo code marked `"private": true`
    with no `license` field, and there is no root `LICENSE` file, so the
    licence of the engine itself is unstated. Third-party pieces are traceable:
    Rapier `Apache-2.0`, Vite `MIT`, shared assets listed in
    `experiments/bakeoff/assets/LICENSES.csv` (Kenney CC0). PENDING until the
    repository states a licence.

## Known limitations (not hidden)

- No GPU skinning and no animation blending; ped animation is CPU pose-bucket
  substitution (item 3).
- No shadow maps (item 4); contact discs stand in.
- The engine's glTF path does not load the multi-mesh car or the skinned ped;
  the contender carries its own GLB reader.
- Audio cannot be verified in headless Chrome; fixed pitch (item 7).
- Deactivation was never observed in the measured window (item 8).
- `GameContext` compatibility was not attempted (item 10).
- Working tree is not committed.
