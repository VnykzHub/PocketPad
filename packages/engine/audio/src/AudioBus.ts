/**
 * M0 `AudioBus` migration (spec 09 §5.13, ER-09-10).
 *
 * Behaviour-for-behaviour port of `packages/runtime/src/audio/AudioBus.ts`
 * onto the DOM-free seams (`AudioContextLike`, `AudioBufferLike`,
 * `AudioDecodeInput`). The frozen surface is unchanged: one master gain, one
 * music gain, a round-robin SFX pool, lazy context creation from `unlock()`,
 * audio-clock fades, and a non-reusable `dispose()`.
 *
 * The runtime class imported DOM types directly; this port reaches the node
 * factory surface through the one `asHostContext` cast, exactly like
 * `AudioSystem`. No member was added beyond the contract except the private
 * implementation. `attachContext` from the contract comment is deliberately
 * not implemented: a public attach path would build a graph outside
 * `unlock()` and weaken FR-9.11.
 *
 * Interpretation notes preserved from M0:
 * - `clampVolume` maps a non-finite volume to 0 (not to the fallback).
 * - `playSfx` is round-robin and stops the previous source on that voice.
 * - `playMusic` starts at `currentTime` with no lead and no crossfade.
 * - `decodeAudio` rejects while locked, because decoding needs a context.
 */

import type {
  AudioBufferLike,
  AudioBus as AudioBusContract,
  AudioBusOptions,
  AudioContextLike,
  AudioDecodeInput,
  AudioLatencyHint,
  AudioUnlockState,
  MusicOptions,
  SfxOptions,
} from "./contracts/audio.js";
import { asHostContext, detectContextFactory } from "./host/types.js";
import type {
  HostAudioContext,
  HostBufferSourceNode,
  HostGainNode,
} from "./host/types.js";
import { DEFAULT_SFX_VOICES } from "./version.js";

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export class AudioBus implements AudioBusContract {
  readonly latencyHint: AudioLatencyHint;

  private readonly factory:
    | ((latencyHint: AudioLatencyHint) => AudioContextLike)
    | null;
  private readonly voiceCount: number;
  private readonly sfxBuffers = new Map<string, AudioBufferLike>();
  private readonly musicBuffers = new Map<string, AudioBufferLike>();

  private busState: AudioUnlockState;
  private masterVolumeValue: number;
  private context: HostAudioContext | null = null;
  private masterGain: HostGainNode | null = null;
  private musicGain: HostGainNode | null = null;
  private voices: HostGainNode[] = [];
  private voiceSources: Array<HostBufferSourceNode | null> = [];
  private voiceIndex = 0;
  private activeMusic: HostBufferSourceNode | null = null;
  private pausedFlag = false;
  private unlockPromise: Promise<void> | null = null;

  constructor(options: AudioBusOptions = {}) {
    this.latencyHint = options.latencyHint ?? "interactive";
    this.factory = options.createContext ?? detectContextFactory();
    this.busState = this.factory === null ? "unavailable" : "locked";
    this.masterVolumeValue = clampVolume(options.masterVolume ?? 1);
    const requestedVoices = options.sfxVoices ?? DEFAULT_SFX_VOICES;
    this.voiceCount = Math.max(
      1,
      Math.floor(
        Number.isFinite(requestedVoices) ? requestedVoices : DEFAULT_SFX_VOICES,
      ),
    );
  }

  get state(): AudioUnlockState {
    return this.busState;
  }

  get unlocked(): boolean {
    return this.busState === "unlocked";
  }

  get paused(): boolean {
    return this.pausedFlag;
  }

  get available(): boolean {
    return this.busState !== "unavailable";
  }

  get masterVolume(): number {
    return this.masterVolumeValue;
  }

  get baseLatency(): number {
    const context = this.context;
    if (context === null) return 0;
    return typeof context.baseLatency === "number" ? context.baseLatency : 0;
  }

  get outputLatency(): number {
    const context = this.context;
    if (context === null) return 0;
    const output = context.outputLatency;
    if (typeof output === "number" && Number.isFinite(output)) return output;
    return this.baseLatency;
  }

  /**
   * Creates and resumes the single context. Idempotent and never rejects: a
   * blocked or missing Web Audio leaves the bus `unavailable` (FR-9.11).
   */
  unlock(): Promise<void> {
    if (this.busState !== "locked") return Promise.resolve();
    const inFlight = this.unlockPromise;
    if (inFlight !== null) return inFlight;

    const attempt = this.performUnlock();
    this.unlockPromise = attempt;
    const clear = (): void => {
      if (this.unlockPromise === attempt) this.unlockPromise = null;
    };
    void attempt.then(clear, clear);
    return attempt;
  }

  setMasterVolume(volume: number): void {
    this.masterVolumeValue = clampVolume(volume);
    const master = this.masterGain;
    const context = this.context;
    if (master !== null && context !== null) {
      master.gain.setValueAtTime(this.masterVolumeValue, context.currentTime);
    }
  }

  registerSfx(id: string, buffer: AudioBufferLike): void {
    this.sfxBuffers.set(id, buffer);
  }

  registerMusic(id: string, buffer: AudioBufferLike): void {
    this.musicBuffers.set(id, buffer);
  }

  /** Rejects while locked: decoding needs the context (FR-9.11). */
  async decodeAudio(data: AudioDecodeInput): Promise<AudioBufferLike> {
    const context = this.context;
    if (this.busState !== "unlocked" || context === null) {
      throw new Error(
        "AudioBus is locked; unlock it from a user gesture before decoding audio.",
      );
    }
    const decode = context.decodeAudioData;
    if (decode === undefined) {
      throw new Error("AudioBus has no AudioContext.decodeAudioData.");
    }
    const bytes = data instanceof ArrayBuffer ? data : await data.arrayBuffer();
    return (await decode.call(context, bytes)) as AudioBufferLike;
  }

  /** Round-robin pooled voice; silent no-op while locked or paused. */
  playSfx(id: string, opts: SfxOptions = {}): void {
    if (this.busState !== "unlocked" || this.pausedFlag) return;
    const context = this.context;
    const voices = this.voices;
    if (context === null || voices.length === 0) return;
    const buffer = this.sfxBuffers.get(id);
    if (buffer === undefined) return;

    const index = this.voiceIndex;
    this.voiceIndex = (index + 1) % voices.length;
    const voice = voices[index];
    if (voice === undefined) return;

    const previous = this.voiceSources[index];
    if (previous !== null && previous !== undefined) {
      try {
        previous.stop();
      } catch {
        // The source already ended; nothing to stop.
      }
    }

    voice.gain.setValueAtTime(clampVolume(opts.volume ?? 1), context.currentTime);

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.setValueAtTime(opts.rate ?? 1, context.currentTime);
    source.connect(voice);
    source.start();
    this.voiceSources[index] = source;
  }

  /** Starts or replaces the single music track (no crossfade in M0). */
  playMusic(id: string, opts: MusicOptions = {}): void {
    if (this.busState !== "unlocked" || this.pausedFlag) return;
    const context = this.context;
    const musicGain = this.musicGain;
    if (context === null || musicGain === null) return;
    const buffer = this.musicBuffers.get(id);
    if (buffer === undefined) return;

    this.stopActiveMusic();

    const fadeMs = Math.max(0, opts.fadeMs ?? 0);
    const volume = clampVolume(opts.volume ?? 1);
    const startAt = context.currentTime;
    musicGain.gain.cancelScheduledValues(startAt);
    if (fadeMs > 0) {
      musicGain.gain.setValueAtTime(0, startAt);
      musicGain.gain.linearRampToValueAtTime(volume, startAt + fadeMs / 1000);
    } else {
      musicGain.gain.setValueAtTime(volume, startAt);
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = opts.loop ?? true;
    source.connect(musicGain);
    source.start();
    this.activeMusic = source;
  }

  /** Fades music out on the audio clock; `fadeMs` 0 stops immediately. */
  stopMusic(fadeMs = 0): void {
    const source = this.activeMusic;
    const context = this.context;
    const musicGain = this.musicGain;
    if (source === null || context === null || musicGain === null) return;

    this.activeMusic = null;
    const fade = Math.max(0, fadeMs) / 1000;
    const startAt = context.currentTime;
    musicGain.gain.cancelScheduledValues(startAt);
    if (fade > 0) {
      musicGain.gain.setValueAtTime(musicGain.gain.value, startAt);
      musicGain.gain.linearRampToValueAtTime(0, startAt + fade);
      try {
        source.stop(startAt + fade);
      } catch {
        // The source already ended.
      }
    } else {
      musicGain.gain.setValueAtTime(0, startAt);
      try {
        source.stop(startAt);
      } catch {
        // The source already ended.
      }
    }
  }

  /** Context time in seconds, or 0 before unlock. */
  now(): number {
    const context = this.context;
    return context === null ? 0 : context.currentTime;
  }

  /** Suspends output (hidden tab); playback calls become no-ops. */
  pause(): void {
    if (this.pausedFlag) return;
    this.pausedFlag = true;
    const context = this.context;
    if (
      this.busState === "unlocked" &&
      context !== null &&
      context.state === "running"
    ) {
      try {
        void context.suspend?.().catch(() => {});
      } catch {
        // Some TV browsers throw synchronously when suspending; stay paused.
      }
    }
  }

  async resume(): Promise<void> {
    if (!this.pausedFlag) return;
    this.pausedFlag = false;
    const context = this.context;
    if (this.busState !== "unlocked" || context === null) return;
    if (context.state !== "running" && context.resume !== undefined) {
      try {
        await context.resume();
      } catch {
        // Leave the context as it is; the bus stays unlocked but silent.
      }
    }
  }

  /** Stops everything and closes the context. The bus is not reusable. */
  dispose(): void {
    this.stopMusic(0);
    const context = this.context;
    this.context = null;
    this.masterGain = null;
    this.musicGain = null;
    this.voices = [];
    this.voiceSources = [];
    this.activeMusic = null;
    this.sfxBuffers.clear();
    this.musicBuffers.clear();
    this.busState = "unavailable";
    this.pausedFlag = false;
    if (context !== null) {
      try {
        void context.close?.().catch(() => {});
      } catch {
        // The context was already closed.
      }
    }
  }

  private async performUnlock(): Promise<void> {
    const factory = this.factory;
    if (factory === null) {
      this.busState = "unavailable";
      return;
    }

    let created: HostAudioContext | null = null;
    try {
      const context = asHostContext(factory(this.latencyHint));
      created = context;

      const master = context.createGain();
      master.gain.value = this.masterVolumeValue;
      master.connect(context.destination);

      const music = context.createGain();
      // Silent until `playMusic` ramps it up; no click on first unlock.
      music.gain.value = 0;
      music.connect(master);

      const voices: HostGainNode[] = [];
      const sources: Array<HostBufferSourceNode | null> = [];
      for (let index = 0; index < this.voiceCount; index += 1) {
        const voice = context.createGain();
        voice.gain.value = 0;
        voice.connect(master);
        voices.push(voice);
        sources.push(null);
      }

      if (context.state !== "running" && context.resume !== undefined) {
        await context.resume();
      }

      this.context = context;
      this.masterGain = master;
      this.musicGain = music;
      this.voices = voices;
      this.voiceSources = sources;
      this.voiceIndex = 0;
      this.busState = "unlocked";

      if (this.pausedFlag) {
        await context.suspend?.();
      }
    } catch {
      if (created !== null) {
        try {
          void created.close?.().catch(() => {});
        } catch {
          // The context never opened far enough to close.
        }
      }
      this.context = null;
      this.masterGain = null;
      this.musicGain = null;
      this.voices = [];
      this.voiceSources = [];
      this.busState = "unavailable";
    }
  }

  private stopActiveMusic(): void {
    const source = this.activeMusic;
    if (source === null) return;
    this.activeMusic = null;
    try {
      source.stop();
    } catch {
      // The source already ended.
    }
    const musicGain = this.musicGain;
    const context = this.context;
    if (musicGain !== null && context !== null) {
      musicGain.gain.cancelScheduledValues(context.currentTime);
      musicGain.gain.setValueAtTime(0, context.currentTime);
    }
  }
}
