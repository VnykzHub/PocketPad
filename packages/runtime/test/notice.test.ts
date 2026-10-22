// @vitest-environment jsdom
/**
 * HP-07 notice panel: structure, alert semantics and the single action.
 * Requirement IDs resolve to existing TRACEABILITY rows (FR-9.3 failure
 * screen, AR-4 remote operability); the page-plan id HP-07 is a plan label,
 * not a trace tag.
 */
import { afterEach, describe, expect, test } from "vitest";
import { Notice } from "../src/ui/Notice";

afterEach(() => {
  document.body.replaceChildren();
});

describe("Notice (HP-07)", () => {
  test("[FR-9.3] renders a title, one message, hint lines and one action", () => {
    const notice = new Notice(document, {
      title: "The game stopped",
      message: "Renderer unavailable.",
      hints: ["Reload the page.", "Try another browser."],
      actionLabel: "Reload",
      onAction: () => undefined,
    });

    expect(notice.element.tagName).toBe("SECTION");
    expect(notice.element.getAttribute("role")).toBe("alert");
    expect(notice.element.querySelector("h2")?.textContent).toBe(
      "The game stopped",
    );
    expect(
      notice.element.querySelector(".lanpad-notice__message")?.textContent,
    ).toBe("Renderer unavailable.");

    const hints = Array.from(
      notice.element.querySelectorAll(".lanpad-notice__hints li"),
    ).map((item) => item.textContent);
    expect(hints).toEqual(["Reload the page.", "Try another browser."]);

    expect(notice.actionButton.tagName).toBe("BUTTON");
    expect(notice.actionButton.textContent).toBe("Reload");
  });

  test("[AR-4] mount makes the action the only focusable thing and runs it once", () => {
    let calls = 0;
    const notice = new Notice(document, {
      title: "The game stopped",
      message: "Unknown error.",
      actionLabel: "Reload",
      onAction: () => {
        calls += 1;
      },
    });

    const host = document.createElement("div");
    document.body.append(host);
    notice.mount(host);

    expect(host.contains(notice.element)).toBe(true);
    expect(document.activeElement).toBe(notice.actionButton);

    const focusable = notice.element.querySelectorAll(
      "button, a[href], input, select, textarea, [tabindex]",
    );
    expect(focusable).toHaveLength(1);
    expect(focusable[0]).toBe(notice.actionButton);

    notice.actionButton.click();
    expect(calls).toBe(1);
  });

  test("[AR-4] destroy removes the panel and its click handler", () => {
    let calls = 0;
    const notice = new Notice(document, {
      title: "The game stopped",
      actionLabel: "Reload",
      onAction: () => {
        calls += 1;
      },
    });
    const host = document.createElement("div");
    document.body.append(host);
    notice.mount(host);

    notice.destroy();
    notice.destroy();

    expect(host.querySelector(".lanpad-notice")).toBeNull();
    notice.actionButton.click();
    expect(calls).toBe(0);
  });

  test("[FR-9.3] an error notice adds the danger mark without a red panel", () => {
    const notice = new Notice(document, {
      title: "The game stopped",
      message: "Unknown error.",
      actionLabel: "Reload",
      onAction: () => undefined,
      tone: "error",
    });

    expect(notice.element.classList.contains("lanpad-notice")).toBe(true);
    expect(notice.element.classList.contains("lanpad-error")).toBe(true);
    // No empty hint list when the caller supplies none.
    expect(notice.element.querySelector(".lanpad-notice__hints")).toBeNull();
    expect(
      notice.element.querySelector(".lanpad-notice__message")?.textContent,
    ).toBe("Unknown error.");
  });
});
