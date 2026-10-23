/**
 * Job queue acceptance tests (01 §7, ER-01-10).
 *
 * A holding executor keeps executions alive so priority, cancellation and the
 * late-result path are observable; the synchronous executor covers the crash
 * and missing-handler paths. All timing-free: no worker, no sleeps.
 */
import { expect, test } from "vitest";
import type {
  JobExecution,
  JobExecutor,
  JobHandle,
  JobHandlers,
  JobPriority,
  JobResult,
} from "../../src/jobs/index.js";
import {
  createSyncJobExecutor,
  JobQueue,
} from "../../src/jobs/index.js";

class HoldingExecutor implements JobExecutor {
  readonly submitted: JobExecution[] = [];
  disposeCalls = 0;

  submit(job: JobExecution): void {
    this.submitted.push(job);
  }

  dispose(): void {
    this.disposeCalls += 1;
  }

  complete(index: number, value?: unknown): void {
    const job = this.submitted[index];
    if (job === undefined) {
      throw new Error(`no submitted job at index ${index}`);
    }
    job.complete(value);
  }
}

const PRIORITY_RANK: Readonly<Record<JobPriority, number>> = {
  critical: 0,
  normal: 1,
  idle: 2,
};

test("[ER-01-10] 32 mixed-priority jobs dispatch by band and drain in ascending id", () => {
  const executor = new HoldingExecutor();
  const queue = new JobQueue(executor, { maxConcurrent: 1 });
  const priorityById = new Map<number, JobPriority>();

  for (let index = 1; index <= 32; index += 1) {
    const priority: JobPriority =
      index % 3 === 1 ? "critical" : index % 3 === 2 ? "normal" : "idle";
    const handle = queue.schedule({
      kind: "hash-bytes",
      priority,
      payload: index,
    });
    priorityById.set(handle.id, priority);
  }

  // One slot, so the remaining 31 jobs wait in the three priority queues.
  expect(executor.submitted).toHaveLength(1);
  expect(executor.submitted[0]?.id).toBe(1);

  for (let index = 0; index < 32; index += 1) {
    const job = executor.submitted[index];
    if (job === undefined) {
      throw new Error(`job ${index} was never dispatched`);
    }
    executor.complete(index, job.payload);
  }
  expect(executor.submitted).toHaveLength(32);

  let previousRank = -1;
  let previousId = 0;
  for (const job of executor.submitted) {
    const priority = priorityById.get(job.id);
    if (priority === undefined) {
      throw new Error(`job ${job.id} has no recorded priority`);
    }
    const rank = PRIORITY_RANK[priority];
    expect(rank).toBeGreaterThanOrEqual(previousRank);
    if (rank === previousRank) {
      expect(job.id).toBeGreaterThan(previousId);
    }
    previousRank = rank;
    previousId = job.id;
  }

  const out: JobResult[] = [];
  expect(queue.drainCompleted(out)).toBe(out);
  expect(out.map((result) => result.id)).toEqual(
    Array.from({ length: 32 }, (_, index) => index + 1),
  );
  for (const result of out) {
    expect(result.ok).toBe(true);
    expect(result.value).toBe(result.id);
  }
  expect(queue.pending).toBe(0);
  expect(queue.running).toBe(0);
});

test("[ER-01-10] cancelling a queued job skips it and an aborted signal never dispatches", () => {
  const executor = new HoldingExecutor();
  const queue = new JobQueue(executor, { maxConcurrent: 1 });

  const running = queue.schedule({
    kind: "hash-bytes",
    priority: "normal",
    payload: "a",
  });
  const queued = queue.schedule({
    kind: "hash-bytes",
    priority: "normal",
    payload: "b",
  });
  const queuedTwice = queue.schedule({
    kind: "hash-bytes",
    priority: "normal",
    payload: "c",
  });

  const aborter = new AbortController();
  aborter.abort();
  const aborted = queue.schedule({
    kind: "hash-bytes",
    priority: "normal",
    payload: "d",
    signal: aborter.signal,
  });

  expect(aborted.state).toBe("cancelled");
  expect(queue.pending).toBe(3);

  queued.cancel();
  expect(queued.state).toBe("cancelled");
  expect(queue.pending).toBe(2);

  executor.complete(0, "a");
  expect(executor.submitted).toHaveLength(2);
  expect(executor.submitted[1]?.id).toBe(queuedTwice.id);
  executor.complete(1, "c");

  const out: JobResult[] = [];
  queue.drainCompleted(out);
  expect(out.map((result) => result.id)).toEqual([running.id, queuedTwice.id]);
  expect(queue.pending).toBe(0);
});

test("[ER-01-10] a cancelled running job's late result is discarded", () => {
  const executor = new HoldingExecutor();
  const queue = new JobQueue(executor, { maxConcurrent: 1 });
  const handle: JobHandle = queue.schedule({
    kind: "hash-bytes",
    priority: "normal",
    payload: 1,
  });

  expect(handle.state).toBe("running");
  handle.cancel();
  expect(handle.state).toBe("cancelled");
  expect(queue.pending).toBe(1);

  executor.complete(0, "late");
  const out: JobResult[] = [];
  queue.drainCompleted(out);
  expect(out).toEqual([]);
  expect(queue.pending).toBe(0);
  expect(queue.running).toBe(0);
});

test("[ER-01-10] a worker crash delivers E_WORKER_FAILED once and the queue stays usable", () => {
  const handlers: JobHandlers = {
    "hash-bytes": () => {
      throw new Error("worker exploded");
    },
    "decode-image": () => 7,
  };
  const queue = new JobQueue(createSyncJobExecutor(handlers));

  const crashed = queue.schedule({
    kind: "hash-bytes",
    priority: "critical",
    payload: null,
  });
  const survived = queue.schedule({
    kind: "decode-image",
    priority: "normal",
    payload: null,
  });
  const missing = queue.schedule({
    kind: "build-atlas",
    priority: "idle",
    payload: null,
  });

  const out: JobResult[] = [];
  queue.drainCompleted(out);
  expect(out.map((result) => result.id)).toEqual([
    crashed.id,
    survived.id,
    missing.id,
  ]);
  expect(out[0]).toMatchObject({
    id: crashed.id,
    ok: false,
    errorCode: "E_WORKER_FAILED",
    errorMessage: "worker exploded",
  });
  expect(out[1]).toMatchObject({ id: survived.id, ok: true, value: 7 });
  expect(out[2]).toMatchObject({
    id: missing.id,
    ok: false,
    errorCode: "E_WORKER_FAILED",
  });

  const afterCrash = queue.schedule({
    kind: "decode-image",
    priority: "normal",
    payload: null,
  });
  const recovered: JobResult[] = [];
  queue.drainCompleted(recovered);
  expect(recovered).toHaveLength(1);
  expect(recovered[0]).toMatchObject({ id: afterCrash.id, ok: true, value: 7 });
});

test("[ER-01-10] dispose cancels queued work, is idempotent and rejects new jobs", () => {
  const executor = new HoldingExecutor();
  const queue = new JobQueue(executor, { maxConcurrent: 1 });
  const running = queue.schedule({
    kind: "hash-bytes",
    priority: "critical",
    payload: 1,
  });
  const queued = queue.schedule({
    kind: "hash-bytes",
    priority: "normal",
    payload: 2,
  });

  queue.dispose();
  queue.dispose();

  expect(executor.disposeCalls).toBe(1);
  expect(running.state).toBe("cancelled");
  expect(queued.state).toBe("cancelled");
  expect(queue.pending).toBe(0);
  expect(() =>
    queue.schedule({ kind: "hash-bytes", payload: 3 }),
  ).toThrow(/disposed/);

  executor.complete(0, "late");
  const out: JobResult[] = [];
  expect(queue.drainCompleted(out)).toEqual([]);
});

test("[ER-01-10] the transfer list reaches the executor seam", () => {
  const executor = new HoldingExecutor();
  const queue = new JobQueue(executor);
  const buffer = new ArrayBuffer(8);

  queue.schedule({
    kind: "hash-bytes",
    payload: buffer,
    transfer: [buffer],
  });

  expect(executor.submitted).toHaveLength(1);
  expect(executor.submitted[0]?.transfer).toEqual([buffer]);
});
