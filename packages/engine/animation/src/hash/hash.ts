/**
 * Canonical FNV-1a 32 state hasher (spec 08 §4.6).
 *
 * Writes a little-endian stream through a reusable DataView in chunks of at
 * most 64 KiB. `stateHash()` allocates one of these per call; `update` never
 * touches it. Hash input is limited to f32 written values, so the result is
 * exact for stored poses.
 */

import { ANIMATION_HASH_CHUNK_BYTES } from "../version.js";

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export class StateHasher {
  private readonly view: DataView;
  private readonly capacity: number;
  private offset = 0;
  private hash = FNV_OFFSET_BASIS >>> 0;

  constructor(capacity = ANIMATION_HASH_CHUNK_BYTES) {
    if (capacity < 16 || capacity % 4 !== 0) {
      throw new Error("StateHasher: capacity must be a multiple of 4, >= 16");
    }
    this.capacity = capacity;
    this.view = new DataView(new ArrayBuffer(capacity));
  }

  u8(value: number): void {
    this.ensure(1);
    this.view.setUint8(this.offset, value);
    this.offset += 1;
  }

  u32(value: number): void {
    this.ensure(4);
    this.view.setUint32(this.offset, value >>> 0, true);
    this.offset += 4;
  }

  i32(value: number): void {
    this.ensure(4);
    this.view.setInt32(this.offset, value | 0, true);
    this.offset += 4;
  }

  f32(value: number): void {
    this.ensure(4);
    this.view.setFloat32(this.offset, value, true);
    this.offset += 4;
  }

  finish(): number {
    this.flush();
    return this.hash >>> 0;
  }

  private ensure(bytes: number): void {
    if (this.offset + bytes > this.capacity) {
      this.flush();
    }
  }

  private flush(): void {
    let h = this.hash;
    for (let i = 0; i < this.offset; i += 1) {
      h ^= this.view.getUint8(i);
      h = Math.imul(h, FNV_PRIME) >>> 0;
    }
    this.hash = h;
    this.offset = 0;
  }
}

/** FNV-1a 32 of a clip/event name in UTF-8 bytes. */
export function fnv1aString(value: string): number {
  const bytes = new TextEncoder().encode(value);
  let h = FNV_OFFSET_BASIS >>> 0;
  for (let i = 0; i < bytes.length; i += 1) {
    h ^= bytes[i]!;
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h >>> 0;
}
