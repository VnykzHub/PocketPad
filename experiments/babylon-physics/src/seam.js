/**
 * Engine-neutral helpers shared by both backends and the scenario suite.
 *
 * Hashes are FNV-1a 32 over the raw float64 bits of observable state. They are
 * only compared between two runs of the same backend (a determinism check),
 * never across backends: two different solvers are not expected to agree.
 */

const HASH_VIEW = new DataView(new ArrayBuffer(8));

export function hashNumbers(values, seed = 0x811c9dc5) {
  let hash = seed >>> 0;
  for (let i = 0; i < values.length; i += 1) {
    HASH_VIEW.setFloat64(0, values[i], true);
    for (let byte = 0; byte < 8; byte += 1) {
      hash ^= HASH_VIEW.getUint8(byte);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash.toString(16).padStart(8, "0");
}

export function round(value, digits = 3) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export function summarize(samples, digits = 3) {
  if (samples.length === 0) {
    return { count: 0, p50: null, p95: null, p99: null, min: null, max: null, mean: null };
  }
  const sorted = samples.slice().sort((a, b) => a - b);
  const at = (percent) => {
    const index = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil((percent / 100) * sorted.length) - 1),
    );
    return sorted[index];
  };
  let total = 0;
  for (let i = 0; i < samples.length; i += 1) total += samples[i];
  return {
    count: samples.length,
    p50: round(at(50), digits),
    p95: round(at(95), digits),
    p99: round(at(99), digits),
    min: round(sorted[0], digits),
    max: round(sorted[sorted.length - 1], digits),
    mean: round(total / samples.length, digits),
  };
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Rotate a plain {x,y,z} vector by a plain quaternion into `out`. */
export function rotateVector(quaternion, vector, out) {
  const { x: qx, y: qy, z: qz, w: qw } = quaternion;
  const { x, y, z } = vector;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out.x = x + qw * tx + (qy * tz - qz * ty);
  out.y = y + qw * ty + (qz * tx - qx * tz);
  out.z = z + qw * tz + (qx * ty - qy * tx);
  return out;
}

export function yawFromQuaternion(quaternion) {
  const { x, y, z, w } = quaternion;
  return Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + z * z));
}

export function angleDelta(a, b) {
  let delta = a - b;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
