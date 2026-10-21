/**
 * E1 targeted verification (D1-EXP-02).
 *
 * Boots the real dev server on 127.0.0.1:0 and proves two things from Node:
 * 1. `/x/e01/`, its generated page module and the shared probe module are
 *    served with HTTP 200.
 * 2. The binary WebSocket path used by the probe (`POST /api/rooms`, hostJoin,
 *    join, 26-byte Input, 27-byte InputFwd echo) works end to end with a real
 *    `ws` client.
 *
 * This is a Node measurement, not a browser measurement. The TV numbers still
 * have to be produced by pressing Run in the TV browser.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  createDevServer,
  type DevServer,
  type StaticRoots,
} from "../../../packages/dev-server/src/index.js";
import {
  createProbeRoom,
  measureBinaryWebSocket,
  type WebSocketConstructor,
} from "../probe.js";

const silentLogger = { info(): void {} };
const experimentsRoot = fileURLToPath(new URL("../../", import.meta.url));

let app: DevServer | null = null;
let tempRoot = "";

afterEach(async () => {
  if (app !== null) {
    await app.close();
    app = null;
  }
  if (tempRoot !== "") {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = "";
  }
});

function makeStaticRoots(): StaticRoots {
  tempRoot = mkdtempSync(join(tmpdir(), "lanpad-e1-"));
  for (const name of ["host", "controller", "games"]) {
    const directory = join(tempRoot, name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "index.html"), `<!doctype html><title>${name}</title>`);
  }
  return {
    host: join(tempRoot, "host"),
    controller: join(tempRoot, "controller"),
    games: join(tempRoot, "games"),
    experiments: experimentsRoot,
  };
}

describe("[E1] dev-server route and binary echo", () => {
  it(
    "[E1] binary websocket round-trip is measured through the served E1 page's /ws room flow",
    async () => {
      app = createDevServer(
        { host: "127.0.0.1", port: 0, staticRoots: makeStaticRoots(), allowedOrigins: [] },
        { logger: silentLogger },
      );
      const { port } = await app.listen();
      const base = `http://127.0.0.1:${port}`;

      const page = await fetch(`${base}/x/e01/`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("E1 - TV browser capabilities");
      expect(html).toContain('src="./page.js"');
      expect(html).toContain('id="run"');
      expect(html).toContain('id="copy"');
      expect(html).toContain('id="results"');
      expect(html).toContain('id="json"');

      const pageModule = await fetch(`${base}/x/e01/page.js`);
      expect(pageModule.status).toBe(200);
      expect(await pageModule.text()).toContain("measureBinaryWebSocket");

      const probeModule = await fetch(`${base}/x/e01/probe.js`);
      expect(probeModule.status).toBe(200);
      expect(await probeModule.text()).toContain("measureBinaryWebSocket");

      const sharedProbe = await fetch(`${base}/x/shared/probe.js`);
      expect(sharedProbe.status).toBe(200);

      const sharedReport = await fetch(`${base}/x/shared/report.js`);
      expect(sharedReport.status).toBe(200);

      const measurement = await measureBinaryWebSocket({
        createRoom: () =>
          createProbeRoom((input, init) => fetch(new URL(input, base).href, init)),
        WebSocketCtor: WebSocket as unknown as WebSocketConstructor,
        url: `ws://127.0.0.1:${port}/ws`,
        now: () => performance.now(),
      });

      expect(measurement.path).toBe("existing /ws room flow");
      expect(measurement.requestBytes).toBe(26);
      expect(measurement.echoBytes).toBe(27);
      expect(measurement.echoType).toBe("InputFwd");
      expect(measurement.slot).toBe(1);
      expect(measurement.fieldsMatched).toBe(true);
      expect(measurement.roundTripMs).toBeGreaterThanOrEqual(0);
      expect(measurement.roundTripMs).toBeLessThan(5000);
    },
    20_000,
  );
});
