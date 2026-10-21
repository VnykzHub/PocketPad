/* Generated from validate.ts by experiments/e14/build.mjs. Do not edit directly. */
function stripIpv6Brackets(hostname) {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}
function isIpv4(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
function classifyHost(hostname) {
  const host = stripIpv6Brackets(hostname.trim().toLowerCase());
  if (host.length === 0) return "invalid";
  if (host === "localhost") return "loopback";
  if (host.includes(":")) {
    if (host === "::1" || host === "0:0:0:0:0:0:0:1") return "loopback";
    if (/^fe[89ab]/.test(host)) return "private";
    if (/^f[cd]/.test(host)) return "private";
    return "public";
  }
  if (isIpv4(host)) {
    const octets = host.split(".").map((part) => Number(part));
    const first = octets[0];
    const second = octets[1];
    if (first === void 0 || second === void 0) return "invalid";
    if (first === 127) return "loopback";
    if (first === 10) return "private";
    if (first === 172 && second >= 16 && second <= 31) return "private";
    if (first === 192 && second === 168) return "private";
    if (first === 169 && second === 254) return "private";
    return "public";
  }
  if (host.endsWith(".local")) return "private";
  if (!host.includes(".")) return "private";
  return "public";
}
function failure(code, message) {
  return {
    ok: false,
    wsUrl: null,
    healthUrl: null,
    host: null,
    port: null,
    hostKind: null,
    problem: { code, message }
  };
}
function validateLanWsUrl(input) {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return failure(
      "empty",
      "Enter the dev server's LAN WebSocket URL, for example ws://192.168.1.10:8080/ws."
    );
  }
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return failure(
      "invalid-url",
      `"${trimmed}" is not a valid URL. Include the scheme, host and port, for example ws://192.168.1.10:8080/ws.`
    );
  }
  if (url.protocol !== "ws:") {
    const message = url.protocol === "wss:" ? "wss:// is already secure and does not reproduce the mixed-content case. Use ws:// for this test." : url.protocol === "http:" || url.protocol === "https:" ? "That looks like the dev-server page URL. Change the scheme to ws:// and keep the host and port, for example ws://192.168.1.10:8080/ws." : `Use the ws:// scheme; got ${url.protocol.replace(":", "")}://.`;
    return failure("not-ws", message);
  }
  if (url.hostname.length === 0) {
    return failure("missing-host", "The URL has no host. Include the LAN IP or hostname.");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return failure(
      "credentials",
      "Remove the username and password from the URL. The probe never records or sends credentials."
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
      `The host ${host} is not a private or LAN address. Use the LAN IP or hostname printed by the dev server (10.x, 172.16-31.x, 192.168.x, 169.254.x, a .local name, or localhost for the control).`
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
    problem: null
  };
}
function deriveControlWsUrl(lan, page) {
  let port = lan.ok && lan.port !== null ? lan.port : "";
  if (port.length === 0 && classifyHost(page.hostname) === "loopback" && page.port.length > 0) {
    port = page.port;
  }
  if (port.length === 0) port = "8080";
  return `ws://localhost:${port}/ws`;
}
function classifyBlockReason(errorName, errorMessage, cspBlocked) {
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
export {
  classifyBlockReason,
  classifyHost,
  deriveControlWsUrl,
  stripIpv6Brackets,
  validateLanWsUrl
};
