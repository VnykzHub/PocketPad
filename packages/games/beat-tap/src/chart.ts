/**
 * Beat Tap chart pack format and validation (GAME-BT-DATA-01, GAME-BT-DATA-02;
 * FR-10.3, E11).
 *
 * Charts are data shipped beside the game and read through the host's static
 * game folder. The validator is hand-written and dependency-free, matching the
 * SDK's manifest/layout approach: a chart is untrusted input until it passes.
 *
 * Pack shape (JSON):
 *   { packVersion?: 1, id: string, type: "chart", license: string,
 *     items: [{ id, title, audio, bpm, offsetMs, durationMs,
 *               notes: [{ timeMs, lane }] }] }
 *
 * `license` is a required, non-empty SPDX expression or `self-made`. Beat Tap
 * ships only self-authored data; the shipped pack declares `CC0-1.0`. Notes are
 * ordered by `timeMs` and time is integer milliseconds from the chart start.
 */
import { LANE_COUNT } from "./config.js";

/** Notes per chart ceiling; keeps the per-song scan arrays bounded. */
export const MAX_CHART_NOTES = 8192;

/** Charts per pack ceiling. */
export const MAX_CHART_ITEMS = 32;

/** Longest chart accepted, 10 minutes. */
export const MAX_CHART_DURATION_MS = 600_000;

/** Audio-offset range; beyond ±5 s the chart is almost certainly wrong. */
export const MAX_CHART_OFFSET_MS = 5000;

const MIN_BPM = 1;
const MAX_BPM = 400;

export interface ChartNote {
  /** Integer milliseconds from the chart start. */
  readonly timeMs: number;
  /** Lane index, 0..LANE_COUNT-1. */
  readonly lane: number;
}

export interface ChartItem {
  readonly id: string;
  readonly title: string;
  /** Audio cue id registered with the host; silent when unknown. */
  readonly audio: string;
  /** Beats per minute; drives the visual beat pulse. */
  readonly bpm: number;
  /**
   * Audio/latency offset baked into the chart, milliseconds. Subtracted from
   * the song clock, exactly like a per-chart calibration.
   */
  readonly offsetMs: number;
  /** Song length in milliseconds, at least the last note time. */
  readonly durationMs: number;
  /** Ordered by `timeMs`; ties are allowed only across different lanes. */
  readonly notes: readonly ChartNote[];
}

export interface ChartPack {
  readonly packVersion?: 1;
  readonly id: string;
  readonly type: "chart";
  readonly license: string;
  readonly items: readonly ChartItem[];
}

export type ChartValidation =
  | { readonly ok: true; readonly pack: ChartPack }
  | { readonly ok: false; readonly errors: readonly string[] };

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= max;
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Validates an untrusted chart pack and returns every error in one pass. The
 * returned pack is the original object (additive fields preserved); the game
 * only reads the typed fields.
 */
export function validateChartPack(value: unknown): ChartValidation {
  if (!isRecord(value)) {
    return { ok: false, errors: ["chart pack: must be an object"] };
  }

  const errors: string[] = [];

  if (value.packVersion !== undefined && value.packVersion !== 1) {
    errors.push("packVersion: must be 1 when present");
  }
  if (!isNonEmptyString(value.id, 64)) {
    errors.push("id: must be 1..64 characters");
  }
  if (value.type !== "chart") {
    errors.push('type: must be "chart"');
  }
  if (!isNonEmptyString(value.license, 64)) {
    errors.push("license: must be 1..64 characters");
  }

  if (!Array.isArray(value.items)) {
    errors.push("items: must be an array");
  } else if (value.items.length < 1 || value.items.length > MAX_CHART_ITEMS) {
    errors.push(`items: must contain 1..${MAX_CHART_ITEMS} charts`);
  } else {
    validateItems(value.items, errors);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, pack: value as unknown as ChartPack };
}

function validateItems(items: unknown[], errors: string[]): void {
  const seenIds = new Set<string>();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const path = `items[${index}]`;
    if (!isRecord(item)) {
      errors.push(`${path}: must be an object`);
      continue;
    }
    if (!isNonEmptyString(item.id, 64)) {
      errors.push(`${path}.id: must be 1..64 characters`);
    } else if (seenIds.has(item.id)) {
      errors.push(`${path}.id: duplicate id "${item.id}"`);
    } else {
      seenIds.add(item.id);
    }
    if (!isNonEmptyString(item.title, 80)) {
      errors.push(`${path}.title: must be 1..80 characters`);
    }
    if (!isNonEmptyString(item.audio, 128)) {
      errors.push(`${path}.audio: must be 1..128 characters`);
    }
    if (!isFiniteNumber(item.bpm) || item.bpm < MIN_BPM || item.bpm > MAX_BPM) {
      errors.push(`${path}.bpm: must be a number ${MIN_BPM}..${MAX_BPM}`);
    }
    if (
      !isFiniteNumber(item.offsetMs) ||
      Math.abs(item.offsetMs) > MAX_CHART_OFFSET_MS
    ) {
      errors.push(`${path}.offsetMs: must be a number within ±${MAX_CHART_OFFSET_MS}`);
    }
    if (
      !isIntegerInRange(item.durationMs, 1, MAX_CHART_DURATION_MS)
    ) {
      errors.push(`${path}.durationMs: must be an integer 1..${MAX_CHART_DURATION_MS}`);
    }
    if (!Array.isArray(item.notes)) {
      errors.push(`${path}.notes: must be an array`);
      continue;
    }
    validateNotes(item.notes, path, item.durationMs, errors);
  }
}

function validateNotes(
  notes: unknown[],
  itemPath: string,
  rawDurationMs: unknown,
  errors: string[],
): void {
  const durationMs = isIntegerInRange(rawDurationMs, 1, MAX_CHART_DURATION_MS)
    ? rawDurationMs
    : MAX_CHART_DURATION_MS;
  if (notes.length < 1 || notes.length > MAX_CHART_NOTES) {
    errors.push(`${itemPath}.notes: must contain 1..${MAX_CHART_NOTES} notes`);
    return;
  }

  let previousTimeMs = -1;
  let previousLane = -1;
  for (let index = 0; index < notes.length; index += 1) {
    const note = notes[index];
    const path = `${itemPath}.notes[${index}]`;
    if (!isRecord(note)) {
      errors.push(`${path}: must be an object`);
      continue;
    }
    if (!isIntegerInRange(note.timeMs, 0, durationMs)) {
      errors.push(`${path}.timeMs: must be an integer 0..${durationMs}`);
      continue;
    }
    if (!isIntegerInRange(note.lane, 0, LANE_COUNT - 1)) {
      errors.push(`${path}.lane: must be an integer 0..${LANE_COUNT - 1}`);
      continue;
    }
    if (note.timeMs < previousTimeMs) {
      errors.push(`${path}.timeMs: notes must be ordered by time`);
    } else if (note.timeMs === previousTimeMs && note.lane === previousLane) {
      errors.push(`${path}: duplicate note at the same time and lane`);
    }
    previousTimeMs = note.timeMs;
    previousLane = note.lane;
  }
}

/** Finds a chart by id; null when absent. */
export function chartById(pack: ChartPack, chartId: string): ChartItem | null {
  for (let index = 0; index < pack.items.length; index += 1) {
    const item = pack.items[index];
    if (item !== undefined && item.id === chartId) {
      return item;
    }
  }
  return null;
}

/** First chart in the pack; the pack validator guarantees at least one. */
export function firstChart(pack: ChartPack): ChartItem {
  const item = pack.items[0];
  if (item === undefined) {
    throw new Error("Chart pack has no charts.");
  }
  return item;
}
