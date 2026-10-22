/**
 * Controller shell and stylesheet contract (W3; FR-8.1, FR-8.2, FR-8.3,
 * FR-8.10, FR-8.12, AR-5, A9).
 *
 * The page shell and the stylesheet are static assets: nothing here executes
 * them, so the checks read them as text. They pin the parts that other modules
 * depend on by id (main.ts), by class (`controls/*` renderers) and by data
 * attribute (ConnectionPill, HapticsToggle, the debug overlay). A change that
 * breaks the controller frame, a control state or a visible label fails here
 * before it reaches a phone.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HTML = readFileSync(join(PACKAGE_ROOT, "index.html"), "utf8");
const CSS = readFileSync(join(PACKAGE_ROOT, "src", "styles.css"), "utf8");

/** FR-8.1: the eleven control types every layout may use. */
const CONTROL_TYPES = [
  "button",
  "dpad",
  "stick",
  "trigger",
  "touchpad",
  "slider",
  "gyro",
  "choice",
  "panel",
  "text",
  "canvas",
] as const;

/** Ids main.ts resolves through `requireElement`; dropping one breaks the page. */
const REQUIRED_IDS = [
  "connection",
  "haptics-toggle",
  "join-form",
  "code",
  "pin",
  "join-error",
  "join-button",
  "controller",
  "slot-label",
  "test-button",
  "play-surface",
  "orientation",
  "debug-overlay",
] as const;

function parseShell(): Document {
  return new DOMParser().parseFromString(HTML, "text/html");
}

describe("[FR-8.1] page shell and control contract", () => {
  it("[FR-8.1] the shell exposes every mount and all eleven types are styled", () => {
    const doc = parseShell();

    for (const id of REQUIRED_IDS) {
      expect(doc.getElementById(id), `missing #${id}`).not.toBeNull();
    }

    // The page loads the shell module; the stylesheet is imported from it.
    expect(doc.querySelector('script[type="module"]')?.getAttribute("src")).toBe("/src/main.ts");

    // One class contract for every renderer: `.control` + `.control-<type>`.
    expect(CSS).toContain(".control {");
    for (const type of CONTROL_TYPES) {
      expect(CSS, `missing .control-${type}`).toContain(`.control-${type} {`);
    }

    // Additive states the renderers and the layout host toggle.
    for (const state of [
      "is-pressed",
      "is-selected",
      "is-disabled",
      "is-unavailable",
      "is-blocked",
      "is-empty",
    ]) {
      expect(CSS, `missing .control.${state}`).toContain(`.control.${state} {`);
    }

    // Pressed is a lime fill with a ground label plus a scale, never a colour
    // change alone.
    expect(CSS).toMatch(/\.control\.is-pressed\s*\{[^}]*background-color:\s*var\(--accent\)/s);
    expect(CSS).toMatch(/\.control\.is-pressed\s*\{[^}]*color:\s*var\(--ground\)/s);
    expect(CSS).toMatch(/\.control\.is-pressed\s*\{[^}]*transform:\s*scale\(0\.97\)/s);

    // The top bar is part of the frame: 44px plus the safe-area top.
    expect(CSS).toContain("--topbar-height: 44px;");
    expect(CSS).toMatch(
      /\.topbar\s*\{[^}]*height:\s*calc\(var\(--topbar-height\) \+ var\(--safe-top\)\)/s,
    );
  });

  it("[FR-8.2] the control surface is a persistent sibling of the join shell", () => {
    const doc = parseShell();
    const app = doc.getElementById("app");
    const surface = doc.getElementById("play-surface");
    const shell = doc.querySelector(".shell");

    expect(app).not.toBeNull();
    expect(surface?.parentElement).toBe(app);
    expect(shell?.contains(surface)).toBe(false);

    // A mounted layout hides the join shell without rebuilding the surface, so
    // a hot swap only replaces controls inside the surface (no reload).
    expect(CSS).toMatch(/body\.playing \.shell\s*\{\s*display:\s*none;/s);
    expect(CSS).toMatch(/\.play-surface\s*\{[^}]*position:\s*fixed/s);
    expect(CSS).toMatch(/\.play-surface\s*\{[^}]*overflow:\s*hidden/s);
  });
});

describe("[FR-8.3] press feedback", () => {
  it("[FR-8.3] presses animate only colour and transform, never layout properties", () => {
    expect(CSS).not.toMatch(/transition:\s*all\b/);
    expect(CSS).not.toMatch(
      /\btransition:[^;}]*\b(width|height|top|left|right|bottom|inset|margin|padding)\b/,
    );

    // The transition list on the shared control is colour plus transform.
    expect(CSS).toMatch(
      /\.control\s*\{[^}]*transition:\s*background-color[^;]*color[^;]*border-color[^;]*transform/s,
    );
  });
});

describe("[AR-5] touch targets, focus and safe areas", () => {
  it("[AR-5] every target keeps its 44px floor and focus is visible", () => {
    const baseControl = /\.control\s*\{([^}]*)\}/s.exec(CSS)?.[1] ?? "";
    expect(baseControl).toMatch(/min-width:\s*44px/);
    expect(baseControl).toMatch(/min-height:\s*44px/);

    expect(CSS).toContain("--phone-target: 48px;");
    expect(CSS).toMatch(/\.haptics-toggle\s*\{[^}]*height:\s*var\(--topbar-height\)/s);
    expect(CSS).toMatch(/\.join-button\s*\{[^}]*min-height:\s*56px/s);
    expect(CSS).toMatch(/\.test-button\s*\{[^}]*min-height:\s*var\(--phone-target\)/s);
    expect(CSS).toMatch(/\.control-text \[data-part="send"\][^{]*\{[^}]*min-width:\s*44px/s);

    // One ring everywhere: 3px accent, 2px offset.
    expect(CSS).toMatch(/outline:\s*3px solid var\(--accent\)/);
    expect(CSS).toContain("outline-offset: 2px");

    // Every edge of the frame reads the safe-area environment.
    for (const edge of ["top", "right", "bottom", "left"] as const) {
      expect(CSS, `missing safe-area ${edge}`).toContain(`env(safe-area-inset-${edge}`);
    }
  });

  it("[AR-5] reduced motion keeps feedback and removes travel", () => {
    expect(CSS).toContain("@media (prefers-reduced-motion: reduce)");
    expect(CSS).toMatch(
      /prefers-reduced-motion: reduce\)[\s\S]*\.control\.is-pressed[\s\S]*transform:\s*none/,
    );
  });
});

describe("[A9] connection state", () => {
  it("[A9] the pill names every state and pairs its dot with a word", () => {
    const doc = parseShell();
    const pill = doc.getElementById("connection");

    expect(pill?.getAttribute("role")).toBe("status");
    expect(pill?.getAttribute("aria-live")).toBe("polite");
    expect(pill?.getAttribute("data-state")).toBe("disconnected");
    expect(pill?.textContent?.trim()).toBe("Disconnected");

    // Words come from ConnectionPill; the stylesheet only owns the dot colour.
    for (const state of [
      "connected",
      "connecting",
      "reconnecting",
      "waiting-for-tv",
      "tv-paused",
      "disconnected",
    ]) {
      expect(CSS, `missing data-state=${state}`).toContain(`#connection[data-state="${state}"]`);
    }

    expect(CSS).toMatch(/#connection::before\s*\{[^}]*width:\s*8px/s);
    expect(CSS).toMatch(/#connection::before\s*\{[^}]*background:\s*var\(--negative\)/s);
    expect(CSS).toMatch(
      /#connection\[data-state="connected"\]::before\s*\{\s*background:\s*var\(--accent\)/s,
    );
    expect(CSS).toMatch(
      /#connection\[data-state="waiting-for-tv"\]::before[\s\S]*?background:\s*var\(--warning\)/,
    );
  });
});

describe("[FR-8.12] haptics toggle", () => {
  it("[FR-8.12] the toggle keeps its label, on/off state and 44px target", () => {
    const doc = parseShell();
    const toggle = doc.getElementById("haptics-toggle");

    expect(toggle?.tagName).toBe("BUTTON");
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
    expect(toggle?.getAttribute("data-haptics")).toBe("on");
    expect(toggle?.textContent?.trim()).toBe("Haptics on");

    expect(CSS).toMatch(/\.haptics-toggle::before\s*\{[^}]*background:\s*var\(--accent\)/s);
    expect(CSS).toContain('.haptics-toggle[data-haptics="off"]::before');
    expect(CSS).toMatch(
      /\.haptics-toggle\[data-haptics="off"\]::before[^{]*\{\s*background:\s*var\(--control\)/s,
    );
  });
});

describe("[FR-8.10] gyro fallback", () => {
  it("[FR-8.10] an unavailable gyro keeps its label and names the reason", () => {
    expect(CSS).toContain(".control.is-unavailable {");
    expect(CSS).toMatch(
      /\.control-gyro\.is-unavailable,\s*\.control-gyro\.is-disabled\s*\{[^}]*color:\s*var\(--faint\)/s,
    );
    expect(CSS).toMatch(
      /\.control-gyro\.is-unavailable[^{]*\{[^}]*border:\s*1px dashed var\(--control\)/s,
    );
    expect(CSS).toContain('.control-gyro [data-part="reason"]');
    expect(CSS).toContain('.control-gyro [data-part="motion-status"]');
  });
});
