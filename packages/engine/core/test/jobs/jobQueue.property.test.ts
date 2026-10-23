/**
 * Job id ordering properties (01 §7, ER-01-10).
 *
 * For any schedule (kind and priority arbitrary, length 0..64), the queue
 * allocates ids 1..n in schedule order and `drainCompleted` returns them in
 * strictly ascending order with no gaps or duplicates. Plain Error failures
 * keep the 500 runs fast.
 */
import fc from "fast-check";
import { test } from "vitest";
import type {
  JobHandlers,
  JobKind,
  JobPriority,
  JobResult,
} from "../../src/jobs/index.js";
import {
  createSyncJobExecutor,
  JobQueue,
  JOB_KINDS,
} from "../../src/jobs/index.js";

const HANDLERS: JobHandlers = {};
for (const kind of JOB_KINDS) {
  HANDLERS[kind] = (_payload, id) => id;
}

const SCHEDULE = fc.array(
  fc.record({
    kind: fc.constantFrom<JobKind>(...JOB_KINDS),
    priority: fc.constantFrom<JobPriority>("critical", "normal", "idle"),
  }),
  { maxLength: 64 },
);

test("[ER-01-10] arbitrary schedules drain in strictly ascending unique ids", () => {
  fc.assert(
    fc.property(SCHEDULE, (jobs) => {
      const queue = new JobQueue(createSyncJobExecutor(HANDLERS));

      for (const job of jobs) {
        queue.schedule({
          kind: job.kind,
          priority: job.priority,
          payload: null,
        });
      }

      const out: JobResult[] = [];
      queue.drainCompleted(out);

      if (out.length !== jobs.length) {
        throw new Error(
          `drained ${out.length} results for ${jobs.length} jobs`,
        );
      }

      for (let index = 0; index < out.length; index += 1) {
        const result = out[index];
        if (result === undefined) {
          throw new Error(`missing result ${index}`);
        }
        const expectedId = index + 1;
        if (result.id !== expectedId) {
          throw new Error(`result ${index} has id ${result.id}`);
        }
        if (result.value !== result.id) {
          throw new Error(`job ${result.id} completed with the wrong payload`);
        }
      }

      queue.dispose();
    }),
    { numRuns: 500 },
  );
});
