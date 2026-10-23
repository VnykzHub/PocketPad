/**
 * Curated asset selection (spec 23, ADR-0004 D7/D8).
 *
 * Source paths are relative to the local, gitignored `Game-assets/` drop.
 * Output paths are relative to `assets/`. Nothing here is read at runtime;
 * `curate.ts` turns this data into copied files, a ledger and per-game
 * manifests.
 */

export const CURATION_DATE = "2026-10-23";

export const GAME_IDS = [
  "sumo-bumpers",
  "draw-and-guess",
  "spy-in-the-room",
  "bluff-quiz",
  "tilt-maze-race",
  "steering-wheel-racer",
  "tank-arena",
  "snake-royale",
  "sword-swing-duel",
  "bomb-defusal",
  "beat-tap",
  "heist-planner",
  "open-world-showcase",
  "reaction-duel",
  "coin-run",
  "launcher",
] as const;

export type GameId = (typeof GAME_IDS)[number];

export type CuratableKind = "mesh" | "texture" | "audio";

export type CurationGroup =
  | "characters"
  | "vehicles"
  | "props"
  | "audio-ui"
  | "audio-impact"
  | "audio-scifi"
  | "audio-digital"
  | "music";

export interface LicenceSource {
  /** Folder name in Game-assets. */
  readonly pack: string;
  readonly author: string;
  readonly licence: "CC0 1.0";
  readonly licenceUrl: string;
  /** Pack-relative evidence file that states the licence. */
  readonly licenceFile: string;
  readonly sourceUrl: string;
  /** ISO date the URL and pack were verified. */
  readonly accessed: string;
  readonly attribution: string;
}

export interface DerivedTransform {
  /** Game-assets-relative source of the derivation. */
  readonly source: string;
  readonly tool: string;
  readonly command: string;
  readonly beforeBytes: number;
  readonly afterBytes: number;
  readonly change: string;
}

export interface SelectionEntry {
  /** Stable asset id; must satisfy the sdk asset-id pattern. */
  readonly id: string;
  readonly kind: CuratableKind;
  readonly group: CurationGroup;
  /** Game-assets-relative source path (forward slashes). */
  readonly source: string;
  /** assets-relative output path (forward slashes). */
  readonly output: string;
  readonly games: readonly GameId[];
  readonly licence: LicenceSource;
  /** Animation-group names, mesh assets only. */
  readonly clips?: readonly string[];
  readonly derived?: DerivedTransform;
  readonly notes?: string;
}

export interface GameManifestSelection {
  readonly game: GameId;
  /** Explicit eager asset ids; GLB texture dependencies are added automatically. */
  readonly boot: readonly string[];
}

const CAR = "kenney_car-kit/Models/GLB format";
const FOREST = "kenney_mini-forest_1.0/Models/GLB format";
const URBAN = "kenney_retro-urban-kit/Models/GLB format";
const ROADS = "kenney_city-kit-roads/Models/GLB format";
const UI = "kenney_ui-audio/Audio";
const INTERFACE = "kenney_interface-sounds/Audio";
const IMPACT = "kenney_impact-sounds/Audio";
const SCIFI = "kenney_sci-fi-sounds/Audio";
const DIGITAL = "kenney_digital-audio/Audio";
const MUSIC = "kenney_music-jingles/Audio/Steel jingles";
const UAL = "Universal Animation Library[Standard]/Unreal-Godot/UAL1_Standard.glb";

const CC0_URL = "https://creativecommons.org/publicdomain/zero/1.0/";

function kenney(
  pack: string,
  sourceUrl: string,
  licenceFile = "License.txt",
): LicenceSource {
  return {
    pack,
    author: "Kenney",
    licence: "CC0 1.0",
    licenceUrl: CC0_URL,
    licenceFile,
    sourceUrl,
    accessed: CURATION_DATE,
    attribution: "None required; crediting Kenney (kenney.nl) is appreciated.",
  };
}

export const LICENCES = {
  carKit: kenney("kenney_car-kit", "https://kenney.nl/assets/car-kit"),
  forest: kenney("kenney_mini-forest_1.0", "https://kenney.nl/assets/mini-forest"),
  urban: kenney("kenney_retro-urban-kit", "https://kenney.nl/assets/retro-urban-kit"),
  roads: kenney("kenney_city-kit-roads", "https://kenney.nl/assets/city-kit-roads"),
  ui: kenney("kenney_ui-audio", "https://kenney.nl/assets/ui-audio"),
  interface: kenney("kenney_interface-sounds", "https://kenney.nl/assets/interface-sounds"),
  impact: kenney("kenney_impact-sounds", "https://kenney.nl/assets/impact-sounds"),
  scifi: kenney("kenney_sci-fi-sounds", "https://kenney.nl/assets/sci-fi-sounds"),
  digital: kenney("kenney_digital-audio", "https://kenney.nl/assets/digital-audio"),
  music: kenney("kenney_music-jingles", "https://kenney.nl/assets/music-jingles"),
  ual: {
    pack: "Universal Animation Library[Standard]",
    author: "Quaternius",
    licence: "CC0 1.0",
    licenceUrl: CC0_URL,
    licenceFile: "License.txt",
    sourceUrl: "https://quaternius.com/packs/universalanimationlibrary.html",
    accessed: CURATION_DATE,
    attribution: "None required; crediting Quaternius (@Quaternius) is appreciated.",
  },
} as const satisfies Record<string, LicenceSource>;

const ALL_GAMES: readonly GameId[] = GAME_IDS;

export const SELECTION: readonly SelectionEntry[] = [
  {
    id: "char.ual",
    kind: "mesh",
    group: "characters",
    source: UAL,
    output: "models/characters/ual-mannequin.glb",
    games: ["sumo-bumpers", "sword-swing-duel", "open-world-showcase"],
    licence: LICENCES.ual,
    clips: ["Idle_Loop", "Walk_Loop"],
    derived: {
      source: UAL,
      tool: "@gltf-transform/core 4.5.1 + @gltf-transform/functions 4.5.1",
      command: "node tools/asset-curate/scripts/optimise-ual.mjs <UAL1_Standard.glb> <out.glb>",
      beforeBytes: 7_618_436,
      afterBytes: 854_184,
      change:
        "Kept Idle_Loop and Walk_Loop; disposed the other 41 clips and their unreferenced accessors; pruned unused nodes and accessors.",
    },
    notes: "Rigged Quaternius mannequin. 65 joints, 2 clips; used for melee, sumo and the open-world pedestrian.",
  },
  {
    id: "char.archer",
    kind: "mesh",
    group: "characters",
    source: `${FOREST}/character-archer.glb`,
    output: "models/characters/archer.glb",
    games: ["sumo-bumpers", "sword-swing-duel", "snake-royale", "open-world-showcase"],
    licence: LICENCES.forest,
    notes: "Kenney mini-forest rigged archer with its animation set; small fallback character.",
  },
  {
    id: "vehicle.sedan",
    kind: "mesh",
    group: "vehicles",
    source: `${CAR}/sedan.glb`,
    output: "models/vehicles/sedan.glb",
    games: ["steering-wheel-racer", "tank-arena", "open-world-showcase"],
    licence: LICENCES.carKit,
    notes: "Kenney car-kit sedan; racer player car, tank-arena body fallback, open-world traffic.",
  },
  {
    id: "vehicle.race",
    kind: "mesh",
    group: "vehicles",
    source: `${CAR}/race.glb`,
    output: "models/vehicles/race.glb",
    games: ["steering-wheel-racer", "open-world-showcase"],
    licence: LICENCES.carKit,
    notes: "Kenney race car; racer alternative skin.",
  },
  {
    id: "vehicle.delivery",
    kind: "mesh",
    group: "vehicles",
    source: `${CAR}/delivery.glb`,
    output: "models/vehicles/delivery.glb",
    games: ["steering-wheel-racer", "heist-planner", "open-world-showcase"],
    licence: LICENCES.carKit,
    notes: "Kenney delivery van; heist get-away prop and open-world traffic.",
  },
  {
    id: "prop.tree",
    kind: "mesh",
    group: "props",
    source: `${FOREST}/tree.glb`,
    output: "models/props/forest/tree.glb",
    games: ["snake-royale", "open-world-showcase"],
    licence: LICENCES.forest,
    notes: "Kenney mini-forest tree; arena cover and city-block greenery.",
  },
  {
    id: "prop.rocks",
    kind: "mesh",
    group: "props",
    source: `${FOREST}/rocks-low.glb`,
    output: "models/props/forest/rocks.glb",
    games: ["snake-royale", "open-world-showcase"],
    licence: LICENCES.forest,
    notes: "Kenney mini-forest low rocks; cover and ground dressing.",
  },
  {
    id: "prop.bench",
    kind: "mesh",
    group: "props",
    source: `${URBAN}/detail-bench.glb`,
    output: "models/props/urban/bench.glb",
    games: ["heist-planner", "open-world-showcase"],
    licence: LICENCES.urban,
    notes: "Kenney retro-urban bench; heist room and street furniture.",
  },
  {
    id: "prop.pallet",
    kind: "mesh",
    group: "props",
    source: `${URBAN}/pallet.glb`,
    output: "models/props/urban/pallet.glb",
    games: ["heist-planner", "open-world-showcase"],
    licence: LICENCES.urban,
    notes: "Kenney retro-urban pallet; heist room prop.",
  },
  {
    id: "prop.road-straight",
    kind: "mesh",
    group: "props",
    source: `${ROADS}/road-straight.glb`,
    output: "models/props/roads/road-straight.glb",
    games: ["steering-wheel-racer", "heist-planner", "open-world-showcase"],
    licence: LICENCES.roads,
    notes: "Kenney roads straight tile; racer track, heist grid and open-world block.",
  },
  {
    id: "prop.streetlight",
    kind: "mesh",
    group: "props",
    source: `${ROADS}/light-square.glb`,
    output: "models/props/roads/streetlight.glb",
    games: ["steering-wheel-racer", "heist-planner", "open-world-showcase"],
    licence: LICENCES.roads,
    notes: "Kenney roads square streetlight; track edge and city dressing.",
  },
  {
    id: "sfx.ui.click",
    kind: "audio",
    group: "audio-ui",
    source: `${UI}/click1.ogg`,
    output: "audio/ui/click.ogg",
    games: ALL_GAMES,
    licence: LICENCES.ui,
    notes: "Primary button click.",
  },
  {
    id: "sfx.ui.rollover",
    kind: "audio",
    group: "audio-ui",
    source: `${UI}/rollover1.ogg`,
    output: "audio/ui/rollover.ogg",
    games: ALL_GAMES,
    licence: LICENCES.ui,
    notes: "Focus/hover rollover.",
  },
  {
    id: "sfx.ui.select",
    kind: "audio",
    group: "audio-ui",
    source: `${INTERFACE}/select_001.ogg`,
    output: "audio/ui/select.ogg",
    games: ALL_GAMES,
    licence: LICENCES.interface,
    notes: "Confirm selection.",
  },
  {
    id: "sfx.ui.back",
    kind: "audio",
    group: "audio-ui",
    source: `${INTERFACE}/back_001.ogg`,
    output: "audio/ui/back.ogg",
    games: ALL_GAMES,
    licence: LICENCES.interface,
    notes: "Back/cancel.",
  },
  {
    id: "sfx.ui.error",
    kind: "audio",
    group: "audio-ui",
    source: `${INTERFACE}/error_004.ogg`,
    output: "audio/ui/error.ogg",
    games: ALL_GAMES,
    licence: LICENCES.interface,
    notes: "Invalid action.",
  },
  {
    id: "sfx.ui.toggle",
    kind: "audio",
    group: "audio-ui",
    source: `${INTERFACE}/toggle_004.ogg`,
    output: "audio/ui/toggle.ogg",
    games: ALL_GAMES,
    licence: LICENCES.interface,
    notes: "Toggle switch.",
  },
  {
    id: "sfx.impact.soft",
    kind: "audio",
    group: "audio-impact",
    source: `${IMPACT}/impactSoft_medium_000.ogg`,
    output: "audio/impact/soft.ogg",
    games: ["sumo-bumpers", "tank-arena", "sword-swing-duel", "reaction-duel", "coin-run", "open-world-showcase"],
    licence: LICENCES.impact,
    notes: "Soft body hit; sumo bump.",
  },
  {
    id: "sfx.impact.metal",
    kind: "audio",
    group: "audio-impact",
    source: `${IMPACT}/impactMetal_medium_002.ogg`,
    output: "audio/impact/metal.ogg",
    games: ["sumo-bumpers", "tank-arena", "sword-swing-duel", "steering-wheel-racer", "open-world-showcase"],
    licence: LICENCES.impact,
    notes: "Metal clash; sword parry, car collision, tank hit.",
  },
  {
    id: "sfx.impact.wood",
    kind: "audio",
    group: "audio-impact",
    source: `${IMPACT}/impactWood_heavy_000.ogg`,
    output: "audio/impact/wood.ogg",
    games: ["sumo-bumpers", "sword-swing-duel", "open-world-showcase"],
    licence: LICENCES.impact,
    notes: "Heavy wooden impact; sword-swing hit.",
  },
  {
    id: "sfx.impact.footstep",
    kind: "audio",
    group: "audio-impact",
    source: `${IMPACT}/footstep_concrete_000.ogg`,
    output: "audio/impact/footstep.ogg",
    games: ["open-world-showcase", "heist-planner", "sword-swing-duel"],
    licence: LICENCES.impact,
    notes: "Concrete footstep; open-world pedestrian and heist movement.",
  },
  {
    id: "sfx.scifi.laser",
    kind: "audio",
    group: "audio-scifi",
    source: `${SCIFI}/laserSmall_000.ogg`,
    output: "audio/scifi/laser.ogg",
    games: ["tilt-maze-race", "tank-arena", "bomb-defusal", "open-world-showcase"],
    licence: LICENCES.scifi,
    notes: "Small laser; tank shot and sci-fi UI.",
  },
  {
    id: "sfx.scifi.explosion",
    kind: "audio",
    group: "audio-scifi",
    source: `${SCIFI}/lowFrequency_explosion_001.ogg`,
    output: "audio/scifi/explosion.ogg",
    games: ["tank-arena", "tilt-maze-race", "bomb-defusal", "open-world-showcase"],
    licence: LICENCES.scifi,
    notes: "Low-frequency explosion; tank and bomb-defusal failure.",
  },
  {
    id: "sfx.scifi.force-field",
    kind: "audio",
    group: "audio-scifi",
    source: `${SCIFI}/forceField_000.ogg`,
    output: "audio/scifi/force-field.ogg",
    games: ["tilt-maze-race", "tank-arena", "bomb-defusal"],
    licence: LICENCES.scifi,
    notes: "Force-field hum; tilt maze wall and bomb shield.",
  },
  {
    id: "sfx.digital.three-tone",
    kind: "audio",
    group: "audio-digital",
    source: `${DIGITAL}/threeTone1.ogg`,
    output: "audio/digital/three-tone.ogg",
    games: ["bomb-defusal", "beat-tap", "bluff-quiz", "spy-in-the-room", "draw-and-guess"],
    licence: LICENCES.digital,
    notes: "Three-tone timer/sting; quiz and countdown feedback.",
  },
  {
    id: "music.menu-sting",
    kind: "audio",
    group: "music",
    source: `${MUSIC}/jingles_STEEL09.ogg`,
    output: "audio/music/menu-sting.ogg",
    games: ALL_GAMES,
    licence: LICENCES.music,
    notes:
      "Short steel jingle for lobbies and round results. Not a loop; Beat Tap must use a self-made track per D8.",
  },
];

/** Manifest files to generate; each game gets eager/lazy groups. */
export const GAME_MANIFESTS: readonly GameManifestSelection[] = [
  {
    game: "sumo-bumpers",
    boot: ["char.ual", "sfx.impact.soft", "sfx.impact.metal", "sfx.ui.click", "sfx.ui.select"],
  },
  {
    game: "steering-wheel-racer",
    boot: ["vehicle.sedan", "prop.road-straight", "sfx.impact.metal", "sfx.ui.click"],
  },
  {
    game: "sword-swing-duel",
    boot: ["char.ual", "sfx.impact.metal", "sfx.impact.wood", "sfx.ui.click"],
  },
  {
    game: "open-world-showcase",
    boot: [
      "char.ual",
      "vehicle.sedan",
      "prop.tree",
      "prop.road-straight",
      "sfx.impact.footstep",
      "sfx.ui.click",
    ],
  },
];

/** Packs and files deliberately left out of the committed subset. */
export const EXCLUSIONS: readonly { readonly pattern: string; readonly reason: string }[] = [
  {
    pattern: "exoticpalmslowpolystyle/**",
    reason:
      "No licence, licence file or source URL in the drop. D7 keeps unlicensed palms out unless URL + access date are recorded.",
  },
  {
    pattern: "buildings_pack.blend, buildings_pack_part_2.blend",
    reason: "Blender source only (139 MB); licence unverified and no .blend importer exists.",
  },
  {
    pattern: "Downtown City MegaKit[Standard]/**",
    reason:
      "FBX + glTF exports, no GLB; no licence file in the drop; 244 MB. Deferred to a world-streaming pass.",
  },
  {
    pattern: "Ultimate Animated Character Pack - Nov 2019/**",
    reason:
      "glTF + external .bin/textures (no GLB), 336 MB, 52 characters. CC0 evidence exists but a conversion pass is out of this small subset.",
  },
  {
    pattern: "Street Pack by @Quaternius/**",
    reason: "FBX only; no importer in the engine.",
  },
  {
    pattern: "Free Low Poly Vehicles Pack by Rgsdev/**",
    reason: "FBX only; no importer in the engine.",
  },
  {
    pattern: "Realistic Car Pack - Nov 2018/**",
    reason: "FBX only; no importer in the engine.",
  },
  {
    pattern: "zipped/**",
    reason: "22 duplicate ZIP archives (356 MB); contents are already extracted alongside.",
  },
  {
    pattern: "kenney_retro-urban-kit (1)/**",
    reason: "Exact duplicate of kenney_retro-urban-kit.",
  },
  {
    pattern: "kenney_city-kit-*/**, kenney_rpg-audio/**",
    reason:
      "CC0 and usable, but outside the small subset: city building kits need world streaming; RPG audio duplicates the selected UI/impact roles.",
  },
  {
    pattern: "Universal Animation Library[Standard]/Unreal-Godot/UAL1_Standard_RM.glb",
    reason: "Root-motion variant of the selected UAL mannequin; one variant is enough.",
  },
  {
    pattern: "other 500+ GLB models",
    reason:
      "The drop has hundreds of CC0 models; this curated set is intentionally limited to two characters, three vehicles, six props and fifteen sounds (fourteen effects and one jingle).",
  },
];
