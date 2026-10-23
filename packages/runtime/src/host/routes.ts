/**
 * Pure host-route and presentation helpers.
 *
 * `main.ts` re-exports these names so imports and tests keep their old entry
 * point. Nothing here touches the DOM, a socket or module-level state.
 */
import { gameSlugFromPath } from "../game/gameRoute.js";
import type { HostPlayerEvent } from "../net/hostClient.js";
import type { ResultsData } from "../ui/ResultsOverlay.js";
import type { SlotRosterState } from "../ui/SlotRoster.js";

/** A host route decision; `/` is the launcher, never a silent game load. */
export type HostRoute =
  | { readonly kind: "launcher" }
  | { readonly kind: "game"; readonly slug: string };

/** `/games/<slug>/` (trailing slash is the canonical form). */
export function gamePathFor(slug: string): string {
  return `/games/${slug}/`;
}

/** HP-03/HP-04 route selection for a pathname. */
export function resolveHostRoute(pathname: string): HostRoute {
  const slug = gameSlugFromPath(pathname);
  return slug === null ? { kind: "launcher" } : { kind: "game", slug };
}

/** Stage/launcher player count; never a negative or fractional number. */
export function playerCountLabel(count: number): string {
  const players = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  return `${players} ${players === 1 ? "player" : "players"}`;
}

/** HP-08 state mapping for a broker player event. */
export function slotRosterStateFor(event: HostPlayerEvent): SlotRosterState {
  switch (event) {
    case "joined":
    case "resumed":
      return "connected";
    case "suspended":
      return "reconnecting";
    case "left":
      return "open";
    default:
      return "open";
  }
}

/** Remote Back keys: Escape, browser Back, Tizen/LG/webOS back codes. */
export function isBackKey(key: string, keyCode = 0): boolean {
  return (
    key === "Escape" ||
    key === "Esc" ||
    key === "Backspace" ||
    key === "BrowserBack" ||
    key === "GoBack" ||
    keyCode === 27 ||
    keyCode === 461 ||
    keyCode === 10009
  );
}

/** Runtime guard for the HP-05 payload; the overlay never invents values. */
export function isResultsData(value: unknown): value is ResultsData {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record["title"] !== "string" || typeof record["rematch"] !== "boolean") {
    return false;
  }
  const rows = record["rows"];
  if (!Array.isArray(rows)) return false;
  return rows.every((row: unknown) => {
    if (typeof row !== "object" || row === null) return false;
    const entry = row as Record<string, unknown>;
    return (
      typeof entry["slot"] === "number" &&
      typeof entry["label"] === "string" &&
      typeof entry["value"] === "string"
    );
  });
}
