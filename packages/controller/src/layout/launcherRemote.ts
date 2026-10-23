/**
 * Console-home remote layout (D4/E stream).
 *
 * The console shell (launcher) is not a game, so it has no game folder to own
 * a layout. This module is the single source of truth for the phone remote
 * that navigation and game selection use: a d-pad, Select (confirm) and Back,
 * plus a status panel the host can fill with the highlighted title or room
 * state. Every control is an existing SDK type, so the standard controller
 * renderer draws it with no launcher-specific code.
 *
 * Bits are frozen for the launcher: Select = 0, Back = 1, d-pad = 8..11.
 * Menu semantics (what Select means on a screen) belong to the host; the
 * controller only reports the bits.
 */
import type { LayoutDocument } from "@lanpad/sdk";

/** Stable layout id; the launcher can hot-swap by this id. */
export const LAUNCHER_REMOTE_LAYOUT_ID = "launcher-remote-v1";

export const LAUNCHER_REMOTE_LAYOUT: LayoutDocument = {
  schemaVersion: 1,
  id: LAUNCHER_REMOTE_LAYOUT_ID,
  orientation: "any",
  background: "#000000",
  controls: [
    {
      type: "panel",
      id: "status",
      x: "50%",
      y: "10%",
      w: "88%",
      h: "12%",
      z: 10,
    },
    {
      type: "dpad",
      id: "nav",
      x: "24%",
      y: "66%",
      size: "34%",
      bits: { up: 8, down: 9, left: 10, right: 11 },
    },
    {
      type: "button",
      id: "back",
      label: "Back",
      shape: "circle",
      x: "78%",
      y: "40%",
      r: "9%",
      bit: 1,
      haptic: [18],
    },
    {
      type: "button",
      id: "select",
      label: "Select",
      shape: "circle",
      x: "78%",
      y: "72%",
      r: "12%",
      bit: 0,
      haptic: [18],
    },
  ],
};

/** Launcher inputs the host reads by name from its game loop. */
export const LAUNCHER_REMOTE_BITS = Object.freeze({
  select: 0,
  back: 1,
  up: 8,
  down: 9,
  left: 10,
  right: 11,
} as const);
