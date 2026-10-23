/**
 * World-cell contract owned by spec 12 and declared here because the frozen
 * shapes in 00 §3.5 come from `@lanpad/engine-core` (00 §6: "`WorldCell` by
 * 12"; 12 §3: "The streamer re-exports them; it does not redefine them").
 *
 * Declaration-only: the streamer implementation lands at M2 (00 §5.14), so
 * this module declares the public shapes and nothing else.
 */

/**
 * Signed 32-bit grid coordinate pair (00 §3.5). Y is elevation, not a cell
 * axis (12 §4.1).
 */
export interface WorldCellId {
  /** Grid coordinate, i32. */
  readonly cx: number;
  /** Grid coordinate, i32. */
  readonly cy: number;
}

/**
 * Canonical decimal `"<cx>,<cy>"` cell key (00 §4.4): both components are
 * signed 32-bit integers, no `+` sign, no leading zeros, `-0` normalized to
 * `0`. The cell size in metres is world configuration, never part of the key,
 * so a world cannot silently mix cell sizes.
 *
 * Changing canonicalization is a `WORLD_CELL_KEY_VERSION` bump (00 §4.1).
 */
export type CellKey = `${number},${number}`;

/**
 * Public residency projection (12 §3.3). The internal state machine reports
 * `queued`, `loading` and `decoding` as `"loading"`; `ready` and `resident`
 * as `"resident"`; `evicting` as `"evicting"`; `unloaded` and `failed` as
 * `"unloaded"`.
 */
export type CellState = "unloaded" | "loading" | "resident" | "evicting";

/**
 * Frozen world-cell projection (00 §3.5). This is what games and the SDK see;
 * internal residency states are never part of the public contract.
 */
export interface WorldCell {
  readonly id: WorldCellId;
  readonly key: CellKey;
  /** 0 = richest. */
  readonly lod: 0 | 1 | 2 | 3;
  readonly state: CellState;
  readonly bytes: number;
}
