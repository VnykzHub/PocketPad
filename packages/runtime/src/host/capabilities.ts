/**
 * D5/D6 runtime capabilities.
 *
 * These are installed before `GameHost` builds the game context, and the
 * injected senders are the only place games can reach the socket (FR-7.17).
 */
import type { GameHaptics } from "@lanpad/sdk";
import { EventRouter } from "../game/EventRouter.js";
import { installRuntimeCapabilities } from "../game/GameContext.js";
import { HapticApi } from "../game/HapticApi.js";
import { LayoutApi } from "../game/LayoutApi.js";
import { PanelApi } from "../game/PanelApi.js";
import { createBrowserSaveCapability } from "../game/SaveApi.js";
import type { HostClient } from "../net/hostClient.js";

/** Last pulse a game requested, for the debug overlay (D6-RT-01; FR-8.11). */
export interface HapticTrace {
  readonly target: number;
  readonly steps: number;
  readonly atMs: number;
}

export interface HostCapabilities {
  readonly layouts: LayoutApi;
  readonly panels: PanelApi;
  readonly haptics: HapticApi;
  readonly events: EventRouter;
  readonly gameHaptics: GameHaptics;
  getLastHaptic(): HapticTrace | null;
}

export function createHostCapabilities(client: HostClient): HostCapabilities {
  const layouts = new LayoutApi({ sender: client });
  const panels = new PanelApi({ sender: client });
  const haptics = new HapticApi({ send: (frame) => client.sendBinary(frame) });

  let lastHaptic: HapticTrace | null = null;
  const gameHaptics: GameHaptics = {
    pulse(target, pattern) {
      haptics.pulse(target, pattern);
      lastHaptic = {
        target: target === "all" ? 0 : target,
        steps: pattern.length,
        atMs: performance.now(),
      };
    },
  };
  const events = new EventRouter();
  installRuntimeCapabilities({
    layouts,
    panels,
    haptics: gameHaptics,
    events,
    // Lazy: the game id is only known when the stage opens a game. The
    // provider picks OPFS (atomic move) then IndexedDB, opens the store before
    // `game.init`, and leaves `ctx.save` undefined on failure (15 §5.5, §3.8).
    save: createBrowserSaveCapability(),
  });

  return {
    layouts,
    panels,
    haptics,
    events,
    gameHaptics,
    getLastHaptic: () => lastHaptic,
  };
}
