/**
 * Compatibility re-export of the frozen 2D solver (07 §5.15).
 *
 * The implementation moved to `@lanpad/engine-physics/two-d` at M0. This file
 * keeps `@lanpad/runtime`'s public physics names stable for games and is
 * deleted at M1; it contains no implementation and imports no Rapier code.
 */
export * from "@lanpad/engine-physics/two-d";
