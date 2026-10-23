/**
 * Worker envelope guards (01 §7, ER-01-10).
 *
 * W1 ships no worker, but the seam's runtime guards and the error-envelope to
 * `JobResult` mapping are exercised so the future adapter cannot silently
 * accept a malformed message or synthesize a second failure.
 */
import { expect, test } from "vitest";
import {
  isWorkerMessage,
  resultFromWorkerMessage,
  WORKER_PROTOCOL_VERSION,
} from "../../src/jobs/index.js";

test("[ER-01-10] worker envelopes validate and failure envelopes map to one JobResult", () => {
  expect(WORKER_PROTOCOL_VERSION).toBe(1);

  const job = {
    v: 1,
    kind: "job",
    id: 7,
    jobKind: "hash-bytes",
    payload: 1,
  };
  expect(isWorkerMessage(job)).toBe(true);
  expect(isWorkerMessage({ ...job, v: 2 })).toBe(false);
  expect(isWorkerMessage({ ...job, id: 0 })).toBe(false);
  expect(isWorkerMessage({ ...job, id: 1.5 })).toBe(false);
  expect(isWorkerMessage({ ...job, jobKind: "not-a-kind" })).toBe(false);
  expect(isWorkerMessage(null)).toBe(false);
  expect(isWorkerMessage("job")).toBe(false);

  expect(isWorkerMessage({ v: 1, kind: "init", id: 0 })).toBe(true);
  expect(isWorkerMessage({ v: 1, kind: "cancel", id: 3 })).toBe(true);
  expect(isWorkerMessage({ v: 1, kind: "progress", id: 3, bytes: 12 })).toBe(
    true,
  );
  expect(
    isWorkerMessage({ v: 1, kind: "progress", id: 3, bytes: Number.NaN }),
  ).toBe(false);

  const result = resultFromWorkerMessage({
    v: 1,
    kind: "result",
    id: 7,
    jobKind: "hash-bytes",
    payload: "ok",
  });
  expect(result).toEqual({
    id: 7,
    kind: "hash-bytes",
    ok: true,
    value: "ok",
  });

  const failure = resultFromWorkerMessage({
    v: 1,
    kind: "error",
    id: 8,
    jobKind: "decode-image",
    errorCode: "E_WORKER_FAILED",
    errorMessage: "boom",
  });
  expect(failure).toEqual({
    id: 8,
    kind: "decode-image",
    ok: false,
    errorCode: "E_WORKER_FAILED",
    errorMessage: "boom",
  });
});
