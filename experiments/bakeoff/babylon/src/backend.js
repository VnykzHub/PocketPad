// Babylon.js backend for the bake-off scene. Every Babylon import lives here;
// main.js sees only plain data and a small method surface, which is the
// "behind GameContext without engine types" evidence (checklist item 10).

import { Engine } from '@babylonjs/core/Engines/engine';
import { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine';
import { Scene } from '@babylonjs/core/scene';
import { Vector3, Quaternion } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { Axis, Space } from '@babylonjs/core/Maths/math.axis';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import { CascadedShadowGenerator } from '@babylonjs/core/Lights/Shadows/cascadedShadowGenerator';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { loadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader';
import '@babylonjs/loaders/glTF';
import { SkyMaterial } from '@babylonjs/materials/sky/skyMaterial';
import HavokPhysics from '@babylonjs/havok';
import { HavokPlugin } from '@babylonjs/core/Physics/v2/Plugins/havokPlugin';
import '@babylonjs/core/Physics/physicsEngineComponent';
import { PhysicsBody } from '@babylonjs/core/Physics/v2/physicsBody';
import { PhysicsShapeBox } from '@babylonjs/core/Physics/v2/physicsShape';
import { PhysicsMotionType } from '@babylonjs/core/Physics/v2/IPhysicsEnginePlugin';
import { PhysicsCharacterController } from '@babylonjs/core/Physics/v2/characterController';
import { Sound } from '@babylonjs/core/Audio/sound';

const GRAVITY = new Vector3(0, -9.81, 0);
const DOWN = new Vector3(0, -1, 0);
const CELL_SIZE_FALLBACK = 64;
const CAR_SPEED = 20; // m/s, fixed scripted run (README)
const PED_SPEED = 1.2; // m/s (README)
const PED_COUNT = 50;
const BUILDING_COUNT = 14;
const CAR_MASS = 1250;

// ---------------------------------------------------------------------------
// Layout

function syntheticLayout() {
  const origin = { x: -96, y: 0, z: -96 };
  const buildings = [];
  const slots = [];
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      slots.push({ x: 12 + col * 12, z: 12 + row * 12 });
    }
  }
  // 14 of the 16 slots in the centre cell (1,1), heights 12-28 m.
  // Positions are cell-local, as the layout contract specifies.
  const dropped = new Set([2, 13]);
  let index = 0;
  for (let i = 0; i < slots.length; i++) {
    if (dropped.has(i)) continue;
    const slot = slots[i];
    buildings.push({
      cell: '1,1',
      x: slot.x,
      z: slot.z,
      height: 12 + ((index * 7) % 17),
    });
    index++;
  }
  const pedestrians = [];
  for (let i = 0; i < PED_COUNT; i++) {
    const cx = i % 3; // south row: cells (0,2), (1,2), (2,2)
    pedestrians.push({
      cell: `${cx},2`,
      x: 10 + ((i * 13) % 44),
      z: 10 + ((i * 17) % 44),
      waypoint: i % 4,
    });
  }
  return {
    cellSizeMeters: 64,
    origin,
    buildings,
    pedestrians,
    car: { x: 0, y: 0.5, z: 32, yaw: 0 },
    cameraPath: [
      { x: 0, z: 32 },
      { x: 32, z: 0 },
      { x: 0, z: -32 },
      { x: -32, z: 0 },
    ],
    runSeconds: 60,
  };
}

async function fetchLayout(assetBase) {
  const response = await fetch(new URL('layout.json', assetBase));
  if (!response.ok) throw new Error(`layout.json HTTP ${response.status}`);
  return await response.json();
}

function normalizeLayout(raw) {
  const layout = {
    cellSizeMeters: Number(raw.cellSizeMeters) || CELL_SIZE_FALLBACK,
    origin: {
      x: Number(raw.origin?.x) || 0,
      y: Number(raw.origin?.y) || 0,
      z: Number(raw.origin?.z) || 0,
    },
    buildings: Array.isArray(raw.buildings) ? raw.buildings : [],
    pedestrians: Array.isArray(raw.pedestrians) ? raw.pedestrians.slice(0, PED_COUNT) : [],
    car: raw.car ?? { x: 0, y: 0.5, z: 32, yaw: 0 },
    cameraPath: Array.isArray(raw.cameraPath) ? raw.cameraPath : [],
    runSeconds: Number(raw.runSeconds) || 60,
  };
  const fallback = syntheticLayout();
  // Fill a short pedestrian list from the synthetic south-cell layout.
  for (let i = layout.pedestrians.length; i < PED_COUNT; i++) {
    layout.pedestrians.push(fallback.pedestrians[i]);
  }
  return layout;
}

function cellKeyFor(x, z, layout) {
  const cx = Math.floor((x - layout.origin.x) / layout.cellSizeMeters);
  const cy = Math.floor((z - layout.origin.z) / layout.cellSizeMeters);
  return `${cx},${cy}`;
}

/**
 * Layout building/pedestrian positions are cell-local (0..64) with the cell
 * given separately; cameraPath and car are world-space. Returns world X/Z.
 */
function cellWorld(spec, layout) {
  const [cx, cy] = String(spec.cell ?? '0,0').split(',').map(Number);
  const column = Number.isFinite(cx) ? cx : 0;
  const row = Number.isFinite(cy) ? cy : 0;
  return {
    x: layout.origin.x + column * layout.cellSizeMeters + Number(spec.x),
    z: layout.origin.z + row * layout.cellSizeMeters + Number(spec.z),
  };
}

function cellsAreNeighbours(a, b) {
  const [ax, ay] = a.split(',').map(Number);
  const [bx, by] = b.split(',').map(Number);
  return Math.abs(ax - bx) <= 1 && Math.abs(ay - by) <= 1;
}

// ---------------------------------------------------------------------------
// Ring path: rounded square on the 12 m road ring centred at x/z = ±32.

function createRingPath() {
  const R = 10;
  const points = [];
  const pushLine = (x0, z0, x1, z1, step = 2) => {
    const distance = Math.hypot(x1 - x0, z1 - z0);
    const count = Math.max(1, Math.ceil(distance / step));
    for (let i = 0; i < count; i++) {
      const t = i / count;
      points.push({ x: x0 + (x1 - x0) * t, z: z0 + (z1 - z0) * t });
    }
  };
  const pushArc = (cx, cz, a0, a1, step = 0.09) => {
    const count = Math.max(1, Math.ceil(Math.abs(a1 - a0) / step));
    for (let i = 0; i < count; i++) {
      const a = a0 + ((a1 - a0) * i) / count;
      points.push({ x: cx + R * Math.cos(a), z: cz + R * Math.sin(a) });
    }
  };

  // Start on the south road at (0, 32), heading +x.
  pushLine(0, 32, 22, 32);
  pushArc(22, 22, Math.PI / 2, 0);
  pushLine(32, 22, 32, -22);
  pushArc(22, -22, 0, -Math.PI / 2);
  pushLine(22, -32, -22, -32);
  pushArc(-22, -22, -Math.PI / 2, -Math.PI);
  pushLine(-32, -22, -32, 22);
  pushArc(-22, 22, Math.PI, Math.PI * 1.5);
  pushLine(-22, 32, 0, 32);

  const cumulative = new Float64Array(points.length + 1);
  for (let i = 0; i < points.length; i++) {
    const next = points[(i + 1) % points.length];
    cumulative[i + 1] = cumulative[i] + Math.hypot(next.x - points[i].x, next.z - points[i].z);
  }
  const length = cumulative[points.length];

  function sampleInto(s, out) {
    let wrapped = s % length;
    if (wrapped < 0) wrapped += length;
    let low = 0;
    let high = points.length;
    while (low < high - 1) {
      const mid = (low + high) >> 1;
      if (cumulative[mid] <= wrapped) low = mid;
      else high = mid;
    }
    const a = points[low];
    const b = points[(low + 1) % points.length];
    const segment = cumulative[low + 1] - cumulative[low] || 1e-6;
    const t = (wrapped - cumulative[low]) / segment;
    out.x = a.x + (b.x - a.x) * t;
    out.z = a.z + (b.z - a.z) * t;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const d = Math.hypot(dx, dz) || 1;
    out.tx = dx / d;
    out.tz = dz / d;
    return out;
  }

  function nearestS(x, z) {
    let best = Infinity;
    let bestS = 0;
    for (let i = 0; i < points.length; i++) {
      const dx = points[i].x - x;
      const dz = points[i].z - z;
      const d = dx * dx + dz * dz;
      if (d < best) {
        best = d;
        bestS = cumulative[i];
      }
    }
    return bestS;
  }

  return { length, sampleInto, nearestS };
}

/** Closed polyline path from layout.cameraPath (world-space metres). */
function createClosedPath(points) {
  const unique = [];
  for (const point of points) {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.z)) continue;
    const previous = unique[unique.length - 1];
    if (previous && Math.hypot(point.x - previous.x, point.z - previous.z) < 0.01) continue;
    unique.push({ x: point.x, z: point.z });
  }
  if (unique.length > 1) {
    const first = unique[0];
    const last = unique[unique.length - 1];
    if (Math.hypot(last.x - first.x, last.z - first.z) < 0.01) unique.pop();
  }
  if (unique.length < 2) return createRingPath();

  const cumulative = new Float64Array(unique.length + 1);
  for (let i = 0; i < unique.length; i++) {
    const next = unique[(i + 1) % unique.length];
    cumulative[i + 1] = cumulative[i] + Math.hypot(next.x - unique[i].x, next.z - unique[i].z);
  }
  const length = cumulative[unique.length];

  function sampleInto(s, out) {
    let wrapped = s % length;
    if (wrapped < 0) wrapped += length;
    let low = 0;
    let high = unique.length;
    while (low < high - 1) {
      const mid = (low + high) >> 1;
      if (cumulative[mid] <= wrapped) low = mid;
      else high = mid;
    }
    const a = unique[low];
    const b = unique[(low + 1) % unique.length];
    const segment = cumulative[low + 1] - cumulative[low] || 1e-6;
    const t = (wrapped - cumulative[low]) / segment;
    out.x = a.x + (b.x - a.x) * t;
    out.z = a.z + (b.z - a.z) * t;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const d = Math.hypot(dx, dz) || 1;
    out.tx = dx / d;
    out.tz = dz / d;
    return out;
  }

  function nearestS(x, z) {
    let best = Infinity;
    let bestS = 0;
    for (let i = 0; i < unique.length; i++) {
      const dx = unique[i].x - x;
      const dz = unique[i].z - z;
      const d = dx * dx + dz * dz;
      if (d < best) {
        best = d;
        bestS = cumulative[i];
      }
    }
    return bestS;
  }

  return { length, sampleInto, nearestS };
}

// ---------------------------------------------------------------------------
// Procedural fallback art (used only until assets/*.glb exist; recorded in
// metrics.errors so no run can mistake it for the contract scene).

function fallbackMaterial(scene, name, color) {
  const material = new StandardMaterial(name, scene);
  material.diffuseColor = color;
  material.specularColor = new Color3(0.04, 0.04, 0.04);
  material.ambientColor = color.scale(0.25);
  return material;
}

function createFallbackCar(scene) {
  const body = MeshBuilder.CreateBox('car-body', { width: 1.8, height: 0.7, depth: 4.2 }, scene);
  body.position.y = 0;
  body.material = fallbackMaterial(scene, 'car-body-mat', new Color3(0.72, 0.16, 0.12));
  const wheels = [];
  const wheelNames = ['wheel-fl', 'wheel-fr', 'wheel-rl', 'wheel-rr'];
  const offsets = [
    [-0.9, -1.4],
    [0.9, -1.4],
    [-0.9, 1.4],
    [0.9, 1.4],
  ];
  for (let i = 0; i < 4; i++) {
    const wheel = MeshBuilder.CreateCylinder(wheelNames[i], { diameter: 0.7, height: 0.3, tessellation: 16 }, scene);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(offsets[i][0], -0.15, offsets[i][1]);
    wheel.material = fallbackMaterial(scene, `${wheelNames[i]}-mat`, new Color3(0.08, 0.08, 0.09));
    wheels.push(wheel);
  }
  return { body, wheels };
}

function createFallbackPed(scene, index) {
  const mesh = MeshBuilder.CreateCapsule(`ped-${index}-body`, { height: 1.7, radius: 0.3 }, scene);
  mesh.position.y = 0.85;
  mesh.material = fallbackMaterial(scene, `ped-${index}-mat`, new Color3(0.25, 0.45, 0.65));
  return mesh;
}

function collectMeshes(rootNodes) {
  const meshes = [];
  for (const root of rootNodes) {
    if (root.getTotalVertices) meshes.push(root);
    if (root.getChildMeshes) meshes.push(...root.getChildMeshes(false));
  }
  return meshes;
}

// ---------------------------------------------------------------------------
// Backend

export async function createBabylonBackend({ canvas, metrics, assetBase, havokWasmUrl, forceBackend }) {
  const errors = metrics.errors;
  const info = {
    backend: 'unknown',
    backendInfo: '',
    softwareRenderer: false,
    assetSource: 'unknown',
    assets: {},
  };
  const pushError = (context, error) => {
    const detail = error && error.stack ? error.stack : String(error);
    errors.push(`${context}: ${detail}`);
    console.error(`[bakeoff] ${context}`, error);
  };

  // --- Engine: WebGPU first, WebGL2 fallback, never a silent software run ---
  let engine = null;
  try {
    if (forceBackend !== 'webgl2' && (await WebGPUEngine.IsSupportedAsync)) {
      const gpu = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: false });
      await gpu.initAsync();
      engine = gpu;
      info.backend = 'webgpu';
      if (gpu._adapterInfo) {
        info.backendInfo = [gpu._adapterInfo.vendor, gpu._adapterInfo.architecture, gpu._adapterInfo.description]
          .filter(Boolean)
          .join(' · ');
      } else {
        info.backendInfo = 'webgpu adapter';
      }
    }
  } catch (error) {
    pushError('webgpu-init', error);
    engine = null;
  }
  if (!engine) {
    engine = new Engine(
      canvas,
      true,
      { preserveDrawingBuffer: true, stencil: true, powerPreference: 'high-performance' },
      false,
    );
    info.backend = 'webgl2';
    const gl = engine._gl;
    const debug = gl && gl.getExtension('WEBGL_debug_renderer_info');
    info.backendInfo = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : String(gl?.getParameter(gl.RENDERER) ?? '');
  }
  engine.setHardwareScalingLevel(1);
  info.softwareRenderer = /swiftshader|software|llvmpipe|basic render/i.test(info.backendInfo);
  if (info.softwareRenderer) pushError('software-renderer', new Error(info.backendInfo));

  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.52, 0.67, 0.86, 1);
  scene.skipPointerMovePicking = true;
  scene.autoClear = true;

  // --- Physics: Havok, Babylon's first-party plugin ---
  let physicsOk = false;
  try {
    const havok = await HavokPhysics({ locateFile: () => havokWasmUrl });
    scene.enablePhysics(GRAVITY.clone(), new HavokPlugin(true, havok));
    scene.getPhysicsEngine().setTimeStep(1 / 60);
    physicsOk = true;
  } catch (error) {
    pushError('havok-init', error);
  }

  // --- Layout ---
  let layout;
  try {
    layout = normalizeLayout(await fetchLayout(assetBase));
    info.assetSource = 'assets/layout.json';
  } catch (error) {
    pushError('layout', error);
    layout = syntheticLayout();
    info.assetSource = 'synthetic-fallback';
  }
  if (layout.buildings.length !== BUILDING_COUNT) {
    errors.push(`layout-buildings: expected ${BUILDING_COUNT}, got ${layout.buildings.length}`);
  }
  if (layout.pedestrians.length !== PED_COUNT) {
    errors.push(`layout-pedestrians: expected ${PED_COUNT}, got ${layout.pedestrians.length}`);
  }

  // --- Asset containers ---
  const containers = {};
  async function loadContainer(file, key) {
    try {
      const container = await loadAssetContainerAsync(new URL(file, assetBase).href, scene, {
        pluginExtension: '.glb',
      });
      containers[key] = container;
      info.assets[key] = true;
      return container;
    } catch (error) {
      info.assets[key] = false;
      pushError(`asset-missing:${file}`, error);
      return null;
    }
  }
  const groundContainer = await loadContainer('ground.glb', 'ground');
  const buildingContainer = await loadContainer('building.glb', 'building');
  const carContainer = await loadContainer('car.glb', 'car');
  const pedContainer = await loadContainer('ped.glb', 'ped');

  // --- Camera (created before CSM, which reads the active camera) ---
  // layout.cameraPath is world-space; layout.car is the start of that path.
  const carStart = layout.car ?? { x: 0, y: 0.5, z: 32, yaw: 0 };
  const path =
    layout.cameraPath.length >= 2
      ? createClosedPath(layout.cameraPath)
      : createRingPath();
  let carS = path.nearestS(carStart.x, carStart.z);
  const camera = new FreeCamera('chase-camera', new Vector3(carStart.x, 8, carStart.z + 14), scene);
  camera.minZ = 0.1;
  camera.maxZ = 1200;
  camera.fov = 0.85;
  scene.activeCamera = camera;
  {
    const ahead = path.sampleInto(carS, { x: 0, z: 0, tx: 1, tz: 0 });
    camera.position.set(carStart.x - ahead.tx * 14, (carStart.y ?? 0.5) + 7.5, carStart.z - ahead.tz * 14);
    camera.setTarget(new Vector3(carStart.x + ahead.tx * 8, (carStart.y ?? 0.5) + 1.5, carStart.z + ahead.tz * 8));
  }

  // --- Sky, lights, shadows ---
  const skybox = MeshBuilder.CreateBox('skybox', { size: 1500 }, scene);
  skybox.infiniteDistance = true;
  skybox.isPickable = false;
  const skyMaterial = new SkyMaterial('sky-material', scene);
  skyMaterial.backFaceCulling = false;
  skyMaterial.useSunPosition = true;
  skyMaterial.sunPosition = new Vector3(-0.55, 0.35, -0.25);
  skyMaterial.turbidity = 6;
  skyMaterial.luminance = 0.92;
  skyMaterial.mieDirectionalG = 0.8;
  skyMaterial.rayleigh = 2;
  skybox.material = skyMaterial;

  const sun = new DirectionalLight('sun', new Vector3(-0.55, -1, -0.35), scene);
  sun.position = new Vector3(50, 90, 40);
  sun.intensity = 2.1;
  const fill = new HemisphericLight('fill', new Vector3(0, 1, 0), scene);
  fill.intensity = 0.35;
  fill.groundColor = new Color3(0.18, 0.2, 0.16);

  let shadows = null;
  let shadowMode = 'none';
  try {
    const cascaded = new CascadedShadowGenerator(1024, sun, false, camera, true);
    cascaded.numCascades = 2;
    cascaded.lambda = 0.8;
    cascaded.shadowMaxZ = 260;
    cascaded.cascadeBlendPercentage = 0.1;
    cascaded.usePercentageCloserFiltering = true;
    cascaded.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
    cascaded.bias = 0.008;
    shadows = cascaded;
    shadowMode = 'cascaded';
  } catch (error) {
    pushError('cascaded-shadows', error);
    try {
      const basic = new ShadowGenerator(1024, sun);
      basic.usePercentageCloserFiltering = true;
      basic.bias = 0.008;
      shadows = basic;
      shadowMode = 'basic';
    } catch (inner) {
      pushError('shadow-generator', inner);
    }
  }
  const addShadowMeshes = (root) => {
    if (!shadows) return;
    if (root.getTotalVertices) shadows.addShadowCaster(root, false);
    if (root.getChildMeshes) {
      for (const mesh of root.getChildMeshes(false)) shadows.addShadowCaster(mesh, false);
    }
  };

  // --- Ground + static collider ---
  let groundMesh = null;
  if (groundContainer) {
    groundContainer.addAllToScene();
    for (const mesh of groundContainer.meshes) {
      mesh.isPickable = false;
      mesh.receiveShadows = true;
      if (!groundMesh && mesh.getTotalVertices() > 0) groundMesh = mesh;
    }
  }
  if (!groundMesh) {
    groundMesh = MeshBuilder.CreateGround('ground', { width: 192, height: 192 }, scene);
    groundMesh.material = fallbackMaterial(scene, 'ground-mat', new Color3(0.3, 0.34, 0.28));
    groundMesh.isPickable = false;
    groundMesh.receiveShadows = true;
  }

  // 12 m ring road with centre lines at x/z = +/-32 (README scene contract).
  // Four non-overlapping strips: the side strips stop at the inner edge of the
  // south/north strips, so no coplanar overlap and no z-fighting at the corners.
  const roadMaterial = fallbackMaterial(scene, 'road-mat', new Color3(0.105, 0.11, 0.12));
  roadMaterial.specularColor = new Color3(0.02, 0.02, 0.02);
  const roadStrips = [
    ['road-south', 76, 12, 0, 32],
    ['road-north', 76, 12, 0, -32],
    ['road-west', 12, 52, -32, 0],
    ['road-east', 12, 52, 32, 0],
  ];
  for (const [name, width, depth, x, z] of roadStrips) {
    const road = MeshBuilder.CreateGround(name, { width, height: depth }, scene);
    road.position.set(x, 0.01, z);
    road.material = roadMaterial;
    road.isPickable = false;
    road.receiveShadows = true;
  }

  if (physicsOk) {
    const colliderRoot = new TransformNode('ground-collider', scene);
    const body = new PhysicsBody(colliderRoot, PhysicsMotionType.STATIC, false, scene);
    body.shape = new PhysicsShapeBox(new Vector3(0, -0.25, 0), Quaternion.Identity(), new Vector3(192, 0.5, 192), scene);
    body.shape.material = { friction: 0.9, restitution: 0.02 };
  }

  const streamables = [];
  let activations = 0;
  let deactivations = 0;

  // --- Buildings ---
  const buildingPalette = [
    new Color3(0.55, 0.58, 0.62),
    new Color3(0.62, 0.55, 0.45),
    new Color3(0.45, 0.55, 0.6),
    new Color3(0.66, 0.5, 0.42),
  ];
  layout.buildings.forEach((spec, index) => {
    const wrapper = new TransformNode(`building-${index}`, scene);
    const world = cellWorld(spec, layout);
    wrapper.position.set(world.x, 0, world.z);
    if (
      spec.x < 0 || spec.x >= layout.cellSizeMeters ||
      spec.z < 0 || spec.z >= layout.cellSizeMeters ||
      !spec.cell
    ) {
      errors.push(`layout-cell: building ${index} has invalid cell-local position (${spec.x}, ${spec.z}) in cell ${spec.cell}`);
    }
    let rootNodes = [];
    if (buildingContainer) {
      const entry = buildingContainer.instantiateModelsToScene((name) => `building-${index}-${name}`, false);
      rootNodes = entry.rootNodes;
      for (const root of rootNodes) root.parent = wrapper;
      wrapper.computeWorldMatrix(true);
      const initial = wrapper.getHierarchyBoundingVectors(true);
      const size = initial.max.subtract(initial.min);
      if (size.y > 1e-4 && size.x > 1e-4 && size.z > 1e-4) {
        wrapper.scaling.set(8 / size.x, spec.height / size.y, 8 / size.z);
      }
      wrapper.computeWorldMatrix(true);
      const scaled = wrapper.getHierarchyBoundingVectors(true);
      wrapper.position.y -= scaled.min.y;
    } else {
      const box = MeshBuilder.CreateBox(`building-${index}-box`, { width: 8, height: spec.height, depth: 8 }, scene);
      box.position.y = spec.height / 2;
      box.parent = wrapper;
      box.material = fallbackMaterial(scene, `building-${index}-mat`, buildingPalette[index % buildingPalette.length]);
      rootNodes = [box];
    }
    const cell = spec.cell ?? cellKeyFor(world.x, world.z, layout);
    for (const root of rootNodes) {
      if (root.getTotalVertices) root.receiveShadows = true;
      if (root.getChildMeshes) for (const mesh of root.getChildMeshes(false)) mesh.receiveShadows = true;
      addShadowMeshes(root);
    }
    // No building collider: the scripted cameraPath crosses the centre cell,
    // and world collision is not a bake-off requirement. Documented in CHECKLIST.
    wrapper.setEnabled(false);
    streamables.push({ key: `building-${index}`, cell, root: wrapper, active: false, anim: null });
  });

  // --- Car ---
  const carRoot = new TransformNode('car', scene);
  carRoot.position.set(carStart.x, carStart.y ?? 0.5, carStart.z);
  carRoot.rotationQuaternion = Quaternion.RotationYawPitchRoll(carStart.yaw ?? 0, 0, 0);
  let wheelMeshes = [];
  let carAudioAnchor = null;
  if (carContainer) {
    const entry = carContainer.instantiateModelsToScene((name) => `car-${name}`, false);
    for (const root of entry.rootNodes) root.parent = carRoot;
    // car.glb origin is the chassis centre and the wheels reach y = -0.5, so
    // placing carRoot at y = 0.5 puts the tyres on the ground. Do not re-align.
    const meshes = collectMeshes(entry.rootNodes);
    carAudioAnchor = meshes.find((mesh) => mesh.getTotalVertices() > 0) ?? null;
    wheelMeshes = meshes.filter((mesh) => /wheel-(fl|fr|rl|rr)/i.test(mesh.name));
    if (wheelMeshes.length !== 4) {
      errors.push(`car-wheels: expected 4 named wheel nodes, found ${wheelMeshes.length}`);
    }
    for (const mesh of meshes) {
      mesh.receiveShadows = true;
      if (shadows) shadows.addShadowCaster(mesh, false);
    }
  } else {
    const fallback = createFallbackCar(scene);
    fallback.body.parent = carRoot;
    for (const wheel of fallback.wheels) wheel.parent = carRoot;
    wheelMeshes = fallback.wheels;
    carAudioAnchor = fallback.body;
    addShadowMeshes(fallback.body);
  }

  let carBody = null;
  if (physicsOk) {
    carBody = new PhysicsBody(carRoot, PhysicsMotionType.DYNAMIC, false, scene);
    carBody.shape = new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), new Vector3(1.9, 1.0, 4.2), scene);
    carBody.shape.material = { friction: 0.8, restitution: 0.02 };
    carBody.setMassProperties({ mass: CAR_MASS });
    carBody.setLinearDamping(0.12);
    carBody.setAngularDamping(0.5);
  }

  // --- Pedestrians ---
  const peds = [];
  layout.pedestrians.forEach((spec, index) => {
    const wrapper = new TransformNode(`ped-${index}`, scene);
    const cellSize = layout.cellSizeMeters;
    const world = cellWorld(spec, layout);
    const [column, row] = String(spec.cell ?? '0,0').split(',').map(Number);
    const cellMinX = layout.origin.x + (Number.isFinite(column) ? column : 0) * cellSize;
    const cellMinZ = layout.origin.z + (Number.isFinite(row) ? row : 0) * cellSize;
    const centerX = clamp(world.x, cellMinX + 6, cellMinX + cellSize - 6);
    const centerZ = clamp(world.z, cellMinZ + 6, cellMinZ + cellSize - 6);
    const startAngle = ((spec.waypoint ?? 0) / 4) * Math.PI * 2;
    const waypoints = [];
    for (let w = 0; w < 4; w++) {
      const angle = startAngle + (w / 4) * Math.PI * 2;
      waypoints.push({ x: centerX + Math.cos(angle) * 3.5, z: centerZ + Math.sin(angle) * 3.5 });
    }
    let animation = null;
    let visualMesh = null;
    if (pedContainer) {
      const entry = pedContainer.instantiateModelsToScene((name) => `ped-${index}-${name}`, false);
      for (const root of entry.rootNodes) root.parent = wrapper;
      animation = entry.animationGroups.find((group) => /walk/i.test(group.name)) ?? entry.animationGroups[0] ?? null;
      if (!animation) errors.push('ped-animation: ped.glb has no animation group');
      visualMesh = entry.rootNodes.find((root) => root.getTotalVertices) ?? null;
    } else {
      visualMesh = createFallbackPed(scene, index);
      visualMesh.parent = wrapper;
    }
    let controller = null;
    if (physicsOk) {
      try {
        controller = new PhysicsCharacterController(
          new Vector3(waypoints[0].x, 1.0, waypoints[0].z),
          { capsuleRadius: 0.3, capsuleHeight: 1.8, characterMass: 70 },
          scene,
        );
      } catch (error) {
        pushError('ped-controller', error);
      }
    }
    wrapper.position.set(waypoints[0].x, 0, waypoints[0].z);
    wrapper.setEnabled(false);
    peds.push({
      index,
      wrapper,
      cell: spec.cell ?? cellKeyFor(world.x, world.z, layout),
      waypoints,
      waypoint: ((spec.waypoint ?? 0) + 1) % 4,
      animation,
      controller,
      active: false,
    });
    if (visualMesh) visualMesh.receiveShadows = false; // peds do not cast (draw-call budget)
  });

  // --- Positional audio: generated engine loop, no external asset ---
  let engineSound = null;
  try {
    const wav = makeEngineWav();
    const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
    engineSound = new Sound('engine-loop', url, scene, null, {
      loop: true,
      autoplay: false,
      spatialSound: true,
      maxDistance: 80,
      refDistance: 6,
      rolloffFactor: 1.2,
    });
    if (carAudioAnchor) engineSound.attachToMesh(carAudioAnchor);
  } catch (error) {
    pushError('audio-init', error);
  }

  // --- Streaming ---
  const activeCellsCache = { key: '' };
  function applyStreaming(cameraX, cameraZ) {
    const cameraCell = cellKeyFor(cameraX, cameraZ, layout);
    if (cameraCell === activeCellsCache.key) return;
    activeCellsCache.key = cameraCell;
    for (const item of streamables) {
      const shouldBeActive = cellsAreNeighbours(item.cell, cameraCell);
      if (shouldBeActive === item.active) continue;
      item.active = shouldBeActive;
      item.root.setEnabled(shouldBeActive);
      if (shouldBeActive) {
        activations++;
        if (item.anim) item.anim.play(true);
      } else {
        deactivations++;
        if (item.anim) item.anim.pause();
      }
    }
    for (const ped of peds) {
      const shouldBeActive = cellsAreNeighbours(ped.cell, cameraCell);
      if (shouldBeActive === ped.active) continue;
      ped.active = shouldBeActive;
      ped.wrapper.setEnabled(shouldBeActive);
      if (shouldBeActive) {
        activations++;
        if (ped.animation) ped.animation.play(true);
      } else {
        deactivations++;
        if (ped.animation) ped.animation.pause();
      }
    }
  }

  // --- Per-frame tick ---
  const scratch = {
    velocity: new Vector3(),
    angular: new Vector3(),
    desired: new Vector3(),
    target: new Vector3(),
    current: { x: 0, z: 0, tx: 0, tz: 0 },
    lookahead: { x: 0, z: 0, tx: 0, tz: 0 },
  };
  const keys = new Set();
  let debugHold = false;
  const keyHandlerDown = (event) => keys.add(event.key.toLowerCase());
  const keyHandlerUp = (event) => keys.delete(event.key.toLowerCase());
  window.addEventListener('keydown', keyHandlerDown);
  window.addEventListener('keyup', keyHandlerUp);

  function updateCar(dt) {
    const manual =
      keys.has('w') || keys.has('a') || keys.has('s') || keys.has('d') ||
      keys.has('arrowup') || keys.has('arrowleft') || keys.has('arrowdown') || keys.has('arrowright');
    path.sampleInto(carS, scratch.current);
    carS = (carS + CAR_SPEED * dt) % path.length;
    path.sampleInto(carS, scratch.current);
    const tangent = scratch.current;

    if (carBody) {
      const position = carRoot.position;
      if (manual) {
        // Arcade drive: Havok owns the body, this only applies velocity changes.
        const throttle = keys.has('w') || keys.has('arrowup') ? 1 : keys.has('s') || keys.has('arrowdown') ? -1 : 0;
        const steer = keys.has('a') || keys.has('arrowleft') ? 1 : keys.has('d') || keys.has('arrowright') ? -1 : 0;
        carBody.getLinearVelocityToRef(scratch.velocity);
        if (throttle !== 0) {
          scratch.velocity.x = mathLerp(scratch.velocity.x, tangent.tx * throttle * CAR_SPEED, 0.08);
          scratch.velocity.z = mathLerp(scratch.velocity.z, tangent.tz * throttle * CAR_SPEED, 0.08);
        }
        carBody.setLinearVelocity(scratch.velocity);
        scratch.angular.set(0, steer * 1.4, 0);
        carBody.setAngularVelocity(scratch.angular);
      } else {
        path.sampleInto(carS + 9, scratch.lookahead);
        const dx = scratch.lookahead.x - position.x;
        const dz = scratch.lookahead.z - position.z;
        const distance = Math.hypot(dx, dz) || 1;
        carBody.getLinearVelocityToRef(scratch.velocity);
        scratch.velocity.x = (dx / distance) * CAR_SPEED;
        scratch.velocity.z = (dz / distance) * CAR_SPEED;
        carBody.setLinearVelocity(scratch.velocity);
        const targetYaw = carYawFor(tangent);
        const yawError = wrapAngle(targetYaw - quaternionYaw(carRoot.rotationQuaternion));
        scratch.angular.set(0, clamp(yawError * 4, -2.5, 2.5), 0);
        carBody.setAngularVelocity(scratch.angular);
      }
      // Recover if a collision or a bad state pushes the car off the world.
      if (carRoot.position.y < -4 || carRoot.position.lengthSquared() > 40000) {
        carRoot.position.set(tangent.x, 0.6, tangent.z);
        carRoot.rotationQuaternion = Quaternion.RotationYawPitchRoll(carYawFor(tangent), 0, 0);
        carBody.setLinearVelocity(Vector3.Zero());
        carBody.setAngularVelocity(Vector3.Zero());
      }
    } else {
      carRoot.position.x = tangent.x;
      carRoot.position.z = tangent.z;
      carRoot.rotationQuaternion = Quaternion.RotationYawPitchRoll(carYawFor(tangent), 0, 0);
    }

    const wheelAngle = (CAR_SPEED / 0.35) * dt;
    for (const wheel of wheelMeshes) {
      wheel.rotate(Axis.X, wheelAngle, Space.LOCAL);
    }

    // Chase camera, smoothed (held still while a debug view is active).
    if (!debugHold) {
      const position = carRoot.position;
      const blend = 1 - Math.exp(-dt * 5);
      scratch.desired.set(position.x - tangent.tx * 14, position.y + 7.5, position.z - tangent.tz * 14);
      Vector3.LerpToRef(camera.position, scratch.desired, blend, camera.position);
      scratch.target.set(position.x + tangent.tx * 8, position.y + 1.5, position.z + tangent.tz * 8);
      camera.setTarget(scratch.target);
    }
  }

  function updatePeds(dt) {
    for (const ped of peds) {
      if (!ped.active) continue;
      const position = ped.controller ? ped.controller.getPosition() : ped.wrapper.position;
      const waypoint = ped.waypoints[ped.waypoint];
      const dx = waypoint.x - position.x;
      const dz = waypoint.z - position.z;
      const distance = Math.hypot(dx, dz);
      if (distance < 0.6) {
        ped.waypoint = (ped.waypoint + 1) % ped.waypoints.length;
        continue;
      }
      const dirX = dx / distance;
      const dirZ = dz / distance;
      if (ped.controller) {
        scratch.desired.set(dirX * PED_SPEED, -1, dirZ * PED_SPEED);
        ped.controller.setVelocity(scratch.desired);
        const surface = ped.controller.checkSupport(dt, DOWN);
        ped.controller.integrate(dt, surface, GRAVITY);
        const next = ped.controller.getPosition();
        ped.wrapper.position.set(next.x, next.y - 0.9, next.z);
      } else {
        ped.wrapper.position.x += dirX * PED_SPEED * dt;
        ped.wrapper.position.z += dirZ * PED_SPEED * dt;
      }
      ped.wrapper.rotation.y = Math.atan2(dirX, dirZ);
    }
  }

  let lastFrameMs = 0;
  scene.onBeforeRenderObservable.add(() => {
    // Reset Babylon's draw-call counter per frame; without SceneInstrumentation
    // it is never reset and would report a cumulative total.
    engine._drawCalls?.fetchNewFrame?.();
    const now = performance.now();
    const dt = lastFrameMs === 0 ? 1 / 60 : Math.min(0.05, (now - lastFrameMs) / 1000);
    lastFrameMs = now;
    updateCar(dt);
    updatePeds(dt);
    applyStreaming(camera.position.x, camera.position.z);
  });

  function getStats() {
    let triangles = 0;
    const active = scene.getActiveMeshes();
    for (let i = 0; i < active.length; i++) {
      const mesh = active.data[i];
      // Babylon's Mesh.instances is an empty array on a non-instanced mesh;
      // treat "no instances" as one draw of the source geometry.
      const instances = mesh.instances?.length || 1;
      triangles += (mesh.getTotalIndices() / 3) * instances;
    }
    const activeStreamables = streamables.reduce((total, item) => total + (item.active ? 1 : 0), 0);
    const activePeds = peds.reduce((total, ped) => total + (ped.active ? 1 : 0), 0);
    return {
      drawCalls: engine._drawCalls?.current ?? 0,
      triangles,
      instances: activeStreamables + activePeds + 1, // +1 car
      activations,
      deactivations,
      activePeds,
      activeStreamables,
      physics: physicsOk,
    };
  }

  // Scene facts for the checklist / report; extras are allowed by the contract.
  Object.assign(info, {
    buildings: streamables.length,
    pedestrians: peds.length,
    animatedPeds: peds.filter((ped) => ped.animation).length,
    pedestrianControllers: peds.filter((ped) => ped.controller).length,
    wheelNodes: wheelMeshes.length,
    carPhysics: Boolean(carBody),
    shadows: shadowMode,
    physics: physicsOk,
    layoutCells: [...new Set([...streamables.map((item) => item.cell), ...peds.map((ped) => ped.cell)])],
  });

  // Prime streaming so the first frame already has the right cells.
  applyStreaming(camera.position.x, camera.position.z);

  let started = false;
  const afterRenderCallbacks = [];
  return {
    info,
    errors,
    start() {
      if (started) return;
      started = true;
      metrics.running = true;
      scene.onAfterRenderObservable.add(() => {
        const now = performance.now();
        for (let i = 0; i < afterRenderCallbacks.length; i++) afterRenderCallbacks[i](now);
      });
      engine.runRenderLoop(() => scene.render());
      // Autoplay the loop; browsers may require a gesture, recorded in metrics.
      try {
        if (engineSound) {
          engineSound.play();
          metrics.audio = 'playing';
        }
      } catch (error) {
        metrics.audio = 'blocked';
        console.warn('[bakeoff] audio blocked until user gesture', error);
      }
    },
    onAfterRender(callback) {
      afterRenderCallbacks.push(callback);
    },
    getStats,
    unlockAudio() {
      try {
        Engine.audioEngine?.unlock?.();
        if (engineSound && !engineSound.isPlaying) {
          engineSound.play();
          metrics.audio = 'playing';
        }
      } catch (error) {
        metrics.audio = 'blocked';
      }
    },
    resize() {
      engine.resize();
    },
    /** Debug: hold the camera over the south cells so peds are visible. */
    viewPeds() {
      debugHold = true;
      camera.position.set(0, 14, 104);
      camera.setTarget(new Vector3(0, 1, 55));
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function mathLerp(a, b, t) {
  return a + (b - a) * t;
}

function wrapAngle(angle) {
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

function quaternionYaw(quaternion) {
  if (!quaternion) return 0;
  return Math.atan2(
    2 * (quaternion.w * quaternion.y + quaternion.x * quaternion.z),
    1 - 2 * (quaternion.y * quaternion.y + quaternion.x * quaternion.x),
  );
}

/** car.glb local forward is -Z: yaw that maps -Z onto the path tangent. */
function carYawFor(tangent) {
  return Math.atan2(-tangent.tx, -tangent.tz);
}

/** 0.5 s looping engine hum as a 16-bit mono WAV, generated locally (CC0). */
function makeEngineWav(sampleRate = 11025, seconds = 0.5) {
  const frames = Math.floor(sampleRate * seconds);
  const dataSize = frames * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeString = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    const fade = Math.min(1, Math.min(i, frames - i) / (sampleRate * 0.02));
    const sample =
      0.16 * Math.sin(2 * Math.PI * 90 * t) +
      0.08 * Math.sin(2 * Math.PI * 180 * t) +
      0.05 * Math.sin(2 * Math.PI * 37 * t);
    view.setInt16(44 + i * 2, clamp(sample * fade, -1, 1) * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}
