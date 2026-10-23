/**
 * Mesh builders and transform helpers for the custom contender.
 *
 * The renderer ABI (`static-pbr-v1` / `instanced-transform-v1`) takes
 * interleaved position(3) + normal(3) + uv(2) float vertices and column-major
 * 4x4 transforms. Everything here writes into caller-owned arrays: the hot
 * path reuses preallocated transform buffers and never allocates per frame.
 */

const FACES = [
  { normal: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  { normal: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { normal: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  { normal: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { normal: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
];

const CORNERS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

const UVS = [
  [0, 1],
  [1, 1],
  [1, 0],
  [0, 0],
];

/** Axis-aligned box centred on the origin, one interleaved static-pbr-v1 mesh. */
export function createBoxGeometry(sizeX, sizeY, sizeZ) {
  const half = [sizeX / 2, sizeY / 2, sizeZ / 2];
  const vertices = new Float32Array(FACES.length * 4 * 8);
  const indices = new Uint16Array(FACES.length * 6);
  let vertexIndex = 0;
  let indexOffset = 0;

  for (let faceIndex = 0; faceIndex < FACES.length; faceIndex += 1) {
    const face = FACES[faceIndex];
    for (let corner = 0; corner < 4; corner += 1) {
      const su = CORNERS[corner][0];
      const sv = CORNERS[corner][1];
      const offset = vertexIndex * 8;
      vertices[offset] =
        face.normal[0] * half[0] + face.u[0] * su * half[0] + face.v[0] * sv * half[0];
      vertices[offset + 1] =
        face.normal[1] * half[1] + face.u[1] * su * half[1] + face.v[1] * sv * half[1];
      vertices[offset + 2] =
        face.normal[2] * half[2] + face.u[2] * su * half[2] + face.v[2] * sv * half[2];
      vertices[offset + 3] = face.normal[0];
      vertices[offset + 4] = face.normal[1];
      vertices[offset + 5] = face.normal[2];
      vertices[offset + 6] = UVS[corner][0];
      vertices[offset + 7] = UVS[corner][1];
      vertexIndex += 1;
    }
    const base = faceIndex * 4;
    indices[indexOffset] = base;
    indices[indexOffset + 1] = base + 1;
    indices[indexOffset + 2] = base + 2;
    indices[indexOffset + 3] = base;
    indices[indexOffset + 4] = base + 2;
    indices[indexOffset + 5] = base + 3;
    indexOffset += 6;
  }

  return {
    vertices,
    indices,
    indexFormat: "uint16",
    triangles: FACES.length * 2,
    bounds: { center: { x: 0, y: 0, z: 0 }, radius: Math.hypot(half[0], half[1], half[2]) },
  };
}

/** Flat XZ plane centred on the origin, facing +Y. */
export function createPlaneGeometry(sizeX, sizeZ) {
  const hx = sizeX / 2;
  const hz = sizeZ / 2;
  // position(3), normal(3), uv(2)
  const vertices = new Float32Array([
    -hx, 0, hz, 0, 1, 0, 0, 1,
    hx, 0, hz, 0, 1, 0, 1, 1,
    hx, 0, -hz, 0, 1, 0, 1, 0,
    -hx, 0, -hz, 0, 1, 0, 0, 0,
  ]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  return {
    vertices,
    indices,
    indexFormat: "uint16",
    triangles: 2,
    bounds: { center: { x: 0, y: 0, z: 0 }, radius: Math.hypot(hx, hz) },
  };
}

/**
 * Inward-facing sky box. The camera sits inside, so the winding is reversed
 * per triangle; the material is unlit, so only the UV gradient matters.
 */
export function createSkyGeometry(halfExtent) {
  const box = createBoxGeometry(halfExtent * 2, halfExtent * 2, halfExtent * 2);
  const indices = new Uint16Array(box.indices.length);
  for (let i = 0; i < box.indices.length; i += 3) {
    indices[i] = box.indices[i];
    indices[i + 1] = box.indices[i + 2];
    indices[i + 2] = box.indices[i + 1];
  }
  // Map each vertex's v to a global 0..1 height so a vertical gradient
  // texture spans ground-to-zenith across every inward face.
  const vertices = box.vertices;
  const faceHeight = halfExtent * 2;
  for (let face = 0; face < FACES.length; face += 1) {
    for (let corner = 0; corner < 4; corner += 1) {
      const vertex = face * 4 + corner;
      const y = vertices[vertex * 8 + 1];
      vertices[vertex * 8 + 7] = (y + halfExtent) / faceHeight;
    }
  }
  return {
    vertices,
    indices,
    indexFormat: "uint16",
    triangles: box.triangles,
    bounds: { center: { x: 0, y: 0, z: 0 }, radius: halfExtent * Math.sqrt(3) },
  };
}

/** Circle on the XZ plane, used for contact shadows under the car and peds. */
export function createDiscGeometry(radius, segments = 24) {
  const vertices = new Float32Array((segments + 2) * 8);
  // centre
  vertices[0] = 0;
  vertices[1] = 0;
  vertices[2] = 0;
  vertices[3] = 0;
  vertices[4] = 1;
  vertices[5] = 0;
  vertices[6] = 0.5;
  vertices[7] = 0.5;
  for (let segment = 0; segment <= segments; segment += 1) {
    const angle = (segment / segments) * Math.PI * 2;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    const offset = (segment + 1) * 8;
    vertices[offset] = x;
    vertices[offset + 1] = 0;
    vertices[offset + 2] = z;
    vertices[offset + 3] = 0;
    vertices[offset + 4] = 1;
    vertices[offset + 5] = 0;
    vertices[offset + 6] = 0.5 + Math.cos(angle) * 0.5;
    vertices[offset + 7] = 0.5 + Math.sin(angle) * 0.5;
  }
  const indices = new Uint16Array(segments * 3);
  for (let segment = 0; segment < segments; segment += 1) {
    const out = segment * 3;
    // Reverse winding vs. the (cos, sin) sweep so the face points at +Y.
    indices[out] = 0;
    indices[out + 1] = segment + 2;
    indices[out + 2] = segment + 1;
  }
  return {
    vertices,
    indices,
    indexFormat: "uint16",
    triangles: segments,
    bounds: { center: { x: 0, y: 0, z: 0 }, radius },
  };
}

/** Vertical RGBA gradient as sRGB bytes, used by the unlit sky material. */
export function createSkyBytes(width, height) {
  const bytes = new Uint8Array(width * height * 4);
  const horizon = [176, 198, 214];
  const zenith = [46, 86, 140];
  for (let y = 0; y < height; y += 1) {
    const t = y / (height - 1);
    const r = Math.round(horizon[0] + (zenith[0] - horizon[0]) * t);
    const g = Math.round(horizon[1] + (zenith[1] - horizon[1]) * t);
    const b = Math.round(horizon[2] + (zenith[2] - horizon[2]) * t);
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      bytes[offset] = r;
      bytes[offset + 1] = g;
      bytes[offset + 2] = b;
      bytes[offset + 3] = 255;
    }
  }
  return bytes;
}

export function writeIdentity(out, offset = 0) {
  out[offset] = 1; out[offset + 1] = 0; out[offset + 2] = 0; out[offset + 3] = 0;
  out[offset + 4] = 0; out[offset + 5] = 1; out[offset + 6] = 0; out[offset + 7] = 0;
  out[offset + 8] = 0; out[offset + 9] = 0; out[offset + 10] = 1; out[offset + 11] = 0;
  out[offset + 12] = 0; out[offset + 13] = 0; out[offset + 14] = 0; out[offset + 15] = 1;
}

/**
 * Column-major T * R * S with a normalized (x, y, z, w) quaternion and
 * per-axis scale. This is the general form for glTF node transforms,
 * building heights (sy = height) and physics poses.
 */
export function composeTRS(out, offset, px, py, pz, qx, qy, qz, qw, sx, sy, sz) {
  const x2 = qx + qx;
  const y2 = qy + qy;
  const z2 = qz + qz;
  const xx = qx * x2;
  const xy = qx * y2;
  const xz = qx * z2;
  const yy = qy * y2;
  const yz = qy * z2;
  const zz = qz * z2;
  const wx = qw * x2;
  const wy = qw * y2;
  const wz = qw * z2;
  out[offset] = (1 - (yy + zz)) * sx;
  out[offset + 1] = (xy + wz) * sx;
  out[offset + 2] = (xz - wy) * sx;
  out[offset + 3] = 0;
  out[offset + 4] = (xy - wz) * sy;
  out[offset + 5] = (1 - (xx + zz)) * sy;
  out[offset + 6] = (yz + wx) * sy;
  out[offset + 7] = 0;
  out[offset + 8] = (xz + wy) * sz;
  out[offset + 9] = (yz - wx) * sz;
  out[offset + 10] = (1 - (xx + yy)) * sz;
  out[offset + 11] = 0;
  out[offset + 12] = px;
  out[offset + 13] = py;
  out[offset + 14] = pz;
  out[offset + 15] = 1;
}

/** Column-major TRS with yaw-only rotation (Y up). */
export function writeTRS(out, offset, x, y, z, yawRadians, scale = 1) {
  const c = Math.cos(yawRadians);
  const s = Math.sin(yawRadians);
  out[offset] = c * scale; out[offset + 1] = 0; out[offset + 2] = -s * scale; out[offset + 3] = 0;
  out[offset + 4] = 0; out[offset + 5] = scale; out[offset + 6] = 0; out[offset + 7] = 0;
  out[offset + 8] = s * scale; out[offset + 9] = 0; out[offset + 10] = c * scale; out[offset + 11] = 0;
  out[offset + 12] = x; out[offset + 13] = y; out[offset + 14] = z; out[offset + 15] = 1;
}

/** Column-major TRS with Ry(yaw) * Rx(pitch): wheel steer then spin. */
export function writeEulerTRS(out, offset, x, y, z, yaw, pitchX) {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cx = Math.cos(pitchX);
  const sx = Math.sin(pitchX);
  out[offset] = cy; out[offset + 1] = 0; out[offset + 2] = -sy; out[offset + 3] = 0;
  out[offset + 4] = sy * sx; out[offset + 5] = cx; out[offset + 6] = cy * sx; out[offset + 7] = 0;
  out[offset + 8] = sy * cx; out[offset + 9] = -sx; out[offset + 10] = cy * cx; out[offset + 11] = 0;
  out[offset + 12] = x; out[offset + 13] = y; out[offset + 14] = z; out[offset + 15] = 1;
}

/** Composes parent * local into `out` (column-major), for wheel transforms. */
export function multiplyMatrices(out, outOffset, parent, parentOffset, local, localOffset) {
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) {
        sum +=
          parent[parentOffset + k * 4 + row] *
          local[localOffset + column * 4 + k];
      }
      out[outOffset + column * 4 + row] = sum;
    }
  }
}
