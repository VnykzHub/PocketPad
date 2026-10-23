/**
 * Non-positional one-shot pool (spec 09 §5.4, §5.13).
 *
 * A thin specialisation of `VoicePool`: gain → bus, no panner. The M0 bus and
 * `AudioSystem.playSfx` both use this shape. See `VoicePool` for selection and
 * the 5 ms steal ramp.
 */

import { VoicePool } from "./VoicePool.js";

export class SfxPool extends VoicePool {
  constructor(capacity: number, onEnded: (index: number) => void) {
    super(capacity, false, onEnded);
  }
}
