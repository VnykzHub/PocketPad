/**
 * Pure result formatting for experiment probe pages (D1-EXP-01).
 *
 * This module has no DOM, timer or network dependency, so the same code is
 * safe in a TV browser and in a Node test. `formatReport()` turns a probe
 * result object into rows for a readable table plus a deterministic JSON block
 * that the operator copies into `docs/RESULTS.md`.
 *
 * The result shape is intentionally small and stable: later probes (E5/E7/E8)
 * reuse it instead of inventing a new report format.
 */

/** Bumped only when the result shape changes in a way consumers must notice. */
export const REPORT_SCHEMA_VERSION = 1;

export type CheckStatus = "pass" | "fail";
export type RowStatus = CheckStatus | "info";

/** One check inside a probe run. `error` is null on success. */
export interface ProbeCheckReport {
  id: string;
  label: string;
  status: CheckStatus;
  durationMs: number;
  value: unknown;
  error: string | null;
}

/** The complete result object rendered and copied by a probe page. */
export interface ProbeReport {
  schema: number;
  experiment: string;
  title: string;
  /** ISO-8601 timestamp captured when the run starts. */
  ranAt: string;
  checks: ProbeCheckReport[];
  /** Optional device/condition fields; never PII. */
  metadata?: Record<string, unknown>;
}

/** One row of the human-readable table. */
export interface ReportRow {
  /** Stable check id; empty for report metadata rows. */
  id: string;
  label: string;
  status: RowStatus;
  detail: string;
  durationMs: number | null;
}

export interface FormattedReport {
  rows: ReportRow[];
  json: string;
}

/**
 * Renders one value for a table cell. Objects become compact JSON, arrays are
 * comma-joined, booleans read as yes/no, and errors keep their message.
 */
export function formatReportValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "completed";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (typeof value === "function") return "function";
  if (typeof value === "symbol") return value.toString();
  if (value instanceof Error) return value.message;
  if (Array.isArray(value)) {
    return value.map((entry) => formatReportValue(entry)).join(", ");
  }
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

/**
 * Builds the stable result object. Copying the checks array keeps the caller's
 * check list frozen for the lifetime of the report.
 */
export function createReport(
  experiment: string,
  title: string,
  checks: readonly ProbeCheckReport[],
  ranAt: string,
  metadata?: Record<string, unknown>,
): ProbeReport {
  const report: ProbeReport = {
    schema: REPORT_SCHEMA_VERSION,
    experiment,
    title,
    ranAt,
    checks: checks.map((check) => ({ ...check })),
  };
  if (metadata !== undefined) {
    report.metadata = metadata;
  }
  return report;
}

/** Deterministic JSON block for the Copy JSON button and `docs/RESULTS.md`. */
export function reportToJson(report: ProbeReport): string {
  return JSON.stringify(report, null, 2);
}

/**
 * Formats a report into table rows and its JSON block. Pure: the DOM writer in
 * `probe.ts` decides where the rows and JSON are displayed.
 */
export function formatReport(report: ProbeReport): FormattedReport {
  const rows: ReportRow[] = [
    { id: "", label: "Experiment", status: "info", detail: report.experiment, durationMs: null },
    { id: "", label: "Title", status: "info", detail: report.title, durationMs: null },
    { id: "", label: "Ran at", status: "info", detail: report.ranAt, durationMs: null },
  ];

  if (report.metadata !== undefined) {
    for (const [key, value] of Object.entries(report.metadata)) {
      rows.push({
        id: "",
        label: `Metadata: ${key}`,
        status: "info",
        detail: formatReportValue(value),
        durationMs: null,
      });
    }
  }

  for (const check of report.checks) {
    const detail = check.error !== null ? check.error : formatReportValue(check.value);
    rows.push({
      id: check.id,
      label: check.label,
      status: check.status,
      detail,
      durationMs: check.durationMs,
    });
  }

  return { rows, json: reportToJson(report) };
}
