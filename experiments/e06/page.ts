/**
 * E6 page wiring (D3-EXP-01). The flash sequence starts only from Run.
 */

import { mountProbePage, type ProbeCheck } from "../shared/probe.js";
import { createE6Result, runFlashSequence, type FlashSequenceResult } from "./flash.js";

function required(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`E6 markup is missing #${id}`);
  return element;
}

const flash = required("flash");
const counter = required("frame-counter");
let software: FlashSequenceResult | null = null;

const checks: readonly ProbeCheck[] = [
  {
    id: "flash-sequence",
    label: "Flash sequence: 30 flashes (6 frames white, 24 black) on animation frames",
    run: async () => {
      software = await runFlashSequence({
        requestFrame: (callback) => {
          window.requestAnimationFrame(callback);
        },
        render: (lit, frame) => {
          flash.classList.toggle("lit", lit);
          counter.textContent = String(frame);
        },
      });
      return {
        flashes: software.flashes,
        framesRendered: software.framesRendered,
        frameIntervalP50Ms: software.frameIntervalP50Ms,
        frameIntervalP95Ms: software.frameIntervalP95Ms,
        refreshHzEstimate: software.refreshHzEstimate,
      };
    },
  },
  {
    id: "display-lag",
    label: "Display lag, Game Mode on / off (camera or photodiode)",
    run: () => {
      if (software === null) return "PENDING";
      const result = createE6Result(software);
      return { ...result.displayLag, tv: result.tv };
    },
  },
  {
    id: "separation",
    label: "Reported apart from E5 input-to-canvas (FR-7.13)",
    run: () => ({
      separateFromE5: true,
      userAdvice: "Turn on the TV's Game Mode (or PC mode) for the lowest display lag.",
    }),
  },
];

mountProbePage({
  experiment: "E6",
  title: "Display lag flash test",
  checks,
  elements: {
    runButton: required("run") as HTMLButtonElement,
    copyButton: required("copy") as HTMLButtonElement,
    tableHost: required("results") as HTMLTableElement,
    jsonHost: required("json"),
    statusHost: required("status"),
  },
});
