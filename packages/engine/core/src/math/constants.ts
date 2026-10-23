/**
 * Scalar constants and helpers (02 §3.2).
 *
 * All angles are radians. Tolerances are fixed by 02 §3.9; do not introduce
 * new epsilon constants at call sites. Every function here is allocation-free
 * on its success path.
 */

export const PI: number = Math.PI;
export const TWO_PI: number = Math.PI * 2;
export const HALF_PI: number = Math.PI / 2;
export const DEG2RAD: number = Math.PI / 180;
export const RAD2DEG: number = 180 / Math.PI;

/** 1e-6, float32-derived comparisons. */
export const EPSILON: number = 1e-6;
/** 1e-9, pure-double scalar comparisons. */
export const EPSILON_SCALAR: number = 1e-9;
/** 1e-12, pure-double intermediate comparisons. */
export const EPSILON_DOUBLE: number = 1e-12;

/**
 * `?debug=1` or anything other than `NODE_ENV=production` is a dev build.
 * Dev builds enforce argument contracts (02 §3.2, §3.6) and count silent
 * degeneracies. Release builds never throw from math functions.
 *
 * @internal Not part of the 02 public surface; excluded from the barrel.
 */
export const IS_DEV: boolean = (() => {
  const env = (
    globalThis as { process?: { env?: { NODE_ENV?: string } } }
  ).process?.env?.NODE_ENV;
  if (env !== undefined && env !== "production") {
    return true;
  }
  if (typeof location !== "undefined" && location.search.includes("debug=1")) {
    return true;
  }
  return env === undefined;
})();

/**
 * Dev-only diagnostics counters (02 §3.8, §5.3). They make silent
 * degeneracies countable; they never change results.
 *
 * @internal Not part of the 02 public surface; excluded from the barrel.
 */
export const DEV_COUNTERS = {
  zeroQuaternion: 0,
  frustumNormalizeFailure: 0,
};

export function clamp(value: number, min: number, max: number): number {
  if (IS_DEV && min > max) {
    throw new RangeError("clamp: min must be <= max");
  }
  return value < min ? min : value > max ? max : value;
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Inverse of `lerp`; returns 0 when `a === b` (no valid interval). */
export function inverseLerp(a: number, b: number, value: number): number {
  return a === b ? 0 : (value - a) / (b - a);
}

export function degToRad(degrees: number): number {
  return degrees * DEG2RAD;
}

export function radToDeg(radians: number): number {
  return radians * RAD2DEG;
}

/** Wraps to (-PI, PI]. */
export function wrapAngle(radians: number): number {
  const wrapped = radians - TWO_PI * Math.floor((radians + PI) / TWO_PI);
  // The floor form yields [-PI, PI); the contract is half-open on the other
  // end, so map exactly -PI to PI.
  return wrapped <= -PI ? PI : wrapped;
}

/** Moves `current` toward `target` by at most `maxDelta`, across the wrap. */
export function moveTowardAngle(
  current: number,
  target: number,
  maxDelta: number,
): number {
  if (!(maxDelta > 0)) {
    return wrapAngle(current);
  }
  const delta = wrapAngle(target - current);
  if (Math.abs(delta) <= maxDelta) {
    return wrapAngle(target);
  }
  return wrapAngle(current + Math.sign(delta) * maxDelta);
}

/** Default epsilon is `EPSILON_SCALAR` (02 §3.9). */
export function approximatelyEqual(
  a: number,
  b: number,
  epsilon: number = EPSILON_SCALAR,
): boolean {
  return Math.abs(a - b) <= epsilon;
}
