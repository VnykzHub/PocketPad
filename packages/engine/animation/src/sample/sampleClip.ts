/**
 * Clip sampling into a pose (spec 08 §5.4).
 *
 * The caller resets the pose to the rest pose first; this module only writes
 * joints that have tracks. Morph `weights` tracks are written into a separate
 * per-instance buffer so they never collide with TRS joints.
 */

import type { AnimationClip, PoseBuffer } from "../contracts/animation.js";
import { sampleTrackInto, sampleWeightInto } from "../clip/track.js";

/**
 * Samples every track of `clip` at `time`. Returns the number of tracks
 * sampled (the stats counter). `morphWeights` may be null in M1.
 */
export function sampleClipInto(
  clip: AnimationClip,
  time: number,
  pose: PoseBuffer,
  morphWeights: Float32Array | null,
): number {
  const tracks = clip.tracks;
  for (let i = 0; i < tracks.length; i += 1) {
    const track = tracks[i]!;
    if (track.path === "weights") {
      if (morphWeights !== null) {
        sampleWeightInto(track, time, morphWeights);
      }
    } else {
      sampleTrackInto(track, time, pose);
    }
  }
  return tracks.length;
}
