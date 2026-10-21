import { beforeEach, describe, expect, it } from "vitest";
import {
  SESSION_STORAGE_PREFIX,
  SESSION_TTL_MS,
  createSessionStore,
  sessionStorageKey,
  type SessionStore,
  type StorageLike,
} from "../src/join/sessionStore.js";

/** In-memory Web Storage double; tests can inspect or clear it directly. */
class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();

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

/** Simulates private-mode storage: every access throws. */
const throwingStorage: StorageLike = {
  getItem() {
    throw new Error("storage blocked");
  },
  setItem() {
    throw new Error("storage blocked");
  },
  removeItem() {
    throw new Error("storage blocked");
  },
};

let nowMs = 0;
let sessionStorage: MemoryStorage;
let localStorage: MemoryStorage;
let store: SessionStore;

beforeEach(() => {
  nowMs = 1_000_000;
  sessionStorage = new MemoryStorage();
  localStorage = new MemoryStorage();
  store = createSessionStore({
    sessionStorage,
    localStorage,
    now: () => nowMs,
  });
});

describe("[FR-5.4] sessions are scoped to a room", () => {
  it("[FR-5.4] stores and reads a session under lanpad.session.<CODE>", () => {
    store.set("ABCD", { session: "session-a", slot: 3 });

    expect(store.get("ABCD")).toEqual({
      session: "session-a",
      slot: 3,
      expiresAt: nowMs + SESSION_TTL_MS,
    });
    expect(sessionStorage.values.has("lanpad.session.ABCD")).toBe(true);
    expect(sessionStorage.values.has(sessionStorageKey("ABCD"))).toBe(true);
    expect(sessionStorageKey("abcd")).toBe("lanpad.session.ABCD");
    expect(`${SESSION_STORAGE_PREFIX}ABCD`).toBe("lanpad.session.ABCD");
  });

  it("[FR-5.4] never returns a session stored for a different room", () => {
    store.set("ABCD", { session: "session-a", slot: 1 });

    expect(store.get("WXYZ")).toBeNull();
    expect(store.get("ABCD")?.session).toBe("session-a");
  });

  it("[FR-5.4] normalizes lower-case codes when reading and writing", () => {
    store.set("abcd", { session: "session-a", slot: 2 });

    expect(store.get("ABCD")?.session).toBe("session-a");
    expect(store.get("abcd")?.slot).toBe(2);
  });

  it("[FR-5.4] keeps the room token for the expired-reservation fallback", () => {
    store.set("ABCD", { session: "session-a", slot: 1, roomToken: "room-token" });

    expect(store.get("ABCD")).toMatchObject({
      session: "session-a",
      slot: 1,
      roomToken: "room-token",
    });
  });

  it("[FR-5.4] clear removes the room's record from both stores", () => {
    store.set("ABCD", { session: "session-a", slot: 1 });
    store.set("WXYZ", { session: "session-b", slot: 2 });

    store.clear("ABCD");

    expect(store.get("ABCD")).toBeNull();
    expect(sessionStorage.values.has("lanpad.session.ABCD")).toBe(false);
    expect(localStorage.values.has("lanpad.session.ABCD")).toBe(false);
    expect(store.get("WXYZ")?.session).toBe("session-b");
  });
});

describe("[FR-5.5] expired sessions fall back to the localStorage mirror", () => {
  it("[FR-5.5] reads localStorage when sessionStorage is empty and rehydrates it", () => {
    store.set("ABCD", { session: "session-a", slot: 3, roomToken: "room-token" });
    sessionStorage.values.clear();

    expect(store.get("ABCD")).toMatchObject({
      session: "session-a",
      slot: 3,
      roomToken: "room-token",
    });
    expect(sessionStorage.values.has("lanpad.session.ABCD")).toBe(true);
  });

  it("[FR-5.5] treats disabled storage as no session instead of throwing", () => {
    const blocked = createSessionStore({
      sessionStorage: throwingStorage,
      localStorage: throwingStorage,
      now: () => nowMs,
    });

    expect(() => blocked.set("ABCD", { session: "session-a", slot: 1 })).not.toThrow();
    expect(blocked.get("ABCD")).toBeNull();
    expect(() => blocked.clear("ABCD")).not.toThrow();
  });

  it("[FR-5.5] tolerates a missing storage pair", () => {
    const memoryless = createSessionStore({ now: () => nowMs });

    memoryless.set("ABCD", { session: "session-a", slot: 1 });
    expect(memoryless.get("ABCD")).toBeNull();
  });
});

describe("[FR-5.2] stored sessions are bounded by the room's maximum life", () => {
  it("[FR-5.2] discards a record after the 4 h mirror window", () => {
    store.set("ABCD", { session: "session-a", slot: 1 });
    const expiresAt = nowMs + SESSION_TTL_MS;

    nowMs = expiresAt - 1;
    expect(store.get("ABCD")).not.toBeNull();

    nowMs = expiresAt;
    expect(store.get("ABCD")).toBeNull();
    expect(sessionStorage.values.has("lanpad.session.ABCD")).toBe(false);
    expect(localStorage.values.has("lanpad.session.ABCD")).toBe(false);
  });

  it("[FR-5.2] honors an explicit expiresAt", () => {
    store.set("ABCD", { session: "session-a", slot: 1, expiresAt: nowMs + 1_000 });

    nowMs += 1_000;
    expect(store.get("ABCD")).toBeNull();
  });

  it("drops malformed JSON instead of failing the join flow", () => {
    sessionStorage.setItem("lanpad.session.ABCD", "{not json");

    expect(store.get("ABCD")).toBeNull();
    expect(sessionStorage.values.has("lanpad.session.ABCD")).toBe(false);
  });

  it("drops records with an invalid slot", () => {
    sessionStorage.setItem(
      "lanpad.session.ABCD",
      JSON.stringify({ session: "session-a", slot: 9, expiresAt: nowMs + 1_000 }),
    );

    expect(store.get("ABCD")).toBeNull();
  });
});
