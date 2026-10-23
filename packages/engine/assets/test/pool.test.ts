/**
 * ER-06-08: decode worker pool and worker protocol.
 *
 * Node has no module `Worker`, so the pool is exercised through a fake
 * `WorkerLike` that records posted messages and can succeed, fail or go
 * silent. The fallback path is the same one production uses when workers
 * are unavailable.
 */

import { describe, expect, test, vi } from "vitest";
import type { WorkerLike } from "../src/contracts/assets.js";
import { decodeAudio } from "../src/codec/audio.js";
import { decodeFont } from "../src/codec/font.js";
import { decodeGlb } from "../src/codec/glb.js";
import { decodeJson } from "../src/codec/json.js";
import { decodeKtx2 } from "../src/codec/ktx2.js";
import { AssetEngineError } from "../src/errors.js";
import {
  DecodePool,
  FALLBACK_MAX_BYTES,
  MAX_DECODE_WORKERS,
  WORKER_RESTART_WINDOW_MS,
  type DecodeFallback,
} from "../src/worker/pool.js";
import {
  decodeRequestTransfer,
  decodeResultError,
  decodeResultFromOutcome,
  isDecodeResult,
  transferablesForValue,
  type DecodeWorkerRequest,
  type DecodeWorkerResponse,
} from "../src/worker/protocol.js";
import {
  buildAudio,
  buildKtx2,
  buildTriangleGlb,
  buildWoff2,
  expectCode,
  textBytes,
} from "./helpers.js";

interface Posted {
  readonly message: DecodeWorkerRequest;
  readonly transfer: readonly Transferable[] | undefined;
}

/** In-process stand-in for a module worker. */
class FakeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  readonly posted: Posted[] = [];
  terminateCalls = 0;
  postError: Error | null = null;

  postMessage(message: unknown, transfer?: Transferable[]): void {
    if (this.postError !== null) throw this.postError;
    this.posted.push({
      message: message as DecodeWorkerRequest,
      transfer,
    });
  }

  terminate(): void {
    this.terminateCalls += 1;
  }

  respond(result: DecodeWorkerResponse): void {
    this.onmessage?.({
      data: result,
    } as unknown as MessageEvent<unknown>);
  }

  respondRaw(data: unknown): void {
    this.onmessage?.({ data } as unknown as MessageEvent<unknown>);
  }

  fail(): void {
    this.onerror?.(new Error("worker crashed"));
  }

  get lastJobId(): number {
    const last = this.posted.at(-1);
    if (last === undefined) throw new Error("worker was never posted a job");
    return last.message.jobId;
  }
}

function workerFactory(): {
  readonly factory: () => WorkerLike;
  readonly workers: FakeWorker[];
} {
  const workers: FakeWorker[] = [];
  return {
    workers,
    factory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  };
}

function workerAt(workers: readonly FakeWorker[], index: number): FakeWorker {
  const worker = workers[index];
  if (worker === undefined) throw new Error(`worker ${index} was not created`);
  return worker;
}

function recordingFallback(): {
  readonly calls: DecodeWorkerRequest[];
  readonly fallback: DecodeFallback;
} {
  const calls: DecodeWorkerRequest[] = [];
  return {
    calls,
    fallback: async (incoming) => {
      calls.push(incoming);
      return {
        jobId: incoming.jobId,
        ok: true,
        value: { json: { id: incoming.id } },
      };
    },
  };
}

function request(
  id: string,
  bytes: ArrayBuffer = new ArrayBuffer(16),
): Omit<DecodeWorkerRequest, "jobId"> {
  return { id, kind: "json", url: `${id}.json`, bytes };
}

function success(jobId: number): DecodeWorkerResponse {
  return { jobId, ok: true, value: { json: { jobId } } };
}

describe("ER-06-08 pool without workers", () => {
  test("ER-06-08 degrades at construction and runs the fallback", async () => {
    const recorded = recordingFallback();
    const onDegraded = vi.fn();
    const pool = new DecodePool({
      fallback: recorded.fallback,
      onDegraded,
    });

    expect(pool.degraded).toBe(true);
    expect(pool.activeWorkers).toBe(0);
    expect(onDegraded).toHaveBeenCalledTimes(1);
    expect(onDegraded).toHaveBeenCalledWith("no worker factory is available");

    const bytes = new ArrayBuffer(16);
    const result = await pool.decode(request("data/a", bytes));
    expect(result).toEqual({
      jobId: 1,
      ok: true,
      value: { json: { id: "data/a" } },
    });
    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]?.jobId).toBe(1);
    expect(recorded.calls[0]?.bytes).toBe(bytes);
    expect(recorded.calls[0]?.url).toBe("data/a.json");
  });

  test("ER-06-08 stamps the request job id onto the fallback result", async () => {
    const pool = new DecodePool({
      fallback: async () => ({ jobId: 999, ok: true, value: { json: null } }),
    });
    const result = await pool.decode(request("data/a"));
    expect(result.jobId).toBe(1);
    expect(result.ok).toBe(true);
  });

  test("ER-06-08 caps fallback decodes at 4 MiB", async () => {
    let fallbackCalls = 0;
    const pool = new DecodePool({
      fallback: async (incoming) => {
        fallbackCalls += 1;
        return { jobId: incoming.jobId, ok: true, value: { json: null } };
      },
    });

    const atCap = await pool.decode(
      request("data/cap", new ArrayBuffer(FALLBACK_MAX_BYTES)),
    );
    expect(atCap.ok).toBe(true);
    expect(fallbackCalls).toBe(1);

    const overCap = await pool.decode(
      request("data/huge", new ArrayBuffer(FALLBACK_MAX_BYTES + 1)),
    );
    expect(overCap.ok).toBe(false);
    expect(overCap.errorCode).toBe("E_WORKER_FAILED");
    expect(overCap.errorMessage).toContain(
      `fallback decode is capped at ${FALLBACK_MAX_BYTES} bytes`,
    );
    expect(fallbackCalls).toBe(1);
  });

  test("ER-06-08 converts fallback errors into failure results", async () => {
    const budget = new DecodePool({
      fallback: async () => {
        throw new AssetEngineError("E_ASSET_BUDGET", "over budget", "data/a");
      },
    });
    const budgetResult = await budget.decode(request("data/a"));
    expect(budgetResult.ok).toBe(false);
    expect(budgetResult.errorCode).toBe("E_ASSET_BUDGET");
    expect(budgetResult.errorMessage).toBe("over budget");

    const plain = new DecodePool({
      fallback: async () => {
        throw new Error("html body");
      },
    });
    const plainResult = await plain.decode(request("data/b"));
    expect(plainResult.errorCode).toBe("E_ASSET_LOAD");
    expect(plainResult.errorMessage).toBe("html body");
  });
});

describe("ER-06-08 worker dispatch", () => {
  test("ER-06-08 creates a worker lazily and transfers the bytes", async () => {
    const { factory, workers } = workerFactory();
    const recorded = recordingFallback();
    const pool = new DecodePool({
      workerFactory: factory,
      fallback: recorded.fallback,
    });
    expect(workers).toHaveLength(0);
    expect(pool.activeWorkers).toBe(0);

    const bytes = new ArrayBuffer(16);
    const job = pool.decode(request("data/a", bytes));
    expect(workers).toHaveLength(1);
    const worker = workerAt(workers, 0);
    expect(pool.activeWorkers).toBe(1);

    const posted = worker.posted[0];
    if (posted === undefined) throw new Error("no message posted");
    expect(posted.message.jobId).toBe(1);
    expect(posted.message.bytes).toBe(bytes);
    expect(posted.transfer).toHaveLength(1);
    expect(posted.transfer?.[0]).toBe(bytes);

    worker.respond(success(1));
    const result = await job;
    expect(result).toEqual(success(1));
    expect(recorded.calls).toHaveLength(0);
  });

  test("ER-06-08 runs at most maxWorkers jobs and pumps the queue", async () => {
    const { factory, workers } = workerFactory();
    const recorded = recordingFallback();
    const pool = new DecodePool({
      maxWorkers: 2,
      workerFactory: factory,
      fallback: recorded.fallback,
    });

    const first = pool.decode(request("data/one"));
    const second = pool.decode(request("data/two"));
    const third = pool.decode(request("data/three"));

    expect(workers).toHaveLength(2);
    expect(pool.activeWorkers).toBe(2);
    expect(workerAt(workers, 0).posted).toHaveLength(1);
    expect(workerAt(workers, 1).posted).toHaveLength(1);

    workerAt(workers, 0).respond(success(1));
    await first;
    // Job 3 moves onto the freed slot instead of creating a third worker.
    expect(workers).toHaveLength(2);
    expect(workerAt(workers, 0).posted).toHaveLength(2);
    expect(workerAt(workers, 0).lastJobId).toBe(3);

    workerAt(workers, 0).respond(success(3));
    workerAt(workers, 1).respond(success(2));
    expect((await second).ok).toBe(true);
    expect((await third).ok).toBe(true);
    expect(recorded.calls).toHaveLength(0);
  });

  test("ER-06-08 caps maxWorkers at the contract maximum", async () => {
    const { factory, workers } = workerFactory();
    const recorded = recordingFallback();
    const pool = new DecodePool({
      maxWorkers: 99,
      workerFactory: factory,
      fallback: recorded.fallback,
    });

    const jobs: Array<Promise<DecodeWorkerResponse>> = [];
    for (let index = 0; index < 6; index += 1) {
      jobs.push(pool.decode(request(`data/job-${index}`)));
    }

    expect(workers).toHaveLength(MAX_DECODE_WORKERS);
    expect(pool.activeWorkers).toBe(MAX_DECODE_WORKERS);
    for (const worker of workers) {
      expect(worker.posted).toHaveLength(1);
    }

    for (const worker of workers) {
      worker.respond(success(worker.lastJobId));
    }
    const restarted = workers.filter((worker) => worker.posted.length > 1);
    expect(restarted).toHaveLength(2);
    for (const worker of restarted) {
      worker.respond(success(worker.lastJobId));
    }

    const results = await Promise.all(jobs);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(recorded.calls).toHaveLength(0);
  });

  test("ER-06-08 clamps a zero maxWorkers to one", () => {
    const { factory, workers } = workerFactory();
    const recorded = recordingFallback();
    const pool = new DecodePool({
      maxWorkers: 0,
      workerFactory: factory,
      fallback: recorded.fallback,
    });

    void pool.decode(request("data/a"));
    void pool.decode(request("data/b"));
    expect(workers).toHaveLength(1);
    expect(pool.activeWorkers).toBe(1);
    expect(workerAt(workers, 0).posted).toHaveLength(1);
    pool.dispose();
  });

  test("ER-06-08 drains boot jobs before queued background jobs", async () => {
    const { factory, workers } = workerFactory();
    const recorded = recordingFallback();
    const pool = new DecodePool({
      maxWorkers: 1,
      workerFactory: factory,
      fallback: recorded.fallback,
    });

    const backgroundOne = pool.decode(request("data/bg-1"));
    const backgroundTwo = pool.decode(request("data/bg-2"));
    const bootOne = pool.decode(request("data/boot-1"), "boot");
    const backgroundThree = pool.decode(request("data/bg-3"), "background");

    const worker = workerAt(workers, 0);
    expect(worker.posted.map((item) => item.message.jobId)).toEqual([1]);

    worker.respond(success(1));
    await backgroundOne;
    expect(worker.posted.map((item) => item.message.jobId)).toEqual([1, 3]);

    worker.respond(success(3));
    await bootOne;
    expect(worker.posted.map((item) => item.message.jobId)).toEqual([1, 3, 2]);

    worker.respond(success(2));
    await backgroundTwo;
    expect(worker.posted.map((item) => item.message.jobId)).toEqual([
      1, 3, 2, 4,
    ]);

    worker.respond(success(4));
    await backgroundThree;
    expect(recorded.calls).toHaveLength(0);
  });

  test("ER-06-08 ignores stale and mismatched worker messages", async () => {
    const { factory, workers } = workerFactory();
    const recorded = recordingFallback();
    const pool = new DecodePool({
      workerFactory: factory,
      fallback: recorded.fallback,
    });

    const job = pool.decode(request("data/a"));
    const worker = workerAt(workers, 0);

    worker.respond(success(99));
    expect(pool.activeWorkers).toBe(1);
    expect(worker.terminateCalls).toBe(0);

    worker.respond(success(1));
    const result = await job;
    expect(result.ok).toBe(true);

    // A late duplicate arrives with no current job; it must be ignored.
    worker.respond(success(1));
    expect(worker.terminateCalls).toBe(0);
    expect(pool.activeWorkers).toBe(1);
  });

  test("ER-06-08 fails and replaces the worker on an invalid message", async () => {
    const { factory, workers } = workerFactory();
    const recorded = recordingFallback();
    const pool = new DecodePool({
      workerFactory: factory,
      fallback: recorded.fallback,
    });

    const first = pool.decode(request("data/a"));
    const worker = workerAt(workers, 0);
    worker.respondRaw({ jobId: 1 });
    const result = await first;
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("E_WORKER_FAILED");
    expect(result.errorMessage).toContain("worker returned an invalid message");
    expect(worker.terminateCalls).toBe(1);
    expect(pool.activeWorkers).toBe(0);
    expect(pool.degraded).toBe(false);

    const second = pool.decode(request("data/b"));
    expect(workers).toHaveLength(2);
    workerAt(workers, 1).respond(success(2));
    expect((await second).ok).toBe(true);
  });
});

describe("ER-06-08 worker failure handling", () => {
  test("ER-06-08 restarts after the first worker failure", async () => {
    const { factory, workers } = workerFactory();
    const recorded = recordingFallback();
    const pool = new DecodePool({
      workerFactory: factory,
      fallback: recorded.fallback,
      now: () => 1_000,
    });

    const first = pool.decode(request("data/first"));
    const second = pool.decode(request("data/second"));
    const firstWorker = workerAt(workers, 0);
    firstWorker.fail();

    const firstResult = await first;
    expect(firstResult.ok).toBe(false);
    expect(firstResult.errorCode).toBe("E_WORKER_FAILED");
    expect(firstResult.errorMessage).toContain("decode worker failed");
    expect(firstResult.errorMessage).toContain("worker error");
    expect(firstWorker.terminateCalls).toBe(1);
    expect(workers).toHaveLength(2);
    expect(pool.degraded).toBe(false);

    const secondWorker = workerAt(workers, 1);
    expect(secondWorker.posted[0]?.message.jobId).toBe(2);
    secondWorker.respond(success(2));
    expect((await second).ok).toBe(true);
  });

  test("ER-06-08 degrades on a second failure inside the restart window", async () => {
    const { factory, workers } = workerFactory();
    const recorded = recordingFallback();
    const onDegraded = vi.fn();
    const pool = new DecodePool({
      workerFactory: factory,
      fallback: recorded.fallback,
      now: () => 5_000,
      onDegraded,
    });

    const first = pool.decode(request("data/first"));
    const second = pool.decode(request("data/second"));
    const third = pool.decode(request("data/third"));

    workerAt(workers, 0).fail();
    await first;
    expect(workers).toHaveLength(2);
    expect(workerAt(workers, 1).lastJobId).toBe(2);

    workerAt(workers, 1).fail();
    const secondResult = await second;
    expect(secondResult.errorCode).toBe("E_WORKER_FAILED");

    const reason = `worker failed twice inside ${WORKER_RESTART_WINDOW_MS} ms`;
    expect(pool.degraded).toBe(true);
    expect(pool.activeWorkers).toBe(0);
    expect(onDegraded).toHaveBeenCalledTimes(1);
    expect(onDegraded).toHaveBeenCalledWith(reason);

    const thirdResult = await third;
    expect(thirdResult.ok).toBe(true);
    expect(recorded.calls.map((call) => call.id)).toEqual(["data/third"]);

    // Every later job goes straight to the fallback, with no new worker.
    const later = await pool.decode(request("data/later"));
    expect(later.ok).toBe(true);
    expect(recorded.calls).toHaveLength(2);
    expect(workers).toHaveLength(2);
    expect(onDegraded).toHaveBeenCalledTimes(1);
  });

  test("ER-06-08 degrades when the worker factory throws", async () => {
    let attempts = 0;
    const recorded = recordingFallback();
    const onDegraded = vi.fn();
    const pool = new DecodePool({
      workerFactory: () => {
        attempts += 1;
        throw new Error("no workers here");
      },
      fallback: recorded.fallback,
      onDegraded,
    });
    expect(pool.degraded).toBe(false);

    const result = await pool.decode(request("data/a"));
    expect(result.ok).toBe(true);
    expect(pool.degraded).toBe(true);
    expect(pool.activeWorkers).toBe(0);
    expect(attempts).toBe(1);
    expect(onDegraded).toHaveBeenCalledWith("worker creation failed");
    expect(recorded.calls).toHaveLength(1);
  });

  test("ER-06-08 fails the job when postMessage throws", async () => {
    const workers: FakeWorker[] = [];
    const recorded = recordingFallback();
    const pool = new DecodePool({
      workerFactory: () => {
        const worker = new FakeWorker();
        if (workers.length === 0) worker.postError = new Error("closed");
        workers.push(worker);
        return worker;
      },
      fallback: recorded.fallback,
    });

    const first = await pool.decode(request("data/a"));
    expect(first.ok).toBe(false);
    expect(first.errorCode).toBe("E_WORKER_FAILED");
    expect(first.errorMessage).toContain("postMessage failed");
    expect(workerAt(workers, 0).terminateCalls).toBe(1);
    expect(pool.activeWorkers).toBe(0);

    const second = pool.decode(request("data/b"));
    expect(workers).toHaveLength(2);
    workerAt(workers, 1).respond(success(2));
    expect((await second).ok).toBe(true);
  });

  test("ER-06-08 times out a silent worker and replaces it", async () => {
    const { factory, workers } = workerFactory();
    const recorded = recordingFallback();
    const pool = new DecodePool({
      workerFactory: factory,
      fallback: recorded.fallback,
      timeoutMs: 20,
    });

    const first = await pool.decode(request("data/slow"));
    expect(first.ok).toBe(false);
    expect(first.errorCode).toBe("E_WORKER_FAILED");
    expect(first.errorMessage).toContain("decode timed out");
    expect(workerAt(workers, 0).terminateCalls).toBe(1);
    expect(pool.activeWorkers).toBe(0);
    expect(pool.degraded).toBe(false);

    const second = pool.decode(request("data/next"));
    expect(workers).toHaveLength(2);
    workerAt(workers, 1).respond(success(2));
    expect((await second).ok).toBe(true);
  });
});

describe("ER-06-08 dispose", () => {
  test("ER-06-08 aborts queued and in-flight jobs and is idempotent", async () => {
    const { factory, workers } = workerFactory();
    const recorded = recordingFallback();
    const pool = new DecodePool({
      workerFactory: factory,
      fallback: recorded.fallback,
    });

    const first = pool.decode(request("data/a"));
    const second = pool.decode(request("data/b"));
    expect(pool.activeWorkers).toBe(1);

    pool.dispose();
    const results = await Promise.all([first, second]);
    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("E_ASSET_ABORTED");
      expect(result.errorMessage).toContain("decode pool is disposed");
    }
    expect(workerAt(workers, 0).terminateCalls).toBe(1);
    expect(pool.activeWorkers).toBe(0);
    expect(recorded.calls).toHaveLength(0);

    expect(() => pool.dispose()).not.toThrow();
    expect(workers).toHaveLength(1);

    const later = await pool.decode(request("data/c"));
    expect(later.ok).toBe(false);
    expect(later.errorCode).toBe("E_ASSET_ABORTED");
    expect(workerAt(workers, 0).posted).toHaveLength(1);
  });
});

describe("ER-06-08 worker protocol", () => {
  test("ER-06-08 isDecodeResult accepts only jobId and ok", () => {
    expect(isDecodeResult({ jobId: 1, ok: true })).toBe(true);
    expect(
      isDecodeResult({ jobId: 2, ok: false, errorCode: "E_ASSET_FORMAT" }),
    ).toBe(true);
    expect(isDecodeResult(null)).toBe(false);
    expect(isDecodeResult(undefined)).toBe(false);
    expect(isDecodeResult({})).toBe(false);
    expect(isDecodeResult({ jobId: 1.5, ok: true })).toBe(false);
    expect(isDecodeResult({ jobId: "1", ok: true })).toBe(false);
    expect(isDecodeResult({ jobId: 1, ok: "yes" })).toBe(false);
    expect(isDecodeResult([])).toBe(false);
  });

  test("ER-06-08 transfers the request bytes", () => {
    const bytes = new ArrayBuffer(8);
    const transfer = decodeRequestTransfer({
      jobId: 4,
      id: "data/a",
      kind: "json",
      url: "data/a.json",
      bytes,
    });
    expect(transfer).toHaveLength(1);
    expect(transfer[0]).toBe(bytes);
  });

  test("ER-06-08 builds success results and errors", () => {
    const mesh = decodeGlb("meshes/tri", buildTriangleGlb()).mesh;
    const meshResult = decodeResultFromOutcome(7, {
      value: mesh,
      droppedAttributes: 1,
    });
    expect(meshResult.jobId).toBe(7);
    expect(meshResult.ok).toBe(true);
    expect(meshResult.value).toBe(mesh);
    expect(meshResult.droppedAttributes).toBe(1);
    expect(meshResult.gpuBytes).toBeUndefined();

    const texture = decodeKtx2({
      id: "textures/t",
      bytes: buildKtx2({ vkFormat: 43, width: 2, height: 2 }),
    });
    const textureResult = decodeResultFromOutcome(8, { value: texture });
    expect(textureResult.gpuBytes).toBe(texture.gpuBytes);
    expect(textureResult.gpuBytes).toBe(512);

    const typed = decodeResultError(
      {
        jobId: 1,
        ok: false,
        errorCode: "E_ASSET_FORMAT",
        errorMessage: "bad bytes",
      },
      "data/a",
    );
    expectCode(typed, "E_ASSET_FORMAT");
    expect(typed.message).toBe("bad bytes");
    expect(typed.id).toBe("data/a");

    const generic = decodeResultError({ jobId: 2, ok: false }, "data/b");
    expectCode(generic, "E_WORKER_FAILED");
    expect(generic.message).toBe("data/b: decode failed");
  });

  test("ER-06-08 lists every transferred buffer per asset kind", () => {
    const mesh = decodeGlb("meshes/tri", buildTriangleGlb()).mesh;
    const meshBuffers = transferablesForValue("mesh", mesh);
    const primitive = mesh.primitives[0];
    if (primitive === undefined) throw new Error("missing primitive");
    expect(meshBuffers).toHaveLength(2);
    expect(meshBuffers).toContain(primitive.vertices.buffer);
    expect(meshBuffers).toContain(primitive.indices.buffer);

    const texture = decodeKtx2({
      id: "textures/t",
      bytes: buildKtx2({ vkFormat: 37, width: 2, height: 2 }),
    });
    const textureBuffers = transferablesForValue("texture", texture);
    expect(textureBuffers).toHaveLength(texture.levels.length);
    expect(textureBuffers[0]).toBe(texture.levels[0]?.bytes.buffer);

    const audio = decodeAudio({
      id: "audio/a",
      url: "audio/a.ogg",
      bytes: buildAudio("ogg"),
    });
    if (audio.kind !== "encoded") throw new Error("expected encoded audio");
    const audioBuffers = transferablesForValue("audio", audio);
    expect(audioBuffers).toHaveLength(1);
    expect(audioBuffers[0]).toBe(audio.bytes);

    const font = decodeFont({ id: "fonts/ui", bytes: buildWoff2() });
    if (font.kind !== "woff2") throw new Error("expected WOFF2");
    const fontBuffers = transferablesForValue("font", font);
    expect(fontBuffers).toHaveLength(1);
    expect(fontBuffers[0]).toBe(font.bytes);

    const json = decodeJson({ id: "data/a", bytes: textBytes('{"a":1}') });
    expect(transferablesForValue("json", json)).toEqual([]);
  });
});
