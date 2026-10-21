import { describe, expect, it } from "vitest";
import {
  createReport,
  formatReport,
  formatReportValue,
  reportToJson,
  REPORT_SCHEMA_VERSION,
} from "../report.js";
import type { ProbeCheckReport, ProbeReport } from "../report.js";

const checks: ProbeCheckReport[] = [
  {
    id: "webgl2",
    label: "WebGL2",
    status: "pass",
    durationMs: 1.5,
    value: { supported: true, maxTextureSize: 8192 },
    error: null,
  },
  {
    id: "binary-ws",
    label: "Binary WebSocket",
    status: "fail",
    durationMs: 2,
    value: null,
    error: "round-trip timed out",
  },
];

describe("[E1] pure probe report helper", () => {
  it("[E1] formats a result object into readable table rows and a JSON block", () => {
    const report = createReport(
      "E1",
      "TV browser capabilities",
      checks,
      "2026-10-21T00:00:00.000Z",
      { device: "synthetic" },
    );

    const formatted = formatReport(report);
    // Experiment, Title, Ran at, one metadata row and two checks.
    expect(formatted.rows).toHaveLength(6);

    const webglRow = formatted.rows.find((row) => row.id === "webgl2");
    expect(webglRow?.status).toBe("pass");
    expect(webglRow?.detail).toContain('"maxTextureSize":8192');

    const wsRow = formatted.rows.find((row) => row.id === "binary-ws");
    expect(wsRow?.status).toBe("fail");
    expect(wsRow?.detail).toBe("round-trip timed out");

    const metadataRow = formatted.rows.find((row) => row.label === "Metadata: device");
    expect(metadataRow?.detail).toBe("synthetic");

    const parsed = JSON.parse(formatted.json) as ProbeReport;
    expect(parsed.schema).toBe(REPORT_SCHEMA_VERSION);
    expect(parsed.experiment).toBe("E1");
    expect(parsed.ranAt).toBe("2026-10-21T00:00:00.000Z");
    expect(parsed.checks).toHaveLength(2);
    expect(parsed.metadata?.device).toBe("synthetic");
  });

  it("[E1, SR-7] produces the JSON locally with no network dependency", () => {
    const report = createReport("E1", "local", checks, "2026-10-21T00:00:00.000Z");
    const json = reportToJson(report);
    expect(JSON.parse(json)).toEqual(report);
    expect(json).toBe(formatReport(report).json);
  });

  it("[E1] renders scalar and compound values for a table cell", () => {
    expect(formatReportValue(true)).toBe("yes");
    expect(formatReportValue(false)).toBe("no");
    expect(formatReportValue(null)).toBe("null");
    expect(formatReportValue(undefined)).toBe("completed");
    expect(formatReportValue(42)).toBe("42");
    expect(formatReportValue("text")).toBe("text");
    expect(formatReportValue([1, "a", false])).toBe("1, a, no");
    expect(formatReportValue({ alpha: 1 })).toBe('{"alpha":1}');
    expect(formatReportValue(new Error("boom"))).toBe("boom");
  });
});
