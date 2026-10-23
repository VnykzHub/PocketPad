/**
 * Per-instance playback state (spec 08 §3.5, §5.2–§5.8).
 *
 * Owns the double pose buffers, the eight pooled action handles, copied layer
 * masks and preallocated scratch. `update` follows the normative tick order:
 * advance actions, sample the base layer, apply overrides, root motion,
 * events. It allocates nothing.
 */

import type { Entity, Scene } from "@lanpad/engine-core";
import { Transform } from "@lanpad/engine-core";
import type {
  AnimationAction,
  AnimationClip,
  AnimationInstance,
  AnimationInstanceOptions,
  BlendTree1D,
  ClipLoopMode,
  JointPalette,
  LayerDesc,
  Playable,
  PlayOptions,
  PoseBuffer,
  RootMotionDelta,
  RootMotionMode,
  RootMotionOptions,
  Skeleton,
} from "../contracts/animation.js";
import type { AnimationCounters } from "../errors.js";
import { animationError } from "../errors.js";
import { ANIMATION_MAX_ACTIONS_PER_INSTANCE } from "../version.js";
import { createPoseBuffer, copyPose } from "../sample/PoseBuffer.js";
import {
  canonicalizeQuatAt,
  lerpInto,
  nlerpInto,
} from "../sample/interpolate.js";
import { sampleClipInto } from "../sample/sampleClip.js";
import {
  dominantSampleIndex,
  evaluateBlend1D,
  validateBlendTree1D,
} from "../blend/blend1d.js";
import {
  applyOverrideLayer,
  clampUnit,
  copyMask,
  validateMask,
} from "../layer/layers.js";
import type { PaletteScratch } from "../palette/palette.js";
import {
  computePalette as computePaletteInto,
  createPaletteScratch,
} from "../palette/palette.js";
import type {
  ResolvedRootOptions,
  RootMotionState,
  RootPoseScratch,
  RootScratch,
} from "../rootmotion/rootMotion.js";
import {
  applyRootDelta,
  computeRootDelta,
  consumeRootMotion as consumeRootState,
  createRootMotionState,
  createRootPoseScratch,
  createRootScratch,
  removeRootFromPose,
  resetRootMotion,
  resolveRootOptions,
  sampleRootModelTransform,
} from "../rootmotion/rootMotion.js";
import type { StateHasher } from "../hash/hash.js";
import { fnv1aString } from "../hash/hash.js";
import {
  ANIMATION_DEFAULT_FADE_OUT_PREVIOUS,
  ANIMATION_MAX_FADE_SECONDS,
  ANIMATION_MAX_LAYERS_M1,
  ANIMATION_MAX_MORPH_TARGETS,
  ANIMATION_MAX_SPEED,
  ANIMATION_MAX_TREE_SAMPLES,
} from "../version.js";

export interface AnimationInstanceHost {
  readonly scene: Scene | undefined;
  readonly debug: boolean;
  readonly counters: AnimationCounters;
  emitEvent(
    entity: Entity,
    clip: AnimationClip,
    name: string,
    payload: number,
    time: number,
  ): void;
  reportPaletteMs(ms: number): void;
}

export interface LayerState {
  readonly name: string;
  readonly mode: "base" | "override" | "additive";
  readonly mask: Uint32Array | undefined;
  weight: number;
}

const KIND_CLIP = 0;
const KIND_TREE_1D = 1;
const KIND_TREE_2D = 2;

const FADE_NONE = 0;
const FADE_IN = 1;
const FADE_OUT = 2;

function sourceKind(source: Playable): number {
  if ("kind" in source) {
    return source.kind === "1d" ? KIND_TREE_1D : KIND_TREE_2D;
  }
  return KIND_CLIP;
}

function isTree1D(source: Playable): source is BlendTree1D {
  return "kind" in source && source.kind === "1d";
}

function clampSpeed(value: number, counters: AnimationCounters): number {
  if (!Number.isFinite(value) || value < 0) {
    counters.speedClamp += 1;
    return 0;
  }
  if (value > ANIMATION_MAX_SPEED) {
    counters.speedClamp += 1;
    return ANIMATION_MAX_SPEED;
  }
  return value;
}

function clampFade(value: number, counters: AnimationCounters): number {
  if (!Number.isFinite(value) || value < 0) {
    counters.fadeClamp += 1;
    return 0;
  }
  if (value > ANIMATION_MAX_FADE_SECONDS) {
    counters.fadeClamp += 1;
    return ANIMATION_MAX_FADE_SECONDS;
  }
  return value;
}

function nowMs(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof perf?.now === "function" ? perf.now() : 0;
}

function validateRootOptions(
  skeleton: Skeleton,
  options: RootMotionOptions | undefined,
): ResolvedRootOptions {
  const resolved = resolveRootOptions(skeleton.rootJoint, options);
  if (resolved.rootJoint < 0 || resolved.rootJoint >= skeleton.jointCount) {
    throw animationError(
      "E_CONTRACT",
      `root joint ${resolved.rootJoint} outside the skeleton`,
    );
  }
  return resolved;
}

/** Pooled action handle; one per fixed slot, reused after retirement. */
export class AnimationActionHandle implements AnimationAction {
  readonly instance: AnimationInstanceImpl;
  sourceInternal: Playable | null = null;
  layerInternal = 0;
  order = 0;
  active = false;
  time = 0;
  weight = 0;
  speed = 1;
  runningInternal = false;
  loop: ClipLoopMode = "repeat";
  parameter = 0;
  parameterX = 0;
  parameterY = 0;
  fadeMode = FADE_NONE;
  fadeElapsed = 0;
  fadeDuration = 0;
  fadeStart = 0;
  fadeTarget = 0;
  previousTime = 0;
  currentTime = 0;
  wrapped = false;
  readonly sampleWeights = new Float32Array(ANIMATION_MAX_TREE_SAMPLES);
  readonly sampleTimes = new Float32Array(ANIMATION_MAX_TREE_SAMPLES);
  readonly previousSampleTimes = new Float32Array(ANIMATION_MAX_TREE_SAMPLES);
  readonly sampleWrapped = new Uint8Array(ANIMATION_MAX_TREE_SAMPLES);
  dominantSample = 0;

  constructor(instance: AnimationInstanceImpl) {
    this.instance = instance;
  }

  get source(): Playable {
    if (this.sourceInternal === null) {
      throw animationError("E_CONTRACT", "action has no source");
    }
    return this.sourceInternal;
  }

  get layer(): number {
    return this.layerInternal;
  }

  get normalizedTime(): number {
    const source = this.sourceInternal;
    if (source === null) return 0;
    if (isTree1D(source)) {
      const phase = this.time % 1;
      return phase < 0 ? phase + 1 : phase;
    }
    const duration = (source as AnimationClip).duration;
    if (!(duration > 0)) return 0;
    let time = this.time % duration;
    if (time < 0) time += duration;
    return time / duration;
  }

  get running(): boolean {
    return this.runningInternal;
  }

  stop(fadeOutSeconds?: number): void {
    this.instance.stopAction(this, fadeOutSeconds);
  }

  setParameter(value: number): void {
    const source = this.sourceInternal;
    if (source === null || !isTree1D(source)) return;
    this.parameter = Number.isFinite(value) ? value : 0;
  }

  setParameter2D(x: number, y: number): void {
    const source = this.sourceInternal;
    if (source === null || !isTree1D(source)) return;
    this.parameterX = Number.isFinite(x) ? x : 0;
    this.parameterY = Number.isFinite(y) ? y : 0;
  }

  retire(): void {
    this.active = false;
    this.runningInternal = false;
    this.fadeMode = FADE_NONE;
    this.weight = 0;
  }
}

/** The concrete `AnimationInstance`; constructed only by `AnimationApi`. */
export class AnimationInstanceImpl implements AnimationInstance {
  readonly id: number;
  readonly entity: Entity;
  readonly skeleton: Skeleton;
  readonly previousPose: PoseBuffer;
  readonly currentPose: PoseBuffer;
  readonly morphWeights: Float32Array;
  readonly actions: AnimationActionHandle[];
  readonly layers: LayerState[];
  readonly morphTargets: number;

  destroyed = false;
  slot = -1;
  readonly detached: boolean;
  lastSampledTrackCount = 0;

  private readonly host: AnimationInstanceHost;
  private readonly transform: Transform | undefined;
  private readonly basePose: PoseBuffer;
  private readonly actionPose: PoseBuffer;
  private readonly samplePose: PoseBuffer;
  private readonly treePose: PoseBuffer;
  private readonly layerPose: PoseBuffer;
  private readonly actionMorph: Float32Array;
  private readonly sampleMorph: Float32Array;
  private readonly treeMorph: Float32Array;
  private readonly layerMorph: Float32Array;
  private readonly morphClip: Float32Array;
  private readonly morphGame: Float32Array;
  private readonly actionOrderScratch = new Int32Array(ANIMATION_MAX_ACTIONS_PER_INSTANCE);
  private readonly paletteScratch: PaletteScratch;
  private readonly rootScratch: RootScratch;
  private readonly rootPoseScratch: RootPoseScratch;
  private readonly rootApplyScratch = { x: 0, y: 0, z: 0 };
  private readonly rootCurrentMatrix = { m: new Float32Array(16) };
  private readonly rootState: RootMotionState;
  private readonly hashQuat = new Float32Array(4);
  private actionSerial = 0;
  private lastDominantAction: AnimationActionHandle | null = null;

  constructor(
    host: AnimationInstanceHost,
    id: number,
    entity: Entity,
    skeleton: Skeleton,
    options: AnimationInstanceOptions | undefined,
    detached: boolean,
  ) {
    this.host = host;
    this.id = id;
    this.entity = entity;
    this.skeleton = skeleton;
    this.detached = detached;
    this.previousPose = createPoseBuffer(skeleton.jointCount);
    this.currentPose = createPoseBuffer(skeleton.jointCount);
    copyPose(this.previousPose, skeleton.restPose);
    copyPose(this.currentPose, skeleton.restPose);
    this.basePose = createPoseBuffer(skeleton.jointCount);
    this.actionPose = createPoseBuffer(skeleton.jointCount);
    this.samplePose = createPoseBuffer(skeleton.jointCount);
    this.treePose = createPoseBuffer(skeleton.jointCount);
    this.layerPose = createPoseBuffer(skeleton.jointCount);
    copyPose(this.basePose, skeleton.restPose);
    copyPose(this.actionPose, skeleton.restPose);
    copyPose(this.samplePose, skeleton.restPose);
    copyPose(this.treePose, skeleton.restPose);
    copyPose(this.layerPose, skeleton.restPose);

    const morphTargets = options?.morphTargets ?? 0;
    if (
      !Number.isInteger(morphTargets) ||
      morphTargets < 0 ||
      morphTargets > ANIMATION_MAX_MORPH_TARGETS
    ) {
      throw animationError(
        "E_CONTRACT",
        `morphTargets ${morphTargets} outside 0..${ANIMATION_MAX_MORPH_TARGETS}`,
      );
    }
    this.morphTargets = morphTargets;
    this.morphWeights = new Float32Array(morphTargets);
    this.morphClip = new Float32Array(morphTargets);
    this.morphGame = new Float32Array(morphTargets);
    this.actionMorph = new Float32Array(morphTargets);
    this.sampleMorph = new Float32Array(morphTargets);
    this.treeMorph = new Float32Array(morphTargets);
    this.layerMorph = new Float32Array(morphTargets);

    this.actions = [];
    for (let i = 0; i < ANIMATION_MAX_ACTIONS_PER_INSTANCE; i += 1) {
      this.actions.push(new AnimationActionHandle(this));
    }

    const descriptors = options?.layers;
    const sourceLayers: readonly LayerDesc[] =
      descriptors === undefined
        ? [{ name: "base", mode: "base" }]
        : descriptors;
    if (sourceLayers.length < 1 || sourceLayers.length > ANIMATION_MAX_LAYERS_M1) {
      throw animationError(
        "E_UNSUPPORTED_FEATURE",
        `${sourceLayers.length} layers exceed the M1 limit of ${ANIMATION_MAX_LAYERS_M1}`,
      );
    }
    if (sourceLayers[0]!.mode !== "base") {
      throw animationError("E_CONTRACT", 'layer 0 must have mode "base"');
    }
    const layers: LayerState[] = [];
    for (let i = 0; i < sourceLayers.length; i += 1) {
      const descriptor = sourceLayers[i]!;
      if (i > 0) {
        if (descriptor.mode === "base") {
          throw animationError("E_CONTRACT", "only layer 0 may be the base layer");
        }
        if (descriptor.mode === "additive") {
          throw animationError(
            "E_UNSUPPORTED_FEATURE",
            "additive layers are M2; rejected in M1",
          );
        }
      }
      if (
        typeof descriptor.name !== "string" ||
        descriptor.name.length < 1 ||
        descriptor.name.length > 32
      ) {
        throw animationError("E_CONTRACT", `layer ${i} name must be 1..32 characters`);
      }
      validateMask(descriptor.mask, skeleton.jointCount, descriptor.name);
      layers.push({
        name: descriptor.name,
        mode: descriptor.mode,
        mask: copyMask(descriptor.mask),
        weight:
          descriptor.weight === undefined ? 1 : clampUnit(descriptor.weight),
      });
    }
    this.layers = layers;

    this.paletteScratch = createPaletteScratch(skeleton.jointCount);
    this.rootScratch = createRootScratch();
    this.rootPoseScratch = createRootPoseScratch();
    this.rootState = createRootMotionState(
      "none",
      validateRootOptions(skeleton, options?.rootMotion),
    );
    this.transform = host.scene?.get(entity, Transform);
  }

  // ---------------------------------------------------------------- playback

  play(source: Playable, options?: PlayOptions): AnimationAction {
    if (this.destroyed) {
      throw animationError("E_CONTRACT", "play on a destroyed instance");
    }
    const layer = options?.layer ?? 0;
    this.requireLayer(layer);
    this.validateSource(source, options);
    const kind = sourceKind(source);
    const fadeOut = clampFade(
      options?.fadeOutPreviousSeconds ?? ANIMATION_DEFAULT_FADE_OUT_PREVIOUS,
      this.host.counters,
    );
    const restart = options?.restart !== false;
    const weight = options?.weight === undefined ? 1 : clampUnit(options.weight);

    let reuse: AnimationActionHandle | null = null;
    if (!restart) reuse = this.findAction(source, layer);

    let action: AnimationActionHandle;
    let preservedTime = 0;
    if (reuse !== null) {
      action = reuse;
      preservedTime = action.time;
    } else {
      action = this.takeActionSlot();
      action.retire();
    }

    for (let i = 0; i < this.actions.length; i += 1) {
      const other = this.actions[i]!;
      if (!other.active || other === action) continue;
      if (other.layerInternal !== layer) continue;
      if (fadeOut > 0) {
        other.fadeMode = FADE_OUT;
        other.fadeElapsed = 0;
        other.fadeDuration = fadeOut;
        other.fadeStart = other.weight;
        other.runningInternal = false;
      } else {
        other.retire();
      }
    }

    action.sourceInternal = source;
    action.layerInternal = layer;
    action.active = true;
    action.runningInternal = true;
    action.speed = clampSpeed(options?.speed ?? 1, this.host.counters);
    action.weight = weight;
    action.fadeMode = FADE_NONE;
    action.fadeElapsed = 0;
    action.fadeDuration = 0;
    action.parameter = options?.parameter ?? 0;
    action.parameterX = options?.parameterX ?? 0;
    action.parameterY = options?.parameterY ?? 0;

    if (reuse === null) {
      action.order = ++this.actionSerial;
      action.time = 0;
    } else if (restart) {
      action.time = 0;
    } else {
      action.time = preservedTime;
    }

    if (kind === KIND_CLIP) {
      const clip = source as AnimationClip;
      const requested = options?.loop ?? clip.loop;
      if (requested === "ping-pong") {
        throw animationError(
          "E_UNSUPPORTED_FEATURE",
          "ping-pong looping is M2; rejected in M1",
        );
      }
      action.loop = requested;
      action.previousTime = action.time;
      action.currentTime = action.time;
      action.wrapped = false;
    } else {
      const tree = source as BlendTree1D;
      evaluateBlend1D(tree, action.parameter, action.sampleWeights);
      action.dominantSample = dominantSampleIndex(
        action.sampleWeights,
        tree.samples.length,
      );
      for (let i = 0; i < tree.samples.length; i += 1) {
        const duration = tree.samples[i]!.clip.duration;
        const local = action.time * duration;
        if (reuse === null || restart) {
          action.sampleTimes[i] = 0;
          action.previousSampleTimes[i] = 0;
        } else {
          action.sampleTimes[i] = local;
          action.previousSampleTimes[i] = local;
        }
        action.sampleWrapped[i] = 0;
      }
      action.previousTime = action.time;
      action.currentTime = action.time;
    }

    const explicitFadeIn = options?.fadeInSeconds;
    const fadeIn =
      explicitFadeIn !== undefined
        ? clampFade(explicitFadeIn, this.host.counters)
        : fadeOut > 0
          ? fadeOut
          : 0;
    if (fadeIn > 0) {
      action.weight = 0;
      action.fadeMode = FADE_IN;
      action.fadeElapsed = 0;
      action.fadeDuration = fadeIn;
      action.fadeTarget = weight;
    }

    if (layer === 0) resetRootMotion(this.rootState);
    return action;
  }

  getAction(layer: number): AnimationAction | null {
    let best: AnimationActionHandle | null = null;
    for (let i = 0; i < this.actions.length; i += 1) {
      const action = this.actions[i]!;
      if (!action.active || action.layerInternal !== layer) continue;
      if (best === null || action.order > best.order) best = action;
    }
    return best;
  }

  stop(layer?: number, fadeOutSeconds?: number): void {
    if (this.destroyed) return;
    if (layer !== undefined) this.requireLayer(layer);
    const fade =
      fadeOutSeconds === undefined
        ? 0
        : clampFade(fadeOutSeconds, this.host.counters);
    for (let i = 0; i < this.actions.length; i += 1) {
      const action = this.actions[i]!;
      if (!action.active) continue;
      if (layer !== undefined && action.layerInternal !== layer) continue;
      this.stopAction(action, fade);
    }
  }

  stopAction(action: AnimationActionHandle, fadeOutSeconds?: number): void {
    if (!action.active) return;
    const fade =
      fadeOutSeconds === undefined
        ? 0
        : clampFade(fadeOutSeconds, this.host.counters);
    if (fade > 0 && action.weight > 0) {
      action.fadeMode = FADE_OUT;
      action.fadeElapsed = 0;
      action.fadeDuration = fade;
      action.fadeStart = action.weight;
      action.runningInternal = false;
      return;
    }
    action.retire();
  }

  setLayerWeight(layer: number, weight: number): void {
    this.requireLayer(layer);
    this.layers[layer]!.weight = clampUnit(weight);
  }

  // ------------------------------------------------------------- root motion

  setRootMotionMode(mode: RootMotionMode, options?: RootMotionOptions): void {
    if (mode !== "none" && mode !== "extract" && mode !== "apply") {
      throw animationError("E_CONTRACT", `unknown root motion mode ${String(mode)}`);
    }
    const resolved = validateRootOptions(this.skeleton, options);
    if (mode === "apply" && this.skeleton.parents[resolved.rootJoint] !== -1) {
      throw animationError(
        "E_UNSUPPORTED_FEATURE",
        "root motion apply requires a skeleton root joint",
      );
    }
    this.rootState.options = resolved;
    if (mode === "apply" && this.host.scene === undefined) {
      this.host.counters.applyWithoutScene += 1;
      this.rootState.mode = "extract";
    } else {
      this.rootState.mode = mode;
    }
    this.lastDominantAction = null;
    resetRootMotion(this.rootState);
  }

  consumeRootMotion(out: RootMotionDelta): boolean {
    return consumeRootState(this.rootState, out);
  }

  setMorphWeight(target: number, weight: number): void {
    if (!Number.isInteger(target) || target < 0 || target >= this.morphTargets) {
      throw animationError(
        "E_CONTRACT",
        `morph target ${target} outside 0..${this.morphTargets - 1}`,
      );
    }
    this.morphGame[target] = clampUnit(weight);
    this.recomputeMorphWeights();
  }

  readPose(out: PoseBuffer, which: "previous" | "current"): void {
    copyPose(out, which === "previous" ? this.previousPose : this.currentPose);
  }

  computePalette(out: JointPalette, alpha: number): void {
    const start = this.host.debug ? nowMs() : 0;
    computePaletteInto(
      this.skeleton,
      this.previousPose,
      this.currentPose,
      alpha,
      out,
      this.paletteScratch,
    );
    if (this.host.debug) this.host.reportPaletteMs(nowMs() - start);
  }

  // ------------------------------------------------------------------ update

  /** Advances one fixed tick. Called by `AnimationApi.update` in slot order. */
  update(dt: number): void {
    if (this.destroyed) return;
    for (let i = 0; i < this.actions.length; i += 1) {
      const action = this.actions[i]!;
      if (action.active) this.advanceAction(action, dt);
    }

    copyPose(this.previousPose, this.currentPose);
    let tracks = this.composeLayer(0, this.currentPose, this.morphClip);
    copyPose(this.basePose, this.currentPose);

    for (let layer = 1; layer < this.layers.length; layer += 1) {
      const state = this.layers[layer]!;
      if (state.weight <= 0) continue;
      const layerTracks = this.composeLayer(layer, this.layerPose, this.layerMorph);
      if (layerTracks > 0) {
        applyOverrideLayer(
          this.currentPose,
          this.layerPose,
          state.mask,
          state.weight,
        );
        tracks += layerTracks;
      }
    }

    this.recomputeMorphWeights();
    this.lastSampledTrackCount = tracks;

    this.updateRootMotion(dt);
    this.emitDominantEvents();

    if (this.host.debug) this.sanitizePose();
  }

  private advanceAction(action: AnimationActionHandle, dt: number): void {
    if (action.fadeMode === FADE_IN) {
      action.fadeElapsed += dt;
      if (action.fadeElapsed >= action.fadeDuration) {
        action.weight = action.fadeTarget;
        action.fadeMode = FADE_NONE;
      } else if (action.fadeDuration > 0) {
        action.weight =
          action.fadeTarget * (action.fadeElapsed / action.fadeDuration);
      }
    } else if (action.fadeMode === FADE_OUT) {
      action.fadeElapsed += dt;
      if (action.fadeElapsed >= action.fadeDuration) {
        action.retire();
        return;
      }
      if (action.fadeDuration > 0) {
        action.weight =
          action.fadeStart * (1 - action.fadeElapsed / action.fadeDuration);
      }
    }

    const source = action.sourceInternal;
    if (source === null) return;
    if (isTree1D(source)) {
      this.advanceTree(action, source, dt);
    } else {
      this.advanceClip(action, source as AnimationClip, dt);
    }
  }

  private advanceClip(
    action: AnimationActionHandle,
    clip: AnimationClip,
    dt: number,
  ): void {
    action.previousTime = action.time;
    action.wrapped = false;
    if (action.speed > 0) {
      const duration = clip.duration;
      let next = action.time + action.speed * dt;
      if (action.loop === "once") {
        if (next > duration) next = duration;
      } else if (next >= duration) {
        action.wrapped = true;
        next = next % duration;
        if (!Number.isFinite(next) || next < 0) next = 0;
      }
      action.time = next;
    }
    action.currentTime = action.time;
  }

  private advanceTree(
    action: AnimationActionHandle,
    tree: BlendTree1D,
    dt: number,
  ): void {
    evaluateBlend1D(tree, action.parameter, action.sampleWeights);
    action.dominantSample = dominantSampleIndex(
      action.sampleWeights,
      tree.samples.length,
    );
    const syncPhase = tree.syncPhase !== false;
    if (syncPhase) {
      let rate = 0;
      for (let i = 0; i < tree.samples.length; i += 1) {
        const weight = action.sampleWeights[i]!;
        if (weight > 0) rate += weight / tree.samples[i]!.clip.duration;
      }
      const previousPhase = action.time;
      let phase = previousPhase;
      if (rate > 0 && action.speed > 0) phase += action.speed * dt * rate;
      let wrapped = false;
      if (phase >= 1) {
        wrapped = true;
        phase -= Math.floor(phase);
      } else if (phase < 0) {
        phase = 0;
      }
      action.time = phase;
      action.wrapped = wrapped;
      for (let i = 0; i < tree.samples.length; i += 1) {
        const duration = tree.samples[i]!.clip.duration;
        action.previousSampleTimes[i] = previousPhase * duration;
        action.sampleTimes[i] = phase * duration;
        action.sampleWrapped[i] = wrapped ? 1 : 0;
      }
      action.previousTime = action.previousSampleTimes[action.dominantSample]!;
      action.currentTime = action.sampleTimes[action.dominantSample]!;
    } else {
      for (let i = 0; i < tree.samples.length; i += 1) {
        const sample = tree.samples[i]!;
        const duration = sample.clip.duration;
        const previous = action.sampleTimes[i]!;
        let next = previous + (sample.speed ?? 1) * action.speed * dt;
        let wrapped = false;
        if (next >= duration) {
          wrapped = true;
          next = next % duration;
          if (!Number.isFinite(next) || next < 0) next = 0;
        }
        action.previousSampleTimes[i] = previous;
        action.sampleTimes[i] = next;
        action.sampleWrapped[i] = wrapped ? 1 : 0;
      }
      action.wrapped = false;
      action.time = action.sampleTimes[action.dominantSample]!;
      action.previousTime = action.previousSampleTimes[action.dominantSample]!;
      action.currentTime = action.time;
    }
  }

  // ------------------------------------------------------------- composition

  private composeLayer(
    layerIndex: number,
    outPose: PoseBuffer,
    outMorph: Float32Array,
  ): number {
    copyPose(outPose, this.skeleton.restPose);
    for (let i = 0; i < outMorph.length; i += 1) outMorph[i] = 0;

    const scratch = this.actionOrderScratch;
    let count = 0;
    for (let i = 0; i < this.actions.length; i += 1) {
      const action = this.actions[i]!;
      if (!action.active || action.layerInternal !== layerIndex) continue;
      if (clampUnit(action.weight) <= 0) continue;
      scratch[count] = i;
      count += 1;
    }
    if (count === 0) return 0;

    // Insertion sort by creation order; eight entries at most.
    for (let i = 1; i < count; i += 1) {
      const value = scratch[i]!;
      const order = this.actions[value]!.order;
      let j = i - 1;
      while (j >= 0 && this.actions[scratch[j]!]!.order > order) {
        scratch[j + 1] = scratch[j]!;
        j -= 1;
      }
      scratch[j + 1] = value;
    }

    // Cumulative normalization: for normalized weights the result is exactly
    // the weighted average and the rest pose is never double-counted.
    let cumulative = 0;
    let tracks = 0;
    let first = true;
    for (let i = 0; i < count; i += 1) {
      const action = this.actions[scratch[i]!]!;
      const weight = clampUnit(action.weight);
      tracks += this.sampleAction(action, this.actionPose, this.actionMorph);
      cumulative += weight;
      const fraction = cumulative > 0 ? weight / cumulative : 1;
      if (first) {
        copyPose(outPose, this.actionPose);
        for (let m = 0; m < outMorph.length; m += 1) {
          outMorph[m] = this.actionMorph[m]!;
        }
        first = false;
      } else {
        this.blendPoseInto(outPose, this.actionPose, fraction);
        for (let m = 0; m < outMorph.length; m += 1) {
          const current = outMorph[m]!;
          outMorph[m] = current + (this.actionMorph[m]! - current) * fraction;
        }
      }
    }
    return tracks;
  }

  private sampleAction(
    action: AnimationActionHandle,
    outPose: PoseBuffer,
    outMorph: Float32Array,
  ): number {
    const source = action.sourceInternal;
    if (source === null) {
      copyPose(outPose, this.skeleton.restPose);
      for (let i = 0; i < outMorph.length; i += 1) outMorph[i] = 0;
      return 0;
    }
    if (!isTree1D(source)) {
      copyPose(outPose, this.skeleton.restPose);
      for (let i = 0; i < outMorph.length; i += 1) outMorph[i] = 0;
      return sampleClipInto(
        source as AnimationClip,
        action.time,
        outPose,
        outMorph.length > 0 ? outMorph : null,
      );
    }

    copyPose(this.treePose, this.skeleton.restPose);
    for (let i = 0; i < this.treeMorph.length; i += 1) this.treeMorph[i] = 0;
    let tracks = 0;
    let cumulative = 0;
    let first = true;
    const syncPhase = source.syncPhase !== false;
    for (let i = 0; i < source.samples.length; i += 1) {
      const weight = action.sampleWeights[i]!;
      if (weight <= 0) continue;
      const sample = source.samples[i]!;
      copyPose(this.samplePose, this.skeleton.restPose);
      for (let m = 0; m < this.sampleMorph.length; m += 1) this.sampleMorph[m] = 0;
      const localTime = syncPhase
        ? action.time * sample.clip.duration
        : action.sampleTimes[i]!;
      tracks += sampleClipInto(
        sample.clip,
        localTime,
        this.samplePose,
        this.sampleMorph.length > 0 ? this.sampleMorph : null,
      );
      cumulative += weight;
      const fraction = cumulative > 0 ? weight / cumulative : 1;
      if (first) {
        copyPose(this.treePose, this.samplePose);
        for (let m = 0; m < this.treeMorph.length; m += 1) {
          this.treeMorph[m] = this.sampleMorph[m]!;
        }
        first = false;
      } else {
        this.blendPoseInto(this.treePose, this.samplePose, fraction);
        for (let m = 0; m < this.treeMorph.length; m += 1) {
          const current = this.treeMorph[m]!;
          this.treeMorph[m] =
            current + (this.sampleMorph[m]! - current) * fraction;
        }
      }
    }
    copyPose(outPose, this.treePose);
    for (let m = 0; m < outMorph.length; m += 1) {
      outMorph[m] = this.treeMorph[m]!;
    }
    return tracks;
  }

  private blendPoseInto(
    out: PoseBuffer,
    sample: PoseBuffer,
    fraction: number,
  ): void {
    if (fraction <= 0) return;
    for (let joint = 0; joint < out.jointCount; joint += 1) {
      lerpInto(
        out.translations,
        joint * 3,
        out.translations,
        joint * 3,
        sample.translations,
        joint * 3,
        3,
        fraction,
      );
      lerpInto(
        out.scales,
        joint * 3,
        out.scales,
        joint * 3,
        sample.scales,
        joint * 3,
        3,
        fraction,
      );
      nlerpInto(
        out.rotations,
        joint * 4,
        out.rotations,
        joint * 4,
        sample.rotations,
        joint * 4,
        fraction,
      );
    }
  }

  private recomputeMorphWeights(): void {
    if (this.morphTargets === 0) return;
    const baseWeight = this.layers[0]!.weight;
    for (let i = 0; i < this.morphTargets; i += 1) {
      const value = this.morphClip[i]! * baseWeight + this.morphGame[i]!;
      this.morphWeights[i] = clampUnit(value);
    }
  }

  // ------------------------------------------------------------- root motion

  private dominantBaseAction(): AnimationActionHandle | null {
    let best: AnimationActionHandle | null = null;
    let bestWeight = -1;
    for (let i = 0; i < this.actions.length; i += 1) {
      const action = this.actions[i]!;
      if (!action.active || action.layerInternal !== 0) continue;
      const weight = clampUnit(action.weight);
      if (weight <= 0) continue;
      if (
        best === null ||
        weight > bestWeight ||
        (weight === bestWeight && action.order < best.order)
      ) {
        best = action;
        bestWeight = weight;
      }
    }
    return best;
  }

  private updateRootMotion(dt: number): void {
    if (this.rootState.mode === "none") return;
    const rootJoint = this.rootState.options.rootJoint;
    if (
      !sampleRootModelTransform(
        this.skeleton,
        this.basePose,
        rootJoint,
        this.rootCurrentMatrix,
        this.rootScratch,
      )
    ) {
      return;
    }
    const dominant = this.dominantBaseAction();
    if (dominant !== this.lastDominantAction) {
      this.rootState.resetRequested = true;
      this.lastDominantAction = dominant;
    }
    computeRootDelta(this.rootState, this.rootCurrentMatrix, dt);
    if (!this.rootState.tickValid) return;
    if (this.rootState.mode === "apply" && this.transform !== undefined) {
      applyRootDelta(
        this.transform.position,
        this.transform.rotation,
        this.rootState.translation,
        this.rootState.rotation,
        this.rootApplyScratch,
      );
      removeRootFromPose(
        this.currentPose,
        rootJoint,
        this.rootState.options.applyVertical,
        this.rootState.options.applyYaw,
        this.rootPoseScratch,
      );
    }
  }

  // ---------------------------------------------------------------- events

  private emitDominantEvents(): void {
    const action = this.dominantBaseAction();
    if (action === null) return;
    const source = action.sourceInternal;
    if (source === null) return;
    if (isTree1D(source)) {
      const sample = source.samples[action.dominantSample];
      if (sample === undefined) return;
      this.emitWindow(
        sample.clip,
        action.previousSampleTimes[action.dominantSample]!,
        action.sampleTimes[action.dominantSample]!,
        action.sampleWrapped[action.dominantSample] === 1,
      );
      return;
    }
    this.emitWindow(
      source as AnimationClip,
      action.previousTime,
      action.currentTime,
      action.wrapped,
    );
  }

  private emitWindow(
    clip: AnimationClip,
    previousTime: number,
    currentTime: number,
    wrapped: boolean,
  ): void {
    const events = clip.events;
    if (events.length === 0) return;
    const duration = clip.duration;
    if (wrapped) {
      for (let i = 0; i < events.length; i += 1) {
        const event = events[i]!;
        if (event.time > previousTime && event.time <= duration) {
          this.host.emitEvent(
            this.entity,
            clip,
            event.name,
            event.payload,
            event.time,
          );
        }
      }
      for (let i = 0; i < events.length; i += 1) {
        const event = events[i]!;
        if (event.time >= 0 && event.time <= currentTime) {
          this.host.emitEvent(
            this.entity,
            clip,
            event.name,
            event.payload,
            event.time,
          );
        }
      }
      return;
    }
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i]!;
      if (event.time > previousTime && event.time <= currentTime) {
        this.host.emitEvent(
          this.entity,
          clip,
          event.name,
          event.payload,
          event.time,
        );
      }
    }
  }

  // ---------------------------------------------------------------- helpers

  private requireLayer(layer: number): void {
    if (!Number.isInteger(layer) || layer < 0 || layer >= this.layers.length) {
      throw animationError(
        "E_CONTRACT",
        `layer ${layer} outside 0..${this.layers.length - 1}`,
      );
    }
  }

  private validateSource(
    source: Playable,
    options: PlayOptions | undefined,
  ): void {
    if ("kind" in source) {
      if (source.kind === "2d") {
        throw animationError(
          "E_UNSUPPORTED_FEATURE",
          "2D blend trees are M2; rejected in M1",
        );
      }
      validateBlendTree1D(source);
    } else {
      if (!(source.duration > 0)) {
        throw animationError(
          "E_ASSET_FORMAT",
          `clip "${source.name}" has no duration`,
        );
      }
      if (!Number.isInteger(source.rootJoint)) {
        throw animationError(
          "E_CONTRACT",
          `clip "${source.name}" has an invalid rootJoint`,
        );
      }
    }
    if (options?.loop === "ping-pong") {
      throw animationError(
        "E_UNSUPPORTED_FEATURE",
        "ping-pong looping is M2; rejected in M1",
      );
    }
  }

  private findAction(
    source: Playable,
    layer: number,
  ): AnimationActionHandle | null {
    let best: AnimationActionHandle | null = null;
    for (let i = 0; i < this.actions.length; i += 1) {
      const action = this.actions[i]!;
      if (!action.active || action.layerInternal !== layer) continue;
      if (action.sourceInternal !== source) continue;
      if (best === null || action.order < best.order) best = action;
    }
    return best;
  }

  private takeActionSlot(): AnimationActionHandle {
    for (let i = 0; i < this.actions.length; i += 1) {
      if (!this.actions[i]!.active) return this.actions[i]!;
    }
    let candidate = this.actions[0]!;
    for (let i = 1; i < this.actions.length; i += 1) {
      const action = this.actions[i]!;
      const weight = clampUnit(action.weight);
      const candidateWeight = clampUnit(candidate.weight);
      if (weight < candidateWeight) {
        candidate = action;
      } else if (weight === candidateWeight && action.order < candidate.order) {
        candidate = action;
      }
    }
    candidate.retire();
    return candidate;
  }

  private sanitizePose(): void {
    const translations = this.currentPose.translations;
    const rotations = this.currentPose.rotations;
    const scales = this.currentPose.scales;
    let bad = false;
    for (let i = 0; i < translations.length; i += 1) {
      if (!Number.isFinite(translations[i]!)) {
        translations[i] = 0;
        bad = true;
      }
    }
    for (let i = 0; i < rotations.length; i += 1) {
      if (!Number.isFinite(rotations[i]!)) {
        const base = i - (i % 4);
        rotations[base] = 0;
        rotations[base + 1] = 0;
        rotations[base + 2] = 0;
        rotations[base + 3] = 1;
        bad = true;
      }
    }
    for (let i = 0; i < scales.length; i += 1) {
      if (!Number.isFinite(scales[i]!)) {
        scales[i] = 1;
        bad = true;
      }
    }
    if (bad) this.host.counters.nonFinitePose += 1;
  }

  // ------------------------------------------------------------------- hash

  /** §4.6 per-instance stream; the API writes version/instanceCount/queue. */
  hashInto(hasher: StateHasher): void {
    hasher.u32(this.id);
    hasher.u32(this.skeleton.jointCount);
    const translations = this.currentPose.translations;
    const rotations = this.currentPose.rotations;
    const scales = this.currentPose.scales;
    const quat = this.hashQuat;
    for (let joint = 0; joint < this.skeleton.jointCount; joint += 1) {
      hasher.f32(translations[joint * 3]!);
      hasher.f32(translations[joint * 3 + 1]!);
      hasher.f32(translations[joint * 3 + 2]!);
      quat[0] = rotations[joint * 4]!;
      quat[1] = rotations[joint * 4 + 1]!;
      quat[2] = rotations[joint * 4 + 2]!;
      quat[3] = rotations[joint * 4 + 3]!;
      canonicalizeQuatAt(quat, 0);
      hasher.f32(quat[0]!);
      hasher.f32(quat[1]!);
      hasher.f32(quat[2]!);
      hasher.f32(quat[3]!);
      hasher.f32(scales[joint * 3]!);
      hasher.f32(scales[joint * 3 + 1]!);
      hasher.f32(scales[joint * 3 + 2]!);
    }
    hasher.u32(this.morphTargets);
    for (let i = 0; i < this.morphTargets; i += 1) {
      hasher.f32(this.morphWeights[i]!);
    }

    const scratch = this.actionOrderScratch;
    let count = 0;
    for (let i = 0; i < this.actions.length; i += 1) {
      if (this.actions[i]!.active) {
        scratch[count] = i;
        count += 1;
      }
    }
    // Sorted by layer, then creation order.
    for (let i = 1; i < count; i += 1) {
      const value = scratch[i]!;
      const action = this.actions[value]!;
      let j = i - 1;
      while (j >= 0) {
        const other = this.actions[scratch[j]!]!;
        const ordered =
          other.layerInternal < action.layerInternal ||
          (other.layerInternal === action.layerInternal &&
            other.order <= action.order);
        if (ordered) break;
        scratch[j + 1] = scratch[j]!;
        j -= 1;
      }
      scratch[j + 1] = value;
    }
    hasher.u32(count);
    for (let i = 0; i < count; i += 1) {
      const action = this.actions[scratch[i]!]!;
      const source = action.sourceInternal;
      if (source === null) {
        hasher.u8(0);
        hasher.u32(0);
        hasher.f32(0);
        hasher.f32(0);
        hasher.u8(0);
        continue;
      }
      const kind = sourceKind(source);
      hasher.u8(kind);
      hasher.u32(fnv1aString(this.dominantClipName(action, source)));
      hasher.f32(action.normalizedTime);
      hasher.f32(action.weight);
      hasher.u8(action.runningInternal ? 1 : 0);
    }
  }

  private dominantClipName(
    action: AnimationActionHandle,
    source: Playable,
  ): string {
    if (!isTree1D(source)) return (source as AnimationClip).name;
    const index = dominantSampleIndex(
      action.sampleWeights,
      source.samples.length,
    );
    return source.samples[index]?.clip.name ?? "";
  }

  /** Stats helper: the number of active actions. */
  activeActionCount(): number {
    let count = 0;
    for (let i = 0; i < this.actions.length; i += 1) {
      if (this.actions[i]!.active) count += 1;
    }
    return count;
  }

  /** Stats helper: pose bytes = two 40 B/joint buffers. */
  poseBytes(): number {
    return this.skeleton.jointCount * 80;
  }

  /** Stats helper: append distinct clips referenced by active actions. */
  collectClips(out: AnimationClip[]): void {
    for (let i = 0; i < this.actions.length; i += 1) {
      const action = this.actions[i]!;
      if (!action.active) continue;
      const source = action.sourceInternal;
      if (source === null) continue;
      if (isTree1D(source)) {
        for (let s = 0; s < source.samples.length; s += 1) {
          addClip(out, source.samples[s]!.clip);
        }
      } else {
        addClip(out, source as AnimationClip);
      }
    }
  }

  /** Called by `AnimationApi.destroyInstance`; idempotent. */
  dispose(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (let i = 0; i < this.actions.length; i += 1) {
      this.actions[i]!.retire();
    }
  }
}

function addClip(out: AnimationClip[], clip: AnimationClip): void {
  for (let i = 0; i < out.length; i += 1) {
    if (out[i] === clip) return;
  }
  out.push(clip);
}
