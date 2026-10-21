/**
 * Pure URL helpers for the E14 mixed-content probe (D1-EXP-05).
 *
 * No DOM, network, storage or timer access lives here, so these functions are
 * safe to import in a TV browser and in a Node test. The page uses them to
 * decide whether a typed URL is a meaningful LAN target and to derive the
 * matching health-check URL; the tests use them to pin that behaviour.
 *
 * The probe only accepts `ws://` URLs on private/LAN or loopback hosts:
 * - `wss://` is already secure and cannot reproduce the mixed-content case.
 * - A public host does not exercise private-network reachability.
 * - Credentials in the URL are rejected so no PII can travel with the test.
 */

export type HostKind = "loopback" | "private" | "public" | "invalid";

export type UrlProblemCode =
  | "empty"
  | "invalid-url"
  | "not-ws"
  | "missing-host"
  | "credentials"
  | "not-lan";

export interface UrlProblem {
  code: UrlProblemCode;
  message: string;
}

export interface LanUrlResult {
  ok: boolean;
  /** Normalized websocket URL; null when validation failed. */
  wsUrl: string | null;
  /** Same host and port over http:// with the dev-server health path. */
  healthUrl: string | null;
  /** Lowercase hostname without IPv6 brackets; null when parsing failed. */
  host: string | null;
  /** Explicit port as parsed; an empty string means the scheme default. */
  port: string | null;
  hostKind: HostKind | null;
  problem: UrlProblem | null;
}

export type BlockReason = "csp" | "mixed-content" | "private-network" | "network" | "unknown";

/** Strips the brackets that `URL.hostname` keeps around IPv6 literals. */
export function stripIpv6Brackets(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

function isIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/**
 * Classifies a hostname without touching the network or the user agent.
 * Loopback is separate from private LAN so the page can explain the control.
 */
export function classifyHost(hostname: string): HostKind {
  const host = stripIpv6Brackets(hostname.trim().toLowerCase());
  if (host.length === 0) return "invalid";
  if (host === "localhost") return "loopback";

  if (host.includes(":")) {
    if (host === "::1" || host === "0:0:0:0:0:0:0:1") return "loopback";
    // fe80::/10 link-local and fc00::/7 unique-local addresses.
    if (/^fe[89ab]/.test(host)) return "private";
    if (/^f[cd]/.test(host)) return "private";
    return "public";
  }

  if (isIpv4(host)) {
    const octets = host.split(".").map((part) => Number(part));
    const first = octets[0];
    const second = octets[1];
    if (first === undefined || second === undefined) return "invalid";
    if (first === 127) return "loopback";
    if (first === 10) return "private";
    if (first === 172 && second >= 16 && second <= 31) return "private";
    if (first === 192 && second === 168) return "private";
    if (first === 169 && second === 254) return "private";
    return "public";
  }

  // mDNS names and single-label hostnames are LAN names; anything with a
  // public-looking dotted name is treated as public.
  if (host.endsWith(".local")) return "private";
  if (!host.includes(".")) return "private";
  return "public";
}

function failure(code: UrlProblemCode, message: string): LanUrlResult {
  return {
    ok: false,
    wsUrl: null,
    healthUrl: null,
    host: null,
    port: null,
    hostKind: null,
    problem: { code, message },
  };
}

/**
 * Validates the operator's LAN WebSocket URL. A valid result carries the
 * normalized `ws://` URL and the `http://<host>:<port>/healthz` URL used by
 * the fetch leg of the probe.
 */
export function validateLanWsUrl(input: string): LanUrlResult {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return failure(
      "empty",
      "Enter the dev server's LAN WebSocket URL, for example ws://192.168.1.10:8080/ws.",
    );
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return failure(
      "invalid-url",
      `"${trimmed}" is not a valid URL. Include the scheme, host and port, for example ws://192.168.1.10:8080/ws.`,
    );
  }

  if (url.protocol !== "ws:") {
    const message =
      url.protocol === "wss:"
        ? "wss:// is already secure and does not reproduce the mixed-content case. Use ws:// for this test."
        : url.protocol === "http:" || url.protocol === "https:"
          ? "That looks like the dev-server page URL. Change the scheme to ws:// and keep the host and port, for example ws://192.168.1.10:8080/ws."
          : `Use the ws:// scheme; got ${url.protocol.replace(":", "")}://.`;
    return failure("not-ws", message);
  }

  if (url.hostname.length === 0) {
    return failure("missing-host", "The URL has no host. Include the LAN IP or hostname.");
  }

  if (url.username.length > 0 || url.password.length > 0) {
    return failure(
      "credentials",
      "Remove the username and password from the URL. The probe never records or sends credentials.",
    );
  }

  const host = stripIpv6Brackets(url.hostname.toLowerCase());
  const hostKind = classifyHost(host);
  if (hostKind === "invalid") {
    return failure("invalid-url", `"${host}" is not a usable hostname.`);
  }
  if (hostKind === "public") {
    return failure(
      "not-lan",
      `The host ${host} is not a private or LAN address. Use the LAN IP or hostname printed by the dev server (10.x, 172.16-31.x, 192.168.x, 169.254.x, a .local name, or localhost for the control).`,
    );
  }

  const health = new URL(url.href);
  health.protocol = "http:";
  health.pathname = "/healthz";
  health.search = "";
  health.hash = "";

  return {
    ok: true,
    wsUrl: url.href,
    healthUrl: health.href,
    host,
    port: url.port,
    hostKind,
    problem: null,
  };
}

export interface PageLocationLike {
  hostname: string;
  port: string;
}

/**
 * Builds the `ws://localhost` control target. The port comes from the typed
 * LAN URL when present (the dev server serves both), then from the page's own
 * origin when that origin is loopback, then from the documented default 8080.
 */
export function deriveControlWsUrl(lan: LanUrlResult, page: PageLocationLike): string {
  let port = lan.ok && lan.port !== null ? lan.port : "";
  if (port.length === 0 && classifyHost(page.hostname) === "loopback" && page.port.length > 0) {
    port = page.port;
  }
  if (port.length === 0) port = "8080";
  return `ws://localhost:${port}/ws`;
}

/**
 * Assigns a best-effort cause to a browser failure. The browser often hides
 * the real reason behind a generic error, so "unknown" is a legitimate answer
 * and the exact error name/message is always recorded separately.
 */
export function classifyBlockReason(
  errorName: string,
  errorMessage: string,
  cspBlocked: boolean,
): BlockReason {
  if (cspBlocked) return "csp";

  const text = `${errorName} ${errorMessage}`.toLowerCase();
  if (/insecure|mixed content|may not be initiated/.test(text)) return "mixed-content";
  if (/private network|local network access|private-network|permission/.test(text)) {
    return "private-network";
  }
  if (/refused|unreachable|failed to fetch|networkerror|network error|connection reset/.test(text)) {
    return "network";
  }
  return "unknown";
}
