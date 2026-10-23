/**
 * Public runtime constants for `@lanpad/engine-audio`.
 *
 * The matching type declarations live in `src/contracts/audio.d.ts`; the
 * values here are the single runtime source of truth and must agree with
 * spec 09. Every value is a rule stated by 09; none is a measurement.
 */

/** Wave brief contract version. */
export const AUDIO_CONTRACT_VERSION = 1 as const;

/** 09 §4.2, §4.4. `audio-mix.json` format version. */
export const AUDIO_MIX_VERSION = 1 as const;

/** 09 §4.3, §4.4. `radio-stations.json` format version. */
export const AUDIO_RADIO_VERSION = 1 as const;

/** 09 §4.2. UTF-8 bytes, hard cap. */
export const AUDIO_MIX_MAX_BYTES = 4096 as const;

/** 09 §4.3. UTF-8 bytes, hard cap. */
export const AUDIO_RADIO_MAX_BYTES = 16384 as const;

/** 09 §4.3. Stations per file. */
export const AUDIO_MAX_STATIONS = 32 as const;

/** 09 §4.3. Tracks per station. */
export const AUDIO_MAX_TRACKS_PER_STATION = 64 as const;

/** 09 §4.3, §3.4. Station id pattern. */
export const AUDIO_STATION_ID_PATTERN = "^[a-z0-9][a-z0-9-]{0,31}$";

/** 09 §3.1, §5.3. Bus names in mix order. */
export const AUDIO_BUS_NAMES = [
  "music",
  "sfx",
  "ambient",
  "voice",
  "ui",
] as const;

/** 09 §3.1. Default latency hint. */
export const DEFAULT_AUDIO_LATENCY_HINT = "interactive" as const;

/** 09 §3.1. Default master volume. */
export const DEFAULT_MASTER_VOLUME = 1 as const;

/** 09 §3.1, §5.4. Default non-positional voice count, matching today. */
export const DEFAULT_SFX_VOICES = 8 as const;

/** 09 §3.1, §5.4. Default positional voice count. */
export const DEFAULT_SPATIAL_VOICES = 16 as const;

/** 09 §3.1, §4.2. Voice-count bounds. */
export const AUDIO_MIN_VOICES = 1 as const;
export const AUDIO_MAX_VOICES = 32 as const;

/** 09 §3.1, §4.2. Default decoded-buffer budget: 32 MiB. */
export const DEFAULT_DECODE_BUDGET_BYTES = 33554432 as const;

/** 09 §3.1. Decode-budget ceiling: 256 MiB. */
export const AUDIO_MAX_DECODE_BUDGET_BYTES = 268435456 as const;

/** 09 §4.1. Backing float32 storage per sample channel. */
export const AUDIO_BYTES_PER_SAMPLE = 4 as const;

/** 09 §4.1. Stream when duration exceeds 30 s. */
export const AUDIO_STREAM_DURATION_THRESHOLD_SECONDS = 30 as const;

/** 09 §4.1. Stream when encoded bytes exceed 1 MiB. */
export const AUDIO_STREAM_BYTES_THRESHOLD = 1048576 as const;

/** 09 §3.3. Playback-rate bounds. */
export const AUDIO_MIN_PLAYBACK_RATE = 0.25 as const;
export const AUDIO_MAX_PLAYBACK_RATE = 4 as const;

/** 09 §3.3. Default source volume. */
export const DEFAULT_SOURCE_VOLUME = 1 as const;

/** 09 §3.3, §5.4. Default source priority. */
export const DEFAULT_SOURCE_PRIORITY = 128 as const;

/** 09 §3.3. Priority bounds. */
export const AUDIO_MIN_PRIORITY = 0 as const;
export const AUDIO_MAX_PRIORITY = 255 as const;

/** 09 §5.4. `playSfx` requests the default SFX priority. */
export const AUDIO_SFX_PRIORITY = 128 as const;

/** 09 §5.4. Dialogue and UI priority band. */
export const AUDIO_VOICE_PRIORITY_MIN = 200 as const;
export const AUDIO_VOICE_PRIORITY_MAX = 220 as const;

/** 09 §5.4. Distant-ambience priority band. */
export const AUDIO_AMBIENT_PRIORITY_MIN = 32 as const;
export const AUDIO_AMBIENT_PRIORITY_MAX = 64 as const;

/** 09 §3.3, §5.5. Spatial defaults. */
export const DEFAULT_DISTANCE_MODEL = "inverse" as const;
export const DEFAULT_PANNING_MODEL = "equalpower" as const;
export const DEFAULT_REF_DISTANCE = 1 as const;
export const DEFAULT_MAX_DISTANCE = 100 as const;
export const DEFAULT_ROLLOFF = 1 as const;

/** 09 §3.3, §4.2. Rolloff upper bound. */
export const AUDIO_MAX_ROLLOFF = 10 as const;

/** 09 §5.3, §5.5. Per-frame gain smoothing time constant. */
export const AUDIO_GAIN_SMOOTHING_SECONDS = 0.01 as const;

/** 09 §5.4. Linear ramp before a stolen voice is reused. */
export const AUDIO_VOICE_STEAL_RAMP_MS = 5 as const;

/** 09 §5.7. One-shot scheduling lead. */
export const AUDIO_START_LEAD_SECONDS = 0.005 as const;

/** 09 §5.7. Stable anchor for a faded music start. */
export const AUDIO_MUSIC_FADE_ANCHOR_SECONDS = 0.02 as const;

/** 09 §5.7. Future scheduling clamp. */
export const AUDIO_MAX_SCHEDULE_AHEAD_SECONDS = 10 as const;

/** 09 §3.4. Music fade defaults and bounds. */
export const AUDIO_DEFAULT_MUSIC_FADE_MS = 0 as const;
export const AUDIO_MAX_MUSIC_FADE_MS = 10000 as const;

/** 09 §3.4, §5.6. Radio crossfade defaults and bounds. */
export const AUDIO_DEFAULT_RADIO_CROSSFADE_MS = 1500 as const;
export const AUDIO_MAX_RADIO_CROSSFADE_MS = 5000 as const;

/** 09 §5.5. M2 Doppler rate bounds. */
export const AUDIO_DOPPLER_MIN = 0.5 as const;
export const AUDIO_DOPPLER_MAX = 2 as const;

/** 09 §5.4. Stealing order; ties fall through to the next criterion. */
export const AUDIO_VOICE_STEALING_ORDER = [
  "free",
  "lowest-priority",
  "oldest",
  "lowest-index",
] as const;

/** 09 §3.7. Additive audio codes layered over core `EngineErrorCode`. */
export const AUDIO_ERROR_CODES = [
  "E_AUDIO_DEVICE",
  "E_AUDIO_DECODE",
  "E_AUDIO_FORMAT",
  "E_AUDIO_BUDGET",
] as const;
