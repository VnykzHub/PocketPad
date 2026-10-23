/**
 * Host-shell copy and event names.
 *
 * These strings are part of the page contract (HP-01..HP-08) and are shared by
 * the room, stage, results and notice paths. Keeping them in one module avoids
 * drift between the modules that render them.
 */

/** HP-06 banner copy: the game stays paused while the socket recovers. */
export const RECONNECT_BANNER_TEXT =
  "Reconnecting to the room… The game is paused.";

/** HP-07 actions; the design allows Reload and Create a new room. */
export const RELOAD_LABEL = "Reload";
export const CREATE_ROOM_LABEL = "Create a new room";
export const BACK_TO_GAMES_LABEL = "Back to games";

/** HP-07 headings kept from the existing host-shell paths. */
export const GAME_STOPPED_TITLE = "The game stopped";
export const GAME_NOT_FOUND_TITLE = "Game not found";
export const ROOM_ENDED_TITLE = "Room ended";

/** Temporary transport for HP-05 until a game-facing results API exists. */
export const RESULTS_EVENT = "lanpad:results";
