/**
 * Synthetic fixture manifests for the console-launcher evidence page.
 *
 * These are test data, not product manifests: no game code, no assets, no
 * real room token. Presentation fields mirror `GameManifest.presentation`
 * (spec 25) so every scene renders through the same code path as a real game
 * folder. One entry (`monogram-only`) deliberately omits `presentation` to
 * show the generated gradient + monogram fallback.
 */
import type {
  ConsoleGame,
  ConsolePlayerInput,
} from "../../packages/runtime/src/ui/console/types.js";

/** Fixed clock so screenshots are deterministic. */
export const FIXTURE_NOW = new Date(2026, 0, 2, 21, 47);
export const FIXTURE_ROOM = { code: "7K4Q", pin: "2841" } as const;
/** Local fake join URL; `fixture-token-not-real` is not a room token. */
export const FIXTURE_JOIN_URL =
  "http://127.0.0.1:8080/c/7K4Q#fixture-token-not-real";
export const FIXTURE_CONNECTION = { text: "Room live", tone: "ok" } as const;

export const FOUR_GAMES: readonly ConsoleGame[] = [
  {
    slug: "neon-circuit",
    name: "Neon Circuit",
    minPlayers: 1,
    maxPlayers: 4,
    presentation: {
      tagline: "Race the grid, own the night.",
      accent: "#4cb3f0",
      categories: ["racing", "action"],
      inputBadges: ["stick", "triggers"],
      featured: true,
    },
  },
  {
    slug: "dune-racers",
    name: "Dune Racers",
    minPlayers: 2,
    maxPlayers: 4,
    presentation: {
      tagline: "Four wheels, one dune.",
      accent: "#ff9f45",
      categories: ["racing"],
      inputBadges: ["stick", "buttons"],
    },
  },
  {
    slug: "orbit-clash",
    name: "Orbit Clash",
    minPlayers: 1,
    maxPlayers: 4,
    presentation: {
      tagline: "Hold the station, break the swarm.",
      accent: "#b388ff",
      categories: ["action", "co-op"],
      inputBadges: ["stick", "buttons", "gyro"],
    },
  },
  {
    slug: "tiny-kingdom",
    name: "Tiny Kingdom",
    minPlayers: 1,
    maxPlayers: 4,
    presentation: {
      tagline: "Build a realm in one sofa session.",
      accent: "#4fd1a1",
      categories: ["co-op"],
      inputBadges: ["dpad", "buttons"],
    },
  },
];

export const THIRTEEN_GAMES: readonly ConsoleGame[] = [
  ...FOUR_GAMES,
  {
    slug: "pulse-arena",
    name: "Pulse Arena",
    minPlayers: 2,
    maxPlayers: 4,
    presentation: {
      tagline: "Last one standing, again.",
      accent: "#ff6b6b",
      categories: ["action"],
      inputBadges: ["stick", "buttons"],
    },
  },
  {
    slug: "skyline-drift",
    name: "Skyline Drift",
    minPlayers: 2,
    maxPlayers: 8,
    presentation: {
      tagline: "Trade paint above the city.",
      accent: "#ff8ad8",
      categories: ["racing", "action"],
      inputBadges: ["stick", "triggers"],
    },
  },
  {
    slug: "dungeon-dashers",
    name: "Dungeon Dashers",
    minPlayers: 1,
    maxPlayers: 4,
    presentation: {
      tagline: "Loot first, ask later.",
      accent: "#f2d05c",
      categories: ["co-op", "action"],
      inputBadges: ["dpad", "buttons"],
    },
  },
  {
    slug: "frostbite",
    name: "Frostbite",
    minPlayers: 1,
    maxPlayers: 4,
    presentation: {
      tagline: "Keep warm, keep moving.",
      accent: "#7ee0ff",
      categories: ["action"],
      inputBadges: ["stick", "gyro"],
    },
  },
  {
    slug: "mecha-mayhem",
    name: "Mecha Mayhem",
    minPlayers: 2,
    maxPlayers: 4,
    presentation: {
      tagline: "Two pilots, one chassis.",
      accent: "#ff5d5d",
      categories: ["co-op", "action"],
      inputBadges: ["triggers", "haptics"],
    },
  },
  {
    slug: "star-chef",
    name: "Star Chef",
    minPlayers: 1,
    maxPlayers: 8,
    presentation: {
      tagline: "Dinner at the edge of the map.",
      accent: "#ffd166",
      categories: ["co-op"],
      inputBadges: ["dpad", "buttons"],
    },
  },
  {
    slug: "rally-riot",
    name: "Rally Riot",
    minPlayers: 2,
    maxPlayers: 8,
    presentation: {
      tagline: "Eight cars, no brakes.",
      accent: "#c77dff",
      categories: ["racing"],
      inputBadges: ["stick", "triggers", "haptics"],
    },
  },
  {
    slug: "lantern-keep",
    name: "Lantern Keep",
    minPlayers: 1,
    maxPlayers: 4,
    presentation: {
      tagline: "Guard the light through the night.",
      accent: "#90e0a8",
      categories: ["solo", "co-op"],
      inputBadges: ["stick", "buttons", "text"],
    },
  },
  {
    slug: "monogram-only",
    name: "Monogram Only",
    minPlayers: 1,
    maxPlayers: 2,
  },
];

const PLAYER_COLORS = [
  "#ff5d5d",
  "#4cb3f0",
  "#4fd1a1",
  "#f2d05c",
  "#b388ff",
  "#ff8ad8",
  "#ff9f45",
  "#7ee0ff",
] as const;
const PLAYER_SHAPES = ["circle", "triangle", "square", "diamond"] as const;
const PLAYER_LABELS = ["Ada", "Rex", "Mira", "Jax", "Nia", "Kai", "Lux", "Vex"];

/** Eight connected players for the lobby scene (topic colours, label+shape). */
export const EIGHT_PLAYERS: readonly ConsolePlayerInput[] = PLAYER_LABELS.map(
  (label, index) => ({
    slot: index + 1,
    label,
    color: PLAYER_COLORS[index % PLAYER_COLORS.length] ?? "#4cb3f0",
    shape: PLAYER_SHAPES[index % PLAYER_SHAPES.length] ?? "circle",
    state: "connected",
  }),
);
