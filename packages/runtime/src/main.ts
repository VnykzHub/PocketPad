/**
 * Host page entry.
 *
 * The page owns two routes (PAGE-PLANS §1):
 *
 *   `/`                  HP-03 launcher once a room exists (HP-02 hero stays
 *                         next to it); never silently loads the cube demo.
 *   `/games/<slug>/`     HP-04 stage: start screen, then the game canvas with
 *                         a 48px room/player bar. Back/Escape opens HP-04b.
 *
 * The page is a composition root: `src/host/bootstrap.ts` wires the room,
 * runtime, chrome and host-flow modules. This module only imports the shell
 * stylesheet, re-exports the pure route/copy helpers that other modules and
 * tests already import from here, and starts the live page when the real
 * `#app` shell is present.
 */
import { bootstrapHost } from "./host/bootstrap.js";
// Keep the stylesheet import last so the shell CSS keeps its original
// cascade position after the component stylesheets (for example overlay.css).
import "./style.css";

export { bootstrapHost };
export {
  RECONNECT_BANNER_TEXT,
  RELOAD_LABEL,
  CREATE_ROOM_LABEL,
  BACK_TO_GAMES_LABEL,
  GAME_STOPPED_TITLE,
  GAME_NOT_FOUND_TITLE,
  ROOM_ENDED_TITLE,
  RESULTS_EVENT,
} from "./host/copy.js";
export {
  gamePathFor,
  resolveHostRoute,
  playerCountLabel,
  slotRosterStateFor,
  isBackKey,
  isResultsData,
} from "./host/routes.js";
export type { HostRoute } from "./host/routes.js";

// Importing this module in tests must not touch the DOM; the real page always
// has `#app`. Mirrors the controller shell's bootstrap guard.
if (typeof document !== "undefined" && document.getElementById("app") !== null) {
  bootstrapHost();
}
