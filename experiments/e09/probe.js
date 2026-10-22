/* Generated from probe.ts by experiments/e09/build.mjs. Do not edit directly. */
var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
import {
  PROBE_PROTOCOL_VERSION
} from "../e01/probe.js";
import { ProbeError, errorMessage } from "../shared/probe.js";
import { unwrapU32 } from "./stats.js";
const PING_TYPE = 3;
const PONG_TYPE = 130;
const PING_FRAME_BYTES = 5;
const PONG_FRAME_BYTES = 9;
const DEFAULT_TIMEOUT_MS = 5e3;
const DEFAULT_PONG_GRACE_MS = 1e3;
const OPEN = 1;
function encodeProbePing(clientTimeMs) {
  const frame = new Uint8Array(PING_FRAME_BYTES);
  frame[0] = PING_TYPE;
  new DataView(frame.buffer).setUint32(1, clientTimeMs >>> 0, true);
  return frame;
}
function decodeProbePong(frame) {
  if (frame.byteLength !== PONG_FRAME_BYTES || frame[0] !== PONG_TYPE) return null;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return { clientTimeMs: view.getUint32(1, true), serverTimeMs: view.getUint32(5, true) };
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
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function openSocket(WebSocketCtor, url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let socket;
    try {
      socket = new WebSocketCtor(url);
    } catch (error) {
      reject(new ProbeError(`WebSocket construction failed: ${errorMessage(error)}`));
      return;
    }
    socket.binaryType = "arraybuffer";
    const finish = (error) => {
      clearTimeout(timer);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      if (error === null) resolve(socket);
      else reject(error);
    };
    const onOpen = () => finish(null);
    const onError = () => finish(new ProbeError("WebSocket failed to open; use a dev-server URL whose Origin is allowed"));
    const timer = setTimeout(
      () => finish(new ProbeError(`WebSocket did not open within ${timeoutMs} ms`)),
      timeoutMs
    );
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
  });
}
function closeQuietly(socket) {
  if (socket === null) return;
  try {
    socket.close();
  } catch {
  }
}
function waitForControl(socket, expected, timeoutMs) {
  return new Promise((resolve, reject) => {
    const finish = (error, message) => {
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      if (error === null) resolve(message);
      else reject(error);
    };
    const onMessage = (event) => {
      const data = eventData(event);
      if (typeof data !== "string") return;
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      if (message.t === "joinError") {
        finish(new ProbeError(`${expected} rejected: ${String(message.reason)}`));
      } else if (message.t === expected) {
        finish(null, message);
      }
    };
    const onClose = () => finish(new ProbeError(`socket closed before ${expected}`));
    const timer = setTimeout(
      () => finish(new ProbeError(`timed out after ${timeoutMs} ms waiting for ${expected}`)),
      timeoutMs
    );
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
  });
}
async function runPingSeries(socket, options) {
  var _a, _b;
  const graceMs = (_a = options.graceMs) != null ? _a : DEFAULT_PONG_GRACE_MS;
  const firstSeq = (_b = options.firstSeq) != null ? _b : 1;
  const pending = /* @__PURE__ */ new Map();
  const samples = [];
  const rttMs = [];
  let resolveDrained = null;
  let closed = false;
  const onMessage = (event) => {
    const bytes = bytesOf(eventData(event));
    if (bytes === null) return;
    const pong = decodeProbePong(bytes);
    if (pong === null) return;
    const sentAt = pending.get(pong.clientTimeMs);
    if (sentAt === void 0) return;
    pending.delete(pong.clientTimeMs);
    const receivedAt = options.clientClock();
    const sample = {
      sentClientMs: sentAt,
      receivedClientMs: receivedAt,
      serverMs: unwrapU32(pong.serverTimeMs, receivedAt)
    };
    if (options.truthOffset !== void 0) sample.truthOffsetMs = options.truthOffset();
    samples.push(sample);
    rttMs.push(receivedAt - sentAt);
    if (pending.size === 0 && resolveDrained !== null) resolveDrained();
  };
  const onClose = () => {
    closed = true;
    if (resolveDrained !== null) resolveDrained();
  };
  socket.addEventListener("message", onMessage);
  socket.addEventListener("close", onClose);
  let sent = 0;
  try {
    for (let index = 0; index < options.count && !closed; index += 1) {
      const seq = firstSeq + index >>> 0;
      pending.set(seq, options.clientClock());
      socket.send(encodeProbePing(seq));
      sent += 1;
      if (index < options.count - 1) await sleep(options.intervalMs);
    }
    if (pending.size > 0 && !closed) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, graceMs);
        resolveDrained = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  } finally {
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("close", onClose);
  }
  return { sent, samples, rttMs };
}
function requireSlotAndSession(message) {
  if (typeof message.slot !== "number" || !Number.isInteger(message.slot)) {
    throw new ProbeError("joined did not carry an integer slot");
  }
  if (typeof message.session !== "string" || message.session.length === 0) {
    throw new ProbeError("joined did not carry a session");
  }
  return { slot: message.slot, session: message.session };
}
async function joinController(options) {
  var _a, _b;
  const timeoutMs = (_a = options.timeoutMs) != null ? _a : DEFAULT_TIMEOUT_MS;
  const socket = (_b = options.socket) != null ? _b : await openSocket(options.WebSocketCtor, options.url, timeoutMs);
  const socketOpenMs = options.now();
  try {
    const joined = waitForControl(socket, "joined", timeoutMs);
    const joinSentMs = options.now();
    socket.send(
      JSON.stringify({
        t: "join",
        v: PROBE_PROTOCOL_VERSION,
        code: options.code,
        ...options.credential
      })
    );
    const message = await joined;
    const joinedMs = options.now();
    return {
      socket,
      ...requireSlotAndSession(message),
      marks: { socketOpenMs, joinSentMs, joinedMs }
    };
  } catch (error) {
    if (options.socket === void 0) closeQuietly(socket);
    throw error;
  }
}
async function hostRoom(WebSocketCtor, url, code, hostToken, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const socket = await openSocket(WebSocketCtor, url, timeoutMs);
  try {
    const joined = waitForControl(socket, "hostJoined", timeoutMs);
    socket.send(JSON.stringify({ t: "hostJoin", v: PROBE_PROTOCOL_VERSION, code, hostToken }));
    await joined;
    return socket;
  } catch (error) {
    closeQuietly(socket);
    throw error;
  }
}
class ControllerSession {
  constructor(controller, code, WebSocketCtor, url, now) {
    __publicField(this, "controller", controller);
    __publicField(this, "code", code);
    __publicField(this, "WebSocketCtor", WebSocketCtor);
    __publicField(this, "url", url);
    __publicField(this, "now", now);
    __publicField(this, "recoveries", []);
    __publicField(this, "rejoining", null);
  }
  get slot() {
    return this.controller.slot;
  }
  suspend() {
    if (this.controller.socket.readyState !== OPEN) return;
    try {
      this.controller.socket.send(JSON.stringify({ t: "suspend" }));
    } catch {
    }
  }
  rejoin() {
    if (this.rejoining !== null) return this.rejoining;
    const sameSocket = this.controller.socket.readyState === OPEN;
    const attempt = {
      startedAtMs: this.now(),
      joinedAtMs: null,
      path: sameSocket ? "same-socket" : "new-socket",
      expectedSlot: this.controller.slot,
      slot: null,
      error: null
    };
    this.recoveries.push(attempt);
    const options = {
      WebSocketCtor: this.WebSocketCtor,
      url: this.url,
      code: this.code,
      credential: { session: this.controller.session },
      now: this.now
    };
    if (sameSocket) options.socket = this.controller.socket;
    else closeQuietly(this.controller.socket);
    this.rejoining = joinController(options).then((joined) => {
      attempt.joinedAtMs = joined.marks.joinedMs;
      attempt.slot = joined.slot;
      this.controller = joined;
    }).catch((error) => {
      attempt.error = errorMessage(error);
    }).then(() => {
      this.rejoining = null;
    });
    return this.rejoining;
  }
  /** Sends `leave` and closes, freeing the slot immediately. */
  leave() {
    if (this.controller.socket.readyState === OPEN) {
      try {
        this.controller.socket.send(JSON.stringify({ t: "leave" }));
      } catch {
      }
    }
    closeQuietly(this.controller.socket);
  }
}
function persistedOf(event) {
  if (typeof event === "object" && event !== null && "persisted" in event) {
    const persisted = event.persisted;
    return typeof persisted === "boolean" ? persisted : void 0;
  }
  return void 0;
}
function recordLifecycle(scope, now, hooks = {}) {
  const events = [];
  scope.document.addEventListener("visibilitychange", () => {
    var _a, _b;
    const hidden = scope.document.visibilityState === "hidden";
    events.push({ type: hidden ? "hidden" : "visible", atMs: now() });
    if (hidden) (_a = hooks.onHidden) == null ? void 0 : _a.call(hooks);
    else (_b = hooks.onVisible) == null ? void 0 : _b.call(hooks);
  });
  scope.document.addEventListener("freeze", () => events.push({ type: "freeze", atMs: now() }));
  scope.document.addEventListener("resume", () => events.push({ type: "resume", atMs: now() }));
  for (const type of ["pagehide", "pageshow"]) {
    scope.window.addEventListener(type, (event) => {
      const entry = { type, atMs: now() };
      const persisted = persistedOf(event);
      if (persisted !== void 0) entry.persisted = persisted;
      events.push(entry);
    });
  }
  return events;
}
export {
  ControllerSession,
  DEFAULT_PONG_GRACE_MS,
  PING_FRAME_BYTES,
  PING_TYPE,
  PONG_FRAME_BYTES,
  PONG_TYPE,
  closeQuietly,
  decodeProbePong,
  encodeProbePing,
  hostRoom,
  joinController,
  openSocket,
  recordLifecycle,
  runPingSeries
};
