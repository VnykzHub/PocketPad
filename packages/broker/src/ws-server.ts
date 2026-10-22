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
  MAX_LAYOUT_JSON_FRAME_BYTES,
  MSG,
  PROTOCOL_VERSION,
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
import { StatsTicker } from "./room/stats.js";

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
  /**
   * Stats tick interval. Defaults to `STATS_INTERVAL_MS` (1 s, FR-7.14);
   * tests shrink it so the stream is observable without sleeping.
   */
  statsIntervalMs?: number;
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
 * - `maxPayload` is the setLayout JSON cap (A13). `parseJsonMessage` still
 *   enforces the 4 KB cap for every other JSON type, so a 4.1 KB panel or
 *   event closes with 1009. Binary frames over 64 bytes close with 1009.
 * - Heartbeat: ping every `heartbeatMs`, terminate after `deadAfterMs` of
 *   silence (FR-7.14).
 */
export function attachWebSocketServer(server: Server, deps: WsServerDeps): WebSocketServer {
  const { registry, config, logger } = deps;

  /*
   * D4-SRV-03: telemetry is owned by the registry so the adapter and the
   * registry agree on slot records; the ticker is transport-owned because its
   * lifetime is the host socket's.
   */
  const stats = registry.statsCollector();
  const statsTicker = new StatsTicker({
    collector: stats,
    now: () => registry.nowMs(),
    ...(deps.statsIntervalMs === undefined ? {} : { intervalMs: deps.statsIntervalMs }),
  });
  const unsubscribeRoomExpired = registry.onRoomExpired((room) => {
    statsTicker.stop(room);
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_LAYOUT_JSON_FRAME_BYTES,
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
      // A server frame should never exceed its per-type cap. If it somehow
      // does, close instead of emitting a frame the peer must reject.
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
        // D6-SRV-01: the D0 codec validates type/length/n/slot. The registry
        // applies the per-slot 20 Hz limit and never logs pattern content.
        const { slot, durationsMs } = decodeHapticCmd(bytes);
        registry.routeHaptic(state.code, slot, durationsMs);
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
        // A suspended controller may rejoin on the same socket with its
        // session (FR-8.8); any other second join is a policy violation.
        const sameSocketRejoin = state.role === "controller" && message.session !== undefined;
        if (state.role === "controller" && !sameSocketRejoin) {
          closeSocket(socket, CLOSE.policy, "socket is already joined");
          return;
        }
        // A10: protocol version mismatch is reported, not fatal (FR-5.6).
        if (message.v !== PROTOCOL_VERSION) {
          sendMessage(peer, { t: "joinError", reason: "badVersion" });
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
          // D5-SRV-01: replay the stored layout/panel after `joined` so a
          // rejoin recovers without a host resend and never sees state before
          // it considers itself joined.
          registry.replayChannelState(message.code, result.slot);
        } else {
          if (sameSocketRejoin) {
            // The reservation lapsed (or the session is unknown): unbind the
            // socket so the client can fall back to a token/PIN join.
            state.role = "unbound";
            state.code = null;
            state.slot = null;
          }
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
        // A10: the host learns about a version mismatch the same way.
        if (message.v !== PROTOCOL_VERSION) {
          sendMessage(peer, { t: "joinError", reason: "badVersion" });
          return;
        }
        const result = registry.hostJoin(message.code, message.hostToken, peer);
        if (result.ok) {
          state.role = "host";
          state.code = message.code;
          state.slot = null;
          // FR-7.14: the 1 Hz stats stream runs while a host is attached.
          const room = registry.getRoom(message.code);
          if (room !== undefined) {
            statsTicker.start(room);
          }
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
      case "suspend": {
        if (state.role !== "controller" || state.code === null || state.slot === null) {
          closeSocket(socket, CLOSE.policy, `${message.t} requires a joined controller`);
          return;
        }
        // FR-8.8: hold the slot for 30 s and tell the host (FR-5.4). The peer
        // guard keeps a stale socket from detaching a newer one.
        registry.suspend(state.code, state.slot, registry.nowMs(), peer);
        return;
      }
      case "layoutAck": {
        if (state.role !== "controller" || state.code === null || state.slot === null) {
          closeSocket(socket, CLOSE.policy, `${message.t} requires a joined controller`);
          return;
        }
        // D5-SRV-01: never trust a controller-supplied slot; the authenticated
        // peer slot is filled in when forwarding to the host.
        registry.routeLayoutAck(state.code, state.slot, message.layoutId);
        return;
      }
      case "event": {
        if (state.role !== "controller" || state.code === null || state.slot === null) {
          closeSocket(socket, CLOSE.policy, `${message.t} requires a joined controller`);
          return;
        }
        // D5-SRV-01: the registry compares `message.slot` with the
        // authenticated slot, applies the 30/s burst-60 limit and forwards the
        // body unchanged.
        registry.routeEvent(state.code, state.slot, message);
        return;
      }
      case "hostPause": {
        if (state.role !== "host" || state.code === null) {
          closeSocket(socket, CLOSE.policy, `${message.t} requires a host connection`);
          return;
        }
        if (registry.hostPause(state.code, peer)) {
          // Idempotent repeats still count as host activity (FR-5.2).
          registry.noteActivity(state.code, registry.nowMs());
        }
        return;
      }
      case "hostResume": {
        if (state.role !== "host" || state.code === null) {
          closeSocket(socket, CLOSE.policy, `${message.t} requires a host connection`);
          return;
        }
        if (registry.hostResume(state.code, peer)) {
          registry.noteActivity(state.code, registry.nowMs());
        }
        return;
      }
      case "setLayout":
      case "panel": {
        if (state.role !== "host" || state.code === null) {
          closeSocket(socket, CLOSE.policy, `${message.t} requires a host connection`);
          return;
        }
        if (message.t === "setLayout") {
          // D5-SRV-01: opaque body; the registry records the last layout for
          // rejoin and fans out only to the requested slot(s).
          registry.setLayout(state.code, message.slot, message.layout);
        } else {
          // D5-SRV-01: private to the addressed slot; never echoed to the host.
          registry.setPanel(state.code, message.slot, message.content);
        }
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
      const now = registry.nowMs();
      state.lastSeenAt = now;
      // FR-7.14: the pong closes the RTT sample opened by the heartbeat ping.
      if (state.role === "controller" && state.code !== null && state.slot !== null) {
        const room = registry.getRoom(state.code);
        if (room !== undefined) {
          stats.recordPong(room, state.slot, now);
        }
      }
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
        // FR-7.14: a dropped socket reserves the slot for 30 s instead of
        // freeing it (FR-5.5 applies only to an explicit `leave`).
        registry.detach(state.code, state.slot, registry.nowMs(), peer);
      } else if (state.role === "host" && state.code !== null) {
        const room = registry.getRoom(state.code);
        // D4-SRV-03: host loss starts the 30 s recovery window and broadcasts
        // `hostStatus lost`; the stats stream stops until the host returns.
        if (registry.hostLeave(state.code, peer) && room !== undefined) {
          statsTicker.stop(room);
        }
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
        // Record the ping before sending so the pong maps to this sample.
        if (state.role === "controller" && state.code !== null && state.slot !== null) {
          const room = registry.getRoom(state.code);
          if (room !== undefined) {
            stats.recordPing(room, state.slot, now);
          }
        }
        socket.ping();
      }
    }
  }, config.heartbeatMs);
  heartbeat.unref?.();

  wss.on("close", () => {
    clearInterval(heartbeat);
    unsubscribeRoomExpired();
    statsTicker.stopAll();
    server.off("upgrade", handleUpgrade);
  });

  return wss;
}
