/**
 * `AudioSystem` — the engine audio facade (spec 09 §3.5, §5.2–§5.9).
 *
 * One context, created only from `unlock()` (FR-9.11); master plus five bus
 * gains; an 8-voice SFX pool and a 16-voice positional pool; two music decks;
 * a decoded-buffer registry with budget accounting; an audio clock that is
 * the only scheduling source.
 *
 * Failure policy: no public member rejects for an audio fault. Locked or
 * unavailable state makes playback a silent no-op, `createSource` still
 * allocates a handle so a game's `init` does not branch on state, and
 * `update(dt)` never starts a source.
 *
 * Allocation policy (09 §5.11): everything fixed-size is allocated at
 * construction. `update` and the mixer writes allocate nothing. `play` and
 * `playSfx` allocate only the unavoidable `AudioBufferSourceNode`.
 *
 * Additive concrete members (not on the frozen contract):
 * `registerStream`/`releaseStream` complete the `AudioAssetValue` plumbing
 * that the contract only models as a type, and the failure counters surface
 * the §3.7 error codes for the debug overlay.
 */

import type {
  AudioBufferLike,
  AudioClock,
  AudioContextLike,
  AudioHandle,
  AudioLatencyHint,
  AudioListener,
  AudioMixer,
  AudioPlayOptions,
  AudioSourceDesc,
  AudioStats,
  AudioSystem,
  AudioSystemOptions,
  AudioUnlockState,
  DistanceModel,
  MusicOptions,
  PanningModel,
  PlaySfxOptions,
  RadioOptions,
  RadioStation,
} from "./contracts/audio.js";
import { EngineAudioClock } from "./clock/AudioClock.js";
import { DecodedBufferRegistry } from "./decode/decodeAudio.js";
import { AudioEngineError } from "./errors.js";
import {
  asHostContext,
  detectContextFactory,
  detectMediaElementFactory,
} from "./host/types.js";
import type { HostAudioContext } from "./host/types.js";
import { buildBusGraph, busIndex } from "./mixer/BusGraph.js";
import type { AudioBusGraph } from "./mixer/BusGraph.js";
import { Mixer } from "./mixer/Mixer.js";
import type { MixerHost } from "./mixer/Mixer.js";
import { DeckPair } from "./music/Decks.js";
import type { ResolvedTrack } from "./music/Decks.js";
import { MusicPlayer } from "./music/MusicPlayer.js";
import { RadioPlayer } from "./music/RadioPlayer.js";
import {
  clamp01,
  clampByteBudget,
  clampMs,
  clampVoiceCount,
  oneShotStartTime,
} from "./schedule.js";
import { EngineListener } from "./spatial/Listener.js";
import { SpatialPool } from "./spatial/SpatialPool.js";
import { VoicePool } from "./voice/VoicePool.js";
import { SfxPool } from "./voice/SfxPool.js";
import {
  AUDIO_BUS_NAMES,
  AUDIO_DEFAULT_MUSIC_FADE_MS,
  AUDIO_MAX_DECODE_BUDGET_BYTES,
  AUDIO_MAX_MUSIC_FADE_MS,
  AUDIO_MAX_PLAYBACK_RATE,
  AUDIO_MIN_PLAYBACK_RATE,
  AUDIO_SFX_PRIORITY,
  AUDIO_VOICE_STEAL_RAMP_MS,
  DEFAULT_AUDIO_LATENCY_HINT,
  DEFAULT_DECODE_BUDGET_BYTES,
  DEFAULT_DISTANCE_MODEL,
  DEFAULT_MASTER_VOLUME,
  DEFAULT_MAX_DISTANCE,
  DEFAULT_REF_DISTANCE,
  DEFAULT_ROLLOFF,
  DEFAULT_SFX_VOICES,
  DEFAULT_SOURCE_PRIORITY,
  DEFAULT_SOURCE_VOLUME,
  DEFAULT_SPATIAL_VOICES,
} from "./version.js";

/** One `createSource` allocation; never a Web Audio node. */
interface SourceRecord {
  readonly handle: AudioHandle;
  readonly generation: number;
  readonly assetId: string;
  readonly bus: number;
  readonly positional: boolean;
  readonly loop: boolean;
  readonly volume: number;
  readonly rate: number;
  readonly distanceModel: DistanceModel;
  readonly refDistance: number;
  readonly maxDistance: number;
  readonly rolloff: number;
  readonly priority: number;
  x: number;
  y: number;
  z: number;
  voiceIndex: number;
  pool: VoicePool | null;
}

interface StreamRecord {
  readonly url: string;
  readonly durationSeconds: number;
}

/** Mutable counters shared with the read-only `stats` view. */
interface AudioCounters {
  droppedPlays: number;
  steals: number;
  interruptions: number;
}

/**
 * The `stats` object is allocated once; its getters read live counters so a
 * debug overlay can poll it every frame without allocating (09 §5.11).
 */
function createStatsView(
  sfx: VoicePool,
  spatial: SpatialPool,
  buffers: DecodedBufferRegistry,
  decks: DeckPair,
  counters: AudioCounters,
): AudioStats {
  return {
    get activeVoices() {
      let count = 0;
      for (let index = 0; index < sfx.capacity; index += 1) {
        if (sfx.active[index] === 1) count += 1;
      }
      for (let index = 0; index < spatial.capacity; index += 1) {
        if (spatial.active[index] === 1) count += 1;
      }
      return count;
    },
    get sfxVoices() {
      return sfx.capacity;
    },
    get spatialVoices() {
      return spatial.capacity;
    },
    get droppedPlays() {
      return counters.droppedPlays;
    },
    get decodedBytes() {
      return buffers.bytes;
    },
    get streaming() {
      return decks.anyStreaming();
    },
    get interruptions() {
      return counters.interruptions;
    },
    get steals() {
      return counters.steals;
    },
  };
}

function clampRate(value: number | undefined, fallback: number): number {
  const resolved = value === undefined || !Number.isFinite(value) ? fallback : value;
  if (resolved < AUDIO_MIN_PLAYBACK_RATE) return AUDIO_MIN_PLAYBACK_RATE;
  if (resolved > AUDIO_MAX_PLAYBACK_RATE) return AUDIO_MAX_PLAYBACK_RATE;
  return resolved;
}

function clampPriority(value: number | undefined): number {
  const resolved =
    value === undefined || !Number.isFinite(value) ? DEFAULT_SOURCE_PRIORITY : value;
  const floored = Math.floor(resolved);
  if (floored < 0) return 0;
  if (floored > 255) return 255;
  return floored;
}

export class EngineAudioSystem implements AudioSystem {
  readonly latencyHint: AudioLatencyHint;
  readonly clock: EngineAudioClock;
  readonly mixer: Mixer;
  readonly listener: EngineListener;

  private readonly createContext:
    | ((hint: AudioLatencyHint) => AudioContextLike)
    | null;
  private readonly busVolumes: number[];
  private readonly defaultDistanceModel: DistanceModel;
  private readonly defaultRefDistance: number;
  private readonly defaultMaxDistance: number;
  private readonly defaultRolloff: number;

  private readonly sfxPool: SfxPool;
  private readonly spatialPool: SpatialPool;
  private readonly buffers: DecodedBufferRegistry;
  private readonly streams = new Map<string, StreamRecord>();
  private readonly decks: DeckPair;
  private readonly music: MusicPlayer;
  private readonly radio: RadioPlayer;

  private readonly onStateChange: () => void;
  private readonly statsView: AudioStats;

  private unlockState: AudioUnlockState = "locked";
  private unlockPromise: Promise<void> | null = null;
  private hostContext: HostAudioContext | null = null;
  private graph: AudioBusGraph | null = null;
  private suspendedFlag = false;
  private explicitSuspend = false;
  private masterMutedByHost = false;
  private listenerDirty = false;
  private disposed = false;

  private sourceRecords: Array<SourceRecord | null> = [];
  private sourceGenerations: number[] = [];

  private readonly counters: AudioCounters = {
    droppedPlays: 0,
    steals: 0,
    interruptions: 0,
  };
  /** Context creation / graph failures (`E_AUDIO_DEVICE`). */
  deviceFailures = 0;
  /** Decode or stream failures (`E_AUDIO_DECODE`). */
  decodeFailures = 0;
  /** Budget rejections (`E_AUDIO_BUDGET`). */
  budgetFailures = 0;

  constructor(options: AudioSystemOptions = {}) {
    const mix = options.mix;
    this.latencyHint = options.latencyHint ?? DEFAULT_AUDIO_LATENCY_HINT;
    this.createContext = options.createContext ?? null;

    const masterVolume = clamp01(
      options.masterVolume ?? mix?.masterVolume,
      DEFAULT_MASTER_VOLUME,
    );
    const sfxVoices = clampVoiceCount(
      options.sfxVoices ?? mix?.sfxVoices,
      DEFAULT_SFX_VOICES,
    );
    const spatialVoices = clampVoiceCount(
      options.spatialVoices ?? mix?.spatialVoices,
      DEFAULT_SPATIAL_VOICES,
    );
    const budget = clampByteBudget(
      options.decodeBudgetBytes,
      DEFAULT_DECODE_BUDGET_BYTES,
      AUDIO_MAX_DECODE_BUDGET_BYTES,
    );

    this.busVolumes = [];
    for (let index = 0; index < AUDIO_BUS_NAMES.length; index += 1) {
      const name = AUDIO_BUS_NAMES[index];
      const configured = name === undefined ? undefined : mix?.buses[name];
      this.busVolumes.push(clamp01(configured, 1));
    }

    this.defaultDistanceModel = mix?.defaults.distanceModel ?? DEFAULT_DISTANCE_MODEL;
    this.defaultRefDistance = mix?.defaults.refDistance ?? DEFAULT_REF_DISTANCE;
    this.defaultMaxDistance = mix?.defaults.maxDistance ?? DEFAULT_MAX_DISTANCE;
    this.defaultRolloff = mix?.defaults.rolloff ?? DEFAULT_ROLLOFF;

    const mixerHost: MixerHost = {
      now: () => this.clock.now,
      masterGainNode: () => this.graph?.masterGain ?? null,
      busGainNode: (index) => this.graph?.busGains[index] ?? null,
      masterMutedByHost: () => this.masterMutedByHost,
    };
    this.mixer = new Mixer(mixerHost, masterVolume, this.busVolumes);

    this.clock = new EngineAudioClock({
      context: () => this.hostContext,
      unlocked: () => this.unlockState === "unlocked",
    });

    this.listener = new EngineListener(() => {
      this.listenerDirty = true;
    });

    this.sfxPool = new SfxPool(sfxVoices, () => {
      // Voice end is bookkeeping only; nothing to schedule.
    });
    this.spatialPool = new SpatialPool(spatialVoices, () => {
      // Voice end is bookkeeping only; nothing to schedule.
    });

    this.buffers = new DecodedBufferRegistry(budget);
    this.decks = new DeckPair(
      options.createMediaElement ?? detectMediaElementFactory(),
      () => {
        this.decodeFailures += 1;
      },
    );

    const now = (): number => this.clock.now;
    const failStream = (): void => {
      this.decodeFailures += 1;
    };
    this.music = new MusicPlayer(this.decks, (id) => this.resolveTrack(id), now, failStream);
    this.radio = new RadioPlayer(this.decks, (id) => this.resolveTrack(id), now, failStream);

    this.onStateChange = () => {
      const host = this.hostContext;
      if (host === null || this.disposed || this.unlockState !== "unlocked") return;
      if (host.state === "interrupted" || host.state === "suspended") {
        if (!this.explicitSuspend) {
          this.counters.interruptions += 1;
          this.suspendedFlag = true;
        }
      } else if (host.state === "running" && !this.explicitSuspend) {
        this.suspendedFlag = false;
      }
    };

    this.statsView = createStatsView(
      this.sfxPool,
      this.spatialPool,
      this.buffers,
      this.decks,
      this.counters,
    );
  }

  /* ---------------------------------------------------------------- state */

  get state(): AudioUnlockState {
    return this.unlockState;
  }

  get unlocked(): boolean {
    return this.unlockState === "unlocked";
  }

  get suspended(): boolean {
    return this.suspendedFlag;
  }

  get available(): boolean {
    return this.unlockState !== "unavailable";
  }

  get stats(): AudioStats {
    return this.statsView;
  }

  get musicPlaying(): boolean {
    return this.music.playing && this.radio.stationId === null;
  }

  get radioStationId(): string | null {
    return this.radio.stationId;
  }

  /** Counted no-op tunes (unknown station or locked). */
  get radioMisses(): number {
    return this.radio.unknownTunings;
  }

  /** Number of streaming URLs registered (contract-gap completion). */
  get streamCount(): number {
    return this.streams.size;
  }

  /* --------------------------------------------------------------- unlock */

  unlock(): Promise<void> {
    if (this.disposed || this.unlockState === "unavailable") {
      return Promise.resolve();
    }
    if (this.unlockState === "unlocked") {
      return this.suspendedFlag ? this.resume() : Promise.resolve();
    }
    const inflight = this.unlockPromise;
    if (inflight !== null) return inflight;

    const attempt = this.performUnlock();
    this.unlockPromise = attempt;
    const clear = (): void => {
      if (this.unlockPromise === attempt) this.unlockPromise = null;
    };
    void attempt.then(clear, clear);
    return attempt;
  }

  private async performUnlock(): Promise<void> {
    // A previous gesture created the context but `resume()` was refused; reuse
    // it so repeated gestures can never construct a second context (ER-09-01).
    const existing = this.hostContext;
    if (existing !== null) {
      await this.resumeContext(existing);
      return;
    }

    const factory = this.createContext ?? detectContextFactory();
    if (factory === null) {
      this.unlockState = "unavailable";
      this.deviceFailures += 1;
      return;
    }

    let contextLike: AudioContextLike;
    try {
      contextLike = factory(this.latencyHint);
    } catch {
      this.unlockState = "unavailable";
      this.deviceFailures += 1;
      return;
    }

    const host = asHostContext(contextLike);
    try {
      if (host.state !== "running" && host.resume !== undefined) {
        await host.resume();
      }
    } catch {
      // Missing gesture: keep the one context and stay locked for a retry.
      this.hostContext = host;
      return;
    }

    this.attachContext(host);
  }

  private async resumeContext(host: HostAudioContext): Promise<void> {
    try {
      if (host.state !== "running" && host.resume !== undefined) {
        await host.resume();
      }
    } catch {
      return; // still locked
    }
    if (this.graph === null) this.attachContext(host);
    else this.unlockState = "unlocked";
  }

  private attachContext(host: HostAudioContext): void {
    try {
      this.hostContext = host;
      const graph = buildBusGraph(host, 1, this.busVolumes);
      this.graph = graph;
      // Unlock before applying gains so `clock.now` is the context clock and
      // not 0; the graph is fully built before any public call can see it.
      this.unlockState = "unlocked";
      this.mixer.applyAll();
      this.sfxPool.build(host, graph.busGains);
      this.spatialPool.build(host, graph.busGains);
      this.listener.attach(host);
      const musicBus = graph.busGains[busIndex("music")];
      if (musicBus !== undefined) this.decks.attach(host, musicBus);
      host.addEventListener?.("statechange", this.onStateChange);
      this.suspendedFlag = host.state === "suspended";
    } catch {
      this.deviceFailures += 1;
      this.unlockState = "unavailable";
      this.graph = null;
      this.hostContext = null;
      try {
        void host.close?.();
      } catch {
        // The context never opened far enough to close.
      }
    }
  }

  async suspend(): Promise<void> {
    if (this.disposed || this.unlockState !== "unlocked") return;
    this.explicitSuspend = true;
    this.suspendedFlag = true;
    const host = this.hostContext;
    if (host === null) return;
    if (host.suspend !== undefined) {
      try {
        await host.suspend();
        return;
      } catch {
        // Some TV browsers throw synchronously; fall back to muting (09 §5.9).
      }
    }
    this.masterMutedByHost = true;
    this.mixer.reapplyMaster(0);
  }

  async resume(): Promise<void> {
    if (this.disposed || this.unlockState !== "unlocked") return;
    this.explicitSuspend = false;
    this.masterMutedByHost = false;
    const host = this.hostContext;
    if (host !== null && host.state !== "running" && host.resume !== undefined) {
      try {
        await host.resume();
      } catch {
        try {
          await host.resume();
        } catch {
          return; // stays suspended; the next gesture retries
        }
      }
    }
    this.suspendedFlag = false;
    this.mixer.reapplyMaster(0);
  }

  /* -------------------------------------------------------------- sources */

  createSource(desc: AudioSourceDesc): AudioHandle {
    let index = this.sourceRecords.indexOf(null);
    if (index < 0) {
      index = this.sourceRecords.length;
      this.sourceRecords.push(null);
      this.sourceGenerations.push(0);
    }
    const generation = (this.sourceGenerations[index] ?? 0) + 1;
    this.sourceGenerations[index] = generation;
    const handle: AudioHandle = { index, generation };
    const bus = busIndex(desc.bus ?? "sfx");
    const record: SourceRecord = {
      handle,
      generation,
      assetId: desc.assetId,
      bus: bus < 0 ? busIndex("sfx") : bus,
      positional: desc.positional ?? false,
      loop: desc.loop ?? false,
      volume: clamp01(desc.volume, DEFAULT_SOURCE_VOLUME),
      rate: clampRate(desc.rate, 1),
      distanceModel: desc.distanceModel ?? this.defaultDistanceModel,
      refDistance: desc.refDistance ?? this.defaultRefDistance,
      maxDistance: desc.maxDistance ?? this.defaultMaxDistance,
      rolloff: desc.rolloff ?? this.defaultRolloff,
      priority: clampPriority(desc.priority),
      x: 0,
      y: 0,
      z: 0,
      voiceIndex: -1,
      pool: null,
    };
    this.sourceRecords[index] = record;
    return handle;
  }

  destroySource(handle: AudioHandle): void {
    const record = this.resolveHandle(handle);
    if (record === null) return;
    if (record.pool !== null && record.voiceIndex >= 0) {
      record.pool.scheduleStop(record.voiceIndex, this.clock.now, 0);
    }
    this.sourceRecords[record.handle.index] = null;
    this.sourceGenerations[record.handle.index] = record.generation + 1;
  }

  setSourcePosition(handle: AudioHandle, x: number, y: number, z: number): void {
    const record = this.resolveHandle(handle);
    if (record === null) return;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    record.x = x;
    record.y = y;
    record.z = z;
    if (record.pool !== null && record.voiceIndex >= 0) {
      this.spatialPool.applyPosition(
        record.voiceIndex,
        x,
        y,
        z,
        this.listener,
        this.clock.now,
      );
    }
  }

  play(handle: AudioHandle, opts?: AudioPlayOptions): void {
    const record = this.resolveHandle(handle);
    if (record === null) return;
    const buffer = this.buffers.get(record.assetId);
    if (buffer === undefined) return;

    const pool = record.positional ? this.spatialPool : this.sfxPool;
    const volume = record.volume * clamp01(opts?.volume, 1);
    const rate = clampRate(
      opts?.rate === undefined ? record.rate : record.rate * clamp01(opts.rate, 1),
      1,
    );

    if (record.pool !== null && record.voiceIndex >= 0) {
      record.pool.scheduleStop(record.voiceIndex, this.clock.now, 0);
    }

    const voice = this.startVoice(
      pool,
      buffer,
      record.bus,
      record.priority,
      volume,
      rate,
      record.loop,
      opts?.at,
      record,
    );
    record.voiceIndex = voice;
    record.pool = voice >= 0 ? pool : null;
  }

  stop(handle: AudioHandle, fadeMs?: number): void {
    const record = this.resolveHandle(handle);
    if (record === null || record.pool === null || record.voiceIndex < 0) return;
    const fade = clampMs(fadeMs, 0, AUDIO_MAX_MUSIC_FADE_MS);
    record.pool.scheduleStop(record.voiceIndex, this.clock.now, fade);
    record.voiceIndex = -1;
    record.pool = null;
  }

  playSfx(assetId: string, opts?: PlaySfxOptions): void {
    const buffer = this.buffers.get(assetId);
    if (buffer === undefined) return;
    const requested = opts?.bus ?? "sfx";
    const index = busIndex(requested);
    const bus = index < 0 ? busIndex("sfx") : index;
    this.startVoice(
      this.sfxPool,
      buffer,
      bus,
      AUDIO_SFX_PRIORITY,
      clamp01(opts?.volume, 1),
      clampRate(opts?.rate, 1),
      false,
      undefined,
      null,
    );
  }

  /* ---------------------------------------------------------------- music */

  playMusic(assetId: string, opts?: MusicOptions): void {
    if (this.unlockState !== "unlocked" || this.disposed) return;
    this.radio.stopNow();
    this.music.play(assetId, opts);
  }

  stopMusic(fadeMs?: number): void {
    this.music.stop(clampMs(fadeMs, AUDIO_DEFAULT_MUSIC_FADE_MS, AUDIO_MAX_MUSIC_FADE_MS));
  }

  registerRadioStation(station: RadioStation): void {
    this.radio.register(station);
  }

  tuneRadio(stationId: string, opts?: RadioOptions): void {
    if (this.unlockState !== "unlocked" || this.disposed) {
      this.radio.tune(stationId, opts);
      return;
    }
    this.music.stopNow();
    this.radio.tune(stationId, opts);
  }

  stopRadio(fadeMs?: number): void {
    this.radio.stop(fadeMs === undefined ? 0 : fadeMs);
  }

  /* -------------------------------------------------------------- buffers */

  registerBuffer(assetId: string, buffer: AudioBufferLike): void {
    const result = this.buffers.register(assetId, buffer);
    if (result === "budget" || result === "disabled") this.budgetFailures += 1;
  }

  releaseBuffer(assetId: string): void {
    this.buffers.release(assetId);
  }

  /**
   * Contract gap: the frozen `AudioSystem` has no way to register the stream
   * arm of `AudioAssetValue`. This additive member completes it for the spec
   * 06 integration; it is not part of the declared interface.
   */
  registerStream(assetId: string, url: string, durationSeconds = 0): void {
    if (typeof url !== "string" || url.length === 0) return;
    this.streams.set(assetId, {
      url,
      durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
    });
  }

  releaseStream(assetId: string): void {
    this.streams.delete(assetId);
  }

  /* ----------------------------------------------------------------- loop */

  update(dtSeconds: number): void {
    // `dt` is part of the contract but audio is scheduled on the audio clock.
    void dtSeconds;
    if (this.disposed) return;
    const now = this.clock.now;
    this.sfxPool.releaseExpired(now);
    this.spatialPool.releaseExpired(now);
    if (this.listenerDirty) {
      this.listenerDirty = false;
      this.spatialPool.refreshFallback(this.listener, now);
    }
    this.decks.update(now);
    this.radio.update();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.radio.stopNow();
    this.music.stopNow();
    this.radio.clear();
    this.music.dispose();
    this.decks.dispose();

    const now = this.clock.now;
    this.sfxPool.stopAll(now);
    this.spatialPool.stopAll(now);
    this.buffers.clear();
    this.streams.clear();
    this.sourceRecords = [];
    this.sourceGenerations = [];

    const host = this.hostContext;
    host?.removeEventListener?.("statechange", this.onStateChange);
    this.hostContext = null;
    this.graph = null;
    this.unlockState = "unavailable";
    this.suspendedFlag = false;
    this.masterMutedByHost = false;
    this.unlockPromise = null;
    this.listener.attach(null);
    if (host !== null) {
      try {
        void host.close?.();
      } catch {
        // The context was already closed.
      }
    }
  }

  /** A typed error value for callers that want to report `E_AUDIO_*`. */
  lastError(code: "E_AUDIO_DEVICE" | "E_AUDIO_DECODE" | "E_AUDIO_BUDGET"): AudioEngineError {
    return new AudioEngineError(code, `audio ${code}`, true);
  }

  /* -------------------------------------------------------------- private */

  private resolveHandle(handle: AudioHandle): SourceRecord | null {
    if (this.disposed) return null;
    const index = handle.index;
    if (!Number.isInteger(index) || index < 0) return null;
    const record = this.sourceRecords[index];
    if (record === null || record === undefined) return null;
    if (record.generation !== handle.generation) return null;
    return record;
  }

  private resolveTrack(assetId: string): ResolvedTrack | null {
    const buffer = this.buffers.get(assetId);
    if (buffer !== undefined) return { kind: "buffer", buffer };
    const stream = this.streams.get(assetId);
    if (stream !== undefined) return { kind: "stream", url: stream.url };
    return null;
  }

  private startVoice(
    pool: VoicePool,
    buffer: AudioBufferLike,
    bus: number,
    priority: number,
    volume: number,
    rate: number,
    loop: boolean,
    at: number | undefined,
    record: SourceRecord | null,
  ): number {
    if (this.disposed || this.unlockState !== "unlocked") return -1;
    const host = this.hostContext;
    if (host === null) return -1;

    const now = this.clock.now;
    const index = pool.select(priority, now);
    if (index === -1) {
      this.counters.droppedPlays += 1;
      return -1;
    }
    const stolen = pool.active[index] === 1;
    if (stolen) {
      pool.beginSteal(index, now);
      this.counters.steals += 1;
    }

    const startAt = oneShotStartTime(now, at);
    pool.baseVolume[index] = volume;
    pool.priorities[index] = priority;
    pool.startedAt[index] = now;
    pool.freeAt[index] = 0;
    pool.active[index] = 1;

    if (record !== null && pool === this.spatialPool) {
      const spatial = this.spatialPool;
      spatial.refDistances[index] = record.refDistance;
      spatial.maxDistances[index] = record.maxDistance;
      spatial.rolloffs[index] = record.rolloff;
      spatial.distanceModelCodes[index] = spatial.distanceModelCode(
        record.distanceModel,
      );
      spatial.posX[index] = record.x;
      spatial.posY[index] = record.y;
      spatial.posZ[index] = record.z;
      spatial.attenuation[index] = spatial.hasNativePanner
        ? 1
        : spatial.attenuationForVoice(index, record.x, record.y, record.z, this.listener);
    }

    const gain = pool.gains[index] ?? null;
    if (gain === null) {
      pool.release(index);
      return -1;
    }

    const level =
      record !== null && pool === this.spatialPool && !this.spatialPool.hasNativePanner
        ? volume * (this.spatialPool.attenuation[index] ?? 1)
        : volume;

    const param = gain.gain;
    param.cancelScheduledValues(startAt);
    if (stolen) {
      param.setValueAtTime(0, startAt);
      param.linearRampToValueAtTime(level, startAt + AUDIO_VOICE_STEAL_RAMP_MS / 1000);
    } else {
      param.setValueAtTime(level, startAt);
    }

    const source = host.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;
    source.playbackRate.setValueAtTime(rate, startAt);
    source.onended = pool.endedHandlerFor(index);
    source.connect(gain);
    pool.sources[index] = source;
    pool.connectBus(index, bus);

    try {
      source.start(startAt);
    } catch {
      pool.release(index);
      return -1;
    }

    if (record !== null && pool === this.spatialPool) {
      this.spatialPool.applyPosition(
        index,
        record.x,
        record.y,
        record.z,
        this.listener,
        now,
      );
    }
    return index;
  }
}

/** Kept for callers that annotate the concrete graph in tests. */
export type AudioSystemGainNode = ReturnType<typeof buildBusGraph>["masterGain"];
export type AudioSystemPublic = AudioSystem;
export type AudioSystemListener = AudioListener;
export type AudioSystemMixer = AudioMixer;
export type AudioSystemClock = AudioClock;
export type AudioSystemPanning = PanningModel;
export type AudioSystemHandle = AudioHandle;
