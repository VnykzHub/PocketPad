/* Generated from latency.ts by experiments/e05/build.mjs. Do not edit directly. */
import { ProbeError, errorMessage } from "../shared/probe.js";
import {
  decodeInputFwdFrame,
  encodeProbeInput
} from "../e01/probe.js";
const E5_SCHEMA_VERSION = 1;
const E5_DEFAULT_TAPS = 100;
const E5_DEFAULT_INTERVAL_MS = 120;
const E5_P95_BUDGET_MS = 25;
const PROTOCOL_VERSION = 1;
const BUTTON_A = 1;
const STEP_TIMEOUT_MS = 2e3;
function percentile(values, percent) {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = Math.ceil(percent / 100 * sorted.length);
  const value = sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
  return value === void 0 ? null : value;
}
function round3(value) {
  return Math.round(value * 1e3) / 1e3;
}
function summarizeLeg(values) {
  var _a, _b;
  if (values.length === 0) return null;
  return {
    count: values.length,
    p50Ms: round3((_a = percentile(values, 50)) != null ? _a : 0),
    p95Ms: round3((_b = percentile(values, 95)) != null ? _b : 0),
    minMs: round3(Math.min(...values)),
    maxMs: round3(Math.max(...values))
  };
}
function summarizeE5(samples) {
  const leg = (pick) => summarizeLeg(samples.map(pick));
  const inputToCanvas = leg((sample) => sample.hostPaintMs - sample.touchMs);
  return {
    tapToEncode: leg((sample) => sample.encodeMs - sample.touchMs),
    packetToHost: leg((sample) => sample.hostReceiveMs - sample.encodeMs),
    receiveToPaint: leg((sample) => sample.hostPaintMs - sample.hostReceiveMs),
    inputToCanvas,
    pass: inputToCanvas === null ? null : inputToCanvas.p95Ms < E5_P95_BUDGET_MS
  };
}
function eventData(event) {
  return typeof event === "object" && event !== null && "data" in event ? event.data : void 0;
}
function textMessage(data) {
  if (typeof data !== "string") return null;
  try {
    const parsed = JSON.parse(data);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}
function bytesOf(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return null;
}
function withTimeout(promise, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new ProbeError(`timed out after ${STEP_TIMEOUT_MS} ms waiting for ${label}`)),
      STEP_TIMEOUT_MS
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
function openSocket(deps) {
  return withTimeout(
    new Promise((resolve, reject) => {
      const socket = new deps.WebSocketCtor(deps.url);
      socket.binaryType = "arraybuffer";
      socket.addEventListener("open", () => resolve(socket));
      socket.addEventListener(
        "error",
        () => reject(new ProbeError("WebSocket failed; open this page from a dev-server URL"))
      );
    }),
    "WebSocket open"
  );
}
function nextMessage(socket, label, match) {
  let listener = () => void 0;
  const waiting = new Promise((resolve, reject) => {
    listener = (event) => {
      const data = eventData(event);
      const message = textMessage(data);
      if (message !== null && message.t === "joinError") {
        reject(new ProbeError(`${label} rejected: ${String(message.reason)}`));
        return;
      }
      const matched = match(data);
      if (matched !== void 0) resolve(matched);
    };
    socket.addEventListener("message", listener);
  });
  return withTimeout(waiting, label).finally(() => socket.removeEventListener("message", listener));
}
function closeQuietly(socket) {
  try {
    socket == null ? void 0 : socket.close();
  } catch {
  }
}
async function runE5TapLoop(deps, taps = E5_DEFAULT_TAPS, intervalMs = E5_DEFAULT_INTERVAL_MS) {
  var _a, _b, _c, _d, _e;
  const credentials = await deps.createRoom();
  let host = null;
  let controller = null;
  const samples = [];
  let missed = 0;
  try {
    const hostSocket = await openSocket(deps);
    host = hostSocket;
    const hostJoined = nextMessage(
      hostSocket,
      "hostJoin",
      (data) => {
        var _a2;
        return ((_a2 = textMessage(data)) == null ? void 0 : _a2.t) === "hostJoined" ? true : void 0;
      }
    );
    hostSocket.send(
      JSON.stringify({
        t: "hostJoin",
        v: PROTOCOL_VERSION,
        code: credentials.code,
        hostToken: credentials.hostToken
      })
    );
    await hostJoined;
    const controllerSocket = await openSocket(deps);
    controller = controllerSocket;
    const joined = nextMessage(controllerSocket, "join", (data) => {
      const message = textMessage(data);
      return (message == null ? void 0 : message.t) === "joined" && typeof message.slot === "number" ? message.slot : void 0;
    });
    controllerSocket.send(
      JSON.stringify({ t: "join", v: PROTOCOL_VERSION, code: credentials.code, pin: credentials.pin })
    );
    const slot = await joined;
    for (let index = 0; index < taps; index += 1) {
      const received = nextMessage(hostSocket, "InputFwd edge", (data) => {
        const bytes = bytesOf(data);
        if (bytes === null) return void 0;
        const at = deps.now();
        const frame = decodeInputFwdFrame(bytes);
        return frame.slot === slot && (frame.edges & BUTTON_A) !== 0 ? at : void 0;
      });
      const touchMs = deps.now();
      (_a = deps.flash) == null ? void 0 : _a.call(deps, "pad", true);
      controllerSocket.send(encodeProbeInput(index * 2, BUTTON_A, BUTTON_A));
      const encodeMs = deps.now();
      try {
        const hostReceiveMs = await received;
        (_b = deps.flash) == null ? void 0 : _b.call(deps, "host", true);
        const hostPaintMs = await new Promise(
          (resolve) => deps.requestFrame(() => resolve(deps.now()))
        );
        samples.push({ touchMs, encodeMs, hostReceiveMs, hostPaintMs });
      } catch (error) {
        if (!(error instanceof ProbeError)) throw error;
        missed += 1;
      }
      controllerSocket.send(encodeProbeInput(index * 2 + 1, 0, 0));
      (_c = deps.flash) == null ? void 0 : _c.call(deps, "pad", false);
      (_d = deps.flash) == null ? void 0 : _d.call(deps, "host", false);
      (_e = deps.onProgress) == null ? void 0 : _e.call(deps, index + 1, taps);
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
    method: "same-tab controller socket -> dev-server /ws broker -> host socket -> flash -> requestAnimationFrame; one performance.now() clock",
    tapsRequested: taps,
    intervalMs,
    missed,
    samples,
    summary: summarizeE5(samples),
    pending: {
      phoneTouchPipeline: "PENDING - needs a phone tapping the real controller",
      cameraInputToPhoton: "PENDING - needs a 240 fps camera or photodiode",
      displayLag: "PENDING - measured separately by E6, never folded into this number",
      tv: "PENDING - TV probing deferred; desktop browser only"
    }
  };
}
export {
  E5_DEFAULT_INTERVAL_MS,
  E5_DEFAULT_TAPS,
  E5_P95_BUDGET_MS,
  E5_SCHEMA_VERSION,
  percentile,
  runE5TapLoop,
  summarizeE5,
  summarizeLeg
};
