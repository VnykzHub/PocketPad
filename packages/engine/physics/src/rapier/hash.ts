/**
 * Canonical state-hash writer (07 §4.3).
 *
 * FNV-1a 32 over a little-endian byte stream, emitted through one reusable
 * 64 KiB scratch buffer. The hasher is called on demand by `stateHash()`,
 * never per step.
 */
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const SCRATCH_BYTES = 65536;

export class StateHasher {
  private readonly buffer: ArrayBuffer;
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  private offset = 0;
  private hash = FNV_OFFSET_BASIS;

  constructor() {
    this.buffer = new ArrayBuffer(SCRATCH_BYTES);
    this.view = new DataView(this.buffer);
    this.bytes = new Uint8Array(this.buffer);
  }

  reset(): void {
    this.offset = 0;
    this.hash = FNV_OFFSET_BASIS;
  }

  u32(value: number): void {
    if (this.offset + 4 > SCRATCH_BYTES) this.flush();
    this.view.setUint32(this.offset, value >>> 0, true);
    this.offset += 4;
  }

  f64(value: number): void {
    if (this.offset + 8 > SCRATCH_BYTES) this.flush();
    this.view.setFloat64(this.offset, value, true);
    this.offset += 8;
  }

  finish(): number {
    this.flush();
    return this.hash >>> 0;
  }

  private flush(): void {
    let hash = this.hash;
    const bytes = this.bytes;
    for (let i = 0; i < this.offset; i += 1) {
      hash ^= bytes[i]!;
      hash = Math.imul(hash, FNV_PRIME);
    }
    this.hash = hash >>> 0;
    this.offset = 0;
  }
}
