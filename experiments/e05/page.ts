/**
 * E5 page wiring (D3-EXP-01). Nothing runs until the Run button is pressed;
 * the shared probe runner turns each step into a table row and the JSON block.
 */

import { ProbeError, mountProbePage, type ProbeCheck } from "../shared/probe.js";
import { createProbeRoom, probeWebSocketUrl, type WebSocketConstructor } from "../e01/probe.js";
import { E5_P95_BUDGET_MS, runE5TapLoop, type E5Run } from "./latency.js";

let latest: E5Run | null = null;

function required(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`E5 markup is missing #${id}`);
  return element;
}

function requireRun(): E5Run {
  if (latest === null) throw new ProbeError("the tap loop did not complete; see its row");
  return latest;
}

const pad = required("pad");
const hostFlash = required("host-flash");
const status = required("status");

const checks: readonly ProbeCheck[] = [
  {
    id: "tap-loop",
    label: "100 press edges: same-tab controller socket -> /ws -> host socket",
    run: async () => {
      latest = null;
      latest = await runE5TapLoop({
        createRoom: () => createProbeRoom(),
        WebSocketCtor: window.WebSocket as unknown as WebSocketConstructor,
        url: probeWebSocketUrl(window.location),
        now: () => performance.now(),
        requestFrame: (callback) => {
          window.requestAnimationFrame(() => callback());
        },
        delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        flash: (target, on) => {
          (target === "pad" ? pad : hostFlash).classList.toggle("lit", on);
        },
        onProgress: (done, total) => {
          status.textContent = `Running: tap ${done}/${total}`;
        },
      });
      return {
        tapsRequested: latest.tapsRequested,
        samples: latest.samples.length,
        missed: latest.missed,
        intervalMs: latest.intervalMs,
      };
    },
  },
  {
    id: "input-to-canvas",
    label: `Input-to-canvas (tap -> host paint), G2 p95 < ${E5_P95_BUDGET_MS} ms`,
    run: () => {
      const { summary } = requireRun();
      if (summary.inputToCanvas === null) throw new ProbeError("no samples");
      if (summary.pass === false) {
        throw new ProbeError(
          `p95 ${summary.inputToCanvas.p95Ms} ms is over the ${E5_P95_BUDGET_MS} ms budget`,
        );
      }
      return summary.inputToCanvas;
    },
  },
  {
    id: "legs",
    label: "Separate legs: tap->encode, packet->host, receive->paint",
    run: () => {
      const { summary } = requireRun();
      return {
        tapToEncode: summary.tapToEncode,
        packetToHost: summary.packetToHost,
        receiveToPaint: summary.receiveToPaint,
      };
    },
  },
  {
    id: "pending-legs",
    label: "Hardware legs not measured by this page",
    run: () => requireRun().pending,
  },
  {
    id: "samples",
    label: "Raw samples (tools/latency-harness log format)",
    run: () => requireRun().samples,
  },
];

mountProbePage({
  experiment: "E5",
  title: "Input-to-canvas software baseline",
  checks,
  elements: {
    runButton: required("run") as HTMLButtonElement,
    copyButton: required("copy") as HTMLButtonElement,
    tableHost: required("results") as HTMLTableElement,
    jsonHost: required("json"),
    statusHost: status,
  },
});
