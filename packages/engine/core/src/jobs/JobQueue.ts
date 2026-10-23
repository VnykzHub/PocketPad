/**
 * Deterministic job queue (spec 01 §3.6, §5.6).
 *
 * Owns id allocation, priority FIFO queues, cancellation and the completed
 * result buffer. Execution is delegated to a `JobExecutor` seam; the only
 * backend in W1 is the synchronous test executor.
 *
 * Guarantees:
 * - job ids are monotonic u32 values, never reused in a session;
 * - queued work dispatches in priority order (critical, normal, idle) and
 *   FIFO within one priority;
 * - `drainCompleted` returns results in ascending id order, so two runs with
 *   the same schedule produce the same application order;
 * - cancelling a queued job never dispatches it, and a cancelled job's late
 *   result is discarded by id;
 * - a throwing executor delivers `E_WORKER_FAILED` once and leaves the queue
 *   usable.
 */
import type {
  Job,
  JobHandle,
  JobKind,
  JobPriority,
  JobResult,
  JobSystem,
} from "../contracts/engine.js";
import type { JobErrorCode, JobExecution, JobExecutor } from "./types.js";
import { isJobKind } from "./types.js";

const PRIORITY_INDEX: Readonly<Record<JobPriority, number>> = {
  critical: 0,
  normal: 1,
  idle: 2,
};

const PRIORITY_NAMES: readonly JobPriority[] = ["critical", "normal", "idle"];

function compareById(left: JobResult, right: JobResult): number {
  return left.id - right.id;
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

class ScheduledJob implements JobHandle {
  readonly id: number;
  readonly kind: JobKind;
  readonly priority: JobPriority;
  readonly payload: unknown;
  readonly signal: AbortSignal | undefined;
  readonly transfer: readonly Transferable[] | undefined;

  private stateValue: JobHandle["state"] = "queued";
  private readonly cancelSelf: (job: ScheduledJob) => void;
  private abortListener: (() => void) | null = null;
  /** True once the executor has been handed this job. */
  dispatched = false;

  constructor(
    id: number,
    kind: JobKind,
    priority: JobPriority,
    payload: unknown,
    signal: AbortSignal | undefined,
    transfer: readonly Transferable[] | undefined,
    cancelSelf: (job: ScheduledJob) => void,
  ) {
    this.id = id;
    this.kind = kind;
    this.priority = priority;
    this.payload = payload;
    this.signal = signal;
    this.transfer = transfer;
    this.cancelSelf = cancelSelf;
  }

  get state(): JobHandle["state"] {
    return this.stateValue;
  }

  cancel(): void {
    this.cancelSelf(this);
  }

  markState(state: JobHandle["state"]): void {
    this.stateValue = state;
  }

  attachAbortListener(listener: () => void): void {
    this.abortListener = listener;
  }

  takeAbortListener(): (() => void) | null {
    const listener = this.abortListener;
    this.abortListener = null;
    return listener;
  }
}

export interface JobQueueOptions {
  /** Maximum simultaneously submitted jobs; default unbounded. */
  readonly maxConcurrent?: number;
}

export class JobQueue implements JobSystem {
  private readonly executor: JobExecutor;
  private readonly maxConcurrent: number;
  private readonly jobs = new Map<number, ScheduledJob>();
  private readonly queues: ScheduledJob[][] = [[], [], []];
  private readonly completed: JobResult[] = [];
  private nextId = 1;
  private runningCount = 0;
  private pumping = false;
  private disposedValue = false;

  constructor(executor: JobExecutor, options: JobQueueOptions = {}) {
    const limit = options.maxConcurrent ?? Number.POSITIVE_INFINITY;
    if (
      limit !== Number.POSITIVE_INFINITY &&
      (!Number.isInteger(limit) || limit < 1)
    ) {
      throw new RangeError("maxConcurrent must be a positive integer or Infinity");
    }
    this.executor = executor;
    this.maxConcurrent = limit;
  }

  /** Jobs not yet completed or discarded (queued + running). */
  get pending(): number {
    return this.jobs.size;
  }

  get running(): number {
    return this.runningCount;
  }

  schedule<T>(job: Job<T>): JobHandle {
    if (this.disposedValue) {
      throw new Error("JobQueue is disposed");
    }
    if (!isJobKind(job.kind)) {
      throw new RangeError(`unknown job kind: ${String(job.kind)}`);
    }
    const priority = job.priority ?? "normal";
    const priorityIndex = PRIORITY_INDEX[priority];
    if (priorityIndex === undefined) {
      throw new RangeError(`unknown job priority: ${String(priority)}`);
    }

    const id = this.allocateId();
    const record = new ScheduledJob(
      id,
      job.kind,
      priority,
      job.payload,
      job.signal,
      job.transfer,
      (self) => this.cancel(self),
    );
    this.jobs.set(id, record);

    if (job.signal !== undefined) {
      if (job.signal.aborted) {
        record.markState("cancelled");
        this.jobs.delete(id);
        return record;
      }
      const listener = (): void => {
        this.cancel(record);
      };
      record.attachAbortListener(listener);
      job.signal.addEventListener("abort", listener, { once: true });
    }

    this.queues[priorityIndex]?.push(record);
    this.pump();
    return record;
  }

  cancel(handle: JobHandle): void {
    if (this.disposedValue) {
      return;
    }
    const record = this.jobs.get(handle.id);
    if (record === undefined || record !== handle) {
      return;
    }
    if (
      record.state === "done" ||
      record.state === "failed" ||
      record.state === "cancelled"
    ) {
      return;
    }

    record.markState("cancelled");
    this.removeAbortListener(record);

    if (!record.dispatched) {
      this.jobs.delete(record.id);
      this.pump();
    }
    // A running job keeps its map entry until the executor reports back; the
    // late result is discarded in finish().
  }

  /**
   * Moves completed results into the caller's array, sorted ascending by id.
   * Never called from a worker callback; the host calls it at a tick boundary.
   */
  drainCompleted(out: JobResult[]): JobResult[] {
    if (this.completed.length === 0) {
      return out;
    }
    this.completed.sort(compareById);
    for (let index = 0; index < this.completed.length; index += 1) {
      const result = this.completed[index];
      if (result !== undefined) {
        out.push(result);
      }
    }
    this.completed.length = 0;
    return out;
  }

  dispose(): void {
    if (this.disposedValue) {
      return;
    }
    this.disposedValue = true;
    for (const record of this.jobs.values()) {
      this.removeAbortListener(record);
      record.markState("cancelled");
    }
    this.jobs.clear();
    for (const queue of this.queues) {
      queue.length = 0;
    }
    this.runningCount = 0;
    this.completed.length = 0;
    this.executor.dispose();
  }

  private allocateId(): number {
    const id = this.nextId;
    this.nextId = this.nextId >= 0xffffffff ? 1 : this.nextId + 1;
    return id;
  }

  private pump(): void {
    if (this.pumping || this.disposedValue) {
      return;
    }
    this.pumping = true;
    try {
      while (this.runningCount < this.maxConcurrent) {
        const record = this.takeNext();
        if (record === null) {
          break;
        }
        record.dispatched = true;
        record.markState("running");
        this.runningCount += 1;

        const execution: JobExecution = {
          id: record.id,
          kind: record.kind,
          payload: record.payload,
          transfer: record.transfer,
          complete: (value?: unknown): void => {
            this.finish(record, true, value, null, null);
          },
          fail: (errorCode: JobErrorCode, errorMessage: string): void => {
            this.finish(record, false, undefined, errorCode, errorMessage);
          },
        };

        try {
          this.executor.submit(execution);
        } catch (error) {
          this.finish(record, false, undefined, "E_WORKER_FAILED", errorMessageOf(error));
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private takeNext(): ScheduledJob | null {
    for (let index = 0; index < this.queues.length; index += 1) {
      const queue = this.queues[index];
      if (queue === undefined) {
        continue;
      }
      while (queue.length > 0) {
        const record = queue.shift();
        if (record === undefined) {
          return null;
        }
        if (record.state === "queued") {
          return record;
        }
      }
    }
    return null;
  }

  private finish(
    record: ScheduledJob,
    ok: boolean,
    value: unknown,
    errorCode: JobErrorCode | null,
    errorMessage: string | null,
  ): void {
    if (this.jobs.get(record.id) !== record) {
      // Cancelled queued job, disposed queue, or a duplicate completion.
      return;
    }
    this.jobs.delete(record.id);
    if (record.dispatched) {
      this.runningCount = Math.max(0, this.runningCount - 1);
    }
    this.removeAbortListener(record);

    if (record.state === "cancelled") {
      this.pump();
      return;
    }

    record.markState(ok ? "done" : "failed");
    this.completed.push(this.makeResult(record, ok, value, errorCode, errorMessage));
    this.pump();
  }

  private makeResult(
    record: ScheduledJob,
    ok: boolean,
    value: unknown,
    errorCode: JobErrorCode | null,
    errorMessage: string | null,
  ): JobResult {
    if (ok) {
      if (value === undefined) {
        return { id: record.id, kind: record.kind, ok: true };
      }
      return { id: record.id, kind: record.kind, ok: true, value };
    }
    const message = errorMessage ?? "job failed";
    if (errorCode === null) {
      return { id: record.id, kind: record.kind, ok: false, errorMessage: message };
    }
    return {
      id: record.id,
      kind: record.kind,
      ok: false,
      errorCode,
      errorMessage: message,
    };
  }

  private removeAbortListener(record: ScheduledJob): void {
    const listener = record.takeAbortListener();
    const signal = record.signal;
    if (listener !== null && signal !== undefined) {
      signal.removeEventListener("abort", listener);
    }
  }
}

/** Priority names in dispatch order, exported for tests and diagnostics. */
export { PRIORITY_NAMES };
