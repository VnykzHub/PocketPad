/**
 * Manifest layout registration (D5/D7 seam).
 *
 * Games address layouts by id (`ctx.layouts.set(slot, "<id>")`), and
 * `LayoutApi` can resolve an id only after the document has been registered
 * and validated. The manifest lists the layout files, so the host fetches
 * them at boot; the game module never touches the network (FR-7.17).
 */
import type { LayoutDocument } from "@lanpad/sdk";
import type { LayoutApi } from "./LayoutApi.js";
import type { LoadedGame } from "./loadGame.js";

/** Fetches and parses one layout document. */
export type LayoutFetcher = (url: string) => Promise<unknown>;

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json() as Promise<unknown>;
}

/**
 * Registers every layout listed by the loaded manifest, resolving each path
 * relative to the manifest URL. Returns the number registered. A fetch or
 * validation failure throws so the host surfaces an error screen instead of
 * starting a game whose layouts can never reach a controller.
 */
export async function registerManifestLayouts(
  layouts: LayoutApi,
  loaded: Pick<LoadedGame, "manifest" | "manifestUrl">,
  fetchLayout: LayoutFetcher = fetchJson,
): Promise<number> {
  let registered = 0;
  for (const relative of loaded.manifest.layouts) {
    const url = new URL(relative, loaded.manifestUrl).href;
    let body: unknown;
    try {
      body = await fetchLayout(url);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not load layout "${relative}": ${reason}`);
    }
    layouts.register(body as LayoutDocument);
    registered += 1;
  }
  return registered;
}
