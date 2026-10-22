/**
 * D4-EXP-01 probe page: E4 LAN quality, E9 clock fairness, E15 lifecycle and
 * G1 join timing.
 *
 * Nothing runs on load. The first Run click creates (or joins) a room, records
 * G1, and arms the E15 lifecycle recorder; later Run clicks reuse that joined
 * controller so lock/unlock or app-switch episodes accumulate between runs.
 * E4 and E9 are re-measured on every Run.
 *
 * The room code, PIN, host token and session stay in memory; none of them is
 * written to the result JSON.
 */

import {
  createProbeRoom,
  probeWebSocketUrl,
  type WebSocketConstructor,
  type WebSocketLike,
} from "../e01/probe.js";
import { mountProbePage, ProbeError, type ProbeCheck } from "../shared/probe.js";
import {
  closeQuietly,
  ControllerSession,
  hostRoom,
  joinController,
  openSocket,
  recordLifecycle,
  runPingSeries,
} from "./probe.js";
import {
  e4Passes,
  E4_P95_LIMIT_MS,
  estimateOffset,
  summarizeFairness,
  summarizeG1,
  summarizeLifecycle,
  summarizeRtt,
  type FairnessRound,
  type G1Summary,
  type LifecycleEvent,
} from "./stats.js";

const moduleEvaluatedMs = performance.now();
const WebSocketCtor = window.WebSocket as unknown as WebSocketConstructor;
const now = (): number => performance.now();
const timeOrigin =
  typeof performance.timeOrigin === "number" ? performance.timeOrigin : Date.now() - performance.now();
const clientClock = (): number => timeOrigin + performance.now();

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`E9 probe markup is missing #${id}`);
  return element as T;
}

function intInput(id: string, min: number, max: number): number {
  const raw = Number(required<HTMLInputElement>(id).value);
  if (!Number.isInteger(raw) || raw < min || raw > max) {
    throw new ProbeError(`#${id} must be an integer in ${min}..${max}`);
  }
  return raw;
}

interface Settings {
  pings: number;
  intervalMs: number;
  sockets: number;
  rounds: number;
  burst: number;
  sameMachine: boolean;
  externalCode: string;
  externalPin: string;
}

function readSettings(): Settings {
  return {
    pings: intInput("pings", 10, 5000),
    intervalMs: intInput("interval", 1, 1000),
    sockets: intInput("sockets", 1, 8),
    rounds: intInput("rounds", 1, 100),
    burst: intInput("burst", 4, 200),
    sameMachine: required<HTMLInputElement>("same-machine").checked,
    externalCode: required<HTMLInputElement>("room-code").value.trim().toUpperCase(),
    externalPin: required<HTMLInputElement>("room-pin").value.trim(),
  };
}

function pageReadyMs(): number {
  const entries =
    typeof performance.getEntriesByType === "function"
      ? performance.getEntriesByType("navigation")
      : [];
  const navigation = entries[0] as PerformanceNavigationTiming | undefined;
  if (navigation !== undefined) {
    if (navigation.loadEventEnd > 0) return navigation.loadEventEnd;
    if (navigation.domContentLoadedEventEnd > 0) return navigation.domContentLoadedEventEnd;
  }
  return moduleEvaluatedMs;
}

/* ---- state that survives between Run clicks ---- */

let settings: Settings | null = null;
let lastRunClickMs = 0;
let session: ControllerSession | null = null;
let hostSocket: WebSocketLike | null = null;
let roomSource: "self-hosted" | "external" | null = null;
let g1: (G1Summary & { measuredAtRun: number }) | null = null;
let lifecycleEvents: LifecycleEvent[] | null = null;
let runCount = 0;

function wsUrl(): string {
  return probeWebSocketUrl(window.location);
}

function currentSettings(): Settings {
  if (settings === null) throw new ProbeError("settings were not read");
  return settings;
}

async function measureG1(current: Settings): Promise<G1Summary & { measuredAtRun: number }> {
  const runClickMs = lastRunClickMs;
  let code: string;
  let pin: string;
  if (current.externalCode.length > 0) {
    if (current.externalPin.length === 0) throw new ProbeError("enter the PIN for the external room");
    code = current.externalCode;
    pin = current.externalPin;
    roomSource = "external";
  } else {
    const room = await createProbeRoom();
    hostSocket = await hostRoom(WebSocketCtor, wsUrl(), room.code, room.hostToken);
    code = room.code;
    pin = room.pin;
    roomSource = "self-hosted";
  }
  const roomReadyMs = now();
  const joined = await joinController({ WebSocketCtor, url: wsUrl(), code, credential: { pin }, now });
  session = new ControllerSession(joined, code, WebSocketCtor, wsUrl(), now);
  const summary = summarizeG1({ pageReadyMs: pageReadyMs(), runClickMs, roomReadyMs, ...joined.marks });
  return { ...summary, measuredAtRun: runCount };
}

async function withSockets<T>(
  count: number,
  use: (sockets: WebSocketLike[]) => Promise<T>,
): Promise<T> {
  const sockets: WebSocketLike[] = [];
  try {
    for (let index = 0; index < count; index += 1) {
      sockets.push(await openSocket(WebSocketCtor, wsUrl()));
    }
    return await use(sockets);
  } finally {
    sockets.forEach(closeQuietly);
  }
}

const checks: readonly ProbeCheck[] = [
  {
    id: "configuration",
    label: "Probe configuration (no codes, PINs or tokens recorded)",
    run: () => {
      runCount += 1;
      settings = readSettings();
      return {
        run: runCount,
        pingsPerSocket: settings.pings,
        intervalMs: settings.intervalMs,
        e4Sockets: settings.sockets,
        e9Rounds: settings.rounds,
        e9PingsPerBurst: settings.burst,
        sameMachineTruth: settings.sameMachine,
        roomSource: settings.externalCode.length > 0 ? "external" : "self-hosted",
        clock: "performance.timeOrigin + performance.now(); server Date.now() via Pong",
      };
    },
  },
  {
    id: "g1-join",
    label: "G1: page load to joined (in-page; excludes QR scan)",
    run: async () => {
      if (g1 === null || session === null) g1 = await measureG1(currentSettings());
      return { ...g1, roomSource, slot: session === null ? null : session.slot };
    },
  },
  {
    id: "e4-rtt",
    label: "E4: Ping/Pong RTT p50/p95, jitter, loss",
    run: async () => {
      const current = currentSettings();
      const series = await withSockets(current.sockets, (sockets) =>
        Promise.all(
          sockets.map((socket, index) =>
            runPingSeries(socket, {
              count: current.pings,
              intervalMs: current.intervalMs,
              clientClock,
              firstSeq: (index + 1) * 1_000_000,
            }),
          ),
        ),
      );
      const summary = summarizeRtt(series.map((entry) => ({ sent: entry.sent, rttMs: entry.rttMs })));
      return {
        ...summary,
        meetsE4Threshold: e4Passes(summary),
        threshold: `p95 < ${E4_P95_LIMIT_MS} ms with no loss (5 GHz phone/TV run)`,
      };
    },
  },
  {
    id: "e9-fairness",
    label: "E9: clock offset estimate error between two sockets",
    run: async () => {
      const current = currentSettings();
      const truth = current.sameMachine ? () => Date.now() + 0.5 - clientClock() : undefined;
      const rounds = await withSockets(2, async ([a, b]) => {
        const collected: FairnessRound[] = [];
        for (let round = 0; round < current.rounds; round += 1) {
          const base = { count: current.burst, intervalMs: 10, clientClock };
          const options = truth === undefined ? base : { ...base, truthOffset: truth };
          const [seriesA, seriesB] = await Promise.all([
            runPingSeries(a as WebSocketLike, options),
            runPingSeries(b as WebSocketLike, { ...options, firstSeq: 1_000_000 }),
          ]);
          if (seriesA.samples.length === 0 || seriesB.samples.length === 0) {
            throw new ProbeError(`round ${round + 1} received no Pongs on one socket`);
          }
          collected.push({ a: estimateOffset(seriesA.samples), b: estimateOffset(seriesB.samples) });
        }
        return collected;
      });
      return {
        ...summarizeFairness(rounds),
        firstRound: rounds[0] ?? null,
        groundTruth: truth === undefined ? "none (not declared same machine)" : "same OS clock",
      };
    },
  },
  {
    id: "e15-lifecycle",
    label: "E15: hide/show episodes and session rejoin time",
    run: () => {
      const active = session;
      if (active === null) throw new ProbeError("no joined controller; the G1 join must succeed first");
      if (lifecycleEvents === null) {
        lifecycleEvents = recordLifecycle({ document, window }, now, {
          onHidden: () => active.suspend(),
          onVisible: () => {
            void active.rejoin();
          },
        });
      }
      const summary = summarizeLifecycle(lifecycleEvents, active.recoveries);
      if (summary.episodes.length === 0) {
        throw new ProbeError(
          "recorder armed; no hide/show yet. Lock the screen or switch apps, return, then press Run again",
        );
      }
      return { ...summary, rawEvents: lifecycleEvents.slice(-20) };
    },
  },
];

const runButton = required<HTMLButtonElement>("run");
// Registered before mountProbePage so it fires first and timestamps the click.
runButton.addEventListener("click", () => {
  lastRunClickMs = now();
});

window.addEventListener("pagehide", (event) => {
  // A real unload (not bfcache) frees the slot; a bfcache entry keeps it for E15.
  if (!(event as PageTransitionEvent).persisted) {
    session?.leave();
    closeQuietly(hostSocket);
  }
});

mountProbePage({
  experiment: "E4/E9/E15/G1",
  title: "LAN quality, clock fairness, lifecycle and join timing",
  checks,
  elements: {
    runButton,
    copyButton: required<HTMLButtonElement>("copy"),
    tableHost: required<HTMLTableElement>("results"),
    jsonHost: required("json"),
    statusHost: required("status"),
  },
});
