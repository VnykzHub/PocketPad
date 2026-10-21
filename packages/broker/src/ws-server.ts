/**
 * WebSocket adapter for the broker (D0-SRV-03).
 *
 * This is transport only: origin allowlist, frame caps, role routing,
 * heartbeat, backpressure and close codes. Room semantics stay in
 * `RoomRegistry`. The same adapter is used by the dev server now and by the
 * production relay in P1 (amendment A1), so nothing dev-only lives here.
 */
import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import {
  MAX_BINARY_FRAME_BYTES,
  MAX_JSON_FRAME_BYTES,
  MSG,
  ProtocolError,
  decodeHapticCmd,
  decodeInputInto,
  decodePing,
  encodePong,
  frameType,
  parseJsonMessage,
  stringifyJsonMessage,
  type InputState,
  type ServerToClientMessage,
} from "@lanpad/protocol";
import type { Logger, Peer } from "./peer.js";
import type { RoomRegistry } from "./registry.js";
import type { JoinRequest } from "./room.js";

/** Application close codes (frozen D0 contract). */
export const CLOSE = {
  /** Binary protocol violation: bad type, bad length, wrong direction. */
  protocol: 1002,
  /** Policy violation: invalid JSON message, wrong role, duplicate join. */
  policy: 1008,
  /** Frame over its cap (SR-6). */
  tooLarge: 1009,
} as const;

export interface WsServerConfig {
  /** Exact origins allowed at the upgrade (SR-11). Never `*`. */
  allowedOrigins: string[];
  /** Dev-only escape hatch for bots that omit `Origin`. */
  allowMissingOrigin: boolean;
  heartbeatMs: number;
  deadAfterMs: number;
  maxBufferedBytes: number;
}

export interface WsServerDeps {
  registry: RoomRegistry;
  config: WsServerConfig;
  logger: Logger;
}

type SocketRole = "unbound" | "controller" | "host";

interface SocketState {
  role: SocketRole;
  code: string | null;
  slot: number | null;
  /** Last pong or inbound frame; drives the 5 s dead check (FR-7.14). */
  lastSeenAt: number;
  /** Input packets dropped because the host was backpressured. */
  dropCount: number;
}

/** `ws` internals: the raw TCP socket is exposed as `_socket` but untyped. */
interface WsInternals {
  _socket?: Socket;
}

function rawSocket(socket: WebSocket): Socket | undefined {
  return (socket as unknown as WsInternals)._socket;
}

/** One `Peer` per socket; the registry never touches `ws` types. */
class SocketPeer implements Peer {
  constructor(private readonly socket: WebSocket) {}

  get bufferedAmount(): number {
    return this.socket.bufferedAmount;
  }

  get remoteAddress(): string {
    return rawSocket(this.socket)?.remoteAddress ?? "unknown";
  }

  send(data: string | Uint8Array): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(data);
    }
  }

  close(code: number, reason: string): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.close(code, reason);
    }
  }
}

function emptyInputState(): InputState {
  return {
    tick: 0,
    buttons: 0,
    edges: 0,
    lx: 0,
    ly: 0,
    rx: 0,
    ry: 0,
    gx: 0,
    gy: 0,
    gz: 0,
    lt: 0,
    rt: 0,
    flags: 0,
  };
}

/** Writes an HTTP error response and drops the socket before the upgrade. */
function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  if (socket.writable) {
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  }
  socket.destroy();
}

function isProtocolError(error: unknown): error is ProtocolError {
  return error instanceof ProtocolError;
}

/**
 * Attaches the broker's WebSocket endpoint at `/ws` to an existing HTTP server.
 *
 * - Upgrades are accepted only on `/ws` (FR-4.4).
 * - `Origin` must be in `allowedOrigins` unless missing and allowed (SR-11).
 * - `maxPayload` is the JSON cap; binary frames over 64 bytes close with 1009.
 * - Heartbeat: ping every `heartbeatMs`, terminate after `deadAfterMs` of
 *   silence (FR-7.14).
 */
export function attachWebSocketServer(server: Server, deps: WsServerDeps): WebSocketServer {
  const { registry, config, logger } = deps;

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_JSON_FRAME_BYTES,
    perMessageDeflate: false,
  });

  const states = new WeakMap<WebSocket, SocketState>();
  /*
   * One reusable state object for the host hot path. JavaScript is
   * single-threaded and `routeInput` never calls back into user code, so the
   * scratch object cannot be re-entered (PR-9.3 groundwork).
   */
  const inputScratch = emptyInputState();

  function closeSocket(socket: WebSocket, code: number, reason: string): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.close(code, reason);
    }
  }

  function sendMessage(peer: Peer, message: ServerToClientMessage): void {
    try {
      peer.send(stringifyJsonMessage(message));
    } catch {
      // A server frame never exceeds the cap in D0. If it somehow does, close
      // instead of emitting a frame the peer must reject.
      peer.close(CLOSE.tooLarge, "server frame too large");
    }
  }

  function handleBinary(socket: WebSocket, state: SocketState, peer: Peer, data: Buffer): void {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (bytes.byteLength > MAX_BINARY_FRAME_BYTES) {
      state.dropCount += 1;
      closeSocket(socket, CLOSE.tooLarge, "binary frame too large");
      return;
    }
    const type = frameType(bytes);
    if (type === null) {
      closeSocket(socket, CLOSE.protocol, "empty binary frame");
      return;
    }

    switch (type) {
      case MSG.Input: {
        if (state.role === "host") {
          closeSocket(socket, CLOSE.protocol, "Input is controller-only");
          return;
        }
        if (state.role !== "controller" || state.code === null || state.slot === null) {
          // Input before a successful join has no slot and is dropped.
          return;
        }
        decodeInputInto(bytes, inputScratch);
        registry.routeInput(state.code, state.slot, inputScratch);
        return;
      }
      case MSG.Ping: {
        const { clientTimeMs } = decodePing(bytes);
        // Clock-sync reply is binary; it does not use the JSON path.
        peer.send(encodePong(clientTimeMs, registry.nowMs()));
        return;
      }
      case MSG.HapticCmd: {
        if (state.role !== "host" || state.code === null) {
          closeSocket(socket, CLOSE.protocol, "HapticCmd is host-only");
          return;
        }
        // Haptic routing lands in D6-SRV-01. Validate the frame, then drop it.
        decodeHapticCmd(bytes);
        return;
      }
      default: {
        closeSocket(socket, CLOSE.protocol, `unexpected binary type 0x${type.toString(16)}`);
      }
    }
  }

  function handleText(socket: WebSocket, state: SocketState, peer: Peer, text: string): void {
    const message = parseJsonMessage(text);

    switch (message.t) {
      case "join": {
        if (state.role === "host") {
          closeSocket(socket, CLOSE.policy, "host cannot join as a controller");
          return;
        }
        if (state.role === "controller") {
          closeSocket(socket, CLOSE.policy, "socket is already joined");
          return;
        }
        const request: JoinRequest = { code: message.code };
        if (message.token !== undefined) request.token = message.token;
        if (message.pin !== undefined) request.pin = message.pin;
        if (message.session !== undefined) request.session = message.session;
        if (message.name !== undefined) request.name = message.name;

        const result = registry.join(request, peer);
        if (result.ok) {
          state.role = "controller";
          state.code = message.code;
          state.slot = result.slot;
          sendMessage(peer, {
            t: "joined",
            slot: result.slot,
            session: result.session,
            serverTime: result.serverTime,
          });
        } else {
          // Keep the socket open so the client can correct the PIN (FR-5.6).
          sendMessage(peer, { t: "joinError", reason: result.reason });
        }
        return;
      }
      case "hostJoin": {
        if (state.role === "controller") {
          closeSocket(socket, CLOSE.policy, "controller cannot hostJoin");
          return;
        }
        const result = registry.hostJoin(message.code, message.hostToken, peer);
        if (result.ok) {
          state.role = "host";
          state.code = message.code;
          state.slot = null;
          sendMessage(peer, {
            t: "hostJoined",
            code: message.code,
            serverTime: registry.nowMs(),
          });
        } else {
          sendMessage(peer, { t: "joinError", reason: result.reason });
        }
        return;
      }
      case "leave": {
        if (state.role !== "controller") {
          closeSocket(socket, CLOSE.policy, "leave is controller-only");
          return;
        }
        if (state.code !== null && state.slot !== null) {
          registry.leave(state.code, state.slot, peer);
        }
        state.role = "unbound";
        state.code = null;
        state.slot = null;
        return;
      }
      case "suspend":
      case "event": {
        if (state.role !== "controller" || state.code === null || state.slot === null) {
          closeSocket(socket, CLOSE.policy, `${message.t} requires a joined controller`);
          return;
        }
        // Suspend reservations (D4) and event routing (D5) are not in D0.
        return;
      }
      case "hostPause":
      case "hostResume":
      case "setLayout":
      case "panel": {
        if (state.role !== "host" || state.code === null) {
          closeSocket(socket, CLOSE.policy, `${message.t} requires a host connection`);
          return;
        }
        // Host pause (D4) and layout/panel routing (D5) are not in D0.
        return;
      }
      default: {
        // Server-to-client variants arriving from a peer are a protocol error.
        closeSocket(socket, CLOSE.policy, `unexpected message type ${message.t}`);
      }
    }
  }

  wss.on("connection", (socket, request) => {
    // PR-6.1: ws exposes the raw TCP socket as `_socket`; disable Nagle.
    rawSocket(socket)?.setNoDelay(true);

    const peer = new SocketPeer(socket);
    const state: SocketState = {
      role: "unbound",
      code: null,
      slot: null,
      lastSeenAt: registry.nowMs(),
      dropCount: 0,
    };
    states.set(socket, state);

    // Logging counters only; headers, query strings and message bodies are
    // never logged (SR-9).
    logger.debug?.("ws.connection", { connections: wss.clients.size });

    socket.on("pong", () => {
      state.lastSeenAt = registry.nowMs();
    });

    socket.on("message", (data, isBinary) => {
      state.lastSeenAt = registry.nowMs();
      try {
        if (isBinary) {
          handleBinary(socket, state, peer, data as Buffer);
        } else {
          handleText(socket, state, peer, data.toString());
        }
      } catch (error) {
        if (isProtocolError(error)) {
          const code =
            error.code === "tooLarge" ? CLOSE.tooLarge : isBinary ? CLOSE.protocol : CLOSE.policy;
          closeSocket(socket, code, error.message);
          return;
        }
        logger.debug?.("ws.error", { connections: wss.clients.size });
        closeSocket(socket, 1011, "internal error");
      }
    });

    socket.on("error", () => {
      // ws emits `error` for receiver failures such as the maxPayload close.
      // It closes the socket itself; nothing here may throw.
      logger.debug?.("ws.error", { connections: wss.clients.size });
    });

    socket.on("close", (code) => {
      states.delete(socket);
      if (state.role === "controller" && state.code !== null && state.slot !== null) {
        registry.leave(state.code, state.slot, peer);
      } else if (state.role === "host" && state.code !== null) {
        registry.hostLeave(state.code, peer);
      }
      // Log the close code only; close reasons can contain client-supplied text.
      logger.debug?.("ws.close", { code });
    });

    // `request` is unused in D0; query strings and headers are never logged.
    void request;
  });

  function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }

    const origin = request.headers.origin;
    if (origin === undefined || origin === "") {
      if (!config.allowMissingOrigin) {
        rejectUpgrade(socket, 403, "Forbidden");
        return;
      }
    } else if (!config.allowedOrigins.includes(origin)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  }

  server.on("upgrade", handleUpgrade);

  const heartbeat = setInterval(() => {
    const now = registry.nowMs();
    for (const socket of wss.clients) {
      const state = states.get(socket);
      if (!state) continue;
      if (now - state.lastSeenAt >= config.deadAfterMs) {
        socket.terminate();
        continue;
      }
      if (socket.readyState === WebSocket.OPEN) {
        socket.ping();
      }
    }
  }, config.heartbeatMs);
  heartbeat.unref?.();

  wss.on("close", () => {
    clearInterval(heartbeat);
    server.off("upgrade", handleUpgrade);
  });

  return wss;
}
