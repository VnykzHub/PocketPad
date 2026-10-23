/**
 * CPU-side dynamic uniform ring (04 §5.7). The ring never allocates after
 * construction; every object gets a 256-byte aligned dynamic offset.
 */

import { OBJECT_UNIFORM_BYTES } from "../abi.js";

const DEFAULT_OBJECT_RING_BYTES = 2 * 1024 * 1024;

export class UniformRing {
  readonly capacityBytes: number;
  readonly strideBytes: number;
  private usedBytes = 0;

  constructor(capacityBytes = DEFAULT_OBJECT_RING_BYTES, alignment = 256) {
    this.capacityBytes = Math.max(256, Math.floor(capacityBytes));
    // Dynamic uniform offsets must satisfy adapter alignment and ABI 256 B.
    const required = Math.max(256, Math.floor(alignment));
    this.strideBytes = Math.ceil(required / 256) * 256;
  }

  reset(): void {
    this.usedBytes = 0;
  }

  /** Returns -1 when the ring has no room for one object. */
  allocate(): number {
    if (this.usedBytes + OBJECT_UNIFORM_BYTES > this.capacityBytes) {
      return -1;
    }
    const offset = this.usedBytes;
    this.usedBytes += this.strideBytes;
    return offset;
  }

  get used(): number {
    return this.usedBytes;
  }

  get remaining(): number {
    return Math.max(0, this.capacityBytes - this.usedBytes);
  }
}

export const OBJECT_RING_CAPACITY_BYTES = DEFAULT_OBJECT_RING_BYTES;
export const MAX_OBJECTS_PER_FRAME =
  DEFAULT_OBJECT_RING_BYTES / OBJECT_UNIFORM_BYTES;
