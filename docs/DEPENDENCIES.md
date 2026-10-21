# Dependencies

> Rule (D0-REPO-01, G7): **no dependency enters without a row here.** Every
> entry in any `package.json` must have a row with its version, why it exists,
> its browser byte cost, and the alternative that was rejected.
>
> Version ranges below mirror the `package.json` files. The exact resolved
> versions and integrity hashes live in the single root `package-lock.json`.
> "Browser byte cost" is gzip size shipped to the browser; build-time, test,
> server-only and type-only packages are 0. Once `tools/size-budget` exists
> (D0-TOOL-02), measured bundle sizes are recorded in `docs/RESULTS.md`.

## Runtime and workspace dependencies

| Package | Version | Used by | Why | Browser byte cost (gz) | Alternative rejected |
|---|---|---|---|---|---|
| `@lanpad/protocol` | workspace `*` (0.0.0) | broker, dev-server, runtime, controller, tools/input-bot | Zero-dependency wire contract: constants, binary codecs, JSON message union. One implementation of the protocol (FR-10.1, anti-rework rule 1). | 0 third-party bytes; our own code, counted by the bundle budgets | Copying wire types into each package — rejected: type drift and version skew |
| `@lanpad/broker` | workspace `*` (0.0.0) | dev-server | Shared room/session/fan-out core so the Phase 2 relay is an adapter, not a rewrite (amendment A1). | 0 (server-only) | Room logic inside dev-server — rejected: would be duplicated into relay (A1) |
| `@lanpad/sdk` | workspace `*` (0.0.0) | runtime, controller | Manifest schema and server-origin config contract shared by host, controller and third-party games (FR-4.3, FR-10.3, G8). | 0 third-party bytes; our own code | Duplicated manifest/config types — rejected: boundary drift |
| `ws` | `^8.22.0` | broker, tools/input-bot | Raw WebSocket server (broker) and client (input-bot). WebSocket is the only transport in v1 (FR-4.4). | 0 (Node-only; never bundled for the browser) | `socket.io` — rejected: extra protocol layer and payload; `uWebSockets.js` — rejected: native build complexity |
| `sirv` | `^3.0.2` | dev-server | Static file serving for host, controller, games and experiment routes, including SPA fallback. | 0 (server-only) | `express` + `serve-static` — rejected: framework weight for one job; hand-rolled static server — rejected: traversal/range handling risk |
| `qrcode` | `^1.5.4` | dev-server | Terminal QR at boot (FR-9.12, D0-SRV-01) and the future data-URL QR path in D4. | 0 (server-only) | `qrcode-terminal` — rejected: no PNG/data-URL path needed later; keeping one QR library |
| `three` | **planned — not installed** | runtime (D3) | 3D renderer candidate pending experiment E12 in D3. Listed now so the dependency is budgeted before it is added. | ~170 KB gz (estimate; measured in D3) | Thin custom WebGL2 renderer — evaluated in E12; not excluded |

## Root devDependencies (build, test, lint, types)

| Package | Version | Used by | Why | Browser byte cost (gz) | Alternative rejected |
|---|---|---|---|---|---|
| `typescript` | `^6.0.3` | root (build) | Strict typecheck and project references. Pinned below 6.1 because `typescript-eslint@8.72` supports `>=4.8.4 <6.1.0`. | 0 (build-time) | Babel/SWC alone — rejected: no type checking; TypeScript 7 (native) — rejected: unsupported by the current typescript-eslint |
| `vite` | `^7.3.7` | root (build/dev) | Dev server and production builds for the host and controller pages (plan amendment A6). | 0 (build-time; emitted bundles are budgeted separately) | webpack — rejected: heavier configuration; Rollup alone — rejected: no dev server/HTML handling; Vite 8 — rejected: Vitest 3.2.7 depends on `vite ^5 \|\| ^6 \|\| ^7`, so Vite 8 would install a second Vite copy |
| `vitest` | `^3.2.7` | root (test) | Unit, property and integration test runner with ESM + TypeScript out of the box. Vitest 4.1.12 was rejected because npm 10.9.2 (bundled with the Node 22 local toolchain and Node 20 CI) crashes in arborist `#loadPeerSet` while resolving it; 3.2.7 resolves cleanly and supports Node 20. | 0 (dev-only) | Jest — rejected: ESM/TypeScript transform friction; Vitest 4 — rejected: npm 10.9.2 install crash |
| `fast-check` | `^4.10.2` | root (test) | Property tests for binary codecs and validators (D0-PROTO-02, TR-1). | 0 (dev-only) | Hand-rolled random loops — rejected: no shrinking or reproducible counterexamples |
| `eslint` | `^10.13.0` | root (lint) | Flat-config linting plus the layer import restrictions required by D0-REPO-01 (FR-10.2). | 0 (dev-only) | Biome — rejected: plan amendment A6 chooses ESLint; the layer-rule setup is already specified |
| `typescript-eslint` | `^8.72.0` | root (lint) | TypeScript parser and recommended rules; supports ESLint 10. | 0 (dev-only) | Raw `@typescript-eslint/parser` — rejected: re-implementing shared presets |
| `jsdom` | `^29.1.1` | root (test, controller only) | DOM environment for controller tests, scoped to `packages/controller`. v30 requires Node >= 22.22 and would break the Node 20 CI target. | 0 (dev-only) | `happy-dom` — rejected: weaker pointer/touch event fidelity needed by D2 |
| `@types/node` | `^20.0.0` | root (types) | Node typings for server and tool packages; matches the Node 20 CI runtime. | 0 (type-only) | None — required for `types: ["node"]` |
| `@types/ws` | `^8.18.2` | root (types) | Type definitions for `ws`. | 0 (type-only) | None — required |
| `@types/qrcode` | `^1.5.6` | root (types) | Type definitions for `qrcode`. | 0 (type-only) | None — required |

## Notes

- One lockfile at the repository root; no per-package lockfiles (D0-REPO-01 anti-rework).
- Nothing is installed earlier than the work item that uses it. `three` stays uninstalled until D3.
- Adding a dependency requires adding its row here in the same change.
