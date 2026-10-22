/**
 * D5-RT-01: host layout sends, per-slot ack tracking and recovery re-sends.
 */
import type { HostToServerMessage } from "@lanpad/protocol";
import type { LayoutDocument } from "@lanpad/sdk";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  LayoutAckTimeoutError,
  LayoutApi,
  LayoutValidationError,
} from "../src/game/LayoutApi.js";

function layout(id = "demo-v1"): LayoutDocument {
  return {
    id,
    orientation: "portrait",
    controls: [
      {
        id: "jump",
        type: "button",
        label: "Jump",
        shape: "circle",
        r: "10%",
        x: "50%",
        y: "80%",
        bit: 0,
      },
    ],
  };
}

class RecordingSender {
  readonly sent: HostToServerMessage[] = [];
  fail = false;

  send(message: HostToServerMessage): void {
    if (this.fail) {
      throw new Error("socket closed");
    }
    this.sent.push(message);
  }
}

describe("D5-RT-01 LayoutApi", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("broadcasts one validated setLayout for all slots", () => {
    const sender = new RecordingSender();
    const api = new LayoutApi({ sender });

    api.set("all", layout());

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]).toMatchObject({
      t: "setLayout",
      slot: "all",
      layout: { id: "demo-v1" },
    });
    expect(api.current(1)?.id).toBe("demo-v1");
    expect(api.current(8)?.id).toBe("demo-v1");
    expect(api.counters.swaps).toBe(1);
  });

  test("an occupied slot is acked once and waitForAcks resolves", async () => {
    const sender = new RecordingSender();
    const api = new LayoutApi({ sender });
    api.set(2, layout());
    api.handleJoined(2);
    expect(sender.sent).toHaveLength(2);

    const pending = api.waitForAcks(2, 500);
    api.handleAck(2, "demo-v1");
    const statuses = await pending;

    expect(statuses).toEqual([{ slot: 2, layoutId: "demo-v1", state: "acked" }]);
    expect(api.counters).toMatchObject({ acksReceived: 1, pendingAcks: 0 });

    api.handleAck(2, "demo-v1");
    expect(api.counters.staleAcks).toBe(1);
  });

  test("waitForAcks treats slots without a controller as ready", async () => {
    const api = new LayoutApi({ sender: new RecordingSender() });
    api.set("all", layout());

    const statuses = await api.waitForAcks("all", 100);

    expect(statuses).toHaveLength(8);
    expect(statuses.every((status) => status.state === "noPlayer")).toBe(true);
  });

  test("times out with per-slot statuses", async () => {
    const api = new LayoutApi({ sender: new RecordingSender() });
    api.set(1, layout());
    api.handleJoined(1);

    const pending = api.waitForAcks(1, 500);
    const caught = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(500);
    const error = await caught;

    expect(error).toBeInstanceOf(LayoutAckTimeoutError);
    expect((error as LayoutAckTimeoutError).statuses).toEqual([
      { slot: 1, layoutId: "demo-v1", state: "timeout" },
    ]);
  });

  test("repeating an acked layout is a no-op", () => {
    const sender = new RecordingSender();
    const api = new LayoutApi({ sender });
    api.set(1, layout());
    api.handleJoined(1);
    api.handleAck(1, "demo-v1");
    const sentBefore = sender.sent.length;

    api.set(1, "demo-v1");

    expect(sender.sent).toHaveLength(sentBefore);
  });

  test("register enables the SDK string form", () => {
    const sender = new RecordingSender();
    const api = new LayoutApi({ sender });
    expect(api.register(layout("quiz-v2"))).toBe("quiz-v2");

    api.set(3, "quiz-v2");

    expect(sender.sent[0]).toMatchObject({ t: "setLayout", slot: 3 });
    expect(api.current(3)?.id).toBe("quiz-v2");
    expect(() => api.set(3, "missing-v1")).toThrow(LayoutValidationError);
  });

  test("rejects invalid documents, targets and unknown ids", () => {
    const sender = new RecordingSender();
    const api = new LayoutApi({ sender });
    const bad = {
      id: "x",
      orientation: "portrait",
      controls: [],
    } as unknown as LayoutDocument;

    expect(() => api.set(1, bad)).toThrow(LayoutValidationError);
    expect(() => api.set(9, layout())).toThrow(RangeError);
    expect(sender.sent).toHaveLength(0);
  });

  test("[FR-5.4] handleResumed and resendAll re-send; handleLeft clears", () => {
    const sender = new RecordingSender();
    const api = new LayoutApi({ sender });
    api.set(1, layout());
    api.handleJoined(1);
    api.handleAck(1, "demo-v1");
    const sentBefore = sender.sent.length;

    api.handleResumed(1);
    api.resendAll();
    expect(sender.sent.length).toBe(sentBefore + 2);
    expect(sender.sent.at(-1)).toMatchObject({ t: "setLayout", slot: 1 });

    api.handleLeft(1);
    expect(api.current(1)).toBeNull();
    expect(api.counters.cleared).toBe(1);
    expect(api.counters.pendingAcks).toBe(0);
  });

  test("clear forgets host state without inventing a wire frame", () => {
    const sender = new RecordingSender();
    const api = new LayoutApi({ sender });
    api.register(layout());
    api.set("all", "demo-v1");
    api.handleJoined(1);
    api.handleAck(1, "demo-v1");
    const sentBefore = sender.sent.length;

    api.clear("all");

    // D5 contract 8: no layout-clear frame exists; controllers keep rendering.
    expect(sender.sent).toHaveLength(sentBefore);
    expect(api.current(1)).toBeNull();
    expect(api.current(8)).toBeNull();
    expect(api.counters.cleared).toBe(8);

    // The id stays registered, and the next set is not a duplicate.
    api.set(1, "demo-v1");
    expect(sender.sent).toHaveLength(sentBefore + 1);
    expect(api.current(1)?.id).toBe("demo-v1");
  });

  test("[FR-8.2][SR-6] a send failure is counted and surfaced, never silently lost", () => {
    const sender = new RecordingSender();
    const api = new LayoutApi({ sender });
    sender.fail = true;

    let thrown: unknown;
    try {
      api.set(1, layout());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('could not send layout "demo-v1"');
    expect(api.lastError).toBe(thrown);
    expect(api.counters.sendFailures).toBe(1);
    expect(api.counters.swaps).toBe(0);
    expect(api.counters.pendingAcks).toBe(0);

    // A later successful send clears lastError.
    sender.fail = false;
    api.set(1, layout("demo-v2"));
    expect(api.lastError).toBeNull();
    expect(api.counters.swaps).toBe(1);
  });

  test("[FR-8.2][SR-6] a 14 KB layout is validated and sent in one setLayout frame", () => {
    const sender = new RecordingSender();
    const api = new LayoutApi({ sender });
    // An extra top-level field is preserved by the SDK validator and is a
    // realistic way for a layout document to approach the 16 KB wire cap.
    const document = {
      ...layout("big-v1"),
      blob: "x".repeat(14_000),
    } as unknown as LayoutDocument;

    const serializedBytes = Buffer.byteLength(JSON.stringify(document));
    expect(serializedBytes).toBeGreaterThan(4096);
    expect(serializedBytes).toBeLessThanOrEqual(16_384);

    api.set(1, document);

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]).toMatchObject({ t: "setLayout", slot: 1 });
    expect((sender.sent[0] as { layout: unknown }).layout).toEqual(document);
    expect(api.counters.sendFailures).toBe(0);
    expect(api.counters.swaps).toBe(1);
    expect(api.lastError).toBeNull();
  });

  test("[FR-8.2][SR-6] a layout over 16 KB is rejected by the SDK validator before send", () => {
    const sender = new RecordingSender();
    const api = new LayoutApi({ sender });
    const document = {
      ...layout("huge-v1"),
      blob: "x".repeat(17_000),
    } as unknown as LayoutDocument;

    expect(Buffer.byteLength(JSON.stringify(document))).toBeGreaterThan(16_384);
    expect(() => api.set(1, document)).toThrow(LayoutValidationError);
    expect(sender.sent).toHaveLength(0);
    expect(api.counters.sendFailures).toBe(0);
    expect(api.counters.swaps).toBe(0);
    expect(api.lastError).toBeNull();
  });
});
