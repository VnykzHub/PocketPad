/**
 * Clip compilation and validation (spec 08 §3.3, §4.3, §4.7).
 *
 * Compilation copies and sorts tracks and events, validates every limit and
 * throws `E_ASSET_FORMAT` on malformed data. The resulting clip shares no
 * mutable state with its source.
 */

import type {
  AnimationClip,
  AnimationTrack,
  ClipEvent,
  ClipLoopMode,
  TrackPath,
} from "../contracts/animation.js";
import type {
  AnimationSource,
  AnimationSourceTrack,
} from "../contracts/sources.js";
import { animationError } from "../errors.js";
import {
  ANIMATION_MAX_CLIP_DURATION,
  ANIMATION_MAX_CLIP_NAME_BYTES,
  ANIMATION_MAX_EVENTS_PER_CLIP,
  ANIMATION_MAX_JOINTS,
  ANIMATION_MAX_KEYS_PER_CLIP,
  ANIMATION_MAX_KEYS_PER_TRACK,
  ANIMATION_MAX_MORPH_TARGETS,
  ANIMATION_MAX_TRACKS_PER_CLIP,
} from "../version.js";

const PATH_RANK: Record<TrackPath, number> = {
  translation: 0,
  rotation: 1,
  scale: 2,
  weights: 3,
};

const PATH_STRIDE: Record<TrackPath, 3 | 4 | 1> = {
  translation: 3,
  rotation: 4,
  scale: 3,
  weights: 1,
};

const LOOP_MODES: readonly ClipLoopMode[] = ["repeat", "once", "ping-pong"];

function fail(message: string): never {
  throw animationError("E_ASSET_FORMAT", `compileClip: ${message}`);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function isTrackPath(value: string): value is TrackPath {
  return (
    value === "translation" ||
    value === "rotation" ||
    value === "scale" ||
    value === "weights"
  );
}

/**
 * §3.3. Tracks are sorted by (path order, target ascending), times must be
 * strictly ascending in f32, and events by (time, authoring order).
 *
 * `skeleton` is optional so tooling can compile before a rig is loaded; when
 * present, joint targets and `source.skeletonId` are checked.
 */
export function compileClip(
  source: AnimationSource,
  skeleton?: {
    readonly id?: string;
    readonly jointCount: number;
  },
): AnimationClip {
  if (typeof source.name !== "string" || source.name.length === 0) {
    fail("name is empty");
  }
  if (utf8Bytes(source.name) > ANIMATION_MAX_CLIP_NAME_BYTES) {
    fail(`name exceeds ${ANIMATION_MAX_CLIP_NAME_BYTES} UTF-8 bytes`);
  }
  if (
    !Number.isFinite(source.duration) ||
    source.duration <= 0 ||
    source.duration > ANIMATION_MAX_CLIP_DURATION
  ) {
    fail(`duration ${source.duration} outside (0, ${ANIMATION_MAX_CLIP_DURATION}]`);
  }
  if (source.loop !== undefined && !LOOP_MODES.includes(source.loop)) {
    fail(`unknown loop mode ${String(source.loop)}`);
  }
  if (
    source.skeletonId !== undefined &&
    skeleton?.id !== undefined &&
    source.skeletonId !== skeleton.id
  ) {
    fail(`skeletonId ${source.skeletonId} does not match ${skeleton.id}`);
  }
  if (source.tracks.length > ANIMATION_MAX_TRACKS_PER_CLIP) {
    fail(`${source.tracks.length} tracks exceed ${ANIMATION_MAX_TRACKS_PER_CLIP}`);
  }

  let totalKeys = 0;
  const tracks: AnimationTrack[] = [];
  for (const sourceTrack of source.tracks) {
    const track = compileTrack(sourceTrack, source.duration, skeleton?.jointCount);
    totalKeys += track.keyCount;
    tracks.push(track);
  }
  if (totalKeys > ANIMATION_MAX_KEYS_PER_CLIP) {
    fail(`${totalKeys} keys exceed ${ANIMATION_MAX_KEYS_PER_CLIP}`);
  }

  tracks.sort(compareTracks);

  const events = compileEvents(source.events, source.duration);

  const rootJoint = source.rootJoint ?? -1;
  if (!Number.isInteger(rootJoint) || rootJoint < -1) {
    fail(`rootJoint ${rootJoint} is invalid`);
  }
  if (rootJoint >= 0 && skeleton !== undefined && rootJoint >= skeleton.jointCount) {
    fail(`rootJoint ${rootJoint} outside skeleton joint count ${skeleton.jointCount}`);
  }

  let sourceBytes = 0;
  for (const track of tracks) {
    sourceBytes += track.times.byteLength + track.values.byteLength;
  }
  for (const event of events) {
    sourceBytes += utf8Bytes(event.name);
  }

  return {
    name: source.name,
    duration: source.duration,
    loop: source.loop ?? "repeat",
    tracks,
    events,
    rootJoint,
    sourceBytes,
  };
}

function compareTracks(a: AnimationTrack, b: AnimationTrack): number {
  const rankA = PATH_RANK[a.path];
  const rankB = PATH_RANK[b.path];
  if (rankA !== rankB) return rankA - rankB;
  return a.target - b.target;
}

function compileTrack(
  source: AnimationSourceTrack,
  duration: number,
  jointCount: number | undefined,
): AnimationTrack {
  const path = source.path;
  if (typeof path !== "string" || !isTrackPath(path)) {
    fail(`unknown track path ${String(path)}`);
  }
  if (source.interpolation !== "linear" && source.interpolation !== "step") {
    // §4.2: CUBICSPLINE is resampled by tooling and rejected at runtime.
    fail(`interpolation ${String(source.interpolation)} is not linear or step`);
  }
  const stride = PATH_STRIDE[path];
  if (!Number.isInteger(source.target) || source.target < 0) {
    fail(`target ${source.target} is invalid for ${path}`);
  }
  if (path === "weights") {
    if (source.target >= ANIMATION_MAX_MORPH_TARGETS) {
      fail(`morph target ${source.target} exceeds ${ANIMATION_MAX_MORPH_TARGETS}`);
    }
  } else if (jointCount !== undefined && source.target >= jointCount) {
    fail(`joint target ${source.target} outside joint count ${jointCount}`);
  } else if (jointCount === undefined && source.target >= ANIMATION_MAX_JOINTS) {
    fail(`joint target ${source.target} exceeds ${ANIMATION_MAX_JOINTS}`);
  }

  const keyCount = source.times.length;
  if (keyCount < 1 || keyCount > ANIMATION_MAX_KEYS_PER_TRACK) {
    fail(`keyCount ${keyCount} outside 1..${ANIMATION_MAX_KEYS_PER_TRACK}`);
  }
  if (source.values.length !== keyCount * stride) {
    fail(
      `values length ${source.values.length} != ${keyCount} keys * ${stride} floats`,
    );
  }

  const times = new Float32Array(keyCount);
  const values = new Float32Array(keyCount * stride);
  for (let i = 0; i < keyCount; i += 1) {
    const time = source.times[i]!;
    if (!Number.isFinite(time) || time < 0 || time > duration) {
      fail(
        `track (${path}, ${source.target}) key ${i} time ${time} outside [0, ${duration}]`,
      );
    }
    times[i] = time;
  }
  for (let i = 0; i < values.length; i += 1) {
    const value = source.values[i]!;
    if (!Number.isFinite(value)) {
      fail(`track (${path}, ${source.target}) value ${i} is not finite`);
    }
    values[i] = value;
  }
  for (let i = 1; i < keyCount; i += 1) {
    if (!(times[i]! > times[i - 1]!)) {
      fail(
        `track (${path}, ${source.target}) times are not strictly ascending at key ${i}`,
      );
    }
  }

  return {
    target: source.target,
    path,
    interpolation: source.interpolation,
    times,
    values,
    keyCount,
    valueStride: stride,
  };
}

function compileEvents(
  source: readonly ClipEvent[] | undefined,
  duration: number,
): readonly ClipEvent[] {
  if (source === undefined || source.length === 0) return [];
  if (source.length > ANIMATION_MAX_EVENTS_PER_CLIP) {
    fail(`${source.length} events exceed ${ANIMATION_MAX_EVENTS_PER_CLIP}`);
  }
  const sorted: { event: ClipEvent; order: number }[] = [];
  for (let order = 0; order < source.length; order += 1) {
    const event = source[order]!;
    if (
      typeof event.name !== "string" ||
      !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(event.name)
    ) {
      fail(`event ${order} has invalid name ${JSON.stringify(event.name)}`);
    }
    if (!Number.isFinite(event.time) || event.time < 0 || event.time > duration) {
      fail(`event ${event.name} time ${event.time} outside [0, ${duration}]`);
    }
    if (
      !Number.isInteger(event.payload) ||
      event.payload < -2147483648 ||
      event.payload > 2147483647
    ) {
      fail(`event ${event.name} payload ${event.payload} is not int32`);
    }
    sorted.push({ event, order });
  }
  sorted.sort((a, b) =>
    a.event.time === b.event.time
      ? a.order - b.order
      : a.event.time - b.event.time,
  );
  const events: ClipEvent[] = [];
  for (const entry of sorted) {
    events.push(entry.event);
  }
  return events;
}
