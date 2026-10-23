/**
 * Bus graph construction (spec 09 §5.3).
 *
 * ```
 * BufferSource ─▶ sourceGain ─▶ [PannerNode] ─▶ busGain ─┐
 * MediaElementSource ─▶ deckGain ────────────▶ musicGain ─┤
 *                                                         ├─▶ masterGain ─▶ destination
 * Bus layout: music · sfx · ambient · voice · ui ─────────┘
 * ```
 *
 * One gain node per bus, one master gain, no compressor or limiter in M1.
 * Built once at unlock and owned by `AudioSystem`; `dispose()` drops the
 * references with the context.
 */

import type { AudioBusName } from "../contracts/audio.js";
import type { HostAudioContext, HostGainNode } from "../host/types.js";
import { AUDIO_BUS_NAMES } from "../version.js";

export interface AudioBusGraph {
  readonly masterGain: HostGainNode;
  /** Indexed exactly like `AUDIO_BUS_NAMES`. */
  readonly busGains: readonly HostGainNode[];
}

/** Bus name → index; unknown names return −1. */
export function busIndex(name: AudioBusName): number {
  switch (name) {
    case "music":
      return 0;
    case "sfx":
      return 1;
    case "ambient":
      return 2;
    case "voice":
      return 3;
    case "ui":
      return 4;
    default:
      return -1;
  }
}

export function buildBusGraph(
  context: HostAudioContext,
  masterVolume: number,
  busVolumes: readonly number[],
): AudioBusGraph {
  const masterGain = context.createGain();
  masterGain.gain.value = masterVolume;
  masterGain.connect(context.destination);

  const busGains: HostGainNode[] = [];
  for (let index = 0; index < AUDIO_BUS_NAMES.length; index += 1) {
    const busGain = context.createGain();
    busGain.gain.value = busVolumes[index] ?? 1;
    busGain.connect(masterGain);
    busGains.push(busGain);
  }
  return { masterGain, busGains };
}
