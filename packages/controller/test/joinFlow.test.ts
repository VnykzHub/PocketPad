import { beforeEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@lanpad/protocol";
import {
  JOIN_FLOW_MESSAGES,
  createJoinFlow,
  parseJoinInput,
  type JoinFlow,
  type JoinTransport,
  type JoinRequest,
} from "../src/join/joinFlow.js";
import { MANUAL_JOIN_MESSAGES, manualJoinView, validateManualJoin } from "../src/join/ManualJoin.js";
import type { ReplaceStateHistory } from "../src/route.js";
import { createSessionStore, type SessionStore, type StorageLike } from "../src/join/sessionStore.js";

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

/** Records `replaceState` in a shared call log so ordering is observable. */
class RecordingHistory implements ReplaceStateHistory {
  readonly urls: string[] = [];

  constructor(private readonly order: string[]) {}

  replaceState(_data: unknown, _unused: string, url?: string | URL | null): void {
    this.urls.push(typeof url === "string" ? url : String(url ?? ""));
    this.order.push("replace");
  }
}

class RecordingTransport implements JoinTransport {
  readonly sent: JoinRequest[] = [];

  constructor(private readonly order: string[]) {}

  send(message: JoinRequest): void {
    this.order.push("send");
    this.sent.push(message);
  }
}

const CODE = "ABCD";
const SESSION = "sessionToken000000000";
const TOKEN = "roomToken000000000000";

let nowMs = 0;
let order: string[];
let sessionStorage: MemoryStorage;
let localStorage: MemoryStorage;
let store: SessionStore;
let transport: RecordingTransport;
let history: RecordingHistory;
let flow: JoinFlow;

beforeEach(() => {
  nowMs = 1_000_000;
  order = [];
  sessionStorage = new MemoryStorage();
  localStorage = new MemoryStorage();
  store = createSessionStore({ sessionStorage, localStorage, now: () => nowMs });
  transport = new RecordingTransport(order);
  history = new RecordingHistory(order);
  flow = createJoinFlow({
    store,
    transport,
    history,
    now: () => nowMs,
    rateLimitRetryMs: 60_000,
  });
});

describe("[FR-5.1] the room token lives in the fragment only", () => {
  it("[FR-5.1] parses /c/<CODE> and a percent-encoded fragment token", () => {
    expect(parseJoinInput("/c/ABCD", "#tok%2Ben")).toEqual({
      code: "ABCD",
      roomToken: "tok+en",
    });
    expect(parseJoinInput("/c/abcd/", "#tok")).toEqual({ code: "ABCD", roomToken: "tok" });
    expect(parseJoinInput("/", "")).toEqual({ code: null, roomToken: null });
    expect(parseJoinInput("/c/ABC", "#tok")).toEqual({ code: null, roomToken: "tok" });
    expect(parseJoinInput("/c/ABCD", "%E0%A4%A")).toEqual({ code: "ABCD", roomToken: null });
  });

  it("[FR-5.1] clears the fragment before the first network call", () => {
    flow.start({ pathname: "/c/ABCD", hash: `#${TOKEN}`, search: "?debug=1" });

    expect(order).toEqual(["replace", "send"]);
    expect(history.urls[0]).toBe("/c/ABCD?debug=1");
    expect(history.urls[0]).not.toContain("#");
    expect(transport.sent[0]).toEqual({
      t: "join",
      v: PROTOCOL_VERSION,
      code: "ABCD",
      token: TOKEN,
    });
  });

  it("[FR-5.1] clears a stray fragment even when there is no controller code", () => {
    flow.start({ pathname: "/", hash: "#secret", search: "" });

    expect(order).toEqual(["replace"]);
    expect(history.urls[0]).toBe("/");
    expect(flow.state.status).toBe("manual");
  });

  it("[FR-5.1] a rejected QR token drops to manual join and is not retried", () => {
    flow.start({ pathname: "/c/ABCD", hash: `#${TOKEN}`, search: "" });
    flow.handleMessage({ t: "joinError", reason: "badToken" });

    expect(flow.state).toMatchObject({
      status: "manual",
      code: "ABCD",
      notice: JOIN_FLOW_MESSAGES.badToken,
    });
    flow.retry();
    expect(transport.sent).toHaveLength(1);
  });

  it("[SR-2] the token never appears in the public state", () => {
    flow.start({ pathname: "/c/ABCD", hash: `#${TOKEN}`, search: "" });

    expect(JSON.stringify(flow.state)).not.toContain(TOKEN);
    expect(flow.state).not.toHaveProperty("token");
  });
});

describe("[FR-5.4] session rejoin is attempted before the room token", () => {
  it("[FR-5.4] sends join {session} first and never includes the token", () => {
    store.set(CODE, { session: SESSION, slot: 3, roomToken: TOKEN });

    flow.start({ pathname: "/c/ABCD", hash: `#${TOKEN}`, search: "" });

    expect(transport.sent).toEqual([
      { t: "join", v: PROTOCOL_VERSION, code: "ABCD", session: SESSION },
    ]);
    expect(transport.sent[0]).not.toHaveProperty("token");
    expect(flow.state).toMatchObject({ status: "joining", via: "session" });
  });

  it("[FR-7.15] a page reload rejoins with the stored session, not the room token", () => {
    flow.start({ pathname: "/c/ABCD", hash: `#${TOKEN}`, search: "" });
    flow.handleMessage({ t: "joined", slot: 2, session: SESSION, serverTime: 1 });

    // Reload: a new flow instance over the same browser storage.
    const reloadOrder: string[] = [];
    const reloadTransport = new RecordingTransport(reloadOrder);
    const reloadFlow = createJoinFlow({
      store,
      transport: reloadTransport,
      history: new RecordingHistory(reloadOrder),
      now: () => nowMs,
    });
    reloadFlow.start({ pathname: "/c/ABCD", hash: `#${TOKEN}`, search: "" });

    expect(reloadTransport.sent).toEqual([
      { t: "join", v: PROTOCOL_VERSION, code: "ABCD", session: SESSION },
    ]);
    expect(reloadTransport.sent[0]).not.toHaveProperty("token");
  });

  it("[FR-5.4] joined stores the session for the room and kick clears it", () => {
    flow.start({ pathname: "/c/ABCD", hash: `#${TOKEN}`, search: "" });
    flow.handleMessage({ t: "joined", slot: 4, session: SESSION, serverTime: 1 });

    expect(store.get(CODE)).toMatchObject({
      session: SESSION,
      slot: 4,
      roomToken: TOKEN,
    });
    expect(flow.state).toEqual({ status: "joined", code: "ABCD", slot: 4 });

    flow.handleMessage({ t: "kick", reason: "removed" });
    expect(store.get(CODE)).toBeNull();
  });
});

describe("[FR-5.5] an expired session falls back without looping", () => {
  it("[FR-5.5] tries the stored room token as a new join", () => {
    store.set(CODE, { session: SESSION, slot: 3, roomToken: TOKEN });
    flow.start({ pathname: "/c/ABCD", hash: "", search: "" });
    expect(transport.sent[0]).toMatchObject({ session: SESSION });

    flow.handleMessage({ t: "joinError", reason: "expired" });

    expect(transport.sent[1]).toEqual({
      t: "join",
      v: PROTOCOL_VERSION,
      code: "ABCD",
      token: TOKEN,
    });
    expect(store.get(CODE)).toBeNull();
  });

  it("[FR-5.5] uses the QR fragment token when the stored session has none", () => {
    store.set(CODE, { session: SESSION, slot: 3 });

    flow.start({ pathname: "/c/ABCD", hash: `#${TOKEN}`, search: "" });
    flow.handleMessage({ t: "joinError", reason: "expired" });

    expect(transport.sent[1]).toMatchObject({ token: TOKEN });
    expect(transport.sent[1]).not.toHaveProperty("session");
  });

  it("[FR-5.5] shows the manual form when no room token exists", () => {
    store.set(CODE, { session: SESSION, slot: 3 });
    flow.start({ pathname: "/c/ABCD", hash: "", search: "" });

    flow.handleMessage({ t: "joinError", reason: "expired" });

    expect(flow.state).toMatchObject({
      status: "manual",
      code: "ABCD",
      notice: JOIN_FLOW_MESSAGES.expired,
    });
    expect(transport.sent).toHaveLength(1);
    expect(store.get(CODE)).toBeNull();
  });
});

describe("[FR-5.2] expiry is surfaced as an actionable manual join", () => {
  it("[FR-5.2] an expired room or token join lands on the manual form", () => {
    flow.start({ pathname: "/c/ABCD", hash: `#${TOKEN}`, search: "" });
    flow.handleMessage({ t: "joinError", reason: "expired" });

    expect(flow.state).toMatchObject({
      status: "manual",
      notice: JOIN_FLOW_MESSAGES.expired,
    });
    expect(transport.sent).toHaveLength(1);
  });
});

describe("[FR-5.6] manual join works without a camera", () => {
  it("[FR-5.6] sends only the PIN, never a token or session", () => {
    flow.start({ pathname: "/c/ABCD", hash: "", search: "" });
    expect(flow.state.status).toBe("manual");

    flow.submitManual({ code: "abcd", pin: "1234" });

    expect(transport.sent).toEqual([
      { t: "join", v: PROTOCOL_VERSION, code: "ABCD", pin: "1234" },
    ]);
    expect(transport.sent[0]).not.toHaveProperty("token");
    expect(transport.sent[0]).not.toHaveProperty("session");
  });

  it("[FR-5.6] badPin returns to the manual form with an inline error and does not loop", () => {
    flow.start({ pathname: "/c/ABCD", hash: "", search: "" });
    flow.submitManual({ code: "ABCD", pin: "1234" });

    flow.handleMessage({ t: "joinError", reason: "badPin" });

    expect(flow.state).toMatchObject({
      status: "manual",
      code: "ABCD",
      notice: JOIN_FLOW_MESSAGES.badPin,
    });
    expect(JOIN_FLOW_MESSAGES.badPin).toContain("Wrong PIN");
    expect(transport.sent).toHaveLength(1);
  });

  it("[FR-5.6] badCode returns to the manual form with an actionable message", () => {
    flow.start({ pathname: "/c/ABCD", hash: "", search: "" });
    flow.submitManual({ code: "ABCD", pin: "1234" });

    flow.handleMessage({ t: "joinError", reason: "badCode" });

    expect(flow.state).toMatchObject({
      status: "manual",
      notice: JOIN_FLOW_MESSAGES.badCode,
    });
    expect(JOIN_FLOW_MESSAGES.badCode).toContain("No room");
  });

  it("[SR-4] requires both a 4-character code and a 4-digit PIN", () => {
    flow.start({ pathname: "/", hash: "", search: "" });

    flow.submitManual({ code: "ABC", pin: "12" });
    expect(transport.sent).toHaveLength(0);
    expect(flow.state).toMatchObject({
      status: "manual",
      errors: {
        code: MANUAL_JOIN_MESSAGES.code,
        pin: MANUAL_JOIN_MESSAGES.pin,
      },
    });

    flow.submitManual({ code: "ABCD", pin: "12ab" });
    expect(transport.sent).toHaveLength(0);
    expect(flow.state).toMatchObject({
      status: "manual",
      errors: { pin: MANUAL_JOIN_MESSAGES.pin },
    });
  });

  it("[FR-5.6] validates both fields and disables submit during a lockout", () => {
    expect(validateManualJoin({ code: "abcd", pin: "1234" })).toEqual({
      ok: true,
      code: "ABCD",
      pin: "1234",
    });

    const view = manualJoinView({
      code: "ABCD",
      pin: "",
      errors: { pin: MANUAL_JOIN_MESSAGES.pin },
      retryAfterMs: 5_000,
    });
    expect(view.canSubmit).toBe(false);
    expect(view.submitLabel).toBe("Try again in 5s");
    expect(view.pinError).toBe(MANUAL_JOIN_MESSAGES.pin);
  });
});

describe("[FR-5.3] a full room has a distinct retry path", () => {
  it("[FR-5.3] roomFull shows the 8/8 message and retry re-sends the join", () => {
    flow.start({ pathname: "/c/ABCD", hash: `#${TOKEN}`, search: "" });

    flow.handleMessage({ t: "joinError", reason: "roomFull" });

    expect(flow.state).toMatchObject({
      status: "error",
      kind: "roomFull",
      message: JOIN_FLOW_MESSAGES.roomFull,
    });
    expect(JOIN_FLOW_MESSAGES.roomFull).toContain("Room is full (8/8)");

    flow.retry();
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[1]).toMatchObject({ token: TOKEN });
  });
});

describe("[SR-5] a rate-limited join tells the user when to retry", () => {
  it("[SR-5] rateLimited shows seconds and blocks submit until the lockout ends", () => {
    flow.start({ pathname: "/c/ABCD", hash: "", search: "" });
    flow.submitManual({ code: "ABCD", pin: "0000" });
    flow.handleMessage({ t: "joinError", reason: "rateLimited" });

    expect(flow.state).toMatchObject({
      status: "error",
      kind: "rateLimited",
      retryAfterMs: 60_000,
    });
    expect(flow.state.status === "error" ? flow.state.message : "").toContain("60 seconds");

    nowMs += 30_000;
    flow.submitManual({ code: "ABCD", pin: "0000" });
    expect(transport.sent).toHaveLength(1);

    nowMs += 30_000;
    flow.submitManual({ code: "ABCD", pin: "0000" });
    expect(transport.sent).toHaveLength(2);
  });
});

describe("join flow ignores unrelated messages", () => {
  it("keeps the current state for hostStatus and other controller traffic", () => {
    flow.start({ pathname: "/c/ABCD", hash: "", search: "" });
    const before = flow.state;

    flow.handleMessage({ t: "hostStatus", state: "lost" });
    flow.handleMessage({ t: "playerResumed", slot: 1 });

    expect(flow.state).toBe(before);
  });

  it("leave clears the stored session for the room", () => {
    flow.start({ pathname: "/c/ABCD", hash: `#${TOKEN}`, search: "" });
    flow.handleMessage({ t: "joined", slot: 1, session: SESSION, serverTime: 1 });

    flow.leave();

    expect(store.get(CODE)).toBeNull();
    expect(flow.state).toEqual({ status: "idle" });
  });
});
