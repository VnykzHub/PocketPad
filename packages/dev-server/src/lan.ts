/**
 * LAN discovery for the dev server (D0-SRV-01).
 *
 * URLs are derived from the interfaces and port passed in, never from a
 * hard-coded host (FR-4.3/SR-11). The first URL the server prints is the one
 * a phone on the same network can actually reach.
 */
import type { NetworkInterfaceInfo } from "node:os";

/**
 * Returns `http://<lan-ip>:<port>` for every non-internal IPv4 interface,
 * followed by `http://localhost:<port>`. Duplicates are removed.
 */
export function lanUrls(port: number, interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string[] {
  const urls: string[] = [];
  for (const infos of Object.values(interfaces)) {
    if (!infos) {
      continue;
    }
    for (const info of infos) {
      if (info.family === "IPv4" && !info.internal) {
        urls.push(`http://${info.address}:${port}`);
      }
    }
  }
  urls.push(`http://localhost:${port}`);
  return [...new Set(urls)];
}

/** Origin allowlist for the WebSocket upgrade (SR-11). Never `*`. */
export function allowedOriginsFromUrls(urls: readonly string[]): string[] {
  return [...new Set(urls.map((url) => new URL(url).origin))];
}
