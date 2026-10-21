/* Generated from report.ts by experiments/shared/build.mjs. Do not edit directly. */
const REPORT_SCHEMA_VERSION = 1;
function formatReportValue(value) {
  if (value === null) return "null";
  if (value === void 0) return "completed";
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
    return json === void 0 ? String(value) : json;
  } catch {
    return String(value);
  }
}
function createReport(experiment, title, checks, ranAt, metadata) {
  const report = {
    schema: REPORT_SCHEMA_VERSION,
    experiment,
    title,
    ranAt,
    checks: checks.map((check) => ({ ...check }))
  };
  if (metadata !== void 0) {
    report.metadata = metadata;
  }
  return report;
}
function reportToJson(report) {
  return JSON.stringify(report, null, 2);
}
function formatReport(report) {
  const rows = [
    { id: "", label: "Experiment", status: "info", detail: report.experiment, durationMs: null },
    { id: "", label: "Title", status: "info", detail: report.title, durationMs: null },
    { id: "", label: "Ran at", status: "info", detail: report.ranAt, durationMs: null }
  ];
  if (report.metadata !== void 0) {
    for (const [key, value] of Object.entries(report.metadata)) {
      rows.push({
        id: "",
        label: `Metadata: ${key}`,
        status: "info",
        detail: formatReportValue(value),
        durationMs: null
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
      durationMs: check.durationMs
    });
  }
  return { rows, json: reportToJson(report) };
}
export {
  REPORT_SCHEMA_VERSION,
  createReport,
  formatReport,
  formatReportValue,
  reportToJson
};
