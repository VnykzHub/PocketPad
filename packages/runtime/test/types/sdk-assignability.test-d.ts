/**
 * ER-18-02 — compile-time projection checks.
 *
 * The SDK restates engine structures structurally instead of importing engine
 * packages. This file is the reverse check: the concrete engine types must be
 * assignable to the SDK projections a game receives. It is type-only; the
 * runtime test config includes it in `tsc --noEmit`, so a drift fails CI even
 * though this file never runs.
 *
 * The negative-fixture half of ER-18-02 (a deliberately missing member must
 * fail tsc with the member name) is not covered here; it needs a separate
 * `tsc` invocation against `sdk/test/fixtures/negative/**` and is PENDING.
 */
// @req ER-18-02
import type { AssetLibrary as EngineAssetLibrary } from "@lanpad/engine-assets";
import type {
  RendererCapabilities as EngineRendererCapabilities,
  Scene as EngineScene,
} from "@lanpad/engine-core";
import type {
  AssetLibrary as SdkAssetLibrary,
  RendererCapabilities as SdkRendererCapabilities,
  Scene as SdkScene,
} from "@lanpad/sdk";

type Assert<T extends true> = T;

export type SceneProjection = Assert<
  EngineScene extends SdkScene ? true : false
>;
export type AssetLibraryProjection = Assert<
  EngineAssetLibrary extends SdkAssetLibrary ? true : false
>;
export type RendererCapabilitiesProjection = Assert<
  EngineRendererCapabilities extends SdkRendererCapabilities ? true : false
>;
