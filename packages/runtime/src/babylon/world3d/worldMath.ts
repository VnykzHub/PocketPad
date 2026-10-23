/**
 * Pure decisions for the Babylon world adapter (spec 22).
 *
 * Nothing here imports Babylon or touches a GPU, so Node tests can pin the
 * contract decisions (tier mapping, clamps, quaternion forward, follow maths)
 * without loading the engine. Hot-path helpers write through caller-owned
 * out parameters and allocate nothing.
 */
import type {
  ShadowTier,
  SkyPreset,
  World3DCapabilities,
} from "@lanpad/sdk";

export type WorldBackend = "webgpu" | "webgl2";
export type WorldTier = "high" | "reduced";

export interface WorldLimits {
  readonly maxActors: number;
  readonly maxInstances: number;
}

/** High tier is WebGPU, reduced is WebGL2 (spec 22 §4). */
export function tierForBackend(backend: WorldBackend): WorldTier {
  return backend === "webgpu" ? "high" : "reduced";
}

/** Conservative ceilings: one actor is one draw group, instances share one. */
export const DEFAULT_WORLD_LIMITS: Readonly<Record<WorldTier, WorldLimits>> = {
  high: { maxActors: 512, maxInstances: 2048 },
  reduced: { maxActors: 256, maxInstances: 1024 },
};

export const DEFAULT_FOV_DEGREES = 60;
export const MIN_FOV_DEGREES = 20;
export const MAX_FOV_DEGREES = 110;

export const DEFAULT_CLIP_SPEED = 1;
export const MAX_CLIP_SPEED = 10;

export const DEFAULT_FOLLOW_DISTANCE = 8;
export const DEFAULT_FOLLOW_HEIGHT = 4;
export const DEFAULT_FOLLOW_LOOK_AHEAD = 2;
export const DEFAULT_FOLLOW_SMOOTHING = 6;
const MAX_FOLLOW_DISTANCE = 500;
const MAX_FOLLOW_SMOOTHING = 60;
const MAX_FRAME_SECONDS = 0.25;

export const DEFAULT_PRIMITIVE_SIZE = 1;
export const DEFAULT_PRIMITIVE_RADIUS = 0.5;
export const DEFAULT_PRIMITIVE_HEIGHT = 1;
export const DEFAULT_PRIMITIVE_SEGMENTS = 16;
const MIN_SEGMENTS = 8;
const MAX_SEGMENTS = 64;

const DEFAULT_FOG_NEAR = 10;
const DEFAULT_FOG_FAR = 100;

export interface CapabilityOverrides {
  readonly maxActors?: number;
  readonly maxInstances?: number;
  /** False when the backend never runs post-processing. */
  readonly post?: boolean;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

/**
 * Capability table for a backend. Post is true only on the high tier; shadow
 * and post availability can be lowered by the adapter if creation fails, so
 * callers must still read the live object.
 */
export function createWorldCapabilities(
  backend: WorldBackend,
  overrides: CapabilityOverrides = {},
): World3DCapabilities {
  const tier = tierForBackend(backend);
  const limits = DEFAULT_WORLD_LIMITS[tier];
  return {
    backend,
    tier,
    shadows: true,
    post: overrides.post ?? tier === "high",
    animation: true,
    instances: true,
    // Per-instance tint needs a custom shader; reporting false is honest and
    // games fall back to per-actor meshes (spec 22 §9).
    instanceTint: false,
    maxActors: positiveInteger(overrides.maxActors, limits.maxActors),
    maxInstances: positiveInteger(overrides.maxInstances, limits.maxInstances),
  };
}

/** `null`, non-finite and negative values become the default speed. */
export function clampClipSpeed(speed: number | undefined): number {
  if (speed === undefined || !Number.isFinite(speed) || speed < 0) {
    return DEFAULT_CLIP_SPEED;
  }
  return speed > MAX_CLIP_SPEED ? MAX_CLIP_SPEED : speed;
}

/** Default 60°, clamped 20..110 (spec 22 §3). */
export function clampFov(fovDegrees: number | undefined): number {
  if (fovDegrees === undefined || !Number.isFinite(fovDegrees)) {
    return DEFAULT_FOV_DEGREES;
  }
  if (fovDegrees < MIN_FOV_DEGREES) return MIN_FOV_DEGREES;
  if (fovDegrees > MAX_FOV_DEGREES) return MAX_FOV_DEGREES;
  return fovDegrees;
}

/** Light intensity is 0..10; anything unusable becomes 0. */
export function clampLightIntensity(intensity: number | undefined): number {
  if (intensity === undefined || !Number.isFinite(intensity)) return 0;
  if (intensity < 0) return 0;
  if (intensity > 10) return 10;
  return intensity;
}

/** Sphere/cylinder segments, clamped 8..64 (spec 22 §2). */
export function clampSegments(segments: number | undefined): number {
  if (segments === undefined || !Number.isFinite(segments)) {
    return DEFAULT_PRIMITIVE_SEGMENTS;
  }
  const rounded = Math.floor(segments);
  if (rounded < MIN_SEGMENTS) return MIN_SEGMENTS;
  if (rounded > MAX_SEGMENTS) return MAX_SEGMENTS;
  return rounded;
}

export function isFiniteVec3(x: number, y: number, z: number): boolean {
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
}

export function isFiniteQuaternion(
  x: number,
  y: number,
  z: number,
  w: number,
): boolean {
  return (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    Number.isFinite(z) &&
    Number.isFinite(w)
  );
}

export function nonNegativeOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

export function positiveOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

export interface FogRangeOut {
  near: number;
  far: number;
}

/** Fog range into caller storage; near is kept below far. */
export function fogRangeTo(
  near: number | undefined,
  far: number | undefined,
  out: FogRangeOut,
): void {
  const safeNear =
    near !== undefined && Number.isFinite(near) && near >= 0
      ? near
      : DEFAULT_FOG_NEAR;
  const safeFar =
    far !== undefined && Number.isFinite(far) && far > safeNear
      ? far
      : Math.max(DEFAULT_FOG_FAR, safeNear + 1);
  out.near = safeNear;
  out.far = safeFar;
}

/** Convenience wrapper for tests and cold paths. */
export function fogRange(
  near: number | undefined,
  far: number | undefined,
): { readonly near: number; readonly far: number } {
  const out = { near: 0, far: 0 };
  fogRangeTo(near, far, out);
  return out;
}

export interface QuaternionOut {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface Vec3Out {
  x: number;
  y: number;
  z: number;
}

/** Yaw about +Y into a quaternion, allocation-free. */
export function yawToQuaternion(yaw: number, out: QuaternionOut): void {
  if (!Number.isFinite(yaw)) {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    out.w = 1;
    return;
  }
  const half = yaw * 0.5;
  out.x = 0;
  out.y = Math.sin(half);
  out.z = 0;
  out.w = Math.cos(half);
}

/**
 * Rotates the spec's forward vector (0, 0, -1) by a quaternion.
 * The formula is the rotation of that fixed vector, so no vector is allocated.
 */
export function quaternionForward(
  x: number,
  y: number,
  z: number,
  w: number,
  out: Vec3Out,
): void {
  const lengthSquared = x * x + y * y + z * z + w * w;
  if (lengthSquared <= 0 || !Number.isFinite(lengthSquared)) {
    out.x = 0;
    out.y = 0;
    out.z = -1;
    return;
  }
  const scale = 1 / Math.sqrt(lengthSquared);
  const qx = x * scale;
  const qy = y * scale;
  const qz = z * scale;
  const qw = w * scale;
  out.x = -2 * qw * qy - 2 * qz * qx;
  out.y = 2 * qw * qx - 2 * qz * qy;
  out.z = -1 + 2 * (qx * qx + qy * qy);
}

/** Horizontal component of `quaternionForward`, normalized; falls back to -Z. */
export function horizontalForward(
  x: number,
  y: number,
  z: number,
  w: number,
  out: Vec3Out,
): void {
  quaternionForward(x, y, z, w, out);
  const length = Math.sqrt(out.x * out.x + out.z * out.z);
  if (length < 1e-6) {
    out.x = 0;
    out.z = -1;
    return;
  }
  out.x /= length;
  out.z /= length;
}

export interface FollowTargetOut {
  /** Desired camera position. */
  px: number;
  py: number;
  pz: number;
  /** Desired look target. */
  tx: number;
  ty: number;
  tz: number;
}

/** Chase pose behind an actor's horizontal forward, allocation-free. */
export function computeFollowTarget(
  actorX: number,
  actorY: number,
  actorZ: number,
  forwardX: number,
  forwardZ: number,
  distance: number,
  height: number,
  lookAhead: number,
  out: FollowTargetOut,
): void {
  out.px = actorX - forwardX * distance;
  out.py = actorY + height;
  out.pz = actorZ - forwardZ * distance;
  out.tx = actorX + forwardX * lookAhead;
  out.ty = actorY;
  out.tz = actorZ + forwardZ * lookAhead;
}

/**
 * Exponential smoothing alpha for a per-second smoothing factor. Frame-rate
 * independent because the host feeds fixed-tick dt.
 */
export function smoothingAlpha(smoothing: number, dtSeconds: number): number {
  if (!Number.isFinite(smoothing) || smoothing <= 0) return 1;
  if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return 0;
  const boundedDt =
    dtSeconds > MAX_FRAME_SECONDS ? MAX_FRAME_SECONDS : dtSeconds;
  const boundedSmoothing =
    smoothing > MAX_FOLLOW_SMOOTHING ? MAX_FOLLOW_SMOOTHING : smoothing;
  return 1 - Math.exp(-boundedSmoothing * boundedDt);
}

export interface FollowOptionsClamped {
  readonly distance: number;
  readonly height: number;
  readonly lookAhead: number;
  readonly smoothing: number;
}

/** Mutable caller storage so `follow()` and `update()` allocate nothing. */
export interface FollowConfig {
  distance: number;
  height: number;
  lookAhead: number;
  smoothing: number;
}

export function clampFollowOptionsTo(
  options: {
    readonly distance?: number;
    readonly height?: number;
    readonly lookAhead?: number;
    readonly smoothing?: number;
  },
  out: FollowConfig,
): void {
  const distance = options.distance;
  const height = options.height;
  const lookAhead = options.lookAhead;
  const smoothing = options.smoothing;
  out.distance =
    distance !== undefined && Number.isFinite(distance) && distance >= 0
      ? Math.min(distance, MAX_FOLLOW_DISTANCE)
      : DEFAULT_FOLLOW_DISTANCE;
  out.height =
    height !== undefined && Number.isFinite(height)
      ? Math.max(-MAX_FOLLOW_DISTANCE, Math.min(height, MAX_FOLLOW_DISTANCE))
      : DEFAULT_FOLLOW_HEIGHT;
  out.lookAhead =
    lookAhead !== undefined && Number.isFinite(lookAhead)
      ? Math.max(-MAX_FOLLOW_DISTANCE, Math.min(lookAhead, MAX_FOLLOW_DISTANCE))
      : DEFAULT_FOLLOW_LOOK_AHEAD;
  out.smoothing =
    smoothing !== undefined && Number.isFinite(smoothing) && smoothing >= 0
      ? Math.min(smoothing, MAX_FOLLOW_SMOOTHING)
      : DEFAULT_FOLLOW_SMOOTHING;
}

/** Convenience wrapper for tests and cold paths. */
export function clampFollowOptions(options: {
  readonly distance?: number;
  readonly height?: number;
  readonly lookAhead?: number;
  readonly smoothing?: number;
}): FollowOptionsClamped {
  const out: FollowConfig = {
    distance: DEFAULT_FOLLOW_DISTANCE,
    height: DEFAULT_FOLLOW_HEIGHT,
    lookAhead: DEFAULT_FOLLOW_LOOK_AHEAD,
    smoothing: DEFAULT_FOLLOW_SMOOTHING,
  };
  clampFollowOptionsTo(options, out);
  return out;
}

/**
 * Advisory tiers: a game may ask for high shadows on WebGL2 and get low
 * (spec 22 §3 "the adapter may clamp them to the capability tier").
 */
export function effectiveShadowTier(
  requested: ShadowTier,
  backend: WorldBackend,
): ShadowTier {
  if (requested === "off") return "off";
  if (backend === "webgl2" && requested === "high") return "low";
  return requested;
}

/** Shadow map edge in pixels; 0 means no shadow pass. */
export function shadowMapSize(tier: ShadowTier): number {
  if (tier === "high") return 2048;
  if (tier === "low") return 512;
  return 0;
}

export interface SkyPresetColors {
  /** Skybox emissive colour when no texture is set. */
  readonly emissive: readonly [number, number, number];
  /** Scene clear colour used while this preset is active. */
  readonly clear: readonly [number, number, number, number];
}

export const SKY_PRESET_COLORS: Readonly<
  Record<Exclude<SkyPreset, "none">, SkyPresetColors>
> = {
  day: {
    emissive: [0.52, 0.68, 0.9],
    clear: [0.52, 0.68, 0.9, 1],
  },
  dusk: {
    emissive: [0.72, 0.38, 0.22],
    clear: [0.3, 0.18, 0.17, 1],
  },
  night: {
    emissive: [0.03, 0.05, 0.12],
    clear: [0.01, 0.015, 0.04, 1],
  },
  overcast: {
    emissive: [0.62, 0.65, 0.68],
    clear: [0.55, 0.58, 0.62, 1],
  },
};
