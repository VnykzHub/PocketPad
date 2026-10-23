/**
 * Minimal glTF-binary reader for the shared bake-off assets.
 *
 * The engine's `@lanpad/engine-assets` M0 decoder accepts one mesh with
 * POSITION/NORMAL/TEXCOORD_0, so two shared assets need a contender-side
 * reader:
 *   - car.glb has five meshes (body + four wheels) -> the engine rejects it.
 *   - ped.glb carries JOINTS_0 / WEIGHTS_0, has no UVs and two primitives,
 *     plus a `walk` clip -> the engine loader rejects it.
 * This file deliberately handles only the subset the shared assets use:
 * GLB 2.0, embedded BIN, float positions/normals, optional UVs, u8/u16/u32
 * joints and indices, node TRS, one skin, and LINEAR/STEP animation samplers.
 */

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

const COMPONENT = {
  5120: { read: "getInt8", bytes: 1 },
  5121: { read: "getUint8", bytes: 1 },
  5122: { read: "getInt16", bytes: 2 },
  5123: { read: "getUint16", bytes: 2 },
  5125: { read: "getUint32", bytes: 4 },
  5126: { read: "getFloat32", bytes: 4 },
};

const COMPONENTS = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

export function parseGlb(buffer) {
  if (!(buffer instanceof ArrayBuffer)) {
    throw new Error("parseGlb: expected an ArrayBuffer");
  }
  const view = new DataView(buffer);
  if (buffer.byteLength < 20) throw new Error("parseGlb: file is too small");
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error("parseGlb: not a GLB");
  if (view.getUint32(4, true) !== 2) throw new Error("parseGlb: GLB version is not 2");
  if (view.getUint32(8, true) !== buffer.byteLength) {
    throw new Error("parseGlb: length header does not match the file");
  }

  let offset = 12;
  let json = null;
  let binOffset = -1;
  let binLength = 0;
  while (offset + 8 <= buffer.byteLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + chunkLength > buffer.byteLength) {
      throw new Error("parseGlb: chunk runs past the file");
    }
    if (chunkType === CHUNK_JSON) {
      const text = new TextDecoder().decode(
        new Uint8Array(buffer, start, chunkLength),
      );
      json = JSON.parse(text);
    } else if (chunkType === CHUNK_BIN) {
      binOffset = start;
      binLength = chunkLength;
    }
    offset = start + chunkLength;
  }
  if (json === null) throw new Error("parseGlb: missing JSON chunk");
  if (binOffset < 0) throw new Error("parseGlb: missing BIN chunk");
  return { json, view, binOffset, binLength };
}

/**
 * Reads one accessor into a Float32Array of raw component values.
 * Returns `{ values, components, count, componentType }`.
 */
export function readAccessor(glb, accessorIndex) {
  const accessor = glb.json.accessors?.[accessorIndex];
  if (accessor === undefined) {
    throw new Error(`readAccessor: accessor ${accessorIndex} does not exist`);
  }
  const bufferView = glb.json.bufferViews?.[accessor.bufferView];
  if (bufferView === undefined) {
    throw new Error(`readAccessor: bufferView ${accessor.bufferView} does not exist`);
  }
  const component = COMPONENT[accessor.componentType];
  const components = COMPONENTS[accessor.type];
  if (component === undefined || components === undefined) {
    throw new Error(
      `readAccessor: unsupported accessor ${accessor.componentType}/${accessor.type}`,
    );
  }
  const count = accessor.count;
  const stride = bufferView.byteStride ?? component.bytes * components;
  const base =
    glb.binOffset + (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const values = new Float32Array(count * components);
  for (let element = 0; element < count; element += 1) {
    const elementOffset = base + element * stride;
    for (let part = 0; part < components; part += 1) {
      values[element * components + part] = glb.view[component.read](
        elementOffset + part * component.bytes,
        true,
      );
    }
  }
  return { values, components, count, componentType: accessor.componentType };
}

/** Bytes of one embedded image, copied out of the GLB buffer. */
export function extractImage(glb, imageIndex) {
  const image = glb.json.images?.[imageIndex];
  if (image === undefined) {
    throw new Error(`extractImage: image ${imageIndex} does not exist`);
  }
  if (image.bufferView === undefined) {
    throw new Error("extractImage: external image URIs are not supported");
  }
  const view = glb.json.bufferViews?.[image.bufferView];
  if (view === undefined) {
    throw new Error(`extractImage: bufferView ${image.bufferView} does not exist`);
  }
  const start = glb.binOffset + (view.byteOffset ?? 0);
  return {
    mimeType: image.mimeType ?? "image/png",
    bytes: new Uint8Array(glb.view.buffer, start, view.byteLength).slice(),
  };
}

export function nodeTRS(json, nodeIndex) {
  const node = json.nodes?.[nodeIndex];
  if (node === undefined) throw new Error(`nodeTRS: node ${nodeIndex} does not exist`);
  const t = node.translation ?? [0, 0, 0];
  const r = node.rotation ?? [0, 0, 0, 1];
  const s = node.scale ?? [1, 1, 1];
  return {
    translation: [t[0] ?? 0, t[1] ?? 0, t[2] ?? 0],
    rotation: [r[0] ?? 0, r[1] ?? 0, r[2] ?? 0, r[3] ?? 1],
    scale: [s[0] ?? 1, s[1] ?? 1, s[2] ?? 1],
  };
}

/**
 * Converts a primitive's attributes into renderer-ready arrays. NORMAL and
 * TEXCOORD_0 are optional; missing values get an up normal and uv (0, 0) so
 * the shared ped (which has neither UVs nor textures) still lands in the
 * static-pbr-v1 ABI.
 */
export function primitiveGeometry(glb, meshIndex, primitiveIndex = 0) {
  const primitive = glb.json.meshes?.[meshIndex]?.primitives?.[primitiveIndex];
  if (primitive === undefined) {
    throw new Error(
      `primitiveGeometry: mesh ${meshIndex} primitive ${primitiveIndex} does not exist`,
    );
  }
  const position = readAccessor(glb, primitive.attributes.POSITION);
  const normal =
    primitive.attributes.NORMAL === undefined
      ? null
      : readAccessor(glb, primitive.attributes.NORMAL);
  const uv =
    primitive.attributes.TEXCOORD_0 === undefined
      ? null
      : readAccessor(glb, primitive.attributes.TEXCOORD_0);
  if (normal !== null && normal.count !== position.count) {
    throw new Error("primitiveGeometry: normal count differs from positions");
  }
  if (uv !== null && uv.count !== position.count) {
    throw new Error("primitiveGeometry: uv count differs from positions");
  }
  let indexValues;
  if (primitive.indices === undefined) {
    indexValues = new Uint32Array(position.count);
    for (let i = 0; i < position.count; i += 1) indexValues[i] = i;
  } else {
    const index = readAccessor(glb, primitive.indices);
    indexValues = index.values;
  }
  let maxIndex = 0;
  for (let i = 0; i < indexValues.length; i += 1) {
    if (indexValues[i] > maxIndex) maxIndex = indexValues[i];
  }
  const indices =
    maxIndex < 65536
      ? Uint16Array.from(indexValues)
      : Uint32Array.from(indexValues);
  return {
    positions: position.values,
    normals: normal === null ? null : normal.values,
    uvs: uv === null ? null : uv.values,
    indices,
    indexFormat: indices instanceof Uint16Array ? "uint16" : "uint32",
    vertexCount: position.count,
    indexCount: indices.length,
    materialSlot: primitive.material ?? -1,
  };
}

/** Packs position/normal/uv into the renderer's static-pbr-v1 ABI. */
export function interleave(geometry) {
  const { positions, normals, uvs, vertexCount } = geometry;
  const vertices = new Float32Array(vertexCount * 8);
  for (let i = 0; i < vertexCount; i += 1) {
    const out = i * 8;
    vertices[out] = positions[i * 3];
    vertices[out + 1] = positions[i * 3 + 1];
    vertices[out + 2] = positions[i * 3 + 2];
    if (normals === null) {
      vertices[out + 3] = 0;
      vertices[out + 4] = 1;
      vertices[out + 5] = 0;
    } else {
      vertices[out + 3] = normals[i * 3];
      vertices[out + 4] = normals[i * 3 + 1];
      vertices[out + 5] = normals[i * 3 + 2];
    }
    vertices[out + 6] = uvs === null ? 0 : uvs[i * 2];
    vertices[out + 7] = uvs === null ? 0 : uvs[i * 2 + 1];
  }
  return vertices;
}

export function boundsOf(positions) {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 };
  let radiusSq = 0;
  for (let i = 0; i < positions.length; i += 3) {
    const dx = positions[i] - center.x;
    const dy = positions[i + 1] - center.y;
    const dz = positions[i + 2] - center.z;
    const distance = dx * dx + dy * dy + dz * dz;
    if (distance > radiusSq) radiusSq = distance;
  }
  return { center, radius: Math.sqrt(radiusSq) };
}

const WHEEL_NAMES = ["wheel-fl", "wheel-fr", "wheel-rl", "wheel-rr"];

/**
 * Body + four named wheel nodes, taken from the shared car.glb contract.
 * Each part keeps its node-local geometry and its node TRS so the caller can
 * place the body and spin each wheel about local X.
 */
export function readCar(glb) {
  const json = glb.json;
  const nodeByName = new Map();
  for (let nodeIndex = 0; nodeIndex < (json.nodes?.length ?? 0); nodeIndex += 1) {
    const node = json.nodes[nodeIndex];
    if (node?.name !== undefined) nodeByName.set(node.name, nodeIndex);
  }
  const partFor = (name) => {
    const nodeIndex = nodeByName.get(name);
    if (nodeIndex === undefined) throw new Error(`readCar: node "${name}" is missing`);
    const node = json.nodes[nodeIndex];
    if (node.mesh === undefined) throw new Error(`readCar: node "${name}" has no mesh`);
    const trs = nodeTRS(json, nodeIndex);
    return {
      name,
      nodeIndex,
      meshIndex: node.mesh,
      geometry: primitiveGeometry(glb, node.mesh, 0),
      translation: trs.translation,
      rotation: trs.rotation,
      scale: trs.scale,
    };
  };

  const body = partFor("body");
  const wheels = WHEEL_NAMES.map(partFor);
  const image = (json.images?.length ?? 0) > 0 ? extractImage(glb, 0) : null;
  return {
    body,
    wheels,
    material: {
      name: json.materials?.[0]?.name ?? "colormap",
      baseColorFactor: [1, 1, 1, 1],
      metallic: 0,
      roughness: 0.75,
      doubleSided: json.materials?.[0]?.doubleSided === true,
      image,
    },
  };
}

/**
 * Skinned pedestrian: both primitives with joint influences, the skeleton
 * source and the `walk` animation source in the shapes
 * `@lanpad/engine-animation` compiles.
 */
export function readPed(glb) {
  const json = glb.json;
  const mesh = json.meshes?.[0];
  if (mesh === undefined) throw new Error("readPed: mesh 0 is missing");
  const skin = json.skins?.[0];
  if (skin === undefined) throw new Error("readPed: no skin");

  const primitives = mesh.primitives.map((primitive, index) => {
    const geometry = primitiveGeometry(glb, 0, index);
    const joints = readAccessor(glb, primitive.attributes.JOINTS_0);
    const weights = readAccessor(glb, primitive.attributes.WEIGHTS_0);
    if (joints.count !== geometry.vertexCount || weights.count !== geometry.vertexCount) {
      throw new Error(`readPed: primitive ${index} joint data count differs`);
    }
    return { geometry, joints: joints.values, weights: weights.values };
  });

  const jointNodes = skin.joints;
  const jointCount = jointNodes.length;
  const parentOfNode = new Map();
  for (let nodeIndex = 0; nodeIndex < (json.nodes?.length ?? 0); nodeIndex += 1) {
    const node = json.nodes[nodeIndex];
    for (const child of node.children ?? []) parentOfNode.set(child, nodeIndex);
  }
  const jointIndexByNode = new Map(jointNodes.map((node, index) => [node, index]));
  const parents = new Int16Array(jointCount);
  const jointNames = [];
  const restTranslations = new Float32Array(jointCount * 3);
  const restRotations = new Float32Array(jointCount * 4);
  const restScales = new Float32Array(jointCount * 3);
  for (let joint = 0; joint < jointCount; joint += 1) {
    const node = jointNodes[joint];
    jointNames.push(json.nodes[node]?.name ?? `joint-${joint}`);
    const parentNode = parentOfNode.get(node);
    parents[joint] = parentNode !== undefined && jointIndexByNode.has(parentNode)
      ? jointIndexByNode.get(parentNode)
      : -1;
    if (parents[joint] >= joint) {
      throw new Error("readPed: skin joints are not topological");
    }
    const trs = nodeTRS(json, node);
    restTranslations.set(trs.translation, joint * 3);
    restRotations.set(trs.rotation, joint * 4);
    restScales.set(trs.scale, joint * 3);
  }
  const inverseBindMatrices = skin.inverseBindMatrices === undefined
    ? new Float32Array(jointCount * 16)
    : readAccessor(glb, skin.inverseBindMatrices).values;

  const skeleton = {
    id: "ped",
    jointNames,
    parents,
    // glTF stores column-major matrices, which is the engine's layout.
    inverseBindMatrices,
    restTranslations,
    restRotations,
    restScales,
    rootJoint: parents.indexOf(-1),
  };

  const animation = (json.animations ?? []).find((entry) => entry.name === "walk");
  if (animation === undefined) throw new Error("readPed: no walk animation");
  const tracks = [];
  for (const channel of animation.channels) {
    const joint = jointIndexByNode.get(channel.target.node);
    if (joint === undefined) continue;
    const sampler = animation.samplers[channel.sampler];
    const times = readAccessor(glb, sampler.input).values;
    const values = readAccessor(glb, sampler.output).values;
    tracks.push({
      target: joint,
      path: channel.target.path,
      interpolation: sampler.interpolation === "STEP" ? "step" : "linear",
      times,
      values,
    });
  }
  const duration = tracks.reduce((longest, track) => {
    const last = track.times[track.times.length - 1] ?? 0;
    return Math.max(longest, last);
  }, 0);
  const walk = { name: "walk", duration: duration > 0 ? duration : 1, tracks, loop: "repeat" };

  const materials = (json.materials ?? []).map((material) => {
    const pbr = material.pbrMetallicRoughness ?? {};
    return {
      name: material.name ?? "",
      baseColorFactor: pbr.baseColorFactor ?? [1, 1, 1, 1],
      metallic: pbr.metallicFactor ?? 1,
      roughness: pbr.roughnessFactor ?? 1,
      doubleSided: material.doubleSided === true,
    };
  });

  return { primitives, skeleton, walk, materials };
}
