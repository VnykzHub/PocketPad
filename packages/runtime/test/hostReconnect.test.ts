/**
 * D4-HOST-02: session resume, 250 ms → 4 s backoff, 30 s loss and pause.
 */
import type {
  HostToServerMessage,
  JoinErrorReason,
} from "@lanpad/protocol";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  HostConnectionState,
  HostJoinResult,
} from "../src/net/hostClient.js";
import {
  HOST_LOST_WINDOW_MS,
  HOST_SESSION_STORAGE_KEY,
  HostReconnect,
  RECONNECT_INITIAL_BACKOFF_MS,
  RECONNECT_MAX_BACKOFF_MS,
  readHostSession,
  storeHostSession,
  type HostReconnectClient,
  type HostSession,
  type HostSessionStorage,
} from "../src/net/hostReconnect.js";

const CODE = "ABCD";
const TOKEN = "A".repeat(22);
const SESSION: HostSession = { code: CODE, hostToken: TOKEN };

class FakeClient implements HostReconnectClient {
  state: HostConnectionState = "idle";
  lastJoinError: JoinErrorReason | null = null;
  connectCalls = 0;
  joins: HostSession[] = [];
  sent: HostToServerMessage[] = [];
  connectFails = false;
  joinFails = false;
  failReason: JoinErrorReason | null = null;

  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.connectFails) {
      throw new Error("connect failed");
    }
    this.state = "connected";
  }

  async hostJoin(code: string, hostToken: string): Promise<HostJoinResult> {
    this.joins.push({ code, hostToken });
    if (this.joinFails) {
      this.lastJoinError = this.failReason;
      throw new Error("join failed");
    }
    this.lastJoinError = null;
    return { serverTime: 100 };
  }

  send(message: HostToServerMessage): void {
    this.sent.push(message);
  }
}

interface MemoryStorage extends HostSessionStorage {
  readonly map: Map<string, string>;
}

function memoryStorage(initial?: Record<string, string>): MemoryStorage {
  const map = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

function storedSession(): Record<string, string> {
  return { [HOST_SESSION_STORAGE_KEY]: JSON.stringify(SESSION) };
}

function build(options: {
  storage?: HostSessionStorage | null;
  onResumed?: (session: HostSession) => void;
  onLost?: (session: HostSession) => void;
  onStateChange?: (state: string) => void;
} = {}) {
  const client = new FakeClient();
  const recovery = new HostReconnect({
    client,
    storage: options.storage ?? null,
    now: () => Date.now(),
    ...(options.onResumed === undefined ? {} : { onResumed: options.onResumed }),
    ...(options.onLost === undefined ? {} : { onLost: options.onLost }),
    ...(options.onStateChange === undefined
      ? {}
      : { onStateChange: options.onStateChange as never }),
  });
  return { client, recovery };
}

describe("[FR-7.16][FR-9.2] D4-HOST-02 HostReconnect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("resumeStored returns none without a stored session", async () => {
    const { client, recovery } = build({ storage: memoryStorage() });

    await expect(recovery.resumeStored()).resolves.toBe("none");
    expect(client.connectCalls).toBe(0);
  });

  test("resumeStored ignores corrupt storage", async () => {
    const storage = memoryStorage({
      [HOST_SESSION_STORAGE_KEY]: "{not json",
    });
    const { recovery } = build({ storage });

    await expect(recovery.resumeStored()).resolves.toBe("none");
    expect(readHostSession(storage)).toBeNull();
  });

  test("[FR-7.16] join stores exactly code + hostToken in sessionStorage", async () => {
    const storage = memoryStorage();
    const { client, recovery } = build({ storage });

    await recovery.join(SESSION);

    expect(recovery.state).toBe("connected");
    expect(client.joins).toEqual([SESSION]);
    expect(storage.getItem(HOST_SESSION_STORAGE_KEY)).toBe(
      JSON.stringify({ code: CODE, hostToken: TOKEN }),
    );
    expect(readHostSession(storage)).toEqual(SESSION);
  });

  test("[FR-7.16] resumeStored resumes a valid stored session", async () => {
    const storage = memoryStorage(storedSession());
    const { client, recovery } = build({ storage });

    await expect(recovery.resumeStored()).resolves.toBe("resumed");
    expect(recovery.state).toBe("connected");
    expect(client.joins).toEqual([SESSION]);
  });

  test("[FR-7.16] an expired token is terminal and clears the stored session", async () => {
    const storage = memoryStorage(storedSession());
    const { client, recovery } = build({ storage });
    client.joinFails = true;
    client.failReason = "expired";

    await expect(recovery.resumeStored()).resolves.toBe("terminal");

    expect(recovery.session).toBeNull();
    expect(storage.getItem(HOST_SESSION_STORAGE_KEY)).toBeNull();
    expect(recovery.state).toBe("idle");
  });

  test("a transient boot failure enters recovering and retries after 250 ms", async () => {
    const storage = memoryStorage(storedSession());
    const resumed: HostSession[] = [];
    const { client, recovery } = build({
      storage,
      onResumed: (session) => resumed.push(session),
    });
    client.connectFails = true;

    await expect(recovery.resumeStored()).resolves.toBe("recovering");
    expect(recovery.state).toBe("reconnecting");
    expect(resumed).toHaveLength(0);

    client.connectFails = false;
    await vi.advanceTimersByTimeAsync(RECONNECT_INITIAL_BACKOFF_MS);

    expect(recovery.state).toBe("connected");
    expect(resumed).toEqual([SESSION]);
  });

  test("close retries with exponential backoff starting at 250 ms", async () => {
    const { client, recovery } = build({ storage: memoryStorage() });
    await recovery.join(SESSION);
    client.connectFails = true;

    recovery.handleClose();
    expect(recovery.state).toBe("reconnecting");

    await vi.advanceTimersByTimeAsync(RECONNECT_INITIAL_BACKOFF_MS);
    expect(client.connectCalls).toBe(2);

    await vi.advanceTimersByTimeAsync(RECONNECT_INITIAL_BACKOFF_MS * 2 - 1);
    expect(client.connectCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.connectCalls).toBe(3);
  });

  test("[FR-7.16] a terminal join error while reconnecting reports lost", async () => {
    const storage = memoryStorage();
    const lost: HostSession[] = [];
    const { client, recovery } = build({
      storage,
      onLost: (session) => lost.push(session),
    });
    await recovery.join(SESSION);
    client.joinFails = true;
    client.failReason = "badHostToken";

    recovery.handleClose();
    await vi.advanceTimersByTimeAsync(RECONNECT_INITIAL_BACKOFF_MS);

    expect(recovery.state).toBe("lost");
    expect(recovery.session).toBeNull();
    expect(storage.getItem(HOST_SESSION_STORAGE_KEY)).toBeNull();
    expect(lost).toEqual([SESSION]);
  });

  test("[FR-7.16] the 30 s window closes after repeated non-terminal failures", async () => {
    const lost: HostSession[] = [];
    const { client, recovery } = build({
      storage: memoryStorage(),
      onLost: (session) => lost.push(session),
    });
    await recovery.join(SESSION);
    client.connectFails = true;

    recovery.handleClose();
    await vi.advanceTimersByTimeAsync(HOST_LOST_WINDOW_MS + RECONNECT_MAX_BACKOFF_MS);

    expect(recovery.state).toBe("lost");
    expect(lost).toEqual([SESSION]);
  });

  test("[FR-9.2] pause/resume mirror hostPause and hostResume when connected", async () => {
    const { client, recovery } = build({ storage: memoryStorage() });

    recovery.pauseForVisibility();
    expect(client.sent).toHaveLength(0);

    await recovery.join(SESSION);
    expect(client.sent).toEqual([{ t: "hostPause" }]);

    recovery.resumeForVisibility();
    expect(client.sent).toEqual([{ t: "hostPause" }, { t: "hostResume" }]);
  });

  test("forget clears stored state so a later close does not reconnect", async () => {
    const storage = memoryStorage();
    const { client, recovery } = build({ storage });
    await recovery.join(SESSION);

    recovery.forget();
    const calls = client.connectCalls;
    recovery.handleClose();
    await vi.advanceTimersByTimeAsync(RECONNECT_INITIAL_BACKOFF_MS);

    expect(storage.getItem(HOST_SESSION_STORAGE_KEY)).toBeNull();
    expect(recovery.state).toBe("idle");
    expect(client.connectCalls).toBe(calls);
  });

  test("storeHostSession round-trips through the storage seam", () => {
    const storage = memoryStorage();
    storeHostSession(storage, SESSION);
    expect(readHostSession(storage)).toEqual(SESSION);
  });
});
