/**
 * D4-EXP-01 end-to-end check against the real dev server and broker.
 *
 * Boots the dev server on 127.0.0.1:0 and drives the probe transport with a
 * Node `ws` client: Ping/Pong bursts (E4/E9), the self-hosted room join (G1)
 * and both session-rejoin paths (E15). These are Node numbers on one machine,
 * not phone or TV measurements; they only prove the probe path works.
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
import { createProbeRoom, type WebSocketConstructor } from "../../e01/probe.js";
import {
  closeQuietly,
  ControllerSession,
  hostRoom,
  joinController,
  openSocket,
  runPingSeries,
} from "../probe.js";
import { estimateOffset, summarizeFairness, summarizeRtt } from "../stats.js";

const Ctor = WebSocket as unknown as WebSocketConstructor;
const experimentsRoot = fileURLToPath(new URL("../../", import.meta.url));
const clientClock = (): number => performance.timeOrigin + performance.now();
const truthOffset = (): number => Date.now() + 0.5 - clientClock();

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
  tempRoot = mkdtempSync(join(tmpdir(), "lanpad-e9-"));
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

async function boot(): Promise<{ base: string; wsUrl: string }> {
  app = createDevServer(
    { host: "127.0.0.1", port: 0, staticRoots: makeStaticRoots(), allowedOrigins: [] },
    { logger: { info(): void {} } },
  );
  const { port } = await app.listen();
  return { base: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/ws` };
}

describe("[E4] [E9] Ping/Pong against the dev server", () => {
  it(
    "[E9] serves /x/e09/ and estimates the offset of a same-clock server within 5 ms",
    async () => {
      const { base, wsUrl } = await boot();
      const page = await fetch(`${base}/x/e09/`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('src="./page.js"');
      for (const file of ["page.js", "probe.js", "stats.js"]) {
        expect((await fetch(`${base}/x/e09/${file}`)).status).toBe(200);
      }

      const a = await openSocket(Ctor, wsUrl);
      const b = await openSocket(Ctor, wsUrl);
      try {
        const options = { count: 40, intervalMs: 2, clientClock, truthOffset };
        const [seriesA, seriesB] = await Promise.all([
          runPingSeries(a, options),
          runPingSeries(b, { ...options, firstSeq: 1_000_000 }),
        ]);
        const rtt = summarizeRtt([seriesA, seriesB].map((s) => ({ sent: s.sent, rttMs: s.rttMs })));
        expect(rtt.sent).toBe(80);
        expect(rtt.lost).toBe(0);
        const fairness = summarizeFairness([
          { a: estimateOffset(seriesA.samples), b: estimateOffset(seriesB.samples) },
        ]);
        expect(fairness.absErrorVsTruthP95Ms).not.toBeNull();
        expect(fairness.absErrorVsTruthP95Ms as number).toBeLessThan(5);
        expect(fairness.pairErrorP95Ms as number).toBeLessThan(5);
      } finally {
        closeQuietly(a);
        closeQuietly(b);
      }
    },
    20_000,
  );
});

describe("[G1] [E15] [G4] join and session rejoin", () => {
  it(
    "[E15] rejoins the same slot on the same socket and on a new socket",
    async () => {
      const { base, wsUrl } = await boot();
      const room = await createProbeRoom((input, init) => fetch(new URL(input, base).href, init));
      const host = await hostRoom(Ctor, wsUrl, room.code, room.hostToken);
      const now = (): number => performance.now();
      try {
        const joined = await joinController({
          WebSocketCtor: Ctor,
          url: wsUrl,
          code: room.code,
          credential: { pin: room.pin },
          now,
        });
        expect(joined.slot).toBe(1);
        expect(joined.marks.joinedMs).toBeGreaterThanOrEqual(joined.marks.joinSentMs);

        const session = new ControllerSession(joined, room.code, Ctor, wsUrl, now);
        session.suspend();
        await session.rejoin();
        expect(session.recoveries[0]).toMatchObject({ path: "same-socket", slot: 1, error: null });

        session.suspend();
        // Simulate the OS killing the socket while the phone is locked.
        const killed = (session as unknown as { controller: { socket: WebSocket } }).controller.socket;
        killed.close();
        await new Promise((resolve) => setTimeout(resolve, 50));
        await session.rejoin();
        const second = session.recoveries[1];
        expect(second).toMatchObject({ path: "new-socket", slot: 1, expectedSlot: 1, error: null });
        expect((second?.joinedAtMs as number) - (second?.startedAtMs as number)).toBeLessThan(1000);
        session.leave();
      } finally {
        closeQuietly(host);
      }
    },
    20_000,
  );
});
