# Controller layout recipes

Validator-backed layouts for the controller renderer. **These files are
fixtures, not game layouts.** A game owns its layouts in
`packages/games/<game>/layouts/`; copy a recipe there, change its `id`, and
keep the game's layout test (see each game's `test/layout.test.ts`) as the
gate. Do not point a game at a file in this directory.

Every recipe here is validated by `packages/controller/test/layoutFixtures.test.ts`
through the same `validateLayout` the host and controller use at runtime.

## Rules the validator enforces

- `id` is 1..64 characters; the convention is `<game>-v<n>`.
- 1..24 controls; unique control ids, button bits, and trigger/slider channels.
- Layout JSON is at most 16 KB.
- Lengths are percentages of the reference dimension:
  - `x`/`y` of the viewport width/height;
  - `size`/`r`/`w`/`h` of `min(width, height)`.
- Event names match `^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$`.
- A `gyro` control requires at least one non-gyro fallback control. The
  fallback is mandatory because motion permission, HTTPS, or sensor data can
  be unavailable; the touch fallback must keep the game playable.
- Choice controls have 1..12 options with unique values; text `maxLen` is
  1..200; haptic patterns have 1..8 integer steps, each 0..65535.

The controller raises every interactive target to at least **44 CSS px**
(AR-5) and adds an 8 px touch slop. Recipes still place controls so their
natural size clears 44 px at a 390 px-wide phone; the QA page checks this.

## Recipes

| File | Use | Controls |
|---|---|---|
| `launcher-remote-v1.json` | Console home remote | d-pad, Select, Back, status panel |
| `recipe-gyro-racer-v1.json` | Racing | gyro steer, stick fallback, brake, speed panel |
| `recipe-tilt-maze-v1.json` | Tilt puzzle | gyro tilt, d-pad fallback, restart, timer panel |
| `recipe-beat-tap-v1.json` | Rhythm | four lanes, cancel, beat panel |
| `recipe-draw-guess-v1.json` | Draw and guess | canvas, text, choice, prompt panel |
| `recipe-bluff-quiz-v1.json` | Quiz/bluffing | choice, text, lock button, question panel |
| `recipe-spy-v1.json` | Hidden-role | private panel, reveal button, done button |
| `recipe-couch-party-v1.json` | Local multiplayer | d-pad, three face buttons, HUD panel |

The launcher remote also exists as a typed export:

```ts
import { LAUNCHER_REMOTE_LAYOUT, LAUNCHER_REMOTE_BITS } from "@lanpad/controller";
```

| Launcher input | Protocol bit |
|---|---|
| Select (confirm) | 0 |
| Back | 1 |
| Up / Down / Left / Right | 8 / 9 / 10 / 11 |

The host decides what each screen does with those bits; the controller only
sends them. The `status` panel is host-owned content (highlighted title, room
state, player list) via the normal panel message.

## Gyro layouts

1. Include a `gyro` control **and** a touch fallback (stick or d-pad).
2. Put the motion mode in `sensors.gyro` (`steer`, `aim`, or `tilt`) and tune
   `sensitivity`/`smoothing` there or per control. Defaults: sensitivity 1,
   smoothing 0.15.
3. Motion permission is requested on the player's first tap, never on page
   load. The control shows **Enable motion**, then **Hold still — calibrating**
   for the 500 ms auto-zero window, then the level bubble and a 44 px
   **Recenter** target. Recenter re-opens the window and sets the one-packet
   `recentered` flag (bit 1).
4. If permission is denied, the page is insecure, the browser lacks motion, or
   no sample arrives within 1 s, the control shows the fallback copy and the
   touch fallback continues to work. Games must not gate their core loop on
   motion.
5. For steering, use the shared mapping instead of dividing by a magic number:

```ts
import { steerAxisFromWire } from "@lanpad/controller";

const steer = steerAxisFromWire(input.rx, {
  deadzoneDps: 2,
  fullScaleDps: 90,
  invert: false,
}); // -1..1
```

`input.rx` is the wire i16 (`dps × 10`). Positive yaw steers right.

## Tap-to-beat calibration

A rhythm or timing game can estimate a player's tempo from a few taps:

```ts
import { TapTempoTracker } from "@lanpad/controller";

const tempo = new TapTempoTracker();
const estimate = tempo.tap(performance.now());
// estimate: { bpm, intervalMs, taps, spreadMs, confidence } | null
```

The helper ignores double taps (<= 120 ms), restarts after a pause longer
than 2 s, uses the median interval, and reports `confidence` in 0..1. Require
at least three taps and, for example, `confidence >= 0.6` before starting.
Reset the tracker when the calibration screen is reopened.

## Haptics

Use the shared event patterns so feedback is consistent and fits one haptic
frame (1..8 alternating vibrate/pause steps):

```ts
import { hapticPatternFor } from "@lanpad/controller";

const pattern = hapticPatternFor("hit"); // [30]
```

Available events: `tick`, `select`, `hit`, `countdown`, `goal`, `error`.
Pass the result to `HapticPlayer.play()`. Haptics are optional feedback: keep
a visible pulse for devices without vibration (AR-3).

## Private panels and UGC controls

- Panels receive host content; do not put private text in a layout label.
  Text/choice/canvas payloads leave the phone only on submit.
- `text` sends one `{value}` per submit (Enter or the 44 px Send button), not
  per keystroke; `maxLen` is enforced on the phone before sending.
- `choice` sends `{value}` for the tapped option; vertical drag scrolls.
- `canvas` sends batched strokes `{points,color,width,phase}` and enforces the
  stroke rate cap. No HTML is accepted in any payload.

## Checklist for a new game layout

1. Copy the closest recipe into `packages/games/<game>/layouts/` and change
   `id`.
2. Add or update the game's layout test to call `validateLayout` and to assert
   the bits/events the game reads.
3. Check every interactive control is at least 44 px at 390 px width.
4. For motion, include the touch fallback and decide what happens when motion
   is unavailable.
5. Run the game's layout test and `npx vitest run --project packages/controller`.
6. Record real-phone results separately; do not mark hardware rows complete
   from desktop or emulator evidence.
