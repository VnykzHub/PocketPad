import { describe, expect, it } from "vitest";
import { mountE14Page } from "../page.js";
import type { E14Window } from "../page.js";

/**
 * Minimal fake DOM for the E14 page controller. The controller receives its
 * `Document` and `Window`, so mounting can be tested in Node without jsdom and
 * without a browser network stack.
 */
class FakeElement {
  value = "";
  textContent: string | null = "";
  disabled = false;
  className = "";
  scope = "";
  children: FakeElement[] = [];
  private listeners = new Map<string, Array<() => void>>();

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  addEventListener(type: string, listener: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: () => void): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((entry) => entry !== listener),
    );
  }

  setAttribute(): void {}
  select(): void {}

  fire(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }

  listenerCount(type: string): number {
    return (this.listeners.get(type) ?? []).length;
  }
}

class FakeDocument {
  body = new FakeElement();
  readonly elements = new Map<string, FakeElement>();

  constructor(ids: readonly string[]) {
    for (const id of ids) this.elements.set(id, new FakeElement());
  }

  getElementById(id: string): FakeElement | null {
    return this.elements.get(id) ?? null;
  }

  createElement(): FakeElement {
    return new FakeElement();
  }

  addEventListener(): void {}
  removeEventListener(): void {}
  execCommand(): boolean {
    return false;
  }
}

class FakeSocket {
  static instances: FakeSocket[] = [];
  readonly url: string;
  readyState = 0;
  private listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close(): void {
    this.readyState = 3;
  }
}

const ELEMENT_IDS = [
  "ws-url",
  "validation",
  "status",
  "results",
  "json",
  "copy",
  "test-lan-ws",
  "test-lan-fetch",
  "test-localhost-ws",
  "context-list",
  "context-note",
] as const;

interface HarnessOptions {
  protocol?: string;
  timeoutMs?: number;
}

function createHarness(options: HarnessOptions = {}) {
  FakeSocket.instances = [];
  const fetchCalls: string[] = [];
  const doc = new FakeDocument(ELEMENT_IDS);
  const protocol = options.protocol ?? "https:";
  const win = {
    location: {
      protocol,
      hostname: "tunnel.example",
      port: "",
      origin: `${protocol}//tunnel.example`,
      pathname: "/x/e14/",
    },
    isSecureContext: protocol === "https:",
    navigator: { userAgent: "vitest-agent", clipboard: undefined },
    performance: { now: () => Date.now() },
    setTimeout: (handler: () => void, ms: number) =>
      globalThis.setTimeout(handler, ms) as unknown as number,
    clearTimeout: (id: number) => globalThis.clearTimeout(id),
    WebSocket: FakeSocket,
    AbortController: globalThis.AbortController,
    fetch: async (url: string): Promise<never> => {
      fetchCalls.push(url);
      throw new Error("fetch is not expected in this test");
    },
  };

  const controller = mountE14Page(doc as unknown as Document, win as unknown as E14Window, {
    timeoutMs: options.timeoutMs ?? 5,
    performanceNow: () => Date.now(),
    now: () => new Date("2026-10-21T00:00:00.000Z"),
  });

  return { doc, win, controller, fetchCalls, elements: doc.elements };
}

function element(harness: ReturnType<typeof createHarness>, id: string): FakeElement {
  const found = harness.elements.get(id);
  if (found === undefined) throw new Error(`missing fake element #${id}`);
  return found;
}

describe("[E14][SR-7] E14 page never auto-runs", () => {
  it("[SR-7] mounting the page opens no socket and makes no fetch", () => {
    const harness = createHarness();

    expect(FakeSocket.instances).toHaveLength(0);
    expect(harness.fetchCalls).toHaveLength(0);
  });

  it("[E14] mounting renders the page context and wires only click listeners", () => {
    const harness = createHarness();

    expect(element(harness, "context-list").children).toHaveLength(8);
    expect(element(harness, "context-note").textContent).toContain("HTTPS");
    expect(element(harness, "status").textContent).toContain("Not run");
    expect(element(harness, "copy").disabled).toBe(true);

    expect(element(harness, "test-lan-ws").listenerCount("click")).toBe(1);
    expect(element(harness, "test-lan-fetch").listenerCount("click")).toBe(1);
    expect(element(harness, "test-localhost-ws").listenerCount("click")).toBe(1);
  });

  it("[E14] a page served over http:// says mixed content cannot be observed there", () => {
    const harness = createHarness({ protocol: "http:" });

    expect(element(harness, "context-note").textContent).toContain(
      "cannot demonstrate mixed-content blocking",
    );
    expect(element(harness, "context-note").textContent).toContain(
      "https://<tunnel-host>/x/e14/",
    );
  });

  it("[E14] an invalid URL is refused before any socket is opened", () => {
    const harness = createHarness();
    element(harness, "ws-url").value = "http://192.168.1.10:8080/";

    element(harness, "test-lan-ws").fire("click");

    expect(FakeSocket.instances).toHaveLength(0);
    expect(element(harness, "status").textContent).toContain("not attempted");
  });
});

describe("[E14] E14 attempt recording", () => {
  it("[E14] a valid LAN URL opens exactly one socket and records the timeout and elapsed time", async () => {
    const harness = createHarness({ timeoutMs: 5 });
    element(harness, "ws-url").value = "ws://192.168.1.10:8080/ws";

    const record = await harness.controller.runLanWebSocket();

    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakeSocket.instances[0]?.url).toBe("ws://192.168.1.10:8080/ws");
    expect(record?.outcome).toBe("timeout");
    expect(record?.errorName).toBe("TimeoutError");
    expect(record?.target).toBe("ws://192.168.1.10:8080/ws");
    expect(record?.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(record?.pageProtocol).toBe("https:");
    expect(record?.secureContext).toBe(true);

    const report = harness.controller.getReport();
    expect(report.experiment).toBe("E14");
    expect(report.schema).toBe(1);
    expect(report.pageUrl).toBe("https://tunnel.example/x/e14/");
    expect(report.attempts).toHaveLength(1);
    expect(element(harness, "json").textContent).toContain('"outcome": "timeout"');
    expect(harness.fetchCalls).toHaveLength(0);
  });

  it("[E14] the localhost control reuses the port typed in the LAN URL", async () => {
    const harness = createHarness({ timeoutMs: 5 });
    element(harness, "ws-url").value = "ws://192.168.1.10:8090/ws";

    const record = await harness.controller.runLocalhostControl();

    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakeSocket.instances[0]?.url).toBe("ws://localhost:8090/ws");
    expect(record?.outcome).toBe("timeout");
    expect(record?.label).toContain("localhost");
  });

  it("[E14] the LAN fetch leg derives the health URL and sends no request when input is invalid", async () => {
    const harness = createHarness();
    element(harness, "ws-url").value = "wss://192.168.1.10:8080/ws";

    const record = await harness.controller.runLanFetch();

    expect(record).toBeNull();
    expect(harness.fetchCalls).toHaveLength(0);
    expect(element(harness, "status").textContent).toContain("not attempted");
  });
});
