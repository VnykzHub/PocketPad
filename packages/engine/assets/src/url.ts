/**
 * Asset URL rules and resolution (06 §4.3).
 *
 * Resolution is pure: an invalid or escaping URL is rejected before a fetch
 * exists. Raw rules run first, then the resolved URL is re-checked so URL
 * normalization cannot smuggle an escape past the base directory.
 */

import { assetError } from "./errors.js";

export const MAX_ASSET_URL_CHARS = 512;

interface RuntimeLocation {
  readonly origin: string;
  readonly protocol: string;
}

function readLocation(): RuntimeLocation | undefined {
  const candidate = (globalThis as { location?: unknown }).location;
  if (candidate === null || typeof candidate !== "object") return undefined;
  const origin = (candidate as { origin?: unknown }).origin;
  const protocol = (candidate as { protocol?: unknown }).protocol;
  if (
    typeof origin !== "string" ||
    typeof protocol !== "string" ||
    origin.length === 0 ||
    origin === "null"
  ) {
    return undefined;
  }
  return { origin, protocol };
}

/** Browser origin, or a stable local origin for Node tests and tooling. */
export function runtimeOrigin(): string {
  return readLocation()?.origin ?? "http://localhost";
}

const SCHEME_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const CONTROL_CHAR = /[\u0000-\u001F\u007F]/;
const ENCODED_DOT = /%2e/i;
const ENCODED_PATH_SEPARATOR = /%(?:2f|5c|00)/i;

/**
 * Returns a reason when `raw` violates the 06 §4.3 raw-string rules, or null
 * when it is a legal relative asset URL. No resolution or fetch happens here.
 */
export function validateRelativeUrl(raw: string): string | null {
  if (raw.length === 0) return "url is empty";
  if (raw.length > MAX_ASSET_URL_CHARS) {
    return `url exceeds ${MAX_ASSET_URL_CHARS} characters`;
  }
  if (raw.includes("\\")) return "url contains a backslash";
  if (raw.includes("?")) return "url contains a query string";
  if (raw.includes("#")) return "url contains a fragment";
  if (raw.includes("//")) return "url contains a double slash";
  if (ENCODED_DOT.test(raw)) return "url contains a percent-encoded dot";
  if (ENCODED_PATH_SEPARATOR.test(raw)) {
    return "url contains a percent-encoded path separator or control byte";
  }
  if (raw.startsWith("/")) return "url is absolute, not relative";
  if (SCHEME_PREFIX.test(raw)) return "url contains a scheme or host";

  const segments = raw.split("/");
  for (const segment of segments) {
    if (segment.length === 0) return "url contains an empty segment";
    if (segment === "." || segment === "..") {
      return "url contains a dot segment";
    }
    if (CONTROL_CHAR.test(segment)) return "url contains a control character";
  }
  return null;
}

/**
 * Resolves `raw` against `baseUrl` and enforces same-origin and base-directory
 * containment. Throws `E_ASSET_FORMAT` on any violation.
 */
export function resolveAssetUrl(raw: string, baseUrl: string): string {
  const reason = validateRelativeUrl(raw);
  if (reason !== null) {
    throw assetError("E_ASSET_FORMAT", `invalid asset url (${reason})`);
  }

  const base = new URL(baseUrl, runtimeOrigin());
  if (base.username !== "" || base.password !== "") {
    throw assetError("E_ASSET_FORMAT", "base url contains credentials");
  }
  const location = readLocation();
  if (location !== undefined) {
    if (base.origin !== location.origin) {
      throw assetError("E_ASSET_FORMAT", "base url is cross-origin");
    }
    if (base.protocol !== location.protocol) {
      throw assetError("E_ASSET_FORMAT", "base url protocol differs from host");
    }
  }

  const resolved = new URL(raw, base);
  if (resolved.username !== "" || resolved.password !== "") {
    throw assetError("E_ASSET_FORMAT", "asset url contains credentials");
  }
  if (resolved.origin !== base.origin) {
    throw assetError("E_ASSET_FORMAT", "asset url is cross-origin");
  }
  if (resolved.protocol !== base.protocol) {
    throw assetError("E_ASSET_FORMAT", "asset url protocol differs from base");
  }

  const basePath = directoryPath(base.pathname);
  if (!resolved.pathname.startsWith(basePath)) {
    throw assetError("E_ASSET_FORMAT", "asset url escapes the manifest base");
  }

  const recheck = validateResolvedPathname(resolved.pathname);
  if (recheck !== null) {
    throw assetError(
      "E_ASSET_FORMAT",
      `resolved asset url is invalid (${recheck})`,
    );
  }
  return resolved.href;
}

function directoryPath(pathname: string): string {
  if (pathname.endsWith("/")) return pathname;
  const slash = pathname.lastIndexOf("/");
  return slash < 0 ? "/" : pathname.slice(0, slash + 1);
}

function validateResolvedPathname(pathname: string): string | null {
  if (pathname.includes("\\")) return "backslash";
  if (ENCODED_DOT.test(pathname)) return "percent-encoded dot";
  if (ENCODED_PATH_SEPARATOR.test(pathname)) return "encoded separator";

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return "malformed percent encoding";
  }
  const segments = decoded.split("/");
  for (const segment of segments) {
    if (segment === "." || segment === "..") return "dot segment";
    if (CONTROL_CHAR.test(segment)) return "control character";
  }
  return null;
}

/**
 * Default base for a manifest: its directory. `manifestUrl` may be absolute
 * or relative; the result is absolute against the runtime origin.
 */
export function manifestBaseUrl(manifestUrl: string): string {
  const resolved = new URL(manifestUrl, runtimeOrigin());
  const slash = resolved.pathname.lastIndexOf("/");
  resolved.pathname = slash < 0 ? "/" : resolved.pathname.slice(0, slash + 1);
  resolved.search = "";
  resolved.hash = "";
  return resolved.href;
}

/** Absolute manifest URL, query-free and same-origin when a host exists. */
export function resolveManifestUrl(manifestUrl: string): string {
  if (manifestUrl.length === 0) {
    throw assetError("E_ASSET_FORMAT", "manifest url is empty");
  }
  if (manifestUrl.includes("?") || manifestUrl.includes("#")) {
    throw assetError(
      "E_ASSET_FORMAT",
      "manifest url must be query-free and fragment-free",
    );
  }
  const resolved = new URL(manifestUrl, runtimeOrigin());
  if (resolved.username !== "" || resolved.password !== "") {
    throw assetError("E_ASSET_FORMAT", "manifest url contains credentials");
  }
  const location = readLocation();
  if (location !== undefined) {
    if (resolved.origin !== location.origin) {
      throw assetError("E_ASSET_FORMAT", "manifest url is cross-origin");
    }
    if (resolved.protocol !== location.protocol) {
      throw assetError(
        "E_ASSET_FORMAT",
        "manifest url protocol differs from the host",
      );
    }
  }
  return resolved.href;
}

/** Normalizes a configured base URL to a trailing-slash directory URL. */
export function normalizeBaseUrl(baseUrl: string): string {
  if (baseUrl.includes("?") || baseUrl.includes("#")) {
    throw assetError("E_ASSET_FORMAT", "base url must be query-free");
  }
  const resolved = new URL(baseUrl, runtimeOrigin());
  if (resolved.username !== "" || resolved.password !== "") {
    throw assetError("E_ASSET_FORMAT", "base url contains credentials");
  }
  resolved.pathname = directoryPath(resolved.pathname);
  resolved.search = "";
  resolved.hash = "";
  return resolved.href;
}
