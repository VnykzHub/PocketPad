# Sumo Bumpers

Top-down arena party game for 2–8 phones. Each player drives a circular bumper,
shoves rivals with collisions and dashes, and tries to be the last body on the
floor while the arena shrinks. First player to win 3 rounds takes the match.

## Files

| Path | Purpose |
|---|---|
| `game.manifest.json` | Launcher metadata, layouts, budgets, presentation |
| `layouts/sb-stick-v1.json` | Minimal layout: one floating left stick |
| `layouts/sb-stick-dash-v1.json` | Stick + dash button + private status panel |
| `src/config.ts` | `GAME-SB-DATA-01` tuning and override validation |
| `src/arena.ts` | Shrink schedule, spawn ring, outside test |
| `src/physics.ts` | Circle collision, mass split, restitution |
| `src/hud.ts` | Precomputed HUD and panel strings |
| `src/render.ts` | Feature-detected flat 2D drawing |
| `src/game.ts` | `GameContext` adapter; match/scoreboard/pool wiring |

## How a match runs

`@lanpad/game-kit`'s match state machine drives the flow:

```
lobby -> countdown -> playing -> results -> countdown -> ...
                                 \-> lobby once a slot reaches 3 wins
```

- The lobby auto-starts a match as soon as `minPlayers` (2) controllers are
  connected. `onEvent(slot, "start")` starts it immediately as well.
- A round spawns every roster slot on a ring inside the arena. The floor
  shrinks linearly from radius `0.48` to `0.18` of the short viewport side over
  60 s.
- A bumper is eliminated only when its **whole circle** is outside the floor.
  The last body standing wins the round; a simultaneous wipe-out is a draw.
- Results stay for 4 s, or advance immediately when any connected player
  presses an action button. After a decided match the game returns to the
  lobby with scores cleared.

The game applies `sb-stick-dash-v1` to every controller. `sb-stick-v1` ships
unchanged for hosts that want the plan's Minimal stick-only layout.

## Disconnect and refresh behaviour

- A controller that drops keeps its body moving (no teleport, no input) for
  2 s, then the body leaves the round. The slot sees
  "Eliminated — spectating" when it reconnects during that round.
- Reconnecting inside the 2 s grace resumes the same body. Reconnecting after
  removal lets the player spectate until the next round; if the slot was in the
  match roster it respawns at the next round.
- If a roster slot is still gone when the next countdown starts, the match
  resets to the lobby and a new match starts with the players who are present.
  Round wins from the abandoned match are discarded.
- Nothing is persisted. Reloading the host page creates a new game in the
  lobby with zero wins (`GAME-SB-HOST-05`, reset option).
- Controllers that join after a match has started spectate until the match
  ends and a new one begins.

## Reconnect / layout notes for integration

- Layouts are addressed by id from `game.manifest.json`; the host must
  register both files (`manifestLayouts` does this for bundled games).
- The dash button occupies protocol bit 0. The game reads both stick axes and
  the edge bit from `GameContext` input; no other channels are used.
- Hit haptics use `ctx.haptics.pulse(slot, [40])`, rate-limited to one pulse
  per bumper per 250 ms. A host without haptics is silent, not fatal.
- Panels are text-only per the SDK panel schema.
