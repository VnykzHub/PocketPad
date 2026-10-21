// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { detectWebGL2, mountProbePage } from "../probe.js";

function buildPage() {
  document.body.innerHTML = `
    <button id="run" type="button">Run</button>
    <button id="copy" type="button" disabled>Copy JSON</button>
    <p id="status">Not run.</p>
    <table id="results"></table>
    <pre id="json">Not run.</pre>
  `;

  function byId<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (element === null) throw new Error(`missing #${id}`);
    return element as T;
  }

  return {
    runButton: byId<HTMLButtonElement>("run"),
    copyButton: byId<HTMLButtonElement>("copy"),
    statusHost: byId<HTMLParagraphElement>("status"),
    tableHost: byId<HTMLTableElement>("results"),
    jsonHost: byId<HTMLPreElement>("json"),
  };
}

describe("[E1] WebGL2 failure display", () => {
  it("[E1] waits for Run and then renders a readable failure plus a passing control", async () => {
    const elements = buildPage();
    const brokenCanvas = {
      getContext(): unknown {
        throw new Error("simulated WebGL2 context failure");
      },
    };

    mountProbePage({
      experiment: "E1-fixture",
      title: "WebGL2 failure display fixture",
      checks: [
        {
          id: "webgl2",
          label: "WebGL2 context acquisition",
          run: () => detectWebGL2(brokenCanvas),
        },
        { id: "control", label: "Fixture control", run: () => "control completed" },
      ],
      elements,
      now: () => new Date("2026-10-21T00:00:00.000Z"),
      performanceNow: () => 0,
    });

    // Mounting only wires listeners: nothing has run yet.
    expect(elements.tableHost.rows).toHaveLength(0);
    expect(elements.jsonHost.textContent).toBe("Not run.");
    expect(elements.copyButton.disabled).toBe(true);

    elements.runButton.click();

    await vi.waitFor(() => {
      expect(elements.statusHost.textContent).toContain("Finished: 1/2 checks passed.");
    });

    // Header row + 3 metadata rows + 2 check rows.
    expect(elements.tableHost.rows).toHaveLength(6);
    const tableText = elements.tableHost.textContent ?? "";
    expect(tableText).toContain("FAIL");
    expect(tableText).toContain(
      "WebGL2 context creation threw: simulated WebGL2 context failure",
    );
    expect(tableText).toContain("PASS");
    expect(elements.copyButton.disabled).toBe(false);

    const report = JSON.parse(elements.jsonHost.textContent ?? "") as {
      ranAt: string;
      checks: Array<{ id: string; status: string; error: string | null }>;
    };
    expect(report.ranAt).toBe("2026-10-21T00:00:00.000Z");
    expect(report.checks[0]?.status).toBe("fail");
    expect(report.checks[0]?.error).toContain("simulated WebGL2 context failure");
    expect(report.checks[1]?.status).toBe("pass");
  });
});
