/**
 * Physics primitives (D7-RT-01; C9, PR-9.3/9.4).
 *
 * Small, custom circle physics for Coin Run (platformer) and future Sumo
 * Bumpers / Tilt Maze. Games import these from `@lanpad/runtime`; they do not
 * carry a private collision implementation.
 */
export * from "./Vec2.js";
export * from "./Aabb.js";
export * from "./collide.js";
