# Game asset inventory (2026-10-23)

Scan of `Game-assets/` at the repo root. **Raw total: 1.3 GB, 4,621 files.** This
folder should not be committed; commit this inventory, a licence ledger and a
curated subset under `assets/` instead.

## At a glance

| Category | Ready-to-use | Needs conversion | Licence |
|---|---:|---:|---|
| 3D buildings / city kits | **282 GLB + 153 glTF** | 306 FBX | CC0 (Kenney, Quaternius) |
| 3D roads / street kits | **95 GLB** | 25 FBX (Street Pack) | CC0 |
| 3D vehicles | **50 GLB** (Kenney car kit) | 29 FBX (Rgsdev 22, Realistic 7) | CC0 |
| 3D characters | **52 glTF + 2 GLB** | 52 FBX | CC0 (Quaternius packs) |
| 3D nature | **22 GLB** (mini-forest) | 5 FBX (palms, **unlicensed**) | CC0 / unknown |
| Animation clips | **~875** (52×16 + 43) | — | CC0 |
| Audio | **556 OGG** (Vorbis) | 0 | CC0 (Kenney) |
| Textures | **794 PNG**, 4 JPG, 3 HDR | — | CC0 where in a licensed pack |
| Source files | 87 `.blend` | — | unverified at root |
| Archives / duplicates | 22 ZIP, 356 MB | — | duplicates |

Unique ready-to-use model files: **411 GLB + 205 glTF (+153 `.bin`)**. The
remainder are FBX/OBJ/`.blend` sources, previews and duplicates.

## Collections

| Collection | Files | Size | Ready formats | What it gives us | Licence |
|---|---:|---:|---|---|---|
| `Downtown City MegaKit[Standard]` | 691 | 244 MB | 153 glTF + 306 FBX | Modular downtown buildings, props, decals | **CC0** (`License_Standard.txt`) |
| `kenney_city-kit-commercial_2.1` | 219 | 12 MB | 41 GLB | Commercial buildings/storefronts | CC0 |
| `kenney_city-kit-industrial_2.0` | 201 | 11 MB | 37 GLB | Warehouses, industry | CC0 |
| `kenney_city-kit-suburban_20` | 216 | 8.2 MB | 40 GLB | Houses, suburbia | CC0 |
| `kenney_retro-urban-kit` | 693 | 6.7 MB | 124 GLB | Dense urban props/buildings | CC0 |
| `kenney_retro-urban-kit (1)` | 693 | 6.7 MB | 124 GLB | **Duplicate — ignore** | CC0 |
| `kenney_city-kit-roads` | 487 | 7.7 MB | 95 GLB | Roads, crossings, lights | CC0 |
| `kenney_car-kit` | 259 | 15 MB | 50 GLB | 50 low-poly vehicles | CC0 |
| `kenney_mini-forest_1.0` | 120 | 3.4 MB | 22 GLB | Trees, rocks, archer character | CC0 |
| `Street Pack by @Quaternius` | 102 | 16 MB | 0 (25 FBX) | Street props, buildings | CC0 |
| `Ultimate Animated Character Pack - Nov 2019` | 264 | 336 MB | 52 glTF | 52 rigged characters, 16 clips each | CC0 |
| `Universal Animation Library[Standard]` | 9 | 61 MB | 2 GLB | One skinned rig, **43 clips** incl. `Walk_Loop`, `Jog_Fwd_Loop`, `Driving_Loop`, `Idle_Loop` | CC0 |
| `Free Low Poly Vehicles Pack by Rgsdev` | 27 | 2.4 MB | 0 (22 FBX) | 22 extra vehicles | CC0 |
| `Realistic Car Pack - Nov 2018` | 30 | 7.6 MB | 0 (7 FBX) | 7 cars | CC0 |
| `kenney_impact-sounds` | 133 | 1.3 MB | 130 OGG | Footsteps, impacts | CC0 |
| `kenney_interface-sounds` | 103 | 1.2 MB | 100 OGG | UI clicks | CC0 |
| `kenney_music-jingles` | 89 | 1.6 MB | 86 OGG | Music stings | CC0 |
| `kenney_digital-audio` | 67 | 1.2 MB | 63 OGG | UI/digital | CC0 |
| `kenney_sci-fi-sounds` | 77 | 5.9 MB | 73 OGG | Sci-fi SFX | CC0 |
| `kenney_rpg-audio` | 55 | 1.2 MB | 52 OGG | RPG SFX | CC0 |
| `kenney_ui-audio` | 55 | 591 KB | 52 OGG | UI SFX | CC0 |
| `exoticpalmslowpolystyle` | 7 | 2.6 MB | 0 (5 FBX) | Palm trees | **No licence file — do not use** |
| Root `buildings_pack*.blend` | 2 | — | 0 | Blender sources | **Unverified** |
| `zipped/` | 22 | 356 MB | 0 | Duplicates of character/animation packs | Duplicates |

## What the engine can use today

| Format | Engine status |
|---|---|
| GLB / glTF | **Mesh loading works.** Skins and animations are **not parsed** by the GLB decoder yet; `KHR_texture_transform` is ignored |
| PNG / WebP / JPG | Decodes through the injected bitmap path |
| OGG (Vorbis) | Container is supported and the browser decodes it; spec 06's audio path targets Opus/AAC, so Vorbis is a **compatibility check to run** |
| FBX / OBJ / `.blend` | **No importer.** Needs a Blender/FBX2glTF conversion step |
| KTX2 | Decoder exists; these collections ship PNG textures, not KTX2 |
| HDR | Three interior cubemap faces only; no environment HDRIs |

## Blockers and gaps

1. **Skeletal animation is the big one.** The 52 characters and the 43-clip
   library are the most valuable assets in the drop, but the custom engine's GLB
   decoder does not read `skins` or `animations`. PlayCanvas and Babylon load
   them natively. Adding the skin/anim decode path to `packages/engine/assets`
   and feeding the animation package is a real work item, not a copy.
2. **`KHR_texture_transform`** appears in Kenney GLBs; our decoder ignores it, so
   some kit pieces may show wrong UV tiling until it is supported.
3. **FBX/OBJ/`.blend` only:** Rgsdev vehicles, Realistic Car Pack, Street Pack and
   the palms cannot be loaded without a conversion pipeline. Prefer the Kenney
   GLB kits for M1.
4. **Scale/orientation** differs between packs; the import step needs an explicit
   unit and up-axis normalization.
5. **No collision meshes.** Buildings and vehicles need convex/trimesh collision
   built at import time.
6. **PBR materials:** the custom renderer currently handles base colour + light,
   not the full metallic-roughness/normal/AO set these assets expect.
7. **Size:** 336 MB of characters and 244 MB Downtown kit must be curated, not
   loaded wholesale; the boot budget is 5 MB gz.

## Recommended M1 subset (all CC0)

| Use | Assets | Approx. raw |
|---|---|---:|
| City block | Kenney commercial + roads + retro urban GLBs | 30–40 MB |
| Vehicles | Kenney car kit (pick 4–6) | 2–3 MB |
| Characters | `UAL1_Standard.glb` + 3–5 characters from the Ultimate pack | 12–16 MB |
| Props | Kenney retro urban / mini-forest | 5 MB |
| Audio | Kenney impact + interface + music jingles | 8–10 MB |
| Ground/sky | generated or Poly Haven CC0 later | — |

Stream these by cell; keep the boot set to a road tile, one building, one car,
one character and a handful of sounds.

## Licence rules

- All named Kenney, Quaternius and Rgsdev packs in this drop declare **CC0 1.0**;
  keep their `License.txt` with the source and record a ledger row per copied
  asset (`file, source, author, licence, date, attribution`).
- Do **not** use the palms folder or the root `.blend` files until their licence
  is found.
- Do not commit the 1.3 GB folder or the 356 MB `zipped/` duplicates; add
  `Game-assets/` to `.gitignore` and commit a curated `assets/` subset plus the
  ledger.
