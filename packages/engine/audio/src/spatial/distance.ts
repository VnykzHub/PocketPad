/**
 * Fallback spatial math (spec 09 §5.5, §5.9).
 *
 * The primary positional path is the browser's `PannerNode`: 09 §5.5 says the
 * engine does not implement a second attenuation curve, so these functions
 * run **only** when `createPanner` is missing. The documented models are the
 * Web Audio ones:
 *
 *   inverse:      ref / (ref + rolloff * (max(d, ref) − ref))
 *   linear:       1 − rolloff * (d − ref) / (max − ref), clamped to [0, 1]
 *   exponential:  (max(d, ref) / ref) ^ (−rolloff)
 *
 * `d` is clamped to `maxDistance` first, so the inverse model floors at
 * `ref / max`. At ref = 1, rolloff = 1, max = 100 the fixture values are
 * 1 m → 1, 5 m → 0.2, 20 m → 0.05 and 200 m → 0.01 (09 §7, ER-09-03 cases).
 */

import type { DistanceModel } from "../contracts/audio.js";

/** Monotonic non-increasing in distance; 1 inside `refDistance`. */
export function distanceGain(
  model: DistanceModel,
  distance: number,
  refDistance: number,
  maxDistance: number,
  rolloff: number,
): number {
  const ref = refDistance > 0 ? refDistance : 1;
  const max = maxDistance > ref ? maxDistance : ref;
  const d = distance > max ? max : distance;
  if (!(d > ref)) return 1;

  if (model === "linear") {
    const span = max - ref;
    const value = span > 0 ? 1 - (rolloff * (d - ref)) / span : 1;
    return value < 0 ? 0 : value > 1 ? 1 : value;
  }
  if (model === "exponential") {
    return Math.pow(d / ref, -rolloff);
  }
  // inverse
  return ref / (ref + rolloff * (d - ref));
}

/**
 * Equal-power pan gains for a pan position in [−1, 1].
 * −1 is hard left, 0 is centre, +1 is hard right.
 */
export function equalPowerGains(pan: number): { left: number; right: number } {
  const clamped = pan < -1 ? -1 : pan > 1 ? 1 : pan;
  const angle = ((clamped + 1) * Math.PI) / 4;
  return { left: Math.cos(angle), right: Math.sin(angle) };
}

/**
 * Signed pan of a source against a listener basis, in [−1, 1].
 *
 * The listener convention is the renderer's (02 §3.5): right-handed, +Y up,
 * camera forward −Z. `right = normalize(cross(forward, up))`, so a source at
 * +X is right and −X is left (ER-09-02). The direction is not normalised by
 * callers; this function divides by `distance`.
 */
export function panForSource(
  sourceX: number,
  sourceY: number,
  sourceZ: number,
  listenerX: number,
  listenerY: number,
  listenerZ: number,
  forwardX: number,
  forwardY: number,
  forwardZ: number,
  upX: number,
  upY: number,
  upZ: number,
): number {
  const dx = sourceX - listenerX;
  const dy = sourceY - listenerY;
  const dz = sourceZ - listenerZ;
  const distanceSq = dx * dx + dy * dy + dz * dz;
  if (distanceSq < 1e-12) return 0;

  // right = forward × up
  const rightX = forwardY * upZ - forwardZ * upY;
  const rightY = forwardZ * upX - forwardX * upZ;
  const rightZ = forwardX * upY - forwardY * upX;
  const rightLengthSq = rightX * rightX + rightY * rightY + rightZ * rightZ;
  if (rightLengthSq < 1e-12) return 0;

  const projection =
    (dx * rightX + dy * rightY + dz * rightZ) / Math.sqrt(rightLengthSq);
  const distance = Math.sqrt(distanceSq);
  const pan = projection / distance;
  return pan < -1 ? -1 : pan > 1 ? 1 : pan;
}
