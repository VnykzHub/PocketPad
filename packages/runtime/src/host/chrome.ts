/**
 * Host chrome: connection pill, stage bar, reconnect banner and fullscreen.
 *
 * The class names are owned by `src/style.css`. Stage ownership is mirrored as
 * a class on `#app` so older TV browsers never need `:has()`.
 */
import { RECONNECT_BANNER_TEXT } from "./copy.js";

export type ConnectionTone = "pending" | "ok" | "bad";

export interface HostChrome {
  /** HP-04 stage bar; hidden until a game starts. */
  readonly stageBar: HTMLElement;
  readonly stageRoomEl: HTMLElement;
  readonly stagePlayersEl: HTMLElement;
  setConnection(text: string, tone: ConnectionTone): void;
  setStageActive(value: boolean): void;
  showReconnectBanner(visible: boolean): void;
  /** Inserts the stage bar and banner into the top bar (or `#app`). */
  mount(): void;
}

export function createChrome(
  doc: Document,
  appEl: HTMLElement,
  connectionEl: HTMLElement,
  topBar: Element | null,
): HostChrome {
  // HP-03/HP-04 chrome. Class names are owned by `src/style.css`.
  const stageBar = doc.createElement("div");
  stageBar.className = "lanpad-stage-bar";
  stageBar.hidden = true;
  const stageRoomEl = doc.createElement("span");
  stageRoomEl.className = "lanpad-stage-bar__room";
  const stagePlayersEl = doc.createElement("span");
  stagePlayersEl.className = "lanpad-stage-bar__players";
  stageBar.append(stageRoomEl, stagePlayersEl);

  // HP-06: sits above the canvas, so it never covers the game's HUD.
  const reconnectBanner = doc.createElement("div");
  reconnectBanner.className = "lanpad-reconnect";
  reconnectBanner.setAttribute("role", "status");
  reconnectBanner.setAttribute("aria-live", "polite");
  reconnectBanner.textContent = RECONNECT_BANNER_TEXT;
  reconnectBanner.hidden = true;

  let mounted = false;

  return {
    stageBar,
    stageRoomEl,
    stagePlayersEl,

    setConnection(text, tone) {
      connectionEl.textContent = text;
      connectionEl.dataset["state"] = tone;
      // CSS cannot rely on :has() on older TV browsers; mirror the tone here.
      appEl.classList.toggle("connection-bad", tone === "bad");
    },

    setStageActive(value) {
      appEl.classList.toggle("stage-active", value);
    },

    showReconnectBanner(visible) {
      reconnectBanner.hidden = !visible;
    },

    mount() {
      if (mounted) return;
      mounted = true;
      if (topBar !== null) {
        topBar.after(stageBar, reconnectBanner);
      } else {
        appEl.prepend(reconnectBanner, stageBar);
      }
    },
  };
}

/**
 * Requests fullscreen from a user gesture when the browser supports it. Used
 * by the launcher activation; TV browsers without the API simply skip it.
 */
export function requestFullscreen(doc: Document): void {
  if (
    doc.fullscreenElement === null &&
    typeof doc.documentElement.requestFullscreen === "function"
  ) {
    void doc.documentElement.requestFullscreen().catch(() => undefined);
  }
}

/**
 * Host fullscreen is a gesture action. The same control exists on the
 * controller; TV browsers that lack the API simply hide it.
 */
export function setupFullscreenToggle(doc: Document): void {
  const fullscreenButton = doc.getElementById("fullscreen-toggle");
  if (!(fullscreenButton instanceof HTMLButtonElement)) {
    return;
  }
  if (typeof doc.documentElement.requestFullscreen !== "function") {
    fullscreenButton.hidden = true;
    return;
  }
  const renderFullscreen = (): void => {
    fullscreenButton.textContent =
      doc.fullscreenElement === null ? "Full screen" : "Exit full screen";
  };
  fullscreenButton.addEventListener("click", () => {
    if (doc.fullscreenElement === null) {
      void doc.documentElement.requestFullscreen().catch(() => undefined);
    } else {
      void doc.exitFullscreen().catch(() => undefined);
    }
  });
  doc.addEventListener("fullscreenchange", renderFullscreen);
  renderFullscreen();
}
