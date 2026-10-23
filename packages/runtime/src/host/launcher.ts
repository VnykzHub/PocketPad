/**
 * HP-03 launcher lifecycle, built on the console shell (spec 25; stream D).
 *
 * The launcher is the `/` route and needs a live room. It is built lazily and
 * kept across room events; only a route change or a stage start destroys it.
 * The four original methods keep their contract so `host/bootstrap.ts` and
 * `host/navigation.ts` need no changes:
 *
 *   destroy   tears the shell down; `hasStarted`/`lastLaunchedSlug` survive
 *   maybeShow rebuilds on `/` with the gate skipped after the first start and
 *             the previously launched tile focused
 *   syncCounts updates chips and lobby rows in place (no shelf rebuild)
 *   focus     moves focus to the active control for the current phase
 *
 * Stream G wiring is additive and optional: pass `presentationFor`, `joinUrl`,
 * `renderQr`, `unlockAudio`, room/connection/player getters, and call
 * `beginLaunch`/`setLoadingProgress`/`returnToLauncher`/`pollGamepad` from the
 * host. The current bootstrap passes only the original four, so the shell
 * renders with generated art, no QR URL and synthesized `P1..Pn` chips until
 * those getters are wired. Nothing here knows a game beyond the documented
 * Engine Cube product flag.
 */
import type { GamePresentation } from "@lanpad/sdk";
import type { AssetProgress } from "../assets/AssetLoader.js";
import type { GameEntry } from "../game/registry.js";
import "../ui/console/console.css";
import {
  ConsoleShell,
  type ConsoleShellOptions,
} from "../ui/console/shell.js";
import type { QrRenderer } from "../ui/console/topBar.js";
import type {
  ConsoleAction,
  ConsoleConnection,
  ConsoleGame,
  ConsolePlayerInput,
  ConsoleRoomInfo,
} from "../ui/console/types.js";
import { resolveHostRoute } from "./routes.js";

/** The bundled WebGPU tech demo, shown only on `/` with `?debug=1`. */
export const ENGINE_CUBE_SLUG = "engine-cube";

export interface LauncherDeps {
  readonly doc: Document;
  readonly gameRoot: HTMLElement;
  readonly games: ReadonlyArray<GameEntry>;
  readonly connectedCount: () => number;
  /** The launcher only exists once a room has a code. */
  readonly isRoomReady: () => boolean;
  readonly getPathname: () => string;
  readonly onLaunch: (slug: string) => void;

  // ---- additive wiring (all optional; stream G) -------------------------
  /** Explicit debug flag; defaults to `?debug=1` in the page URL. */
  readonly debug?: boolean;
  /** Additive manifest metadata (spec 25 §1) for one slug. */
  readonly presentationFor?: (slug: string) => GamePresentation | undefined;
  readonly roomCode?: () => string | null;
  readonly roomPin?: () => string | null;
  /** `<origin>/c/<CODE>#<token>`; only passed to the QR renderer. */
  readonly joinUrl?: () => string | null;
  readonly renderQr?: QrRenderer;
  readonly unlockAudio?: () => Promise<void>;
  /** Real identities from game-kit; defaults to synthesized `P1..Pn`. */
  readonly players?: () => readonly ConsolePlayerInput[] | undefined;
  readonly connection?: () => ConsoleConnection | undefined;
  readonly lowTier?: boolean;
  readonly now?: () => Date;
  readonly scheduleClock?: (tick: () => void) => unknown;
  readonly cancelClock?: (handle: unknown) => void;
  readonly gamepads?: ConsoleShellOptions["gamepads"];
  readonly onCancelLaunch?: (slug: string) => void;
}

export interface HostLauncher {
  destroy(): void;
  maybeShow(): void;
  /** Mirrors connected players/connection onto the shell without a rebuild. */
  syncCounts(): void;
  focus(): void;
  /** Shows the loading screen and calls `onLaunch`; a no-op while hidden. */
  beginLaunch(slug?: string): void;
  /** Forward `AssetProgress` from the stage/asset loader. */
  setLoadingProgress(progress: AssetProgress): void;
  /** Rebuild on `/` and restore the launched tile (or `slug`). */
  returnToLauncher(slug?: string | null): void;
  updatePlayers(players: readonly ConsolePlayerInput[]): void;
  updateConnection(connection: ConsoleConnection): void;
  updateRoom(room: ConsoleRoomInfo): void;
  /** Host frame hook; there is no rAF loop inside the launcher. */
  pollGamepad(): ConsoleAction[];
  /** Broker remote button id (`up|down|left|right|ok|back`). */
  handleRemote(button: string): boolean;
  readonly shell: ConsoleShell | null;
}

/** `?debug=1`, either parameter position, never `?debug=10`. */
export function isDebugSearch(search: string): boolean {
  return /(?:^|[?&])debug=1(?:&|$)/.test(search);
}

/**
 * Maps one registry entry to a console tile. `presentation` is copied when the
 * host supplies it; Engine Cube is marked `debugOnly` by slug, the single
 * product flag the launcher filters on.
 */
export function consoleGameFromEntry(
  entry: GameEntry,
  presentationFor?: (slug: string) => GamePresentation | undefined,
): ConsoleGame {
  const presentation = presentationFor?.(entry.slug);
  return {
    slug: entry.slug,
    name: entry.name,
    ...(entry.description.length > 0 ? { description: entry.description } : {}),
    minPlayers: entry.minPlayers,
    maxPlayers: entry.maxPlayers,
    ...(presentation !== undefined ? { presentation } : {}),
    ...(entry.slug === ENGINE_CUBE_SLUG ? { debugOnly: true } : {}),
  };
}

export function createLauncher(deps: LauncherDeps): HostLauncher {
  let shell: ConsoleShell | null = null;
  let hasStarted = false;
  let lastLaunchedSlug: string | null = null;

  function resolveDebug(): boolean {
    if (deps.debug !== undefined) return deps.debug;
    try {
      const view = deps.doc.defaultView as
        | (Window & { location?: { search?: string } })
        | null;
      return isDebugSearch(view?.location?.search ?? "");
    } catch {
      return false;
    }
  }

  function playerInputs(): readonly ConsolePlayerInput[] {
    const provided = deps.players?.();
    if (provided !== undefined) return provided;
    const count = Math.max(0, Math.min(8, Math.floor(deps.connectedCount())));
    const players: ConsolePlayerInput[] = [];
    for (let slot = 1; slot <= count; slot += 1) players.push({ slot });
    return players;
  }

  function roomInfo(): ConsoleRoomInfo {
    const joinUrl = deps.joinUrl?.() ?? null;
    return {
      code: deps.roomCode?.() ?? null,
      pin: deps.roomPin?.() ?? null,
      ...(joinUrl !== null ? { joinUrl } : {}),
    };
  }

  function connectionInfo(): ConsoleConnection {
    return deps.connection?.() ?? { text: "Room live", tone: "ok" };
  }

  function destroy(): void {
    shell?.destroy();
    shell = null;
  }

  function maybeShow(): void {
    if (shell !== null) return;
    if (!deps.isRoomReady()) return;
    if (resolveHostRoute(deps.getPathname()).kind !== "launcher") return;

    const created = new ConsoleShell(deps.doc, {
      games: deps.games.map((entry) =>
        consoleGameFromEntry(entry, deps.presentationFor),
      ),
      debug: resolveDebug(),
      skipStartGate: hasStarted,
      focusSlug: lastLaunchedSlug,
      room: roomInfo(),
      connection: connectionInfo(),
      players: playerInputs(),
      onStarted: () => {
        hasStarted = true;
      },
      onLaunch: (game) => {
        lastLaunchedSlug = game.slug;
        deps.onLaunch(game.slug);
      },
      ...(deps.renderQr !== undefined ? { renderQr: deps.renderQr } : {}),
      ...(deps.unlockAudio !== undefined
        ? { unlockAudio: deps.unlockAudio }
        : {}),
      ...(deps.lowTier !== undefined ? { lowTier: deps.lowTier } : {}),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
      ...(deps.scheduleClock !== undefined
        ? { scheduleClock: deps.scheduleClock }
        : {}),
      ...(deps.cancelClock !== undefined
        ? { cancelClock: deps.cancelClock }
        : {}),
      ...(deps.gamepads !== undefined ? { gamepads: deps.gamepads } : {}),
      ...(deps.onCancelLaunch !== undefined
        ? {
            onCancelLaunch: (game: ConsoleGame) =>
              deps.onCancelLaunch?.(game.slug),
          }
        : {}),
    });

    shell = created;
    created.mount(deps.gameRoot);
    created.focus();
  }

  function syncCounts(): void {
    if (shell === null) return;
    shell.updatePlayers(playerInputs());
    shell.updateConnection(connectionInfo());
    shell.updateRoom(roomInfo());
  }

  function beginLaunch(slug?: string): void {
    if (shell === null) return;
    const target =
      slug ?? lastLaunchedSlug ?? shell.row.focusedGame?.slug ?? null;
    if (target === null) return;
    const game = shell.row.gameList.find((entry) => entry.slug === target);
    if (game !== undefined) shell.beginLaunch(game);
  }

  function setLoadingProgress(progress: AssetProgress): void {
    shell?.setLoadingProgress(progress);
  }

  function returnToLauncher(slug?: string | null): void {
    const target = slug !== undefined ? slug : lastLaunchedSlug;
    maybeShow();
    shell?.returnFromGame(target);
    shell?.focus();
  }

  return {
    destroy,
    maybeShow,
    syncCounts,
    focus() {
      shell?.focus();
    },
    beginLaunch,
    setLoadingProgress,
    returnToLauncher,
    updatePlayers(players) {
      shell?.updatePlayers(players);
    },
    updateConnection(connection) {
      shell?.updateConnection(connection);
    },
    updateRoom(room) {
      shell?.updateRoom(room);
    },
    pollGamepad() {
      return shell?.pollGamepad() ?? [];
    },
    handleRemote(button) {
      return shell?.handleRemote(button) ?? false;
    },
    get shell() {
      return shell;
    },
  };
}
