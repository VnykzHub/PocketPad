/**
 * Connection pill state machine and view (D4-CTRL-02; SPEC §8.5, A9).
 *
 * One vocabulary for every connection state the player can see:
 *
 *   Connecting → Connected (P#) → Reconnecting → Disconnected
 *   plus host presence: "Waiting for TV" (`hostStatus lost`) and "TV paused"
 *   (`hostStatus paused`).
 *
 * The model is pure and separate from the DOM so both the reconnect tests and
 * the page shell share exactly the same mapping. Host presence is only shown
 * while connected: a socket that is down has no trustworthy host state, and
 * the next `hostStatus` after the rejoin replaces it.
 */
import type { HostStatusState } from "@lanpad/protocol";

/** Socket-level phase. `connecting` includes the very first join. */
export type ConnectionPillPhase = "connecting" | "connected" | "reconnecting" | "disconnected";

export interface ConnectionPillState {
  phase: ConnectionPillPhase;
  /** Slot from `joined`; null before the first assignment. */
  slot: number | null;
  /** Last `hostStatus` seen while connected; null when unknown. */
  host: HostStatusState | null;
}

export const INITIAL_CONNECTION_PILL_STATE: ConnectionPillState = {
  phase: "disconnected",
  slot: null,
  host: null,
};

/** Visible text for a state. Never contains a token or PIN. */
export function connectionPillText(state: ConnectionPillState): string {
  switch (state.phase) {
    case "disconnected":
      return "Disconnected";
    case "reconnecting":
      return "Reconnecting";
    case "connecting":
      return "Connecting";
    case "connected":
      switch (state.host) {
        case "lost":
          return "Waiting for TV";
        case "paused":
          return "TV paused";
        default:
          return state.slot === null ? "Connected" : `Connected (P${state.slot})`;
      }
  }
}

/** `data-state` attribute value; CSS hooks for the page shell. */
export function connectionPillDataState(state: ConnectionPillState): string {
  switch (state.phase) {
    case "disconnected":
      return "disconnected";
    case "reconnecting":
      return "reconnecting";
    case "connecting":
      return "connecting";
    case "connected":
      if (state.host === "lost") {
        return "waiting-for-tv";
      }
      if (state.host === "paused") {
        return "tv-paused";
      }
      return "connected";
  }
}

/**
 * Observable pill state. `setPhase` is the socket lifecycle; `setHostStatus`
 * feeds the A9 server broadcast. Leaving `connected` clears the host state so
 * a stale "Waiting for TV" cannot survive a reconnect.
 */
export class ConnectionPillModel {
  private current: ConnectionPillState = { ...INITIAL_CONNECTION_PILL_STATE };
  private readonly listeners = new Set<(state: ConnectionPillState) => void>();

  get state(): ConnectionPillState {
    return this.current;
  }

  /** Subscribes and immediately receives the current state. */
  subscribe(listener: (state: ConnectionPillState) => void): () => void {
    this.listeners.add(listener);
    listener(this.current);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setPhase(phase: ConnectionPillPhase, slot: number | null = null): void {
    this.update({
      phase,
      slot: phase === "connected" ? slot : null,
      host: phase === "connected" ? this.current.host : null,
    });
  }

  setSlot(slot: number | null): void {
    if (this.current.slot === slot) {
      return;
    }
    this.update({ ...this.current, slot });
  }

  setHostStatus(host: HostStatusState | null): void {
    if (this.current.host === host) {
      return;
    }
    this.update({ ...this.current, host });
  }

  private update(next: ConnectionPillState): void {
    this.current = next;
    for (const listener of this.listeners) {
      listener(next);
    }
  }
}

/**
 * Binds a model to a DOM element. The element is owned by the page shell; this
 * class only writes `textContent` and `data-state`.
 */
export class ConnectionPill {
  private readonly element: HTMLElement;
  private readonly model: ConnectionPillModel;
  private readonly unsubscribe: () => void;

  constructor(element: HTMLElement, model: ConnectionPillModel = new ConnectionPillModel()) {
    this.element = element;
    this.model = model;
    this.unsubscribe = model.subscribe((state) => {
      this.render(state);
    });
  }

  get state(): ConnectionPillState {
    return this.model.state;
  }

  get connectionModel(): ConnectionPillModel {
    return this.model;
  }

  destroy(): void {
    this.unsubscribe();
  }

  private render(state: ConnectionPillState): void {
    this.element.textContent = connectionPillText(state);
    this.element.dataset["state"] = connectionPillDataState(state);
  }
}
