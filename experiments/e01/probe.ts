/**
 * E1 — TV browser capability probe helpers (D1-EXP-02).
 *
 * Everything here is either pure (frame codecs, texture classification, frame
 * interval math) or takes its browser surface as an injected argument, so the
 * Node tests can fake the browser without a DOM. `page.ts` supplies the real
 * `window`/`navigator` values and is the only place that reads the user agent.
 *
 * The binary WebSocket check deliberately uses the existing `/ws` room flow:
 * create a room with `POST /api/rooms`, host it with the host token, join it
 * with the PIN, send one 26-byte `Input`, and wait for the 27-byte `InputFwd`
 * echo on the host socket. No dev-only echo endpoint is added and the
 * production Origin checks and frame caps are untouched.
 */

import { ProbeError, errorMessage } from "../shared/probe.js";

/** Input frame size including the type byte: 1 + 25 = 26. */
export const INPUT_FRAME_BYTES = 26;
/** InputFwd frame size including type and slot bytes: 1 + 1 + 25 = 27. */
export const INPUT_FWD_FRAME_BYTES = 27;
/** Frozen wire type bytes (packages/protocol/src/constants.ts). */
export const INPUT_TYPE = 0x02;
export const INPUT_FWD_TYPE = 0xb2;
/** JSON wire version the dev server validates; probe pages cannot import packages. */
export const PROBE_PROTOCOL_VERSION = 1;
/** rAF samples required by D1-EXP-02. */
export const RAF_SAMPLE_FRAMES = 120;

const MAX_PROBE_SLOT = 8;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RAF_TIMEOUT_MS = 12_000;

/* ------------------------------------------------------------------ */
/* Input / InputFwd codecs (throwaway copies for the probe)            */
/* ------------------------------------------------------------------ */

export interface ProbeInputFields {
  tick: number;
  buttons: number;
  edges: number;
}

export interface ProbeEchoFrame extends ProbeInputFields {
  slot: number;
  byteLength: number;
}

/**
 * Builds one 26-byte Input frame. The body stays zero except the three fields
 * the echo check compares, which keeps the probe independent of the game
 * input state. Fields are little-endian, matching the frozen wire contract.
 */
export function encodeProbeInput(tick = 0, buttons = 0, edges = 0): Uint8Array {
  const frame = new Uint8Array(INPUT_FRAME_BYTES);
  const view = new DataView(frame.buffer);
  frame[0] = INPUT_TYPE;
  view.setUint32(1, tick >>> 0, true);
  view.setUint16(5, buttons & 0xffff, true);
  view.setUint16(7, edges & 0xffff, true);
  return frame;
}

function readInputFields(frame: Uint8Array): ProbeInputFields {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return {
    tick: view.getUint32(1, true),
    buttons: view.getUint16(5, true),
    edges: view.getUint16(7, true),
  };
}

/** Validates and decodes the 27-byte `InputFwd` frame the host receives. */
export function decodeInputFwdFrame(frame: Uint8Array): ProbeEchoFrame {
  if (!(frame instanceof Uint8Array)) {
    throw new ProbeError("InputFwd echo must be a Uint8Array");
  }
  if (frame.byteLength !== INPUT_FWD_FRAME_BYTES) {
    throw new ProbeError(
      `InputFwd echo is ${frame.byteLength} bytes; expected ${INPUT_FWD_FRAME_BYTES}`,
    );
  }
  if (frame[0] !== INPUT_FWD_TYPE) {
    throw new ProbeError(
      `InputFwd echo has type byte 0x${(frame[0] ?? 0).toString(16)}; expected 0x${INPUT_FWD_TYPE.toString(16)}`,
    );
  }
  const slot = frame[1] ?? 0;
  if (slot < 1 || slot > MAX_PROBE_SLOT) {
    throw new ProbeError(`InputFwd echo slot ${slot} is outside 1..${MAX_PROBE_SLOT}`);
  }
  return { slot, ...readInputFields(frame.subarray(1)), byteLength: frame.byteLength };
}

/* ------------------------------------------------------------------ */
/* Compressed texture extensions                                       */
/* ------------------------------------------------------------------ */

export interface CompressedTextureSupport {
  astc: boolean;
  etc: boolean;
  etc1: boolean;
  s3tc: boolean;
  bptc: boolean;
  /** Every supported extension whose name mentions a compressed format. */
  extensions: string[];
}

const COMPRESSED_NAME = /compress|astc|bptc/i;

const ASTC_EXTENSIONS = [
  "WEBGL_compressed_texture_astc",
  "WEBKIT_WEBGL_compressed_texture_astc",
] as const;
const ETC_EXTENSIONS = ["WEBGL_compressed_texture_etc"] as const;
const ETC1_EXTENSIONS = ["WEBGL_compressed_texture_etc1"] as const;
const S3TC_EXTENSIONS = [
  "WEBGL_compressed_texture_s3tc",
  "WEBGL_compressed_texture_s3tc_srgb",
] as const;
const BPTC_EXTENSIONS = ["EXT_texture_compression_bptc"] as const;

function hasAny(supported: ReadonlySet<string>, names: readonly string[]): boolean {
  return names.some((name) => supported.has(name));
}

/**
 * Reports exactly which compressed formats the context advertises. ASTC does
 * not imply KTX2: the Basis transcoder may still be needed, so no `ktx2` field
 * exists here.
 */
export function classifyCompressedExtensions(
  extensions: readonly string[],
): CompressedTextureSupport {
  const supported = new Set(extensions);
  return {
    astc: hasAny(supported, ASTC_EXTENSIONS),
    etc: hasAny(supported, ETC_EXTENSIONS),
    etc1: hasAny(supported, ETC1_EXTENSIONS),
    s3tc: hasAny(supported, S3TC_EXTENSIONS),
    bptc: hasAny(supported, BPTC_EXTENSIONS),
    extensions: extensions.filter((name) => COMPRESSED_NAME.test(name)),
  };
}

/* ------------------------------------------------------------------ */
/* requestAnimationFrame rate                                          */
/* ------------------------------------------------------------------ */

export interface FrameRateSummary {
  frames: number;
  meanIntervalMs: number;
  hz: number;
  minIntervalMs: number;
  maxIntervalMs: number;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Mean rAF interval, converted to Hz. Throws on empty or non-positive samples. */
export function summarizeFrameIntervals(intervals: readonly number[]): FrameRateSummary {
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
    hz: round(1000 / meanIntervalMs, 1),
    minIntervalMs: round(min, 1),
    maxIntervalMs: round(max, 1),
  };
}

export type RequestFrame = (callback: (timestamp: number) => void) => number;

/**
 * Collects `frames` intervals from `requestAnimationFrame`. A hidden tab may
 * stop delivering frames; the timeout turns that into a readable probe error
 * instead of a stuck Run button.
 */
export function measureAnimationFrameRate(
  requestFrame: RequestFrame,
  frames = RAF_SAMPLE_FRAMES,
  timeoutMs = DEFAULT_RAF_TIMEOUT_MS,
): Promise<FrameRateSummary> {
  if (!Number.isInteger(frames) || frames < 2) {
    throw new ProbeError(`frames must be an integer >= 2; got ${String(frames)}`);
  }
  return new Promise<FrameRateSummary>((resolve, reject) => {
    const timestamps: number[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(
        new ProbeError(
          `requestAnimationFrame produced ${Math.max(0, timestamps.length - 1)}/${frames} intervals within ${timeoutMs} ms; keep the tab visible`,
        ),
      );
    }, timeoutMs);

    const onFrame = (timestamp: number): void => {
      if (settled) return;
      timestamps.push(timestamp);
      if (timestamps.length <= frames) {
        requestFrame(onFrame);
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        const intervals: number[] = [];
        for (let index = 1; index < timestamps.length; index += 1) {
          const current = timestamps[index];
          const previous = timestamps[index - 1];
          if (current === undefined || previous === undefined) continue;
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

/* ------------------------------------------------------------------ */
/* Web Audio                                                           */
/* ------------------------------------------------------------------ */

export interface AudioContextLike {
  state: string;
  sampleRate: number;
  baseLatency?: number;
  resume(): Promise<void>;
  close?(): Promise<void>;
}

export type AudioContextConstructor = new () => AudioContextLike;

export interface AudioProbeMeasurement {
  initialState: string;
  finalState: string;
  sampleRate: number;
  baseLatencyMs: number | null;
  resumeAttempted: boolean;
  resumeError: string | null;
}

/**
 * Constructs an AudioContext, which the caller must do from a user gesture.
 * A suspended context gets one bounded `resume()` attempt. The measurement
 * records both states so a TV that needs a second gesture is visible in the
 * table instead of being reported as a plain boolean.
 */
export async function probeAudioContext(
  ContextCtor: AudioContextConstructor,
  resumeTimeoutMs = 1000,
): Promise<AudioProbeMeasurement> {
  const context = new ContextCtor();
  const initialState = context.state;
  let finalState = initialState;
  let resumeAttempted = false;
  let resumeError: string | null = null;

  try {
    if (initialState === "suspended") {
      resumeAttempted = true;
      try {
        await Promise.race([
          context.resume(),
          new Promise<void>((_resolve, reject) => {
            setTimeout(
              () => reject(new ProbeError(`AudioContext.resume() did not settle within ${resumeTimeoutMs} ms`)),
              resumeTimeoutMs,
            );
          }),
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
      baseLatencyMs:
        typeof context.baseLatency === "number" && Number.isFinite(context.baseLatency)
          ? round(context.baseLatency * 1000, 2)
          : null,
      resumeAttempted,
      resumeError,
    };
  } finally {
    try {
      await context.close?.();
    } catch {
      // Closing a context on a TV browser can reject; the measurement is done.
    }
  }
}

/* ------------------------------------------------------------------ */
/* Binary WebSocket round-trip through the existing room flow          */
/* ------------------------------------------------------------------ */

export interface ProbeRoomCredentials {
  code: string;
  pin: string;
  hostToken: string;
}

export interface WebSocketLike {
  binaryType: string;
  readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

export type WebSocketConstructor = new (url: string) => WebSocketLike;

export interface BinaryWebSocketOptions {
  /** Creates a fresh room through `POST /api/rooms`. */
  createRoom: () => Promise<ProbeRoomCredentials>;
  WebSocketCtor: WebSocketConstructor;
  /** Same-origin `/ws` URL derived from `location`. */
  url: string;
  now?: () => number;
  timeoutMs?: number;
  /** 26-byte Input frame; defaults to a tick/button pattern the echo can verify. */
  input?: Uint8Array;
}

export interface BinaryWebSocketMeasurement {
  path: "existing /ws room flow";
  requestBytes: number;
  echoBytes: number;
  echoType: "InputFwd";
  slot: number;
  roundTripMs: number;
  fieldsMatched: boolean;
}

export interface LocationLike {
  protocol: string;
  host: string;
}

/** Builds `ws(s)://<current host>/ws`; never uses a hard-coded origin. */
export function probeWebSocketUrl(location: LocationLike): string {
  if (location.host.length === 0) {
    throw new ProbeError("Open this page from the dev server, not from file://");
  }
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/ws`;
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (input: string, init?: { method?: string }) => Promise<FetchResponseLike>;

function isCredentials(value: unknown): value is ProbeRoomCredentials {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["code"] === "string" &&
    typeof record["pin"] === "string" &&
    typeof record["hostToken"] === "string"
  );
}

/**
 * `POST /api/rooms` on the current origin. The tokens and PIN stay in memory
 * for the round-trip and are never copied into the result JSON.
 */
export async function createProbeRoom(fetchImpl: FetchLike = fetch): Promise<ProbeRoomCredentials> {
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

function eventData(event: unknown): unknown {
  if (typeof event === "object" && event !== null && "data" in event) {
    return (event as { data?: unknown }).data;
  }
  return undefined;
}

function bytesOf(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new ProbeError(`expected binary WebSocket data; got ${typeof data}`);
}

function textOf(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return null;
}

interface ControlMessage {
  t?: unknown;
  slot?: unknown;
  reason?: unknown;
}

function controlMatcher(
  expected: "hostJoined" | "joined",
  label: string,
): (data: unknown) => ControlMessage | undefined {
  return (data) => {
    const text = textOf(data);
    if (text === null) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return undefined;
    }
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const message = parsed as ControlMessage;
    if (message.t === "joinError") {
      const reason = typeof message.reason === "string" ? message.reason : "unknown reason";
      throw new ProbeError(`${label} was rejected: ${reason}`);
    }
    return message.t === expected ? message : undefined;
  };
}

function openSocket(
  WebSocketCtor: WebSocketConstructor,
  url: string,
  timeoutMs: number,
): Promise<WebSocketLike> {
  return new Promise<WebSocketLike>((resolve, reject) => {
    let socket: WebSocketLike;
    try {
      socket = new WebSocketCtor(url);
    } catch (error) {
      reject(new ProbeError(`WebSocket construction failed: ${errorMessage(error)}`));
      return;
    }
    socket.binaryType = "arraybuffer";

    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
    };
    const finish = (error: ProbeError | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === null) {
        resolve(socket);
      } else {
        reject(error);
      }
    };
    const onOpen = (): void => finish(null);
    const onError = (): void =>
      finish(
        new ProbeError(
          "WebSocket failed before opening; use a dev-server URL whose Origin is allowed",
        ),
      );
    const timer = setTimeout(
      () => finish(new ProbeError(`WebSocket did not open within ${timeoutMs} ms`)),
      timeoutMs,
    );
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
  });
}

function waitForMessage<T>(
  socket: WebSocketLike,
  label: string,
  timeoutMs: number,
  match: (data: unknown) => T | undefined,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };
    const fail = (error: ProbeError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onMessage = (event: unknown): void => {
      if (settled) return;
      let matched: T | undefined;
      try {
        matched = match(eventData(event));
      } catch (error) {
        fail(error instanceof ProbeError ? error : new ProbeError(errorMessage(error)));
        return;
      }
      if (matched === undefined) return;
      settled = true;
      cleanup();
      resolve(matched);
    };
    const onError = (): void => fail(new ProbeError(`WebSocket error while waiting for ${label}`));
    const onClose = (): void => fail(new ProbeError(`WebSocket closed before ${label} arrived`));
    const timer = setTimeout(
      () => fail(new ProbeError(`timed out after ${timeoutMs} ms waiting for ${label}`)),
      timeoutMs,
    );
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
  });
}

function closeQuietly(socket: WebSocketLike | null): void {
  if (socket === null) return;
  try {
    socket.close();
  } catch {
    // A socket that failed to open or already closed needs no cleanup.
  }
}

function defaultNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * Measures one binary round-trip against the real `/ws` room flow:
 * host socket + controller socket in a freshly created room, one Input frame,
 * and the InputFwd echo received by the host. The returned object deliberately
 * excludes the room code, PIN and tokens.
 */
export async function measureBinaryWebSocket(
  options: BinaryWebSocketOptions,
): Promise<BinaryWebSocketMeasurement> {
  const now = options.now ?? defaultNow;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const input = options.input ?? encodeProbeInput(0x01020304, 0x0001, 0x0001);
  if (input.byteLength !== INPUT_FRAME_BYTES || input[0] !== INPUT_TYPE) {
    throw new ProbeError(
      `probe Input must be ${INPUT_FRAME_BYTES} bytes with type 0x${INPUT_TYPE.toString(16)}`,
    );
  }
  const sentFields = readInputFields(input);

  const credentials = await options.createRoom();
  let host: WebSocketLike | null = null;
  let controller: WebSocketLike | null = null;

  try {
    host = await openSocket(options.WebSocketCtor, options.url, timeoutMs);
    const hostJoined = waitForMessage(
      host,
      "hostJoined",
      timeoutMs,
      controlMatcher("hostJoined", "hostJoin"),
    );
    host.send(
      JSON.stringify({
        t: "hostJoin",
        v: PROBE_PROTOCOL_VERSION,
        code: credentials.code,
        hostToken: credentials.hostToken,
      }),
    );
    await hostJoined;

    controller = await openSocket(options.WebSocketCtor, options.url, timeoutMs);
    const joinedWaiter = waitForMessage(
      controller,
      "joined",
      timeoutMs,
      controlMatcher("joined", "join"),
    );
    controller.send(
      JSON.stringify({
        t: "join",
        v: PROBE_PROTOCOL_VERSION,
        code: credentials.code,
        pin: credentials.pin,
      }),
    );
    const joined = await joinedWaiter;
    if (typeof joined.slot !== "number" || !Number.isInteger(joined.slot)) {
      throw new ProbeError("joined message did not include an integer slot");
    }

    const echoWaiter = waitForMessage(host, "InputFwd echo", timeoutMs, (data) => {
      if (typeof data === "string") return undefined;
      return decodeInputFwdFrame(bytesOf(data));
    });

    const startedAt = now();
    controller.send(input);
    const echo = await echoWaiter;
    const roundTripMs = now() - startedAt;

    if (echo.slot !== joined.slot) {
      throw new ProbeError(
        `InputFwd slot ${echo.slot} does not match the joined slot ${joined.slot}`,
      );
    }

    return {
      path: "existing /ws room flow",
      requestBytes: input.byteLength,
      echoBytes: echo.byteLength,
      echoType: "InputFwd",
      slot: echo.slot,
      roundTripMs: round(roundTripMs, 3),
      fieldsMatched:
        echo.tick === sentFields.tick &&
        echo.buttons === sentFields.buttons &&
        echo.edges === sentFields.edges,
    };
  } finally {
    closeQuietly(controller);
    closeQuietly(host);
  }
}

/* ------------------------------------------------------------------ */
/* E1 pass criterion                                                   */
/* ------------------------------------------------------------------ */

/** G6: a TV-only target is viable only with both WebGL2 and binary WebSocket. */
export function e1TvOnlyViable(webgl2: boolean, binaryWebSocket: boolean): boolean {
  return webgl2 && binaryWebSocket;
}
