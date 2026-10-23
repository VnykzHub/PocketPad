/**
 * LAN discovery, origin allowlist and boot-banner tests (D0-SRV-01).
 */
import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, test } from "vitest";
import {
  LAN_ONLY_WARNING,
  TLS_DEV_WARNING,
  allowedOriginsFromUrls,
  formatBanner,
  formatQr,
  lanUrls,
  printBootInfo,
  resolveTlsConfig,
} from "../src/index.js";

function iface(
  address: string,
  family: "IPv4" | "IPv6",
  internal: boolean,
): NetworkInterfaceInfo {
  const base = {
    address,
    netmask: family === "IPv4" ? "255.255.255.0" : "ffff:ffff:ffff:ffff::",
    mac: "00:00:00:00:00:00",
    internal,
    cidr: family === "IPv4" ? `${address}/24` : `${address}/64`,
  };
  return family === "IPv4"
    ? { ...base, family: "IPv4" }
    : { ...base, family: "IPv6", scopeid: 1 };
}

function syntheticInterfaces(): NodeJS.Dict<NetworkInterfaceInfo[]> {
  return {
    loopback: [iface("127.0.0.1", "IPv4", true)],
    wifi: [iface("192.168.1.20", "IPv4", false)],
    ethernet: [iface("10.0.0.5", "IPv4", false)],
    duplicate: [iface("192.168.1.20", "IPv4", false)],
    wifi6: [iface("fe80::1", "IPv6", false)],
  };
}

describe("lanUrls", () => {
  test("[SR-11] only non-internal IPv4 addresses and localhost become URLs", () => {
    const urls = lanUrls(8080, syntheticInterfaces());
    expect(urls).toEqual([
      "http://192.168.1.20:8080",
      "http://10.0.0.5:8080",
      "http://localhost:8080",
    ]);

    const origins = allowedOriginsFromUrls(urls);
    expect(origins).toEqual([
      "http://192.168.1.20:8080",
      "http://10.0.0.5:8080",
      "http://localhost:8080",
    ]);
    for (const origin of origins) {
      expect(origin).not.toBe("*");
      expect(origin).toMatch(/^http:\/\/[^/]+:\d+$/);
    }
  });

  test("[FR-4.3] URLs use the supplied port, never a hard-coded host", () => {
    const urls = lanUrls(9123, { wifi: [iface("192.168.0.7", "IPv4", false)] });
    expect(urls).toEqual(["http://192.168.0.7:9123", "http://localhost:9123"]);
    expect(urls.join(" ")).not.toContain("8080");
  });
});

describe("boot banner and QR", () => {
  test("[SR-3] the boot banner prints every LAN URL and the LAN-only warning", () => {
    const urls = ["http://192.168.1.20:8080", "http://localhost:8080"];
    const banner = formatBanner(urls);

    expect(banner).toContain("lanpad dev server");
    expect(banner).toContain("TV / host:   http://192.168.1.20:8080/");
    expect(banner).toContain("Controller:  http://192.168.1.20:8080/c/<CODE>");
    expect(banner).toContain("All URLs:");
    expect(banner).toContain("  http://192.168.1.20:8080/");
    expect(banner).toContain("  http://localhost:8080/");
    expect(banner).toContain(LAN_ONLY_WARNING);
    expect(banner).toContain("WARNING: LAN only. This server has no TLS and no production hardening.");
    expect(banner).toContain("Do not expose it to a public network. (SR-3)");
  });

  test("[SR-3] the TLS banner replaces the no-TLS warning", () => {
    const banner = formatBanner(["https://192.168.1.20:8080"], { tls: true });
    expect(banner).toContain(TLS_DEV_WARNING);
    expect(banner).not.toContain(LAN_ONLY_WARNING);
    expect(banner).toContain("https://192.168.1.20:8080/");
  });

  test("[SR-3] TLS needs both certificate and key paths", () => {
    expect(resolveTlsConfig({})).toBeUndefined();
    expect(() =>
      resolveTlsConfig({ LANPAD_TLS_CERT: "cert.pem" }),
    ).toThrowError(/LANPAD_TLS_KEY/);
    expect(() =>
      resolveTlsConfig({ LANPAD_TLS_KEY: "key.pem" }),
    ).toThrowError(/LANPAD_TLS_CERT/);
    expect(
      resolveTlsConfig({
        LANPAD_TLS_CERT: "cert.pem",
        LANPAD_TLS_KEY: "key.pem",
      }),
    ).toEqual({ certPath: "cert.pem", keyPath: "key.pem" });
  });

  test("[SR-3] a room code can be shown in the controller URL", () => {
    const banner = formatBanner(["http://192.168.1.20:8080"], { roomCode: "ABCD" });
    expect(banner).toContain("Controller:  http://192.168.1.20:8080/c/ABCD");
    expect(banner).not.toContain("<CODE>");
  });

  test("[SR-3] boot output renders a terminal QR below the warning", async () => {
    const chunks: string[] = [];
    await printBootInfo(["http://127.0.0.1:8080", "http://localhost:8080"], {
      output: {
        write(chunk: string) {
          chunks.push(chunk);
          return true;
        },
      },
      roomCode: "ABCD",
    });
    const output = chunks.join("");

    const warningIndex = output.indexOf("WARNING: LAN only.");
    const qrIndex = output.search(/[▀▄█]/);
    expect(warningIndex).toBeGreaterThan(-1);
    expect(qrIndex).toBeGreaterThan(warningIndex);
  });

  test("[SR-3] formatQr returns a non-empty terminal QR", async () => {
    const qr = await formatQr("http://localhost:8080/");
    expect(qr.length).toBeGreaterThan(100);
    expect(qr).toMatch(/[▀▄█]/);
  });
});
