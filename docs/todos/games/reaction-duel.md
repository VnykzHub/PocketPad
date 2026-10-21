# Game: Reaction Duel

| Field | Value |
|---|---|
| Stage | D7 (proof set) |
| Spec | `SPEC.md` §17.2 Reaction Duel |
| Capabilities | C1 buttons, C2 edges + synced timestamps |
| Goals | G1 join→play, G2 timing fairness, G4 8 players, G8 SDK proof |
| Depends on | D2 buttons/edges/mapper, D3 loop/audio, D4 rooms, D7-SDK-01 |
| Work-item prefix | `GAME-RD-*` |

## Amendment A12 — four-input first-game variant (2026-10-21)

The accelerated first game must require at least four inputs per controller.
The Minimal therefore uses a four-button target-match variant:

- The TV signal is one of four targets (A, B, X, Y), each shown as a symbol
  plus label, not colour alone.
- Every controller exposes the same four buttons; pressing the matching button
  after the signal wins the round.
- A pre-signal press is a false start; a wrong-button press after the signal is
  a miss. Both lose the round.
- The match randomizes the target across all four buttons.

The original one-button tap duel remains a supported mode in the Full version.
This amendment adds a mode; it does not replace Reaction Duel's proof-set role
(rooms, timing, scoring, 8 players).

## Minimal (v1 acceptance)

**Gameplay contract**

- TV shows "Wait…", then a signal after a random 2–6 s delay.
- The signal is one of four targets: A, B, X or Y, shown as a symbol plus label (not colour alone).
- Each controller has four buttons with the same four symbols; the first player to press the matching button after the signal wins the round.
- A press before the signal is a false start and loses the round.
- A press of the wrong button after the signal is a miss and loses the round.
- The match randomizes the target across all four buttons; all four inputs must be usable.
- Best of 5 rounds; scores shown between rounds; 2–8 players.
- If nobody presses the correct button within 3 s of the signal, the round is a draw (no score) and replays.
- Fairness uses the synced timestamp (`ControllerState.tick`) carried with the edge, not arrival order (FR-7.10).
- Tie rule: earliest synced timestamp wins; a difference < 1 ms is a replay round (README §1.1).

**Host work items**

- [ ] `GAME-RD-HOST-01` — State machine: `lobby → countdown(3s) → waiting(2–6s) → signal → roundResult → nextRound | matchResult`. Seeded RNG for the delay; fake-clock testable.
- [ ] `GAME-RD-HOST-02` — Adjudication: collect the first edge per slot after `signalAt`; invalidate a slot that sent an edge during `waiting`; compare `packet.tick`; apply the tie rule; log the decision in debug only.
- [ ] `GAME-RD-HOST-03` — Presentation: large signal (color + shape, not color alone), countdown, scores, round winner, match winner. Audio cue on signal (start screen has unlocked audio); visual equivalent required.
- [ ] `GAME-RD-HOST-04` — Round flow: best-of-5 scoring, draw/replay, rematch from the results screen (remote-operable), return to hub.
- [ ] `GAME-RD-HOST-05` — Reconnect: a dropped player keeps their slot; if they return before the next round they can play; if not, the round proceeds with remaining players (documented). Host refresh restarts the match at the current round (proof scope).

**Controller work**

- [ ] `GAME-RD-CTRL-01` — Four-button layout (`rd-four-button-v1`): A/B/X/Y in a 2×2 grid, each at least 44 px with a distinct symbol and label, bits 0–3, same-frame pressed state; optional small status text.
- [ ] `GAME-RD-CTRL-02` — Each button sends its own bit edge on press; the layout has no axes; all four bits must be accepted.
- [ ] `GAME-RD-CTRL-03` — Full version only: haptic pulse at the signal if enabled; the game must remain playable with haptics off.

**Data / manifest**

```json
{
  "schemaVersion": 1,
  "name": "Reaction Duel",
  "entry": "index.js",
  "layouts": ["layouts/rd-four-button-v1.json"],
  "assetBudget": { "initialBytes": 262144, "totalBytes": 1048576 },
  "minPlayers": 2,
  "maxPlayers": 8,
  "needsGyro": false
}
```

- [ ] `GAME-RD-DATA-01` — Config: `mode: "fourButton"`, `buttons: ["A","B","X","Y"]`, `roundsToWin: 3` (best of 5), `minDelayMs: 2000`, `maxDelayMs: 6000`, `noTapTimeoutMs: 3000`, `tieThresholdMs: 1`.

**Tests / acceptance**

- [ ] `GAME-RD-TEST-01` — State-machine unit tests with fake clock: waiting duration range, signal, false start, no-tap draw, best-of-5 progression.
- [ ] `GAME-RD-TEST-02` — Adjudication tests with two recorded taps: earliest matching-button timestamp wins; equal/near-equal replays; a pre-signal edge loses; a wrong-button post-signal edge is a miss.
- [ ] `GAME-RD-TEST-06` — Four-input test: the layout exposes bits 0–3 and the game accepts each button; the target randomizes across all four.
- [ ] `GAME-RD-TEST-03` — 8-player bot run: all slots receive signal state; one winner; no stuck round.
- [ ] `GAME-RD-TEST-04` — Reconnect mid-match: slot preserved; player can tap next round.
- [ ] `GAME-RD-TEST-05` — Audio/visual cue: signal is perceivable with sound muted.
- [ ] `GAME-RD-PERF-01` — Asset budget, draw calls, frame p95 recorded.

**Anti-rework**

- The game never reads sockets; it consumes `ControllerState.edges` and `tick` only.
- The tie rule is data/config, not a hard-coded branch in the host.
- Round/score logic stays in the game, not the hub.

## Full version (post-v1 backlog)

- [ ] Modes: classic one-button tap, count-the-taps, memory sequence.
- [ ] Phone buzz at the signal on Android (haptics optional).
- [ ] Sound design and animated scoreboard.
- [ ] Tournament bracket and spectator view.
- [ ] Latency-fair adjudication refinements from E9 data.
- [ ] Themes and accessibility options (reduced motion, color-blind-safe signal).

## Risks / watch-outs

- **Clock sync accuracy (E9).** If timestamp error is > 5 ms, switch to arrival order plus a documented tie rule; record the decision.
- **False-start UX.** A player who taps early must understand why they lost; show "Too early, P3".
- **Backgrounded phones.** A suspended player cannot tap; do not mark them false-starters.
- **Audio cue latency (E11).** The visual signal is the source of truth; audio is additive.
- **Host refresh.** Proof scope accepts losing match state; document it on the results/start screen.

## Acceptance checklist

- [ ] Minimal contract implemented and playable with 2 and 8 players.
- [ ] Four-button layout exposes and exercises all four inputs per controller.
- [ ] False start, wrong-button miss, no-tap, tie and best-of-5 cases tested.
- [ ] Signal is visible without audio; audio is synchronized.
- [ ] Reconnect and host refresh behavior documented.
- [ ] Budget/frame metrics recorded.
- [ ] No platform changes required.
