# Game: Spy in the Room

| Field | Value |
|---|---|
| Stage | P6 (next tier, wave 1) |
| Spec | `SPEC.md` §17.3 Spy in the Room |
| Capabilities | C3 private panel, C4 choice |
| Goals | G5 private screens, G8, lowest realtime load |
| Depends on | D5 panels/choice, D4 sessions, P6-DOCS-01 packs |
| Work-item prefix | `GAME-SIR-*` |

## Minimal (v1 acceptance)

**Gameplay contract**

- Each phone privately shows a secret word.
- One player (the spy) gets a different word; everyone else has the same word.
- A timed discussion happens on the TV (e.g. 3 minutes); the TV shows who is still in and the timer.
- Players vote with a `choice` list; the most-voted player is revealed.
- If the spy is caught, the civilians win; if not, the spy wins.
- 3–8 players; 2 rounds; then a winner/scoreboard.
- No realtime input beyond voting; the game is turn/phase based.

**Host work items**

- [ ] `GAME-SIR-HOST-01` — Role assignment: one spy, everyone else civilian; choose a word pair from a pack; seeded RNG; never send the spy word to civilians.
- [ ] `GAME-SIR-HOST-02` — Private panels: send each slot only its word; show role confirmation on the phone; clear at round end.
- [ ] `GAME-SIR-HOST-03` — Phase/timer: `roles → discussion(timer) → vote → reveal → next`; timer visible; host can end discussion early.
- [ ] `GAME-SIR-HOST-04` — Vote/reveal: collect one vote per player; tally; reveal the most-voted player's role. If spy, civilians win; else spy wins. Ties follow a documented rule (re-vote or no elimination).
- [ ] `GAME-SIR-HOST-05` — Reconnect: a dropped player's vote is skipped; they keep their role if they return before reveal; host can pause the timer.
- [ ] `GAME-SIR-HOST-06` — Scoreboard/results: round wins, match winner, rematch/return.

**Controller work**

- [ ] `GAME-SIR-CTRL-01` — Layouts: `sir-word-v1` (panel with the secret word + role hint) and `sir-vote-v1` (choice list).
- [ ] `GAME-SIR-CTRL-02` — Panel: large, readable, private; Minimal shows "Your word" and the word; `showRoleHint` config controls whether the spy is told.
- [ ] `GAME-SIR-CTRL-03` — Vote: one choice, lock after submit; show "Vote submitted".
- [ ] `GAME-SIR-CTRL-04` — Full: spy last-guess input (text/choice) when caught; optional.

**Data / content**

```json
// packs/spy-words-v1.json
{
  "id": "spy-words-v1",
  "type": "word-pair-list",
  "license": "CC0-1.0",
  "items": [
    { "civilian": "coffee", "spy": "tea" },
    { "civilian": "beach", "spy": "desert" }
  ]
}
```

- [ ] `GAME-SIR-DATA-01` — At least 30 CC0/self-made word pairs; no duplicates; family-friendly.
- [ ] `GAME-SIR-DATA-02` — Config: `rounds: 2`, `discussionMs: 180000`, `allowSelfVote: false`, `showRoleHint: false`.

**Tests / acceptance**

- [ ] `GAME-SIR-TEST-01` — Exactly one spy; civilians share a word; spy word differs; no leakage in panels.
- [ ] `GAME-SIR-TEST-02` — Timer and phase transitions; host early-end; no stuck phase.
- [ ] `GAME-SIR-TEST-03` — Vote tally; tie rule; win determination.
- [ ] `GAME-SIR-TEST-04` — Reconnect during discussion/vote; no duplicate vote; role preserved.
- [ ] `GAME-SIR-TEST-05` — 8 players; panel text readable; no PII stored.
- [ ] `GAME-SIR-PERF-01` — Negligible realtime load; no frame impact.

**Anti-rework**

- Word pairs are a pack; roles/votes are game state on the host.
- Panels are the only private channel; no custom socket messages.
- The game works with no realtime input beyond vote events.

## Full version (post-v1 backlog)

- [ ] Word packs, categories, family mode.
- [ ] Role variants (multiple spies, informant).
- [ ] Spy last guess for a comeback.
- [ ] Animated reveals and scoring across rounds.
- [ ] Discussion prompts on the TV, player avatars.
- [ ] Custom word pairs from the host (filtered, not stored).

## Risks / watch-outs

- **Panel leakage:** a role bug ruins the game; test per-slot privacy on every round.
- **Ties:** define clearly (re-vote or no elimination) and show it.
- **Silent players:** the game is social; no timer pressure beyond the discussion timer.
- **Content:** word pairs must be family-safe; filter hook.
- **8 players:** the vote list must fit and be readable on a phone.

## Acceptance checklist

- [ ] Minimal contract playable with 3–8 players.
- [ ] Role/word privacy verified per slot.
- [ ] Timer, vote, tie and win rules tested.
- [ ] Reconnect behavior documented.
- [ ] Content pack licensed; XSS suite passes.
- [ ] No platform changes required.
