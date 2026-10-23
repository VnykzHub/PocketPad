# Integrating a contender with the shared assets and runner

Read this before you write the page. The runner is the same for all three
contenders; do not edit it or the shared assets.

## URL convention

The runner serves the **repository root** at `http://127.0.0.1:<port>/`.

Your page is always loaded at:

```
/experiments/bakeoff/<contender>/
```

where `<contender>` is `custom`, `playcanvas` or `babylon`.

- Build with Vite using a **relative base** (`base: "./"` in `vite.config.*`).
  A relative base makes every emitted asset URL resolve under the page path.
- Put the production build in `<contender>/dist/`. For a request to
  `/experiments/bakeoff/<contender>/`, the server tries
  `<contender>/dist/index.html`, then `<contender>/build/index.html`, then
  `<contender>/www/index.html`, then `<contender>/index.html`.
- For any missing file under the page path, the server retries the same path
  under `<contender>/dist/`, `<contender>/build/`, then `<contender>/www/`.
  That is how Vite's `assets/*.js` chunks are served.
- Build before you run. The runner records cold boot gzip from `dist/` and
  reports `PENDING` when no production build exists. It does not invent one.

## Shared assets

Fetch them with a **relative** URL from your page:

```js
const layout = await (await fetch("../assets/layout.json")).json();
const ground = await fetch("../assets/ground.glb");
const building = await fetch("../assets/building.glb");
const car = await fetch("../assets/car.glb");
const ped = await fetch("../assets/ped.glb");
```

From `/experiments/bakeoff/<contender>/`, `../assets/...` resolves to
`/experiments/bakeoff/assets/...`. Do not copy or modify the assets.

`layout.json` contract (cell-local coordinates for buildings and pedestrians,
world-space metres for the car and camera path):

- `cellSizeMeters: 64`, `origin: {x:-96,y:0,z:-96}`, `runSeconds: 60`.
- `buildings[14]`: `{cell:"1,1", x, z, height}`; the mesh is 8 x 8 x 1 m with
  its base at y = 0, so set `scale.y = height` (or rebuild the same box).
- `pedestrians[50]`: `{cell, x, z, waypoint}` in south cells; one shared
  skinned `ped.glb` (Quaternius Universal Animation Library mannequin) at
  1.2 m/s. It has one skin, 65 joints, 8,546 vertices over two primitives, and
  one in-place clip named `walk` (the source `Walk_Loop`, authored at 1.333 s;
  not retimed). The model is 1.83 m tall with its origin at the feet. Engines
  that do not parse glTF `skins`/`animations` will render the bind pose; that
  is a measured engine limitation, not an asset failure. Do not patch the
  shared asset to hide it.
- `car`: `{x:0, y:0.5, z:32, yaw:0}`. `car.glb` is the Kenney Car Kit sedan:
  a `car` root with a `body` and four wheel nodes named exactly `wheel-fl`,
  `wheel-fr`, `wheel-rl`, `wheel-rr`. The root origin is the chassis centre,
  local forward is **-Z** (baked into the parts, so set yaw on the root), and
  wheels spin about local **X**. Put the root at `y = 0.5` so the wheels touch
  the ground. The colormap is embedded; do not fetch a texture.
- `cameraPath[15]`: world-space points, a closed 704 m loop through the 3x3
  grid. At 20 m/s a lap is 35.2 s, so the 60 s run covers the grid.

## Licence and provenance

`ped.glb` is derived from
`Game-assets/Universal Animation Library[Standard]/Unreal-Godot/UAL1_Standard.glb`
(Quaternius, CC0 1.0); only `Walk_Loop` is kept and renamed `walk`.
`car.glb` is derived from `Game-assets/kenney_car-kit/Models/GLB format/sedan.glb`
plus `Textures/colormap.png` (Kenney, CC0 1.0). Everything else is generated
in-repo. CC0 status is taken from each pack's own `License.txt`
(`Universal Animation Library[Standard]/License.txt` and
`kenney_car-kit/License.txt`), not from the general Quaternius or Kenney site
terms. See `LICENSES.csv`; attribution is not required.

## Headers

Every response carries:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
```

There is **no CSP** from the runner. Cross-origin requests are blocked by CORP,
so do not load a CDN, a remote font or remote art at runtime. Vendor
everything into your build. Your page must work with `crossOriginIsolated ===
true`; a 12-byte `SharedArrayBuffer` smoke test is a good early check.

## Metrics contract

Set `window.__BAKEOFF__` as soon as the page starts, with `ready: false`.
Set `ready: true` only after the first rendered frame and once the scene loop
is running.

```js
window.__BAKEOFF__ = {
  ready: true,
  backend: "webgpu",       // "webgpu" | "webgl2" | "unknown"
  frameTimesMs: [],        // your own frame intervals after warm-up
  drawCalls: 0,
  triangles: 0,
  instances: 0,
  firstFrameMs: 0,         // performance.now() at the first rendered frame
  activations: 0,          // streaming activations since load
  deactivations: 0,
  errors: []               // strings; keep them serializable
};
```

The runner also injects its **own** `requestAnimationFrame` probe after the
5 s warm-up and samples 60 s independently of your loop. Your `frameTimesMs`
is recorded as a second, page-reported series. Do not clear the object: the
runner reads it after the run.

- `backend`: report the backend that actually rendered. Do not report `webgpu`
  after falling back to WebGL2, and do not silently run a software renderer.
- `errors`: push page-visible failures (asset load, shader compile, physics
  init). Keep each entry a string of at most a few hundred characters.
- The viewport is 1920x1080 at DPR 1. Size the canvas to the window.

## What the runner does per run

1. Fresh Chrome profile, headless Chrome, 1920x1080 DPR 1, COOP/COEP on.
2. Navigates to your page and waits up to 45 s for `__BAKEOFF__.ready`.
3. Records backend, GPU renderer string, `readyAfterMs`, screenshot.
4. Warms up 5 s, then samples frame intervals for 60 s.
5. Samples the JS heap once per second.
6. Records the final `__BAKEOFF__` snapshot, including your `frameTimesMs`.
7. Repeats three times; all runs are reported, never only the best.

A missing page is recorded as `not-run` with the exact reason. A page that
loads but never becomes ready is recorded as `error` with Chrome diagnostics.

## Manual checks

```bash
cd experiments/bakeoff/runner
node run.mjs --serve-only
```

Open the printed URL for your contender. The same server serves the results
page at `/experiments/bakeoff/runner/index.html`.
