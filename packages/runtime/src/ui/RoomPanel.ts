/**
 * Room panel (D4-HOST-01; FR-5.1, FR-5.6, SR-10, AR-4).
 *
 * The lobby's single source of room credentials and the join affordances for
 * the TV: the 120px room code, the PIN, the QR, the persistent "anyone with
 * this code can join" notice and the manual join line (PAGE-PLANS HP-02).
 * Nothing else in the lobby renders the code or PIN. It owns no game, room or
 * network logic; the host shell feeds it room credentials and host-join state.
 *
 * The root carries `data-state` so the shell can show HP-01 (boot) instead of
 * the hero until a room exists, and resume HP-06 without a stale QR:
 *   - `empty`   no room yet; the shell hides the panel
 *   - `live`    a fresh room with code, PIN and a QR
 *   - `resumed` a reloaded host session; no PIN and never a stale QR
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
import { hostStatusText, type HostStatusKind } from "./HostStatus.js";

/** Exact persistent notice required by SR-10. */
export const SECURITY_NOTICE =
  "Anyone with this code can join. Only share it with people in the room.";

export const NEW_ROOM_LABEL = "New room";
export const QR_FALLBACK_TEXT =
  "QR unavailable: enter the code and PIN below.";
/** Caption under a working QR (PAGE-PLANS HP-02: caption `--muted`). */
export const QR_CAPTION = "Scan to join";

/** Room-panel layout state; drives the host shell's boot/lobby swap. */
export type RoomPanelState = "empty" | "live" | "resumed";

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
  private readonly codeEl: HTMLElement;
  private readonly pinEl: HTMLElement;
  private readonly qrCanvas: HTMLCanvasElement;
  private readonly qrCaption: HTMLElement;
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

    // HP-02 hero: the only place the code and PIN are rendered in the lobby.
    const hero = document.createElement("div");
    hero.className = "room-panel__hero";

    const label = document.createElement("p");
    label.className = "room-panel__label";
    label.textContent = "Room code";

    const digits = document.createElement("div");
    digits.className = "room-panel__digits";

    this.codeEl = document.createElement("h1");
    this.codeEl.className = "room-panel__code";
    this.codeEl.textContent = "----";

    this.pinEl = document.createElement("div");
    this.pinEl.className = "room-panel__pin";
    this.pinEl.textContent = "PIN ----";

    digits.append(this.codeEl, this.pinEl);

    this.statusEl = document.createElement("span");
    this.statusEl.className = "room-panel__status";
    this.statusEl.setAttribute("role", "status");
    this.statusEl.setAttribute("aria-live", "polite");
    this.statusEl.dataset["kind"] = "waiting";
    this.statusEl.textContent = hostStatusText("waiting");

    const topline = document.createElement("div");
    topline.className = "room-panel__topline";
    topline.append(this.statusEl);

    hero.append(label, digits, topline);

    const qrFigure = document.createElement("figure");
    qrFigure.className = "room-panel__qr";

    this.qrCanvas = document.createElement("canvas");
    this.qrCanvas.className = "room-panel__qr-canvas";
    this.qrCanvas.width = QR_CANVAS_SIZE;
    this.qrCanvas.height = QR_CANVAS_SIZE;
    this.qrCanvas.setAttribute("role", "img");
    this.qrCanvas.setAttribute("aria-label", "QR code to join the room");
    this.qrCanvas.hidden = true;

    this.qrCaption = document.createElement("figcaption");
    this.qrCaption.className = "room-panel__qr-fallback";
    this.qrCaption.textContent = "Preparing QR code…";

    qrFigure.append(this.qrCanvas, this.qrCaption);

    this.manualEl = document.createElement("p");
    this.manualEl.className = "room-panel__manual";
    this.manualEl.textContent = manualJoinInstruction(this.publicOrigin);

    const notice = document.createElement("p");
    notice.className = "room-panel__notice";
    notice.setAttribute("role", "note");
    notice.textContent = SECURITY_NOTICE;

    this.newRoomButton = document.createElement("button");
    this.newRoomButton.type = "button";
    this.newRoomButton.className = "room-panel__new-room";
    this.newRoomButton.textContent = NEW_ROOM_LABEL;
    this.newRoomButton.addEventListener("click", this.handleNewRoom);

    topline.append(this.newRoomButton);

    // HP-02 order: hero (status + New room), QR, manual line, security notice.
    layout.append(hero, qrFigure, this.manualEl, notice);

    root.classList.add("room-panel");
    root.dataset["state"] = "empty";
    root.replaceChildren(layout);
    this.syncHostClasses();
  }

  /**
   * Shows the room credentials. The QR is regenerated only when the code or
   * token changes; repeated player events never re-render it.
   */
  setRoom(room: RoomPanelRoom | null): void {
    if (room === null) {
      this.lastRoomKey = "";
      this.qrGeneration += 1;
      this.root.dataset["state"] = "empty";
      this.codeEl.textContent = "----";
      this.pinEl.textContent = "PIN ----";
      this.qrCanvas.hidden = true;
      this.qrCaption.textContent = "Waiting for a room…";
      this.qrCaption.hidden = false;
      this.syncHostClasses();
      return;
    }

    const roomKey = `${room.code}\u0000${room.roomToken}`;
    const changed = roomKey !== this.lastRoomKey;
    this.lastRoomKey = roomKey;
    this.root.dataset["state"] = "live";
    this.syncHostClasses();
    this.codeEl.textContent = room.code;
    this.pinEl.textContent = `PIN ${room.pin}`;
    this.manualEl.textContent = manualJoinInstruction(this.publicOrigin);

    if (changed) {
      void this.renderRoomQr(room);
    }
  }

  /** Updates the status line when the host socket joins or drops. */
  setHostJoined(joined: boolean): void {
    this.setHostStatus(joined ? "connected" : "waiting");
  }

  /** D4-HOST-02 status line: waiting, connected, reconnecting or lost. */
  setHostStatus(kind: HostStatusKind): void {
    this.statusEl.textContent = hostStatusText(kind);
    this.statusEl.dataset["kind"] = kind;
  }

  /**
   * Reload recovery path: only `{code, hostToken}` survived in
   * sessionStorage, so the room token/PIN for a fresh QR are gone. Phones
   * that are already connected stay in the room; the QR stays hidden
   * instead of showing a stale or token-bearing image.
   */
  setResumedRoom(code: string): void {
    this.lastRoomKey = "";
    this.qrGeneration += 1;
    this.root.dataset["state"] = "resumed";
    this.syncHostClasses();
    this.codeEl.textContent = code;
    this.pinEl.textContent = "PIN ----";
    this.qrCanvas.hidden = true;
    this.qrCaption.textContent =
      "Room resumed — phones already connected stay in the game.";
    this.qrCaption.hidden = false;
    this.statusEl.textContent = hostStatusText("connected");
    this.statusEl.dataset["kind"] = "connected";
  }

  /** Removes listeners and panel content (host teardown). */
  destroy(): void {
    this.destroyed = true;
    this.qrGeneration += 1;
    this.newRoomButton.removeEventListener("click", this.handleNewRoom);
    this.root.classList.remove("room-panel");
    delete this.root.dataset["state"];
    this.syncHostClasses();
    this.root.replaceChildren();
  }

  /** Mirrors the room state onto the host so CSS never needs :has(). */
  private syncHostClasses(): void {
    const host = this.root.closest(".host");
    if (host === null) return;
    const state = this.root.dataset["state"];
    host.classList.toggle("room-empty", state === "empty");
    host.classList.toggle("room-live", state === "live");
    host.classList.toggle("room-resumed", state === "resumed");
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
    this.qrCaption.textContent = "Preparing QR code…";
    this.qrCaption.hidden = false;

    try {
      await renderJoinQr(this.qrCanvas, joinUrl, this.renderQr);
      if (this.destroyed || generation !== this.qrGeneration) {
        return;
      }
      this.qrCanvas.hidden = false;
      this.qrCaption.textContent = QR_CAPTION;
      this.qrCaption.hidden = false;
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
    this.qrCaption.textContent = QR_FALLBACK_TEXT;
    this.qrCaption.hidden = false;
  }
}
