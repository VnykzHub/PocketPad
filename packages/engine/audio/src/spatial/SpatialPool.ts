/**
 * Positional voice pool (spec 09 §5.4, §5.5, §5.9).
 *
 * Each voice owns a gain and a `PannerNode` created once at unlock. When
 * `createPanner` is missing the pool falls back to a `StereoPannerNode` and
 * engine-side equal-power pan plus the documented distance models; when that
 * is missing too, attenuation is applied to the voice gain with no panning.
 * Position writes allocate nothing.
 */

import type {
  HostAudioParam,
  HostPannerNode,
} from "../host/types.js";
import { AUDIO_GAIN_SMOOTHING_SECONDS } from "../version.js";
import { VoicePool } from "../voice/VoicePool.js";
import { distanceGain, panForSource } from "./distance.js";
import type { EngineListener } from "./Listener.js";

function writeSmooth(param: HostAudioParam | undefined, value: number, now: number): void {
  if (param === undefined) return;
  if (param.setTargetAtTime !== undefined) {
    param.setTargetAtTime(value, now, AUDIO_GAIN_SMOOTHING_SECONDS);
  } else {
    param.setValueAtTime(value, now);
  }
}

function writePannerPosition(
  panner: HostPannerNode,
  x: number,
  y: number,
  z: number,
  now: number,
): void {
  if (panner.positionX !== undefined) {
    writeSmooth(panner.positionX, x, now);
    writeSmooth(panner.positionY, y, now);
    writeSmooth(panner.positionZ, z, now);
    return;
  }
  panner.setPosition?.(x, y, z);
}

export class SpatialPool extends VoicePool {
  /** Last source position per voice, for listener-motion refresh. */
  readonly posX: Float64Array;
  readonly posY: Float64Array;
  readonly posZ: Float64Array;
  /** Engine-side attenuation when no `PannerNode` exists; 1 otherwise. */
  readonly attenuation: Float64Array;

  constructor(capacity: number, onEnded: (index: number) => void) {
    super(capacity, true, onEnded);
    this.posX = new Float64Array(capacity);
    this.posY = new Float64Array(capacity);
    this.posZ = new Float64Array(capacity);
    this.attenuation = new Float64Array(capacity).fill(1);
  }

  /**
   * Distance attenuation for a voice, using its stored model parameters. The
   * browser's `PannerNode` owns this when it exists (09 §5.5); the value is
   * only consumed on the fallback path.
   */
  attenuationForVoice(
    index: number,
    x: number,
    y: number,
    z: number,
    listener: EngineListener,
  ): number {
    const dx = x - listener.x;
    const dy = y - listener.y;
    const dz = z - listener.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return distanceGain(
      this.distanceModelAt(index),
      distance,
      this.refDistances[index] ?? 1,
      this.maxDistances[index] ?? 100,
      this.rolloffs[index] ?? 1,
    );
  }

  /** Store and apply a source position; allocation-free. */
  applyPosition(
    index: number,
    x: number,
    y: number,
    z: number,
    listener: EngineListener,
    now: number,
  ): void {
    this.posX[index] = x;
    this.posY[index] = y;
    this.posZ[index] = z;

    const panner = this.panners[index] ?? null;
    if (panner !== null) {
      writePannerPosition(panner, x, y, z, now);
      return;
    }

    this.attenuation[index] = this.attenuationForVoice(index, x, y, z, listener);
    this.applyFallbackGain(index, now);

    const stereo = this.stereoPanners[index] ?? null;
    if (stereo !== null) {
      const pan = panForSource(
        x,
        y,
        z,
        listener.x,
        listener.y,
        listener.z,
        listener.forwardX,
        listener.forwardY,
        listener.forwardZ,
        listener.upX,
        listener.upY,
        listener.upZ,
      );
      writeSmooth(stereo.pan, pan, now);
    }
  }

  /** Re-apply every active fallback voice after the listener moved. */
  refreshFallback(listener: EngineListener, now: number): void {
    if (this.hasNativePanner) return;
    for (let index = 0; index < this.capacity; index += 1) {
      if (this.active[index] !== 1) continue;
      this.applyPosition(
        index,
        this.posX[index] ?? 0,
        this.posY[index] ?? 0,
        this.posZ[index] ?? 0,
        listener,
        now,
      );
    }
  }

  /** The gain a fallback voice should hold: base volume × attenuation. */
  fallbackGain(index: number): number {
    return (this.baseVolume[index] ?? 1) * (this.attenuation[index] ?? 1);
  }

  private applyFallbackGain(index: number, now: number): void {
    const gain = this.gains[index] ?? null;
    if (gain === null) return;
    writeSmooth(gain.gain, this.fallbackGain(index), now);
  }
}
