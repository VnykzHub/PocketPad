import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  classifyBlockReason,
  classifyHost,
  deriveControlWsUrl,
  validateLanWsUrl,
} from "../validate.js";

function readE14(file: string): string {
  return readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
}

describe("[E14] LAN WebSocket URL validation", () => {
  it("[E14] accepts a private LAN ws:// URL and derives the http health URL", () => {
    const result = validateLanWsUrl("ws://192.168.1.10:8080/ws");

    expect(result.ok).toBe(true);
    expect(result.wsUrl).toBe("ws://192.168.1.10:8080/ws");
    expect(result.healthUrl).toBe("http://192.168.1.10:8080/healthz");
    expect(result.host).toBe("192.168.1.10");
    expect(result.port).toBe("8080");
    expect(result.hostKind).toBe("private");
    expect(result.problem).toBeNull();
  });

  it("[E14] accepts every private range, loopback, mDNS and single-label LAN name", () => {
    const accepted = [
      "ws://10.1.2.3:8080/ws",
      "ws://172.16.0.1:8080/ws",
      "ws://172.31.255.254:8080/ws",
      "ws://192.168.0.1/ws",
      "ws://169.254.10.20:8080/ws",
      "ws://my-pc.local:8080/ws",
      "ws://my-pc:8080/ws",
      "ws://localhost:8080/ws",
      "ws://127.0.0.1:8080/ws",
      "ws://[::1]:8080/ws",
      "ws://[fd00::1]:8080/ws",
      "ws://[fe80::1]:8080/ws",
    ];

    for (const url of accepted) {
      const result = validateLanWsUrl(url);
      expect(result.ok, url).toBe(true);
    }

    expect(validateLanWsUrl("ws://localhost:8080/ws").hostKind).toBe("loopback");
    expect(validateLanWsUrl("ws://my-pc.local:8080/ws").hostKind).toBe("private");
    expect(validateLanWsUrl("ws://[::1]:8080/ws").host).toBe("::1");
    expect(validateLanWsUrl("ws://[fd00::1]:8080/ws").healthUrl).toBe(
      "http://[fd00::1]:8080/healthz",
    );
  });

  it("[E14] rejects public hosts because they do not test LAN reachability", () => {
    const rejected = [
      "ws://example.com:8080/ws",
      "ws://8.8.8.8:8080/ws",
      "ws://172.32.0.1:8080/ws",
      "ws://[2001:db8::1]:8080/ws",
    ];

    for (const url of rejected) {
      const result = validateLanWsUrl(url);
      expect(result.ok, url).toBe(false);
      expect(result.problem?.code, url).toBe("not-lan");
      expect(result.wsUrl).toBeNull();
      expect(result.healthUrl).toBeNull();
    }
  });

  it("[E14] rejects non-ws schemes with an actionable message", () => {
    const https = validateLanWsUrl("https://192.168.1.10:8080/ws");
    expect(https.ok).toBe(false);
    expect(https.problem?.code).toBe("not-ws");
    expect(https.problem?.message).toContain("ws://");

    const wss = validateLanWsUrl("wss://192.168.1.10:8080/ws");
    expect(wss.ok).toBe(false);
    expect(wss.problem?.code).toBe("not-ws");
    expect(wss.problem?.message).toMatch(/already secure/i);

    const ftp = validateLanWsUrl("ftp://192.168.1.10:8080/ws");
    expect(ftp.ok).toBe(false);
    expect(ftp.problem?.code).toBe("not-ws");
  });

  it("[E14] rejects empty, malformed and credential-bearing input", () => {
    const empty = validateLanWsUrl("   ");
    expect(empty.ok).toBe(false);
    expect(empty.problem?.code).toBe("empty");

    const malformed = validateLanWsUrl("not a url");
    expect(malformed.ok).toBe(false);
    expect(malformed.problem?.code).toBe("invalid-url");

    const credentials = validateLanWsUrl("ws://user:secret@192.168.1.10:8080/ws");
    expect(credentials.ok).toBe(false);
    expect(credentials.problem?.code).toBe("credentials");
    expect(credentials.problem?.message).toMatch(/credentials/i);
  });

  it("[E14] classifies hosts without any network or user-agent input", () => {
    expect(classifyHost("192.168.1.10")).toBe("private");
    expect(classifyHost("10.0.0.1")).toBe("private");
    expect(classifyHost("172.16.0.1")).toBe("private");
    expect(classifyHost("172.31.255.255")).toBe("private");
    expect(classifyHost("172.32.0.1")).toBe("public");
    expect(classifyHost("127.0.0.1")).toBe("loopback");
    expect(classifyHost("localhost")).toBe("loopback");
    expect(classifyHost("[::1]")).toBe("loopback");
    expect(classifyHost("[fd00::1]")).toBe("private");
    expect(classifyHost("[fe80::1]")).toBe("private");
    expect(classifyHost("my-pc.local")).toBe("private");
    expect(classifyHost("my-pc")).toBe("private");
    expect(classifyHost("example.com")).toBe("public");
    expect(classifyHost("")).toBe("invalid");
  });

  it("[E14] derives the localhost control port from the LAN URL, then the page, then 8080", () => {
    const lan = validateLanWsUrl("ws://192.168.1.10:8090/ws");
    expect(deriveControlWsUrl(lan, { hostname: "tunnel.example", port: "" })).toBe(
      "ws://localhost:8090/ws",
    );

    const invalid = validateLanWsUrl("http://192.168.1.10:8090/");
    expect(deriveControlWsUrl(invalid, { hostname: "localhost", port: "8091" })).toBe(
      "ws://localhost:8091/ws",
    );
    expect(deriveControlWsUrl(invalid, { hostname: "tunnel.example", port: "" })).toBe(
      "ws://localhost:8080/ws",
    );
  });

  it("[E14] classifies block reasons but keeps the exact error for the report", () => {
    expect(
      classifyBlockReason(
        "SecurityError",
        "Failed to construct 'WebSocket': An insecure WebSocket connection may not be initiated from a page loaded over HTTPS.",
        false,
      ),
    ).toBe("mixed-content");
    expect(classifyBlockReason("Error", "blocked", true)).toBe("csp");
    expect(classifyBlockReason("TypeError", "Private Network Access blocked", false)).toBe(
      "private-network",
    );
    expect(classifyBlockReason("TypeError", "Failed to fetch", false)).toBe("network");
    expect(classifyBlockReason("Event", "", false)).toBe("unknown");
  });
});

describe("[SR-7] E14 probe stays local and stores nothing", () => {
  const textFiles = [
    "index.html",
    "e14.css",
    "boot.js",
    "validate.ts",
    "validate.js",
    "page.ts",
    "page.js",
  ] as const;

  it("[SR-7] uses no storage, cookies, beacons or analytics", () => {
    const forbidden = [
      /localStorage/i,
      /sessionStorage/i,
      /\bdocument\.cookie\b/i,
      /\bindexedDB\b/i,
      /\bsendBeacon\b/,
      /\bXMLHttpRequest\b/,
      /\bgtag\s*\(/i,
      /google-analytics|googletagmanager|mixpanel|amplitude|segment\.(?:io|com)/i,
    ];

    for (const file of textFiles) {
      const text = readE14(file);
      for (const pattern of forbidden) {
        expect(text, `${file} matches ${String(pattern)}`).not.toMatch(pattern);
      }
    }
  });

  it("[SR-7] loads no external script, stylesheet or image", () => {
    const html = readE14("index.html");
    expect(html).not.toMatch(/(?:href|src)\s*=\s*["']https?:\/\//i);
    expect(readE14("e14.css")).not.toMatch(/url\(\s*["']?https?:\/\//i);
  });

  it("[SR-7] validation module is pure: no network, DOM, storage or timers", () => {
    for (const file of ["validate.ts", "validate.js"] as const) {
      const text = readE14(file);
      for (const pattern of [
        /\bnew\s+WebSocket\b/,
        /\bfetch\s*\(/,
        /\bdocument\./,
        /\bwindow\./,
        /\bperformance\./,
        /\bsetTimeout\s*\(/,
        /localStorage|sessionStorage/,
      ]) {
        expect(text, `${file} matches ${String(pattern)}`).not.toMatch(pattern);
      }
    }
  });

  it("[SR-7] rejects credentials so no PII can travel with the test", () => {
    const result = validateLanWsUrl("ws://user:secret@192.168.1.10:8080/ws");
    expect(result.ok).toBe(false);
    expect(result.problem?.code).toBe("credentials");
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});

describe("[E14] probe page contract", () => {
  const html = readE14("index.html");

  it("[E14] explains the test, the tunnel steps and the no-auto-run rule", () => {
    expect(html).toContain("<h1>E14");
    expect(html).toContain("mixed content");
    expect(html).toContain("cloudflared tunnel --url");
    expect(html).toContain("ngrok http 8080");
    expect(html).toContain("Nothing runs on page load");
    expect(html).toContain("never installs or starts a tunnel");
  });

  it("[E14] provides three attempt buttons, a results table and copyable JSON", () => {
    expect(html).toContain('id="test-lan-ws"');
    expect(html).toContain('id="test-lan-fetch"');
    expect(html).toContain('id="test-localhost-ws"');
    expect(html).toContain('id="results"');
    expect(html).toContain('id="json"');
    expect(html).toContain('id="copy"');
  });

  it("[E14] has no inline script and no automatic run handler", () => {
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    expect(html).not.toMatch(/\bonload\s*=/i);
    expect(html).toContain('src="./boot.js"');
  });
});
