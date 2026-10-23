/**
 * Decode worker pool (06 §5.6).
 *
 * Workers are created lazily, at most `maxWorkers`, and each runs one job at
 * a time. A missing factory, a failed worker or a second failure inside the
 * restart window puts the pool in degraded mode: every later job decodes on
 * the main thread through the injected `fallback`, capped at 4 MiB.
 */

import type { WorkerLike } from "../contracts/assets.js";
import {
  decodeFailureResult,
  decodePoolFailure,
  decodeRequestTransfer,
  isDecodeResult,
  type DecodeWorkerRequest,
  type DecodeWorkerResponse,
} from "./protocol.js";

export const MAX_DECODE_WORKERS = 4;
export const DEFAULT_DECODE_JOB_TIMEOUT_MS = 30_000;
export const WORKER_RESTART_WINDOW_MS = 10_000;
export const FALLBACK_MAX_BYTES = 4_194_304;

export type DecodePriority = "boot" | "background";

export type DecodeFallback = (
  request: DecodeWorkerRequest,
) => Promise<DecodeWorkerResponse>;

export interface DecodePoolOptions {
  /** Capped at 4; defaults to 1. */
  readonly maxWorkers?: number;
  /** Absent means no worker is available and decode falls back. */
  readonly workerFactory?: () => WorkerLike;
  readonly timeoutMs?: number;
  readonly fallback: DecodeFallback;
  readonly now?: () => number;
  /** Called once when the pool first degrades. */
  readonly onDegraded?: (reason: string) => void;
}

interface Slot {
  readonly worker: WorkerLike;
  current: PendingJob | null;
}

interface PendingJob {
  readonly request: DecodeWorkerRequest;
  readonly priority: DecodePriority;
  readonly resolve: (result: DecodeWorkerResponse) => void;
  slot: Slot | null;
  timer: ReturnType<typeof setTimeout> | null;
}

function failureFor(
  request: DecodeWorkerRequest,
  code: "E_WORKER_FAILED" | "E_ASSET_ABORTED",
  reason: string,
): DecodeWorkerResponse {
  return decodePoolFailure(request.jobId, code, `${request.id}: ${reason}`);
}

/**
 * Default production factory. It returns undefined outside a browser with
 * module workers; the pool then degrades instead of failing the load.
 */
export function createModuleWorkerFactory(): (() => WorkerLike) | undefined {
  if (typeof Worker === "undefined") return undefined;
  return () =>
    new Worker(new URL("./decode.worker.js", import.meta.url), {
      type: "module",
    }) as unknown as WorkerLike;
}

export class DecodePool {
  private readonly maxWorkers: number;
  private readonly factory: (() => WorkerLike) | undefined;
  private readonly timeoutMs: number;
  private readonly fallback: DecodeFallback;
  private readonly now: () => number;
  private readonly onDegraded: ((reason: string) => void) | undefined;

  private readonly slots: Slot[] = [];
  private readonly bootQueue: PendingJob[] = [];
  private readonly backgroundQueue: PendingJob[] = [];
  private nextJobId = 1;
  private lastWorkerFailureAt = Number.NEGATIVE_INFINITY;
  private degradedFlag = false;
  private disposed = false;

  constructor(options: DecodePoolOptions) {
    const requested = options.maxWorkers ?? 1;
    this.maxWorkers = Math.max(
      1,
      Math.min(MAX_DECODE_WORKERS, Math.floor(requested)),
    );
    this.factory = options.workerFactory;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_DECODE_JOB_TIMEOUT_MS;
    this.fallback = options.fallback;
    this.now = options.now ?? (() => Date.now());
    this.onDegraded = options.onDegraded;
    if (this.factory === undefined) {
      this.degrade("no worker factory is available");
    }
  }

  get degraded(): boolean {
    return this.degradedFlag;
  }

  get activeWorkers(): number {
    return this.slots.length;
  }

  private degrade(reason: string): void {
    if (this.degradedFlag) return;
    this.degradedFlag = true;
    this.onDegraded?.(reason);
  }

  /** Runs one decode. Never rejects; failures are result objects. */
  decode(
    request: Omit<DecodeWorkerRequest, "jobId">,
    priority: DecodePriority = "background",
  ): Promise<DecodeWorkerResponse> {
    const withId: DecodeWorkerRequest = {
      ...request,
      jobId: this.nextJobId,
    };
    this.nextJobId += 1;
    if (this.disposed) {
      return Promise.resolve(
        failureFor(withId, "E_ASSET_ABORTED", "the decode pool is disposed"),
      );
    }
    if (this.degradedFlag) return this.runFallback(withId);

    return new Promise<DecodeWorkerResponse>((resolve) => {
      const job: PendingJob = {
        request: withId,
        priority,
        resolve,
        slot: null,
        timer: null,
      };
      if (priority === "boot") this.bootQueue.push(job);
      else this.backgroundQueue.push(job);
      this.pump();
    });
  }

  private async runFallback(
    request: DecodeWorkerRequest,
  ): Promise<DecodeWorkerResponse> {
    if (request.bytes.byteLength > FALLBACK_MAX_BYTES) {
      return failureFor(
        request,
        "E_WORKER_FAILED",
        `fallback decode is capped at ${FALLBACK_MAX_BYTES} bytes`,
      );
    }
    try {
      const result = await this.fallback(request);
      return { ...result, jobId: request.jobId };
    } catch (error) {
      return decodeFailureResult(request.jobId, request.id, error);
    }
  }

  private takeJob(): PendingJob | undefined {
    const boot = this.bootQueue.shift();
    if (boot !== undefined) return boot;
    return this.backgroundQueue.shift();
  }

  private freeSlot(): Slot | undefined {
    for (const slot of this.slots) {
      if (slot.current === null) return slot;
    }
    return undefined;
  }

  private createSlot(): Slot | undefined {
    const factory = this.factory;
    if (factory === undefined || this.degradedFlag) return undefined;
    try {
      const worker = factory();
      const slot: Slot = { worker, current: null };
      worker.onmessage = (event) => this.onWorkerMessage(slot, event.data);
      worker.onerror = () => this.onWorkerFailure(slot, "worker error");
      worker.onmessageerror = () =>
        this.onWorkerFailure(slot, "worker message error");
      this.slots.push(slot);
      return slot;
    } catch {
      this.degrade("worker creation failed");
      return undefined;
    }
  }

  private pump(): void {
    if (this.disposed) return;
    for (;;) {
      if (this.bootQueue.length === 0 && this.backgroundQueue.length === 0) {
        return;
      }
      let slot = this.freeSlot();
      if (slot === undefined && this.slots.length < this.maxWorkers) {
        slot = this.createSlot();
      }
      if (slot === undefined) {
        if (this.degradedFlag) this.flushToFallback();
        return;
      }
      const job = this.takeJob();
      if (job === undefined) return;
      this.startJob(slot, job);
    }
  }

  private startJob(slot: Slot, job: PendingJob): void {
    slot.current = job;
    job.slot = slot;
    job.timer = setTimeout(() => this.onJobTimeout(job), this.timeoutMs);
    try {
      slot.worker.postMessage(job.request, decodeRequestTransfer(job.request));
    } catch {
      this.onWorkerFailure(slot, "postMessage failed");
    }
  }

  private onJobTimeout(job: PendingJob): void {
    if (job.timer !== null) {
      clearTimeout(job.timer);
      job.timer = null;
    }
    const slot = job.slot;
    job.slot = null;
    job.resolve(failureFor(job.request, "E_WORKER_FAILED", "decode timed out"));
    if (slot !== null) {
      slot.current = null;
      this.terminateSlot(slot);
      this.pump();
    }
  }

  private onWorkerMessage(slot: Slot, data: unknown): void {
    if (!isDecodeResult(data)) {
      this.onWorkerFailure(slot, "worker returned an invalid message");
      return;
    }
    const job = slot.current;
    if (job === null || data.jobId !== job.request.jobId) return;
    this.finishJob(job);
    job.resolve(data);
    this.pump();
  }

  private finishJob(job: PendingJob): void {
    if (job.timer !== null) {
      clearTimeout(job.timer);
      job.timer = null;
    }
    const slot = job.slot;
    job.slot = null;
    if (slot !== null && slot.current === job) slot.current = null;
  }

  private onWorkerFailure(slot: Slot, reason: string): void {
    const job = slot.current;
    if (job !== null) {
      this.finishJob(job);
      job.resolve(
        failureFor(
          job.request,
          "E_WORKER_FAILED",
          `decode worker failed: ${reason}`,
        ),
      );
    }
    this.terminateSlot(slot);

    const failureAt = this.now();
    if (failureAt - this.lastWorkerFailureAt < WORKER_RESTART_WINDOW_MS) {
      this.degrade(`worker failed twice inside ${WORKER_RESTART_WINDOW_MS} ms`);
      this.flushToFallback();
      return;
    }
    this.lastWorkerFailureAt = failureAt;
    this.pump();
  }

  private terminateSlot(slot: Slot): void {
    const index = this.slots.indexOf(slot);
    if (index >= 0) this.slots.splice(index, 1);
    slot.current = null;
    slot.worker.onmessage = null;
    slot.worker.onerror = null;
    slot.worker.onmessageerror = null;
    try {
      slot.worker.terminate();
    } catch {
      // Termination is best-effort; the slot is already forgotten.
    }
  }

  private flushToFallback(): void {
    const jobs = [...this.bootQueue, ...this.backgroundQueue];
    this.bootQueue.length = 0;
    this.backgroundQueue.length = 0;
    for (const job of jobs) {
      void this.runFallback(job.request).then(job.resolve);
    }
  }

  /** Aborts in-flight and queued jobs, then terminates every worker. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const job of [...this.bootQueue, ...this.backgroundQueue]) {
      this.finishJob(job);
      job.resolve(
        failureFor(job.request, "E_ASSET_ABORTED", "the decode pool is disposed"),
      );
    }
    this.bootQueue.length = 0;
    this.backgroundQueue.length = 0;
    for (const slot of [...this.slots]) {
      const job = slot.current;
      if (job !== null) {
        this.finishJob(job);
        job.resolve(
          failureFor(
            job.request,
            "E_ASSET_ABORTED",
            "the decode pool is disposed",
          ),
        );
      }
      this.terminateSlot(slot);
    }
  }
}
