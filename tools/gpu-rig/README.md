# @lanpad/gpu-rig

Headless determinism rig for the PocketPad renderer program. It renders one lit
triangle at a fixed 256x256 with no clock, randomness, input, network or asset
loading, reads the pixels back, and hashes the top-down RGBA8 bytes with 32-bit
FNV-1a. The same page runs on WebGPU and on WebGL2, so either backend can be
checked on its own.

## What it proves, and what it does not

It proves that the browser exposes the requested backend, that a triangle
pipeline compiles and draws without validation errors, that two consecutive
readbacks in one page agree byte for byte, and that the pixels hash to the
recorded value for that backend on that machine.

It does not benchmark frame time, and it does not prove parity between WebGPU
and WebGL2. Each backend has its own hash.

## Files

| File | Purpose |
|---|---|
| `index.html` | 256x256 canvas and `<pre>` status; external script and stylesheet only |
| `probe.js` | deterministic scene, readback, FNV-1a, `window.__GPU_RIG__` |
| `style.css` | page styling (external, so the dev CSP holds) |
| `run.mjs` | Node 20 CLI: Chrome + CDP, static server, poll, golden compare |
| `golden.json` | recorded hashes per backend, written only by `--update-golden` |

## Run

```bash
node tools/gpu-rig/run.mjs --backend auto
node tools/gpu-rig/run.mjs --backend webgl2
node tools/gpu-rig/run.mjs --backend webgpu
```

Options:

| Flag | Meaning |
|---|---|
| `--backend auto\|webgpu\|webgl2` | Backend to exercise; default `auto` (WebGPU first, WebGL2 fallback) |
| `--chrome <path>` | Chrome/Chromium binary; default `CHROME_PATH`, then common OS paths |
| `--timeout <ms>` | Startup plus readback budget; default `30000` |
| `--out <json>` | Also write the result JSON to a file |
| `--update-golden` | Record this run's hash in `golden.json` |

The runner prints one JSON object. It exits `0` only when a hash was produced
and matched `golden.json`, or when the run was recorded with
`--update-golden`. Everything else exits `1` with an `error` string.

## Backend selection

`probe.js` reads `?backend=` from the page URL:

- `webgpu` — WebGPU only; a WebGPU failure is reported as an error.
- `webgl2` — WebGL2 only.
- `auto` — try WebGPU; on any failure fall back to WebGL2 and record
  `fallbackReason`. An unhealthy WebGPU setup therefore does not silently pass
  as WebGPU: the reported backend is the one that actually rendered.

The runner rejects a result whose `backend` does not match an explicit
`--backend`.

## The exposed object

Exactly one object is published per page load, including on error:

```js
window.__GPU_RIG__ = {
  scene: "lit-triangle-v1",
  backend: "webgpu" | "webgl2",
  hash: "1a2b3c4d" | null,
  drawCalls: 1,
  width: 256,
  height: 256,
  error: null | "message",
  requestedBackend: "auto" | "webgpu" | "webgl2",
  stable: true,
  backendInfo: { /* adapter diagnostics */ } | null,
  fallbackReason: null | "message"
};
window.__GPU_RIG_DONE__ = true; // set only after __GPU_RIG__ exists
```

The runner polls for both and never sleeps for a fixed time.

## Golden hashes

`golden.json` looks like this (a real one is only ever written by a run):

```json
{
  "version": 1,
  "scene": "lit-triangle-v1",
  "width": 256,
  "height": 256,
  "backends": {
    "webgpu": {
      "hash": "00000000",
      "adapter": "recorded adapter string",
      "chrome": "Chrome/0.0.0.0",
      "drawCalls": 1,
      "recordedAt": "2026-01-01T00:00:00.000Z"
    }
  }
}
```

Rules:

- **A missing golden is a failure, not a pass.** So is a golden with no entry
  for the backend that just ran, or one for a different scene/size.
- `--update-golden` writes only what a real run produced. A hash is never
  hand-entered.
- Updates merge: recording `webgpu` does not erase the `webgl2` entry. To
  populate both, run `--backend webgpu --update-golden` and
  `--backend webgl2 --update-golden` on the same machine.
- Hashes depend on GPU, driver, OS and Chrome build. A mismatch on different
  hardware means “this machine differs”, not automatically “the renderer
  regressed”. Treat the rig as a baseline for the machine that recorded it.
- If `golden.json` is corrupt JSON the runner refuses to overwrite it; delete
  the file deliberately and re-record.

## Chrome

The rig drives Chrome/Chromium over the DevTools Protocol with the `ws`
package. Headless mode is built into Chrome; no separate download is needed.

Install Chrome if it is absent:

- Windows: install from https://www.google.com/chrome/ (the runner checks
  `%ProgramFiles%\Google\Chrome\Application\chrome.exe`,
  `%ProgramFiles(x86)%\...`, `%LOCALAPPDATA%\Google\Chrome\Application\...`
  and the Chromium equivalents).
- macOS: install Chrome or Chromium in `/Applications`.
- Linux: `sudo apt install google-chrome-stable` or `chromium`.

Override the binary with `--chrome <path>` or `CHROME_PATH`. An explicit path
that does not exist is an error rather than a silent fallback.

Newer Chrome builds may expose WebGPU in headless only with
`--enable-unsafe-webgpu`, which the runner passes. The adapter actually used is
recorded in `backendInfo` and in `golden.json`.

## Environment and dependencies

- Node 20 or newer, ESM.
- `ws` is declared in this package and is already hoisted by the root
  workspace; no separate install step is needed once the repo is installed.
- The rig writes nothing outside a temp Chrome profile, `golden.json` and an
  optional `--out` file.
- Tests are not wired into the root Vitest projects; run the CLI directly.
