/**
 * Private panel renderer (D5-CTRL-01; FR-8.1, FR-8.3, SR-13, AR-5).
 *
 * A display-only region owned by one slot. The host sends `PanelContent`; this
 * renderer validates it again with the SDK (`validatePanelContent`) and builds
 * the DOM with `textContent`/`img.src` only — there is no HTML path, so a
 * malicious host or game cannot inject markup (SR-13). Panels are private by
 * routing (only the addressed phone receives them); the renderer never emits
 * an event and never echoes its content anywhere.
 *
 * Content updates in place (`setContent`), preserving the same element so
 * hot-swap can re-render onto a panel control with the same id (D5-CTRL-02).
 * Long text and block lists scroll by translating the content wrapper, because
 * the play surface consumes native scroll gestures (D2-CTRL-01).
 *
 * The extra `setContent`/`getContent` methods are additive: `ControlRenderer`
 * is unchanged, and `isPanelRenderer` is the type guard callers use.
 */
import {
  validatePanelContent,
  type PanelBlock,
  type PanelContent,
  type PanelControl,
} from "@lanpad/sdk";
import type { InputState } from "@lanpad/protocol";
import {
  applyControlElementStyle,
  createPart,
  measureControl,
  type ControlContext,
  type ControlRenderer,
} from "./control.js";
import type { TouchBinding } from "../touch/touchEngine.js";
import { appendSafeImage, setSafeText } from "../render/safeRender.js";

const PLACEHOLDER_TEXT = "Private panel";
const INVALID_TEXT = "Panel content unavailable";

/** Per-field caps mirror the SDK panel contract; defence in depth. */
const MAX_TITLE_CHARS = 80;
const MAX_BODY_CHARS = 1_000;
const MAX_LIST_ITEM_CHARS = 120;

/** Panel renderer with the in-place content update used by hot-swap. */
export interface PanelRenderer extends ControlRenderer {
  /** Validates and renders new content; `null` restores the empty state. */
  setContent(content: PanelContent | null): void;
  /** Last content accepted for rendering (null when empty). */
  getContent(): PanelContent | null;
}

/** True when `renderer` is a panel; the only supported way to call `setContent`. */
export function isPanelRenderer(renderer: ControlRenderer): renderer is PanelRenderer {
  return typeof (renderer as Partial<PanelRenderer>).setContent === "function";
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function textBlock(
  tag: "div" | "p",
  text: string,
  part: string,
  maxLen: number,
): HTMLElement {
  const block = createPart(tag, part);
  setSafeText(block, text, maxLen);
  return block;
}

export function createPanelControl(control: PanelControl, ctx: ControlContext): PanelRenderer {
  const box = measureControl(control, ctx.surfaceSize);

  const element = document.createElement("div");
  applyControlElementStyle(element, control, box, ctx);
  element.classList.add("control", "control-panel");
  element.setAttribute("role", "region");
  element.setAttribute("aria-label", "private panel");
  element.style.overflow = "hidden";
  element.style.borderRadius = "12px";
  element.style.background = "rgba(255, 255, 255, 0.06)";
  element.style.border = "1px solid rgba(255, 255, 255, 0.28)";

  const viewport = createPart("div", "viewport");
  viewport.style.position = "absolute";
  viewport.style.left = "0";
  viewport.style.top = "0";
  viewport.style.width = "100%";
  viewport.style.height = "100%";
  viewport.style.overflow = "hidden";
  viewport.style.pointerEvents = "none";
  element.append(viewport);

  const content = createPart("div", "content");
  content.style.position = "absolute";
  content.style.left = "0";
  content.style.top = "0";
  content.style.width = "100%";
  content.style.boxSizing = "border-box";
  content.style.padding = "10px 12px";
  content.style.color = "#f4f4f5";
  content.style.font = "400 15px/1.35 system-ui, sans-serif";
  content.style.overflowWrap = "anywhere";
  content.style.transform = "translate3d(0, 0, 0)";
  content.style.pointerEvents = "none";
  viewport.append(content);

  const placeholder = createPart("div", "placeholder");
  placeholder.textContent = PLACEHOLDER_TEXT;
  placeholder.style.position = "absolute";
  placeholder.style.left = "0";
  placeholder.style.top = "0";
  placeholder.style.width = "100%";
  placeholder.style.height = "100%";
  placeholder.style.display = "flex";
  placeholder.style.alignItems = "center";
  placeholder.style.justifyContent = "center";
  placeholder.style.color = "rgba(244, 244, 245, 0.55)";
  placeholder.style.font = "500 14px/1 system-ui, sans-serif";
  placeholder.style.pointerEvents = "none";
  viewport.append(placeholder);

  let lastContent: PanelContent | null = null;
  let activeIdentifier: number | null = null;
  let startY = 0;
  let startOffset = 0;
  let offset = 0;

  const maxScroll = (): number => {
    const overflow = content.scrollHeight - viewport.clientHeight;
    return overflow > 0 ? overflow : 0;
  };

  const applyOffset = (next: number): void => {
    offset = clamp(next, -maxScroll(), 0);
    content.style.transform = `translate3d(0, ${offset.toFixed(2)}px, 0)`;
  };

  const appendImage = (
    parent: HTMLElement,
    src: string,
    alt: string | undefined,
    fit: "contain" | "cover" | undefined,
  ): void => {
    // Belt and braces: the SDK validator already checked this, but a renderer
    // must never assign a protocol URL. Only vetted paths/data URIs reach `.src`.
    appendSafeImage(parent, src, alt, fit);
  };

  const renderBlock = (block: PanelBlock): void => {
    switch (block.type) {
      case "heading": {
        const heading = textBlock("div", block.text, "block-heading", MAX_BODY_CHARS);
        heading.style.fontWeight = "700";
        heading.style.fontSize = "17px";
        heading.style.margin = "4px 0 6px";
        content.append(heading);
        break;
      }
      case "paragraph": {
        const paragraph = textBlock("p", block.text, "block-paragraph", MAX_BODY_CHARS);
        paragraph.style.margin = "0 0 8px";
        paragraph.style.whiteSpace = "pre-wrap";
        content.append(paragraph);
        break;
      }
      case "list": {
        const list = document.createElement("ul");
        list.dataset["part"] = "block-list";
        list.style.margin = "0 0 8px";
        list.style.paddingLeft = "20px";
        for (const item of block.items) {
          const entry = document.createElement("li");
          setSafeText(entry, item, MAX_LIST_ITEM_CHARS);
          list.append(entry);
        }
        content.append(list);
        break;
      }
      case "image": {
        const wrapper = createPart("div", "block-image");
        wrapper.style.margin = "0 0 8px";
        appendImage(wrapper, block.src, block.alt, undefined);
        content.append(wrapper);
        break;
      }
    }
  };

  const renderContent = (value: PanelContent): void => {
    switch (value.kind) {
      case "text": {
        if (value.title !== undefined && value.title.length > 0) {
          const title = createPart("div", "panel-title");
          setSafeText(title, value.title, MAX_TITLE_CHARS);
          title.style.fontWeight = "700";
          title.style.fontSize = "17px";
          title.style.margin = "0 0 6px";
          content.append(title);
        }
        const body = createPart("div", "panel-text");
        setSafeText(body, value.text, MAX_BODY_CHARS);
        body.style.whiteSpace = "pre-wrap";
        content.append(body);
        break;
      }
      case "blocks": {
        for (const block of value.blocks) {
          renderBlock(block);
        }
        break;
      }
      case "image": {
        appendImage(content, value.src, value.alt, value.fit ?? "contain");
        break;
      }
    }
  };

  const showPlaceholder = (text: string): void => {
    placeholder.textContent = text;
    placeholder.hidden = false;
  };

  const setContent = (value: PanelContent | null): void => {
    content.replaceChildren();
    offset = 0;
    content.style.transform = "translate3d(0, 0, 0)";

    if (value === null) {
      lastContent = null;
      delete element.dataset["invalidPanel"];
      showPlaceholder(PLACEHOLDER_TEXT);
      return;
    }

    const result = validatePanelContent(value);
    if (!result.ok) {
      // Keep the previous content out of the DOM: a rejected panel could be
      // hostile. A neutral message is safer than rendering a partial object.
      lastContent = null;
      element.dataset["invalidPanel"] = "true";
      showPlaceholder(INVALID_TEXT);
      return;
    }

    lastContent = result.content;
    delete element.dataset["invalidPanel"];
    placeholder.hidden = true;
    renderContent(result.content);
  };

  setContent(null);

  return {
    id: control.id,
    element,

    setContent,

    getContent(): PanelContent | null {
      return lastContent;
    },

    setPressed(): void {
      // Display-only: no pressed representation to avoid implying a target.
    },

    onTouchStart(binding: TouchBinding): void {
      if (activeIdentifier !== null) {
        return;
      }
      activeIdentifier = binding.identifier;
      startY = binding.startY;
      startOffset = offset;
    },

    onTouchMove(binding: TouchBinding): void {
      if (binding.identifier !== activeIdentifier) {
        return;
      }
      applyOffset(startOffset + (binding.lastY - startY));
    },

    onTouchEnd(binding: TouchBinding): void {
      if (binding.identifier !== activeIdentifier) {
        return;
      }
      activeIdentifier = null;
      startOffset = offset;
    },

    onTouchCancel(binding: TouchBinding): void {
      if (binding.identifier !== activeIdentifier) {
        return;
      }
      activeIdentifier = null;
      startOffset = offset;
    },

    getState(): Partial<InputState> {
      return {};
    },

    dispose(): void {
      activeIdentifier = null;
      content.replaceChildren();
      element.remove();
    },
  };
}
