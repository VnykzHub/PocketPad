# Game: Bomb Defusal

| Field | Value |
|---|---|
| Stage | P6 (ambitious, wave 3) |
| Spec | `SPEC.md` §17.4 Bomb Defusal |
| Capabilities | C3 private panel, C4 text/choice, per-slot layouts, procedural content |
| Goals | G5 private screens/per-slot layouts, G8 |
| Depends on | D5 panels/choice/text/hot-swap, D4 sessions, P6-DOCS-01 |
| Work-item prefix | `GAME-BD-*` |

## Minimal (v1 acceptance)

**Gameplay contract**

- The TV shows a ticking bomb with a timer.
- One phone is the defuser; the screen has three module types: wires, button, keypad.
- Other phones show manual pages on private panels; the manual explains the rules needed to solve each module.
- Rules are procedurally generated per round from a fixed rule set; every generated bomb is solvable.
- Defuse all modules before the timer runs out to win; a wrong action adds a strike (3 strikes = loss).
- 2–8 players (1 defuser + manual readers); one round for Minimal.

**Host work items**

- [ ] `GAME-BD-HOST-01` — Bomb state: modules, timer, strikes, defused count, win/loss, reveal.
- [ ] `GAME-BD-HOST-02` — Module generators: wires, button, keypad; each produces a state + a unique solution and a manual snippet that determines it. A solvability checker verifies each generated bomb.
- [ ] `GAME-BD-HOST-03` — Per-slot layouts: defuser gets the module layout; manual readers get a panel layout with paged manual content; swap via D5 hot-swap.
- [ ] `GAME-BD-HOST-04` — Manual pages: generate concise pages (text/blocks) from the same rule data; deterministic; no hidden contradictions.
- [ ] `GAME-BD-HOST-05` — Actions: wire cut, button press/hold, keypad code; validate against the solution; strike feedback; module solved state.
- [ ] `GAME-BD-HOST-06` — Reconnect: the defuser can rejoin and resume; manual readers can rejoin and get their page; if the defuser is gone for 20 s, the round is lost (documented).

**Controller work**

- [ ] `GAME-BD-CTRL-01` — Defuser layout `bd-defuser-v1`: wires (choice list of colored wires), button (large press/hold), keypad (text input or numeric choice), module status.
- [ ] `GAME-BD-CTRL-02` — Manual layout `bd-manual-v1`: panel with paged content (prev/next), page indicator; readable on a small screen.
- [ ] `GAME-BD-CTRL-03` — Show timer, strikes, and solved modules; same-frame button feedback.
- [ ] `GAME-BD-CTRL-04` — Haptics (Full): ticking pulses; optional, never required.

**Data / manifest**

```json
{
  "schemaVersion": 1,
  "name": "Bomb Defusal",
  "entry": "index.js",
  "layouts": ["layouts/bd-defuser-v1.json", "layouts/bd-manual-v1.json"],
  "assetBudget": { "initialBytes": 524288, "totalBytes": 2097152 },
  "minPlayers": 2,
  "maxPlayers": 8,
  "needsGyro": false
}
```

- [ ] `GAME-BD-DATA-01` — Config: `timerMs: 300000`, `strikesAllowed: 3`, `moduleCount: 3`, `moduleTypes: ["wires","button","keypad"]`, `manualPagesMax: 8`.
- [ ] `GAME-BD-DATA-02` — Rule tables for each module are data + pure functions; no randomness outside the seeded generator.

**Tests / acceptance**

- [ ] `GAME-BD-TEST-01` — Solvability: 10,000 generated bombs pass the checker; no contradictions between state and manual.
- [ ] `GAME-BD-TEST-02` — Module rules: correct/incorrect actions, strikes, solved state.
- [ ] `GAME-BD-TEST-03` — Timer/win/loss; strike limit.
- [ ] `GAME-BD-TEST-04` — Per-slot layouts: defuser vs manual pages; no defuser controls on manual phones.
- [ ] `GAME-BD-TEST-05` — Manual readability: page length/lines fit the panel; scrolling/paging works.
- [ ] `GAME-BD-TEST-06` — Reconnect: defuser and reader; no duplicate actions.
- [ ] `GAME-BD-PERF-01` — Timer-driven UI within budget; no per-frame allocations.

**Anti-rework**

- Rule generation is data + pure functions; the manual and the solution come from the same source.
- Per-slot layouts use D5 hot-swap; no custom per-role controller code.
- The server never interprets game actions; all validation is host-side.

## Full version (post-v1 backlog)

- [ ] 8+ module types (Morse, Simon, memory, maze, passwords).
- [ ] Difficulty levels and module count scaling.
- [ ] Rotating defuser roles between rounds.
- [ ] Tension audio, ticking haptics, timer callouts.
- [ ] A proper manual generator with sections/index.
- [ ] Campaign/missions and statistics.

## Risks / watch-outs

- **Solvability and fairness:** a generated rule that contradicts the manual is a game-breaking bug; the checker is mandatory.
- **Manual readability:** small screens; test with 8 pages and long rules; use short sentences and clear formatting.
- **Role clarity:** players must know who is the defuser; the TV and phone must say it.
- **Time pressure:** 5 minutes for 3 modules is a design guess; tune with playtests.
- **No realtime input:** events are low-rate; the timer runs on the host.

## Acceptance checklist

- [ ] Minimal contract playable with 2–8 players.
- [ ] 10k solvability check passes.
- [ ] Module/timer/strike tests pass.
- [ ] Per-slot layouts and manual readability verified.
- [ ] Reconnect behavior documented.
- [ ] No platform changes required.
