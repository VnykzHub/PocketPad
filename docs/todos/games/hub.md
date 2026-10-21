# Hub (not a game, but required)

| Field | Value |
|---|---|
| Stage | D7 minimal launcher; P6 full hub |
| Spec | `SPEC.md` §17.5, §9.13 |
| Capabilities | Layouts/events, manifests, no game simulation |
| Goals | G1, G6, G8; the front door to the catalog |
| Depends on | D7-SDK-01, D4-HOST-01, D5 layouts/events |
| Work-item prefix | `HUB-*` (stage items: D7-HUB-01, P6-HUB-01/02) |

## Minimal (v1 acceptance)

**Contract**

- The host opens on a hub, not straight into a game.
- TV menu lists every registered game with name, player count and a gyro badge.
- Remote arrow keys + Enter navigate and launch (AR-4).
- P1 phone can pick a game from a `choice` layout; the TV highlights the pick.
- Lobby shows joined players/slots, the room code, PIN and QR.
- Launching mounts the game via `GameHost`; returning disposes it and returns to the hub.
- No voting/catalog thumbnails in Minimal (P6).
- No game-specific code in the hub; everything comes from manifests.

**Host work items**

- [ ] `HUB-MIN-01` — Hub state machine: `lobby ↔ picker ↔ launching ↔ game`; focus/selection state; no reloads.
- [ ] `HUB-MIN-02` — Game list from `getGames()`; text cards; arrow/Enter; visible focus.
- [ ] `HUB-MIN-03` — P1 picker: send a `choice` layout with game names to slot 1; handle the event; remote override.
- [ ] `HUB-MIN-04` — Lobby: join/leave/suspend/resume events; slot list; QR/code/PIN panel.
- [ ] `HUB-MIN-05` — Launch/dispose: load manifests, start/stop games, restore hub; no leaked timers/audio.
- [ ] `HUB-MIN-06` — Empty state: "waiting for players" and a clear "scan to join" prompt.

**Controller work**

- [ ] `HUB-CTRL-01` — Picker layout uses the `choice` control; one pick; lock after submit.
- [ ] `HUB-CTRL-02` — Lobby shows "waiting for the TV to start" and your slot.
- [ ] `HUB-CTRL-03` — Game-specific layouts replace the picker after launch (D5 hot-swap).

**Tests / acceptance**

- [ ] `[AR-4]` Hub is fully remote-operable.
- [ ] `[FR-9.13]` P1 can pick a game; the TV launches it.
- [ ] `[G8]` Adding a game folder adds a hub card with no code change.
- [ ] `[FR-8.10]` Gyro games are labelled; fallback is noted.
- [ ] Returning from every proof game works repeatedly.

## Full hub (P6)

**Contract**

- Phone voting: all players get a `choice` layout of games; live tally; winner launched; tie rule.
- Catalog: thumbnails, descriptions, player counts, categories, recent games.
- Per-game settings: manifest extension, validated; passed to the game via context.
- Family-friendly toggle and accessibility toggles (haptics, reduced motion), persisted locally.
- Recent games stored on the host only; no accounts.
- All images licensed and budgeted.

**Work items**

- [ ] `HUB-FULL-01` — Voting with live tally and tie rule.
- [ ] `HUB-FULL-02` — Catalog with thumbnails/descriptions/categories, lazy-loaded.
- [ ] `HUB-FULL-03` — Per-game settings extension + validation + UI.
- [ ] `HUB-FULL-04` — Recent games (host localStorage), continue/remove.
- [ ] `HUB-FULL-05` — Family filter and accessibility toggles wired to P3/D6.
- [ ] `HUB-FULL-06` — 8-player, 10+ game catalog usability pass.

**Tests**

- [ ] `[FR-9.13]` phone voting/catalog work.
- [ ] `[SR-13]` family toggle affects UGC.
- [ ] `[AR-3]` accessibility toggles persist.
- [ ] `[G3]` catalog assets within budget.

## Anti-rework

- The hub reads the registry; no hard-coded game list.
- Pick/vote use the existing layout/event path; no new protocol.
- The hub is a host UI; games do not render the hub.
- Full hub extends Minimal; no second menu shell.

## Risks / watch-outs

- **TV remote UX:** focus must be obvious; test arrow/Enter on the actual TV.
- **P1 disconnect:** remote override or re-prompt; do not block the lobby.
- **Catalog size:** thumbnails can blow the bundle; lazy-load and budget.
- **Settings sprawl:** only manifest-declared settings; no bespoke host forms.
- **Voting latency:** low-rate events; do not poll.

## Acceptance checklist

- [ ] Minimal hub playable with 2–8 players.
- [ ] Remote and P1 pick both work.
- [ ] Lobby/QR/slots correct.
- [ ] Full hub voting/catalog/settings/toggles pass (P6).
- [ ] No game-specific hub code.
- [ ] Catalog assets within budget.
