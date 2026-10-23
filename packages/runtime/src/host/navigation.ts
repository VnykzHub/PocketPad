/**
 * Host navigation between `/` (HP-03 launcher) and `/games/<slug>/` (HP-04).
 *
 * All route transitions live here so the browser history, the notice, the
 * modals and the stage are updated in one order. Phones stay connected across
 * every transition; only the stage is torn down.
 */
import { requestFullscreen } from "./chrome.js";
import type { HostLauncher } from "./launcher.js";
import type { HostModals } from "./modals.js";
import type { HostNotices } from "./notices.js";
import { gamePathFor, resolveHostRoute } from "./routes.js";
import type { HostStage } from "./stage.js";

export interface NavigationDeps {
  readonly window: Window;
  readonly doc: Document;
  readonly notices: HostNotices;
  readonly launcher: HostLauncher;
  readonly stage: HostStage;
  readonly modals: HostModals;
  /**
   * The console home is visible again (return from a game, failed launch).
   * Bootstrap uses it to re-send the launcher remote layout to phones.
   */
  readonly onLauncherShown?: () => void;
}

export interface HostNavigation {
  navigateToGame(slug: string): void;
  returnToLauncher(pushHistory?: boolean): void;
  /** Room-ended paths: replace the route so a reload cannot reopen the stage. */
  resetRouteToLauncher(): void;
  handlePopState(): void;
  install(): void;
  /** Direct `/games/<slug>/` boot; `/` waits for the room then shows HP-03. */
  bootRoute(): void;
}

export function createNavigation(deps: NavigationDeps): HostNavigation {
  /** Guards the shell's `onLaunch` re-entry into `navigateToGame`. */
  let launching = false;

  async function openLaunchedGame(slug: string): Promise<void> {
    try {
      await deps.stage.openGame(slug, { autoStart: true });
    } catch {
      // `openGame` reports its own errors through notices and resolves.
    }
    // Success: `startGame` made the stage interactive and destroyed the
    // launcher shell. Anything else (unknown game, load failure) returns to
    // the console home instead of leaving a stuck loading screen.
    if (deps.stage.isStageActive()) return;
    if (deps.window.location.pathname !== "/") {
      deps.window.history.replaceState({}, "", "/");
    }
    deps.launcher.returnToLauncher(slug);
    // The game never took over the phones, so restore the launcher remote.
    deps.onLauncherShown?.();
  }

  function navigateToGame(slug: string): void {
    // The console shell calls this from `onLaunch` while beginning its own
    // loading phase; that inner call must not launch twice.
    if (launching) return;
    const path = gamePathFor(slug);
    if (deps.window.location.pathname !== path) {
      deps.window.history.pushState({}, "", path);
    }
    deps.notices.clear();
    // Keep the shell alive through the launch so it can show asset progress.
    // It is a no-op when the shell is absent or already loading, and it is
    // destroyed by the stage only once the game is interactive.
    launching = true;
    try {
      deps.launcher.beginLaunch(slug);
    } finally {
      launching = false;
    }
    // The launcher activation is the user gesture: unlock audio, request
    // fullscreen, and start the selected game directly. The direct
    // /games/<slug>/ route keeps the explicit start screen.
    void deps.stage.unlockAudio();
    requestFullscreen(deps.doc);
    void openLaunchedGame(slug);
  }

  /** Rebuilds the `/` route without touching the live room (Phones stay). */
  function returnToLauncher(pushHistory = true): void {
    const slug = deps.stage.getCurrentSlug();
    if (pushHistory && deps.window.location.pathname !== "/") {
      deps.window.history.pushState({}, "", "/");
    }
    deps.notices.clear();
    deps.modals.closeAll();
    deps.stage.teardownGame();
    deps.stage.clearCurrentSlug();
    deps.launcher.returnToLauncher(slug);
    // Phones get the launcher d-pad back on the first `/` frame; the stage's
    // game layout must not survive the route change.
    deps.onLauncherShown?.();
  }

  function resetRouteToLauncher(): void {
    if (deps.window.location.pathname !== "/") {
      deps.window.history.replaceState({}, "", "/");
    }
    deps.modals.closeAll();
    deps.stage.teardownGame();
    deps.stage.clearCurrentSlug();
    deps.launcher.destroy();
  }

  function handlePopState(): void {
    const route = resolveHostRoute(deps.window.location.pathname);
    if (route.kind === "game") {
      deps.notices.clear();
      deps.launcher.destroy();
      void deps.stage.openGame(route.slug);
      return;
    }
    returnToLauncher(false);
  }

  function install(): void {
    deps.window.addEventListener("popstate", handlePopState);
  }

  function bootRoute(): void {
    const route = resolveHostRoute(deps.window.location.pathname);
    if (route.kind === "game") {
      void deps.stage.openGame(route.slug);
    }
    // HP-03: the launcher needs a live room; bootHost shows it.
  }

  return {
    navigateToGame,
    returnToLauncher,
    resetRouteToLauncher,
    handlePopState,
    install,
    bootRoute,
  };
}
