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
 * CP-15 design language (DESIGN.md `true-black-flat`): a `--surface` card with
 * a 24 px header row — a drawn lock glyph plus `Private` — and the content
 * below it. All colour, radius and type come from `.control-panel` rules in
 * `styles.css`; this file owns geometry, the scroll container and state
 * classes only. Long content scrolls by translating the content layer (the
 * play surface consumes native scroll gestures, D2-CTRL-01) and shows a 2 px
 * scrollbar and a 24 px edge fade while it overflows.
 *
 * Content updates in place (`setContent`), preserving the same element so
 * hot-swap can re-render onto a panel control with the same id (D5-CTRL-02).
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
  applyControlClasses,
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
const HEADER_LABEL = "Private";

/** Header row height; matches `.control-panel [data-part="header"]`. */
const HEADER_HEIGHT_PX = 24;

/** Per-field caps mirror the SDK panel contract; defence in depth. */
const MAX_TITLE_CHARS = 80;
const MAX_BODY_CHARS = 1_000;
const MAX_LIST_ITEM_CHARS = 120;

const SVG_NS = "http://www.w3.org/2000/svg";

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

/**
 * Draws the header lock with SVG primitives (no emoji, no icon font). The
 * glyph inherits `--muted` from the header row through `currentColor`.
 */
function createLockGlyph(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("data-part", "lock");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  const shackle = document.createElementNS(SVG_NS, "path");
  shackle.setAttribute("d", "M5.25 7V5.5a2.75 2.75 0 0 1 5.5 0V7");
  svg.append(shackle);

  const body = document.createElementNS(SVG_NS, "rect");
  body.setAttribute("x", "3.5");
  body.setAttribute("y", "7");
  body.setAttribute("width", "9");
  body.setAttribute("height", "6");
  body.setAttribute("rx", "1.5");
  svg.append(body);

  return svg;
}

export function createPanelControl(control: PanelControl, ctx: ControlContext): PanelRenderer {
  const box = measureControl(control, ctx.surfaceSize);

  const element = document.createElement("div");
  applyControlElementStyle(element, control, box, ctx);
  applyControlClasses(element, "panel");
  element.setAttribute("role", "region");
  element.setAttribute("aria-label", "private panel");

  const header = createPart("div", "header");
  const headerLabel = createPart("span", "header-label");
  headerLabel.textContent = HEADER_LABEL;
  header.append(createLockGlyph(), headerLabel);
  element.append(header);

  // The viewport is the scroll clip below the header; the content layer is
  // translated inside it so the card itself never scrolls.
  const viewport = createPart("div", "viewport");
  viewport.style.top = `${HEADER_HEIGHT_PX}px`;
  viewport.style.height = `calc(100% - ${HEADER_HEIGHT_PX}px)`;
  element.append(viewport);

  const content = createPart("div", "content");
  viewport.append(content);

  const placeholder = createPart("div", "placeholder");
  placeholder.textContent = PLACEHOLDER_TEXT;
  viewport.append(placeholder);

  const scrollbar = createPart("div", "scrollbar");
  scrollbar.hidden = true;
  viewport.append(scrollbar);

  let lastContent: PanelContent | null = null;
  let activeIdentifier: number | null = null;
  let startY = 0;
  let startOffset = 0;
  let offset = 0;
  let scrollable = false;
  let scrollSpan = 0;
  let thumbTravel = 0;

  const maxScroll = (): number => {
    const overflow = content.scrollHeight - viewport.clientHeight;
    return overflow > 0 ? overflow : 0;
  };

  /** Moves the content layer and keeps the scrollbar thumb in step. */
  const applyOffset = (next: number): void => {
    offset = clamp(next, -maxScroll(), 0);
    content.style.transform = `translate3d(0, ${offset.toFixed(2)}px, 0)`;
    if (scrollable) {
      const progress = scrollSpan === 0 ? 0 : -offset / scrollSpan;
      scrollbar.style.transform = `translate3d(0, ${(progress * thumbTravel).toFixed(1)}px, 0)`;
    }
  };

  /**
   * Recomputes whether the content overflows. Called only when content changes
   * (never per touch), so the mask strings and thumb height are not rebuilt on
   * the scroll path.
   */
  const updateScrollAffordance = (): void => {
    const viewHeight = viewport.clientHeight;
    const total = content.scrollHeight;
    const overflow = total - viewHeight;

    if (viewHeight <= 0 || overflow <= 0) {
      scrollbar.hidden = true;
      if (scrollable) {
        scrollable = false;
        element.classList.remove("is-scrollable");
        scrollbar.style.transform = "";
      }
      return;
    }

    const thumbHeight = Math.max(
      24,
      Math.min(viewHeight, (viewHeight * viewHeight) / total),
    );
    scrollSpan = overflow;
    thumbTravel = Math.max(0, viewHeight - thumbHeight);
    scrollable = true;
    element.classList.add("is-scrollable");
    scrollbar.hidden = false;
    scrollbar.style.height = `${thumbHeight.toFixed(0)}px`;
    applyOffset(offset);
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
        content.append(heading);
        break;
      }
      case "paragraph": {
        const paragraph = textBlock("p", block.text, "block-paragraph", MAX_BODY_CHARS);
        content.append(paragraph);
        break;
      }
      case "list": {
        const list = document.createElement("ul");
        list.dataset["part"] = "block-list";
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
          content.append(title);
        }
        const body = createPart("div", "panel-text");
        setSafeText(body, value.text, MAX_BODY_CHARS);
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
    content.style.transform = "";

    if (value === null) {
      lastContent = null;
      delete element.dataset["invalidPanel"];
      element.classList.add("is-empty");
      showPlaceholder(PLACEHOLDER_TEXT);
      updateScrollAffordance();
      return;
    }

    const result = validatePanelContent(value);
    if (!result.ok) {
      // Keep the previous content out of the DOM: a rejected panel could be
      // hostile. A neutral message is safer than rendering a partial object.
      lastContent = null;
      element.dataset["invalidPanel"] = "true";
      element.classList.add("is-empty");
      showPlaceholder(INVALID_TEXT);
      updateScrollAffordance();
      return;
    }

    lastContent = result.content;
    delete element.dataset["invalidPanel"];
    element.classList.remove("is-empty");
    placeholder.hidden = true;
    renderContent(result.content);
    updateScrollAffordance();
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
