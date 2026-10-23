/**
 * GameWorld3D browser evidence (spec 22), stream A.
 *
 * Boots the Babylon adapter on a real GPU context, loads the tracked bake-off
 * pedestrian GLB through the model-provider seam, renders a model actor with
 * its `walk` clip, a thin-instance batch of the same model, and primitives.
 * The host frame boundary is exercised exactly as production uses it:
 * `beginFrame` / `endFrame` with one `world.update(1/60)` per fixed tick; this
 * page never starts a Babylon render loop.
 *
 * Every value in `window.__WORLD__` is read from Babylon at runtime; the
 * runner records it verbatim.
 */
import "@babylonjs/loaders/glTF/index.js";
import { Engine } from "@babylonjs/core/Engines/engine";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import { BabylonGameRenderer } from "../../../packages/runtime/src/babylon/BabylonGameRenderer.ts";
import { createAssetContainerModelSource } from "../../../packages/runtime/src/babylon/world3d/modelSource.ts";
import pedUrl from "../../bakeoff/assets/ped.glb?url";

const FIXED_STEP = 1 / 60;
const INSTANCE_COUNT = 8;
const PROP_COLORS = ["#b9543f", "#c9a24a", "#4f7f9c", "#7a5c99", "#3f8b66"];

const params = new URLSearchParams(location.search);
const requestedBackend =
  params.get("backend") === "webgl2" ? "webgl2" : "webgpu";

const statusElement = document.getElementById("status");
const state = {
  requestedBackend,
  backend: null,
  ready: false,
  error: null,
  userAgent: navigator.userAgent,
  crossOriginIsolated: self.crossOriginIsolated === true,
  gpu: null,
  modelClips: null,
  capabilities: null,
  instanceCount: 0,
  instanceMode: null,
  thinInstances: 0,
  clip: null,
  scene: null,
  camera: null,
  follow: null,
  actorAlive: false,
  frame: null,
  engineFps: null,
};
globalThis.__WORLD__ = state;

function setStatus(text) {
  if (statusElement !== null) {
    statusElement.textContent = text;
    statusElement.dataset.state = text;
  }
}

function describeError(error) {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

async function readGpuInfo() {
  if (typeof navigator.gpu === "undefined") return { webgpu: false };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    const info = adapter?.info;
    return {
      webgpu: true,
      adapter:
        info === undefined
          ? null
          : {
              vendor: info.vendor ?? null,
              architecture: info.architecture ?? null,
              device: info.device ?? null,
              description: info.description ?? null,
            },
    };
  } catch (error) {
    return { webgpu: true, error: describeError(error) };
  }
}

async function createEngine(canvas) {
  if (requestedBackend === "webgl2") {
    return new Engine(
      canvas,
      true,
      {
        preserveDrawingBuffer: true,
        stencil: true,
        powerPreference: "high-performance",
      },
      false,
    );
  }
  if (!(await WebGPUEngine.IsSupportedAsync)) {
    throw new Error("WebGPU is not supported in this browser session.");
  }
  const engine = new WebGPUEngine(canvas, {
    antialias: true,
    adaptToDeviceRatio: false,
  });
  await engine.initAsync();
  return engine;
}

function snapshot(scene, engine, world, actor, instances) {
  const started = scene.animationGroups.find(
    (group) => group.name === "walk" && group.isStarted,
  );
  const walk =
    started ?? scene.animationGroups.find((group) => group.name === "walk");
  if (walk !== undefined) {
    state.clip = {
      name: walk.name,
      started: walk.isStarted,
      weight: walk.weight,
      speedRatio: walk.speedRatio,
      currentFrame: walk.getCurrentFrame(),
    };
  }
  const thinMeshes = scene.meshes.filter((mesh) => mesh.thinInstanceCount > 0);
  state.thinInstances = thinMeshes.reduce(
    (total, mesh) => total + mesh.thinInstanceCount,
    0,
  );
  state.instanceMode = state.thinInstances > 0 ? "thin" : "pooled";
  state.instanceCount = instances.count;
  state.meshDetails = scene.meshes.map((mesh) => ({
    name: mesh.name,
    type: mesh.getClassName(),
    thin: mesh.thinInstanceCount,
    skeleton: mesh.skeleton === null ? null : mesh.skeleton.name,
    visible: mesh.isVisible,
    enabled: mesh.isEnabled(),
    vertices: mesh.getTotalVertices(),
    position: {
      x: mesh.position.x,
      y: mesh.position.y,
      z: mesh.position.z,
    },
  }));
  state.thinMatrices = thinMeshes.map((mesh) => ({
    name: mesh.name,
    matrices: (mesh.thinInstanceGetWorldMatrices?.() ?? []).map((matrix) => [
      matrix.m[12],
      matrix.m[13],
      matrix.m[14],
    ]),
  }));
  state.scene = {
    meshes: scene.meshes.length,
    activeMeshes: scene.getActiveMeshes().length,
    transformNodes: scene.transformNodes.length,
    animationGroups: scene.animationGroups.length,
    totalVertices: scene.getTotalVertices(),
  };
  const camera = scene.activeCamera;
  state.camera =
    camera === null
      ? null
      : {
          x: camera.position.x,
          y: camera.position.y,
          z: camera.position.z,
        };
  state.follow =
    camera === null
      ? null
      : {
          expected: { x: 0, y: 3.5, z: 7 },
          actual: state.camera,
          error: Math.hypot(
            camera.position.x,
            camera.position.y - 3.5,
            camera.position.z - 7,
          ),
        };
  state.engineFps = engine.getFps();
  state.capabilities = { ...world.capabilities };
  state.actorAlive = actor.alive;
  state.frame = state.frame === null ? 1 : state.frame + 1;
}

async function boot() {
  setStatus("gpu-info");
  state.gpu = await readGpuInfo();

  setStatus("engine");
  const canvas = document.createElement("canvas");
  canvas.className = "world-canvas";
  document.body.appendChild(canvas);

  const engine = await createEngine(canvas);
  const backend = requestedBackend === "webgl2" ? "webgl2" : "webgpu";
  state.backend = backend;

  const renderer = new BabylonGameRenderer(engine, canvas, backend, {
    label: "world-experiment",
    near: 0.1,
    far: 300,
  });
  await renderer.init(canvas);
  const scene = engine.scenes[0];
  if (scene === undefined) throw new Error("Babylon did not create a scene.");

  const applySize = () => {
    renderer.resize(window.innerWidth, window.innerHeight, 1);
  };
  applySize();
  window.addEventListener("resize", applySize);

  setStatus("loading ped.glb");
  const container = await LoadAssetContainerAsync(pedUrl, scene);
  state.modelClips = container.animationGroups.map((group) => group.name);
  const source = createAssetContainerModelSource(container);
  const provider = {
    hasModel(assetId) {
      return assetId === "ped";
    },
    getModel(assetId) {
      return assetId === "ped" ? source : null;
    },
  };

  setStatus("world");
  const world = renderer.createWorld({ provider });
  world.setSky("day");
  world.setSun({ x: -0.35, y: -1, z: -0.55 }, "#fff2dc", 2.4);
  world.setAmbient("#8aa0c0", 0.55);
  world.setFog("#c6d6ea", 25, 140);
  world.setShadowTier("low");
  if (world.capabilities.post) {
    world.setPost({ bloom: true, vignette: 0.3, grade: "warm" });
  }
  world.setCamera({ x: 0, y: 3.5, z: 7 }, { x: 0, y: 0, z: 0 }, 60);

  setStatus("primitives");
  world.createPrimitive("ground", { size: 40, color: "#59674e" });
  for (let index = 0; index < PROP_COLORS.length; index += 1) {
    const box = world.createPrimitive("box", {
      size: 1.2 + index * 0.25,
      color: PROP_COLORS[index],
    });
    box.setPosition(-6 + index * 3, 0.6 + index * 0.12, -6);
    box.setYaw(index * 0.4);
  }
  const sphere = world.createPrimitive("sphere", {
    radius: 0.9,
    segments: 24,
    color: "#e0d5b0",
  });
  sphere.setPosition(5, 0.9, -2);
  const cylinder = world.createPrimitive("cylinder", {
    radius: 0.6,
    height: 2.4,
    segments: 24,
    color: "#8e9aa8",
  });
  cylinder.setPosition(-5, 1.2, -2);

  setStatus("model");
  const actor = world.spawnModel("ped");
  actor.setPosition(0, 0, 0);
  actor.setYaw(0);
  actor.playClip("walk", { loop: true, speed: 1 });

  setStatus("instances");
  const instances = world.spawnInstances("ped", INSTANCE_COUNT);
  for (let index = 0; index < INSTANCE_COUNT; index += 1) {
    instances.setTransform(index, -7 + index * 2, 0, -4, Math.PI, 1);
  }
  state.instanceCount = instances.count;

  world.follow(actor, {
    distance: 7,
    height: 3.5,
    lookAhead: 2,
    smoothing: 4,
  });
  world.update(FIXED_STEP);

  let last = performance.now();
  let accumulator = 0;
  let elapsed = 0;
  let frameCount = 0;

  const frame = (now) => {
    const delta = Math.min((now - last) / 1000, 0.25);
    last = now;
    accumulator += delta;
    while (accumulator >= FIXED_STEP) {
      world.update(FIXED_STEP);
      accumulator -= FIXED_STEP;
      elapsed += FIXED_STEP;
    }
    renderer.beginFrame(0);
    renderer.endFrame();
    frameCount += 1;
    if (frameCount % 20 === 0) {
      snapshot(scene, engine, world, actor, instances);
    }
    if (!state.ready && elapsed >= 1.5) {
      snapshot(scene, engine, world, actor, instances);
      if (state.clip?.started === true) {
        state.ready = true;
        globalThis.__WORLD_READY__ = true;
        setStatus(`ready · ${backend}`);
      }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

async function main() {
  await boot();
}

main().catch((error) => {
  state.error = describeError(error);
  setStatus("error");
  console.error(error);
});
