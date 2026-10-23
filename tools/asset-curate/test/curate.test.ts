import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { validateAssetManifest } from "../../../sdk/src/assets.js";
import { runAssetCurateCli, type CliIo } from "../src/cli.js";
import { curate } from "../src/curate.js";
import { ledgerKeysFromCsv, parseLedger, validateLedger } from "../src/ledger.js";
import { LICENCES, SELECTION } from "../src/selection.js";

const DERIVED_OUTPUT = "models/characters/ual-mannequin.glb";
const DERIVED_BYTES = 854_184;

interface Fixture {
  readonly root: string;
  readonly sourceRoot: string;
  readonly assetRoot: string;
}

const fixtureRoots: string[] = [];

afterAll(() => {
  while (fixtureRoots.length > 0) {
    const root = fixtureRoots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function writeAt(root: string, relative: string, data: Uint8Array): void {
  const absolute = join(root, ...relative.split("/"));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, data);
}

function absAt(root: string, relative: string): string {
  return join(root, ...relative.split("/"));
}

/**
 * Synthetic GLB: one JSON chunk, embedded (absent) buffers, one external
 * texture and one animation. Enough for the curation parser, not a renderer.
 */
function makeGlb(json: unknown): Buffer {
  const text = Buffer.from(JSON.stringify(json), "utf8");
  const padded = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + padded.length, 8);
  header.writeUInt32LE(padded.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, padded]);
}

const MESH_JSON = {
  asset: { version: "2.0", generator: "asset-curate-test" },
  meshes: [{}],
  animations: [{ name: "Idle" }],
  images: [{ uri: "Textures/colormap.png" }],
};

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "asset-curate-test-"));
  fixtureRoots.push(root);
  const sourceRoot = join(root, "Game-assets");
  const assetRoot = join(root, "assets");
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(assetRoot, { recursive: true });

  for (const entry of SELECTION) {
    if (entry.derived !== undefined) {
      writeAt(sourceRoot, entry.derived.source, Buffer.alloc(entry.derived.beforeBytes, 0x11));
      writeAt(assetRoot, entry.output, Buffer.alloc(entry.derived.afterBytes, 0x22));
      continue;
    }
    if (entry.kind === "mesh") {
      writeAt(sourceRoot, entry.source, makeGlb(MESH_JSON));
      writeAt(
        sourceRoot,
        posix.join(posix.dirname(entry.source), "Textures/colormap.png"),
        Buffer.from(`png:${entry.id}`),
      );
      continue;
    }
    writeAt(sourceRoot, entry.source, Buffer.from(`OggS:${entry.id}`));
  }

  for (const licence of Object.values(LICENCES)) {
    const evidence = posix.join(licence.pack, licence.licenceFile);
    writeAt(sourceRoot, evidence, Buffer.from("License: CC0 1.0 Universal\n"));
  }
  return { root, sourceRoot, assetRoot };
}

interface MutableManifest {
  schemaVersion: number;
  groups: { id: string; mode: string }[];
  assets: {
    id: string;
    path: string;
    kind: string;
    bytes: number;
    group: string;
    ledger: string;
    clips?: string[];
  }[];
}

function parseManifest(content: string): MutableManifest {
  return JSON.parse(content) as MutableManifest;
}

function capture(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { io: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) }, stdout, stderr };
}

describe("asset curation against a synthetic drop", () => {
  const fixture = createFixture();

  test("[ER-23-01] copies a licence-clean subset and writes a complete ledger", () => {
    const result = curate({ sourceRoot: fixture.sourceRoot, assetRoot: fixture.assetRoot });

    expect(result.errors, result.errors.join("\n")).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.scan.glb).toBe(11);
    expect(result.scan.ogg).toBe(15);
    expect(result.totals.files).toBe(SELECTION.length + 5);
    expect(result.groups.map((group) => group.group)).toEqual([
      "characters",
      "vehicles",
      "props",
      "audio-ui",
      "audio-impact",
      "audio-scifi",
      "audio-digital",
      "music",
    ]);
    expect(result.written).toHaveLength(37);

    const ledgerPath = absAt(fixture.assetRoot, "LICENSES.csv");
    expect(existsSync(ledgerPath)).toBe(true);
    const parsed = parseLedger(readFileSync(ledgerPath, "utf8"));
    expect(parsed.rows).toHaveLength(result.totals.files);
    expect(validateLedger(parsed, { knownFiles: new Set(result.files.map((asset) => asset.path)) })).toEqual(
      [],
    );

    for (const entry of SELECTION) {
      if (entry.derived === undefined) {
        expect(existsSync(absAt(fixture.assetRoot, entry.output)), entry.id).toBe(true);
      }
    }
    expect(readFileSync(absAt(fixture.assetRoot, DERIVED_OUTPUT)).length).toBe(DERIVED_BYTES);
    expect(existsSync(absAt(fixture.assetRoot, "models/vehicles/Textures/colormap.png"))).toBe(true);
    expect(existsSync(absAt(fixture.assetRoot, "CURATION.md"))).toBe(true);
    expect(existsSync(absAt(fixture.assetRoot, "CURATION.json"))).toBe(true);
  });

  test("[ER-23-01] produced manifests pass the SDK validator and reject missing ledger rows, escapes and budgets", () => {
    const result = curate({ sourceRoot: fixture.sourceRoot, assetRoot: fixture.assetRoot, check: true });
    expect(result.ok, result.errors.join("\n")).toBe(true);

    const ledgerKeys = ledgerKeysFromCsv(readFileSync(absAt(fixture.assetRoot, "LICENSES.csv"), "utf8"));
    const sumo = result.manifests.find((manifest) => manifest.game === "sumo-bumpers");
    expect(sumo).toBeDefined();
    if (sumo === undefined) return;

    for (const manifest of result.manifests) {
      const value = parseManifest(manifest.content);
      const budget = { initialBytes: manifest.bootBytes, totalBytes: manifest.totalBytes };
      const valid = validateAssetManifest(value, ledgerKeys, budget);
      expect(valid.ok, `${manifest.game}: ${valid.ok ? "" : JSON.stringify(valid.errors)}`).toBe(true);

      const eagerBytes = value.assets
        .filter((asset) => asset.group === "boot")
        .reduce((total, asset) => total + asset.bytes, 0);
      expect(eagerBytes, `${manifest.game} boot accounting`).toBe(manifest.bootBytes);
      expect(value.assets.every((asset) => ledgerKeys.has(asset.ledger))).toBe(true);

      const tooSmall = validateAssetManifest(value, ledgerKeys, {
        initialBytes: manifest.bootBytes - 1,
        totalBytes: manifest.totalBytes,
      });
      expect(tooSmall.ok).toBe(false);
      if (!tooSmall.ok) expect(tooSmall.errors.map((error) => error.code)).toContain("E_ASSET_BUDGET");

      const tooSmallTotal = validateAssetManifest(value, ledgerKeys, {
        initialBytes: manifest.bootBytes,
        totalBytes: manifest.totalBytes - 1,
      });
      expect(tooSmallTotal.ok).toBe(false);
      if (!tooSmallTotal.ok) {
        expect(tooSmallTotal.errors.map((error) => error.code)).toContain("E_ASSET_BUDGET");
      }

      expect(manifest.bootBytes).toBeLessThanOrEqual(5 * 1024 * 1024);
    }

    expect(sumo.bootIds).toContain("char.ual");
    expect(sumo.bootIds).toContain("sfx.ui.click");
    expect(sumo.bootIds).not.toContain("char.archer");

    const openWorld = result.manifests.find((manifest) => manifest.game === "open-world-showcase");
    expect(openWorld?.bootIds).toContain("dep.models.props.forest.textures.colormap");

    const brokenLedger = parseManifest(sumo.content);
    const first = brokenLedger.assets[0];
    if (first !== undefined) first.ledger = "missing.glb";
    const ledgerFailure = validateAssetManifest(brokenLedger, ledgerKeys, {
      initialBytes: sumo.bootBytes,
      totalBytes: sumo.totalBytes,
    });
    expect(ledgerFailure.ok).toBe(false);
    if (!ledgerFailure.ok) expect(ledgerFailure.errors.map((error) => error.code)).toContain("E_ASSET_LEDGER");

    const brokenPath = parseManifest(sumo.content);
    const firstPath = brokenPath.assets[0];
    if (firstPath !== undefined) firstPath.path = "../escape.glb";
    const pathFailure = validateAssetManifest(brokenPath, ledgerKeys, {
      initialBytes: sumo.bootBytes,
      totalBytes: sumo.totalBytes,
    });
    expect(pathFailure.ok).toBe(false);
    if (!pathFailure.ok) expect(pathFailure.errors.map((error) => error.code)).toContain("E_ASSET_PATH");
  });

  test("[ER-23-01] check mode detects a tampered copy and a wrong derived byte count", () => {
    const clean = curate({ sourceRoot: fixture.sourceRoot, assetRoot: fixture.assetRoot, check: true });
    expect(clean.ok, clean.errors.join("\n")).toBe(true);
    expect(clean.written).toEqual([]);

    const clickPath = absAt(fixture.assetRoot, "audio/ui/click.ogg");
    writeFileSync(clickPath, Buffer.concat([readFileSync(clickPath), Buffer.from([0])]));
    const tampered = curate({ sourceRoot: fixture.sourceRoot, assetRoot: fixture.assetRoot, check: true });
    expect(tampered.ok).toBe(false);
    expect(tampered.errors).toContain("audio/ui/click.ogg: assets copy differs from source bytes");

    const restored = curate({ sourceRoot: fixture.sourceRoot, assetRoot: fixture.assetRoot });
    expect(restored.ok, restored.errors.join("\n")).toBe(true);
    expect(readFileSync(clickPath)).toEqual(
      readFileSync(absAt(fixture.sourceRoot, "kenney_ui-audio/Audio/click1.ogg")),
    );

    writeAt(fixture.assetRoot, DERIVED_OUTPUT, Buffer.alloc(10, 0x33));
    const shortDerived = curate({ sourceRoot: fixture.sourceRoot, assetRoot: fixture.assetRoot, check: true });
    expect(shortDerived.ok).toBe(false);
    expect(
      shortDerived.errors.some((error) => error.includes(`derived file is 10 bytes, expected ${DERIVED_BYTES}`)),
    ).toBe(true);

    writeAt(fixture.assetRoot, DERIVED_OUTPUT, Buffer.alloc(DERIVED_BYTES, 0x22));
    const repaired = curate({ sourceRoot: fixture.sourceRoot, assetRoot: fixture.assetRoot, check: true });
    expect(repaired.ok, repaired.errors.join("\n")).toBe(true);
  });

  test("[ER-23-01] the CLI reports JSON, check status and a usage error", () => {
    const check = capture();
    const code = runAssetCurateCli(["--source", fixture.sourceRoot, "--out", fixture.assetRoot, "--check", "--json"], {
      cwd: fixture.root,
      io: check.io,
    });
    expect(code).toBe(0);
    const summary = JSON.parse(check.stdout.join("")) as { ok: boolean; d6: string; manifests: unknown[] };
    expect(summary.ok).toBe(true);
    expect(summary.d6).toBe("NOT_MEASURED_BY_CLI");
    expect(summary.manifests).toHaveLength(4);
    expect(check.stderr.join("")).toContain("WARNING: The 5 MiB boot budget");

    const usage = capture();
    expect(runAssetCurateCli(["--not-a-flag"], { cwd: fixture.root, io: usage.io })).toBe(2);
    expect(usage.stderr.join("")).toContain("unknown option");

    const help = capture();
    expect(runAssetCurateCli(["--help"], { cwd: fixture.root, io: help.io })).toBe(0);
    expect(help.stdout.join("")).toContain("Usage: asset-curate");
  });

  test("[ER-23-01] a missing Game-assets drop is reported without writing", () => {
    const missing = join(fixture.root, "missing-drop");
    const result = curate({ sourceRoot: missing, assetRoot: fixture.assetRoot });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("Game-assets is missing");
    expect(result.written).toEqual([]);
  });
});

describe("committed curated assets", () => {
  test("[ER-23-01] every committed manifest passes the SDK validator against the committed ledger", () => {
    const assetRoot = new URL("../../../assets/", import.meta.url);
    const ledgerKeys = ledgerKeysFromCsv(readFileSync(new URL("LICENSES.csv", assetRoot), "utf8"));
    expect(ledgerKeys.size).toBeGreaterThan(0);

    for (const game of ["sumo-bumpers", "steering-wheel-racer", "sword-swing-duel", "open-world-showcase"]) {
      const value = parseManifest(readFileSync(new URL(`manifests/${game}.assets.json`, assetRoot), "utf8"));
      const bootBytes = value.assets
        .filter((asset) => asset.group === "boot")
        .reduce((total, asset) => total + asset.bytes, 0);
      const totalBytes = value.assets.reduce((total, asset) => total + asset.bytes, 0);
      const validation = validateAssetManifest(value, ledgerKeys, { initialBytes: bootBytes, totalBytes });

      expect(validation.ok, `${game}: ${validation.ok ? "" : JSON.stringify(validation.errors)}`).toBe(true);
      expect(bootBytes).toBeLessThanOrEqual(5 * 1024 * 1024);
      for (const asset of value.assets) {
        expect(ledgerKeys.has(asset.ledger), `${game}: ${asset.ledger}`).toBe(true);
        expect(existsSync(new URL(asset.path, assetRoot)), `${game}: ${asset.path}`).toBe(true);
      }
    }
  });
});
