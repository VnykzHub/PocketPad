# P2 — Pages and Production Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Steps use checkbox syntax.
>
> **Goal:** Serve the host, controller and game bundles from Vercel at `vynkzhub.com`, with a short TV URL, production config pointing at the relay, strict CSP/security headers, and a TV-only acceptance run that proves FR-4.1.
>
> **Architecture:** Static Vite builds for host (`/`, `/tv`), controller (`/c/:code`) and games (`/games/*`), deployed as one Vercel project with rewrites. Build-time `PublicConfig` selects the relay origins. No server functions are used for game traffic; the relay is separate.
>
> **Tech stack:** Vercel, Vite, `vercel.json` headers/rewrites, environment variables, CSP.
>
> **Spec:** `SPEC.md` §4.2, §6.2, §9.6, §13, §14 P2; FR-4.1–4.3, FR-4.6, FR-9.6, FR-9.12, SR-7, SR-8; A4.
>
> **Program position:** Phase 2, after P0; parallel with P1. Both P1 and P2 must finish before P3.

## Global constraints

- Pages are static; no Vercel functions in the game path.
- Host and controller builds are the same code as dev; only `PublicConfig` changes (FR-4.3/4.6).
- HTTPS only; WSS to the relay; no mixed content.
- Production CSP must include both `https://relay.vynkzhub.com` (room creation) and `wss://relay.vynkzhub.com` (A4).
- No secrets in the frontend build; `PublicConfig` is public.
- Experiments and dev-only tools are not deployed.
- iOS remains out of scope (A5).

---

## Stage goal and exit criteria

**Exit criteria (§14 P2):**

> Pages on Vercel, short TV URL, production config.

Concretely:

- [ ] `https://vynkzhub.com/tv` serves the host with no PC/local process (FR-4.1).
- [ ] `https://vynkzhub.com/c/<CODE>#<token>` serves the controller and joins the relay.
- [ ] The QR on the host points at the pages origin, never the relay.
- [ ] CSP/security headers pass with zero console violations.
- [ ] Production config is injected at build time; the same code runs in staging and production.
- [ ] Preview/staging/production deploys and rollback work.

**Layer coverage**

| Layer | Work items |
|---|---|
| Infra/ops | P2-INFRA-01..03, P2-OPS-01 |
| Security | P2-SEC-01 |
| QA | P2-QA-01 |

**Goals advanced:** G1 (short URL/QR), G6 (TV-only), G7 (secure static delivery).

---

## Work items

### P2-INFRA-01 — Static build outputs, Vercel project and route map

| Field | Value |
|---|---|
| Layer | Infra/ops |
| Spec | §4.2, §10, §14 P2; FR-4.1, FR-9.12 |
| Depends on | P0-OPS-03, D0-SRV-01, D3-RT-02 |
| Unblocks | P2-INFRA-02/03, P2-QA-01 |
| Deliverables | `vercel.json`, root build script, Vercel project config, `docs/DEPLOY-PAGES.md` |

**Route map**

| Path | Serves | Cache |
|---|---|---|
| `/` | host `index.html` | `no-store` |
| `/tv` | host `index.html` | `no-store` |
| `/c/*` | controller `index.html` (SPA fallback) | `no-store` |
| `/games/*` | game entry + assets | immutable for hashed assets |
| `/assets/*` | runtime/controller hashed assets | `public, max-age=31536000, immutable` |
| `/x/*` | 404 in production (experiments excluded) | — |
| `/healthz` | not on pages (relay only) | — |

**Build**

- `npm run build` produces `dist/host`, `dist/controller`, `dist/games`, `dist/assets`.
- One Vercel project can host all paths via rewrites; do not deploy `node_modules`, source maps, experiments, or dev-server code.
- Controller SPA fallback must return `index.html` for `/c/ABCD` and for `/c` (manual join).
- Host `/tv` and `/` serve the same build; no separate app.

**Steps**

- [ ] Add a production build script that assembles the four output directories.
- [ ] Write `vercel.json` with rewrites and headers (headers in P2-SEC-01).
- [ ] Configure the Vercel project (framework preset: none/Vite; output dir).
- [ ] Add `/c` (no code) fallback to the controller for manual join.
- [ ] Verify `/x/*` returns 404 in production.
- [ ] Record the deployment URL and build time.

**Acceptance**

- [ ] `/`, `/tv`, `/c/ABCD`, `/c`, `/games/<slug>` resolve correctly.
- [ ] Hashed assets are served with immutable cache; HTML is no-store.
- [ ] No experiments or source maps are public.
- [ ] The build contains no dev-server or relay code.

**Tests (tagged)**

- `[FR-4.1]` host is served with no local process
- `[FR-9.12]` `/tv` serves the host
- `[FR-4.3]` the same build runs in staging and production
- `[G3]` deployed JS/assets match the size-gated build

**Anti-rework**

- The route map mirrors the dev server; do not create a production-only page structure.
- One build artifact promotes through environments; avoid per-env code.

**Risks**

- Vercel rewrites can shadow static assets; order rules carefully and test `/assets/*`.
- SPA fallback must not swallow `/games/*` 404s.

---

### P2-INFRA-02 — Production config injection and origin wiring

| Field | Value |
|---|---|
| Layer | Infra/ops + config |
| Spec | §4.2/4.3; FR-4.3, FR-4.6; P0-ARCH-01 |
| Depends on | P0-ARCH-01, P1-SRV-01, P2-INFRA-01 |
| Unblocks | P2-QA-01 |
| Deliverables | Vercel env vars (staging/prod), `docs/CONFIG.md` update, build check |

**Env**

```env
VITE_ENV=production
VITE_PUBLIC_ORIGIN=https://vynkzhub.com
VITE_RELAY_ORIGIN=https://relay.vynkzhub.com
VITE_WS_ORIGIN=wss://relay.vynkzhub.com
VITE_REGION=bom
VITE_REQUIRE_PIN_FOR_QR=false
```

- Staging uses staging origins with the same variable names.
- The host creates rooms via `POST ${relayOrigin}/api/rooms`; the controller connects to `${wsOrigin}/ws`.
- The QR is built from `publicOrigin`, never `relayOrigin`.
- The build fails if a production env var is missing or points at `localhost`/a LAN IP.
- No runtime config fetch; Vite embeds values at build time. Document that a config change requires a redeploy.

**Steps**

- [ ] Add Vercel env vars for staging and production.
- [ ] Extend `parsePublicConfig` to reject non-HTTPS production origins and localhost.
- [ ] Add a build-time assertion that production bundles contain no `localhost`/`192.168.`/`ws://` literals.
- [ ] Point the host's room creation at `relayOrigin`; the controller's WS at `wsOrigin`.
- [ ] Verify the QR uses `publicOrigin`.
- [ ] Record the staging and production configs (values, not secrets).

**Acceptance**

- [ ] Staging pages talk to the staging relay; production pages to the production relay.
- [ ] No origin is hard-coded in the bundles.
- [ ] A missing/malformed production env fails the build.
- [ ] QR URLs point at the pages origin.

**Tests (tagged)**

- `[FR-4.3]` only config differs between environments
- `[FR-4.6]` users never configure transport
- `[SR-2]` QR origin is the pages origin, token in fragment
- `[SR-8]` CSP origins match the config

**Anti-rework**

- One config schema for P1/P2/P5; no duplicate env parsing.
- Keep staging/production variable names identical; values differ.

**Risks**

- Vercel preview deployments get random domains; previews need their own allowed origin or should use staging config. Decide and document.

---

### P2-INFRA-03 — Short TV URL and QR origin

| Field | Value |
|---|---|
| Layer | Infra/ops + host UI |
| Spec | §4.2, §9.6; FR-9.12, FR-5.1, SR-2 |
| Depends on | P2-INFRA-01, D4-HOST-01 |
| Unblocks | P2-QA-01, P5 |
| Deliverables | `/tv` rewrite, redirect rules, `docs/SHORT-URL.md` |

**Behavior**

- `vynkzhub.com/tv` serves the host directly.
- `vynkzhub.com/` also serves the host (typing the bare domain works).
- Optional `www` → apex redirect at the edge; keep one canonical origin for the QR and CSP.
- The QR encodes `https://vynkzhub.com/c/<CODE>#<roomToken>`.
- No path prefix such as `/host`; the TV URL stays short.
- A printed/on-screen "Open vynkzhub.com/tv" line is shown only if no room exists; once a room exists, the QR/code dominate.

**Steps**

- [ ] Add the `/tv` rewrite (no redirect loop with `/`).
- [ ] Add the `www` canonical redirect if `www` is configured.
- [ ] Verify the QR on a real TV encodes the apex pages origin.
- [ ] Test typing `vynkzhub.com/tv` on a TV remote.
- [ ] Document the canonical URL.

**Acceptance**

- [ ] `/tv` loads the host in under 2 s on the test TV network.
- [ ] The QR scans to the apex controller URL.
- [ ] No `www`/apex duplicate origins in CSP/QR.
- [ ] The bare domain also works.

**Tests (tagged)**

- `[FR-9.12]` short TV URL works
- `[FR-5.1]` QR token is in the fragment on the pages origin
- `[G1]` URL entry/scan path is short

**Anti-rework**

- One canonical public origin everywhere; do not let `www` leak into QR/CSP.
- P5 reuses the same URL.

**Risks**

- DNS/cert propagation for the apex can lag; test after propagation.
- TV browsers may cache the old redirect; use no-store on HTML.

---

### P2-SEC-01 — CSP, security headers, cache policy and mixed-content checks

| Field | Value |
|---|---|
| Layer | Security |
| Spec | §13; SR-8, SR-7; A4 |
| Depends on | P2-INFRA-01/02, P0-SEC-01 |
| Unblocks | P3-SEC-03, P5 |
| Deliverables | `vercel.json` headers, `docs/CSP.md`, test script |

**Headers**

```
Content-Security-Policy: default-src 'self'; connect-src 'self' https://relay.vynkzhub.com wss://relay.vynkzhub.com; img-src 'self' data:; media-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=()
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Frame-Options: DENY
```

- No `unsafe-inline`/`unsafe-eval`; no third-party scripts/fonts.
- `connect-src` includes both relay schemes (A4).
- Dev CSP may allow `ws:` same-origin, but production is exact.
- Cache: HTML no-store; hashed assets immutable; no caching of relay responses.
- No service worker in v1 (avoids stale app shells).

**Steps**

- [ ] Add the headers in `vercel.json` (global + path-specific).
- [ ] Verify the controller and host work with `style-src 'self'` (CSSOM updates are allowed; no inline `<style>` tags).
- [ ] Run a CSP-violation check in the browser console on staging.
- [ ] Verify `POST /api/rooms` works with the HTTPS relay origin in `connect-src`.
- [ ] Verify WSS connects with no mixed-content warnings.
- [ ] Add an automated header test (fetch the deployed page, assert headers).
- [ ] Document the policy and the one canonical origin.

**Acceptance**

- [ ] Zero CSP violations in a full join/play session.
- [ ] Room creation succeeds; WSS connects.
- [ ] HSTS, nosniff, referrer, frame and permissions headers present.
- [ ] No third-party requests on page load.
- [ ] HTML is no-store; assets immutable.

**Tests (tagged)**

- `[SR-8]` CSP lists HTTPS and WSS relay origins
- `[SR-8]` no unsafe-inline/unsafe-eval
- `[SR-7]` no third-party/analytics requests
- `[A4]` room creation is not blocked by connect-src
- `[FR-4.1]` TV-only session works under the CSP

**Anti-rework**

- One CSP source of truth for staging/production (env-substituted relay origin if needed).
- P3 tightens further; it does not replace the policy from scratch.

**Risks**

- Some TV browsers are picky about CSP; test on the actual TV, not only desktop.
- Inline style attributes in the controller would break under `style-src 'self'`; the DOM renderer uses CSSOM, which is allowed, but verify.

---

### P2-OPS-01 — Vercel deploy pipeline, previews and rollback

| Field | Value |
|---|---|
| Layer | Infra/ops |
| Spec | §14 P2; P0 ADR-0004 |
| Depends on | P2-INFRA-01..03, P2-SEC-01 |
| Unblocks | P2-QA-01, P5 |
| Deliverables | Vercel project settings, `.github/workflows` or Vercel Git integration, `docs/DEPLOY-PAGES.md` |

**Behavior**

- Git integration: preview per PR, staging on main, production on manual promotion (or a protected branch).
- Build command runs typecheck/tests before Vite build (or CI gates the deploy).
- Env vars scoped per environment; no production secrets in previews.
- Rollback: Vercel instant rollback to the previous deployment; DNS unchanged.
- Preview URLs are not added to the production Origin allowlist; previews use staging config or are excluded from joining production rooms. Document.
- Build output excludes experiments and source maps in production (or uploads source maps privately for debugging).

**Steps**

- [ ] Configure preview/staging/production environments and env scopes.
- [ ] Gate deploys on CI typecheck/tests/build/size.
- [ ] Test a rollback to the previous deployment.
- [ ] Verify preview URL behavior with the relay allowlist.
- [ ] Document deploy/rollback and the canonical URL.
- [ ] Record the first staging and production deploys.

**Acceptance**

- [ ] Merges deploy staging; production needs approval.
- [ ] Rollback restores the previous build in under a minute.
- [ ] Preview URLs cannot join production rooms unless explicitly allowed.
- [ ] No secrets in frontend env.

**Tests (tagged)**

- `[FR-4.1]` production pages deploy and serve the host
- `[SR-11]` preview origins are not in the production allowlist
- `[G7]` deploy artifacts contain no dev/experiment files

**Anti-rework**

- Same artifact to staging/production; env differs.
- Rollback is a platform action, not a rebuild.

**Risks**

- Preview deployments may hit CORS/WS failures; that is expected unless configured.
- Vercel build minutes/cost at scale; note in COST.

---

### P2-QA-01 — TV-only end-to-end acceptance

| Field | Value |
|---|---|
| Layer | QA |
| Spec | §14 P2; FR-4.1, G1, G6; §11 |
| Depends on | P1-QA-01, P2-INFRA-01..03, P2-SEC-01, P2-OPS-01 |
| Unblocks | P3 |
| Deliverables | `docs/RESULTS.md` P2 row, screenshots |

**Scenario (the critical one)**

- [ ] On the actual TV, with no PC and no local process, open `https://vynkzhub.com/tv`.
- [ ] Host creates a room; QR/code/PIN appear.
- [ ] Scan with a phone; controller loads over HTTPS and joins over WSS.
- [ ] Play the cube demo / a proof game; input works; no mixed-content/CSP errors.
- [ ] Close the TV tab and reopen `/tv`; host recovers within 30 s.
- [ ] Check the browser console and network: no third-party requests, no errors.
- [ ] Measure load-to-playable time; record.

**Additional**

- [ ] Manual join from a phone without a camera (code+PIN) on the production URL.
- [ ] Controller on 4G (not the LAN): joins and plays; record latency.
- [ ] `www` redirect does not break QR/CSP.
- [ ] Rollback deployment still serves a working host.

**Steps**

- [ ] Run the scenario on the test TV and two phones; record device/browser/version.
- [ ] Capture screenshots and a network summary (no tokens).
- [ ] Record G1 timing on production-like staging.
- [ ] File any CSP/CORS/mixed-content issue as a blocking defect.
- [ ] Record results in `docs/RESULTS.md`.

**Acceptance**

- [ ] FR-4.1 proven: TV-only, no local process.
- [ ] No CSP/mixed-content errors.
- [ ] QR/manual join both work on production URLs.
- [ ] Host recovery works.
- [ ] Results include devices, network, and numbers.

**Tests (tagged)**

- `[FR-4.1]` host playable with no local process
- `[G6]` TV-only primary path works
- `[SR-8]` production CSP permits the real flow with zero violations
- `[FR-5.6]` manual join works on production
- `[G1]` scan-to-play is measured on production-like staging

**Anti-rework**

- This acceptance run is repeated in P5 with beta users; keep the script.
- Do not "fix" CSP by adding unsafe-inline; fix the code.

**Risks**

- Phone on 4G may route to a relay region with different latency; record.
- TV browsers may block WSS under some proxy; test the real TV network.

---

## Stage exit checklist

- [ ] P2-INFRA-01..03, P2-SEC-01, P2-OPS-01, P2-QA-01 complete.
- [ ] Pages live at `vynkzhub.com` with `/tv` and `/c/:code`.
- [ ] Production config injected; no hard-coded origins.
- [ ] CSP/security headers pass with zero violations.
- [ ] TV-only run proves FR-4.1.
- [ ] Rollback works.
- [ ] `docs/RESULTS.md` P2 row complete.

## Handoff to P3

- P3 hardens the deployed surface: rate limits, PIN modes, UGC filter, logging.
- P2 does not change broker semantics; P3 tunes config and adds controls.
- Both P1 and P2 must be complete before P3 starts.

## Explicitly not in P2

- Relay changes (P1).
- Beta traffic (P5).
- Multi-region pages (not needed).
- Service worker/offline mode (not in v1).
- iOS work (A5).
