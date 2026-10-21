import { beforeEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@lanpad/protocol";
import type { ClientToServerMessage } from "@lanpad/protocol";
import {
  createSessionStore,
  type SessionStore,
  type StorageLike,
} from "../src/join/sessionStore.js";
import {
  SLOT_RESERVATION_MS,
  createSuspendController,
  type SessionLostReason,
  type SuspendController,
  type SuspendSocket,
  type SuspendWakeLock,
  type VisibilitySource,
} from "../src/lifecycle/suspend.js";
import {
  WakeLockManager,
  type WakeLockLike,
  type WakeLockSentinelLike,
  type WakeLockState,
} from "../src/lifecycle/wakeLock.js";

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

class FakeSocket implements SuspendSocket {
  open = true;
  throwOnSend = false;
  readonly sent: ClientToServerMessage[] = [];

  isOpen(): boolean {
    return this.open;
  }

  send(message: ClientToServerMessage): void {
    if (this.throwOnSend) {
      throw new Error("socket is not writable");
    }
    this.sent.push(message);
  }
}

class FakeWakeLock implements SuspendWakeLock {
  requests = 0;
  releases = 0;
  failRequest = false;
  failRelease = false;

  async request(): Promise<boolean> {
    this.requests += 1;
    if (this.failRequest) {
      throw new Error("wake lock refused");
    }
    return true;
  }

  async release(): Promise<void> {
    this.releases += 1;
    if (this.failRelease) {
      throw new Error("wake lock release failed");
    }
  }
}

type VisibilityListener = () => void;

class FakeVisibility implements VisibilitySource {
  visibilityState = "visible";
  private readonly listeners = new Map<string, Set<VisibilityListener>>();

  addEventListener(type: string, listener: VisibilityListener): void {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: VisibilityListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string): void {
    const set = this.listeners.get(type);
    if (set === undefined) {
      return;
    }
    for (const listener of [...set]) {
      listener();
    }
  }

  hide(): void {
    this.visibilityState = "hidden";
    this.dispatch("visibilitychange");
  }

  show(): void {
    this.visibilityState = "visible";
    this.dispatch("visibilitychange");
  }

  get listenerCount(): number {
    let total = 0;
    for (const set of this.listeners.values()) {
      total += set.size;
    }
    return total;
  }
}

/** Flushes promise continuations scheduled by the wake lock calls. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const CODE = "ABCD";
const ROOM_TOKEN = "room-token-do-not-send";

let nowMs: number;
let store: SessionStore;
let socket: FakeSocket;
let wakeLock: FakeWakeLock;
let visibility: FakeVisibility;
let events: string[];
let errors: unknown[];
let lost: SessionLostReason[];
let reconnects: number;
let controller: SuspendController;

beforeEach(() => {
  nowMs = 1_000_000;
  store = createSessionStore({
    sessionStorage: new MemoryStorage(),
    localStorage: new MemoryStorage(),
    now: () => nowMs,
  });
  store.set(CODE, { session: "session-abc", slot: 2, roomToken: ROOM_TOKEN });
  socket = new FakeSocket();
  wakeLock = new FakeWakeLock();
  visibility = new FakeVisibility();
  events = [];
  errors = [];
  lost = [];
  reconnects = 0;
  controller = createSuspendController({
    socket,
    store,
    code: CODE,
    wakeLock,
    visibility,
    now: () => nowMs,
    onHide: () => {
      events.push("hide");
    },
    onShow: () => {
      events.push("show");
    },
    onReconnect: () => {
      reconnects += 1;
      events.push("reconnect");
    },
    onSessionLost: (reason) => {
      lost.push(reason);
    },
    onError: (error) => {
      errors.push(error);
    },
  });
});

describe("[FR-8.8] hidden sends suspend and visible rejoins", () => {
  it("[FR-8.8] hidden sends suspend, runs the hide hook and releases the wake lock", () => {
    controller.attach();
    visibility.hide();

    expect(socket.sent).toEqual([{ t: "suspend" }]);
    expect(events).toEqual(["hide"]);
    expect(wakeLock.releases).toBe(1);
    expect(wakeLock.requests).toBe(0);
    expect(controller.isHidden).toBe(true);
  });

  it("[FR-8.8] duplicate hidden events send exactly one suspend", () => {
    controller.attach();
    visibility.hide();
    visibility.hide();
    visibility.dispatch("pagehide");

    expect(socket.sent).toHaveLength(1);
    expect(wakeLock.releases).toBe(1);
    expect(events).toEqual(["hide"]);
  });

  it("[FR-8.8] visible reacquires the wake lock and rejoins by session", () => {
    controller.attach();
    visibility.hide();
    nowMs += 5_000;
    visibility.show();

    expect(wakeLock.requests).toBe(1);
    expect(socket.sent[1]).toEqual({
      t: "join",
      v: PROTOCOL_VERSION,
      code: CODE,
      session: "session-abc",
    });
    expect(JSON.stringify(socket.sent)).not.toContain(ROOM_TOKEN);
    expect(events).toEqual(["hide", "show"]);
    expect(controller.isHidden).toBe(false);
  });

  it("[FR-8.8] pagehide suspends and pageshow resumes when visibility does not fire", () => {
    controller.attach();

    visibility.dispatch("pagehide");
    expect(socket.sent).toEqual([{ t: "suspend" }]);

    nowMs += 1_000;
    visibility.dispatch("pageshow");
    expect(socket.sent[1]).toMatchObject({ t: "join", session: "session-abc" });
    expect(wakeLock.requests).toBe(1);
  });

  it("[FR-8.8] a send failure still completes the hidden transition", () => {
    controller.attach();
    socket.throwOnSend = true;
    visibility.hide();

    expect(events).toEqual(["hide"]);
    expect(wakeLock.releases).toBe(1);
    expect(errors).toHaveLength(1);
  });
});

describe("[FR-5.4] resume inside the reservation keeps the slot", () => {
  it("[FR-5.4] visible before 30 s resumes with the session token", () => {
    controller.attach();
    visibility.hide();
    nowMs += SLOT_RESERVATION_MS - 1;
    visibility.show();

    expect(lost).toEqual([]);
    expect(socket.sent[1]).toMatchObject({
      t: "join",
      code: CODE,
      session: "session-abc",
    });
  });
});

describe("[FR-5.5] resume after the reservation falls back", () => {
  it("[FR-5.5] visible after 30 s reports the loss instead of a stale session join", () => {
    controller.attach();
    visibility.hide();
    nowMs += SLOT_RESERVATION_MS + 1;
    visibility.show();

    expect(lost).toEqual(["expired"]);
    expect(socket.sent).toEqual([{ t: "suspend" }]);
    expect(reconnects).toBe(0);
  });

  it("[FR-5.5] a missing stored session asks for a new join", () => {
    store.clear(CODE);
    controller.attach();
    visibility.hide();
    nowMs += 1_000;
    visibility.show();

    expect(lost).toEqual(["missing"]);
    expect(socket.sent).toEqual([{ t: "suspend" }]);
    expect(reconnects).toBe(0);
  });
});

describe("[FR-8.8] closed sockets hand over to reconnect", () => {
  it("[FR-8.8] a socket that died while hidden triggers onReconnect", () => {
    controller.attach();
    visibility.hide();
    socket.open = false;
    nowMs += 1_000;
    visibility.show();

    expect(reconnects).toBe(1);
    expect(socket.sent).toEqual([{ t: "suspend" }]);
    expect(events).toEqual(["hide", "reconnect", "show"]);
  });
});

describe("[AR-3] wake lock failures never block the lifecycle", () => {
  it("[AR-3] a refused wake lock request still resumes the session", async () => {
    wakeLock.failRequest = true;
    controller.attach();
    visibility.hide();
    nowMs += 1_000;
    visibility.show();
    await flushMicrotasks();

    expect(socket.sent[1]).toMatchObject({ t: "join", session: "session-abc" });
    expect(events).toEqual(["hide", "show"]);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("[AR-3] a refused wake lock release still completes suspend", async () => {
    wakeLock.failRelease = true;
    controller.attach();
    visibility.hide();
    await flushMicrotasks();

    expect(socket.sent).toHaveLength(1);
    expect(events).toEqual(["hide"]);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("[G4] suspend controller teardown", () => {
  it("[G4] destroy removes every listener and releases the wake lock", () => {
    controller.attach();
    controller.destroy();

    expect(visibility.listenerCount).toBe(0);
    expect(wakeLock.releases).toBe(1);

    visibility.hide();
    expect(socket.sent).toHaveLength(0);
  });
});

class FakeSentinel implements WakeLockSentinelLike {
  released = false;
  releaseCalls = 0;
  private readonly listeners = new Set<() => void>();

  async release(): Promise<void> {
    this.releaseCalls += 1;
    this.released = true;
  }

  addEventListener(type: "release", listener: () => void): void {
    void type;
    this.listeners.add(listener);
  }

  removeEventListener(type: "release", listener: () => void): void {
    void type;
    this.listeners.delete(listener);
  }

  fireRelease(): void {
    this.released = true;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

class FakeWakeLockApi implements WakeLockLike {
  readonly sentinels: FakeSentinel[] = [];
  fail = false;

  async request(type: "screen"): Promise<WakeLockSentinelLike> {
    void type;
    if (this.fail) {
      throw new Error("NotAllowedError");
    }
    const sentinel = new FakeSentinel();
    this.sentinels.push(sentinel);
    return sentinel;
  }
}

describe("[AR-3] wake lock feature detection", () => {
  it("[AR-3] an unsupported browser resolves false and never throws", async () => {
    const manager = new WakeLockManager({ navigator: null });
    expect(manager.supported).toBe(false);
    await expect(manager.request()).resolves.toBe(false);
    expect(manager.state).toBe("unsupported");
    await expect(manager.release()).resolves.toBeUndefined();
    expect(manager.state).toBe("unsupported");

    const empty = new WakeLockManager({ navigator: {} });
    expect(empty.supported).toBe(false);
    await expect(empty.request()).resolves.toBe(false);
  });

  it("[AR-3] a refused request fails gracefully", async () => {
    const api = new FakeWakeLockApi();
    api.fail = true;
    const errors: unknown[] = [];
    const states: WakeLockState[] = [];
    const manager = new WakeLockManager({
      navigator: { wakeLock: api },
      onError: (error) => {
        errors.push(error);
      },
      onStateChange: (state) => {
        states.push(state);
      },
    });

    await expect(manager.request()).resolves.toBe(false);
    expect(manager.state).toBe("failed");
    expect(errors).toHaveLength(1);
    expect(states).toContain("requesting");
  });

  it("[AR-3] request holds and release returns to idle", async () => {
    const api = new FakeWakeLockApi();
    const manager = new WakeLockManager({ navigator: { wakeLock: api } });

    await expect(manager.request()).resolves.toBe(true);
    expect(manager.state).toBe("held");
    expect(manager.isHeld).toBe(true);
    expect(api.sentinels[0]?.releaseCalls).toBe(0);

    await manager.release();
    expect(manager.state).toBe("idle");
    expect(manager.isHeld).toBe(false);
    expect(api.sentinels[0]?.releaseCalls).toBe(1);
  });

  it("[AR-3] a browser-initiated release returns the manager to idle", async () => {
    const api = new FakeWakeLockApi();
    const manager = new WakeLockManager({ navigator: { wakeLock: api } });
    await manager.request();

    api.sentinels[0]?.fireRelease();
    expect(manager.state).toBe("idle");
    expect(manager.isHeld).toBe(false);
  });

  it("[AR-3] a second request while held does not allocate another sentinel", async () => {
    const api = new FakeWakeLockApi();
    const manager = new WakeLockManager({ navigator: { wakeLock: api } });

    await expect(manager.request()).resolves.toBe(true);
    await expect(manager.request()).resolves.toBe(true);
    expect(api.sentinels).toHaveLength(1);
  });

  it("[AR-3] release during an in-flight request discards the granted lock", async () => {
    const api = new FakeWakeLockApi();
    const manager = new WakeLockManager({ navigator: { wakeLock: api } });

    const pending = manager.request();
    await manager.release();
    await expect(pending).resolves.toBe(false);

    expect(api.sentinels[0]?.releaseCalls).toBe(1);
    expect(manager.isHeld).toBe(false);
    expect(manager.state).toBe("idle");
  });
});
