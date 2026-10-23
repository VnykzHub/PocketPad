/**
 * `@lanpad/engine-renderer-webgl2/canvas2d` public 2D entry.
 *
 * Kept separate from the 3D entry so importing a 2D-only build never pulls the
 * WebGL2 shader set (05 §3.1). Exports the Canvas2D contract types and the
 * Tier C implementation.
 */

export type * from "./contracts/canvas2d.js";

export { createCanvas2DDevice } from "./canvas2d/device.js";
export { CANVAS2D_BACKGROUND } from "./canvas2d/draw2d.js";
