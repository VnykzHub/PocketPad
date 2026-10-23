/**
 * Vec2 (02 §3.3). Legacy 2D convention: +X right, +Y down, positive angle
 * clockwise on screen. Plain mutable data, never a class.
 *
 * Every function with an `out` parameter reads its inputs before writing, so
 * `out` may alias any input.
 */

import { EPSILON, PI } from "./constants.js";

export interface Vec2 {
  x: number;
  y: number;
}

/** Allocates; cold path only. */
export function vec2Create(x: number = 0, y: number = 0): Vec2 {
  return { x, y };
}

export function vec2Set(out: Vec2, x: number, y: number): Vec2 {
  out.x = x;
  out.y = y;
  return out;
}

export function vec2Copy(out: Vec2, a: Vec2): Vec2 {
  const x = a.x;
  const y = a.y;
  out.x = x;
  out.y = y;
  return out;
}

export function vec2Add(out: Vec2, a: Vec2, b: Vec2): Vec2 {
  const x = a.x + b.x;
  const y = a.y + b.y;
  out.x = x;
  out.y = y;
  return out;
}

export function vec2Sub(out: Vec2, a: Vec2, b: Vec2): Vec2 {
  const x = a.x - b.x;
  const y = a.y - b.y;
  out.x = x;
  out.y = y;
  return out;
}

export function vec2Scale(out: Vec2, a: Vec2, scalar: number): Vec2 {
  const x = a.x * scalar;
  const y = a.y * scalar;
  out.x = x;
  out.y = y;
  return out;
}

export function vec2AddScaled(
  out: Vec2,
  a: Vec2,
  b: Vec2,
  scalar: number,
): Vec2 {
  const x = a.x + b.x * scalar;
  const y = a.y + b.y * scalar;
  out.x = x;
  out.y = y;
  return out;
}

export function vec2Negate(out: Vec2, a: Vec2): Vec2 {
  const x = -a.x;
  const y = -a.y;
  out.x = x;
  out.y = y;
  return out;
}

export function vec2Dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

/** Scalar z component of the 3D cross product. */
export function vec2Cross(a: Vec2, b: Vec2): number {
  return a.x * b.y - a.y * b.x;
}

export function vec2LengthSq(a: Vec2): number {
  return a.x * a.x + a.y * a.y;
}

export function vec2Length(a: Vec2): number {
  return Math.sqrt(a.x * a.x + a.y * a.y);
}

export function vec2DistanceSq(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function vec2Distance(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Writes the unit vector and returns the original length; zero writes (0,0). */
export function vec2Normalize(out: Vec2, a: Vec2): number {
  const x = a.x;
  const y = a.y;
  const length = Math.sqrt(x * x + y * y);
  if (length > 0) {
    out.x = x / length;
    out.y = y / length;
  } else {
    out.x = 0;
    out.y = 0;
  }
  return length;
}

export function vec2Lerp(out: Vec2, a: Vec2, b: Vec2, t: number): Vec2 {
  const x = a.x + (b.x - a.x) * t;
  const y = a.y + (b.y - a.y) * t;
  out.x = x;
  out.y = y;
  return out;
}

export function vec2Min(out: Vec2, a: Vec2, b: Vec2): Vec2 {
  const x = a.x < b.x ? a.x : b.x;
  const y = a.y < b.y ? a.y : b.y;
  out.x = x;
  out.y = y;
  return out;
}

export function vec2Max(out: Vec2, a: Vec2, b: Vec2): Vec2 {
  const x = a.x > b.x ? a.x : b.x;
  const y = a.y > b.y ? a.y : b.y;
  out.x = x;
  out.y = y;
  return out;
}

/** Clamps the length; a non-positive `maxLength` collapses to (0,0). */
export function vec2ClampLength(
  out: Vec2,
  a: Vec2,
  maxLength: number,
): Vec2 {
  const x = a.x;
  const y = a.y;
  const length = Math.sqrt(x * x + y * y);
  if (length <= maxLength || length === 0) {
    out.x = x;
    out.y = y;
  } else {
    const scale = maxLength > 0 ? maxLength / length : 0;
    out.x = x * scale;
    out.y = y * scale;
  }
  return out;
}

/**
 * Positive radians rotate clockwise on screen (y-down). The matrix is the
 * ordinary 2D rotation; the y-down axis makes it read as clockwise.
 */
export function vec2Rotate(out: Vec2, a: Vec2, radians: number): Vec2 {
  const x = a.x;
  const y = a.y;
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  out.x = x * c - y * s;
  out.y = x * s + y * c;
  return out;
}

/** Angle in (-PI, PI], measured from +X toward +Y (clockwise on screen). */
export function vec2Angle(a: Vec2): number {
  const angle = Math.atan2(a.y, a.x);
  return angle <= -PI ? PI : angle;
}

/** Default `length` is 1. */
export function vec2FromAngle(
  out: Vec2,
  radians: number,
  length: number = 1,
): Vec2 {
  out.x = Math.cos(radians) * length;
  out.y = Math.sin(radians) * length;
  return out;
}

/** Clockwise +90° perpendicular: (-y, x). */
export function vec2Perp(out: Vec2, a: Vec2): Vec2 {
  const x = a.x;
  const y = a.y;
  out.x = -y;
  out.y = x;
  return out;
}

export function vec2Equals(
  a: Vec2,
  b: Vec2,
  epsilon: number = EPSILON,
): boolean {
  return Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon;
}
