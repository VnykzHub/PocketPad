/**
 * Direct game route (D7-SDK-01).
 *
 * The dev server serves the same host page for `/` and `/games/<slug>/`, so
 * the host selects the game on the client. The root path keeps the D3 cube
 * demo; a game route must be exactly one lowercase slug segment.
 */

const GAME_ROUTE_PATTERN = /^\/games\/([a-z0-9][a-z0-9-]*)\/?$/;

/** Returns the slug for `/games/<slug>/` (trailing slash optional), or null. */
export function gameSlugFromPath(pathname: string): string | null {
  return GAME_ROUTE_PATTERN.exec(pathname)?.[1] ?? null;
}
