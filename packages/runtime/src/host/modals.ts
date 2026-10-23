/**
 * HP-04b leave confirmation and HP-05 results overlay.
 *
 * Both are modal: opening either pauses the game beneath it, and closing it
 * runs `syncPause` so the tab/socket state decides whether play resumes. They
 * mount on the body (inside the components), so leaving a game cannot remove
 * them with the stage tree.
 */
import { LeaveConfirm } from "../ui/LeaveConfirm.js";
import { ResultsOverlay, type ResultsData } from "../ui/ResultsOverlay.js";
import type { OpenGameOptions } from "./stage.js";

export interface ModalsDeps {
  readonly doc: Document;
  readonly isStageActive: () => boolean;
  readonly getCurrentSlug: () => string | null;
  readonly pauseGame: () => void;
  readonly syncPause: () => void;
  readonly openGame: (slug: string, options?: OpenGameOptions) => Promise<void>;
  readonly returnToLauncher: () => void;
}

export interface HostModals {
  readonly leaveConfirm: LeaveConfirm;
  readonly resultsOverlay: ResultsOverlay;
  /** True while either modal owns the screen (used by the pause decision). */
  isOpen(): boolean;
  openLeaveConfirm(): void;
  showGameResults(data: ResultsData): void;
  closeAll(): void;
}

export function createModals(deps: ModalsDeps): HostModals {
  const resultsOverlay = new ResultsOverlay(deps.doc);
  const leaveConfirm = new LeaveConfirm(deps.doc);

  function isOpen(): boolean {
    return leaveConfirm.isOpen || resultsOverlay.isVisible;
  }

  function openLeaveConfirm(): void {
    if (!deps.isStageActive() || leaveConfirm.isOpen) return;
    deps.pauseGame();
    leaveConfirm.open(
      () => {
        // Keep playing: syncPause only resumes when the tab/socket allow it.
        deps.syncPause();
      },
      () => {
        deps.returnToLauncher();
      },
    );
  }

  /** HP-05 callback. No GameContext method exists yet, so the event seam feeds it. */
  function showGameResults(data: ResultsData): void {
    if (!deps.isStageActive()) return;
    deps.pauseGame();
    resultsOverlay.show(data, {
      onRematch: () => {
        const slug = deps.getCurrentSlug();
        if (slug !== null) void deps.openGame(slug, { autoStart: true });
      },
      onBack: () => {
        deps.returnToLauncher();
      },
    });
  }

  function closeAll(): void {
    leaveConfirm.close();
    resultsOverlay.hide();
  }

  return {
    leaveConfirm,
    resultsOverlay,
    isOpen,
    openLeaveConfirm,
    showGameResults,
    closeAll,
  };
}
