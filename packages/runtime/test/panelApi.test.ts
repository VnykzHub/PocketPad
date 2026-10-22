/**
 * D5-RT-01: private panel sends (one slot only), validation and cleanup.
 */
import type { HostToServerMessage, JsonValue } from "@lanpad/protocol";
import { describe, expect, test } from "vitest";
import { PanelApi, PanelValidationError } from "../src/game/PanelApi.js";

const TEXT: JsonValue = { kind: "text", title: "Hint", text: "Press A" };

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

describe("[SR-13] D5-RT-01 PanelApi", () => {
  test("[SR-13] sends private content to exactly one slot", () => {
    const sender = new RecordingSender();
    const api = new PanelApi({ sender });

    api.set(3, TEXT);

    expect(sender.sent).toEqual([{ t: "panel", slot: 3, content: TEXT }]);
    expect(api.current(3)).toEqual(TEXT);
    expect(api.current(4)).toBeNull();
    expect(api.bytes(3)).toBeGreaterThan(0);
    expect(api.counters.sent).toBe(1);
  });

  test("show is the plan's alias and content is copied on store", () => {
    const sender = new RecordingSender();
    const api = new PanelApi({ sender });
    const content: JsonValue = { kind: "text", text: "secret" };

    api.show(1, content);
    (content as { text: string }).text = "mutated";

    expect(api.current(1)).toEqual({ kind: "text", text: "secret" });
  });

  test("clear sends the documented null body and forgets the panel", () => {
    const api = new PanelApi({ sender: new RecordingSender() });
    api.set(2, TEXT);
    api.clear(2);

    expect(api.current(2)).toBeNull();
    expect(api.bytes(2)).toBe(0);
    expect(api.counters.cleared).toBe(1);
  });

  test("invalid content throws and is counted", () => {
    const sender = new RecordingSender();
    const api = new PanelApi({ sender });

    expect(() => api.set(1, { kind: "text", text: "x".repeat(1001) })).toThrow(
      PanelValidationError,
    );
    expect(() => api.set(1, null)).toThrow(PanelValidationError);
    expect(() => api.set(0, TEXT)).toThrow(RangeError);
    expect(sender.sent).toHaveLength(0);
    expect(api.counters.invalid).toBe(2);
  });

  test("[FR-5.4] player join/resume re-sends only stored content; leave clears", () => {
    const sender = new RecordingSender();
    const api = new PanelApi({ sender });
    api.set(1, TEXT);
    const sentBefore = sender.sent.length;

    api.handleJoined(1);
    api.handleResumed(1);
    expect(sender.sent.length).toBe(sentBefore + 2);

    api.handleLeft(1);
    api.handleResumed(1);
    expect(sender.sent.length).toBe(sentBefore + 2);
    expect(api.current(1)).toBeNull();
  });

  test("resendAll reaches every stored panel and a closed socket is counted", () => {
    const sender = new RecordingSender();
    const api = new PanelApi({ sender });
    api.set(1, TEXT);
    api.set(2, TEXT);
    const sentBefore = sender.sent.length;
    api.resendAll();
    expect(sender.sent.length).toBe(sentBefore + 2);

    sender.fail = true;
    expect(() => api.set(1, TEXT)).not.toThrow();
    expect(api.counters.sendFailures).toBe(1);
  });
});
