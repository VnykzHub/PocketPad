/**
 * Manifest presentation resolution for the console shell (spec 25 §1).
 *
 * Every tile is derived from `GameManifest.presentation`; nothing here knows a
 * game slug. Missing fields fall back to a deterministic accent, gradient and
 * monogram from the game name, so incomplete art is never an error (spec 25
 * §1) and never renders `undefined`.
 *
 * Identity helpers mirror `@lanpad/game-kit`'s player identity. The runtime
 * does not import game-kit (ADR-0004 Wave 0 clarification 2), so the same
 * eight DESIGN hues, P1..P8 labels and four shapes live here; hosts that
 * already have game-kit identities pass them through `ConsolePlayerInput`.
 */
import type { InputBadge } from "@lanpad/sdk";
import { playerRangeLabel } from "../Launcher.js";
import type {
  ConsoleGame,
  ConsolePlayer,
  ConsolePlayerInput,
  PlayerPresence,
  PlayerShape,
} from "./types.js";

/** DESIGN.md player hues, at least 60 degrees apart and readable on #000. */
const PLAYER_COLORS: readonly string[] = [
  "#4cb3f0",
  "#ff9f45",
  "#c58cff",
  "#4fd1a1",
  "#ff7aa8",
  "#f2d05c",
  "#8fb8ff",
  "#ff6b6b",
];

const PLAYER_SHAPES: readonly PlayerShape[] = [
  "circle",
  "triangle",
  "square",
  "diamond",
];

const PLAYER_LABELS: readonly string[] = [
  "P1",
  "P2",
  "P3",
  "P4",
  "P5",
  "P6",
  "P7",
  "P8",
];

/** Fallback accents reuse the player palette, which is proven on #000. */
const FALLBACK_ACCENTS = PLAYER_COLORS;

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** User-facing labels for input badges; the badge is never an icon alone. */
const INPUT_BADGE_LABELS: Readonly<Record<InputBadge, string>> = {
  stick: "Stick",
  dpad: "D-pad",
  buttons: "Buttons",
  triggers: "Triggers",
  gyro: "Gyro",
  haptics: "Haptics",
  text: "Text entry",
  canvas: "Canvas",
  choice: "Choice",
};

/** Re-exported so the console is a single import for callers. */
export { playerRangeLabel };

/** Two-letter monogram from the game name; `"?"` when there is none. */
export function monogramFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((word) => word[0] ?? "");
  return letters.join("").toUpperCase() || "?";
}

/** Stable, non-negative hash so fallback art is identical across reloads. */
export function hashText(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Deterministic accent for a game without `presentation.accent`. */
export function fallbackAccent(game: Pick<ConsoleGame, "slug" | "name">): string {
  const seed = game.slug.length > 0 ? game.slug : game.name;
  const index = hashText(seed) % FALLBACK_ACCENTS.length;
  return FALLBACK_ACCENTS[index] ?? "#4cb3f0";
}

/** The manifest accent when it is a valid `#rrggbb`, else the fallback. */
export function presentationAccent(
  game: Pick<ConsoleGame, "slug" | "name" | "presentation">,
): string {
  const accent = game.presentation?.accent;
  if (accent !== undefined && HEX_COLOR.test(accent)) {
    return accent.toLowerCase();
  }
  return fallbackAccent(game);
}

/**
 * Backdrop / tile-art gradient. Gradients are allowed on the launcher only
 * (DESIGN.md console-shell tier) and this one is derived from the accent.
 */
export function presentationGradient(
  game: Pick<ConsoleGame, "slug" | "name" | "presentation">,
): string {
  const accent = presentationAccent(game);
  return `radial-gradient(120% 120% at 18% 0%, ${accent}73 0%, ${accent}26 42%, #050505 78%)`;
}

/** The focused tile's tagline, or null when the manifest omits it. */
export function presentationTagline(game: ConsoleGame): string | null {
  const tagline = game.presentation?.tagline?.trim();
  return tagline !== undefined && tagline.length > 0 ? tagline : null;
}

/** Input badges in manifest order, unknown values dropped defensively. */
export function presentationBadges(game: ConsoleGame): readonly InputBadge[] {
  const badges = game.presentation?.inputBadges ?? [];
  return badges.filter(
    (badge): badge is InputBadge => INPUT_BADGE_LABELS[badge] !== undefined,
  );
}

/** Display label for a badge; every badge is text, not colour. */
export function inputBadgeLabel(badge: InputBadge): string {
  return INPUT_BADGE_LABELS[badge] ?? "Input";
}

/** Featured games first, then case-insensitive name, then slug (spec 25 §2). */
export function sortConsoleGames(
  games: readonly ConsoleGame[],
): ConsoleGame[] {
  const featured = (game: ConsoleGame): number =>
    game.presentation?.featured === true ? 0 : 1;
  return [...games].sort((a, b) => {
    const byFeatured = featured(a) - featured(b);
    if (byFeatured !== 0) return byFeatured;
    const aName = a.name.trim().toLowerCase();
    const bName = b.name.trim().toLowerCase();
    if (aName < bName) return -1;
    if (aName > bName) return 1;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
}

/** Engine Cube and other tech demos stay hidden unless `?debug=1`. */
export function visibleConsoleGames(
  games: readonly ConsoleGame[],
  debug: boolean,
): ConsoleGame[] {
  return games.filter((game) => game.debugOnly !== true || debug);
}

/** DESIGN colour for a slot, 1..8. */
export function slotColor(slot: number): string {
  const safe = Number.isInteger(slot) && slot >= 1 && slot <= 8 ? slot : 1;
  return PLAYER_COLORS[safe - 1] ?? PLAYER_COLORS[0] ?? "#4cb3f0";
}

/** `P1`..`P8` for a slot. */
export function slotLabel(slot: number): string {
  const safe = Number.isInteger(slot) && slot >= 1 && slot <= 8 ? slot : 1;
  return PLAYER_LABELS[safe - 1] ?? "P1";
}

/** Shape cycles with the slot so adjacent slots never share one. */
export function slotShape(slot: number): PlayerShape {
  const safe = Number.isInteger(slot) && slot >= 1 && slot <= 8 ? slot : 1;
  return PLAYER_SHAPES[(safe - 1) % PLAYER_SHAPES.length] ?? "circle";
}

/**
 * Fills identity gaps and sorts by slot. Invalid slots are dropped, duplicate
 * slots keep the first entry, and `open` is accepted so a host can pass a full
 * eight-slot snapshot.
 */
export function resolvePlayers(
  inputs: readonly ConsolePlayerInput[],
): ConsolePlayer[] {
  const seen = new Set<number>();
  const players: ConsolePlayer[] = [];
  for (const input of inputs) {
    if (!Number.isInteger(input.slot) || input.slot < 1 || input.slot > 8) {
      continue;
    }
    if (seen.has(input.slot)) continue;
    seen.add(input.slot);
    const state: PlayerPresence = input.state ?? "connected";
    players.push({
      slot: input.slot,
      label: input.label?.trim() || slotLabel(input.slot),
      color: input.color?.trim() || slotColor(input.slot),
      shape: input.shape ?? slotShape(input.slot),
      state,
    });
  }
  return players.sort((a, b) => a.slot - b.slot);
}

/** Chips only represent players who are in the room. */
export function connectedPlayers(
  players: readonly ConsolePlayer[],
): ConsolePlayer[] {
  return players.filter((player) => player.state === "connected");
}
