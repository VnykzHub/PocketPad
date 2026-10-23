/**
 * Internal structural seams for Web Audio (spec 09 §3.1, §5.3, §5.9).
 *
 * The frozen contract deliberately exposes only opaque `AudioContextLike` and
 * `AudioBufferLike` views (see `src/contracts/audio.d.ts`). The host modules
 * that actually build the graph need the node factory surface, so it is
 * declared here and reached only through a single cast at the factory
 * boundary. No game-facing signature names these types.
 *
 * Optional members model the documented fallbacks (09 §5.9): a context
 * without `createPanner` uses `createStereoPanner`, a context without either
 * uses gain-only attenuation, a listener may expose AudioParams or only the
 * deprecated `setPosition`/`setOrientation` calls.
 */

import type {
  AudioContextLike,
  AudioContextStateLike,
  AudioMediaElementLike,
} from "../contracts/audio.js";

/** The subset of `AudioParam` the engine schedules against. */
export interface HostAudioParam {
  value: number;
  setValueAtTime(value: number, time: number): void;
  linearRampToValueAtTime(value: number, time: number): void;
  /** 09 §5.3/§5.5 per-frame smoothing; absent on minimal fakes. */
  setTargetAtTime?(target: number, startTime: number, timeConstant: number): void;
  cancelScheduledValues(startTime: number): void;
  /** 09 §5.6 equal-power crossfade; absent on some TV browsers (09 §5.9). */
  setValueCurveAtTime?(
    values: Float32Array,
    startTime: number,
    duration: number,
  ): void;
}

export interface HostAudioNode {
  connect(destination: HostAudioNode): unknown;
  disconnect(): void;
}

export interface HostGainNode extends HostAudioNode {
  readonly gain: HostAudioParam;
}

export interface HostStereoPannerNode extends HostAudioNode {
  readonly pan: HostAudioParam;
}

/** AudioParams preferred by 09 §5.5; fallback is `setPosition`. */
export interface HostAudioListener {
  readonly positionX?: HostAudioParam;
  readonly positionY?: HostAudioParam;
  readonly positionZ?: HostAudioParam;
  readonly forwardX?: HostAudioParam;
  readonly forwardY?: HostAudioParam;
  readonly forwardZ?: HostAudioParam;
  readonly upX?: HostAudioParam;
  readonly upY?: HostAudioParam;
  readonly upZ?: HostAudioParam;
  setPosition?(x: number, y: number, z: number): void;
  setOrientation?(
    forwardX: number,
    forwardY: number,
    forwardZ: number,
    upX: number,
    upY: number,
    upZ: number,
  ): void;
}

export type HostPanningModel = "equalpower" | "HRTF";
export type HostDistanceModel = "inverse" | "linear" | "exponential";

export interface HostPannerNode extends HostAudioNode {
  panningModel: HostPanningModel;
  distanceModel: HostDistanceModel;
  refDistance: number;
  maxDistance: number;
  rolloffFactor: number;
  readonly positionX?: HostAudioParam;
  readonly positionY?: HostAudioParam;
  readonly positionZ?: HostAudioParam;
  setPosition?(x: number, y: number, z: number): void;
}

export interface HostBufferSourceNode extends HostAudioNode {
  buffer: unknown;
  loop: boolean;
  loopStart: number;
  loopEnd: number;
  readonly playbackRate: HostAudioParam;
  onended: (() => void) | null;
  start(when?: number): void;
  stop(when?: number): void;
}

export type HostMediaElementSourceNode = HostAudioNode;

/** Event target subset used for `statechange` events. */
export interface HostContextEventTarget {
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
}

/** The node factory surface an `AudioContextLike` hides from the contract. */
export interface HostAudioContext extends HostContextEventTarget {
  readonly currentTime: number;
  readonly state: AudioContextStateLike;
  readonly baseLatency?: number;
  readonly outputLatency?: number;
  readonly destination: HostAudioNode;
  readonly listener?: HostAudioListener;
  createGain(): HostGainNode;
  createBufferSource(): HostBufferSourceNode;
  createPanner?(): HostPannerNode;
  createStereoPanner?(): HostStereoPannerNode;
  createMediaElementSource?(
    element: AudioMediaElementLike,
  ): HostMediaElementSourceNode;
  decodeAudioData?(bytes: ArrayBuffer): Promise<unknown>;
  resume?(): Promise<void>;
  suspend?(): Promise<void>;
  close?(): Promise<void>;
}

export interface HostDocumentLike {
  createElement(tagName: string): AudioMediaElementLike;
}

type AudioContextConstructor = new (options?: {
  latencyHint?: string;
}) => AudioContextLike;

/**
 * 09 §3.1: detection reads `globalThis.AudioContext`, never a user agent.
 * Detection does not construct a context; `unlock()` does (FR-9.11).
 */
export function detectContextFactory(): ((
  latencyHint: "interactive" | "balanced",
) => AudioContextLike) | null {
  const ctor = (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
  if (typeof ctor !== "function") return null;
  const Context = ctor as AudioContextConstructor;
  return (latencyHint) => new Context({ latencyHint });
}

/** 09 §3.1/§5.6: default streaming factory is `document.createElement("audio")`. */
export function detectMediaElementFactory(): (() => AudioMediaElementLike) | null {
  const doc = (globalThis as unknown as { document?: HostDocumentLike }).document;
  if (doc === undefined || typeof doc.createElement !== "function") return null;
  return () => doc.createElement("audio");
}

/** The one cast between the frozen opaque seam and the host node surface. */
export function asHostContext(context: AudioContextLike): HostAudioContext {
  return context as unknown as HostAudioContext;
}
