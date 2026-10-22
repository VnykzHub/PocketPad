// @vitest-environment jsdom
/**
 * Page wiring smoke test. jsdom has no dev server behind it, so every network
 * check fails here; the page must still stay idle until Run and then render
 * one row per check with copyable JSON.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// jsdom replaces the global URL, so resolve the path as a string.
const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "index.html"), "utf8");

describe("[G1] E4/E9/E15/G1 page wiring", () => {
  it("[G1] does nothing on load and renders every check after Run", async () => {
    const body = /<body>([\s\S]*)<\/body>/.exec(html)?.[1] ?? "";
    document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, "");
    await import("../page.js");

    expect(document.getElementById("status")?.textContent).toBe("Not run.");
    expect(document.getElementById("results")?.childElementCount).toBe(0);

    (document.getElementById("run") as HTMLButtonElement).click();
    await vi.waitFor(
      () => expect(document.getElementById("status")?.textContent).toMatch(/^Finished:/),
      { timeout: 15_000 },
    );

    // Three report metadata rows plus five checks.
    expect(document.querySelectorAll("#results tbody tr").length).toBe(8);
    const json = document.getElementById("json")?.textContent ?? "";
    expect(json).toContain('"experiment": "E4/E9/E15/G1"');
    expect(json).toContain('"id": "e15-lifecycle"');
  }, 20_000);
});
