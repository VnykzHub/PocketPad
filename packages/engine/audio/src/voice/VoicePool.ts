/**
 * Pooled voices (spec 09 §5.4, §5.11).
 *
 * Each voice owns its gain and, for the positional pool, its panner (or the
 * stereo-panner fallback) created once at unlock. A fresh
 * `AudioBufferSourceNode` is created per playback; that is the only
 * unavoidable per-play node allocation. Selection scans fixed parallel
 * arrays and allocates nothing; end handlers are preallocated per voice so a
 * play never creates a closure.
 */

import type { AudioHandle, DistanceModel, PanningModel } from "../contracts/audio.js";
import type {
  HostAudioContext,
  HostAudioNode,
  HostBufferSourceNode,
  HostGainNode,
  HostPannerNode,
  HostStereoPannerNode,
} from "../host/types.js";
import { AUDIO_VOICE_STEAL_RAMP_MS } from "../version.js";
import { selectVoiceIndex } from "./VoiceStealing.js";

const DISTANCE_MODEL_CODES: readonly DistanceModel[] = [
  "inverse",
  "linear",
  "exponential",
];

const NOOP = (): void => {
  // Used only if a caller asks for an index outside the pool.
};

export class VoicePool {
  readonly positional: boolean;
  readonly capacity: number;

  readonly active: Uint8Array;
  readonly priorities: Uint8Array;
  readonly startedAt: Float64Array;
  readonly freeAt: Float64Array;
  readonly baseVolume: Float64Array;
  readonly refDistances: Float64Array;
  readonly maxDistances: Float64Array;
  readonly rolloffs: Float64Array;
  readonly distanceModelCodes: Uint8Array;
  readonly assetIds: Array<string | null>;
  readonly handles: Array<AudioHandle | null>;
  readonly gains: Array<HostGainNode | null>;
  readonly panners: Array<HostPannerNode | null>;
  readonly stereoPanners: Array<HostStereoPannerNode | null>;
  readonly sources: Array<HostBufferSourceNode | null>;

  private readonly busLinks: Int8Array;
  private readonly endedHandlers: Array<() => void>;
  private readonly onEnded: (index: number) => void;
  private busGains: readonly HostGainNode[] = [];
  private context: HostAudioContext | null = null;

  constructor(
    capacity: number,
    positional: boolean,
    onEnded: (index: number) => void,
  ) {
    this.capacity = capacity;
    this.positional = positional;
    this.onEnded = onEnded;
    this.active = new Uint8Array(capacity);
    this.priorities = new Uint8Array(capacity);
    this.startedAt = new Float64Array(capacity);
    this.freeAt = new Float64Array(capacity);
    this.baseVolume = new Float64Array(capacity);
    this.refDistances = new Float64Array(capacity);
    this.maxDistances = new Float64Array(capacity);
    this.rolloffs = new Float64Array(capacity);
    this.distanceModelCodes = new Uint8Array(capacity);
    this.assetIds = new Array<string | null>(capacity).fill(null);
    this.handles = new Array<AudioHandle | null>(capacity).fill(null);
    this.gains = new Array<HostGainNode | null>(capacity).fill(null);
    this.panners = new Array<HostPannerNode | null>(capacity).fill(null);
    this.stereoPanners = new Array<HostStereoPannerNode | null>(capacity).fill(null);
    this.sources = new Array<HostBufferSourceNode | null>(capacity).fill(null);
    this.busLinks = new Int8Array(capacity).fill(-1);
    this.endedHandlers = [];
    for (let index = 0; index < capacity; index += 1) {
      const voiceIndex = index;
      this.endedHandlers.push(() => {
        this.handleEnded(voiceIndex);
      });
    }
  }

  build(context: HostAudioContext, busGains: readonly HostGainNode[]): void {
    this.context = context;
    this.busGains = busGains;
    for (let index = 0; index < this.capacity; index += 1) {
      const gain = context.createGain();
      gain.gain.value = 0;
      this.gains[index] = gain;

      if (this.positional && context.createPanner !== undefined) {
        const panner = context.createPanner();
        panner.panningModel = "equalpower";
        panner.distanceModel = "inverse";
        panner.refDistance = 1;
        panner.maxDistance = 100;
        panner.rolloffFactor = 1;
        gain.connect(panner);
        this.panners[index] = panner;
      } else if (this.positional && context.createStereoPanner !== undefined) {
        const stereo = context.createStereoPanner();
        gain.connect(stereo);
        this.stereoPanners[index] = stereo;
      }
    }
  }

  /** True when a PannerNode exists; otherwise callers apply fallback math. */
  get hasNativePanner(): boolean {
    return this.positional && this.context?.createPanner !== undefined;
  }

  get hasStereoPanner(): boolean {
    return this.positional && this.context?.createStereoPanner !== undefined;
  }

  /** Select a voice, releasing expired stops first; −1 means drop. */
  select(requestPriority: number, now: number): number {
    this.releaseExpired(now);
    return selectVoiceIndex(
      this.active,
      this.priorities,
      this.startedAt,
      this.capacity,
      requestPriority,
    );
  }

  /** Prepare a voice for a newly stolen source with the 5 ms ramp. */
  beginSteal(index: number, now: number): void {
    const source = this.sources[index] ?? null;
    if (source !== null) {
      source.onended = null;
      try {
        source.stop(now + AUDIO_VOICE_STEAL_RAMP_MS / 1000);
      } catch {
        // The source already ended; the gain ramp still applies.
      }
      this.sources[index] = null;
    }
    const gain = this.gains[index] ?? null;
    if (gain !== null) {
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(0, now + AUDIO_VOICE_STEAL_RAMP_MS / 1000);
    }
  }

  /** Connect the voice's output (panner, stereo panner or gain) to a bus. */
  connectBus(index: number, busIndexValue: number): void {
    if (this.busLinks[index] === busIndexValue) return;
    const output = this.outputNode(index);
    if (output === null) return;
    const busGain = this.busGains[busIndexValue];
    if (busGain === undefined) return;
    output.disconnect();
    output.connect(busGain);
    this.busLinks[index] = busIndexValue;
  }

  /** Schedule the 5 ms (or caller fade) stop and mark the free time. */
  scheduleStop(index: number, now: number, fadeMs: number): void {
    const source = this.sources[index] ?? null;
    const gain = this.gains[index] ?? null;
    const fadeSeconds = fadeMs > 0 ? fadeMs / 1000 : 0;
    if (source === null) {
      this.release(index);
      return;
    }
    if (gain !== null) {
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      if (fadeSeconds > 0) {
        gain.gain.linearRampToValueAtTime(0, now + fadeSeconds);
      } else {
        gain.gain.setValueAtTime(0, now);
      }
    }
    try {
      source.stop(now + fadeSeconds);
    } catch {
      // Already stopped.
    }
    if (fadeSeconds === 0) {
      this.release(index);
    } else {
      this.freeAt[index] = now + fadeSeconds;
    }
  }

  /** Free every voice whose scheduled stop has elapsed. */
  releaseExpired(now: number): void {
    for (let index = 0; index < this.capacity; index += 1) {
      if (this.active[index] !== 1) continue;
      const free = this.freeAt[index] ?? 0;
      if (free > 0 && now >= free) {
        this.release(index);
      }
    }
  }

  release(index: number): void {
    const source = this.sources[index] ?? null;
    if (source !== null) source.onended = null;
    this.sources[index] = null;
    this.active[index] = 0;
    this.priorities[index] = 0;
    this.startedAt[index] = 0;
    this.freeAt[index] = 0;
    this.assetIds[index] = null;
    this.handles[index] = null;
  }

  /** Stop every voice immediately (dispose / context loss). */
  stopAll(now: number): void {
    for (let index = 0; index < this.capacity; index += 1) {
      if (this.active[index] !== 1) continue;
      this.scheduleStop(index, now, 0);
    }
  }

  outputNode(index: number): HostAudioNode | null {
    return (
      this.panners[index] ??
      this.stereoPanners[index] ??
      this.gains[index] ??
      null
    );
  }

  distanceModelAt(index: number): DistanceModel {
    return DISTANCE_MODEL_CODES[this.distanceModelCodes[index] ?? 0] ?? "inverse";
  }

  distanceModelCode(model: DistanceModel): number {
    switch (model) {
      case "linear":
        return 1;
      case "exponential":
        return 2;
      default:
        return 0;
    }
  }

  panningModelFor(index: number): PanningModel {
    void index;
    return "equalpower";
  }

  /** The preallocated `onended` for a voice; safe to assign to a source. */
  endedHandlerFor(index: number): () => void {
    return this.endedHandlers[index] ?? NOOP;
  }

  private handleEnded(index: number): void {
    if (this.active[index] !== 1) return;
    this.release(index);
    this.onEnded(index);
  }
}
