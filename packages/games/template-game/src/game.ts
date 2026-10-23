/**
 * Wave 0 template game.
 *
 * Its only job is to prove that adding `packages/games/<slug>/` with a
 * manifest, layout, entry and tsconfig registers a playable game with no root
 * configuration edit. It draws nothing, counts ticks and disposes cleanly.
 */
import type {
  Game,
  GameContext,
  GameInputSnapshot,
  GameManifest,
} from "@lanpad/sdk";

export const TEMPLATE_MAX_PLAYERS = 2;

export function createTemplateGame(manifest: GameManifest): Game {
  let context: GameContext | null = null;
  let ticks = 0;
  let presses = 0;

  return {
    manifest,
    init(ctx: GameContext): void {
      context = ctx;
      ticks = 0;
      presses = 0;
      ctx.debug.setCounter("ticks", 0);
    },
    simulate(dt: number, input: GameInputSnapshot): void {
      if (context === null) return;
      const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
      ticks += 1;
      for (const player of input.players) {
        if (player.connected && player.edges !== 0) presses += 1;
      }
      context.debug.setCounter("ticks", ticks);
      context.debug.setCounter("presses", presses);
      void step;
    },
    render(): void {
      const ctx = context;
      if (ctx === null) return;
      ctx.renderer.beginFrame(0);
      ctx.renderer.endFrame();
    },
    dispose(): void {
      context = null;
    },
  };
}

export default createTemplateGame;
