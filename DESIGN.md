# PocketPad Design System

**Direction:** `true-black-flat` — app style dealt by the taste skill, seed `1080531052`, kind `community`, drawn 2026-10-22.
**Sources:** taste skill (`design-taste-frontend`) for the dealt style, Emil Kowalski's design-engineering rules for interaction and motion, Impeccable for surface mode and craft floor.

## The idea

On this platform, **the room's only light is the game, and every surface stays out of its way**. The TV is a dark stage; the phone is a dark control surface. Neither is a dashboard, a landing page, or a website. The interface recedes; the game and the players' hands carry the colour.

## Two redraws from the dealt sheet (recorded)

| Redraw | Why |
| --- | --- |
| **Shell** — no 210px sidebar, no 64px desktop top bar | The host is read at 2–4 m with a five-key remote, and the controller is held in two hands. A desktop navigation shell contradicts the product's use. The palette, elevation, accent discipline and control language are kept. |
| **Type scale** — TV sizes are 2–3× the dealt app scale | 20px titles are desktop-sized. A 10-foot UI needs 48–64px titles and 22–26px body text to be read without leaning in. The phone keeps close to the dealt scale. |

Everything else is adopted: true black ground, elevation by lightness alone, one lime accent confined to live data/state, no borders or shadows on resting cards, inverted white primary, Inter, sentence case, no tracked capitals.

## Principles

1. **The game is the brightest thing on the TV.** Platform chrome is black, quiet, and never competes with the canvas.
2. **The controller is a surface, not a page.** It does not scroll under a thumb, it has no navigation, and it never asks the player to look away from the TV.
3. **One accent, earned.** Lime marks live input and live connection. It is never decoration, never a button fill, never a nav highlight.
4. **Elevation by lightness.** `#000` ground, `#111` surface, `#2a2a2a` raised. No borders on resting cards, no shadows, no glass.
5. **Every press answers in under 160 ms.** Controls scale and fill on press; nothing waits for a network round trip to look pressed.
6. **Plain words, sentence case.** No exclamation marks, no emoji, no "Oops", no tracked uppercase labels.
7. **State is never carried by colour alone.** A connected player also has a label and a shape; a pressed control also scales.

## Tokens

```css
:root {
  /* ground and elevation */
  --ground: #000000;
  --surface: #111111;
  --raised: #2a2a2a;
  --border: #1a1a1a;      /* structural rule only, never a card outline */
  --rule: #161616;
  --control: #444444;     /* interactive outline when one is needed */

  /* text */
  --text: #ffffff;
  --muted: #b4b4b4;
  --faint: #949494;

  /* signal */
  --accent: #c6f24e;      /* live input, connected state, focus ring */
  --positive: #c6f24e;
  --negative: #e5484d;
  --warning: #e5a93b;

  /* player identity — eight hues, at least 60° apart, readable on #000 */
  --player-1: #4cb3f0;
  --player-2: #ff9f45;
  --player-3: #c58cff;
  --player-4: #4fd1a1;
  --player-5: #ff7aa8;
  --player-6: #f2d05c;
  --player-7: #8fb8ff;
  --player-8: #ff6b6b;

  /* shape */
  --radius-card: 20px;
  --radius-control: 999px;
  --radius-field: 14px;

  /* spacing — 4px base */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;
  --space-7: 48px;
  --space-8: 64px;

  /* motion */
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
  --dur-press: 120ms;
  --dur-state: 160ms;
  --dur-enter: 220ms;
  --dur-panel: 280ms;
}
```

**Host scale** (10-foot, 1080p baseline):

```css
:root {
  --host-title: 64px;
  --host-subtitle: 32px;
  --host-body: 24px;
  --host-meta: 18px;
  --host-code: 120px;
  --host-pin: 48px;
  --host-action: 28px;
  --host-gap: 24px;
  --host-pad: 40px;
  --host-target: 64px;
}
```

**Phone scale** (thumb-first, 390px baseline):

```css
:root {
  --phone-title: 24px;
  --phone-body: 16px;
  --phone-meta: 13px;
  --phone-control-label: 16px;
  --phone-gap: 12px;
  --phone-pad: 16px;
  --phone-target: 48px;   /* never below 44px */
}
```

## Type

One family: **Inter**, falling back to `system-ui, sans-serif`. Weights 400, 500, 600; never 700 on the host, never above 600 on the phone.

| Role | Host | Phone | Weight | Notes |
| --- | --- | --- | --- | --- |
| Screen title | `--host-title` | `--phone-title` | 600 | Sentence case, tracking −0.02em |
| Section / card title | `--host-subtitle` | 18px | 500 | |
| Body | `--host-body` | `--phone-body` | 400 | Line height 1.45 |
| Meta / status | `--host-meta` | `--phone-meta` | 400 | `--muted` |
| Room code | `--host-code` | 32px | 600 | Tabular figures, tracking 0.08em |
| PIN | `--host-pin` | 24px | 500 | Tabular figures |
| Action label | `--host-action` | 18px | 500 | |

Numbers that update (packet rate, RTT, scores, timer) use `font-variant-numeric: tabular-nums`. Text never drops below 12px on the phone or 16px on the host.

## Colour use

| Role | Host | Phone |
| --- | --- | --- |
| Ground | `--ground` full-bleed | `--ground` |
| Cards / control surfaces | `--surface` | `--surface` |
| Raised (sheet, pressed control) | `--raised` | `--raised` |
| Live input / connected | `--accent` fill or 3px mark | `--accent` fill on the pressed control |
| Player identity | Swatch + number in the slot row | 2px edge + label in the layout, if the game sets one |
| Primary action | Inverted: white fill, black label | Inverted white pill |
| Secondary action | `--surface` with `--control` outline | Same |
| Danger | `--negative` text/icon only, never a full red panel | Same |
| Warning | `--warning` icon + text | Same |

Accent never fills a host button, tab or navigation item. On the controller it may fill a control **while it is being pressed**, because that is live input — the one piece of data the surface exists to show.

## Elevation and edges

- Resting cards: `--surface` on `--ground`, **no border, no shadow**.
- Nested elements (a field inside a card): `--raised` or a 1px `--border` rule, never both.
- Rules are for lists and section splits only; a card does not get an outline.
- No gradients anywhere. No glow. No backdrop blur. No glass.
- The one exception for a shadow is a phone sheet that floats over the control surface: `0 12px 28px rgb(0 0 0 / 0.35)`.

## Focus and input

**Host (remote).** One focus ring: 3px `--accent`, 2px offset, `border-radius: inherit`. Focus moves **instantly** — no transition, no scale, no fade, because remote navigation is a keyboard action repeated constantly. The ring must survive on any background; if it sits on a light game frame, add a 2px `--ground` outer ring.

**Phone.** `:focus-visible` exists for external keyboards and switch access; touch interactions do not show a ring. Every control captures the pointer so a thumb can slide off without dropping the press.

**Press.** `transform: scale(0.97)` over `--dur-press` with `--ease-out`; fill change over 80ms. Release returns over `--dur-press`. No animation on submit of the join form beyond the state change itself.

## Motion

| Event | Duration | Easing | Purpose |
| --- | --- | --- | --- |
| Control press / release | 120 ms | `--ease-out` | Feedback |
| Connection pill state change | 160 ms | `--ease-out` | State indication |
| Reconnect banner in | 220 ms | `--ease-out` | Prevent a jarring appearance |
| Reconnect banner out | 160 ms | `--ease-out` | Exit is faster than entry |
| Phone sheet (panel) | 280 ms | `--ease-out` | Spatial consistency |
| Host results panel | 220 ms | `--ease-out` | Prevent a jarring change |
| Host game launch | 220 ms | `--ease-out` | Once per game, not per frame |

Rules:

- Nothing animates on remote focus movement or on keyboard actions.
- Nothing enters from `scale(0)`; use `scale(0.95)` + opacity when an entrance is needed.
- Only `transform`, `opacity` and `filter` animate. Never `width`, `height`, `top` or `left`.
- Use transitions, not keyframes, for anything that can be interrupted (reconnect, sheets).
- `prefers-reduced-motion: reduce` removes movement and keeps opacity/colour feedback.
- No entrance animation on any app screen; motion is feedback, not theatre.

## Component primitives

### Host

| Component | Spec |
| --- | --- |
| **Stage** | Full-bleed `--ground`; the game canvas is the largest element. Chrome sits above and below, never over the play area except a HUD the game opts into. |
| **Top bar** | 64px, `--ground`, 1px `--rule` bottom. Wordmark left at 28px/600; room chip right (`ABCD · PIN 1234`) at `--host-meta`, tabular. No navigation. |
| **Room code block** | `--host-code`, lime only when the room is live; `--faint` while creating. Code and PIN on one line, PIN one step smaller. |
| **QR card** | `--surface`, `--radius-card`, 20px padding. QR 320 CSS px, caption `--muted`. Fallback text replaces the QR, never the code. |
| **Slot row** | 80px, `--surface`, radius 20px, 16px padding. Player number in the player hue, 20px swatch, state label (`Connected`, `Waiting`, `Reconnecting`) in `--muted`; no borders. |
| **Game card** | `--surface`, radius 20px, 24px padding, title 32px/600, players line `--muted`, one-line description `--muted`. The whole card is the target; focus ring around the card. |
| **Primary action** | Inverted pill: `--text` fill, `--ground` label, 56px tall, 32px horizontal padding, `--radius-control`. One per screen. |
| **Secondary action** | `--surface` fill, 1px `--control` outline, `--text` label, same height as primary. |
| **Notice panel** | Centred, max 720px, `--surface`, radius 20px, 32px padding. Title 40px/600, message `--host-body`, one action. Used for renderer failure, room expiry, host lost. |
| **Results panel** | `--surface`, radius 20px, centred; title 48px/600, one line per player, the winner in `--accent` text (not a fill). |
| **Focus ring** | 3px `--accent`, 2px offset, instant. |

### Phone

| Component | Spec |
| --- | --- |
| **Status pill** | 36px tall, `--surface`, radius 999, `--muted` label with a 8px dot. Dot is `--accent` when connected, `--warning` when reconnecting, `--negative` when lost. |
| **Join form** | Full-height `--ground`, 16px pad, title 24px/600. Two field groups, 16px apart, 48px inputs, `--radius-field`, `--surface` fill with a 1px `--control` border. Join button 56px, inverted. |
| **Code field** | 56px, 32px/600, tabular, letter-spaced 0.08em, centred, uppercase input. Four characters. |
| **PIN field** | 56px, 24px/500, tabular, centred. Four digits. |
| **Error line** | 16px `--negative`, below the fields, `role="alert"`, no red panel. |
| **Haptics toggle** | 44px pill, `--surface`, label `Haptics on` / `Haptics off`, 8px dot `--accent` when on. |
| **Control surface** | Full-viewport grid, `--ground`, safe-area insets, `--phone-gap` between controls. No scrolling. |
| **Panel sheet** | Bottom sheet, `--surface`, radius 20px 20px 0 0, drag handle, max 70vh, scrolls internally. Closes on downward flick or a 44px close target. |
| **Reconnect banner** | 44px strip under the status pill, `--surface`, `--warning` dot, text `Reconnecting…`. Controls stay visible and pressable underneath. |
| **Permission card** | `--surface`, radius 20px, 20px padding, title 18px/500, body 16px, one 48px action. Used for iOS motion access. |

## Control design language (all 11 types)

Every control shares one grammar so a player can move between games without relearning:

- **Surface:** `--surface` fill, no border, `--radius-control` (pill) for round/segment controls, `--radius-card` for pads and panels.
- **Label:** `--phone-control-label`, `--muted` at rest, `--ground` when active on the lime fill.
- **Rest:** no shadow, no outline. Shape alone defines the target.
- **Pressed:** fill `--accent`, label `--ground`, `scale(0.97)`, 80–120 ms.
- **Disabled:** fill `--surface`, label `--control`; never remove the label.
- **Unavailable (gyro denied):** `--surface`, label `--faint`, plus a one-line reason and a fallback control.
- **Identity:** if the layout assigns a player hue, a 2px edge uses it; the fill stays neutral so the accent still means "pressed".
- **Hit area:** at least `--phone-target`; visually smaller shapes may sit inside a larger invisible target.

| Type | Shape | Pressed expression | Mapping shown to the player |
| --- | --- | --- | --- |
| `button` | Pill (999) | Lime fill, scale | Label + the action it fires |
| `dpad` | Cross of four pill segments | Segment fills lime | Four arrows; diagonals allowed only if the layout says so |
| `stick` | Circle with a 32px thumb | Thumb follows, ring brightens | Continuous 2-axis value; deadzone 8% |
| `trigger` | Vertical rounded bar | Fill rises with the pull | 0–100% travel |
| `touchpad` | Rounded rect (20px) | Touch point marker + trail | Free 2D position / strokes |
| `slider` | Horizontal pill track | Handle and track fill | 0–100% with the value shown at the thumb |
| `gyro` | Card with a level bubble | Bubble tracks tilt; recenter action | Tilt in degrees, plus a recenter target |
| `choice` | Row of pill chips | Selected chip inverts to white; pressed uses lime | One of N options, label visible |
| `panel` | Card (20px) | Not pressable | Private text the host never sees |
| `text` | Field + system keyboard | Focus ring on the field | Free text, `inputmode` from the layout |
| `canvas` | Card with a drawing area | Stroke trail | Free drawing; strokes batch |

## Accessibility

- Minimum touch target 44px; the design uses 48px on the phone and 64px on the host.
- Text contrast: `--text` on `--ground` is 21:1; `--muted` 9.8:1; `--faint` 6.1:1. Never place text on `--accent` below 16px.
- State is never colour-only: connected has a dot **and** a word; pressed has a fill **and** a scale.
- The host is fully operable with Arrow keys, Enter, Space and the TV remote's OK/Select.
- `prefers-reduced-motion` keeps colour/opacity feedback and removes travel.
- Safe-area insets on the phone: `env(safe-area-inset-*)` on the control surface and the sheet.
- Landscape is the default play orientation; portrait must still lay out without clipping or scroll.

## Anti-patterns (banned)

Gradients, glows, glass, backdrop blur, emoji, tracked uppercase labels, icon-in-tinted-square cards, rows of identical feature cards, shadows on resting surfaces, `transition: all`, `scale(0)` entrances, animations on remote focus, colour-only state, placeholder copy ("Item 1", "Lorem"), and any accent on host chrome.
