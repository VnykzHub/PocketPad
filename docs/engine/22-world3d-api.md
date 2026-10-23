# 22 — Game-facing 3D world API (`ctx.world`)

**Status:** frozen contract for Wave 0. Implementation streams A (Babylon) and the `@lanpad/sdk` types land in Wave 0/1.
**Goal:** give every game one backend-agnostic, allocation-free 3D surface for models, instances, animation, scene settings, camera and primitives, without exposing a Babylon type.
**Non-goals:** physics bodies, terrain streaming, editor authoring, custom shaders, particle systems, 2D drawing. Those belong to specs 07/12/17 and later.

---

## 1. Availability and naming

`GameContext.world?: GameWorld3D` is **additive**. It is absent on 2D-only hosts, on the custom-engine path until a world backend exists, and before the host installs it. A game feature-detects:

```ts
if (ctx.world === undefined) { /* 2D or reduced host */ }
```

The existing spec-12 streamer member is renamed `ctx.streaming?: WorldStreamer` (ADR-0004 clarification 1). No game consumes the streamer today. `ctx.scene` and `ctx.animation` are custom-engine projections; on a Babylon host they are absent, and a game must use exactly one path: `ctx.world` **or** the custom projections, never both.

No Babylon type, node, mesh or material appears in `@lanpad/sdk`. A boundary test scans the SDK and games for engine imports.

## 2. Types

All handles are opaque numbers. A handle is valid until `dispose()`; using it after dispose throws `WorldError` with `E_WORLD_DISPOSED`.

```ts
export type WorldHandle = number;

export interface World3DCapabilities {
  readonly backend: "webgpu" | "webgl2";
  readonly tier: "high" | "reduced";
  readonly shadows: boolean;
  readonly post: boolean;
  readonly animation: boolean;
  readonly instances: boolean;
  readonly instanceTint: boolean;
  readonly maxActors: number;
  readonly maxInstances: number;
}

export interface WorldTransform {
  x: number; y: number; z: number;
  /** Yaw about +Y, radians; ignored when a quaternion setter was used last. */
  yaw: number;
  /** Uniform scale. */
  scale: number;
}

export interface ClipPlayOptions {
  readonly loop?: boolean;      // default true
  readonly speed?: number;      // default 1, clamped 0..10
  readonly restart?: boolean;   // default true
}

export interface FollowOptions {
  readonly distance?: number;   // default 8
  readonly height?: number;     // default 4
  readonly lookAhead?: number;  // default 2
  readonly smoothing?: number;  // default 6, per second
}

export type PrimitiveKind = "box" | "sphere" | "cylinder" | "plane" | "ground";
export type ShadowTier = "off" | "low" | "high";
export type SkyPreset = "none" | "day" | "dusk" | "night" | "overcast";
export type ColorGrade = "none" | "warm" | "cool";

export interface PrimitiveOptions {
  readonly color?: string;        // #rgb / #rrggbb, default "#ffffff"
  readonly emissive?: string;     // null/absent = no emissive
  readonly size?: number;         // box/plane/ground edge, default 1
  readonly radius?: number;       // sphere/cylinder, default 0.5
  readonly height?: number;       // cylinder, default 1
  readonly segments?: number;     // sphere/cylinder, clamped 8..64
  readonly visible?: boolean;     // default true
}

export interface PostOptions {
  readonly bloom?: boolean;
  readonly vignette?: number;     // 0..1
  readonly grade?: ColorGrade;
}

export interface WorldActor {
  readonly id: WorldHandle;
  readonly alive: boolean;
  setPosition(x: number, y: number, z: number): void;
  setYaw(radians: number): void;
  setQuaternion(x: number, y: number, z: number, w: number): void;
  setScale(uniform: number): void;
  setScale3(x: number, y: number, z: number): void;
  setTint(color: string | null): void;
  setEmissive(color: string | null): void;
  setVisible(visible: boolean): void;
  playClip(name: string, options?: ClipPlayOptions): void;
  stopClip(fadeSeconds?: number): void;
  crossfadeClip(name: string, fadeSeconds: number, options?: ClipPlayOptions): void;
  setClipSpeed(speed: number): void;
  dispose(): void;
}

export interface WorldInstances {
  readonly count: number;
  setTransform(index: number, x: number, y: number, z: number, yaw: number, scale: number): void;
  setVisible(index: number, visible: boolean): void;
  /** No-op when `capabilities.instanceTint` is false. */
  setTintAt(index: number, color: string | null): void;
  dispose(): void;
}

export interface GameWorld3D {
  readonly capabilities: World3DCapabilities;
  hasModel(assetId: string): boolean;
  spawnModel(assetId: string): WorldActor;
  spawnInstances(assetId: string, count: number): WorldInstances;
  createPrimitive(kind: PrimitiveKind, options?: PrimitiveOptions): WorldActor;

  setSun(direction: Vec3, color: string, intensity: number): void;
  setAmbient(color: string, intensity: number): void;
  setFog(color: string | null, near?: number, far?: number): void;
  setSky(preset: SkyPreset): void;
  setSkyTexture(assetId: string | null): void;
  setShadowTier(tier: ShadowTier): void;
  setPost(options: PostOptions): void;

  setCamera(position: Vec3, target: Vec3, fovDegrees?: number): void;
  follow(actor: WorldActor, options?: FollowOptions): void;
  clearFollow(): void;

  /** Host-only: advances clips and follow once per fixed tick before simulate. */
  update(dtSeconds: number): void;
  dispose(): void;
}
```

## 3. Semantics

- **Asset ids** come from the game's `assets.json` (spec 23). `spawnModel` on a missing or not-ready id throws `E_WORLD_ASSET`; no partial actor is created. `hasModel` is the non-throwing probe.
- **Instances** draw one shared mesh many times. `count` above `capabilities.maxInstances` throws `E_WORLD_LIMIT`; the index range is 0-based and stable for the lifetime of the handle.
- **Transforms** are metres, right-handed, +Y up, −Z forward. `setPosition` replaces translation; `setYaw` replaces rotation with a Y-only quaternion; `setQuaternion` replaces it entirely. Scale is uniform unless `setScale3` is used.
- **Tint** multiplies the model's base colour; `null` restores the asset's material. **Emissive** adds an unlit colour; `null` clears it.
- **Animation:** `playClip` starts a named GLB animation group; `crossfadeClip` fades from the current clip over `fadeSeconds`; `stopClip` fades out if given. Unknown clip names throw `E_WORLD_UNSUPPORTED`. A model without clips reports `animation: false` in its actor capabilities; the world capability stays true.
- **Camera:** `setCamera` sets position/target/FOV (default 60, clamped 20..110). `follow` overrides position/target each `update` using a smoothing factor; `clearFollow` stops it. A follow never allocates.
- **Scene:** sun direction need not be normalized; intensity is 0..10. Fog with `null` clears. `setSky` applies a built-in preset; `setSkyTexture` overrides with an asset id (or `null`). Shadow and post tiers are **advisory**: the adapter may clamp them to the capability tier, and the game must read `capabilities` before relying on them.
- **Lifecycle:** the host calls `world.update(dt)` once per fixed tick before `simulate`. The game calls `dispose()` on teardown; the host also calls it exactly once. Both are idempotent.

## 4. Tiers

| Feature | `high` (WebGPU) | `reduced` (WebGL2) |
|---|---|---|
| Models/instances/primitives | yes | yes |
| Skeletal animation | yes | yes, lower bone budget |
| Shadows | cascaded/high | low or off |
| Post (bloom/vignette/grade) | yes | off (reported false) |
| Sky texture | yes | yes |
| Instance tint | yes | optional |

A game branches on `capabilities`, never on `backend`, for correctness.

## 5. Allocation rules

- Setters take primitives; per-frame calls allocate nothing.
- `spawnModel`, `spawnInstances`, `createPrimitive`, `setCamera` and scene setup are cold path and may allocate.
- `update` and `follow` must not allocate after warm-up.
- The conformance suite measures allocations with the existing counters; a regression fails the stream gate.

## 6. Fake and conformance

`@lanpad/sdk/testing` exports `createFakeWorld()`: a pure implementation that records every call, advances clip time from `update(dt)`, returns deterministic handles and never touches a GPU. The same conformance suite runs against the fake in Node and against the Babylon adapter in Chrome.

## 7. Acceptance

| ID | Criterion |
|---|---|
| ER-22-01 | The fake satisfies the conformance suite: every method callable in any order, handles opaque, dispose idempotent |
| ER-22-02 | The Babylon adapter renders a GLB model, an instance batch and a primitive in Chrome on WebGPU |
| ER-22-03 | `playClip`/`crossfadeClip`/`stopClip` advance and blend; a skinned character visibly animates |
| ER-22-04 | Sun, ambient, fog, sky and shadow-tier changes are visible in a screenshot; unsupported post reports false |
| ER-22-05 | `follow` converges to the target distance/height and never allocates per tick |
| ER-22-06 | The same scene renders on WebGL2 with reduced capabilities and no post |
| ER-22-07 | No Babylon/engine import appears in `sdk/**` or `packages/games/**` (source scan) |
| ER-22-08 | `spawnModel` with a missing asset throws `E_WORLD_ASSET` and creates no actor |
| ER-22-09 | Exceeding actor/instance limits throws `E_WORLD_LIMIT` with the limit in the message |
| ER-22-10 | `dispose` frees actors, instances and GPU resources; a second call is a no-op |

Every row is PENDING until evidence exists. Stream A's 2026-10-23 browser run
(headless Chrome 155, 1280×720, `experiments/babylon-world/`) measured WebGPU
p95 3.865 ms and WebGL2 p95 3.185 ms with 0 errors over the model + 8 instances
+ 5 primitives scene; those are desktop dev-machine numbers, not target
hardware. ER-22-01 is covered by `sdk/test/world3d.conformance.test.ts` (fake)
and the adapter suite; ER-22-05's per-tick allocation is PENDING.

## 8. File ownership

| Path | Owner |
|---|---|
| `sdk/src/world3d.ts`, `sdk/src/testing/world3d.ts` | Wave 0 |
| `packages/runtime/src/babylon/world3d/**` | Stream A |
| `packages/runtime/src/game/GameContext.ts` wiring | Stream G |
| Conformance suite `sdk/test/world3d.conformance.test.ts` | Wave 0 |

## 9. Risks

- Babylon ignores per-instance matrices on **skinned** thin instances. The adapter auto-detects skeletons and pools one clone + skeleton per index instead; transforms are correct, but memory/GPU cost is higher. Record a budget line when the first skinned crowd lands.
- `@babylonjs/loaders@9.32.0` is required for GLB containers and is pinned in `packages/runtime/package.json`; it is a lazy chunk, not boot code.
- The browser evidence is headless, 1280×720, desktop RTX 3050 Ti only; TV, integrated GPU and real display pacing remain PENDING.
- Babylon's thin instances need a custom material for per-instance tint; if it does not land, `instanceTint` reports false and games fall back to per-actor meshes.
- Skeletal animation and skinning loaders add bundle weight; measured against the 5 MiB boot cap in streams B/C.
- Follow smoothing must use the fixed tick, not wall-clock time, or replays diverge.
