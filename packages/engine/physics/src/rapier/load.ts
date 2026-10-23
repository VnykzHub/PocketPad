/**
 * Rapier module load and initialization (A15).
 *
 * `@dimforge/rapier3d-compat` inlines its WASM as base64 in the ESM bundle,
 * so importing it is synchronous and `init()` compiles the module. The
 * adapter contract keeps `PhysicsAdapter.create` synchronous: callers must
 * `await initRapierPhysics()` once before creating a world.
 */
import * as RAPIER from "@dimforge/rapier3d-compat";

/** Exact version pinned in `package.json` and `package-lock.json` (A15). */
export const RAPIER_VERSION = "0.21.0";

let initPromise: Promise<void> | null = null;
let ready = false;

/** Idempotent module initialization. Safe to await from several callers. */
export async function initRapierPhysics(): Promise<void> {
  if (ready) return;
  initPromise ??= RAPIER.init();
  await initPromise;
  ready = true;
}

export function isRapierReady(): boolean {
  return ready;
}

export { RAPIER };
