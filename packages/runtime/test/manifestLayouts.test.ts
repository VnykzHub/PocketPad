/**
 * D5/D7 seam: manifest layout files are registered before a game can call
 * `ctx.layouts.set(slot, "<id>")`, and the string form then sends the document.
 */
import type { GameManifest, LayoutDocument } from "@lanpad/sdk";
import type { HostToServerMessage } from "@lanpad/protocol";
import { describe, expect, test } from "vitest";
import { LayoutApi, LayoutValidationError } from "../src/game/LayoutApi.js";
import { registerManifestLayouts } from "../src/game/manifestLayouts.js";

const MANIFEST: GameManifest = {
  name: "Probe",
  entry: "index.js",
  layouts: ["layouts/probe-v1.json"],
  assetBudget: { initialBytes: 1, totalBytes: 1 },
  minPlayers: 1,
  maxPlayers: 8,
  needsGyro: false,
};

const LAYOUT: LayoutDocument = {
  id: "probe-v1",
  orientation: "portrait",
  controls: [
    {
      type: "button",
      id: "go",
      label: "Go",
      shape: "circle",
      x: "50%",
      y: "80%",
      r: "10%",
      bit: 0,
    },
  ],
};

class RecordingSender {
  readonly sent: HostToServerMessage[] = [];

  send(message: HostToServerMessage): void {
    this.sent.push(message);
  }
}

describe("[FR-10.3] manifest layout registration", () => {
  test("[FR-10.3] fetches layouts relative to the manifest and enables the id form", async () => {
    const sender = new RecordingSender();
    const api = new LayoutApi({ sender });
    const urls: string[] = [];

    const count = await registerManifestLayouts(
      api,
      { manifest: MANIFEST, manifestUrl: "https://tv.example/games/probe/game.manifest.json" },
      async (url) => {
        urls.push(url);
        return LAYOUT;
      },
    );

    expect(count).toBe(1);
    expect(urls).toEqual(["https://tv.example/games/probe/layouts/probe-v1.json"]);

    api.set(1, "probe-v1");
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]).toMatchObject({ t: "setLayout", slot: 1, layout: { id: "probe-v1" } });
  });

  test("[FR-10.3] a failed fetch names the layout; an invalid document is rejected", async () => {
    const api = new LayoutApi({ sender: new RecordingSender() });
    const loaded = {
      manifest: MANIFEST,
      manifestUrl: "https://tv.example/games/probe/game.manifest.json",
    };

    await expect(
      registerManifestLayouts(api, loaded, async () => {
        throw new Error("HTTP 404");
      }),
    ).rejects.toThrow(/layouts\/probe-v1\.json.*HTTP 404/);

    await expect(
      registerManifestLayouts(api, loaded, async () => ({ id: "", orientation: "portrait", controls: [] })),
    ).rejects.toBeInstanceOf(LayoutValidationError);
  });
});
