/**
 * Worker message envelope and runtime guards (spec 01 §4.3, §5.7).
 *
 * This is the seam between the main thread and a future worker pool. W1 ships
 * no worker: the types and guards let the runtime adapter be written and the
 * envelopes be validated without importing `Worker`. Payloads are structured
 * clone values; transfer lists travel as the second `postMessage` argument,
 * never inside `payload`.
 */
import type { JobKind, JobResult } from "../contracts/engine.js";
import type { JobErrorCode } from "./types.js";
import { isJobKind } from "./types.js";

export const WORKER_PROTOCOL_VERSION = 1;

export interface WorkerInitMessage {
  readonly v: 1;
  readonly kind: "init";
  readonly id: 0;
}

export interface WorkerJobMessage {
  readonly v: 1;
  readonly kind: "job";
  readonly id: number;
  readonly jobKind: JobKind;
  readonly payload: unknown;
}

export interface WorkerCancelMessage {
  readonly v: 1;
  readonly kind: "cancel";
  readonly id: number;
}

export interface WorkerResultMessage {
  readonly v: 1;
  readonly kind: "result";
  readonly id: number;
  readonly jobKind: JobKind;
  readonly payload: unknown;
}

export interface WorkerErrorMessage {
  readonly v: 1;
  readonly kind: "error";
  readonly id: number;
  readonly jobKind: JobKind;
  readonly errorCode: JobErrorCode;
  readonly errorMessage: string;
}

export interface WorkerProgressMessage {
  readonly v: 1;
  readonly kind: "progress";
  readonly id: number;
  readonly jobKind?: JobKind;
  readonly bytes: number;
}

export type WorkerMessage =
  | WorkerInitMessage
  | WorkerJobMessage
  | WorkerCancelMessage
  | WorkerResultMessage
  | WorkerErrorMessage
  | WorkerProgressMessage;

const ERROR_CODES: readonly JobErrorCode[] = [
  "E_WORKER_FAILED",
  "E_ASSET_FORMAT",
  "E_ASSET_LOAD",
];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}

function isJobId(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= 0xffffffff
  );
}

function isJobErrorCode(value: unknown): value is JobErrorCode {
  return (
    typeof value === "string" &&
    (ERROR_CODES as readonly string[]).includes(value)
  );
}

/** Total runtime guard for both worker directions. */
export function isWorkerMessage(value: unknown): value is WorkerMessage {
  const record = asRecord(value);
  if (record === null || record.v !== WORKER_PROTOCOL_VERSION) {
    return false;
  }
  switch (record.kind) {
    case "init":
      return record.id === 0;
    case "job":
      return isJobId(record.id) && isJobKind(record.jobKind) && "payload" in record;
    case "cancel":
      return isJobId(record.id);
    case "result":
      return isJobId(record.id) && isJobKind(record.jobKind) && "payload" in record;
    case "error":
      return (
        isJobId(record.id) &&
        isJobKind(record.jobKind) &&
        isJobErrorCode(record.errorCode) &&
        typeof record.errorMessage === "string"
      );
    case "progress":
      return (
        isJobId(record.id) &&
        (record.jobKind === undefined || isJobKind(record.jobKind)) &&
        typeof record.bytes === "number" &&
        Number.isFinite(record.bytes)
      );
    default:
      return false;
  }
}

/** Converts a validated result/error envelope into the queue's `JobResult`. */
export function resultFromWorkerMessage(
  message: WorkerResultMessage | WorkerErrorMessage,
): JobResult {
  if (message.kind === "result") {
    if (message.payload === undefined) {
      return { id: message.id, kind: message.jobKind, ok: true };
    }
    return { id: message.id, kind: message.jobKind, ok: true, value: message.payload };
  }
  return {
    id: message.id,
    kind: message.jobKind,
    ok: false,
    errorCode: message.errorCode,
    errorMessage: message.errorMessage,
  };
}
