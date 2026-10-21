/**
 * D4 path shim.
 *
 * D0 froze the `RoomRegistry` implementation at `src/registry.ts`; the D4 plan
 * describes it as `src/room/registry.ts`. Both spellings resolve to the one
 * implementation — new room modules (D4-SRV-03 host/stats) can import from
 * here without creating a second registry.
 */
export * from "../registry.js";
