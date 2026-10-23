/**
 * Frozen 2D collision solver (07 §5.15; D7-RT-01; C9, PR-9.3/9.4).
 *
 * Moved verbatim from `packages/runtime/src/physics` at M0. Circle physics for
 * Coin Run (platformer) and future Sumo Bumpers / Tilt Maze. Games keep
 * importing these names from `@lanpad/runtime`, which re-exports this entry;
 * the `./two-d` subpath is the Rapier-free entry. This folder imports only its
 * own files.
 */
export * from "./Vec2.js";
export * from "./Aabb.js";
export * from "./collide.js";
