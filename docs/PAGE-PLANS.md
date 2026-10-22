# PocketPad Page Plans

**Status: DRAFT — awaiting sign-off. No implementation has started.**
System: [`DESIGN.md`](../DESIGN.md). Product: [`PRODUCT.md`](../PRODUCT.md).
Direction: `true-black-flat`, seed `1080531052`, with the shell and type-scale redraws recorded in `DESIGN.md`.

---

## 0. How to read this

Every page has: **route / when**, **job** (the one question it answers), **composition**, **elements**, **states**, **copy**, **motion**, **acceptance**. Page IDs are stable and should be used in test names (`[HP-02]`, `[CP-08]`).

Host pages are `HP-*`; controller pages `CP-*`; per-game layouts `LP-*`. The input map is §7. The build order is §9.

**Screen baselines:** host 1920×1080 (design), 1280×720 (minimum), 1440×900 (laptop preview). Phone 390×844 portrait and 844×390 landscape. Nothing scrolls except a panel sheet's contents.

---

## 1. Route map

| Route / trigger | Page | Surface |
| --- | --- | --- |
| `/`, no room yet | HP-01 Boot & room creation | Host |
| `/`, room live, no game | HP-02 Lobby → HP-03 Launcher | Host |
| `/games/<slug>/` | HP-04 Stage | Host |
| Game asks for results | HP-05 Results overlay | Host |
| Socket drops | HP-06 Reconnect / resumed room | Host |
| Any failure | HP-07 Notices | Host |
| Always (aside) | HP-08 Player roster | Host |
| `?debug=1` | HP-09 Debug overlay | Host |
| `/c` or `/c/<CODE>` | CP-01 Join | Phone |
| Join submitted | CP-02 Connecting | Phone |
| Join failed | CP-03 Error / lockout | Phone |
| Connected, no layout | CP-04 Waiting | Phone |
| Layout received | CP-05 Playing shell + CP-07…CP-17 | Phone |
| Socket drops | CP-06 Reconnecting | Phone |
| `?debug=1` | CP-18 Debug overlay | Phone |
| Portrait with a landscape layout | CP-19 Orientation | Phone |

---

## 2. Host frame (applies to every HP page)

```
┌──────────────────────────────────────────────────────────────┐
│ lanpad                                    ABCD · PIN 1234  ● │  64px top bar
├──────────────────────────────────────────────────────────────┤
│                                                              │
│                         page content                         │
│                                                              │
└──────────────────────────────────────────────────────────────┘
  48px safe margin on all four sides; one left edge
```

- Background `--ground` full-bleed. No card wraps the page.
- Top bar 64px, 1px `--rule` bottom. Wordmark left at 28px/600; room chip right at 18px tabular. The chip is **hidden during the lobby** (the code is the hero there) and **appears during the stage**.
- Focus: exactly one ring (3px `--accent`, 2px offset, instant). Arrow keys move; Enter/Space/OK activate. No focus transition.
- No scroll. No hover states (TV remotes do not hover).
- Every page has one `h1` at `--host-title` or the page's stated hero size.
- During play the shell's room section and the raw input table are **not mounted**.

---

## 3. Host pages

### HP-01 — Boot & room creation

**When:** page load with no `sessionStorage` session, or "New room".
**Job:** "Is the room ready, and if not, why?"

```
                    lanpad
                    ──────
                 Starting PocketPad
              Creating a room for this TV

        [ failure state ]
                 Could not create a room
        Check that the dev server is running,
                 then try again.
                 [ Try again ]
```

- Centred column, max 720px, vertically centred.
- Status dot 8px: `--faint` while creating, `--negative` on failure, `--accent` on success (then immediately HP-02).
- No spinner, no indeterminate bar. Room creation is fast; a fake progress animation is noise.
- Failure is the only focusable thing: **Try again** (Enter). It retries `POST /api/rooms`.
- Copy: `Starting PocketPad`, `Creating a room for this TV`, `Could not create a room`, `Check that the dev server is running, then try again.`, `Try again`.
- Motion: text swap only, 160ms opacity.
- **Acceptance:** a failure never leaves the screen without a focusable action; Enter retries; no code or PIN is shown until the room exists.

---

### HP-02 — Lobby

**When:** room created and host joined; assets may still be loading.
**Job:** "How do I join, and who is already here?"

```
┌──────────────────────────────────────────────────────────────┐
│ lanpad                                              ● Live   │
│                                                              │
│   ROOM CODE                    PLAYERS                       │
│   ┌──────────┐                 ┌──────────────────────────┐  │
│   │   B26A   │   120px         │ ● Player 1   Connected   │  │
│   └──────────┘                 │ ○ Player 2   Open        │  │
│   PIN 1596    48px             │ ○ Player 3   Open        │  │
│                                │ …                        │  │
│   ┌────────┐  ┌──────────────┐ │ ○ Player 8   Open        │  │
│   │  QR    │  │ Scan to join │ └──────────────────────────┘  │
│   │ 320px  │  │ or open /c   │                               │
│   └────────┘  └──────────────┘   [ Press Enter to start ]   │
│                                   Sound on.                  │
│   Anyone with this code can join. Only share it with        │
│   people in the room.                                        │
│   Or open http://192.168.29.98:8080/c and enter the code+PIN │
│                                                    New room  │
└──────────────────────────────────────────────────────────────┘
```

- 12-column grid: join block spans 7, roster spans 5. One 24px gutter.
- **One source for code and PIN.** Remove the duplicates from the shell header (`#room-code`, `#room-pin`) and from `StartScreen`; the hero is the only place they appear in the lobby.
- Code 120px/600, tabular, tracking 0.08em. PIN 48px/500.
- QR card: `--surface`, 20px radius, 320 CSS px, caption `--muted`. If QR fails, the caption becomes `QR unavailable: enter the code and PIN below.` and the code/PIN remain.
- Security notice: exact existing string, 18px `--muted`. Manual join line: exact existing string, 18px `--faint`.
- Roster: 8 rows × 80px; see HP-08.
- Primary action: the lobby's job ends at join. The game shelf (HP-03) is the next action; its focused card launches on Enter. The standalone **Press Enter to start** pill belongs to the `/games/<slug>/` start screen (`StartScreen`), not the lobby hero. While assets load, that game-route start screen shows `Loading game…` with a 480px progress bar.
- Audio line: 18px `--muted` + 8px dot. `Sound on.` / `Sound is off until you press Enter.` / `Audio unavailable — the game will run without sound.` No emoji.
- Secondary: **New room**, 44px text action at the bottom right of the join block. Focus order: Start → New room.
- **Behaviour change:** the lobby no longer shows the raw 8-row input table. It is debug-only.
- Motion: none on entry. Progress bar width is the only change.
- **Acceptance:** code and PIN appear exactly once; QR failure still allows manual join; the launcher is reachable with Enter; `New room` does not steal default focus; asset progress never blocks the join instructions.

---

### HP-03 — Launcher

**When:** room live, no game route, or Back from a stage.
**Job:** "What can we play?"

```
┌──────────────────────────────────────────────────────────────┐
│ lanpad                                    ABCD · 2 players  │
│                                                              │
│  Games                                                       │
│  ┌─────────────────────────┐  ┌─────────────────────────┐    │
│  │      ● ●                │  │        ◉                │    │
│  │      ● ●                │  │       ◉ ◉               │    │
│  │  Reaction Duel          │  │  Coin Run               │    │
│  │  1–8 players · 3 rounds │  │  1–4 players · 1 level  │    │
│  │  Match the signal.      │  │  Race for 20 coins.     │    │
│  │  2 connected            │  │  2 connected            │    │
│  └─────────────────────────┘  └─────────────────────────┘    │
│                                                              │
│  Players                                                     │
│  ● Player 1  Connected     ● Player 2  Connected            │
│  ○ Player 3  Open          ○ Player 4  Open                 │
└──────────────────────────────────────────────────────────────┘
```

- `h1` "Games" at 64px/600. Game shelf: two cards, 560×360, 24px gutter, `--surface`, 20px radius. Cards are the focus targets; the focused card gets the ring and lifts its title from `--muted` to `--text` (no scale — remote focus does not animate).
- Card content: a drawn motif (four dots for Reaction Duel; a coin for Coin Run) at 96px, title 40px/600, player range + round/level line at 18px `--muted`, one-line description at 20px, and the live connected count at 18px `--accent` when > 0.
- Arrow keys move between cards; Enter launches. No separate "Play" button.
- Player roster sits below as a compact 2-column list (4 rows each), 56px rows; it is not the hero.
- Empty state: "No games installed" at 40px + `Add a game package, then restart the host.` at 24px `--muted`. The frame stays.
- **Root route change:** `/` renders this launcher instead of silently loading Cube Demo. Cube Demo becomes an experiment page at `/x/` — **decision D1**.
- Motion: none; focus is instant.
- **Acceptance:** list comes from `getGames()`, not a hard-coded menu; unknown slug still shows HP-07; keyboard-only launch works; connected counts update without re-render flicker.

---

### HP-04 — Stage

**When:** a game is running.
**Job:** "The game owns the screen; the platform is a quiet frame."

```
┌──────────────────────────────────────────────────────────────┐
│ ABCD · 3 players                                     48px  │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│                    game canvas 16:9                          │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

- 48px bar: room chip left, player count right, 1px `--rule` bottom. No wordmark, no nav.
- Canvas fills the remaining viewport. **Render contract:** games draw in a design space (1280×720) that the platform scales to the actual canvas. No game may assume CSS pixels. This fixes the Coin Run and Reaction Duel clipping at ~1052×592.
- The lobby, roster, input table, start screen and notices do not mount during play.
- **Leave game:** remote Back / Escape opens HP-04b. No other remote key is intercepted.
- **Acceptance:** canvas has no document scroll; 16:9 letterboxing is centred; phone input is unaffected; Back opens the confirm overlay.

#### HP-04b — Leave confirm (overlay)

```
                 Leave the game?
        Phones stay connected to the room.
           [ Keep playing ]   [ Back to games ]
```

- 720px panel, 20px radius, 32px padding, flat 72% black scrim over the canvas (no blur).
- Default focus: **Keep playing**. Escape closes. Enter activates the focused action.
- Motion: 220ms scale 0.96→1 + opacity; exit 160ms.

---

### HP-05 — Results

**When:** a game reports a finished round or match.
**Job:** "Who won, and what happens now?"

```
                 ┌────────────────────────────────┐
                 │         Round over             │
                 │    Player 2 wins the match     │
                 │                                │
                 │  ● Player 1            12      │
                 │  ● Player 2            18  WIN │
                 │  ● Player 3             9      │
                 │                                │
                 │      [ Play again ]            │
                 │      [ Back to games ]         │
                 └────────────────────────────────┘
```

- Platform-owned overlay over a dimmed canvas; 900px panel, `--surface`, 20px radius, 48px padding.
- Title 56px/600; subtitle 32px `--muted`.
- Rows: 72px, player swatch 20px, label 24px, value 24px tabular right-aligned; winner row gets the word `WIN` in `--accent` **and** the value in `--text` (not colour alone).
- Primary **Play again** (inverted); secondary **Back to games** (outlined). Focus order: Play again → Back to games.
- Data contract (host-side): `{ title, subtitle?, rows: [{ slot, label, value, winner? }], rematch: boolean }`.
- Motion: 220ms scale 0.96→1 + opacity; exit 160ms. Nothing animates when the remote moves focus.
- **Acceptance:** the game supplies all copy and values; the platform never invents a score; focus is trapped; Enter on Play again restarts without reload.

---

### HP-06 — Reconnect & resumed room

**Host reconnecting:** a 48px banner directly under the top bar, `--surface`, 8px `--warning` dot, text `Reconnecting to the room… The game is paused.` The canvas stays visible and paused; no scrim, no full-screen error. When the socket returns, the banner removes over 160ms.

**Resumed room** (host reloaded, `{code, hostToken}` survived):
- Lobby shows the code only. PIN is `PIN ----` per the existing capability limit; QR is hidden, never stale.
- Replace the QR with the existing explanatory line: `Room resumed — phones already connected stay in the game.`
- Start remains available once assets are ready.
- **Acceptance:** no stale QR is rendered; a resumed room never claims a PIN it does not have; the reconnecting banner never covers the game's HUD (it sits above the canvas, not over it).

---

### HP-07 — Notices

**When:** renderer unavailable, game stopped, room ended, removed from room.
**Job:** "What happened, and what is the one thing I can do?"

```
                    ┌──────────────────────┐
                    │   The game stopped   │
                    │   <message>          │
                    │   • hint             │
                    │   • hint             │
                    │      [ Reload ]      │
                    └──────────────────────┘
```

- Centred 720px panel, `--surface`, 20px radius, 32px padding, `role="alert"`.
- Title 40px/600; message 24px; hints 18px `--muted` as a real list; one action.
- Notice types and copy: keep the existing strings from `RendererFallbackNotice` and the fatal/room-lost paths. The design changes layout, not wording.
- One primary action per notice. `Reload` and `Create a new room` are the only two actions that exist.
- Motion: 220ms opacity; no scale on a failure.
- **Acceptance:** every notice is keyboard-dismissible with its one action; no token or room secret appears in any message; focus is on the action.

---

### HP-08 — Player roster

**When:** lobby and launcher (not during play).
**Job:** "Who is connected, and in which slot?"

- 8 rows, 80px, `--surface`, 20px radius, 16px padding, 8px gap.
- Connected: 20px player-hue swatch, `Player N` at 24px, `Connected` at 18px `--muted`, and a 2px `--accent` left mark (shape + colour).
- Reconnecting: swatch, `Player N`, `Reconnecting` with an 8px `--warning` dot.
- Open: hollow 20px ring `--control`, `Player N` at 24px `--faint`, `Open` at 18px `--faint`.
- No raw hex, axis or packet values in player mode. Those belong to HP-09.
- **Acceptance:** states update from `hostStats` without layout shift; no row shows a button or a control the host cannot use.

---

### HP-09 — Debug overlay (dev only)

- `?debug=1` only; `d` toggles. Never shown in acceptance screenshots.
- Top-right, 46ch, `--surface` at 90%, 12px radius, 14px Inter tabular numbers (not monospace; the real-code exception does not apply to numbers).
- Rows: backend, FPS, frame ms mean/p50/p95, sim ticks/s, draw calls, texture MB, per-slot RTT/packets/drops/tick.
- **Acceptance:** no token or room token ever appears; overlay is absent without the flag.

---

## 4. Controller frame (applies to every CP page)

```
┌──────────────────────────────┐
│ [● Connected (P2)]  [Haptics]│  44px, safe-area top
│                              │
│          control area        │  fills the rest
│                              │
└──────────────────────────────┘
   env(safe-area-inset-*) on all sides; no scrolling
```

- Background `--ground`; controls from the layout are absolutely positioned in the control area.
- Top bar 44px: 36px status pill left, 44px haptics pill right. `pointer-events: none` on the bar except the haptics button.
- The play surface reserves a 52px top inset so no control sits under the pill.
- No text smaller than 12px; every target ≥44px (the design uses 48px).
- Landscape is the default for play; portrait is supported for portrait layouts or shows CP-19.
- Haptics toggle: 44px, `--surface`, label `Haptics on`/`Haptics off`, 8px dot `--accent` when on. It never covers a control.

---

## 5. Controller pages

### CP-01 — Join

**Job:** "Get me into the room with the fewest keystrokes."

```
              Join a room
        ┌────────────────────┐
        │       B26A         │  56px, 32px/600, centred
        └────────────────────┘
        ┌────────────────────┐
        │      1596          │  56px, 24px/500, centred
        └────────────────────┘
        (error line, when present)
        ┌────────────────────┐
        │       Join         │  56px, inverted
        └────────────────────┘
```

- Title 24px/600. Fields 56px, `--surface`, 14px radius, 1px `--control`. Code: uppercase, `letter-spacing: 0.08em`, `autocapitalize=characters`. PIN: `inputmode=numeric`, `letter-spacing: 0.5em`.
- Auto-advance: a complete 4-character code moves focus to the PIN. It does **not** auto-submit.
- URL code prefill focuses the PIN.
- Join button disabled only while connecting or locked out; disabled stays legible and says why.
- Error line 16px `--negative`, `role="alert"`, below the fields.
- Motion: none; field focus ring appears instantly.
- **Acceptance:** 44px+ targets; PIN opens the numeric keyboard; code is never truncated or lowercased; error is announced; no layout shift when an error appears.

### CP-02 — Connecting

- Same form. Join disabled, label `Joining…`; fields readable but not editable.
- Status pill amber: `Connecting`.
- No spinner. The label is the state.
- **Acceptance:** tapping Join twice cannot send two joins; the form returns fully if the join is refused.

### CP-03 — Join error / lockout

- Error line below the fields; PIN focused and selected; code preserved.
- Lockout: Join disabled with `Try again in 12s`; the countdown updates once per second, no animation.
- Copy: keep the existing `joinFlow` strings; this plan changes placement only.
- **Acceptance:** lockout countdown ends and re-enables the button without a reload; error is not a red panel.

### CP-04 — Waiting (connected, no layout)

```
              Player 2
        Connected. Waiting for the game to start.
              Room B26A · PIN 1596

              [ Haptics on ]  (top bar)
```

- `Player N` at 24px/600; state line 16px `--muted`; room code and PIN at 16px tabular `--faint`.
- A large `--surface` panel (60% height) with the player's swatch and `Connected` is the visual anchor; it contains no controls.
- **Behaviour change:** the D0 **Test** button is removed from the normal waiting page. It remains available only with `?debug=1`.
- **Acceptance:** a fresh phone never sees a "Test" control; a layout arriving replaces this page without a reload.

### CP-05 — Playing shell

- Full-viewport control area; layout `background` or `--ground`.
- Controls absolutely positioned from the layout's x/y; the platform never reflows them.
- Status pill top-left, haptics top-right, both above the controls, with a 52px reserved top inset.
- Reconnect banner inserts under the top bar (CP-06) and shifts nothing.
- **Acceptance:** no scrolling in any orientation; all controls inside safe areas; a control at 100%/100% is still fully tappable.

### CP-06 — Reconnecting / host lost

- Controls stay visible and pressable (existing product truth: presses are latched).
- Banner 44px, `--surface`, `--warning` dot, `Reconnecting…`; controls keep full contrast. Dimming would read as "disabled" and is wrong.
- Host paused: pill `Waiting for TV` (`--warning`); no banner (one message, not two).
- Host lost: pill `Disconnected` (`--negative`), controls removed, CP-01 returns with `Connection lost.`
- **Acceptance:** a press during reconnect still appears on the TV after rejoin; the banner never covers a control (it occupies the reserved inset).

### CP-07 — Control: `button`

- Shape: circle (`r`), rounded (16px) or square (4px) from the layout; default rounded.
- 18% of min(W,H) is a typical diameter; hit area clamps to ≥44px.
- Label 16px/500 centred; if the layout supplies a `symbol` and no label, render the symbol as a drawn glyph, not text. **Current gap:** `symbol` is validated but dropped.
- Rest `--surface`, label `--muted`; pressed `--accent` fill, `--ground` label, `scale(0.97)`; disabled `--surface`/`--control`.
- Mapping: `bit` 0–15 → `buttons |= 1 << bit`; no event.
- **Acceptance:** multi-touch presses OR together and release only when the last finger lifts; `aria-pressed` mirrors the fill; the press repaints before the network round trip.

### CP-08 — Control: `dpad`

- Cross of four pill wedges inside a circular hit area; 36% typical.
- Each wedge shows an arrow glyph (drawn, not an emoji) at 14px; the hub is a 24% circle.
- Rest: wedges `--surface`, glyph `--muted`. Pressed: wedge `--accent`, glyph `--ground`. Two adjacent wedges press for a diagonal.
- Deadzone: `max(6px, 12% of radius)` at the centre.
- Mapping: `bits.up/down/left/right` → four `buttons` bits; 8 sectors; diagonals OR two bits.
- **Acceptance:** drag across wedges reclassifies without lifting; the hub cancels; no unreachable diagonal; 44px minimum per wedge at the smallest supported size.

### CP-09 — Control: `stick`

- Base circle `--surface` with a 42% knob `--raised`; 40% typical; a 32px thumb.
- Four 2px ticks at the cardinal points, inside the ring, `--control`; a 4px centre dot.
- Floating mode: the base appears at the first touch point and stays for the gesture.
- Pressed: ring brightens to `--accent` at 40% opacity, knob follows the thumb (no scale — the knob is the feedback).
- Deadzone: layout `deadzone` 0–0.5, store applies 8% radial; the visual deadzone circle is shown at 18% opacity while pressing.
- Mapping: `axis` `left` → `lx/ly`, `right` → `rx/ry`; i16 wire, −1..1 after the host mapper.
- **Acceptance:** one finger owns the stick for the whole gesture; a second finger does not steal it; release returns the knob in 120ms; the knob never leaves the base.

### CP-10 — Control: `trigger`

- Vertical (default) or horizontal rounded bar, radius 10px, 18% wide.
- Rest: `--surface` track with a 2px `--control` edge; a small `LT`/`RT` label at the base.
- Pressed: `--accent` fill rises with the pull; a value readout (`62%`) appears 8px above the thumb for the first 600ms, then fades.
- Mapping: `channel` `lt`/`rt` → `triggers.lt/rt` 0..1 (u8 wire). Absolute position; bottom = 0 on a vertical trigger.
- **Acceptance:** the fill tracks the finger with no lag; releasing returns to 0; the readout never overlaps another control.

### CP-11 — Control: `slider`

- Horizontal (default) pill track, 999px radius, 12% tall; `LT`/`RT` label at the left.
- A 32px round thumb marks the value; the filled portion is `--accent`, the remainder `--surface`.
- `direction` reverses the mapping visually and in value.
- Mapping: `channel` `lt`/`rt` → `triggers` 0..1.
- **Acceptance:** the thumb is draggable from anywhere on the track; the value shown matches the emitted value; the track is at least 44px tall as a hit area even if the visible bar is thinner.

### CP-12 — Control: `touchpad`

- Rounded rect 20px, `--surface`; a 1px crosshair in both axes at 14% opacity; a 18% knob.
- Pressed: knob `--accent`, a 1px trail in `--accent` at 20% opacity; 2% centre snap.
- Mapping: absolute position → `rx/ry` −1..1 (i16 wire). Not a delta.
- **Acceptance:** resting a thumb at centre emits exactly 0,0; the knob does not jump on first touch; the full pad area is reachable.

### CP-13 — Control: `gyro`

- Card 168×44 (current shape) or the layout-defined size; a level bubble plus a `Recenter` target at the right.
- States and copy: `idle` → `Tap to enable motion`; `requesting` → `Allow motion…`; `granted` → live bubble; `denied` → `Motion blocked — use the buttons`; `no-data` → `No motion data`; `paused` → `Motion paused`; `insecure` → `Motion needs HTTPS`; `unsupported` → `No motion sensor`.
- Granted: bubble 20px `--accent` in a 64px ring, `--control` ring; the bubble tracks tilt at 1:1 with the integrated angle, clamped.
- Denied/unavailable: card `--surface`, label `--faint`, and a **text fallback is mandatory** — the layout validator already requires a non-gyro fallback; the UI must show it.
- Mapping: gx/gy/gz i16 dps×10 at 60Hz + flags bit 0 active, bit 1 recentered; host integrates to `tilt.angleX/angleY` ±30°.
- **Acceptance:** the permission prompt runs inside the tap gesture (iOS); denying never blocks play; the recenter action is 44px and sends flag bit 1 once.

### CP-14 — Control: `choice`

- A vertical list inside a 12px-radius card; rows 44px, 8px gaps, 18px labels.
- Selected: a 44px pill in `--text` with `--ground` text (inversion, not accent). Pressed: `--accent` for 80ms.
- More than 5 options: scroll inside the card with a visible 2px scrollbar (no gradient fade, per `DESIGN.md`); a `> 8px` drag scrolls instead of selecting.
- Mapping: emits `{ value }` at **high** priority on the event queue; local selection highlights immediately.
- **Acceptance:** a drag that scrolls never selects; the selected row is readable without colour; the list is keyboard-reachable for switch access.

### CP-15 — Control: `panel`

- Card 12px radius, `--surface`, 16px padding; a 24px header row with a lock glyph (drawn) and `Private` at 13px `--muted`.
- Content 16px `--text`, line height 1.45; scrolls internally with a scrollbar when taller than the card (no gradient fade, per `DESIGN.md`).
- Empty/invalid: `Panel content unavailable` at 16px `--faint`, centred; no broken frame.
- Mapping: none. Display only; content is addressed to this slot by the broker.
- **Acceptance:** content never appears on the host; text is `textContent` (no HTML); vertical drag scrolls without selecting.

### CP-16 — Control: `text`

- Field 48px, `--surface`, 14px radius, placeholder `Type here…` at `--faint`; a 44px **Send** button to the right, inverted when the field has content, outlined when empty.
- `maxLen` counter at 13px `--faint`, right-aligned above the field, only when > 40 characters.
- Blocked state (event rate limited): field border `--warning`, a 13px line `Slow down a moment.`; do not clear the text.
- Mapping: `{ value }` at **high** priority on Send; the system keyboard opens on tap.
- **Acceptance:** Send is 44px; the field is not covered by the keyboard (scroll the page only if unavoidable, and never the play surface); a blocked send keeps the draft.

### CP-17 — Control: `canvas`

- Card 12px radius, `--background` at 100%; a 1px `--control` inner border.
- Empty state: centred `Draw here` at 15px `--faint`, which disappears on the first stroke.
- Stroke: 6px `--accent` default, round caps; a 2px trail while drawing; `width` and `color` from the layout if present.
- Pressed: no scale (the card is large); the stroke is the feedback.
- Mapping: batches `{ points, color, width, phase }` at **low** priority; `maxStrokePoints` from the layout.
- **Acceptance:** one stroke at a time; no dropped points at 60Hz; the canvas backs at DPR ≤2; the empty state does not block the first stroke.

### CP-18 — Debug overlay (dev only)

- `?debug=1` or triple-tap the top-left 64px corner. Restyle with tokens; 13px tabular Inter; green is **not** used (it would read as "connected").
- RTT, packets/s, last send age, script ms, layout id, slot, host status.
- **Acceptance:** absent without the flag; no token or PIN.

### CP-19 — Orientation

**When:** a `landscape` layout arrives while the phone is in portrait.
**Job:** "Turn the phone."

```
                 ┌──────────┐
                 │   ▭ →    │
                 └──────────┘
              Turn your phone sideways
           Coin Run uses the whole screen
```

- Full-screen `--ground`, centred; drawn rotate glyph 64px; title 24px/600; body 16px `--muted`.
- The status pill remains visible. Controls are not mounted until orientation matches.
- No forced fullscreen request, no orientation lock API.
- **Acceptance:** rotating resolves the screen without a reload; a portrait-capable layout never shows this page.

---

## 6. Control inventory → design deltas

Every renderer currently emits `.control` and `.control-<type>` with **no CSS rules**; all visuals are inline rgba/opacity values. The implementation replaces those with the token classes in `DESIGN.md` §"Control design language".

| Type | Must add | Must remove |
| --- | --- | --- |
| button | symbol/icon rendering, pressed fill, disabled | inline rgba backgrounds |
| dpad | arrow glyphs, hub, diagonal cue | per-wedge inline opacities |
| stick | cardinal ticks, deadzone ring, floating-base cue | inline knob opacity |
| trigger | label, value readout, idle track | inline fill colour |
| slider | thumb, label, tick marks | inline fill colour |
| touchpad | second crosshair axis, label, bounds | pre-inverted store curve is internal; keep behaviour |
| gyro | permission rationale card, fallback emphasis, recenter target | dashed pill as the only state |
| choice | selection inversion, scroll fade, scrollbar | selection bar opacity |
| panel | header/chrome, scroll affordance, invalid state | placeholder as the only state |
| text | placeholder, counter, blocked state | Send scale-only feedback |
| canvas | empty state, ink colour/size from layout | black .25 inline background |

---

## 7. Input map (layout → wire → game)

| Layout field | Controller renderer | `ControllerState` / `GameControllerState` | Units on the wire | Game sees |
| --- | --- | --- | --- | --- |
| `button.bit` 0–15 | button | `buttons` bit | u16 bitfield | `players[i].buttons & (1 << bit)` |
| `dpad.bits.{up,down,left,right}` | dpad | four `buttons` bits | u16 | same, four masks |
| `stick.axis: left` + x/y | stick | `lx`, `ly` | i16 −32768..32767 → −1..1 | `players[i].lx/ly` |
| `stick.axis: right` + x/y | stick | `rx`, `ry` | i16 → −1..1 | `players[i].rx/ry` |
| `trigger.channel: lt` | trigger | `triggers.lt` | u8 0..255 → 0..1 | `players[i].triggers.lt` |
| `trigger.channel: rt` | trigger | `triggers.rt` | u8 → 0..1 | `players[i].triggers.rt` |
| `slider.channel` | slider | same as trigger | u8 → 0..1 | `triggers.lt/rt` |
| `touchpad` x/y | touchpad | `rx`, `ry` absolute | i16 → −1..1 | `players[i].rx/ry` |
| `gyro` | gyro | `gyro.{x,y,z}` + `gyroActive` + `gyroRecentered` | i16 dps×10 | `gyro`, `tilt.angleX/angleY`, flags |
| `choice.event` | choice | — (event queue) | JSON `{ value }` | `context.events.on(name)` |
| `text.event` | text | — (event queue) | JSON `{ value }` | `context.events.on(name)` |
| `canvas.event` | canvas | — (event queue) | JSON stroke batch | `context.events.on(name)` |
| `panel` | panel | — (display only) | JSON to one slot | not visible to the game |

**Edges vs levels:** buttons are level state plus OR-accumulated `edges`; `pollAll()` clears edges once per simulation tick. A sub-tick tap must survive to the next tick — the design must never introduce a state that samples input at a different rate.

**Priority:** choice and text are high (never dropped); canvas strokes are low (batched, droppable under pressure); input packets are their own binary path and are not affected by the event queue.

---

## 8. Shipped game layouts

### LP-01 — Reaction Duel four-button (`rd-four-button-v1`)

```
        ┌──────────────────────────┐
        │                          │
        │    ( A )        ( B )    │   25%,30%      75%,30%
        │     ▲            ●       │   bits 0,1
        │                          │
        │    ( X )        ( Y )    │   25%,70%      75%,70%
        │     ✕            ■       │   bits 2,3
        │                          │
        └──────────────────────────┘
```

- Four rounded buttons, r 18%, 2×2 grid, `background #101014`.
- Labels `A`, `B`, `X`, `Y` with `▲ ● ✕ ■` glyphs; the glyph is the primary mark, the letter the secondary.
- Bits 0–3 map to the game's four signals. No diagonal, no stick.
- Visual: neutral surfaces; the pressed button is the only lime on the phone. Player hue edge if the room gives one.
- **Acceptance:** all four buttons reachable with two thumbs; no button overlaps the status pill; a press during countdown still registers.

### LP-02 — Coin Run d-pad (`pf-dpad-v1`, landscape)

```
        ┌──────────────────────────┐
        │                          │
        │                          │
        │      ┌────┐              │
        │      │ ◀  │         (↑)  │   dpad 36% @ 18%,66%   jump 16% @ 84%,68%
        │   ┌──┼────┼──┐       JUMP │   bits 10/8/11/9       bit 0
        │   │▲ │ 12 │▶ │            │
        │   └──┼────┼──┘            │
        │      │ ▼  │               │
        │      └────┘               │
        └──────────────────────────┘
```

- D-pad 36% at (18%, 66%), bits up 8 / down 9 / left 10 / right 11.
- Jump circle 16% at (84%, 68%), bit 0, label `Jump` + an up-arrow glyph.
- Landscape only; portrait shows CP-19.
- **Acceptance:** left thumb reaches all four directions without covering the jump; the d-pad's diagonal press emits two bits; jump is edge-triggered by the game (`edges`), not a level check.

### LP-03 — Coin Run stick (`pf-stick-v1`, landscape)

```
        ┌──────────────────────────┐
        │                          │
        │        (stick ring)      │
        │          ◎               │   stick 40% @ 18%,66%, axis left
        │      MOVE                │
        │                    (↑)   │   jump 16% @ 84%,68%, bit 0
        │                   JUMP   │
        └──────────────────────────┘
```

- Floating stick 40% at (18%, 66%), axis `left`; jump 16% at (84%, 68%), bit 0.
- The stick shows `MOVE` under the ring at 13px `--faint`; the jump shows `JUMP`.
- **Acceptance:** the floating base appears where the thumb lands; a 20% tilt produces movement (deadzone 8%); jump remains edge-triggered.

---

## 9. Build order (UI only)

Serial across waves; one writer per file. Each wave ends with `npm run check`.

| Wave | Work | Files (one writer each) | Depends on |
| --- | --- | --- | --- |
| **W1 — Host system** | Tokens, host frame, HP-01, HP-02, HP-07, HP-08 | `packages/runtime/index.html`, `src/style.css`, `src/ui/StartScreen.ts`, `src/ui/RoomPanel.ts`, `src/ui/HostStatus.ts`, new `src/ui/Notice.ts`, new `src/ui/SlotRoster.ts` | DESIGN.md |
| **W2 — Host flow** | HP-03 launcher, HP-04 stage frame, HP-04b confirm, HP-05 results, HP-06 reconnect, root routing | `src/main.ts`, `src/ui/Launcher.ts` (new), `src/ui/ResultsOverlay.ts` (new), `src/ui/LeaveConfirm.ts` (new), `src/game/registry.ts` usage, tests | W1 |
| **W3 — Controller shell** | Tokens, CP-01…CP-06, CP-19, safe areas, `styles.css` control classes | `packages/controller/index.html`, `src/styles.css`, `src/main.ts`, `src/net/ConnectionPill.ts`, new `src/ui/Toggle.ts` | DESIGN.md |
| **W4 — Controls** | CP-07…CP-17; strip inline styles, add tokens, symbols, labels, states | `src/controls/*.ts` (one file per writer), `src/controls/control.ts` | W3 |
| **W5 — Layouts & stitch** | LP-01…LP-03, host canvas scale contract, end-to-end | `packages/games/*/layouts/*.json`, `packages/runtime/src/render/*`, `packages/games/platformer/src/render.ts`, `packages/games/reaction-duel/src/game.ts`, integration tests | W2 + W4 |

**Not in this UI phase:** new game mechanics, new platform APIs beyond the results payload, Phase 2 hosting, a marketing page.

---

## 10. Acceptance for the whole pass

- `npm run check` green at every wave boundary; no test weakened.
- Controller bundle ≤ 40,960 gz dev. CSS additions are not counted; new TS must be offset by removing inline style code.
- Screenshots at 1920×1080, 1280×720, 390×844 and 844×390.
- 44px minimum targets on the phone; 64px on the host.
- Every host page fully operable with arrows + Enter.
- `prefers-reduced-motion` checked on the reconnect banner, results panel, leave confirm and panel sheet.
- No duplicate room code/PIN in the lobby; no raw input table during play.
- No token, PIN or room secret in any visible text, URL (except the QR fragment), log or screenshot.
- The platformer and Reaction Duel render correctly at the real canvas size (the render-space contract in W5).

---

## 11. Decisions to confirm before W1

| # | Decision | Recommendation |
| --- | --- | --- |
| D1 | What happens to Cube Demo when `/` becomes the launcher? | Move it to `/x/cube` as an experiment; keep `/games/<slug>/` for real games. |
| D2 | Is the platform allowed to own the results overlay (new host API), or do games keep drawing results? | Own it; games send a small results payload. It removes the copy/colour divergence. |
| D3 | Does the waiting page keep the Test button? | Debug-only (`?debug=1`). It is the "test page" a phone should never see. |
| D4 | Does Back leave a running game immediately or confirm first? | Confirm (HP-04b), default "Keep playing". |
| D5 | Are player hues fixed per slot (1–8) or assigned per room? | Fixed per slot, so a player keeps their colour across games and screens. |
