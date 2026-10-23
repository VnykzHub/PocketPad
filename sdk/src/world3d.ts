/**
 * Game-facing 3D world API (spec 22; Wave 0 contract).
 *
 * Opaque handles only. No Babylon, engine or DOM type appears here; a game
 * talks to `ctx.world` and the host maps it to the active backend. Every
 * additive member is optional on `GameContext`, so a 2D host simply omits it.
 */
import type { Vec3 } from "./game-api.js";

/** Opaque actor/instance identity; never dereference or persist. */
export type WorldHandle = number;

export type WorldErrorCode =
  | "E_WORLD_ASSET"
  | "E_WORLD_LIMIT"
  | "E_WORLD_UNSUPPORTED"
  | "E_WORLD_DISPOSED"
  | "E_WORLD_ARGUMENT";

/** Thrown by world methods; `code` is the stable contract. */
export class WorldError extends Error {
  readonly code: WorldErrorCode;

  constructor(code: WorldErrorCode, message: string) {
    super(message);
    this.name = "WorldError";
    this.code = code;
  }
}

export interface World3DCapabilities {
  readonly backend: "webgpu" | "webgl2";
  readonly tier: "high" | "reduced";
  readonly shadows: boolean;
  readonly post: boolean;
  readonly animation: boolean;
  readonly instances: boolean;
  readonly instanceTint: boolean;
  readonly maxActors: number;
  readonly maxInstances: number;
}

export interface ClipPlayOptions {
  /** Default true. */
  readonly loop?: boolean;
  /** Default 1, clamped 0..10. */
  readonly speed?: number;
  /** Default true. */
  readonly restart?: boolean;
}

export interface FollowOptions {
  /** Default 8 metres. */
  readonly distance?: number;
  /** Default 4 metres. */
  readonly height?: number;
  /** Default 2 metres. */
  readonly lookAhead?: number;
  /** Default 6 per second. */
  readonly smoothing?: number;
}

export type PrimitiveKind = "box" | "sphere" | "cylinder" | "plane" | "ground";
export type ShadowTier = "off" | "low" | "high";
export type SkyPreset = "none" | "day" | "dusk" | "night" | "overcast";
export type ColorGrade = "none" | "warm" | "cool";

export interface PrimitiveOptions {
  /** `#rgb` or `#rrggbb`; default `#ffffff`. */
  readonly color?: string;
  /** `#rgb`/`#rrggbb`, or null/absent for no emissive. */
  readonly emissive?: string | null;
  /** Box/plane/ground edge length; default 1. */
  readonly size?: number;
  /** Sphere/cylinder radius; default 0.5. */
  readonly radius?: number;
  /** Cylinder height; default 1. */
  readonly height?: number;
  /** Sphere/cylinder segments, clamped 8..64. */
  readonly segments?: number;
  /** Default true. */
  readonly visible?: boolean;
}

export interface PostOptions {
  readonly bloom?: boolean;
  /** 0..1. */
  readonly vignette?: number;
  /** Default "none". */
  readonly grade?: ColorGrade;
}

export interface WorldActor {
  readonly id: WorldHandle;
  readonly alive: boolean;
  setPosition(x: number, y: number, z: number): void;
  /** Yaw about +Y in radians. */
  setYaw(radians: number): void;
  setQuaternion(x: number, y: number, z: number, w: number): void;
  setScale(uniform: number): void;
  setScale3(x: number, y: number, z: number): void;
  setTint(color: string | null): void;
  setEmissive(color: string | null): void;
  setVisible(visible: boolean): void;
  playClip(name: string, options?: ClipPlayOptions): void;
  stopClip(fadeSeconds?: number): void;
  crossfadeClip(
    name: string,
    fadeSeconds: number,
    options?: ClipPlayOptions,
  ): void;
  setClipSpeed(speed: number): void;
  dispose(): void;
}

export interface WorldInstances {
  readonly count: number;
  setTransform(
    index: number,
    x: number,
    y: number,
    z: number,
    yaw: number,
    scale: number,
  ): void;
  setVisible(index: number, visible: boolean): void;
  /** No-op when `capabilities.instanceTint` is false. */
  setTintAt(index: number, color: string | null): void;
  dispose(): void;
}

export interface GameWorld3D {
  readonly capabilities: World3DCapabilities;
  hasModel(assetId: string): boolean;
  spawnModel(assetId: string): WorldActor;
  spawnInstances(assetId: string, count: number): WorldInstances;
  createPrimitive(kind: PrimitiveKind, options?: PrimitiveOptions): WorldActor;

  setSun(direction: Vec3, color: string, intensity: number): void;
  setAmbient(color: string, intensity: number): void;
  /** `color: null` clears fog. */
  setFog(color: string | null, near?: number, far?: number): void;
  setSky(preset: SkyPreset): void;
  setSkyTexture(assetId: string | null): void;
  setShadowTier(tier: ShadowTier): void;
  setPost(options: PostOptions): void;

  setCamera(position: Vec3, target: Vec3, fovDegrees?: number): void;
  follow(actor: WorldActor, options?: FollowOptions): void;
  clearFollow(): void;

  /** Host-only: advances clips and follow once per fixed tick before simulate. */
  update(dtSeconds: number): void;
  dispose(): void;
}
