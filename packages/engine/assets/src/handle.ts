/**
 * Reference-counted handle implementation (06 §4.1, §5.2).
 *
 * One `AssetRecord` per manifest id is shared by every handle. `load` gives
 * the caller one reference; `get` returns a borrowed handle with zero
 * references. The library never owns a handle, so `trim` can only free a
 * value when the record's refcount is 0.
 */

import type {
  AssetFailure,
  AssetHandle,
  AssetKind,
  AssetState,
} from "./contracts/assets.js";
import { assetError } from "./errors.js";

/** In-process dev checks; a production bundler may replace this with false. */
export const DEV_CHECKS: boolean = (() => {
  const proc = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process;
  return proc?.env?.NODE_ENV !== "production";
})();

export interface AssetRecord {
  readonly id: string;
  readonly kind: AssetKind;
  state: AssetState;
  value: unknown;
  /** CPU decoded bytes charged to the decoded ledger. */
  bytes: number;
  /** Planned GPU bytes charged to the texture ledger. */
  textureGpuBytes: number;
  failed: AssetFailure | null;
  revision: number;
  refcount: number;
  /** LRU stamp: last `value` read or load completion, whichever is later. */
  lastUsed: number;
  /** Member of the initial boot set; evicted last. */
  pinned: boolean;
}

export function createRecord(
  id: string,
  kind: AssetKind,
  pinned: boolean,
): AssetRecord {
  return {
    id,
    kind,
    state: "queued",
    value: undefined,
    bytes: 0,
    textureGpuBytes: 0,
    failed: null,
    revision: 1,
    refcount: 0,
    lastUsed: 0,
    pinned,
  };
}

export function markLoading(record: AssetRecord): void {
  record.state = "loading";
}

export function markReady(
  record: AssetRecord,
  value: unknown,
  bytes: number,
  textureGpuBytes: number,
  now: number,
): void {
  record.state = "ready";
  record.value = value;
  record.bytes = bytes;
  record.textureGpuBytes = textureGpuBytes;
  record.failed = null;
  record.lastUsed = now;
}

export function markFailed(record: AssetRecord, failure: AssetFailure): void {
  record.state = "failed";
  record.value = undefined;
  record.bytes = 0;
  record.textureGpuBytes = 0;
  record.failed = failure;
}

export function markDisposed(record: AssetRecord): void {
  record.state = "disposed";
  record.value = undefined;
  record.bytes = 0;
  record.textureGpuBytes = 0;
  record.failed = null;
}

/** Owner callbacks the handle uses; the library implements these. */
export interface HandleOwner {
  touch(record: AssetRecord): void;
  /** Called when the record's refcount reaches 0. */
  onRefcountZero(record: AssetRecord): void;
}

/**
 * Concrete `AssetHandle`. `ownedCount` counts the references this exact
 * handle object holds; two `retain()` calls need two `release()` calls.
 */
export class AssetHandleImpl<T> implements AssetHandle<T> {
  private readonly record: AssetRecord;
  private readonly owner: HandleOwner;
  private readonly borrowed: boolean;
  private ownedCount: number;

  constructor(
    record: AssetRecord,
    owner: HandleOwner,
    borrowed: boolean,
    initialOwnedCount: number,
  ) {
    this.record = record;
    this.owner = owner;
    this.borrowed = borrowed;
    this.ownedCount = initialOwnedCount;
  }

  get id(): string {
    return this.record.id;
  }

  get kind(): AssetKind {
    return this.record.kind;
  }

  get state(): AssetState {
    return this.record.state;
  }

  get value(): T {
    if (this.record.state === "ready") {
      this.owner.touch(this.record);
      return this.record.value as T;
    }
    if (this.record.state === "disposed") {
      throw assetError(
        this.borrowed ? "E_ASSET_EVICTED" : "E_STALE_HANDLE",
        `${this.record.id}: the asset value is no longer available`,
        this.record.id,
      );
    }
    throw assetError(
      "E_ASSET_NOT_READY",
      `${this.record.id}: value is not ready (state ${this.record.state})`,
      this.record.id,
    );
  }

  retain(): AssetHandle<T> {
    if (this.record.state === "disposed" || this.ownedCount < 0) {
      if (DEV_CHECKS) {
        throw assetError(
          "E_STALE_HANDLE",
          `${this.record.id}: retain() on a disposed handle`,
          this.record.id,
        );
      }
      return this;
    }
    this.ownedCount += 1;
    this.record.refcount += 1;
    return this;
  }

  release(): void {
    if (this.record.state === "disposed") {
      if (DEV_CHECKS) {
        throw assetError(
          "E_STALE_HANDLE",
          `${this.record.id}: release() on a disposed handle`,
          this.record.id,
        );
      }
      return;
    }
    if (this.ownedCount <= 0) {
      if (DEV_CHECKS) {
        throw assetError(
          "E_STALE_HANDLE",
          `${this.record.id}: release() below zero references`,
          this.record.id,
        );
      }
      return;
    }
    this.ownedCount -= 1;
    this.record.refcount = Math.max(0, this.record.refcount - 1);
    if (this.record.refcount === 0) this.owner.onRefcountZero(this.record);
  }

  get revision(): number {
    return this.record.revision;
  }

  get bytes(): number {
    return this.record.bytes;
  }

  get textureGpuBytes(): number {
    return this.record.textureGpuBytes;
  }

  get failed(): AssetFailure | null {
    return this.record.failed;
  }
}

/** Handle for a value the caller owns `references` times. */
export function createHandle<T>(
  record: AssetRecord,
  owner: HandleOwner,
  references: number,
): AssetHandle<T> {
  if (references > 0) record.refcount += references;
  return new AssetHandleImpl<T>(record, owner, false, references);
}

/** Borrowed handle from `get`, holding no reference. */
export function createBorrowedHandle<T>(
  record: AssetRecord,
  owner: HandleOwner,
): AssetHandle<T> {
  return new AssetHandleImpl<T>(record, owner, true, 0);
}
