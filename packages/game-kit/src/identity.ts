/**
 * Player identity (spec 24 §2.3; ER-24-03).
 *
 * Colours are the eight `--player-N` tokens from DESIGN.md. State is never
 * carried by colour alone, so every UI use must pair `playerColor` with
 * `playerLabel` and `playerShape`.
 */
import { requireSlot } from "./slots.js";

export type PlayerShape = "circle" | "triangle" | "square" | "diamond";

/** DESIGN.md §player identity: eight hues, at least 60° apart, readable on #000. */
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

/** Shapes cycle with the slot so no two adjacent slots share one. */
const PLAYER_SHAPES: readonly PlayerShape[] = [
  "circle",
  "triangle",
  "square",
  "diamond",
];

/** Constant labels, so HUD code returning rows allocates no strings. */
const PLAYER_LABELS: readonly string[] = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8"];

/** The slot's DESIGN hue token, e.g. `#4cb3f0` for slot 1. */
export function playerColor(slot: number): string {
  requireSlot(slot);
  return PLAYER_COLORS[slot - 1] ?? PLAYER_COLORS[0] ?? "#4cb3f0";
}

/** The slot's short label, `"P1"`..`"P8"`. */
export function playerLabel(slot: number): string {
  requireSlot(slot);
  return PLAYER_LABELS[slot - 1] ?? "P1";
}

/** The slot's shape; slots 1/5 are circles, 2/6 triangles, 3/7 squares, 4/8 diamonds. */
export function playerShape(slot: number): PlayerShape {
  requireSlot(slot);
  return PLAYER_SHAPES[(slot - 1) % PLAYER_SHAPES.length] ?? "circle";
}
