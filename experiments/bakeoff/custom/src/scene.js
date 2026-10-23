/**
 * The shared bake-off scene on the PocketPad engine.
 *
 * Responsibilities:
 *   - build render meshes/materials from `@lanpad/engine-assets` MeshData
 *     (ground, building) and from the contender-side GLB reader (car, ped);
 *   - build the Rapier world: ground and buildings on layer 1 ("world"), the
 *     car chassis + raycast vehicle on layer 0, pedestrians on the default
 *     layer (their character filter excludes the car through the car's mask);
 *   - drive the car along the shared cameraPath with a pure-pursuit steering
 *     controller (the physics does the driving, the path is scripted);
 *   - deactivate rendering + simulation for objects outside the camera cell's
 *     3x3 neighbourhood, and count object activations/deactivations;
 *   - render a sky box, ground, buildings, contact discs, pedestrians and the
 *     car through the engine RenderFrame ABI.
 *
 * Honest gaps (recorded in CHECKLIST.md): no shadow maps (both backends
 * report `shadowCascades: 0` and there is no light API), no GPU skinning (the
 * ABI has no joints/weights, so peds are CPU-skinned pose buckets), and the
 * sky is a textured box because the renderer exposes no sky/light API.
 */

import {
  mat4Create,
  mat4LookAt,
  mat4Multiply,
  mat4PerspectiveWebGL2,
  mat4PerspectiveWebGPU,
} from "@lanpad/engine-core";
import { CellGrid } from "@lanpad/engine-streaming";
import {
  createDiscGeometry,
  createSkyBytes,
  createSkyGeometry,
  composeTRS,
  multiplyMatrices,
  writeEulerTRS,
} from "./geometry.js";
import { createPedRig, createPedSimulation, PED_BUCKETS } from "./peds.js";

const FIXED_DT = 1 / 60;
const CAMERA_FOV_Y = (60 * Math.PI) / 180;
const CAMERA_NEAR = 0.5;
const CAMERA_FAR = 1500;
const CAMERA_BACK = 8;
const CAMERA_HEIGHT = 4;
const CAMERA_LOOK_AHEAD = 2;
const CAMERA_FOLLOW_RATE = 3.5;
const SKY_HALF_EXTENT = 400;
const CAR_TARGET_SPEED = 20;
const CAR_TOP_SPEED = 26;

// Physics layer bits. Layer indices are declared to createRapierWorld:
// 0 = default (car chassis), 1 = world (ground, buildings).
const LAYER_CAR = 1 << 0;
const LAYER_WORLD = 1 << 1;
const LAYER_PEDS = 1 << 2;
const CAR_MASK = LAYER_WORLD;
const WORLD_MASK = LAYER_CAR | LAYER_PEDS;

const CAR_MASS_KG = 1250;

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function makeMeshFromPrimitive(device, label, primitive, layout = "static-pbr-v1") {
  return device.createMesh({
    label,
    // The vertex buffer is the same for both ABI-1 layouts; the layout token
    // selects the instanced pipeline, and `drawInstanced` rejects a mesh that
    // was created without it.
    layout,
    vertices: [primitive.vertices],
    indices: { data: primitive.indices, format: primitive.indexFormat },
    bounds: primitive.bounds,
  });
}

/**
 * Packs position/normal/uv from a GLB primitive into the renderer ABI and
 * computes its model-space bounding sphere.
 */
function packPrimitive(geometry) {
  const { positions, normals, uvs, vertexCount } = geometry;
  const vertices = new Float32Array(vertexCount * 8);
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const offset = vertex * 8;
    const x = positions[vertex * 3];
    const y = positions[vertex * 3 + 1];
    const z = positions[vertex * 3 + 2];
    vertices[offset] = x;
    vertices[offset + 1] = y;
    vertices[offset + 2] = z;
    vertices[offset + 3] = normals === null ? 0 : normals[vertex * 3];
    vertices[offset + 4] = normals === null ? 1 : normals[vertex * 3 + 1];
    vertices[offset + 5] = normals === null ? 0 : normals[vertex * 3 + 2];
    vertices[offset + 6] = uvs === null ? 0 : uvs[vertex * 2];
    vertices[offset + 7] = uvs === null ? 0 : uvs[vertex * 2 + 1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const center = {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    z: (minZ + maxZ) / 2,
  };
  let radiusSq = 0;
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const offset = vertex * 8;
    const dx = vertices[offset] - center.x;
    const dy = vertices[offset + 1] - center.y;
    const dz = vertices[offset + 2] - center.z;
    const distance = dx * dx + dy * dy + dz * dz;
    if (distance > radiusSq) radiusSq = distance;
  }
  return {
    vertices,
    indices: geometry.indices,
    indexFormat: geometry.indexFormat,
    vertexCount,
    indexCount: geometry.indexCount,
    bounds: { center, radius: Math.sqrt(radiusSq) },
  };
}

function makeGradientTexture(device, label, width, height, bytes) {
  return device.createTexture({
    label,
    width,
    height,
    format: "rgba8unorm-srgb",
    usage: ["sample", "copy-dst"],
    mipLevels: 1,
    data: [{ mipLevel: 0, layer: 0, bytes, bytesPerRow: width * 4 }],
    sampler: {
      label: `${label}-sampler`,
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "nearest",
      addressU: "clamp-to-edge",
      addressV: "clamp-to-edge",
    },
  });
}

/**
 * Creates the scene. Everything is allocated here (meshes, materials,
 * transforms, body states); `update` and `render` do not allocate.
 */
export function createScene({
  device,
  backend,
  layout,
  ground,
  building,
  facadeTexture,
  carData,
  pedData,
  carTexture,
  physics,
  onError,
}) {
  const cellSize = layout.cellSizeMeters;
  const origin = layout.origin;
  const cellsX = 3;
  const cellsY = 3;
  const grid = new CellGrid({
    origin: { x: origin.x, y: origin.y, z: origin.z },
    cellSizeMeters: cellSize,
    grid: { minX: 0, minY: 0, maxX: cellsX - 1, maxY: cellsY - 1 },
  });

  /* ---------------------------------------------------------------- meshes */

  const groundPrimitive = ground.primitives[0];
  const groundMesh = makeMeshFromPrimitive(device, "ground", groundPrimitive);
  const groundMaterial = device.createMaterial({
    label: "ground-material",
    baseColorFactor: [0.29, 0.33, 0.3, 1],
    metallic: 0,
    roughness: 1,
    emissiveFactor: [0, 0, 0],
    alphaMode: "opaque",
    doubleSided: false,
  });

  const buildingPrimitive = building.primitives[0];
  const buildingMesh = makeMeshFromPrimitive(
    device,
    "building",
    buildingPrimitive,
    "instanced-transform-v1",
  );
  const buildingMaterial = device.createMaterial({
    label: "building-material",
    baseColorFactor: [1, 1, 1, 1],
    metallic: 0,
    roughness: 0.85,
    emissiveFactor: [0, 0, 0],
    baseColorTexture: facadeTexture ?? null,
    alphaMode: "opaque",
    doubleSided: false,
  });

  const skyGeometry = createSkyGeometry(SKY_HALF_EXTENT);
  const skyMesh = device.createMesh({
    label: "sky",
    layout: "static-pbr-v1",
    vertices: [skyGeometry.vertices],
    indices: { data: skyGeometry.indices, format: "uint16" },
    bounds: skyGeometry.bounds,
  });
  const skyTexture = makeGradientTexture(
    device,
    "sky-gradient",
    256,
    128,
    createSkyBytes(256, 128),
  );
  const skyMaterial = device.createMaterial({
    label: "sky-material",
    baseColorFactor: [1, 1, 1, 1],
    metallic: 0,
    roughness: 1,
    emissiveFactor: [0, 0, 0],
    baseColorTexture: skyTexture,
    alphaMode: "opaque",
    doubleSided: false,
    unlit: true,
  });

  const discGeometry = createDiscGeometry(1, 20);
  const discMesh = device.createMesh({
    label: "contact-disc",
    layout: "instanced-transform-v1",
    vertices: [discGeometry.vertices],
    indices: { data: discGeometry.indices, format: "uint16" },
    bounds: discGeometry.bounds,
  });
  const discMaterial = device.createMaterial({
    label: "contact-disc-material",
    baseColorFactor: [0.04, 0.05, 0.045, 1],
    metallic: 0,
    roughness: 1,
    emissiveFactor: [0, 0, 0],
    alphaMode: "opaque",
    doubleSided: false,
    unlit: true,
  });

  /* ------------------------------------------------------------- car visual */

  const carBodyGeometry = packPrimitive(carData.body.geometry);
  const carBodyMesh = device.createMesh({
    label: "car-body",
    layout: "static-pbr-v1",
    vertices: [carBodyGeometry.vertices],
    indices: {
      data: carBodyGeometry.indices,
      format: carBodyGeometry.indexFormat,
    },
    bounds: carBodyGeometry.bounds,
  });
  const carWheels = [];
  for (let index = 0; index < carData.wheels.length; index += 1) {
    const part = carData.wheels[index];
    const geometry = packPrimitive(part.geometry);
    carWheels.push({
      mesh: device.createMesh({
        label: `car-${part.name}`,
        layout: "static-pbr-v1",
        vertices: [geometry.vertices],
        indices: { data: geometry.indices, format: geometry.indexFormat },
        bounds: geometry.bounds,
      }),
      translation: part.translation,
    });
  }
  const carMaterial = device.createMaterial({
    label: "car-material",
    baseColorFactor:
      carTexture === null ? [0.72, 0.22, 0.18, 1] : [1, 1, 1, 1],
    metallic: 0,
    roughness: 0.75,
    emissiveFactor: [0, 0, 0],
    baseColorTexture: carTexture,
    alphaMode: "opaque",
    doubleSided: false,
  });
  const carBodyNode = { m: new Float32Array(16) };
  composeTRS(
    carBodyNode.m,
    0,
    carData.body.translation[0],
    carData.body.translation[1],
    carData.body.translation[2],
    carData.body.rotation[0],
    carData.body.rotation[1],
    carData.body.rotation[2],
    carData.body.rotation[3],
    1,
    1,
    1,
  );
  // The shared car bakes a 180-degree yaw into every part node (local -Z
  // forward). Recover that yaw so wheels spin about the chassis axle.
  const partRotation = carData.wheels[0].rotation;
  const carPartYaw = Math.atan2(
    2 * (partRotation[3] * partRotation[1] + partRotation[0] * partRotation[2]),
    1 - 2 * (partRotation[1] * partRotation[1] + partRotation[2] * partRotation[2]),
  );

  /* ---------------------------------------------------------------- physics */

  const groundBody = physics.createBody({
    type: "static",
    position: { x: 0, y: -0.5, z: 0 },
  });
  physics.createCollider(groundBody, {
    shape: { kind: "box", halfExtents: { x: 96, y: 0.5, z: 96 } },
    friction: 0.9,
    restitution: 0,
    layer: 1,
    mask: WORLD_MASK,
  });

  const buildingBody = physics.createBody({ type: "static" });
  const buildingCount = layout.buildings.length;
  const buildingTransforms = new Float32Array(buildingCount * 16);
  // Deactivated buildings are compacted out of this buffer before the draw so
  // they are not submitted to the GPU at all; drawing a zero-scale instance
  // would still pay the vertex cost and would only hide the object.
  const buildingActiveTransforms = new Float32Array(buildingCount * 16);
  const buildingActive = new Uint8Array(buildingCount);
  const buildingCellIndex = new Int32Array(buildingCount);
  for (let index = 0; index < buildingCount; index += 1) {
    const entry = layout.buildings[index];
    const comma = entry.cell.indexOf(",");
    const cx = Number(entry.cell.slice(0, comma));
    const cy = Number(entry.cell.slice(comma + 1));
    const worldX = origin.x + cx * cellSize + entry.x;
    const worldZ = origin.z + cy * cellSize + entry.z;
    composeTRS(
      buildingTransforms,
      index * 16,
      worldX,
      0,
      worldZ,
      0,
      0,
      0,
      1,
      1,
      entry.height,
      1,
    );
    physics.createCollider(buildingBody, {
      shape: {
        kind: "box",
        halfExtents: { x: 4, y: entry.height / 2, z: 4 },
      },
      friction: 0.8,
      restitution: 0,
      layer: 1,
      mask: WORLD_MASK,
      localPosition: { x: worldX, y: entry.height / 2, z: worldZ },
    });
    buildingCellIndex[index] = grid.indexOf(cx, cy);
  }

  const carStart = layout.car;
  const startHalfYaw = carStart.yaw * 0.5;
  const chassisBody = physics.createBody({
    type: "dynamic",
    position: { x: carStart.x, y: carStart.y, z: carStart.z },
    rotation: {
      x: 0,
      y: Math.sin(startHalfYaw),
      z: 0,
      w: Math.cos(startHalfYaw),
    },
    mass: CAR_MASS_KG,
    linearDamping: 0,
    angularDamping: 0.4,
    ccd: true,
    canSleep: false,
  });
  physics.createCollider(chassisBody, {
    shape: { kind: "box", halfExtents: { x: 0.75, y: 0.55, z: 1.3 } },
    localPosition: { x: 0, y: 0.2, z: 0 },
    friction: 0.7,
    restitution: 0,
    layer: 0,
    mask: CAR_MASK,
  });

  const wheelDescs = [];
  for (let index = 0; index < carWheels.length; index += 1) {
    const translation = carWheels[index].translation;
    wheelDescs.push({
      localPosition: {
        x: translation[0],
        y: translation[1],
        z: translation[2],
      },
      radius: 0.3,
      width: 0.35,
      suspensionRestLength: 0.25,
      suspensionStiffness: 245000,
      suspensionDamping: 9000,
      maxTravel: 0.25,
      steerable: index < 2,
      driven: true,
      friction: 2,
    });
  }
  const vehicle = physics.createVehicle({
    chassis: chassisBody,
    wheels: wheelDescs,
    engineForce: 7000,
    reverseForce: 4000,
    brakeForce: 9000,
    maxSteerDegrees: 30,
    steerRateDegreesPerSecond: 240,
    topSpeed: CAR_TOP_SPEED,
    downforce: 0,
  });

  /* ------------------------------------------------------------------- peds */

  const pedRig = createPedRig(pedData, device);
  const peds = createPedSimulation({
    rig: pedRig,
    pedestrians: layout.pedestrians,
    physics,
    origin,
    onError,
  });
  const pedCount = layout.pedestrians.length;
  const pedCellIndex = new Int32Array(pedCount);
  for (let index = 0; index < pedCount; index += 1) {
    const cell = layout.pedestrians[index].cell;
    const comma = cell.indexOf(",");
    pedCellIndex[index] = grid.indexOf(
      Number(cell.slice(0, comma)),
      Number(cell.slice(comma + 1)),
    );
  }
  const cellIndexByKey = new Map();
  for (let cellY = 0; cellY < cellsY; cellY += 1) {
    for (let cellX = 0; cellX < cellsX; cellX += 1) {
      cellIndexByKey.set(`${cellX},${cellY}`, grid.indexOf(cellX, cellY));
    }
  }
  function isCellKeyActive(cellKey) {
    const index = cellIndexByKey.get(cellKey);
    return index !== undefined && activeByCell[index] === 1;
  }

  /* ----------------------------------------------------------------- camera */

  const camera = {
    x: carStart.x,
    y: carStart.y + CAMERA_HEIGHT,
    z: carStart.z + CAMERA_BACK,
    lookX: carStart.x,
    lookY: carStart.y + 1.2,
    lookZ: carStart.z,
  };
  const eye = { x: 0, y: 0, z: 0 };
  const target = { x: 0, y: 0, z: 0 };
  const up = { x: 0, y: 1, z: 0 };
  const view = mat4Create();
  const projection = mat4Create();
  const viewProjection = mat4Create();
  let projectionAspect = 0;

  /* --------------------------------------------------------- scripted route */

  const pathPoints = layout.cameraPath;
  const segmentCount = pathPoints.length;
  const segmentLengths = new Float64Array(segmentCount);
  const segmentDirsX = new Float64Array(segmentCount);
  const segmentDirsZ = new Float64Array(segmentCount);
  let pathLength = 0;
  for (let index = 0; index < segmentCount; index += 1) {
    const a = pathPoints[index];
    const b = pathPoints[(index + 1) % segmentCount];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    segmentLengths[index] = length;
    segmentDirsX[index] = length === 0 ? 0 : dx / length;
    segmentDirsZ[index] = length === 0 ? 0 : dz / length;
    pathLength += length;
  }
  const nearest = { segment: 0, t: 0 };

  /** Allocation-free closest-point search across the closed route. */
  function nearestOnPath(x, z) {
    let best = Infinity;
    let bestSegment = 0;
    let bestT = 0;
    for (let index = 0; index < segmentCount; index += 1) {
      const a = pathPoints[index];
      const dx = segmentDirsX[index] * segmentLengths[index];
      const dz = segmentDirsZ[index] * segmentLengths[index];
      const lengthSq = dx * dx + dz * dz;
      let t = 0;
      if (lengthSq > 0) {
        t = clamp(((x - a.x) * dx + (z - a.z) * dz) / lengthSq, 0, 1);
      }
      const px = a.x + dx * t;
      const pz = a.z + dz * t;
      const distanceSq = (x - px) * (x - px) + (z - pz) * (z - pz);
      if (distanceSq < best) {
        best = distanceSq;
        bestSegment = index;
        bestT = t;
      }
    }
    nearest.segment = bestSegment;
    nearest.t = bestT;
  }

  function lookaheadPoint(x, z, distance, out) {
    nearestOnPath(x, z);
    let segment = nearest.segment;
    let remaining = (1 - nearest.t) * segmentLengths[segment];
    let guard = 0;
    while (distance > remaining && guard < segmentCount) {
      distance -= remaining;
      segment = (segment + 1) % segmentCount;
      remaining = segmentLengths[segment];
      guard += 1;
    }
    const start = pathPoints[segment];
    const advance = Math.min(distance, segmentLengths[segment]);
    out.x = start.x + segmentDirsX[segment] * advance;
    out.z = start.z + segmentDirsZ[segment] * advance;
    return segment;
  }

  function distanceToCorner(x, z) {
    nearestOnPath(x, z);
    return (1 - nearest.t) * segmentLengths[nearest.segment];
  }

  /* ------------------------------------------------------------- streaming */

  const activeByCell = new Uint8Array(cellsX * cellsY);
  const activeCenter = { cx: -1, cy: -1 };
  let activations = 0;
  let deactivations = 0;
  const pedActive = new Uint8Array(pedCount);
  let activePedCount = 0;

  function isCellActive(cx, cy) {
    const index = grid.indexOf(cx, cy);
    return index >= 0 && activeByCell[index] === 1;
  }

  function clearActiveCell(cx, cy) {
    const index = grid.indexOf(cx, cy);
    if (index >= 0) activeByCell[index] = 1;
  }

  function applyCellActivation(cx, cy) {
    if (cx === activeCenter.cx && cy === activeCenter.cy) return;
    activeCenter.cx = cx;
    activeCenter.cy = cy;
    activeByCell.fill(0);
    grid.forEachNeighbour(cx, cy, 1, clearActiveCell);
    let activated = 0;
    let deactivated = 0;
    for (let index = 0; index < buildingCount; index += 1) {
      const cellIndex = buildingCellIndex[index];
      const active = cellIndex >= 0 && activeByCell[cellIndex] === 1 ? 1 : 0;
      if (active === buildingActive[index]) continue;
      buildingActive[index] = active;
      if (active === 1) activated += 1;
      else deactivated += 1;
    }
    activePedCount = 0;
    for (let index = 0; index < pedCount; index += 1) {
      const cellIndex = pedCellIndex[index];
      const active = cellIndex >= 0 && activeByCell[cellIndex] === 1 ? 1 : 0;
      if (active === pedActive[index]) {
        activePedCount += active;
        continue;
      }
      pedActive[index] = active;
      activePedCount += active;
      if (active === 1) activated += 1;
      else deactivated += 1;
    }
    activations += activated;
    deactivations += deactivated;
    peds.setActiveCells(isCellKeyActive);
  }

  /* ------------------------------------------------------------- car state */

  const bodyState = {
    position: { x: carStart.x, y: carStart.y, z: carStart.z },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    linearVelocity: { x: 0, y: 0, z: 0 },
    angularVelocity: { x: 0, y: 0, z: 0 },
    sleeping: false,
    enabled: true,
    mass: CAR_MASS_KG,
    userData: 0,
  };
  const vehicleState = {
    wheelCount: 4,
    speed: 0,
    forward: { x: 0, y: 0, z: -1 },
    wheels: [],
  };
  const vehicleInput = { throttle: 0, steering: 0, brake: 0 };
  const lookahead = { x: 0, z: 0 };
  const chassisMatrix = { m: new Float32Array(16) };
  const bodyMatrix = { m: new Float32Array(16) };
  const wheelLocal = { m: new Float32Array(16) };
  const wheelWorld = { m: new Float32Array(16) };
  const carDiscMatrix = { m: new Float32Array(16) };
  const skyTransform = { m: new Float32Array(16) };
  const pedDiscTransforms = new Float32Array(pedCount * 16);
  let carX = carStart.x;
  let carY = carStart.y;
  let carZ = carStart.z;
  let carYaw = carStart.yaw;
  let lastError = "";

  function report(error) {
    const text = String(error).slice(0, 300);
    if (text === lastError) return;
    lastError = text;
    onError?.(text);
  }

  /* -------------------------------------------------------------- stepping */

  function update(dt) {
    const forward = vehicleState.forward;
    const heading = Math.atan2(forward.x, -forward.z);
    const speed = vehicleState.speed;
    const lookaheadDistance = 7 + Math.abs(speed) * 0.45;
    lookaheadPoint(carX, carZ, lookaheadDistance, lookahead);
    const targetYaw = Math.atan2(lookahead.x - carX, -(lookahead.z - carZ));
    let headingError = targetYaw - heading;
    while (headingError > Math.PI) headingError -= Math.PI * 2;
    while (headingError < -Math.PI) headingError += Math.PI * 2;

    vehicleInput.steering = clamp(headingError * 1.8, -1, 1);

    // Corner easing: brake before the 90-degree route corners instead of
    // scrubbing the building walls at 20 m/s.
    let targetSpeed = CAR_TARGET_SPEED;
    const toCorner = distanceToCorner(carX, carZ);
    if (toCorner < 10) targetSpeed = 7.5;
    else if (toCorner < 24) targetSpeed = 13;
    if (Math.abs(headingError) > 0.4) targetSpeed = Math.min(targetSpeed, 9);
    const speedDelta = targetSpeed - speed;
    vehicleInput.throttle = clamp(speedDelta * 0.4, 0, 1);
    vehicleInput.brake =
      speedDelta < -1.5 ? clamp(-speedDelta * 0.25, 0, 1) : 0;
    physics.setVehicleInput(vehicle, vehicleInput);

    peds.update(dt);
    physics.step(dt);

    if (physics.readBody(chassisBody, bodyState)) {
      carX = bodyState.position.x;
      carY = bodyState.position.y;
      carZ = bodyState.position.z;
    }
    physics.readVehicle(vehicle, vehicleState);
    const forwardNow = vehicleState.forward;
    carYaw = Math.atan2(forwardNow.x, -forwardNow.z);

    // Camera follows the car with a wall-clock-independent exponential
    // smoothing; the look-ahead point keeps the car slightly low-centre.
    const desiredX = carX - forwardNow.x * CAMERA_BACK;
    const desiredY = carY + CAMERA_HEIGHT;
    const desiredZ = carZ - forwardNow.z * CAMERA_BACK;
    const blend = 1 - Math.exp(-dt * CAMERA_FOLLOW_RATE);
    camera.x += (desiredX - camera.x) * blend;
    camera.y += (desiredY - camera.y) * blend;
    camera.z += (desiredZ - camera.z) * blend;
    camera.lookX = carX + forwardNow.x * CAMERA_LOOK_AHEAD;
    camera.lookY = carY + 1.2;
    camera.lookZ = carZ + forwardNow.z * CAMERA_LOOK_AHEAD;

    const cellX = grid.worldToCellX(camera.x);
    const cellY = grid.worldToCellZ(camera.z);
    if (grid.indexOf(cellX, cellY) >= 0) applyCellActivation(cellX, cellY);
  }

  /* -------------------------------------------------------------- rendering */

  function buildCamera(width, height) {
    const aspect = height > 0 ? width / height : 1;
    eye.x = camera.x;
    eye.y = camera.y;
    eye.z = camera.z;
    target.x = camera.lookX;
    target.y = camera.lookY;
    target.z = camera.lookZ;
    mat4LookAt(view, eye, target, up);
    if (Math.abs(aspect - projectionAspect) > 1e-6) {
      projectionAspect = aspect;
      if (backend === "webgpu") {
        mat4PerspectiveWebGPU(
          projection,
          CAMERA_FOV_Y,
          aspect,
          CAMERA_NEAR,
          CAMERA_FAR,
        );
      } else {
        mat4PerspectiveWebGL2(
          projection,
          CAMERA_FOV_Y,
          aspect,
          CAMERA_NEAR,
          CAMERA_FAR,
        );
      }
    }
    mat4Multiply(viewProjection, projection, view);
  }

  function render(frame) {
    const size = device.size;
    buildCamera(size.width, size.height);
    frame.setCamera(viewProjection);

    // Sky box centred on the camera; unlit gradient, opaque.
    composeTRS(
      skyTransform.m,
      0,
      eye.x,
      eye.y,
      eye.z,
      0,
      0,
      0,
      1,
      1,
      1,
      1,
    );
    frame.draw(skyMesh, skyMaterial, skyTransform);

    frame.draw(groundMesh, groundMaterial, IDENTITY);

    let buildingsVisible = 0;
    for (let index = 0; index < buildingCount; index += 1) {
      if (buildingActive[index] !== 1) continue;
      const to = buildingsVisible * 16;
      const from = index * 16;
      for (let slot = 0; slot < 16; slot += 1) {
        buildingActiveTransforms[to + slot] = buildingTransforms[from + slot];
      }
      buildingsVisible += 1;
    }
    if (buildingsVisible > 0) {
      frame.drawInstanced(
        buildingMesh,
        buildingMaterial,
        buildingActiveTransforms,
        buildingsVisible,
      );
    }

    // Contact shadows: painted discs, because neither backend exposes shadow
    // maps (`capabilities.shadowCascades === 0`).
    composeTRS(
      carDiscMatrix.m,
      0,
      carX,
      0.02,
      carZ,
      0,
      Math.sin(carYaw * 0.5),
      0,
      Math.cos(carYaw * 0.5),
      1.5,
      1,
      2.6,
    );
    frame.draw(discMesh, discMaterial, carDiscMatrix);
    let pedDiscCount = 0;
    for (let index = 0; index < peds.states.length; index += 1) {
      const ped = peds.states[index];
      if (ped.active !== true) continue;
      composeTRS(
        pedDiscTransforms,
        pedDiscCount * 16,
        ped.x,
        0.015,
        ped.z,
        0,
        0,
        0,
        1,
        0.38,
        1,
        0.38,
      );
      pedDiscCount += 1;
    }
    if (pedDiscCount > 0) {
      frame.drawInstanced(
        discMesh,
        discMaterial,
        pedDiscTransforms,
        pedDiscCount,
      );
    }

    peds.render(frame);

    // Car: chassis transform * part-local node transform. Wheel placement
    // comes from telemetry, so suspension/steer/spin match the physics.
    composeTRS(
      chassisMatrix.m,
      0,
      carX,
      carY,
      carZ,
      bodyState.rotation.x,
      bodyState.rotation.y,
      bodyState.rotation.z,
      bodyState.rotation.w,
      1,
      1,
      1,
    );
    multiplyMatrices(bodyMatrix.m, 0, chassisMatrix.m, 0, carBodyNode.m, 0);
    frame.draw(carBodyMesh, carMaterial, bodyMatrix);
    for (let index = 0; index < carWheels.length; index += 1) {
      const wheel = carWheels[index];
      const state = vehicleState.wheels[index];
      const suspension = state === undefined ? 0 : state.suspensionLength;
      const spin = state === undefined ? 0 : state.rotation;
      const steer = state === undefined ? 0 : state.steerAngle;
      writeEulerTRS(
        wheelLocal.m,
        0,
        wheel.translation[0],
        wheel.translation[1] - suspension,
        wheel.translation[2],
        carPartYaw + steer,
        spin,
      );
      multiplyMatrices(wheelWorld.m, 0, chassisMatrix.m, 0, wheelLocal.m, 0);
      frame.draw(wheel.mesh, carMaterial, wheelWorld);
    }
  }

  /* ------------------------------------------------------------ diagnostics */

  function diagnostics() {
    return {
      backend,
      shadowCascades: device.capabilities.shadowCascades,
      car: {
        x: Number(carX.toFixed(3)),
        y: Number(carY.toFixed(3)),
        z: Number(carZ.toFixed(3)),
        yaw: Number(carYaw.toFixed(3)),
        speed: Number(vehicleState.speed.toFixed(3)),
      },
      camera: {
        x: Number(camera.x.toFixed(3)),
        y: Number(camera.y.toFixed(3)),
        z: Number(camera.z.toFixed(3)),
      },
      cell: { cx: activeCenter.cx, cy: activeCenter.cy },
      buildings: buildingCount,
      peds: { total: pedCount, active: activePedCount },
      activations,
      deactivations,
      skinning: {
        mode: pedRig.skinning,
        buckets: PED_BUCKETS,
        trianglesPerPed: pedRig.trianglesPerPed,
      },
      physics: {
        bodyCount: physics.stats.bodyCount,
        colliderCount: physics.stats.colliderCount,
        awakeBodyCount: physics.stats.awakeBodyCount,
        stepMs: Number(physics.stats.stepMs.toFixed(3)),
      },
      routeLengthMeters: Number(pathLength.toFixed(2)),
    };
  }

  // Prime the cell set and two physics steps so the first rendered frame has
  // live wheel telemetry and a settled camera.
  const bootCellX = grid.worldToCellX(camera.x);
  const bootCellY = grid.worldToCellZ(camera.z);
  applyCellActivation(
    grid.indexOf(bootCellX, bootCellY) >= 0 ? bootCellX : 1,
    grid.indexOf(bootCellX, bootCellY) >= 0 ? bootCellY : 2,
  );
  for (let index = 0; index < 2; index += 1) {
    physics.setVehicleInput(vehicle, vehicleInput);
    physics.step(FIXED_DT);
  }
  physics.readBody(chassisBody, bodyState);
  physics.readVehicle(vehicle, vehicleState);
  carX = bodyState.position.x;
  carY = bodyState.position.y;
  carZ = bodyState.position.z;
  const forward0 = vehicleState.forward;
  camera.x = carX - forward0.x * CAMERA_BACK;
  camera.y = carY + CAMERA_HEIGHT;
  camera.z = carZ - forward0.z * CAMERA_BACK;
  camera.lookX = carX;
  camera.lookY = carY + 1.2;
  camera.lookZ = carZ;

  return {
    update,
    render,
    diagnostics,
    peds,
    rig: pedRig,
    activations: () => activations,
    deactivations: () => deactivations,
    activePedCount: () => activePedCount,
    car: () => ({
      x: carX,
      y: carY,
      z: carZ,
      yaw: carYaw,
      speed: vehicleState.speed,
    }),
    camera: () => ({
      x: camera.x,
      y: camera.y,
      z: camera.z,
      lookX: camera.lookX,
      lookY: camera.lookY,
      lookZ: camera.lookZ,
    }),
    report,
  };
}

const IDENTITY = {
  m: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
};
