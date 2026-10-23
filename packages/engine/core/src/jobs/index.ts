/**
 * `@lanpad/engine-core` jobs subtree barrel (spec 01 §5.6, §5.7).
 *
 * The package entry (`src/index.ts`) is integration-owned; it should export
 * these values explicitly. `contracts/time.d.ts` declares `JobSystem` and the
 * job member types, so a blanket star export from both modules is ambiguous.
 */
export { JobQueue, PRIORITY_NAMES } from "./JobQueue.js";
export type { JobQueueOptions } from "./JobQueue.js";
export { createSyncJobExecutor } from "./SyncExecutor.js";
export { isJobKind, JOB_KINDS } from "./types.js";
export type {
  Job,
  JobErrorCode,
  JobExecution,
  JobExecutor,
  JobHandle,
  JobHandler,
  JobHandlers,
  JobKind,
  JobPayload,
  JobPriority,
  JobResult,
  JobState,
  JobSystem,
} from "./types.js";
export {
  isWorkerMessage,
  resultFromWorkerMessage,
  WORKER_PROTOCOL_VERSION,
} from "./WorkerProtocol.js";
export type {
  WorkerCancelMessage,
  WorkerErrorMessage,
  WorkerInitMessage,
  WorkerJobMessage,
  WorkerMessage,
  WorkerProgressMessage,
  WorkerResultMessage,
} from "./WorkerProtocol.js";
