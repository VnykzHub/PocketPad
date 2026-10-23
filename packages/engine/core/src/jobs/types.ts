/**
 * Job-domain types (spec 01 §3.6, §5.6, §5.7).
 *
 * The frozen surface (`Job`, `JobHandle`, `JobResult`, `JobSystem`, `JobKind`)
 * lives in `../contracts/time.d.ts` and is re-exported here for the `jobs/`
 * subtree. This module adds only the executor seam and the runtime kind list.
 * Payloads crossing the seam are plain cloneable values; the queue never reads
 * them.
 */
export type {
  Job,
  JobHandle,
  JobKind,
  JobPayload,
  JobPriority,
  JobResult,
  JobSystem,
} from "../contracts/engine.js";

import type { JobHandle, JobKind, JobResult } from "../contracts/engine.js";

/** Failure codes `JobResult` may carry (01 §3.6). */
export type JobErrorCode = NonNullable<JobResult["errorCode"]>;

/** `queued | running | done | cancelled | failed`, from the frozen `JobHandle`. */
export type JobState = JobHandle["state"];

/** Every job kind in 01 §3.6, as runtime data for guards and test fixtures. */
export const JOB_KINDS = [
  "decode-gltf",
  "decode-ktx2",
  "decode-image",
  "decode-audio",
  "build-atlas",
  "build-navmesh",
  "compress-save",
  "hash-bytes",
] as const satisfies readonly JobKind[];

export function isJobKind(value: unknown): value is JobKind {
  return (
    typeof value === "string" &&
    (JOB_KINDS as readonly string[]).includes(value)
  );
}

/**
 * One running job as seen by an executor (worker pool or synchronous test
 * backend). The executor calls `complete` or `fail` exactly once unless the
 * job is cancelled; a post-cancel completion is discarded by id.
 */
export interface JobExecution {
  readonly id: number;
  readonly kind: JobKind;
  readonly payload: unknown;
  /** Structured-clone transfer list from `Job.transfer`, if any. */
  readonly transfer: readonly Transferable[] | undefined;
  complete(value?: unknown): void;
  fail(errorCode: JobErrorCode, errorMessage: string): void;
}

/**
 * Execution seam. A worker-pool adapter forwards `submit` over
 * `postMessage`; `createSyncJobExecutor` runs the handler inline. No worker
 * implementation ships in W1.
 */
export interface JobExecutor {
  submit(job: JobExecution): void;
  dispose(): void;
}

/** Synchronous handler for one kind. Receives the payload and job id. */
export type JobHandler = (payload: unknown, id: number) => unknown;

/** Handler table for the synchronous test backend. */
export type JobHandlers = Partial<Record<JobKind, JobHandler>>;
