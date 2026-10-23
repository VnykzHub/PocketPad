/**
 * Console top bar (spec 25 §2.5): room code, PIN, QR toggle, connection,
 * clock and one chip per connected player.
 *
 * State is never colour alone: the connection pill always carries a word, and
 * every player chip carries its `P1..P8` label and a shape, coloured with the
 * DESIGN `--player-*` hue. The join URL (which carries the room token in its
 * fragment) is only ever handed to the injected QR renderer; it is never
 * written to text content or an attribute.
 */
import {
  connectedPlayers,
  resolvePlayers,
} from "./presentation.js";
import type {
  ConsoleConnection,
  ConsolePlayer,
  ConsolePlayerInput,
  ConsoleRoomInfo,
} from "./types.js";

/** Renders a join URL into the canvas; injected so tests avoid `qrcode`. */
export type QrRenderer = (
  canvas: HTMLCanvasElement,
  joinUrl: string,
) => Promise<unknown>;

export const QR_UNAVAILABLE = "Join QR unavailable";
export const QR_CAPTION = "Scan to join";

export interface ConsoleTopBarOptions {
  readonly room?: ConsoleRoomInfo;
  readonly connection?: ConsoleConnection;
  readonly players?: readonly ConsolePlayerInput[];
  readonly renderQr?: QrRenderer;
}

let nextQrPanelId = 0;

/** 24-hour `HH:MM`, tabular in CSS. Invalid dates render `--:--`. */
export function formatClock(now: Date): string {
  if (Number.isNaN(now.getTime())) return "--:--";
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

export class ConsoleTopBar {
  readonly element: HTMLElement;
  readonly qrToggle: HTMLButtonElement;
  readonly qrPanel: HTMLElement;
  readonly qrStatus: HTMLElement;
  readonly clockEl: HTMLTimeElement;
  readonly connectionEl: HTMLElement;
  readonly chipsEl: HTMLElement;
  readonly codeEl: HTMLElement;
  readonly pinEl: HTMLElement;

  private readonly doc: Document;
  private readonly renderQr: QrRenderer | undefined;
  private readonly panelId: string;
  private room: ConsoleRoomInfo;
  private qrCanvas: HTMLCanvasElement | null = null;
  private qrOpen = false;
  private chipSignature = "";
  private renderGeneration = 0;
  private destroyed = false;

  constructor(doc: Document, options: ConsoleTopBarOptions = {}) {
    this.doc = doc;
    this.renderQr = options.renderQr;
    this.room = options.room ?? { code: null, pin: null };
    this.panelId = `console-qr-${nextQrPanelId++}`;

    const root = doc.createElement("header");
    root.className = "console-top";

    const left = doc.createElement("div");
    left.className = "console-top__left";

    this.codeEl = doc.createElement("span");
    this.codeEl.className = "console-top__code";
    this.codeEl.dataset["role"] = "room-code";

    this.pinEl = doc.createElement("span");
    this.pinEl.className = "console-top__pin";

    this.qrToggle = doc.createElement("button");
    this.qrToggle.setAttribute("type", "button");
    this.qrToggle.className = "console-top__qr-toggle";
    this.qrToggle.setAttribute("aria-expanded", "false");
    this.qrToggle.setAttribute("aria-controls", this.panelId);
    this.qrToggle.textContent = "QR";
    this.qrToggle.addEventListener("click", this.handleQrToggle);

    left.append(this.codeEl, this.pinEl, this.qrToggle);

    this.qrPanel = doc.createElement("div");
    this.qrPanel.className = "console-qr";
    this.qrPanel.id = this.panelId;
    this.qrPanel.hidden = true;
    this.qrStatus = doc.createElement("p");
    this.qrStatus.className = "console-qr__status";
    this.qrStatus.setAttribute("role", "status");
    this.qrStatus.setAttribute("aria-live", "polite");
    this.qrPanel.append(this.qrStatus);

    const right = doc.createElement("div");
    right.className = "console-top__right";

    this.connectionEl = doc.createElement("span");
    this.connectionEl.className = "console-status";
    const connectionDot = doc.createElement("span");
    connectionDot.className = "console-status__dot";
    connectionDot.setAttribute("aria-hidden", "true");
    const connectionText = doc.createElement("span");
    connectionText.className = "console-status__text";
    this.connectionEl.append(connectionDot, connectionText);

    this.clockEl = doc.createElement("time");
    this.clockEl.className = "console-top__clock";

    this.chipsEl = doc.createElement("div");
    this.chipsEl.className = "console-top__players";
    this.chipsEl.setAttribute("role", "list");
    this.chipsEl.setAttribute("aria-label", "Connected players");

    right.append(this.connectionEl, this.clockEl, this.chipsEl);
    root.append(left, this.qrPanel, right);
    this.element = root;

    this.renderRoom();
    this.setConnection(options.connection ?? { text: "Room live", tone: "ok" });
    this.setClock(new Date());
    this.setPlayers(options.players ?? []);
  }

  get roomInfo(): ConsoleRoomInfo {
    return this.room;
  }

  get isQrOpen(): boolean {
    return this.qrOpen;
  }

  setRoom(room: ConsoleRoomInfo): void {
    this.room = room;
    this.renderRoom();
    if (this.qrOpen) this.renderQrPanel();
  }

  setConnection(connection: ConsoleConnection): void {
    const text = this.connectionEl.children[1];
    if (text !== undefined) text.textContent = connection.text;
    this.connectionEl.dataset["tone"] = connection.tone;
    this.connectionEl.setAttribute(
      "aria-label",
      `Connection: ${connection.text}`,
    );
  }

  setClock(now: Date): void {
    this.clockEl.textContent = formatClock(now);
    this.clockEl.setAttribute("datetime", now.toISOString());
  }

  /** Rebuilds chips only when the resolved player list changed. */
  setPlayers(inputs: readonly ConsolePlayerInput[]): void {
    const players = connectedPlayers(resolvePlayers(inputs));
    const signature = players
      .map(
        (player) =>
          `${player.slot}:${player.color}:${player.shape}:${player.label}`,
      )
      .join("|");
    if (signature === this.chipSignature) return;
    this.chipSignature = signature;

    const chips: HTMLElement[] = [];
    for (const player of players) chips.push(this.createChip(player));
    this.chipsEl.replaceChildren(...chips);
    this.chipsEl.hidden = chips.length === 0;
  }

  setQrOpen(open: boolean): void {
    if (this.destroyed || this.qrOpen === open) return;
    this.qrOpen = open;
    this.qrPanel.hidden = !open;
    this.qrToggle.setAttribute("aria-expanded", open ? "true" : "false");
    this.qrToggle.textContent = open ? "Hide QR" : "QR";
    if (open) this.renderQrPanel();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.renderGeneration += 1;
    this.qrToggle.removeEventListener("click", this.handleQrToggle);
    this.element.remove();
  }

  private createChip(player: ConsolePlayer): HTMLElement {
    const chip = this.doc.createElement("span");
    chip.className = "console-chip";
    chip.setAttribute("role", "listitem");
    chip.dataset["slot"] = String(player.slot);
    chip.dataset["shape"] = player.shape;
    chip.style.setProperty("--chip-color", player.color);

    const shape = this.doc.createElement("span");
    shape.className = "console-chip__shape";
    shape.dataset["shape"] = player.shape;
    shape.setAttribute("aria-hidden", "true");

    const label = this.doc.createElement("span");
    label.className = "console-chip__label";
    label.textContent = player.label;

    const state = this.doc.createElement("span");
    state.className = "visually-hidden";
    state.textContent = "connected";

    chip.append(shape, label, state);
    return chip;
  }

  private renderRoom(): void {
    const code = this.room.code?.trim() ?? "";
    this.codeEl.textContent = code.length > 0 ? code : "----";
    const pin = this.room.pin?.trim() ?? "";
    this.pinEl.textContent = pin.length > 0 ? `PIN ${pin}` : "PIN ----";
  }

  private renderQrPanel(): void {
    const generation = ++this.renderGeneration;
    const joinUrl = this.room.joinUrl ?? null;
    if (joinUrl === null || this.renderQr === undefined) {
      this.qrStatus.textContent = QR_UNAVAILABLE;
      if (this.qrCanvas !== null) {
        this.qrCanvas.remove();
        this.qrCanvas = null;
      }
      return;
    }

    let canvas = this.qrCanvas;
    if (canvas === null) {
      canvas = this.doc.createElement("canvas");
      canvas.className = "console-qr__canvas";
      canvas.setAttribute("width", "384");
      canvas.setAttribute("height", "384");
      this.qrCanvas = canvas;
      this.qrPanel.append(canvas);
    }
    this.qrStatus.textContent = QR_CAPTION;

    // The URL is an argument only: never text, never an attribute.
    void this.renderQr(canvas, joinUrl).catch(() => {
      if (this.destroyed || generation !== this.renderGeneration) return;
      this.qrStatus.textContent = QR_UNAVAILABLE;
    });
  }

  private readonly handleQrToggle = (): void => {
    this.setQrOpen(!this.qrOpen);
  };
}
