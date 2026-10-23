/**
 * Shader-module cache (04 §4.2, §5.5).
 *
 * Modules are never evicted while the device is alive. When the 64-module cap
 * is reached a new module is refused with `E_UNSUPPORTED_FEATURE`; silently
 * evicting a live module would invalidate pipelines that still reference it.
 */

import type { ShaderModuleKey } from "../contracts/webgpu.js";

export interface ShaderCacheEntry<T> {
  readonly key: ShaderModuleKey;
  readonly value: T;
}

export class ShaderCache<T> {
  private readonly capacity: number;
  private readonly entries = new Map<ShaderModuleKey, ShaderCacheEntry<T>>();

  constructor(capacity = 64) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: ShaderModuleKey): T | undefined {
    return this.entries.get(key)?.value;
  }

  has(key: ShaderModuleKey): boolean {
    return this.entries.has(key);
  }

  /** Returns false when a new module would exceed the cap. */
  set(key: ShaderModuleKey, value: T): boolean {
    if (this.entries.has(key)) {
      this.entries.set(key, { key, value });
      return true;
    }
    if (this.entries.size >= this.capacity) {
      return false;
    }
    this.entries.set(key, { key, value });
    return true;
  }

  delete(key: ShaderModuleKey): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
