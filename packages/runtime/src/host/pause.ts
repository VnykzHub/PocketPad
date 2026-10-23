/**
 * Single place that decides whether the game simulates (FR-9.2).
 *
 * Three independent sources pause the game: the tab being hidden, a lost host
 * socket, and a modal (leave confirmation or results) covering the canvas.
 * Every caller funnels through the callback this module returns, so those
 * sources cannot disagree.
 */

export interface PauseSyncDeps {
  readonly doc: Document;
  /** True while the host socket is recovering or gone. */
  readonly isNetworkLost: () => boolean;
  /** HP-04b/HP-05 are modal: the game beneath them stays paused. */
  readonly isModalOpen: () => boolean;
  readonly pauseGame: () => void;
  readonly resumeGame: () => void;
}

/** Returns the host's `syncPause` callback. */
export function createPauseSync(deps: PauseSyncDeps): () => void {
  return () => {
    if (deps.doc.hidden || deps.isNetworkLost() || deps.isModalOpen()) {
      deps.pauseGame();
    } else {
      deps.resumeGame();
    }
  };
}
