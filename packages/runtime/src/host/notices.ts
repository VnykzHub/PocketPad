/**
 * HP-07 notice panel lifecycle.
 *
 * Notices are inserted before the first child of `#game-root`, matching the
 * existing host-shell order: they sit above the canvas. The module owns the
 * single active notice and never logs error text or credentials.
 */
import type { RendererFallbackNotice } from "../render/Renderer.js";
import { Notice, type NoticeOptions } from "../ui/Notice.js";
import { GAME_STOPPED_TITLE, RELOAD_LABEL } from "./copy.js";

export interface NoticesDeps {
  readonly doc: Document;
  readonly gameRoot: HTMLElement;
  /** Stops the current game before a fatal notice is shown. */
  readonly teardownGame: () => void;
}

export interface HostNotices {
  clear(): void;
  show(options: NoticeOptions): Notice;
  showError(error: unknown): void;
  showRenderer(notice: RendererFallbackNotice, fatal: boolean): void;
}

export function createNotices(deps: NoticesDeps): HostNotices {
  let activeNotice: Notice | null = null;

  function clear(): void {
    activeNotice?.destroy();
    activeNotice = null;
  }

  function show(options: NoticeOptions): Notice {
    clear();
    const notice = new Notice(deps.doc, options);
    // Existing host notices sat above the canvas; keep that order.
    deps.gameRoot.insertBefore(notice.element, deps.gameRoot.firstChild);
    notice.focusAction();
    activeNotice = notice;
    return notice;
  }

  function reloadPage(): void {
    window.location.reload();
  }

  function showRenderer(notice: RendererFallbackNotice, fatal: boolean): void {
    show({
      title: notice.title,
      message: notice.message,
      hints: notice.hints,
      actionLabel: RELOAD_LABEL,
      onAction: reloadPage,
      tone: fatal ? "error" : "notice",
    });
  }

  /** Fatal runtime error: stop the game and offer a reload (D3-SDK-01 risk). */
  function showError(error: unknown): void {
    const text = error instanceof Error ? error.message : "Unknown error.";
    deps.teardownGame();
    show({
      title: GAME_STOPPED_TITLE,
      message: text,
      actionLabel: RELOAD_LABEL,
      onAction: reloadPage,
      tone: "error",
    });
  }

  return { clear, show, showError, showRenderer };
}
