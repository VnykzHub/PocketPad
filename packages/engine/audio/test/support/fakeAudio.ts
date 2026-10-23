/**
 * Deterministic fake Web Audio graph for Node tests.
 *
 * The frozen contract hides Web Audio behind opaque seams, so the tests build
 * a small structural implementation of `HostAudioContext` instead of jsdom or
 * a real `AudioContext`. Every scheduled write is recorded with its audio
 * time; that is what lets the tests assert the scheduling rules in
 * spec 09 §5.7 and the gain ramps in §5.3/§5.6 without rendering audio.
 *
 * No offline render happens here. This file records *intent* only; it says
 * nothing about output samples, latency or hardware behaviour, and it must
 * never be used to claim a measurement.
 */

import type {
  AudioBufferLike,
  AudioContextLike,
  AudioContextStateLike,
  AudioMediaElementLike,
} from "../../src/contracts/audio.js";
import type {
  HostAudioContext,
  HostAudioListener,
  HostAudioNode,
  HostAudioParam,
  HostBufferSourceNode,
  HostGainNode,
  HostMediaElementSourceNode,
  HostPannerNode,
  HostStereoPannerNode,
} from "../../src/host/types.js";

export type ParamWriteType = "set" | "ramp" | "target" | "curve" | "cancel";

/** One scheduled `AudioParam` write, in audio-context seconds. */
export interface ParamWrite {
  readonly type: ParamWriteType;
  readonly value: number;
  readonly time: number;
  /** Equal-power curve samples, present for `"curve"`. */
  readonly values?: readonly number[];
}

export class FakeParam implements HostAudioParam {
  value = 0;
  readonly writes: ParamWrite[] = [];

  constructor(value = 0) {
    this.value = value;
  }

  setValueAtTime(value: number, time: number): void {
    this.value = value;
    this.writes.push({ type: "set", value, time });
  }

  linearRampToValueAtTime(value: number, time: number): void {
    this.value = value;
    this.writes.push({ type: "ramp", value, time });
  }

  setTargetAtTime(target: number, startTime: number, timeConstant: number): void {
    void timeConstant;
    this.writes.push({ type: "target", value: target, time: startTime });
  }

  cancelScheduledValues(startTime: number): void {
    this.writes.push({ type: "cancel", value: 0, time: startTime });
  }

  setValueCurveAtTime(values: Float32Array, startTime: number, duration: number): void {
    void duration;
    this.value = values[values.length - 1] ?? 0;
    this.writes.push({
      type: "curve",
      value: this.value,
      time: startTime,
      values: Array.from(values),
    });
  }

  /** Writes of one type, in schedule order. */
  ofType(type: ParamWriteType): ParamWrite[] {
    return this.writes.filter((write) => write.type === type);
  }

  /** The last write of any type, or undefined. */
  last(): ParamWrite | undefined {
    return this.writes[this.writes.length - 1];
  }

  reset(): void {
    this.writes.length = 0;
  }
}

export class FakeNode implements HostAudioNode {
  readonly connections: HostAudioNode[] = [];

  connect(destination: HostAudioNode): unknown {
    this.connections.push(destination);
    return destination;
  }

  disconnect(): void {
    this.connections.length = 0;
  }
}

export class FakeGain extends FakeNode implements HostGainNode {
  readonly gain = new FakeParam();
}

export class FakePanner extends FakeNode implements HostPannerNode {
  panningModel: HostPannerNode["panningModel"] = "equalpower";
  distanceModel: HostPannerNode["distanceModel"] = "inverse";
  refDistance = 1;
  maxDistance = 100;
  rolloffFactor = 1;
  readonly positionX = new FakeParam();
  readonly positionY = new FakeParam();
  readonly positionZ = new FakeParam();
  readonly setPositionCalls: Array<readonly [number, number, number]> = [];

  setPosition(x: number, y: number, z: number): void {
    this.setPositionCalls.push([x, y, z]);
  }
}

export class FakeStereoPanner extends FakeNode implements HostStereoPannerNode {
  readonly pan = new FakeParam();
}

export class FakeBufferSource extends FakeNode implements HostBufferSourceNode {
  buffer: unknown = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  readonly playbackRate = new FakeParam(1);
  onended: (() => void) | null = null;
  readonly startCalls: number[] = [];
  readonly stopCalls: number[] = [];
  started = false;

  start(when = 0): void {
    if (this.started) throw new Error("InvalidStateError: already started");
    this.started = true;
    this.startCalls.push(when);
  }

  stop(when = 0): void {
    if (!this.started) throw new Error("InvalidStateError: not started");
    this.stopCalls.push(when);
  }

  /** Simulate natural end: invoke `onended` once. */
  fireEnded(): void {
    const handler = this.onended;
    this.onended = null;
    handler?.();
  }
}

export class FakeMediaElementSource extends FakeNode implements HostMediaElementSourceNode {}

export class FakeMediaElement implements AudioMediaElementLike {
  src = "";
  preload = "";
  muted = false;
  volume = 1;
  currentTime = 0;
  duration = 120;
  paused = true;
  ended = false;
  playCalls = 0;
  pauseCalls = 0;

  play(): Promise<void> {
    this.playCalls += 1;
    this.paused = false;
    this.ended = false;
    return Promise.resolve();
  }

  pause(): void {
    this.pauseCalls += 1;
    this.paused = true;
  }

  /** Simulate the stream finishing. */
  finish(): void {
    this.ended = true;
    this.paused = true;
  }
}

export class FakeListener implements HostAudioListener {
  readonly positionX = new FakeParam();
  readonly positionY = new FakeParam();
  readonly positionZ = new FakeParam();
  readonly forwardX = new FakeParam();
  readonly forwardY = new FakeParam();
  readonly forwardZ = new FakeParam();
  readonly upX = new FakeParam();
  readonly upY = new FakeParam();
  readonly upZ = new FakeParam();
}

export interface FakeContextOptions {
  /** Default "suspended", so `unlock()` exercises `resume()`. */
  readonly state?: AudioContextStateLike;
  /** Default 0. Set this to test scheduling at a non-zero clock. */
  readonly currentTime?: number;
  readonly baseLatency?: number;
  readonly outputLatency?: number;
  readonly hasPanner?: boolean;
  readonly hasStereoPanner?: boolean;
  /** "reject" models a `NotAllowedError` from a non-gesture `resume()`. */
  readonly resume?: "resolve" | "reject" | "never";
  readonly suspend?: "resolve" | "reject";
  /** Thrown synchronously by `createMediaElementSource` when false. */
  readonly routesMediaElement?: boolean;
}

export class FakeContext implements HostAudioContext {
  currentTime: number;
  state: AudioContextStateLike;
  readonly baseLatency: number;
  readonly outputLatency: number;
  readonly destination = new FakeDestination();
  readonly listener = new FakeListener();
  readonly createdGains: FakeGain[] = [];
  readonly createdSources: FakeBufferSource[] = [];
  readonly createdPanners: FakePanner[] = [];
  readonly createdStereoPanners: FakeStereoPanner[] = [];
  readonly createdMediaElementSources: FakeMediaElementSource[] = [];
  readonly resumeCalls: number[] = [];
  readonly suspendCalls: number[] = [];
  readonly closeCalls: number[] = [];
  readonly decodedByteArrays: ArrayBuffer[] = [];
  readonly stateListeners: Array<() => void> = [];
  readonly hasPanner: boolean;
  readonly hasStereoPanner: boolean;
  readonly routesMediaElement: boolean;
  private readonly resumeBehavior: "resolve" | "reject" | "never";
  private readonly suspendBehavior: "resolve" | "reject";

  constructor(options: FakeContextOptions = {}) {
    this.state = options.state ?? "suspended";
    this.currentTime = options.currentTime ?? 0;
    this.baseLatency = options.baseLatency ?? 0.01;
    this.outputLatency = options.outputLatency ?? 0.02;
    this.hasPanner = options.hasPanner ?? true;
    this.hasStereoPanner = options.hasStereoPanner ?? true;
    this.routesMediaElement = options.routesMediaElement ?? true;
    this.resumeBehavior = options.resume ?? "resolve";
    this.suspendBehavior = options.suspend ?? "resolve";
    // `delete` would only remove an own property; these live on the prototype.
    // Shadow them with an own `undefined` so the `createPanner !== undefined`
    // feature check sees the documented fallback.
    if (!this.hasPanner) {
      Object.defineProperty(this, "createPanner", { value: undefined, configurable: true });
    }
    if (!this.hasStereoPanner) {
      Object.defineProperty(this, "createStereoPanner", {
        value: undefined,
        configurable: true,
      });
    }
  }

  createGain(): HostGainNode {
    const gain = new FakeGain();
    this.createdGains.push(gain);
    return gain;
  }

  createBufferSource(): HostBufferSourceNode {
    const source = new FakeBufferSource();
    this.createdSources.push(source);
    return source;
  }

  createPanner(): HostPannerNode {
    const panner = new FakePanner();
    this.createdPanners.push(panner);
    return panner;
  }

  createStereoPanner(): HostStereoPannerNode {
    const panner = new FakeStereoPanner();
    this.createdStereoPanners.push(panner);
    return panner;
  }

  createMediaElementSource(element: AudioMediaElementLike): HostMediaElementSourceNode {
    if (!this.routesMediaElement) {
      throw new Error("NotSupportedError: media element routing unavailable");
    }
    void element;
    const source = new FakeMediaElementSource();
    this.createdMediaElementSources.push(source);
    return source;
  }

  decodeAudioData(bytes: ArrayBuffer): Promise<unknown> {
    this.decodedByteArrays.push(bytes);
    const view = new DataView(bytes);
    const length = view.byteLength >= 4 ? view.getUint32(0, true) : bytes.byteLength;
    return Promise.resolve(fakeBuffer(length === 0 ? 1 : length, 1));
  }

  resume(): Promise<void> {
    this.resumeCalls.push(this.currentTime);
    if (this.resumeBehavior === "reject") {
      return Promise.reject(new Error("NotAllowedError"));
    }
    if (this.resumeBehavior === "never") {
      return new Promise<void>(() => {
        // Deliberately never settles.
      });
    }
    this.state = "running";
    return Promise.resolve();
  }

  suspend(): Promise<void> {
    this.suspendCalls.push(this.currentTime);
    if (this.suspendBehavior === "reject") {
      return Promise.reject(new Error("InvalidStateError"));
    }
    this.state = "suspended";
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closeCalls.push(this.currentTime);
    this.state = "closed";
    return Promise.resolve();
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === "statechange") this.stateListeners.push(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type !== "statechange") return;
    const index = this.stateListeners.indexOf(listener);
    if (index >= 0) this.stateListeners.splice(index, 1);
  }

  /** Move the audio clock; does not fire `statechange`. */
  advance(seconds: number): void {
    this.currentTime += seconds;
  }

  /** Set `state` and notify the system's `statechange` listener. */
  transition(next: AudioContextStateLike): void {
    this.state = next;
    for (const listener of this.stateListeners.slice()) listener();
  }
}

class FakeDestination extends FakeNode {}

export interface FakeFactory {
  readonly factory: (hint: "interactive" | "balanced") => AudioContextLike;
  readonly contexts: FakeContext[];
  readonly calls: number;
  readonly last: () => FakeContext | undefined;
}

/** A factory that creates one `FakeContext` per call and records every call. */
export function createFakeFactory(options: FakeContextOptions = {}): FakeFactory {
  const contexts: FakeContext[] = [];
  return {
    factory: () => {
      const context = new FakeContext(options);
      contexts.push(context);
      return context;
    },
    contexts,
    get calls() {
      return contexts.length;
    },
    last: () => contexts[contexts.length - 1],
  };
}

/** Synthetic decoded buffer; `length` is samples per channel. */
export function fakeBuffer(
  length = 48000,
  numberOfChannels = 1,
  sampleRate = 48000,
): AudioBufferLike {
  return {
    duration: length / sampleRate,
    sampleRate,
    length,
    numberOfChannels,
  };
}

/** The last source the context created, or a clear test failure. */
export function lastSource(context: FakeContext): FakeBufferSource {
  const source = context.createdSources[context.createdSources.length - 1];
  if (source === undefined) throw new Error("no buffer source was created");
  return source;
}
