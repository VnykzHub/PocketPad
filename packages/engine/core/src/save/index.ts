/**
 * Save subsystem entry (15 §5.1).
 *
 * M0 exposes the header/file codec and its runtime constants only. The
 * `SaveStore`, storage adapters, compression, SHA-256 and migrations are M1
 * and deliberately absent. The frozen public types stay in
 * `contracts/save.d.ts`; this barrel exports values plus the two input/output
 * shapes the contract does not declare.
 */

export {
  SAVE_DEFAULT_MAX_SLOTS,
  SAVE_FLAG_DEFLATE,
  SAVE_FLAGS_RESERVED_MASK,
  SAVE_FORMAT_VERSION,
  SAVE_GAME_ID_PATTERN,
  SAVE_HEADER_BYTES,
  SAVE_HEADER_MAX_BYTES,
  SAVE_HEADER_PREFIX_BYTES,
  SAVE_MAGIC,
  SAVE_MAX_GAME_ID_BYTES,
  SAVE_MAX_GAME_VERSION_BYTES,
  SAVE_MAX_PAYLOAD_BYTES,
  SAVE_MAX_UNCOMPRESSED_BYTES,
  SAVE_SLOT_ID_PATTERN,
} from "./constants.js";
export {
  createSaveHeader,
  decodeSaveHeader,
  encodeSaveHeader,
  fnv1a32,
} from "./header.js";
export type { CreateSaveHeaderInput } from "./header.js";
export { decodeSaveFile, encodeSaveFile } from "./file.js";
export type { DecodedSaveFile } from "./file.js";
