import { beforeEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@lanpad/protocol";
import {
  createSessionStore,
  type SessionStore,
  type StorageLike,
} from "../src/join/sessionStore.js";
import {
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  SERVER_SILENCE_TIMEOUT_MS,
  createReconnectController,
  reconnectDelayMs,
  type ReconnectController,
  type ReconnectJoin,
  type ReconnectState,
  type ReconnectStopReason,
  type ReconnectTimers,
} from "../src/net/reconnect.js";
import {
  ConnectionPill,
  ConnectionPillModel,
  connectionPillDataState,
  connectionPillText,
} from "../src/ui/ConnectionPill.js";

/** In-memory Web Storage double. */
class MemoryStorage implements StorageLike {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

interface ScheduledTask {
  at: number;
  handler: () => void;
}

/**
 * Deterministic timer surface: advancing the clock runs due handlers in
 * deadline order, including timers scheduled from inside a handler.
 */
class FakeTimers implements ReconnectTimers {
  private nextId = 1;
  private nowMs = 0;
  private readonly tasks = new Map<number, ScheduledTask>();

  setTimeout(handler: () => void, timeoutMs: number): number {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.set(id, { at: this.nowMs + Math.max(0, timeoutMs), handler });
    return id;
  }

  clearTimeout(handle: number): void {
    this.tasks.delete(handle);
  }

  get pending(): number {
    return this.tasks.size;
  }

  advance(ms: number): void {
    const target = this.nowMs + Math.max(0, ms);
    for (;;) {
      let dueId: number | null = null;
      let due: ScheduledTask | null = null;
      for (const [id, task] of this.tasks) {
        if (task.at > target) {
          continue;
        }
        if (due === null || task.at < due.at) {
          due = task;
          dueId = id;
        }
      }
      if (due === null || dueId === null) {
        break;
      }
      this.tasks.delete(dueId);
      this.nowMs = due.at;
      due.handler();
    }
    this.nowMs = target;
  }
}

const CODE = "ABCD";
const ROOM_TOKEN = "room-token-do-not-send";

let timers: FakeTimers;
let store: SessionStore;
let joins: ReconnectJoin[];
let states: ReconnectState[];
let stops: ReconnectStopReason[];
let staleCount: number;
let controller: ReconnectController;

beforeEach(() => {
  timers = new FakeTimers();
  store = createSessionStore({
    sessionStorage: new MemoryStorage(),
    localStorage: new MemoryStorage(),
    now: () => 0,
  });
  store.set(CODE, { session: "session-abc", slot: 3, roomToken: ROOM_TOKEN });
  joins = [];
  states = [];
  stops = [];
  staleCount = 0;
  controller = createReconnectController({
    store,
    code: CODE,
    timers,
    random: () => 0.5,
    onJoin: (message) => {
      joins.push(message);
    },
    onState: (state) => {
      states.push(state);
    },
    onStop: (reason) => {
      stops.push(reason);
    },
    onStaleSocket: () => {
      staleCount += 1;
    },
  });
});

describe("[FR-7.15] exponential reconnect backoff", () => {
  it("[FR-7.15] starts at 250 ms, doubles and caps at 4 s", () => {
    const nominal = [0, 1, 2, 3, 4, 5, 10].map((attempt) =>
      reconnectDelayMs(attempt, () => 0.5),
    );
    expect(nominal).toEqual([250, 500, 1_000, 2_000, 4_000, 4_000, 4_000]);
    expect(RECONNECT_BASE_DELAY_MS).toBe(250);
    expect(RECONNECT_MAX_DELAY_MS).toBe(4_000);
  });

  it("[FR-7.15] applies ±20% jitter and never exceeds the 4 s cap", () => {
    expect(reconnectDelayMs(0, () => 0)).toBe(200);
    expect(reconnectDelayMs(0, () => 1)).toBe(300);
    expect(reconnectDelayMs(2, () => 0)).toBe(800);
    expect(reconnectDelayMs(2, () => 1)).toBe(1_200);
    expect(reconnectDelayMs(8, () => 0)).toBe(3_200);
    expect(reconnectDelayMs(8, () => 1)).toBe(4_000);
  });

  it("[FR-7.15] a socket close schedules 250/500/1000/2000/4000 ms attempts", () => {
    controller.onConnected(3);
    controller.onDisconnected();

    expect(controller.state).toMatchObject({
      phase: "waiting",
      attempt: 0,
      delayMs: 250,
      slot: 3,
    });

    timers.advance(249);
    expect(joins).toHaveLength(0);
    timers.advance(1);
    expect(joins).toHaveLength(1);
    expect(controller.state.phase).toBe("connecting");

    controller.onAttemptFailed();
    expect(controller.state).toMatchObject({ phase: "waiting", attempt: 1, delayMs: 500 });
    timers.advance(500);
    expect(joins).toHaveLength(2);

    controller.onAttemptFailed();
    expect(controller.state.delayMs).toBe(1_000);
    timers.advance(1_000);
    expect(joins).toHaveLength(3);

    controller.onAttemptFailed();
    expect(controller.state.delayMs).toBe(2_000);
    timers.advance(2_000);
    expect(joins).toHaveLength(4);

    controller.onAttemptFailed();
    expect(controller.state.delayMs).toBe(4_000);
    timers.advance(4_000);
    expect(joins).toHaveLength(5);

    controller.onAttemptFailed();
    expect(controller.state.delayMs).toBe(4_000);
    timers.advance(4_000);
    expect(joins).toHaveLength(6);
  });
});

describe("[FR-5.4] session rejoin", () => {
  it("[FR-5.4] every attempt joins with the session token and never the room token", () => {
    controller.onConnected(3);
    controller.onDisconnected();
    timers.advance(250);

    expect(joins).toHaveLength(1);
    expect(joins[0]).toEqual({
      t: "join",
      v: PROTOCOL_VERSION,
      code: CODE,
      session: "session-abc",
    });
    expect(joins[0] === undefined ? null : "token" in joins[0]).toBe(false);
    expect(JSON.stringify(joins)).not.toContain(ROOM_TOKEN);
  });

  it("[FR-5.4] keeps the slot across the drop and the rejoin", () => {
    controller.onConnected(6);
    controller.onDisconnected();
    expect(controller.state.slot).toBe(6);

    timers.advance(250);
    expect(controller.state.slot).toBe(6);

    controller.onConnected(6);
    expect(controller.state).toMatchObject({
      phase: "connected",
      slot: 6,
      attempt: 0,
      delayMs: 0,
    });
  });

  it("[FR-5.4] a connected state clears a previous retry attempt counter", () => {
    controller.onConnected(1);
    controller.onDisconnected();
    timers.advance(250);
    controller.onAttemptFailed();
    timers.advance(500);
    controller.onAttemptFailed();
    controller.onConnected(1);
    expect(controller.state.attempt).toBe(0);
    expect(states.at(-1)).toMatchObject({ phase: "connected", attempt: 0 });
  });
});

describe("[FR-5.5] expired reservations and missing sessions", () => {
  it("[FR-5.5] an expired reservation stops reconnect for the join-flow fallback", () => {
    controller.onConnected(4);
    controller.onDisconnected();
    timers.advance(250);

    controller.onJoinRejected("expired");

    expect(stops).toEqual(["expired"]);
    expect(controller.state).toMatchObject({ phase: "stopped", stopReason: "expired" });
    expect(timers.pending).toBe(0);

    timers.advance(10_000);
    expect(joins).toHaveLength(1);
  });

  it("[FR-5.5] a missing stored session stops instead of spinning", () => {
    store.clear(CODE);
    controller.onConnected(1);
    controller.onDisconnected();
    timers.advance(250);

    expect(joins).toHaveLength(0);
    expect(stops).toEqual(["noSession"]);
    expect(controller.state).toMatchObject({ phase: "stopped", stopReason: "noSession" });
    expect(timers.pending).toBe(0);
  });

  it("[FR-5.5] a refused rejoin is terminal, not an endless retry", () => {
    controller.onConnected(1);
    controller.onDisconnected();
    timers.advance(250);

    controller.onJoinRejected("badToken");

    expect(stops).toEqual(["rejected"]);
    expect(controller.state.stopReason).toBe("rejected");
    expect(timers.pending).toBe(0);
  });
});

describe("[FR-7.14] heartbeat lapse handling", () => {
  it("[FR-7.14] a silent socket is detected after 7 s and reconnected", () => {
    controller.onConnected(2);

    timers.advance(SERVER_SILENCE_TIMEOUT_MS - 1);
    expect(staleCount).toBe(0);
    expect(controller.state.phase).toBe("connected");

    timers.advance(1);
    expect(staleCount).toBe(1);
    expect(controller.state).toMatchObject({
      phase: "waiting",
      attempt: 0,
      slot: 2,
      delayMs: 250,
    });

    timers.advance(250);
    expect(joins).toHaveLength(1);
    expect(joins[0]).toMatchObject({ t: "join", session: "session-abc" });
  });

  it("[FR-7.14] any server activity resets the silence watchdog", () => {
    controller.onConnected(2);

    timers.advance(6_000);
    controller.onServerActivity();
    timers.advance(6_000);
    expect(staleCount).toBe(0);
    expect(controller.state.phase).toBe("connected");

    timers.advance(1_000);
    expect(staleCount).toBe(1);
  });

  it("[FR-7.14] a socket close disarms the watchdog", () => {
    controller.onConnected(2);
    controller.onDisconnected();

    timers.advance(SERVER_SILENCE_TIMEOUT_MS);
    expect(staleCount).toBe(0);
  });
});

describe("[G4] reconnect never leaks work after leave or kick", () => {
  it("[G4] explicit leave stops reconnect and leaves no timers", () => {
    controller.onConnected(1);
    controller.stop("left");

    expect(controller.state).toMatchObject({ phase: "stopped", stopReason: "left" });
    expect(timers.pending).toBe(0);

    controller.onDisconnected();
    timers.advance(10_000);
    expect(joins).toHaveLength(0);
  });

  it("[G4] a kick during backoff cancels the pending attempt", () => {
    controller.onConnected(2);
    controller.onDisconnected();
    expect(timers.pending).toBe(1);

    controller.stop("kicked");
    expect(timers.pending).toBe(0);

    timers.advance(5_000);
    expect(joins).toHaveLength(0);
  });

  it("[G4] a throwing join transport schedules the next backoff instead of crashing", () => {
    const throwing = createReconnectController({
      store,
      code: CODE,
      timers,
      random: () => 0.5,
      onJoin: () => {
        throw new Error("socket factory failed");
      },
    });
    throwing.onConnected(1);
    throwing.onDisconnected();
    timers.advance(250);

    expect(throwing.state).toMatchObject({ phase: "waiting", attempt: 1, delayMs: 500 });
    expect(timers.pending).toBe(1);
  });
});

describe("[A9] connection pill state machine", () => {
  it("[A9] maps hostStatus lost, paused and active to the pill", () => {
    const model = new ConnectionPillModel();
    model.setPhase("connected", 4);
    expect(connectionPillText(model.state)).toBe("Connected (P4)");
    expect(connectionPillDataState(model.state)).toBe("connected");

    model.setHostStatus("lost");
    expect(connectionPillText(model.state)).toBe("Waiting for TV");
    expect(connectionPillDataState(model.state)).toBe("waiting-for-tv");

    model.setHostStatus("paused");
    expect(connectionPillText(model.state)).toBe("TV paused");
    expect(connectionPillDataState(model.state)).toBe("tv-paused");

    model.setHostStatus("active");
    expect(connectionPillText(model.state)).toBe("Connected (P4)");
  });

  it("[A9] leaving connected clears a stale Waiting for TV state", () => {
    const model = new ConnectionPillModel();
    model.setPhase("connected", 1);
    model.setHostStatus("lost");

    model.setPhase("reconnecting");
    expect(connectionPillText(model.state)).toBe("Reconnecting");
    expect(model.state.host).toBeNull();
    expect(model.state.slot).toBeNull();

    model.setPhase("connected", 1);
    expect(connectionPillText(model.state)).toBe("Connected (P1)");
  });

  it("[A9] renders Connecting and Disconnected for socket states", () => {
    const model = new ConnectionPillModel();
    expect(connectionPillText(model.state)).toBe("Disconnected");
    expect(connectionPillDataState(model.state)).toBe("disconnected");

    model.setPhase("connecting");
    expect(connectionPillText(model.state)).toBe("Connecting");
    expect(connectionPillDataState(model.state)).toBe("connecting");

    model.setPhase("disconnected");
    expect(connectionPillText(model.state)).toBe("Disconnected");
  });

  it("[A9] writes text and data-state into the element and stops on destroy", () => {
    const element = document.createElement("span");
    const model = new ConnectionPillModel();
    const pill = new ConnectionPill(element, model);

    expect(element.textContent).toBe("Disconnected");
    expect(element.dataset["state"]).toBe("disconnected");

    model.setPhase("connected", 2);
    model.setHostStatus("lost");
    expect(element.textContent).toBe("Waiting for TV");
    expect(element.dataset["state"]).toBe("waiting-for-tv");

    pill.destroy();
    model.setHostStatus("active");
    expect(element.textContent).toBe("Waiting for TV");
  });
});
