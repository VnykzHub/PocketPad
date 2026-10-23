# 08 — Animation

**Status:** target contract for the engine's skeletal animation subsystem. **No animation code exists in this tree today.** There is no glTF loader, no skeleton, no skinning path, and no animation sampling anywhere in the current runtime. This document is the interface to implement against; it is not a claim of implementation.
**Authority:** [`SPEC.md`](../../SPEC.md) for the product/protocol contract, [`docs/ENGINE.md`](../ENGINE.md) for what exists today, [`docs/engine/README.md`](README.md) for the programme rules, [`00-architecture.md`](00-architecture.md) for package boundaries and frozen contracts, [`02-math.md`](02-math.md) for coordinate, quaternion and matrix conventions. Where this spec and `SPEC.md` disagree, `SPEC.md` wins until an amendment is recorded in [`docs/todos/README.md`](../todos/README.md).
**Package:** `@lanpad/engine-animation`, package root `packages/engine/animation/` (00 §3.7, §5.3 and §6; 00 §6 assigns `packages/engine/animation/**` to this spec and says "Package skeleton only in M0"). This spec owns that directory and its tests. The wave brief's shorthand `packages/animation/src/**` resolves here; no `packages/animation/` is created.
**Milestone:** M0 ships only the package skeleton and the compiled-data types (00 §5.14 explicitly defers skeletal animation from M0). M1 ships skeletal clips, crossfades, 1D blend trees, a base plus one override layer, root motion, events and vertex-shader skinning. M2 adds additive layers, 2D blend trees, morph targets and compressed `.pclip` as the default runtime clip format.

---

## 1. Goal

Give PocketPad games **deterministic skeletal animation** that is good enough for the M1 vertical slice (a walking character, a run cycle, pedestrians, a mission NPC) and shaped so the M3 open-world target — crowds of animated pedestrians and traffic — does not require replacing the subsystem.

The player-visible outcome:

- a character's walk, run and idle cycles blend without a T-pose pop or foot skate at the blend boundary;
- a crossfade between two clips is smooth, rate-correct at 60 Hz simulation and 120 Hz display, and does not restart the foot phase;
- footsteps, attack windows and other authored moments fire exactly once, in order, on the simulation tick that reaches them;
- a character driven by root motion moves the distance its animation was authored to move, without sliding, and a looping clip does not teleport at the seam;
- skinned characters render through the WebGPU backend and the WebGL2 fallback with the same pose;
- 64 animated characters at 60 joints each stay inside the frame budget with no per-frame garbage.

The engineering outcome:

1. one public surface (`AnimationApi` plus the compiled `Skeleton`/`AnimationClip` types) that games and the runtime code against, so a future sampler or skinning backend is invisible;
2. fixed-tick sampling with no wall clock, no `Math.random`, no `Map`/`Set` iteration and no per-tick allocation after warm-up (00 §5.8, §5.10);
3. a strict CPU/GPU split: this package samples poses and joint palettes; renderer specs 04 and 05 upload and draw them; neither side reaches into the other;
4. a glTF mapping that a fresh implementer can follow without guessing which node, skin, track or accessor becomes which runtime object.

**North-star constraint, not a promise.** Vice City-scale crowds mean hundreds of skinned characters, many clips, streaming skeletons and animation-driven crowds. This spec fixes the architecture for that ceiling — shared skeletons, dense instance storage, preallocated poses, bone-texture skinning, quantized clips — but measures only M1 numbers.

---

## 2. Non-goals

- **No inverse kinematics (IK), look-at, foot planting, aim offsets or procedural bone correction.** These are separate gameplay systems that may land later behind additive APIs; the M1 pose is clip-driven only.
- **No ragdolls or physics-driven bones.** Spec 07 owns physics; a ragdoll bridge is an M2+ joint effort and would write joint targets, not run inside this package.
- **No retargeting between different skeletons.** A clip compiles against one skeleton. Retargeting is a tooling feature that produces clips for the target skeleton; the runtime never retargets.
- **No facial animation beyond morph targets.** Lip-sync, visemes and procedural expressions are out of scope.
- **No cloth, hair or soft-body simulation.**
- **No animation authoring, curve editing or timeline UI.** Spec 17 owns the editor. This spec defines the data the editor writes.
- **No glTF byte parsing.** `engine-assets` (spec 06) owns GLB/glTF parsing and accessor decoding. This package consumes decoded `SkeletonSource`/`AnimationSource` data. Animation never imports a renderer backend, the DOM, protocol, SDK, runtime or a game.
- **No compute skinning or dual-quaternion skinning in M1.** M1 is vertex-shader linear blend skinning with four influences on both backends. Compute skinning is an additive M2+ path; dual-quaternion skinning is not planned.
- **No more than 256 joints per skeleton, more than four influences per vertex, or more than eight active morph targets in M1/M2.**
- **No cross-browser bit-identical animation.** Same build, same browser, same tick and same clip state must produce the same pose. `Math.sin`/`Math.cos`/`Math.sqrt` last-bit differences between engines are accepted per 00 §5.8.
- **No networked animation state.** Spec 14 owns state sync. Clips are local assets; a game that needs synchronized emotes sends its own gameplay event.
- **No frame-rate-dependent sampling.** Animation advances once per fixed tick; rendering only interpolates between the last two ticks.

---

## 3. Public interfaces

All types use `engine-core` math (`Vec3`, `Quat`, `Entity`) and the conventions of 02. Signatures are normative in shape. The surface below is **frozen after the M1 release**: changes are additive (new optional fields, new clip paths, new layer modes) or require an engine major plus an amendment. Types that games see are restated structurally in `@lanpad/sdk`; the SDK imports no engine package (00 §3.6).

### 3.1 Limits and conventions

| Property | Rule |
|---|---|
| Units | Metres, seconds, radians |
| Axes | Right-handed, **+Y up**, **−Z forward** (02 §3.1). No axis conversion is applied to glTF assets |
| Rotations | Unit quaternions `(x, y, z, w)`, normalized on every write |
| Matrices | Column-major, 16 floats; `Mat4` layout from 02 |
| Joint order | Topological: `parents[i] < i` for every non-root joint; 1..16 roots with `parents[i] === -1` |
| Joints per skeleton | 1..256; 257 is rejected at compile |
| Influences per vertex | 4 (hard); weights normalized at import; unused influences are joint 0, weight 0 |
| Morph targets | 32 authored, 8 active per mesh (M2) |
| Instances | 256 recommended, 1,024 hard per `AnimationApi` |
| Layers per instance | 2 in M1, 8 hard in M2; exactly one base layer |
| Actions per instance | 8 active; exhausted fade-outs are retired oldest-first |
| Clip duration | `> 0` and `<= 3,600` s |
| Keys per clip / per track | 200,000 / 65,535 |
| Tracks per clip | 1,024 |
| Events per clip | 256 |
| Event queue | 512 pending events per `AnimationApi` |
| Clip name | 1..64 UTF-8 bytes, no control characters; unique per skeleton at load is not required |
| Event name | `^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$` (same shape as protocol event names) |

### 3.2 Skeleton and pose

```ts
import type { Entity, Quat, Vec3 } from "@lanpad/engine-core";

/** A compiled skeleton. Immutable after compile; shared by every instance. */
export interface Skeleton {
  readonly jointCount: number;
  /** Stable asset identity; used only to reject a clip compiled against another skeleton. */
  readonly id?: string;
  /** Parent joint index; a root is -1; parents[i] < i for every non-root joint. */
  readonly parents: Int16Array;
  /** 16 floats per joint, column-major, model space; the skin's inverse bind matrices. */
  readonly inverseBindMatrices: Float32Array;
  /** Local bind-pose TRS, copied into every new instance's pose buffers. */
  readonly restPose: PoseBuffer;
  /** Default root joint for root motion; the first root unless the skeleton declares another. */
  readonly rootJoint: number;
  /** Debug/authoring names, index-aligned with joints; never used for lookup in a hot path. */
  readonly jointNames: readonly string[];
}

/** Local-space TRS pose, structure-of-arrays, caller- or instance-owned. */
export interface PoseBuffer {
  readonly jointCount: number;
  readonly translations: Float32Array; // 3 floats per joint
  readonly rotations: Float32Array;    // 4 floats per joint, (x, y, z, w)
  readonly scales: Float32Array;       // 3 floats per joint
}

/** Model-space skinning palette: jointWorldModel * inverseBind. */
export interface JointPalette {
  readonly jointCount: number;
  readonly matrices: Float32Array;     // 16 floats per joint, column-major
}

/** Allocates; cold path only (instance creation or load). */
export function createPoseBuffer(jointCount: number): PoseBuffer;
export function createJointPalette(jointCount: number): JointPalette;
/** Allocation-free copy; aliasing is rejected in dev. */
export function copyPose(out: PoseBuffer, source: PoseBuffer): void;
```

Rules:

- `createPoseBuffer` initializes every joint to identity (`T = 0`, `R = (0,0,0,1)`, `S = 1`). It does **not** know the rest pose; `AnimationApi.createInstance` copies `skeleton.restPose` into both instance buffers.
- A `PoseBuffer` is always sized exactly to its skeleton. Passing a buffer with a different `jointCount` to any API is `E_CONTRACT` in dev and a counted no-op in production.
- `JointPalette.matrices` is model space. The renderer applies the entity's model matrix after skinning; the palette must **not** include the entity transform.
- The palette is computed from the interpolated pose at render time (§5.9) and is owned by the caller (the runtime's render path), not by the instance.

### 3.3 Clips, tracks and events

```ts
export type TrackPath = "translation" | "rotation" | "scale" | "weights";
export type TrackInterpolation = "linear" | "step";
export type ClipLoopMode = "repeat" | "once" | "ping-pong"; // ping-pong is M2

export interface AnimationTrack {
  /** Joint index for TRS paths; morph-target index for "weights". */
  readonly target: number;
  readonly path: TrackPath;
  readonly interpolation: TrackInterpolation;
  /** Seconds, strictly ascending, length === keyCount. */
  readonly times: Float32Array;
  /** 3/4/3/1 floats per key. Immutable and shared; never mutated after compile. */
  readonly values: Float32Array;
  readonly keyCount: number;
  readonly valueStride: 3 | 4 | 1;
}

export interface ClipEvent {
  /** Seconds from clip start, in [0, duration]. */
  readonly time: number;
  readonly name: string;
  /** Signed 32-bit gameplay payload; 0 when unused. */
  readonly payload: number;
}

export interface AnimationClip {
  readonly name: string;
  readonly duration: number;           // seconds, > 0
  readonly loop: ClipLoopMode;         // default for playback
  readonly tracks: readonly AnimationTrack[];
  readonly events: readonly ClipEvent[];
  /** Joint index used for root motion; -1 disables root motion. */
  readonly rootJoint: number;
  /** Retained CPU bytes for stats and budgets. */
  readonly sourceBytes: number;
}
```

Rules:

- Tracks are sorted by `(path order translation=0, rotation=1, scale=2, weights=3, target ascending)` at compile. Sampling iterates that order; a game must not depend on a different order.
- `times[0] >= 0`; `times[keyCount - 1] <= duration`; duplicate or out-of-order times are `E_ASSET_FORMAT`. A single-key track is a constant.
- Values are immutable after compile and may be shared by several clips (the compiler may deduplicate an identical constant track).
- A glTF `weights` channel is split at import into **one track per morph target** (`target` = morph-target index, `valueStride = 1`). Animation never sees an interleaved N-weight channel. M1 ignores `weights` tracks and drops them with a dev warning; M2 consumes them.
- Events are sorted by `(time ascending, authoring order)` at compile. Two events may share a time; both fire in authoring order.

### 3.4 Blend trees and layers

```ts
export interface BlendSample1D {
  readonly threshold: number;
  readonly clip: AnimationClip;
  readonly speed?: number;             // > 0, default 1
}

export interface BlendTree1D {
  readonly kind: "1d";
  /** 2..16 samples, sorted by ascending threshold with no duplicates. */
  readonly samples: readonly BlendSample1D[];
  /** Match normalized clip phase across samples. Default true. */
  readonly syncPhase?: boolean;
}

export interface BlendSample2D {
  readonly x: number;
  readonly y: number;
  readonly clip: AnimationClip;
  readonly speed?: number;
}

/** M2. Freeform Cartesian blend, top-four inverse-distance weights. */
export interface BlendTree2D {
  readonly kind: "2d";
  /** 2..16 samples. */
  readonly samples: readonly BlendSample2D[];
  readonly syncPhase?: boolean;
}

export interface BoneMask {
  /** ceil(jointCount / 32) u32 words. Bit i set means joint i is affected. */
  readonly joints: Uint32Array;
}

export interface LayerDesc {
  readonly name: string;               // 1..32 characters
  readonly mode: "base" | "override" | "additive";
  /** Default: every joint. Only meaningful for override/additive. */
  readonly mask?: BoneMask;
  /** 0..1, default 1. */
  readonly weight?: number;
}
```

Rules:

- A `BlendTree1D` with fewer than two samples, duplicate thresholds, or a non-finite threshold is rejected with `E_CONTRACT` when played.
- Below the first threshold or above the last, the end sample gets weight 1. Between two samples, weights are linear and sum to 1.
- `BlendTree2D` uses at most four contributing samples: squared distance to `(x, y)`, ascending; ties by sample index. An exact match within `1e-6` gives that sample weight 1. Otherwise `w_i = 1 / (d_i^2 + 1e-6)`, normalized. M2.
- Exactly one layer has `mode: "base"` and it is layer 0. M1 accepts at most one additional `override` layer; `additive` and more than two layers are rejected with `E_UNSUPPORTED_FEATURE` until M2.
- A mask only gates override/additive layers. The base layer always covers every joint.
- Masks are copied at instance creation; the game may not mutate a mask after creation.

### 3.5 Playback actions and `AnimationApi`

```ts
export type Playable = AnimationClip | BlendTree1D | BlendTree2D;

export interface PlayOptions {
  readonly loop?: ClipLoopMode;              // default clip.loop
  readonly speed?: number;                   // 0..10, default 1
  readonly weight?: number;                  // 0..1, default 1
  readonly fadeInSeconds?: number;           // 0..10; see the crossfade rule
  readonly fadeOutPreviousSeconds?: number;  // 0..10, default 0.2; 0 = hard cut
  readonly restart?: boolean;                // default true
  readonly parameter?: number;               // 1D tree, default 0; ignored for clips
  readonly parameterX?: number;              // 2D tree, default 0
  readonly parameterY?: number;              // 2D tree, default 0
  readonly layer?: number;                   // default 0
}

export interface AnimationAction {
  readonly source: Playable;
  readonly layer: number;
  /** Seconds into the source; for a tree, the group phase scaled to each sample. */
  time: number;
  /** [0, 1); live value derived from time. */
  readonly normalizedTime: number;
  weight: number;
  speed: number;
  readonly running: boolean;
  stop(fadeOutSeconds?: number): void;
  /** 1D tree parameter; no-op for clips and 2D trees. */
  setParameter(value: number): void;
  /** 2D tree parameter; no-op for clips and 1D trees. */
  setParameter2D(x: number, y: number): void;
}

export interface AnimationInstanceOptions {
  readonly layers?: readonly LayerDesc[];    // default one base layer named "base"
  readonly rootMotion?: RootMotionOptions;
  readonly morphTargets?: number;            // 0..32, default 0; M2
}

export interface AnimationStats {
  readonly instanceCount: number;
  readonly jointCount: number;               // sum over live instances
  readonly activeActionCount: number;
  readonly sampledTrackCount: number;        // last update
  readonly eventsEmitted: number;            // cumulative
  readonly eventsDropped: number;            // cumulative
  readonly updateMs: number;                 // last update, debug only
  readonly paletteMs: number;                // last render frame, debug only
  readonly clipBytes: number;                // retained clip CPU bytes
  readonly poseBytes: number;                // all instance pose buffers, not caller palettes
}

export interface AnimationInstance {
  readonly id: number;                       // unique, monotonically increasing; never reused
  readonly entity: Entity;
  readonly skeleton: Skeleton;
  /** Previous fixed-tick pose; the sample side of render interpolation. */
  readonly previousPose: PoseBuffer;
  /** Current fixed-tick pose. */
  readonly currentPose: PoseBuffer;
  readonly morphWeights: Float32Array;       // length = morphTargets; M2

  play(source: Playable, options?: PlayOptions): AnimationAction;
  getAction(layer: number): AnimationAction | null;
  stop(layer?: number, fadeOutSeconds?: number): void;
  setLayerWeight(layer: number, weight: number): void;

  setRootMotionMode(mode: RootMotionMode, options?: RootMotionOptions): void;
  /** Returns the accumulated delta and clears it; false when no valid delta. */
  consumeRootMotion(out: RootMotionDelta): boolean;

  setMorphWeight(target: number, weight: number): void;      // M2
  /** Copies the pose to `out` without interpolation (debug/tests). */
  readPose(out: PoseBuffer, which: "previous" | "current"): void;
  /** Interpolates previous→current by alpha and writes model-space skinning matrices. */
  computePalette(out: JointPalette, alpha: number): void;
}

export interface AnimationApiOptions {
  /** The loop's fixed step; default 1/60. */
  readonly fixedStep?: number;
  /** Default 1,024. */
  readonly maxInstances?: number;
  /** Default 512. */
  readonly eventCapacity?: number;
  readonly debug?: boolean;
}

export interface AnimationApi {
  createInstance(
    entity: Entity,
    skeleton: Skeleton,
    options?: AnimationInstanceOptions,
  ): AnimationInstance;
  destroyInstance(instance: AnimationInstance): void;
  getInstance(entity: Entity): AnimationInstance | null;

  /**
   * Advances every instance exactly once, in ascending slot index.
   * Call once per fixed tick inside game.simulate(), after setting playback
   * parameters and before physics/character movement.
   */
  update(dt: number): void;

  /** Moves queued events into caller slots; returns the count copied. */
  drainEvents(out: AnimationEvent[]): number;

  /** FNV-1a 32 over the canonical pose/action stream in §4.6; test/replay probe. */
  stateHash(): number;

  readonly stats: AnimationStats;
  dispose(): void;                           // idempotent
}

/** Constructs the API with the loop's fixed step and capacities. */
export function createAnimationApi(options?: AnimationApiOptions): AnimationApi;
```

`AnimationEvent` (the drained form):

```ts
export interface AnimationEvent {
  readonly entity: Entity;
  readonly clip: AnimationClip;
  readonly name: string;
  readonly payload: number;
  /** Clip-local time of the event, seconds. */
  readonly time: number;
}
```

Rules:

- `update(dt)` must be called exactly once per simulation tick. A `dt` that differs from the configured fixed step by more than `1e-9` is clamped to the fixed step and counted; a second call in one tick advances time twice and is a game bug (the API cannot see ticks, so the contract is documented, not enforced).
- `createInstance` requires a live entity with a `Transform`. The instance does not add or require a Scene component; animation keeps its own dense table keyed by entity index. Creating two instances for one entity is `E_CONTRACT`.
- `destroyInstance` is idempotent. If the entity is destroyed first, the runtime calls `destroyInstance` during scene teardown; leaving an instance bound to a dead entity is a dev-mode warning and a production no-op.
- `play` on a layer replaces that layer's current action. The default `fadeOutPreviousSeconds = 0.2` crossfades: the new action fades in over the same duration unless `fadeInSeconds` is explicitly `0`, and the old action ramps to 0 and is retired. `fadeOutPreviousSeconds: 0` is a hard cut.
- `play` with `fadeInSeconds > 0` ramps the new action from 0 to `weight`. If `restart` is false and the source is the same object, the existing action's phase is kept.
- `speed` is non-negative. Negative playback is not supported in M1; a negative value is clamped to 0 and counted.
- `stop` with a fade keeps sampling the action until its weight reaches 0; without a fade it is removed at the end of the current tick.
- `getAction(layer)` returns the primary action for that layer, including a fading-in action. A layer with no action samples the rest pose (base) or contributes nothing (override/additive).
- `drainEvents(out)` copies at most `out.length` events, preserving order, and leaves the rest queued. It never allocates. If the queue is full when an event fires, the **newest** event is dropped and `eventsDropped` increments.
- `stateHash()` reflects the queue at call time; a test that drains events between hashes must also record the drained sequence, or hash before draining. `stateHash()` does not mutate state.

### 3.6 Root motion

```ts
export type RootMotionMode = "none" | "extract" | "apply";

export interface RootMotionOptions {
  /** Default: skeleton.rootJoint (or clip.rootJoint when the skeleton has none). */
  readonly rootJoint?: number;
  /** Include Y in the extracted translation. Default false: physics owns vertical. */
  readonly applyVertical?: boolean;
  /** Include yaw in the extracted rotation. Default true. */
  readonly applyYaw?: boolean;
  /** Reject a per-tick delta larger than this; default 2 m. */
  readonly maxDeltaPerTick?: number;
}

export interface RootMotionDelta {
  /** Model-space displacement since the previous tick; XZ unless applyVertical. */
  translation: Vec3;
  /** Yaw-only rotation about +Y (shortest arc); identity when applyYaw is false. */
  rotation: Quat;
  /** |translation| / dt, m/s; 0 when invalid. */
  speed: number;
  /** False on the first tick, after a clip switch, or on a rejected teleport. */
  valid: boolean;
}
```

Rules:

- Root motion is sampled from the **highest-weight base-layer action** after blending, before override layers are applied. A blend tree's delta is the weighted blend of its contributing samples' root joints.
- `extract` only reports the delta. The game applies it to its own state, normally a character controller (07 §5.8) or a scene transform.
- `apply` writes the entity's `Transform`: `position += entity.rotation * translation`; `rotation = entity.rotation * rotation` (quaternion multiply, 02 order). It also writes `PreviousTransform` when spec 03 provides that component. It then removes the applied translation (and yaw when `applyYaw`) from the root joint of `currentPose`, so the root does not double-move by skinning.
- `apply` is legal only for entities with no physics body bound. A bound entity is `E_CONTRACT` in dev; production falls back to `extract` and counts it.
- Deltas accumulate between `consumeRootMotion` calls, clamped to the configured maximum; `consumeRootMotion` returns and clears the accumulated delta. A rejected teleport sets `valid = false` and clears the accumulator.
- A clip switch, a crossfade that changes the dominant action, and the first update after instance creation reset the previous root pose and produce `valid = false` for that tick. A loop that wraps with a pose jump larger than `maxDeltaPerTick` is rejected; a properly authored root-motion loop is continuous and passes.
- `speed` is telemetry, not simulation state. It is never hashed.

### 3.7 Scene and renderer integration

```ts
/** Additive fields this spec requires from the renderer's M1 skinned draw path. */
export interface SkinnedDraw {
  readonly entity: Entity;
  /** Mesh/material handles are owned by specs 04/05 and are opaque here. */
  readonly palette: JointPalette;
  readonly morphWeights?: Float32Array;
}
```

- The runtime owns the render loop. It walks live animation instances in ascending id, skips entities without a visible skinned mesh, calls `instance.computePalette(palette, alpha)` once per display frame for each visible instance, and submits `SkinnedDraw` records. The renderer never calls animation.
- Spec 04 adds `skinned-pbr-v1` as a **new layout id** (never by changing `static-pbr-v1`): `position float32x3`, `normal float32x3`, `uv float32x2`, `JOINTS_0 uint16x4`, `WEIGHTS_0 float32x4`, stride 48 bytes. Spec 05 implements the same attributes for WebGL2.
- Skinning is vertex-shader linear blend skinning in M1. The four weights are normalized at import. The palette is bound through the renderer's skinning slot: a uniform block when `jointCount <= 64`, a bone texture when `jointCount > 64` (04 §4.4; 05 §5). Both backends support 256 joints.
- No game receives a `JointPalette`, a bone texture, a GPU handle or a backend object. `GameContext.animation` exposes `AnimationApi`; `computePalette` is used by the runtime, not by games.
- Morph targets (M2) add a separate mesh layout and a weights buffer. Animation supplies weights only; the renderer owns deformation. WebGL2 uses the CPU-blend or vertex-texture path chosen by spec 05; WebGPU uses the morph layout chosen by spec 04.
- The scene does not store a skeleton component. A game that wants animation calls `ctx.animation.createInstance(entity, skeleton)` itself; the runtime matches that instance to the entity's visible skinned mesh. Spec 03 may add a `SkinnedMesh` component additively, but this package never depends on it.

---

## 4. Data formats

### 4.1 Conventions and versioning

| Field | Rule |
|---|---|
| Length | Metres |
| Time | Seconds; clips advance in fixed 1/60 s ticks |
| Rotation | Unit quaternion `(x, y, z, w)`; canonical sign is `w >= 0` for hashing |
| Matrix | Column-major, 16 floats; `inverseBindMatrices` are model space |
| glTF axes | glTF is right-handed, +Y up. No axis conversion is applied. Engine forward is −Z (02); a character authored facing +Z is rotated by the game's prefab/scene transform, not by this package |
| Clip names | UTF-8, 1..64 bytes, no control characters |
| Event names | `^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$` |
| Format versions | `ANIMATION_CLIP_VERSION = 1`, `ANIMATION_METADATA_VERSION = 1`; both registered in 00 §4.1 by the integration agent when the format lands |

### 4.2 glTF 2.0 mapping (normative)

`engine-assets` (spec 06) parses the GLB/glTF and produces the source structures in §4.3. Animation compiles them. The mapping is fixed:

| glTF | Runtime |
|---|---|
| `skins[i].joints[]` (node indices) | Skeleton joints, after topological sort and remap |
| `skins[i].inverseBindMatrices` accessor (`MAT4`, column-major) | `Skeleton.inverseBindMatrices` |
| `skins[i].inverseBindMatrices` absent | Assets computes it from the inverse of each joint node's world transform at bind pose |
| `skins[i].skeleton` | Root joint hint; if absent, the common ancestor of the joints, or the first root after sorting |
| Node local `translation`/`rotation`/`scale` of each joint | `Skeleton.restPose`; a joint authored as a `matrix` is decomposed at import |
| A mesh primitive with `JOINTS_0` and `WEIGHTS_0` | Skinned mesh; the mesh's skin index selects the skeleton |
| `animations[j].name` | Clip name; fallback `anim-<j>` |
| `animations[j].channels[].target.node` | Joint index after remap (or the node whose mesh a `weights` channel targets) |
| `channels[].target.path` `translation` / `rotation` / `scale` | `TrackPath` of the same name |
| `channels[].target.path` `weights` | Split into one track per morph target, `target` = target index, `valueStride = 1` (M2) |
| `samplers[].input` accessor | `times`, converted to seconds |
| `samplers[].output` accessor | `values` (3/4/3 per key; `weights` split per target) |
| `samplers[].interpolation` `LINEAR` / `STEP` | `TrackInterpolation` of the same name |
| `samplers[].interpolation` `CUBICSPLINE` | **Not accepted at runtime.** Tooling resamples to LINEAR at ≥ 30 Hz with the tolerances in §5.11; a raw CUBICSPLINE source is rejected with `E_ASSET_FORMAT` |
| Animation channel targeting a non-joint node | Ignored with a dev counter; no runtime track |
| Animation duration | Maximum `times` across its tracks; a track ending early holds its last value |

Additional rules:

- **Joint order.** glTF does not require joints to be parent-before-child. Spec 06 must topologically sort each skin (stable by original joint index) and remap every mesh's `JOINTS_0` indices to the new order. `compileSkeleton` validates `parents[i] < i`; a non-topological source is rejected, never silently reordered by animation.
- **Roots.** A skin may have one or more parentless joints (a forest) when the common ancestor is not itself a joint. All roots have `parents[i] === -1`; roots sort first; at most 16 are allowed. Root motion requires a chosen root; with multiple roots and no declared `rootJoint`, the first root (lowest index) is used.
- **One skin per skinned mesh.** Multi-skin vertex blending is not supported. A primitive with more than one `JOINTS_n`/`WEIGHTS_n` set is reduced to the first four influences by tooling; an unreduced source is rejected.
- **Weights.** `WEIGHTS_0` is normalized at import. If all four weights are zero, the vertex is rigid to joint 0 and a dev counter increments. `JOINTS_0` values are validated against `jointCount - 1`.
- **Morph targets.** `meshes[].primitives[].targets[]` and `meshes[].weights` are decoded by assets. Animation consumes only split `weights` tracks and the active-target count; it never reads vertex deltas. M2.
- **Node animation vs skin animation.** A clip may animate nodes that are not in the skin; those channels are ignored. A glTF animation that targets two skins produces two `AnimationSource` objects, one per skin, each containing only that skin's remapped joint tracks and the same name; the runtime treats them as separate clips. A source with no tracks after filtering is rejected.
- **Names.** A glTF animation with duplicate names is allowed; clips are distinguished by object identity and the asset id, not by name. Diagnostics print the source index.
- **No axis conversion, no unit scaling.** glTF metres and seconds are engine units. A source authored in centimetres is a tooling conversion error.

### 4.3 Decoded source data (the `engine-assets` boundary)

`engine-assets` produces these structures from glTF, `.pclip` or tooling output. Animation owns the compile step and validates every field.

```ts
export interface SkeletonSource {
  readonly id?: string;                       // asset identity, copied to Skeleton.id
  readonly jointNames: readonly string[];
  /** Length jointCount, topological (parents[i] < i), at least one -1 root. */
  readonly parents: Int16Array;
  readonly inverseBindMatrices: Float32Array; // 16 * jointCount, column-major
  readonly restTranslations: Float32Array;    // 3 * jointCount
  readonly restRotations: Float32Array;       // 4 * jointCount
  readonly restScales: Float32Array;          // 3 * jointCount
  readonly rootJoint: number;                 // -1 if undeclared
}

export interface AnimationSourceTrack {
  readonly target: number;                    // joint or morph-target index
  readonly path: TrackPath;
  readonly interpolation: TrackInterpolation;
  readonly times: Float32Array;               // seconds, ascending
  readonly values: Float32Array;              // 3/4/3/1 per key
}

export interface AnimationSource {
  readonly name: string;
  /** The skeleton this source's indices were built for; checked when both ids exist. */
  readonly skeletonId?: string;
  readonly duration: number;
  readonly tracks: readonly AnimationSourceTrack[];
  readonly events?: readonly ClipEvent[];
  readonly rootJoint?: number;                // -1 = no root motion
}

export function compileSkeleton(source: SkeletonSource): Skeleton;
export function compileClip(
  source: AnimationSource,
  skeleton: Skeleton,
  options?: { readonly morphTargets?: number },
): AnimationClip;
```

Rules:

- `compileSkeleton` and `compileClip` allocate freely; they are load-time APIs, never called in a tick. They validate and throw `EngineError` with `E_ASSET_FORMAT` or `E_CONTRACT`; they never partially build a half-valid object.
- `compileClip` may adopt the source's typed arrays without copying when the source is marked immutable by ownership transfer. In all cases the returned clip's arrays are treated as immutable.
- A track targeting `target >= skeleton.jointCount` (or `>= morphTargets` for `weights`) is `E_ASSET_FORMAT`. A `weights` track whose `values.length !== keyCount` is `E_ASSET_FORMAT` (the channel was not split).
- If both `Skeleton.id` and `AnimationSource.skeletonId` are present and differ, `compileClip` throws `E_CONTRACT`. Assets emit one `AnimationSource` per (glTF animation, skin) pair; a source never mixes joint indices from two skeletons, so a clip can never be silently applied to the wrong rig.
- `rootJoint` resolution order: explicit `AnimationSource.rootJoint`, then `Skeleton.rootJoint`, then `-1`.
- The compile step computes `sourceBytes` from the retained arrays plus track/event metadata and stores it for budgets.

### 4.4 Compressed clip container (`.pclip`, `ANIMATION_CLIP_VERSION = 1`)

`.pclip` is the optional M1 and default M2 runtime clip format. **Spec 06 owns the byte parser** (it is an asset); this section owns the semantics. Tooling (16) writes it. All integers are little-endian via `DataView`.

File layout:

```
header (32)
clip table (40 * clipCount)
string table (stringTableBytes)
data (payloadBytes - clipTableBytes - stringTableBytes)
```

Header (32 bytes):

| Offset | Size | Field | Rule |
|---|---|---|---|
| 0 | 4 | `magic` | ASCII `PPAC` |
| 4 | u16 | `formatVersion` | 1 |
| 6 | u16 | `headerBytes` | 32 |
| 8 | u32 | `clipCount` | 1..4,096 |
| 12 | u32 | `stringTableBytes` | ≤ 1 MiB |
| 16 | u32 | `clipTableBytes` | `clipCount * 40` |
| 20 | u32 | `eventTableBytes` | total bytes of all event records; `12 * Σ eventCount` |
| 24 | u32 | `reserved` | 0 |
| 28 | u32 | `payloadBytes` | bytes after the header, including clip table and string table; bounds every offset |

`dataStart = headerBytes + clipTableBytes + stringTableBytes`. `trackTableOffset` and `eventTableOffset` are relative to `dataStart`. `nameOffset` and event `nameOffset` are relative to the start of the string table.

Clip record (40 bytes):

| Offset | Size | Field | Rule |
|---|---|---|---|
| 0 | u32 | `nameOffset` | into the string table; NUL-terminated UTF-8 |
| 4 | f32 | `duration` | seconds, > 0 |
| 8 | u8 | `loop` | 0 repeat, 1 once, 2 ping-pong |
| 9 | u8 | `trackCount` | 0..255 |
| 10 | u16 | `eventCount` | 0..256 |
| 12 | i16 | `rootJoint` | -1 = none |
| 14 | u16 | `reserved` | 0 |
| 16 | u32 | `trackTableOffset` | relative to `dataStart`; `trackCount * 40` bytes follow |
| 20 | u32 | `eventTableOffset` | relative to `dataStart`; `eventCount * 12` bytes follow |
| 24 | u32 | `f32BytesEquivalent` | uncompressed size, for the memory report |
| 28 | u32 | `reserved2` | 0 |
| 32 | u32 | `reserved3` | 0 |
| 36 | u32 | `reserved4` | 0 |

Track record (40 bytes):

| Offset | Size | Field | Rule |
|---|---|---|---|
| 0 | u16 | `target` | joint or morph index |
| 2 | u8 | `path` | 0 translation, 1 rotation, 2 scale, 3 weights |
| 3 | u8 | `interpolation` | 0 linear, 1 step |
| 4 | u16 | `keyCount` | 1..65,535 |
| 6 | u8 | `timeEncoding` | 0 = u16 normalized over `[0, duration]` |
| 7 | u8 | `valueEncoding` | 0 = i16 ranged, 1 = quaternion smallest-three, 2 = i16 unit weights |
| 8 | f32[3] | `rangeMin` | per-component minimum for encodings 0/2; zero for 1 |
| 20 | f32[3] | `rangeSpan` | per-component `max - min`; zero for 1 |
| 32 | u32 | `timeOffset` | relative to `dataStart`; `keyCount * 2` bytes |
| 36 | u32 | `valueOffset` | relative to `dataStart`; `keyCount * valueBytes` |

Value bytes per key: encoding 0 = `2 * valueStride` (3 components: 6 bytes; 1: 2 bytes); encoding 1 = 8 bytes; encoding 2 = 2 bytes.

Value encodings:

- **i16 ranged (0)** — used for translation, scale and morph weights. Key `k` component `c`: `value = rangeMin[c] + (i16Value + 32768) / 65535 * rangeSpan[c]`. A zero span decodes to `rangeMin`. Translation precision is `rangeSpan / 65535`; the tooling must keep that ≤ 0.5 mm or split the track.
- **quaternion smallest-three (1)** — each key is 8 bytes: `u16 largest` (0..3, 0xffff means "invalid, use identity") followed by three `i16` components scaled by `32767` in `[-1, 1]`. Encoding: canonicalize `w >= 0`, choose the largest-magnitude component, store the other three; reconstruction takes the positive square root for the omitted component. Decoded quaternions are normalized; a non-finite or near-zero result is `E_ASSET_FORMAT`.
- **i16 unit weights (2)** — morph weights in `[0, 1]`; `value = (i16Value + 32768) / 65535`. Values are clamped to `[0, 1]` after decode.

Time encoding 0 stores each key time as `u16 = round(time / duration * 65535)`, strictly non-decreasing, first `0`, last ≤ 65535. The decoder reconstructs `time = u16Value / 65535 * duration`.

Event record (12 bytes): `u16 timeNormalized` (same scale as track times, against **this clip's** duration), `u16 reserved`, `u32 nameOffset` (into the string table), `i32 payload`. Event names are NUL-terminated UTF-8 in the string table, ≤ 64 bytes.

Validation on read:

- magic, version, `headerBytes`, every offset and length within `payloadBytes`; no integer overflow; no string without a NUL before the string-table end;
- `clipCount`, track, key and event caps from §3.1;
- times strictly ascending, non-decreasing after decode, and within `[0, duration]`; durations > 0;
- every `rangeSpan >= 0`; finite minima; quaternion records reconstruct to unit length within `1e-3`;
- unknown `path`, `interpolation`, `timeEncoding` or `valueEncoding` values refuse the asset with `E_ASSET_FORMAT`; an unknown `formatVersion` is refused, never guessed.

Decode produces `AnimationSource` (§4.3) in f32 arrays. The parser and decode live in `engine-assets`; a decode failure fails the asset, not the game mid-frame.

### 4.5 Animation metadata sidecar (`*.anim.json`, `ANIMATION_METADATA_VERSION = 1`)

glTF has no event or root-motion metadata. Tooling reads a sidecar next to a source clip and bakes the result into `.pclip`; the runtime never fetches the sidecar.

```json
{
  "formatVersion": 1,
  "clip": "walk",
  "loop": "repeat",
  "rootJoint": "root",
  "events": [
    { "time": 0.25, "name": "footstep.left", "payload": 1 },
    { "time": 0.75, "name": "footstep.right", "payload": 2 }
  ]
}
```

Rules: `clip` matches the glTF animation name; `loop` is `repeat | once | ping-pong`; `rootJoint` is a joint name from the skeleton; event times are seconds in `[0, duration]`; names follow the event pattern. A missing sidecar means no events, default loop `repeat`, root joint from the skeleton. The sidecar is tooling input only; adding a field is additive, changing a required field bumps `ANIMATION_METADATA_VERSION`.

### 4.6 Canonical pose/action hash

`AnimationApi.stateHash()` is the determinism probe. It hashes a canonical little-endian stream with FNV-1a 32 using a reusable `DataView` (maximum 64 KiB chunks):

1. `u32 formatVersion = 1`.
2. `u32 instanceCount`; instances in ascending slot index.
3. Per instance:
   - `u32 instanceId`, `u32 jointCount`;
   - per joint in ascending index, from `currentPose`: `f32 translation.x/y/z`, `f32 canonicalRotation.x/y/z/w`, `f32 scale.x/y/z`;
   - `u32 morphTargetCount`, then each `f32` morph weight;
   - `u32 actionCount`; per action in ascending layer: `u8 sourceKind` (0 clip, 1 1D, 2 2D), `u32 clipNameHash` (FNV-1a of the dominant clip name), `f32 normalizedTime`, `f32 weight`, `u8 running`.
4. `u32 pendingEventCount`; per queued event in queue order: `u32 eventNameHash`, `i32 payload`, `f32 time`.

Canonical rotation: if `w < 0`, negate all four components; if `w == 0` and `x < 0`, negate. This makes `q` and `-q` hash identically. Pose arrays are stored as f32, so the hash is exact for the stored values. `speed`, telemetry and render-interpolated palettes are excluded.

### 4.7 Limits

| Item | Limit | On exceed |
|---|---|---|
| Joints per skeleton | 256 | `compileSkeleton` throws `E_ASSET_FORMAT` |
| Roots per skeleton | 16 | `E_ASSET_FORMAT` |
| Influences per vertex | 4 | tooling reduces; raw >4 rejected at mesh decode |
| Morph targets authored / active | 32 / 8 | compile rejects >32; renderer refuses >8 active |
| Instances | 1,024 hard | `createInstance` returns a no-op instance and counts |
| Actions per instance | 8 | oldest fully-faded action retired; a ninth live action drops the lowest-weight one |
| Layers per instance | 2 (M1), 8 (M2) | `E_UNSUPPORTED_FEATURE` |
| Events per clip | 256 | `E_ASSET_FORMAT` |
| Pending events | 512 | newest dropped, `eventsDropped` increments |
| Keys per clip / per track | 200,000 / 65,535 | `E_ASSET_FORMAT` |
| Tracks per clip | 1,024 | `E_ASSET_FORMAT` |
| `.pclip` file | 32 MiB | `E_ASSET_FORMAT` |
| Pose bytes per instance | 40 B/joint (T 12 + R 16 + S 12) × 2 buffers + 64 B/joint palette | implementation bug if exceeded |

### 4.8 Versioning

- `ANIMATION_CLIP_VERSION` and `ANIMATION_METADATA_VERSION` are registered in 00 §4.1 before the format is written. A breaking byte-layout or semantic change bumps the version and keeps a reader for the previous version for one milestone.
- Adding an optional field does not bump a version. Reinterpreting an existing field does.
- The runtime `Skeleton` and `AnimationClip` have no serialized form; they are compiled from assets. Saves (spec 15) store game-owned playback state, not engine clip data.
- A game that stores a clip name or a joint name across a save must tolerate a missing name after a content update; the engine never remaps saves.

---

## 5. Architecture

### 5.1 Module map

```
packages/engine/animation/
  src/
    index.ts                  public exports only
    skeleton/
      Skeleton.ts             compiled skeleton, validation
      compileSkeleton.ts      SkeletonSource -> Skeleton
    clip/
      AnimationClip.ts        clip/track/event types and validation
      compileClip.ts          AnimationSource -> AnimationClip, track sorting
      track.ts                binary search, endpoint clamp, key sampling
    sample/
      PoseBuffer.ts           TRS SoA creation/copy
      sampleClip.ts           per-track sampling into a pose
      interpolate.ts          nlerp/lerp, shortest arc, canonical sign
    blend/
      blend1d.ts              bracketing weights
      blend2d.ts              top-four inverse-distance weights (M2)
      blendActions.ts         action weight normalization
    layer/
      layers.ts               base/override/additive composition, bone masks
    rootmotion/
      rootMotion.ts           delta extraction, apply, accumulation
    events/
      eventQueue.ts           fixed-capacity ring, window scan across loops
    palette/
      palette.ts              hierarchy multiply, inverse bind, model-space matrices
    api/
      AnimationApi.ts         instance table, update, drain, stats, dispose
      AnimationInstance.ts    per-instance actions, poses, root motion, morph
    compress/
      pclipSchema.ts          constants and validation rules for spec 06's reader
    debug/
      draw.ts                 skeleton/bone debug lines through the renderer contract
  test/
    fixtures/
    unit/
    property/
    golden/
    integration/
    bench/
```

No file under `src/` imports a renderer backend, the DOM, `@lanpad/protocol`, `@lanpad/sdk`, `@lanpad/runtime` or a game (00 §5.2 D3). The package imports `@lanpad/engine-core` and `@lanpad/engine-assets` only; `engine-assets` must not import `engine-animation` (the allowed edge is one-way, 00 §5.2 D2).

### 5.2 Data layout

- **Skeletons are compiled once and shared.** A Skeleton owns its parents, inverse bind matrices, rest pose and names. Instances hold references, never copies, except for pose buffers sized to the shared joint count.
- **Instances live in a fixed-capacity slot table.** A slot is reused only after destroy; each instance keeps a monotonically increasing `id` for identity, and a reused slot does not reuse an id. Iteration is ascending slot index, which is the only order that affects the hash or events. Destroy marks a hole; holes are never compacted mid-tick.
- **Pose buffers are double-buffered per instance.** `previousPose` and `currentPose` are allocated at instance creation and reused forever. Sampling copies current→previous, then overwrites current. No pose is allocated per tick.
- **Actions are pooled per instance.** The pool capacity is eight. A new `play` takes a free slot or retires the oldest fully faded action; the active action list is a fixed array, not a `Map`.
- **Blend-tree samples are references.** A `BlendTree` is an immutable description; the per-instance action holds a small fixed array of child clip weights (maximum 16) and phases.
- **Morph weights** are one `Float32Array(32)` per instance when `morphTargets > 0`, otherwise a shared zero-length buffer.
- **Events** are a fixed-capacity ring of structs in the API; `drainEvents` copies into caller slots and advances the head. Event name strings are references to compiled clip strings, never new strings.
- **Pose/palette math** uses doubles for intermediate arithmetic and stores f32 at the buffer boundary; the storage type is part of the hash and of GPU upload.

### 5.3 Tick pipeline (normative order)

`AnimationApi.update(dt)` executes exactly this sequence, once per fixed tick:

1. **Validate `dt`.** It must equal the configured fixed step within `1e-9`; otherwise clamp to the fixed step and increment a counter. `dt <= 0` is a no-op.
2. **Advance actions**, in ascending slot index, then ascending layer:
   - advance `fadeIn`/`fadeOut` weights by `dt / fadeDuration`; retire actions whose fade-out reached 0;
   - advance each action's time by `speed * dt` (for a tree, advance the group phase by `dt / weightedDuration`); apply loop mode and clamp;
   - evaluate the 1D/2D blend weights from the parameter.
3. **Reset and sample the base layer.** For the instance, copy `currentPose` into `previousPose`. Sample the base action(s) into `currentPose`; if no action, copy `restPose`.
4. **Apply override layers** in declared order, respecting masks and layer weights. M2 adds additive layers after overrides.
5. **Root motion.** Sample the root joint's model transform from the base-layer result, compute the delta against the previous tick's stored root transform, and store/accumulate it according to the mode. `valid` is false on the first tick, on a dominant-action change, or on a rejected teleport.
6. **Events.** For the dominant base action, scan the event window `(previousTime, currentTime]` (split at the loop boundary) and enqueue matches in `(time, authoring order)` order. For a blend tree, the dominant sample is the highest-weight sample, ties by sample index.
7. **Stats.** Update counters and, only when debug is enabled, `updateMs` with one `performance.now()` pair.

The order is part of the contract: changing steps 4–6 changes poses, root deltas and event ticks. A change requires a spec revision and a new golden fixture.

`computePalette(out, alpha)` is a render-frame operation, not part of `update`:

1. For each joint in ascending index, interpolate `previousPose`→`currentPose`: translation and scale linear, rotation shortest-arc nlerp (02 `quatNlerp`), clamp alpha to `[0, 1]`.
2. Build the local matrix `T * R * S` (column-major).
3. Multiply through the hierarchy: `W_i = W_parent * M_i`; parents are guaranteed to precede children.
4. Write `J_i = W_i * inverseBind_i` into `out.matrices`.
5. No allocation; if `alpha` is 0 or 1 the interpolation step is skipped and the corresponding stored pose is used directly.

### 5.4 Sampling and interpolation

- A track samples by binary search for the last key `t <= time` (first key when time is before the range; last key when after).
- `step` returns the left key's value.
- `linear` lerps translation/scale and nlerps rotation. nlerp is used, not slerp, because it is cheaper, stable for small angles and the engine's blend paths are normalized; 02 `quatNlerp` guarantees shortest arc.
- A track that does not target a joint's path leaves that joint's value at the rest pose for that path. Tracks are sparse by design.
- A constant track (one key) is sampled without search after the first tick.
- Time outside `[0, duration]` is clamped before sampling; loop handling happens in the action, not the track.
- Sampling never mutates clip arrays and never reads the clock.

### 5.5 Blending

- **Action weights** in a layer are clamped to `[0, 1]` and normalized when their sum is `> 0`. If the sum is `0`, the base layer uses the rest pose; an override/additive layer contributes nothing.
- **Base layer composition** accumulates in ascending action creation order (retired actions last). Translations/scales lerp by weight; rotations nlerp with shortest arc. The result is stored in `currentPose`.
- **Crossfade** ramps the outgoing and incoming action weights linearly over their configured durations; no easing curve is applied in M1. A crossfade does not reset the normalized phase when `restart: false` and the source object is identical.
- **Blend tree 1D** weights are linear between the two bracketing thresholds and clamped at the ends. **Blend tree 2D** (M2) uses top-four inverse-distance weights as defined in §3.4.
- **Phase sync** (default true): a tree maintains a group phase in `[0, 1)`. `weightedDuration = 1 / Σ(w_i / duration_i)` over samples with `w_i > 0`; `phase += actionSpeed * dt / weightedDuration`, wrapped. Each sample's local time is `phase * clip.duration`. If no sample has weight `> 0`, the phase does not advance. When `syncPhase` is false, each sample's action advances by its own `speed * dt` and the group phase is unused.
- **Layer composition (M1):**
  - base result `B`;
  - for each override layer with weight `w` and mask bit set: `T/S = lerp(B, O, w * layerWeight)`, `R = nlerp(B, O, w * layerWeight)`;
  - unmasked joints keep `B`.
- **Additive layers (M2):** delta relative to the rest pose: `T/S = B + (A - rest) * w`; `R = B * nlerp(identity, A * inverse(rest), w)`. The mask is applied per joint. This formula is fixed so two implementations agree.
- Blend results are stored in the instance's pose; no intermediate pose buffer is allocated per layer (a single scratch pose is preallocated per instance in M2).

### 5.6 Layers

- Layer 0 is the base layer and always exists. `AnimationInstanceOptions.layers` may supply its name/weight; its mode must be `"base"`.
- M1 accepts one override layer. M2 accepts up to seven additional override/additive layers.
- A layer's weight is clamped to `[0, 1]` on write. A layer with no action contributes nothing; the base layer then falls back to the next action or the rest pose.
- Masks are hard bitsets. Compute the mask word index with `i >>> 5` and bit with `1 << (i & 31)`. A mask shorter than `ceil(jointCount / 32)` is `E_CONTRACT`.
- Layer order is declaration order; there is no priority field. Two layers with the same name are allowed but discouraged; names are for debug only.

### 5.7 Root motion

- The root joint's **model-space** transform is sampled from the layer-composed base pose before override layers. Model space means the skeleton's own space: parent transforms from the skeleton root down to the root joint, not the entity transform.
- The per-tick delta is `currentRoot * inverse(previousRoot)`: translation in model space, rotation as a quaternion. For the default `applyYaw`, only the yaw component about +Y is kept; pitch/roll are discarded. For `applyVertical: false`, the Y component of translation is discarded and remains in the pose for physics/character handling.
- `extract` stores the delta for `consumeRootMotion`; it does not write the pose. `apply` writes the entity transform and zeroes the applied components in `currentPose` (root XZ translation and yaw), so skinning does not double-apply them. The zeroing is deterministic and part of the pose hash.
- On the first update, after `play` changes the dominant action, and after a rejected loop seam, `valid` is false and the delta is zero. A game that consumes every tick therefore sees one invalid tick per transition; it must not apply that tick's delta.
- Accumulation clamps to `maxDeltaPerTick * 600` (10 s at 60 Hz) to bound memory and NaN risk; beyond that the accumulator stops growing and `stats` records the clamp.
- Root motion never moves a physics body directly. A character controller receives the extracted delta as desired translation (07 §5.8); a vehicle ignores it.

### 5.8 Events

- Events are authored per clip, sorted at compile. The event window is half-open `(previousTime, currentTime]`, so an event at `time = 0` does not fire on the first update (authors place events after the start) and an event at exactly `duration` fires once when a `once` clip reaches its end.
- For `repeat`, a wrap scans `[previousTime, duration]` then `[0, currentTime]`; an event exactly at `duration` fires before the wrap. For `ping-pong` (M2), events fire in play direction; a reversal at an endpoint does not re-fire the endpoint event in the same tick.
- Only the **dominant base action** emits events:
  - a clip action is dominant when its weight is the largest in layer 0; ties by action creation order;
  - a blend tree's dominant sample is the highest-weight sample, ties by sample index;
  - an action with weight `<= 0` emits nothing; a fully faded-out action emits nothing.
- Override and additive layers never emit events. This is deliberate: a footstep event must not fire from both walk and run during a blend.
- Events queue in `(tick, slot index, event time, authoring index)` order. `drainEvents` copies into caller slots and leaves the remainder queued.
- A paused loop does not call `update`, so time and events do not advance. A game that needs to drain events after a pause still can; the queue is not cleared by pause.
- Event payloads are numbers, not objects. A game that needs structured data switches on `name` and reads its own state.

### 5.9 GPU skinning and render integration

- **CPU side.** `computePalette` produces model-space matrices. The runtime calls it for every visible skinned instance once per display frame, after the loop's `alpha` is known. The palette buffer is owned by the runtime's render path and reused; one buffer per visible character (or a pooled set sized to the max visible count).
- **GPU side (spec 04/05).** The renderer binds the palette as:
  - a uniform block for `jointCount <= 64` (64 × 64 B = 4 KiB), or
  - an RGBA32F bone texture for `jointCount > 64`: width `4 * jointCount`, height 1, NEAREST filtering, no mips, four texels per joint (the four matrix columns). 256 joints need 1024 texels, below every supported backend's limit.
- **Vertex path.** `skinnedPosition = Σ (weight_i * (jointMatrix_i * position))`; the entity model matrix is applied afterwards. Normals use the same joint matrix's upper-left 3×3, then normalize; non-uniform scale is not compensated in M1 (documented limitation).
- **Influences.** Exactly four; `JOINTS_0` is `uint16x4`, `WEIGHTS_0` is `float32x4`. Weights are normalized at import; the shader does not renormalize per vertex (it trusts the import).
- **Backends.** WebGPU uses vertex-shader skinning in M1; compute skinning is not required and must not be assumed. WebGL2 uses vertex-shader skinning with a bone texture for >64 joints and a uniform block for ≤64 (05 §5). Canvas2D never draws 3D and therefore never skins.
- **Device loss.** Palettes are CPU data and survive; the renderer re-uploads on the next frame from the cached buffers. Animation holds no GPU handle.
- **Interpolation.** `alpha` interpolates the last two fixed-tick poses; animation does not use wall-clock time. At 120 Hz two render frames between ticks produce different joint matrices from the same two poses, which is the intended behaviour.
- **Debug draw.** `debug/draw.ts` emits bone lines and joint axes through the backend-neutral renderer contract only when `?debug=1`; it allocates on enable and never in the frame loop.

### 5.10 Morph targets (M2)

- glTF morph targets are decoded by assets; animation compiles split `weights` tracks to `target` indices and drives `instance.morphWeights`.
- Up to 32 targets may be authored; at most 8 are active for rendering. Active means weight `> 1e-4`. The game may force a target active with `setMorphWeight` even if the clip leaves it at 0.
- Final weight = clip weight × base-layer weight + game weight, clamped to `[0, 1]`. Game weights are added after layers and are deterministic.
- `computePalette` does not touch morph weights. The runtime reads `instance.morphWeights` (interpolating previous/current by `alpha` into a caller buffer) and passes it to the renderer. An additive `interpolateMorphWeights(out, alpha)` helper is part of the M2 API addition.
- The renderer applies morph positions (and optionally normals) before skinning. WebGPU uses the `skinned-morph-pbr` layout; WebGL2 uses its CPU-blend or vertex-texture path. Animation never deforms vertices.

### 5.11 Compression pipeline

- **Where it runs.** Tooling (16) reads glTF + sidecar and writes `.pclip`; assets (06) parses and decodes it on a worker into `AnimationSource`; animation compiles it. No compression or decode happens in `simulate`.
- **Key reduction.** Before quantization, tooling may remove keys whose removal keeps linear interpolation error within tolerance at 60 Hz: translation `<= 0.5 mm`, rotation `<= 0.1°`, scale `<= 0.001`. Keys that carry an event at the same time are never removed.
- **Resampling.** `CUBICSPLINE` is resampled to `LINEAR` at a rate of at least 30 Hz and at least the source key rate when the source key rate is lower; the tolerance above is the acceptance bound. A `STEP` track is never resampled.
- **Quantization.** Per-track range for translation/scale; smallest-three for rotation; unit i16 for morph weights; u16 normalized times.
- **Budgets.** `.pclip` must be `<= 35%` of the f32 equivalent for a 60-joint, 30 Hz, 2 s clip and must not exceed the source size for any fixture. Decode must not allocate per key; it expands once into f32 arrays.
- **Error bound.** After decode, every key must be within the tolerances above of the source. The acceptance fixture compares sampled poses at 60 Hz, not just key values.
- **Versioning.** The container rules in §4.4 are the contract. A future encoding adds a new `valueEncoding`; existing values are never reinterpreted.

### 5.12 Determinism

Required within one build and one browser (00 §5.8):

- fixed `dt = 1/60`; animation has no accumulator and no wall clock;
- no `Math.random`, `Date.now`, `performance.now`, timers or promises inside `update` or `computePalette` (timings only in debug);
- iteration over dense arrays in ascending index; no `Map`/`Set`/object-key iteration in `update`;
- action order is layer order then creation order; blend-tree sample order is threshold/index order; event order is `(time, authoring index)`;
- quaternion nlerp takes the shortest arc and the stored pose is normalized;
- `speed`, `fadeInSeconds` and `fadeOutSeconds` are part of the replay state; changing them changes the hash;
- render interpolation (`alpha`) and palettes are not hashed; only fixed-tick poses, action state and queued events are;
- cross-browser last-bit transcendental differences are accepted, as 00 §5.8 scopes; the same build/browser must match.

### 5.13 Hot paths and allocation

Hot paths: `AnimationApi.update`, `sampleClip`, layer composition, root-motion extraction, event enqueue, `computePalette`, `drainEvents`.

In these paths:

- no `new`, no object/array literals, no closures, no `map`/`filter`/`forEach`/spread, no string concatenation;
- all pose/palette/scratch buffers are allocated at instance creation;
- binary search and sampling use scalar locals;
- event names are references; payloads are numbers;
- `stats` fields are numbers; debug timing uses a single `performance.now()` pair only when `debug.enabled`.

Allowed allocations: compile, instance create/destroy, `play`/`stop` action creation (pooled; a play when the pool is full may allocate only in dev), debug draw enable, and asset load. A per-frame allocation is a review failure and a benchmark failure.

### 5.14 Scene and entity lifecycle

- `createInstance` stores `entity` and a dense table row. It does not mutate the Scene. The entity must be alive; a dead/stale entity handle is `E_STALE_HANDLE` in dev and a no-op in production.
- Entity destruction does not automatically destroy the animation instance (the Scene cannot call into animation without a dependency). The runtime that owns both calls `destroyInstance` for every instance whose entity is no longer alive at scene teardown, or the game calls it. `AnimationApi.getInstance` is the only lookup; the runtime iterates its own instance list.
- `AnimationInstance` holds no references to asset handles after compile. If the game releases the clip asset, the compiled clip stays valid because it owns or shares immutable typed arrays; releasing a skeleton asset while instances live is a game bug, and the skeleton object remains valid until all instances are destroyed (the runtime holds a reference).
- `dispose()` destroys every instance, clears the queue and is idempotent. It does not free caller-owned pose/palette buffers.

### 5.15 Error handling

- Boundary validation (skeleton/clip compile, `play`, masks, `createInstance`) throws `EngineError` with `E_ASSET_FORMAT`, `E_CONTRACT` or `E_UNSUPPORTED_FEATURE`.
- `update`, `computePalette`, `consumeRootMotion` and `drainEvents` never throw in normal operation. A stale instance is a counted no-op; a non-finite pose value is caught in dev once per tick, logged with the joint index, and clamped/zeroed in production.
- A missing asset is `E_ASSET_LOAD` from assets, not animation.
- Error messages include the clip name, joint index or instance id, never a URL with a token or a player name.
- A clip that references joint indices beyond the skeleton is rejected at compile; it can never reach `update`.

### 5.16 Threading

- Sampling and palette computation run on the main thread inside the tick/render paths. They are not moved to a worker in M1/M2 because the game API is synchronous and the pose is needed immediately by gameplay (root motion, events).
- Decode and compile may run in a worker: GLB parsing (assets), `.pclip` decode (assets), and `compileSkeleton`/`compileClip` are pure functions over typed arrays. A worker result is applied at a load boundary, never mid-tick. Structured clone of typed arrays is allowed; GPU handles never cross a worker boundary.
- `SharedArrayBuffer` is not required. No animation state is shared between threads.

---

## 6. File ownership

This spec owns exactly one documentation file and the following implementation tree. No other agent writes these paths in the same wave.

| Path | Contents | Wave |
|---|---|---|
| `docs/engine/08-animation.md` | this spec | spec wave |
| `packages/engine/animation/package.json` | workspace package `@lanpad/engine-animation`, private, deps `@lanpad/engine-core` + `@lanpad/engine-assets` | M0 (integration agent edits workspace config) |
| `packages/engine/animation/src/index.ts` | public exports | M0/M1 |
| `packages/engine/animation/src/skeleton/**` | skeleton compile and validation | M1 |
| `packages/engine/animation/src/clip/**` | clip compile, track validation, sampling | M1 |
| `packages/engine/animation/src/sample/**` | pose buffers, interpolation | M1 |
| `packages/engine/animation/src/blend/**` | 1D (M1) and 2D (M2) blend weights, action blending | M1/M2 |
| `packages/engine/animation/src/layer/**` | base/override/additive composition, masks | M1/M2 |
| `packages/engine/animation/src/rootmotion/**` | delta extraction, apply, accumulation | M1 |
| `packages/engine/animation/src/events/**` | fixed-capacity queue, loop-aware window scan | M1 |
| `packages/engine/animation/src/palette/**` | hierarchy multiply, inverse bind, model-space matrices | M1 |
| `packages/engine/animation/src/api/**` | `AnimationApi`, `AnimationInstance`, stats, dispose | M1 |
| `packages/engine/animation/src/compress/**` | `.pclip` schema constants and validation shared with 06 | M2 |
| `packages/engine/animation/src/debug/**` | skeleton debug draw | M1 |
| `packages/engine/animation/test/**` | unit, property, golden, integration, bench | M0/M1 |

Boundaries:

- The package imports `@lanpad/engine-core` and `@lanpad/engine-assets` only (00 §5.2 D2). It does not import a renderer backend, protocol, sdk, runtime or games.
- `engine-assets` must **not** import `engine-animation`. It produces `SkeletonSource`/`AnimationSource`; animation compiles them. This keeps the dependency edge one-way.
- The package's `package.json`, `tsconfig.json` and root Vitest project entry are integration-agent edits (00 §5.16), not feature-agent edits.
- Specs 03, 04, 05, 06 and 07 own their files. This spec requests only: (a) spec 03's optional `PreviousTransform` and, if added, a `SkinnedMesh` component; (b) spec 04's `skinned-pbr-v1` layout and skinning binding; (c) spec 05's vertex-shader skinning; (d) spec 06's skin/clip decode and `.pclip` parser; (e) spec 07's character controller accepting an extracted root-motion delta.
- Tests use `packages/engine/animation/test/fixtures/**`; another spec may read a fixture but not edit it. Golden hashes live in `test/golden/**` and are updated only with a reviewed pose change.

---

## 7. Acceptance

Every row carries an `ER-08-NN` requirement ID that must resolve to a row in `docs/todos/TRACEABILITY.md` once the engine programme is registered. **Evidence rule:** PASS requires a recorded build, device, browser version, date and numbers in `docs/RESULTS.md`. Untested rows are PENDING and name the run needed. No row is claimed from this document.

| ID | Criterion | Fixture / method | Hardware | Evidence state |
|---|---|---|---|---|
| ER-08-01 | `npm run check` exits 0; every new test title carries its `ER-08-*` ID; no test skipped, removed or weakened for the wave | full gate | CI Node 20 | PENDING — first M1 animation wave |
| ER-08-02 | **Deterministic sampling:** a 600-tick fixture with 32 instances, 3 clips, a 1D blend tree, one crossfade and events produces the same `stateHash()` on two runs; changing a clip speed or the crossfade duration changes it | `packages/engine/animation/test/fixtures/determinism-600.json`; run in Node and Chrome 155 | CI Node 20 + Desktop Chrome 155, Windows 11 | PENDING — fixture authored with the sampler |
| ER-08-03 | **Skeletal fixture:** a 24-joint rig with walk (1.0 s) and run (0.6 s) clips; a 0→1 blend at ticks 0/150/300/450/600 produces joint model-space positions within `1e-4 m` of the golden; no T-pose pop at a 0.2 s crossfade; layer weights sum to 1 within `1e-6` | `test/fixtures/rig-24/`, golden hashes and positions | Desktop Chrome 155, Windows 11 | PENDING — needs the rig and golden |
| ER-08-04 | **Events:** a clip with events at 0.10/0.40/0.70/0.95 s loops three times; exactly 12 events fire, in order, once each; pausing between ticks does not advance or duplicate; a crossfade emits only from the dominant action | `test/fixtures/events-loop.json` + `test/golden/events.json` | CI Node 20 | PENDING — fixture authored with events |
| ER-08-05 | **Root motion:** a 10 s walk clip authored to translate 8.0 m and turn 90°; extracted displacement within 1% and yaw within 0.5°; loop seam jump ≤ 0.02 m; `apply` moves the entity by the same amount and the resulting root joint stays within `1e-4 m` of its in-place position | `test/fixtures/rootmotion-walk.json` | CI Node 20 + Desktop Chrome 155 | PENDING — fixture authored with a root track |
| ER-08-06 | **Skinning:** a 1,024-vertex, 24-joint, 4-influence mesh renders through WebGPU and WebGL2; CPU palette matches a reference `W * inverseBind` product within `1e-5`; the 65-joint and 256-joint bone-texture paths produce frames within 2% of pixels differing by more than 8/255 | `test/fixtures/skinning-24/` plus procedural `rig-65` and `rig-256`; `experiments/e-m1-animation/golden/` | Desktop Chrome 155, Windows 11 | PENDING — needs the render page |
| ER-08-07 | **Performance:** 64 skinned characters × 60 joints, 4 influences, 1920×1080, 600 measured frames after 120 warm-up: animation `update` p95 ≤ **0.75 ms/frame**, palette p95 ≤ **0.75 ms/frame**, total frame p95 ≤ **14 ms**; no frame over 20 ms after warm-up | `test/bench/m1-animation.bench.ts`, page reports `window.__ANIMATION_BENCH__` | Desktop Chrome 155, Windows 11; CPU/GPU adapter recorded | PENDING — target, not measured |
| ER-08-08 | **Memory:** 64 instances share 8 clips; retained clip data ≤ 2 MB, total animation CPU memory ≤ 6 MB, heap growth over 480 frames after warm-up ≤ 256 KiB | bench page + Chrome heap snapshot / `performance.memory` | Desktop Chrome 155, Windows 11 | PENDING — needs the bench page |
| ER-08-09 | **Compression (M2):** 100 clips round-trip through `.pclip`; sampled translation error ≤ 0.5 mm, rotation ≤ 0.1°, scale ≤ 0.001 at 60 Hz; file ≤ 35% of f32; decode is deterministic; an unknown version is refused with `E_ASSET_FORMAT` | `test/fixtures/pclip-100/` + codec golden | CI Node 20 | PENDING — codec lands with M2 |
| ER-08-10 | **Morph targets (M2):** an 8-target mesh blends weights from a clip and from `setMorphWeight`; WebGPU and WebGL2 frames match within 2% of pixels differing by more than 8/255; weights are clamped and hashed | `test/fixtures/morph-8/` | Desktop Chrome 155, Windows 11 | PENDING — M2 |
| ER-08-11 | **Bundle:** `@lanpad/engine-animation` ≤ **45 KB gzip**, recorded in the size report; controller bundle byte-identical to before the wave | `npm run size` | CI Node 20 | PENDING — first M1 build |
| ER-08-12 | **TV tier:** the 64-character bench scene runs at 60 Hz on the TV profile with recorded p95 update, palette and frame times | same bench page, TV profile | **PENDING device:** a 2020-era Android TV Chromium and a Tizen/webOS set (SPEC §12) | PENDING — no TV hardware yet |

Acceptance fixtures are JSON/GLB plus a thin harness and are owned by this spec. A row may not be marked PASS from a specification or a benchmark on a different machine.

---

## 8. Test plan

| Layer | Scope | Location |
|---|---|---|
| Unit | skeleton validation (topology, roots, caps), track sorting and validation, binary search and endpoint clamp, step vs linear sampling, nlerp shortest arc and canonical sign, 1D bracketing, crossfade weight ramp, layer/mask composition, root delta and apply, event window across a loop, palette hierarchy vs reference matrix multiplication, `.pclip` field validation | `packages/engine/animation/test/unit/**` |
| Property (`fast-check`) | sampling at a key time equals the key value; sampled quaternions are unit length; blended weights sum to 1 or fall back to rest; nlerp endpoints exact and shortest arc; event windows emit each event exactly once per cycle; no NaN for finite inputs; hash depends only on pose/action state, not allocation order | `.../test/property/**` |
| Golden | `determinism-600` hash, walk/run pose positions, crossfade weight trace, event trace, root-motion trace, skinning palette bytes | `.../test/golden/**` |
| Integration | `AnimationApi` + fixed loop: one update per tick, pause does not advance, events drain in order, root motion apply writes `Transform` and `PreviousTransform`, instance on a destroyed entity, `dispose` idempotence, device loss does not lose palettes | `.../test/integration/**` |
| Contract | `AnimationApi` surface, stale instance behaviour, no allocation after warm-up, dev throws vs production no-op | `.../test/unit/contract.test.ts` |
| Benchmark | ER-08-07 scene: update, palette, frame p50/p95/max, instance/joint counts, heap growth; browser page reports `window.__ANIMATION_BENCH__` | `.../test/bench/**` + `experiments/e-m1-animation/` |
| Manual | TV tiers, real-device frame pacing, visual review of skinning seams and root-motion feet | `docs/RESULTS.md` rows |

Rules:

- Every test title carries its `ER-08-*` (or an existing `FR-*`/`PR-*`) tag; the tag must resolve to a traceability row.
- Integration tests that need the dev server bind `127.0.0.1:0`, wait on messages and never use fixed sleeps. Animation unit tests need no server and must run in Node.
- Real GPU work is measured on the bench page; CI runs the deterministic CPU suite with a fake device where a renderer is needed. A browser-only row is never deleted to make CI green.
- Performance rows report p50, p95, max, frame count, instance/joint counts, blend configuration, adapter/CPU, browser version and build hash. A number without those fields is not evidence.
- The walk/run golden is captured before and after any sampler or layer change in the same change.
- The `.d.ts` contract file for this spec (README §7.1) is generated from §3 and checked by a compile test; the conformance suite runs the same fixture against the CPU sampler and any future alternative sampler.

---

## 9. Dependencies

**Specs**

| Spec | Why |
|---|---|
| 00 | Package boundary, `Scene`/`Entity`/`Transform` contracts, determinism and no-allocation rules, version registry |
| 01 | Fixed loop, `dt`, `alpha`, tick order; animation updates once per tick |
| 02 | `Vec3`, `Quat`, `Mat4`, `quatNlerp`, `mat4Compose`, column-major convention, −Z forward |
| 03 | `Scene`, `Entity`, `Transform`; optional `PreviousTransform` and, if added, `SkinnedMesh`; animation does not require a new component |
| 04 | `skinned-pbr-v1` vertex layout, palette binding (uniform ≤64, bone texture >64), M1 vertex-shader skinning, morph layout (M2) |
| 05 | WebGL2 vertex-shader skinning, bone texture, morph fallback (M2) |
| 06 | glTF skin/animation decode, topological joint sort and `JOINTS_0` remap, `.pclip` parser, morph-target decode, asset kinds `animation` and `mesh` |
| 07 | Character controller consumes extracted root motion (M2); ragdoll bridge is out of scope |
| 11 | AI pedestrians drive animation parameters and root motion through gameplay, not through this package |
| 12 | Streaming releases clip/skeleton assets; compiled data stays valid while instances live |
| 15 | Saves store game playback state (clip names, times), never engine pose buffers |
| 16 | Tooling writes `.pclip`, applies key reduction and CUBICSPLINE resampling, parses the sidecar |
| 19 | Fixture conventions, benchmark harness, results template |

**Packages:** `@lanpad/engine-core` and `@lanpad/engine-assets` only. The integration agent adds `packages/engine/animation` to root `workspaces`, `tsconfig` references, Vitest projects and eslint boundary rules (00 §5.16). No third-party runtime dependency.

**Paper trail:** amendment **A14 — Browser-native engine reframe** is required before M0/M1 engine work merges (00 §1). The `.pclip` and metadata versions are added to the 00 §4.1 registry in the same change that lands the format.

**Preconditions for the M1 fixture:** spec 06 can decode a GLB skin with 24 joints and two animation clips; spec 04/05 accept a model-space palette and draw `skinned-pbr-v1`; spec 03's `Transform` exists and, if present, `PreviousTransform` is written by animation `apply`.

---

## 10. Risks

| ID | Risk | Likelihood | Impact | Mitigation / fallback |
|---|---|---|---|---|
| A1 | glTF joint order is not parent-before-child, so the palette cannot be computed in one pass | High | Wrong or rejected assets | Spec 06 sorts topologically and remaps `JOINTS_0`; compile validates; tooling test fixture includes an out-of-order skin |
| A2 | The renderer's M1 skinned layout is not added, so animation has no draw path | Medium | Visible T-pose or no characters | Contract in §3.7 and §9; renderer 04 adds `skinned-pbr-v1` as a new layout id; integration test fails until it lands |
| A3 | Root motion and physics both move a character, causing double motion or sliding | High | Broken movement feel | `apply` is forbidden with a physics body; `extract` feeds the character controller; the root components are zeroed after apply; fixture ER-08-05 |
| A4 | Event double-firing during crossfades and blend trees | High | Duplicate footsteps/attacks | Only the dominant base action emits; ties deterministic; fixture ER-08-04 |
| A5 | Quaternion sign or nlerp long-arc causes a pop at blend boundaries | Medium | Visible spin | Shortest-arc nlerp, canonical sign for hashing, normalized pose, golden blend fixture |
| A6 | Bone-texture skinning is unsupported or slow on a TV WebGL2 stack | Medium on TV | Characters fail or stutter | Uniform path for ≤64 joints; CPU palette; feature-probe float textures; TV row PENDING; fallback to a lower joint budget |
| A7 | Per-frame palette computation becomes the crowd bottleneck | High at M2 scale | Frame budget blown | Palette only for visible instances; p95 budget; LOD/update-rate reduction at M2; compute skinning is a future optional path |
| A8 | Per-tick allocations creep in through arrays/closures in blending | High over time | GC hitches on TV | Preallocated poses/actions/palette, review rule, heap-growth row ER-08-08 |
| A9 | Clip memory grows with open-world content | High at M3 | Memory pressure | Shared clips/skeletons, quantized `.pclip`, streaming release, per-game animation budget, `sourceBytes` stats |
| A10 | Compression error makes feet or hands jitter | Medium | Visible artifacts | Tolerance-bound key reduction and quantization; sampled-pose round-trip test, not just key values; per-track range |
| A11 | Morph targets multiply vertex cost and memory | Medium at M2 | Frame budget on TV | 8 active cap, M2 layout, WebGL2 CPU fallback, measurement before enabling by default |
| A12 | Animation scope grows into IK, retargeting, ragdolls and facial rigs | High | M1 slips | Non-goals are normative; new systems are additive and need a game requirement plus an amendment |
| A13 | The SDK restatement of `AnimationApi` drifts from the engine type | Medium | Game compiles but breaks at runtime | Structural assignability test in `packages/runtime`; SDK imports nothing |
| A14 | `Math` differences make replays unstable across browsers | Medium | Replay row fails off the recorded build | Determinism scoped per build/browser (00 §5.8); hash fixture records `ENGINE_VERSION`; no cross-browser lockstep claim |
| A15 | Compile of a large clip blocks boot | Medium | Slow join / long task | Compile is load-time; worker-capable pure functions; time-sliced boot; 8 ms long-task gate (FR-9.10) applies to decode/compile work |
| A16 | Clip/skeleton asset released while instances still animate | Low | Crash or garbage pose | Instances hold compiled immutable data; runtime retains skeleton for instance lifetime; dev warning on release-with-instances |

**Fallback if M1 animation slips:** the vertical slice ships with one clip per character, no blend tree, no root motion and no morph targets; crossfade, events and vertex skinning remain because the renderer and gameplay need them. The public API does not change; the missing features are additive at M2. A game that needs them is scheduled after M1, not given a private sampler.
