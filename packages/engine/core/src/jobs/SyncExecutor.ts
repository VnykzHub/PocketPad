/**
 * Synchronous job executor (spec 01 §3.6, §5.7).
 *
 * The W1 test backend: runs the handler for the job kind on the calling
 * thread and reports the result through the `JobExecution` seam. It exists to
 * prove the queue's ordering, cancellation and failure paths without a
 * `Worker`. A missing handler or a thrown error becomes `E_WORKER_FAILED`
 * exactly once, matching the specified worker-crash path.
 */
import type { JobExecutor, JobExecution, JobHandlers } from "./types.js";

export function createSyncJobExecutor(handlers: JobHandlers): JobExecutor {
  return {
    submit(job: JobExecution): void {
      const handler = handlers[job.kind];
      if (handler === undefined) {
        job.fail("E_WORKER_FAILED", `no synchronous handler for ${job.kind}`);
        return;
      }
      try {
        job.complete(handler(job.payload, job.id));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        job.fail("E_WORKER_FAILED", message);
      }
    },
    dispose(): void {
      /* the synchronous backend owns no worker or transport */
    },
  };
}
