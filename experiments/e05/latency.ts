/**
 * E5 — input-to-canvas software baseline (D3-EXP-01, PR-11.1, G2).
 *
 * One browser tab plays both ends through the real dev-server `/ws` room
 * flow: a controller socket sends a press edge, the host socket receives the
 * `InputFwd`, the host flash element turns white, and the next animation frame
 * stamps the paint. Every stamp comes from one `performance.now()` clock, so
 * no clock sync is needed.
 *
 * Samples use the latency-harness log format
 * `{touchMs, encodeMs, hostReceiveMs, hostPaintMs}` so
 * `tools/latency-harness` can re-analyse a copied log.
 *
 * What this does not measure (FR-7.13): the phone's touch pipeline, Wi-Fi,
 * and canvas-to-photon display lag. Those need a phone, a TV and a 240 fps
 * camera; the result JSON marks them PENDING. TV probing is deferred.
 *
 * The room code, PIN and host token stay in local variables and are never
 * written to the result (SR-7).
 */

import { ProbeError, errorMessage } from "../shared/probe.js";
import {
  decodeInputFwdFrame,
  encodeProbeInput,
  type ProbeRoomCredentials,
  type WebSocketConstructor,
  type WebSocketLike,
} from "../e01/probe.js";

export const E5_SCHEMA_VERSION = 1;
export const E5_DEFAULT_TAPS = 100;
export const E5_DEFAULT_INTERVAL_MS = 120;
/** G2: p95 input-to-canvas under 25 ms on LAN dev. */
export const E5_P95_BUDGET_MS = 25;
const PROTOCOL_VERSION = 1;
const BUTTON_A = 1;
const STEP_TIMEOUT_MS = 2000;

export interface E5Sample {
  touchMs: number;
  encodeMs: number;
  hostReceiveMs: number;
  hostPaintMs: number;
}

export interface E5LegSummary {
  count: number;
  p50Ms: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
}

export interface E5Summary {
  tapToEncode: E5LegSummary | null;
  packetToHost: E5LegSummary | null;
  receiveToPaint: E5LegSummary | null;
  inputToCanvas: E5LegSummary | null;
  /** p95 inputToCanvas < 25 ms; null with no samples. */
  pass: boolean | null;
}

/** Nearest-rank percentile, matching tools/latency-harness. */
export function percentile(values: readonly number[], percent: number): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = Math.ceil((percent / 100) * sorted.length);
  const value = sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
  return value === undefined ? null : value;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function summarizeLeg(values: readonly number[]): E5LegSummary | null {
  if (values.length === 0) return null;
  return {
    count: values.length,
    p50Ms: round3(percentile(values, 50) ?? 0),
    p95Ms: round3(percentile(values, 95) ?? 0),
    minMs: round3(Math.min(...values)),
    maxMs: round3(Math.max(...values)),
  };
}

export function summarizeE5(samples: readonly E5Sample[]): E5Summary {
  const leg = (pick: (sample: E5Sample) => number): E5LegSummary | null =>
    summarizeLeg(samples.map(pick));
  const inputToCanvas = leg((sample) => sample.hostPaintMs - sample.touchMs);
  return {
    tapToEncode: leg((sample) => sample.encodeMs - sample.touchMs),
    packetToHost: leg((sample) => sample.hostReceiveMs - sample.encodeMs),
    receiveToPaint: leg((sample) => sample.hostPaintMs - sample.hostReceiveMs),
    inputToCanvas,
    pass: inputToCanvas === null ? null : inputToCanvas.p95Ms < E5_P95_BUDGET_MS,
  };
}

export interface E5Deps {
  createRoom: () => Promise<ProbeRoomCredentials>;
  WebSocketCtor: WebSocketConstructor;
  url: string;
  now: () => number;
  /** requestAnimationFrame; the callback time stamps the paint. */
  requestFrame: (callback: () => void) => void;
  delay: (ms: number) => Promise<void>;
  /** Visual flash; `pad` on tap, `host` on receipt. Optional in tests. */
  flash?: (target: "pad" | "host", on: boolean) => void;
  onProgress?: (done: number, total: number) => void;
}

export interface E5Run {
  schema: number;
  method: string;
  tapsRequested: number;
  intervalMs: number;
  missed: number;
  samples: E5Sample[];
  summary: E5Summary;
  pending: {
    phoneTouchPipeline: string;
    cameraInputToPhoton: string;
    displayLag: string;
    tv: string;
  };
}

function eventData(event: unknown): unknown {
  return typeof event === "object" && event !== null && "data" in event
    ? (event as { data?: unknown }).data
    : undefined;
}

function textMessage(data: unknown): Record<string, unknown> | null {
  if (typeof data !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function bytesOf(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return null;
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new ProbeError(`timed out after ${STEP_TIMEOUT_MS} ms waiting for ${label}`)),
      STEP_TIMEOUT_MS,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function openSocket(deps: E5Deps): Promise<WebSocketLike> {
  return withTimeout(
    new Promise<WebSocketLike>((resolve, reject) => {
      const socket = new deps.WebSocketCtor(deps.url);
      socket.binaryType = "arraybuffer";
      socket.addEventListener("open", () => resolve(socket));
      socket.addEventListener("error", () =>
        reject(new ProbeError("WebSocket failed; open this page from a dev-server URL")),
      );
    }),
    "WebSocket open",
  );
}

/** Resolves with the first message `match` accepts. */
function nextMessage<T>(
  socket: WebSocketLike,
  label: string,
  match: (data: unknown) => T | undefined,
): Promise<T> {
  let listener: (event: unknown) => void = () => undefined;
  const waiting = new Promise<T>((resolve, reject) => {
    listener = (event: unknown): void => {
      const data = eventData(event);
      const message = textMessage(data);
      if (message !== null && message.t === "joinError") {
        reject(new ProbeError(`${label} rejected: ${String(message.reason)}`));
        return;
      }
      const matched = match(data);
      if (matched !== undefined) resolve(matched);
    };
    socket.addEventListener("message", listener);
  });
  return withTimeout(waiting, label).finally(() => socket.removeEventListener("message", listener));
}

function closeQuietly(socket: WebSocketLike | null): void {
  try {
    socket?.close();
  } catch {
    // Already closed.
  }
}

/** Runs `taps` press edges through the dev server and returns the samples. */
export async function runE5TapLoop(
  deps: E5Deps,
  taps: number = E5_DEFAULT_TAPS,
  intervalMs: number = E5_DEFAULT_INTERVAL_MS,
): Promise<E5Run> {
  const credentials = await deps.createRoom();
  let host: WebSocketLike | null = null;
  let controller: WebSocketLike | null = null;
  const samples: E5Sample[] = [];
  let missed = 0;

  try {
    const hostSocket = await openSocket(deps);
    host = hostSocket;
    const hostJoined = nextMessage(hostSocket, "hostJoin", (data) =>
      textMessage(data)?.t === "hostJoined" ? true : undefined,
    );
    hostSocket.send(
      JSON.stringify({
        t: "hostJoin",
        v: PROTOCOL_VERSION,
        code: credentials.code,
        hostToken: credentials.hostToken,
      }),
    );
    await hostJoined;

    const controllerSocket = await openSocket(deps);
    controller = controllerSocket;
    const joined = nextMessage(controllerSocket, "join", (data) => {
      const message = textMessage(data);
      return message?.t === "joined" && typeof message.slot === "number" ? message.slot : undefined;
    });
    controllerSocket.send(
      JSON.stringify({ t: "join", v: PROTOCOL_VERSION, code: credentials.code, pin: credentials.pin }),
    );
    const slot = await joined;

    for (let index = 0; index < taps; index += 1) {
      const received = nextMessage(hostSocket, "InputFwd edge", (data) => {
        const bytes = bytesOf(data);
        if (bytes === null) return undefined;
        const at = deps.now();
        const frame = decodeInputFwdFrame(bytes);
        return frame.slot === slot && (frame.edges & BUTTON_A) !== 0 ? at : undefined;
      });
      const touchMs = deps.now();
      deps.flash?.("pad", true);
      controllerSocket.send(encodeProbeInput(index * 2, BUTTON_A, BUTTON_A));
      const encodeMs = deps.now();
      try {
        const hostReceiveMs = await received;
        deps.flash?.("host", true);
        const hostPaintMs = await new Promise<number>((resolve) =>
          deps.requestFrame(() => resolve(deps.now())),
        );
        samples.push({ touchMs, encodeMs, hostReceiveMs, hostPaintMs });
      } catch (error) {
        if (!(error instanceof ProbeError)) throw error;
        missed += 1;
      }
      controllerSocket.send(encodeProbeInput(index * 2 + 1, 0, 0));
      deps.flash?.("pad", false);
      deps.flash?.("host", false);
      deps.onProgress?.(index + 1, taps);
      await deps.delay(intervalMs);
    }
  } catch (error) {
    throw error instanceof ProbeError ? error : new ProbeError(errorMessage(error));
  } finally {
    closeQuietly(controller);
    closeQuietly(host);
  }

  return {
    schema: E5_SCHEMA_VERSION,
    method:
      "same-tab controller socket -> dev-server /ws broker -> host socket -> flash -> requestAnimationFrame; one performance.now() clock",
    tapsRequested: taps,
    intervalMs,
    missed,
    samples,
    summary: summarizeE5(samples),
    pending: {
      phoneTouchPipeline: "PENDING - needs a phone tapping the real controller",
      cameraInputToPhoton: "PENDING - needs a 240 fps camera or photodiode",
      displayLag: "PENDING - measured separately by E6, never folded into this number",
      tv: "PENDING - TV probing deferred; desktop browser only",
    },
  };
}
