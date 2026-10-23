/**
 * Babylon scene classes, isolated behind a dynamic import.
 *
 * `BabylonGameRenderer.init()` loads this module; importing the renderer in a
 * unit test therefore does not pull Babylon's module graph into the test
 * worker. The exports are the exact classes the adapter constructs.
 */
export { Scene } from "@babylonjs/core/scene";
export { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
export { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
export { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
export { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
export { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
export { Vector3 } from "@babylonjs/core/Maths/math.vector";
export { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
