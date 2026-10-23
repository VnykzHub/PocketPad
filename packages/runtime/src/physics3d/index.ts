/**
 * Renderer-facing pose bridge over a `Physics3D` world (spec 07 §3.7).
 *
 * The frozen contract syncs physics into engine-core `Scene` entities
 * (`bindTransform` / `syncScene`). The Babylon host path needs the same copy
 * into Babylon nodes, and `packages/runtime/src/babylon/**` owns the only
 * allowed Babylon import. This bridge stays Babylon-free: it accepts any
 * object with a mutable `position` and an optional writable
 * `rotationQuaternion` (a Babylon `TransformNode` satisfies both structurally),
 * so the boundary test keeps passing and the bridge can be tested in Node.
 *
 * Rules carried over from the contract and the M0 frame budget:
 * - explicit `step(dt)`; `dt` is forwarded and validated by the world;
 * - reads go through `readBody(handle, out)` into slot-owned `BodyState`
 *   objects, so a sync allocates nothing;
 * - a binding whose handle no longer resolves is dropped (swap-pop), which is
 *   how destroyed bodies leave the bridge without a per-frame registry scan.
 *
 * Babylon nodes using euler `rotation` instead of `rotationQuaternion` are
 * synced position-only. Set `node.rotationQuaternion = Quaternion.Identity()`
 * once before binding if the node should receive rotation.
 */
import type { Quat } from "@lanpad/engine-core";
import type {
  BodyHandle,
  BodyState,
  Physics3D,
} from "@lanpad/engine-physics";

/**
 * Minimal writable pose surface. A Babylon `TransformNode` matches it without
 * the runtime importing Babylon; a plain test object matches it too.
 */
export interface PoseTarget {
  position: { x: number; y: number; z: number };
  /** When present and non-null, rotation is written into this object. */
  rotationQuaternion?: Quat | null;
}

interface Binding {
  readonly body: BodyHandle;
  readonly target: PoseTarget;
  /** Caller-owned state for `readBody`; reused for this slot's lifetime. */
  readonly state: BodyState;
  /** True when the target had a non-null quaternion at bind time. */
  readonly writesRotation: boolean;
}

export interface PhysicsPoseBridge {
  /** The world this bridge reads; owned by the caller. */
  readonly world: Physics3D;
  /**
   * Binds a body to a pose target. Returns true when a binding was added;
   * rebinding the same handle repoints the existing slot and never grows the
   * bridge. A stale binding for a reused slot index is replaced.
   */
  bind(body: BodyHandle, target: PoseTarget): boolean;
  /** Removes the binding for this exact handle. Returns true if one existed. */
  unbind(body: BodyHandle): boolean;
  has(body: BodyHandle): boolean;
  /** Number of active bindings. */
  readonly size: number;
  /** Copies every live body's pose into its target; returns the copy count. */
  sync(): number;
  /** `world.step(dt)` then `sync()`. `dt` must equal `world.fixedDt`. */
  stepAndSync(dt: number): number;
  /** Drops all bindings. Does not step, clear or dispose the world. */
  dispose(): void;
}

function createBodyState(): BodyState {
  return {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    linearVelocity: { x: 0, y: 0, z: 0 },
    angularVelocity: { x: 0, y: 0, z: 0 },
    sleeping: false,
    enabled: true,
    mass: 0,
    userData: 0,
  };
}

function sameHandle(a: BodyHandle, b: BodyHandle): boolean {
  return a.index === b.index && a.generation === b.generation;
}

/**
 * Creates a pose bridge over `world`. The world stays caller-owned: disposing
 * the bridge only drops bindings.
 */
export function createPhysicsPoseBridge(world: Physics3D): PhysicsPoseBridge {
  const bindings: Binding[] = [];
  let disposed = false;

  const assertLive = (operation: string): void => {
    if (disposed) {
      throw new Error(`physics3d: ${operation} after dispose`);
    }
  };

  const removeAt = (index: number): void => {
    const lastIndex = bindings.length - 1;
    const last = bindings[lastIndex];
    if (index !== lastIndex && last) {
      bindings[index] = last;
    }
    bindings.pop();
  };

  const find = (body: BodyHandle): number => {
    for (let i = 0; i < bindings.length; i += 1) {
      const binding = bindings[i];
      if (binding && sameHandle(binding.body, body)) return i;
    }
    return -1;
  };

  const bridge: PhysicsPoseBridge = {
    world,

    bind(body: BodyHandle, target: PoseTarget): boolean {
      assertLive("bind");
      // A destroyed body frees its slot index; a later body reuses the index
      // with a new generation. Drop the stale binding first so the index is
      // never synced twice or left pointing at the old target.
      for (let i = bindings.length - 1; i >= 0; i -= 1) {
        const binding = bindings[i];
        if (binding && binding.body.index === body.index) {
          removeAt(i);
        }
      }
      const rotation = target.rotationQuaternion;
      bindings.push({
        body,
        target,
        state: createBodyState(),
        writesRotation: rotation !== undefined && rotation !== null,
      });
      return true;
    },

    unbind(body: BodyHandle): boolean {
      assertLive("unbind");
      const index = find(body);
      if (index < 0) return false;
      removeAt(index);
      return true;
    },

    has(body: BodyHandle): boolean {
      return find(body) >= 0;
    },

    get size(): number {
      return bindings.length;
    },

    sync(): number {
      assertLive("sync");
      let written = 0;
      // Backwards so a swap-pop from removeAt never skips an unvisited slot.
      for (let i = bindings.length - 1; i >= 0; i -= 1) {
        const binding = bindings[i];
        if (!binding) continue;
        if (!world.readBody(binding.body, binding.state)) {
          removeAt(i);
          continue;
        }
        const position = binding.target.position;
        position.x = binding.state.position.x;
        position.y = binding.state.position.y;
        position.z = binding.state.position.z;
        if (binding.writesRotation) {
          const rotation = binding.target.rotationQuaternion;
          if (rotation) {
            rotation.x = binding.state.rotation.x;
            rotation.y = binding.state.rotation.y;
            rotation.z = binding.state.rotation.z;
            rotation.w = binding.state.rotation.w;
          }
        }
        written += 1;
      }
      return written;
    },

    stepAndSync(dt: number): number {
      assertLive("stepAndSync");
      world.step(dt);
      return bridge.sync();
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      bindings.length = 0;
    },
  };

  return bridge;
}
