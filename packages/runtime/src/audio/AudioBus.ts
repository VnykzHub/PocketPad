/**
 * AudioBus — the single audio path for the host runtime (D3-RT-05).
 *
 * Spec: §9.6; FR-9.11, C8, E11.
 *
 * Hard rules this module enforces:
 * - **No audio before a user gesture.** No `AudioContext` is constructed until
 *   `unlock()` is called from the start screen's Enter/Space/click handler
 *   (FR-9.11). `playSfx`/`playMusic` are silent no-ops while locked, so a game
 *   that calls them during `init` cannot autoplay.
 * - **One context, one master gain.** All voices and music route through
 *   `masterGain` → `destination`; `setMasterVolume` is the only global volume.
 * - **Fades use the audio clock.** `playMusic`/`stopMusic` schedule gain ramps
 *   and `source.stop()` at `AudioContext.currentTime`, never `setTimeout`, so a
 *   paused or hidden tab cannot drift from the scheduled beat (C8).
 * - **No clock, no sound.** `now()` is the `AudioContext` clock; `baseLatency`
 *   and `outputLatency` are exposed so E11 calibration can measure output
 *   latency instead of guessing it.
 *
 * Voice pooling: the gain node for each SFX voice is created once at unlock and
 * reused round-robin. Web Audio requires a fresh `AudioBufferSourceNode` per
 * playback; that is the only per-SFX allocation and it is unavoidable. The
 * hot-path rule (PR-9.3) applies to the fixed loop, not to a sound trigger.
 */

/** E11 lets the host pick `interactive` (low latency) or `balanced`. */
export type AudioLatencyHint = "interactive" | "balanced";

/**
 * `locked` — no context yet; nothing may play.
 * `unlocked` — the gesture happened and the context is running.
 * `unavailable` — Web Audio is missing or failed; the game runs silently.
 */
export type AudioBusState = "locked" | "unlocked" | "unavailable";

export interface SfxOptions {
  /** 0..1; clamped. Default 1. */
  readonly volume?: number;
  /** Playback rate multiplier (1 = normal pitch). Default 1. */
  readonly rate?: number;
}

export interface MusicOptions {
  /** Default true: host music is usually a background loop. */
  readonly loop?: boolean;
  /** Gain ramp length in milliseconds. Default 0 (immediate). */
  readonly fadeMs?: number;
  /** 0..1; clamped. Default 1. */
  readonly volume?: number;
}

export interface AudioBusOptions {
  readonly latencyHint?: AudioLatencyHint;
  /**
   * Test/swap seam. Defaults to `globalThis.AudioContext` when it exists and
   * is `null` otherwise, so a Node test can construct the bus without Web Audio.
   * The factory is only invoked from `unlock()`, never from the constructor.
   */
  readonly createContext?: (latencyHint: AudioLatencyHint) => AudioContext;
  /** Master gain applied when the context is created. Default 1. */
  readonly masterVolume?: number;
  /** Number of pooled SFX gain nodes. Default 8. */
  readonly sfxVoices?: number;
}

/** Default number of overlapping SFX voices. */
export const DEFAULT_SFX_VOICES = 8;

type AudioContextConstructor = new (
  options?: AudioContextOptions,
) => AudioContext;

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Returns a factory only when the browser exposes Web Audio. Detection reads
 * the constructor, not the user agent (FR-12.1). The context itself is still
 * created lazily by `unlock()`.
 */
function detectBrowserFactory(): ((hint: AudioLatencyHint) => AudioContext) | null {
  const ctor = (
    globalThis as unknown as { AudioContext?: AudioContextConstructor }
  ).AudioContext;
  if (typeof ctor !== "function") return null;
  return (latencyHint) => new ctor({ latencyHint });
}

export class AudioBus {
  readonly latencyHint: AudioLatencyHint;

  private readonly factory: ((hint: AudioLatencyHint) => AudioContext) | null;
  private readonly voiceCount: number;
  private readonly sfxBuffers = new Map<string, AudioBuffer>();
  private readonly musicBuffers = new Map<string, AudioBuffer>();

  private busState: AudioBusState;
  private masterVolumeValue: number;
  private context: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private voices: GainNode[] = [];
  private voiceSources: Array<AudioBufferSourceNode | null> = [];
  private voiceIndex = 0;
  private activeMusic: AudioBufferSourceNode | null = null;
  private pausedFlag = false;
  private unlockPromise: Promise<void> | null = null;

  constructor(options: AudioBusOptions = {}) {
    this.latencyHint = options.latencyHint ?? "interactive";
    this.factory = options.createContext ?? detectBrowserFactory();
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

  get state(): AudioBusState {
    return this.busState;
  }

  /** Frozen interface member (D3-RT-05). */
  get unlocked(): boolean {
    return this.busState === "unlocked";
  }

  /** True while the host asked the bus to stay silent (hidden tab). */
  get paused(): boolean {
    return this.pausedFlag;
  }

  /** False only when Web Audio cannot run at all. */
  get available(): boolean {
    return this.busState !== "unavailable";
  }

  get masterVolume(): number {
    return this.masterVolumeValue;
  }

  /** `AudioContext.baseLatency` after unlock, else 0. */
  get baseLatency(): number {
    const context = this.context;
    if (context === null) return 0;
    return typeof context.baseLatency === "number" ? context.baseLatency : 0;
  }

  /** `AudioContext.outputLatency` (E11 calibration input), else 0. */
  get outputLatency(): number {
    const context = this.context;
    if (context === null) return 0;
    const output = (context as AudioContext & { outputLatency?: number })
      .outputLatency;
    if (typeof output === "number" && Number.isFinite(output)) return output;
    return this.baseLatency;
  }

  /**
   * Creates and resumes the single `AudioContext`. Must be called from a user
   * gesture (Enter/Space/click on the start screen). Idempotent, and it never
   * rejects: if the browser blocks or lacks Web Audio the bus becomes
   * `unavailable` and the start screen shows its silent fallback (FR-9.11).
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

  /** Sets the master gain through a short ramp-free assignment (0..1). */
  setMasterVolume(volume: number): void {
    this.masterVolumeValue = clampVolume(volume);
    const master = this.masterGain;
    const context = this.context;
    if (master !== null && context !== null) {
      master.gain.setValueAtTime(this.masterVolumeValue, context.currentTime);
    }
  }

  /**
   * Registers a decoded SFX buffer. Decode with `decodeAudio` (or the asset
   * loader's `decodeAudio` hook) first; the bus never fetches.
   */
  registerSfx(id: string, buffer: AudioBuffer): void {
    this.sfxBuffers.set(id, buffer);
  }

  /** Registers a decoded music buffer. */
  registerMusic(id: string, buffer: AudioBuffer): void {
    this.musicBuffers.set(id, buffer);
  }

  /**
   * Decodes audio bytes with the bus's context. Audio bytes may arrive as a
   * `Blob` from `AssetLoader` or as an `ArrayBuffer`.
   *
   * Rejects while locked: decoding needs the `AudioContext`, and creating one
   * before the gesture would break FR-9.11. Games decode during `init`, which
   * runs after the start screen unlocked the bus.
   */
  async decodeAudio(data: Blob | ArrayBuffer): Promise<AudioBuffer> {
    const context = this.context;
    if (this.busState !== "unlocked" || context === null) {
      throw new Error(
        "AudioBus is locked; unlock it from a user gesture before decoding audio.",
      );
    }
    const bytes = data instanceof ArrayBuffer ? data : await data.arrayBuffer();
    return context.decodeAudioData(bytes);
  }

  /**
   * Plays a short buffer through a pooled voice. Silent no-op while locked or
   * paused; unknown ids are ignored (a missing asset must not crash the host).
   */
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

    // A long sample must not overlap itself on the same voice; stop it first.
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

  /**
   * Starts (or replaces) the single music track. Silent no-op while locked or
   * paused. A previous track is stopped immediately; the new one fades in on
   * the audio clock so Beat Tap can trust `now()` (C8).
   */
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

  /**
   * Fades the current music out on the audio clock and schedules its stop.
   * `fadeMs` of 0 stops immediately. No-op when no music is active.
   */
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

  /** `AudioContext.currentTime`, or 0 before unlock (no context, no clock). */
  now(): number {
    const context = this.context;
    return context === null ? 0 : context.currentTime;
  }

  /**
   * Suspends audio output (host tab hidden, D4). Playback calls become no-ops
   * while paused, and `resume()` continues the same context without a jump.
   */
  pause(): void {
    if (this.pausedFlag) return;
    this.pausedFlag = true;
    const context = this.context;
    if (this.busState === "unlocked" && context !== null && context.state === "running") {
      try {
        void context.suspend().catch(() => {});
      } catch {
        // Some TV browsers throw synchronously when suspending; stay paused.
      }
    }
  }

  /** Undoes `pause()`. Resolves after the context resumed, if it was running. */
  async resume(): Promise<void> {
    if (!this.pausedFlag) return;
    this.pausedFlag = false;
    const context = this.context;
    if (this.busState !== "unlocked" || context === null) return;
    if (context.state !== "running") {
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
        void context.close().catch(() => {});
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

    let created: AudioContext | null = null;
    try {
      const context = factory(this.latencyHint);
      created = context;

      const master = context.createGain();
      master.gain.value = this.masterVolumeValue;
      master.connect(context.destination);

      const music = context.createGain();
      // Silent until `playMusic` ramps it up; no click on first unlock.
      music.gain.value = 0;
      music.connect(master);

      const voices: GainNode[] = [];
      const sources: Array<AudioBufferSourceNode | null> = [];
      for (let index = 0; index < this.voiceCount; index += 1) {
        const voice = context.createGain();
        voice.gain.value = 0;
        voice.connect(master);
        voices.push(voice);
        sources.push(null);
      }

      if (context.state !== "running") {
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
        await context.suspend();
      }
    } catch {
      if (created !== null) {
        try {
          void created.close().catch(() => {});
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
