# Controller QA probe (`/x/controller-qa/`)

Browser-truth check for the controller layout recipes (stream E, **AR-5**).

The page renders every layout in `layouts.json` at a portrait **390 x 844** and a
landscape **844 x 390** phone surface. For each non-panel control it:

- resolves the expected box with the same frozen rules as
  `packages/controller/src/controls/control.ts` (`x`/`y` against surface
  width/height; `size`/`r` against `min(width, height)`; a circle's `r` is a
  radius, a rounded/square `r` is the edge);
- measures the rendered element with `getBoundingClientRect()`;
- requires at least **44 x 44 CSS px** and that the DOM matches the expected
  box within 0.5 px;
- fails a control whose request was below 44 px even though the renderer would
  clamp it (`undersized`), because the fixture itself should be fixed.

The result table and JSON are the evidence to paste into `docs/RESULTS.md`.
Nothing runs on page load, and the page makes no request until **Run** fetches
`layouts.json` (same origin). No analytics, cookies, uploads or PII (**SR-7**).

## Run it

```sh
npm run build
node packages/dev-server/dist/main.js
# open http://localhost:8080/x/controller-qa/
```

Press **Run**. A passing run says:

```
PASS - <n> targets >= 44 px across 8 layouts x 2 phone sizes.
```

`layouts.json` is a copy of `packages/controller/layouts/*.json`. If a fixture
changes, regenerate the copy; `test/qa.test.ts` fails on any drift:

```sh
node --input-type=module -e "import {readdirSync,readFileSync,writeFileSync} from 'node:fs'; const dir='packages/controller/layouts'; const files=readdirSync(dir).filter(f=>f.endsWith('.json')).sort(); writeFileSync('experiments/controller-qa/layouts.json', JSON.stringify(files.map(f=>JSON.parse(readFileSync(dir+'/'+f,'utf8'))), null, 2)+'\n');"
```

## Screenshot steps

1. Start the dev server and open `http://localhost:8080/x/controller-qa/`.
2. Press **Run**; wait for the PASS status and the two phone frames.
3. Screenshot the page with both frames visible (desktop viewport at least
   1360 px wide, or scroll so both fit). Save as
   `screenshots/controller-qa-launcher-remote-desktop.png`.
4. For a per-game screenshot, choose the recipe in **Layout for screenshots**
   and repeat; suggested names:
   `controller-qa-<layout-id>-<portrait|landscape>.png`.
5. Also screenshot one failing case if the probe ever goes red, and paste the
   **Result JSON** into `docs/RESULTS.md`.

Screenshots are evidence for the browser used; they do not replace the
real-device rows below.

## Evidence status

| Check | Status |
|---|---|
| Desktop Chrome (provisional target), both phone sizes | PENDING - run the page and record the JSON |
| Android Chrome 390 x 844 portrait | PENDING - real device |
| Android Chrome 844 x 390 landscape | PENDING - real device |
| iOS Safari 390 x 844 (out of v1 acceptance) | PENDING - real device |
| Gyro permission prompt + visible "Hold still - calibrating" step | PENDING - real device with motion sensors |
| Recenter button clears the 44 px target on hardware | PENDING - real device |
| Haptic patterns (hit / select / countdown) | PENDING - real device vibration |
| Text field stays visible when the on-screen keyboard opens | PENDING - real device |

Do not mark a row PASS from a desktop emulation; record only what was run.

## What this probe does not cover

- The real control renderers (this page uses simplified boxes to measure the
  layout geometry; the controller's own tests cover renderer behaviour).
- Touch routing, multi-touch ownership, gyro calibration math, reconnect state
  or UGC payloads; those are covered by `packages/controller/test/`.
- Frame time or controller bundle size.
