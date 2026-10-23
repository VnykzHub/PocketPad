/**
 * Console lobby panel (spec 25 §2.6; BUILD-BRIEF launcher).
 *
 * Eight stable rows, one per controller slot. Rows are created once and only
 * their data attributes and state word change, so a player joining or dropping
 * never rebuilds the panel or steals focus. State is always a word plus the
 * player's colour, label and shape; colour never carries meaning alone.
 *
 * With no phones in the room the panel swaps the grid for a scan-to-join
 * empty state that names the room code and can open the top-bar QR.
 */
import { resolvePlayers, slotColor, slotLabel, slotShape } from "./presentation.js";
import type {
  ConsolePlayerInput,
  ConsoleRoomInfo,
  PlayerPresence,
  PlayerShape,
} from "./types.js";

export const LOBBY_HEADING = "Players";
export const LOBBY_EMPTY_TITLE = "Scan to join";
export const LOBBY_EMPTY_HINT =
  "No phones yet. Scan the QR in the top bar, or enter the room code.";
export const LOBBY_QR_LABEL = "Show join QR";
export const LOBBY_SLOT_COUNT = 8;

const STATE_LABELS: Readonly<Record<PlayerPresence, string>> = {
  connected: "Connected",
  reconnecting: "Reconnecting",
  open: "Open",
};

export interface ConsoleLobbyOptions {
  readonly players?: readonly ConsolePlayerInput[];
  readonly room?: ConsoleRoomInfo;
  /** Opens the top-bar QR from the empty state. */
  readonly onScanRequest?: () => void;
}

interface RowBinding {
  readonly slot: number;
  readonly element: HTMLElement;
  readonly shape: HTMLElement;
  readonly label: HTMLElement;
  readonly state: HTMLElement;
}

export class ConsoleLobbyPanel {
  readonly element: HTMLElement;
  readonly emptyState: HTMLElement;
  readonly emptyHint: HTMLElement;
  readonly list: HTMLElement;
  readonly countEl: HTMLElement;
  readonly qrButton: HTMLButtonElement;

  private readonly doc: Document;
  private readonly onScanRequest: (() => void) | undefined;
  private readonly rows: RowBinding[] = [];
  private room: ConsoleRoomInfo;
  private playerInputs: readonly ConsolePlayerInput[];
  private connected = 0;

  constructor(doc: Document, options: ConsoleLobbyOptions = {}) {
    this.doc = doc;
    this.onScanRequest = options.onScanRequest;
    this.room = options.room ?? { code: null, pin: null };
    this.playerInputs = options.players ?? [];

    const root = doc.createElement("section");
    root.className = "console-lobby";
    root.setAttribute("aria-labelledby", "console-lobby-title");

    const head = doc.createElement("div");
    head.className = "console-lobby__head";
    const heading = doc.createElement("h2");
    heading.id = "console-lobby-title";
    heading.className = "console-lobby__title";
    heading.textContent = LOBBY_HEADING;
    this.countEl = doc.createElement("p");
    this.countEl.className = "console-lobby__count";
    head.append(heading, this.countEl);

    this.emptyState = doc.createElement("div");
    this.emptyState.className = "console-lobby__empty";
    const emptyTitle = doc.createElement("h3");
    emptyTitle.className = "console-lobby__empty-title";
    emptyTitle.textContent = LOBBY_EMPTY_TITLE;
    this.emptyHint = doc.createElement("p");
    this.emptyHint.className = "console-lobby__empty-hint";
    this.qrButton = doc.createElement("button");
    this.qrButton.setAttribute("type", "button");
    this.qrButton.className = "console-lobby__qr";
    this.qrButton.textContent = LOBBY_QR_LABEL;
    this.qrButton.addEventListener("click", this.handleScanRequest);
    this.emptyState.append(emptyTitle, this.emptyHint, this.qrButton);

    this.list = doc.createElement("ul");
    this.list.className = "console-lobby__list";
    this.list.setAttribute("aria-label", "Player slots");
    for (let slot = 1; slot <= LOBBY_SLOT_COUNT; slot += 1) {
      this.list.append(this.createRow(slot).element);
    }

    root.append(head, this.emptyState, this.list);
    this.element = root;
    this.render();
  }

  get connectedCount(): number {
    return this.connected;
  }

  setPlayers(inputs: readonly ConsolePlayerInput[]): void {
    this.playerInputs = inputs;
    this.render();
  }

  setRoom(room: ConsoleRoomInfo): void {
    this.room = room;
    this.render();
  }

  destroy(): void {
    this.qrButton.removeEventListener("click", this.handleScanRequest);
    this.rows.length = 0;
    this.element.remove();
  }

  private createRow(slot: number): RowBinding {
    const doc = this.doc;
    const element = doc.createElement("li");
    element.className = "console-lobby__row";
    element.dataset["slot"] = String(slot);
    element.dataset["state"] = "open";

    const shape = doc.createElement("span");
    shape.className = "console-lobby__shape";
    shape.dataset["shape"] = slotShape(slot);
    shape.setAttribute("aria-hidden", "true");

    const label = doc.createElement("span");
    label.className = "console-lobby__label";
    label.textContent = slotLabel(slot);

    const state = doc.createElement("span");
    state.className = "console-lobby__state";
    state.textContent = STATE_LABELS.open;

    element.append(shape, label, state);
    const binding: RowBinding = { slot, element, shape, label, state };
    this.rows.push(binding);
    return binding;
  }

  private render(): void {
    const players = resolvePlayers(this.playerInputs);
    const bySlot = new Map(players.map((player) => [player.slot, player]));
    this.connected = players.filter(
      (player) => player.state === "connected",
    ).length;

    for (const row of this.rows) {
      const player = bySlot.get(row.slot);
      const state: PlayerPresence = player?.state ?? "open";
      const label = player?.label ?? slotLabel(row.slot);
      const color = player?.color ?? slotColor(row.slot);
      const shape: PlayerShape = player?.shape ?? slotShape(row.slot);

      row.element.dataset["state"] = state;
      row.element.setAttribute(
        "aria-label",
        `${label}, ${STATE_LABELS[state]}`,
      );
      row.shape.dataset["shape"] = shape;
      row.element.style.setProperty("--player-color", color);
      row.label.textContent = label;
      row.state.textContent = STATE_LABELS[state];
    }

    const code = this.room.code?.trim() ?? "";
    this.emptyHint.textContent =
      code.length > 0
        ? `No phones yet. Scan the QR in the top bar, or enter room ${code}.`
        : LOBBY_EMPTY_HINT;
    this.emptyState.hidden = this.connected > 0;
    this.list.hidden = this.connected === 0;
    this.countEl.textContent = `${this.connected} of ${LOBBY_SLOT_COUNT}`;
  }

  private readonly handleScanRequest = (): void => {
    this.onScanRequest?.();
  };
}
