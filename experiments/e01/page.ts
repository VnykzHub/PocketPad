/**
 * E1 — TV browser capability probe page (D1-EXP-02).
 *
 * The checks are declared here but run only from the shared Run button. The
 * Web Audio check is first so its AudioContext is constructed inside the
 * click's user-activation window. Every check is wrapped by `runChecks()` in
 * `../shared/probe.js`, so a failure produces a table row and a JSON entry
 * instead of aborting the probe.
 *
 * The user agent is read exactly once, in the `user-agent` check, purely as a
 * recorded value. No capability in this file branches on it (FR-12.1).
 */

import {
  detectAudioContext,
  detectDeviceMemory,
  detectHardwareConcurrency,
  detectWakeLock,
  detectWebGL2,
  detectWebRTC,
  mountProbePage,
  ProbeError,
  type CanvasLike,
  type DeviceMemoryScope,
  type ProbeCheck,
  type WebGL2Info,
} from "../shared/probe.js";
import {
  classifyCompressedExtensions,
  createProbeRoom,
  e1TvOnlyViable,
  INPUT_FRAME_BYTES,
  INPUT_FWD_FRAME_BYTES,
  measureAnimationFrameRate,
  measureBinaryWebSocket,
  PROBE_PROTOCOL_VERSION,
  probeAudioContext,
  probeWebSocketUrl,
  RAF_SAMPLE_FRAMES,
  type AudioContextConstructor,
  type WebSocketConstructor,
} from "./probe.js";

interface ProbeWindow {
  AudioContext?: AudioContextConstructor;
  webkitAudioContext?: AudioContextConstructor;
}

const probeWindow = window as unknown as ProbeWindow;

let glInfo: WebGL2Info | null = null;
let webgl2Available = false;
let binaryWebSocketMeasured = false;

function requireGlInfo(): WebGL2Info {
  if (glInfo === null) {
    throw new ProbeError("WebGL2 is unavailable; see the WebGL2 check for the error");
  }
  return glInfo;
}

function audioContextConstructor(): AudioContextConstructor | null {
  return probeWindow.AudioContext ?? probeWindow.webkitAudioContext ?? null;
}

const checks: readonly ProbeCheck[] = [
  {
    id: "web-audio",
    label: "Web Audio: state after the Run gesture",
    run: async () => {
      if (!detectAudioContext(probeWindow)) {
        throw new ProbeError("Web Audio is unavailable: no AudioContext constructor");
      }
      const ContextCtor = audioContextConstructor();
      if (ContextCtor === null) {
        throw new ProbeError("Web Audio is unavailable: no usable AudioContext constructor");
      }
      return probeAudioContext(ContextCtor);
    },
  },
  {
    id: "probe-configuration",
    label: "Probe path (records which binary WebSocket route was used)",
    run: () => ({
      binaryWebSocketPath: "existing /ws room flow (host + controller sockets)",
      inputFrameBytes: INPUT_FRAME_BYTES,
      expectedEchoBytes: INPUT_FWD_FRAME_BYTES,
      protocolVersion: PROBE_PROTOCOL_VERSION,
    }),
  },
  {
    id: "webgl2",
    label: "WebGL2 present + context attributes",
    run: () => {
      webgl2Available = false;
      glInfo = null;
      const canvas = document.createElement("canvas");
      glInfo = detectWebGL2(canvas as unknown as CanvasLike);
      webgl2Available = true;
      return {
        supported: true,
        contextAttributes: glInfo.contextAttributes,
      };
    },
  },
  {
    id: "max-texture-size",
    label: "GL MAX_TEXTURE_SIZE",
    run: () => {
      const info = requireGlInfo();
      if (info.maxTextureSize === null) {
        throw new ProbeError("WebGL2 did not report MAX_TEXTURE_SIZE");
      }
      return info.maxTextureSize;
    },
  },
  {
    id: "compressed-textures",
    label: "Compressed texture extensions (exact list)",
    run: () => classifyCompressedExtensions(requireGlInfo().extensions),
  },
  {
    id: "binary-websocket",
    label: "Binary WebSocket round trip (/ws room flow, Input -> InputFwd)",
    run: async () => {
      binaryWebSocketMeasured = false;
      if (typeof window.WebSocket !== "function") {
        throw new ProbeError("WebSocket constructor is unavailable");
      }
      const result = await measureBinaryWebSocket({
        createRoom: () => createProbeRoom(),
        WebSocketCtor: window.WebSocket as unknown as WebSocketConstructor,
        url: probeWebSocketUrl(window.location),
        now: () => performance.now(),
      });
      binaryWebSocketMeasured = true;
      return {
        path: result.path,
        roundTripMs: result.roundTripMs,
        slot: result.slot,
        echoType: result.echoType,
        echoBytes: result.echoBytes,
        fieldsMatched: result.fieldsMatched,
      };
    },
  },
  {
    id: "webrtc",
    label: "RTCPeerConnection present (not used in v1)",
    run: () => detectWebRTC(window),
  },
  {
    id: "raf-rate",
    label: `requestAnimationFrame rate over ${RAF_SAMPLE_FRAMES} frames`,
    run: () => {
      if (typeof window.requestAnimationFrame !== "function") {
        throw new ProbeError("requestAnimationFrame is unavailable");
      }
      return measureAnimationFrameRate(
        (callback) => window.requestAnimationFrame(callback),
        RAF_SAMPLE_FRAMES,
      );
    },
  },
  {
    id: "wake-lock",
    label: "Wake Lock API present",
    run: () => detectWakeLock(navigator),
  },
  {
    id: "device-memory",
    label: "navigator.deviceMemory (GB; null means unknown)",
    run: () => detectDeviceMemory(navigator as unknown as DeviceMemoryScope),
  },
  {
    id: "hardware-concurrency",
    label: "navigator.hardwareConcurrency",
    run: () => detectHardwareConcurrency(navigator),
  },
  {
    id: "screen-dpr",
    label: "Screen and devicePixelRatio",
    run: () => ({
      width: window.screen.width,
      height: window.screen.height,
      availWidth: window.screen.availWidth,
      availHeight: window.screen.availHeight,
      colorDepth: window.screen.colorDepth,
      devicePixelRatio: window.devicePixelRatio,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    }),
  },
  {
    id: "user-agent",
    label: "User agent string (recorded only, never used for capability)",
    run: () => navigator.userAgent,
  },
  {
    id: "tv-only-criterion",
    label: "G6 TV-only pass criterion: WebGL2 + binary WebSocket",
    run: () => {
      if (!e1TvOnlyViable(webgl2Available, binaryWebSocketMeasured)) {
        throw new ProbeError(
          `TV-only criterion not met: WebGL2=${webgl2Available ? "yes" : "no"}, binary WebSocket=${binaryWebSocketMeasured ? "yes" : "no"}`,
        );
      }
      return {
        viable: true,
        criterion: "WebGL2 and binary WebSocket both present",
      };
    },
  },
];

function required(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`E1 probe markup is missing #${id}`);
  }
  return element;
}

const table = required("results");
const tableHost = table as HTMLTableElement;

mountProbePage({
  experiment: "E1",
  title: "TV browser capabilities",
  checks,
  elements: {
    runButton: required("run") as HTMLButtonElement,
    copyButton: required("copy") as HTMLButtonElement,
    tableHost,
    jsonHost: required("json"),
    statusHost: required("status"),
  },
});
