/* Generated from probe.ts by experiments/e01/build.mjs. Do not edit directly. */
import { ProbeError, errorMessage } from "../shared/probe.js";
const INPUT_FRAME_BYTES = 26;
const INPUT_FWD_FRAME_BYTES = 27;
const INPUT_TYPE = 2;
const INPUT_FWD_TYPE = 178;
const PROBE_PROTOCOL_VERSION = 1;
const RAF_SAMPLE_FRAMES = 120;
const MAX_PROBE_SLOT = 8;
const DEFAULT_TIMEOUT_MS = 5e3;
const DEFAULT_RAF_TIMEOUT_MS = 12e3;
function encodeProbeInput(tick = 0, buttons = 0, edges = 0) {
  const frame = new Uint8Array(INPUT_FRAME_BYTES);
  const view = new DataView(frame.buffer);
  frame[0] = INPUT_TYPE;
  view.setUint32(1, tick >>> 0, true);
  view.setUint16(5, buttons & 65535, true);
  view.setUint16(7, edges & 65535, true);
  return frame;
}
function readInputFields(frame) {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return {
    tick: view.getUint32(1, true),
    buttons: view.getUint16(5, true),
    edges: view.getUint16(7, true)
  };
}
function decodeInputFwdFrame(frame) {
  var _a, _b;
  if (!(frame instanceof Uint8Array)) {
    throw new ProbeError("InputFwd echo must be a Uint8Array");
  }
  if (frame.byteLength !== INPUT_FWD_FRAME_BYTES) {
    throw new ProbeError(
      `InputFwd echo is ${frame.byteLength} bytes; expected ${INPUT_FWD_FRAME_BYTES}`
    );
  }
  if (frame[0] !== INPUT_FWD_TYPE) {
    throw new ProbeError(
      `InputFwd echo has type byte 0x${((_a = frame[0]) != null ? _a : 0).toString(16)}; expected 0x${INPUT_FWD_TYPE.toString(16)}`
    );
  }
  const slot = (_b = frame[1]) != null ? _b : 0;
  if (slot < 1 || slot > MAX_PROBE_SLOT) {
    throw new ProbeError(`InputFwd echo slot ${slot} is outside 1..${MAX_PROBE_SLOT}`);
  }
  return { slot, ...readInputFields(frame.subarray(1)), byteLength: frame.byteLength };
}
const COMPRESSED_NAME = /compress|astc|bptc/i;
const ASTC_EXTENSIONS = [
  "WEBGL_compressed_texture_astc",
  "WEBKIT_WEBGL_compressed_texture_astc"
];
const ETC_EXTENSIONS = ["WEBGL_compressed_texture_etc"];
const ETC1_EXTENSIONS = ["WEBGL_compressed_texture_etc1"];
const S3TC_EXTENSIONS = [
  "WEBGL_compressed_texture_s3tc",
  "WEBGL_compressed_texture_s3tc_srgb"
];
const BPTC_EXTENSIONS = ["EXT_texture_compression_bptc"];
function hasAny(supported, names) {
  return names.some((name) => supported.has(name));
}
function classifyCompressedExtensions(extensions) {
  const supported = new Set(extensions);
  return {
    astc: hasAny(supported, ASTC_EXTENSIONS),
    etc: hasAny(supported, ETC_EXTENSIONS),
    etc1: hasAny(supported, ETC1_EXTENSIONS),
    s3tc: hasAny(supported, S3TC_EXTENSIONS),
    bptc: hasAny(supported, BPTC_EXTENSIONS),
    extensions: extensions.filter((name) => COMPRESSED_NAME.test(name))
  };
}
function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
function summarizeFrameIntervals(intervals) {
  if (intervals.length === 0) {
    throw new ProbeError("no animation frame intervals were recorded");
  }
  let total = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  for (const interval of intervals) {
    if (!Number.isFinite(interval) || interval <= 0) {
      throw new ProbeError(`invalid animation frame interval: ${String(interval)}`);
    }
    total += interval;
    if (interval < min) min = interval;
    if (interval > max) max = interval;
  }
  const meanIntervalMs = total / intervals.length;
  return {
    frames: intervals.length,
    meanIntervalMs: round(meanIntervalMs, 1),
    hz: round(1e3 / meanIntervalMs, 1),
    minIntervalMs: round(min, 1),
    maxIntervalMs: round(max, 1)
  };
}
function measureAnimationFrameRate(requestFrame, frames = RAF_SAMPLE_FRAMES, timeoutMs = DEFAULT_RAF_TIMEOUT_MS) {
  if (!Number.isInteger(frames) || frames < 2) {
    throw new ProbeError(`frames must be an integer >= 2; got ${String(frames)}`);
  }
  return new Promise((resolve, reject) => {
    const timestamps = [];
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(
        new ProbeError(
          `requestAnimationFrame produced ${Math.max(0, timestamps.length - 1)}/${frames} intervals within ${timeoutMs} ms; keep the tab visible`
        )
      );
    }, timeoutMs);
    const onFrame = (timestamp) => {
      if (settled) return;
      timestamps.push(timestamp);
      if (timestamps.length <= frames) {
        requestFrame(onFrame);
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        const intervals = [];
        for (let index = 1; index < timestamps.length; index += 1) {
          const current = timestamps[index];
          const previous = timestamps[index - 1];
          if (current === void 0 || previous === void 0) continue;
          intervals.push(current - previous);
        }
        resolve(summarizeFrameIntervals(intervals));
      } catch (error) {
        reject(error);
      }
    };
    requestFrame(onFrame);
  });
}
async function probeAudioContext(ContextCtor, resumeTimeoutMs = 1e3) {
  var _a;
  const context = new ContextCtor();
  const initialState = context.state;
  let finalState = initialState;
  let resumeAttempted = false;
  let resumeError = null;
  try {
    if (initialState === "suspended") {
      resumeAttempted = true;
      try {
        await Promise.race([
          context.resume(),
          new Promise((_resolve, reject) => {
            setTimeout(
              () => reject(new ProbeError(`AudioContext.resume() did not settle within ${resumeTimeoutMs} ms`)),
              resumeTimeoutMs
            );
          })
        ]);
      } catch (error) {
        resumeError = errorMessage(error);
      }
      finalState = context.state;
    }
    return {
      initialState,
      finalState,
      sampleRate: context.sampleRate,
      baseLatencyMs: typeof context.baseLatency === "number" && Number.isFinite(context.baseLatency) ? round(context.baseLatency * 1e3, 2) : null,
      resumeAttempted,
      resumeError
    };
  } finally {
    try {
      await ((_a = context.close) == null ? void 0 : _a.call(context));
    } catch {
    }
  }
}
function probeWebSocketUrl(location) {
  if (location.host.length === 0) {
    throw new ProbeError("Open this page from the dev server, not from file://");
  }
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/ws`;
}
function isCredentials(value) {
  if (typeof value !== "object" || value === null) return false;
  const record = value;
  return typeof record["code"] === "string" && typeof record["pin"] === "string" && typeof record["hostToken"] === "string";
}
async function createProbeRoom(fetchImpl = fetch) {
  const response = await fetchImpl("/api/rooms", { method: "POST" });
  if (!response.ok) {
    throw new ProbeError(`POST /api/rooms returned HTTP ${response.status}`);
  }
  const body = await response.json();
  if (!isCredentials(body)) {
    throw new ProbeError("POST /api/rooms returned an unexpected body");
  }
  return { code: body.code, pin: body.pin, hostToken: body.hostToken };
}
function eventData(event) {
  if (typeof event === "object" && event !== null && "data" in event) {
    return event.data;
  }
  return void 0;
}
function bytesOf(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new ProbeError(`expected binary WebSocket data; got ${typeof data}`);
}
function textOf(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return null;
}
function controlMatcher(expected, label) {
  return (data) => {
    const text = textOf(data);
    if (text === null) return void 0;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return void 0;
    }
    if (typeof parsed !== "object" || parsed === null) return void 0;
    const message = parsed;
    if (message.t === "joinError") {
      const reason = typeof message.reason === "string" ? message.reason : "unknown reason";
      throw new ProbeError(`${label} was rejected: ${reason}`);
    }
    return message.t === expected ? message : void 0;
  };
}
function openSocket(WebSocketCtor, url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let socket;
    try {
      socket = new WebSocketCtor(url);
    } catch (error) {
      reject(new ProbeError(`WebSocket construction failed: ${errorMessage(error)}`));
      return;
    }
    socket.binaryType = "arraybuffer";
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === null) {
        resolve(socket);
      } else {
        reject(error);
      }
    };
    const onOpen = () => finish(null);
    const onError = () => finish(
      new ProbeError(
        "WebSocket failed before opening; use a dev-server URL whose Origin is allowed"
      )
    );
    const timer = setTimeout(
      () => finish(new ProbeError(`WebSocket did not open within ${timeoutMs} ms`)),
      timeoutMs
    );
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
  });
}
function waitForMessage(socket, label, timeoutMs, match) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onMessage = (event) => {
      if (settled) return;
      let matched;
      try {
        matched = match(eventData(event));
      } catch (error) {
        fail(error instanceof ProbeError ? error : new ProbeError(errorMessage(error)));
        return;
      }
      if (matched === void 0) return;
      settled = true;
      cleanup();
      resolve(matched);
    };
    const onError = () => fail(new ProbeError(`WebSocket error while waiting for ${label}`));
    const onClose = () => fail(new ProbeError(`WebSocket closed before ${label} arrived`));
    const timer = setTimeout(
      () => fail(new ProbeError(`timed out after ${timeoutMs} ms waiting for ${label}`)),
      timeoutMs
    );
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
  });
}
function closeQuietly(socket) {
  if (socket === null) return;
  try {
    socket.close();
  } catch {
  }
}
function defaultNow() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
async function measureBinaryWebSocket(options) {
  var _a, _b, _c;
  const now = (_a = options.now) != null ? _a : defaultNow;
  const timeoutMs = (_b = options.timeoutMs) != null ? _b : DEFAULT_TIMEOUT_MS;
  const input = (_c = options.input) != null ? _c : encodeProbeInput(16909060, 1, 1);
  if (input.byteLength !== INPUT_FRAME_BYTES || input[0] !== INPUT_TYPE) {
    throw new ProbeError(
      `probe Input must be ${INPUT_FRAME_BYTES} bytes with type 0x${INPUT_TYPE.toString(16)}`
    );
  }
  const sentFields = readInputFields(input);
  const credentials = await options.createRoom();
  let host = null;
  let controller = null;
  try {
    host = await openSocket(options.WebSocketCtor, options.url, timeoutMs);
    const hostJoined = waitForMessage(
      host,
      "hostJoined",
      timeoutMs,
      controlMatcher("hostJoined", "hostJoin")
    );
    host.send(
      JSON.stringify({
        t: "hostJoin",
        v: PROBE_PROTOCOL_VERSION,
        code: credentials.code,
        hostToken: credentials.hostToken
      })
    );
    await hostJoined;
    controller = await openSocket(options.WebSocketCtor, options.url, timeoutMs);
    const joinedWaiter = waitForMessage(
      controller,
      "joined",
      timeoutMs,
      controlMatcher("joined", "join")
    );
    controller.send(
      JSON.stringify({
        t: "join",
        v: PROBE_PROTOCOL_VERSION,
        code: credentials.code,
        pin: credentials.pin
      })
    );
    const joined = await joinedWaiter;
    if (typeof joined.slot !== "number" || !Number.isInteger(joined.slot)) {
      throw new ProbeError("joined message did not include an integer slot");
    }
    const echoWaiter = waitForMessage(host, "InputFwd echo", timeoutMs, (data) => {
      if (typeof data === "string") return void 0;
      return decodeInputFwdFrame(bytesOf(data));
    });
    const startedAt = now();
    controller.send(input);
    const echo = await echoWaiter;
    const roundTripMs = now() - startedAt;
    if (echo.slot !== joined.slot) {
      throw new ProbeError(
        `InputFwd slot ${echo.slot} does not match the joined slot ${joined.slot}`
      );
    }
    return {
      path: "existing /ws room flow",
      requestBytes: input.byteLength,
      echoBytes: echo.byteLength,
      echoType: "InputFwd",
      slot: echo.slot,
      roundTripMs: round(roundTripMs, 3),
      fieldsMatched: echo.tick === sentFields.tick && echo.buttons === sentFields.buttons && echo.edges === sentFields.edges
    };
  } finally {
    closeQuietly(controller);
    closeQuietly(host);
  }
}
function e1TvOnlyViable(webgl2, binaryWebSocket) {
  return webgl2 && binaryWebSocket;
}
export {
  INPUT_FRAME_BYTES,
  INPUT_FWD_FRAME_BYTES,
  INPUT_FWD_TYPE,
  INPUT_TYPE,
  PROBE_PROTOCOL_VERSION,
  RAF_SAMPLE_FRAMES,
  classifyCompressedExtensions,
  createProbeRoom,
  decodeInputFwdFrame,
  e1TvOnlyViable,
  encodeProbeInput,
  measureAnimationFrameRate,
  measureBinaryWebSocket,
  probeAudioContext,
  probeWebSocketUrl,
  summarizeFrameIntervals
};
