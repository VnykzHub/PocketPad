/**
 * Result and conformance-suite types for the engine verification rig
 * (docs/engine/19-testing-benchmarks.md §3.2, §4.6, §5.9).
 *
 * These types describe persisted JSON. Rules carried from the spec:
 * - `formatVersion` is exactly `1`; a reader refuses any other value.
 * - `startedAt` is an ISO-8601 UTC string, e.g. "2026-10-22T00:00:00.000Z".
 * - `durationMs` is an integer number of milliseconds (>= 0).
 * - `null` means "not measured" and is never a stand-in for zero.
 * - Unknown fields in a result are ignored; optional additions do not bump
 *   the format version.
 * - Percentiles use the nearest-rank definition owned by spec 16.
 *
 * This module holds types and format constants only. Suite validation lives
 * in `conformance.ts`; this file does not validate a RunResult.
 */

/** Format version written into a conformance suite file. */
export const CONFORMANCE_SUITE_FORMAT_VERSION = 1 as const;

/** Kind discriminator for a conformance suite file. */
export const CONFORMANCE_SUITE_KIND = "engine-conformance-suite" as const;

export type ConformanceSuiteKind = typeof CONFORMANCE_SUITE_KIND;

/** Requested renderer mode (§3.1). A request, not a guarantee. */
export type EngineTestMode = "webgpu" | "webgl2" | "software" | "canvas2d";

/** Backend actually used, as reported by the page (§3.2). */
export type EngineTestBackend = "webgpu" | "webgl2" | "canvas2d" | "none";

export type EngineTestCommand =
  | "verify"
  | "golden-verify"
  | "golden-update"
  | "determinism"
  | "conformance"
  | "bench";

/** Process exit codes (§3.5). */
export type ExitCode = 0 | 1 | 2 | 3;

export type RunStatus = "pass" | "fail" | "error" | "skipped";

export interface Percentiles {
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly mean: number;
}

export interface BuildIdentity {
  /** ENGINE_VERSION. */
  readonly engineVersion: string;
  /** 8..64 lowercase hex characters. */
  readonly buildHash: string;
  /** Working tree had uncommitted changes. */
  readonly dirty: boolean;
  /** Game slug, or "engine" for the M0 demo. */
  readonly gameId: string;
  readonly sceneId: string;
}

export interface AdapterInfo {
  readonly api: "webgpu" | "webgl2";
  readonly vendor: string;
  readonly architecture: string;
  readonly device: string;
  readonly description: string;
  readonly isFallbackAdapter: boolean | null;
}

export interface Viewport {
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly dpr: number;
}

export interface RunEnvironment {
  /** Display string, e.g. "Chrome 155.0.8059.85". */
  readonly browser: string;
  readonly headless: boolean;
  readonly viewport: Viewport;
  readonly adapter: AdapterInfo | null;
  /** docs/DEVICES.md id; null on CI. */
  readonly deviceId: string | null;
}

export interface GpuTiming {
  readonly source: "timestamp-query" | "ext-disjoint-timer" | "none";
  readonly p50: number | null;
  readonly p95: number | null;
  readonly max: number | null;
}

export interface HeapSample {
  readonly source: "performance.memory";
  readonly startBytes: number;
  readonly endBytes: number;
  /** endBytes - startBytes. */
  readonly growthBytes: number;
  readonly frames: number;
}

export interface BenchSample {
  readonly sceneId: string;
  readonly warmupFrames: number;
  readonly measuredFrames: number;
  /** Frame time in milliseconds. */
  readonly frameMs: Percentiles;
  readonly cpuMs: Percentiles | null;
  readonly gpuMs: GpuTiming;
  readonly drawCalls: Percentiles;
  /** Maximum over measured frames. */
  readonly triangles: number;
  /** Last measured frame. */
  readonly textureBytes: number;
  /** Last measured frame. */
  readonly bufferBytes: number;
  /** 0.6 .. 1.0. */
  readonly renderScale: number;
  /** null when the browser exposes no heap API. */
  readonly heap: HeapSample | null;
}

export interface GoldenTolerance {
  /** 0..255. */
  readonly maxChannelDelta: number;
  /** 0..1. */
  readonly maxMismatchFraction: number;
}

export interface DiffMetrics {
  readonly totalPixels: number;
  readonly mismatchPixels: number;
  readonly mismatchFraction: number;
  readonly maxChannelDelta: number;
  readonly meanAbsError: number;
  /** First mismatch in scan order, or null when the images are equal. */
  readonly firstMismatch: { readonly x: number; readonly y: number } | null;
}

export interface GoldenComparison {
  readonly goldenId: string;
  /** Relative to the manifest directory. */
  readonly file: string;
  readonly expectedSha256: string;
  readonly actualSha256: string;
  readonly width: number;
  readonly height: number;
  readonly tolerance: GoldenTolerance;
  readonly diff: DiffMetrics;
  readonly pass: boolean;
}

export interface DeterminismResult {
  readonly replayId: string;
  readonly seed: number;
  readonly ticks: number;
  readonly hashEvery: number;
  readonly runs: number;
  readonly hashesPerRun: number;
  readonly equal: boolean;
  /** "fnv1a32:" plus eight lowercase hex digits, from run 1. */
  readonly stateHash: string;
  readonly firstMismatchTick: number | null;
  /** A seed+1 run produced a different hash. */
  readonly seedSensitivity: boolean;
}

/** Kinds of shared contract case the conformance runner understands. */
export type ConformanceCaseKind =
  | "math-projection"
  | "math-quat-order"
  | "scene-lifecycle"
  | "tick-order"
  | "render-contract";

/** One failed case in a conformance summary (§3.2 names this ConformanceCaseFailure). */
export interface ConformanceFailure {
  readonly id: string;
  readonly message: string;
}

/**
 * The §3.2 conformance summary. It is embedded in `RunResult.conformance`
 * without its own version field; the §4.6 `CONFORMANCE_REPORT_VERSION = 1`
 * applies when a case-level report is written separately.
 *
 * `cases === passed + failed + skipped`; `pass` is true only when
 * `failed === 0`. A skipped case must carry an explicit reason.
 */
export interface ConformanceResult {
  readonly suiteId: string;
  readonly cases: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly failures: readonly ConformanceFailure[];
  readonly pass: boolean;
}

/** §3.2 name for the same shape. */
export type ConformanceSummary = ConformanceResult;

/**
 * One named case in a conformance suite file.
 *
 * `input` is the synthetic fixture handed to the implementation registered
 * under this case's `id`. It must be a finite JSON value; `{}` means "no
 * input". `skip: true` is the only way a case may be skipped and requires a
 * `reason` (enforced by `loadSuite`).
 */
export interface ConformanceCase {
  /** Must equal the enclosing suite's `suiteId`. */
  readonly suiteId: string;
  /** Stable id, unique within the suite: ^[a-z0-9][a-z0-9-]{0,63}$. */
  readonly id: string;
  readonly kind: ConformanceCaseKind;
  readonly input: unknown;
  readonly skip?: boolean;
  /** Required when `skip` is true; otherwise optional. */
  readonly reason?: string;
}

/**
 * A conformance suite file (`engine-conformance-suite`, version 1).
 * Cases run and are reported in declaration order.
 */
export interface ConformanceSuite {
  readonly formatVersion: typeof CONFORMANCE_SUITE_FORMAT_VERSION;
  readonly kind: ConformanceSuiteKind;
  /** ^[a-z0-9][a-z0-9-]{0,63}$. */
  readonly suiteId: string;
  /** Non-empty; case ids are unique. An empty suite is rejected. */
  readonly cases: readonly ConformanceCase[];
}

export interface BudgetCheck {
  /** "frame-p95" | "draw-calls" | "texture-bytes" | "heap-growth". */
  readonly id: string;
  readonly observed: number;
  readonly limit: number;
  readonly unit: "ms" | "count" | "bytes";
  readonly pass: boolean;
}

export interface ArtifactPaths {
  readonly resultJson: string;
  readonly screenshotPng: string | null;
  readonly goldenActualPng: string | null;
  readonly goldenDiffPng: string | null;
  readonly log: string;
}

export type RunErrorCode =
  | "E_RIG_USAGE"
  | "E_RIG_CHROME"
  | "E_RIG_CDP"
  | "E_RIG_TIMEOUT"
  | "E_RIG_PAGE"
  | "E_RIG_RESULT"
  | "E_RIG_GOLDEN"
  | "E_RIG_IO"
  | "E_RIG_UNSUPPORTED";

export interface RunError {
  readonly code: RunErrorCode;
  readonly message: string;
}

/** The one result file every rig command writes (§3.2, `engine-bench-result` v1). */
export interface RunResult {
  readonly formatVersion: 1;
  readonly kind: "engine-bench-result";
  /** UUID v4. */
  readonly runId: string;
  readonly command: EngineTestCommand;
  readonly status: RunStatus;
  readonly exitCode: ExitCode;
  /** ISO-8601 UTC, e.g. "2026-10-22T00:00:00.000Z". */
  readonly startedAt: string;
  /** Whole-run duration in integer milliseconds. */
  readonly durationMs: number;
  readonly requestedMode: EngineTestMode;
  readonly backend: EngineTestBackend;
  readonly fallback: boolean;
  readonly build: BuildIdentity;
  readonly environment: RunEnvironment;
  readonly bench: BenchSample | null;
  readonly golden: GoldenComparison | null;
  readonly determinism: DeterminismResult | null;
  readonly conformance: ConformanceResult | null;
  readonly budgets: readonly BudgetCheck[];
  readonly artifacts: ArtifactPaths;
  readonly errors: readonly RunError[];
  readonly warnings: readonly string[];
}
