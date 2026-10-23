/**
 * Audio error values (spec 09 §3.7).
 *
 * None of these ever reaches `simulate` as an exception: the system records
 * and counts them. They exist so validators and host code can return a typed
 * failure instead of throwing a bare `Error`.
 */

import type { AudioErrorCode } from "./contracts/audio.js";

export class AudioEngineError extends Error {
  readonly code: AudioErrorCode;
  readonly layer = "audio" as const;
  readonly recoverable: boolean;

  constructor(code: AudioErrorCode, message: string, recoverable = true) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    this.recoverable = recoverable;
  }
}

export class AudioValidationError extends AudioEngineError {
  override readonly code = "E_AUDIO_FORMAT" as const;
  /** JSON path of the offending value, e.g. `buses.music`. */
  readonly path: string;

  constructor(path: string, message: string) {
    super("E_AUDIO_FORMAT", message, true);
    this.path = path;
  }
}

export function audioError(
  code: AudioErrorCode,
  message: string,
  recoverable = true,
): AudioEngineError {
  return new AudioEngineError(code, message, recoverable);
}
