/**
 * `radio-stations.json` validation (spec 09 §4.3).
 *
 * Limits: ≤ 16 KB; format version 1; ≤ 32 stations; ids match the documented
 * pattern and are unique; 1..64 tracks per station; every track id exists in
 * the asset manifest (manifest membership is checked by the caller, which
 * owns that registry). `loop` defaults to true.
 */

import type { RadioStation, RadioStationsDocument } from "../contracts/audio.js";
import { AudioValidationError } from "../errors.js";
import {
  AUDIO_MAX_STATIONS,
  AUDIO_MAX_TRACKS_PER_STATION,
  AUDIO_RADIO_MAX_BYTES,
  AUDIO_RADIO_VERSION,
  AUDIO_STATION_ID_PATTERN,
} from "../version.js";

export type RadioValidation =
  | { readonly ok: true; readonly value: RadioStationsDocument }
  | { readonly ok: false; readonly error: AudioValidationError };

const STATION_ID = new RegExp(AUDIO_STATION_ID_PATTERN);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateRadioDocument(input: unknown): RadioValidation {
  if (!isRecord(input)) {
    return {
      ok: false,
      error: new AudioValidationError("$", "radio document must be an object"),
    };
  }
  if (input.formatVersion !== AUDIO_RADIO_VERSION) {
    return {
      ok: false,
      error: new AudioValidationError(
        "formatVersion",
        `radio formatVersion must be ${AUDIO_RADIO_VERSION}`,
      ),
    };
  }
  const stationsInput = input.stations;
  if (!Array.isArray(stationsInput)) {
    return {
      ok: false,
      error: new AudioValidationError("stations", "stations must be an array"),
    };
  }
  if (stationsInput.length > AUDIO_MAX_STATIONS) {
    return {
      ok: false,
      error: new AudioValidationError(
        "stations",
        `at most ${AUDIO_MAX_STATIONS} stations`,
      ),
    };
  }

  const stations: RadioStation[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < stationsInput.length; index += 1) {
    const entry: unknown = stationsInput[index];
    const path = `stations[${index}]`;
    if (!isRecord(entry)) {
      return {
        ok: false,
        error: new AudioValidationError(path, "station must be an object"),
      };
    }
    const id = entry.id;
    if (typeof id !== "string" || !STATION_ID.test(id)) {
      return {
        ok: false,
        error: new AudioValidationError(
          `${path}.id`,
          "station id must match ^[a-z0-9][a-z0-9-]{0,31}$",
        ),
      };
    }
    if (seen.has(id)) {
      return {
        ok: false,
        error: new AudioValidationError(`${path}.id`, "station ids must be unique"),
      };
    }
    seen.add(id);

    const tracks = entry.tracks;
    if (!Array.isArray(tracks)) {
      return {
        ok: false,
        error: new AudioValidationError(`${path}.tracks`, "tracks must be an array"),
      };
    }
    if (tracks.length < 1 || tracks.length > AUDIO_MAX_TRACKS_PER_STATION) {
      return {
        ok: false,
        error: new AudioValidationError(
          `${path}.tracks`,
          `tracks must contain 1..${AUDIO_MAX_TRACKS_PER_STATION} ids`,
        ),
      };
    }
    const trackIds: string[] = [];
    for (let trackIndex = 0; trackIndex < tracks.length; trackIndex += 1) {
      const track: unknown = tracks[trackIndex];
      if (typeof track !== "string" || track.length === 0) {
        return {
          ok: false,
          error: new AudioValidationError(
            `${path}.tracks[${trackIndex}]`,
            "track must be a non-empty asset id",
          ),
        };
      }
      trackIds.push(track);
    }

    const loopInput = entry.loop;
    if (loopInput !== undefined && typeof loopInput !== "boolean") {
      return {
        ok: false,
        error: new AudioValidationError(`${path}.loop`, "loop must be a boolean"),
      };
    }

    stations.push({
      id,
      tracks: trackIds,
      loop: loopInput === undefined ? true : loopInput,
    });
  }

  return {
    ok: true,
    value: { formatVersion: AUDIO_RADIO_VERSION, stations },
  };
}

/** Parse + size-check a UTF-8 `radio-stations.json` document. */
export function parseRadioDocument(text: string): RadioValidation {
  if (new TextEncoder().encode(text).byteLength > AUDIO_RADIO_MAX_BYTES) {
    return {
      ok: false,
      error: new AudioValidationError("$", "radio-stations.json exceeds 16 KB"),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return {
      ok: false,
      error: new AudioValidationError("$", "radio-stations.json is not valid JSON"),
    };
  }
  return validateRadioDocument(parsed);
}
