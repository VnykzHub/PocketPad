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
  function navigateToGame(slug: string): void {
    const path = gamePathFor(slug);
    if (deps.window.location.pathname !== path) {
      deps.window.history.pushState({}, "", path);
    }
    deps.notices.clear();
    deps.launcher.destroy();
    // The launcher activation is the user gesture: unlock audio, request
    // fullscreen, and start the selected game directly. The direct
    // /games/<slug>/ route keeps the explicit start screen.
    void deps.stage.unlockAudio();
    requestFullscreen(deps.doc);
    void deps.stage.openGame(slug, { autoStart: true });
  }

  /** Rebuilds the `/` route without touching the live room (Phones stay). */
  function returnToLauncher(pushHistory = true): void {
    if (pushHistory && deps.window.location.pathname !== "/") {
      deps.window.history.pushState({}, "", "/");
    }
    deps.notices.clear();
    deps.modals.closeAll();
    deps.stage.teardownGame();
    deps.stage.clearCurrentSlug();
    deps.launcher.maybeShow();
    deps.launcher.focus();
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
