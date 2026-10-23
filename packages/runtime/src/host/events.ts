/**
 * Host page event registration: remote Back/Enter handling, the results seam,
 * route popstate and the visibility/pagehide pause contract (AR-4, FR-9.2).
 *
 * Registration order matches the original shell: key handling first, then the
 * route listener, then results, then visibility/pagehide/pageshow. Components
 * closer to the focus (LeaveConfirm, ResultsOverlay) run first and mark an
 * event `defaultPrevented`; this module never treats that key as a second
 * action.
 */
import { attachVisibilityPause } from "../game/GameHost.js";
import { shouldCreateRoomOnKey, type HostPhase } from "../net/hostClient.js";
import { RESULTS_EVENT } from "./copy.js";
import type { HostModals } from "./modals.js";
import type { HostNavigation } from "./navigation.js";
import type { HostOverlay } from "./overlay.js";
import { isBackKey, isResultsData } from "./routes.js";
import type { HostStage } from "./stage.js";

export interface HostEventsDeps {
  readonly window: Window;
  readonly doc: Document;
  readonly overlay: HostOverlay;
  readonly modals: HostModals;
  readonly stage: HostStage;
  readonly navigation: HostNavigation;
  readonly getPhase: () => HostPhase;
  readonly createRoom: () => void;
  readonly pauseRecoveryForVisibility: () => void;
  readonly resumeRecoveryForVisibility: () => void;
  readonly syncPause: () => void;
}

export function installHostEvents(deps: HostEventsDeps): void {
  deps.window.addEventListener("keydown", (event) => {
    deps.overlay.handleKey(event.key);

    // A focused component (LeaveConfirm's Escape, for example) runs first and
    // marks the event handled; never treat that same key as a second action.
    if (event.defaultPrevented) return;

    if (isBackKey(event.key, event.keyCode)) {
      // LeaveConfirm handles Escape itself while it is open.
      if (deps.modals.leaveConfirm.isOpen) return;
      if (deps.modals.resultsOverlay.isVisible) {
        event.preventDefault();
        deps.navigation.returnToLauncher();
        return;
      }
      if (deps.stage.isStageActive()) {
        event.preventDefault();
        deps.modals.openLeaveConfirm();
        return;
      }
      if (deps.stage.hasStartScreen()) {
        // Backing out before the game starts needs no confirmation.
        event.preventDefault();
        deps.navigation.returnToLauncher();
        return;
      }
    }

    // While a stage, overlay or start screen is up, Enter is not room creation.
    if (
      deps.stage.hasStartScreen() ||
      deps.stage.isStageActive() ||
      deps.modals.leaveConfirm.isOpen ||
      deps.modals.resultsOverlay.isVisible ||
      !shouldCreateRoomOnKey(event.key, deps.getPhase())
    ) {
      return;
    }
    event.preventDefault();
    void deps.createRoom();
  });

  deps.navigation.install();

  // D5/D7 results seam: the platform overlay is ready, but `GameContext` has
  // no frozen results method yet, so a game (or a test) reports through one
  // page event. The callback is the single mount path HP-05 needs.
  deps.window.addEventListener(RESULTS_EVENT, (event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (!isResultsData(detail)) return;
    deps.modals.showGameResults(detail);
  });

  attachVisibilityPause(deps.doc, {
    pause: () => {
      deps.pauseRecoveryForVisibility();
      deps.syncPause();
    },
    resume: () => {
      deps.resumeRecoveryForVisibility();
      deps.syncPause();
    },
  });
  // pagehide/pageshow cover tab/browser backgrounding where visibilitychange
  // may not fire; both paths send `hostPause` / `hostResume` (FR-9.2).
  deps.window.addEventListener("pagehide", () => {
    deps.pauseRecoveryForVisibility();
    deps.syncPause();
  });
  deps.window.addEventListener("pageshow", () => {
    deps.resumeRecoveryForVisibility();
    deps.syncPause();
  });
}
