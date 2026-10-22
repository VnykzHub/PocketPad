# Reaction Duel

First proof game for PocketPad. Spec: `SPEC.md` §17.2 Reaction Duel, with
amendment A12 (`docs/todos/games/reaction-duel.md`).

This folder is a complete bundled game: the pure rules model and adjudicator,
the host adapter at `src/game.ts`, and the manifest/layout/config data. The
host discovers `game.manifest.json` at build time (D7-SDK-01), bundles
`src/game.ts`, and `loadGame` still fetches and validates the manifest over
HTTP. `game.manifest.json` names `index.js` as the served entry; the bundled
host maps that URL to the Vite chunk instead of a built file.

## Rules (four-button Minimal)

1. The match is best of 5: the first player to win 3 rounds wins the match.
2. At the start of each round the TV shows "Wait…", then a signal after a
   random delay between 2 and 6 seconds.
3. The signal is one target out of four: **A, B, X, Y**. It is shown as a
   symbol plus a label, never colour alone.
4. Every controller exposes the same four buttons. The first player whose
   matching-button press arrives after the signal wins the round.
5. A press before the signal is a false start and loses the round.
6. A press of the wrong button after the signal is a miss and loses the round.
7. If nobody presses the matching button within 3 seconds of the signal, the
   round is a draw, scores nothing, and is replayed.
8. Ties are decided on the synced controller timestamp (`ControllerState.tick`
   carried with the edge), not arrival order (FR-7.10). The earliest synced
   timestamp wins; a gap smaller than 1 ms is a replay round.
9. The match supports 2 to 8 players.

Players who are disconnected keep their slot; if they return before the next
round they can play, otherwise the round proceeds without them.

## Four-input requirement (A12)

The first game must exercise at least four inputs per controller:

- The layout `layouts/rd-four-button-v1.json` has exactly four `button`
  controls, one each for A, B, X and Y.
- Buttons use protocol bits 0, 1, 2 and 3. Every bit must be accepted.
- The four buttons sit in a 2x2 grid; each has a distinct label and a distinct
  symbol (`▲`, `●`, `✕`, `■`). The `symbol` field is an additive display hint;
  the SDK validator preserves unknown properties.
- The layout declares no axes, sticks, triggers or sensors. The manifest sets
  `needsGyro: false`; the game is fully playable with buttons only.
- Each button renders at least 44 x 44 CSS px at the smallest supported
  controller viewport. This scaffold verifies 320 x 568 CSS px, where an
  `r` of 18% resolves to 57.6 px.

The classic one-button tap duel stays a Full-version mode; A12 adds the
four-button mode without replacing Reaction Duel's proof-set role.

## Files

| File | Purpose |
|---|---|
| `game.manifest.json` | Game boundary: entry, layouts, asset budget (256 KiB initial / 1 MiB total), 2-8 players, no gyro |
| `layouts/rd-four-button-v1.json` | Controller layout: four buttons on bits 0-3 |
| `config.json` | Rules data: `fourButton` mode, A/B/X/Y, first to 3, 2-6 s delay, 3 s no-tap timeout, 1 ms tie threshold |
| `src/model.ts` | Pure round state machine: lobby through countdown, signal, result; seeded delay; no timers, no I/O |
| `src/adjudication.ts` | Edge adjudication: earliest synced tick wins, false start, wrong button, tie and no-tap replays |
| `src/game.ts` | Host adapter: `(manifest) => Game`, applies the four-button layout on join, renders via the 2D surface, reports results with synced timestamps |
| `test/layout.test.ts` | Layout/config contract tests tagged A12, FR-8.1, FR-8.3 and G5 |
| `test/model.test.ts` | Round model tests: delay bounds, signal, timeout, seeded replay |
| `test/adjudication.test.ts` | Adjudication tests: earliest tick, false start, wrong button, tie gap |
| `test/game.test.ts` | Adapter tests: layout application, 2-8 slots, rendering, rematch, dispose |

## Configuration

```json
{
  "mode": "fourButton",
  "buttons": ["A", "B", "X", "Y"],
  "roundsToWin": 3,
  "minDelayMs": 2000,
  "maxDelayMs": 6000,
  "noTapTimeoutMs": 3000,
  "tieThresholdMs": 1
}
```

`roundsToWin: 3` is best of 5. The tie threshold is configuration, not a
hard-coded host branch.

## Testing

From the repository root:

```sh
npx vitest --config packages/games/reaction-duel/vitest.config.ts
```

The tests read the shipped JSON as data and validate the layout with the
existing pure `sdk/src/layout-validate.ts` validator. The game stays free of
sockets, protocol imports, fetch, storage and DOM access (FR-7.17); host
services arrive only through `GameContext`.
