/**
 * Per-action merge, engagement, hysteresis and edge resolution (10 §5.8.3–5).
 *
 * Rules:
 *  - button: value = max(scaled source level), clamped 0..1;
 *  - axis: value = |clamp(sum of scaled components, -1, 1)|;
 *  - vector2: components summed, the vector normalized above 1, `yUp`
 *    negating only the stored y (value is computed before the flip).
 *
 * Engagement is per binding: digital sources at level >= 1, analog sources
 * with threshold/hysteresis. Edges OR the per-binding edge with the source's
 * pending edge. Bit 0 is the aggregate; bit i+1 is binding i.
 */

import type { InputActionKind } from "../contracts/input.js";

export interface ActionReading {
  x: number;
  y: number;
  hasX: boolean;
  hasY: boolean;
  scaleX: number;
  scaleY: number;
  /** True for keys, pad buttons and phone buttons. */
  digital: boolean;
  pendingPress: boolean;
  pendingRelease: boolean;
}

export interface ResolvedActionState {
  x: number;
  y: number;
  value: number;
  pressed: boolean;
  released: boolean;
  edges: number;
  releaseEdges: number;
}

export function createActionReading(): ActionReading {
  return {
    x: 0,
    y: 0,
    hasX: false,
    hasY: false,
    scaleX: 1,
    scaleY: 1,
    digital: false,
    pendingPress: false,
    pendingRelease: false,
  };
}

export function resetActionReading(reading: ActionReading): void {
  reading.x = 0;
  reading.y = 0;
  reading.hasX = false;
  reading.hasY = false;
  reading.scaleX = 1;
  reading.scaleY = 1;
  reading.digital = false;
  reading.pendingPress = false;
  reading.pendingRelease = false;
}

export function createResolvedActionState(): ResolvedActionState {
  return {
    x: 0,
    y: 0,
    value: 0,
    pressed: false,
    released: true,
    edges: 0,
    releaseEdges: 0,
  };
}

/** Engage at `threshold`; disengage only at or below `threshold - hysteresis`. */
export function hysteresisEngage(
  value: number,
  threshold: number,
  hysteresis: number,
  engaged: boolean,
): boolean {
  if (engaged) return value > threshold - hysteresis;
  return value >= threshold;
}

function readingMagnitude(reading: ActionReading): number {
  const x = reading.x;
  const y = reading.y;
  let magnitude = 0;
  if (reading.hasX && reading.hasY) magnitude = Math.hypot(x, y);
  else if (reading.hasX) magnitude = Math.abs(x);
  else if (reading.hasY) magnitude = Math.abs(y);
  return Number.isFinite(magnitude) ? magnitude : 0;
}

function clampSigned(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value > 1) return 1;
  if (value < -1) return -1;
  return value;
}

/**
 * Resolves one action. `previousEngaged` is updated in place to the new
 * per-binding engagement; the returned boolean is the new aggregate button
 * engagement (other kinds return `previousAggregateEngaged` unchanged).
 */
export function resolveAction(
  kind: InputActionKind,
  threshold: number,
  hysteresis: number,
  yUp: boolean,
  readings: readonly ActionReading[],
  previousEngaged: Uint8Array,
  previousAggregateEngaged: boolean,
  out: ResolvedActionState,
): boolean {
  let edges = 0;
  let releaseEdges = 0;

  for (let index = 0; index < readings.length; index += 1) {
    const reading = readings[index];
    if (reading === undefined) continue;
    const magnitude = readingMagnitude(reading);
    const wasEngaged =
      index < previousEngaged.length && previousEngaged[index] === 1;
    const engaged = reading.digital
      ? magnitude >= 1
      : hysteresisEngage(magnitude, threshold, hysteresis, wasEngaged);
    if (index < previousEngaged.length) {
      previousEngaged[index] = engaged ? 1 : 0;
    }
    if (index < 15) {
      const bit = 1 << (index + 1);
      if (reading.pendingPress || (engaged && !wasEngaged)) edges |= bit;
      if (reading.pendingRelease || (!engaged && wasEngaged)) releaseEdges |= bit;
    }
  }

  let x = 0;
  let y = 0;
  let value = 0;

  if (kind === "button") {
    let merged = 0;
    for (const reading of readings) {
      if (reading.hasX) {
        const candidate = reading.x * reading.scaleX;
        if (candidate > merged) merged = candidate;
      }
      if (reading.hasY) {
        const candidate = reading.y * reading.scaleY;
        if (candidate > merged) merged = candidate;
      }
    }
    value = clampSigned(merged);
    if (value < 0) value = 0;
    x = value;
    y = 0;
    const aggregate = hysteresisEngage(value, threshold, hysteresis, previousAggregateEngaged);
    out.pressed = aggregate;
    out.released = !aggregate;
    out.x = x;
    out.y = y;
    out.value = value;
    out.edges = edges !== 0 ? edges | 1 : 0;
    out.releaseEdges = releaseEdges !== 0 ? releaseEdges | 1 : 0;
    return aggregate;
  }

  if (kind === "axis") {
    let sum = 0;
    for (const reading of readings) {
      if (reading.hasX) sum += reading.x * reading.scaleX;
      if (reading.hasY) sum += reading.y * reading.scaleY;
    }
    x = clampSigned(sum);
    value = Math.abs(x);
    out.pressed = value >= threshold;
    out.released = value <= threshold - hysteresis;
  } else {
    let sx = 0;
    let sy = 0;
    for (const reading of readings) {
      if (reading.hasX) sx += reading.x * reading.scaleX;
      if (reading.hasY) sy += reading.y * reading.scaleY;
    }
    if (!Number.isFinite(sx)) sx = 0;
    if (!Number.isFinite(sy)) sy = 0;
    const length = Math.hypot(sx, sy);
    if (length > 1) {
      sx /= length;
      sy /= length;
    }
    value = length > 1 ? 1 : length;
    if (!Number.isFinite(value)) {
      value = 0;
      sx = 0;
      sy = 0;
    }
    x = sx;
    y = yUp ? -sy : sy;
    out.pressed = value >= threshold;
    out.released = value <= threshold - hysteresis;
  }

  out.x = x;
  out.y = y;
  out.value = value;
  out.edges = edges !== 0 ? edges | 1 : 0;
  out.releaseEdges = releaseEdges !== 0 ? releaseEdges | 1 : 0;
  return previousAggregateEngaged;
}
