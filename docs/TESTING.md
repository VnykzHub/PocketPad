# Testing Guide

> D0-QA-01. Read with `docs/todos/TRACEABILITY.md` (the single source of
> requirement IDs) and `docs/todos/IMPLEMENTATION-ORDER.md` (stage order).
> This file describes how tests are written, tagged, and recorded; it does not
> replace the stage acceptance checklists.

## Commands

| Command | What it runs |
|---|---|
| `npm test` | Every Vitest project once (`vitest run`) |
| `npm test -- --project packages/dev-server` | One workspace's tests |
| `npm run typecheck` | `tsc -b` over the project references |
| `npm run lint` | ESLint, including the layer import rules |
| `npm run build` | Build every workspace (server, SDK, tools and browser bundles) |
| `npm run size` | Controller and host gzip budgets (dev tier) |
| `npm run trace` | Trace check scoped to the current stage (`--stage D0`) |
| `npm run check` | All of the above, in order; the local gate and what CI runs |

Everything runs on Node >= 20 and needs no network, credentials, or phone.
CI (`.github/workflows/ci.yml`) runs `npm ci` then `npm run check` on Node 20.

## Tag convention

TRACEABILITY.md is the only ID list. Every requirement ID there must appear in
at least one test:

- in the test title: `test("[FR-7.3] sub-tick tap keeps its edge bit", ...)`
- or in a leading comment: `// @req FR-7.3`

A title may carry several tags: `test("[G4][FR-5.3] ...")`. A tag counts only
inside square brackets or after `@req`; a plain mention in prose, a string
literal elsewhere, or an array literal such as `toEqual(["FR-1.1"])` does not
count. A tag must resolve to a row in TRACEABILITY.md: `[FR-99.9]` fails the
checker as an unknown ID.

Enforcement is stage-scoped:

- `npm run trace` passes `--stage D0`. Only `FR`/`NR`/`PR`/`SR`/`AR`/`TR` rows
  whose `Primary work item(s)` cell names the current stage are required.
  Untagged IDs owned by later stages are reported as **deferred**, not missing.
- The Gate (and later stages, by changing the flag) runs the checker without
  `--stage` and requires the whole matrix.
- Goals (`G`), experiments (`E`), capabilities (`C`) and amendments (`A`) are
  Gate-audited. Tag them when the work lands; they are never a reason to add a
  placeholder tag.

Tag the test that actually exercises the requirement. Never add an ID to
TRACEABILITY.md, weaken a test, or delete a tag to make the checker pass; an
unknown or missing tag is a real defect. The Gate samples tests to confirm the
body asserts something, so an empty test with a correct tag still fails.

## Test layers

| Layer | Location | Purpose |
|---|---|---|
| Unit | `packages/*/test/*.test.ts` | One module's behavior: codecs, registry, routing, client |
| Property | same, using `fast-check` | Invariants over random inputs, e.g. `decode(encode(x))` round-trips and bounds |
| Golden | `packages/*/test/fixtures/` | Frozen wire bytes and manifests that must not drift silently |
| Integration | `packages/dev-server/test/e2e.test.ts` and broker WS tests | The real HTTP server, real broker, real WebSocket clients |
| Manual | `docs/RESULTS.md` | Device, browser and TV behavior no CI run can prove |

Rules that apply to every layer:

- Test the component under test through its real interface. Do not mock the
  dev server, broker, or WebSocket layer in integration tests; those tests are
  the regression harness for later stages (D4 sessions/reconnect builds on the
  D0 echo test).
- Bind local servers to `127.0.0.1` and port `0`. Never use a fixed port, and
  never expose a test server beyond loopback.
- Wait on messages and events, not fixed sleeps. The only intentional wait is
  the 40 ms tap hold that proves edges survive a sub-tick press.
- Keep tests hermetic: temp directories under `os.tmpdir()`, no clock, locale,
  or ordering assumptions, and no dependency on another test's state.
- No secrets in tests or logs: no real tokens, PINs, session values, room codes
  from a live room, customer data, or personal device names/IPs. When asserting
  logs, assert that secrets are absent.
- Do not weaken or skip a test to land a change. If a test is wrong, fix the
  test in the same change and explain why in the commit.

## Recording manual results

Manual checks (phones, browsers, TVs, LAN feel, latency perception) are
recorded in `docs/RESULTS.md`, one row per run:

| Field | Meaning |
|---|---|
| Date | `YYYY-MM-DD` of the run |
| Stage / work item | e.g. `D0-QA-02` |
| Device | Model; redact personal names before publishing |
| OS / browser | OS version and browser + version |
| Method | What was done and what was measured |
| Result | Numbers where possible, or the observed behavior |
| Verdict | PASS / FAIL / PENDING |

A manual row stays **PENDING** until a person actually runs it. Automated test
output, CI, or a localhost browser tab is not a substitute for a phone/TV run.
Link raw logs or screenshots when they are kept; do not paste tokens, PINs,
session values, or live room codes into this repository.

## Adding a requirement

1. Change the code and the tagged test together.
2. Add the tag to the test title or as `// @req ID`.
3. If the requirement is genuinely new, add its row to TRACEABILITY.md and the
   owning stage file in the same change; then run `npm run trace`.
4. Run `npm run check` before handing off.
