/**
 * @lanpad/engine-test — engine verification rig.
 *
 * W0/T1 exports the conformance-suite loader and the Node runner. The CLI,
 * Chrome/CDP launcher, golden diff, bench and determinism orchestration are
 * not implemented yet (docs/engine/19-testing-benchmarks.md §5.1).
 */
export * from "./schema.js";
export * from "./conformance.js";
