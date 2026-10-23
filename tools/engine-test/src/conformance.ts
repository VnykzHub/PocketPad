/**
 * Conformance-suite loader and runner
 * (docs/engine/19-testing-benchmarks.md §3.2, §5.9).
 *
 * The runner is deliberately Node-only and synchronous: an implementation is
 * a named function supplied by the caller, so no browser, GPU or Chrome is
 * needed to prove a contract. A missing implementation fails its case with
 * `E_CONFORMANCE_MISSING`; only an explicit `skip: true` with a reason is
 * counted as skipped.
 *
 * Cases run and are reported in declaration order. The returned object is the
 * §3.2 ConformanceSummary shape (`ConformanceResult`).
 */
import {
  CONFORMANCE_SUITE_FORMAT_VERSION,
  CONFORMANCE_SUITE_KIND,
  type ConformanceCase,
  type ConformanceCaseKind,
  type ConformanceFailure,
  type ConformanceResult,
  type ConformanceSuite,
} from "./schema.js";

/** Stable validation failure codes. Never renumber or reuse a code. */
export type ConformanceSuiteErrorCode =
  | "E_CONFORMANCE_JSON"
  | "E_CONFORMANCE_FORMAT_VERSION"
  | "E_CONFORMANCE_KIND"
  | "E_CONFORMANCE_SUITE_ID"
  | "E_CONFORMANCE_CASES"
  | "E_CONFORMANCE_CASE"
  | "E_CONFORMANCE_CASE_SUITE_ID"
  | "E_CONFORMANCE_CASE_ID"
  | "E_CONFORMANCE_CASE_KIND"
  | "E_CONFORMANCE_CASE_INPUT"
  | "E_CONFORMANCE_CASE_DUPLICATE"
  | "E_CONFORMANCE_SKIP_REASON";

/** Invalid suite data. `path` is a JSON path such as `$.cases[1].kind`. */
export class ConformanceSuiteError extends Error {
  readonly code: ConformanceSuiteErrorCode;
  readonly path: string;

  constructor(code: ConformanceSuiteErrorCode, path: string, detail: string) {
    super(`${code} at ${path}: ${detail}`);
    this.name = "ConformanceSuiteError";
    this.code = code;
    this.path = path;
  }
}

/** `^[a-z0-9][a-z0-9-]{0,63}$` for suite and case ids. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const CASE_KINDS: ReadonlySet<string> = new Set<ConformanceCaseKind>([
  "math-projection",
  "math-quat-order",
  "scene-lifecycle",
  "tick-order",
  "render-contract",
]);

function suiteError(code: ConformanceSuiteErrorCode, path: string, detail: string): never {
  throw new ConformanceSuiteError(code, path, detail);
}

function isCaseKind(value: string): value is ConformanceCaseKind {
  return CASE_KINDS.has(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * True for a finite JSON value: null, boolean, finite number, string, array
 * or plain object, with no cycles. `undefined`, functions, symbols, bigint,
 * NaN/Infinity, Date, Map and class instances are rejected.
 */
function isJsonValue(value: unknown, stack: Set<object> = new Set()): boolean {
  if (value === null) return true;

  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      break;
    default:
      return false;
  }

  const object = value as object;
  if (stack.has(object)) return false;
  stack.add(object);

  let valid: boolean;
  if (Array.isArray(value)) {
    valid = value.every((entry) => isJsonValue(entry, stack));
  } else if (isPlainObject(value)) {
    valid = Object.values(value).every((entry) => isJsonValue(entry, stack));
  } else {
    valid = false;
  }

  stack.delete(object);
  return valid;
}

/**
 * Validates a parsed conformance suite. Unknown fields are ignored so a suite
 * can gain optional fields without a version bump; known fields are strict.
 *
 * @throws ConformanceSuiteError with a stable `code` and JSON `path`.
 */
export function loadSuite(json: unknown): ConformanceSuite {
  if (!isPlainObject(json)) {
    suiteError("E_CONFORMANCE_JSON", "$", "suite must be a JSON object");
  }

  if (json["formatVersion"] !== CONFORMANCE_SUITE_FORMAT_VERSION) {
    suiteError(
      "E_CONFORMANCE_FORMAT_VERSION",
      "$.formatVersion",
      `expected ${CONFORMANCE_SUITE_FORMAT_VERSION}`,
    );
  }

  if (json["kind"] !== CONFORMANCE_SUITE_KIND) {
    suiteError("E_CONFORMANCE_KIND", "$.kind", `expected "${CONFORMANCE_SUITE_KIND}"`);
  }

  const suiteId = json["suiteId"];
  if (typeof suiteId !== "string" || !ID_PATTERN.test(suiteId)) {
    suiteError(
      "E_CONFORMANCE_SUITE_ID",
      "$.suiteId",
      "expected a lowercase id matching ^[a-z0-9][a-z0-9-]{0,63}$",
    );
  }

  const casesValue = json["cases"];
  if (!Array.isArray(casesValue) || casesValue.length === 0) {
    suiteError("E_CONFORMANCE_CASES", "$.cases", "expected a non-empty array of cases");
  }
  const rawCases: readonly unknown[] = casesValue;

  const caseIds = new Set<string>();
  const cases: ConformanceCase[] = [];

  for (let index = 0; index < rawCases.length; index += 1) {
    const path = `$.cases[${index}]`;
    const raw = rawCases[index];

    if (!isPlainObject(raw)) {
      suiteError("E_CONFORMANCE_CASE", path, "case must be an object");
    }

    const caseSuiteId = raw["suiteId"];
    if (typeof caseSuiteId !== "string" || !ID_PATTERN.test(caseSuiteId)) {
      suiteError(
        "E_CONFORMANCE_CASE_SUITE_ID",
        `${path}.suiteId`,
        "expected a lowercase id matching ^[a-z0-9][a-z0-9-]{0,63}$",
      );
    }
    if (caseSuiteId !== suiteId) {
      suiteError(
        "E_CONFORMANCE_CASE_SUITE_ID",
        `${path}.suiteId`,
        `case suiteId "${caseSuiteId}" does not match suite "${suiteId}"`,
      );
    }

    const id = raw["id"];
    if (typeof id !== "string" || !ID_PATTERN.test(id)) {
      suiteError(
        "E_CONFORMANCE_CASE_ID",
        `${path}.id`,
        "expected a lowercase id matching ^[a-z0-9][a-z0-9-]{0,63}$",
      );
    }
    if (caseIds.has(id)) {
      suiteError("E_CONFORMANCE_CASE_DUPLICATE", `${path}.id`, `duplicate case id "${id}"`);
    }

    const kind = raw["kind"];
    if (typeof kind !== "string" || !isCaseKind(kind)) {
      suiteError(
        "E_CONFORMANCE_CASE_KIND",
        `${path}.kind`,
        `expected one of ${[...CASE_KINDS].join(", ")}`,
      );
    }

    if (!Object.hasOwn(raw, "input")) {
      suiteError("E_CONFORMANCE_CASE_INPUT", `${path}.input`, "input is required (use {} for none)");
    }
    const input = raw["input"];
    if (!isJsonValue(input)) {
      suiteError("E_CONFORMANCE_CASE_INPUT", `${path}.input`, "input must be a finite JSON value");
    }

    const skipValue = raw["skip"];
    if (skipValue !== undefined && typeof skipValue !== "boolean") {
      suiteError("E_CONFORMANCE_CASE", `${path}.skip`, "skip must be a boolean when present");
    }

    const reasonValue = raw["reason"];
    if (reasonValue !== undefined) {
      if (
        typeof reasonValue !== "string" ||
        reasonValue.trim().length === 0 ||
        reasonValue.length > 280
      ) {
        suiteError(
          "E_CONFORMANCE_SKIP_REASON",
          `${path}.reason`,
          "reason must be a non-empty string of at most 280 characters",
        );
      }
    }

    if (skipValue === true && reasonValue === undefined) {
      suiteError("E_CONFORMANCE_SKIP_REASON", `${path}.reason`, "an explicit skip requires a reason");
    }

    caseIds.add(id);
    cases.push({
      suiteId,
      id,
      kind,
      input,
      ...(skipValue === true ? { skip: true } : {}),
      ...(typeof reasonValue === "string" ? { reason: reasonValue } : {}),
    });
  }

  return {
    formatVersion: CONFORMANCE_SUITE_FORMAT_VERSION,
    kind: CONFORMANCE_SUITE_KIND,
    suiteId,
    cases,
  };
}

/**
 * What an implementation returns. `true`/`false` is shorthand for
 * `{ pass }`; a failure message is diagnostic text and does not gate anything
 * beyond the pass flag.
 */
export interface ConformanceOutcome {
  readonly pass: boolean;
  readonly message?: string;
}

/**
 * One named implementation, keyed by case id in the implementation map.
 * It receives the case `input` and either returns an outcome or throws
 * (a throw fails the case, it does not abort the suite).
 */
export type ConformanceImplementation = (input: unknown) => boolean | ConformanceOutcome;

export type ConformanceImplementationMap = Readonly<Record<string, ConformanceImplementation>>;

export type ConformanceCaseStatus = "pass" | "fail" | "skip";

/** Per-case detail for logging. The returned result keeps failures only (§3.2). */
export interface ConformanceCaseResult {
  readonly suiteId: string;
  readonly id: string;
  readonly kind: ConformanceCaseKind;
  readonly status: ConformanceCaseStatus;
  /** Failure message, or the skip reason; null on pass. */
  readonly message: string | null;
}

export interface ConformanceRunOptions {
  /** Observes every case in declaration order (used by the CLI run log). */
  readonly onCaseResult?: (result: ConformanceCaseResult) => void;
}

function passResult(testCase: ConformanceCase): ConformanceCaseResult {
  return {
    suiteId: testCase.suiteId,
    id: testCase.id,
    kind: testCase.kind,
    status: "pass",
    message: null,
  };
}

function failureResult(testCase: ConformanceCase, message: string): ConformanceCaseResult {
  return {
    suiteId: testCase.suiteId,
    id: testCase.id,
    kind: testCase.kind,
    status: "fail",
    message,
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function findImplementation(
  implementations: ConformanceImplementationMap,
  id: string,
): ConformanceImplementation | null {
  if (!Object.hasOwn(implementations, id)) return null;
  const candidate = implementations[id];
  return typeof candidate === "function" ? candidate : null;
}

function executeCase(
  testCase: ConformanceCase,
  implementation: ConformanceImplementation,
): ConformanceCaseResult {
  let outcome: unknown;
  try {
    outcome = implementation(testCase.input);
  } catch (error) {
    return failureResult(testCase, `E_CONFORMANCE_THREW: ${describeError(error)}`);
  }

  if (outcome === true) return passResult(testCase);
  if (outcome === false) {
    return failureResult(testCase, "E_CONFORMANCE_FAILED: implementation returned false");
  }

  if (isPlainObject(outcome) && typeof outcome["pass"] === "boolean") {
    const message = outcome["message"];
    if (message !== undefined && typeof message !== "string") {
      return failureResult(
        testCase,
        "E_CONFORMANCE_OUTCOME: outcome.message must be a string when present",
      );
    }
    if (outcome["pass"] === true) return passResult(testCase);
    return failureResult(
      testCase,
      typeof message === "string" && message.length > 0
        ? message
        : "E_CONFORMANCE_FAILED: implementation reported a failure",
    );
  }

  return failureResult(
    testCase,
    "E_CONFORMANCE_OUTCOME: implementation must return a boolean or { pass: boolean, message?: string }",
  );
}

/**
 * Runs every case in declaration order.
 *
 * - `cases === passed + failed + skipped`.
 * - `pass` is true only when nothing failed; a reasoned skip does not fail.
 * - A `skip: true` without a non-empty reason fails its case with
 *   `E_CONFORMANCE_SKIP_REASON` (the loader rejects such a suite first).
 * - Missing or non-callable implementations fail with `E_CONFORMANCE_MISSING`;
 *   they are never silently skipped.
 */
export function runConformance(
  suite: ConformanceSuite,
  implementations: ConformanceImplementationMap,
  options: ConformanceRunOptions = {},
): ConformanceResult {
  const failures: ConformanceFailure[] = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const testCase of suite.cases) {
    let result: ConformanceCaseResult;

    if (testCase.skip === true) {
      if (typeof testCase.reason === "string" && testCase.reason.trim().length > 0) {
        skipped += 1;
        result = {
          suiteId: testCase.suiteId,
          id: testCase.id,
          kind: testCase.kind,
          status: "skip",
          message: testCase.reason,
        };
      } else {
        result = failureResult(
          testCase,
          "E_CONFORMANCE_SKIP_REASON: explicit skip requires a non-empty reason",
        );
      }
    } else {
      const implementation = findImplementation(implementations, testCase.id);
      result =
        implementation === null
          ? failureResult(
              testCase,
              `E_CONFORMANCE_MISSING: no implementation registered for case "${testCase.id}"`,
            )
          : executeCase(testCase, implementation);
    }

    if (result.status === "pass") {
      passed += 1;
    } else if (result.status === "fail") {
      failed += 1;
      failures.push({
        id: testCase.id,
        message: result.message ?? "E_CONFORMANCE_FAILED: case failed without a message",
      });
    }

    options.onCaseResult?.(result);
  }

  return {
    suiteId: suite.suiteId,
    cases: suite.cases.length,
    passed,
    failed,
    skipped,
    failures,
    pass: failed === 0,
  };
}
