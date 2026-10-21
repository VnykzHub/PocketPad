// @vitest-environment jsdom
/**
 * E1 page wiring smoke test (D1-EXP-02).
 *
 * jsdom has no GPU, audio or WebSocket, so almost every capability check fails
 * here. That is the point: the page must still render one table row per check
 * and produce copyable JSON, which is the failure display a real TV needs.
 * Capability numbers are not asserted from jsdom.
 */
import { describe, expect, it, vi } from "vitest";

const pageMarkup = `
  <button id="run" type="button">Run</button>
  <button id="copy" type="button" disabled>Copy JSON</button>
  <p id="status">Not run.</p>
  <table id="results"></table>
  <pre id="json">Not run.</pre>
`;

describe("[E1] E1 page wiring", () => {
  it("[E1] runs only on click and renders every check even when capabilities are missing", async () => {
    document.body.innerHTML = pageMarkup;
    // jsdom has no canvas backend; return null instead of jsdom's virtual-console
    // "not implemented" notice so the check fails through the normal probe path.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null);
    await import("../page.js");

    // Mounting alone must not start the probe.
    expect(document.getElementById("status")?.textContent).toBe("Not run.");
    expect(document.getElementById("results")?.childElementCount).toBe(0);

    const runButton = document.getElementById("run") as HTMLButtonElement;
    runButton.click();

    await vi.waitFor(
      () => {
        expect(document.getElementById("status")?.textContent).toMatch(/^Finished:/);
      },
      { timeout: 15_000 },
    );

    const rows = document.querySelectorAll("#results tbody tr");
    // Three report metadata rows plus one row per check.
    expect(rows.length).toBe(17);
    expect(document.getElementById("json")?.textContent).toContain('"experiment": "E1"');

    const tvOnly = [...rows].find((row) => row.textContent?.includes("G6 TV-only"));
    expect(tvOnly?.textContent).toContain("FAIL");
  }, 20_000);
});
