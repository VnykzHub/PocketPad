/**
 * Latency log analyzer (D3-TOOL-01, PR-11.1, FR-7.13).
 *
 * Input is the JSON log the E5 page and the live harness both produce: one
 * record per tap with timestamps on a single monotonic clock (milliseconds).
 *
 *   { touchMs, encodeMs?, hostReceiveMs, hostPaintMs? }
 *
 * `touchMs`        tap time (touchstart, or the bot's scheduled press)
 * `encodeMs`       Input frame with the press edge written to the socket
 * `hostReceiveMs`  InputFwd carrying that edge reached the host
 * `hostPaintMs`    first host frame painted after receipt (browser only)
 *
 * Every leg is summarised on its own. Display lag (canvas-to-photon) is never
 * folded into these numbers: it needs a camera or photodiode and is reported
 * as a separate, PENDING field (FR-7.13). P5's production latency gate reuses
 * this format, so do not rename fields.
 */

export const LATENCY_LOG_SCHEMA_VERSION = 1;

/** G2: input-to-canvas p95 must be under 25 ms on LAN dev. */
export const LAN_P95_BUDGET_MS = 25;

export interface LatencySample {
  touchMs: number;
  encodeMs?: number | null;
  hostReceiveMs: number;
  hostPaintMs?: number | null;
}

export interface LegSummary {
  count: number;
  p50Ms: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
}

export type LegName =
  | "tapToEncode"
  | "packetToHost"
  | "inputAge"
  | "receiveToPaint"
  | "inputToCanvas";

type StampName = "touchMs" | "encodeMs" | "hostReceiveMs" | "hostPaintMs";

/** Which timestamps each leg subtracts (end - start). */
export const LEG_DEFINITIONS: Readonly<Record<LegName, readonly [StampName, StampName]>> =
  Object.freeze({
    tapToEncode: ["touchMs", "encodeMs"],
    packetToHost: ["encodeMs", "hostReceiveMs"],
    inputAge: ["touchMs", "hostReceiveMs"],
    receiveToPaint: ["hostReceiveMs", "hostPaintMs"],
    inputToCanvas: ["touchMs", "hostPaintMs"],
  });

const LEG_ORDER: readonly LegName[] = [
  "tapToEncode",
  "packetToHost",
  "inputAge",
  "receiveToPaint",
  "inputToCanvas",
];

export interface DisplayLagField {
  /** Always PENDING from software logs: needs a camera or photodiode (E6). */
  status: "PENDING";
  valueMs: null;
  note: string;
}

export interface LatencyReport {
  schema: number;
  sampleCount: number;
  /** Samples dropped because a timestamp was missing, non-finite or out of order. */
  rejected: number;
  legs: Partial<Record<LegName, LegSummary>>;
  /** The leg the G2 budget is judged on: inputToCanvas when painted, else inputAge. */
  gatedLeg: LegName | null;
  budgetMs: number;
  pass: boolean | null;
  displayLag: DisplayLagField;
}

export class LatencyLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LatencyLogError";
  }
}

/** Nearest-rank percentile; `null` for an empty list. */
export function percentile(values: readonly number[], percent: number): number | null {
  if (!(percent > 0 && percent <= 100)) {
    throw new RangeError(`percentile must be in (0, 100], got ${percent}`);
  }
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((percent / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? null;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function summarize(values: readonly number[]): LegSummary | null {
  if (values.length === 0) return null;
  let sum = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    sum += value;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return {
    count: values.length,
    p50Ms: round3(percentile(values, 50) ?? 0),
    p95Ms: round3(percentile(values, 95) ?? 0),
    minMs: round3(min),
    maxMs: round3(max),
    meanMs: round3(sum / values.length),
  };
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function stamp(sample: LatencySample, name: StampName): number | null {
  const value = sample[name];
  return finite(value) ? value : null;
}

/** A sample is usable when its required stamps exist and never run backwards. */
function sampleIsValid(sample: LatencySample): boolean {
  if (!finite(sample.touchMs) || !finite(sample.hostReceiveMs)) return false;
  for (const optional of [sample.encodeMs, sample.hostPaintMs]) {
    if (optional !== undefined && optional !== null && !finite(optional)) return false;
  }
  const chain: number[] = [];
  for (const name of ["touchMs", "encodeMs", "hostReceiveMs", "hostPaintMs"] as const) {
    const value = stamp(sample, name);
    if (value !== null) chain.push(value);
  }
  for (let index = 1; index < chain.length; index += 1) {
    if ((chain[index] ?? 0) < (chain[index - 1] ?? 0)) return false;
  }
  return true;
}

export function analyzeSamples(
  samples: readonly LatencySample[],
  budgetMs: number = LAN_P95_BUDGET_MS,
): LatencyReport {
  const valid = samples.filter(sampleIsValid);
  const legs: Partial<Record<LegName, LegSummary>> = {};
  for (const leg of LEG_ORDER) {
    const [from, to] = LEG_DEFINITIONS[leg];
    const values: number[] = [];
    for (const sample of valid) {
      const start = stamp(sample, from);
      const end = stamp(sample, to);
      if (start !== null && end !== null) values.push(end - start);
    }
    const summary = summarize(values);
    if (summary !== null) legs[leg] = summary;
  }
  const gatedLeg: LegName | null =
    legs.inputToCanvas !== undefined
      ? "inputToCanvas"
      : legs.inputAge !== undefined
        ? "inputAge"
        : null;
  const gated = gatedLeg === null ? undefined : legs[gatedLeg];
  return {
    schema: LATENCY_LOG_SCHEMA_VERSION,
    sampleCount: valid.length,
    rejected: samples.length - valid.length,
    legs,
    gatedLeg,
    budgetMs,
    pass: gated === undefined ? null : gated.p95Ms < budgetMs,
    displayLag: {
      status: "PENDING",
      valueMs: null,
      note: "Canvas-to-photon display lag is measured separately with a 240 fps camera or photodiode (E6); it is not part of these software legs.",
    },
  };
}

/**
 * Parses an exported log: either a bare sample array or an object with a
 * `samples` array (the shape `runLiveLatency` and the E5 page write).
 */
export function parseLatencyLog(text: string): LatencySample[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new LatencyLogError(`log is not valid JSON: ${(error as Error).message}`);
  }
  let list: unknown[] | null = null;
  if (Array.isArray(parsed)) {
    list = parsed;
  } else if (typeof parsed === "object" && parsed !== null) {
    const samples = (parsed as { samples?: unknown }).samples;
    if (Array.isArray(samples)) list = samples;
  }
  if (list === null) {
    throw new LatencyLogError("log must be an array of samples or an object with a `samples` array");
  }
  return list.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new LatencyLogError(`sample ${index} is not an object`);
    }
    const record = entry as Record<string, unknown>;
    if (!finite(record.touchMs) || !finite(record.hostReceiveMs)) {
      throw new LatencyLogError(`sample ${index} needs numeric touchMs and hostReceiveMs`);
    }
    const sample: LatencySample = { touchMs: record.touchMs, hostReceiveMs: record.hostReceiveMs };
    if (finite(record.encodeMs)) sample.encodeMs = record.encodeMs;
    if (finite(record.hostPaintMs)) sample.hostPaintMs = record.hostPaintMs;
    return sample;
  });
}

/** Plain-text table for the terminal; one row per measured leg. */
export function formatReportTable(report: LatencyReport): string {
  const header = ["leg", "n", "p50 ms", "p95 ms", "min ms", "max ms"];
  const rows: string[][] = [header];
  for (const leg of LEG_ORDER) {
    const summary = report.legs[leg];
    if (summary === undefined) continue;
    rows.push([
      leg,
      String(summary.count),
      summary.p50Ms.toFixed(2),
      summary.p95Ms.toFixed(2),
      summary.minMs.toFixed(2),
      summary.maxMs.toFixed(2),
    ]);
  }
  rows.push(["displayLag", "-", report.displayLag.status, "", "", ""]);
  const widths = header.map((_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? "").length)),
  );
  const lines = rows.map((row) =>
    row
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd(),
  );
  const verdict =
    report.pass === null
      ? "no gated leg measured"
      : `${report.gatedLeg ?? "?"} p95 ${report.pass ? "<" : ">="} ${report.budgetMs} ms: ${report.pass ? "PASS" : "FAIL"}`;
  return `${lines.join("\n")}\n${verdict} (samples=${report.sampleCount}, rejected=${report.rejected})`;
}
