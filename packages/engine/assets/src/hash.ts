/**
 * FNV-1a 32 over exact response bytes (06 §5.8).
 *
 * Basis `0x811c9dc5`, prime `0x01000193`, matching world streaming and the
 * save header. Hashing is a one-shot helper, never part of a frame path.
 */

export const FNV1A32_OFFSET_BASIS = 0x811c9dc5;
export const FNV1A32_PRIME = 0x01000193;

function asBytes(source: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
}

export function fnv1a32(source: ArrayBuffer | ArrayBufferView): number {
  const bytes = asBytes(source);
  let hash = FNV1A32_OFFSET_BASIS;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    hash = Math.imul(hash ^ byte, FNV1A32_PRIME);
  }
  return hash >>> 0;
}

export function fnv1a32Hex(source: ArrayBuffer | ArrayBufferView): string {
  const hex = fnv1a32(source).toString(16).padStart(8, "0");
  return `fnv1a32:${hex}`;
}

export function verifyFnv1a32(
  source: ArrayBuffer | ArrayBufferView,
  expected: string,
): boolean {
  return fnv1a32Hex(source) === expected;
}
