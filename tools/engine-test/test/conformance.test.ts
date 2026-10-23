import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  ConformanceSuiteError,
  loadSuite,
  runConformance,
  type ConformanceImplementationMap,
} from "../src/conformance";
import type { ConformanceCase, ConformanceSuite } from "../src/schema";

// Shared-conformance cases carry ER-19-11; suite schema/format cases carry
// ER-19-01. Both rows are in docs/todos/TRACEABILITY.md (W0-CONTRACTS).
const SUITE_ID = "engine-core-contract";

function makeSuite(cases: readonly ConformanceCase[]): ConformanceSuite {
  return {
    formatVersion: 1,
    kind: "engine-conformance-suite",
    suiteId: SUITE_ID,
    cases,
  };
}

function makeCase(
  id: string,
  overrides: Partial<Pick<ConformanceCase, "kind" | "input" | "skip" | "reason">> = {},
): ConformanceCase {
  return { suiteId: SUITE_ID, id, kind: "render-contract", input: {}, ...overrides };
}

function rawSuite(cases: readonly unknown[]): Record<string, unknown> {
  return { formatVersion: 1, kind: "engine-conformance-suite", suiteId: SUITE_ID, cases };
}

function loadError(json: unknown): ConformanceSuiteError {
  try {
    loadSuite(json);
  } catch (error) {
    if (error instanceof ConformanceSuiteError) return error;
    throw error;
  }
  throw new Error("expected loadSuite to throw");
}

test("[ER-19-11] a passing case returns the §3.2 conformance summary", () => {
  const implementations: ConformanceImplementationMap = { "clear-color": () => true };
  const result = runConformance(makeSuite([makeCase("clear-color")]), implementations);

  expect(result).toEqual({
    suiteId: SUITE_ID,
    cases: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
    failures: [],
    pass: true,
  });
  expect(Object.keys(result).sort()).toEqual([
    "cases",
    "failed",
    "failures",
    "pass",
    "passed",
    "skipped",
    "suiteId",
  ]);
});

test("[ER-19-11] a failing case reports its exact case id and message", () => {
  const result = runConformance(makeSuite([makeCase("depth-range")]), {
    "depth-range": () => ({ pass: false, message: "depth range must be [0, 1]" }),
  });

  expect(result.failed).toBe(1);
  expect(result.passed).toBe(0);
  expect(result.pass).toBe(false);
  expect(result.failures).toEqual([
    { id: "depth-range", message: "depth range must be [0, 1]" },
  ]);
});

test("[ER-19-11] a missing implementation fails with E_CONFORMANCE_MISSING, never skips", () => {
  const result = runConformance(makeSuite([makeCase("not-registered")]), {});

  expect(result.failed).toBe(1);
  expect(result.skipped).toBe(0);
  expect(result.pass).toBe(false);
  const failure = result.failures[0];
  expect(failure?.id).toBe("not-registered");
  expect(failure?.message.startsWith("E_CONFORMANCE_MISSING")).toBe(true);
});

test("[ER-19-11] only an explicit skip with a reason is skipped, and it is not executed", () => {
  let executed = false;
  const observed: string[] = [];
  const testCase = makeCase("timestamp-query", {
    skip: true,
    reason: "timestamp queries are optional on this backend",
  });

  const result = runConformance(
    makeSuite([testCase]),
    {
      "timestamp-query": () => {
        executed = true;
        return true;
      },
    },
    {
      onCaseResult: (caseResult) => {
        observed.push(`${caseResult.status}:${caseResult.message ?? ""}`);
      },
    },
  );

  expect(executed).toBe(false);
  expect(result.skipped).toBe(1);
  expect(result.passed).toBe(0);
  expect(result.pass).toBe(true);
  expect(observed).toEqual(["skip:timestamp queries are optional on this backend"]);
});

test("[ER-19-11] a hand-built skip without a reason fails instead of counting as skipped", () => {
  const result = runConformance(makeSuite([makeCase("no-reason", { skip: true })]), {});

  expect(result.skipped).toBe(0);
  expect(result.failed).toBe(1);
  expect(result.pass).toBe(false);
  expect(result.failures[0]?.message.startsWith("E_CONFORMANCE_SKIP_REASON")).toBe(true);
});

test("[ER-19-11] a throwing implementation fails its case with a stable code", () => {
  const result = runConformance(makeSuite([makeCase("throws")]), {
    throws: () => {
      throw new Error("device lost");
    },
  });

  expect(result.failures).toEqual([
    { id: "throws", message: "E_CONFORMANCE_THREW: device lost" },
  ]);
});

test("[ER-19-11] cases run and report in declaration order across runs", () => {
  const suite = makeSuite([
    makeCase("z-last"),
    makeCase("a-first"),
    makeCase("m-middle"),
  ]);
  const implementations: ConformanceImplementationMap = {
    "z-last": () => false,
    "a-first": () => false,
    "m-middle": () => true,
  };

  const first = runConformance(suite, implementations);
  const second = runConformance(suite, implementations);

  expect(first).toEqual(second);
  expect(first.failures.map((failure) => failure.id)).toEqual(["z-last", "a-first"]);
});

test("[ER-19-01] loadSuite rejects an unknown formatVersion with a stable code", () => {
  const error = loadError({ ...makeSuite([makeCase("case-a")]), formatVersion: 2 });

  expect(error.code).toBe("E_CONFORMANCE_FORMAT_VERSION");
  expect(error.path).toBe("$.formatVersion");
});

test("[ER-19-01] loadSuite rejects duplicate case ids", () => {
  const error = loadError(makeSuite([makeCase("dup"), makeCase("dup")]));

  expect(error.code).toBe("E_CONFORMANCE_CASE_DUPLICATE");
  expect(error.path).toBe("$.cases[1].id");
});

test("[ER-19-01] loadSuite rejects an explicit skip without a reason", () => {
  const error = loadError(
    rawSuite([{ suiteId: SUITE_ID, id: "skip-no-reason", kind: "tick-order", input: {}, skip: true }]),
  );

  expect(error.code).toBe("E_CONFORMANCE_SKIP_REASON");
  expect(error.path).toBe("$.cases[0].reason");
});

test("[ER-19-01] loadSuite rejects an unknown case kind", () => {
  const error = loadError(
    rawSuite([{ suiteId: SUITE_ID, id: "bad-kind", kind: "pixel-perfect", input: {} }]),
  );

  expect(error.code).toBe("E_CONFORMANCE_CASE_KIND");
  expect(error.path).toBe("$.cases[0].kind");
});

test("[ER-19-01] loadSuite requires an input field even when the case has no data", () => {
  const error = loadError(
    rawSuite([{ suiteId: SUITE_ID, id: "no-input", kind: "tick-order" }]),
  );

  expect(error.code).toBe("E_CONFORMANCE_CASE_INPUT");
  expect(error.path).toBe("$.cases[0].input");
});

test("[ER-19-01] loadSuite rejects a non-object root and an empty case list", () => {
  expect(loadError([]).code).toBe("E_CONFORMANCE_JSON");
  expect(loadError(makeSuite([])).code).toBe("E_CONFORMANCE_CASES");
});

test("[ER-19-01] the shipped example suite validates and keeps declaration order", () => {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL("../conformance/example.suite.json", import.meta.url), "utf8"),
  );
  const suite = loadSuite(parsed);

  expect(suite.suiteId).toBe("engine-core-contract");
  expect(suite.cases.map((testCase) => testCase.id)).toEqual([
    "projection-depth-range-webgl",
    "quat-composition-order",
    "scene-destroy-twice",
  ]);
  expect(suite.cases.filter((testCase) => testCase.skip === true)).toHaveLength(1);
});
