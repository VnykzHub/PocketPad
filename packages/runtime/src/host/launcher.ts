/**
 * HP-03 launcher lifecycle.
 *
 * The launcher is the `/` route and needs a live room. It is built lazily and
 * kept across room events; only a route change or a stage start destroys it.
 * `syncCounts` edits the documented count span on each card in place, because
 * rebuilding the shelf would drop remote focus.
 */
import type { GameEntry } from "../game/registry.js";
import { Launcher, type LauncherGame } from "../ui/Launcher.js";
import { resolveHostRoute } from "./routes.js";

export interface LauncherDeps {
  readonly doc: Document;
  readonly gameRoot: HTMLElement;
  readonly games: ReadonlyArray<GameEntry>;
  readonly connectedCount: () => number;
  /** The launcher only exists once a room has a code. */
  readonly isRoomReady: () => boolean;
  readonly getPathname: () => string;
  readonly onLaunch: (slug: string) => void;
}

export interface HostLauncher {
  destroy(): void;
  maybeShow(): void;
  /** Mirrors the connected count onto visible cards without a re-render. */
  syncCounts(): void;
  focus(): void;
}

export function createLauncher(deps: LauncherDeps): HostLauncher {
  let launcher: Launcher | null = null;

  function launcherEntries(): ReadonlyArray<LauncherGame> {
    return deps.games.map((entry) => ({
      ...entry,
      connected: deps.connectedCount(),
    }));
  }

  function destroy(): void {
    launcher?.destroy();
    launcher = null;
  }

  function maybeShow(): void {
    if (!deps.isRoomReady()) return;
    if (resolveHostRoute(deps.getPathname()).kind !== "launcher") return;
    if (launcher !== null) return;
    launcher = new Launcher(deps.doc, {
      games: launcherEntries(),
      onLaunch: deps.onLaunch,
    });
    launcher.mount(deps.gameRoot);
    // The launcher is the host route: keep remote focus on the shelf.
    launcher.focus();
  }

  /**
   * HP-03 acceptance: connected counts update without a re-render flicker.
   * `Launcher` has no update method, so the shell edits only the documented
   * count span on each card instead of rebuilding the shelf and losing focus.
   */
  function syncCounts(): void {
    if (launcher === null) return;
    const count = deps.connectedCount();
    const cards = launcher.element.querySelectorAll<HTMLElement>(
      ".lanpad-launcher__card",
    );
    for (const card of cards) {
      const existing = card.querySelector<HTMLElement>(
        ".lanpad-launcher__card-connected",
      );
      if (count > 0) {
        const label = existing ?? deps.doc.createElement("span");
        if (existing === null) {
          label.className = "lanpad-launcher__card-connected";
          card.append(label);
        }
        label.textContent = `${count} connected`;
      } else if (existing !== null) {
        existing.remove();
      }
    }
  }

  return {
    destroy,
    maybeShow,
    syncCounts,
    focus() {
      launcher?.focus();
    },
  };
}
