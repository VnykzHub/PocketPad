# Coin Run

Minimal 1-4 player (2-player focus) side-scrolling platformer for PocketPad.
Coin Run is a dev-tier extra game, not one of the four D7 proof games; the plan
is `docs/todos/games/platformer.md` (work items `GAME-PF-01` .. `GAME-PF-06`).
The Minimal v1 slice is one level: move left/right, jump, collect 20 shared
coins and reach the goal flag. Rendering is procedural; the game ships no
assets.

## Play directly

```sh
npm run build
node packages/dev-server/dist/main.js
```

On the TV open `http://<host>:8080/games/platformer/`. That exact path makes
the runtime select `packages/games/platformer/game.manifest.json` and mount the
normal `GameHost`; `?game=platformer` selects the same manifest. The dev server
serves the manifest and `layouts/*.json` from this game folder and the built
bundle from `packages/games/dist/platformer/`.

Controller dev bridge: append `?layout=pf-dpad-v1` or `?layout=pf-stick-v1` to
a controller URL to fetch and validate that layout before D5 `setLayout`
lands. The host still applies the same layout through the normal layout path
once it has a connected controller state.

## Controls

| Action | d-pad layout (`pf-dpad-v1`) | stick layout (`pf-stick-v1`) |
|---|---|---|
| Move left | d-pad left, bit 10 | left stick `lx` below -0.25 |
| Move right | d-pad right, bit 11 | left stick `lx` above 0.25 |
| Jump | Jump button, bit 0 edge | Jump button, bit 0 edge |

- d-pad up (bit 8) and down (bit 9) are declared to satisfy the shared d-pad
  contract but are intentionally unused by Coin Run.
- Jump is edge-triggered: holding the button does not repeat a jump.
- No gyro, no haptics, no private panel, no text or canvas controls.
- Both layouts are landscape and keep every target at or above 44x44 CSS px.
  The d-pad's four direction sectors each own half of its declared square.

## Players

The manifest declares `minPlayers: 1` and `maxPlayers: 4`. The Minimal slice
targets two players sharing one TV and one fixed-aspect camera; 1-4 phones each
control one character. Coins feed one shared team score, per-player
contributions are display-only, players pass through each other, and the first
player to touch the goal ends the level for everyone. Falling respawns at the
last checkpoint with no life lost. Rematch resets the level, coins, checkpoints
and score.

## Known D0 join and reload limits

- D0 has no session tokens or QR sessions. A phone reload joins as a new slot;
  the old character can stay idle for the rest of the session because there is
  no slot-list event until D4/D5. This is a documented slice gap, not a Coin Run
  rule.
- There is no lobby roster yet: the host starts when at least one controller is
  connected.
- Layout delivery is host-driven. Before the host has a connected controller
  state for a fresh slot it may not have sent the platformer layout yet, so the
  phone can briefly show the default D0 test button until the layout arrives.
  The fix belongs in the host's connected tracking, not in this package.

## Files

| File | Purpose |
|---|---|
| `game.manifest.json` | Game boundary: entry `index.js`, both layouts, 256 KiB initial / 1 MiB total asset budget, 1-4 players, no gyro |
| `layouts/pf-dpad-v1.json` | Landscape d-pad (`move`, bits 8/9/10/11) plus jump button (bit 0) |
| `layouts/pf-stick-v1.json` | Landscape floating left stick plus jump button (bit 0) |
| `test/manifest.test.ts` | Manifest contract, layout files present, five-player and missing-layout rejection |
| `test/layout.test.ts` | Layout validation, bit/channel uniqueness, duplicate-channel rejection, 44 px targets |
| `tsconfig.json`, `vitest.config.ts` | Scoped typecheck and test config used by the root gate |

Game logic files under `src/` are added by `GAME-PF-02` .. `GAME-PF-06`.

## Assets

No assets. The manifest still declares `initialBytes: 262144` and
`totalBytes: 1048576` so the size gate exercises the game folder early; all
drawing is procedural shapes.

## Testing

From the repository root:

```sh
npx vitest --config packages/games/platformer/vitest.config.ts
npm run typecheck:games
```

Tests are tagged `[FR-10.3]`, `[FR-8.1]`, `[FR-8.4]`, `[AR-5]` and `[G8]`.
