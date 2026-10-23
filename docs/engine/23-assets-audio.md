# 23 — Game assets and audio wiring

**Status:** frozen contract for Wave 0. Streams B (runtime), C (curation) and G (host wiring) implement it.
**Goal:** replace the empty `GAME_ASSETS` array with a per-game, validated, byte-budgeted asset manifest that fills `ctx.assets` and makes `ctx.audio.playSfx/playMusic` work by asset id.
**Non-goals:** a general asset editor, remote CDN loading, video, shader assets, hot reload, UGC uploads.

---

## 1. File

Each game folder may contain `assets.json` next to `game.manifest.json`:

```json
{
  "schemaVersion": 1,
  "groups": [
    { "id": "boot", "mode": "eager" },
    { "id": "arena", "mode": "lazy" }
  ],
  "assets": [
    {
      "id": "car",
      "path": "assets/car.glb",
      "kind": "mesh",
      "bytes": 182296,
      "group": "boot",
      "ledger": "car.glb",
      "clips": ["idle", "drive"]
    },
    {
      "id": "hit",
      "path": "assets/hit.ogg",
      "kind": "audio",
      "bytes": 12044,
      "group": "boot",
      "ledger": "hit.ogg"
    }
  ]
}
```

- Absent file = no assets. A game with assets but no `assets.json` fails validation.
- `schemaVersion` is `1`. Unknown fields are rejected.
- `groups[].mode` is `"eager"` (loaded before the start screen completes) or `"lazy"` (loaded on demand).
- `assets[].kind` uses the SDK's `AssetKind`: `mesh | texture | material | audio | font | json | scene | animation`.
- `clips` is optional and only meaningful for `mesh`; it lists animation-group names a game may address in `ctx.world.playClip`.
- `bytes` is the exact file size in bytes; it is checked at load, not trusted.
- `ledger` names a row in the game's `LICENSES.csv`. Every asset must have one; the validator rejects the manifest otherwise.
- `path` is relative to the game folder, uses `/`, and must not be absolute, contain `..`, a drive letter or a scheme. It must resolve inside the game folder.

## 2. Budgets

The existing manifest `assetBudget.initialBytes` / `totalBytes` are authoritative:

- Sum of eager `bytes` ≤ `initialBytes` and ≤ **5 MiB** (the SPEC boot cap includes host + game code + boot assets; the host reports the running total).
- Sum of all `bytes` ≤ `totalBytes`.
- A boot set that would exceed either limit is a validation failure before any request is made.
- Lazy groups never count toward the boot set; they are capped by `totalBytes` and the runtime's resident-byte budget.

## 3. Host flow

1. `loadGame` fetches `assets.json` (if present), validates it and its ledger, and rejects the game with a fixed notice on failure.
2. The stage loads the **eager** group with byte-accurate progress (fetched/declared) shown on the start screen.
3. After the start gesture unlocks audio, the host decodes every `audio` asset and registers it with `AudioBus.registerSfx`/`registerMusic` by asset `id`.
4. Only then does `game.init(ctx)` run. `ctx.assets` is the existing `AssetLibrary`; `ctx.audio.playSfx("hit")` resolves the registered buffer.
5. Lazy groups load through `ctx.assets.load(id)`; `@lanpad/game-kit` provides a `loadGroup` helper over the ids. Progress remains byte-accurate.
6. `GAME_ASSETS` and its empty array are deleted from `host/stage.ts` when stream B lands.

Failure behavior: a missing file, byte mismatch, missing ledger row, bad path, duplicate id or over-budget sum prevents the game from starting and shows the existing fixed error notice. There is **no** fallback to `Game-assets/` or a remote URL.

## 4. Audio

- Supported container: OGG Vorbis. **D6 gate:** a decode smoke test in Chrome, Firefox and Safari must pass; if any fails, curation transcodes to Opus and this spec is amended before games ship audio.
- `playSfx(id)` and `playMusic(id)` accept only ids present in `assets.json` and decoded. An unknown id remains a silent no-op at runtime (existing `AudioBus` contract), but the loader rejects a missing declared asset at boot.
- Audio decodes only after the start gesture (`FR-9.11`); no context is created before it.
- `playMusic` fades use the audio clock, never `setTimeout`.

## 5. Validation

Wave 0 provides a pure `validateAssetManifest(value, ledger): AssetManifestResult` in the SDK (no filesystem):

- Structure, types, unique ids/group ids, known kinds, `schemaVersion` 1.
- Path safety rules above.
- Every asset has a ledger row; empty ledger entries fail.
- Boot/total budget arithmetic.
- `clips` only on mesh assets and non-empty strings.
- Returns the first error with a JSON path such as `assets[2].ledger`.

Stream C adds a CLI that reads the filesystem, recomputes bytes, verifies the ledger file and fails on any mismatch.

## 6. Acceptance

| ID | Criterion |
|---|---|
| ER-23-01 | A valid fixture loads; each invalid fixture (duplicate id, unknown kind, path escape, missing ledger, over budget, bad schema version) fails with the named code and JSON path |
| ER-23-02 | Boot progress reports fetched/declared bytes exactly; a short read fails the load |
| ER-23-03 | A GLB from `assets.json` appears in the host through `ctx.world.spawnModel` |
| ER-23-04 | An OGG declared as `audio` decodes and plays through `playSfx` after the gesture |
| ER-23-05 | A missing file or byte mismatch prevents `game.init` and shows fixed copy |
| ER-23-06 | Over-budget boot and total sets fail before any fetch |
| ER-23-07 | Lazy groups are not requested during boot and load on demand with progress |
| ER-23-08 | No code path reads `Game-assets/` directly (source scan) |
| ER-23-09 | Host + game + boot assets measured at gzip ≤ 5 MiB in the size gate |
| ER-23-10 | Audio decode happens after unlock and before `game.init`; no AudioContext before the gesture |

## 7. File ownership

| Path | Owner |
|---|---|
| `sdk/src/assets.ts`, `sdk/schema/game-assets.schema.json` | Wave 0 |
| `packages/runtime/src/assets/**`, `src/audio/**`, `src/game/loadGame.ts` | Stream B |
| `tools/asset-curate/**`, `assets/**`, game `LICENSES.csv` | Stream C |
| `host/stage.ts` wiring | Stream G |
| Test fixture game | Wave 0 template + stream B |

## 8. Risks

- OGG decode support varies by browser and TV; D6's smoke test decides before any game depends on it.
- Large GLBs can breach the boot cap; curation must optimise and split groups.
- Registering audio before the gesture is not allowed; decode must stay after unlock without delaying the first playable frame more than the budget allows.
