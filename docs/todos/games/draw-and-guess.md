# Game: Draw and Guess

| Field | Value |
|---|---|
| Stage | D7 (proof set) |
| Spec | `SPEC.md` §17.2 Draw and Guess |
| Capabilities | C3 private panel, C4 text/choice, C5 canvas strokes |
| Goals | G4 8 players, G5 private screens, G8 SDK proof |
| Depends on | D5 layouts/panels/events, D4 sessions, D7-SDK-01 |
| Work-item prefix | `GAME-DG-*` |

## Minimal (v1 acceptance)

**Gameplay contract**

- Players rotate as the drawer each round.
- The drawer sees a secret word on a private panel and draws on a canvas control.
- Strokes appear live on the TV for everyone.
- Other players type guesses; the first correct guess scores.
- Fixed word list, 3 rounds, then a winner.
- Guess normalization: trim, lowercase, collapse spaces; exact match against the word; no fuzzy matching in Minimal.
- 2–8 players; a solo game is not valid (min 2).

**Host work items**

- [ ] `GAME-DG-HOST-01` — Round/role state: choose drawer (round-robin), pick a word (seeded RNG, no repeats within a match), reveal at round end.
- [ ] `GAME-DG-HOST-02` — Private panel: send the word only to the drawer's slot; clear at round end; verify no other slot receives it (D5 privacy).
- [ ] `GAME-DG-HOST-03` — Stroke rendering: consume `start/move/end` events in order, draw polylines on the TV, clear between rounds, handle a reconnecting drawer.
- [ ] `GAME-DG-HOST-04` — Guess handling: receive text events, normalize, compare, mark correct, ignore duplicate guesses, score the first correct guesser; Minimal has no hints.
- [ ] `GAME-DG-HOST-05` — Scoreboard/results: drawer and guesser scoring (drawer scores if someone guesses), 3 rounds, winner, rematch/return (remote-operable).
- [ ] `GAME-DG-HOST-06` — Reconnect: a drawer who drops pauses the round for up to 20 s then skips; a guesser who drops can rejoin and keep guessing.

**Controller work**

- [ ] `GAME-DG-CTRL-01` — Layouts:
  - Drawer: canvas (~70% of screen) + a small "word" panel; Minimal has no undo.
  - Guesser: text input + submit + a status line.
- [ ] `GAME-DG-CTRL-02` — Canvas: default white ink, 6 px; send batched strokes; local ink immediate; flush on end.
- [ ] `GAME-DG-CTRL-03` — Text: one event per submit, `maxLen` 60, keyboard viewport handling (E16).
- [ ] `GAME-DG-CTRL-04` — Panel: render the secret word with `textContent`; heading + text only.
- [ ] `GAME-DG-CTRL-05` — On role change, the host swaps layouts for the affected slots only (D5 hot-swap).

**Data / content**

```json
// packs/words-family-v1.json
{
  "id": "words-family-v1",
  "type": "word-list",
  "license": "CC0-1.0",
  "items": ["apple", "bicycle", "castle", "dragon", "..."],
  "meta": { "category": "family", "language": "en" }
}
```

- [ ] `GAME-DG-DATA-01` — At least 50 CC0/self-made words; no duplicates; per-match no repeats.
- [ ] `GAME-DG-DATA-02` — Config: `rounds: 3`, `maxGuessesPerRound: 20`, `reconnectPauseMs: 20000`.

**Tests / acceptance**

- [ ] `GAME-DG-TEST-01` — Panel privacy: the word reaches only the drawer; other slots get no panel content (D5-QA-01).
- [ ] `GAME-DG-TEST-02` — Stroke order: start/move/end render the same polyline; a dropped/rejoined drawer's new strokes still render.
- [ ] `GAME-DG-TEST-03` — Guess normalization and first-correct scoring; duplicate/case/space variants.
- [ ] `GAME-DG-TEST-04` — Role rotation across 3 rounds; no repeated word; winner on score.
- [ ] `GAME-DG-TEST-05` — E10: < 20 KB/s per drawer, < 100 ms visible delay.
- [ ] `GAME-DG-TEST-06` — E16: keyboard open, layout usable, text survives rotation.
- [ ] `GAME-DG-TEST-07` — XSS: hostile guesses/panel text are inert and not stored.
- [ ] `GAME-DG-PERF-01` — Stroke rendering stays within frame budget with 8 connected players.

**Anti-rework**

- Word content is a pack, not an array in code.
- Panels/canvas/text come from D5 controls; the game ships layouts, not phone UI.
- Guess scoring is game logic; the server never sees or interprets guesses beyond routing.

## Full version (post-v1 backlog)

- [ ] Colours and brush sizes; undo; eraser.
- [ ] Hints that reveal letters over time.
- [ ] Word packs/categories, difficulty, language packs.
- [ ] Speed-based scoring and streaks.
- [ ] Avatars, round gallery, replay of strokes.
- [ ] Family-friendly filter integration and host review.
- [ ] Timer modes and custom words.
- [ ] Spectator mode for eliminated/extra players.

## Risks / watch-outs

- **Stroke bandwidth (E10):** batch aggressively; if over budget, quantize points or reduce sample rate.
- **Keyboard viewport (E16):** use `visualViewport`, keep submit visible; test Android.
- **Moderation (SR-13):** guesses can be offensive; filter before display, never store; family mode.
- **Drawer drop:** do not leave the round stuck; pause/skip with a clear message.
- **Panel privacy:** a bug here ruins the game; D5 privacy tests must run for every role swap.

## Acceptance checklist

- [ ] Minimal contract playable with 2 and 8 players.
- [ ] Word panel private; text and strokes round-trip.
- [ ] 3-round rotation, scoring, winner, rematch.
- [ ] E10/E16 pass; XSS suite passes.
- [ ] Content pack licensed and data-driven.
- [ ] No platform changes required.
