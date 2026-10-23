/**
 * Generational handle stores (04 §5.9). Handles are kind-tagged, index-stable
 * and generation-checked. A stale handle never resolves to a reused slot.
 */

import type {
  BufferHandle,
  GpuHandle,
  LodGroupHandle,
  MaterialHandle,
  MeshHandle,
  PipelineHandle,
  RenderTargetHandle,
  SamplerHandle,
  ShaderModuleHandle,
  TextureHandle,
} from "@lanpad/engine-core";

export type HandleKind =
  | "shader"
  | "pipeline"
  | "texture"
  | "sampler"
  | "buffer"
  | "mesh"
  | "lodGroup"
  | "material"
  | "renderTarget";

export const HANDLE_KINDS: readonly HandleKind[] = [
  "shader",
  "pipeline",
  "texture",
  "sampler",
  "buffer",
  "mesh",
  "lodGroup",
  "material",
  "renderTarget",
];

export type KindedHandle<K extends HandleKind> = GpuHandle & {
  readonly __kind: K;
};

export type AnyKindedHandle =
  | ShaderModuleHandle
  | PipelineHandle
  | TextureHandle
  | SamplerHandle
  | BufferHandle
  | MeshHandle
  | LodGroupHandle
  | MaterialHandle
  | RenderTargetHandle;

export function makeHandle<K extends HandleKind>(
  kind: K,
  index: number,
  generation: number,
): KindedHandle<K> {
  return { __kind: kind, index, generation };
}

export function isHandleKind(value: unknown): value is HandleKind {
  return typeof value === "string" && HANDLE_KINDS.includes(value as HandleKind);
}

export function kindOf(handle: GpuHandle): HandleKind | undefined {
  const value = (handle as GpuHandle & { readonly __kind?: unknown }).__kind;
  return isHandleKind(value) ? value : undefined;
}

export class HandleStore<T> {
  private values: (T | undefined)[] = [];
  private generations: number[] = [];
  private live: boolean[] = [];

  get count(): number {
    let total = 0;
    for (const isLive of this.live) {
      if (isLive) {
        total += 1;
      }
    }
    return total;
  }

  add(value: T): number {
    return this.addWithGeneration(value).index;
  }

  /** Adds a value and returns the slot with the generation needed to address it. */
  addWithGeneration(value: T): {
    readonly index: number;
    readonly generation: number;
  } {
    for (let index = 0; index < this.live.length; index += 1) {
      if (this.live[index] === false) {
        this.live[index] = true;
        this.values[index] = value;
        return { index, generation: this.generations[index] ?? 0 };
      }
    }
    const index = this.values.length;
    this.values.push(value);
    this.generations.push(0);
    this.live.push(true);
    return { index, generation: 0 };
  }

  get(handle: GpuHandle): T | undefined {
    if (
      !Number.isInteger(handle.index) ||
      !Number.isInteger(handle.generation) ||
      handle.index < 0 ||
      handle.generation < 0
    ) {
      return undefined;
    }
    if (
      this.live[handle.index] !== true ||
      this.generations[handle.index] !== handle.generation
    ) {
      return undefined;
    }
    return this.values[handle.index];
  }

  /** Frees a live slot. Returns undefined for a stale handle. */
  free(handle: GpuHandle): T | undefined {
    const value = this.get(handle);
    if (value === undefined) {
      return undefined;
    }
    const index = handle.index;
    this.live[index] = false;
    this.values[index] = undefined;
    this.generations[index] = (this.generations[index] ?? 0) + 1;
    return value;
  }

  forEachLive(
    callback: (index: number, generation: number, value: T) => void,
  ): void {
    for (let index = 0; index < this.live.length; index += 1) {
      if (this.live[index] === true) {
        const value = this.values[index];
        if (value !== undefined) {
          callback(index, this.generations[index] ?? 0, value);
        }
      }
    }
  }

  invalidateAll(): void {
    for (let index = 0; index < this.live.length; index += 1) {
      if (this.live[index] === true) {
        this.live[index] = false;
        this.values[index] = undefined;
        this.generations[index] = (this.generations[index] ?? 0) + 1;
      }
    }
  }
}
