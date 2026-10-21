# Test devices (D1)

> Only devices that actually exist and were actually used are listed here. **No
> TV is available yet**; the SPEC §12 TV rows are marked unavailable rather
> than invented. Device IDs are stable and are referenced from
> `docs/RESULTS.md` and `docs/DEVICE-MATRIX.md`. Append new devices; never
> reuse or silently rename an ID.
>
> Source for the PC numbers: the D1 probe run of 2026-10-21 in
> `docs/RESULTS.md`. Source for the phone/tablet rows: the D0-QA-02 manual run
> of 2026-10-21 in `docs/RESULTS.md`.

## Available devices

| ID | Role | Brand + model | Year | OS | Browser + version | Renderer | Network | Game Mode | Available | Results |
|---|---|---|---|---|---|---|---|---|---|---|
| `pc-win11-rtx3050` | Host / TV fallback | This Windows PC (brand/model not recorded) | not recorded | Windows 11 Home Single Language 10.0.26300, 64-bit | Google Chrome 155.0.8059.85 (D1 run, 2026-10-21) | WebGL2; max texture 16384; S3TC/S3TC_sRGB/BPTC/RGTC | LAN; dev server at `192.168.29.98:8080`; band not recorded | n/a (desktop) | yes | E1 **PASS**; E2 **RECORDED** (safe-mode cap; full ceiling PENDING); E3 **PASS** (desktop); E14 **PENDING** — see `docs/RESULTS.md` §D1 |
| `android-phone-d0qa02` | Controller | Android phone (brand/model not recorded) | not recorded | Android (version not recorded) | Chrome (version not recorded) | n/a (controller) | LAN via the dev server; band not recorded | n/a | yes | D0-QA-02 join **PASS** (2026-10-21). D1 probes not run on this device. |
| `android-tablet-d0qa02` | Controller | Android tablet (brand/model not recorded) | not recorded | Android (version not recorded) | Chrome (version not recorded) | n/a (controller) | LAN via the dev server; band not recorded | n/a | yes | D0-QA-02 join **PASS** (2026-10-21). D1 probes not run on this device. |

Notes:

- The host browser used in the D0-QA-02 run was not recorded. The PC's browser
  and version above come from the D1 run on 2026-10-21. Both phone/tablet
  browser versions were also not captured; do not infer them.
- The PC is the host screen and the current TV fallback. It is **not** a TV;
  desktop E1/E3 numbers must not be presented as TV results.
- Game Mode is a TV setting; it is not applicable to the desktop and was not
  tested on any TV.
- IDs ending in `-tbd` appear only in `docs/DEVICE-MATRIX.md` to hold the
  unavailable SPEC §12 rows. They are **not** devices and must not be used in a
  results row until real hardware exists.

## SPEC §12 rows and availability

| §12 platform | Status | Device ID | Notes |
|---|---|---|---|
| Chrome desktop | **Available — measured** | `pc-win11-rtx3050` | D1 E1/E2/E3 run 2026-10-21 (E2 safe mode only). |
| Chrome Android | **Available — controller only** | `android-phone-d0qa02`, `android-tablet-d0qa02` | D0-QA-02 join passed. No D1 capability/render probe was run; Chrome Android has no host-renderer role in v1. Exact versions not recorded. |
| Safari iOS 17+ | **Deferred (amendment A5)** | — | No iOS device; out of v1 acceptance. The controller must still degrade gracefully (feature detection stays). |
| Android TV (Chromium) | **Unavailable — not tested** | — | No TV. This is the row the D1 exit criterion requires. |
| Tizen | **Unavailable — not tested** | — | No TV. |
| webOS | **Unavailable — not tested** | — | No TV. |
| Firefox desktop | **Not tested** | — | Browser availability/version on this PC was not recorded; no E1 binary-WS run. |

## Network

- Router model and Wi-Fi band: **not recorded**.
- AP/client isolation: phone→PC LAN reachability **works** — in D0-QA-02 both
  Android controllers joined the room served by this PC. No explicit
  isolation-on/isolation-off test was run.
- Dev-server origins observed: `http://192.168.29.98:8080/` on the LAN and
  `http://localhost:8080/` locally. `127.0.0.1` is rejected by the WebSocket
  Origin allowlist (SR-11), so pages must be opened via `localhost` or the LAN
  IP during D1.

## Fallback

- **PC + HDMI** is the spec/plan default fallback if a TV browser fails
  E1-E3 (SPEC §22 Q2; `docs/todos/README.md` §11 Q2). This PC is available as
  the host; **HDMI output to a TV was not exercised**, so the fallback is
  recorded as available in principle, not verified end to end.
- A real TV probe run remains the only way to close the D1 exit criterion and
  the `G6` TV-only goal.

## Links

- `docs/RESULTS.md` §D1 — measured rows.
- `docs/BUDGETS.md` — budgets derived from the measurements.
- `docs/DEVICE-MATRIX.md` — the reusable per-stage checklist.
