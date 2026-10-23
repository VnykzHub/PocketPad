/**
 * Game audio asset wiring (spec 23 §4; FR-9.11, ER-23-10).
 *
 * `assets.json` audio entries are fetched with their group, but decoded only
 * after the start gesture unlocked the shared `AudioBus`. The asset service
 * depends on this narrow sink instead of the concrete bus, so the gesture rule
 * lives in one place and tests can inject a recorder.
 *
 * `AudioBus` satisfies `GameAudioSink` structurally: `unlocked`, `available`,
 * `decodeAudio`, `registerSfx` and `registerMusic` already exist with these
 * signatures. Registration writes each buffer under its asset id in both the
 * SFX and music maps; the manifest has no role field, so both
 * `playSfx(id)` and `playMusic(id)` must resolve.
 */

export interface GameAudioSink {
  /** True only after the start gesture created and resumed the AudioContext. */
  readonly unlocked: boolean;
  /**
   * False when Web Audio cannot run at all. Optional for simple fakes; a
   * missing value is treated as "would work after a gesture", so decoding
   * before unlock still fails loudly.
   */
  readonly available?: boolean;
  /** Decodes with the one shared context. Must throw while locked. */
  decodeAudio(data: Blob | ArrayBuffer): Promise<AudioBuffer>;
  registerSfx(id: string, buffer: AudioBuffer): void;
  registerMusic(id: string, buffer: AudioBuffer): void;
}

/** One audio asset that failed to decode during registration. */
export interface GameAudioRegistrationFailure {
  readonly id: string;
  readonly code: "E_ASSET_DECODE";
  readonly message: string;
}

/** Result of `GameAssetLibrary.registerAudio`; decode failures never throw. */
export interface GameAudioRegistration {
  /** Ids decoded and registered by this call, in declaration order. */
  readonly registered: readonly string[];
  readonly failures: readonly GameAudioRegistrationFailure[];
  /** True when Web Audio is unavailable and nothing was decoded. */
  readonly skipped: boolean;
}
