/**
 * Cube demo game module (D3-SDK-01).
 *
 * This is the `entry` named by `public/demo/cube-demo/game.manifest.json`.
 * It has exactly the shape a third-party game has: a default-exported
 * `(manifest) => Game` factory that receives everything else through
 * `init(ctx)`. It uses the SDK renderer interface only and never sees a
 * socket (FR-7.17).
 */
import type { Game, GameContext, GameInputSnapshot, GameManifest } from "@lanpad/sdk";
import { CubeDemo } from "../../render/CubeDemo.js";
import type { InputSnapshot } from "../../input/types.js";

export interface CubeDemoGame extends Game {
  /** The running demo after `init`, for tests and the overlay. */
  readonly demo: CubeDemo | null;
}

export default function createCubeDemoGame(manifest: GameManifest): CubeDemoGame {
  let demo: CubeDemo | null = null;
  return {
    manifest,
    get demo(): CubeDemo | null {
      return demo;
    },
    init(ctx: GameContext): void {
      demo = new CubeDemo(ctx.renderer);
      demo.init();
    },
    simulate(dt: number, input: GameInputSnapshot): void {
      // The runtime snapshot is the SDK snapshot; CubeDemo only reads it.
      demo?.simulate(dt, input as InputSnapshot);
    },
    render(alpha: number): void {
      demo?.render(alpha);
    },
    dispose(): void {
      demo?.dispose();
      demo = null;
    },
  };
}
