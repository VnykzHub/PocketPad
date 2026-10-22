/**
 * HP-08 slot roster (SR-6, FR-5.4, AR-4).
 *
 * Always eight 80px rows, one per controller slot, so the TV lobby never
 * reflows as players join: a slot is either `open` (hollow 20px ring, faint
 * text), `connected` (player-hue swatch, 2px lime left mark) or
 * `reconnecting` (warning dot while the 30s slot reservation runs). State is
 * never colour alone — every row keeps its word.
 *
 * The roster is display-only. It never imports the host shell or the socket;
 * the shell feeds it the slot states it already tracks, including
 * `hostStats`-shaped data. An off-screen live region announces the connected
 * count so a TV viewer gets the same information as the visual rows.
 */
import { MAX_CONTROLLERS } from "@lanpad/protocol";

export type SlotRosterState = "open" | "connected" | "reconnecting";

export interface SlotRosterEntry {
  /** 1-based controller slot. */
  readonly slot: number;
  readonly state: SlotRosterState;
}

/** The word shown in each row; `Connected`/`Reconnecting`/`Open`. */
export const SLOT_STATE_LABEL: Readonly<Record<SlotRosterState, string>> = {
  open: "Open",
  connected: "Connected",
  reconnecting: "Reconnecting",
};

export interface SlotRosterOptions {
  /** Region label for the list. Default "Players". */
  readonly label?: string;
}

export class SlotRoster {
  readonly element: HTMLElement;

  private readonly rows: HTMLElement[] = [];
  private readonly stateEls: HTMLElement[] = [];
  private readonly summaryEl: HTMLElement;
  private lastSummary = "";

  constructor(doc: Document, options: SlotRosterOptions = {}) {
    const list = doc.createElement("ul");
    list.className = "slot-roster";
    list.setAttribute("aria-label", options.label ?? "Players");

    for (let slot = 1; slot <= MAX_CONTROLLERS; slot += 1) {
      const row = doc.createElement("li");
      row.className = "slot-row";
      row.dataset["slot"] = String(slot);
      row.dataset["state"] = "open";

      const swatch = doc.createElement("span");
      swatch.className = "slot-row__swatch";
      swatch.setAttribute("aria-hidden", "true");

      const name = doc.createElement("span");
      name.className = "slot-row__name";
      name.textContent = `Player ${slot}`;

      const state = doc.createElement("span");
      state.className = "slot-row__state";
      state.textContent = SLOT_STATE_LABEL.open;

      row.append(swatch, name, state);
      list.append(row);
      this.rows.push(row);
      this.stateEls.push(state);
    }

    this.summaryEl = doc.createElement("span");
    this.summaryEl.className = "visually-hidden";
    this.summaryEl.setAttribute("role", "status");
    this.summaryEl.setAttribute("aria-live", "polite");
    this.setSummary(0, 0);

    const root = doc.createElement("div");
    root.className = "slot-roster-mount";
    root.append(list, this.summaryEl);
    this.element = root;
  }

  /**
   * Applies the current slot states. Entries outside 1..8 are ignored and
   * slots missing from `entries` fall back to `open`, so a full snapshot is
   * the only input the roster needs.
   */
  update(entries: readonly SlotRosterEntry[]): void {
    const states = new Map<number, SlotRosterState>();
    for (const entry of entries) {
      if (
        Number.isInteger(entry.slot) &&
        entry.slot >= 1 &&
        entry.slot <= MAX_CONTROLLERS
      ) {
        states.set(entry.slot, entry.state);
      }
    }

    let connected = 0;
    let reconnecting = 0;
    for (let slot = 1; slot <= MAX_CONTROLLERS; slot += 1) {
      const state = states.get(slot) ?? "open";
      const row = this.rows[slot - 1];
      const stateEl = this.stateEls[slot - 1];
      if (row === undefined || stateEl === undefined) continue;
      row.dataset["state"] = state;
      stateEl.textContent = SLOT_STATE_LABEL[state];
      if (state === "connected") connected += 1;
      if (state === "reconnecting") reconnecting += 1;
    }

    this.setSummary(connected, reconnecting);
  }

  /** Appends the roster to `parent`. */
  mount(parent: HTMLElement): void {
    parent.append(this.element);
  }

  /** Removes the roster from the document. Safe to call twice. */
  destroy(): void {
    this.element.remove();
  }

  private setSummary(connected: number, reconnecting: number): void {
    // "N of 8 players" — the plural names the eight slots, even when N is 1.
    const summary =
      reconnecting > 0
        ? `${connected} of ${MAX_CONTROLLERS} players connected, ${reconnecting} reconnecting`
        : `${connected} of ${MAX_CONTROLLERS} players connected`;
    // Re-setting identical text would make the live region re-announce on
    // every hostStats tick; only write when the count actually changed.
    if (summary === this.lastSummary) return;
    this.lastSummary = summary;
    this.summaryEl.textContent = summary;
  }
}
