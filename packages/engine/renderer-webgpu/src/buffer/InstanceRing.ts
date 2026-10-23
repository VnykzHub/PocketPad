/**
 * CPU-side instance ring (04 §5.16). A batch larger than the remaining ring is
 * split; the caller emits one draw per split. A full ring drops the remainder
 * and increments `droppedDraws`.
 */

import { INSTANCE_STRIDE_BYTES } from "../abi.js";

export const INSTANCE_RING_CAPACITY_BYTES = 4 * 1024 * 1024;
export const MAX_INSTANCES_PER_FRAME =
  INSTANCE_RING_CAPACITY_BYTES / INSTANCE_STRIDE_BYTES;

export class InstanceRing {
  readonly capacityBytes: number;
  readonly strideBytes: number;
  private usedBytes = 0;

  constructor(capacityBytes = INSTANCE_RING_CAPACITY_BYTES) {
    this.capacityBytes = Math.max(
      INSTANCE_STRIDE_BYTES,
      Math.floor(capacityBytes),
    );
    this.strideBytes = INSTANCE_STRIDE_BYTES;
  }

  reset(): void {
    this.usedBytes = 0;
  }

  /**
   * Reserves as many instances as fit. Returns the accepted count and writes
   * the byte offset through `writeOffset`. A count of 0 means full.
   */
  allocate(count: number, writeOffset: { value: number }): number {
    const requested = Math.max(0, Math.floor(count));
    const available = Math.floor(
      (this.capacityBytes - this.usedBytes) / this.strideBytes,
    );
    const accepted = Math.min(requested, available);
    writeOffset.value = this.usedBytes;
    this.usedBytes += accepted * this.strideBytes;
    return accepted;
  }

  get used(): number {
    return this.usedBytes;
  }

  get remainingInstances(): number {
    return Math.floor(
      (this.capacityBytes - this.usedBytes) / this.strideBytes,
    );
  }
}
