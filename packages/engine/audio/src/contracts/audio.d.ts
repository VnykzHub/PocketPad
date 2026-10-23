/**
 * Audio subsystem contract (spec 09, `docs/engine/09-audio.md` §3–§6).
 *
 * Declaration only. This wave ships no Web Audio graph, mixer, decoder,
 * voice pool, music deck or radio implementation; later waves add those behind
 * these declarations without widening the public surface.
 *
 * Frozen and additive-only. The spec is authoritative for semantics; this
 * file is authoritative for the TypeScript shape. No DOM or Web Audio type
 * crosses this boundary: `AudioContextLike`, `AudioBufferLike`,
 * `AudioMediaElementLike` and `BlobLike` are opaque structural seams that the
 * host modules unwrap. 09 §3.1/§3.3 name `BaseAudioContext`, `AudioBuffer` and
 * `HTMLAudioElement` at the injection boundary; the DOM-free rule in the wave
 * brief replaces those annotations with these seams and changes no behaviour.
 *
 * Runtime constant values live in `src/version.ts`; this file declares types
 * only. `AudioEngine` aliases the spec's `AudioSystem`, `AudioSource` aliases
 * `AudioSourceDesc`, and `AudioHandle` is the base shape of the spec's
 * `AudioSourceHandle`.
 */

import type {
  EngineError,
  EngineErrorCode,
  Quat,
  Vec3,
} from "@lanpad/engine-core";

/* -------------------------------------------------------------------------
 * 1. State, device and opaque host seams (09 §3.1, §5.2)
 * ---------------------------------------------------------------------- */

/** Same state strings as the existing `AudioBus`; the M0 facade depends on them. */
export type AudioUnlockState = "locked" | "unlocked" | "unavailable";

/** 09 §3.1 name for the same three-state unlock machine. */
export type AudioState = AudioUnlockState;

/** Buses present in M1. M0 exposes master and music only (09 §5.3). */
export type AudioBusName = "music" | "sfx" | "ambient" | "voice" | "ui";

export type AudioLatencyHint = "interactive" | "balanced";

/**
 * Device view assembled from `AudioSystem.state` and `AudioClock` (09 §3.5).
 * 09 defines the members, not a named aggregate; this is the aggregate the
 * wave brief requires.
 */
export interface AudioDeviceState {
  readonly unlock: AudioUnlockState;
  readonly running: boolean;
  readonly suspended: boolean;
  readonly available: boolean;
  readonly baseLatency: number;
  readonly outputLatency: number;
}

/** The subset of `BaseAudioContext` the engine is allowed to read. */
export type AudioContextStateLike =
  | "suspended"
  | "running"
  | "closed"
  | "interrupted";

/**
 * Opaque context seam for the `createContext` test/swap hook (09 §3.1).
 * Node creation and routing stay in the host module; the contract never sees
 * an `AudioNode`.
 */
export interface AudioContextLike {
  readonly currentTime: number;
  readonly state: AudioContextStateLike;
  readonly baseLatency?: number;
  readonly outputLatency?: number;
}

/** Opaque decoded-buffer seam (09 §3.3, §4.1). */
export interface AudioBufferLike {
  readonly duration: number;
  readonly sampleRate: number;
  readonly length: number;
  readonly numberOfChannels: number;
}

/** Opaque byte-source seam; a browser `Blob` satisfies it structurally. */
export interface BlobLike {
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Bytes accepted by the M0 decode path (09 §5.13). */
export type AudioDecodeInput = ArrayBuffer | BlobLike;

/**
 * Opaque media-element seam for streaming decks (09 §5.6). A browser
 * `HTMLAudioElement` satisfies it structurally; no DOM type is imported.
 */
export interface AudioMediaElementLike {
  src: string;
  preload: string;
  muted: boolean;
  volume: number;
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly ended: boolean;
  play(): Promise<void>;
  pause(): void;
}

/* -------------------------------------------------------------------------
 * 2. Clock and listener (09 §3.2, §5.5, §5.7)
 * ---------------------------------------------------------------------- */

export interface AudioClock {
  /** Context time in seconds; exactly 0 while locked or unavailable. */
  readonly now: number;
  readonly running: boolean;
  /** Seconds; 0 when the browser does not report it. */
  readonly baseLatency: number;
  /** Seconds; falls back to baseLatency, then 0. */
  readonly outputLatency: number;
  /** Context time for a performance-now timestamp, clamped to [0, now]. */
  performanceToAudio(perfMs: number): number;
  /** performance-now estimate for a context time, clamped to now. */
  audioToPerformance(audioSeconds: number): number;
}

export interface AudioListener {
  setPosition(x: number, y: number, z: number): void;
  /** World-space unit vectors; normalized by the engine. */
  setOrientation(
    fx: number,
    fy: number,
    fz: number,
    ux: number,
    uy: number,
    uz: number,
  ): void;
  /**
   * Camera convenience. Forward is `quatRotate(rotation, (0, 0, -1))`;
   * up defaults to world `(0, 1, 0)` (09 §3.2, §5.5).
   */
  setFromTransform(position: Vec3, rotation: Quat, up?: Vec3): void;
}

/* -------------------------------------------------------------------------
 * 3. Sources and assets (09 §3.3)
 * ---------------------------------------------------------------------- */

export type DistanceModel = "inverse" | "linear" | "exponential";

export type PanningModel = "equalpower" | "HRTF";

/** Generational and owned by the AudioSystem. Never a Web Audio node. */
export interface AudioHandle {
  readonly index: number;
  readonly generation: number;
}

/** 09 §3.3 name for a live source handle; same shape as `AudioHandle`. */
export type AudioSourceHandle = AudioHandle;

export interface AudioSourceDesc {
  /** Manifest id, kind "audio". */
  readonly assetId: string;
  /** Default "sfx". */
  readonly bus?: AudioBusName;
  /** Default false. */
  readonly positional?: boolean;
  /** Default false. */
  readonly loop?: boolean;
  /** 0..1, default 1. */
  readonly volume?: number;
  /** 0.25..4, default 1. */
  readonly rate?: number;
  /** Default "equalpower". */
  readonly panningModel?: PanningModel;
  /** Default "inverse". */
  readonly distanceModel?: DistanceModel;
  /** Default 1; > 0. */
  readonly refDistance?: number;
  /** Default 100; > refDistance. */
  readonly maxDistance?: number;
  /** 0..10, default 1. */
  readonly rolloff?: number;
  /** 0..255, default 128. */
  readonly priority?: number;
  /** Default false; M2 only. */
  readonly doppler?: boolean;
}

/** The wave brief's `AudioSource`; 09 defines the descriptor, not a live node. */
export type AudioSource = AudioSourceDesc;

export interface AudioPlayOptions {
  /** Context time to start; default clock.now, with a 5 ms lead (09 §5.7). */
  readonly at?: number;
  /** Multiplies the source volume; 0..1, default 1. */
  readonly volume?: number;
  /** Multiplies the source rate; 0.25..4, default 1. */
  readonly rate?: number;
}

/** Decoded by engine-assets; either a decoded buffer or a stream URL. */
export type AudioAssetValue =
  | { readonly kind: "buffer"; readonly buffer: AudioBufferLike }
  | {
      readonly kind: "stream";
      readonly url: string;
      readonly durationSeconds?: number;
    };

/** A streamed music/radio payload; the stream arm of `AudioAssetValue`. */
export type MusicStream = Extract<AudioAssetValue, { readonly kind: "stream" }>;

/* -------------------------------------------------------------------------
 * 4. Buses, voices and the mixer (09 §3.4, §5.3, §5.4)
 * ---------------------------------------------------------------------- */

/**
 * Contract-level bus descriptor. `volume` is 0..1 and `muted` is the per-bus
 * mute. `maxVoices`, when present, is a 1..32 ceiling for voices routed
 * through the bus; 09 §5.4 defines only global SFX/spatial pool sizes, so it
 * carries no spec default.
 */
export interface AudioBusDesc {
  readonly name: AudioBusName;
  readonly volume: number;
  readonly muted: boolean;
  readonly maxVoices?: number;
}

export type AudioVoicePool = "sfx" | "spatial";

/** Contract-level pool descriptor; 09 §5.4 supplies both default sizes. */
export interface AudioVoiceDesc {
  readonly pool: AudioVoicePool;
  readonly maxVoices: number;
  readonly positional: boolean;
}

export type AudioVoiceState = "free" | "playing" | "stealing";

/**
 * Read-only voice view. 09 §5.4 defines the selection fields (priority,
 * startedAt, index) but no canonical public voice type; the remaining fields
 * expose the pool and current ownership the descriptor requires.
 */
export interface AudioVoice {
  readonly index: number;
  readonly pool: AudioVoicePool;
  readonly state: AudioVoiceState;
  readonly priority: number;
  readonly startedAt: number;
  readonly assetId: string | null;
  readonly handle: AudioHandle | null;
}

/** Fixed stealing procedure from 09 §5.4. */
export interface AudioVoiceStealingPolicy {
  /** Evaluated in order; ties fall through to the next criterion. */
  readonly order: readonly [
    "free",
    "lowest-priority",
    "oldest",
    "lowest-index",
  ];
  /** Never evict a voice whose priority is higher than the request. */
  readonly neverStealHigherPriority: boolean;
  /** Linear ramp applied before a stolen voice is reused, in milliseconds. */
  readonly stealRampMs: number;
  /** When every voice is higher priority, drop and count the request. */
  readonly onExhausted: "drop";
}

export interface AudioMixConfig {
  readonly formatVersion: 1;
  readonly masterVolume: number;
  readonly buses: Readonly<Record<AudioBusName, number>>;
  readonly sfxVoices: number;
  readonly spatialVoices: number;
  readonly defaults: {
    readonly distanceModel: DistanceModel;
    readonly panningModel: PanningModel;
    readonly refDistance: number;
    readonly maxDistance: number;
    readonly rolloff: number;
  };
}

export interface AudioMixer {
  readonly masterVolume: number;
  readonly muted: boolean;
  setMasterVolume(volume: number, rampMs?: number): void;
  setBusVolume(bus: AudioBusName, volume: number, rampMs?: number): void;
  getBusVolume(bus: AudioBusName): number;
  setBusMuted(bus: AudioBusName, muted: boolean): void;
  setMuted(muted: boolean): void;
}

/* -------------------------------------------------------------------------
 * 5. Music, radio and config documents (09 §3.4, §4.2, §4.3, §5.6)
 * ---------------------------------------------------------------------- */

export interface MusicOptions {
  /** Default true. */
  readonly loop?: boolean;
  /** Default 0; 0..10000. */
  readonly fadeMs?: number;
  /** 0..1, default 1. */
  readonly volume?: number;
  /** Context time; default clock.now with a 20 ms fade anchor when fading. */
  readonly startAt?: number;
}

export interface RadioOptions {
  /** Crossfade length, default 1500; 0..5000. */
  readonly fadeMs?: number;
  /** Default: the station's loop flag. */
  readonly loop?: boolean;
}

export interface RadioStation {
  /** `^[a-z0-9][a-z0-9-]{0,31}$`. */
  readonly id: string;
  /** 1..64 manifest audio asset ids. */
  readonly tracks: readonly string[];
  readonly loop: boolean;
}

/** `radio-stations.json`: UTF-8 JSON <= 16 KB, format version 1. */
export interface RadioStationsDocument {
  readonly formatVersion: 1;
  /** 0..32 stations with unique ids. */
  readonly stations: readonly RadioStation[];
}

/* -------------------------------------------------------------------------
 * 6. Frozen M0 AudioBus surface (09 §5.13; migration source
 *    `packages/runtime/src/audio/AudioBus.ts`)
 * ---------------------------------------------------------------------- */

/** M0 host/test options; the factory is invoked only by `unlock()`. */
export interface AudioBusOptions {
  readonly latencyHint?: AudioLatencyHint;
  readonly createContext?: (latencyHint: AudioLatencyHint) => AudioContextLike;
  /** Master gain applied when the context is created; 0..1, default 1. */
  readonly masterVolume?: number;
  /** Pooled SFX voices; 1..32, default 8. */
  readonly sfxVoices?: number;
}

/** M0 non-positional play options; values are clamped where 09 says so. */
export interface SfxOptions {
  /** 0..1, default 1. */
  readonly volume?: number;
  /** Playback-rate multiplier, default 1. */
  readonly rate?: number;
}

/**
 * Frozen M0 audio path. Every member matches the existing runtime class; the
 * migration adds `attachContext` internally without changing this surface.
 * A future `AudioSystem` composes this interface.
 */
export interface AudioBus {
  readonly latencyHint: AudioLatencyHint;
  readonly state: AudioUnlockState;
  readonly unlocked: boolean;
  readonly paused: boolean;
  readonly available: boolean;
  readonly masterVolume: number;
  readonly baseLatency: number;
  readonly outputLatency: number;

  /** Lazy context creation from a user gesture; idempotent, never rejects. */
  unlock(): Promise<void>;
  setMasterVolume(volume: number): void;
  registerSfx(id: string, buffer: AudioBufferLike): void;
  registerMusic(id: string, buffer: AudioBufferLike): void;
  /** Rejects while locked, as today. */
  decodeAudio(data: AudioDecodeInput): Promise<AudioBufferLike>;
  playSfx(id: string, opts?: SfxOptions): void;
  playMusic(id: string, opts?: MusicOptions): void;
  stopMusic(fadeMs?: number): void;
  /** Context time in seconds, or 0 before unlock. */
  now(): number;
  pause(): void;
  resume(): Promise<void>;
  /** Idempotent; not reusable. */
  dispose(): void;
}

/* -------------------------------------------------------------------------
 * 7. The system (09 §3.5)
 * ---------------------------------------------------------------------- */

export interface AudioSystemOptions {
  /** Default "interactive". */
  readonly latencyHint?: AudioLatencyHint;
  /** 0..1, default 1. */
  readonly masterVolume?: number;
  /** 1..32, default 8. */
  readonly sfxVoices?: number;
  /** 1..32, default 16. */
  readonly spatialVoices?: number;
  /** Default 32 MiB; 0 disables decoding. Clamped to 0..256 MiB. */
  readonly decodeBudgetBytes?: number;
  /** Validated `audio-mix.json`, when the game provides one. */
  readonly mix?: AudioMixConfig;
  /** Test seam; defaults to detecting Web Audio at unlock time. */
  readonly createContext?: (hint: AudioLatencyHint) => AudioContextLike;
  /** Streaming seam; defaults to creating a media element. */
  readonly createMediaElement?: () => AudioMediaElementLike;
}

export interface PlaySfxOptions extends SfxOptions {
  /** Default "sfx". */
  readonly bus?: AudioBusName;
}

export interface AudioStats {
  /** Playing, across both pools. */
  readonly activeVoices: number;
  readonly sfxVoices: number;
  readonly spatialVoices: number;
  /** Voice exhaustion, cumulative. */
  readonly droppedPlays: number;
  /** Decoded buffers currently held. */
  readonly decodedBytes: number;
  /** A music/radio deck is streaming. */
  readonly streaming: boolean;
  /** Context suspend/interruption events. */
  readonly interruptions: number;
  /** Voices stolen, cumulative. */
  readonly steals: number;
}

export interface AudioSystem {
  readonly state: AudioUnlockState;
  readonly unlocked: boolean;
  readonly suspended: boolean;
  readonly available: boolean;
  readonly latencyHint: AudioLatencyHint;
  readonly clock: AudioClock;
  readonly mixer: AudioMixer;
  readonly listener: AudioListener;
  readonly stats: AudioStats;

  /** Must be called from a user gesture. Idempotent; never rejects. */
  unlock(): Promise<void>;
  suspend(): Promise<void>;
  resume(): Promise<void>;

  createSource(desc: AudioSourceDesc): AudioHandle;
  destroySource(handle: AudioHandle): void;
  setSourcePosition(handle: AudioHandle, x: number, y: number, z: number): void;
  play(handle: AudioHandle, opts?: AudioPlayOptions): void;
  stop(handle: AudioHandle, fadeMs?: number): void;

  /** Buffer SFX shortcut; delegates to the "sfx" bus. */
  playSfx(assetId: string, opts?: PlaySfxOptions): void;

  playMusic(assetId: string, opts?: MusicOptions): void;
  stopMusic(fadeMs?: number): void;
  readonly musicPlaying: boolean;

  registerRadioStation(station: RadioStation): void;
  tuneRadio(stationId: string, opts?: RadioOptions): void;
  stopRadio(fadeMs?: number): void;
  readonly radioStationId: string | null;

  /** Register an already-decoded buffer (asset decode path or tests). */
  registerBuffer(assetId: string, buffer: AudioBufferLike): void;
  /** Safe for unknown ids. */
  releaseBuffer(assetId: string): void;

  /** Once per simulation tick, after simulate and before render. Allocation-free. */
  update(dtSeconds: number): void;
  /** Idempotent; not reusable. */
  dispose(): void;
}

/** The wave brief's `AudioEngine`; 09 names the interface `AudioSystem`. */
export type AudioEngine = AudioSystem;

/* -------------------------------------------------------------------------
 * 8. Accepted asset kinds and codecs as data (09 §4.1)
 * ---------------------------------------------------------------------- */

export type AudioAssetKind = "audio";

export type AudioAssetPayloadKind = AudioAssetValue["kind"];

export type AudioCodec = "opus" | "aac" | "pcm";

export type AudioContainer = "ogg" | "webm" | "mp4" | "wav";

export type AudioMimeType =
  | "audio/ogg"
  | "audio/webm"
  | "audio/mp4"
  | "audio/wav";

export type AudioRuntimeUse =
  | "decoded"
  | "streamed"
  | "dev-test"
  | "optional-streamed";

/**
 * One accepted source format. This is data, not a decoder: the browser decodes
 * the bytes. `featureGate` names the capability check the host must pass
 * before offering the format (09 §4.1, §5.9).
 */
export interface AudioFormatDesc {
  readonly id: string;
  readonly codec: AudioCodec;
  readonly container: AudioContainer;
  readonly extension: ".opus" | ".webm" | ".m4a" | ".wav";
  readonly mimeType: AudioMimeType;
  readonly runtimeUse: AudioRuntimeUse;
  readonly required: boolean;
  readonly featureGate?: "canPlayType";
}

/* -------------------------------------------------------------------------
 * 9. Errors (09 §3.7) — additive codes over core's union, not a parallel one
 * ---------------------------------------------------------------------- */

/**
 * Narrow view of the frozen core union. Core now owns the four `E_AUDIO_*`
 * codes (00 §5.9); `E_STALE_HANDLE` and `E_UNSUPPORTED_FEATURE` are existing
 * core codes the audio fallback paths reference.
 */
export type AudioErrorCode = Extract<
  EngineErrorCode,
  `E_AUDIO_${string}` | "E_STALE_HANDLE" | "E_UNSUPPORTED_FEATURE"
>;

export interface AudioError extends Omit<EngineError, "code" | "layer"> {
  readonly code: AudioErrorCode;
  readonly layer: "audio";
}

/** Config validation failure carrying a JSON path such as `buses.music`. */
export interface AudioValidationError extends AudioError {
  readonly code: "E_AUDIO_FORMAT";
  readonly path: string;
}
