/**
 * Host private-panel API (D5-RT-01; FR-8.1, FR-8.4, SR-13, D5 contracts 3, 7).
 *
 * `ctx.panels.set(slot, content)` validates the SDK panel schema, sends the
 * panel to exactly one slot and keeps the last validated body for reconnect
 * recovery. `ctx.panels.clear(slot)` sends `{content:null}` (the documented
 * clear path) and forgets the stored body. Panels are never broadcast and the
 * host never receives an echo, so one phone's secret cannot leak to another.
 *
 * Bodies stay opaque to the transport (FR-7.9). No socket is exposed to games
 * (FR-7.17); the injected sender is the host client's `send`.
 */
import {
  MAX_PANEL_CONTENT_BYTES,
  validatePanelContent,
} from "@lanpad/sdk";
import {
  MAX_CONTROLLERS,
  jsonByteLength,
  type HostToServerMessage,
  type JsonValue,
} from "@lanpad/protocol";

/** Minimal sender surface; `HostClient.send` satisfies it. */
export interface PanelSender {
  send(message: HostToServerMessage): void;
}

export interface PanelApiDeps {
  readonly sender: PanelSender;
  /** Number of slots the host exposes, 1..8. Default 8. */
  readonly slots?: number;
}

/** Thrown when the SDK validator rejects panel content (developer error). */
export class PanelValidationError extends Error {
  readonly errors: readonly string[];

  constructor(errors: readonly string[]) {
    super(`Invalid panel content: ${errors.join("; ")}.`);
    this.name = "PanelValidationError";
    this.errors = errors;
  }
}

export interface PanelCounters {
  readonly sent: number;
  readonly cleared: number;
  readonly sendFailures: number;
  readonly invalid: number;
  /** Total serialized bytes of all currently stored panels. */
  readonly storedBytes: number;
}

interface StoredPanel {
  /** Last validated body, or null after `clear()`. */
  content: JsonValue | null;
  bytes: number;
}

export class PanelApi {
  private readonly sender: PanelSender;
  private readonly slotCount: number;
  private readonly stored: StoredPanel[];

  private sentCount = 0;
  private clearedCount = 0;
  private sendFailures = 0;
  private invalidCount = 0;

  constructor(deps: PanelApiDeps) {
    const slots = deps.slots ?? MAX_CONTROLLERS;
    if (!Number.isInteger(slots) || slots < 1 || slots > MAX_CONTROLLERS) {
      throw new RangeError(
        `PanelApi slots must be an integer in 1..${MAX_CONTROLLERS}.`,
      );
    }
    this.sender = deps.sender;
    this.slotCount = slots;
    this.stored = [];
    for (let index = 0; index < slots; index += 1) {
      this.stored.push({ content: null, bytes: 0 });
    }
  }

  get counters(): PanelCounters {
    let storedBytes = 0;
    for (const entry of this.stored) {
      storedBytes += entry.bytes;
    }
    return {
      sent: this.sentCount,
      cleared: this.clearedCount,
      sendFailures: this.sendFailures,
      invalid: this.invalidCount,
      storedBytes,
    };
  }

  /**
   * Validates and sends private content to one slot. `content` is the SDK's
   * `PanelContent`; it is validated as untrusted JSON.
   */
  set(slot: number, content: JsonValue): void {
    this.assertSlot(slot, "set");
    const result = validatePanelContent(content);
    if (!result.ok) {
      this.invalidCount += 1;
      throw new PanelValidationError(result.errors);
    }
    const body = result.content as unknown as JsonValue;
    const bytes = jsonByteLength(JSON.stringify(body));
    if (bytes > MAX_PANEL_CONTENT_BYTES) {
      // The validator already enforces this; keep the guard in one place.
      this.invalidCount += 1;
      throw new PanelValidationError([
        `panel: serialized size ${bytes} bytes exceeds the ${MAX_PANEL_CONTENT_BYTES}-byte limit`,
      ]);
    }

    const entry = this.stored[slot - 1];
    if (entry === undefined) {
      return;
    }
    // Deep copy so a game mutating its object cannot change a later resend.
    entry.content = JSON.parse(JSON.stringify(body)) as JsonValue;
    entry.bytes = bytes;
    this.send(slot, entry.content);
  }

  /** Convenience alias matching the plan's `ctx.panels.set` wording. */
  show(slot: number, content: JsonValue): void {
    this.set(slot, content);
  }

  /** Sends the documented clear body and forgets the stored content. */
  clear(slot: number): void {
    this.assertSlot(slot, "clear");
    const entry = this.stored[slot - 1];
    if (entry !== undefined) {
      entry.content = null;
      entry.bytes = 0;
    }
    this.clearedCount += 1;
    this.send(slot, null);
  }

  /** Last stored content for one slot, or null. Copy before mutating. */
  current(slot: number): JsonValue | null {
    return this.validSlot(slot) ? this.stored[slot - 1]?.content ?? null : null;
  }

  /** Serialized bytes currently stored for one slot (0 when cleared). */
  bytes(slot: number): number {
    return this.validSlot(slot) ? this.stored[slot - 1]?.bytes ?? 0 : 0;
  }

  /** Controller join: the broker may already replay; the host resends too. */
  handleJoined(slot: number): void {
    this.resend(slot);
  }

  /** `playerResumed`: the plan requires an unconditional re-send. */
  handleResumed(slot: number): void {
    this.resend(slot);
  }

  /** `playerLeft`: forget the slot's private content. */
  handleLeft(slot: number): void {
    if (!this.validSlot(slot)) {
      return;
    }
    const entry = this.stored[slot - 1];
    if (entry !== undefined) {
      entry.content = null;
      entry.bytes = 0;
    }
  }

  /** Re-sends a slot's stored panel, if any (no clear replay). */
  resend(slot: number): void {
    if (!this.validSlot(slot)) {
      return;
    }
    const content = this.stored[slot - 1]?.content ?? null;
    if (content !== null) {
      this.send(slot, content);
    }
  }

  /** Re-sends every stored panel (host reconnect). */
  resendAll(): void {
    for (let slot = 1; slot <= this.slotCount; slot += 1) {
      this.resend(slot);
    }
  }

  /** Drops all stored panels (room lost or host teardown). */
  clearAll(): void {
    for (const entry of this.stored) {
      entry.content = null;
      entry.bytes = 0;
    }
  }

  private send(slot: number, content: JsonValue | null): void {
    try {
      this.sender.send({ t: "panel", slot, content });
    } catch {
      this.sendFailures += 1;
      return;
    }
    this.sentCount += 1;
  }

  private assertSlot(slot: number, method: string): void {
    if (!this.validSlot(slot)) {
      throw new RangeError(
        `ctx.panels.${method} slot must be an integer in 1..${this.slotCount}.`,
      );
    }
  }

  private validSlot(slot: number): boolean {
    return Number.isInteger(slot) && slot >= 1 && slot <= this.slotCount;
  }
}
