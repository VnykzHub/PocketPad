/**
 * Host status line copy (D4-HOST-02; FR-7.16, FR-9.2).
 *
 * One place for the four states the TV shows while the room socket comes and
 * goes. The "connected" text is the exact sentence the D4 RoomPanel test
 * asserts, so moving the copy here must not change it.
 */
export type HostStatusKind = "waiting" | "connected" | "reconnecting" | "lost";

const HOST_STATUS_TEXT: Readonly<Record<HostStatusKind, string>> = Object.freeze({
  waiting: "Waiting for a room…",
  connected: "Room ready: scan the QR or enter the code and PIN.",
  reconnecting: "Reconnecting to the room…",
  lost: "Room lost — starting a new room…",
});

/** Display text for one host status state. */
export function hostStatusText(kind: HostStatusKind): string {
  return HOST_STATUS_TEXT[kind];
}
