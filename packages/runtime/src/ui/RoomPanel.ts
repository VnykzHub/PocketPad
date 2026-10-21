/**
 * Room panel (D4-HOST-01; FR-5.1, FR-5.6, SR-10, AR-4).
 *
 * Renders the join affordances for the TV: a large QR, the 4-character room
 * code, the 4-digit PIN, the persistent "anyone with this code can join"
 * notice and the manual join line. It owns no game, room or network logic;
 * the host shell feeds it room credentials and host-join state.
 *
 * Secrets: the room token is accepted only to build the QR URL. It is never
 * written to text content, an attribute or a log. If QR rendering fails the
 * fallback is the manual code + PIN path, never the token-bearing URL (FR-5.1,
 * SR-2, SR-9).
 */
import {
  buildJoinUrl,
  defaultQrRenderer,
  renderJoinQr,
  resolvePublicOrigin,
  QR_CANVAS_SIZE,
  type QrRenderer,
} from "./QrCode.js";

/** Exact persistent notice required by SR-10. */
export const SECURITY_NOTICE =
  "Anyone with this code can join. Only share it with people in the room.";

export const NEW_ROOM_LABEL = "New room";
export const QR_FALLBACK_TEXT =
  "QR unavailable: enter the code and PIN below.";

/** The credentials the panel needs from `POST /api/rooms`. */
export interface RoomPanelRoom {
  readonly code: string;
  readonly pin: string;
  readonly roomToken: string;
}

export interface RoomPanelOptions {
  /** Pages origin for the join URL; defaults to VITE_PUBLIC_ORIGIN or location.origin. */
  readonly publicOrigin?: string;
  /** Test/swap seam; defaults to `qrcode.toCanvas`. */
  readonly renderQr?: QrRenderer;
  /** Called by the "New room" button. The shell performs the room creation. */
  readonly onNewRoom?: () => void;
}

/**
 * Manual join line from D4-HOST-01. It is always visible, including when the
 * QR fails, so a phone without a camera can join (FR-5.6).
 */
export function manualJoinInstruction(publicOrigin: string): string {
  const base = publicOrigin.trim().replace(/\/+$/, "");
  if (base.length === 0) {
    return "Or open /c and enter the code + PIN";
  }
  return `Or open ${base}/c and enter the code + PIN`;
}

function resolvePublicOriginSafely(explicit?: string): string {
  try {
    return resolvePublicOrigin(explicit);
  } catch {
    // A missing/invalid origin must not remove the manual join path.
    return "";
  }
}

export class RoomPanel {
  readonly root: HTMLElement;
  readonly newRoomButton: HTMLButtonElement;

  private readonly renderQr: QrRenderer;
  private readonly publicOrigin: string;
  private readonly codeEl: HTMLDivElement;
  private readonly pinEl: HTMLDivElement;
  private readonly qrCanvas: HTMLCanvasElement;
  private readonly qrFallback: HTMLElement;
  private readonly manualEl: HTMLParagraphElement;
  private readonly statusEl: HTMLSpanElement;
  private readonly onNewRoom: (() => void) | undefined;

  /** Last code+token pair; keeps the QR from regenerating on every event. */
  private lastRoomKey = "";
  /** Guards async QR completions that arrive after a newer room/destroy. */
  private qrGeneration = 0;
  private destroyed = false;

  constructor(root: HTMLElement, options: RoomPanelOptions = {}) {
    this.root = root;
    this.renderQr = options.renderQr ?? defaultQrRenderer;
    this.publicOrigin = resolvePublicOriginSafely(options.publicOrigin);
    this.onNewRoom = options.onNewRoom;

    const layout = document.createElement("div");
    layout.className = "room-panel__layout";

    const qrFigure = document.createElement("figure");
    qrFigure.className = "room-panel__qr";

    this.qrCanvas = document.createElement("canvas");
    this.qrCanvas.className = "room-panel__qr-canvas";
    this.qrCanvas.width = QR_CANVAS_SIZE;
    this.qrCanvas.height = QR_CANVAS_SIZE;
    this.qrCanvas.setAttribute("role", "img");
    this.qrCanvas.setAttribute("aria-label", "QR code to join the room");
    this.qrCanvas.hidden = true;

    this.qrFallback = document.createElement("figcaption");
    this.qrFallback.className = "room-panel__qr-fallback";
    this.qrFallback.textContent = "Preparing QR code…";

    qrFigure.append(this.qrCanvas, this.qrFallback);

    const digits = document.createElement("div");
    digits.className = "room-panel__digits";

    this.codeEl = document.createElement("div");
    this.codeEl.className = "room-panel__code";
    this.codeEl.setAttribute("aria-label", "Room code");
    this.codeEl.textContent = "----";

    this.pinEl = document.createElement("div");
    this.pinEl.className = "room-panel__pin";
    this.pinEl.setAttribute("aria-label", "Room PIN");
    this.pinEl.textContent = "PIN ----";

    digits.append(this.codeEl, this.pinEl);
    layout.append(qrFigure, digits);

    const notice = document.createElement("p");
    notice.className = "room-panel__notice";
    notice.setAttribute("role", "note");
    notice.textContent = SECURITY_NOTICE;

    this.manualEl = document.createElement("p");
    this.manualEl.className = "room-panel__manual";
    this.manualEl.textContent = manualJoinInstruction(this.publicOrigin);

    const actions = document.createElement("div");
    actions.className = "room-panel__actions";

    this.newRoomButton = document.createElement("button");
    this.newRoomButton.type = "button";
    this.newRoomButton.className = "room-panel__new-room";
    this.newRoomButton.textContent = NEW_ROOM_LABEL;
    this.newRoomButton.addEventListener("click", this.handleNewRoom);

    this.statusEl = document.createElement("span");
    this.statusEl.className = "room-panel__status";
    this.statusEl.setAttribute("role", "status");
    this.statusEl.setAttribute("aria-live", "polite");
    this.statusEl.textContent = "Waiting for a room…";

    actions.append(this.newRoomButton, this.statusEl);

    root.classList.add("room-panel");
    root.replaceChildren(layout, notice, this.manualEl, actions);
  }

  /**
   * Shows the room credentials. The QR is regenerated only when the code or
   * token changes; repeated player events never re-render it.
   */
  setRoom(room: RoomPanelRoom | null): void {
    if (room === null) {
      this.lastRoomKey = "";
      this.qrGeneration += 1;
      this.codeEl.textContent = "----";
      this.pinEl.textContent = "PIN ----";
      this.qrCanvas.hidden = true;
      this.qrFallback.textContent = "Waiting for a room…";
      this.qrFallback.hidden = false;
      return;
    }

    const roomKey = `${room.code}\u0000${room.roomToken}`;
    const changed = roomKey !== this.lastRoomKey;
    this.lastRoomKey = roomKey;
    this.codeEl.textContent = room.code;
    this.pinEl.textContent = `PIN ${room.pin}`;
    this.manualEl.textContent = manualJoinInstruction(this.publicOrigin);

    if (changed) {
      void this.renderRoomQr(room);
    }
  }

  /** Updates the status line when the host socket joins or drops. */
  setHostJoined(joined: boolean): void {
    this.statusEl.textContent = joined
      ? "Room ready: scan the QR or enter the code and PIN."
      : "Joining the room…";
  }

  /** Removes listeners and panel content (host teardown). */
  destroy(): void {
    this.destroyed = true;
    this.qrGeneration += 1;
    this.newRoomButton.removeEventListener("click", this.handleNewRoom);
    this.root.classList.remove("room-panel");
    this.root.replaceChildren();
  }

  private readonly handleNewRoom = (): void => {
    this.onNewRoom?.();
  };

  private async renderRoomQr(room: RoomPanelRoom): Promise<void> {
    const generation = ++this.qrGeneration;
    let joinUrl: string;
    try {
      joinUrl = buildJoinUrl(this.publicOrigin, room.code, room.roomToken);
    } catch {
      this.showQrFallback();
      return;
    }

    this.qrCanvas.hidden = true;
    this.qrFallback.textContent = "Preparing QR code…";
    this.qrFallback.hidden = false;

    try {
      await renderJoinQr(this.qrCanvas, joinUrl, this.renderQr);
      if (this.destroyed || generation !== this.qrGeneration) {
        return;
      }
      this.qrCanvas.hidden = false;
      this.qrFallback.hidden = true;
    } catch {
      if (this.destroyed || generation !== this.qrGeneration) {
        return;
      }
      // Deliberately no console output: the URL contains the room token.
      this.showQrFallback();
    }
  }

  private showQrFallback(): void {
    this.qrCanvas.hidden = true;
    this.qrFallback.textContent = QR_FALLBACK_TEXT;
    this.qrFallback.hidden = false;
  }
}
