/**
 * Skinned pedestrians for the custom contender.
 *
 * The renderer ABI has no joint indices, skin weights or dynamic mesh update,
 * so runtime GPU skinning is not expressible through the public device. The
 * honest equivalent: compile the shared skeleton and `walk` clip with
 * `@lanpad/engine-animation`, CPU-skin one pose per phase bucket at boot, and
 * instance each bucket. A ped switches buckets as it walks, which reproduces
 * the walk cycle at PED_BUCKETS samples per 1.333 s loop without per-frame
 * vertex uploads. This is NOT GPU skinning and is documented as such.
 */

import {
  compileSkeleton,
  compileClip,
  createPoseBuffer,
  createJointPalette,
  copyPose,
  sampleClipInto,
  computePalette,
  createPaletteScratch,
} from "@lanpad/engine-animation";
import { composeTRS } from "./geometry.js";

export const PED_BUCKETS = 16;
export const PED_SPEED = 1.2;
const PED_STRIDE_METERS = 1.6;
const PED_CAPSULE_RADIUS = 0.3;
const PED_CAPSULE_HALF_HEIGHT = 0.55;
const PED_CAPSULE_CENTER_Y = PED_CAPSULE_RADIUS + PED_CAPSULE_HALF_HEIGHT;

/**
 * Skins one primitive with a model-space palette (`J_i = W_i * inverseBind`).
 * 4 influences per vertex, matching the shared ped's JOINTS_0/WEIGHTS_0.
 */
function skinPrimitive(primitive, paletteMatrices) {
  const { positions, normals, indices, indexFormat, vertexCount } = primitive.geometry;
  const joints = primitive.joints;
  const weights = primitive.weights;
  const vertices = new Float32Array(vertexCount * 8);
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const px = positions[vertex * 3];
    const py = positions[vertex * 3 + 1];
    const pz = positions[vertex * 3 + 2];
    const nx = normals === null ? 0 : normals[vertex * 3];
    const ny = normals === null ? 1 : normals[vertex * 3 + 1];
    const nz = normals === null ? 0 : normals[vertex * 3 + 2];
    let sx = 0;
    let sy = 0;
    let sz = 0;
    let tx = 0;
    let ty = 0;
    let tz = 0;
    for (let influence = 0; influence < 4; influence += 1) {
      const weight = weights[vertex * 4 + influence];
      if (weight === 0) continue;
      const joint = joints[vertex * 4 + influence];
      const base = joint * 16;
      const m0 = paletteMatrices[base];
      const m1 = paletteMatrices[base + 1];
      const m2 = paletteMatrices[base + 2];
      const m4 = paletteMatrices[base + 4];
      const m5 = paletteMatrices[base + 5];
      const m6 = paletteMatrices[base + 6];
      const m8 = paletteMatrices[base + 8];
      const m9 = paletteMatrices[base + 9];
      const m10 = paletteMatrices[base + 10];
      const m12 = paletteMatrices[base + 12];
      const m13 = paletteMatrices[base + 13];
      const m14 = paletteMatrices[base + 14];
      sx += weight * (m0 * px + m4 * py + m8 * pz + m12);
      sy += weight * (m1 * px + m5 * py + m9 * pz + m13);
      sz += weight * (m2 * px + m6 * py + m10 * pz + m14);
      tx += weight * (m0 * nx + m4 * ny + m8 * nz);
      ty += weight * (m1 * nx + m5 * ny + m9 * nz);
      tz += weight * (m2 * nx + m6 * ny + m10 * nz);
    }
    const length = Math.hypot(tx, ty, tz) || 1;
    const out = vertex * 8;
    vertices[out] = sx;
    vertices[out + 1] = sy;
    vertices[out + 2] = sz;
    vertices[out + 3] = tx / length;
    vertices[out + 4] = ty / length;
    vertices[out + 5] = tz / length;
    vertices[out + 6] = 0;
    vertices[out + 7] = 0;
    if (sx < minX) minX = sx;
    if (sy < minY) minY = sy;
    if (sz < minZ) minZ = sz;
    if (sx > maxX) maxX = sx;
    if (sy > maxY) maxY = sy;
    if (sz > maxZ) maxZ = sz;
  }

  const center = {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    z: (minZ + maxZ) / 2,
  };
  let radiusSq = 0;
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const out = vertex * 8;
    const dx = vertices[out] - center.x;
    const dy = vertices[out + 1] - center.y;
    const dz = vertices[out + 2] - center.z;
    const distance = dx * dx + dy * dy + dz * dz;
    if (distance > radiusSq) radiusSq = distance;
  }
  return {
    vertices,
    indices,
    indexFormat,
    bounds: { center, radius: Math.sqrt(radiusSq) },
  };
}

/**
 * Compiles the skeleton + clip and builds PED_BUCKETS instanced meshes per
 * primitive. Returns the material handles, the per-bucket mesh arrays and the
 * triangle count of one pedestrian.
 */
export function createPedRig(pedData, device) {
  const skeleton = compileSkeleton(pedData.skeleton);
  const walk = compileClip(pedData.walk, skeleton);
  const pose = createPoseBuffer(skeleton.jointCount);
  const palette = createJointPalette(skeleton.jointCount);
  const scratch = createPaletteScratch(skeleton.jointCount);
  const buckets = [];

  for (let bucket = 0; bucket < PED_BUCKETS; bucket += 1) {
    copyPose(pose, skeleton.restPose);
    const time = (bucket / PED_BUCKETS) * walk.duration;
    sampleClipInto(walk, time, pose, null);
    computePalette(skeleton, pose, pose, 1, palette, scratch);
    const meshes = [];
    for (let primitiveIndex = 0; primitiveIndex < pedData.primitives.length; primitiveIndex += 1) {
      const primitive = pedData.primitives[primitiveIndex];
      const skinned = skinPrimitive(primitive, palette.matrices);
      meshes.push(
        device.createMesh({
          label: `ped-bucket-${bucket}-${primitiveIndex}`,
          layout: "instanced-transform-v1",
          vertices: [skinned.vertices],
          indices: { data: skinned.indices, format: skinned.indexFormat },
          bounds: skinned.bounds,
        }),
      );
    }
    buckets.push(meshes);
  }

  const materials = pedData.materials.map((material, index) =>
    device.createMaterial({
      label: `ped-material-${index}`,
      baseColorFactor: material.baseColorFactor,
      metallic: material.metallic,
      roughness: material.roughness,
      emissiveFactor: [0, 0, 0],
      alphaMode: "opaque",
      // The shared GLB marks both materials double-sided. The M0 WebGPU device
      // rejects `doubleSided: true` (no cull-mode state in the pipeline yet),
      // and the ped is a closed mannequin, so single-sided is visually correct.
      doubleSided: false,
    }),
  );

  let trianglesPerPed = 0;
  for (const primitive of pedData.primitives) {
    trianglesPerPed += primitive.geometry.indexCount / 3;
  }
  return {
    skeleton,
    walk,
    buckets,
    materials,
    trianglesPerPed,
    skinning: "cpu-pose-buckets",
    bucketCount: PED_BUCKETS,
  };
}

function parseCell(cell) {
  const [cx, cy] = cell.split(",").map((part) => Number(part));
  return { cx, cy };
}

/**
 * Creates one kinematic character controller per pedestrian and drives them
 * around a 6 m square loop at 1.2 m/s. `origin` is the world position of cell
 * (0,0); layout x/z are cell-local.
 */
export function createPedSimulation({
  rig,
  pedestrians,
  physics,
  origin,
  onError,
}) {
  const states = [];
  for (let index = 0; index < pedestrians.length; index += 1) {
    const ped = pedestrians[index];
    const cell = parseCell(ped.cell);
    const worldX = origin.x + cell.cx * 64 + ped.x;
    const worldZ = origin.z + cell.cy * 64 + ped.z;
    let controller;
    try {
      controller = physics.createCharacter({
        radius: PED_CAPSULE_RADIUS,
        halfHeight: PED_CAPSULE_HALF_HEIGHT,
        position: { x: worldX, y: PED_CAPSULE_CENTER_Y, z: worldZ },
        slopeLimitDegrees: 45,
        stepOffset: 0.3,
        snapToGround: 0.2,
      });
    } catch (error) {
      onError?.(`ped ${index}: character controller failed: ${String(error)}`);
      throw error;
    }
    states.push({
      cell,
      cellKey: ped.cell,
      controller,
      bodyState: {
        position: { x: worldX, y: PED_CAPSULE_CENTER_Y, z: worldZ },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        linearVelocity: { x: 0, y: 0, z: 0 },
        angularVelocity: { x: 0, y: 0, z: 0 },
        sleeping: false,
        enabled: true,
        mass: 70,
        userData: 0,
      },
      corners: [
        { x: worldX + 3, z: worldZ + 3 },
        { x: worldX - 3, z: worldZ + 3 },
        { x: worldX - 3, z: worldZ - 3 },
        { x: worldX + 3, z: worldZ - 3 },
      ],
      target: (ped.waypoint + 1) % 4,
      x: worldX,
      z: worldZ,
      yaw: 0,
      phase: ((ped.waypoint * 0.25) + index * 0.017) % 1,
      bucket: 0,
      active: true,
    });
  }

  const transformsByBucket = [];
  const countsByBucket = new Int32Array(PED_BUCKETS);
  for (let bucket = 0; bucket < PED_BUCKETS; bucket += 1) {
    transformsByBucket.push(new Float32Array(pedestrians.length * 16));
  }
  const desired = { x: 0, y: 0, z: 0 };

  function setActiveCells(isActive) {
    for (const ped of states) {
      const active = isActive(ped.cellKey);
      if (active === ped.active) continue;
      ped.active = active;
      physics.setEnabled(ped.controller.body, active);
    }
  }

  function update(dt) {
    countsByBucket.fill(0);
    for (let index = 0; index < states.length; index += 1) {
      const ped = states[index];
      if (!ped.active) continue;
      const target = ped.corners[ped.target];
      let dx = target.x - ped.x;
      let dz = target.z - ped.z;
      let distance = Math.hypot(dx, dz);
      if (distance < 0.5) {
        ped.target = (ped.target + 1) % 4;
        const next = ped.corners[ped.target];
        dx = next.x - ped.x;
        dz = next.z - ped.z;
        distance = Math.hypot(dx, dz) || 1;
      }
      desired.x = (dx / distance) * PED_SPEED * dt;
      desired.y = 0;
      desired.z = (dz / distance) * PED_SPEED * dt;
      const result = ped.controller.move(desired, dt);
      physics.readBody(ped.controller.body, ped.bodyState);
      ped.x = ped.bodyState.position.x;
      ped.z = ped.bodyState.position.z;
      const moved = Math.hypot(result.moved.x, result.moved.z);
      ped.phase = (ped.phase + moved / PED_STRIDE_METERS) % 1;
      ped.yaw = Math.atan2(dx, dz); // glTF mannequin faces +Z
      ped.bucket = Math.floor(ped.phase * PED_BUCKETS) % PED_BUCKETS;
      const bucket = ped.bucket;
      const offset = countsByBucket[bucket] * 16;
      const halfYaw = ped.yaw * 0.5;
      composeTRS(
        transformsByBucket[bucket],
        offset,
        ped.x,
        0,
        ped.z,
        0,
        Math.sin(halfYaw),
        0,
        Math.cos(halfYaw),
        1,
        1,
        1,
      );
      countsByBucket[bucket] += 1;
    }
  }

  function render(frame) {
    for (let bucket = 0; bucket < PED_BUCKETS; bucket += 1) {
      const count = countsByBucket[bucket];
      if (count === 0) continue;
      const meshes = rig.buckets[bucket];
      for (let primitive = 0; primitive < meshes.length; primitive += 1) {
        frame.drawInstanced(
          meshes[primitive],
          rig.materials[primitive],
          transformsByBucket[bucket],
          count,
        );
      }
    }
  }

  return {
    states,
    setActiveCells,
    update,
    render,
    activeCount: () => {
      let count = 0;
      for (const ped of states) if (ped.active) count += 1;
      return count;
    },
  };
}
