/**
 * Fixture loading for the animation tests.
 *
 * JSON carries plain number arrays; these helpers convert them to the typed
 * arrays `compileSkeleton`/`compileClip` require. Everything here is synthetic.
 */

import { readFileSync } from "node:fs";
import type { Mat4 } from "@lanpad/engine-core";
import { mat4Invert, mat4Multiply } from "@lanpad/engine-core";
import { compileSkeleton } from "../../src/skeleton/compileSkeleton.js";
import { compileClip } from "../../src/clip/compileClip.js";
import type {
  AnimationClip,
  ClipEvent,
  JointPalette,
  Skeleton,
} from "../../src/contracts/animation.js";
import type {
  AnimationSource,
  SkeletonSource,
} from "../../src/contracts/sources.js";

export interface SkeletonJson {
  readonly id: string;
  readonly jointNames: readonly string[];
  readonly parents: readonly number[];
  readonly inverseBindMatrices: readonly number[];
  readonly restTranslations: readonly number[];
  readonly restRotations: readonly number[];
  readonly restScales: readonly number[];
  readonly rootJoint: number;
}

export interface TrackJson {
  readonly target: number;
  readonly path: "translation" | "rotation" | "scale" | "weights";
  readonly interpolation: "linear" | "step";
  readonly times: readonly number[];
  readonly values: readonly number[];
}

export interface ClipJson {
  readonly name: string;
  readonly skeletonId?: string;
  readonly duration: number;
  readonly tracks: readonly TrackJson[];
  readonly events?: readonly ClipEvent[];
  readonly rootJoint?: number;
  readonly loop?: "repeat" | "once" | "ping-pong";
}

export interface GoldenBlendJson {
  readonly ticks: number;
  readonly jointCount: number;
  readonly samples: readonly {
    readonly tick: number;
    readonly parameter: number;
    readonly positions: readonly number[];
  }[];
}

export interface DeterminismJson {
  readonly ticks: number;
  readonly fixedStep: number;
  readonly instanceCount: number;
  readonly clips: readonly string[];
  readonly tree: {
    readonly clips: readonly string[];
    readonly thresholds: readonly number[];
    readonly syncPhase: boolean;
  };
  readonly crossfades: readonly {
    readonly tick: number;
    readonly clip: string;
    readonly fadeOutPreviousSeconds: number;
  }[];
  readonly speedChange: number;
  readonly fadeChange: number;
}

export interface GoldenEventsJson {
  readonly clip: string;
  readonly loops: number;
  readonly events: readonly {
    readonly time: number;
    readonly name: string;
    readonly payload: number;
  }[];
}

function loadJson<T>(name: string): T {
  const text = readFileSync(
    new URL(`../fixtures/${name}`, import.meta.url),
    "utf8",
  );
  return JSON.parse(text) as T;
}

export function loadClipJson(name: string): ClipJson {
  return loadJson<ClipJson>(name);
}

export function loadSkeletonJson(): SkeletonJson {
  return loadJson<SkeletonJson>("rig-24.json");
}

export function skeletonSourceFromJson(data: SkeletonJson): SkeletonSource {
  return {
    id: data.id,
    jointNames: data.jointNames,
    parents: Int16Array.from(data.parents),
    inverseBindMatrices: Float32Array.from(data.inverseBindMatrices),
    restTranslations: Float32Array.from(data.restTranslations),
    restRotations: Float32Array.from(data.restRotations),
    restScales: Float32Array.from(data.restScales),
    rootJoint: data.rootJoint,
  };
}

export function clipSourceFromJson(data: ClipJson): AnimationSource {
  return {
    name: data.name,
    ...(data.skeletonId === undefined ? {} : { skeletonId: data.skeletonId }),
    duration: data.duration,
    tracks: data.tracks.map((track) => ({
      target: track.target,
      path: track.path,
      interpolation: track.interpolation,
      times: Float32Array.from(track.times),
      values: Float32Array.from(track.values),
    })),
    events: data.events ?? [],
    ...(data.rootJoint === undefined ? {} : { rootJoint: data.rootJoint }),
    ...(data.loop === undefined ? {} : { loop: data.loop }),
  };
}

export const skeleton: Skeleton = compileSkeleton(
  skeletonSourceFromJson(loadJson<SkeletonJson>("rig-24.json")),
);

export function loadClip(name: string): AnimationClip {
  return compileClip(clipSourceFromJson(loadJson<ClipJson>(name)), skeleton);
}

export function loadGoldenBlend(): GoldenBlendJson {
  return loadJson<GoldenBlendJson>("golden-blend.json");
}

export function loadDeterminism(): DeterminismJson {
  return loadJson<DeterminismJson>("determinism-600.json");
}

export function loadGoldenEvents(): GoldenEventsJson {
  return loadJson<GoldenEventsJson>("golden-events.json");
}

const inverseBindScratch: Mat4 = { m: new Float32Array(16) };
const paletteWorldScratch: Mat4 = { m: new Float32Array(16) };

/**
 * Model-space joint positions recovered from a palette: `W = J * inverse(IBM)`.
 * Independent of the pose arrays, so it checks the palette itself.
 */
export function palettePositions(
  palette: JointPalette,
  rig: Skeleton = skeleton,
): number[] {
  const count = palette.jointCount;
  const out: number[] = [];
  for (let joint = 0; joint < count; joint += 1) {
    const ibm: Mat4 = {
      m: rig.inverseBindMatrices.subarray(joint * 16, joint * 16 + 16),
    };
    if (!mat4Invert(inverseBindScratch, ibm)) {
      throw new Error(`joint ${joint} inverse bind is singular`);
    }
    const j: Mat4 = {
      m: palette.matrices.subarray(joint * 16, joint * 16 + 16),
    };
    mat4Multiply(paletteWorldScratch, j, inverseBindScratch);
    out.push(
      paletteWorldScratch.m[12]!,
      paletteWorldScratch.m[13]!,
      paletteWorldScratch.m[14]!,
    );
  }
  return out;
}
