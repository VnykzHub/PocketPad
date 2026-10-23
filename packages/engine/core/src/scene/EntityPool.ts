/**
 * Prefab entity pool (spec 03 §3.9, §5.8, PR-9.4).
 *
 * Instances live at the scene root while idle and are disabled as a whole.
 * `acquire` resets every prefab component in record order (parent before
 * child) and re-enables the instance; `release` disables it and returns it to
 * the LIFO idle stack. With `reset`-capable components acquire does not
 * allocate.
 */

import type {
  ComponentType,
  EngineScene,
  Entity,
  EntityPoolOptions,
  Prefab,
} from "../contracts/scene.js";
import { Parent, Transform } from "./builtins.js";
import { getComponentByName } from "./component.js";
import { sceneError } from "./errors.js";
import { IDENTITY_TRANSFORM_PAYLOAD } from "./Serialization.js";
import { instantiateRecords } from "./Prefab.js";

interface PoolComponent {
  readonly type: ComponentType<unknown>;
  readonly payload: unknown;
}

interface PoolInstance {
  readonly root: Entity;
  readonly entities: readonly Entity[];
  active: boolean;
}

const DEFAULT_MAX_INSTANCES = 1_024;

/** Pool-specific hooks the concrete scene exposes (not part of `EngineScene`). */
interface ScenePoolHooks {
  readonly devChecks?: boolean;
  noteRejectedOperation?(): void;
  noteStaleHandle?(): void;
}

export class EntityPool {
  private readonly scene: EngineScene;
  private readonly prefab: Prefab;
  private readonly defaultParent: Entity | null;
  private readonly maxInstances: number;
  private readonly recordComponents: readonly (readonly PoolComponent[])[];
  private readonly instances: PoolInstance[] = [];
  private readonly idleStack: Uint32Array;
  private readonly rootIndexById = new Map<number, number>();
  private readonly devChecks: boolean;
  private idleCount = 0;
  private activeCount = 0;
  private disposed = false;

  constructor(scene: EngineScene, prefab: Prefab, options?: EntityPoolOptions) {
    this.scene = scene;
    this.prefab = prefab;
    this.defaultParent = options?.parent ?? null;
    this.devChecks = (scene as unknown as ScenePoolHooks).devChecks === true;

    let roots = 0;
    let rootIndex = -1;
    for (let index = 0; index < prefab.entities.length; index += 1) {
      if (prefab.entities[index]!.parent === null) {
        roots += 1;
        rootIndex = index;
      }
    }
    if (roots !== 1 || rootIndex !== prefab.root) {
      throw sceneError(
        "E_SCENE_INVALID",
        "EntityPool: prefab must have exactly one root at `prefab.root`",
      );
    }

    this.recordComponents = this.buildRecordComponents(prefab);

    const max = options?.max ?? DEFAULT_MAX_INSTANCES;
    if (!Number.isInteger(max) || max < 1) {
      throw sceneError("E_SCENE_INVALID", "EntityPool: max must be a positive integer");
    }
    this.maxInstances = max;

    const initial = options?.initial ?? 0;
    if (!Number.isInteger(initial) || initial < 0 || initial > max) {
      throw sceneError(
        "E_SCENE_INVALID",
        "EntityPool: initial must be an integer in [0, max]",
      );
    }

    this.idleStack = new Uint32Array(max);
    for (let count = 0; count < initial; count += 1) {
      const instance = this.createInstance();
      this.setEnabledForInstance(instance, false);
      this.pushIdle(this.instances.length - 1);
    }
  }

  private buildRecordComponents(
    prefab: Prefab,
  ): readonly (readonly PoolComponent[])[] {
    const result = new Array<readonly PoolComponent[]>(prefab.entities.length);
    for (let index = 0; index < prefab.entities.length; index += 1) {
      const record = prefab.entities[index]!;
      const source = record.components;
      const names = Object.keys(source);
      const components: PoolComponent[] = [];
      let hasTransform = false;
      for (let nameIndex = 0; nameIndex < names.length; nameIndex += 1) {
        const name = names[nameIndex]!;
        const type = getComponentByName(name);
        if (type === undefined) {
          throw sceneError(
            "E_SCENE_INVALID",
            `EntityPool: unknown component ${name} in record ${index}`,
          );
        }
        if ((type as unknown) === (Parent as unknown)) {
          throw sceneError(
            "E_SCENE_INVALID",
            `EntityPool: record ${index} carries a parent component`,
          );
        }
        if (!type.serializable || type.deserialize === undefined) {
          throw sceneError(
            "E_SCENE_INVALID",
            `EntityPool: component ${name} is not serializable`,
          );
        }
        if (type.id === Transform.id) hasTransform = true;
        components.push({ type: type as ComponentType<unknown>, payload: source[name] });
      }
      for (let a = 1; a < components.length; a += 1) {
        const item = components[a]!;
        let b = a - 1;
        while (b >= 0 && components[b]!.type.id > item.type.id) {
          components[b + 1] = components[b]!;
          b -= 1;
        }
        components[b + 1] = item;
      }
      if (!hasTransform) {
        components.unshift({
          type: Transform as ComponentType<unknown>,
          payload: IDENTITY_TRANSFORM_PAYLOAD,
        });
      }
      result[index] = components;
    }
    return result;
  }

  private createInstance(): PoolInstance {
    const created = instantiateRecords(this.scene, this.prefab, null);
    const instance: PoolInstance = {
      root: created.root,
      entities: created.entities,
      active: false,
    };
    this.instances.push(instance);
    this.rootIndexById.set(created.root.id, this.instances.length - 1);
    return instance;
  }

  private setEnabledForInstance(instance: PoolInstance, enabled: boolean): void {
    for (let index = 0; index < instance.entities.length; index += 1) {
      const entity = instance.entities[index]!;
      if (this.scene.isAlive(entity)) this.scene.setEnabled(entity, enabled);
    }
  }

  private resetInstance(instance: PoolInstance): void {
    for (let recordIndex = 0; recordIndex < instance.entities.length; recordIndex += 1) {
      const entity = instance.entities[recordIndex]!;
      if (!this.scene.isAlive(entity)) {
        this.reject("reset: instance entity was destroyed externally", "E_STALE_HANDLE");
        continue;
      }
      const components = this.recordComponents[recordIndex]!;
      let transformReset = false;
      for (let index = 0; index < components.length; index += 1) {
        const component = components[index]!;
        const current = this.scene.get(entity, component.type);
        const reset = component.type.reset;
        if (current !== undefined && reset !== undefined) {
          reset(current, component.payload);
          if (component.type.id === Transform.id) transformReset = true;
          continue;
        }
        const deserialize = component.type.deserialize;
        if (deserialize !== undefined) {
          this.scene.add(entity, component.type, deserialize(component.payload));
          continue;
        }
        throw sceneError(
          "E_SCENE_FORMAT",
          `EntityPool: component ${component.type.name} cannot be reset`,
        );
      }
      if (transformReset) this.scene.markTransformDirty(entity);
    }
  }

  private pushIdle(index: number): void {
    this.idleStack[this.idleCount] = index;
    this.idleCount += 1;
  }

  private reject(message: string, code: "E_SCENE_INVALID" | "E_STALE_HANDLE"): void {
    const hooks = this.scene as unknown as ScenePoolHooks;
    if (code === "E_STALE_HANDLE") hooks.noteStaleHandle?.();
    else hooks.noteRejectedOperation?.();
    if (this.devChecks) throw sceneError(code, `EntityPool.${message}`);
  }

  /** Returns a reset, enabled instance root. Throws at the instance cap. */
  acquire(parent?: Entity | null): Entity {
    if (this.disposed) {
      throw sceneError("E_CONTRACT", "EntityPool.acquire: pool is disposed");
    }

    let index: number;
    if (this.idleCount > 0) {
      this.idleCount -= 1;
      index = this.idleStack[this.idleCount]!;
    } else {
      if (this.instances.length >= this.maxInstances) {
        throw sceneError("E_SCENE_INVALID", "EntityPool.acquire: instance cap reached");
      }
      this.createInstance();
      index = this.instances.length - 1;
    }

    const instance = this.instances[index]!;
    this.resetInstance(instance);
    this.setEnabledForInstance(instance, true);

    const target = parent === undefined ? this.defaultParent : parent;
    let accepted: boolean;
    try {
      accepted = this.scene.setParent(instance.root, target);
    } catch (error) {
      this.setEnabledForInstance(instance, false);
      this.pushIdle(index);
      throw error;
    }
    if (!accepted) {
      this.setEnabledForInstance(instance, false);
      this.pushIdle(index);
      throw sceneError("E_SCENE_INVALID", "EntityPool.acquire: parent rejected");
    }

    instance.active = true;
    this.activeCount += 1;
    return instance.root;
  }

  /** Disables every instance entity and returns it to the idle list. */
  release(entity: Entity): void {
    if (this.disposed) return;
    const index = this.rootIndexById.get(entity.id);
    if (index === undefined) {
      this.reject("release: entity is not owned by this pool", "E_SCENE_INVALID");
      return;
    }
    const instance = this.instances[index];
    if (instance === undefined || instance.root.generation !== entity.generation) {
      this.reject("release: entity is not owned by this pool", "E_SCENE_INVALID");
      return;
    }
    if (!instance.active) {
      this.reject("release: instance is already idle", "E_SCENE_INVALID");
      return;
    }
    if (!this.scene.isAlive(instance.root)) {
      this.reject("release: instance root was destroyed externally", "E_STALE_HANDLE");
      return;
    }
    this.setEnabledForInstance(instance, false);
    instance.active = false;
    this.activeCount -= 1;
    this.pushIdle(index);
  }

  /** Destroys every instance this pool created; idempotent. */
  dispose(): void {
    if (this.disposed) return;
    for (let index = 0; index < this.instances.length; index += 1) {
      const root = this.instances[index]!.root;
      if (this.scene.isAlive(root)) this.scene.destroyEntity(root);
    }
    this.instances.length = 0;
    this.rootIndexById.clear();
    this.idleCount = 0;
    this.activeCount = 0;
    this.disposed = true;
  }

  get active(): number {
    return this.activeCount;
  }

  get idle(): number {
    return this.idleCount;
  }

  get created(): number {
    return this.instances.length;
  }
}
