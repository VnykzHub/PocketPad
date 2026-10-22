// @vitest-environment jsdom
/**
 * HP-06 resumed room (D4-HOST-02). A reload keeps `{code, hostToken}` but
 * loses the room token/PIN, so the panel must show the code, hide the QR and
 * never invent a PIN.
 */
import { afterEach, describe, expect, test } from "vitest";
import { RoomPanel } from "../src/ui/RoomPanel.js";

const roots: HTMLElement[] = [];

function makePanel(): { panel: RoomPanel; root: HTMLElement } {
  const root = document.createElement("div");
  document.body.append(root);
  roots.push(root);
  const panel = new RoomPanel(root, {
    publicOrigin: "http://192.168.1.10:8080",
    renderQr: async () => undefined,
  });
  return { panel, root };
}

afterEach(() => {
  for (const root of roots) root.remove();
  roots.length = 0;
});

describe("HP-06 resumed room", () => {
  test("[FR-5.4] shows the code, hides the QR and never invents a PIN", () => {
    const { panel, root } = makePanel();
    panel.setResumedRoom("ABCD");

    expect(root.querySelector(".room-panel__code")?.textContent).toBe("ABCD");
    expect(root.querySelector(".room-panel__pin")?.textContent).toBe(
      "PIN ----",
    );
    expect(
      root.querySelector<HTMLCanvasElement>(".room-panel__qr-canvas")?.hidden,
    ).toBe(true);
    expect(root.querySelector(".room-panel__qr-fallback")?.textContent).toBe(
      "Room resumed — phones already connected stay in the game.",
    );
    // No room token exists after a resume, so nothing secret can be rendered.
    expect(root.innerHTML.toLowerCase()).not.toContain("roomtoken");

    panel.destroy();
  });
});

