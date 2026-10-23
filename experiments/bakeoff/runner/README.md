# Bake-off runner

Static server + headless-Chrome CDP runner for the PocketPad engine bake-off.
It serves the repository root, loads each contender at
`/experiments/bakeoff/<contender>/`, waits for `window.__BAKEOFF__.ready`,
warms up 5 s, samples 60 s of frame intervals, and records all three runs.

## Run all three contenders

```bash
cd experiments/bakeoff/runner
node run.mjs
```

That is the whole command. It runs `playcanvas`, `babylon` and `custom` three
times each, serially, on a fresh Chrome profile per run, and writes:

- `experiments/bakeoff/runner/results.json` — raw measurements, one object per
  contender per run, plus the machine/browser context and protocol.
- `experiments/bakeoff/runner/screenshots/<contender>-run<N>.png` — one
  screenshot per run.

Requirements:

- Node >= 20 with the global `WebSocket` (Node 22 is fine). If the global is
  missing it falls back to the repo's `ws`.
- Google Chrome or Chromium. Auto-detected on Windows/macOS/Linux; override
  with `--chrome <path>` or `CHROME_PATH`.
- The contender's production build in `<contender>/dist/` (fallbacks:
  `build/`, `www/`, then a root `index.html`). Build before running, or the
  page is loaded from whatever exists and cold boot gzip is `PENDING`.

A missing contender page does not stop the run: it is recorded as `not-run` with
the exact missing path. The runner never invents numbers.

## Options

```
node run.mjs --only custom,playcanvas   # subset
node run.mjs --runs 3 --warmup 5 --seconds 60
node run.mjs --chrome "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
node run.mjs --port 8123 --out /tmp/results.json
node run.mjs --headed                   # visible Chrome for debugging
node run.mjs --keep-profiles            # keep throwaway Chrome profiles
node run.mjs --capped                   # sample at the display cadence (see below)
node run.mjs --help
```

Defaults: all three contenders, 3 runs, 5 s warm-up, 60 s sampled,
1920x1080 DPR 1, ephemeral port, `runner/results.json`.

Exit code is 0 when every selected contender is `measured` or `not-run`, and 1
when any contender that has a page errors or partially fails.

## View the results page

`index.html` fetches `results.json`, so it must be served over HTTP:

```bash
cd experiments/bakeoff/runner
node run.mjs --serve-only
```

Open the printed results URL. `--serve-only` also prints the URL for each
contender page and the shared assets, which is useful for manual checks.

## Harness self-test

Proves the server, CDP connection, readiness wait, sampler, heap sampling and
screenshot path without a contender:

```bash
cd experiments/bakeoff/runner
node run.mjs --only selftest --runs 1 --warmup 1 --seconds 5 --out selftest/results.json
```

The self-test page is a Canvas2D probe. It is not a contender and is never
included in the default run.

## What is measured

Per run, in this order:

1. Fresh Chrome profile, `--headless=new`, 1920x1080 at DPR 1.
2. Navigation to `/experiments/bakeoff/<contender>/`.
3. Wait up to 45 s for `window.__BAKEOFF__.ready === true`.
4. Screenshot and GPU probe (WebGL renderer/vendor, WebGPU availability,
   `crossOriginIsolated`, `document.visibilityState`).
5. 5 s warm-up.
6. An independent `requestAnimationFrame` probe samples 60 s of frame
   intervals. This is the primary frame evidence. Chrome runs with
   `--disable-frame-rate-limit` and `--disable-gpu-vsync` so the intervals
   measure render work, not the display cadence. Use `--capped` for a
   display-paced run.
7. `Runtime.getHeapUsage` once per second.
8. Final `__BAKEOFF__` snapshot: backend, draw calls, triangles, instances,
   activations/deactivations, first frame, page errors, and the page's own
   `frameTimesMs` summarized separately.
9. Screenshot saved, Chrome terminated, profile deleted.

Percentiles use nearest-rank over the sampled intervals. Cold boot gzip is
`zlib.gzipSync` level 9, computed per file and summed over the production
build (source maps excluded); it is not a single concatenated stream, and the
method string is recorded in `results.json`.

## Honesty rules

- Missing page => `not-run` with the reason. Build failure, readiness timeout
  or Chrome failure => `error` with the diagnostics. No placeholder values.
- All runs are kept. Nothing is aggregated down to the best run.
- The page-reported backend is recorded as-is and flagged when it is not one of
  `webgpu`, `webgl2`, `unknown`. The WebGL renderer string is recorded so a
  SwiftShader result is visible rather than averaged in.
- Frame intervals are compositor rAF deltas, not GPU timestamp queries. This
  is stated in `results.json` under `protocol.notes`.
- The default uncapped protocol exists because this machine's display runs at
  119 Hz. A display-paced rAF probe sits at an 8.33 ms floor even when the
  engine is faster, and an engine costing 9 ms per frame would quantize to
  16.7 ms and fail the 14 ms budget despite meeting 60 fps. Uncapped sampling
  resolves the actual per-frame cost. A capped run is available with
  `--capped` and records `protocol.framePacing: "display-paced"`.
- No CSP is sent (it would break contenders), but COOP/COEP/CORP are sent on
  every response. Cross-origin runtime loads therefore fail by design.
- The shared assets are real CC0 models: `ped.glb` has a 65-joint skin and an
  in-place `walk` clip, and `car.glb` has an embedded Kenney colormap. A
  contender that cannot decode skins/animations or embedded textures is
  measured as-is; the harness never simplifies the assets to hide a failure.
