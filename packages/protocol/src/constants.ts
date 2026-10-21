/**
 * Frozen wire constants (D0-PROTO-01).
 *
 * These values are consumed by every later stage. Additive changes are allowed;
 * renames or semantic changes require a PROTOCOL_VERSION bump.
 */

/** Wire protocol version. A breaking change bumps this value. */
export const PROTOCOL_VERSION = 1;

/** Fixed simulation tick rate in Hz (spec §9.1). */
export const TICK_HZ = 60;

/** Maximum controllers per room (SR-6). */
export const MAX_CONTROLLERS = 8;

/** Binary frames larger than this are rejected and the socket is closed (SR-6). */
export const MAX_BINARY_FRAME_BYTES = 64;

/** JSON frames larger than this many UTF-8 bytes are rejected (SR-6). */
export const MAX_JSON_FRAME_BYTES = 4096;

/** A haptic pattern carries at most eight durations (spec §7.1). */
export const MAX_HAPTIC_STEPS = 8;

/** Input frame size including the type byte: 1 + 25 = 26. */
export const INPUT_FRAME_BYTES = 26;

/** InputFwd frame size including type and slot bytes: 1 + 1 + 25 = 27. */
export const INPUT_FWD_FRAME_BYTES = 27;

/** Room codes use Crockford base32 and exclude I, L, O and U (README §1.1). */
export const ROOM_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Room code length in characters (20 bits of entropy). */
export const ROOM_CODE_LENGTH = 4;

/** Manual-join room PIN length in digits. */
export const ROOM_PIN_LENGTH = 4;

/** Room, session and host tokens are 16 random bytes (SR-1). */
export const TOKEN_BYTES = 16;

/** Length of a base64url-encoded 16-byte token. */
export const TOKEN_LENGTH = 22;

/** Optional player display names are at most 24 characters (README §1.1). */
export const MAX_PLAYER_NAME_CHARS = 24;

/** Event names are at most 64 characters (D0-PROTO-03). */
export const MAX_EVENT_NAME_CHARS = 64;

/**
 * Binary frame type bytes (spec §7.1). The high bit of server-sent types is
 * set; direction is part of the type value, not a separate flag.
 */
export const MSG = {
  Input: 0x02,
  Ping: 0x03,
  Pong: 0x82,
  Haptic: 0x84,
  HapticCmd: 0xa2,
  InputFwd: 0xb2,
} as const;

/** Button bit positions in `buttons` and `edges` (FR-7.2). Values are positions, not masks. */
export const BUTTON_BITS = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  L1: 4,
  R1: 5,
  L2: 6,
  R2: 7,
  DUp: 8,
  DDown: 9,
  DLeft: 10,
  DRight: 11,
  L3: 12,
  R3: 13,
  Start: 14,
  Select: 15,
} as const;
