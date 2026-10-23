/**
 * Decoded-buffer registry and budget accounting (spec 09 §4.1, ER-09-12).
 *
 * Decoded audio is charged as `length * numberOfChannels * 4` bytes — the
 * float32 backing storage. Exceeding `decodeBudgetBytes` fails **that**
 * registration with `E_AUDIO_BUDGET` and leaves the previous buffer loaded.
 * Streamed audio never passes through this registry and is not counted.
 */

import type { AudioBufferLike } from "../contracts/audio.js";
import { AUDIO_BYTES_PER_SAMPLE } from "../version.js";

export type RegisterResult = "ok" | "budget" | "disabled";

interface Entry {
  readonly buffer: AudioBufferLike;
  readonly bytes: number;
}

/** Bytes charged for one decoded buffer; non-finite shape → 0. */
export function bufferByteSize(buffer: AudioBufferLike): number {
  const length = buffer.length;
  const channels = buffer.numberOfChannels;
  if (!Number.isFinite(length) || !Number.isFinite(channels)) return 0;
  if (length <= 0 || channels <= 0) return 0;
  return length * channels * AUDIO_BYTES_PER_SAMPLE;
}

export class DecodedBufferRegistry {
  private readonly budget: number;
  private readonly entries = new Map<string, Entry>();
  private usedBytes = 0;

  constructor(budgetBytes: number) {
    this.budget = Number.isFinite(budgetBytes) && budgetBytes > 0 ? budgetBytes : 0;
  }

  get budgetBytes(): number {
    return this.budget;
  }

  get bytes(): number {
    return this.usedBytes;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  get(id: string): AudioBufferLike | undefined {
    return this.entries.get(id)?.buffer;
  }

  /**
   * 0 disables decoding entirely: every non-empty buffer is rejected. A
   * duplicate id replaces the buffer only when the new total fits the budget.
   */
  register(id: string, buffer: AudioBufferLike): RegisterResult {
    const bytes = bufferByteSize(buffer);
    if (this.budget === 0 && bytes > 0) return "disabled";

    const previous = this.entries.get(id);
    const nextBytes = this.usedBytes - (previous?.bytes ?? 0) + bytes;
    if (nextBytes > this.budget) return "budget";

    if (previous !== undefined) {
      this.usedBytes -= previous.bytes;
    }
    this.entries.set(id, { buffer, bytes });
    this.usedBytes += bytes;
    return "ok";
  }

  /** No-op for an unknown id (09 §4.1). */
  release(id: string): boolean {
    const entry = this.entries.get(id);
    if (entry === undefined) return false;
    this.entries.delete(id);
    this.usedBytes -= entry.bytes;
    return true;
  }

  clear(): void {
    this.entries.clear();
    this.usedBytes = 0;
  }
}
