import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveServerOrigin, toWebSocketUrl } from "../src/index";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function clearOriginSources(): void {
  vi.stubEnv("VITE_SERVER_ORIGIN", "");
  vi.stubGlobal("location", undefined);
}

describe("resolveServerOrigin (D0-SDK-01)", () => {
  test("[FR-4.3] strips trailing slashes from an explicit origin", () => {
    expect(resolveServerOrigin("https://x/")).toBe("https://x");
    expect(resolveServerOrigin("http://localhost:8080//")).toBe("http://localhost:8080");
    expect(resolveServerOrigin("https://x/base/")).toBe("https://x/base");
  });

  test("[FR-4.3] rejects non-http(s) origins", () => {
    for (const origin of ["ftp://x", "ws://x", "file:///tmp/app", "javascript:alert(1)"]) {
      expect(() => resolveServerOrigin(origin)).toThrow(/Unsupported server origin/);
    }
  });

  test("[FR-4.3] rejects values that are not absolute URLs", () => {
    expect(() => resolveServerOrigin("not a url")).toThrow(/Invalid server origin/);
  });

  test("[FR-4.3] rejects an empty explicit origin instead of guessing", () => {
    expect(() => resolveServerOrigin("")).toThrow(/Cannot resolve the server origin/);
  });

  test("[FR-4.3] falls back to globalThis.location in a browser", () => {
    vi.stubEnv("VITE_SERVER_ORIGIN", "");
    vi.stubGlobal("location", { origin: "https://lanpad.test/" });
    expect(resolveServerOrigin()).toBe("https://lanpad.test");
  });

  test("[FR-4.3] uses VITE_SERVER_ORIGIN when no explicit origin is supplied", () => {
    vi.stubEnv("VITE_SERVER_ORIGIN", "https://env.example:8443/");
    vi.stubGlobal("location", { origin: "https://location.example" });
    expect(resolveServerOrigin()).toBe("https://env.example:8443");
  });

  test("[FR-4.3] an explicit origin wins over build-time and location config", () => {
    vi.stubEnv("VITE_SERVER_ORIGIN", "https://env.example");
    vi.stubGlobal("location", { origin: "https://location.example" });
    expect(resolveServerOrigin("http://explicit.example:9000/")).toBe(
      "http://explicit.example:9000",
    );
  });

  test("[FR-4.3] throws a clear error when no origin source exists", () => {
    clearOriginSources();
    expect(() => resolveServerOrigin()).toThrow(/Cannot resolve the server origin/);
  });

  test("[FR-4.3] SDK config source contains no hard-coded origin", () => {
    const source = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/(?:wss?|https?):\/\//);
  });
});

describe("toWebSocketUrl (D0-SDK-01)", () => {
  test("[FR-4.6] derives wss from https and ws from http", () => {
    expect(toWebSocketUrl("https://relay.example")).toBe("wss://relay.example/ws");
    expect(toWebSocketUrl("http://localhost:8080/")).toBe("ws://localhost:8080/ws");
  });

  test("[FR-4.6] keeps the port and normalizes the default path", () => {
    expect(toWebSocketUrl("http://192.168.1.20:8080///")).toBe("ws://192.168.1.20:8080/ws");
  });

  test("[FR-4.6] accepts a custom path with or without a leading slash", () => {
    expect(toWebSocketUrl("https://relay.example", "/socket")).toBe(
      "wss://relay.example/socket",
    );
    expect(toWebSocketUrl("https://relay.example", "socket")).toBe(
      "wss://relay.example/socket",
    );
    expect(toWebSocketUrl("https://relay.example", "")).toBe("wss://relay.example/ws");
  });

  test("[FR-4.6] preserves an origin path prefix", () => {
    expect(toWebSocketUrl("https://relay.example/base/", "/ws")).toBe(
      "wss://relay.example/base/ws",
    );
  });

  test("[FR-4.6] rejects non-http(s) origins", () => {
    expect(() => toWebSocketUrl("ws://relay.example")).toThrow(/Unsupported server origin/);
    expect(() => toWebSocketUrl("ftp://relay.example")).toThrow(/Unsupported server origin/);
  });

  test("[FR-4.6] rejects an origin that is not an absolute URL", () => {
    expect(() => toWebSocketUrl("relay.example")).toThrow(/Invalid server origin/);
  });
});
