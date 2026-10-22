# PocketPad

A TV browser becomes a game console; phones become the controllers. No app install, no accounts, no pairing beyond a four-character code and a four-digit PIN.

## What it is

- A **host** page on the biggest screen in the room. It owns the simulation, renders the game, and shows who has joined.
- **Controllers** on phones. They send about 26 bytes of input per packet and receive a JSON layout describing the controls they should draw.
- A **local broker** that pairs rooms, assigns slots, relays input and private panels, and enforces the protocol limits.

## What it is not (v1)

- Not a cloud service. Phase 1 is one Node process on a LAN.
- Not an account system. No profiles, no login, no saved progress, no PII.
- Not a phone game. The phone renders controls, not the game.
- Not an app. iOS is out of v1 acceptance; feature-detect gyro and haptics and stay playable without them.

## Surfaces

| Surface | Distance / grip | What the person is doing | Design mode |
| --- | --- | --- | --- |
| Host TV | 2–4 m, remote or no input at all | Starts the room, shares the code, picks a game, watches and reacts | Operate, at 10-foot scale |
| Phone controller | Held in two hands, thumbs on glass, often in landscape | Joins in seconds, then plays without looking away from the TV | Operate, thumb-first |
| TV notices | 2–4 m | Recovers from a lost room, unsupported renderer, or expired session | Operate |

## People

- **The host.** Whoever holds the TV remote. May be technical or not. Opens a URL, presses one key, reads a four-character code aloud.
- **The players.** Two to eight people in the same room, mixed ages, holding phones they already know. They will not read instructions.
- **The spectator.** Someone waiting for a slot. Needs to see that the room is full and that waiting is expected.

## Jobs, in order of frequency

1. A player joins: open the URL, type four letters and four digits, land on a working controller.
2. A player plays: the controls for the current game appear without a reload; every press lands.
3. The host starts a game and sees the room state: who is connected, which slot is which, what to do next.
4. A player recovers: Wi-Fi blips, the phone locks, the host reloads. The slot survives and the controller comes back.
5. The host chooses what to play: a launcher that lists the games actually installed.

## Product truths the UI must express

- **One code, one room.** The code and PIN are the only pairing surface. The QR is a shortcut, never the only path.
- **Eight slots.** Player identity is a number and a colour, not a name.
- **The phone is a controller, not a second screen.** Control surfaces are large, stable, and never scroll under a thumb.
- **The TV is read, not touched.** Every host action must work with a five-key remote: arrows and Enter.
- **Connection is state, not an error.** Reconnecting is normal; the UI keeps the controls alive and says so quietly.
- **Private information stays private.** Panels are addressed to one slot; nothing private is ever drawn on the host.
- **No dark patterns, no noise.** No sound before a user gesture, no autoplay, no notification permission, no analytics.

## Voice

Plain, present tense, sentence case. Say what happened and what to do next. No exclamation marks, no "Oops", no emoji. Use the same noun for the same thing everywhere: **room**, **code**, **PIN**, **player**, **controller**, **host**.

## Success measures

- Join completes in under 5 seconds on a phone, from URL to controls.
- Every touch target is at least 44 CSS px; the controller bundle stays under 40 KB gz in dev.
- A person at 3 m can read the room code and the player list without leaning in.
- Input-to-canvas p95 stays under 25 ms on a LAN.
- No token, PIN, or room secret ever appears in a URL except the room token in the QR fragment.

## Boundaries of this design work

Phase 1, LAN only. The design covers the host and controller surfaces and the platform UI between games. It does not design a marketing site, a Phase 2 relay console, accounts, billing, or game content beyond the two shipped games.
