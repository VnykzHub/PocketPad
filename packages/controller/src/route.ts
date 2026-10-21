/**
 * Controller URL routing (D0-CTRL-01, FR-5.6 groundwork).
 *
 * The controller page is served at `/c/<CODE>`. A room token may arrive in the
 * URL fragment (`/c/<CODE>#<roomToken>`, D4); D0 only parses it so the fragment
 * can be cleared before the first network request (FR-5.1). Everything here is
 * pure so it can be tested without a DOM.
 */
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from "@lanpad/protocol";

/** Parsed controller route. `token` is null when the fragment is empty. */
export interface ControllerRoute {
  /** Normalized 4-character room code, or null when the path is not `/c/<code>`. */
  code: string | null;
  /** Room token read from the URL fragment; never sent in D0 (D4 owns token join). */
  token: string | null;
}

/** Minimal `History` surface needed to strip the fragment. */
export interface ReplaceStateHistory {
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

const CONTROLLER_PATH = /^\/c\/([^/]+)\/?$/;

/**
 * Normalizes a user-entered or URL-derived room code: trimmed, upper-cased and
 * restricted to the Crockford base32 alphabet rooms are generated from.
 */
export function normalizeRoomCode(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const code = value.trim().toUpperCase();
  if (code.length !== ROOM_CODE_LENGTH) {
    return null;
  }
  for (const character of code) {
    if (!ROOM_CODE_ALPHABET.includes(character)) {
      return null;
    }
  }
  return code;
}

/**
 * Parses `/c/<CODE>` (with an optional trailing slash).
 *
 * Returns `{ code: null }` for any other path or an invalid code so the page
 * can fall back to the manual code + PIN form (FR-5.6). The path carries no
 * fragment, so `token` is always null here; use `parseControllerRoute` when the
 * fragment is available.
 */
export function parseControllerPath(pathname: string): ControllerRoute {
  const match = CONTROLLER_PATH.exec(pathname);
  const rawCode = match?.[1];
  const code = rawCode === undefined ? null : normalizeRoomCode(rawCode);
  return { code, token: null };
}

/**
 * Reads the room token from `location.hash`. The QR URL uses the raw token
 * (`#<roomToken>`), but percent-encoded fragments are decoded for robustness.
 * Returns null for an empty, malformed or undecodable fragment.
 */
export function parseFragmentToken(hash: string | null | undefined): string | null {
  if (typeof hash !== "string") {
    return null;
  }
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw.length === 0) {
    return null;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return decoded.length > 0 ? decoded : null;
}

/** Combines path and fragment parsing for the page bootstrap. */
export function parseControllerRoute(pathname: string, hash: string): ControllerRoute {
  return { ...parseControllerPath(pathname), token: parseFragmentToken(hash) };
}

/**
 * Removes the URL fragment before the first network call (FR-5.1). The room
 * token must never reach a request URL, a referrer or a log line.
 */
export function clearUrlFragment(
  history: ReplaceStateHistory,
  pathname: string,
  search: string,
): void {
  history.replaceState(null, "", `${pathname}${search}`);
}
