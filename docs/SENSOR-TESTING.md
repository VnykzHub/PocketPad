# Sensor testing on Android (D6-DOC-01)

> **Status:** procedure written 2026-10-22. No E7/E8 device run has been
> recorded. `experiments/e07/`, `experiments/e08/` and the swing page do not
> exist yet, and no bundled game declares `sensors.gyro`, so the in-app leg is
> still blocked. The console procedure below is runnable today and records the
> E7 platform facts (secure context, units, signs, drift) without those pages.
>
> **Scope:** Android Chrome. iOS is deferred by amendment A5 and is not an
> acceptance target; see §8.
>
> **Related:** `docs/RESULTS.md` §E7/E8, `docs/DEVICE-MATRIX.md`,
> `docs/todos/phase-1-dev/D6-sensors-haptics.md` (`D6-EXP-01`, `D6-DOC-01`),
> `docs/RESULTS.md` §E14 (the tunnel mixed-content probe).

## 1. Why gyro needs a secure context

`DeviceMotionEvent` is a sensor API gated on a **secure context**. A page is a
secure context when it is delivered over HTTPS or from `localhost`. A LAN URL
such as `http://192.168.1.23:8080/c/ABCD` is **not** a secure context, even
though the phone can reach it.

On Chrome Android in an insecure context, `DeviceMotionEvent` may exist as a
constructor while the browser withholds `devicemotion` events; E7 records the
exact behaviour on the device. The controller therefore checks
`window.isSecureContext` before it offers motion:

- `MotionEnable` enters the `insecure-context` state and shows
  **"Motion needs a secure HTTPS connection."**
- The layout's non-gyro controls remain fully usable (FR-8.10, AR-3).
- No permission prompt is shown on page load; enabling is always tap-gated.

This is the key E7 finding: the same phone, same room, same layout works over
HTTPS and does not deliver motion over plain LAN HTTP.

Two dev workarounds exist: an HTTPS tunnel (§3, recommended) or the Android
Chrome insecure-origin flag (§4). Production is HTTPS and needs neither.

## 2. What exists today, and what is missing

Implemented and covered by tests:

- Controller `MotionEnable` states: `idle`, `requesting`, `granted`, `denied`,
  `no-data`, `paused`, `insecure-context`, `unsupported`. The no-data watchdog
  fires after **1000 ms**.
- `GyroSampleBinding` at 60 Hz; `sensors.smoothing` and `sensors.sensitivity`
  from the layout are applied.
- A visible motion pill on an explicit `gyro` control, and a compact motion
  status strip (300x60, 112x44 action) when a layout declares
  `"sensors": { "gyro": "steer" | "aim" | "tilt" }` but renders no `gyro`
  control.
- Visibility handling: the sensor and binding stop when the page is hidden and
  resume only if motion was already granted.
- Host integration: `TiltIntegrator` per slot, clamp ±30°, inactive decay at
  20 deg/s. With `?debug=1`, the host overlay shows per-slot
  `gyro on|off · tilt X.X°/Y.Y°` (or `tilt —` when unavailable).

Missing / blocking a full E7 run:

- `experiments/e07/` (the raw `rotationRate` logger with CSV copy) does not
  exist. The console snippet in §5 replaces it for now.
- `experiments/e08/` (vibration patterns) and the swing page do not exist.
- No shipped game or layout declares `sensors.gyro`, so the in-app motion pill
  and strip cannot be exercised on a device until a gyro layout or the E7 page
  exists. The UI behaviour is unit-tested, not device-accepted.
- `docs/RESULTS.md` E7, E8 and swing rows remain **PENDING**.

## 3. HTTPS tunnel procedure (recommended)

`cloudflared` quick tunnels need no account. `ngrok` works too but current
versions usually require a free account and an authtoken. Record the provider
and version in `docs/RESULTS.md`.

Prerequisites: Node 20+, a built tree, and an Android phone with Chrome. The
phone needs internet access for the tunnel; it does not need to be on the same
Wi-Fi as the PC (although the host page still runs on the PC).

### 3.1 Build once

```sh
npm run build
```

The dev server serves `packages/controller/dist`, `packages/runtime/dist`,
`packages/games/dist` and `experiments/`. If a `dist` is stale or missing, the
controller page or a game asset returns 404 through the tunnel.

### 3.2 Start the tunnel

Terminal A:

```sh
cloudflared tunnel --url http://localhost:8080
```

Record the printed `https://<random>.trycloudflare.com` URL and the
`cloudflared --version` output. Alternative:

```sh
ngrok http 8080
```

`ngrok` may require `ngrok config add-authtoken <token>` first. Record
`ngrok --version` and expect a free-tier interstitial that must be dismissed
once on the phone.

Keep the tunnel running only for the test window.

### 3.3 Start the dev server with the tunnel origin allowlisted

The dev server's `defaultConfig()` allows only the LAN/localhost origins for
port 8080. The broker rejects any other browser `Origin` at the WebSocket
upgrade (SR-11), so a tunnel page that is not allowlisted loads but cannot
connect. There is no CLI flag or environment variable for this yet; push the
origin into the config before `listen()`.

Terminal B, from the repo root (substitute the host printed in 3.2):

```sh
node --input-type=module -e "import { createDevServer, defaultConfig } from './packages/dev-server/dist/index.js'; const config = defaultConfig(); config.allowedOrigins.push('https://TUNNEL-HOST'); const app = createDevServer(config); console.log(await app.listen());"
```

Windows PowerShell and cmd accept the double-quoted `-e` argument with single
quotes inside; bash does too. Keep the process in the foreground.

Expected output: `{ port: 8080, urls: [ 'http://<lan-ip>:8080', ..., 'http://localhost:8080' ] }`,
and the server keeps running. If port 8080 is already in use, stop the other
process; the tunnel is fixed to 8080.

Why the controller page is opened through the tunnel: the controller resolves
the server origin from `location.origin`, so it connects to
`wss://TUNNEL-HOST/ws`. The tunnel terminates TLS and forwards to
`localhost:8080`; the page and socket share one origin, so there is no mixed
content. The alternative (HTTPS page connecting to a LAN `ws://` address) is
blocked by mixed-content rules; E14 records that failure separately.

### 3.4 Create a room and join from the phone

1. On the PC, open `http://localhost:8080/` and create a room (or use the
   room panel's existing room).
2. Note the 4-character code and the PIN, if the room uses one.
3. On the phone, open `https://TUNNEL-HOST/c/CODE` (the page loads even before
   a room exists). Enter the PIN when prompted.
4. Do **not** scan the host's QR from this setup: it encodes the host origin
   (`http://localhost:8080/c/CODE`), which the phone cannot reach. Join by
   code instead. If the room requires the QR token, copy the fragment
   (`#<roomToken>`) from the QR URL and append it to the tunnel URL; never
   paste the token into logs or screenshots.

### 3.5 Confirm the secure context

In the phone's Chrome, the simplest check without USB debugging is the
controller UI: with a gyro layout, the motion action must not show
**"Motion needs a secure HTTPS connection."** With USB debugging, use
`chrome://inspect/#devices` on the PC and evaluate:

```js
window.isSecureContext; // must be true
```

If it is `false`, the page is not the HTTPS tunnel URL (check for a redirect, a
cached HTTP tab, or the ngrok interstitial).

## 4. Alternative: Android Chrome insecure-origin flag (LAN HTTP)

Use this only when a tunnel is unavailable. It changes the browser's security
model, so record that the flag was used.

1. On the phone, open
   `chrome://flags/#unsafely-treat-insecure-origin-as-secure`.
2. Under "Insecure origins treated as secure", enter the exact controller
   origin: `http://<LAN-IP>:8080` — scheme, host and port, no path, no trailing
   slash.
3. Set the flag to **Enabled** and relaunch Chrome.
4. Open `http://<LAN-IP>:8080/c/CODE` and verify
   `window.isSecureContext === true`.

Caveats:

- Every page on that origin is treated as trustworthy, not just the controller.
- The flag is per browser profile, can reset on update, and may be unavailable
  in managed or newer builds.
- Results obtained this way are dev evidence only. Record "flag used" in
  `docs/RESULTS.md`; do not present a flag run as production behaviour.
- Remove the origin from the flag list after the test.

`mkcert` plus a root CA installed on the phone is a third option. It is
fiddly, device-specific, and not the default. Document it only if it is
actually used.

## 5. Step-by-step E7 verification

E7 asks for `rotationRate` units, signs and axis mapping on Android, the
secure-context difference, and drift. The console leg below works today; the
in-app leg needs a gyro layout.

### 5.1 Raw sensor leg (works today)

1. Enable USB debugging on the phone, connect it to the PC, and open
   `chrome://inspect/#devices` in desktop Chrome.
2. Open the controller page (LAN HTTP first, then the HTTPS tunnel) and press
   **Inspect**.
3. In the console, record the context and start logging:

```js
window.isSecureContext;
const logMotion = (event) => {
  const r = event.rotationRate;
  console.log(JSON.stringify({
    ms: Math.round(performance.now()),
    alpha: r?.alpha ?? null,
    beta: r?.beta ?? null,
    gamma: r?.gamma ?? null,
    interval: event.interval ?? null,
    orientation: screen.orientation?.type ?? null,
  }));
};
addEventListener("devicemotion", logMotion);
```

4. On the **LAN HTTP** page: `isSecureContext` should be `false` and no motion
   lines should appear. Record the exact result; this is E7's secure-context
   finding. If lines do appear over HTTP, record that too: it means that Chrome
   build did not enforce the gate, and the finding must be written down rather
   than assumed. Stop and restart Chrome between the HTTP and HTTPS runs so a
   stale listener cannot confuse the result.
5. On the **HTTPS tunnel** page: `isSecureContext` should be `true` and lines
   should appear. Rotate the phone slowly around each axis.
6. Record resting noise, the sign of each axis, and the units. Treat the
   values as degrees per second (the spec assumption E7 verifies).
7. Repeat in portrait and landscape; record `screen.orientation.type` with the
   values. This produces the per-platform sign/axis table that
   `D6-CTRL-02`'s remap must match.
8. Leave the phone still for 60 s and record drift / auto-zero behaviour.
9. Remove the listener with `removeEventListener("devicemotion", logMotion)`.

### 5.2 In-app leg (blocked until a gyro layout exists)

Prerequisite: a layout containing `"sensors": { "gyro": "tilt" }` (or
`"steer"` / `"aim"`), served by a game. No bundled game does this at the time
of writing. When one exists:

1. Join the room and wait for the layout.
2. With no explicit `gyro` control, the motion strip appears top-centre with
   an **Enable motion** action. With an explicit control, tap its
   **Enable motion** pill.
3. Tap once; Android Chrome has no `DeviceMotionEvent.requestPermission`, so
   listening starts directly. Confirm the label changes to **Motion on**
   (strip) or the pill reports motion.
4. On the host with `?debug=1`, confirm the player's row shows `gyro on` and
   `tilt X.X°/Y.Y°` changing as the phone tilts. Tilt is clamped to ±30°.
5. Tap **Recalibrate** while holding the phone still; tilt should return to
   ~0°.
6. Background the page or lock the screen, then return. Motion must pause and
   resume only if it was granted before; the fallback controls must stay
   usable while paused.
7. If motion is denied or unsupported, confirm the message and that the
   non-gyro controls still work.

### 5.3 E7 record and go/no-go

- [ ] Secure context `false` on LAN HTTP; no sensor data.
- [ ] Secure context `true` over HTTPS (tunnel or flag); sensor data flows.
- [ ] Android Chrome needs no `requestPermission`; the first tap starts it.
- [ ] Units, signs and axis mapping recorded for portrait and landscape.
- [ ] 60 s drift / auto-zero recorded.
- [ ] In-app enable, recalibrate, pause/resume and fallback verified (blocked
      until a gyro layout exists).
- [ ] Written go/no-go for gyro games: if rates are stable and remappable,
      gyro games may proceed; if not, restrict them and keep the fallback as
      the primary path.

Append the result to `docs/RESULTS.md` §E7. Do not convert the PENDING row to
PASS without a device run, and never overwrite another experiment row.

## 6. Troubleshooting

| Symptom | Likely cause | Check | Fix |
|---|---|---|---|
| Tunnel page loads, but joining fails or the socket closes immediately | Browser `Origin` not in the dev-server allowlist | Dev-server terminal; the broker rejects the upgrade (403/1006) | Restart with the tunnel origin pushed (§3.3); confirm the scheme is `https` and the host matches exactly |
| `window.isSecureContext` is `false` | Page served over LAN HTTP, or a cached HTTP tab | Address bar and `location.href` | Use the HTTPS tunnel URL or the Chrome flag (§4); close the HTTP tab |
| **"Motion needs a secure HTTPS connection."** | Same as above; the controller detected `insecure-context` | `isSecureContext` | Fix the page origin; the fallback controls already work |
| **"Motion is not available on this device."** | No `DeviceMotionEvent` (desktop browser, or a device without motion sensors) | `typeof DeviceMotionEvent` | Run on an Android phone; do not expect motion on a laptop |
| **"Motion permission was denied."** | Permission refused or blocked by policy | Site settings for the origin | Reset the site permission, reload, tap again; Android Chrome normally does not prompt |
| **"No motion data received."** | No events within 1000 ms | Console snippet in §5.1; foreground the page; check the origin | Keep the screen awake and the page foreground; use HTTPS/flag; if still empty, the device or browser is not delivering motion |
| Values are all zero | Phone is still (auto-zero) or sensor fusion has not settled | Console output while moving the phone | Move the device; tap Recalibrate; retry after a few seconds |
| Values drift | Sensor bias | 60 s still run | Record the drift; rely on auto-zero/recalibrate; report if it makes gameplay unusable |
| Wrong axis or sign | Orientation not recorded, or the remap table differs per platform | `screen.orientation.type` and raw axes | Record the raw table in E7; fix `D6-CTRL-02`'s mapping, not the game |
| **"Motion paused"** | Page hidden or screen locked | `document.visibilityState` | Return to the page; it resumes only if motion was granted before |
| Tunnel returns 502 | Nothing listening on `localhost:8080` | Dev-server terminal | Start the server (§3.3); keep it running |
| ngrok shows a warning interstitial | Free-tier browser warning | The page before the controller | Dismiss "Visit Site" once, or use `cloudflared` |
| Vibration does nothing | Silent mode, no user activation, or no Vibration API | `navigator.vibrate`, ringer mode, haptics toggle | Unmute, tap once to activate, enable the toggle; visual fallback is expected |
| Console: "Mixed Content" | HTTPS page connecting to a LAN `ws://` URL | Network tab / console | Use the same-origin `wss://` tunnel path; do not point the HTTPS page at the LAN socket |

## 7. Security caveats

- **Temporary only.** Start the tunnel for the test and stop it with Ctrl+C
  when done. Do not leave it running, and do not add tunnel origins to
  committed config. There is no production tunnel mode.
- **Anyone with the URL can reach the dev server.** The room code and PIN gate
  play, not static files or `/api`. Treat the URL as a secret for the test
  window.
- **The tunnel provider terminates TLS** and can observe traffic metadata and
  content. Do not send production data, real user data, or secrets through it.
- **No tokens in logs or screenshots.** Room tokens, session tokens and host
  tokens are bearer credentials. Redact them from copied console output and
  URLs before pasting into `docs/RESULTS.md`.
- **Quick tunnels have random hostnames and no SLA.** Providers may inject
  headers or an interstitial, and some networks block them.
- **Do not measure latency over a tunnel.** The extra hop and TLS termination
  invalidate E5/E6 numbers. The tunnel is for sensor and permission tests
  only.
- **The Chrome flag lowers a security boundary** for the whole origin. Use it
  only for dev, record it, and remove it after the test. Never ship a flag or
  an insecure-origin allowance in production.
- **Trusted network only.** Do not expose a dev server with real room state to
  untrusted users.

## 8. iOS deferral (A5)

iOS is **out of v1 acceptance** by explicit user decision (amendment A5 in
`docs/todos/README.md` §1). iOS is deferred, not failed, and no iOS-specific
fixes are scheduled.

What the code already does:

- `DeviceMotionEvent.requestPermission` is called **only if it exists**, and
  only inside the user's tap. It is never called on page load. On Android
  Chrome the function does not exist, so motion starts directly.
- HTTPS is still required for motion on iOS.
- iOS has no Web Vibration API; the controller's visual haptics fallback is
  the expected behaviour there.
- Every gyro layout must keep a usable non-gyro control set, so an iOS device
  can still play.

If iOS becomes a target later:

1. Add the device to `docs/DEVICE-MATRIX.md` and record its OS/browser.
2. Enable and verify the `requestPermission` path inside a user gesture.
3. Run the E7 and E8 iOS legs with this procedure (HTTPS tunnel) and append
   rows to `docs/RESULTS.md`.
4. Re-check layouts for the non-gyro fallback and visual haptics.
5. No architectural change is expected.

## 9. Recording the run

Use the `E7`/`E8` table shape in `docs/RESULTS.md` (`docs/RESULTS-TEMPLATE.md`
has the blank row). At minimum record:

- Date, device ID/model, Android version, Chrome version.
- Tunnel provider and version, or "Chrome flag used" with the exact origin.
- Page URL **without** tokens; HTTP vs HTTPS.
- `isSecureContext` result and whether any `devicemotion` events arrived.
- Sample count, orientation(s), units, sign/axis table and drift.
- For E8: pattern, duration, phone model, and whether 10 Hz vs 20 Hz is
  distinguishable.
- A go/no-go for gyro games and, separately, for 20 Hz haptics.

A tunnel or flag run is dev evidence. Production acceptance is a later HTTPS
deployment (P2/P5); record the method so the Gate can tell them apart.
