/**
 * `@lanpad/engine-audio` public entry.
 *
 * Exports the frozen spec 09 contracts, the runtime constants, and the
 * implementation behind them: the `AudioSystem` facade, the M0 `AudioBus`
 * migration, the mixer, voice pools, listener, clock, buffer registry, music
 * decks and radio. The declared surface is unchanged; the concrete classes
 * add only the members documented at their definition (stream registration,
 * failure counters).
 */

export type * from "./contracts/audio.js";

export { EngineAudioSystem } from "./AudioSystem.js";
export type {
  AudioSystemClock,
  AudioSystemGainNode,
  AudioSystemHandle,
  AudioSystemListener,
  AudioSystemMixer,
  AudioSystemPanning,
  AudioSystemPublic,
} from "./AudioSystem.js";
export { AudioBus } from "./AudioBus.js";

export { EngineAudioClock } from "./clock/AudioClock.js";
export type { AudioClockHost } from "./clock/AudioClock.js";

export { DecodedBufferRegistry, bufferByteSize } from "./decode/decodeAudio.js";
export type { RegisterResult } from "./decode/decodeAudio.js";

export {
  AudioEngineError,
  AudioValidationError,
  audioError,
} from "./errors.js";

export { parseMixConfig, validateMixConfig } from "./config/mix.js";
export type { MixValidation } from "./config/mix.js";
export { parseRadioDocument, validateRadioDocument } from "./config/radio.js";
export type { RadioValidation } from "./config/radio.js";

export { buildBusGraph, busIndex } from "./mixer/BusGraph.js";
export type { AudioBusGraph } from "./mixer/BusGraph.js";
export { Mixer } from "./mixer/Mixer.js";
export type { MixerGainHost, MixerHost } from "./mixer/Mixer.js";

export {
  CROSSFADE_CURVE_POINTS,
  Deck,
  DeckPair,
  fillFadeInCurve,
  fillFadeOutCurve,
} from "./music/Decks.js";
export type { BufferTrack, ResolvedTrack, StreamTrack } from "./music/Decks.js";
export { MusicPlayer } from "./music/MusicPlayer.js";
export type { TrackResolver } from "./music/MusicPlayer.js";
export { RadioPlayer } from "./music/RadioPlayer.js";

export {
  clamp01,
  clampByteBudget,
  clampMs,
  clampVoiceCount,
  oneShotStartTime,
} from "./schedule.js";

export { distanceGain, equalPowerGains, panForSource } from "./spatial/distance.js";
export { EngineListener } from "./spatial/Listener.js";
export { SpatialPool } from "./spatial/SpatialPool.js";

export { SfxPool } from "./voice/SfxPool.js";
export { selectVoice, selectVoiceIndex } from "./voice/VoiceStealing.js";
export type { VoiceCandidate } from "./voice/VoiceStealing.js";
export { VoicePool } from "./voice/VoicePool.js";

export {
  asHostContext,
  detectContextFactory,
  detectMediaElementFactory,
} from "./host/types.js";
export type {
  HostAudioContext,
  HostAudioListener,
  HostAudioNode,
  HostAudioParam,
  HostBufferSourceNode,
  HostContextEventTarget,
  HostDistanceModel,
  HostDocumentLike,
  HostGainNode,
  HostMediaElementSourceNode,
  HostPannerNode,
  HostPanningModel,
  HostStereoPannerNode,
} from "./host/types.js";

export {
  AUDIO_CONTRACT_VERSION,
  AUDIO_MIX_VERSION,
  AUDIO_RADIO_VERSION,
  AUDIO_MIX_MAX_BYTES,
  AUDIO_RADIO_MAX_BYTES,
  AUDIO_MAX_STATIONS,
  AUDIO_MAX_TRACKS_PER_STATION,
  AUDIO_STATION_ID_PATTERN,
  AUDIO_BUS_NAMES,
  DEFAULT_AUDIO_LATENCY_HINT,
  DEFAULT_MASTER_VOLUME,
  DEFAULT_SFX_VOICES,
  DEFAULT_SPATIAL_VOICES,
  AUDIO_MIN_VOICES,
  AUDIO_MAX_VOICES,
  DEFAULT_DECODE_BUDGET_BYTES,
  AUDIO_MAX_DECODE_BUDGET_BYTES,
  AUDIO_BYTES_PER_SAMPLE,
  AUDIO_STREAM_DURATION_THRESHOLD_SECONDS,
  AUDIO_STREAM_BYTES_THRESHOLD,
  AUDIO_MIN_PLAYBACK_RATE,
  AUDIO_MAX_PLAYBACK_RATE,
  DEFAULT_SOURCE_VOLUME,
  DEFAULT_SOURCE_PRIORITY,
  AUDIO_MIN_PRIORITY,
  AUDIO_MAX_PRIORITY,
  AUDIO_SFX_PRIORITY,
  AUDIO_VOICE_PRIORITY_MIN,
  AUDIO_VOICE_PRIORITY_MAX,
  AUDIO_AMBIENT_PRIORITY_MIN,
  AUDIO_AMBIENT_PRIORITY_MAX,
  DEFAULT_DISTANCE_MODEL,
  DEFAULT_PANNING_MODEL,
  DEFAULT_REF_DISTANCE,
  DEFAULT_MAX_DISTANCE,
  DEFAULT_ROLLOFF,
  AUDIO_MAX_ROLLOFF,
  AUDIO_GAIN_SMOOTHING_SECONDS,
  AUDIO_VOICE_STEAL_RAMP_MS,
  AUDIO_START_LEAD_SECONDS,
  AUDIO_MUSIC_FADE_ANCHOR_SECONDS,
  AUDIO_MAX_SCHEDULE_AHEAD_SECONDS,
  AUDIO_DEFAULT_MUSIC_FADE_MS,
  AUDIO_MAX_MUSIC_FADE_MS,
  AUDIO_DEFAULT_RADIO_CROSSFADE_MS,
  AUDIO_MAX_RADIO_CROSSFADE_MS,
  AUDIO_DOPPLER_MIN,
  AUDIO_DOPPLER_MAX,
  AUDIO_VOICE_STEALING_ORDER,
  AUDIO_ERROR_CODES,
} from "./version.js";
