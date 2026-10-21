# Game: Bluff Quiz

| Field | Value |
|---|---|
| Stage | P6 (next tier, wave 1) |
| Spec | `SPEC.md` §17.3 Bluff Quiz |
| Capabilities | C3 private panel, C4 text/choice |
| Goals | G5 private screens, G8, low realtime load |
| Depends on | D5 panels/text/choice, D4 sessions, P6-DOCS-01 packs |
| Work-item prefix | `GAME-BQ-*` |

## Minimal (v1 acceptance)

**Gameplay contract**

- A question is shown; each phone types a fake answer privately.
- The real answer is mixed into the list of fakes and shown on the TV.
- Players vote for the answer they think is real.
- Scoring: players who fool others earn points; players who find the truth earn points.
- 2–8 players; 5 questions; then a winner.
- No timers in Minimal; the host advances when all answers/votes are in (with a host "skip" fallback).

**Host work items**

- [ ] `GAME-BQ-HOST-01` — Phase state machine: `question → collectFakes → buildList → vote → reveal → score → next`. Host can advance/skip a stalled phase.
- [ ] `GAME-BQ-HOST-02` — Fake collection: one text answer per slot, trim/length limits, reject empty, dedupe against the real answer and other fakes (case-insensitive).
- [ ] `GAME-BQ-HOST-03` — Vote list: real answer + up to 7 unique fakes, shuffled with a seeded RNG; send a `choice` layout mapping option values to answer ids (never reveal which is real).
- [ ] `GAME-BQ-HOST-04` — Scoring: +1 for each vote your fake gets; +2 for voting the real answer (numbers configurable); no self-vote; reveal the real answer and the scoreboard.
- [ ] `GAME-BQ-HOST-05` — Reconnect: a dropped player can rejoin before their phase; if they miss a phase, they score 0 for it; no stuck phase (host skip).

**Controller work**

- [ ] `GAME-BQ-CTRL-01` — Layouts: `bq-answer-v1` (question panel + text input + submit) and `bq-vote-v1` (choice list).
- [ ] `GAME-BQ-CTRL-02` — Text: `maxLen` 80, one submit, keyboard viewport handling; show "Answer submitted".
- [ ] `GAME-BQ-CTRL-03` — Choice: show option labels only; no answer ids leaked in the UI; one vote, lock after submit.
- [ ] `GAME-BQ-CTRL-04` — Panel: show the question/phase privately; sanitize text.

**Data / content**

```json
// packs/quiz-general-v1.json
{
  "id": "quiz-general-v1",
  "type": "quiz",
  "license": "CC0-1.0",
  "items": [
    { "question": "What is the capital of Australia?", "answer": "Canberra" }
  ]
}
```

- [ ] `GAME-BQ-DATA-01` — At least 30 CC0/self-made Q&A items; no duplicates; answers short.
- [ ] `GAME-BQ-DATA-02` — Config: `questions: 5`, `maxFakeLen: 80`, `scoreFool: 1`, `scoreTruth: 2`, `allowSelfVote: false`.

**Tests / acceptance**

- [ ] `GAME-BQ-TEST-01` — Dedupe: real answer and duplicate fakes removed case-insensitively; empty rejected.
- [ ] `GAME-BQ-TEST-02` — Vote list never reveals the real answer by ordering or ids; shuffle seeded/tested.
- [ ] `GAME-BQ-TEST-03` — Scoring: fool points, truth points, self-vote disallowed, ties handled.
- [ ] `GAME-BQ-TEST-04` — Phase completes with 2 and 8 players; host skip unblocks.
- [ ] `GAME-BQ-TEST-05` — Reconnect during answer/vote phases; no duplicate submissions.
- [ ] `GAME-BQ-TEST-06` — XSS/moderation: hostile fake answers are inert and filterable.
- [ ] `GAME-BQ-PERF-01` — Content and UI within budget; no realtime pressure.

**Anti-rework**

- Quiz content is a pack; no hard-coded arrays.
- The real answer is mixed host-side only; the controller never receives it before reveal.
- Text/choice controls come from D5; no custom phone UI.

## Full version (post-v1 backlog)

- [ ] Categories, packs, difficulty.
- [ ] Timers per phase with a visible countdown.
- [ ] Image and audio rounds (budgeted assets).
- [ ] Duplicate-answer scoring variants.
- [ ] Host narration/voice lines (optional, no copyrighted audio).
- [ ] Family-friendly filter integration and a pack editor.
- [ ] Streaks, achievements, results breakdown.

## Risks / watch-outs

- **Moderation (SR-13):** fake answers can be offensive; filter before display, never store, family mode.
- **Duplicate answers:** silently merge or reject with a message; do not show duplicates as separate options.
- **Vote privacy:** the real answer must not be inferable from option order or ids.
- **Stalled players:** a disconnected player must not block the game; host skip.
- **8-player lists:** up to 8 options; keep text readable on a TV and phone.

## Acceptance checklist

- [ ] Minimal contract playable with 2 and 8 players.
- [ ] Dedupe, shuffle, scoring, self-vote rules tested.
- [ ] Real answer never leaks before reveal.
- [ ] Reconnect and host skip work.
- [ ] Content pack licensed; XSS suite passes.
- [ ] No platform changes required.
