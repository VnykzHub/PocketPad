/**
 * Shared Babylon visuals used by both physics backends.
 *
 * Keeping one render module means the frame-cost comparison renders exactly
 * the same meshes, materials and camera for Havok and Rapier; the only
 * difference in a measured frame is the physics step and its transform sync.
 */

import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";

const COLORS = {
  ground: new Color3(0.16, 0.18, 0.2),
  car: new Color3(0.85, 0.15, 0.12),
  wheel: new Color3(0.05, 0.05, 0.06),
  character: new Color3(0.16, 0.72, 0.72),
  "bench-a": new Color3(0.28, 0.5, 0.85),
  "bench-b": new Color3(0.9, 0.55, 0.18),
  slate: new Color3(0.42, 0.44, 0.48),
};

const materialCache = new WeakMap();

export function createEngine(canvas) {
  return new Engine(canvas, true, {
    preserveDrawingBuffer: true,
    stencil: false,
    antialias: false,
    powerPreference: "high-performance",
    alpha: false,
  });
}

export function createScene(engine) {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.055, 0.065, 0.085, 1);
  const camera = new ArcRotateCamera(
    "spike-camera",
    Math.PI / 2,
    1.15,
    24,
    new Vector3(0, 1, 0),
    scene,
  );
  camera.minZ = 0.1;
  camera.maxZ = 300;
  camera.fov = 0.9;
  const hemi = new HemisphericLight("spike-hemi", new Vector3(0, 1, 0), scene);
  hemi.intensity = 0.75;
  const sun = new DirectionalLight("spike-sun", new Vector3(-0.45, -1, 0.4), scene);
  sun.intensity = 1.15;
  return { scene, camera, hemi, sun };
}

function material(scene, colorKey) {
  let byKey = materialCache.get(scene);
  if (!byKey) {
    byKey = new Map();
    materialCache.set(scene, byKey);
  }
  let mat = byKey.get(colorKey);
  if (!mat) {
    mat = new StandardMaterial(`spike-mat-${colorKey}`, scene);
    mat.diffuseColor = COLORS[colorKey] ?? new Color3(0.7, 0.7, 0.7);
    mat.specularColor = new Color3(0.06, 0.06, 0.06);
    byKey.set(colorKey, mat);
  }
  return mat;
}

export function makeBoxMesh(scene, name, halfExtents, colorKey) {
  const mesh = MeshBuilder.CreateBox(
    name,
    {
      width: halfExtents.x * 2,
      height: halfExtents.y * 2,
      depth: halfExtents.z * 2,
    },
    scene,
  );
  mesh.material = material(scene, colorKey);
  return mesh;
}

export function makeCarVisual(scene) {
  const root = new TransformNode("spike-car", scene);
  const chassis = MeshBuilder.CreateBox(
    "spike-car-chassis",
    { width: 1.9, height: 1.0, depth: 4.2 },
    scene,
  );
  chassis.material = material(scene, "car");
  chassis.parent = root;
  const wheels = [];
  for (let i = 0; i < 4; i += 1) {
    const wheel = MeshBuilder.CreateCylinder(
      `spike-car-wheel-${i}`,
      { height: 0.25, diameter: 0.7, tessellation: 14 },
      scene,
    );
    wheel.material = material(scene, "wheel");
    wheel.parent = root;
    wheel.rotation.z = Math.PI / 2;
    wheels.push(wheel);
  }
  return { root, chassis, wheels };
}

export function makeCharacterVisual(scene) {
  const mesh = MeshBuilder.CreateCapsule(
    "spike-character",
    { height: 1.8, radius: 0.3, tessellation: 12 },
    scene,
  );
  mesh.material = material(scene, "character");
  return mesh;
}

export function setCameraFocus(camera, position) {
  camera.target.set(position.x, position.y + 0.7, position.z);
  camera.alpha = Math.PI / 2;
  camera.beta = 1.18;
  camera.radius = 13;
}

export function setCameraBench(camera) {
  camera.target.set(0, 1.4, 0);
  camera.alpha = Math.PI / 2;
  camera.beta = 1.0;
  camera.radius = 26;
}

export function describeRenderer(engine) {
  try {
    const gl = engine._gl;
    const extension = gl?.getExtension("WEBGL_debug_renderer_info");
    return {
      webglVersion: gl ? gl.getParameter(gl.VERSION) : null,
      vendor: extension ? gl.getParameter(extension.UNMASKED_VENDOR_WEBGL) : null,
      renderer: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null,
      api: "WebGL2",
    };
  } catch (error) {
    return { error: String(error) };
  }
}
