# Budgets (D1, 2026-10-21)

> Single source for memory, texture and frame numbers. The evidence is
> `docs/RESULTS.md` §D1. Every value is dated and confidence-tagged:
> **measured**, **provisional** or **spec-fixed**.
>
> **Status:** E1 and E3 ran on **desktop Chrome 155 only**; E2 ran in **safe
> mode only**; no TV was measured; E14 is pending. Therefore **no memory
> budget is derived from a measured ceiling**, and the 70% rule (PR-11.2) is
> not applied yet. `GATE-PERF-01` must not freeze these numbers until the TV
> runs exist.

## E2 status — why the 70% rule is not applied

| Item | Value | Meaning |
|---|---:|---|
| E2 run | safe mode only | `#safe-mode` checked; 512 MB stop per phase |
| JS heap at stop | 512 MB | enforced safe-mode **cap**, not a ceiling |
| Texture memory at stop | 512 MB | enforced safe-mode **cap**, not a ceiling |
| Estimated total | 1024 MB | 512 + 512, again the cap |
| Failure mode | `js-heap safe-limit; texture safe-limit` | stop condition; no allocation throw, no slow step; every step ended `ok` or `safe-limit` |
| Full-run ceiling | **PENDING** | the full (unsafe) run was not performed |

PR-11.2 says no memory hard-fail is set until E2 has run on real TVs. TV rows
are still missing, so the memory values below are placeholders and must not be
enforced in CI.

## Memory budgets

| Budget | Value | Source | Confidence | Date | Pending |
|---|---:|---|---|---|---|
| `hostMemoryMB` (JS heap) | **358 MB** | 70% of the 512 MB E2 safe-mode cap (the page-reported `suggestedHostBudgetMb`); a cap, **not** a measured ceiling | provisional, low | 2026-10-21 | full E2 run on a real TV |
| `textureMemoryMB` | **128 MB** | SPEC PR-9.2 provisional value; E2 produced no texture ceiling | provisional, low | 2026-10-21 | full E2 run on a real TV |
| `hardFailMemoryMB` | **unset** | PR-11.2 forbids a hard fail before E2 on real TVs | spec-fixed rule | 2026-10-21 | E2 + Gate |

Why the asymmetric values: 358 MB is exactly the probe's 70%-of-cap figure for
the JS heap and is used only as a low-confidence placeholder. The texture
budget keeps the spec's 128 MB provisional because allocating 512 MB of
textures without a context loss does **not** establish a usable texture limit.
Replace both after a full E2 run; do not carry 358 MB forward as "measured".

## GPU and texture limits

| Budget | Value | Source | Confidence |
|---|---:|---|---|
| Max texture size | **16384** | E1 on `pc-win11-rtx3050` | measured on desktop; TV pending |
| Compressed formats present | S3TC, S3TC_sRGB, BPTC, RGTC | E1 on `pc-win11-rtx3050` | measured on desktop; TV pending |
| Compressed formats absent | ASTC, ETC, ETC1 | E1 on `pc-win11-rtx3050` | measured on desktop; TV pending |
| Texture budget | **128 MB** | table above | provisional |

Do not infer KTX2/Basis support from this list alone; the transcoder may still
be needed (SPEC §22 item 6, E1 note).

## Frame and resolution budgets

| Budget | Value | Source | Confidence |
|---|---|---|---|
| Minimum render resolution | **1280x720** | E3 criterion row PASS on desktop | measured on desktop; TV pending |
| Highest resolution tested | **1920x1080** | all five E3 scenes at 1080p | measured on desktop; TV pending |
| Frame-time p95 target, 60 Hz class | **16.7 ms** (frame interval); spec target 14 ms, hard fail 20 ms | SPEC §11 | spec-fixed |
| Frame-time p95, 30 Hz panel class | **33.3 ms** | D1 plan rule if a TV caps rAF at 30 Hz | spec-fixed, conditional |
| Measured desktop frame p95 | **8.4-8.5 ms** wall clock; GPU p50 0.25-1.60 ms, GPU p95 0.31-5.35 ms | E3, 10 scene/resolution runs | measured on desktop; rAF-capped near 120 Hz; **not a TV frame budget** |
| Render-scale floor | **60%** | spec default, unchanged by E2/E3 | provisional |

The desktop rAF cap is about 120 Hz (E1 measured 114.2 Hz over 120 frames; E3
hit 120.00 fps). That cap, not the GPU, sets the wall-clock p95 on this
machine, so the frame budget for a TV must come from an actual TV run.

## Size budgets (unchanged by D1)

| Budget | Value | Source | Confidence | Current evidence |
|---|---:|---|---|---|
| Controller JS, hard | **61440 B (60 KB gz)** | SPEC §11; `tools/size-budget/budgets.json` | spec-fixed | D0: 5067 B gz |
| Controller JS, dev target | 40960 B (40 KB gz) | same | spec-fixed | D0: 5067 B gz |
| Controller JS, prod target | 51200 B (50 KB gz) | same | spec-fixed | — |
| Host runtime + demo, hard | **5242880 B (5 MB gz)** | SPEC §11; `tools/size-budget/budgets.json` | spec-fixed | D0: 5680 B gz |
| Host runtime + demo, dev target | 3145728 B (3 MB gz) | same | spec-fixed | D0: 5680 B gz |
| Host runtime + demo, prod target | 3670016 B (3.5 MB gz) | same | spec-fixed | — |
| Engine core, aspirational | 409600 B (400 KB gz) | `tools/size-budget/budgets.json` | provisional (aspirational) | — |

D1 did not change any byte budget, so `tools/size-budget/budgets.json` was not
edited.

## Latency and network budgets (not measured by D1)

These are recorded so the single budget file is complete; they are **not** D1
results and must be set or confirmed by their owning experiments.

| Budget | Dev target | Prod target | Hard fail | Source | Confidence |
|---|---:|---:|---:|---|---|
| Input to canvas p50 | 15 ms | 20 ms | — | SPEC §11 | spec-fixed; E5/D3 confirms |
| Input to canvas p95 | 25 ms | 35 ms | 50 ms | SPEC §11 | spec-fixed; E5/D3 confirms |
| WS RTT p95 | 8 ms | 25 ms | 50 ms | SPEC §11 | spec-fixed; E4 confirms |
| Reconnect after Wi-Fi blip | 1 s | 1 s | 3 s | SPEC §11 | spec-fixed; E15 confirms |
| Room setup to playable | 5 s | 5 s | 10 s | SPEC §11 | spec-fixed; G1/D4 confirms |

E1's **1.4 ms** binary-WebSocket round trip is a single localhost sample, not
an E4/RTT-p95 measurement. Do not use it as the WS budget.

## TV target decision

- **WebGL2: yes** on the measured device (desktop Chrome 155). **D3 may proceed
  with the WebGL2 target**; the D1 stop rule is not triggered.
- **Binary WebSocket: yes** on the same device (`/ws` room flow).
- **Canvas2D fallback: not required** by the measured device; the friendly
  failure screen (FR-9.3) remains the unsupported-browser path.
- **Resolution floor: 720p.** 720p and 1080p both passed on desktop; the
  TV-safe maximum is unmeasured.
- **PC + HDMI** remains the plan fallback (SPEC §22 Q2); it was not exercised
  end to end.
- **D1 exit remains open** until a real TV produces E1/E2/E3 rows and E14 is
  recorded.

## Consumption rules

- `docs/BUDGETS.md` is the single source for memory, texture and frame
  numbers. D3 must read thresholds from here (or a generated `budgets.ts`),
  never hard-code a second set.
- Do not encode a device model into runtime code. Budgets describe a device
  class; per-device caps stay in `docs/DEVICES.md`.
- Any measurement that changes a budget updates this file and
  `tools/size-budget/budgets.json` together (`docs/todos/layers/docs-experiments.md`).
- `GATE-PERF-01` freezes these numbers after the TV runs; until then every
  memory value here is provisional.
