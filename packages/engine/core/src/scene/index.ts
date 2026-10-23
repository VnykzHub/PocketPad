/**
 * Scene module entry (spec 03 §3).
 *
 * Value exports only: the matching public types are declared in the frozen
 * `contracts/scene.d.ts` and re-exported by the package entry. Exporting them
 * here as well would make `export *` ambiguous (TS2308).
 */

export { defineComponent } from "./component.js";
export { Transform, Parent, Renderable, Name } from "./builtins.js";
export { createScene } from "./Scene.js";
export { parsePrefab, instantiatePrefab } from "./Prefab.js";
export { EntityPool } from "./EntityPool.js";
