/**
 * Listener writes (spec 09 §3.2, §5.5).
 *
 * The listener is written from the camera once per tick. The convention is
 * the renderer's (02 §3.5): right-handed, +Y up, a camera looks down −Z;
 * `setFromTransform` derives forward as `quatRotate(rotation, (0, 0, −1))`
 * and defaults up to world +Y. Position and orientation updates use
 * `positionX/…` AudioParams with `setTargetAtTime(…, 0.01)` when present and
 * fall back to `setPosition`/`setOrientation` (09 §5.9). No call allocates.
 */

import { quatRotateVec3, vec3Normalize } from "@lanpad/engine-core";
import type { Quat, Vec3 } from "@lanpad/engine-core";
import type { AudioListener } from "../contracts/audio.js";
import type {
  HostAudioContext,
  HostAudioListener,
  HostAudioParam,
} from "../host/types.js";

const MINUS_Z: Vec3 = { x: 0, y: 0, z: -1 };
const WORLD_UP: Vec3 = { x: 0, y: 1, z: 0 };
const FALLBACK_UP: Vec3 = { x: 0, y: 0, z: -1 };

/** Forward/up longer or shorter than this are treated as unusable. */
const EPSILON = 1e-9;

function writeParam(param: HostAudioParam | undefined, value: number, now: number): void {
  if (param === undefined) return;
  if (param.setTargetAtTime !== undefined) {
    param.setTargetAtTime(value, now, 0.01);
  } else {
    param.setValueAtTime(value, now);
  }
}

export class EngineListener implements AudioListener {
  private readonly onChange: () => void;
  private readonly forward: Vec3 = { x: 0, y: 0, z: -1 };
  private readonly up: Vec3 = { x: 0, y: 1, z: 0 };
  private readonly scratch: Vec3 = { x: 0, y: 0, z: 0 };
  private context: HostAudioContext | null = null;
  private posX = 0;
  private posY = 0;
  private posZ = 0;

  constructor(onChange: () => void) {
    this.onChange = onChange;
  }

  attach(context: HostAudioContext | null): void {
    this.context = context;
    if (context !== null) this.apply();
  }

  setPosition(x: number, y: number, z: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    this.posX = x;
    this.posY = y;
    this.posZ = z;
    this.apply();
    this.onChange();
  }

  setOrientation(
    fx: number,
    fy: number,
    fz: number,
    ux: number,
    uy: number,
    uz: number,
  ): void {
    if (
      !Number.isFinite(fx) ||
      !Number.isFinite(fy) ||
      !Number.isFinite(fz) ||
      !Number.isFinite(ux) ||
      !Number.isFinite(uy) ||
      !Number.isFinite(uz)
    ) {
      return;
    }
    this.scratch.x = fx;
    this.scratch.y = fy;
    this.scratch.z = fz;
    const forwardLength = vec3Normalize(this.scratch, this.scratch);
    if (forwardLength < EPSILON) return;
    this.forward.x = this.scratch.x;
    this.forward.y = this.scratch.y;
    this.forward.z = this.scratch.z;

    this.scratch.x = ux;
    this.scratch.y = uy;
    this.scratch.z = uz;
    const upLength = vec3Normalize(this.scratch, this.scratch);
    if (upLength < EPSILON) {
      this.copyFallbackUp();
    } else {
      this.up.x = this.scratch.x;
      this.up.y = this.scratch.y;
      this.up.z = this.scratch.z;
    }
    this.orthogonalizeUp();
    this.apply();
    this.onChange();
  }

  setFromTransform(position: Vec3, rotation: Quat, up?: Vec3): void {
    this.posX = position.x;
    this.posY = position.y;
    this.posZ = position.z;

    quatRotateVec3(this.scratch, rotation, MINUS_Z);
    const length = vec3Normalize(this.scratch, this.scratch);
    if (length >= EPSILON) {
      this.forward.x = this.scratch.x;
      this.forward.y = this.scratch.y;
      this.forward.z = this.scratch.z;
    }

    if (up === undefined) {
      this.copyFallbackUp();
    } else {
      const upLengthSq = up.x * up.x + up.y * up.y + up.z * up.z;
      if (upLengthSq < EPSILON * EPSILON) {
        this.copyFallbackUp();
      } else {
        this.up.x = up.x;
        this.up.y = up.y;
        this.up.z = up.z;
      }
    }
    this.orthogonalizeUp();
    this.apply();
    this.onChange();
  }

  get x(): number {
    return this.posX;
  }

  get y(): number {
    return this.posY;
  }

  get z(): number {
    return this.posZ;
  }

  get forwardX(): number {
    return this.forward.x;
  }

  get forwardY(): number {
    return this.forward.y;
  }

  get forwardZ(): number {
    return this.forward.z;
  }

  get upX(): number {
    return this.up.x;
  }

  get upY(): number {
    return this.up.y;
  }

  get upZ(): number {
    return this.up.z;
  }

  private copyFallbackUp(): void {
    this.up.x = FALLBACK_UP.x;
    this.up.y = FALLBACK_UP.y;
    this.up.z = FALLBACK_UP.z;
    // A camera looking along ±Y still needs a usable up; keep +Y unless it
    // would be parallel, in which case −Z is the conventional choice.
    const dot =
      this.forward.x * WORLD_UP.x +
      this.forward.y * WORLD_UP.y +
      this.forward.z * WORLD_UP.z;
    if (Math.abs(dot) < 0.999999) {
      this.up.x = WORLD_UP.x;
      this.up.y = WORLD_UP.y;
      this.up.z = WORLD_UP.z;
    }
  }

  /** Gram–Schmidt: remove the forward component from up, then normalise. */
  private orthogonalizeUp(): void {
    const dot =
      this.up.x * this.forward.x +
      this.up.y * this.forward.y +
      this.up.z * this.forward.z;
    this.scratch.x = this.up.x - dot * this.forward.x;
    this.scratch.y = this.up.y - dot * this.forward.y;
    this.scratch.z = this.up.z - dot * this.forward.z;
    const length = vec3Normalize(this.scratch, this.scratch);
    if (length < EPSILON) {
      this.copyFallbackUp();
      return;
    }
    this.up.x = this.scratch.x;
    this.up.y = this.scratch.y;
    this.up.z = this.scratch.z;
  }

  private apply(): void {
    const context = this.context;
    if (context === null) return;
    const listener = context.listener;
    if (listener === undefined) return;
    const now = context.currentTime;
    this.applyPosition(listener, now);
    this.applyOrientation(listener, now);
  }

  private applyPosition(listener: HostAudioListener, now: number): void {
    if (listener.positionX !== undefined) {
      writeParam(listener.positionX, this.posX, now);
      writeParam(listener.positionY, this.posY, now);
      writeParam(listener.positionZ, this.posZ, now);
      return;
    }
    listener.setPosition?.(this.posX, this.posY, this.posZ);
  }

  private applyOrientation(listener: HostAudioListener, now: number): void {
    if (listener.forwardX !== undefined) {
      writeParam(listener.forwardX, this.forward.x, now);
      writeParam(listener.forwardY, this.forward.y, now);
      writeParam(listener.forwardZ, this.forward.z, now);
      writeParam(listener.upX, this.up.x, now);
      writeParam(listener.upY, this.up.y, now);
      writeParam(listener.upZ, this.up.z, now);
      return;
    }
    listener.setOrientation?.(
      this.forward.x,
      this.forward.y,
      this.forward.z,
      this.up.x,
      this.up.y,
      this.up.z,
    );
  }
}
