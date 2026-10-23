/**
 * `audio-mix.json` validation (spec 09 §4.2).
 *
 * Limits: UTF-8 JSON ≤ 4 KB; `formatVersion` must be 1; every volume finite
 * in 0..1; voice counts integers 1..32; `refDistance > 0`;
 * `maxDistance > refDistance`; `rolloff` in 0..10. Unknown fields are
 * ignored. A malformed document fails with `E_AUDIO_FORMAT` — never a silent
 * fallback to defaults.
 */

import type {
  AudioBusName,
  AudioMixConfig,
  DistanceModel,
  PanningModel,
} from "../contracts/audio.js";
import { AudioValidationError } from "../errors.js";
import {
  AUDIO_BUS_NAMES,
  AUDIO_MAX_ROLLOFF,
  AUDIO_MAX_VOICES,
  AUDIO_MIX_MAX_BYTES,
  AUDIO_MIX_VERSION,
  AUDIO_MIN_VOICES,
} from "../version.js";

export type MixValidation =
  | { readonly ok: true; readonly value: AudioMixConfig }
  | { readonly ok: false; readonly error: AudioValidationError };

const DISTANCE_MODELS: readonly DistanceModel[] = [
  "inverse",
  "linear",
  "exponential",
];

const PANNING_MODELS: readonly PanningModel[] = ["equalpower", "HRTF"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVolume(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
  );
}

function isVoiceCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= AUDIO_MIN_VOICES &&
    value <= AUDIO_MAX_VOICES
  );
}

export function validateMixConfig(input: unknown): MixValidation {
  if (!isRecord(input)) {
    return {
      ok: false,
      error: new AudioValidationError("$", "mix must be an object"),
    };
  }
  if (input.formatVersion !== AUDIO_MIX_VERSION) {
    return {
      ok: false,
      error: new AudioValidationError(
        "formatVersion",
        `mix formatVersion must be ${AUDIO_MIX_VERSION}`,
      ),
    };
  }
  if (!isVolume(input.masterVolume)) {
    return {
      ok: false,
      error: new AudioValidationError(
        "masterVolume",
        "masterVolume must be finite in 0..1",
      ),
    };
  }

  const busesInput = input.buses;
  if (!isRecord(busesInput)) {
    return {
      ok: false,
      error: new AudioValidationError("buses", "buses must be an object"),
    };
  }
  const buses = {} as Record<AudioBusName, number>;
  for (const name of AUDIO_BUS_NAMES) {
    const volume = busesInput[name];
    if (!isVolume(volume)) {
      return {
        ok: false,
        error: new AudioValidationError(
          `buses.${name}`,
          `buses.${name} must be finite in 0..1`,
        ),
      };
    }
    buses[name] = volume;
  }

  if (!isVoiceCount(input.sfxVoices)) {
    return {
      ok: false,
      error: new AudioValidationError(
        "sfxVoices",
        `sfxVoices must be an integer in ${AUDIO_MIN_VOICES}..${AUDIO_MAX_VOICES}`,
      ),
    };
  }
  if (!isVoiceCount(input.spatialVoices)) {
    return {
      ok: false,
      error: new AudioValidationError(
        "spatialVoices",
        `spatialVoices must be an integer in ${AUDIO_MIN_VOICES}..${AUDIO_MAX_VOICES}`,
      ),
    };
  }

  const defaultsInput = input.defaults;
  if (!isRecord(defaultsInput)) {
    return {
      ok: false,
      error: new AudioValidationError("defaults", "defaults must be an object"),
    };
  }
  const distanceModel = defaultsInput.distanceModel;
  if (!DISTANCE_MODELS.includes(distanceModel as DistanceModel)) {
    return {
      ok: false,
      error: new AudioValidationError(
        "defaults.distanceModel",
        "defaults.distanceModel must be inverse, linear or exponential",
      ),
    };
  }
  const panningModel = defaultsInput.panningModel;
  if (!PANNING_MODELS.includes(panningModel as PanningModel)) {
    return {
      ok: false,
      error: new AudioValidationError(
        "defaults.panningModel",
        "defaults.panningModel must be equalpower or HRTF",
      ),
    };
  }

  const refDistance = defaultsInput.refDistance;
  if (
    typeof refDistance !== "number" ||
    !Number.isFinite(refDistance) ||
    refDistance <= 0
  ) {
    return {
      ok: false,
      error: new AudioValidationError(
        "defaults.refDistance",
        "defaults.refDistance must be a finite number > 0",
      ),
    };
  }

  const maxDistance = defaultsInput.maxDistance;
  if (
    typeof maxDistance !== "number" ||
    !Number.isFinite(maxDistance) ||
    maxDistance <= refDistance
  ) {
    return {
      ok: false,
      error: new AudioValidationError(
        "defaults.maxDistance",
        "defaults.maxDistance must be finite and > refDistance",
      ),
    };
  }

  const rolloff = defaultsInput.rolloff;
  if (
    typeof rolloff !== "number" ||
    !Number.isFinite(rolloff) ||
    rolloff < 0 ||
    rolloff > AUDIO_MAX_ROLLOFF
  ) {
    return {
      ok: false,
      error: new AudioValidationError(
        "defaults.rolloff",
        `defaults.rolloff must be finite in 0..${AUDIO_MAX_ROLLOFF}`,
      ),
    };
  }

  const value: AudioMixConfig = {
    formatVersion: AUDIO_MIX_VERSION,
    masterVolume: input.masterVolume,
    buses,
    sfxVoices: input.sfxVoices,
    spatialVoices: input.spatialVoices,
    defaults: {
      distanceModel: distanceModel as DistanceModel,
      panningModel: panningModel as PanningModel,
      refDistance,
      maxDistance,
      rolloff,
    },
  };
  return { ok: true, value };
}

/** Parse + size-check a UTF-8 `audio-mix.json` document. */
export function parseMixConfig(text: string): MixValidation {
  if (new TextEncoder().encode(text).byteLength > AUDIO_MIX_MAX_BYTES) {
    return {
      ok: false,
      error: new AudioValidationError("$", "audio-mix.json exceeds 4 KB"),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return {
      ok: false,
      error: new AudioValidationError("$", "audio-mix.json is not valid JSON"),
    };
  }
  return validateMixConfig(parsed);
}
