# 25 — Console shell: manifest presentation and motion tiers

**Status:** frozen contract for Wave 0. Stream D implements the launcher in Wave 1.
**Goal:** give the PS5-style home everything it needs from each game manifest, with no per-game code, and amend the design system so motion is allowed on capable devices without breaking reduced-motion users.
**Non-goals:** copying PlayStation trade dress, per-game launcher code, 3D key art (Wave 2), a theme editor.

---

## 1. Manifest fields (additive)

`game.manifest.json` gains one optional object:

```json
{
  "presentation": {
    "tagline": "Shrink the floor. Stay on.",
    "accent": "#ff9f45",
    "thumbnail": "art/sumo-thumb.webp",
    "heroModel": "characters/bumper",
    "categories": ["party", "arena"],
    "inputBadges": ["stick", "haptics"],
    "featured": false
  }
}
```

| Field | Type | Rules |
|---|---|---|
| `tagline` | string | 1..80 characters, no control characters, trimmed |
| `accent` | string | `#rrggbb`, must meet 3:1 against `#000` |
| `thumbnail` | string | asset id from `assets.json`, 1..64 chars, `[a-z0-9._-]` segments |
| `heroModel` | string | asset id, same rules; Wave 2 uses it for the backdrop |
| `categories` | string[] | max 3 unique values from `party, arena, puzzle, racing, action, co-op, solo` |
| `inputBadges` | string[] | max 5 unique values from `stick, dpad, buttons, triggers, gyro, haptics, text, canvas, choice` |
| `featured` | boolean | default false; at most one featured game per library |

- The whole object is optional; a manifest without it validates.
- Unknown fields inside `presentation` are rejected.
- Missing optional fields fall back to the launcher's generated gradient and monogram from the game name; missing art is never an error.
- The launcher reads only the manifest; no game code runs on the home screen.
- Engine Cube is `?debug=1` only; its manifest stays valid but the launcher filters it unless debug is on.

## 2. Launcher contract (stream D)

The launcher must:

1. Operate with arrows/Enter, a standard gamepad and the phone remote layout (d-pad, confirm, back).
2. Derive one tile per discovered game from the manifest, sorted by `featured` then name; no hard-coded slugs.
3. Show title, tagline, player range (`minPlayers..maxPlayers`) and input badges on the focused tile.
4. Crossfade the backdrop to the focused game's accent/gradient; Wave 2 adds `heroModel`.
5. Show room code, PIN, QR toggle, connection state, clock and one chip per connected player (colour + label + shape).
6. Restore focus on return; free timers, audio and GPU resources on leave; pause the backdrop while a game runs.
7. Keep input immediate: motion never delays a state change.

## 3. Design-system amendment (D3)

`DESIGN.md` gains a **console shell** tier, additive to the existing flat rules:

- **Full tier:** focus scale up to 1.08; parallax up to 8 px on tile art; soft accent glow; backdrop crossfade. Only `transform` and `opacity` animate. Existing duration/easing tokens.
- **Reduced tier:** `prefers-reduced-motion: reduce` or a low-tier device keeps instant focus, no parallax and a static backdrop.
- No layout shift, no shadow/glass on resting surfaces, no new fonts, no tracked capitals. The accent stays reserved for live state and focus.
- Sound plays only after the start gesture, default volume low, with a mute toggle and move/select/back/error cues.
- Backdrop frame cost ≤ 4 ms on the dev machine in Full; paused during games.

## 4. Validation and schema

- SDK `GamePresentation` type and `validateManifest` rules; JSON schema gains `presentation`.
- Fixtures: a fully-populated manifest validates; each invalid field (long tagline, bad accent, unknown category/badge, >3 categories, >5 badges, bad asset id, unknown key) fails with a JSON path.
- A manifest without `presentation` still validates; existing games need no changes.

## 5. Acceptance

| ID | Criterion |
|---|---|
| ER-25-01 | A manifest with every presentation field validates; an absent object validates |
| ER-25-02 | Each invalid field fails with the exact JSON path; the schema and validator agree |
| ER-25-03 | The launcher builds tiles from manifests only; adding a game folder adds a tile with zero code changes |
| ER-25-04 | Keyboard, gamepad and phone-remote navigation all pass the same launcher tests |
| ER-25-05 | Reduced tier passes the same navigation tests with animations off |
| ER-25-06 | Launch/return 20 times leaves no leaked listener, timer, audio node or GPU resource |
| ER-25-07 | Backdrop ≤ 4 ms per frame in Full and paused during a game |
| ER-25-08 | Screenshots at 1920×1080 for start, 4 tiles, 13 tiles, empty and 8-player lobby |
| ER-25-09 | Engine Cube is hidden unless `?debug=1` |

## 6. File ownership

| Path | Owner |
|---|---|
| `sdk/src/manifest.ts` presentation types/validator, schema, fixtures | Wave 0 |
| `DESIGN.md` console-shell amendment | Wave 0 |
| `packages/runtime/src/ui/console/**`, launcher CSS, `host/launcher.ts` | Stream D |
| Phone remote layout | Stream E |
