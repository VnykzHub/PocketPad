// @req ER-09-15 — mix/radio config validation (spec 09 §4.2, §4.3).
/**
 * Config validation — spec 09 §4.2 (`audio-mix.json`) and §4.3
 * (`radio-stations.json`).
 *
 * A malformed document fails with `E_AUDIO_FORMAT` and a JSON path; it never
 * silently falls back to defaults. Unknown fields are ignored, so a newer
 * document still loads on an older engine.
 *
 * Acceptance row: ER-09-15.
 */

import { describe, expect, test } from "vitest";
import { parseMixConfig, validateMixConfig } from "../src/config/mix.js";
import { parseRadioDocument, validateRadioDocument } from "../src/config/radio.js";
import type { AudioValidationError } from "../src/errors.js";

const VALID_MIX = {
  formatVersion: 1,
  masterVolume: 0.8,
  buses: { music: 0.6, sfx: 1, ambient: 0.5, voice: 1, ui: 0.9 },
  sfxVoices: 8,
  spatialVoices: 16,
  defaults: {
    distanceModel: "inverse",
    panningModel: "equalpower",
    refDistance: 1,
    maxDistance: 100,
    rolloff: 1,
  },
} as const;

const VALID_RADIO = {
  formatVersion: 1,
  stations: [{ id: "vice-fm", tracks: ["track-a", "track-b"] }],
} as const;

function mixError(input: unknown): AudioValidationError {
  const result = validateMixConfig(input);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a validation failure");
  return result.error;
}

function radioError(input: unknown): AudioValidationError {
  const result = validateRadioDocument(input);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a validation failure");
  return result.error;
}

function withBudget<T extends object>(document: T, bytes: number): string {
  const base = JSON.stringify({ ...document, pad: "" });
  const padLength = bytes - base.length;
  return JSON.stringify({ ...document, pad: "x".repeat(padLength) });
}

describe("audio-mix.json", () => {
  test("[09 §4] a complete document validates and keeps every field", () => {
    const result = validateMixConfig(VALID_MIX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(VALID_MIX);
  });

  test("[09 §4] unknown fields are ignored, including inside buses", () => {
    const result = validateMixConfig({
      ...VALID_MIX,
      futureFlag: true,
      buses: { ...VALID_MIX.buses, podcast: 0.3 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value.buses).sort()).toEqual([
      "ambient",
      "music",
      "sfx",
      "ui",
      "voice",
    ]);
    expect("futureFlag" in result.value).toBe(false);
  });

  test("[09 §4] formatVersion must be 1", () => {
    const error = mixError({ ...VALID_MIX, formatVersion: 2 });
    expect(error.code).toBe("E_AUDIO_FORMAT");
    expect(error.path).toBe("formatVersion");
  });

  test("[09 §4] every volume must be finite in 0..1", () => {
    for (const volume of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY, "0.5"]) {
      const error = mixError({ ...VALID_MIX, masterVolume: volume });
      expect(error.path).toBe("masterVolume");
    }
    const busError = mixError({
      ...VALID_MIX,
      buses: { ...VALID_MIX.buses, music: 2 },
    });
    expect(busError.path).toBe("buses.music");
    const missing = mixError({
      ...VALID_MIX,
      buses: { music: 1, sfx: 1, ambient: 1, voice: 1 },
    });
    expect(missing.path).toBe("buses.ui");
  });

  test("[09 §4] voice counts are integers in 1..32", () => {
    for (const count of [0, 33, 2.5, Number.NaN, "8"]) {
      expect(mixError({ ...VALID_MIX, sfxVoices: count }).path).toBe("sfxVoices");
      expect(mixError({ ...VALID_MIX, spatialVoices: count }).path).toBe(
        "spatialVoices",
      );
    }
    expect(validateMixConfig({ ...VALID_MIX, sfxVoices: 1 }).ok).toBe(true);
    expect(validateMixConfig({ ...VALID_MIX, sfxVoices: 32 }).ok).toBe(true);
  });

  test("[09 §4] distance defaults are ordered and bounded", () => {
    const badModel = mixError({
      ...VALID_MIX,
      defaults: { ...VALID_MIX.defaults, distanceModel: "doppler" },
    });
    expect(badModel.path).toBe("defaults.distanceModel");
    const badPanning = mixError({
      ...VALID_MIX,
      defaults: { ...VALID_MIX.defaults, panningModel: "binaural" },
    });
    expect(badPanning.path).toBe("defaults.panningModel");
    expect(
      mixError({ ...VALID_MIX, defaults: { ...VALID_MIX.defaults, refDistance: 0 } })
        .path,
    ).toBe("defaults.refDistance");
    expect(
      mixError({
        ...VALID_MIX,
        defaults: { ...VALID_MIX.defaults, maxDistance: 1 },
      }).path,
    ).toBe("defaults.maxDistance");
    expect(
      mixError({ ...VALID_MIX, defaults: { ...VALID_MIX.defaults, rolloff: 11 } })
        .path,
    ).toBe("defaults.rolloff");
    expect(
      validateMixConfig({
        ...VALID_MIX,
        defaults: { ...VALID_MIX.defaults, rolloff: 0 },
      }).ok,
    ).toBe(true);
  });

  test("[09 §4] a non-object document fails at the root", () => {
    expect(mixError(null).path).toBe("$");
    expect(mixError([]).path).toBe("$");
  });

  test("[09 §4] parsing rejects invalid JSON", () => {
    const result = parseMixConfig("{not json");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.path).toBe("$");
    expect(result.error.message).toContain("valid JSON");
  });

  test("[09 §4] the 4 KB cap is exact", () => {
    const atLimit = parseMixConfig(withBudget(VALID_MIX, 4096));
    expect(atLimit.ok).toBe(true);
    const over = parseMixConfig(withBudget(VALID_MIX, 4097));
    expect(over.ok).toBe(false);
    if (over.ok) return;
    expect(over.error.path).toBe("$");
    expect(over.error.message).toContain("4 KB");
  });
});

describe("radio-stations.json", () => {
  test("[09 §4] a station without loop defaults to true", () => {
    const result = validateRadioDocument(VALID_RADIO);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stations).toEqual([
      { id: "vice-fm", tracks: ["track-a", "track-b"], loop: true },
    ]);
  });

  test("[09 §4] loop false is preserved", () => {
    const result = validateRadioDocument({
      formatVersion: 1,
      stations: [{ id: "vice-fm", tracks: ["a"], loop: false }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stations[0]?.loop).toBe(false);
  });

  test("[09 §4] formatVersion and station count are capped", () => {
    expect(radioError({ formatVersion: 2, stations: [] }).path).toBe("formatVersion");
    const tooMany = Array.from({ length: 33 }, (_, index) => ({
      id: `station-${index}`,
      tracks: ["a"],
    }));
    expect(radioError({ formatVersion: 1, stations: tooMany }).path).toBe("stations");
    const atLimit = Array.from({ length: 32 }, (_, index) => ({
      id: `station-${index}`,
      tracks: ["a"],
    }));
    expect(validateRadioDocument({ formatVersion: 1, stations: atLimit }).ok).toBe(true);
  });

  test("[09 §4] station ids follow the documented pattern", () => {
    for (const id of ["Vice-FM", "-vice", "vice_fm", "vice fm", "", "a".repeat(33)]) {
      expect(
        radioError({ formatVersion: 1, stations: [{ id, tracks: ["a"] }] }).path,
      ).toBe("stations[0].id");
    }
    expect(
      validateRadioDocument({
        formatVersion: 1,
        stations: [{ id: "a", tracks: ["a"] }, { id: "a".repeat(32), tracks: ["a"] }],
      }).ok,
    ).toBe(true);
  });

  test("[09 §4] duplicate station ids are rejected", () => {
    const error = radioError({
      formatVersion: 1,
      stations: [
        { id: "vice-fm", tracks: ["a"] },
        { id: "vice-fm", tracks: ["b"] },
      ],
    });
    expect(error.path).toBe("stations[1].id");
    expect(error.message).toContain("unique");
  });

  test("[09 §4] each station has 1..64 tracks", () => {
    expect(
      radioError({ formatVersion: 1, stations: [{ id: "a", tracks: [] }] }).path,
    ).toBe("stations[0].tracks");
    const tooMany = Array.from({ length: 65 }, (_, index) => `track-${index}`);
    expect(
      radioError({ formatVersion: 1, stations: [{ id: "a", tracks: tooMany }] }).path,
    ).toBe("stations[0].tracks");
    const atLimit = Array.from({ length: 64 }, (_, index) => `track-${index}`);
    expect(
      validateRadioDocument({ formatVersion: 1, stations: [{ id: "a", tracks: atLimit }] })
        .ok,
    ).toBe(true);
  });

  test("[09 §4] track ids are non-empty strings", () => {
    expect(
      radioError({ formatVersion: 1, stations: [{ id: "a", tracks: [""] }] }).path,
    ).toBe("stations[0].tracks[0]");
    expect(
      radioError({ formatVersion: 1, stations: [{ id: "a", tracks: [7] }] }).path,
    ).toBe("stations[0].tracks[0]");
  });

  test("[09 §4] loop must be a boolean when present", () => {
    expect(
      radioError({
        formatVersion: 1,
        stations: [{ id: "a", tracks: ["a"], loop: "yes" }],
      }).path,
    ).toBe("stations[0].loop");
  });

  test("[09 §4] parsing rejects invalid JSON and documents over 16 KB", () => {
    const invalid = parseRadioDocument("{");
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(invalid.error.message).toContain("valid JSON");

    const atLimit = parseRadioDocument(withBudget(VALID_RADIO, 16384));
    expect(atLimit.ok).toBe(true);
    const over = parseRadioDocument(withBudget(VALID_RADIO, 16385));
    expect(over.ok).toBe(false);
    if (over.ok) return;
    expect(over.error.message).toContain("16 KB");
  });
});
