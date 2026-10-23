/**
 * `AnimationApi` facade (spec 08 §3.5, §5.2, §5.10, §5.13–§5.14).
 *
 * A dense slot table (ascending slot index is the deterministic iteration
 * order), a monotonic instance id, the shared event queue and the canonical
 * state hasher. Boundary calls validate; `update` never throws.
 */

import type { Entity, Scene } from "@lanpad/engine-core";
import { Transform } from "@lanpad/engine-core";
import type {
  AnimationApi,
  AnimationApiOptions,
  AnimationClip,
  AnimationEvent,
  AnimationInstance,
  AnimationInstanceOptions,
  AnimationStats,
  Skeleton,
} from "../contracts/animation.js";
import { AnimationInstanceImpl } from "./AnimationInstance.js";
import type { AnimationInstanceHost } from "./AnimationInstance.js";
import type { AnimationCounters } from "../errors.js";
import { animationError, createCounters, IS_DEV } from "../errors.js";
import { EventQueue } from "../events/eventQueue.js";
import { StateHasher, fnv1aString } from "../hash/hash.js";
import {
  ANIMATION_DEFAULT_EVENT_CAPACITY,
  ANIMATION_DEFAULT_FIXED_STEP,
  ANIMATION_DEFAULT_MAX_INSTANCES,
  ANIMATION_HASH_VERSION,
  ANIMATION_MAX_INSTANCES_HARD,
  ANIMATION_MAX_PENDING_EVENTS,
} from "../version.js";

function nowMs(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof perf?.now === "function" ? perf.now() : 0;
}

export class AnimationApiImpl implements AnimationApi, AnimationInstanceHost {
  readonly scene: Scene | undefined;
  readonly debug: boolean;
  readonly counters: AnimationCounters;
  readonly fixedStep: number;
  readonly maxInstances: number;

  private readonly queue: EventQueue;
  private readonly slots: (AnimationInstanceImpl | null)[];
  private readonly byEntity = new Map<number, AnimationInstanceImpl>();
  private readonly clipScratch: AnimationClip[] = [];
  private nextId = 0;
  private disposed = false;
  private lastSampledTrackCount = 0;
  private lastUpdateMs = 0;
  private lastPaletteMs = 0;
  private liveCount = 0;

  constructor(options?: AnimationApiOptions) {
    const fixedStep = options?.fixedStep ?? ANIMATION_DEFAULT_FIXED_STEP;
    if (!Number.isFinite(fixedStep) || fixedStep <= 0) {
      throw animationError(
        "E_CONTRACT",
        "fixedStep must be a positive finite number",
      );
    }
    let maxInstances = options?.maxInstances ?? ANIMATION_DEFAULT_MAX_INSTANCES;
    if (!Number.isInteger(maxInstances) || maxInstances < 1) {
      throw animationError("E_CONTRACT", "maxInstances must be a positive integer");
    }
    if (maxInstances > ANIMATION_MAX_INSTANCES_HARD) {
      maxInstances = ANIMATION_MAX_INSTANCES_HARD;
    }
    let eventCapacity = options?.eventCapacity ?? ANIMATION_DEFAULT_EVENT_CAPACITY;
    if (!Number.isInteger(eventCapacity) || eventCapacity < 1) {
      throw animationError(
        "E_CONTRACT",
        "eventCapacity must be a positive integer",
      );
    }
    if (eventCapacity > ANIMATION_MAX_PENDING_EVENTS) {
      eventCapacity = ANIMATION_MAX_PENDING_EVENTS;
    }
    this.fixedStep = fixedStep;
    this.maxInstances = maxInstances;
    this.debug = options?.debug ?? false;
    this.scene = options?.scene;
    this.counters = createCounters();
    this.queue = new EventQueue(eventCapacity);
    this.slots = [];
    for (let i = 0; i < maxInstances; i += 1) this.slots.push(null);
  }

  // ------------------------------------------------------------- lifecycle

  createInstance(
    entity: Entity,
    skeleton: Skeleton,
    options?: AnimationInstanceOptions,
  ): AnimationInstance {
    if (this.disposed) {
      throw animationError("E_CONTRACT", "createInstance after dispose");
    }
    if (this.scene !== undefined) {
      if (!this.scene.isAlive(entity)) {
        if (IS_DEV) {
          throw animationError(
            "E_STALE_HANDLE",
            `createInstance for a dead entity ${entity.id}:${entity.generation}`,
          );
        }
        this.counters.noOpInstance += 1;
        return new AnimationInstanceImpl(
          this,
          this.nextId++,
          entity,
          skeleton,
          options,
          true,
        );
      }
      if (this.scene.get(entity, Transform) === undefined) {
        throw animationError(
          "E_CONTRACT",
          `entity ${entity.id}:${entity.generation} has no Transform`,
        );
      }
    }

    const existing = this.byEntity.get(entity.id);
    if (existing !== undefined) {
      if (existing.entity.generation === entity.generation) {
        throw animationError(
          "E_CONTRACT",
          `entity ${entity.id}:${entity.generation} already has an animation instance`,
        );
      }
      this.destroyInstance(existing);
    }

    const slot = this.findFreeSlot();
    if (slot < 0) {
      this.counters.noOpInstance += 1;
      return new AnimationInstanceImpl(
        this,
        this.nextId++,
        entity,
        skeleton,
        options,
        true,
      );
    }
    const instance = new AnimationInstanceImpl(
      this,
      this.nextId++,
      entity,
      skeleton,
      options,
      false,
    );
    instance.slot = slot;
    this.slots[slot] = instance;
    this.byEntity.set(entity.id, instance);
    this.liveCount += 1;
    return instance;
  }

  destroyInstance(instance: AnimationInstance): void {
    if (this.disposed) return;
    if (!(instance instanceof AnimationInstanceImpl)) return;
    if (instance.destroyed) return;
    instance.dispose();
    if (instance.slot >= 0 && this.slots[instance.slot] === instance) {
      this.slots[instance.slot] = null;
      this.liveCount -= 1;
    }
    const bound = this.byEntity.get(instance.entity.id);
    if (bound === instance) this.byEntity.delete(instance.entity.id);
  }

  getInstance(entity: Entity): AnimationInstance | null {
    const instance = this.byEntity.get(entity.id);
    if (instance === undefined || instance.destroyed) return null;
    if (instance.entity.generation !== entity.generation) return null;
    return instance;
  }

  // ----------------------------------------------------------------- update

  update(dt: number): void {
    if (this.disposed) return;
    if (!Number.isFinite(dt) || dt <= 0) return;
    let step = dt;
    if (Math.abs(dt - this.fixedStep) > 1e-9) {
      this.counters.dtClamp += 1;
      step = this.fixedStep;
    }
    const start = this.debug ? nowMs() : 0;
    let tracks = 0;
    for (let i = 0; i < this.slots.length; i += 1) {
      const instance = this.slots[i] ?? null;
      if (instance === null || instance.destroyed) continue;
      instance.update(step);
      tracks += instance.lastSampledTrackCount;
    }
    this.lastSampledTrackCount = tracks;
    if (this.debug) this.lastUpdateMs = nowMs() - start;
  }

  // ----------------------------------------------------------------- events

  emitEvent(
    entity: Entity,
    clip: AnimationClip,
    name: string,
    payload: number,
    time: number,
  ): void {
    this.counters.eventsEmitted += 1;
    if (!this.queue.push(entity, clip, name, payload, time)) {
      this.counters.eventsDropped += 1;
    }
  }

  reportPaletteMs(ms: number): void {
    this.lastPaletteMs = ms;
  }

  drainEvents(out: AnimationEvent[]): number {
    if (this.disposed) return 0;
    return this.queue.drain(out);
  }

  // ------------------------------------------------------------------ hash

  stateHash(): number {
    const hasher = new StateHasher();
    hasher.u32(ANIMATION_HASH_VERSION);
    let count = 0;
    for (let i = 0; i < this.slots.length; i += 1) {
      const instance = this.slots[i] ?? null;
      if (instance !== null && !instance.destroyed) count += 1;
    }
    hasher.u32(count);
    for (let i = 0; i < this.slots.length; i += 1) {
      const instance = this.slots[i] ?? null;
      if (instance !== null && !instance.destroyed) instance.hashInto(hasher);
    }
    hasher.u32(this.queue.size);
    for (let i = 0; i < this.queue.size; i += 1) {
      const record = this.queue.peek(i);
      if (record === undefined) continue;
      hasher.u32(fnv1aString(record.name));
      hasher.i32(record.payload);
      hasher.f32(record.time);
    }
    return hasher.finish();
  }

  // ------------------------------------------------------------------ stats

  get stats(): AnimationStats {
    this.clipScratch.length = 0;
    let jointCount = 0;
    let activeActions = 0;
    let poseBytes = 0;
    let live = 0;
    for (let i = 0; i < this.slots.length; i += 1) {
      const instance = this.slots[i] ?? null;
      if (instance === null || instance.destroyed) continue;
      live += 1;
      jointCount += instance.skeleton.jointCount;
      activeActions += instance.activeActionCount();
      poseBytes += instance.poseBytes();
      instance.collectClips(this.clipScratch);
    }
    let clipBytes = 0;
    for (let i = 0; i < this.clipScratch.length; i += 1) {
      clipBytes += this.clipScratch[i]!.sourceBytes;
    }
    return {
      instanceCount: live,
      jointCount,
      activeActionCount: activeActions,
      sampledTrackCount: this.lastSampledTrackCount,
      eventsEmitted: this.counters.eventsEmitted,
      eventsDropped: this.counters.eventsDropped,
      updateMs: this.debug ? this.lastUpdateMs : 0,
      paletteMs: this.debug ? this.lastPaletteMs : 0,
      clipBytes,
      poseBytes,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (let i = 0; i < this.slots.length; i += 1) {
      const instance = this.slots[i] ?? null;
      if (instance !== null) instance.dispose();
      this.slots[i] = null;
    }
    this.byEntity.clear();
    this.queue.clear();
    this.liveCount = 0;
  }

  /** Test/debug helper: live instances in ascending slot order. */
  get liveInstanceCount(): number {
    return this.liveCount;
  }

  private findFreeSlot(): number {
    for (let i = 0; i < this.slots.length; i += 1) {
      if (this.slots[i] === null) return i;
    }
    return -1;
  }
}

/** Factory used by `packages/engine/animation/src/index.ts`. */
export function createAnimationApi(options?: AnimationApiOptions): AnimationApi {
  return new AnimationApiImpl(options);
}
