/**
 * Token and PIN primitives (D4-SRV-01).
 *
 * Entropy is injected so room/session/host tokens and PINs are deterministic
 * in tests and load simulations; production callers pass `crypto.randomBytes`.
 * Nothing in this module logs (SR-9): tokens and PINs are secrets and must
 * never reach a logger, a URL or a message body.
 */
import { timingSafeEqual } from "node:crypto";
import { ROOM_PIN_LENGTH, TOKEN_BYTES } from "@lanpad/protocol";

/** Fixed 32-byte buffer compared on the unequal-length path (SR-1). */
const DUMMY = new Uint8Array(32);

/** Two bytes are drawn for a PIN; six complete 0..9999 cycles fit in 65536. */
const PIN_DRAW_LIMIT = 6 * 10 ** ROOM_PIN_LENGTH;

/** Bounded so a broken entropy source fails loudly instead of spinning. */
const MAX_PIN_ATTEMPTS = 64;

/**
 * Generates a 128-bit room/session/host token as 22 base64url characters
 * (SR-1). The same generator serves every token class; never derive one token
 * from another.
 */
export function generateToken(randomBytes: (n: number) => Uint8Array): string {
  const bytes = randomBytes(TOKEN_BYTES);
  if (bytes.byteLength !== TOKEN_BYTES) {
    throw new Error(`randomBytes returned ${bytes.byteLength} bytes; expected ${TOKEN_BYTES}`);
  }
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Constant-time credential comparison (SR-1).
 *
 * Lengths are public (22-char tokens, 4-digit PINs), but a mismatched length
 * still runs a fixed dummy compare so the failure path never short-circuits
 * into a timing side channel about the other secret.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.byteLength !== right.byteLength) {
    timingSafeEqual(DUMMY, DUMMY);
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * Generates a four-digit manual-join PIN (SR-4).
 *
 * Two bytes give 0..65535; values below 60000 are exactly six cycles of
 * 0..9999, so rejecting the remaining 8.4% yields uniform digits without the
 * modulo bias of `% 10000`. This is the injected-entropy equivalent of
 * `randomInt(0, 10000)` padded to four characters.
 */
export function generatePin(randomBytes: (n: number) => Uint8Array): string {
  for (let attempt = 0; attempt < MAX_PIN_ATTEMPTS; attempt += 1) {
    const bytes = randomBytes(2);
    if (bytes.byteLength !== 2) {
      throw new Error(`randomBytes returned ${bytes.byteLength} bytes; expected 2`);
    }
    const draw = ((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0);
    if (draw < PIN_DRAW_LIMIT) {
      return String(draw % 10 ** ROOM_PIN_LENGTH).padStart(ROOM_PIN_LENGTH, "0");
    }
  }
  throw new Error(`randomBytes rejected ${MAX_PIN_ATTEMPTS} consecutive PIN draws`);
}

/** True only for exactly `ROOM_PIN_LENGTH` ASCII digits (SR-4). */
export function isValidPin(value: string): boolean {
  if (value.length !== ROOM_PIN_LENGTH) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x30 || code > 0x39) {
      return false;
    }
  }
  return true;
}
