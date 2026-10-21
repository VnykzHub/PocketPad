# E1 — TV browser capability probe (D1-EXP-02)

Standalone probe served by the D0 dev server at `/x/e01/`. It measures what the
TV browser can do before D3 commits to a renderer. It does not import
`packages/runtime`, makes no requests to any origin other than this dev server,
and uploads nothing (**SR-7**).

## What it records

| Check | Method |
|---|---|
| WebGL2 + context attributes | `canvas.getContext("webgl2")`, `getContextAttributes()` |
| `MAX_TEXTURE_SIZE` | `gl.getParameter(gl.MAX_TEXTURE_SIZE)` |
| Compressed formats | exact list of supported ASTC / ETC / ETC1 / S3TC / BPTC extensions |
| Web Audio | `AudioContext` constructed inside the Run click, state before/after one bounded `resume()` |
| Binary WebSocket | one 26-byte `Input` frame and the 27-byte `InputFwd` echo, round-trip ms |
| WebRTC presence | `typeof RTCPeerConnection` (presence only) |
| rAF rate | 120 intervals, mean interval and Hz |
| Wake Lock | `"wakeLock" in navigator` |
| Device memory | `navigator.deviceMemory` (GB, `null` = unknown) |
| Hardware concurrency | `navigator.hardwareConcurrency` |
| Screen / DPR | screen size, available size, colour depth, `devicePixelRatio`, viewport |
| User agent | recorded value only; no capability decision reads it (**FR-12.1**) |
| TV-only criterion | **G6**: WebGL2 **and** binary WebSocket both present |

KTX2 support is not inferred from ASTC. The exact compressed-extension list is
recorded, and the Basis transcoder may still be needed.

## Binary WebSocket path

The probe uses the **existing `/ws` room flow**; no dev-only echo endpoint was
added:

1. `POST /api/rooms` creates a throwaway room.
2. A host socket sends `hostJoin` with the host token.
3. A controller socket sends `join` with the room code and PIN.
4. The controller sends one 26-byte `Input`; the host must receive the 27-byte
   `InputFwd` echo with the same slot and fields.

Room code, PIN and tokens stay in memory and are never written to the result
JSON. The production Origin allowlist and frame caps are untouched.

## Run

From the repository root:

```sh
npm run build
node packages/dev-server/dist/main.js
```

Open the printed LAN URL at `/x/e01/`, then press **Run all checks**. At 60 Hz
the rAF sample takes about 2 s; a 30 Hz panel takes about 4 s. Copy the JSON
with **Copy JSON** and transcribe its values into `docs/RESULTS.md` by hand.

## Build and test

```sh
npx tsc -p experiments/e01/tsconfig.json
node experiments/e01/build.mjs
npx vitest run --project experiments experiments/e01
```

`probe.js` and `page.js` are generated ES2019 modules checked in beside the
TypeScript sources. Re-run both commands after editing `probe.ts` or `page.ts`,
and keep the generated files in the tree.

The tests are tagged `[E1]`, `[FR-12.1]`, `[G6]` and `[SR-7]`. The echo test
boots the real dev server and real broker, checks that `/x/e01/` and its modules
are served, and completes the room flow with a Node `ws` client. That is a Node
measurement only; TV numbers require pressing Run in the TV browser.
