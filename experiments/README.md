# Device probes (`experiments/`)

Standalone D1 probe pages, served by the D0 dev server at `/x/<id>`. They
measure the TV and phone browsers; they do not import `packages/runtime` and
are never shipped to production.

## Rules

- No analytics, uploads, cookies or PII (**SR-7**). Results are copied from the
  page and recorded by hand in `docs/RESULTS.md`.
- Only same-origin dev-server requests and WebSocket calls are allowed. The
  index and the shared helpers make no network calls at all.
- No probe runs on page load. Every page has an explicit **Run** button;
  `mountProbePage()` only attaches click listeners.
- Capabilities are feature-detected from injected objects, never from the
  user-agent string (**FR-12.1**).
- No new runtime dependency is added. Vite, TypeScript and esbuild are already
  root devDependencies.

## Layout

```
experiments/
  index.html                    # /x/ - lists E1, E2, E3, E14 and the fixture
  e01/                          # E1 page (D1-EXP-02)
  shared/
    report.ts                   # pure result -> table rows + JSON
    report.js                   # generated browser copy
    probe.ts                    # runChecks, feature detection, page wiring
    probe.js                    # generated browser copy
    probe.css                   # shared page styling
    build.mjs                   # regenerates report.js and probe.js
    test/                       # tagged Vitest tests [E1] [SR-7] [FR-12.1]
    fixtures/webgl2-failure/    # intentional WebGL2 failure page
```

The E1/E2/E3/E14 probe implementations land in D1-EXP-02..05. This work item
(D1-EXP-01) owns the index, the shared page/report pattern, the failure fixture
and `docs/RESULTS-TEMPLATE.md`; the index links all four probe pages now so the
later work items only add their page directories. Until a later item adds its
directory, that URL returns 404 (the dev server deliberately does not mask a
missing experiment with an SPA shell).

## Pages

| URL | Purpose |
|---|---|
| `/x/` | Index of E1, E2, E3, E14 plus the self-test fixture. |
| `/x/e01/` | E1: TV browser capabilities (D1-EXP-02). |
| `/x/e02/` | E2: memory ceiling (D1-EXP-03). |
| `/x/e03/` | E3: render benchmark (D1-EXP-04). |
| `/x/e14/` | E14: mixed content / LAN reachability (D1-EXP-05). |
| `/x/shared/fixtures/webgl2-failure/` | Intentional WebGL2 context error; proves the failure display is readable. |

## Build and run

From the repository root:

```sh
npm ci
npm run build                    # builds the dev server and every workspace
node packages/dev-server/dist/main.js
```

Then open `http://localhost:8080/x/` (or the LAN URL printed by the dev
server). The experiments root is served as a static directory; no Vite dev
server is involved.

### Probe JavaScript

Browsers cannot load TypeScript. The runnable ES2019 modules
`experiments/shared/report.js` and `experiments/shared/probe.js` are checked in
next to their `.ts` sources, so the dev-server entrypoint serves working pages
immediately after `npm run build` (or right after checkout). Regenerate them
after editing either `.ts` file:

```sh
# 1. type-check (no emit)
npx tsc -p experiments/shared/tsconfig.json

# 2. transpile to ES2019 ES modules beside the sources
node experiments/shared/build.mjs
```

`build.mjs` uses the esbuild package that already ships with the root Vite
devDependency. It preserves the `./report.js` import specifier, so the page
loads two small modules rather than a bundle. Keep both the `.ts` source and
the generated `.js` in the tree.

## Tests

```sh
# only the probe tests
npx vitest run --project experiments

# whole repository
npm test
```

Tagged coverage:

- `[E1]` - report formatting and index contents (links to E1/E2/E3/E14).
- `[SR-7]` - no network calls or external origins in probe pages/helpers.
- `[FR-12.1]` - capability detection uses features, not the user agent.

Tests live in `experiments/shared/test/`. The `experiments` Vitest project is
declared in the root `vitest.config.ts`.

## Page pattern

Every probe page is a static HTML document plus one ES module. The minimum
markup is:

```html
<h1>E1 - TV browser capabilities</h1>
<button id="run" type="button">Run</button>
<button id="copy" type="button" disabled>Copy JSON</button>
<p id="status" role="status" aria-live="polite">Not run.</p>
<table id="results"></table>
<pre id="json">Not run.</pre>
<script type="module" src="./probe-page.js"></script>
```

The page module imports `mountProbePage` from `../shared/probe.js`, defines
checks as `{ id, label, run }`, and passes the five elements. A check passes
when it returns (any value except `false`); it fails when it throws or returns
`false`. `runChecks()` catches each failure, so one broken check does not stop
the rest of the table. The JSON block is the exact object to paste into
`docs/RESULTS.md`.

The shared CSS is `shared/probe.css`. Do not use inline `<script>` or `<style>`
blocks: the dev server's CSP is `script-src 'self'; style-src 'self'` and will
block them.

## Failure fixture

`/x/shared/fixtures/webgl2-failure/` uses the same page pattern but passes a
fake canvas whose `getContext("webgl2")` throws. The normal failure path must
show a red **FAIL** row with
`WebGL2 context creation threw: Intentional WebGL2 context failure (fixture): ...`
and the same message in the JSON block. It is deterministic on any machine and
does not touch the GPU.

## Verification checklist

- `npx vitest run --project experiments` passes.
- `GET /x/` and `GET /x/e01/` return 200 via the D0 dev server.
- `GET /x/shared/fixtures/webgl2-failure/`, `GET /x/shared/probe.js` and
  `GET /x/shared/probe.css` return 200 with the expected content types.
- Pressing **Run** on the fixture produces one FAIL row and one PASS row; the
  table is readable at TV distance and **Copy JSON** works without devtools.
